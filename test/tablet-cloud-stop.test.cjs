// 平板 liming-cloud 阶段 5：停止协议（设计 §5.6）。先记「停止中」，再停当前一轮、停后台命令、清项目目录下的残留进程、复核；
// 四项都确认了才报「已停止」，做不下去就保持「停止中」，之后可以重复执行。取消原因表逐行各一条。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createFakeCloud, createFakeJobs, until } = require('./tablet-cloud-fake-dsh.cjs');

const lib = file => import(pathToFileURL(path.join(__dirname, '../site/tablet/liming-cloud/lib', file)).href);

async function setup(t) {
  const { createLedger } = await lib('ledger.js');
  const { createOutbox } = await lib('outbox.js');
  const { createRunner } = await lib('runner.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablet-cloud-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cloud = createFakeCloud();
  const jobs = createFakeJobs();
  const ledger = createLedger({ dir });
  ledger.init();
  const outbox = createOutbox(ledger);
  const leftovers = { found: [], remain: [], calls: 0 };
  const remote = {
    machines: () => ['li', 'li2'],
    async connect(machine) { if (cloud.offline) throw Object.assign(new Error(`连不上 ${machine}`), { code: 'ECONNREFUSED' }); return { client: cloud.client(), release() {} }; },
    async ensureProjectDir() {},
    async killLeftovers(machine, cwd) { leftovers.calls += 1; leftovers.lastCwd = cwd; if (cloud.offline) throw new Error('连不上'); return { found: [...leftovers.found], remain: [...leftovers.remain] }; },
    invalidate() {},
  };
  const runner = createRunner({ jobs, ledger, outbox, remote, followIdleMs: 200, reconnectMs: [20, 50], maxReconnects: 3, stopJobWaitMs: 150 });
  t.after(() => runner.dispose());
  async function running(machine = 'li2') {
    const task = runner.dispatch({ machine, title: '长任务', text: '跑个长任务', tabletSessionId: 'tablet-A' });
    const sid = task.cloudSessionId;
    assert.ok(await until(() => cloud.sessions.get(sid) && cloud.sessions.get(sid).running));
    return { ...task, sid };
  }
  return { cloud, jobs, ledger, outbox, runner, leftovers, remote, running };
}

test('四步停止：一轮停了、后台命令清空、残留进程清零，都复核过才记「已停止」', async (t) => {
  const { cloud, jobs, ledger, leftovers, running } = await setup(t);
  const task = await running();
  cloud.addJob(task.sid, { id: 'bash-aaa', label: 'npm run dev' });
  leftovers.found = [4242];
  const outcome = await jobs.kill(task.jobId, 'no longer needed');
  assert.equal(outcome.status, 'killed');
  assert.match(outcome.detail, /已停止/);
  const t2 = ledger.getTask(task.taskId);
  assert.equal(t2.status, 'stopped');
  assert.equal(t2.stopRequest.source, 'job');
  assert.equal(t2.stopRequest.reason, 'no longer needed');
  assert.ok(t2.stopRequest.confirmedAt);
  assert.deepEqual(t2.stopRequest.killedPids, [4242]);
  assert.equal(cloud.sessions.get(task.sid).running, false);
  assert.equal(cloud.sessions.get(task.sid).jobs[0].status, 'killed');
  assert.equal(leftovers.lastCwd, task.cwd, '只清这个任务的项目目录');
  const order = ['session/cancel', 'job/list', 'job/kill'].map(n => cloud.calls.indexOf(n));
  assert.ok(order.every(i => i >= 0) && order[0] < order[1] && order[1] < order[2], JSON.stringify(cloud.calls));
});

test('云端这一轮还在跑时不报「已停止」；之后再停一次就停完（可以重复执行）', async (t) => {
  const { cloud, jobs, ledger, runner, running } = await setup(t);
  const task = await running();
  cloud.stubbornCancel = true;
  const outcome = await jobs.kill(task.jobId, 'cancelled by the user');
  assert.match(outcome.detail, /停止中/);
  assert.equal(ledger.getTask(task.taskId).status, 'stopping');
  assert.match(ledger.getTask(task.taskId).lastError, /这一轮还在跑/);
  cloud.stubbornCancel = false;
  const again = await runner.stop(task.taskId, { source: 'resume' });
  assert.equal(again.status, 'stopped');
  assert.equal(ledger.getTask(task.taskId).status, 'stopped');
  assert.equal(ledger.getTask(task.taskId).stopRequest.reason, 'cancelled by the user', '原来的停止请求留着');
});

test('后台命令停不下来时不报「已停止」', async (t) => {
  const { cloud, jobs, ledger, running } = await setup(t);
  const task = await running();
  cloud.addJob(task.sid, { id: 'bash-stuck', label: 'stuck', unkillable: true });
  await jobs.kill(task.jobId, 'no longer needed');
  assert.equal(ledger.getTask(task.taskId).status, 'stopping');
  assert.match(ledger.getTask(task.taskId).lastError, /后台命令没停下/);
});

test('项目目录下的残留进程停不掉时不报「已停止」', async (t) => {
  const { jobs, ledger, leftovers, running } = await setup(t);
  const task = await running();
  leftovers.found = [11, 12];
  leftovers.remain = [12];
  await jobs.kill(task.jobId, 'no longer needed');
  assert.equal(ledger.getTask(task.taskId).status, 'stopping');
  assert.match(ledger.getTask(task.taskId).lastError, /PID 12/);
});

test('停到一半连不上：保持「停止中」；连上后接着停完', async (t) => {
  const { cloud, ledger, runner, running } = await setup(t);
  const task = await running();
  cloud.offline = true;
  const r = await runner.stopFromPanel(task.taskId);
  assert.equal(r.status, 'stopping');
  assert.equal(ledger.getTask(task.taskId).status, 'stopping');
  assert.equal(ledger.getTask(task.taskId).stopRequest.source, 'panel');
  cloud.offline = false;
  const done = await runner.stop(task.taskId, { source: 'resume' });
  assert.equal(done.status, 'stopped');
});

test('云端重启后没加载的对话：session/cancel、session/state、job/list 报 not-found 也照样往下停', async (t) => {
  const { cloud, ledger, runner, running } = await setup(t);
  const task = await running();
  await runner.dispose();   // 平板不跟了（像引擎重启）
  cloud.finishTurn(task.sid, '', { kind: 'interrupted' });
  cloud.coldSessions.add(task.sid);
  const r = await runner.stop(task.taskId, { source: 'resume' });
  assert.equal(r.status, 'stopped', r.detail);
  assert.equal(ledger.getTask(task.taskId).status, 'stopped');
});

test('取消原因表：模型原话、cancelled by the user、session archived 停云端；引擎退出类只解除跟踪', async (t) => {
  const { DETACH_ONLY_REASONS } = await lib('cancel-reasons.js');
  assert.deepEqual([...DETACH_ONLY_REASONS].sort(), ['jobs service disposed', 'jobs teardown', 'owner disposed', 'teardown']);
  for (const reason of ['不需要了，换个思路', 'cancelled by the user', 'session archived']) {
    const { cloud, jobs, ledger, running } = await setup(t);
    const task = await running();
    await jobs.kill(task.jobId, reason);
    assert.equal(ledger.getTask(task.taskId).status, 'stopped', reason);
    assert.ok(cloud.calls.includes('session/cancel'), reason);
  }
  for (const reason of DETACH_ONLY_REASONS) {
    const { cloud, jobs, ledger, running } = await setup(t);
    const task = await running();
    const outcome = await jobs.kill(task.jobId, reason);
    assert.equal(outcome.status, 'killed', reason);
    assert.equal(ledger.getTask(task.taskId).status, 'running', reason);
    assert.ok(!cloud.calls.includes('session/cancel'), reason);
    assert.equal(cloud.sessions.get(task.sid).running, true, reason);
  }
});

test('面板「停止」直接走停止协议，停完结掉平板这边的后台任务', async (t) => {
  const { jobs, ledger, runner, running } = await setup(t);
  const task = await running();
  const r = await runner.stopFromPanel(task.taskId);
  assert.equal(r.status, 'stopped');
  const outcome = await jobs.get(task.jobId).settled;
  assert.equal(outcome.status, 'killed');
  assert.equal(ledger.getTask(task.taskId).stopRequest.source, 'panel');
  assert.equal((await runner.stopFromPanel(task.taskId)).status, 'stopped', '已经停了再点也不出错');
});

test('停止等正在发送的消息，合并重复停止，接着做时不补发已撤销的消息', async (t) => {
  const { cloud, ledger, outbox, runner, running } = await setup(t);
  const task = await running();
  const arrived = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(release.resolve);
  const client = cloud.client();
  const send = outbox.enqueueAndFlush(task.taskId, { text: '正在发送的插话', mode: 'steer' }, {
    async prompt(...args) {
      arrived.resolve();
      await release.promise;
      return client.prompt(...args);
    },
  });
  await arrived.promise;
  outbox.enqueue(task.taskId, { text: '还未发送的插话', mode: 'steer' });
  const first = runner.stopFromPanel(task.taskId);
  const second = runner.stop(task.taskId, { source: 'resume' });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ledger.getTask(task.taskId).status, 'stopping');
    assert.ok(!cloud.calls.includes('session/cancel'), '发送中的请求结清后才开始云端停止');
  } finally {
    release.resolve();
    await Promise.allSettled([send, first, second]);
  }
  await send;
  assert.deepEqual(await first, await second);
  assert.equal(ledger.getTask(task.taskId).status, 'stopped');
  assert.equal(cloud.sessions.get(task.sid).running, false);
  assert.equal(cloud.calls.filter(x => x === 'session/cancel').length, 1);
  await runner.tell(task.taskId, '请继续');
  assert.ok(await until(() => cloud.userMessages(task.sid).some(m => m.text === '请继续')));
  assert.deepEqual(cloud.userMessages(task.sid).map(m => m.text), ['跑个长任务', '正在发送的插话', '请继续']);
});

