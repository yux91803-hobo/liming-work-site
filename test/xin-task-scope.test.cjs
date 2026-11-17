// 站长 2026-11-12 反馈（「感觉他像个智障」）：网页上「1 个待确认」是别的对话里派的「查网关签到积分」，
// 新对话里的小芯只看得到这个对话的任务，一口咬定「只有奶龙」；站长回「不用了」后，任务停下前压着的旧补充又被翻出来重新开工；
// 后台容器连不上本机的网关面板（127.0.0.1:8788），反复试，还让站长「启动面板」。
// 参考 Codex codex-rs/core/src/session/input_queue.rs：干活时收到的补充一次取完、和下一轮一起交给模型，不留着以后再放。
const test = require('node:test');
const { lockedSpawn } = require('./helpers/locked.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');

// 假 codex（同 xin-batch1.test.cjs）：后台任务在 $L/hold-bg 存在时一直等，然后回「做好了」；每次调用的参数记下来
function fakeCodex(dir) {
  const bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(log, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), [
    '#!/bin/sh',
    'case "$*" in *--ephemeral*) exit 0;; esac',
    'L="' + log + '"',
    'exec 9>"$L/seq.lock"; flock 9',
    'n=$(cat "$L/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$L/n"',
    // 先写临时名再改名：测试看到 args.N 时内容是完整的
    'for a in "$@"; do printf "%s\\n" "$a"; done > "$L/.args.$n" && mv "$L/.args.$n" "$L/args.$n"',
    'flock -u 9; exec 9>&-',
    'printf \'{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-%012d"}\\n\' $n',
    'echo \'{"type":"turn.started"}\'',
    'case "$*" in *【你现在在后台】*) while [ -f "$L/hold-bg" ]; do sleep 0.1; done;; esac',
    'echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"做好了"}}\'',
    'echo \'{"type":"turn.completed","usage":{}}\''
  ].join('\n'), { mode: 0o755 });
  const calls = () => fs.readdirSync(log).filter(f => /^args\.\d+$/.test(f)).sort((a, b) => a.split('.')[1] - b.split('.')[1]).map(f => fs.readFileSync(path.join(log, f), 'utf8'));
  return { bin, log, calls };
}
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-scope-')), xin = path.join(dir, 'xin'), work = path.join(dir, 'work');
  fs.mkdirSync(xin, { recursive: true }); fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(path.join(dir, 'tmp'));
  const fc = fakeCodex(dir);
  const env = { ...process.env, TMPDIR: path.join(dir, 'tmp'), XIN_HOME: xin, XIN_WORK: work, XIN_CODEX_TRANSPORT: 'exec', XIN_FRONT_PROVIDER: 'deepseek',
    XIN_DSH: path.join(dir, 'no-dsh'), XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', CODEX_HOME: path.join(dir, 'codex'), PATH: fc.bin + ':' + process.env.PATH };
  const ensureState=require('./helpers/state-mode.cjs').stateClient(t,env);
  const run = (argv, args) => { ensureState(); const r = spawnSync(process.execPath, [AGENT, ...argv], { env, input: JSON.stringify(args || {}), encoding: 'utf8', timeout: platformTimeout(30000) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const op = (name, args) => run([name], args), locked = (name, args) => { ensureState(); const r = lockedSpawn(AGENT, name, args, { env, encoding: 'utf8', timeout: platformTimeout(30000) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const hold = on => { const f = path.join(fc.log, 'hold-bg'); if (on) fs.writeFileSync(f, ''); else fs.rmSync(f, { force: true }); };
  const task = sid => JSON.parse(fs.readFileSync(path.join(xin, 'sessions', sid + '.json'), 'utf8'));
  t.after(() => stopOwned(xin, dir));
  return { dir, xin, work, env, op, locked, hold, task, fc };
}
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
async function until(fn, ms = 15000, what = '') {
  const end = performance.now() + platformTimeout(ms); let v;
  while (performance.now() < end) { v = await fn(); if (v) return v; await sleep(120); }
  throw new Error('等不到：' + what + ' ' + JSON.stringify(v));
}
async function agentModule(env) {
  const old = { ...process.env };
  Object.assign(process.env, env);
  try { return await import(pathToFileURL(AGENT).href + '?sc=' + Math.random()); } finally { for (const k of Object.keys(env)) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
}

test('任务停下来等确认前收到的补充：跟着站长的回复一起交给模型（回复放最后、以它为准），不在这一轮做完后再翻出来重新开工', async t => {
  const h = home(t);
  h.hold(true);
  const n = h.locked('task_new', { kind: 'quick', title: '查积分', goal: '现在有多少积分了？' });
  const tk = await until(() => { const x = h.task(n.task.sid); return x.status === 'running' && x.runs.length && x; }, 15000, '开工');
  // 干活时前台转来两句补充（进收件箱），然后它停下来问
  for (const text of ['兄弟催进度：咋样了？', '直接读本地面板 127.0.0.1:8788']) assert.equal(h.locked('task_tell', { sid: tk.sid, text }).ok, true);
  assert.equal(h.locked('task_ask', { sid: tk.sid, question: '面板连不上，要我怎么办？' }).ok, true);
  h.hold(false);
  await until(() => { const x = h.task(tk.sid); return x.status === 'waiting' && x.finishedRun && x; }, 15000, '停在等你确认');
  assert.equal(h.task(tk.sid).inbox.length, 2, '补充还压着');
  // 站长回「不用了」：这一轮带上压着的补充和回复，回复在最后
  assert.equal(h.locked('task_tell', { sid: tk.sid, text: '不用了' }).ok, true);
  assert.deepEqual(h.task(tk.sid).inbox, [], '补充随回复一起交出去了，不再压着');
  await until(() => h.task(tk.sid).status === 'done', 15000, '做完');
  await sleep(1500);
  const calls = h.fc.calls();
  assert.equal(calls.length, 2, '回完「不用了」做完就结束，没有再开一轮：' + calls.length);
  const second = calls[1];
  assert.ok(second.includes('兄弟催进度：咋样了？') && second.includes('直接读本地面板'), '压着的补充交给了模型');
  assert.ok(second.lastIndexOf('不用了') > second.lastIndexOf('直接读本地面板'), '站长的回复放在最后');
  assert.match(second, /以.*最后.*为准|以站长最后的回复为准/);
  assert.equal(h.task(tk.sid).status, 'done');
});

test('前台看任务：task list 也列出别的对话里没做完的任务（写明是别的对话、在等确认的问题）；按编号找得到别的对话的任务（show 能看，补充、停止照旧只认本对话：xin-runtime 的「结构化桥拒绝跨对话操作」）', async () => {
  const m = await agentModule({ XIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'xin-scope-m-')) });
  const all = [
    { sid: 'staskwait074', kind: 'task', no: 74, parent: 'sxianliao001', title: '查网关签到积分', tkind: 'quick', status: 'waiting', question: '面板连不上', created: 1, runs: ['r1'] },
    { sid: 'staskrun0075', kind: 'task', no: 75, parent: 'sxianliao001', title: '跑着的', tkind: 'quick', status: 'running', created: 2, runs: ['r2'] },
    { sid: 'staskdone076', kind: 'task', no: 76, parent: 'sxianliao001', title: '早做完了', tkind: 'quick', status: 'done', created: 3, runs: ['r3'], result: { ok: true, text: 'x' } },
    { sid: 'staskmine077', kind: 'task', no: 77, parent: 'snewchat0001', title: '奶龙', tkind: 'code', status: 'done', created: 4, runs: ['r4'], result: { ok: true, text: '画好了' }, frontSeen: true },
  ];
  const r = m.frontTaskList('snewchat0001', all);
  assert.deepEqual(r.tasks.map(x => x.no), [77]);
  assert.deepEqual(r.others.map(x => [x.no, x.status, x.question || '']), [[74, 'waiting', '面板连不上'], [75, 'running', '']], '别的对话里没做完的都列出来，做完的不列');
  assert.match(r.note, /别的对话/); assert.match(r.note, /工作台/);
  assert.equal(m.frontTaskByNo('snewchat0001', '74', all)?.sid, 'staskwait074', '按编号找得到别的对话的任务');
  assert.equal(m.frontTaskByNo('snewchat0001', '99', all), null);
  // 每轮附上的 <后台任务>：别的对话里在等确认的也说（网页上「N 个待确认」是所有对话的），注明是别的对话；跑着的照旧不每轮说
  const notes = m.taskNotes('snewchat0001', all, { active: false }).text;
  assert.match(notes, /任务 74「查网关签到积分」（别的对话里派的）在等用户确认：面板连不上/);
  assert.ok(!/任务 75/.test(notes) && !/任务 76/.test(notes), notes);
});

test('提示词：后台任务知道容器里连不上这台电脑本机的服务，连不上就直说做不了、别反复试、别让用户启动面板；前台知道 task list 也有别的对话的任务、签到积分派电脑维护（2026-11-12 站长定：小芯要能管自己的电脑）', async () => {
  process.env.XIN_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'xin-scope-p-'));
  await require('./helpers/own-state.cjs').ownState();   // 测试进程里直接调提示词模块：测试进程自己当主人（正式环境里这段跑在常驻状态进程里）
  const { taskSystemPrompt, systemPrompt } = await import(pathToFileURL(path.join(__dirname, '../site/xin/vm-persona.mjs')).href);
  const p = taskSystemPrompt({ no: 1, title: '查积分', dir: '/data/workspace/x', workspace: { work: '/w/work', home: '/w/home', tmp: '/w/tmp' }, goal: '现在有多少积分' });
  assert.match(p, /127\.0\.0\.1/); assert.match(p, /连不上/); assert.match(p, /直接说做不了/); assert.match(p, /不要反复试/); assert.match(p, /启动/);
  const front = systemPrompt('', { tasks: true });
  assert.match(front, /别的对话/); assert.match(front, /工作台里点/); assert.match(front, /签到积分/); assert.match(front, /--kind system/);
});

test('新对话里问别的对话的任务：task show 看得到；task tell/stop 不跨对话改动，说清楚去工作台或回那个对话', async t => {
  const h = home(t);
  h.hold(true);
  const n = h.locked('task_new', { kind: 'quick', title: '查网关签到积分', goal: '现在有多少积分了？', parent: 'sxianliao001' });
  const sid = 'snewchat0001', run = 'rnewchat0001';
  fs.writeFileSync(path.join(h.xin, 'sessions', sid + '.json'), JSON.stringify({ sid, agent: 'codex', runs: [run] }));
  fs.writeFileSync(path.join(h.xin, 'runs', run + '.json'), JSON.stringify({ run, sid, agent: 'codex', model: 'deepseek-v4.1-flash', text: '那个查网关积分的', started: Date.now() }));
  fs.writeFileSync(path.join(h.xin, 'runs', run + '.jsonl'), JSON.stringify({ t: 'user', text: '那个查网关积分的' }) + '\n');
  const list = h.locked('front_action', { run, argv: ['xin', 'task', 'list'] });
  assert.deepEqual(list.tasks, []);
  assert.deepEqual(list.others.map(x => [x.no, x.title, x.from]), [[n.task.no, '查网关签到积分', '别的对话里派的']]);
  const show = h.locked('front_action', { run, argv: ['xin', 'task', 'show', String(n.task.no)] });
  assert.equal(show.task.sid, n.task.sid);
  for (const sub of [['tell', String(n.task.no), '不用了'], ['stop', String(n.task.no)]]) {
    const r = h.locked('front_action', { run, argv: ['xin', 'task', ...sub] });
    assert.match(String(r.error), /别的对话/); assert.match(String(r.error), /工作台/);
  }
  assert.notEqual(h.task(n.task.sid).status, 'stopped', '没有被别的对话停掉');
  h.hold(false);
});
