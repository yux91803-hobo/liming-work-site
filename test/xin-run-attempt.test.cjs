const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process'), { pathToFileURL } = require('node:url');
const { stateMode } = require('./helpers/state-mode.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
const url = name => pathToFileURL(path.join(__dirname, '../site/xin/' + name + '.mjs')).href;
const RUN = 'rattempt001', SID = 'sattempt001', OLD = '1'.repeat(32), CURRENT = '2'.repeat(32);

function fixture(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-attempt-')), home = path.join(dir, 'xin'), bin = path.join(dir, 'bin');
  for (const d of [bin, home, home + '/runs', home + '/sessions']) fs.mkdirSync(d);
  for (const name of ['codex', 'claude', 'agy', 'dsh']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, XIN_HOME: home, XIN_WORK: path.join(dir, 'work'), XIN_DSH: path.join(bin, 'dsh'),
    XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', XIN_FRONT_PROVIDER: 'deepseek', CODEX_HOME: path.join(dir, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), PATH: bin + ':' + process.env.PATH };
  const meta = { run: RUN, sid: SID, agent: 'codex', started: Date.now(), attempt: CURRENT };
  fs.writeFileSync(home + '/runs/' + RUN + '.json', JSON.stringify(meta));
  fs.writeFileSync(home + '/runs/' + RUN + '.jsonl', JSON.stringify({ t: 'user', text: '先看波形，再看寄存器' }) + '\n');
  fs.writeFileSync(home + '/sessions/' + SID + '.json', JSON.stringify({ sid: SID, agent: 'codex', runs: [RUN], title: '尝试隔离', created: Date.now() }));
  const owner = mode === 'kernel' ? stateMode(t, env) : null;
  t.after(() => stopOwned(home, dir));
  const cli = (op, args = {}, extra = {}) => {
    const r = spawnSync(process.execPath, [AGENT, ...op], { env: { ...env, ...extra }, input: JSON.stringify(args), encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const report = (op, args, attempt = CURRENT, run = RUN) => cli(['locked', op], args, { XIN_LOCK: SID, XIN_RUN: run, XIN_ATTEMPT: attempt });
  const js = (source, attempt = CURRENT) => spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...env, XIN_RUN: RUN, XIN_ATTEMPT: attempt }, encoding: 'utf8', timeout: 15000
  });
  return { dir, home, env, owner, cli, report, js, meta: () => JSON.parse(fs.readFileSync(home + '/runs/' + RUN + '.json')) };
}

for (const mode of ['legacy', 'kernel']) {
  test(mode + '：旧尝试、漏带编号、冒用另一轮的报告不能更新 run；当前尝试可用', t => {
    const f = fixture(t, mode);
    for (const [token, run] of [[OLD, RUN], ['', RUN], [CURRENT, 'rattempt002'], [CURRENT, '']]) {
      const r = f.report('run_patch', { run: RUN, changes: { compileTrusted: true } }, token, run);
      assert.equal(r.error, 'stale_attempt', JSON.stringify(r));
      assert.equal(f.meta().compileTrusted, undefined);
      assert.ok(!JSON.stringify(r).includes(CURRENT), '错误不得回显编号');
    }
    assert.equal(f.report('run_patch', { run: RUN, changes: { compileTrusted: true } }).meta.compileTrusted, true);
    assert.equal(f.report('session_patch', { sid: SID, changes: { agentSid: 'new-thread' } }, OLD).error, 'stale_attempt');
    assert.equal(f.report('session_patch', { sid: SID, changes: { agentSid: 'new-thread' } }).session.agentSid, 'new-thread');
    assert.equal(f.report('run_complete', { run: RUN, done: { t: 'done', ok: true } }, OLD).error, 'stale_attempt');
    assert.equal(f.meta().ended, undefined);
    assert.equal(fs.readFileSync(f.home + '/runs/' + RUN + '.jsonl', 'utf8').includes('"t":"done"'), false);
    // 网页上的可信停止仍走公共入口，不需要伪造 runner 身份。
    assert.equal(f.cli(['stop'], { run: RUN }).ok, true);
    assert.equal(f.meta().stopped, true);
  });

  test(mode + '：具名记忆、单次写入和 xin 工具沿用启动身份，过期尝试没有副作用', t => {
    const f = fixture(t, mode);
    const code = `import {BASE,writeJ} from ${JSON.stringify(url('vm-base'))};
      import {addMemory,listMemory} from ${JSON.stringify(url('vm-memory'))};
      const out=[];for(const action of [()=>writeJ(BASE+'/attempt-marker.json',{bad:true}),()=>addMemory({content:'先看波形',source:'user'})]){
        try{const r=action();out.push(r?.error||'allowed');}catch(e){out.push(e.code);}}
      console.log(JSON.stringify(out));`;
    const denied = f.js(code, OLD); assert.equal(denied.status, 0, denied.stderr);
    assert.deepEqual(JSON.parse(denied.stdout), ['stale_attempt', 'stale_attempt']);
    assert.equal(fs.existsSync(f.home + '/attempt-marker.json'), false);
    assert.equal(f.cli(['memory_list']).items.length, 0);
    const r = spawnSync(process.execPath, [AGENT, 'xin', 'remember', '--basis', 'stated', '先看波形，再看寄存器'], {
      env: { ...f.env, XIN_RUN: RUN, XIN_ATTEMPT: OLD }, encoding: 'utf8', timeout: 15000
    });
    assert.equal(r.status, 1); assert.doesNotMatch(r.stdout + r.stderr, new RegExp(OLD));
    assert.equal(f.cli(['memory_list']).items.length, 0);
    const accepted = f.js(code); assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(fs.existsSync(f.home + '/attempt-marker.json'), true);
    assert.equal(f.cli(['memory_list']).items.length, 1);
  });
}

test('关闭新编号分配时仍隔离已有编号；无编号旧 runner 可继续报告', async t => {
  const attempts = await import(url('vm-run-attempt'));
  assert.equal(attempts.attemptsEnabled({ XIN_RUN_ATTEMPTS: '0' }), false);
  assert.equal(attempts.attemptsEnabled({ XIN_RUN_ATTEMPTS: '1' }), true);
  assert.equal(attempts.nextAttempt({}), null, '不能给旧轮次的重新派发补协议');
  assert.match(attempts.nextAttempt({ attempt: CURRENT }), /^[a-f0-9]{32}$/);
  assert.match(attempts.nextAttempt({ attemptProtocol: 1 }), /^[a-f0-9]{32}$/);
  const f = fixture(t, 'kernel');
  assert.equal(f.report('run_patch', { run: RUN, changes: { died: true } }, OLD).error, 'stale_attempt');
  const legacy = 'rlegacy001';
  fs.writeFileSync(f.home + '/runs/' + legacy + '.json', JSON.stringify({ run: legacy, sid: SID, agent: 'codex', started: Date.now() }));
  assert.equal(f.report('run_patch', { run: legacy, changes: { died: true } }, '', legacy).meta.died, true);
});

test('接收端直接核对身份：过期报告绕过客户端也不能追加事件、具名写入或执行 xin', async t => {
  const f = fixture(t, 'kernel'), { requestState } = await import(url('vm-kernel-client'));
  const before = fs.readFileSync(f.home + '/runs/' + RUN + '.jsonl', 'utf8');
  for (const q of [
    { kind: 'named', name: 'memory.add', args: [{ content: '不该写入', source: 'user' }] },
    { kind: 'write', name: 'attempt-marker.json', body: '{"bad":true}' },
    { kind: 'append', name: 'runs/' + RUN + '.jsonl', event: { t: 'done', ok: true } },
    { kind: 'xin', argv: ['remember', '--basis', 'stated', '先看波形'] }
  ]) assert.equal((await requestState(f.home, { ...q, run: RUN, attempt: OLD })).error, 'stale_attempt');
  assert.equal(fs.readFileSync(f.home + '/runs/' + RUN + '.jsonl', 'utf8'), before);
  assert.equal(fs.existsSync(f.home + '/attempt-marker.json'), false);
  assert.equal(f.cli(['memory_list']).items.length, 0);
});

test('SQLite 已提交新编号但尚未投影时，旧编号也不能在提交锁内写入', t => {
  const f=fixture(t,'legacy');
  const r=f.js(`import {BASE,journal,writeJ} from ${JSON.stringify(url('vm-base'))};
    journal.writing(()=>journal.db.prepare('INSERT INTO documents(name,body,dirty) VALUES(?,?,1)').run('runs/${RUN}.json',JSON.stringify({run:'${RUN}',sid:'${SID}',attempt:'${OLD}'})));
    let result;try{writeJ(BASE+'/forbidden.json',{bad:true});result='allowed';}catch(e){result=e.code;}
    console.log(JSON.stringify(result));`);
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout),'stale_attempt');
  assert.equal(fs.existsSync(f.home+'/forbidden.json'),false);
  assert.equal(f.meta().attempt,CURRENT,'此刻投影仍旧，不能拿投影代替数据库判定');
});

