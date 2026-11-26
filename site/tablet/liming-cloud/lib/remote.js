// 连到一台云电脑：经 SSH 确保那台的常驻 dsh web 在跑（照 DSH Go 的 ~/.dsh-app-remote 约定，见 remote-bootstrap.js），
// 开本机隧道，用启动令牌登录，拿到 DshClient。同一台机器的客户端缓存复用；隧道断了、端口变了就重新来。
// direct 只给测试和调试用：直接给 { 机器名: { baseUrl, token } }，远端命令在本机 sh 里跑。
import { DshClient } from './dsh-client.js';
import { DEFAULT_LAUNCH_COMMAND, createLocalShell, createRemoteBootstrap, shQuote } from './remote-bootstrap.js';

export class RemoteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
  }
}

// 清掉工作目录在项目目录下的进程：先 TERM，3 秒后还在的 KILL，再看还剩哪些（僵尸进程不算）。
// 只认 /proc/<pid>/cwd 等于项目目录或在它下面的，项目目录以外的进程不碰。
export function leftoverScript(cwd) {
  const d = shQuote(cwd);
  return [
    `D=${d}`,
    'alive() { s=$(sed "s/.*) //" "/proc/$1/stat" 2>/dev/null | cut -d" " -f1) || return 1; [ -n "$s" ] && [ "$s" != Z ]; }',
    'P=""',
    'for p in /proc/[0-9]*; do',
    '  pid=${p#/proc/}; [ "$pid" = "$$" ] && continue',
    '  c=$(readlink "$p/cwd" 2>/dev/null) || continue',
    '  case "$c" in "$D"|"$D"/*) P="$P $pid";; esac',
    'done',
    'L=""',
    'if [ -n "$P" ]; then kill -TERM $P 2>/dev/null; sleep 3; for pid in $P; do alive "$pid" && L="$L $pid"; done; fi',
    'R=""',
    'if [ -n "$L" ]; then kill -KILL $L 2>/dev/null; sleep 1; for pid in $L; do alive "$pid" && R="$R $pid"; done; fi',
    'printf "LMC found%s\\n" "$P"',
    'printf "LMC remain%s\\n" "$R"',
  ].join('\n');
}

export function parseLeftovers(stdout) {
  const pick = key => {
    const line = String(stdout || '').split('\n').find(l => l.startsWith(`LMC ${key}`));
    return line ? line.slice(`LMC ${key}`.length).trim().split(/\s+/).filter(Boolean).map(Number) : null;
  };
  const found = pick('found');
  const remain = pick('remain');
  if (!found || !remain) return null;
  return { found, remain };
}

export function createRemote({ secrets, tunnels, launchCommand = DEFAULT_LAUNCH_COMMAND, direct = null, loginTimeoutMs = 15000 } = {}) {
  const cache = new Map();

  function machines() {
    if (direct) return Object.keys(direct).sort();
    return secrets.listMachines().filter(name => {
      const m = secrets.getMachine(name);
      return Boolean(m && m.sshTarget);
    });
  }

  function sshSpec(machine) {
    const m = secrets.getMachine(machine);
    if (!m || !m.sshTarget) throw new RemoteError('NO_SSH_TARGET', `${machine} 还没装 SSH 令牌，重跑一次平板装机脚本`);
    return { sshTarget: m.sshTarget, sshPort: m.sshPort || 22 };
  }

  function shellFor(machine) {
    if (direct) {
      if (!direct[machine]) throw new RemoteError('NO_SSH_TARGET', `没有配置机器 ${machine}`);
      return createLocalShell();
    }
    return tunnels.createSshShell(machine, sshSpec(machine));
  }

  async function connect(machine, ownerId) {
    if (direct) {
      const d = direct[machine];
      if (!d) throw new RemoteError('NO_SSH_TARGET', `没有配置机器 ${machine}`);
      let c = cache.get(machine);
      if (!c) {
        c = { client: await DshClient.login(d.baseUrl, d.token, { timeoutMs: loginTimeoutMs }) };
        cache.set(machine, c);
      }
      return { client: c.client, release() {} };
    }
    const spec = sshSpec(machine);
    let c = cache.get(machine);
    if (c) {
      const st = tunnels.status(machine);
      if (!st || st.state !== 'open' || st.localPort !== c.localPort) { cache.delete(machine); c = null; }
    }
    if (!c) {
      const boot = createRemoteBootstrap(shellFor(machine), { launchCommand });
      const info = await boot.ensureRunning();
      const t = await tunnels.acquire(machine, ownerId, { ...spec, remotePort: info.port });
      try {
        const client = await DshClient.login(t.baseUrl, info.token, { timeoutMs: loginTimeoutMs });
        c = { client, localPort: t.localPort, remotePort: info.port };
        cache.set(machine, c);
      } catch (err) {
        await tunnels.release(machine, ownerId);
        throw err;
      }
    } else {
      await tunnels.acquire(machine, ownerId, { ...spec, remotePort: c.remotePort });
    }
    let released = false;
    return { client: c.client, release: () => { if (!released) { released = true; return tunnels.release(machine, ownerId); } } };
  }

  function invalidate(machine) {
    cache.delete(machine);
  }

  async function exec(machine, script, opts = {}) {
    return shellFor(machine).run(script, opts);
  }

  async function ensureProjectDir(machine, cwd) {
    const r = await exec(machine, `mkdir -p ${shQuote(cwd)}`, { timeoutMs: 30000 });
    if (r.exitCode !== 0) throw new RemoteError('MKDIR_FAILED', `${machine} 上建不了项目目录：${String(r.stderr || '').trim().slice(0, 200)}`);
  }

  async function killLeftovers(machine, cwd) {
    const r = await exec(machine, leftoverScript(cwd), { timeoutMs: 30000 });
    const parsed = parseLeftovers(r.stdout);
    if (!parsed) throw new RemoteError('LEFTOVER_CHECK_FAILED', `${machine} 上查残留进程失败：${String(r.stderr || '').trim().slice(0, 200)}`);
    return parsed;
  }

  return { machines, connect, invalidate, exec, ensureProjectDir, killLeftovers };
}
