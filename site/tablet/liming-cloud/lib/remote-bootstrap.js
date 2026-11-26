// 独立隔离 DSH Go ~/.dsh-app-remote/ 托管启动约定。
// 严格对照上游 ccch1mneyyy/dsh-go 的 app/lib/remote/ssh/remote_bootstrap.dart：
//   - 状态目录：$HOME/.dsh-app-remote（权限 700）
//   - web.pid：托管 dsh web 进程号
//   - web.st：进程启动时间（/proc/$pid/stat 第 22 字段，退回 ps -o lstart=），防止 PID 复用误杀
//   - web.cmd：启动命令一致性校验（默认固定 /data/home/.local/bin/dsh-tablet）
//   - web.log：启动日志（每次启动截断，解析最新 token= URL）
// 安全边界：进程清理只限本约定托管的 dsh web 实例本身；发现运行中且 web.cmd 不一致的共享实例时，
// 绝不杀进程，直接抛出 code === 'shared' 错误。
import { spawn } from 'node:child_process';
import { redactText } from './redact.js';

export const REMOTE_STATE_DIR = '$HOME/.dsh-app-remote';
export const DEFAULT_LAUNCH_COMMAND = '/data/home/.local/bin/dsh-tablet';
export const TAG = 'DSHAPP';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_CMD_RE = /[\r\n\0;|&`><]|\$\(/;

export class RemoteBootstrapError extends Error {
  constructor(code, message, { detail = '', retryable = false } = {}) {
    super(redactText(message));
    this.name = 'RemoteBootstrapError';
    this.code = code;
    this.detail = redactText(detail);
    this.retryable = retryable;
  }
}

export function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function remotePathExpr(p) {
  const trimmed = String(p || '').trim();
  if (trimmed === '~') return '"$HOME"';
  if (trimmed.startsWith('~/')) return `"$HOME"/${shQuote(trimmed.slice(2))}`;
  return shQuote(trimmed);
}

export function validateLaunchCommand(cmd) {
  const trimmed = typeof cmd === 'string' ? cmd.trim() : '';
  const effective = trimmed || DEFAULT_LAUNCH_COMMAND;
  if (UNSAFE_CMD_RE.test(effective)) {
    throw new RemoteBootstrapError('invalid_command', '非法的远端启动命令（含禁止的 Shell 元字符）');
  }
  return effective;
}

export function parseLaunchUrl(text) {
  if (typeof text !== 'string' || !text) return null;
  const match = /https?:\/\/\S+/.exec(text);
  if (!match) return null;
  let url;
  try {
    url = new URL(match[0]);
  } catch {
    return null;
  }
  const token = url.searchParams.get('token');
  if (!token) return null;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const cleanPath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return {
    baseUrl: `${url.protocol}//${url.hostname}:${port}${cleanPath}`,
    host: url.hostname,
    port,
    token,
    authority: `127.0.0.1:${port}`,
  };
}

export function buildPrelude({ environment = {} } = {}) {
  const lines = ['umask 077'];
  for (const [k, v] of Object.entries(environment)) {
    if (!ENV_KEY_RE.test(k)) continue;
    lines.push(`${k}=${shQuote(v)}; export ${k}`);
  }
  lines.push(`D="${REMOTE_STATE_DIR}"`);
  lines.push(`_st() {
  if [ -r "/proc/$1/stat" ]; then
    S=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
    S=\${S##*) }
    set -- $S
    [ "$#" -ge 20 ] || return 1
    shift 19
    printf '%s\\n' "$1"
  else
    ps -p "$1" -o lstart= 2>/dev/null
  fi
}
ours() {
  kill -0 "$1" 2>/dev/null || return 1
  if [ -f "$D/web.st" ]; then
    A=$(_st "$1") || return 1
    B=$(cat "$D/web.st" 2>/dev/null) || return 1
    [ -n "$A" ] && [ -n "$B" ] && [ "$A" = "$B" ]
    return $?
  fi
  A=$(ps -p "$1" -o args= 2>/dev/null) || return 1
  case "$A" in
    *'--host 127.0.0.1 --port 0 --no-open'*) return 0;;
    *) return 1;;
  esac
}`);
  return lines.join('\n') + '\n';
}

