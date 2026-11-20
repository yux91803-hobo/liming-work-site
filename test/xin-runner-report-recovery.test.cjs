const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { installStateSocketFault, stateSocketFault } = require('./helpers/state-socket-fault.cjs');
const SOURCE = path.join(__dirname, '../site/xin'), FRONT = path.join(__dirname, 'helpers/front-responses.cjs');
const KEY = Buffer.alloc(32, 9).toString('base64url'), OWNER = { mode: 'kernel', gen: 1 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = platformTimeout(10000)) {
  const end = performance.now() + ms;
  for (;;) { const value = await check(); if (value || performance.now() > end) return value; await sleep(25); }
}
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

async function fixture(t, fault, { gateRunner = false, startupFault = false, backoffMs = [3000], finalization = false, finalizationFault, writeProject = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-report-recovery-')), home = path.join(dir, 'xin'), work = path.join(dir, 'work'), bin = path.join(dir, 'bin');
  for (const folder of [bin, work, path.join(work, 'uploads'), path.join(home, 'agent'), path.join(home, 'runs'), path.join(home, 'sessions'), path.join(dir, 'user')]) fs.mkdirSync(folder, { recursive: true });
  for (const name of ['claude', 'agy', 'dsh']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const codexLog = path.join(dir, 'codex.jsonl'), codexGo = path.join(dir, 'codex-go'), runnerGo = path.join(dir, 'runner-go');
  const disableWriter = path.join(dir, 'disable-writer'), phaseMarker = path.join(dir, 'finalization-phase.json');
  const blockOwner = path.join(dir, 'block-test-owner');
  const project = path.join(work, 'project');
  fs.writeFileSync(path.join(bin, 'codex'), '#!' + process.execPath + '\n' + `
const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(codexLog)},JSON.stringify(process.argv.slice(2))+'\\n');
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(codexGo)})){
  clearInterval(timer);
  if(${writeProject}){fs.writeFileSync('a.txt','new A');fs.writeFileSync('b.txt','new B');}
  if(${finalization === 'default'})console.log(JSON.stringify({type:'thread.started',thread_id:'10000000-0000-0000-0000-000000000001'}));
  console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'任务测试完成'}}));
}},20);
`, { mode: 0o755 });
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
const fs=require('node:fs');require('node:os').homedir=()=>${JSON.stringify(path.join(dir, 'user'))};require('node:module').syncBuiltinESMExports();
const real=global.fetch;global.fetch=(url,init)=>{const u=new URL(String(url));if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('test blocked external fetch');return real(url,init);};
if(${JSON.stringify(startupFault)}&&process.argv[2]==='run'){
  const net=require('node:net'),end=net.Socket.prototype.end;
  net.Socket.prototype.end=function(data,...rest){
    if(typeof data==='string'||Buffer.isBuffer(data)){
      try{const q=JSON.parse(String(data));if(q.kind==='control'&&q.op==='health'){q.testStartupRun=process.argv[3];q.testStartupAttempt=process.env.XIN_ATTEMPT;data=JSON.stringify(q)+'\\n';}}catch{}
    }
    return end.call(this,data,...rest);
  };
}
if(${JSON.stringify(gateRunner)}&&process.argv[2]==='run')while(!fs.existsSync(${JSON.stringify(runnerGo)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
if(fs.existsSync(${JSON.stringify(disableWriter)}))process.env.XIN_RUN_FINALIZATION='0';
if(process.argv[2]==='serve')while(fs.existsSync(${JSON.stringify(blockOwner)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
if(['ready','prepared'].includes(${JSON.stringify(finalizationFault)})&&process.argv[2]==='run'){
  const link=fs.linkSync;
  fs.linkSync=(from,to)=>{
    const phase=${JSON.stringify(finalizationFault)};
    if(phase==='prepared')link(from,to);
    if(require('node:path').basename(to)===phase&&!fs.existsSync(${JSON.stringify(phaseMarker)})){
      fs.writeFileSync(${JSON.stringify(phaseMarker)},JSON.stringify({pid:process.pid,phase}));
      process.kill(process.pid,'SIGSTOP');
    }
    if(phase==='ready')link(from,to);
  };
  require('node:module').syncBuiltinESMExports();
}
if(${JSON.stringify(finalizationFault)}==='project'&&process.argv[2]==='serve'){
  const rename=fs.renameSync;
  fs.renameSync=(from,to)=>{
    rename(from,to);
    if(require('node:path').dirname(to)===${JSON.stringify(project)}&&from.startsWith(to+'.xin-')&&!fs.existsSync(${JSON.stringify(phaseMarker)})){
      fs.writeFileSync(${JSON.stringify(phaseMarker)},JSON.stringify({pid:process.pid,file:to}));
      process.kill(process.pid,'SIGSTOP');
    }
  };
  require('node:module').syncBuiltinESMExports();
}
require(${JSON.stringify(FRONT)});
`);
  const env = { ...process.env, XIN_HOME: home, XIN_WORK: work, XIN_DSH: path.join(bin, 'dsh'), XIN_AGY_HOME: path.join(dir, 'user'), XIN_ANTIGRAVITY_BIN: '',
    XIN_FRONT_PROVIDER: 'deepseek', XIN_FRONT_TEST_DELAY: '1500', XIN_FRONT_TEST_TEXT: '做好了', XIN_FRONT_TEST_LOG: path.join(dir, 'front.jsonl'),
    XIN_STATE_TEST_FAULT: fault, XIN_RUN_ATTEMPTS: '1', XIN_RUN_FINALIZATION: finalization ? '1' : '0',
    ...(finalization ? {XIN_DEAD_MS:'3500'} : {}), XIN_CODEX_TRANSPORT: 'exec', XIN_TASK_SANDBOX: '0', XIN_CODEX_KEY: 'synthetic-test-key',
    CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), NODE_OPTIONS: '--require=' + preload, PATH: bin + ':' + process.env.PATH };
  if (finalization === 'default') delete env.XIN_RUN_FINALIZATION;
  for (const name of fs.readdirSync(SOURCE).filter(n => /^vm-.*\.mjs$/.test(n))) fs.copyFileSync(path.join(SOURCE, name), path.join(home, 'agent', name));
  installStateSocketFault(path.join(home, 'agent'));
  if (['beforeCommit','afterCommit'].includes(finalizationFault)) {
    const state = path.join(home, 'agent', 'vm-state.mjs'), original = fs.readFileSync(state, 'utf8');
    const boundary = "      d.exec('COMMIT');\n    }catch(e)";
    assert.ok(original.includes(boundary));
    const pause = `\n      if(command?.id.startsWith('finish:')&&!fs.existsSync(${JSON.stringify(phaseMarker)})){
        fs.writeFileSync(${JSON.stringify(phaseMarker)},JSON.stringify({pid:process.pid,phase:${JSON.stringify(finalizationFault)}}));
        process.kill(process.pid,'SIGSTOP');
      }\n`;
    const commit = "      d.exec('COMMIT');\n";
    fs.writeFileSync(state, original.replace(boundary, (finalizationFault === 'beforeCommit' ? pause + commit : commit + pause) + '    }catch(e)'));
  }
  const agent = path.join(home, 'agent', 'vm-agent-0123456789ab.mjs'); fs.copyFileSync(path.join(SOURCE, 'vm-agent.mjs'), agent);
  fs.writeFileSync(path.join(home, 'kernel-keys.json'), JSON.stringify({ v: 1, keys: { ka: KEY } }), { mode: 0o600 });
  const K = await import(pathToFileURL(path.join(SOURCE, 'vm-kernel.mjs')).href), W = await import(pathToFileURL(path.join(__dirname, '../src/xin-kernel.js')).href);
  const k = await K.createKernel({ home, env, keeper: { backoffMs } });
  t.after(async () => { fs.rmSync(blockOwner,{force:true}); await k.close().catch(() => {}); await stopOwned(home, dir, platformTimeout(10000)); });
  const request = async (method, target, body) => {
    const text = body === undefined ? '' : JSON.stringify(body), headers = { 'x-xin-auth': await W.signKernelRequest({ key: KEY, kid: 'ka', method, target, body: text }) };
    if (text) headers['content-type'] = 'application/json';
    const r = await fetch('http://127.0.0.1:' + k.port + target, { method, headers, body: text || undefined }); return { status: r.status, body: await r.json() };
  };
  const op = async (name, args = {}) => { const r = await request('POST', '/xin/op', { agent, op: name, args, owner: OWNER }); assert.equal(r.body.ok, true, JSON.stringify(r)); return r.body.data; };
  const health = async () => (await request('GET', '/xin/health')).body;
  const running = previous => until(async () => { const h = await health(); return h.owner.phase === 'running' && h.owner.pid !== previous && h; });
  const meta = run => readJSON(path.join(home, 'runs', run + '.json'));
  const inspect = async run => JSON.stringify({ run, meta: meta(run), owner: (await health()).owner, modelCalls: rows(path.join(dir, 'front.jsonl')).length, kernel: rows(path.join(home, 'logs', 'kernel.jsonl')).filter(r => r.route === 'state') });
  const settle = async run => {
    for (const end = performance.now() + platformTimeout(20000); performance.now() < end; await sleep(50)) {
      const r = await request('POST', '/xin/op', { agent, op: 'poll', args: { run }, owner: OWNER });
      if (r.body.ok && r.body.data.done) return r.body.data;
    }
    assert.fail('这一轮没收尾：' + await inspect(run));
  };
  await op('sessions'); assert.ok(await running());
  return { dir, home, work, project, env, op, health, running, meta, inspect, settle, codexLog, codexGo, runnerGo, disableWriter, phaseMarker, blockOwner,
    modelCalls: () => rows(path.join(dir, 'front.jsonl')) };
}

async function killAtFault(f, run, phase, op) {
  const fault = await until(() => stateSocketFault(f.home)); assert.ok(fault, '没有命中完整请求帧的故障点');
  assert.equal(fault.phase, phase); assert.equal(fault.op, op); assert.equal(fault.run, run);
  const first = f.meta(run); assert.match(first.attempt, /^[a-f0-9]{32}$/); assert.equal(fault.attempt, first.attempt);
  process.kill(fault.pid, 'SIGKILL'); return { first, killedAt: performance.now(), pid: fault.pid, result: fault.result };
}

for (const operation of ['front_immediate', 'front_model']) test(operation + ' 完整请求已送出、处理前主人被杀：同一尝试接着做，模型只调一次', async t => {
  const f = await fixture(t, 'before:' + operation), sent = await f.op('send', { main: true, text: '慢慢做', clientId: 'report-' + operation + '-0001' });
  const { first, killedAt, pid } = await killAtFault(f, sent.run, 'before', operation), done = await f.settle(sent.run);
  assert.ok(performance.now() - killedAt < platformTimeout(8000), '收尾太慢：' + await f.inspect(sent.run));
  assert.equal(f.modelCalls().length, 1, '不能用提早报错代替真正执行模型：' + await f.inspect(sent.run));
  assert.equal(done.events.filter(e => e.t === 'done').length, 1); assert.equal(done.events.find(e => e.t === 'done').ok, true, JSON.stringify(done.events));
  assert.ok(done.events.some(e => e.t === 'text' && /做好了/.test(e.text))); assert.ok(!done.events.some(e => e.t === 'err'), JSON.stringify(done.events));
  const after = await f.running(pid); assert.ok(after); assert.ok(after.owner.epoch > 1); assert.equal(f.meta(sent.run).attempt, first.attempt);
});

test('启动 health 完整请求已送出、处理前主人被杀：同一尝试接着做，模型只调一次', async t => {
  const f = await fixture(t, 'before:health', { startupFault: true, backoffMs: [50] }), sent = await f.op('send', { main: true, text: '慢慢做', clientId: 'report-startup-0001' });
  const { first, killedAt, pid } = await killAtFault(f, sent.run, 'before', 'health');
  assert.equal(first.pid, null, '故障发生在 runner 初始化前的只读健康探测');
  assert.ok(await f.running(pid), '替换主人应已就绪');
  assert.ok(await until(() => f.modelCalls().length === 1, platformTimeout(4000)), '启动探测失联后仍未调用模型：' + await f.inspect(sent.run));
  const done = await f.settle(sent.run);
  assert.ok(performance.now() - killedAt < platformTimeout(8000));
  assert.equal(f.modelCalls().length, 1); assert.equal(f.meta(sent.run).attempt, first.attempt);
  assert.equal(done.events.filter(e => e.t === 'done').length, 1); assert.equal(done.events.find(e => e.t === 'done').ok, true, JSON.stringify(done.events));
  assert.ok(!done.events.some(e => e.t === 'err'), JSON.stringify(done.events));
});

test('front_immediate 视觉转交已提交但回应丢失：重起后取回同一任务，不重复派活', async t => {
  const f = await fixture(t, 'after:front_immediate', { gateRunner: true, backoffMs: [50] }), image = path.join(f.work, 'uploads', 'photo.png'); fs.writeFileSync(image, 'synthetic-png-fixture');
  const sent = await f.op('send', { main: true, text: '看看这张图', clientId: 'report-vision-0001', files: [{ path: image, name: 'photo.png' }] });
  // The same capability flag is written when a provider reports image:false; pause before runner startup to make that real state deterministic.
  const original = f.meta(sent.run), { requestState } = await import(pathToFileURL(path.join(SOURCE, 'vm-kernel-client.mjs')).href);
  await requestState(f.home, { kind: 'write', name: 'runs/' + sent.run + '.json', body: JSON.stringify({ ...original, frontSeesImages: false }) });
  fs.writeFileSync(f.runnerGo, '');
  const { first, killedAt, pid, result } = await killAtFault(f, sent.run, 'after', 'front_immediate'); assert.ok(result.terminal && result.task?.sid, JSON.stringify(result));
  const created = fs.readdirSync(path.join(f.home, 'sessions')).map(n => readJSON(path.join(f.home, 'sessions', n))).filter(s => s.kind === 'task');
  assert.equal(created.length, 1, '丢回应之前，视觉任务已经提交'); assert.equal(created[0].sid, result.task.sid); assert.equal(created[0].frontRun, sent.run);
  const done = await f.settle(sent.run);
  assert.ok(performance.now() - killedAt < platformTimeout(8000), '收尾太慢：' + await f.inspect(sent.run));
  assert.equal(done.events.filter(e => e.t === 'done').length, 1); assert.equal(done.events.find(e => e.t === 'done').ok, true, JSON.stringify(done.events));
  assert.equal(f.meta(sent.run).attempt, first.attempt); assert.ok(await f.running(pid)); assert.equal(f.modelCalls().length, 0, '视觉转交不需要再调聊天模型');
  const tasks = (await f.op('tasks', { sid: sent.sid })).tasks; assert.equal(tasks.length, 1); assert.equal(tasks[0].sid, result.task.sid);
  assert.ok(await until(() => rows(f.codexLog).length === 1), '只启动一个假视觉执行器'); assert.equal(rows(f.codexLog).length, 1);
});

test('front_immediate 不可重试的报告错误：辅助定时器不阻止 runner 退出和释放执行锁', async t => {
  const f = await fixture(t, 'reject:front_immediate'), sent = await f.op('send', { main: true, text: '慢慢做', clientId: 'report-rejected-0001' });
  const fault = await until(() => stateSocketFault(f.home)); assert.ok(fault, '没有命中报告错误点');
  assert.equal(fault.op, 'front_immediate'); assert.equal(fault.run, sent.run);
  const first = f.meta(sent.run); assert.ok(first.pid, '先登记 runner 再报告');
  const running = () => {
    try { const stat = fs.readFileSync('/proc/' + first.pid + '/stat', 'utf8'); return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]); }
    // 进程在 open 和读之间退出时 Linux 报 ESRCH 而不是 ENOENT（2026-11-21 main 运行 44775024922 偶发），两种都算已退出
    catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return false; throw e; }
  };
  assert.ok(await until(() => !running(), platformTimeout(3000)), '不可重试错误之后 runner 仍被辅助定时器挂住');
  const lock = spawnSync('flock', ['-n', '--conflict-exit-code', '73', path.join(f.home, 'locks', sent.run + '.lock'), 'true'], { timeout: 1000 });
  assert.equal(lock.status, 0, 'runner 退出必须释放生命周期锁');
  assert.equal(f.modelCalls().length, 0, '协议拒绝之后不启动模型');
  assert.equal(f.meta(sent.run).ended, undefined, '未得到模型结果，不伪造成功收尾');
});

const stateClient = () => import(pathToFileURL(path.join(SOURCE, 'vm-kernel-client.mjs')).href);
const storeReader = () => import(pathToFileURL(path.join(SOURCE, 'vm-run-attempt.mjs')).href);
const locked = async (f, op, args, context = {}) => (await stateClient()).requestState(f.home,
  {kind:'op', op, args, locked:true, key:'tasks', ...context});
const finalDir = (f, meta) => path.join(f.home, 'finalization', meta.run + '.' + meta.attempt);
const loadSession = (f, sid) => readJSON(path.join(f.home, 'sessions', sid + '.json'));
const modelStats = (f, run) => rows(path.join(f.home, 'model-stats.jsonl')).filter(e => e.run === run && e.kind !== 'status');

async function startBackground(f, options) {
  const result = await locked(f, 'task_new', {kind:'system', title:'收尾测试', goal:'运行隔离的本地收尾测试', model:'glm-5.3', named:true, ...options});
  assert.ok(result.task?.sid, JSON.stringify(result));
  const launched = await until(() => loadSession(f, result.task.sid).runs.at(-1));
  assert.ok(launched, '后台任务没有启动');
  return {sid:result.task.sid, run:launched};
}

test('默认启用的后台执行在主人持续失联时仍能结束，重起后只按保存的结果记账', async t => {
  const f = await fixture(t,'',{finalization:'default',backoffMs:[50]});
  const {sid, run} = await startBackground(f);
  assert.ok(await until(()=>rows(f.codexLog).length===1&&f.meta(run).childPid));
  const first=f.meta(run), owner=(await f.health()).owner;
  assert.equal(first.finalProtocol,1);
  fs.writeFileSync(f.blockOwner,'');
  process.kill(owner.pid,'SIGKILL');
  fs.writeFileSync(f.codexGo,'');
  const store = (await storeReader()).createFinalizationStore(f.home);
  assert.ok(await until(()=>store.read(first,'ready').state==='valid'), '失联期间应已保存完整结果包');
  const lock = () => spawnSync('flock',['-n',path.join(f.home,'locks',run+'.lock'),'true'],{timeout:1000}).status===0;
  assert.ok(await until(lock), '执行器应在状态进程恢复前释放执行锁');
  assert.equal(f.meta(run).ended,undefined);
  assert.equal(store.read(first,'prepared').data.changes.agentSid,'10000000-0000-0000-0000-000000000001');
  fs.unlinkSync(f.blockOwner);
  const done=await f.settle(run);
  assert.ok(done.events.some(e=>e.t==='done'&&e.ok));
  assert.equal(loadSession(f,sid).agentSid,'10000000-0000-0000-0000-000000000001');
  assert.equal(loadSession(f,sid).status,'done');
  assert.deepEqual(loadSession(f,sid).runs,[run]);
  assert.equal(rows(f.codexLog).length,1);assert.equal(modelStats(f,run).length,1);
  assert.equal(f.meta(run).attempt,first.attempt);
});

for (const phase of ['beforeCommit', 'afterCommit']) test('收尾 SQLite ' + phase + ' 被杀：按同一尝试提交后台结果、状态、统计各一次', async t => {
  const f = await fixture(t, '', {finalization:true, finalizationFault:phase, backoffMs:[2600]});
  const {sid, run} = await startBackground(f);
  fs.writeFileSync(f.codexGo, '');
  const fault = await until(() => fs.existsSync(f.phaseMarker) && readJSON(f.phaseMarker));
  assert.ok(fault, '后台终态未到达提交边界：' + await f.inspect(run));
  const original = f.meta(run), store = (await storeReader()).createFinalizationStore(f.home);
  const prepared = store.read(original, 'prepared'), ready = store.read(original, 'ready');
  assert.equal(prepared.state, 'valid'); assert.equal(ready.data.prepared, prepared.digest);
  const { DatabaseSync } = require('node:sqlite'), readOnly = new DatabaseSync(path.join(f.home, 'workflow.sqlite'), {readOnly:true});
  const id = 'finish:' + run + ':' + original.attempt;
  assert.equal(Boolean(readOnly.prepare('SELECT id FROM commands WHERE id=?').get(id)), phase === 'afterCommit');
  readOnly.close();
  fs.writeFileSync(f.disableWriter, '');
  process.kill(fault.pid, 'SIGKILL');
  const done = await f.settle(run);
  const finalTask = loadSession(f, sid), after = f.meta(run);
  assert.equal(after.attempt, original.attempt);
  assert.equal(finalTask.status, 'done'); assert.equal(finalTask.finishedRun, run); assert.deepEqual(finalTask.runs, [run]);
  assert.equal(after.died, undefined); assert.equal(rows(f.codexLog).length, 1);
  assert.equal(done.events.filter(e=>e.t==='done').length, 1);
  assert.equal(modelStats(f, run).length, 1);
  const report = digest => locked(f, 'run_finalize', {run,digest}, {run,attempt:after.attempt});
  const receipt = await report(ready.digest);
  assert.equal(receipt.digest, ready.digest); assert.equal(receipt.done.ok, true); assert.deepEqual(await report(ready.digest), receipt);
  assert.equal((await report('f'.repeat(64))).error, 'finalization_conflict');
  assert.equal((await locked(f, 'run_finalize', {run,digest:ready.digest}, {run,attempt:'1'.repeat(32)})).error, 'stale_attempt');
  const another = await startBackground(f);
  assert.equal(f.meta(another.run).finalProtocol, undefined, '关闭开关只影响新轮次');
  await f.settle(another.run);
});

test('持久收尾回执送达后丢响应：前台正文、状态和用量各提交一次', async t => {
  const f = await fixture(t, 'after:run_finalize', {finalization:true, backoffMs:[50]});
  const sent = await f.op('send', {main:true, text:'慢慢做', clientId:'finalize-front-0001'});
  const {first, result} = await killAtFault(f, sent.run, 'after', 'run_finalize');
  const done = await f.settle(sent.run);
  assert.equal(first.attempt, f.meta(sent.run).attempt);
  assert.equal(f.modelCalls().length, 1);
  assert.equal(done.events.filter(e=>e.t==='text' && e.text==='做好了').length, 1);
  assert.equal(done.events.filter(e=>e.t==='done' && e.ok).length, 1);
  assert.equal(modelStats(f, sent.run).length, 1);
  assert.equal(result.done.ok, true);
  const usage = loadSession(f, sent.sid).frontUsage;
  assert.ok(usage.total > 0); assert.deepEqual(result.done.usage, usage);
  const outbox=fs.readdirSync(path.join(f.home,'outbox')).map(n=>readJSON(path.join(f.home,'outbox',n)));
  assert.equal(outbox.filter(n=>n.msg.sid===sent.sid).length,1);
});

for (const phase of ['prepared','ready']) test('执行器和主人同时退出：保留 ' + phase + ' 的证据，不重调模型', async t => {
  const f = await fixture(t, '', {finalization:true, finalizationFault:phase, backoffMs:[50]});
  const {sid, run} = await startBackground(f);
  fs.writeFileSync(f.codexGo, '');
  const marker = await until(() => fs.existsSync(f.phaseMarker) && readJSON(f.phaseMarker));
  assert.ok(marker, 'runner 没有写到原子发布之前');
  const first = f.meta(run), owner = (await f.health()).owner.pid;
  assert.equal(marker.pid, first.pid);
  const evidence = fs.readdirSync(finalDir(f,first));
  assert.ok(evidence.includes('prepared'));
  assert.equal(evidence.some(n=>n.startsWith('ready.')&&n.endsWith('.tmp')), phase==='ready');
  process.kill(owner,'SIGKILL'); process.kill(marker.pid,'SIGKILL');
  const done = await f.settle(run);
  assert.equal(f.meta(run).attempt, first.attempt);
  assert.equal(loadSession(f,sid).status, 'failed'); assert.deepEqual(loadSession(f,sid).runs,[run]);
  assert.equal(rows(f.codexLog).length,1);
  assert.equal(done.events.filter(e=>e.t==='done'&&!e.ok).length,1);
  assert.ok(done.events.some(e=>e.t==='err'&&e.text.includes(phase==='ready'?'没有写完':'检查中断')));
  assert.deepEqual(fs.readdirSync(finalDir(f,first)), evidence);
});

function projectFiles(f) {
  fs.mkdirSync(f.project);
  fs.writeFileSync(path.join(f.project,'a.txt'),'old A');
  fs.writeFileSync(path.join(f.project,'b.txt'),'old B');
}

for (const stop of [false,true]) test('持久收尾 ' + (stop ? '停止先提交且不写回项目' : '先完成再停止只获得原回执'), async t => {
  const f = await fixture(t, '', {finalization:true, finalizationFault:stop?'ready':undefined, writeProject:true});
  projectFiles(f);
  const {sid, run} = await startBackground(f,{kind:'code',dir:f.project});
  fs.writeFileSync(f.codexGo,'');
  if (stop) {
    const fault = await until(()=>fs.existsSync(f.phaseMarker)&&readJSON(f.phaseMarker));
    assert.ok(fault);
    assert.equal((await locked(f,'task_stop',{sid})).task.status,'stopping');
    process.kill(fault.pid,'SIGCONT');
  }
  const done = await f.settle(run);
  assert.equal(done.events.filter(e=>e.t==='done').length,1);
  assert.equal(done.events.find(e=>e.t==='done').stopped,stop);
  assert.equal(loadSession(f,sid).status,stop?'stopped':'done');
  assert.equal((await locked(f,'task_stop',{sid})).already,true);
  assert.equal(fs.readFileSync(path.join(f.project,'a.txt'),'utf8'),stop?'old A':'new A');
  assert.equal(rows(f.codexLog).length,1);
});

for (const conflict of [false,true]) test('持久收尾项目写回中途重启，' + (conflict?'保留外部修改并等待批准':'同一发布补齐未写完的文件'), async t => {
  const f = await fixture(t, '', {finalization:true, finalizationFault:'project', writeProject:true, backoffMs:[600]});
  projectFiles(f);
  const {sid, run} = await startBackground(f,{kind:'code',dir:f.project});
  fs.writeFileSync(f.codexGo,'');
  const fault = await until(()=>fs.existsSync(f.phaseMarker)&&readJSON(f.phaseMarker));
  assert.ok(fault,'未到同一发布的文件写回边界');
  const old = f.meta(run), other = path.join(f.project,path.basename(fault.file)==='a.txt'?'b.txt':'a.txt');
  assert.match(fs.readFileSync(fault.file,'utf8'),/^new /);
  assert.match(fs.readFileSync(other,'utf8'),/^old /);
  const store = (await storeReader()).createFinalizationStore(f.home);
  assert.equal(store.read(old,'intent').state,'valid');
  assert.equal(store.read(old,'effects').state,'missing');
  if(conflict)fs.writeFileSync(other,'new external content');
  process.kill(fault.pid,'SIGKILL');
  const done = await f.settle(run), task = loadSession(f,sid), effects = store.read(old,'effects');
  assert.equal(f.meta(run).attempt,old.attempt);
  assert.equal(rows(f.codexLog).length,1);
  assert.equal(done.events.filter(e=>e.t==='done').length,1);
  assert.equal(effects.state,'valid');
  assert.equal(fs.readdirSync(path.join(f.home,'backups')).filter(name=>name.startsWith('task-')).length,1);
  if (conflict) {
    assert.equal(task.status,'waiting'); assert.deepEqual(task.publication.conflicts,[path.basename(other)]);
    assert.equal(fs.readFileSync(other,'utf8'),'new external content');
  } else {
    assert.equal(task.status,'done'); assert.equal(task.publicationReceipt.files,2);
    assert.equal(fs.readFileSync(path.join(f.project,'a.txt'),'utf8'),'new A');
    assert.equal(fs.readFileSync(path.join(f.project,'b.txt'),'utf8'),'new B');
    assert.equal(fs.readFileSync(path.join(task.publicationReceipt.backup,'originals','a.txt'),'utf8'),'old A');
  }
});

test('收尾包固定身份和摘要，拒绝换版本、错误目标、改写和非私有文件', async t => {
  const { createFinalizationStore, finalizationEvidence } = await storeReader();
  const base = fs.mkdtempSync(path.join(os.tmpdir(),'xin-finalization-format-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const store=createFinalizationStore(base), meta={run:'rrun00001',sid:'ssession001',attempt:'1'.repeat(32),finalProtocol:1};
  const data={at:Date.now(),code:0,ok:true,timeout:false,transient:false,changes:{},usage:null,ms:65,recordStats:false,reply:'完成'};
  const dir=path.join(base,'finalization',meta.run+'.'+meta.attempt);
  const file=path.join(dir,'prepared'), crypto=require('node:crypto');
  const first=store.write(meta,'prepared',data);
  assert.equal(fs.statSync(dir).mode&0o777,0o700);assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.deepEqual(store.write(meta,'prepared',{...data}),first);
  assert.throws(()=>store.write(meta,'prepared',{...data,code:1}),{code:'finalization_conflict'});
  assert.throws(()=>store.write(meta,'prepared',{...data,changes:{cookie:'synthetic'}}),{code:'finalization_invalid'});
  assert.equal(store.read({...meta,sid:'sanotherid'},'prepared').state,'invalid');
  assert.equal(finalizationEvidence(store,{...meta,attempt:'2'.repeat(32)}),null);
  const envelope=JSON.parse(fs.readFileSync(file,'utf8').slice(65));
  const body=JSON.stringify({...envelope,v:2});
  fs.writeFileSync(file,crypto.createHash('sha256').update(body).digest('hex')+'\n'+body);
  assert.equal(finalizationEvidence(store,meta).reason,'invalid');
  fs.writeFileSync(file,Buffer.alloc(1024*1024+1));
  assert.equal(store.read(meta,'prepared').state,'invalid');
  fs.unlinkSync(file);fs.symlinkSync(path.join(base,'never-read'),file);
  assert.equal(store.read(meta,'prepared').state,'invalid');
  store.forget([meta.run]);assert.equal(fs.existsSync(dir),false);
});
