// 运行中插话两阶段交付、AGY 原生动作回执与前台额度报告失联容错（docs/superpowers/plans/2026-11-16-xin-finalization.md §2、§4）：
// 用复制的真实状态进程和假执行器，在临时目录注入真实套接字断线与主人 SIGKILL/重启，不调外部模型或正式站。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process'), { pathToFileURL } = require('node:url');
const { lockedSpawn } = require('./helpers/locked.cjs');
const { stateMode } = require('./helpers/state-mode.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { fakeAgy, fakeCodex } = require('./helpers/fake-agy.cjs');
const { installStateSocketFault, stateSocketFault, stateSocketFaultFile } = require('./helpers/state-socket-fault.cjs');

const SOURCE = path.join(__dirname, '../site/xin');
const url = name => pathToFileURL(path.join(SOURCE, name + '.mjs')).href;

function agyFaultFixture(t, script, faultRule, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-steer-delivery-'));
  const home = path.join(root, 'xin'), bin = path.join(root, 'bin'), profile = path.join(root, 'profile');
  const agentDir = path.join(root, 'agent'), agent = path.join(agentDir, 'vm-agent.mjs');
  for (const dir of [home + '/sessions', home + '/runs', home + '/run', bin, profile, agentDir]) fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(SOURCE).filter(n => /^vm-.*\.mjs$/.test(n))) fs.copyFileSync(path.join(SOURCE, name), path.join(agentDir, name));
  installStateSocketFault(agentDir);
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, 'require("node:os").homedir=()=>' + JSON.stringify(profile) + ';require("node:module").syncBuiltinESMExports();');
  fs.writeFileSync(path.join(root, 'script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(bin, 'agy'), fakeAgy(root), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), fakeCodex(root), { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, NODE_OPTIONS: '--require=' + preload,
    XIN_HOME: home, XIN_WORK: path.join(root, 'work'), CODEX_HOME: path.join(profile, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(profile, '.claude'), XIN_AGY_HOME: profile,
    XIN_ANTIGRAVITY_BIN: path.join(bin, 'agy'), XIN_CODEX_TRANSPORT: 'exec', XIN_TASK_SANDBOX: '0',
    XIN_SYSTEMD_BUS: path.join(root, 'no-systemd-bus'), XIN_AGY_IDLE_MS: '60000',
    XIN_NOTE_WAIT_MS: '600000', ...(faultRule ? { XIN_STATE_TEST_FAULT: faultRule } : {}), ...extra };
  t.after(() => stopOwned(home, root));
  const startOwner = (override = {}) => stateMode(t, { ...env, ...override }, { agent });
  let owner = startOwner();
  const call = (name, args = {}) => {
    const r = lockedSpawn(agent, name, args, { env, encoding: 'utf8', timeout: platformTimeout(20000) });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const lines = file => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  const until = async (fn, what, ms = 15000) => {
    for (const end = performance.now() + platformTimeout(ms); performance.now() < end;) {
      const value = fn(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('等不到：' + what);
  };
  return { root, home, env, agent, get owner() { return owner; }, set owner(v) { owner = v; }, startOwner, call, read, lines, until };
}

test('steer_take 已提交但回包前主人被杀：执行器按同一批次重取，补充不丢且只送进模型一次、过程事件只记一条', async t => {
  const f = agyFaultFixture(t, [
    { action: 'shell', command: 'echo step-one >> list.txt', gate: true },
    { action: 'final', text: '按补充只留启用的：alpha-main' }
  ], 'after:steer_take');
  // 先挡住第一步之前的空取件，等站长补充写入后再打开故障门
  const marker = stateSocketFaultFile(f.home);
  fs.writeFileSync(marker, '{"armed":false}');
  const task = f.call('task_new', { kind: 'research', goal: '核对 alpha-main 与 beta-backup' }).task;
  await f.until(() => fs.existsSync(path.join(f.root, 'at-1')), '第一步请求已发出');
  const said = '刚才那件事，备用的别列，只列实际启用的';
  const told = f.call('task_tell', { sid: task.sid, text: said, clientId: 'steer-take-drop-01' });
  assert.equal(told.delivery, 'now');
  fs.unlinkSync(marker);
  fs.writeFileSync(path.join(f.root, 'go-1'), '');

  const fault = await f.until(() => stateSocketFault(f.home), 'steer_take 提交后的故障门');
  assert.equal(fault.phase, 'after');
  assert.equal(fault.op, 'steer_take');
  assert.equal(fault.result?.steers?.length, 1);
  assert.equal(fault.result.steers[0].text, said);
  // 提交后但尚未收到消费回执前，磁盘上的补充仍是 pending（兼容回退到旧版时也不会当成已消费丢掉）
  const runBeforeAck = f.read(path.join(f.home, 'runs', fault.run + '.json'));
  assert.equal(runBeforeAck.steers[0].state, 'pending', '仅认领尚未确认消费前保持 pending');

  f.owner.child.kill('SIGKILL'); await f.owner.exited;
  f.owner = f.startOwner({ XIN_STATE_TEST_FAULT: '' });

  const h = await f.until(() => {
    f.call('tasks', { all: true });
    const cur = f.call('history', { sid: task.sid });
    return ['done', 'failed'].includes(cur.task.status) && cur;
  }, '任务在主人重启后完成');
  assert.equal(h.task.status, 'done', JSON.stringify(h.task));
  assert.equal(h.runs.length, 1, '同一轮已消费补充并正常收尾，不重复再开第二轮');
  const calls = f.lines(path.join(f.root, 'calls.jsonl'));
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].prompt.includes(said));
  assert.equal(calls[1].prompt.split(said).length - 1, 1, '重取同一批次只送进模型一次');
  assert.equal(h.runs[0].events.filter(e => e.t === 'user' && e.steer).length, 1, '过程里的兄弟插话只记一次');
  const runAfter = f.read(path.join(f.home, 'runs', fault.run + '.json'));
  assert.deepEqual(runAfter.steers.map(x => [x.text, x.state]), [[said, 'accepted']]);
  const normalPrepared = JSON.parse(fs.readFileSync(path.join(f.home, 'finalization', fault.run + '.' + runAfter.attempt, 'prepared'), 'utf8').split('\n')[1]);
  assert.equal(Object.hasOwn(normalPrepared.data, 'ackedSteers'), false, '已在线确认消费的常规轮次不加新字段，兼容回滚');
});

test('两阶段取件契约：同批次重取不吞新来的补充；未确认时随正常或异常收尾保留；旧尝试不得认领或确认新尝试的补充', async () => {
  const { createSteerOps } = await import(url('vm-steer'));
  const { withCallContext, callContext } = await import(url('vm-kernel-context'));
  const { attemptError } = await import(url('vm-run-attempt'));
  const store = new Map(), events = [];
  const metaF = r => 'runs/' + r + '.json', sessF = s => 'sessions/' + s + '.json';
  store.set(sessF('stask001'), { sid: 'stask001', kind: 'task', status: 'running', runs: ['rrun0001'] });
  store.set(metaF('rrun0001'), {
    run: 'rrun0001', sid: 'stask001', task: true, attemptProtocol: 1, attempt: 'a'.repeat(32),
    steers: [{ id: 's-1', text: '第一条补充', at: 10, state: 'pending' }]
  });
  const ops = createSteerOps({
    metaF, sessF, isTask: s => s?.kind === 'task', lastRun: s => s?.runs?.at(-1),
    readJ: k => structuredClone(store.get(k) || null), writeJ: (k, v) => store.set(k, structuredClone(v)),
    emit: (run, ev) => events.push({ run, ev }), okId: s => typeof s === 'string' && s.length > 4,
    cut: s => String(s || ''), callContext
  });
  // 旧尝试被 attemptError 拦住
  assert.equal(attemptError(store.get(metaF('rrun0001')), { run: 'rrun0001', attempt: 'b'.repeat(32) })?.error, 'stale_attempt');

  // 当前尝试认领第一批
  const first = withCallContext({ locked: true, key: 'tasks', run: 'rrun0001', attempt: 'a'.repeat(32) }, () =>
    ops.steerTake({ run: 'rrun0001', claim: 'agy-steer-0' }));
  assert.deepEqual(first.steers.map(x => x.id), ['s-1']);
  assert.equal(store.get(metaF('rrun0001')).steers[0].state, 'pending', '认领阶段不提前标 accepted');
  assert.equal(events.length, 1, '首次认领记一条过程事件');

  // 丢回包期间又来了第二条补充；用原批次重取只拿回原批次，且不重复记过程事件
  const m1 = store.get(metaF('rrun0001'));
  m1.steers.push({ id: 's-2', text: '第二条补充', at: 20, state: 'pending' });
  store.set(metaF('rrun0001'), m1);
  const replay = withCallContext({ locked: true, key: 'tasks', run: 'rrun0001', attempt: 'a'.repeat(32) }, () =>
    ops.steerTake({ run: 'rrun0001', claim: 'agy-steer-0' }));
  assert.deepEqual(replay.steers.map(x => x.id), ['s-1'], '同批次重取不混入后到的第二条');
  assert.equal(events.length, 1, '重取不重复记过程事件');

  const second = withCallContext({ locked: true, key: 'tasks', run: 'rrun0001', attempt: 'a'.repeat(32) }, () =>
    ops.steerTake({ run: 'rrun0001', claim: 'agy-steer-1' }));
  assert.deepEqual(second.steers.map(x => x.id), ['s-2'], '新批次只可认领未被认领的补充');

  // 模型步完成后确认第一批：只有 s-1 变 accepted，s-2 仍保持 pending 等下一步（或收尾带入下一轮）
  withCallContext({ locked: true, key: 'tasks', run: 'rrun0001', attempt: 'a'.repeat(32) }, () =>
    ops.steerAck({ run: 'rrun0001', claim: 'agy-steer-0', state: 'accepted' }));
  assert.deepEqual(store.get(metaF('rrun0001')).steers.map(x => [x.id, x.state]), [['s-1', 'accepted'], ['s-2', 'pending']]);
  assert.equal(events.length, 2, '确认消费不重复显示插话');
  const lateRetry = withCallContext({ locked:true, key:'tasks', run:'rrun0001', attempt:'a'.repeat(32) }, () =>
    ops.steerTake({run:'rrun0001', claim:'agy-steer-0'}));
  assert.deepEqual(lateRetry.steers, [], '确认过的批次重送不取走新输入');

  // 下一步认领 s-2，但模型步在确认前结束/崩溃：s-2 仍是 pending，旧版或新版 taskFinish 都会按 pending 带去下一轮
  const again = withCallContext({ locked: true, key: 'tasks', run: 'rrun0001', attempt: 'a'.repeat(32) }, () =>
    ops.steerTake({ run: 'rrun0001', claim: 'agy-steer-1' }));
  assert.deepEqual(again.steers.map(x => x.id), ['s-2']);
  assert.equal(store.get(metaF('rrun0001')).steers[1].state, 'pending');
});

test('AGY 原生动作重试使用同一编号，继续任务或在同一轮换模型时使用新编号', async () => {
  const {createExecutorSteerBridge} = await import(url('vm-steer'));
  const calls = [];
  const lockedCall = (_key, op, args) => { calls.push({op, ...args}); return {ok:true, msg:'已记下'}; };
  const first = createExecutorSteerBridge({run:'rrun0001', sid:'stask001', model:'gemini-4-hydrogen', lockedCall});
  const switched = createExecutorSteerBridge({run:'rrun0001', sid:'stask001', model:'gemini-4-argon', lockedCall});
  const resumed = createExecutorSteerBridge({run:'rrun0002', sid:'stask001', model:'gemini-4-hydrogen', lockedCall});
  for (const bridge of [first, first, switched, resumed]) {
    bridge.note('新发现', 'agy-note-0');
    bridge.ask('需要确认什么？', 'agy-ask-1');
  }
  for (const op of ['task_note', 'task_ask']) {
    const reports = calls.filter(x => x.op === op);
    assert.equal(typeof reports[0].id, 'string');
    assert.equal(reports[0].id, reports[1].id);
    assert.equal(new Set(reports.map(x => x.id)).size, 3);
    assert.deepEqual(reports.map(x => x.run), ['rrun0001','rrun0001','rrun0001','rrun0002']);
  }
});

test('AGY 原生 note 与 ask 回包前主人被杀：按步编号重送只记一次并拿到原回执；持续失联时如实告知模型而不伪造已记下', async t => {
  const convSid = 'sconvnote12345';
  const f = agyFaultFixture(t, [
    { action: 'note', text: '两份配置写的默认模型不一样，我先核一下' },
    { action: 'ask', question: '', text: '要保留旧配置还是只留新的？' }
  ], 'after:task_note');
  fs.writeFileSync(path.join(f.home, 'sessions', convSid + '.json'), JSON.stringify({ sid: convSid, agent: 'codex', title: '核对配置', runs: [], created: Date.now(), updated: Date.now() }));
  const task = f.call('task_new', { kind: 'research', goal: '查配置出入', parent: convSid }).task;

  const fault = await f.until(() => stateSocketFault(f.home), 'task_note 提交后的故障门');
  assert.equal(fault.phase, 'after');
  assert.equal(fault.op, 'task_note');
  f.owner.child.kill('SIGKILL'); await f.owner.exited;
  // 重启后把故障切到 after:task_ask，顺便验证原生 ask 丢回包也能恢复
  fs.unlinkSync(stateSocketFaultFile(f.home));
  f.owner = f.startOwner({ XIN_STATE_TEST_FAULT: 'after:task_ask' });

  const askFault = await f.until(() => stateSocketFault(f.home), 'task_ask 提交后的故障门');
  assert.equal(askFault.phase, 'after');
  assert.equal(askFault.op, 'task_ask');
  f.owner.child.kill('SIGKILL'); await f.owner.exited;
  f.owner = f.startOwner({ XIN_STATE_TEST_FAULT: '' });

  const h = await f.until(() => {
    f.call('tasks', { all: true });
    const cur = f.call('history', { sid: task.sid });
    return ['waiting', 'done', 'failed'].includes(cur.task.status) && cur;
  }, '任务进入等你确认');
  assert.equal(h.task.status, 'waiting', JSON.stringify(h.task));
  assert.equal(h.task.question, '要保留旧配置还是只留新的？');
  const calls = f.lines(path.join(f.root, 'calls.jsonl'));
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /^记下了，过一会儿回原聊天告诉兄弟/, '重送后模型仍收到真实转告回执');
  const saved = f.read(path.join(f.home, 'sessions', task.sid + '.json'));
  assert.equal(saved.noteIds.length, 1, 'note 去重只记一次');
  assert.equal(saved.notesSent, 1, '主动说计数只加一次');
  assert.equal(h.runs[0].events.filter(e => e.t === 'note').length, 1, '过程里的 note 事件只有一条');

  // 持续失联时：note 回调返回空/抛错，antigravityWork 不得对模型谎称「已记下。」
  const { antigravityWork } = await import(url('vm-runtime'));
  const downRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-note-down-'));
  t.after(() => fs.rmSync(downRoot, { recursive: true, force: true }));
  for (const d of ['work', 'tmp', 'io', 'client']) fs.mkdirSync(path.join(downRoot, d));
  fs.writeFileSync(path.join(downRoot, 'script.json'), JSON.stringify([
    { action: 'note', text: '这条在主人失联时发不出去' },
    { action: 'final', text: '重要结论直接写进最终结果' }
  ]));
  const bin = path.join(downRoot, 'agy');
  fs.writeFileSync(bin, fakeAgy(downRoot), { mode: 0o755 });
  const prevBin = process.env.XIN_ANTIGRAVITY_BIN, prevHome = process.env.XIN_AGY_HOME, prevSandbox = process.env.XIN_TASK_SANDBOX;
  process.env.XIN_ANTIGRAVITY_BIN = bin; process.env.XIN_AGY_HOME = downRoot; process.env.XIN_TASK_SANDBOX = '0';
  let code;
  try {
    let used = 0; const fn = () => ++used <= 10; fn.recordCumulativeUsage = () => ({ input: 1, output: 1, total: 2 });
    code = await antigravityWork({ workspace: { work: path.join(downRoot, 'work'), tmp: path.join(downRoot, 'tmp'), io: path.join(downRoot, 'io') } }, {
      clientDir: path.join(downRoot, 'client'), instructions: '测试说明', text: '测试目标',
      budget: fn, quota: () => {}, conversation: () => {}, ask: () => {}, remember: () => {},
      steers: () => [], note: () => ''
    });
  } finally {
    if (prevBin === undefined) delete process.env.XIN_ANTIGRAVITY_BIN; else process.env.XIN_ANTIGRAVITY_BIN = prevBin;
    if (prevHome === undefined) delete process.env.XIN_AGY_HOME; else process.env.XIN_AGY_HOME = prevHome;
    if (prevSandbox === undefined) delete process.env.XIN_TASK_SANDBOX; else process.env.XIN_TASK_SANDBOX = prevSandbox;
  }
  assert.equal(code, 0);
  const downCalls = f.lines(path.join(downRoot, 'calls.jsonl'));
  assert.doesNotMatch(downCalls[1].prompt, /^已记下。/, '失联未确认时绝不伪造已记下');
  assert.match(downCalls[1].prompt, /暂时不可用|未确认|写进最后的结果/);
});

test('前台查资料中途插话后第二轮 ACP 坏格式切 DeepSeek：未确认的插话不被吞掉，本轮收尾后自动续跑插话', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-front-steer-fallback-'));
  const control = root + '/control', home = root + '/home', work = root + '/work', bin = root + '/bin', log = root + '/native.jsonl', gateway = root + '/gateway.jsonl';
  for (const dir of [control + '/sessions', control + '/runs', home, work + '/uploads', bin]) fs.mkdirSync(dir, { recursive: true });
  const preload = root + '/preload.cjs';
  fs.writeFileSync(preload, `
    require('node:os').homedir=()=>${JSON.stringify(home)};require('node:module').syncBuiltinESMExports();
    const fs=require('node:fs'),real=fetch;global.fetch=async function(url,init){
      if(!String(url).endsWith('/v1/responses'))return real(url,init);const body=JSON.parse(init.body);
      if(String(body.instructions||'').startsWith('你是聊天界面的状态栏'))return new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:''}]}],usage:{input_tokens:10,output_tokens:2}}));
      fs.appendFileSync(${JSON.stringify(gateway)},JSON.stringify(body)+'\\n');
      const n=fs.readFileSync(${JSON.stringify(gateway)},'utf8').trim().split('\\n').length;
      return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'deepseek-turn-'+n}]}],usage:{input_tokens:8,output_tokens:5}}));
    };`);
  fs.writeFileSync(bin + '/agy', '#!' + process.execPath + '\n' + `
    const fs=require('node:fs'),a=process.argv.slice(2),log=${JSON.stringify(log)};
    const record=o=>fs.appendFileSync(log,JSON.stringify(o)+'\\n'),send=o=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\\n');
    record({argv:a});
    if(a.includes('/usage')){console.log(JSON.stringify({event:'result',result:{command:{data:{groups:[{buckets:[{id:'gemini-5h',remaining_fraction:1,reset_time:new Date(Date.now()+3600000).toISOString()},{id:'gemini-weekly',remaining_fraction:1,reset_time:new Date(Date.now()+7*86400000).toISOString()}]}]}}}}));process.exit(0);}
    if(a.includes('--help')){console.log('acp --agent --settings');process.exit(0);}
    let prompts=0,held=null;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const q=JSON.parse(line);record(q);if(!q.method)return;
      if(q.method==='initialize')send({id:q.id,result:{protocolVersion:1,agentCapabilities:{promptCapabilities:{image:true}}}});
      else if(q.method==='session/new')send({id:q.id,result:{sessionId:'s-front',models:{currentModelId:'gemini-4-hydrogen-high',availableModels:[{modelId:'gemini-4-hydrogen-high',name:'Gemini 4 Hydrogen (High)'}]}}});
      else if(q.method==='session/cancel'){if(held!==null){const id=held;held=null;send({id,result:{stopReason:'cancelled'}});}}
      else if(q.method==='session/prompt'){
        prompts++;
        const firstTurn=!fs.existsSync(${JSON.stringify(root + '/searched')});
        if(prompts===1&&firstTurn){fs.writeFileSync(${JSON.stringify(root + '/searched')},'1');held=q.id;send({method:'session/update',params:{sessionId:'s-front',update:{sessionUpdate:'tool_call',toolCallId:'c1',title:'"stm32" on Web',kind:'search',status:'in_progress',rawInput:{query:'stm32'}}}});
          setTimeout(()=>send({method:'session/update',params:{sessionId:'s-front',update:{sessionUpdate:'tool_call_update',toolCallId:'c1',kind:'search',status:'completed'}}}),700);return;}
        // 取消后的补充请求与格式修正都回坏格式，迫使本轮用初始 payload 切 DeepSeek；续跑的第二轮同样走 DeepSeek 验证入参
        send({method:'session/update',params:{sessionId:'s-front',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"text":"半截坏格式'}}}});
        send({id:q.id,result:{stopReason:'end_turn'}});
      }else send({id:q.id,result:{}});
    });`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, XIN_HOME: control, XIN_WORK: work, XIN_AGY_HOME: home, XIN_ANTIGRAVITY_BIN: bin + '/agy',
    NODE_OPTIONS: '--require=' + preload, PATH: bin + ':' + process.env.PATH, XIN_CODEX_TRANSPORT: 'exec', XIN_TASK_SANDBOX: '0',
    XIN_CODEX_KEY: 'test-key', XIN_FRONT_STEER_GAP_MS: '200', XIN_FRONT_PROVIDER: 'antigravity' };
  const agent = path.join(SOURCE, 'vm-agent.mjs');
  const ensureState = require('./helpers/state-mode.cjs').stateClient(t, env);
  t.after(() => stopOwned(control, root));
  const call = (op, args = {}) => { ensureState(); const r = spawnSync(process.execPath, [agent, op], { env, input: JSON.stringify(args), encoding: 'utf8', timeout: 20000 }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const wait = async run => { for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) { const p = call('poll', { run, off: 0 }); if (p.done) return p; await new Promise(r => setTimeout(r, 60)); } assert.fail('front run timeout: ' + run); };

  const sent = call('send', { agent: 'codex', text: '帮我查一下 STM32H7 主频' });
  for (const end = performance.now() + platformTimeout(10000); performance.now() < end;) {
    const p = call('poll', { run: sent.run, off: 0 });
    if ((p.events || []).some(e => e.t === 'tool' && e.name === 'WebSearch')) break;
    await new Promise(r => setTimeout(r, 60));
  }
  const steered = call('steer', { sid: sent.sid, run: sent.run, text: '顺便只看双核型号', clientId: 'front-steer-keep-01' });
  assert.equal(steered.ok, true);

  const firstDone = await wait(sent.run);
  assert.equal(firstDone.events.find(e => e.t === 'done').model, 'deepseek-v4.1-flash');
  assert.ok(firstDone.next, 'DeepSeek 兜底未携带中途插话，本轮结束时必须自动开启下一轮处理插话');
  const secondDone = await wait(firstDone.next);
  assert.equal(secondDone.events.find(e => e.t === 'done').ok, true);
  const gw = fs.readFileSync(gateway, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(gw.length, 2, '第二轮把未确认的插话真正送给前台模型');
  assert.match(JSON.stringify(gw[1].input), /顺便只看双核型号/);
});

test('前台 openFrontProvider 的 front_quota 报告失联容错与校验错误边界', async t => {
  const { openFrontProvider } = await import(url('vm-front-agy'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-front-quota-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'agy');
  const writeFake = blocked => fs.writeFileSync(bin, '#!' + process.execPath + '\n' + `
    const a=process.argv.slice(2),send=o=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\\n');
    if(a.includes('/usage')){console.log(JSON.stringify({event:'result',result:{command:{data:{groups:[{buckets:[
      {id:'gemini-5h',remaining_fraction:${blocked ? 0 : 1},reset_time:new Date(Date.now()+3600000).toISOString()},
      {id:'gemini-weekly',remaining_fraction:1,reset_time:new Date(Date.now()+604800000).toISOString()}]}]}}}}));process.exit(0);}
    if(a.includes('--help')){console.log('acp --agent --settings');process.exit(0);}
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const q=JSON.parse(line);if(!q.method)return;
      if(q.method==='initialize')send({id:q.id,result:{protocolVersion:1,agentCapabilities:{promptCapabilities:{image:true}}}});
      else if(q.method==='session/new')send({id:q.id,result:{sessionId:'s1',models:{currentModelId:'gemini-4-hydrogen-high',availableModels:[{modelId:'gemini-4-hydrogen-high',name:'Gemini 4 Hydrogen (High)'}]}}});
      else if(q.method==='session/prompt'){send({method:'session/update',params:{sessionId:'s1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"text":"hydrogen-ok","calls":[]}'}}}});send({id:q.id,result:{stopReason:'end_turn'}});}
      else send({id:q.id,result:{}});
    });`, { mode: 0o755 });

  // 1) 真实额度可用 + 缓存报告失联：Hydrogen 照常回答
  writeFake(false);
  for (const code of ['owner_unavailable', 'state_disconnected', 'state_timeout', 'state_client_failed']) {
    for (const executed of [false, 'unknown']) {
      const p = await openFrontProvider({
        binary: bin, cwd: path.join(root, 'cwd-' + code + '-' + executed), baseURL: 'http://127.0.0.1:9/v1', key: 'k',
        quota: () => { throw Object.assign(Error('quota-down'), { code, executed }); }
      });
      const out = await p.request({ input: [{ role: 'user', content: '你好' }], tools: [] });
      p.close();
      assert.equal(out.output[0].content[0].text, 'hydrogen-ok');
    }
  }

  // 2) 真实额度已耗尽 + 缓存报告失联：仍切到 DeepSeek 兜底，不启动 Hydrogen
  writeFake(true);
  let fallbackCalls = 0;
  const blockedProvider = await openFrontProvider({
    binary: bin, cwd: path.join(root, 'cwd-blocked'), baseURL: 'http://127.0.0.1:9/v1', key: 'k',
    quota: () => { throw Object.assign(Error('quota-down'), { code: 'state_disconnected', executed: 'unknown' }); },
    fetch: async () => { fallbackCalls++; return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'deepseek-ok' }] }] })); }
  });
  const blockedOut = await blockedProvider.request({ input: [{ role: 'user', content: '你好' }], tools: [] });
  blockedProvider.close();
  assert.equal(blockedOut.output[0].content[0].text, 'deepseek-ok');
  assert.equal(fallbackCalls, 1);

  // 3) 过期尝试、协议或业务校验错误：原样抛出，绝不当网络失联吞掉
  writeFake(false);
  for (const [code, executed] of [['stale_attempt', false], ['bad_quota', true], ['state_protocol', 'unknown'], ['state_response', 'unknown'], ['state_disconnected', true]]) {
    await assert.rejects(
      openFrontProvider({
        binary: bin, cwd: path.join(root, 'cwd-err-' + code + '-' + executed), baseURL: 'http://127.0.0.1:9/v1', key: 'k',
        quota: () => { throw Object.assign(Error('quota-rejected'), { code, executed }); }
      }),
      e => e.message === 'quota-rejected' && e.code === code
    );
  }
});