for(const committed of [false,true])test('派发尝试在'+(committed?'提交后投影前':'提交前')+'崩溃：编号和派发计数一起恢复，不先启动执行器',t=>{
  const f=fixture(t,'legacy'),run='rdispatch001',sentinel=path.join(f.dir,'executed'),self=path.join(f.dir,'executor.mjs');
  fs.writeFileSync(self,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(sentinel)},'unexpected');`);
  const code=`import {BASE,journal,writeJ,readJ} from ${JSON.stringify(url('vm-base'))};
    import {createDispatcher} from ${JSON.stringify(url('vm-dispatch'))};
    const metaF=r=>BASE+'/runs/'+r+'.json';
    journal.atomic(()=>{writeJ(metaF('${run}'),{run:'${run}',sid:'${SID}',agent:'codex',started:Date.now(),attemptProtocol:1});journal.enqueueLaunch('${run}','${SID}');});
    ${committed?"journal.recover=()=>process.kill(process.pid,'SIGKILL');":"journal.checkWriter=transaction=>{if(transaction)process.kill(process.pid,'SIGKILL');};"}
    const dispatcher=createDispatcher({self:${JSON.stringify(self)},metaF,sessF:s=>BASE+'/sessions/'+s+'.json',runF:r=>BASE+'/runs/'+r+'.jsonl',lockedCall:()=>({}),emit:()=>{},patchRun:()=>{}});
    dispatcher.dispatchLaunches();`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:f.env,encoding:'utf8',timeout:10000});
  assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(fs.existsSync(sentinel),false);
  const recovered=spawnSync(process.execPath,['--input-type=module','-e',`import {BASE,journal,readJ} from ${JSON.stringify(url('vm-base'))};journal.recover();console.log(JSON.stringify({meta:readJ(BASE+'/runs/${run}.json'),launch:journal.launchRecord('${run}')}));`],{env:f.env,encoding:'utf8',timeout:10000});
  assert.equal(recovered.status,0,recovered.stderr);const data=JSON.parse(recovered.stdout);
  assert.equal(data.launch.state,committed?'dispatched':'pending');assert.equal(data.launch.attempts,committed?1:0);
  if(committed)assert.match(data.meta.attempt,/^[a-f0-9]{32}$/);else assert.equal(data.meta.attempt,undefined);
  assert.equal(data.meta.pid,committed?null:undefined);assert.equal(fs.existsSync(sentinel),false);
});

// 旧模式每个请求一个进程：任务一轮做完时，执行进程在收尾里派下一轮，同一刻网页（或测试）来查的进程也在派发，
// 两个都读到同一条待派发。2026-11-17 #161 正式运行的单元测试：后一个写的新编号盖掉前一个，前一个执行进程对不上编号退出，
// 后一个拿不到锁也退出，这一轮没人做，15 秒后被当成中途断了、多起一轮（本地加压 60 次里复现 2 次，日志里两次派发相隔 7 毫秒）
test('两个进程同时读到同一条待派发：只有认领到的那个起执行进程，编号不被后来的覆盖',t=>{
  const f=fixture(t,'legacy'),run='rdispatch002',sid='sdispatch002',record=path.join(f.dir,'executed.jsonl'),self=path.join(f.dir,'executor.mjs');
  fs.writeFileSync(self,`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(record)},JSON.stringify({run:process.argv[3],attempt:process.env.XIN_ATTEMPT})+'\\n');`);
  const code=`import fs from 'node:fs';
    import {BASE,journal,writeJ,readJ,alive} from ${JSON.stringify(url('vm-base'))};
    import {createDispatcher} from ${JSON.stringify(url('vm-dispatch'))};
    const metaF=r=>BASE+'/runs/'+r+'.json';
    journal.atomic(()=>{writeJ(metaF('${run}'),{run:'${run}',sid:'${sid}',agent:'codex',started:Date.now(),attemptProtocol:1});journal.enqueueLaunch('${run}','${sid}');});
    const dispatcher=createDispatcher({self:${JSON.stringify(self)},metaF,sessF:s=>BASE+'/sessions/'+s+'.json',runF:r=>BASE+'/runs/'+r+'.jsonl',lockedCall:()=>({}),emit:()=>{},patchRun:()=>{}});
    // 另一个进程在第一个认领之前读到的样子：同一条还是待派发
    const stale=journal.pendingLaunches();
    dispatcher.dispatchLaunches();
    const launcher=()=>readJ(metaF('${run}')).launcher;
    for(const end=performance.now()+10000;performance.now()<end&&!(fs.existsSync(${JSON.stringify(record)})&&launcher()&&!alive(launcher().pid,launcher().identity));)await new Promise(r=>setTimeout(r,20));
    journal.pendingLaunches=()=>stale;
    dispatcher.dispatchLaunches();
    await new Promise(r=>setTimeout(r,800));
    console.log(JSON.stringify({meta:readJ(metaF('${run}')),launch:journal.launchRecord('${run}')}));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:f.env,encoding:'utf8',timeout:20000});
  assert.equal(child.status,0,child.stderr);
  const data=JSON.parse(child.stdout.trim().split('\n').pop()),started=fs.readFileSync(record,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(started.length,1,'同一条只起一个执行进程：'+JSON.stringify(started));
  assert.equal(data.meta.attempt,started[0].attempt,'执行进程拿到的编号就是记录里的，没被后来的覆盖');
  assert.equal(data.launch.state,'dispatched');assert.equal(data.launch.attempts,1);
});

test('损坏的权威元数据拒绝写入，解析错误不夹带 Cookie 或正文片段',t=>{
  const f=fixture(t,'legacy');
  const r=f.js(`import {BASE,journal,writeJ} from ${JSON.stringify(url('vm-base'))};
    journal.writing(()=>journal.db.prepare('INSERT INTO documents(name,body,dirty) VALUES(?,?,1)').run('runs/${RUN}.json','SENSITIVE_COOKIE_TEST_VALUE'));
    try{writeJ(BASE+'/forbidden.json',{bad:true});console.log('allowed');}catch(e){console.log(JSON.stringify({code:e.code,message:e.message}));}`);
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).code,'invalid_run_state');
  assert.doesNotMatch(r.stdout+r.stderr,/SENSITIVE|COOKIE_TEST/);assert.equal(fs.existsSync(f.home+'/forbidden.json'),false);
});
