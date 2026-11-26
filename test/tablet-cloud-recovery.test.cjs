// 平板 liming-cloud 阶段 6：断线补齐、通知闭环（设计 §5.5）、重启后的对账与恢复（设计 §5.7）。
// 站长 11-26 要核对的三条边界都在这里：完成通知不会因引擎被杀而丢、发件箱重启后准确补发、停止请求重启后接着确认。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFakeCloud, createFakeJobs, until } = require('./tablet-cloud-fake-dsh.cjs');

const lib = file => import(pathToFileURL(path.join(__dirname, '../site/tablet/liming-cloud/lib', file)).href);

// 假的 ctx.agents：get(id) 取活着的代理；代理有 status、followup、inject、session.snapshotEvents()
function createAgents() {
  const live = new Map();
  return {
    live,
    get: id => live.get(id),
    add(id, { status = 'idle', events = [] } = {}) {
      const sent = [];
      const agent = { id, status, sent, session: { id, snapshotEvents: () => events.slice() }, followup: m => sent.push({ via: 'followup', m }), inject: m => sent.push({ via: 'inject', m }) };
      live.set(id, agent);
      return agent;
    },
  };
}

async function setup(t, { dir, cloud = createFakeCloud(), statuses = {}, now, beforeRename } = {}) {
  const { createLedger } = await lib('ledger.js');
  const { createOutbox } = await lib('outbox.js');
  const { createRunner } = await lib('runner.js');
  const { createRecovery } = await lib('recovery.js');
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablet-cloud-recovery-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  }
  const jobs = createFakeJobs();
  const ledger = createLedger({ dir, beforeRename });
  ledger.init();
  const outbox = createOutbox(ledger);
  const agents = createAgents();
  const counts = { connect: 0, release: 0, leftovers: 0 };
  const remote = {
    machines: () => ['li', 'li2'],
    async connect(machine) { counts.connect += 1; if (cloud.offline) throw Object.assign(new Error(`连不上 ${machine}`), { code: 'ECONNREFUSED' }); return { client: cloud.client(), release() { counts.release += 1; } }; },
    async ensureProjectDir() {},
    async killLeftovers() { counts.leftovers += 1; return { found: [777], remain: [] }; },
    invalidate() {},
  };
  const runner = createRunner({ jobs, ledger, outbox, remote, followIdleMs: 200, reconnectMs: [20, 50], maxReconnects: 50, ...(now ? { now } : {}) });
  const readStatus = async name => statuses[name] || { known: false, reason: '没有只读 key' };
  const recovery = createRecovery({ runner, ledger, agents, readStatus, retryGraceMs: 0, ...(now ? { now } : {}) });
  t.after(async () => { recovery.dispose(); await runner.dispose(); });
  return { dir, cloud, jobs, ledger, outbox, agents, runner, recovery, counts };
}

const noticeEvent = (seq, text, source) => ({ seq, type: 'user/message', data: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source } });

test('断线重连：从上次看到的位置补齐，步骤不重复、不丢', async (t) => {
  const { cloud, ledger, runner } = await setup(t);
  cloud.followTail = 3;
  const task = runner.dispatch({ machine: 'li2', title: '长任务', text: '跑', tabletSessionId: 'tab-A' });
  const sid = task.cloudSessionId;
  assert.ok(await until(() => cloud.sessions.get(sid) && cloud.sessions.get(sid).running));
  for (const n of [1, 2, 3]) cloud.toolCall(sid, 'bash', { description: `第${n}步` });
  assert.ok(await until(() => runner.steps(task.taskId).length === 3));
  cloud.dropStreams(sid);
  for (const n of [4, 5, 6, 7, 8]) cloud.toolCall(sid, 'bash', { description: `第${n}步` });
  assert.ok(await until(() => runner.steps(task.taskId).length === 8, 5000), JSON.stringify(runner.steps(task.taskId)));
  assert.deepEqual(runner.steps(task.taskId).map(s => s.text), [1, 2, 3, 4, 5, 6, 7, 8].map(n => `bash · 第${n}步`));
  cloud.finishTurn(sid, '好了');
  assert.ok(await until(() => ledger.getTask(task.taskId).status === 'completed'));
});

