// 收尾这一批（2026-11-12）：集合目录不能当任务的项目目录（研究笔记 3.2）；第二批留下的三个小问题。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { lockedSpawn } = require('./helpers/locked.cjs');

const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
function agentEnv(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-cl-')), work = path.join(home, 'work');
  const env = Object.assign({}, process.env, { XIN_HOME: path.join(home, 'xin'), XIN_WORK: work }, extraEnv);
  env.NODE_OPTIONS = (env.NODE_OPTIONS || '') + ' --require=' + path.join(__dirname, 'helpers/front-responses.cjs');
  const op = (name, args) => JSON.parse(execFileSync(process.execPath, [AGENT, name], { env, input: JSON.stringify(args || {}) }).toString());
  return { home, work, xin: env.XIN_HOME, env, op };
}
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
async function vm(env) {
  const old = { ...process.env };
  Object.assign(process.env, env);
  try { return await import(pathToFileURL(AGENT).href + '?cl=' + Math.random()); } finally { for (const k of Object.keys(env)) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
}

test('集合目录不能当项目目录：上传的文件（uploads 和下面每一天）、任务目录本身、每日任务目录、STM32 空工程；它们下面各自的项目、名字相近的目录照常', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-cl-dir-')), work = path.join(home, 'work');
  for (const d of ['uploads/2026-11-12', 'tasks/3-blink', 'daily', 'stm32-template', 'uploads-notes', 'blink']) fs.mkdirSync(path.join(work, d), { recursive: true });
  fs.symlinkSync(path.join(work, 'uploads'), path.join(work, 'up-link'));
  const m = await vm({ XIN_HOME: path.join(home, 'xin'), XIN_WORK: work });
  const real = d => fs.realpathSync(path.join(work, d));
  for (const [d, name] of [['uploads', 'uploads'], ['uploads/2026-11-12', 'uploads'], ['up-link', 'uploads'], ['tasks', 'tasks'], ['daily', 'daily'], ['stm32-template', 'stm32-template']])
    assert.equal(m.collectionDir(real(d)), name, d);
  for (const d of ['tasks/3-blink', 'uploads-notes', 'blink']) assert.equal(m.collectionDir(real(d)), '', d);
});

test('xin task new --dir 指到上传目录：不派，说清楚改用 --file 带上要用的文件', async () => {
  const { work, xin, env, op } = agentEnv();
  const r = op('send', { agent: 'codex', text: '你好' });
  for (const end = performance.now() + platformTimeout(15000); performance.now() < end && !op('poll', { run: r.run, off: 0 }).done;) await sleep(200);
  fs.mkdirSync(path.join(work, 'uploads', '2026-11-12'), { recursive: true });
  const e = Object.assign({}, env, { XIN_RUN: r.run, PATH: path.join(xin, 'bin') + ':' + process.env.PATH });
  const xinTask = (...a) => { try { return execFileSync(process.execPath, [AGENT, 'xin', 'task', ...a], { env: e, input: '' }).toString(); } catch (err) { return String(err.stdout || '') + String(err.stderr || ''); } };
  const out = xinTask('new', '--title', '看看上传', '--dir', 'uploads/2026-11-12', '--', '整理一下');
  assert.match(out, /不能把 .*uploads.* 当项目目录/);
  assert.match(out, /--file/);
  assert.equal(op('tasks', { sid: r.sid }).tasks.length, 0, '没有派出任务');
  assert.match(xinTask('new', '--title', 'X', '--dir', 'uploads/new-day', '--', 'x'), /不能把/);
  assert.ok(!fs.existsSync(path.join(work, 'uploads', 'new-day')), '没在上传目录里建出空目录');
});

test('以前做完的 Gemini（Antigravity）任务：存下的用量是「输入不含缓存」的旧口径，取出来时换算，缓存命中不超过 100%；别的模型、已换算的照旧', () => {
  const { xin, op } = agentEnv();
  fs.mkdirSync(path.join(xin, 'sessions'), { recursive: true });
  const put = (sid, model, usage) => fs.writeFileSync(path.join(xin, 'sessions', sid + '.json'), JSON.stringify({ sid, kind: 'task', agent: 'codex', no: 1, title: '用量', status: 'done', runs: [], created: 1, endedAt: 2, model, started: true, usage }));
  // 正式机 #123 前的真实形状：input 54735 不含缓存读取 149606，total = 输入 + 输出
  put('sagyold0001', 'gemini-4-hydrogen', { input: 54735, cached: 149606, output: 39807, total: 94542, ctx: 0, win: 1000000 });
  const u = op('history', { sid: 'sagyold0001' }).usage;
  assert.deepEqual([u.input, u.cached, u.output, u.total, u.incl], [204341, 149606, 39807, 244148, true]);
  assert.ok(u.cached / u.input <= 1);
  const fresh = { input: 204341, cached: 149606, output: 39807, total: 244148, ctx: 0, win: 1000000, incl: true };
  put('sagynew0001', 'gemini-4-hydrogen', fresh);
  assert.deepEqual(op('history', { sid: 'sagynew0001' }).usage, fresh, '已换算的不再加一次');
  const codex = { input: 120, cached: 60, output: 30, total: 150, ctx: 40, win: 200000 };
  put('scodex00001', 'glm-5.3', codex);
  assert.deepEqual(op('history', { sid: 'scodex00001' }).usage, codex, 'Codex 的输入本来就含缓存');
});

