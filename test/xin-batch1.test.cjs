// 后台可靠性第一批（docs/xin-reliability-usage-design.md 的 A 部分）：每日任务目录、临时错误重试、等回答时限、轮询按字节读。
const test = require('node:test');
const { lockedSpawn } = require('./helpers/locked.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');

// 假 codex（exec 传输）：每次调用记下参数和工作目录。
// - 每日任务（输入里有「到点做每日任务了」）：$L/hold-daily 存在时一直等。
// - 后台任务（设定里有【你现在在后台】）：$L/hold-bg 存在时一直等；$L/script 里一行一个动作，按调用顺序取：
//   ok（正常做完）、fail:<信息>（先执行一条命令再 turn.failed）。没写就是 ok。
function fakeCodex(dir) {
  const bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(log, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), [
    '#!/bin/sh',
    'case "$*" in *--ephemeral*) exit 0;; esac',
    'L="' + log + '"',
    'exec 9>"$L/seq.lock"; flock 9',
    'n=$(cat "$L/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$L/n"',
    // 先写工作目录、再写参数，都先写临时名再改名：测试看到 args.N 时内容完整、cwd.N 也已经在了（新执行机忙时读到一半，#133 合并后 CI）
    'pwd > "$L/.cwd.$n" && mv "$L/.cwd.$n" "$L/cwd.$n"; for a in "$@"; do printf "%s\\n" "$a"; done > "$L/.args.$n" && mv "$L/.args.$n" "$L/args.$n"',
    'flock -u 9; exec 9>&-',
    'printf \'{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-%012d"}\\n\' $n',
    'echo \'{"type":"turn.started"}\'',
    'case "$*" in',
    '  *到点做每日任务了*) while [ -f "$L/hold-daily" ]; do sleep 0.1; done',
    '    if [ -f "$L/daily-fail" ]; then echo \'{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"curl","aggregated_output":"","exit_code":0,"status":"completed"}}\'; echo \'{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}\'; exit 1; fi;;',
    '  *【你现在在后台】*)',
    '    while [ -f "$L/hold-bg" ]; do sleep 0.1; done',
    '    exec 9>"$L/script.lock"; flock 9',
    '    k=$(cat "$L/k" 2>/dev/null || echo 0); k=$((k+1)); echo $k > "$L/k"',
    '    act=$(sed -n "${k}p" "$L/script" 2>/dev/null)',
    '    flock -u 9; exec 9>&-',
    '    case "$act" in fail:*)',
    '      echo \'{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"make","aggregated_output":"ok","exit_code":0,"status":"completed"}}\'',
    '      printf \'{"type":"turn.failed","error":{"message":"%s"}}\\n\' "${act#fail:}"; exit 1;;',
    '      early:*) printf \'{"type":"turn.failed","error":{"message":"%s"}}\\n\' "${act#early:}"; exit 1;;',
    '    esac;;',
    'esac',
    'echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"做好了"}}\'',
    'echo \'{"type":"turn.completed","usage":{}}\''
  ].join('\n'), { mode: 0o755 });
  const calls = () => fs.readdirSync(log).filter(f => /^args\.\d+$/.test(f)).sort((a, b) => a.split('.')[1] - b.split('.')[1])
    .map(f => ({ args: fs.readFileSync(path.join(log, f), 'utf8'), cwd: fs.readFileSync(path.join(log, 'cwd.' + f.split('.')[1]), 'utf8').trim() }));
  return { bin, log, calls };
}