test('停止先撤回仍在 Harness 里排队的本任务消息，再验证当前轮结束', async (t) => {
  const { cloud, ledger, outbox, runner, running } = await setup(t);
  const task = await running();
  const client = cloud.client();
  await outbox.enqueueAndFlush(task.taskId, { text: '排到下轮的旧请求', mode: 'queue' }, client);
  assert.equal(cloud.sessions.get(task.sid).queue.length, 1);
  assert.equal((await runner.stopFromPanel(task.taskId)).status, 'stopped');
  assert.equal(ledger.getTask(task.taskId).status, 'stopped');
  assert.equal(cloud.sessions.get(task.sid).running, false);
  assert.deepEqual(cloud.userMessages(task.sid).map(m => m.text), ['跑个长任务']);
});

test('同一机器同一项目只允许一个活动任务，旧台账有重叠时不扫别人的进程', async (t) => {
  const { cloud, ledger, runner, leftovers } = await setup(t);
  const request = { machine: 'li2', project: 'shared-project', title: '任务', text: '开始', tabletSessionId: 'tab-A' };
  const first = runner.dispatch(request);
  assert.throws(() => runner.dispatch(request), { code: 'PROJECT_BUSY' });
  assert.ok(await until(() => cloud.sessions.get(first.cloudSessionId)?.running));
  const old = ledger.createTask({ ...request, status: 'running' });
  const r = await runner.stopFromPanel(first.taskId);
  assert.equal(r.status, 'stopping');
  assert.match(r.detail, new RegExp(old.taskId));
  assert.equal(leftovers.calls, 0, '项目目录仍被另一个任务使用');
});

