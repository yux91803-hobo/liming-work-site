// 每机单隧道 SSH 复用器：基于系统 ssh（ControlMaster + -L 127.0.0.1:<local>:127.0.0.1:<remote>）。
// 特性：按需建立、活跃任务计数复用、无进行中任务自动关闭、掉线指数退避重连、进程组干净退出、
// 任何日志/状态/报错绝不输出 ibssh_ 令牌。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ensurePrivateDir } from './ledger.js';
import { createRedactingLogger, redactText } from './redact.js';
import { parseSshTarget } from './secrets.js';

export const DEFAULT_BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);

export class SshTunnelError extends Error {
  constructor(code, message, extraSecrets) {
    super(redactText(message, extraSecrets));
    this.name = 'SshTunnelError';
    this.code = code;
  }
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

function probeLoopbackPort(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function signalProcessGroup(child, sig) {
  if (!child?.pid) return false;
  try { process.kill(-child.pid, sig); return true; } catch {}
  try { return child.kill(sig); } catch { return false; }
}

function sweepProcessGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

function stopChildProcess(child, stopGraceMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sweepProcessGroup(child);
      resolve();
    };
    const timer = setTimeout(() => {
      signalProcessGroup(child, 'SIGKILL');
      done();
    }, stopGraceMs);
    timer.unref?.();
    child.once('exit', done);
    if (!signalProcessGroup(child, 'SIGTERM')) {
      done();
    }
  });
}