test('备份那一刻没做完的那一轮：恢复后不重跑，标成停了（聊天显示已停止、说明一句）；只处理一次', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-cl-rs-')), cold = path.join(tmp, 'cold');
  const { xin, work, op } = agentEnv({ XIN_FRONT_TEST_COLD: cold });
  fs.writeFileSync(cold, '');   // 网关卡着：这一轮一直在做
  const r = op('send', { agent: 'codex', text: '早上好' });
  for (const end = performance.now() + platformTimeout(10000); performance.now() < end;) { const m = JSON.parse(fs.readFileSync(path.join(xin, 'runs', r.run + '.json'), 'utf8')); if (m.pid) break; await sleep(100); }
  const a = op('backup_export');
  assert.equal(a.ok, true, JSON.stringify(a));
  // 原来那台电脑上这一轮后来结束了（这里直接停掉），备份里它还是「在做」
  op('stop', { run: r.run });
  for (const end = performance.now() + platformTimeout(15000); performance.now() < end && !op('poll', { run: r.run, off: 0 }).done;) await sleep(200);
  // 新电脑：解进空的 ~/.xin。同一个包恢复两次：刚备份完就恢复；和真实情况——备份是几小时、几天前打的，
  // 离这一轮开始早过了判定「进程没了」的 15 秒，旧电脑的进程号在新电脑上也不在。
  // 以前只有前一种能过：后一种先被当成「中途断了」收成失败，再被收成「停了」，记了两条 done（#146 笔记本 CI 上恢复时离开始已 15.3 秒，碰上了）。
  for (const [label, ago] of [['刚备份完就恢复', 0], ['隔了一天才恢复', 86400e3]]) {
    const out = path.join(tmp, ago ? 'restored-late' : 'restored'), log = path.join(tmp, ago ? 'front-after-late.log' : 'front-after.log');
    fs.mkdirSync(out);
    execFileSync('tar', ['-xzf', a.file, '-C', out]);
    if (ago) { const f = path.join(out, 'runs', r.run + '.json'), m = JSON.parse(fs.readFileSync(f, 'utf8')); fs.writeFileSync(f, JSON.stringify({ ...m, started: m.started - ago })); }
    const env2 = Object.assign({}, process.env, { XIN_HOME: out, XIN_WORK: work, XIN_FRONT_TEST_LOG: log });
    env2.NODE_OPTIONS = (env2.NODE_OPTIONS || '') + ' --require=' + path.join(__dirname, 'helpers/front-responses.cjs');
    const op2 = (name, args) => JSON.parse(execFileSync(process.execPath, [AGENT, name], { env: env2, input: JSON.stringify(args || {}) }).toString());
    let p = null;
    for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) { p = op2('poll', { run: r.run, off: 0 }); if (p.done) break; await sleep(200); }
    assert.ok(p && p.done, label + '：恢复后这一轮结束了');
    const done = p.events.find(e => e.t === 'done');
    assert.equal(done.stopped, true, label + '：' + JSON.stringify(p.events.slice(-3)));
    assert.equal(p.events.filter(e => e.t === 'err' && /备份/.test(e.text)).length, 1, label + '：说明一句是备份那一刻没做完的');
    assert.ok(!p.events.some(e => e.t === 'err' && /中途断了/.test(e.text)), label + '：不当成中途断了');
    assert.ok(!fs.existsSync(log), label + '：没有重新发给模型');
    assert.ok(!fs.existsSync(path.join(out, 'restore-stop.json')), label + '：只处理一次');
    op2('status');
    const again = op2('poll', { run: r.run, off: 0 }).events;
    assert.equal(again.filter(e => e.t === 'err' && /备份/.test(e.text)).length, 1, label + '：再开不再说一遍');
    assert.equal(again.filter(e => e.t === 'done').length, 1, label + '：只收一次尾');
  }
});