export function buildProbeScript({ launchCommand = DEFAULT_LAUNCH_COMMAND, environment = {} } = {}) {
  const cmd = validateLaunchCommand(launchCommand);
  return (
    buildPrelude({ environment }) +
    `printf '${TAG} home %s\\n' "$HOME"\n` +
    'if [ -f "$D/web.pid" ]; then\n' +
    '  P=$(cat "$D/web.pid" 2>/dev/null)\n' +
    '  if [ -n "$P" ] && ours "$P"; then\n' +
    `    printf '${TAG} alive %s\\n' "$P"\n` +
    `    if [ "$(cat "$D/web.cmd" 2>/dev/null)" = ${shQuote(cmd)} ]; then printf '${TAG} samecmd\\n'; fi\n` +
    '    L=$(grep -E \'https?://[^ ]*[?&]token=\' "$D/web.log" 2>/dev/null | tail -n 1)\n' +
    `    printf '${TAG} url %s\\n' "$L"\n` +
    '  else\n' +
    '    rm -f "$D/web.pid"\n' +
    '  fi\n' +
    'fi\n' +
    'true\n'
  );
}

// 严格限缩停止脚本：仅当 PID 属于托管进程（ours）且 web.cmd 与预期启动命令完全一致时才停止；
// 命令不一致时不杀进程，输出 DSHAPP shared 并以退出码 73 拒绝。
export function buildStopScript({ launchCommand = DEFAULT_LAUNCH_COMMAND, environment = {} } = {}) {
  const cmd = validateLaunchCommand(launchCommand);
  return (
    buildPrelude({ environment }) +
    'if [ -f "$D/web.pid" ]; then\n' +
    '  P=$(cat "$D/web.pid" 2>/dev/null)\n' +
    '  if [ -n "$P" ] && ours "$P"; then\n' +
    `    if [ "$(cat "$D/web.cmd" 2>/dev/null)" != ${shQuote(cmd)} ]; then\n` +
    `      printf '${TAG} shared\\n'; exit 73\n` +
    '    fi\n' +
    '    if command -v pkill >/dev/null 2>&1; then pkill -TERM -P "$P" 2>/dev/null; fi\n' +
    '    kill "$P" 2>/dev/null\n' +
    '    i=0; while kill -0 "$P" 2>/dev/null && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done\n' +
    '    ours "$P" && kill -9 "$P" 2>/dev/null\n' +
    '    rm -f "$D/web.pid" "$D/web.st"\n' +
    '  else\n' +
    '    rm -f "$D/web.pid"\n' +
    '  fi\n' +
    'fi\n' +
    'true\n'
  );
}

export function buildStartScript({
  launchCommand = DEFAULT_LAUNCH_COMMAND,
  workingDirectory = null,
  environment = {},
  startTimeoutSec = 60,
} = {}) {
  const cmd = validateLaunchCommand(launchCommand);
  const seconds = Math.max(1, Math.min(600, Math.floor(Number(startTimeoutSec) || 60)));
  const cwd = typeof workingDirectory === 'string' ? workingDirectory.trim() : '';
  const lines = [
    buildPrelude({ environment }).trimEnd(),
    `printf '${TAG} home %s\\n' "$HOME"`,
    `mkdir -p "$D" || { printf '${TAG} nodir\\n'; exit 70; }`,
    'chmod 700 "$D" 2>/dev/null',
    // 启动前再次检查是否已有活着的托管实例：绝不强杀，直接报 shared（对齐 remote_bootstrap.dart）。
    'if [ -f "$D/web.pid" ]; then',
    '  P=$(cat "$D/web.pid" 2>/dev/null)',
    `  if [ -n "$P" ] && ours "$P"; then printf '${TAG} shared\\n'; exit 73; fi`,
    '  rm -f "$D/web.pid"',
    'fi',
  ];
  if (cwd) {
    lines.push(`cd ${remotePathExpr(cwd)} 2>/dev/null || printf '${TAG} nocwd\\n'`);
  }
  lines.push(
    `printf '%s' ${shQuote(cmd)} > "$D/web.cmd"`,
    ': > "$D/web.log"',
    'NO_COLOR=1; export NO_COLOR',
    'N=""; if command -v nohup >/dev/null 2>&1; then N=nohup; fi',
    `$N ${cmd} --host 127.0.0.1 --port 0 --no-open </dev/null >>"$D/web.log" 2>&1 &`,
    'P=$!',
    '_st "$P" > "$D/web.st"',
    'printf \'%s\\n\' "$P" > "$D/web.pid"',
    `printf '${TAG} started %s\\n' "$P"`,
    'i=0',
    `while [ $i -lt ${seconds} ]; do`,
    '  L=$(grep -E \'https?://[^ ]*[?&]token=\' "$D/web.log" 2>/dev/null | tail -n 1)',
    `  if [ -n "$L" ]; then printf '${TAG} url %s\\n' "$L"; exit 0; fi`,
    '  if ! kill -0 "$P" 2>/dev/null; then',
    `    printf '${TAG} exited\\n'; tail -n 20 "$D/web.log" 2>/dev/null | sed 's/^/${TAG} log /'; exit 1`,
    '  fi',
    '  sleep 1; i=$((i+1))',
    'done',
    `printf '${TAG} timeout\\n'; tail -n 20 "$D/web.log" 2>/dev/null | sed 's/^/${TAG} log /'; exit 1`,
  );
  return lines.join('\n') + '\n';
}