export function createTunnelManager(options = {}) {
  const sshBin = options.sshBin || 'ssh';
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  const controlDir = options.controlDir || path.join(os.tmpdir(), `liming-ssh-${uid}`);
  const idleCloseMs = options.idleCloseMs ?? 15000;
  const backoffMs = Array.isArray(options.backoffMs) && options.backoffMs.length > 0
    ? options.backoffMs
    : DEFAULT_BACKOFF_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? 15000;
  const readyPollIntervalMs = options.readyPollIntervalMs ?? 50;
  const execTimeoutMs = options.execTimeoutMs ?? 30000;
  const stopGraceMs = options.stopGraceMs ?? 2000;
  const onDisconnect = typeof options.onDisconnect === 'function' ? options.onDisconnect : null;
  const onReconnect = typeof options.onReconnect === 'function' ? options.onReconnect : null;

  const knownTargets = new Set();
  const extraSecrets = () => {
    const out = [];
    for (const target of knownTargets) {
      out.push(target);
      const at = target.indexOf('@');
      if (at > 0) out.push(target.slice(0, at));
    }
    return out;
  };
  const log = createRedactingLogger(options.logger, extraSecrets);
  const machines = new Map();

  function rememberTarget(target) {
    knownTargets.add(target);
  }

  function controlPathFor(machine) {
    ensurePrivateDir(controlDir, 0o700);
    const digest = createHash('sha256').update(String(machine)).digest('hex').slice(0, 12);
    return path.join(controlDir, `cm-${digest}.sock`);
  }

  function commonSshArgs(controlPath, sshPort, connectSec) {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', `ConnectTimeout=${connectSec}`,
      '-o', `ControlPath=${controlPath}`,
      '-o', 'ControlPersist=no',
    ];
    if (sshPort && sshPort !== 22) {
      args.push('-p', String(sshPort));
    }
    return args;
  }

  function getOrCreateState(machine) {
    let st = machines.get(machine);
    if (!st) {
      st = {
        machine,
        state: 'closed', // closed | connecting | open | reconnecting
        child: null,
        localPort: null,
        remotePort: null,
        sshTarget: null,
        sshPort: 22,
        controlPath: null,
        owners: new Set(),
        idleTimer: null,
        reconnectTimer: null,
        reconnects: 0,
        connectingPromise: null,
        intentionalClose: false,
        lastError: null,
      };
      machines.set(machine, st);
    }
    return st;
  }

  function clearTimers(st) {
    if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
    if (st.reconnectTimer) { clearTimeout(st.reconnectTimer); st.reconnectTimer = null; }
  }

  function safeUnlink(filePath) {
    if (!filePath) return;
    try { fs.unlinkSync(filePath); } catch {}
  }

  async function stopTunnelProcess(st) {
    clearTimers(st);
    const child = st.child;
    const sock = st.controlPath;
    st.intentionalClose = true;
    st.child = null;
    st.localPort = null;
    if (child) {
      await stopChildProcess(child, stopGraceMs);
    }
    safeUnlink(sock);
    st.state = 'closed';
  }

  function scheduleReconnect(st) {
    if (st.owners.size === 0 || st.intentionalClose) {
      st.state = 'closed';
      return;
    }
    const idx = Math.min(st.reconnects, backoffMs.length - 1);
    const delay = backoffMs[idx];
    st.reconnects += 1;
    st.state = 'reconnecting';
    log.warn(`[${st.machine}] SSH 隧道断开，${delay}ms 后进行第 ${st.reconnects} 次重连`);
    st.reconnectTimer = setTimeout(() => {
      st.reconnectTimer = null;
      if (st.owners.size === 0 || st.intentionalClose) return;
      openTunnelInternal(st, {
        sshTarget: st.sshTarget,
        sshPort: st.sshPort,
        remotePort: st.remotePort,
      }).then((info) => {
        st.reconnects = 0;
        log.info(`[${st.machine}] SSH 隧道已恢复（127.0.0.1:${info.localPort} -> ${info.remotePort}）`);
        try { onReconnect?.(info); } catch {}
      }).catch((err) => {
        st.lastError = redactText(err.message, extraSecrets);
        log.warn(`[${st.machine}] SSH 隧道重连失败：${st.lastError}`);
        scheduleReconnect(st);
      });
    }, delay);
    st.reconnectTimer.unref?.();
  }

  async function openTunnelInternal(st, { sshTarget, sshPort = 22, remotePort }) {
    const target = parseSshTarget(sshTarget);
    rememberTarget(target);
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw new SshTunnelError('TUNNEL_INVALID_PORT', `无效远端端口：${remotePort}`, extraSecrets);
    }

    const controlPath = controlPathFor(st.machine);
    safeUnlink(controlPath);
    const localPort = await allocateLoopbackPort();
    const connectSec = Math.max(1, Math.ceil(connectTimeoutMs / 1000));
    const args = [
      '-N',
      '-T',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ControlMaster=yes',
      ...commonSshArgs(controlPath, sshPort, connectSec),
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      '--',
      target,
    ];

    st.state = 'connecting';
    st.intentionalClose = false;
    st.sshTarget = target;
    st.sshPort = sshPort;
    st.remotePort = remotePort;
    st.controlPath = controlPath;
    st.localPort = localPort;

    let stderrBuf = '';
    const child = spawn(sshBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    st.child = child;

    child.stderr.on('data', (chunk) => {
      if (stderrBuf.length < 4096) stderrBuf += chunk.toString('utf8');
    });

    let exitedEarly = false;
    let exitReason = '';
    const onUnexpectedExit = (code, signal, err) => {
      const detail = redactText(
        err ? err.message : (stderrBuf.trim() || (signal ? `signal ${signal}` : `exit ${code}`)),
        extraSecrets,
      );
      if (st.state === 'connecting') {
        exitedEarly = true;
        exitReason = detail;
        return;
      }
      if (st.child !== child) return;
      st.child = null;
      st.localPort = null;
      safeUnlink(controlPath);
      if (st.intentionalClose) {
        st.state = 'closed';
        return;
      }
      st.lastError = detail;
      const willReconnect = st.owners.size > 0;
      try {
        onDisconnect?.({
          machine: st.machine,
          error: detail,
          attempt: st.reconnects + 1,
          willReconnect,
        });
      } catch {}
      if (willReconnect) {
        scheduleReconnect(st);
      } else {
        st.state = 'closed';
      }
    };

    child.once('error', (err) => onUnexpectedExit(null, null, err));
    child.once('exit', (code, signal) => onUnexpectedExit(code, signal, null));

    const deadline = Date.now() + connectTimeoutMs;
    while (Date.now() < deadline) {
      if (exitedEarly) {
        await stopChildProcess(child, stopGraceMs);
        safeUnlink(controlPath);
        if (st.child === child) {
          st.child = null;
          st.localPort = null;
          st.state = 'closed';
        }
        st.lastError = exitReason;
        throw new SshTunnelError('TUNNEL_EXITED', `[${st.machine}] SSH 隧道提前退出：${exitReason}`, extraSecrets);
      }
      if (st.intentionalClose || st.child !== child) {
        throw new SshTunnelError('TUNNEL_CLOSED', `[${st.machine}] SSH 隧道在就绪前已关闭`, extraSecrets);
      }
      if (await probeLoopbackPort(localPort, Math.min(250, connectTimeoutMs))) {
        st.state = 'open';
        st.reconnects = 0;
        st.lastError = null;
        log.info(`[${st.machine}] SSH 隧道已建立（127.0.0.1:${localPort} -> ${remotePort}）`);
        return {
          machine: st.machine,
          localPort,
          remotePort,
          baseUrl: `http://127.0.0.1:${localPort}`,
          reused: false,
        };
      }
      await sleep(readyPollIntervalMs);
    }

    await stopChildProcess(child, stopGraceMs);
    safeUnlink(controlPath);
    if (st.child === child) {
      st.child = null;
      st.localPort = null;
      st.state = 'closed';
    }
    const errMsg = redactText(stderrBuf.trim() || `连接超时（${connectTimeoutMs}ms）`, extraSecrets);
    st.lastError = errMsg;
    throw new SshTunnelError('TUNNEL_TIMEOUT', `[${st.machine}] SSH 隧道建立超时：${errMsg}`, extraSecrets);
  }

  async function acquire(machine, ownerId, { sshTarget, sshPort = 22, remotePort }) {
    if (!ownerId || typeof ownerId !== 'string') {
      throw new SshTunnelError('TUNNEL_INVALID_OWNER', 'acquire 需要非空 ownerId', extraSecrets);
    }
    const target = parseSshTarget(sshTarget);
    rememberTarget(target);
    const st = getOrCreateState(machine);
    if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
    if (st.reconnectTimer) { clearTimeout(st.reconnectTimer); st.reconnectTimer = null; }
    st.owners.add(ownerId);

    const sameEndpoint = st.remotePort === remotePort && st.sshTarget === target && st.sshPort === sshPort;
    if (st.state === 'open' && st.child && st.localPort && sameEndpoint) {
      return {
        machine,
        localPort: st.localPort,
        remotePort: st.remotePort,
        baseUrl: `http://127.0.0.1:${st.localPort}`,
        reused: true,
      };
    }

    if (st.connectingPromise && sameEndpoint) {
      try {
        const info = await st.connectingPromise;
        return { ...info, reused: true };
      } catch (err) {
        st.owners.delete(ownerId);
        throw err;
      }
    }

    if (st.child) {
      await stopTunnelProcess(st);
    }

    const promise = openTunnelInternal(st, { sshTarget: target, sshPort, remotePort });
    st.connectingPromise = promise;
    try {
      return await promise;
    } catch (err) {
      st.owners.delete(ownerId);
      throw err;
    } finally {
      if (st.connectingPromise === promise) st.connectingPromise = null;
    }
  }

  async function release(machine, ownerId) {
    const st = machines.get(machine);
    if (!st) return;
    st.owners.delete(ownerId);
    if (st.owners.size > 0) return;
    if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
    if (st.reconnectTimer) { clearTimeout(st.reconnectTimer); st.reconnectTimer = null; }
    if (idleCloseMs <= 0) {
      await stopTunnelProcess(st);
      return;
    }
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null;
      if (st.owners.size === 0) {
        log.info(`[${machine}] 无活跃任务，自动关闭 SSH 隧道`);
        stopTunnelProcess(st).catch(() => {});
      }
    }, idleCloseMs);
    st.idleTimer.unref?.();
  }

  async function closeMachine(machine) {
    const st = machines.get(machine);
    if (!st) return;
    st.owners.clear();
    await stopTunnelProcess(st);
  }

  async function closeAll() {
    await Promise.all([...machines.keys()].map(m => closeMachine(m)));
  }

  function execRemote(machine, { sshTarget, sshPort = 22 }, script, { timeoutMs = execTimeoutMs, signal } = {}) {
    const target = parseSshTarget(sshTarget);
    rememberTarget(target);
    const controlPath = controlPathFor(machine);
    const connectSec = Math.max(1, Math.ceil(Math.min(timeoutMs, connectTimeoutMs) / 1000));
    const args = [
      '-T',
      '-o', 'ControlMaster=auto',
      ...commonSshArgs(controlPath, sshPort, connectSec),
      '--',
      target,
      'sh -s',
    ];

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new SshTunnelError('SSH_EXEC_ABORTED', `[${machine}] 远端命令已取消`, extraSecrets));
        return;
      }
      const child = spawn(sshBin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      const out = [];
      const err = [];
      child.stdout.on('data', c => out.push(c));
      child.stderr.on('data', c => err.push(c));

      let settled = false;
      let timer = null;
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        signalProcessGroup(child, 'SIGKILL');
        if (!settled) {
          settled = true;
          cleanup();
          reject(new SshTunnelError('SSH_EXEC_ABORTED', `[${machine}] 远端命令已取消`, extraSecrets));
        }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          signalProcessGroup(child, 'SIGKILL');
          if (!settled) {
            settled = true;
            cleanup();
            reject(new SshTunnelError('SSH_EXEC_TIMEOUT', `[${machine}] 远端命令执行超时（${timeoutMs}ms）`, extraSecrets));
          }
        }, timeoutMs);
        timer.unref?.();
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new SshTunnelError('SSH_EXEC_FAILED', `[${machine}] 启动 ssh 失败：${e.message}`, extraSecrets));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          exitCode: code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: redactText(Buffer.concat(err).toString('utf8'), extraSecrets),
        });
      });

      child.stdin.on('error', () => {});
      child.stdin.end(String(script || ''));
    });
  }

  function createSshShell(machine, spec) {
    return {
      run: (script, opts) => execRemote(machine, spec, script, opts),
    };
  }

  function status(machine) {
    const st = machines.get(machine);
    if (!st) {
      return {
        machine,
        state: 'closed',
        localPort: null,
        remotePort: null,
        pid: null,
        activeOwners: 0,
        reconnects: 0,
        lastError: null,
      };
    }
    return {
      machine: st.machine,
      state: st.state,
      localPort: st.localPort,
      remotePort: st.remotePort,
      pid: st.child?.pid ?? null,
      activeOwners: st.owners.size,
      reconnects: st.reconnects,
      lastError: st.lastError ? redactText(st.lastError, extraSecrets) : null,
    };
  }

  function listStatuses() {
    return [...machines.keys()].sort().map(status);
  }

  return {
    controlPathFor,
    acquire,
    release,
    closeMachine,
    closeAll,
    execRemote,
    createSshShell,
    status,
    listStatuses,
  };
}