// 假 codex（exec 传输），和 test/xin-batch1.test.cjs 的同一个思路，只留后台任务要用的：$L/hold-bg 在的时候一直做；每次后台调用记一个文件。
function fakeCodex(dir) {
  const bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(log, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), [
    '#!/bin/sh',
    'case "$*" in *--ephemeral*) exit 0;; esac',
    'L="' + log + '"',
    'case "$*" in *【你现在在后台】*) : > "$L/bg.$$";; esac',
    'printf \'{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-%012d"}\\n\' $$',
    'echo \'{"type":"turn.started"}\'',
    'case "$*" in *【你现在在后台】*) while [ -f "$L/hold-bg" ]; do sleep 0.1; done;; esac',
    'echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"做好了"}}\'',
    'echo \'{"type":"turn.completed","usage":{}}\''
  ].join('\n'), { mode: 0o755 });
  return { bin, log, bgCalls: () => fs.readdirSync(log).filter(f => /^bg\.\d+$/.test(f)).length };
}

test('备份那一刻在做的后台任务：隔了一天才恢复，也不当成「中途断了」接着做（不重跑），任务标成停了', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-cl-task-')), xin = path.join(dir, 'xin');
  for (const d of ['xin', 'work', 'tmp']) fs.mkdirSync(path.join(dir, d));
  const envFor = (home, fc) => ({ ...process.env, TMPDIR: path.join(dir, 'tmp'), XIN_HOME: home, XIN_WORK: path.join(dir, 'work'), XIN_CODEX_TRANSPORT: 'exec', XIN_FRONT_PROVIDER: 'deepseek',
    XIN_DSH: path.join(dir, 'no-dsh'), XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', CODEX_HOME: path.join(dir, 'codex'), PATH: fc.bin + ':' + process.env.PATH });
  const call = (env, name, args) => { const r = spawnSync(process.execPath, [AGENT, name], { env, input: JSON.stringify(args || {}), encoding: 'utf8', timeout: platformTimeout(20000) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const locked = (env, name, args) => { const r = lockedSpawn(AGENT, name, args, { env, encoding: 'utf8', timeout: platformTimeout(20000) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const fc = fakeCodex(path.join(dir, 'old')), env = envFor(xin, fc);
  fs.writeFileSync(path.join(fc.log, 'hold-bg'), '');   // 后台任务一直在做
  const n = locked(env, 'task_new', { kind: 'code', title: '编个程序', goal: '编个程序' });
  assert.ok(n.task, JSON.stringify(n));
  const task = home => JSON.parse(fs.readFileSync(path.join(home, 'sessions', n.task.sid + '.json'), 'utf8'));
  let run = null;
  for (const end = performance.now() + platformTimeout(15000); performance.now() < end && !run;) {
    const t = task(xin), r = t.status === 'running' && t.runs.at(-1), m = r && JSON.parse(fs.readFileSync(path.join(xin, 'runs', r + '.json'), 'utf8'));
    if (m && m.pid && fc.bgCalls()) run = r; else await sleep(100);
  }
  assert.ok(run, '任务开始做了');
  const a = call(env, 'backup_export');
  assert.equal(a.ok, true, JSON.stringify(a));
  // 原来那台电脑这时停掉（备份里任务还是「在做」）
  locked(env, 'task_stop', { sid: n.task.sid });
  fs.rmSync(path.join(fc.log, 'hold-bg'));
  for (const end = performance.now() + platformTimeout(15000); performance.now() < end && task(xin).status === 'running';) await sleep(100);
  // 新电脑：隔了一天才恢复（备份通常是几小时、几天前的），离这一轮开始早过了判定「进程没了」的 15 秒
  const out = path.join(dir, 'restored');
  fs.mkdirSync(out);
  execFileSync('tar', ['-xzf', a.file, '-C', out]);
  const f = path.join(out, 'runs', run + '.json'), m = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...m, started: m.started - 86400e3 }));
  const fc2 = fakeCodex(path.join(dir, 'new')), env2 = envFor(out, fc2);
  // 网页打开后照常轮询任务列表（它会顺手收拾进程没了的任务、接着做断掉的）
  for (let i = 0; i < 3; i++) { call(env2, 'tasks', { all: true }); await sleep(300); }
  const t = task(out);
  assert.equal(t.status, 'stopped', JSON.stringify({ status: t.status, nextShow: t.nextShow, resumes: t.resumes }));
  assert.equal(t.runs.length, 1, '没有再开一轮接着做');
  assert.equal(fc2.bgCalls(), 0, '新电脑上没有重新发给模型');
  const evs = call(env2, 'poll', { run, off: 0 }).events;
  assert.equal(evs.filter(e => e.t === 'err' && /备份/.test(e.text)).length, 1, '说明一句是备份那一刻没做完的');
  assert.ok(!evs.some(e => e.t === 'err' && /中途断了/.test(e.text)), '不当成中途断了');
  assert.deepEqual(evs.filter(e => e.t === 'done').map(e => !!e.stopped), [true], '只收一次尾，收成停了');
});
