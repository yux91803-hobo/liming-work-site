// 平板 liming-cloud 阶段 2 单测：dsh-client（假 dsh web HTTP+WS）、remote-bootstrap（本机 /bin/sh 实跑）、ssh-tunnel（假 ssh 隧道）。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const libDir = path.resolve(__dirname, '../site/tablet/liming-cloud/lib');
const importLib = (file) => import(pathToFileURL(path.join(libDir, file)).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablet-cloud-transport-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const pidAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitFor(fn, ms = 5000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  return false;
}

// 最小零依赖 RFC 6455 服务端帧编解码，用于在本机单测中模拟真实 /api/remote.mux WebSocket。
function wsEncodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsDecodeFrames(state, onMessage) {
  while (state.buf.length >= 2) {
    const b0 = state.buf[0];
    const b1 = state.buf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (state.buf.length < 4) return;
      len = state.buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (state.buf.length < 10) return;
      len = Number(state.buf.readBigUInt64BE(2));
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (state.buf.length < offset + maskLen + len) return;
    const mask = masked ? state.buf.subarray(offset, offset + 4) : null;
    const raw = Buffer.from(state.buf.subarray(offset + maskLen, offset + maskLen + len));
    state.buf = state.buf.subarray(offset + maskLen + len);
    if (mask) {
      for (let i = 0; i < raw.length; i++) raw[i] ^= mask[i % 4];
    }
    if (opcode === 0x08) {
      onMessage({ opcode: 'close' });
    } else if (opcode === 0x01) {
      onMessage({ opcode: 'text', text: raw.toString('utf8') });
    }
  }
}

async function startFakeDshWeb(t) {
  let activeToken = 'launchTok_v1_secret';
  let cookieCounter = 0;
  let validCookie = null;
  let loginCount = 0;
  let seenOriginHeader = null;
  let rpcDelayMs = 0;
  let streamMode = 'normal'; // normal | rpc-error | abrupt-drop
  const wsSockets = new Set();

  const server = http.createServer((req, res) => {
    if (req.headers.origin) seenOriginHeader = req.headers.origin;
    const url = new URL(req.url, 'http://127.0.0.1');

    // GET /?token=... 登录换 dsh-auth-* Cookie
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
      loginCount += 1;
      if (url.searchParams.get('token') !== activeToken) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end(`bad token ${url.searchParams.get('token')}`);
        return;
      }
      cookieCounter += 1;
      validCookie = `dsh-auth-mock123=v1.payload${cookieCounter}.sig${cookieCounter}`;
      res.writeHead(303, {
        location: './',
        'set-cookie': `${validCookie}; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict`,
      });
      res.end();
      return;
    }

    // GET / 健康检查
    if (req.method === 'GET' && url.pathname === '/') {
      if (!validCookie || req.headers.cookie !== validCookie) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      res.writeHead(200);
      res.end('ok');
      return;
    }

    // POST /api/<endpoint>
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (!validCookie || req.headers.cookie !== validCookie) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('cookie expired');
        return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        if (rpcDelayMs > 0) await sleep(rpcDelayMs);
        if (res.writableEnded || res.destroyed) return;
        const env = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const endpoint = url.pathname.slice('/api/'.length);
        const args = env.payload?.args || {};
        if (endpoint === 'session/create') {
          if (args.request?.cwd === '/conflict') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              type: 'server-response',
              rpcId: env.rpcId,
              result: { ok: false, error: { code: 'session/conflict', message: 'cwd conflict' } },
            }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            type: 'server-response',
            rpcId: env.rpcId,
            result: { ok: true, value: { sessionId: args.request.sessionId } },
          }));
          return;
        }
        if (endpoint === 'session/list') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            type: 'server-response',
            rpcId: env.rpcId,
            result: { ok: true, value: { sessions: [{ id: 'tablet-t1', running: true }] } },
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: env.rpcId,
          result: { ok: true, value: { echo: endpoint, args } },
        }));
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/api/remote.mux') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!validCookie || req.headers.cookie !== validCookie) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    wsSockets.add(socket);
    socket.on('close', () => wsSockets.delete(socket));

    const state = { buf: Buffer.alloc(0) };
    socket.on('data', (chunk) => {
      state.buf = Buffer.concat([state.buf, chunk]);
      wsDecodeFrames(state, (msg) => {
        if (msg.opcode === 'close') {
          socket.end();
          return;
        }
        const frame = JSON.parse(msg.text);
        if (frame.type === 'open') {
          const { streamId, endpoint } = frame;
          if (streamMode === 'rpc-error') {
            socket.write(wsEncodeText(JSON.stringify({
              type: 'error',
              streamId,
              error: { code: 'session/not-found', message: 'missing session' },
            })));
            return;
          }
          if (streamMode === 'abrupt-drop') {
            socket.write(wsEncodeText(JSON.stringify({
              type: 'item',
              streamId,
              value: { seq: 1, endpoint, kind: 'first' },
            })));
            setTimeout(() => socket.destroy(), 30);
            return;
          }
          socket.write(wsEncodeText(JSON.stringify({
            type: 'item',
            streamId,
            value: { seq: 1, endpoint, jobs: [{ id: 'j1', status: 'running' }] },
          })));
          socket.write(wsEncodeText(JSON.stringify({
            type: 'item',
            streamId,
            value: { seq: 2, endpoint, jobs: [] },
          })));
          socket.write(wsEncodeText(JSON.stringify({ type: 'end', streamId })));
        }
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => {
    for (const s of wsSockets) s.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get token() { return activeToken; },
    setToken(tok) { activeToken = tok; },
    expireCookie() { validCookie = 'dsh-auth-expired=v1.other.sig'; },
    setRpcDelay(ms) { rpcDelayMs = ms; },
    setStreamMode(m) { streamMode = m; },
    get loginCount() { return loginCount; },
    get seenOriginHeader() { return seenOriginHeader; },
  };
}

test('dsh-client：登录换 Cookie、401 自动重登、一元 RPC、超时取消与脱敏报错', async (t) => {
  const { DshClient, DshRpcError, DshHttpError, DshTransportError } = await importLib('dsh-client.js');
  const srv = await startFakeDshWeb(t);

  // 错误 token 返回 401 且不回显令牌原文
  const badToken = 'badLaunchToken_SecretXYZ';
  await assert.rejects(
    () => DshClient.login(srv.baseUrl, badToken),
    (err) => err instanceof DshHttpError && err.status === 401 && !err.message.includes(badToken) && !err.body.includes(badToken),
  );

  // 正常登录与一元 RPC
  const client = await DshClient.login(srv.baseUrl, srv.token);
  t.after(() => client.close());
  assert.match(client.cookieHeader, /^dsh-auth-mock123=/);
  assert.equal(srv.seenOriginHeader, null, '不应发送 Origin 头');

  const created = await client.createSession({ sessionId: 'tablet-t1', cwd: '/data/workspace/tablet/demo' });
  assert.equal(created.sessionId, 'tablet-t1');

  await assert.rejects(
    () => client.createSession({ sessionId: 'tablet-t1', cwd: '/conflict' }),
    (err) => err instanceof DshRpcError && err.code === 'session/conflict',
  );

  // Cookie 失效触发 401 -> 自动重登并重放成功
  const loginsBefore = srv.loginCount;
  srv.expireCookie();
  const list = await client.listSessions();
  assert.equal(list.sessions[0].id, 'tablet-t1');
  assert.equal(srv.loginCount, loginsBefore + 1);

  // 启动令牌也轮换时通过 onTokenRefresh 自动重登
  srv.setToken('launchTok_v2_refreshed');
  srv.expireCookie();
  let refreshed = false;
  client.onTokenRefresh = async () => { refreshed = true; return srv.token; };
  const list2 = await client.listSessions();
  assert.equal(refreshed, true);
  assert.equal(list2.sessions.length, 1);

  // 超时与 AbortSignal 取消
  srv.setRpcDelay(400);
  await assert.rejects(
    () => client.listSessions({ timeoutMs: 50 }),
    (err) => err instanceof DshTransportError && err.code === 'TIMEOUT',
  );
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(
    () => client.listSessions({ timeoutMs: 5000, signal: ac.signal }),
    (err) => err instanceof DshTransportError && err.code === 'ABORTED',
  );
  srv.setRpcDelay(0);
});

test('dsh-client：Mux WebSocket 流式读取、401 升级重登、业务错误与意外断线报错', async (t) => {
  const { DshClient, DshRpcError, DshTransportError } = await importLib('dsh-client.js');
  const srv = await startFakeDshWeb(t);
  const client = await DshClient.login(srv.baseUrl, srv.token);
  t.after(() => client.close());

  // 正常多帧读取直至 end
  const frames = [];
  const stream = client.followSession('tablet-t1');
  for await (const item of stream) {
    frames.push(item);
  }
  assert.equal(frames.length, 2);
  assert.equal(frames[0].seq, 1);
  assert.equal(frames[1].seq, 2);

  // Cookie 失效后打开 Mux 流自动重登并读到数据
  srv.expireCookie();
  const jobs = await client.readJobListOnce('tablet-t1');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'j1');

  // 流内 error 帧转 DshRpcError
  srv.setStreamMode('rpc-error');
  const errStream = client.followSession('tablet-t1');
  await assert.rejects(
    () => errStream.nextFrame(2000),
    (err) => err instanceof DshRpcError && err.code === 'session/not-found',
  );
  await errStream.close();

  // 中途物理断线（未收到 end 帧）必须抛 STREAM_DISCONNECTED
  srv.setStreamMode('abrupt-drop');
  const dropStream = client.followSession('tablet-t1');
  const first = await dropStream.nextFrame(2000);
  assert.equal(first.done, false);
  assert.equal(first.value.seq, 1);
  await assert.rejects(
    () => dropStream.nextFrame(2000),
    (err) => err instanceof DshTransportError && err.code === 'STREAM_DISCONNECTED',
  );
  await dropStream.close();
});

test('remote-bootstrap：本机 /bin/sh 实跑首次启动、复用、PID 死亡重拉、web.st 防 PID 复用、web.cmd 不一致不杀报 shared', async (t) => {
  const {
    DEFAULT_LAUNCH_COMMAND,
    createLocalShell,
    createRemoteBootstrap,
  } = await importLib('remote-bootstrap.js');

  assert.equal(DEFAULT_LAUNCH_COMMAND, '/data/home/.local/bin/dsh-tablet');

  const root = tmpDir(t);
  const fakeHome = path.join(root, 'home');
  const binDir = path.join(fakeHome, '.local/bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeDsh = path.join(binDir, 'dsh-tablet');
  const spawnLog = path.join(root, 'spawns.log');
  const portFile = path.join(root, 'port.txt');
  fs.writeFileSync(portFile, '41234');

  // 假 dsh-tablet：核对参数 --host 127.0.0.1 --port 0 --no-open，输出带 token 的启动行并常驻
  fs.writeFileSync(fakeDsh, `#!/bin/sh
echo "PID=$$ ARGS=$*" >> ${JSON.stringify(spawnLog)}
PORT=$(cat ${JSON.stringify(portFile)})
echo "dsh web: http://127.0.0.1:$PORT/?token=bootTok_$$"
exec sleep 300
`, { mode: 0o755 });

  const trackedPids = new Set();
  t.after(() => {
    for (const pid of trackedPids) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });

  const shell = createLocalShell({ env: { ...process.env, HOME: fakeHome } });
  const bootstrap = createRemoteBootstrap(shell, {
    launchCommand: fakeDsh,
    startTimeoutSec: 5,
  });

  // 1. 首次启动
  const ep1 = await bootstrap.ensureRunning();
  trackedPids.add(ep1.pid);
  assert.equal(ep1.reused, false);
  assert.equal(ep1.port, 41234);
  assert.equal(ep1.token, `bootTok_${ep1.pid}`);
  assert.equal(pidAlive(ep1.pid), true);

  const stateDir = path.join(fakeHome, '.dsh-app-remote');
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(stateDir, 'web.cmd'), 'utf8'), fakeDsh);
  assert.ok(fs.readFileSync(path.join(stateDir, 'web.st'), 'utf8').trim().length > 0);
  assert.match(fs.readFileSync(spawnLog, 'utf8'), /--host 127\.0\.0\.1 --port 0 --no-open/);

  // 2. 再次 ensureRunning 复用运行中实例（不新拉进程）
  const ep2 = await bootstrap.ensureRunning();
  assert.equal(ep2.reused, true);
  assert.equal(ep2.pid, ep1.pid);
  assert.equal(ep2.token, ep1.token);
  assert.equal(fs.readFileSync(spawnLog, 'utf8').trim().split('\n').length, 1);

  // 3. 不同 web.cmd 时绝不杀运行中的实例，probe/ensureRunning/start/stop 全部报 shared
  const otherBootstrap = createRemoteBootstrap(shell, {
    launchCommand: `${binDir}/other-dsh-cmd`,
    startTimeoutSec: 5,
  });
  await assert.rejects(() => otherBootstrap.ensureRunning(), (err) => err.code === 'shared');
  await assert.rejects(() => otherBootstrap.start(), (err) => err.code === 'shared');
  await assert.rejects(() => otherBootstrap.stop(), (err) => err.code === 'shared');
  assert.equal(pidAlive(ep1.pid), true, '不同命令绝不能误杀现有共享实例');

  // 4. 正常停止只停自身托管的实例
  await bootstrap.stop();
  assert.ok(await waitFor(() => !pidAlive(ep1.pid), 3000), '匹配命令的托管实例应被干净停止');

  // 5. PID 死亡后重拉新实例
  fs.writeFileSync(portFile, '41235');
  const ep3 = await bootstrap.ensureRunning();
  trackedPids.add(ep3.pid);
  assert.equal(ep3.reused, false);
  assert.equal(ep3.port, 41235);
  assert.notEqual(ep3.pid, ep1.pid);

  // 杀掉 ep3 并用无关进程测试 web.st 防 PID 复用
  process.kill(ep3.pid, 'SIGKILL');
  assert.ok(await waitFor(() => !pidAlive(ep3.pid), 2000));

  const decoy = spawn('sleep', ['300'], { stdio: 'ignore' });
  trackedPids.add(decoy.pid);
  fs.writeFileSync(path.join(stateDir, 'web.pid'), `${decoy.pid}\n`);
  fs.writeFileSync(path.join(stateDir, 'web.st'), '999999999999\n'); // 与 decoy 真实启动时间不同

  const probeAfterRecycle = await bootstrap.probe();
  assert.equal(probeAfterRecycle.pid, null, 'web.st 不匹配应判定 PID 已被复用');
  assert.equal(pidAlive(decoy.pid), true, '无关进程绝不被误杀');

  fs.writeFileSync(portFile, '41236');
  const ep4 = await bootstrap.ensureRunning();
  trackedPids.add(ep4.pid);
  assert.equal(ep4.reused, false);
  assert.equal(ep4.port, 41236);
  assert.equal(pidAlive(decoy.pid), true, '重拉新实例期间无关进程依然存活');

  // 清理测试进程
  await bootstrap.stop();
  try { process.kill(decoy.pid, 'SIGKILL'); } catch {}

  // 6. 启动失败日志中的 token= 必须脱敏
  const failingDsh = path.join(binDir, 'dsh-fail');
  fs.writeFileSync(failingDsh, `#!/bin/sh
echo "crash dump token=LeakBootSecret999"
exit 2
`, { mode: 0o755 });
  const failBootstrap = createRemoteBootstrap(shell, { launchCommand: failingDsh, startTimeoutSec: 5 });
  await assert.rejects(
    () => failBootstrap.start(),
    (err) => err.code === 'exited' && !err.detail.includes('LeakBootSecret999') && err.detail.includes('token=[REDACTED]'),
  );
});

test('同一台云机的并发首连共用一次 Harness 冷启动，再分别登记隧道使用者', async (t) => {
  const { createRemote } = await importLib('remote.js');
  const srv = await startFakeDshWeb(t);
  const target = 'ibssh_FakeParallelToken@li2.instabox.test';
  const owners = new Set();
  let starts = 0;
  const tunnels = {
    createSshShell() {
      return {
        async run(script) {
          if (script.includes('nohup')) {
            starts++;
            await new Promise(resolve => setImmediate(resolve));
            return { exitCode: 0, stdout: `DSHAPP started 123\nDSHAPP url ${srv.baseUrl}/?token=${srv.token}\n` };
          }
          return { exitCode: 0, stdout: '' };
        },
      };
    },
    status() { return { state: 'open', localPort: Number(new URL(srv.baseUrl).port) }; },
    async acquire(_machine, ownerId) { owners.add(ownerId); return { localPort: this.status().localPort, baseUrl: srv.baseUrl }; },
    release(_machine, ownerId) { owners.delete(ownerId); },
  };
  const remote = createRemote({ secrets: { getMachine: () => ({ sshTarget: target }) }, tunnels });
  const [first, second] = await Promise.all([remote.connect('li2', 'first'), remote.connect('li2', 'second')]);
  assert.equal(starts, 1);
  assert.equal(first.client, second.client);
  assert.deepEqual([...owners], ['first', 'second']);
  await first.release();
  await second.release();
  assert.equal(owners.size, 0);
});

test('ssh-tunnel：假 ssh 按需建隧道、复用、无活跃任务自动关闭、掉线退避重连与零令牌泄露', async (t) => {
  const { createTunnelManager } = await importLib('ssh-tunnel.js');
  const root = tmpDir(t);
  const fakeSsh = path.join(root, 'fake-ssh');
  const stateDir = path.join(root, 'ssh-state');
  fs.mkdirSync(stateDir, { recursive: true });
  const spawnLog = path.join(stateDir, 'spawns.jsonl');

  // 用 Node 写假 ssh：解析 -L 127.0.0.1:<local>:127.0.0.1:<remote> 并真正监听 localPort；支持 sh -s 与故障注入
  fs.writeFileSync(fakeSsh, `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
let forward = null;
let target = null;
let remoteCmd = null;
let afterDash = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!afterDash && a === '--') { afterDash = true; continue; }
  if (!afterDash && a === '-L') { forward = args[++i]; continue; }
  if (!afterDash && (a === '-o' || a === '-p')) { i++; continue; }
  if (!afterDash && a.startsWith('-')) continue;
  if (!target) target = a;
  else remoteCmd = (remoteCmd ? remoteCmd + ' ' : '') + a;
}
const modeFile = ${JSON.stringify(path.join(stateDir, 'mode.txt'))};
const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'ok';
fs.appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify({ pid: process.pid, forward, remoteCmd, mode }) + '\\n');

if (mode === 'fail-with-secret') {
  process.stderr.write('Permission denied for ' + target + ' (publickey)\\n');
  process.exit(255);
}

if (remoteCmd === 'sh -s') {
  const input = fs.readFileSync(0, 'utf8');
  const r = spawnSync('/bin/sh', ['-s'], { input, stdio: ['pipe', 'inherit', 'inherit'] });
  process.exit(r.status === null ? 1 : r.status);
}

const localPort = Number(forward.split(':')[1]);
const srv = net.createServer((sock) => {
  sock.write('TUNNEL_OK\\n');
  sock.end();
});
srv.listen(localPort, '127.0.0.1');
process.on('SIGTERM', () => { srv.close(() => process.exit(0)); });
process.on('SIGINT', () => { srv.close(() => process.exit(0)); });
`, { mode: 0o755 });

  const logs = [];
  const disconnects = [];
  const reconnects = [];
  const manager = createTunnelManager({
    sshBin: fakeSsh,
    controlDir: path.join(root, 'ctrl'),
    idleCloseMs: 80,
    backoffMs: [50, 100],
    connectTimeoutMs: 3000,
    readyPollIntervalMs: 20,
    stopGraceMs: 500,
    logger: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
    onDisconnect: (ev) => disconnects.push(ev),
    onReconnect: (ev) => reconnects.push(ev),
  });
  t.after(() => manager.closeAll());

  const secretToken = 'ibssh_SuperSecretTunnelTok7788';
  const sshTarget = `${secretToken}@li2.instabox.test`;

  // 1. 按需建立并复用同一隧道
  const t1 = await manager.acquire('li2', 'task-1', { sshTarget, remotePort: 3080 });
  assert.equal(t1.reused, false);
  assert.ok(t1.localPort > 0);
  const pid1 = manager.status('li2').pid;
  assert.equal(pidAlive(pid1), true);

  const t2 = await manager.acquire('li2', 'task-2', { sshTarget, remotePort: 3080 });
  assert.equal(t2.reused, true);
  assert.equal(t2.localPort, t1.localPort);
  assert.equal(manager.status('li2').activeOwners, 2);
  assert.equal(fs.readFileSync(spawnLog, 'utf8').trim().split('\n').length, 1, '复用不新起 ssh');

  // 2. 意外掉线时有活跃任务自动退避重连
  process.kill(pid1, 'SIGKILL');
  assert.ok(await waitFor(() => reconnects.length >= 1, 3000), '掉线后应自动重连');
  assert.equal(disconnects.length, 1);
  assert.equal(disconnects[0].willReconnect, true);
  const pid2 = manager.status('li2').pid;
  assert.ok(pid2 && pid2 !== pid1 && pidAlive(pid2));

  // 3. 仅剩 0 个活跃任务时自动关闭隧道
  await manager.release('li2', 'task-1');
  await sleep(120);
  assert.equal(manager.status('li2').state, 'open', '仍有 task-2 活跃，隧道不断');
  await manager.release('li2', 'task-2');
  assert.ok(await waitFor(() => manager.status('li2').state === 'closed', 2000), '无活跃任务应自动断开');
  assert.ok(await waitFor(() => !pidAlive(pid2), 2000), 'ssh 进程应干净退出');

  // 4. execRemote / createSshShell 可正常执行远端脚本
  const shell = manager.createSshShell('li2', { sshTarget });
  const execRes = await shell.run('printf "HELLO_REMOTE\\n"');
  assert.equal(execRes.exitCode, 0);
  assert.equal(execRes.stdout.trim(), 'HELLO_REMOTE');

  // 5. 失败报错、status() 与日志中绝不泄露 ibssh_ 令牌
  fs.writeFileSync(path.join(stateDir, 'mode.txt'), 'fail-with-secret');
  let caught = null;
  try {
    await manager.acquire('li', 'task-err', { sshTarget: `${secretToken}@li.instabox.test`, remotePort: 3080 });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, '失败时应抛错');
  assert.ok(!caught.message.includes('SuperSecretTunnelTok7788'), `异常泄露令牌：${caught.message}`);
  const statusJson = JSON.stringify(manager.listStatuses());
  assert.ok(!statusJson.includes('SuperSecretTunnelTok7788'), `status 泄露令牌：${statusJson}`);
  for (const line of logs) {
    assert.ok(!line.includes('SuperSecretTunnelTok7788'), `日志泄露令牌：${line}`);
  }

  await t.test('就绪轮询期间系统时钟向前校准不会提前超时', async (clockTest) => {
    fs.writeFileSync(path.join(stateDir, 'mode.txt'), 'ok');
    const wallTime = Date.now();
    let reads = 0;
    clockTest.mock.method(Date, 'now', () => wallTime + (reads++ === 0 ? 0 : 3600_000));

    const tunnel = await manager.acquire('li2', 'task-clock', { sshTarget, remotePort: 3080 });
    assert.ok(tunnel.localPort > 0);
  });
  await t.test('两个同时等待就绪的任务只开一条隧道', async () => {
    const before = fs.readFileSync(spawnLog, 'utf8').trim().split('\n').length;
    const opts = { sshTarget, remotePort: 3080 };
    const [first, second] = await Promise.all([manager.acquire('parallel', 'task-3', opts), manager.acquire('parallel', 'task-4', opts)]);
    const spawned = fs.readFileSync(spawnLog, 'utf8').trim().split('\n').slice(before).map(line => JSON.parse(line));
    try {
      assert.equal(first.localPort, second.localPort);
      assert.equal(manager.status('parallel').activeOwners, 2);
      assert.equal(spawned.length, 1);
    } finally {
      for (const { pid } of spawned) {
        if (pid !== manager.status('parallel').pid) {
          try { process.kill(pid, 'SIGTERM'); } catch {}
        }
      }
    }
  });
});
