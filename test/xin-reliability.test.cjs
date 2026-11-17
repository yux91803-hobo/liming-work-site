// 临时配置、假的 CLI；不读取或清理开发机的真实 AI 会话。
const test = require('node:test');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');
process.env.XIN_CODEX_TRANSPORT = 'exec';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const AGENT = process.env.XIN_TEST_AGENT_PATH || path.join(__dirname, '../site/xin/vm-agent.mjs');
const ID = '11111111-2222-4333-8444-555555555555', SID = 'sreliable001';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const PRELOAD = `
require(${JSON.stringify(path.join(__dirname,'helpers/front-responses.cjs'))});
const fs = require('node:fs'), path = require('node:path');
require('node:os').homedir = () => process.env.XIN_TEST_PROFILE;
require('node:module').syncBuiltinESMExports();
const read = fs.readFileSync;
fs.readFileSync = function (name, ...args) {
  const value = read.call(this, name, ...args);
  const op = process.argv[2] === 'locked' ? process.argv[3] : process.argv[2];
  if (typeof name === 'string' && process.env.XIN_TEST_BARRIER_TARGET === path.resolve(name) &&
      process.env.XIN_TEST_BARRIER_OPS.split(',').includes(op)) {
    const dir = process.env.XIN_TEST_BARRIER_DIR;
    fs.writeFileSync(path.join(dir, String(process.pid)), 'read');
    const end = performance.now() + 350;
    while (fs.readdirSync(dir).length < 2 && performance.now() < end)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return value;
};
`;

