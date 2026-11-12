/* 遗留进程（2026-11-12）：一轮做完，它起的进程不该还开着。
   起因：11-07 一轮里模型用 setsid 在桌面上开了个 Chromium（hark.com 登录页），这一轮结束后它一直开着，
   显卡进程空转占满一核 4 天，云电脑也一直睡不着。
   三层：
   1. 每一轮的命令放进自己的 systemd 用户 scope（xin-run-<轮次>-a<第几次>.scope）：cgroup 跟着进程走，setsid、nohup、两次 fork 都逃不出去
      （systemd 的 transient scope；Codex 只用进程组 + PR_SET_PDEATHSIG，管不到 setsid 甩出去的）。
      提示词让模型把想给站长看的东西开在桌面上，所以不在一轮结束时马上关：结束 2 小时后还留着的，定时器停掉它的 scope。
   2. 浏览器会自己跳出去：Chromium 有用户会话总线时会把自己挪进 app-org.chromium.Chromium-<pid>.scope。
      所以另外每 10 分钟看一次（systemd 定时器）：不是小芯自己管的浏览器，开了 2 小时以上、连续半小时以上空转占 CPU，
      或者不管忙不忙已经开了 12 小时以上，就关掉。
   3. 别的进程长时间占满 CPU（不是这一轮的、不是系统服务）：只记下来提醒，不杀（可能是站长自己在桌面上开的）。
   参考 Codex codex-rs/utils/pty/src/process_group.rs、systemd transient scope、GitHub Actions runner 作业结束时清理孤儿进程。
   这个文件不 import 别的 vm-*.mjs。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const REAPER = { runGrace: 2 * 3600e3, browserAge: 2 * 3600, browserHot: 0.3, browserFor: 30 * 60e3, browserMax: 12 * 3600, hogHot: 0.8, hogFor: 2 * 3600e3 };
const RUN_SCOPE = /^xin-run-[A-Za-z0-9_-]{1,64}$/;
const UNIT_OK = /^[A-Za-z0-9@._:-]{1,200}\.(scope|service)$/;
const BROWSERS = new Set(['chromium', 'chrome', 'google-chrome', 'chromium-browse', 'chrome-linux', 'firefox', 'firefox-esr', 'firefox-bin']);
// 小芯自己管的浏览器：任务浏览器、登录窗口（CDP 走管道）、网页成品检查（临时资料 web-browser-）
const OURS = /--remote-debugging-pipe|--user-data-dir=\S*(\/\.xin(-tasks)?\/|xin-task-|login-window-profile|browser-profile|web-browser-)/;

const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 等不了就不等 */ } };
const whichCache = new Map();
function which(c) {
  if (!whichCache.has(c)) whichCache.set(c, (process.env.PATH || '/usr/bin:/bin').split(':').some(d => d && fs.existsSync(path.join(d, c))));
  return whichCache.get(c);
}
const uidNow = () => (typeof process.getuid === 'function' ? process.getuid() : 0);
const busEnv = (env, uid) => {
  const e = { ...env }, dir = '/run/user/' + uid;
  if (!e.XDG_RUNTIME_DIR) e.XDG_RUNTIME_DIR = dir;
  if (!e.DBUS_SESSION_BUS_ADDRESS) e.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + dir + '/bus';
  return e;
};

