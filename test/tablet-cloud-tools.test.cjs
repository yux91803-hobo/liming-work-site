// 平板 liming-cloud 阶段 3：cloud_run / cloud_tell / cloud_machines 三个工具和任务执行（派活、跟随、完成、插话、接着做）。
// 云端用内存里的假 dsh web（test/tablet-cloud-fake-dsh.cjs，行为照真实 0.2.2-rc.3 实测），ctx.jobs 用照 dsh-jobs 形状的假实现。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFakeCloud, createFakeJobs, until } = require('./tablet-cloud-fake-dsh.cjs');

const lib = file => import(pathToFileURL(path.join(__dirname, '../site/tablet/liming-cloud/lib', file)).href);
const NOW = Date.parse('2026-11-26T06:00:00Z');

async function setup(t, { statuses = {}, maxPerMachine } = {}) {
  const { createLedger } = await lib('ledger.js');
  const { createOutbox } = await lib('outbox.js');
  const { createRunner } = await lib('runner.js');
  const { createCloudTools } = await lib('tools.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablet-cloud-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cloud = createFakeCloud();
  const jobs = createFakeJobs();
  const ledger = createLedger({ dir });
  ledger.init();
  const outbox = createOutbox(ledger);
  const dirs = [];
  const remote = {
    machines: () => ['li', 'li2'],
    async connect(machine) { if (cloud.offline) throw Object.assign(new Error(`连不上 ${machine}`), { code: 'ECONNREFUSED' }); return { client: cloud.client(), release() {} }; },
    async ensureProjectDir(machine, cwd) { dirs.push({ machine, cwd }); },
    invalidate() {},
  };
  const runner = createRunner({ jobs, ledger, outbox, remote, followIdleMs: 200, reconnectMs: [20, 50] });
  t.after(() => runner.dispose());
  const readStatus = async name => statuses[name] || { known: false, reason: '没有只读 key' };
  const registered = [];
  const tools = createCloudTools({ runner, ledger, remote, readStatus, settings: () => ({ maxConcurrentPerMachine: maxPerMachine }), now: () => NOW });
  for (const def of tools) registered.push(def);
  const byName = Object.fromEntries(registered.map(d => [d.name, d]));
  const exec = (callId = 'call_1') => ({ callId, rootCallId: callId, agent: { id: 'tablet-session-A' }, signal: new AbortController().signal });
  return { cloud, jobs, ledger, outbox, runner, byName, exec, dirs };
}

function walkSchema(schema, at = '$') {
  assert.equal(typeof schema, 'object', at);
  if ('required' in schema) assert.ok(Array.isArray(schema.required), `${at}.required 要写成数组`);
  for (const [k, v] of Object.entries(schema.properties || {})) walkSchema(v, `${at}.${k}`);
  if (schema.items) walkSchema(schema.items, `${at}[]`);
}

test('注册三个工具，参数和输出都是标准 JSON Schema（required 写数组），说明里告诉 AI 什么时候派', async (t) => {
  const { byName } = await setup(t);
  assert.deepEqual(Object.keys(byName).sort(), ['cloud_machines', 'cloud_run', 'cloud_tell']);
  for (const def of Object.values(byName)) {
    walkSchema(def.parameters);
    walkSchema(def.output.schema);
    assert.equal(typeof def.execute, 'function');
    assert.equal(typeof def.output.render, 'function');
  }
  assert.deepEqual(byName.cloud_run.parameters.required, ['task']);
  assert.deepEqual(byName.cloud_tell.parameters.required, ['task_id', 'text']);
  assert.match(byName.cloud_run.description, /派之前不用问/);
  assert.match(byName.cloud_run.description, /job_output/);
});

test('cloud_run 立即返回，不等云端做完；后台任务归当前平板对话，台账先记再发', async (t) => {
  const { byName, exec, ledger, jobs, cloud, dirs } = await setup(t, { statuses: { li2: { known: true, awake: true, cooldownUntil: null, remainingMin: 200 } } });
  const out = await byName.cloud_run.execute({ task: '查一下 FreeRTOS 和 RT-Thread 的任务调度差别，写一份对比', project: 'rtos-compare' }, exec('call_run1'));
  assert.equal(out.ok, true);
  assert.equal(out.machine, 'li2');
  assert.match(out.reason, /醒着/);
  assert.ok(out.taskId && out.jobId);
  const task = ledger.getTask(out.taskId);
  assert.equal(task.tabletSessionId, 'tablet-session-A');
  assert.equal(task.project, 'rtos-compare');
  assert.equal(task.cwd, '/data/workspace/tablet/rtos-compare');
  assert.equal(task.outbox.length, 1, '先写进发件箱');
  const job = jobs.get(out.jobId);
  assert.equal(job.spec.owner, 'tablet-session-A');
  assert.deepEqual(job.spec.toolCall, { callId: 'call_run1', rootCallId: 'call_run1' });
  assert.equal(job.spec.kind, 'cloud');
  assert.equal(job.outcome, null, '返回时云端还没做完');
  // 后台把活派出去：建目录、建对话（确定性编号）、发消息
  const sid = task.cloudSessionId;
  assert.ok(await until(() => cloud.sessions.get(sid) && cloud.userMessages(sid).length === 1));
  assert.deepEqual(dirs, [{ machine: 'li2', cwd: '/data/workspace/tablet/rtos-compare' }]);
  assert.equal(cloud.sessions.get(sid).cwd, '/data/workspace/tablet/rtos-compare');
  assert.ok(await until(() => ledger.getTask(out.taskId).status === 'running'));
  assert.equal(ledger.getTask(out.taskId).outbox[0].status, 'acked');
  const rendered = byName.cloud_run.output.render({}, out);
  assert.match(rendered.map(b => b.text).join(''), /li2/);
});

test('云端这一轮做完：后台任务以 completed 结束，输出里有步骤和结果，台账记完成、通知待确认', async (t) => {
  const { byName, exec, ledger, jobs, cloud } = await setup(t);
  const out = await byName.cloud_run.execute({ task: '写个 hello world', machine: 'li' }, exec());
  const sid = ledger.getTask(out.taskId).cloudSessionId;
  assert.ok(await until(() => cloud.sessions.get(sid) && cloud.sessions.get(sid).running));
  cloud.toolCall(sid, 'bash', { command: 'gcc hello.c -o hello', description: '编译' });
  assert.ok(await until(() => jobs.get(out.jobId).progress && jobs.get(out.jobId).progress.includes('编译')));
  cloud.finishTurn(sid, '写好了：hello.c，已编译运行，输出 hello world');
  const outcome = await jobs.get(out.jobId).settled;
  assert.equal(outcome.status, 'completed');
  const text = jobs.get(out.jobId).output.join('');
  assert.match(text, /bash · 编译/);
  assert.match(text, /写好了：hello\.c/);
  const task = ledger.getTask(out.taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.noticeState, 'pending');
  assert.match(task.summary, /写好了/);
  assert.ok(task.endedAt);
});

test('cloud_tell：进行中插进本轮；做完以后在原对话里开新一轮、登记新的后台任务', async (t) => {
  const { byName, exec, ledger, jobs, cloud } = await setup(t);
  const out = await byName.cloud_run.execute({ task: '整理 USART 笔记', machine: 'li2' }, exec());
  const sid = ledger.getTask(out.taskId).cloudSessionId;
  assert.ok(await until(() => cloud.sessions.get(sid) && cloud.sessions.get(sid).running));
  const steer = await byName.cloud_tell.execute({ task_id: out.taskId, text: '顺便加上 DMA 的部分' }, exec('call_tell1'));
  assert.equal(steer.mode, 'steer');
  assert.equal(steer.delivered, true);
  const prompts = cloud.sessions.get(sid).prompts;
  assert.equal(prompts.at(-1).mode, 'steer');
  assert.equal(cloud.turnStarts(sid), 1, '插话不另开一轮');
  cloud.finishTurn(sid, '笔记整理好了，含 DMA');
  assert.equal((await jobs.get(out.jobId).settled).status, 'completed');
  const again = await byName.cloud_tell.execute({ task_id: out.taskId, text: '再补一个中断优先级的例子' }, exec('call_tell2'));
  assert.equal(again.mode, 'queue');
  assert.ok(again.jobId && again.jobId !== out.jobId);
  assert.ok(await until(() => cloud.turnStarts(sid) === 2));
  assert.equal(cloud.sessions.size, 1, '还是原来那段对话');
  assert.equal(ledger.getTask(out.taskId).status, 'running');
  assert.equal(ledger.getTask(out.taskId).noticeState, 'none');
  cloud.finishTurn(sid, '例子补上了');
  assert.equal((await jobs.get(again.jobId).settled).status, 'completed');
  assert.match(ledger.getTask(out.taskId).summary, /例子补上了/);
  // cloud_run 带 continue_of 等同于接着做
  const cont = await byName.cloud_run.execute({ task: '最后检查一遍错别字', continue_of: out.taskId }, exec('call_run2'));
  assert.equal(cont.taskId, out.taskId);
  assert.ok(await until(() => cloud.turnStarts(sid) === 3));
  assert.equal(await byName.cloud_tell.execute({ task_id: 't_nope', text: 'x' }, exec()).then(r => r.ok), false);
});

test('cloud_run 带 model 时先给云端对话选模型，再发消息；不带就用那台的默认模型', async (t) => {
  const { byName, exec, ledger, cloud } = await setup(t);
  const out = await byName.cloud_run.execute({ task: '用 GLM 写首诗', machine: 'li2', model: 'glm-5.4' }, exec());
  const sid = ledger.getTask(out.taskId).cloudSessionId;
  assert.ok(await until(() => cloud.sessions.get(sid) && cloud.userMessages(sid).length === 1));
  assert.deepEqual(cloud.sessions.get(sid).model, { provider: 'xin-gateway', model: 'glm-5.4' });
  assert.ok(cloud.calls.indexOf('session/selectModel') < cloud.calls.lastIndexOf('session/prompt'));
  const plain = await byName.cloud_run.execute({ task: '默认模型', machine: 'li' }, exec());
  const sid2 = ledger.getTask(plain.taskId).cloudSessionId;
  assert.ok(await until(() => cloud.sessions.get(sid2) && cloud.userMessages(sid2).length === 1));
  assert.equal(cloud.sessions.get(sid2).model, null);
  assert.equal(byName.cloud_run.parameters.properties.model.enum.includes('glm-5.4'), true);
});

test('挑不出机器时不派：不记台账、不登记后台任务，把原因交给 AI', async (t) => {
  const cool = { known: true, awake: false, cooldownUntil: NOW + 20 * 60e3, remainingMin: null };
  const { byName, exec, ledger, jobs } = await setup(t, { statuses: { li: cool, li2: cool } });
  const out = await byName.cloud_run.execute({ task: '随便做点什么' }, exec());
  assert.equal(out.ok, false);
  assert.match(out.reason, /都在冷却/);
  assert.equal(ledger.listTasks().length, 0);
  assert.equal(jobs.jobs.size, 0);
});

test('cloud_machines：两台的醒睡、剩余时间、冷却和平板任务，只读不唤醒', async (t) => {
  const { byName, exec } = await setup(t, { statuses: { li: { known: true, awake: false, cooldownUntil: NOW + 600e3, remainingMin: null }, li2: { known: true, awake: true, cooldownUntil: null, remainingMin: 33 } } });
  await byName.cloud_run.execute({ task: '跑个长任务', machine: 'li2' }, exec());
  const out = await byName.cloud_machines.execute({}, exec());
  const li = out.machines.find(m => m.name === 'li');
  const li2 = out.machines.find(m => m.name === 'li2');
  assert.match(li.state, /冷却到 14:10/);
  assert.match(li2.state, /醒着/);
  assert.equal(li2.remainingMin, 33);
  assert.equal(li2.activeTasks, 1);
  const text = byName.cloud_machines.output.render({}, out).map(b => b.text).join('');
  assert.match(text, /li2/);
});

test('后台任务因平板引擎退出被取消（owner disposed 这一类）：只是不跟了，云端照常跑，台账还是进行中', async (t) => {
  const { byName, exec, ledger, jobs, cloud } = await setup(t);
  const out = await byName.cloud_run.execute({ task: '长任务', machine: 'li2' }, exec());
  const sid = ledger.getTask(out.taskId).cloudSessionId;
  assert.ok(await until(() => cloud.sessions.get(sid) && cloud.sessions.get(sid).running));
  const outcome = await jobs.kill(out.jobId, 'owner disposed');
  assert.equal(outcome.status, 'killed');
  assert.match(outcome.detail, /云端任务照常进行/);
  assert.equal(cloud.sessions.get(sid).running, true, '没有停云端');
  assert.ok(!cloud.calls.includes('session/cancel'));
  assert.equal(ledger.getTask(out.taskId).status, 'running');
});

test('cloud_run 能选的模型和 li、li2 上 web 配置的模型表一致（天启换模型表后这里会红）', async () => {
  const { CLOUD_MODELS } = await lib('tools.js');
  const yml = fs.readFileSync(path.join(__dirname, '../site/tablet/dsh-tablet-profile.yml'), 'utf8');
  const ids = [...yml.matchAll(/^\s+- id: "([^"]+)"$/gm)].map(m => m[1]);
  assert.ok(ids.length >= 1);
  assert.deepEqual([...CLOUD_MODELS].sort(), [...ids].sort());
  assert.match(yml, /^\s{6}xin-gateway:$/m, 'selectModel 用的线路名 xin-gateway');
});

test('每台上限：默认 2，插件配置可改，面板写进 settings.json 的优先；只收 1–5，文件权限 600', async (t) => {
  const { createSettings } = await lib('settings.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablet-cloud-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(createSettings({ dir }).get().maxConcurrentPerMachine, 2);
  const s = createSettings({ dir, config: { maxConcurrentPerMachine: 3 } });
  assert.equal(s.get().maxConcurrentPerMachine, 3);
  assert.equal(s.set({ maxConcurrentPerMachine: 4 }).maxConcurrentPerMachine, 4);
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.throws(() => s.set({ maxConcurrentPerMachine: 9 }), /1–5/);
  assert.throws(() => s.set({ maxConcurrentPerMachine: 0 }), /1–5/);
  assert.equal(s.get().maxConcurrentPerMachine, 4);
  fs.writeFileSync(s.file, '{broken');
  assert.equal(s.get().maxConcurrentPerMachine, 3, '文件坏了退回插件配置');
});