// Harness 释放类原因防漂移：设了 DSH_HARNESS_ROOT（含 node_modules/@deepseek-ai 的目录）就扫它的源码；
// 没设时核对下面这份从 0.2.2-rc.1、0.2.2-rc.3 源码抄下来的快照（dsh-jobs-local 的 cancelForTeardown、disposeAll、settle 原因）。
const SNAPSHOT_RC1_RC3 = ['owner disposed', 'jobs service disposed', 'jobs teardown', 'teardown'];
test('已装 Harness 的释放类取消原因都在「只解除跟踪」名单里', async () => {
  const { DETACH_ONLY_REASONS, isDetachReason } = await lib('cancel-reasons.js');
  let found = SNAPSHOT_RC1_RC3;
  const root = process.env.DSH_HARNESS_ROOT;
  if (root) {
    const src = fs.readFileSync(path.join(root, 'node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js'), 'utf8');
    found = [...new Set([...src.matchAll(/"([a-z ]*(?:disposed|teardown))"/g)].map(m => m[1]))];
    assert.ok(found.length >= 3, `在 ${root} 里没扫到释放类原因`);
  }
  for (const r of found) assert.ok(isDetachReason(r), `Harness 有新的释放类原因「${r}」，要加进 cancel-reasons.js 并核对它是不是只在引擎退出时出现`);
  assert.deepEqual([...DETACH_ONLY_REASONS].sort(), [...SNAPSHOT_RC1_RC3].sort());
  assert.equal(isDetachReason('cancelled by the user'), false);
  assert.equal(isDetachReason(' owner disposed '), true);
});

test('残留进程脚本（本机 /bin/sh 实跑）：只停工作目录在项目目录下的进程，项目目录外的不碰', { skip: process.platform !== 'linux' }, async (t) => {
  const { leftoverScript, parseLeftovers } = await lib('remote.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tablet-cloud-leftover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = path.join(root, 'proj-abc');
  const sub = path.join(proj, 'build');
  const other = path.join(root, 'proj-abcdef');   // 名字有共同前缀的别的项目
  for (const d of [sub, other]) fs.mkdirSync(d, { recursive: true });
  const inside = spawn('sleep', ['60'], { cwd: proj, stdio: 'ignore' });
  const deeper = spawn('sleep', ['60'], { cwd: sub, stdio: 'ignore' });
  const outside = spawn('sleep', ['60'], { cwd: other, stdio: 'ignore' });
  t.after(() => { for (const p of [inside, deeper, outside]) try { p.kill('SIGKILL'); } catch {} });
  await new Promise(r => setTimeout(r, 200));
  const out = execFileSync('/bin/sh', ['-c', leftoverScript(proj)], { encoding: 'utf8' });
  const r = parseLeftovers(out);
  assert.deepEqual([...r.found].sort((a, b) => a - b), [inside.pid, deeper.pid].sort((a, b) => a - b));
  assert.deepEqual(r.remain, []);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(await until(() => !alive(inside.pid) || inside.exitCode !== null || inside.signalCode !== null));
  assert.equal(alive(outside.pid), true, '项目目录外的进程还活着');
  assert.equal(parseLeftovers('garbage'), null);
});