test('完成通知：先记「待确认」；只有在对话日志里看到这条通知才记「已告诉」，只认自己的', async (t) => {
  const { cloud, jobs, ledger, runner, recovery } = await setup(t);
  const task = runner.dispatch({ machine: 'li2', title: '写文档', text: '写', tabletSessionId: 'tab-A' });
  const sid = task.cloudSessionId;
  assert.ok(await until(() => cloud.sessions.get(sid) && cloud.sessions.get(sid).running));
  cloud.finishTurn(sid, '写完了');
  await jobs.get(task.jobId).settled;
  assert.equal(ledger.getTask(task.taskId).noticeState, 'pending');
  recovery.onSessionEvent({ id: 'tab-A' }, noticeEvent(50, 'background job cloud-ffff (cloud: x) finished', { kind: 'tool-jobs', form: 'notice' }));
  recovery.onSessionEvent({ id: 'tab-B' }, noticeEvent(51, `background job ${task.jobId} finished`, { kind: 'tool-jobs', form: 'notice' }));
  recovery.onSessionEvent({ id: 'tab-A' }, noticeEvent(52, `background job ${task.jobId} finished`, { kind: 'user' }));
  assert.equal(ledger.getTask(task.taskId).noticeState, 'pending', '别人的通知、别的对话、不是通知的话都不算');
  recovery.onSessionEvent({ id: 'tab-A' }, noticeEvent(53, `background job ${task.jobId} (cloud: li2 · 写文档) finished [status: completed]`, { kind: 'tool-jobs', form: 'notice' }));
  const done = ledger.getTask(task.taskId);
  assert.equal(done.noticeState, 'confirmed');
  assert.equal(done.noticeMeta.via, 'tool-jobs');
  assert.equal(done.noticeMeta.seq, 53);
});

test('引擎重启后补说：代理出现前保持未读；日志里已有就补记不重发；没有就补投一次，写进日志才记「已告诉」，再重启不重复', async (t) => {
  const first = await setup(t);
  const { ledger } = first;
  const mk = (id, extra) => { const x = ledger.createTask({ machine: 'li2', title: id, tabletSessionId: `tab-${id}`, taskId: id }); ledger.updateTask(x.taskId, cur => ({ ...cur, status: 'completed', noticeState: 'pending', jobId: `cloud-${id}`, summary: `${id} 的结果`, ...extra })); return x; };
  mk('t_seen1');
  mk('t_miss1');
  mk('t_busy1');
  const second = await setup(t, { dir: first.dir });   // 同一份台账，新的进程
  second.recovery.sweep();
  assert.equal(second.ledger.getTask('t_miss1').noticeState, 'pending', '对话没打开时不动');
  // 日志里已经有 tool-jobs 通知：补记，不重发
  const a = second.agents.add('tab-t_seen1', { events: [noticeEvent(9, 'background job cloud-t_seen1 (cloud: …) finished', { kind: 'tool-jobs', form: 'notice' })] });
  second.recovery.onAgentCreated(a);
  assert.equal(second.ledger.getTask('t_seen1').noticeState, 'confirmed');
  assert.equal(a.sent.length, 0);
  // 日志里没有：补投一条 liming-cloud 通知（空闲走 followup），日志里出现后才确认
  const b = second.agents.add('tab-t_miss1', { status: 'idle' });
  second.recovery.onAgentCreated(b);
  assert.ok(await until(() => b.sent.length === 1));
  assert.equal(b.sent[0].via, 'followup');
  assert.deepEqual({ kind: b.sent[0].m.source.kind, form: b.sent[0].m.source.form, taskId: b.sent[0].m.source.taskId }, { kind: 'liming-cloud', form: 'notice', taskId: 't_miss1' });
  assert.match(b.sent[0].m.content[0].text, /t_miss1 的结果/);
  assert.equal(second.ledger.getTask('t_miss1').noticeState, 'pending', '发出去不等于写进了日志');
  second.recovery.onSessionEvent({ id: 'tab-t_miss1' }, { seq: 12, type: 'user/message', data: { ...b.sent[0].m } });
  assert.equal(second.ledger.getTask('t_miss1').noticeState, 'confirmed');
  // 代理正忙：走 inject
  const c = second.agents.add('tab-t_busy1', { status: 'running' });
  second.recovery.onAgentCreated(c);
  assert.ok(await until(() => c.sent.length === 1));
  assert.equal(c.sent[0].via, 'inject');
  // 再来一次（再重启、代理又出现）：已经确认的不再发；还没确认的同一进程里也只发一次
  second.recovery.onAgentCreated(b);
  second.recovery.onAgentCreated(c);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(b.sent.length, 1);
  assert.equal(c.sent.length, 1);
});