function* taggedLines(stdout) {
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith(`${TAG} `)) continue;
    const rest = line.slice(TAG.length + 1);
    const space = rest.indexOf(' ');
    if (space < 0) yield [rest, ''];
    else yield [rest.slice(0, space), rest.slice(space + 1)];
  }
}

function looksMissingShell(result) {
  if (String(result?.stdout || '').includes(TAG)) return false;
  return /'sh' is not recognized|sh: (command )?not found|command not found: sh|No such file or directory.*\bsh\b/.test(
    String(result?.stderr || ''),
  );
}

function looksNotFound(log) {
  return /command not found|not found|No such file or directory|can.t open|ENOENT/i.test(log);
}

export function parseProbe(stdout) {
  let home = null;
  let pid = null;
  let sameCommand = false;
  let launchLine = null;
  for (const [key, value] of taggedLines(stdout)) {
    if (key === 'home') home = value || null;
    else if (key === 'alive') {
      const n = Number.parseInt(value.trim(), 10);
      if (Number.isInteger(n) && n > 0) pid = n;
    } else if (key === 'samecmd') {
      sameCommand = true;
    } else if (key === 'url') {
      launchLine = value.trim() || null;
    }
  }
  const launchUrl = parseLaunchUrl(launchLine);
  const reusable = pid !== null && sameCommand && launchUrl !== null;
  return { home, pid, sameCommand, launchLine, launchUrl, reusable };
}

export function parseStart(result, { launchCommand = DEFAULT_LAUNCH_COMMAND } = {}) {
  if (looksMissingShell(result)) {
    throw new RemoteBootstrapError('no_shell', '远端主机缺少 POSIX sh，无法执行托管启动', {
      detail: String(result?.stderr || '').trim(),
    });
  }
  let home = null;
  let pid = null;
  let urlLine = null;
  let noDsh = false;
  let exited = false;
  let timedOut = false;
  const logLines = [];

  for (const [key, value] of taggedLines(result?.stdout || '')) {
    if (key === 'home') home = value || null;
    else if (key === 'started') {
      const n = Number.parseInt(value.trim(), 10);
      if (Number.isInteger(n) && n > 0) pid = n;
    } else if (key === 'url') {
      urlLine = value.trim();
    } else if (key === 'shared') {
      throw new RemoteBootstrapError(
        'shared',
        '远端已有另一条启动命令拉起的托管 dsh web 实例在运行，已拒绝覆盖或强杀',
      );
    } else if (key === 'nodsh') {
      noDsh = true;
    } else if (key === 'exited') {
      exited = true;
    } else if (key === 'timeout') {
      timedOut = true;
    } else if (key === 'log') {
      logLines.push(value);
    }
  }

  const parsed = parseLaunchUrl(urlLine);
  if (parsed) {
    return {
      port: parsed.port,
      token: parsed.token,
      pid,
      reused: false,
      home,
      authority: `127.0.0.1:${parsed.port}`,
    };
  }

  const tail = redactText(logLines.filter(l => l.trim().length > 0).join('\n')).trim();
  if (noDsh || (exited && looksNotFound(tail))) {
    throw new RemoteBootstrapError('not_found', `远端找不到启动命令：${launchCommand}`, { detail: tail });
  }
  if (timedOut) {
    throw new RemoteBootstrapError('timeout', '等待远端 dsh web 输出启动地址超时', { detail: tail, retryable: true });
  }
  if (exited) {
    throw new RemoteBootstrapError('exited', '远端 dsh web 启动后意外退出', { detail: tail });
  }
  const stderr = redactText(String(result?.stderr || '').trim());
  throw new RemoteBootstrapError('start_failed', `远端 dsh web 启动失败（exit=${result?.exitCode ?? 'null'}）`, {
    detail: stderr.split('\n').slice(0, 6).join('\n'),
  });
}