// 第 1 层：把这一轮的命令包进 systemd-run --user --scope（它建好 scope 后直接 exec 原命令，进程号不变）
export function scoped(cmd, args, { unit, env = {}, exists = fs.existsSync, which: has = which, uid = uidNow() } = {}) {
  if (!RUN_SCOPE.test(String(unit || ''))) throw Error('不认的 scope 名字：' + unit);
  // XIN_SYSTEMD_BUS 只给测试用：假的 systemd-run 也走这条路
  if (!exists(process.env.XIN_SYSTEMD_BUS || '/run/user/' + uid + '/bus') || !has('systemd-run')) return { cmd, args, env, scope: null };
  return { cmd: 'systemd-run', args: ['--user', '--scope', '--unit=' + unit, '--collect', '--quiet', '--', cmd, ...args], env: busEnv(env, uid), scope: unit + '.scope' };
}
export function stopUnitNow(unit, { exec = spawnSync, wait = sleepSync, env = process.env, uid = uidNow() } = {}) {
  const e = busEnv(env, uid), run = a => exec('systemctl', ['--user', ...a], { env: e, timeout: 5000, stdio: 'ignore' });
  run(['kill', '--signal=SIGTERM', unit]); wait(1500);
  run(['kill', '--signal=SIGKILL', unit]);
  run(['stop', unit]);
  return true;
}
/* ---------- 读进程 ---------- */
export function readProcs({ root = '/proc', hz = 100 } = {}) {
  let uptime = 0; try { uptime = parseFloat(fs.readFileSync(path.join(root, 'uptime'), 'utf8')); } catch { /* 没有就算 0 */ }
  const out = [];
  let names = []; try { names = fs.readdirSync(root).filter(n => /^\d+$/.test(n)); } catch { return out; }
  for (const n of names) {
    try {
      const stat = fs.readFileSync(path.join(root, n, 'stat'), 'utf8');
      const a = stat.indexOf('('), b = stat.lastIndexOf(')');
      const comm = stat.slice(a + 1, b), t = stat.slice(b + 2).trim().split(/\s+/), f = i => Number(t[i - 2]) || 0;
      const args = fs.readFileSync(path.join(root, n, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ');
      const cg = (fs.readFileSync(path.join(root, n, 'cgroup'), 'utf8').split('\n').find(l => l.startsWith('0::')) || '0::/').slice(3).trim();
      const uidLine = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(path.join(root, n, 'status'), 'utf8'));
      const start = f(21);
      out.push({ pid: Number(n), comm, args, uid: uidLine ? Number(uidLine[1]) : -1, cpu: (f(13) + f(14)) / hz, start, age: uptime - start / hz,
        unit: cg.split('/').filter(x => /\.(scope|service)$/.test(x)).pop() || '', slice: cg.startsWith('/system.slice') ? 'system' : cg.startsWith('/user.slice') ? 'user' : 'other' });
    } catch { /* 读的时候已经退了 */ }
  }
  return out;
}

/* ---------- 判断（纯函数，好测） ---------- */
const key = p => p.pid + ':' + p.start;
const host = args => { const m = /https?:\/\/([^/\s:]+)/.exec(args || ''); return m ? m[1] : ''; };
const isBrowserMain = p => BROWSERS.has(p.comm) && !/(^|\s)--type=/.test(p.args);
// ended(run)：这一轮结束的时间；还在做返回 null；找不到记录（对话删了）返回 0
export function decide({ prev, cur, state = {}, ended = () => null, opts = {} }) {
  const O = { ...REAPER, ...opts }, hot = {}, actions = [], alerts = [];
  const dt = prev ? (cur.at - prev.at) / 1000 : 0, before = new Map((prev?.procs || []).map(p => [key(p), p]));
  const frac = p => { const q = before.get(key(p)); return dt > 0 && q ? Math.max(0, (p.cpu - q.cpu) / dt) : 0; };
  const since = (k, isHot) => { if (!isHot) return null; hot[k] = state.hot?.[k] ?? prev.at; return hot[k]; };
  const units = new Map();
  for (const p of cur.procs) { if (!units.has(p.unit)) units.set(p.unit, []); units.get(p.unit).push(p); }
  const handled = new Set();
  for (const [unit, ps] of units) {
    // 第 1 层兜底：结束了的那一轮的 scope 里还有进程
    const m = /^xin-run-([A-Za-z0-9_]+?)(?:-a\d+)?\.scope$/.exec(unit);
    if (m) {
      const end = ended(m[1]);
      if (end != null && cur.at - end >= O.runGrace) actions.push({ kind: 'stop', unit, pids: ps.map(p => p.pid), name: ps[0].comm, reason: '这一轮已经结束' + (end ? ' ' + Math.round((cur.at - end) / 3600e3) + ' 小时' : '') + '，它起的进程还开着' });
      ps.forEach(p => handled.add(key(p))); continue;
    }
    // 第 2 层：不是自己管的浏览器，开得久、一直空转
    const main = ps.find(isBrowserMain);
    if (!main || !unit || OURS.test(main.args)) continue;
    ps.forEach(p => handled.add(key(p)));
    const name = [main.comm, host(main.args)].filter(Boolean).join(' ');
    if (main.age >= O.browserMax) { actions.push({ kind: 'stop', unit, pids: ps.map(p => p.pid), name, reason: '不是小芯自己管的浏览器，已经在桌面上开了 ' + Math.round(main.age / 3600) + ' 小时' }); continue; }
    if (main.age < O.browserAge || !prev) continue;
    const use = ps.reduce((s, p) => s + frac(p), 0), k = 'b:' + unit + ':' + key(main), t = since(k, use >= O.browserHot);
    if (t != null && cur.at - t > O.browserFor) actions.push({ kind: 'stop', unit, pids: ps.map(p => p.pid), name,
      reason: '不是小芯自己管的浏览器，开了 ' + Math.round(main.age / 3600) + ' 小时，最近 ' + Math.round((cur.at - t) / 60e3) + ' 分钟一直占 CPU（约 ' + Math.round(use * 100) + '%）' });
  }
  // 第 3 层：别的进程长时间占满 CPU，只提醒
  if (prev) for (const p of cur.procs) {
    if (handled.has(key(p)) || p.slice === 'system') continue;
    const k = 'p:' + key(p), t = since(k, frac(p) >= O.hogHot);
    if (t != null && cur.at - t >= O.hogFor) alerts.push({ pid: p.pid, name: p.comm, args: p.args.slice(0, 200), unit: p.unit, hours: Math.round((cur.at - t) / 360e3) / 10 });
  }
  return { actions, alerts, state: { hot } };
}

/* ---------- 每 10 分钟一次（systemd 定时器调 vm-agent.mjs reap） ---------- */
export function reapOnce({ stateFile, ended, now = Date.now(), procs = readProcs(), stop = unit => stopUnitNow(unit), log = () => {} }) {
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* 第一次 */ }
  const cur = { at: now, procs }, prev = saved.sample && now - saved.sample.at < 3600e3 ? saved.sample : null;
  const r = decide({ prev, cur, state: saved.state || {}, ended });
  const done = [];
  for (const a of r.actions) {
    if (!UNIT_OK.test(a.unit)) continue;
    let ok = false; try { ok = stop(a.unit); } catch { ok = false; }
    done.push({ ...a, ok }); log({ at: now, act: 'stop', unit: a.unit, name: a.name, pids: a.pids, reason: a.reason, ok });
  }
  const told = saved.told || {}, fresh = r.alerts.filter(a => !told[a.pid]);
  for (const a of fresh) { told[a.pid] = now; log({ at: now, act: 'alert', ...a }); }
  for (const k of Object.keys(told)) if (!r.alerts.some(a => String(a.pid) === k)) delete told[k];
  const slim = { at: now, procs: procs.map(p => ({ pid: p.pid, start: p.start, cpu: p.cpu })) };
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify({ sample: slim, state: r.state, told, alerts: r.alerts })); fs.renameSync(stateFile + '.tmp', stateFile); } catch { /* 下次再记 */ }
  return { actions: done, alerts: r.alerts };
}
