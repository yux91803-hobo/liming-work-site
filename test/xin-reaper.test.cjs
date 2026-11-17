// 遗留进程（2026-11-12 站长：「不光是清理掉，以后出现这样的问题得怎么解决」）。
// 起因：11-07 一轮里模型用 setsid 在桌面上开了个 Chromium（hark.com 登录页），这一轮结束后它一直开着，显卡进程空转占满一核 4 天，电脑也睡不着。
// 参考：Codex codex-rs/utils/pty/src/process_group.rs（进程组 + PR_SET_PDEATHSIG + killpg，管不到 setsid 甩出去的）、
// systemd 的 transient scope（cgroup 跟着进程走，setsid、两次 fork 都逃不出去；Chromium 自己也把浏览器放进 app-org.chromium.Chromium-<pid>.scope）、
// GitHub Actions runner 收尾时清理这次作业留下的孤儿进程。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const imp = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-reaper.mjs')).href);

const HZ = 100, MIN = 60e3;
// 一个进程的样本：cpu 是累计的 CPU 秒数，age 是已经活了多久（秒）
const P = (pid, o) => ({ pid, uid: 1000, comm: 'x', args: 'x', unit: 'session-1.scope', slice: 'user', cpu: 0, age: 3600 * 24, ...o });
const sample = (at, procs) => ({ at, procs: procs.map(p => ({ ...p, start: 1000 + p.pid })) });

