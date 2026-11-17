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

async function fixture(t, fault, { gateRunner = false, startupFault = false, backoffMs = [3000] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-report-recovery-')), home = path.join(dir, 'xin'), work = path.join(dir, 'work'), bin = path.join(dir, 'bin');
  for (const folder of [bin, work, path.join(work, 'uploads'), path.join(home, 'agent'), path.join(home, 'runs'), path.join(home, 'sessions'), path.join(dir, 'user')]) fs.mkdirSync(folder, { recursive: true });
  for (const name of ['claude', 'agy', 'dsh']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const codexLog = path.join(dir, 'codex.jsonl'), codexGo = path.join(dir, 'codex-go'), runnerGo = path.join(dir, 'runner-go');
  fs.writeFileSync(path.join(bin, 'codex'), '#!' + process.execPath + '\n' + `
const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(codexLog)},JSON.stringify(process.argv.slice(2))+'\\n');
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(codexGo)})){clearInterval(timer);console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'图片测试完成'}}));}},20);
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
require(${JSON.stringify(FRONT)});
`);
  const env = { ...process.env, XIN_HOME: home, XIN_WORK: work, XIN_DSH: path.join(bin, 'dsh'), XIN_AGY_HOME: path.join(dir, 'user'), XIN_ANTIGRAVITY_BIN: '',
    XIN_FRONT_PROVIDER: 'deepseek', XIN_FRONT_TEST_DELAY: '1500', XIN_FRONT_TEST_TEXT: '做好了', XIN_FRONT_TEST_LOG: path.join(dir, 'front.jsonl'),
    XIN_STATE_TEST_FAULT: fault, XIN_RUN_ATTEMPTS: '1', XIN_CODEX_TRANSPORT: 'exec', XIN_TASK_SANDBOX: '0', XIN_CODEX_KEY: 'synthetic-test-key',
    CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), NODE_OPTIONS: '--require=' + preload, PATH: bin + ':' + process.env.PATH };
  for (const name of fs.readdirSync(SOURCE).filter(n => /^vm-.*\.mjs$/.test(n))) fs.copyFileSync(path.join(SOURCE, name), path.join(home, 'agent', name));
  installStateSocketFault(path.join(home, 'agent'));
  const agent = path.join(home, 'agent', 'vm-agent-0123456789ab.mjs'); fs.copyFileSync(path.join(SOURCE, 'vm-agent.mjs'), agent);
  fs.writeFileSync(path.join(home, 'kernel-keys.json'), JSON.stringify({ v: 1, keys: { ka: KEY } }), { mode: 0o600 });
  const K = await import(pathToFileURL(path.join(SOURCE, 'vm-kernel.mjs')).href), W = await import(pathToFileURL(path.join(__dirname, '../src/xin-kernel.js')).href);
  const k = await K.createKernel({ home, env, keeper: { backoffMs } });
  t.after(async () => { await k.close().catch(() => {}); await stopOwned(home, dir, platformTimeout(10000)); });
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
  return { dir, home, work, env, op, health, running, meta, inspect, settle, codexLog, codexGo, runnerGo, modelCalls: () => rows(path.join(dir, 'front.jsonl')) };
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
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  };
  assert.ok(await until(() => !running(), platformTimeout(3000)), '不可重试错误之后 runner 仍被辅助定时器挂住');
  const lock = spawnSync('flock', ['-n', '--conflict-exit-code', '73', path.join(f.home, 'locks', sent.run + '.lock'), 'true'], { timeout: 1000 });
  assert.equal(lock.status, 0, 'runner 退出必须释放生命周期锁');
  assert.equal(f.modelCalls().length, 0, '协议拒绝之后不启动模型');
  assert.equal(f.meta(sent.run).ended, undefined, '未得到模型结果，不伪造成功收尾');
});