const FAKE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const root = process.env.XIN_TEST_ROOT, args = process.argv.slice(2);
if (args.includes('--ephemeral')) process.exit(0);
if (args[0] === 'delete') {
  fs.appendFileSync(path.join(root, 'deletions'), args.join(' ') + '\\n');
  process.exit(0);
}
const log = path.join(root, 'launches');
fs.appendFileSync(log, process.pid + '\\n');
const number = fs.readFileSync(log, 'utf8').trim().split('\\n').length;
const claude = path.basename(process.argv[1]) === 'claude';
const sidIndex = args.indexOf('--session-id');
const id = claude && sidIndex >= 0 ? args[sidIndex + 1] : '${ID}';
const emit = o => console.log(JSON.stringify(o));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
emit(claude ? {type:'system',subtype:'init',session_id:id} : {type:'thread.started',thread_id:id});
(async () => {
  if (process.env.XIN_TEST_MODE === 'cold' && number === 1) { await sleep(10000); return; }
  if (process.env.XIN_TEST_MODE === 'silent-thinking') {
    if (!claude) emit({type:'turn.started'});
    else if (args.includes('--include-partial-messages')) emit({type:'stream_event',event:{type:'message_start',message:{role:'assistant'}}});
    await sleep(1600);
  } else if (process.env.XIN_TEST_MODE === 'thinking') {
    for (let i = 0; i < 14; i++) {
      fs.appendFileSync(path.join(root, 'progress'), process.pid + '\\n');
      emit(claude ? {type:'assistant',message:{content:[{type:'thinking',thinking:'working'}]}} :
        {type:'item.completed',item:{id:'reason'+i,type:'reasoning',text:'working'}});
      await sleep(100);
    }
  } else await sleep(Number(process.env.XIN_TEST_DELAY_MS) || 100);
  emit(claude ? {type:'assistant',message:{content:[{type:'text',text:'OK'}]}} :
    {type:'item.completed',item:{id:'reply',type:'agent_message',text:'OK'}});
  emit(claude ? {type:'result',session_id:id,is_error:false} : {type:'turn.completed',usage:{}});
})();
`;

// legacy：不起状态进程，走旧模式的 flock 锁（只给测旧模式锁文件的那条用，删旧模式第 2 步一起改写）
function fixture(t, extra = {}, { legacy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-reliability-'));
  for (const p of ['xin/sessions', 'bin', 'profile', 'work', 'barrier', 'codex/sessions/2026/11/06', 'claude/projects/work'])
    fs.mkdirSync(path.join(dir, p), { recursive: true });
  const preload = path.join(dir, 'preload.cjs'); fs.writeFileSync(preload, PRELOAD);
  for (const cmd of ['codex', 'claude']) fs.writeFileSync(path.join(dir, 'bin', cmd), FAKE, { mode: 0o755 });
  const env = Object.assign({}, process.env, {
    XIN_HOME: path.join(dir, 'xin'), XIN_WORK: path.join(dir, 'work'),
    CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    XIN_CODEX_SYS: path.join(dir, 'no-system-config'), XIN_TEST_PROFILE: path.join(dir, 'profile'),
    XIN_TEST_ROOT: dir, PATH: path.join(dir, 'bin') + ':' + process.env.PATH,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require=' + preload].filter(Boolean).join(' ')
  }, extra);
  const session = path.join(env.XIN_HOME, 'sessions', SID + '.json');
  // 控制器和执行进程都对着真的常驻状态进程（test/helpers/state-mode.cjs）
  const ensureState = legacy ? () => {} : require('./helpers/state-mode.cjs').stateClient(t, env);
  const op = (name, args = {}) => {
    ensureState(); const r = spawnSync(process.execPath, [AGENT, name], { env, input: JSON.stringify(args), encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr || String(r.error || ''));
    return JSON.parse(r.stdout);
  };
  // The retired Claude mode takes no new conversations; an existing one continues exactly as before.
  const claudeSend = text => {
    const sid = 'sclaudeold1';
    fs.writeFileSync(path.join(env.XIN_HOME, 'sessions', sid + '.json'), JSON.stringify({ sid, agent: 'claude', title: 'old', agentSid: require('node:crypto').randomUUID(), started: false, runs: [], created: Date.now(), updated: Date.now() }));
    return op('send', { sid, text });
  };
  const asyncOp = (name, args) => new Promise((resolve, reject) => {
    ensureState(); const child = spawn(process.execPath, [AGENT, name], { env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('error', reject); child.on('close', code => {
      try { assert.equal(code, 0, err); resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify(args));
  });
  const wait = async run => {
    const log = path.join(env.XIN_HOME, 'runs', run + '.jsonl'), meta = path.join(env.XIN_HOME, 'runs', run + '.json');
    for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) {
      let events = [], ended = false;
      try { events = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)); ended = !!JSON.parse(fs.readFileSync(meta, 'utf8')).ended; } catch { /* 正在写 */ }
      if (ended && events.some(e => e.t === 'done')) return events;
      await pause(25);
    }
    assert.fail('runner did not finish');
  };
  const seed = () => fs.writeFileSync(session, JSON.stringify({ sid: SID, agent: 'codex', agentSid: ID, started: true,
    title: 'original', created: 1, updated: 1, runs: [] }));
  const barrier = ops => Object.assign(env, { XIN_TEST_BARRIER_TARGET: session,
    XIN_TEST_BARRIER_OPS: ops.join(','), XIN_TEST_BARRIER_DIR: path.join(dir, 'barrier') });
  t.after(() => stopOwned(env.XIN_HOME, dir));
  // CLI lifecycle coverage belongs to the daily/background executor, not the now tool-less front.
  const cliSend = () => {
    const run='rclitest001';
    fs.mkdirSync(path.join(env.XIN_HOME,'runs'),{recursive:true});
    fs.writeFileSync(session,JSON.stringify({sid:SID,agent:'codex',title:'CLI executor',runs:[run],created:1,updated:1}));
    fs.writeFileSync(path.join(env.XIN_HOME,'runs',run+'.json'),JSON.stringify({run,sid:SID,agent:'codex',kind:'daily',text:'CLI test',started:Date.now(),model:'deepseek-v4.1-flash',fallbacks:[]}));
    fs.writeFileSync(path.join(env.XIN_HOME,'runs',run+'.jsonl'),JSON.stringify({t:'user',text:'CLI test'})+'\n');
    ensureState(); spawn(process.execPath,[AGENT,'run',run],{env,detached:true,stdio:'ignore'}).unref();
    return {run,sid:SID};
  };
  return { dir, env, session, op, asyncOp, wait, seed, barrier, cliSend, claudeSend };
}

function oldLog(env, agent, id = ID) {
  const file = agent === 'codex' ? path.join(env.CODEX_HOME, 'sessions/2026/11/06', 'rollout-2026-11-06T00-00-00-' + id + '.jsonl') :
    path.join(env.CLAUDE_CONFIG_DIR, 'projects/work', id + '.jsonl');
  fs.writeFileSync(file, JSON.stringify(agent === 'codex' ? { type: 'session_meta', payload: { id, source: 'exec', originator: 'codex_exec' } } :
    { type: 'user', sessionId: id, promptSource: 'sdk', entrypoint: 'sdk-cli', message: { content: 'independent task' } }) + '\n');
  const old = (Date.now() - 7200000) / 1000; fs.utimesSync(file, old, old); return file;
}

test('清理不碰独立 codex exec / Claude SDK 的旧记录，坏的归属登记也不能授权删除', t => {
  const f = fixture(t), codex = oldLog(f.env, 'codex'), claude = oldLog(f.env, 'claude');
  const owned = path.join(f.env.XIN_HOME, 'agent-sessions'); fs.mkdirSync(owned);
  fs.writeFileSync(path.join(owned, 'codex-' + ID + '.json'), '{}');
  assert.deepEqual(f.op('prune'), { codex: 0, claude: 0, harness: 0, bytes: 0 });
  assert.ok(fs.existsSync(codex) && fs.existsSync(claude));
  assert.equal(fs.existsSync(path.join(f.dir, 'deletions')), false);
});

for (const agent of ['codex', 'claude']) test(agent + '：网页新会话登记归属，仍关联的保留，已失联的旧记录才清理', async t => {
  const f = fixture(t), sent = agent==='codex' ? f.cliSend() : f.claudeSend('test ownership'); await f.wait(sent.run);
  const sessionFile = path.join(f.env.XIN_HOME, 'sessions', sent.sid + '.json');
  const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8')), marker = path.join(f.env.XIN_HOME, 'agent-sessions', agent + '-' + s.agentSid + '.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { agent, id: s.agentSid });
  const log = oldLog(f.env, agent, s.agentSid);
  assert.deepEqual(f.op('prune'), { codex: 0, claude: 0, harness: 0, bytes: 0 }); assert.ok(fs.existsSync(log));
  fs.unlinkSync(sessionFile); // 仅模拟测试对话丢失关联，真实日志都在临时目录。
  assert.equal(f.op('prune')[agent], 1); assert.equal(fs.existsSync(log), false); assert.equal(fs.existsSync(marker), false);
});

test('旧网页会话从有效关联补登记；不能把未知孤立记录当作旧网页会话', t => {
  const f = fixture(t); f.seed(); const known = oldLog(f.env, 'codex'), otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const other = oldLog(f.env, 'codex', otherId);
  assert.deepEqual(f.op('prune'), { codex: 0, claude: 0, harness: 0, bytes: 0 });
  assert.ok(fs.existsSync(path.join(f.env.XIN_HOME, 'agent-sessions', 'codex-' + ID + '.json')));
  fs.unlinkSync(f.session); assert.equal(f.op('prune').codex, 1);
  assert.equal(fs.existsSync(known), false); assert.ok(fs.existsSync(other));
});

test('有无法判定归属的损坏网页记录时，保守停止清理', t => {
  const f = fixture(t), file = oldLog(f.env, 'codex');
  const owned = path.join(f.env.XIN_HOME, 'agent-sessions'); fs.mkdirSync(owned);
  fs.writeFileSync(path.join(owned, 'codex-' + ID + '.json'), JSON.stringify({ agent: 'codex', id: ID }));
  for (const bad of [[], { agent: 'codex', agentSid: '../../wrong' }, { agent: 'unknown', agentSid: ID }]) {
    fs.writeFileSync(f.session, JSON.stringify(bad));
    assert.equal(f.op('prune').skipped, 'bad_session_file'); assert.ok(fs.existsSync(file));
  }
});

test('同一对话并发发送：只接收一轮，另一轮明确 busy，所有已接收消息都进入历史', async t => {
  const f = fixture(t, { XIN_TEST_DELAY_MS: '1500' }); f.seed(); f.barrier(['send']);
  const results = await Promise.all([f.asyncOp('send', { sid: SID, text: 'one' }), f.asyncOp('send', { sid: SID, text: 'two' })]);
  const accepted = results.filter(r => r.run && !r.error);
  for (const r of accepted) await f.wait(r.run);
  assert.equal(accepted.length, 1, JSON.stringify(results)); assert.equal(results.filter(r => r.error === 'busy').length, 1);
  const saved = JSON.parse(fs.readFileSync(f.session, 'utf8'));
  assert.deepEqual(saved.runs, accepted.map(r => r.run));
  assert.equal(fs.readdirSync(path.join(f.env.XIN_HOME, 'runs')).filter(n => /^r.*\.jsonl$/.test(n)).length, 1);
});

test('并发改名、归档和后台保存状态不相互覆盖，后台任务不继承请求锁', async t => {
  const f = fixture(t, { XIN_TEST_DELAY_MS: '1800' }); f.seed();
  const r = f.op('send', { sid: SID, text: 'running' }); f.barrier(['rename', 'archive']);
  const changes = await Promise.all([f.asyncOp('rename', { sid: SID, title: 'renamed' }), f.asyncOp('archive', { sid: SID, on: true })]);
  assert.ok(changes.every(x => x.ok), JSON.stringify(changes)); await f.wait(r.run);
  const saved = JSON.parse(fs.readFileSync(f.session, 'utf8'));
  assert.equal(saved.title, 'renamed'); assert.equal(saved.archived, true); assert.equal(saved.agentSid, ID); assert.deepEqual(saved.runs, [r.run]);
});

test('锁持有进程被杀后由系统释放，后续发送不用人工删除锁文件', async t => {
  const f = fixture(t, {}, { legacy: true }); f.seed(); const dir = path.join(f.env.XIN_HOME, 'locks'); fs.mkdirSync(dir);
  const holder = spawn('flock', ['--close', path.join(dir, SID + '.lock'), process.execPath, '-e', "console.log('ready');setInterval(()=>{},1000)"],
    { detached: true, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
    assert.equal(f.op('send', { sid: SID, text: 'blocked' }).error, 'busy');
  } finally { process.kill(-holder.pid, 'SIGKILL'); }
  const r = f.op('send', { sid: SID, text: 'recovered' }); assert.ok(r.run, JSON.stringify(r)); await f.wait(r.run);
});

for (const agent of ['codex', 'claude']) test(agent + ' 思考进展持续超过初始等待时间，不会误重连', async t => {
  const f = fixture(t, { XIN_TEST_MODE: 'thinking', XIN_STALL_MS: '800' });
  const r = agent==='codex' ? f.cliSend() : f.claudeSend('think'), events = await f.wait(r.run);
  assert.equal(fs.readFileSync(path.join(f.dir, 'launches'), 'utf8').trim().split('\n').length, 1);
  assert.equal(events.some(e => e.t === 'status' && /重新连/.test(e.text)), false);
  assert.equal(events.find(e => e.t === 'done').ok, true);
});

for (const agent of ['codex', 'claude']) test(agent + ' 已开始处理后长时间不输出事件，也不会被网页重放任务', async t => {
  const f = fixture(t, { XIN_TEST_MODE: 'silent-thinking', XIN_STALL_MS: '800' });
  const r = agent==='codex' ? f.cliSend() : f.claudeSend('silent reasoning'), events = await f.wait(r.run);
  assert.equal(fs.readFileSync(path.join(f.dir, 'launches'), 'utf8').trim().split('\n').length, 1);
  assert.equal(events.some(e => e.t === 'status' && /重新连/.test(e.text)), false);
  assert.equal(events.find(e => e.t === 'done').ok, true);
});

test('只有初始化、一直没有模型进展的连接仍自动重试一次', async t => {
  const f = fixture(t, { XIN_TEST_MODE: 'cold', XIN_STALL_MS: '800' });
  const r = f.cliSend(), events = await f.wait(r.run);
  assert.equal(fs.readFileSync(path.join(f.dir, 'launches'), 'utf8').trim().split('\n').length, 2);
  assert.equal(events.filter(e => e.t === 'status' && /重新连/.test(e.text)).length, 1);
  assert.equal(events.find(e => e.t === 'done').ok, true);
});