// 本地 /bin/sh 执行器（对照 remote_shell.dart 的 LocalProcessShell，用于离线单测与本机调试）。
export function createLocalShell({ env = process.env, cwd } = {}) {
  return {
    run(script, { timeoutMs = 30000, signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new RemoteBootstrapError('aborted', '本地 sh 执行已取消'));
          return;
        }
        const child = spawn('/bin/sh', ['-c', script], {
          env,
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const out = [];
        const err = [];
        child.stdout.on('data', chunk => out.push(chunk));
        child.stderr.on('data', chunk => err.push(chunk));

        let settled = false;
        let timer = null;
        const cleanup = () => {
          if (timer) { clearTimeout(timer); timer = null; }
          if (signal) signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          try { child.kill('SIGKILL'); } catch {}
          if (!settled) {
            settled = true;
            cleanup();
            reject(new RemoteBootstrapError('aborted', '本地 sh 执行已取消'));
          }
        };

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
            if (!settled) {
              settled = true;
              cleanup();
              resolve({
                exitCode: -1,
                stdout: Buffer.concat(out).toString('utf8'),
                stderr: Buffer.concat(err).toString('utf8') + '\ntimeout',
              });
            }
          }, timeoutMs);
          timer.unref?.();
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        child.on('error', (e) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new RemoteBootstrapError('start_failed', `执行 /bin/sh 失败：${e.message}`));
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            exitCode: code,
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(err).toString('utf8'),
          });
        });
      });
    },
  };
}

export function createRemoteBootstrap(shell, options = {}) {
  const launchCommand = validateLaunchCommand(options.launchCommand || DEFAULT_LAUNCH_COMMAND);
  const workingDirectory = options.workingDirectory || null;
  const environment = options.environment || {};
  const startTimeoutSec = options.startTimeoutSec || 60;
  const probeTimeoutMs = options.probeTimeoutMs || 20000;

  async function probe(opts = {}) {
    const script = buildProbeScript({ launchCommand, environment });
    const result = await shell.run(script, { timeoutMs: opts.timeoutMs || probeTimeoutMs, signal: opts.signal });
    if (looksMissingShell(result)) {
      throw new RemoteBootstrapError('no_shell', '远端主机缺少 POSIX sh', { detail: result.stderr });
    }
    return parseProbe(result.stdout);
  }

  async function start(opts = {}) {
    const script = buildStartScript({ launchCommand, workingDirectory, environment, startTimeoutSec });
    const timeoutMs = opts.timeoutMs || (startTimeoutSec + 20) * 1000;
    const result = await shell.run(script, { timeoutMs, signal: opts.signal });
    return parseStart(result, { launchCommand });
  }

  async function ensureRunning(opts = {}) {
    const info = await probe(opts);
    if (info.reusable) {
      return {
        port: info.launchUrl.port,
        token: info.launchUrl.token,
        pid: info.pid,
        reused: true,
        home: info.home,
        authority: `127.0.0.1:${info.launchUrl.port}`,
      };
    }
    if (info.pid !== null) {
      throw new RemoteBootstrapError(
        'shared',
        '远端已有其他命令或不可复用的托管 dsh web 实例在运行，不自动强杀，请先在云机确认',
      );
    }
    return start(opts);
  }

  async function stop(opts = {}) {
    const script = buildStopScript({ launchCommand, environment });
    const result = await shell.run(script, { timeoutMs: opts.timeoutMs || 15000, signal: opts.signal });
    if (looksMissingShell(result)) {
      throw new RemoteBootstrapError('no_shell', '远端主机缺少 POSIX sh', { detail: result.stderr });
    }
    for (const [key] of taggedLines(result.stdout)) {
      if (key === 'shared') {
        throw new RemoteBootstrapError(
          'shared',
          '远端托管 dsh web 实例由其他启动命令拉起，拒绝停止',
        );
      }
    }
    return { stopped: true };
  }

  return {
    launchCommand,
    probe,
    start,
    ensureRunning,
    stop,
  };
}
