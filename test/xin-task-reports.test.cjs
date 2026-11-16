const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const { stateMode } = require('./helpers/state-mode.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
const url = name => pathToFileURL(path.join(__dirname, '../site/xin/' + name + '.mjs')).href;
const RUN = 'rbridge001', SID = 'sbridge001', ATTEMPT = '1'.repeat(32), ID = 'a'.repeat(24);

test('畸形对象不能永久堵住队列；未知协议或丢失工作区不能降级', async () => {
  const {drainTaskReports, taskBridgeSession} = await import(url('vm-task-reports'));
  for(const value of [null, [], 1]) {
    let reply;
    drainTaskReports({}, {bridgeProtocol:1}, {drain:(_,fn)=>{reply=fn(value,{id:ID});}, submit:()=>assert.fail('malformed input must not reach controller')});
    assert.equal(typeof reply,'string');
  }
  for(const version of [1,2]) assert.throws(()=>taskBridgeSession({}, {bridgeProtocol:version,run:RUN,attempt:ATTEMPT}),{code:'bad_bridge_scope'});
});

function fixture(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-bridge-receipt-')), home = path.join(dir, 'xin');
  const io = path.join(dir, 'workspace', 'io');
  for (const d of [home + '/runs', home + '/sessions', io]) fs.mkdirSync(d, { recursive: true });
  const meta = { run: RUN, sid: SID, agent: 'codex', task: true, sandbox: true, attempt: ATTEMPT,
    bridgeProtocol: 1, started: Date.now(), pid: process.pid };
  const task = { kind: 'task', sid: SID, agent: 'codex', no: 1, title: '队列回执', status: 'running',
    runs: [RUN], dir, workspace: { io, work: dir, home: dir, tmp: dir } };
  fs.writeFileSync(home + '/runs/' + RUN + '.json', JSON.stringify(meta));
  fs.writeFileSync(home + '/sessions/' + SID + '.json', JSON.stringify(task));
  const env = { ...process.env, XIN_HOME: home, XIN_WORK: path.join(dir, 'work'), XIN_TASK_SANDBOX: '0',
    XIN_DSH: '/nonexistent/xin-test-dsh', CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    XIN_AGY_HOME: dir, XIN_FRONT_PROVIDER: 'deepseek', XIN_RUN: RUN, XIN_ATTEMPT: ATTEMPT, XIN_LOCK: 'tasks' };
  // The owner is a coordinator, never an executor with an inherited source context.
  const ownerEnv = { ...env }; delete ownerEnv.XIN_RUN; delete ownerEnv.XIN_ATTEMPT; delete ownerEnv.XIN_LOCK;
  const owner = mode === 'kernel' ? stateMode(t, ownerEnv, { force: true }) : null;
  t.after(() => stopOwned(home, dir));
  const call = (changes = {}, extra = {}) => {
    const a = { run: RUN, sid: SID, id: ID, op: 'remember', text: '板子的串口接在 USART2', ...changes };
    const r = spawnSync(process.execPath, [AGENT, 'locked', 'task_bridge'], {
      env: { ...env, ...extra }, input: JSON.stringify(a), encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const rows = sql => { const d = new DatabaseSync(home + '/workflow.sqlite', { readOnly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };
  return { dir, home, env, ownerEnv, owner, call, rows };
}

for (const mode of ['legacy', 'kernel']) {
  test(mode + '：同一文件请求重送返回原回执，不再添加记忆证据；不同内容冲突', t => {
    const f = fixture(t, mode), first = f.call();
    assert.match(first.text, /待确认/); assert.deepEqual(f.call(), first);
    assert.equal(f.rows('SELECT * FROM memory_evidence').length, 1);
    assert.equal(f.rows("SELECT * FROM commands WHERE id LIKE 'task-bridge:%'").length, 1);
    assert.equal(f.call({ text: '换成另一条内容' }).error, 'message_conflict');
    assert.equal(f.rows('SELECT * FROM memory_evidence').length, 1);
  });
  test(mode + '：旧编号、另一轮、未知操作和错误锁不能产生记忆或提问', t => {
    const f = fixture(t, mode);
    assert.equal(f.call({}, { XIN_ATTEMPT: '2'.repeat(32) }).error, 'stale_attempt');
    assert.equal(f.call({ run: 'rbridge002' }).error, 'stale_attempt');
    assert.equal(f.call({ op: 'exec', text: 'irrelevant' }).error, 'bad_bridge_request');
    assert.equal(f.call({}, { XIN_LOCK: SID }).error, 'bad_bridge_request');
    assert.equal(f.call({ sid: 'sbridge002' }).error, 'bridge_ended');
    assert.equal(f.rows("SELECT * FROM commands WHERE id LIKE 'task-bridge:%'").length, 0);
    assert.equal(JSON.parse(fs.readFileSync(f.home + '/sessions/' + SID + '.json')).pendingQuestion, undefined);
  });
  test(mode + '：结束后只重放已经提交的回执，新请求不能改变任务', t => {
    const f = fixture(t, mode), first = f.call({ op: 'ask', text: '请选择串口引脚' });
    const r = spawnSync(process.execPath, [AGENT, 'locked', 'run_patch'], { env: f.env,
      input: JSON.stringify({ run: RUN, changes: { ended: Date.now() } }), encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(f.call({ op: 'ask', text: '请选择串口引脚' }), first);
    assert.equal(f.call({ id: 'b'.repeat(24), op: 'ask', text: '不得替换旧问题' }).error, 'bridge_ended');
    const saved = JSON.parse(fs.readFileSync(f.home + '/sessions/' + SID + '.json'));
    assert.equal(saved.pendingQuestion || saved.question, '请选择串口引脚');
  });
}

test('状态进程提交后崩溃，重送仍返回同一回执和单份记忆证据', async t => {
  const f = fixture(t, 'kernel'), first = f.call();
  f.owner.child.kill('SIGKILL'); await f.owner.exited;
  stateMode(t, f.ownerEnv, { force: true });
  assert.deepEqual(f.call(), first);
  assert.equal(f.rows('SELECT * FROM memory_evidence').length, 1);
});

test('忘掉任务的既有清理路径会移除含记忆正文的桥回执', async t => {
  const f = fixture(t, 'legacy'); f.call();
  const {StateJournal} = await import(url('vm-state'));
  const journal = new StateJournal(f.home);
  try { journal.dropConversation(SID); } finally { journal.close(); }
  assert.equal(f.rows("SELECT * FROM commands WHERE id LIKE 'task-bridge:%'").length, 0);
});

test('真实文件队列：提交后丢回应并重启 owner，原请求保留，重送不重复记忆', async t => {
  const f = fixture(t, 'kernel');
  const { drainBridge } = await import(url('vm-runtime'));
  const { drainTaskReports, taskBridgeSession } = await import(url('vm-task-reports'));
  const m = JSON.parse(fs.readFileSync(f.home + '/runs/' + RUN + '.json'));
  const task = JSON.parse(fs.readFileSync(f.home + '/sessions/' + SID + '.json'));
  const w = taskBridgeSession(task, m).workspace;
  const req = path.join(w.io, ID + '.request'), reply = path.join(w.io, ID + '.reply');
  fs.writeFileSync(req, JSON.stringify({ op: 'remember', text: '板子的串口接在 USART2' }));
  const submit = a => f.call(a);
  drainTaskReports(w, m, { drain: drainBridge, submit: a => { submit(a); throw Error('simulated lost response'); } });
  assert.equal(fs.existsSync(req), true); assert.equal(fs.existsSync(reply), false);
  f.owner.child.kill('SIGKILL'); await f.owner.exited;
  stateMode(t, f.ownerEnv, { force: true });
  drainTaskReports(w, m, { drain: drainBridge, submit });
  assert.equal(fs.existsSync(req), false); assert.match(fs.readFileSync(reply, 'utf8'), /待确认/);
  assert.equal(f.rows('SELECT * FROM memory_evidence').length, 1);
});

for (const committed of [false, true]) test('提交' + (committed ? '后' : '前') + ' kill：副作用和回执一起恢复', t => {
  const f = fixture(t, 'legacy');
  const code = `import {journal,readJ,BASE,ownership} from ${JSON.stringify(url('vm-base'))};
    import {addMemory} from ${JSON.stringify(url('vm-memory'))};
    import {createController} from ${JSON.stringify(url('vm-kernel-controller'))};
    import {createTaskBridgeHandler} from ${JSON.stringify(url('vm-task-reports'))};
    const fn=createTaskBridgeHandler({loadRun:r=>readJ(BASE+'/runs/'+r+'.json'),loadTask:s=>readJ(BASE+'/sessions/'+s+'.json'),isTask:t=>t?.kind==='task',lastRun:t=>t.runs.at(-1),remember:addMemory,ask:()=>{throw Error('unexpected ask')}});
    const c=createController({ops:{},iops:{task_bridge:fn},dispatchLaunches:()=>{}});
    ownership.hold();const db=journal.db,exec=db.exec.bind(db);
    ${committed ? "journal.recover=()=>process.kill(process.pid,'SIGKILL');" : "db.exec=sql=>{if(sql==='COMMIT')process.kill(process.pid,'SIGKILL');return exec(sql);};"}
    console.log(JSON.stringify(c.invoke({op:'task_bridge',locked:true,key:'tasks',run:'${RUN}',attempt:'${ATTEMPT}',args:{run:'${RUN}',sid:'${SID}',id:'${ID}',op:'remember',text:'板子的串口接在 USART2'}})));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.signal, 'SIGKILL', r.stderr + r.stdout);
  const before = f.rows("SELECT * FROM commands WHERE id LIKE 'task-bridge:%'");
  assert.equal(before.length, committed ? 1 : 0);
  const reply = f.call(); assert.match(reply.text, /待确认/);
  assert.equal(f.rows('SELECT * FROM memory_evidence').length, 1);
  assert.equal(f.rows("SELECT * FROM commands WHERE id LIKE 'task-bridge:%'").length, 1);
});