test('每一轮的命令放进自己的 systemd scope（有用户会话的 systemd 才包；没有就照原样起，不耽误这一轮）', async () => {
  const { scoped } = await imp();
  const has = { bus: true, run: true };
  const o = { exists: f => (f.endsWith('/bus') ? has.bus : false), which: c => (c === 'systemd-run' ? has.run : false), uid: 1000 };
  let w = scoped('codex', ['exec', '--json', 'hi'], { unit: 'xin-run-rabc123', env: { PATH: '/usr/bin' }, ...o });
  assert.equal(w.cmd, 'systemd-run');
  assert.deepEqual(w.args, ['--user', '--scope', '--unit=xin-run-rabc123', '--collect', '--quiet', '--', 'codex', 'exec', '--json', 'hi']);
  assert.equal(w.env.XDG_RUNTIME_DIR, '/run/user/1000');
  assert.equal(w.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
  assert.equal(w.env.PATH, '/usr/bin');
  assert.equal(w.scope, 'xin-run-rabc123.scope');
  w = scoped('codex', ['x'], { unit: 'xin-run-rabc123', env: { XDG_RUNTIME_DIR: '/run/user/9', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, ...o });
  assert.equal(w.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/x', '已有的不改');
  has.bus = false;
  w = scoped('codex', ['x'], { unit: 'xin-run-r1', env: {}, ...o });
  assert.deepEqual([w.cmd, w.args, w.scope], ['codex', ['x'], null]);
  has.bus = true; has.run = false;
  assert.equal(scoped('codex', ['x'], { unit: 'xin-run-r1', env: {}, ...o }).cmd, 'codex');
  assert.throws(() => scoped('codex', [], { unit: 'bad unit;rm', env: {}, ...o }), /scope/);
});

test('判断：这一轮结束 2 小时以后它留下的进程 → 停掉它的 scope（桌面上给站长看的东西留够时间）；还在做的、刚结束的、删掉了记录的分别处理', async () => {
  const { decide } = await imp();
  const t0 = Date.now();
  const units = { rold000001: 'xin-run-rold000001-a1.scope', rlive00001: 'xin-run-rlive00001-a1.scope', rjust00001: 'xin-run-rjust00001-a2.scope', rgone00001: 'xin-run-rgone00001-a1.scope' };
  const ps = (i) => Object.values(units).map((u, k) => P(10 + k, { unit: u, cpu: i }));
  const ended = { rold000001: t0 - 3 * 3600e3, rlive00001: null, rjust00001: t0 - 10 * MIN, rgone00001: 0 };
  const r = decide({ prev: sample(t0, ps(5)), cur: sample(t0 + 10 * MIN, ps(6)), state: {}, ended: run => ended[run] });
  assert.deepEqual(r.actions.map(a => [a.kind, a.unit]).sort(), [['stop', 'xin-run-rgone00001-a1.scope'], ['stop', 'xin-run-rold000001-a1.scope']]);
  assert.match(r.actions[0].reason, /结束/);
});

test('判断：不是小芯自己管的浏览器，开了 2 小时以上、连续半小时空转占 CPU → 关掉；开了 12 小时以上不管忙不忙都关；自己的浏览器、刚开的、不怎么占的、系统服务都不动', async () => {
  const { decide } = await imp();
  const t0 = Date.now();
  const leak = (cpu, o = {}) => [
    P(100, { comm: 'chromium', args: '/usr/lib/chromium/chromium --user-data-dir=/tmp/chromeprof-1794023961 --new-window https://hark.com/login', unit: 'app-org.chromium.Chromium-100.scope', age: 5 * 3600, cpu: cpu * 0.1, ...o }),
    P(101, { comm: 'chromium', args: '/usr/lib/chromium/chromium --type=gpu-process', unit: 'app-org.chromium.Chromium-100.scope', age: 5 * 3600, cpu: cpu * 0.9, ...o }),
  ];
  const ours = [P(200, { comm: 'chrome', args: '/opt/chrome --remote-debugging-pipe --user-data-dir=/data/home/.xin-tasks/xin-task-s1/browser-profile', unit: 'app-org.chromium.Chromium-200.scope', age: 5 * 3600 }),
    P(201, { comm: 'chrome', args: '/opt/chrome --type=gpu-process', unit: 'app-org.chromium.Chromium-200.scope', age: 5 * 3600 })];
  const young = [P(300, { comm: 'chromium', args: '/usr/lib/chromium/chromium --new-window https://x', unit: 'app-org.chromium.Chromium-300.scope', age: 600 })];
  const gw = [P(400, { comm: 'python3', args: '/usr/bin/python3 wb_proxy.py', unit: 'workbuddy-gateway.service', slice: 'system', uid: 1000 })];
  const at = i => t0 + i * 10 * MIN;
  // 每 10 分钟采一次：泄漏的浏览器每次用掉 9 分钟 CPU（约 90%），自己的、刚开的同样很热；网关也热
  const hotAll = (i, extra = []) => sample(at(i), [...leak(i * 540), ...ours.map(p => ({ ...p, cpu: p.cpu + i * 540 })), ...young.map(p => ({ ...p, cpu: i * 540 })), ...gw.map(p => ({ ...p, cpu: i * 540 })), ...extra]);
  let state = {}, r;
  const none = () => null;
  for (let i = 1; i <= 3; i++) { r = decide({ prev: hotAll(i - 1), cur: hotAll(i), state, ended: none }); state = r.state; assert.deepEqual(r.actions, [], '热了不到半小时先不动（第 ' + i + ' 次）'); }
  r = decide({ prev: hotAll(3), cur: hotAll(4), state, ended: none }); state = r.state;
  assert.deepEqual(r.actions.map(a => [a.kind, a.unit]), [['stop', 'app-org.chromium.Chromium-100.scope']]);
  assert.match(r.actions[0].reason, /浏览器/); assert.match(r.actions[0].name, /hark\.com|chromium/);
  // 不热了就重新计时
  const cool = sample(at(5), [...leak(4 * 540 + 10).map(p => ({ ...p, age: 3 * 3600 }))]);
  r = decide({ prev: hotAll(4), cur: cool, state: {}, ended: none });
  assert.deepEqual(r.actions, [], '开了 3 小时、不怎么占：不动');
  // 不占 CPU 但在桌面上开了 12 小时以上：也关掉（给站长看的东西早该看完了）
  const old = sample(at(5), [...leak(4 * 540 + 10).map(p => ({ ...p, age: 13 * 3600 })), ...ours.map(p => ({ ...p, age: 30 * 3600 }))]);
  r = decide({ prev: hotAll(4), cur: old, state: {}, ended: none });
  assert.deepEqual(r.actions.map(a => a.unit), ['app-org.chromium.Chromium-100.scope']);
  assert.match(r.actions[0].reason, /13 小时/);
});

test('判断：别的进程长时间占满 CPU（不是这一轮的、不是系统服务）只记下来提醒，不杀', async () => {
  const { decide } = await imp();
  const t0 = Date.now();
  const hog = (i) => sample(t0 + i * 10 * MIN, [P(500, { comm: 'make', args: 'make -j1', unit: 'session-88.scope', cpu: i * 570 }), P(600, { comm: 'ffmpeg', args: 'ffmpeg', unit: 'system.slice', slice: 'system', cpu: i * 570 })]);
  let state = {}, r;
  for (let i = 1; i <= 13; i++) { r = decide({ prev: hog(i - 1), cur: hog(i), state, ended: () => null }); state = r.state; }
  assert.deepEqual(r.actions, [], '不杀');
  assert.deepEqual(r.alerts.map(a => [a.pid, a.name]), [[500, 'make']]);
  assert.ok(r.alerts[0].hours >= 2);
});

test('读进程：从 /proc 读出命令、CPU 秒数、活了多久、所在的 systemd 单元；读不到的跳过', async () => {
  const { readProcs } = await imp();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-proc-'));
  fs.writeFileSync(path.join(root, 'uptime'), '360000.00 1000.00\n');
  const mkp = (pid, comm, args, utime, stime, start, cg, uid = 1000) => {
    const d = path.join(root, String(pid)); fs.mkdirSync(d);
    const f = Array(52).fill('0'); f[13] = String(utime); f[14] = String(stime); f[21] = String(start);
    fs.writeFileSync(path.join(d, 'stat'), pid + ' (' + comm + ') S ' + f.slice(3).join(' ') + '\n');
    fs.writeFileSync(path.join(d, 'cmdline'), args.join('\0') + '\0');
    fs.writeFileSync(path.join(d, 'cgroup'), '0::' + cg + '\n');
    fs.writeFileSync(path.join(d, 'status'), 'Name:\t' + comm + '\nUid:\t' + uid + '\t' + uid + '\t' + uid + '\t' + uid + '\n');
  };
  mkp(16327, 'chromium', ['/usr/lib/chromium/chromium', '--new-window', 'https://hark.com/login'], 3000, 1000, 1000 * HZ, '/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.chromium.Chromium-16327.scope');
  mkp(385028, 'python3', ['/usr/bin/python3', 'wb_proxy.py'], 10, 10, 2000 * HZ, '/system.slice/workbuddy-gateway.service', 1000);
  fs.mkdirSync(path.join(root, '777'));   // 读的时候已经退了
  fs.mkdirSync(path.join(root, 'self'));
  const ps = readProcs({ root, hz: HZ });
  const c = ps.find(p => p.pid === 16327), g = ps.find(p => p.pid === 385028);
  assert.equal(c.comm, 'chromium'); assert.match(c.args, /hark\.com/);
  assert.equal(c.cpu, 40); assert.equal(c.age, 360000 - 1000);
  assert.equal(c.unit, 'app-org.chromium.Chromium-16327.scope'); assert.equal(c.slice, 'user'); assert.equal(c.uid, 1000);
  assert.equal(g.unit, 'workbuddy-gateway.service'); assert.equal(g.slice, 'system');
  assert.equal(ps.length, 2);
});

/* ---------- 接进控制器：假的 systemd-run / systemctl / /proc ---------- */
const { spawnSync } = require('node:child_process');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-reap-')), xin = path.join(dir, 'xin'), work = path.join(dir, 'work'), bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
  for (const d of [xin, work, bin, log, path.join(dir, 'tmp')]) fs.mkdirSync(d, { recursive: true });
  // 假的 systemd-run：记下参数，然后照真的一样 exec 「--」后面的命令（进程号不变）
  fs.writeFileSync(path.join(bin, 'systemd-run'), '#!/bin/sh\necho "$*" >> "' + log + '/systemd-run"\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\necho "$*" >> "' + log + '/systemctl"\n', { mode: 0o755 });
  // 假 codex：后台任务回「做好了」
  fs.writeFileSync(path.join(bin, 'codex'), ['#!/bin/sh', 'case "$*" in *--ephemeral*) exit 0;; esac',
    'echo \'{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-000000000001"}\'', 'echo \'{"type":"turn.started"}\'',
    'echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"做好了"}}\'', 'echo \'{"type":"turn.completed","usage":{}}\''].join('\n'), { mode: 0o755 });
  const bus = path.join(dir, 'bus'); fs.writeFileSync(bus, '');
  const env = { ...process.env, TMPDIR: path.join(dir, 'tmp'), XIN_HOME: xin, XIN_WORK: work, XIN_CODEX_TRANSPORT: 'exec', XIN_FRONT_PROVIDER: 'deepseek', XIN_DSH: path.join(dir, 'no-dsh'),
    XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', CODEX_HOME: path.join(dir, 'codex'), PATH: bin + ':' + process.env.PATH, XIN_SYSTEMD_BUS: bus, XIN_SYSTEMD_USER_DIR: path.join(dir, 'units') };
  const ensureState = require('./helpers/state-mode.cjs').stateClient(t, env);   // 起控制器之前先起真的常驻状态进程
  const run = (argv, args, extra = {}) => { ensureState(); const r = spawnSync(process.execPath, [AGENT, ...argv], { env: { ...env, ...extra }, input: JSON.stringify(args || {}), encoding: 'utf8', timeout: platformTimeout(30000) }); assert.equal(r.status, 0, r.stderr); return r.stdout ? JSON.parse(r.stdout) : null; };
  const read = f => { try { return fs.readFileSync(path.join(log, f), 'utf8'); } catch { return ''; } };
  t.after(() => stopOwned(xin, dir));
  return { dir, xin, env, run, read };
}
async function until(fn, ms = 15000, what = '') {
  const end = performance.now() + platformTimeout(ms); let v;
  while (performance.now() < end) { v = await fn(); if (v) return v; await new Promise(ok => setTimeout(ok, 120)); }
  throw new Error('等不到：' + what + ' ' + JSON.stringify(v));
}

test('控制器：每一轮的模型命令经 systemd-run 放进 xin-run-<轮次>-a1.scope；这一轮照常做完；顺手装好每 10 分钟的清理定时器', async t => {
  const h = home(t);
  const n = h.run(['locked', 'task_new'], { kind: 'code', title: '点灯', goal: '写个点灯程序' });
  const tk = await until(() => { const x = JSON.parse(fs.readFileSync(path.join(h.xin, 'sessions', n.task.sid + '.json'), 'utf8')); return x.status === 'done' && x; }, 20000, '做完');
  const run = tk.runs.at(-1);
  assert.match(h.read('systemd-run'), new RegExp('--user --scope --unit=xin-run-' + run + '-a1 --collect --quiet -- '));
  const units = path.join(h.dir, 'units');
  assert.match(fs.readFileSync(path.join(units, 'xin-reaper.timer'), 'utf8'), /OnUnitActiveSec=10min/);
  assert.match(fs.readFileSync(path.join(units, 'xin-reaper.service'), 'utf8'), /ExecStart=.*xin-reap/);
  assert.match(fs.readFileSync(path.join(h.xin, 'bin', 'xin-reap'), 'utf8'), /controller-current\.json[\s\S]*reap/);
  assert.match(h.read('systemctl'), /--user enable --now xin-reaper\.timer/);
});

test('控制器 reap：结束 2 小时以上那一轮的 scope 停掉、桌面上开了 13 小时的浏览器关掉；还在做的、系统服务不动；记进 logs/reaper.jsonl', async t => {
  const h = home(t);
  // 一轮 3 小时前就结束了的记录
  fs.mkdirSync(path.join(h.xin, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(h.xin, 'runs', 'rold00000001.json'), JSON.stringify({ run: 'rold00000001', sid: 'sx', ended: true, endedAt: Date.now() - 3 * 3600e3 }));
  fs.writeFileSync(path.join(h.xin, 'runs', 'rold00000001.jsonl'), '{"t":"done","ok":true}\n');
  fs.writeFileSync(path.join(h.xin, 'runs', 'rlive0000001.json'), JSON.stringify({ run: 'rlive0000001', sid: 'sy', started: Date.now() }));
  fs.writeFileSync(path.join(h.xin, 'runs', 'rlive0000001.jsonl'), '{"t":"user","text":"hi"}\n');
  const root = path.join(h.dir, 'proc'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'uptime'), '400000.00 1.00\n');
  const mkp = (pid, comm, args, start, cg) => {
    const d = path.join(root, String(pid)); fs.mkdirSync(d);
    const f = Array(52).fill('0'); f[21] = String(start * 100);
    fs.writeFileSync(path.join(d, 'stat'), pid + ' (' + comm + ') S ' + f.slice(3).join(' ') + '\n');
    fs.writeFileSync(path.join(d, 'cmdline'), args.join('\0') + '\0');
    fs.writeFileSync(path.join(d, 'cgroup'), '0::' + cg + '\n');
    fs.writeFileSync(path.join(d, 'status'), 'Uid:\t1000\t1000\t1000\t1000\n');
  };
  const app = '/user.slice/user-1000.slice/user@1000.service/app.slice/';
  mkp(201, 'sleep', ['sleep', '9999'], 300000, app + 'xin-run-rold00000001-a1.scope');
  mkp(202, 'make', ['make'], 390000, app + 'xin-run-rlive0000001-a1.scope');
  mkp(300, 'chromium', ['/usr/lib/chromium/chromium', '--new-window', 'https://hark.com/login'], 400000 - 13 * 3600, app + 'app-org.chromium.Chromium-300.scope');
  mkp(400, 'python3', ['/usr/bin/python3', 'wb_proxy.py'], 1000, '/system.slice/workbuddy-gateway.service');
  // reap 交给常驻状态进程做，它用的是自己的环境：起它之前把假的 /proc 放进夹具的环境（命令行进程的环境改不了它）
  h.env.XIN_PROC_ROOT = root;
  const r = h.run(['reap'], {}, { XIN_PROC_ROOT: root });
  assert.deepEqual(r.actions.map(a => a.unit).sort(), ['app-org.chromium.Chromium-300.scope', 'xin-run-rold00000001-a1.scope']);
  const sc = h.read('systemctl');
  for (const u of ['xin-run-rold00000001-a1.scope', 'app-org.chromium.Chromium-300.scope']) {
    assert.match(sc, new RegExp('--user kill --signal=SIGTERM ' + u.replace(/\./g, '\\.')));
    assert.match(sc, new RegExp('--user stop ' + u.replace(/\./g, '\\.')));
  }
  assert.ok(!/rlive0000001|workbuddy/.test(sc), '还在做的那一轮、系统服务没动');
  const logs = fs.readFileSync(path.join(h.xin, 'logs', 'reaper.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(logs.map(l => [l.act, l.unit]).sort(), [['stop', 'app-org.chromium.Chromium-300.scope'], ['stop', 'xin-run-rold00000001-a1.scope']]);
  assert.match(logs.find(l => /Chromium/.test(l.unit)).name, /hark\.com/);
});

test('提示词：桌面上开给站长看的东西，这一轮结束 2 小时后会自动关；别用 setsid、nohup 让它常驻；要一直跑的用 systemd --user 服务', async () => {
  process.env.XIN_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'xin-reap-p-'));
  const { systemPrompt, tianqiPrompt } = await import(pathToFileURL(path.join(__dirname, '../site/xin/vm-persona.mjs')).href);
  for (const p of [systemPrompt(''), tianqiPrompt()]) {
    assert.match(p, /2 小时后会自动关/); assert.match(p, /setsid/); assert.match(p, /systemd --user/);
  }
});