function home(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-batch1-')), xin = path.join(dir, 'xin'), work = path.join(dir, 'work');
  fs.mkdirSync(xin, { recursive: true }); fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(path.join(dir, 'tmp'));
  const fc = fakeCodex(dir);
  const env = { ...process.env, TMPDIR: path.join(dir, 'tmp'), XIN_HOME: xin, XIN_WORK: work, XIN_CODEX_TRANSPORT: 'exec', XIN_FRONT_PROVIDER: 'deepseek',
    XIN_DSH: path.join(dir, 'no-dsh'), XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', CODEX_HOME: path.join(dir, 'codex'), PATH: fc.bin + ':' + process.env.PATH, ...extra };
  const ensureState=require('./helpers/state-mode.cjs').stateClient(t,env);
  const run = (argv, args) => { ensureState(); const r = spawnSync(process.execPath, [AGENT, ...argv], { env, input: JSON.stringify(args || {}), encoding: 'utf8', timeout: platformTimeout(20000) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const op = (name, args) => run([name], args), locked = (name, args) => { ensureState(); const r = lockedSpawn(AGENT, name, args, { env, encoding: 'utf8', timeout: platformTimeout(20000) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const hold = (name, on) => { const f = path.join(fc.log, 'hold-' + name); if (on) fs.writeFileSync(f, ''); else fs.rmSync(f, { force: true }); };
  const script = lines => fs.writeFileSync(path.join(fc.log, 'script'), lines.join('\n') + '\n');
  const task = sid => JSON.parse(fs.readFileSync(path.join(xin, 'sessions', sid + '.json'), 'utf8'));
  t.after(() => stopOwned(xin, dir));
  return { dir, xin, work, env, op, locked, hold, script, task, fc };
}
async function until(fn, ms = 15000, what = '') {
  // 等待预算用单调时钟，宿主暂停/校时后的墙钟跳跃不能在控制器恢复之前判超时。
  const end = performance.now() + platformTimeout(ms); let v;
  while (performance.now() < end) { v = fn(); if (v) return v; await new Promise(ok => setTimeout(ok, 120)); }
  throw new Error('等不到：' + what + ' ' + JSON.stringify(v));
}

test('每日任务在跑时普通任务照样开始：每日任务用自己的目录 WORK/daily', async t => {
  const h = home(t);
  h.op('daily_set', { text: '- 网关签到' });
  h.hold('daily', true);
  const d = h.op('daily', {});
  assert.ok(d.sid, JSON.stringify(d));
  await until(() => h.fc.calls().some(c => c.args.includes('到点做每日任务了')), 15000, '每日任务开始');
  const n = h.locked('task_new', { kind: 'code', title: '普通任务', goal: '做点事' });
  assert.ok(n.task, JSON.stringify(n));
  await until(() => h.task(n.task.sid).status !== 'queued', 15000, '普通任务不再排队');
  assert.equal(h.task(d.sid).status, 'running', '每日任务还在跑');
  assert.equal(h.task(d.sid).dir, path.join(h.work, 'daily'));
  assert.equal(h.fc.calls().find(c => c.args.includes('到点做每日任务了')).cwd, fs.realpathSync(path.join(h.work, 'daily')));
  h.hold('daily', false);
});

test('同一个项目目录的两个任务仍然排队', async t => {
  const h = home(t);
  fs.mkdirSync(path.join(h.work, 'proj'));
  h.hold('bg', true);
  const a = h.locked('task_new', { kind: 'code', title: '甲', goal: '改 proj', dir: 'proj' });
  await until(() => h.task(a.task.sid).status === 'running', 15000, '甲开始');
  const b = h.locked('task_new', { kind: 'code', title: '乙', goal: '也改 proj', dir: 'proj' });
  await new Promise(ok => setTimeout(ok, platformTimeout(800)));
  assert.equal(h.task(b.task.sid).status, 'queued');
  h.hold('bg', false);
  await until(() => h.task(b.task.sid).status === 'done', 20000, '乙最后也做完');
});

/* ---------- 临时错误：控制器等一会儿接着做 ---------- */
const bgCalls = h => h.fc.calls().filter(c => c.args.includes('【你现在在后台】'));

test('干活中途断线：等一会儿用同一个会话接着做完，不算没做成', async t => {
  const h = home(t, { XIN_RETRY_DELAYS_MS: '1500' });
  h.script(['fail:stream disconnected before completion', 'ok']);
  const n = h.locked('task_new', { kind: 'code', title: '断线', goal: '编个程序' });
  const waiting = await until(() => { const x = h.task(n.task.sid); return x.status === 'queued' && x.retryAt > 0 && x; }, 15000, '断线后回到排队、等一会儿');
  assert.equal(waiting.transientRetries, 1);
  assert.equal(waiting.result, undefined, '还没有结果，不算没做成');
  const done = await until(() => { const x = h.task(n.task.sid); return x.status === 'done' && x; }, 20000, '接着做完');
  assert.equal(done.result.ok, true);
  const calls = bgCalls(h);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes('resume') && calls[1].args.includes(waiting.agentSid), '续接同一个会话');
  assert.ok(calls[1].args.includes('刚才连接模型出错'), '告诉它先看现状、别重复有副作用的事');
});

test('预算用完不重试，直接算没做成', async t => {
  const h = home(t, { XIN_RETRY_DELAYS_MS: '200' });
  h.script(['fail:task inference budget exhausted; partial work is retained', 'ok']);
  const n = h.locked('task_new', { kind: 'code', title: '预算', goal: '编个程序' });
  const x = await until(() => { const v = h.task(n.task.sid); return v.status === 'failed' && v; }, 15000, '失败');
  assert.equal(bgCalls(h).length, 1);
  assert.ok(!x.transientRetries);
});

test('连续临时错误到上限后算没做成', async t => {
  const h = home(t, { XIN_RETRY_DELAYS_MS: '200,200,200' });
  h.script(['fail:502 Bad Gateway', 'fail:502 Bad Gateway', 'fail:502 Bad Gateway', 'fail:502 Bad Gateway']);
  const n = h.locked('task_new', { kind: 'code', title: '一直断', goal: '编个程序' });
  const x = await until(() => { const v = h.task(n.task.sid); return v.status === 'failed' && v; }, 40000, '重试用完后失败');
  assert.equal(bgCalls(h).length, 4);
  assert.equal(x.transientRetries, 3);
});

test('重试时已经过了任务时限：按超时收尾，不再起一轮', async t => {
  const h = home(t, { XIN_RETRY_DELAYS_MS: '3000', XIN_TASK_TIMEOUT_MS: '1500' });
  h.script(['fail:stream disconnected before completion', 'ok']);
  const n = h.locked('task_new', { kind: 'code', title: '超时', goal: '编个程序' });
  const x = await until(() => { const v = h.task(n.task.sid); return v.status === 'failed' && v; }, 30000, '按超时失败');
  assert.match(x.result.err, /超时/);
  assert.equal(bgCalls(h).length, 1);
});

/* ---------- 等站长回答：最多挂 10 分钟（参考 Agent HUD requests.rs 的 hold_ms） ---------- */
const loadAgent = () => { process.env.XIN_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'xin-batch1-import-')); return import(require('node:url').pathToFileURL(AGENT).href); };

test('awaitTaskInput：到点先记下问题再交还', async () => {
  const { awaitTaskInput, APPROVAL_HOLD_MS, INPUT_TIMEOUT_TEXT } = await loadAgent();
  assert.equal(APPROVAL_HOLD_MS, 600000);
  assert.match(INPUT_TIMEOUT_TEXT, /10 分钟内没有回复/);
  let expired = 0;
  const r = await awaitTaskInput({ id: 'a1', holdMs: 60, read: () => ({}), expire: () => { expired++; }, sleep: ms => new Promise(ok => setTimeout(ok, Math.min(ms, 10))) });
  assert.deepEqual(r, { expired: true });
  assert.equal(expired, 1);
});

test('awaitTaskInput：有答复就返回答复，本轮结束就返回 ended', async () => {
  const { awaitTaskInput } = await loadAgent();
  const sleep = () => new Promise(ok => setTimeout(ok, 5));
  let n = 0;
  assert.deepEqual(await awaitTaskInput({ id: 'a1', holdMs: 5000, read: () => (++n > 2 ? { approvalReplies: { a1: '删吧' } } : {}), expire: () => assert.fail('不该到点'), sleep }), { reply: '删吧' });
  assert.deepEqual(await awaitTaskInput({ id: 'a1', holdMs: 5000, read: () => ({ ended: Date.now() }), expire: () => assert.fail('不该到点'), sleep }), { ended: true });
});

async function askingTask(h) {
  h.hold('bg', true);
  const n = h.locked('task_new', { kind: 'code', title: '要问', goal: '清理工程' });
  const t = await until(() => { const x = h.task(n.task.sid); return x.status === 'running' && x.runs.length && x; }, 15000, '开工');
  const run = t.runs.at(-1);
  assert.equal(h.locked('task_approval', { sid: t.sid, run, id: 'a1', method: 'item/tool/requestUserInput', kind: 'input', question: '要删掉旧的 build 目录吗？' }).ok, true);
  assert.equal(h.op('tasks', {}).bg, 1, '等回答期间算后台在忙');
  return { sid: t.sid, run };
}

test('等回答到点：问题记成等你确认，这一轮结束后不再算后台在忙；回答后接着做', async t => {
  const h = home(t);
  const { sid, run } = await askingTask(h);
  assert.equal(h.locked('task_approval_expire', { sid, run, id: 'a1' }).ok, true);
  let x = h.task(sid);
  assert.equal(x.status, 'running'); assert.equal(x.approval, undefined); assert.equal(x.pendingQuestion, '要删掉旧的 build 目录吗？');
  h.hold('bg', false);
  x = await until(() => { const v = h.task(sid); return v.status === 'waiting' && v; }, 15000, '这一轮结束后停在等你确认');
  assert.equal(x.question, '要删掉旧的 build 目录吗？');
  assert.equal(h.op('tasks', {}).bg, 0, '不再让云电脑醒着');
  assert.equal(h.locked('task_tell', { sid, text: '删吧' }).ok, true);
  await until(() => h.task(sid).status === 'done', 15000, '接着做完');
  const last = bgCalls(h).at(-1).args;
  assert.ok(last.includes('用户回复：删吧') && last.includes('要删掉旧的 build 目录吗？'), last.slice(-300));
});

test('到点一直没记下问题（锁忙满 2 分钟）：不对模型说「已经记下」；这一轮结束后照样停在等你确认，回答能接着做', async t => {
  const { inputTimeoutReply, INPUT_TIMEOUT_TEXT } = await loadAgent();
  assert.equal(inputTimeoutReply({ expired: true }), INPUT_TIMEOUT_TEXT);
  const unsaved = inputTimeoutReply({ expired: true, unsaved: true });
  assert.ok(!/已经记下/.test(unsaved), unsaved);
  assert.match(unsaved, /最后一条消息/);
  const h = home(t);
  const { sid } = await askingTask(h);
  // task_approval_expire 一直没成功：任务上还挂着这一轮的 approval
  h.hold('bg', false);
  const x = await until(() => { const v = h.task(sid); return v.status === 'waiting' && v.finishedRun && v; }, 15000, '这一轮结束后停在等你确认');
  assert.equal(x.question, '要删掉旧的 build 目录吗？');
  assert.equal(x.approval, undefined, '这一轮已经结束，不能再按 approval 回复');
  assert.equal(h.op('tasks', {}).bg, 0, '不再让云电脑醒着');
  const told = h.locked('task_tell', { sid, text: '删吧' });
  assert.equal(told.ok, true, JSON.stringify(told));
  await until(() => h.task(sid).status === 'done', 15000, '接着做完');
  const last = bgCalls(h).at(-1).args;
  assert.ok(last.includes('用户回复：删吧') && last.includes('要删掉旧的 build 目录吗？'), last.slice(-300));
});

test('到点那一刻站长回答：答案进收件箱，下一轮带上，不丢', async t => {
  const h = home(t);
  const { sid, run } = await askingTask(h);
  h.locked('task_approval_expire', { sid, run, id: 'a1' });
  assert.equal(h.locked('task_tell', { sid, text: '留着别删' }).ok, true);
  h.hold('bg', false);
  await until(() => bgCalls(h).length >= 2, 15000, '下一轮').catch(e => { const x = h.task(sid); throw new Error(e.message + ' DIAG ' + JSON.stringify({ status: x.status, inbox: x.inbox, q: x.question, pq: x.pendingQuestion, runs: x.runs, fin: x.finishedRun, calls: h.fc.calls().map(c => c.args.slice(-80)) })); });
  assert.ok(bgCalls(h)[1].args.includes('留着别删'));
});

test('模型还没开工就失败、换下一个候选：失败原因记进 model-stats（fromErr），正式站联调失败时查得到', async t => {
  const h = home(t);
  h.script(['early:upstream connect error 503 from gateway']);
  const n = h.locked('task_new', { kind: 'code', title: '换模型', goal: '编译工程' });
  const done = await until(() => { const v = h.task(n.task.sid); return v.status === 'done' && v; }, 20000, '换了模型做完');
  // 任务 done 和统计那一行在同一个事务里提交，但写到磁盘时先写文档（会话）、后写追加的行（vm-state.mjs 的 project）。
  // 这里直接读文件，会看到「会话已经 done、统计还没写」的那一下（11-20 本地跑全量时读到 ENOENT）。
  // 照 Marten 的 WaitForNonStaleProjectionDataAsync、Testing Library 的 waitFor：等这一轮的那行写进来再断言
  const statsF = path.join(h.xin, 'model-stats.jsonl');
  const rows = () => { let s = ''; try { s = fs.readFileSync(statsF, 'utf8'); } catch { /* 还没写 */ } return s.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }); };
  const last = await until(() => rows().find(x => x.run === done.finishedRun), 15000, 'model-stats 记下这一轮');
  assert.equal(last.kind, 'code', JSON.stringify(last));
  assert.equal(last.from, 'glm-5.4', JSON.stringify(last));
  assert.equal(last.model, 'kimi-k3.1-pro');
  assert.match(last.fromErr || '', /503/);
});

test('做完的任务记住用量：副本删了以后 history 照样有用量', async t => {
  const h = home(t);
  fs.mkdirSync(path.join(h.xin, 'sessions'), { recursive: true });
  const usage = { input: 120, cached: 60, output: 30, total: 150, ctx: 40, win: 200000 };
  fs.writeFileSync(path.join(h.xin, 'sessions', 'susage00001.json'), JSON.stringify({ sid: 'susage00001', kind: 'task', agent: 'codex', no: 1, title: '用量', status: 'done', runs: [], created: 1, endedAt: 2, agentSid: '0199a213-81c0-7800-8aa1-000000000001', started: true, usage }));
  assert.deepEqual(h.op('history', { sid: 'susage00001' }).usage, usage);
});

/* ---------- 轮询按字节位置读（参考 Agent HUD docs/performance.md：从上次读到的位置接着读，半行等下次） ---------- */
function pollRun(h) {
  const sid = 'spollpos001', run = 'rpollpos0001', dirS = path.join(h.xin, 'sessions'), dirR = path.join(h.xin, 'runs');
  fs.mkdirSync(dirS, { recursive: true }); fs.mkdirSync(dirR, { recursive: true });
  fs.writeFileSync(path.join(dirS, sid + '.json'), JSON.stringify({ sid, agent: 'codex', runs: [run], created: 1, updated: 1 }));
  fs.writeFileSync(path.join(dirR, run + '.json'), JSON.stringify({ run, sid, agent: 'codex', started: Date.now(), pid: process.pid }));
  const log = path.join(dirR, run + '.jsonl');
  const add = evs => fs.appendFileSync(log, evs.map(e => JSON.stringify(e) + '\n').join(''));
  return { run, log, add };
}

test('按字节位置读和按条数读结果一致；接着上次的位置只拿到新的', async t => {
  const h = home(t), p = pollRun(h);
  p.add([1, 2, 3, 4, 5].map(i => ({ t: 'text', text: '第' + i + '段' })));
  const a = h.op('poll', { run: p.run, off: 0 }), b = h.op('poll', { run: p.run, pos: 0 });
  assert.deepEqual(b.events, a.events); assert.equal(b.off, 5); assert.equal(b.pos, fs.statSync(p.log).size); assert.equal(b.done, false);
  p.add([{ t: 'text', text: '第6段' }, { t: 'done', ok: true }]);
  const c = h.op('poll', { run: p.run, pos: b.pos, off: b.off });
  assert.deepEqual(c.events.map(e => e.t), ['text', 'done']); assert.equal(c.off, 7); assert.equal(c.done, true);
  const d = h.op('poll', { run: p.run, pos: c.pos, off: c.off });
  assert.deepEqual(d.events, []); assert.equal(d.done, true); assert.equal(d.pos, c.pos);
});

test('pos 落在半行时不越过它；pos 不对（超出长度、不在行首）就按条数读并把位置纠正回来，不出错', async t => {
  const h = home(t), p = pollRun(h);
  p.add([{ t: 'text', text: '完整的一行' }]);
  fs.appendFileSync(p.log, '{"t":"text","text":"写到一半');
  const a = h.op('poll', { run: p.run, pos: 0 });
  assert.equal(a.events.length, 1); assert.equal(a.pos, Buffer.byteLength(JSON.stringify({ t: 'text', text: '完整的一行' }) + '\n'));
  const b = h.op('poll', { run: p.run, pos: a.pos, off: 1 });
  assert.deepEqual(b.events, []); assert.equal(b.pos, a.pos);
  const c = h.op('poll', { run: p.run, pos: 1e9, off: 1 });
  assert.deepEqual(c.events, []); assert.equal(c.pos, a.pos, '超出长度：按条数读，位置纠正回来');
  const d = h.op('poll', { run: p.run, pos: 3, off: 0 });
  assert.equal(d.events.length, 1); assert.equal(d.pos, a.pos, '不在行首：按条数读');
});

test('不带 pos 的旧请求照常按条数读', async t => {
  const h = home(t), p = pollRun(h);
  p.add([{ t: 'text', text: '甲' }, { t: 'text', text: '乙' }]);
  const r = h.op('poll', { run: p.run, off: 1 });
  assert.deepEqual(r.events.map(e => e.text), ['乙']); assert.equal(r.off, 2);
});

test('每日任务重试时过了时限：按超时收尾，并记下今天的每日任务没做成', async t => {
  const h = home(t, { XIN_RETRY_DELAYS_MS: '3000', XIN_TASK_TIMEOUT_MS: '1500' });
  h.op('daily_set', { text: '- 网关签到' });
  fs.writeFileSync(path.join(h.fc.log, 'daily-fail'), '');
  const d = h.op('daily', {});
  const x = await until(() => { const v = h.task(d.sid); return v.status === 'failed' && v; }, 30000, '按超时失败');
  assert.match(x.result.err, /超时/);
  const last = h.op('daily_get', {}).last;
  assert.equal(last.sid, d.sid); assert.equal(last.ok, false, JSON.stringify(last));
});
