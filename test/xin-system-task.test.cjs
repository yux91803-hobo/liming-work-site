// 站长 2026-11-12：「我用别的，比如 grok bot、muse，他们电脑出啥问题我都可以让他们自己修，而我的小芯好像限制有点太多了，他都不能完全管自己的电脑」。
// 以前默认模式里所有动手的活都进隔离容器（系统目录只读、不能 sudo、看不到进程和桌面、连不上本机网关），电脑本身的事根本做不了。
// 参考 Grok Bot（source/host/runner/system-prompt.ts「Where you work」：自己的电脑是默认干活的地方，Shell 直接跑、不用批准，
// 只有碰用户的电脑才每步批准）和 OpenMuse（docs/COMPUTER.md：E2B 桌面的隔离靠整台虚拟机，里面免密 sudo）：
// 新加一类后台任务「电脑维护」（--kind system）：不进容器，直接在电脑上做，能 sudo；同一时间只做一个（共用目录 WORK/system，按目录排队）。
const test = require('node:test');
const { lockedSpawn } = require('./helpers/locked.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const { captureRunContext } = require('./helpers/run-context.cjs');
const { stateMode } = require('./helpers/state-mode.cjs');
const SITE = path.join(__dirname, '../site/xin');
const AGENT = path.join(SITE, 'vm-agent.mjs');
const imp = f => import(pathToFileURL(path.join(SITE, f)).href);
// 测试进程里直接调控制器模块：用自己的临时状态目录，不读写机器上的 ~/.xin。CI 上那里是空的；本机要是留着旧库，
// 会把「不是主人建不了库」盖住（#170 第一次 CI 就是这么挂的：本机全过，CI 上提示词读记忆要建库）。
process.env.XIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-system-task-proc-'));

// 假 codex（同 xin-batch1.test.cjs）：后台任务在 $L/hold-bg 存在时一直等，然后回「做好了」；每次调用的参数和工作目录记下来
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
    'case "$*" in *【你现在在后台】*) while [ -f "$L/hold-bg" ]; do sleep 0.1; done;; esac',
    'echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"做好了"}}\'',
    'echo \'{"type":"turn.completed","usage":{}}\''
  ].join('\n'), { mode: 0o755 });
  const calls = () => fs.readdirSync(log).filter(f => /^args\.\d+$/.test(f)).sort((a, b) => a.split('.')[1] - b.split('.')[1])
    .map(f => ({ args: fs.readFileSync(path.join(log, f), 'utf8'), cwd: fs.readFileSync(path.join(log, 'cwd.' + f.split('.')[1]), 'utf8').trim() }));
  return { bin, log, calls };
}
function home(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-system-')), xin = path.join(dir, 'xin'), work = path.join(dir, 'work');
  fs.mkdirSync(xin, { recursive: true }); fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(path.join(dir, 'tmp'));
  const fc = fakeCodex(dir);
  const preload = path.join(dir, 'fetch.cjs');
  fs.writeFileSync(preload, `
    globalThis.fetch = async (_url, init) => {
      if (JSON.parse(init.body || '{}').stream) return new Response('{}');
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 30000);
        init.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      return new Response(JSON.stringify({ status: 'completed', output: [] }));
    };
  `);
  const env = { ...process.env, TMPDIR: path.join(dir, 'tmp'), XIN_HOME: xin, XIN_WORK: work, XIN_CODEX_TRANSPORT: 'exec', XIN_FRONT_PROVIDER: 'deepseek',
    XIN_DSH: path.join(dir, 'no-dsh'), XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', CODEX_HOME: path.join(dir, 'codex'), PATH: fc.bin + ':' + process.env.PATH,
    XIN_CODEX_KEY_FILE: path.join(dir, 'codex.key'), NODE_OPTIONS: '--require=' + preload, ...extra };
  let owner;
  const ensureState = () => owner ||= stateMode(t, env);
  const restart = async () => {
    owner.child.kill('SIGKILL');
    await owner.exited;
    owner = stateMode(t, env);
  };
  const run = (argv, args) => { ensureState(); const r = spawnSync(process.execPath, [AGENT, ...argv], { env, input: JSON.stringify(args || {}), encoding: 'utf8', timeout: platformTimeout(20000) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const locked = (name, args, context) => { ensureState(); const r = lockedSpawn(AGENT, name, args, { env: { ...env, ...context }, encoding: 'utf8', timeout: platformTimeout(20000) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const op = (name, args) => run([name], args);
  const hold = on => { const f = path.join(fc.log, 'hold-bg'); if (on) fs.writeFileSync(f, ''); else fs.rmSync(f, { force: true }); };
  const task = sid => JSON.parse(fs.readFileSync(path.join(xin, 'sessions', sid + '.json'), 'utf8'));
  t.after(() => stopOwned(xin, dir));
  const decide = (t, decision = 'approve', fields = {}) => op('task_tell', { sid: t.sid, decision, approvalId: t.approval.id, _ownerInput: true, ...fields });
  return { dir, xin, work, locked, hold, task, fc, op, decide, restart };
}
async function until(fn, ms = 15000, what = '') {
  const end = performance.now() + platformTimeout(ms); let v;
  while (performance.now() < end) { v = fn(); if (v) return v; await new Promise(ok => setTimeout(ok, 120)); }
  throw new Error('等不到：' + what + ' ' + JSON.stringify(v));
}

test('电脑维护任务不进容器：目录是 WORK/system、不建项目副本、codex 不带沙盒；普通任务照旧进沙盒', async t => {
  const h = home(t);
  const s = h.locked('task_new', { kind: 'system', title: '看看磁盘', goal: '电脑磁盘是不是满了，满了就清一清', dir: 'proj', web: true, sites: ['bilibili.com'] });
  assert.ok(s.task, JSON.stringify(s));
  assert.deepEqual([s.task.kind, s.task.status, s.task.approval.kind], ['system', 'waiting', 'host']);
  assert.equal(h.task(s.task.sid).runs.length, 0);
  assert.equal(h.decide(s.task).ok, true);
  await until(() => h.task(s.task.sid).status === 'done', 20000, '电脑维护任务做完');
  const st = h.task(s.task.sid);
  assert.equal(st.dir, fs.realpathSync(path.join(h.work, 'system')), '--dir 不管用，固定在 WORK/system');
  assert.equal(st.workspace, undefined, '不建项目副本');
  assert.equal(st.web, false); assert.equal(st.sites, undefined, '不带网页成品和网站登录（那些在容器里做）');
  const call = h.fc.calls().find(c => c.args.includes('看看磁盘'));
  assert.ok(call.args.includes('--dangerously-bypass-approvals-and-sandbox'), '不进沙盒');
  assert.ok(call.args.includes('【电脑维护】'), '用电脑维护的说明');
  assert.equal(call.cwd, fs.realpathSync(path.join(h.work, 'system')));
  const n = h.locked('task_new', { kind: 'code', title: '普通活', goal: '写个小程序' });
  await until(() => h.task(n.task.sid).status === 'done', 20000, '普通任务做完');
  const normal = h.fc.calls().find(c => c.args.includes('普通活'));
  assert.ok(!normal.args.includes('--dangerously-bypass-approvals-and-sandbox'), '普通任务照旧在沙盒里');
  assert.ok(!normal.args.includes('【电脑维护】'));
});

test('电脑维护任务同一时间只做一个；它在做的时候普通任务照样开始', async t => {
  const h = home(t);
  h.hold(true);
  const a = h.locked('task_new', { kind: 'system', title: '修甲', goal: '重启卡住的服务' });
  assert.equal(h.decide(a.task).ok, true);
  await until(() => h.task(a.task.sid).status === 'running', 15000, '甲开始');
  const b = h.locked('task_new', { kind: 'system', title: '修乙', goal: '装个软件' });
  assert.equal(h.decide(b.task).ok, true);
  const c = h.locked('task_new', { kind: 'code', title: '普通丙', goal: '写代码' });
  await until(() => h.task(c.task.sid).status === 'running', 15000, '普通任务不用等');
  assert.equal(h.task(b.task.sid).status, 'queued', '第二个电脑维护任务排队');
  h.hold(false);
  await until(() => h.task(b.task.sid).status === 'done', 20000, '乙最后也做完');
});

test('维护审批只接受站长任务卡片上的决定，编号不可跨任务或重放，拒绝不启动执行器', async t => {
  const h = home(t);
  const a = h.locked('task_new', { kind: 'system', goal: '检查系统 A' }).task;
  const b = h.locked('task_new', { kind: 'system', goal: '检查系统 B' }).task;
  assert.equal(h.locked('task_tell', { sid: a.sid, decision: 'approve', approvalId: a.approval.id, _ownerInput: true }).error, 'owner_required');
  assert.equal(h.decide(a, 'approve', { approvalId: b.approval.id }).error, 'stale_approval');
  const { requestState } = await imp('vm-kernel-client.mjs');
  const changed = { ...h.task(b.sid), goal: '改过的目标', dir: h.work };
  await requestState(h.xin, { kind: 'write', name: 'sessions/' + b.sid + '.json', body: JSON.stringify(changed) });
  assert.equal(h.decide(b).error, 'stale_approval');
  const denied = h.decide(a, 'deny');
  assert.equal(denied.task.status, 'stopped');
  assert.equal(h.decide(a).error, 'stale_approval');
  assert.equal(h.task(b.sid).status, 'waiting');
  assert.equal(h.fc.calls().length, 0);
  assert.equal(h.op('send', { sid: b.sid, text: '执行', _ownerInput: true }).error, 'use_task_tell');
  assert.ok(h.locked('task_new', { daily: true, goal: '不在清单中的任务' }).error);
});

test('维护审批过期后停止，旧编号不会启动任务，也不会把待确认当作活跃任务', async t => {
  const h = home(t, { XIN_WAIT_TTL_MS: '100' });
  const task = h.locked('task_new', { kind: 'system', goal: '检查磁盘占用' }).task;
  assert.equal(task.approval.kind, 'host');
  assert.ok(task.waitUntil > 0);
  await until(() => Date.now() >= task.waitUntil);
  assert.equal(h.decide(task).error, 'stale_approval');
  h.locked('task_expire');
  assert.equal(h.task(task.sid).status, 'stopped');
  assert.equal(h.task(task.sid).runs.length, 0);
  assert.equal(h.fc.calls().length, 0);
});

test('主人重启保留待处理审批，排队中的授权过期后重新等待，不启动执行器', async t => {
  const h = home(t, { XIN_WAIT_TTL_MS: '2200' });
  h.hold(true);
  const first = h.locked('task_new', { kind: 'system', goal: '检查版本 A' }).task;
  assert.equal(h.decide(first).ok, true);
  await until(() => h.fc.calls().length === 1, 15000, '第一个任务占用维护目录');
  let next = h.locked('task_new', { kind: 'system', goal: '检查版本 B' }).task;
  await h.restart();
  assert.equal(h.task(next.sid).approval.id, next.approval.id);
  assert.equal(h.decide(next).task.status, 'queued');
  await until(() => h.task(next.sid).hostGrant?.expiresAt <= Date.now(), 5000, '排队的授权过期');
  h.hold(false);
  await until(() => h.task(next.sid).status === 'waiting', 15000, '重新进入确认状态');
  assert.equal(h.task(next.sid).runs.length, 0);
  assert.equal(h.fc.calls().length, 1);
  assert.equal(h.decide(next).error, 'stale_approval');
  next = h.op('history', { sid: next.sid }).task;
  assert.equal(h.decide(next).ok, true);
  await until(() => h.task(next.sid).status === 'done', 15000, '第二次批准后完成');
});

test('未授权来源的维护续做重新等待确认，获授权的同一命令重试只启动一轮', async t => {
  const h = home(t);
  const a = h.locked('task_new', { kind: 'system', goal: '检查版本' }).task;
  assert.equal(h.decide(a).ok, true);
  await until(() => h.task(a.sid).status === 'done', 20000, '第一次维护结束');
  const tell = { sid: a.sid, text: '检查另一项状态', clientId: 'auto-host-0001' };
  const next = h.locked('task_tell', tell);
  assert.equal(next.delivery, 'approval');
  assert.equal(next.task.status, 'waiting');
  assert.equal(h.task(a.sid).runs.length, 1);
  assert.equal(h.locked('task_tell', tell).delivery, 'approval');
  const args = { clientId: 'owner-host-0001' };
  assert.equal(h.decide(next.task, 'approve', args).ok, true);
  assert.equal(h.decide(next.task, 'approve', args).ok, true);
  await until(() => h.task(a.sid).status === 'done', 20000, '第二次维护结束');
  assert.equal(h.task(a.sid).runs.length, 2);
  assert.equal(h.fc.calls().length, 2);
});

test('方案 C 只从同一对话内仍在运行的站长前台轮次签发自动授权，维护要求取站长原话', async t => {
  const h = home(t);
  fs.writeFileSync(path.join(h.dir, 'codex.key'), 'synthetic-key');
  h.hold(true);
  const send = { text: '检查本机版本', _ownerInput: true };
  const front = h.op('send', send);
  const context = captureRunContext(h.xin, front.run);
  assert.ok(context.XIN_ATTEMPT);
  const argv = ['xin', 'task', 'new', '--kind', 'system', '--', '替换掉站长要求'];
  // 有权限轮次的编号本身不提供授权，来源必须和派发命令的执行尝试相符。
  const unrelated = h.locked('task_new', { parent: front.sid, frontRun: front.run, kind: 'system', goal: send.text });
  assert.ok(unrelated.error);
  const action = h.locked('front_action', { run: front.run, argv }, context);
  assert.equal(action.task?.status, 'running', JSON.stringify(action));
  const task = h.task(action.task.sid);
  assert.equal(task.goal, send.text);
  assert.equal(task.hostGrant.run, front.run);
  assert.equal(h.locked('task_tell', { sid: task.sid, text: '模型追加目标' }).error, 'owner_required');
  const tell = h.op('task_tell', { sid: task.sid, text: '再确认磁盘余量', _ownerInput: true });
  assert.ok(tell.ok);
  h.hold(false);
  await until(() => h.task(task.sid).status === 'done', 20000, '已授权维护完成');
  const old = h.op('send', { text: '旧版待送达消息' });
  const fromOld = h.locked('front_action', { run: old.run, argv }, captureRunContext(h.xin, old.run));
  assert.equal(fromOld.task?.status, 'waiting', JSON.stringify(fromOld));
  assert.equal(h.task(fromOld.task.sid).runs.length, 0);
});

test('提示词：电脑维护直接查直接修、能 sudo、别停两个关键服务；前台知道派 --kind system；容器任务做不了时说要电脑维护', async () => {
  const p = await imp('vm-persona.mjs');
  await require('./helpers/own-state.cjs').ownState();   // 提示词要读记忆、头一次要建库：测试进程自己当主人（正式环境里状态进程一起来就建好了）
  const sys = p.taskSystemPrompt({ no: 3, title: '看看磁盘', tkind: 'system', dir: '/data/workspace/system', goal: '磁盘' });
  assert.match(sys, /【电脑维护】/);
  assert.match(sys, /免密 sudo/);
  assert.match(sys, /不用先问/);
  assert.match(sys, /instabox-guest-agent/);
  assert.match(sys, /workbuddy-gateway/);
  assert.doesNotMatch(sys, /只在这里面创建和修改文件/, '不限制只在工作目录里改');
  assert.doesNotMatch(sys, /不可撤销的事不要自己做/, '改系统设置正是它的活，不再要先问');
  assert.match(sys, /改系统设置[^\n]*都可以/);
  assert.doesNotMatch(sys, /隔离容器/);
  const front = p.systemPrompt('', { tasks: true });
  assert.match(front, /--kind[^\n]*system/);
  assert.match(front, /电脑本身的事[^\n]*--kind system/);
  assert.doesNotMatch(front, /别派任务去查/, '签到积分这类事不再说做不了');
  const boxed = p.taskSystemPrompt({ no: 4, title: '写代码', tkind: 'code', dir: '/data/workspace/p', workspace: { work: '/x/work', home: '/x/home', tmp: '/x/tmp', io: '/x/io' }, goal: 'x' });
  assert.match(boxed, /电脑维护/);
});

test('电脑维护的模型和名字', async () => {
  const m = await imp('vm-models.mjs');
  assert.ok(Array.isArray(m.ROUTES.system) && m.ROUTES.system.length, '有候选模型');
  assert.equal(m.route({ kind: 'system' }).kind, 'system');
  assert.equal(m.KIND_NAMES.system, '电脑维护');
  const a = await imp('vm-agent.mjs');
  assert.ok(a.TASK_KINDS.includes('system'));
});