test('重启后对账：发件箱里没送到的按原请求编号补发（不重复、不漏），进行中的接着跟', async (t) => {
  const cloud = createFakeCloud();
  const first = await setup(t, { cloud });
  const task = first.runner.dispatch({ machine: 'li2', title: '派了一半', text: '原话', tabletSessionId: 'tab-A' });
  const sid = task.cloudSessionId;
  assert.ok(await until(() => cloud.sessions.get(sid) && cloud.userMessages(sid).length === 1));
  // 模拟：补充要求记进了发件箱，还没发出去引擎就被杀了
  const pendingEntry = first.outbox.enqueue(task.taskId, { text: '补一句', mode: 'steer' });
  first.ledger.updateTask(task.taskId, cur => ({ ...cur, runRequestIds: [...cur.runRequestIds, pendingEntry.requestId] }));
  await first.runner.dispose();
  const second = await setup(t, { dir: first.dir, cloud, statuses: { li2: { known: true, awake: true, cooldownUntil: null, remainingMin: 300 } } });
  second.agents.add('tab-A');
  second.recovery.onAgentCreated(second.agents.get('tab-A'));
  assert.ok(await until(() => cloud.userMessages(sid).length === 2));
  assert.deepEqual(cloud.userMessages(sid).map(m => m.text), ['原话', '补一句']);
  assert.equal(second.ledger.getTask(task.taskId).outbox.every(e => e.status === 'acked'), true);
  cloud.finishTurn(sid, '都做了');
  assert.ok(await until(() => second.ledger.getTask(task.taskId).status === 'completed'));
  assert.equal(cloud.userMessages(sid).length, 2, '原话没有重发');
});

test('重启后对账：「停止中」的接着停完；机器醒着才连，睡着的不叫醒，冷却中的到点再连一次', async (t) => {
  const cloud = createFakeCloud();
  const first = await setup(t, { cloud });
  const a = first.runner.dispatch({ machine: 'li2', title: '要停的', text: 'x', tabletSessionId: 'tab-A' });
  assert.ok(await until(() => cloud.sessions.get(a.cloudSessionId) && cloud.sessions.get(a.cloudSessionId).running));
  await first.runner.dispose();
  first.ledger.updateTask(a.taskId, cur => ({ ...cur, status: 'stopping', stopRequest: { source: 'panel', reason: '', requestedAt: 1 } }));
  const b = first.ledger.createTask({ machine: 'li', title: '睡着那台', tabletSessionId: 'tab-B', taskId: 't_sleep1' });
  first.ledger.updateTask(b.taskId, cur => ({ ...cur, status: 'running' }));
  const t0 = performance.now();
  const second = await setup(t, {
    dir: first.dir, cloud,
    statuses: { li2: { known: true, awake: true, cooldownUntil: null, remainingMin: 300 }, li: { known: true, awake: false, cooldownUntil: null, remainingMin: null } },
  });
  await second.recovery.sweep();
  assert.ok(await until(() => second.ledger.getTask(a.taskId).status === 'stopped'), JSON.stringify(second.ledger.getTask(a.taskId)));
  assert.equal(cloud.sessions.get(a.cloudSessionId).running, false);
  const connectsAfterStop = second.counts.connect;
  assert.equal(second.ledger.getTask('t_sleep1').status, 'running', '睡着那台不去连');
  // 冷却中：到点再连一次
  const third = await setup(t, { dir: first.dir, cloud, statuses: { li: { known: true, awake: false, cooldownUntil: Date.now() + 150, remainingMin: null } } });
  third.ledger.updateTask('t_sleep1', cur => ({ ...cur, status: 'stopping', stopRequest: { source: 'job', reason: 'x', requestedAt: 1 } }));
  cloud.coldSessions.add('tablet-t_sleep1');
  await third.recovery.sweep();
  assert.equal(third.counts.connect, 0, '冷却中先不连');
  assert.ok(await until(() => third.counts.connect >= 1, 3000), '冷却结束后连一次');
  assert.ok(performance.now() - t0 >= 150);
  assert.ok(connectsAfterStop >= 1);
});