test('主人长失联跨过 steer_ack 直至收尾：扩展回执另存，恢复后不重复再起一轮，主包仍兼容回滚', async t => {
  const f = agyFaultFixture(t, [
    { action: 'shell', command: 'echo step-one >> list.txt', gate: true },
    { action: 'final', text: '长失联期间也完成了补充要求', gate: true }
  ], '', { XIN_STEER_RETRY_MS: '300' });
  const task = f.call('task_new', { kind: 'research', goal: '整理模型清单' }).task;
  await f.until(() => fs.existsSync(path.join(f.root, 'at-1')), '第一步请求已发出');
  const said = '只留实际正在用的模型';
  assert.equal(f.call('task_tell', { sid: task.sid, text: said }).delivery, 'now');
  fs.writeFileSync(path.join(f.root, 'go-1'), '');

  // 等第二步已经认领补充并发给假 agy，然后杀掉主人且暂不重启：第二步完成、steer_ack 与 run_finalize 全部在无主人状态下落盘退出
  await f.until(() => fs.existsSync(path.join(f.root, 'at-2')), '第二步携带补充已发出');
  const run = f.call('history', { sid: task.sid }).runs[0].run;
  const runMetaBefore = f.read(path.join(f.home, 'runs', run + '.json')), pid = runMetaBefore.pid;
  f.owner.child.kill('SIGKILL'); await f.owner.exited;
  fs.writeFileSync(path.join(f.root, 'go-2'), '');
  await f.until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'runner 离线写完终态包并退出');
  const dir = path.join(f.home, 'finalization', run + '.' + runMetaBefore.attempt);
  const offlinePrepared = JSON.parse(fs.readFileSync(path.join(dir, 'prepared'), 'utf8').split('\n')[1]);
  assert.equal(Object.hasOwn(offlinePrepared.data, 'ackedSteers'), false, '长失联也必须保持 #210 的严格 prepared 格式');
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'steer'), 'utf8').split('\n')[1]);
  assert.equal(receipt.data.prepared, fs.readFileSync(path.join(dir, 'prepared'), 'utf8').split('\n')[0]);
  assert.equal(receipt.data.claims.length, 1);

  // 重启主人后由持久收尾恢复：已消费的补充被终态包确认，任务直接 done，不会因为 steer_ack 当时没送到而多跑第二轮
  f.owner = f.startOwner({ XIN_STATE_TEST_FAULT: '' });
  const h = await f.until(() => {
    f.call('tasks', { all: true });
    const cur = f.call('history', { sid: task.sid });
    return ['done', 'failed', 'queued', 'running'].includes(cur.task.status) && cur.task.status === 'done' && cur;
  }, '主人恢复后应用终态包直接完成任务');
  assert.equal(h.runs.length, 1, '终态包携带已消费批次，不误起第二轮');
  assert.deepEqual(f.read(path.join(f.home, 'runs', run + '.json')).steers.map(x => [x.text, x.state]), [[said, 'accepted']]);
});