test('云端中断：最后一轮是 interrupted 就记「云端中断」，清项目目录残留进程，不自动重派', async (t) => {
  const { cloud, jobs, ledger, runner, counts } = await setup(t);
  const task = runner.dispatch({ machine: 'li2', title: '会中断的', text: 'x', tabletSessionId: 'tab-A' });
  const sid = task.cloudSessionId;
  assert.ok(await until(() => cloud.sessions.get(sid) && cloud.sessions.get(sid).running));
  const promptsBefore = cloud.sessions.get(sid).prompts.length;
  cloud.finishTurn(sid, '', { kind: 'interrupted' });
  const outcome = await jobs.get(task.jobId).settled;
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail, /云端中断/);
  const tk = ledger.getTask(task.taskId);
  assert.equal(tk.status, 'interrupted');
  assert.equal(counts.leftovers, 1, '清了残留进程');
  assert.deepEqual(tk.leftoverPids, [777]);
  assert.equal(cloud.sessions.get(sid).prompts.length, promptsBefore, '没有自动重派');
});

test('首次派发和插话在同一份台账提交里写入消息与轮次编号', async (t) => {
  const snapshots = [];
  const { cloud, runner } = await setup(t, { beforeRename: file => snapshots.push(JSON.parse(fs.readFileSync(file, 'utf8'))) });
  const task = runner.dispatch({ machine: 'li2', title: '正常派发', text: '先做', tabletSessionId: 'tab-A' });
  assert.ok(await until(() => cloud.sessions.get(task.cloudSessionId)?.running));
  await runner.tell(task.taskId, '再补充');
  const versions = snapshots.map(s => s.tasks[task.taskId]).filter(Boolean);
  assert.ok(versions.length > 0);
  for (const version of versions) {
    assert.deepEqual(version.runRequestIds, version.outbox.map(e => e.requestId));
    assert.ok(version.outbox.length > 0, '首次落盘失败前也不会有空派发');
  }
});

test('云端对话不见了：有待发送插话也记失败，不重派', async (t) => {
  const cloud = createFakeCloud();
  const first = await setup(t, { cloud });
  const task = first.runner.dispatch({ machine: 'li2', title: '会丢的', text: 'x', tabletSessionId: 'tab-A' });
  assert.ok(await until(() => cloud.sessions.get(task.cloudSessionId) && cloud.sessions.get(task.cloudSessionId).running));
  await first.runner.dispose();
  const queued = await first.runner.tell(task.taskId, '离线时补一句');
  assert.equal(queued.mode, 'steer');
  assert.equal(queued.delivered, false);
  cloud.sessions.delete(task.cloudSessionId);
  const second = await setup(t, { dir: first.dir, cloud, statuses: { li2: { known: true, awake: true, cooldownUntil: null, remainingMin: 300 } } });
  second.agents.add('tab-A');
  second.recovery.onAgentCreated(second.agents.get('tab-A'));
  assert.ok(await until(() => second.ledger.getTask(task.taskId).status === 'failed'));
  assert.match(second.ledger.getTask(task.taskId).lastError, /云端对话不见了/);
  assert.equal(cloud.sessions.has(task.cloudSessionId), false, '没有重新建对话');
});

test('云端收到插话但日志未落盘就崩溃：标中断并保留原文，不把上一次回复当结果或重新派', async (t) => {
  const first = await setup(t);
  const { cloud } = first;
  const task = first.runner.dispatch({ machine: 'li2', title: '会中断的', text: '先做', tabletSessionId: 'tab-A' });
  assert.ok(await until(() => cloud.sessions.get(task.cloudSessionId)?.running));
  const session = cloud.sessions.get(task.cloudSessionId);
  const onDisk = session.events.slice();
  const accepted = await first.runner.tell(task.taskId, '补充要求');
  assert.equal(accepted.delivered, true);
  await first.runner.dispose();
  session.events = onDisk;
  session.active = false;
  session.running = false;
  const promptsBefore = session.prompts.length;

  const second = await setup(t, { dir: first.dir, cloud });
  second.agents.add('tab-A');
  second.recovery.onAgentCreated(second.agents.get('tab-A'));
  assert.ok(await until(() => second.ledger.getTask(task.taskId).status === 'interrupted'));
  const result = second.ledger.getTask(task.taskId);
  assert.match(result.summary, /未能确认/);
  assert.ok(result.outbox.some(item => item.requestId === accepted.requestId && item.text === '补充要求'));
  assert.equal(session.prompts.length, promptsBefore);
});

test('跟完就放手：每次连接都释放，没有进行中的任务时不占着连接', async (t) => {
  const { cloud, jobs, runner, counts } = await setup(t);
  const task = runner.dispatch({ machine: 'li2', title: '短任务', text: 'x', tabletSessionId: 'tab-A' });
  assert.ok(await until(() => cloud.sessions.get(task.cloudSessionId) && cloud.sessions.get(task.cloudSessionId).running));
  cloud.finishTurn(task.cloudSessionId, '好');
  await jobs.get(task.jobId).settled;
  assert.ok(await until(() => counts.release === counts.connect));
});

test('跟随中心跳碰上云端重启后没加载的对话（session/state 报 not-found）：不算对话不见了，接着等', async (t) => {
  const { cloud, ledger, runner } = await setup(t);
  const task = runner.dispatch({ machine: 'li2', title: '长任务', text: 'x', tabletSessionId: 'tab-A' });
  const sid = task.cloudSessionId;
  assert.ok(await until(() => cloud.sessions.get(sid) && cloud.sessions.get(sid).running));
  cloud.coldSessions.add(sid);
  await new Promise(r => setTimeout(r, 600));   // 跟随空闲 200ms 就心跳一次，至少碰上两次
  assert.equal(ledger.getTask(task.taskId).status, 'running', JSON.stringify(ledger.getTask(task.taskId)));
  cloud.coldSessions.delete(sid);
  cloud.finishTurn(sid, '好了');
  assert.ok(await until(() => ledger.getTask(task.taskId).status === 'completed'));
});

test('重连次数用完（比如长时间冷却）：只是暂时跟丢，台账还是进行中；之后再接上照样拿到结果', async (t) => {
  const { createRunner } = await lib('runner.js');
  const base = await setup(t);
  const { cloud, ledger, jobs, recovery } = base;
  const runner = createRunner({ jobs, ledger, outbox: base.outbox, remote: { machines: () => ['li2'], async connect(m) { if (cloud.offline) throw Object.assign(new Error('machine_cooldown'), { code: 'ECONNREFUSED' }); return { client: cloud.client(), release() {} }; }, async ensureProjectDir() {}, async killLeftovers() { return { found: [], remain: [] }; }, invalidate() {} }, followIdleMs: 200, reconnectMs: [10], maxReconnects: 3 });
  t.after(() => runner.dispose());
  const task = runner.dispatch({ machine: 'li2', title: '冷却里的任务', text: 'x', tabletSessionId: 'tab-A' });
  const sid = task.cloudSessionId;
  assert.ok(await until(() => cloud.sessions.get(sid) && cloud.sessions.get(sid).running));
  cloud.offline = true;
  cloud.dropStreams(sid);
  const outcome = await jobs.get(task.jobId).settled;
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail, /暂时跟丢/);
  assert.equal(ledger.getTask(task.taskId).status, 'running', '不记失败，留给之后对账');
  cloud.offline = false;
  cloud.finishTurn(sid, '冷却完做完了');
  base.agents.add('tab-A');
  const { createRecovery } = await lib('recovery.js');
  const rec = createRecovery({ runner, ledger, agents: base.agents, readStatus: async () => ({ known: false }), retryGraceMs: 0 });
  t.after(() => rec.dispose());
  await rec.attach(ledger.getTask(task.taskId), { userPresent: true });
  assert.ok(await until(() => ledger.getTask(task.taskId).status === 'completed'));
  assert.match(ledger.getTask(task.taskId).summary, /冷却完做完了/);
});
