// 小芯内核外壳（site/xin/vm-kernel.mjs）：/xin/health、/xin/op、/xin/stream，以及 ensure / serve。
// 设计见 docs/xin-kernel-design.md §4、§14；计划 docs/superpowers/plans/2026-11-13-xin-kernel-stage1.md。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { platformTimeout } = require('./helpers/timeout.cjs');

const load = rel => import(pathToFileURL(path.join(__dirname, rel)).href);
const KEY = Buffer.alloc(32, 7).toString('base64url');
const FAKE = 'vm-agent-000000000000.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 假控制器：按 op 做事，参数从标准输入来，和真控制器一样
const FAKE_AGENT = `import fs from 'node:fs';
import {spawn} from 'node:child_process';
const op = process.argv[2];
let input = ''; for await (const c of process.stdin) input += c;
const a = input ? JSON.parse(input) : {};
const count = n => { const f = process.env.XIN_HOME + '/' + n + '.count'; let k = 0; try { k = Number(fs.readFileSync(f, 'utf8')) || 0; } catch {} fs.writeFileSync(f, String(k + 1)); };
if (op === 'echo') process.stdout.write(JSON.stringify(a));
else if (op === 'slow') { await new Promise(r => setTimeout(r, a.ms || 500)); if (a.mark) fs.writeFileSync(a.mark, 'done'); process.stdout.write('{"ok":true}'); }
else if (op === 'boom') { process.stderr.write('line1\\nleak ibp_LEAKED1\\nboom happened\\n'); process.exit(1); }
else if (op === 'garbage') process.stdout.write('not json');
else if (op === 'env') process.stdout.write(JSON.stringify({ probe: process.env.XIN_ENV_PROBE || null }));
else if (op === 'launch') { const c=spawn(process.execPath,['-e',"setTimeout(()=>require('fs').writeFileSync(process.argv[1],'done'),1500)",a.mark],{detached:true,stdio:'ignore'});c.unref();process.stdout.write(JSON.stringify({pid:c.pid})); }
else if (op === 'poll') {
  count('poll');
  if (a.run.startsWith('rbad')) { process.stdout.write(JSON.stringify({ error: 'no_run', msg: '找不到这一轮' })); process.exit(0); }
  const file = process.env.XIN_HOME + '/runs/' + a.run + '.jsonl';
  let lines = []; try { lines = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean); } catch {}
  const off = a.off | 0, evs = lines.slice(off).map(l => JSON.parse(l));
  process.stdout.write(JSON.stringify({ events: evs, off: off + evs.length, pos: (off + evs.length) * 10, done: evs.some(e => e.t === 'done') }));
}
else process.stdout.write(JSON.stringify({ error: 'bad_op' }));
`;

async function kernelFixture(opt = {}) {
  const kernel = await load('../site/xin/vm-kernel.mjs'), worker = await load('../src/xin-kernel.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-kernel-'));
  fs.mkdirSync(path.join(home, 'agent')); fs.mkdirSync(path.join(home, 'runs'));
  fs.writeFileSync(path.join(home, 'kernel-keys.json'), JSON.stringify({ v: 1, keys: { ka: KEY } }), { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'agent', FAKE), FAKE_AGENT);
  const env = Object.assign({}, process.env, { XIN_HOME: home }, opt.env || {});
  const k = await kernel.createKernel({ home, env, ...(opt.kernel || {}) });
  const agent = path.join(home, 'agent', FAKE);
  async function request(method, target, body, o = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = Object.assign({}, o.headers || {});
    if (o.sign !== false) headers['x-xin-auth'] = await worker.signKernelRequest({ key: KEY, kid: 'ka', method, target, body: text });
    if (text) headers['content-type'] = 'application/json';
    return fetch('http://127.0.0.1:' + k.port + target, { method, headers, body: text || undefined, signal: o.signal });
  }
  const op = (name, args, o) => request('POST', '/xin/op', { agent, op: name, args: args || {} }, o);
  return { kernel, worker, home, k, agent, request, op };
}

test('health 要签名；回应都带内核头', async () => {
  const f = await kernelFixture();
  try {
    const bad = await f.request('GET', '/xin/health', undefined, { sign: false });
    assert.strictEqual(bad.status, 401);
    assert.ok(bad.headers.get('x-xin-kernel'));
    assert.deepStrictEqual(await bad.json(), { ok: false, executed: false, error: 'kernel_auth', reason: 'missing' });
    const good = await f.request('GET', '/xin/health');
    assert.strictEqual(good.status, 200);
    const d = await good.json();
    assert.strictEqual(d.ok, true); assert.ok(d.kernel); assert.strictEqual(d.pid, process.pid);
  } finally { await f.k.close(); }
});

test('op 原样起控制器，参数从标准输入进去', async () => {
  const f = await kernelFixture();
  try {
    const r = await f.op('echo', { a: 1, text: '你好' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true, data: { a: 1, text: '你好' } });
  } finally { await f.k.close(); }
});

test('控制器出错都是 executed:true；超时会杀掉子进程', async () => {
  const f = await kernelFixture({ kernel: { opTimeoutMs: 300 } });
  try {
    const boom = await (await f.op('boom')).json();
    assert.strictEqual(boom.executed, true); assert.strictEqual(boom.error, 'agent_failed');
    assert.match(boom.msg, /boom happened/); assert.ok(!boom.msg.includes('LEAKED1'), '错误信息要脱敏');
    assert.strictEqual((await (await f.op('garbage')).json()).error, 'agent_output');
    const mark = path.join(f.home, 'slow.mark');
    const t = await (await f.op('slow', { ms: 900, mark })).json();
    assert.deepStrictEqual([t.executed, t.error], [true, 'agent_timeout']);
    await sleep(1300);
    assert.ok(!fs.existsSync(mark), '超时的控制器被杀掉了，没有做完');
  } finally { await f.k.close(); }
});

test('没执行的都是 executed:false：路径不对、模块不在、太忙、请求太大', async () => {
  const f = await kernelFixture({ kernel: { maxConcurrent: 1 } });
  try {
    let r = await f.request('POST', '/xin/op', { agent: '/tmp/vm-agent-000000000000.mjs', op: 'echo', args: {} });
    assert.strictEqual(r.status, 400); assert.deepStrictEqual(await r.json(), { ok: false, executed: false, error: 'bad_request' });
    r = await f.request('POST', '/xin/op', { agent: path.join(f.home, 'agent', 'vm-agent-111111111111.mjs'), op: 'echo', args: {} });
    assert.strictEqual(r.status, 409); assert.deepStrictEqual(await r.json(), { ok: false, executed: false, error: 'agent_missing' });
    const slow = f.op('slow', { ms: 800 });
    await sleep(150);
    r = await f.op('echo', {});
    assert.strictEqual(r.status, 503); assert.deepStrictEqual(await r.json(), { ok: false, executed: false, error: 'kernel_busy' });
    assert.strictEqual((await (await slow).json()).ok, true);
    // Worker 最多放进来 65536 个字符，全是中文时是 19 万多字节：这么大的内核要收得下，再大才拒
    r = await f.op('echo', { text: '字'.repeat(60000) });
    assert.strictEqual(r.status, 200); assert.strictEqual((await r.json()).ok, true);
    r = await f.op('echo', { text: 'x'.repeat(300000) });
    assert.strictEqual(r.status, 413); assert.strictEqual((await r.json()).executed, false);
  } finally { await f.k.close(); }
});

test('对方断开不杀控制器：让它做完并存下结果', async () => {
  const f = await kernelFixture();
  try {
    const mark = path.join(f.home, 'finished.mark'), ac = new AbortController();
    const p = f.op('slow', { ms: 500, mark }, { signal: ac.signal }).catch(e => e);
    await sleep(100); ac.abort(); await p;
    await sleep(1000);
    assert.ok(fs.existsSync(mark));
  } finally { await f.k.close(); }
});

test('日志不带秘密，只记操作、状态和 clientId', async () => {
  const f = await kernelFixture();
  try {
    const MARK = 'secret-message-text-9f3a';
    await f.op('echo', { text: MARK, clientId: 'cid-12345678' }, { headers: { authorization: 'Bearer ibp_SECRET' } });
    await f.op('boom', {});
    await f.request('GET', '/xin/health', undefined, { sign: false, headers: { authorization: 'Bearer ibp_SECRET' } });
    const log = fs.readFileSync(path.join(f.home, 'logs', 'kernel.jsonl'), 'utf8');
    for (const bad of [MARK, 'ibp_SECRET', KEY, 'sig=', 'LEAKED1']) assert.ok(!log.includes(bad), '日志里不该有 ' + bad);
    const lines = log.trim().split('\n').map(l => JSON.parse(l));
    assert.ok(lines.some(l => l.id === 'cid-12345678' && l.op === 'echo' && l.status === 200));
    assert.ok(lines.some(l => l.route === '/xin/health' && l.status === 401));
    for (const l of lines) for (const k of Object.keys(l)) assert.ok(['at', 'method', 'route', 'op', 'status', 'ms', 'id', 'error', 'reason'].includes(k), '日志多了字段 ' + k);
  } finally { await f.k.close(); }
});

test('真控制器：同一个 clientId 一次走内核、一次直接调，只有一轮', async () => {
  const f = await kernelFixture();
  try {
    // 把真控制器放进 home/agent，入口改成带哈希的名字（模块之间按 ./vm-xxx.mjs 互相引用）
    const src = path.join(__dirname, '../site/xin');
    for (const x of fs.readdirSync(src).filter(x => /^vm-.*\.mjs$/.test(x))) fs.copyFileSync(path.join(src, x), path.join(f.home, 'agent', x));
    const real = path.join(f.home, 'agent', 'vm-agent-abcdefabcdef.mjs');
    fs.copyFileSync(path.join(src, 'vm-agent.mjs'), real);
    await f.k.close();
    const work = path.join(f.home, 'work');
    const env = Object.assign({}, process.env, { XIN_HOME: f.home, XIN_WORK: work });
    env.NODE_OPTIONS = (env.NODE_OPTIONS || '') + ' --require=' + path.join(__dirname, 'helpers/front-responses.cjs');
    const kernel = await f.kernel.createKernel({ home: f.home, env });
    const args = { agent: 'codex', text: '同一句话', clientId: 'dup-12345678' };
    const viaKernel = (async () => {
      const text = JSON.stringify({ agent: real, op: 'send', args });
      const r = await fetch('http://127.0.0.1:' + kernel.port + '/xin/op', { method: 'POST', body: text, headers: { 'content-type': 'application/json', 'x-xin-auth': await f.worker.signKernelRequest({ key: KEY, kid: 'ka', method: 'POST', target: '/xin/op', body: text }) } });
      const d = await r.json(); assert.strictEqual(d.ok, true, JSON.stringify(d)); return d.data;
    })();
    const direct = new Promise((ok, no) => { const c = execFile(process.execPath, [real, 'send'], { env }, (e, out) => e ? no(e) : ok(JSON.parse(out))); c.stdin.end(JSON.stringify(args)); });
    const results = await Promise.all([viaKernel, direct]);
    const runs = fs.readdirSync(path.join(f.home, 'runs')).filter(x => /^r[0-9a-z]+\.json$/.test(x));
    assert.strictEqual(runs.length, 1, '只该有一轮：' + runs.join(','));
    const run = runs[0].replace('.json', '');
    assert.ok(results.some(d => d.run === run));
    for (const d of results) assert.ok(d.run === run || d.error === 'busy', JSON.stringify(d));
    await kernel.close();
  } finally { /* 第一个内核已关 */ }
});

// 读内核的 SSE：每条消息 {id, event, data}；注释行（心跳）单独计数
async function openStream(f, query, o = {}) {
  const target = '/xin/stream?' + new URLSearchParams({ agent: f.agent, ...query }).toString();
  const ac = new AbortController();
  const r = await f.request('GET', target, undefined, { signal: ac.signal });
  const got = { status: r.status, type: r.headers.get('content-type'), messages: [], beats: 0, ended: false, ac };
  if (r.status !== 200) { got.body = await r.json(); return got; }
  got.done = (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith(':')) { got.beats++; continue; }
          const m = {}; for (const line of block.split('\n')) { const j = line.indexOf(': '); if (j > 0) m[line.slice(0, j)] = line.slice(j + 2); }
          got.messages.push({ id: m.id, event: m.event, data: m.data && JSON.parse(m.data) });
        }
      }
    } catch { /* 中止 */ }
    got.ended = true;
  })();
  return got;
}
const pollCount = f => { try { return Number(fs.readFileSync(path.join(f.home, 'poll.count'), 'utf8')) || 0; } catch { return 0; } };
const appendEv = (f, run, ev) => fs.appendFileSync(path.join(f.home, 'runs', run + '.jsonl'), JSON.stringify(ev) + '\n');

test('流：有新事件才推，推的是 poll 原样结果，整段答案不拆开', async () => {
  const f = await kernelFixture({ kernel: { pollEveryMs: 50 } });
  try {
    const s = await openStream(f, { run: 'rstream01', off: '0', watching: '1', deviceId: 'dev12345', tabId: 'tab12345' });
    assert.strictEqual(s.status, 200);
    assert.match(s.type, /^text\/event-stream/);
    await sleep(300);
    assert.strictEqual(s.messages.length, 0, '没有新事件时不推');
    appendEv(f, 'rstream01', { t: 'text', text: '整段答案 ABC' });
    for (const end = performance.now() + platformTimeout(3000); performance.now() < end && !s.messages.length;) await sleep(30);
    assert.strictEqual(s.messages.length, 1);
    const d = s.messages[0].data;
    assert.deepStrictEqual(d.events, [{ t: 'text', text: '整段答案 ABC' }]);
    assert.strictEqual(s.messages[0].id, String(d.pos));
    s.ac.abort(); await s.done;
  } finally { await f.k.close(); }
});

test('流：推出 done 之后就结束', async () => {
  const f = await kernelFixture({ kernel: { pollEveryMs: 50 } });
  try {
    appendEv(f, 'rstream02', { t: 'text', text: '好' });
    const s = await openStream(f, { run: 'rstream02', off: '0' });
    for (const end = performance.now() + platformTimeout(3000); performance.now() < end && !s.messages.length;) await sleep(30);
    appendEv(f, 'rstream02', { t: 'done' });
    const t0 = performance.now();
    await Promise.race([s.done, sleep(platformTimeout(2000))]);
    assert.ok(s.ended, '做完以后流要关');
    assert.ok(performance.now() - t0 < platformTimeout(1500));
    assert.strictEqual(s.messages.at(-1).data.done, true);
    assert.deepStrictEqual(s.messages.flatMap(m => m.data.events).map(e => e.t), ['text', 'done']);
  } finally { await f.k.close(); }
});

test('流：没变化也定期调 poll（保住「有人在看」）', async () => {
  const f = await kernelFixture({ kernel: { pollEveryMs: 50, keepWatchMs: 200 } });
  try {
    const s = await openStream(f, { run: 'rstream03', off: '0', watching: '1' });
    await sleep(1100);
    assert.ok(pollCount(f) >= 3, 'poll 次数 ' + pollCount(f));
    s.ac.abort(); await s.done;
  } finally { await f.k.close(); }
});

test('流：定时心跳', async () => {
  const f = await kernelFixture({ kernel: { pollEveryMs: 30, heartbeatMs: 100 } });
  try {
    const s = await openStream(f, { run: 'rstream04', off: '0' });
    await sleep(400);
    assert.ok(s.beats >= 2, '心跳 ' + s.beats);
    s.ac.abort(); await s.done;
  } finally { await f.k.close(); }
});

test('流：对方断开就停，不再调 poll', async () => {
  const f = await kernelFixture({ kernel: { pollEveryMs: 30, keepWatchMs: 100 } });
  try {
    const s = await openStream(f, { run: 'rstream05', off: '0' });
    await sleep(200); s.ac.abort(); await s.done;
    await sleep(150);
    const n = pollCount(f);
    appendEv(f, 'rstream05', { t: 'text', text: 'x' });
    await sleep(500);
    assert.strictEqual(pollCount(f), n);
  } finally { await f.k.close(); }
});

test('流：run 不合法回 400；poll 报错就推 error 然后关', async () => {
  const f = await kernelFixture({ kernel: { pollEveryMs: 30 } });
  try {
    const bad = await openStream(f, { run: '../etc', off: '0' });
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(bad.body, { ok: false, executed: false, error: 'bad_request' });
    const s = await openStream(f, { run: 'rbadpoll01', off: '0' });
    await Promise.race([s.done, sleep(platformTimeout(2000))]);
    assert.ok(s.ended);
    assert.strictEqual(s.messages[0].event, 'error');
    assert.strictEqual(s.messages[0].data.error, 'no_run');
  } finally { await f.k.close(); }
});

/* ---------- ensure / serve：临时用户管理器驱动真实 HTTP 内核 ---------- */
function lifecycleHome(prefix='xin-kensure-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix)), bin = path.join(home, 'bin'), config=path.join(home,'config');
  for (const d of ['agent','runs','bin','config']) fs.mkdirSync(path.join(home,d));
  fs.writeFileSync(path.join(home,'kernel-keys.json'),JSON.stringify({v:1,keys:{ka:KEY}}),{mode:0o600});
  fs.writeFileSync(path.join(home,'agent',FAKE),FAKE_AGENT);
  const fake=fs.readFileSync(path.join(__dirname,'helpers/kernel-systemd.cjs'),'utf8');
  for(const cmd of ['systemctl','systemd-run'])fs.writeFileSync(path.join(bin,cmd),'#!'+process.execPath+'\n'+fake,{mode:0o755});
  const bus=path.join(home,'bus');fs.writeFileSync(bus,'');
  return {home,bin,bus,config,unit:path.join(config,'systemd/user/xin-kernel-resident.service')};
}
function freePort() { return new Promise(ok => { const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); }); }
function kernelCopy(home, hash) {
  const f = path.join(home, 'agent', 'vm-kernel-' + hash + '.mjs');
  fs.copyFileSync(path.join(__dirname, '../site/xin/vm-kernel.mjs'), f); return f;
}
function runEnsure(L, file, port, extra = {}) {
  const env = Object.assign({}, process.env, { XIN_HOME: L.home, XDG_CONFIG_HOME: L.config, PATH: L.bin + ':' + process.env.PATH, XIN_SYSTEMD_BUS: L.bus }, extra);
  return new Promise((ok, no) => execFile(process.execPath, [file, 'ensure', '--port', String(port)], { env }, (e, out) => e ? no(e) : ok(JSON.parse(out))));
}
async function signedHealth(port) {
  const worker = await load('../src/xin-kernel.js');
  const r = await fetch('http://127.0.0.1:' + port + '/xin/health', { headers: { 'x-xin-auth': await worker.signKernelRequest({ key: KEY, kid: 'ka', method: 'GET', target: '/xin/health' }) } });
  return r.json();
}
function killAll(L, extraPids = []) {
  let pids = []; try { pids = fs.readFileSync(path.join(L.home, 'pids'), 'utf8').trim().split('\n').map(Number); } catch { /* 没起过 */ }
  for (const p of [...pids, ...extraPids]) if(p>1)try { process.kill(p, 'SIGKILL'); } catch { /* 已经退出 */ }
}
const systemdLog = L => { try { return fs.readFileSync(path.join(L.home, 'systemd.log'), 'utf8'); } catch { return ''; } };
function serviceControl(L,action) {
  const env={...process.env,XIN_HOME:L.home,XDG_CONFIG_HOME:L.config,PATH:L.bin+':'+process.env.PATH};
  const args=['--user',action,...(action==='daemon-reload'?[]:['xin-kernel-resident.service'])];
  return new Promise((ok,no)=>execFile(path.join(L.bin,'systemctl'),args,{env},e=>e?no(e):ok()));
}
async function lifecycleOp(L,port,op,args={}) {
  const worker=await load('../src/xin-kernel.js'),body=JSON.stringify({agent:path.join(L.home,'agent',FAKE),op,args});
  const r=await fetch('http://127.0.0.1:'+port+'/xin/op',{method:'POST',body,headers:{'x-xin-auth':await worker.signKernelRequest({key:KEY,kid:'ka',method:'POST',target:'/xin/op',body})}});
  return r.json();
}

test('ensure：用 systemd 用户服务起内核，只杀主进程、挂了自动重启；同一版本再 ensure 什么都不做', async () => {
  const L = lifecycleHome(), port = await freePort(), file = kernelCopy(L.home, 'aaaaaaaaaaaa');
  try {
    const first = await runEnsure(L, file, port);
    assert.strictEqual(first.ok, true, JSON.stringify(first)); assert.strictEqual(first.started, true);
    const log = systemdLog(L);
    assert.strictEqual(first.persistent,true);
    const unit=fs.readFileSync(L.unit,'utf8');
    assert.match(unit,/KillMode=process/);assert.match(unit,/Restart=always/);assert.match(unit,/RestartSec=2/);assert.match(unit,/WantedBy=default.target/);
    assert.match(unit,/vm-kernel-aaaaaaaaaaaa\.mjs/);assert.match(log,/systemctl --user enable/);
    assert.strictEqual(fs.readFileSync(path.join(L.home,'enabled'),'utf8'),'yes');
    assert.strictEqual((await signedHealth(port)).kernel, 'aaaaaaaaaaaa');
    const second = await runEnsure(L, file, port);
    assert.deepStrictEqual([second.ok, second.already], [true, true]);
    assert.strictEqual(systemdLog(L).split('\n').filter(l => l.startsWith('systemctl --user start')).length, 1);
  } finally { killAll(L); }
});

test('ensure：版本不同会先停旧的再起新的', async () => {
  const L = lifecycleHome(), port = await freePort();
  try {
    await runEnsure(L, kernelCopy(L.home, 'aaaaaaaaaaaa'), port);
    const r = await runEnsure(L, kernelCopy(L.home, 'bbbbbbbbbbbb'), port);
    assert.strictEqual(r.started, true, JSON.stringify(r));
    assert.match(systemdLog(L), /systemctl --user stop xin-kernel-resident\.service/);
    assert.strictEqual((await signedHealth(port)).kernel, 'bbbbbbbbbbbb');
  } finally { killAll(L); }
});

test('ensure：控制器的环境和 exec 时一样（把 ensure 时的环境存下来给 serve 用）', async () => {
  const L = lifecycleHome(), port = await freePort(), worker = await load('../src/xin-kernel.js');
  try {
    await runEnsure(L, kernelCopy(L.home, 'cccccccccccc'), port, { XIN_ENV_PROBE: '1' });
    const st = fs.statSync(path.join(L.home, 'kernel.env.json'));
    assert.strictEqual(st.mode & 0o777, 0o600);
    const text = JSON.stringify({ agent: path.join(L.home, 'agent', FAKE), op: 'env', args: {} });
    const r = await fetch('http://127.0.0.1:' + port + '/xin/op', { method: 'POST', body: text, headers: { 'x-xin-auth': await worker.signKernelRequest({ key: KEY, kid: 'ka', method: 'POST', target: '/xin/op', body: text }) } });
    assert.deepStrictEqual(await r.json(), { ok: true, data: { probe: '1' } });
  } finally { killAll(L); }
});

test('ensure：没有用户总线时直接起一个脱离的进程', async () => {
  const L = lifecycleHome(), port = await freePort();
  let pid = 0;
  try {
    const r = await runEnsure(L, kernelCopy(L.home, 'dddddddddddd'), port, { XIN_SYSTEMD_BUS: path.join(L.home, 'no-bus') });
    assert.strictEqual(r.started, true, JSON.stringify(r));
    assert.ok(!systemdLog(L).includes('systemd-run'));assert.strictEqual(r.persistent,false);assert.strictEqual(fs.existsSync(L.unit),false);
    const h = await signedHealth(port); pid = h.pid;
    assert.strictEqual(h.kernel, 'dddddddddddd');
  } finally { killAll(L, pid ? [pid] : []); }
});

test('持久服务：enable 失败保留临时启动；健康同版本临时服务下次仍迁移，未丢环境',async()=>{
  const L=lifecycleHome(),port=await freePort(),file=kernelCopy(L.home,'111111111111');
  try {
    const fallback=await runEnsure(L,file,port,{XIN_FAKE_FAIL:'enable',XIN_ENV_PROBE:'saved'});
    assert.strictEqual(fallback.ok,true);assert.strictEqual(fallback.persistent,false);assert.strictEqual(fallback.serviceError,'service_enable_failed');
    assert.strictEqual(fs.existsSync(L.unit),false);assert.strictEqual(fs.existsSync(path.join(L.home,'enabled')),false);
    const migration=await runEnsure(L,file,port,{XIN_ENV_PROBE:'saved'});
    assert.strictEqual(migration.persistent,true);assert.notStrictEqual(migration.pid,fallback.pid);
    assert.deepStrictEqual((await lifecycleOp(L,port,'env')).data,{probe:'saved'});
  }finally{killAll(L);}
});

test('持久服务：临时回退保留原来的 reset-failed 后重试，不能因改持久服务丢掉旧恢复途径',async()=>{
  const L=lifecycleHome(),port=await freePort(),file=kernelCopy(L.home,'abababababab');
  try {
    const r=await runEnsure(L,file,port,{XIN_FAKE_FAIL:'enable',XIN_FAKE_RUN_FAIL:'once'});
    assert.strictEqual(r.ok,true,JSON.stringify(r));assert.strictEqual(r.persistent,false);assert.strictEqual(r.systemd,true);
    assert.strictEqual(systemdLog(L).split('\n').filter(l=>l.startsWith('systemd-run')).length,2);
    assert.match(systemdLog(L),/systemctl --user reset-failed xin-kernel.service/);
  }finally{killAll(L);}
});

test('持久服务：旧 transient 因后台进程尚未回收时，也可迁到独立单元，后台工作继续完成',async()=>{
  const L=lifecycleHome(),port=await freePort(),old=kernelCopy(L.home,'111111111111'),next=kernelCopy(L.home,'222222222222'),mark=path.join(L.home,'busy.done');let executor=0;
  try {
    await runEnsure(L,old,port,{XIN_FAKE_FAIL:'enable'});
    executor=(await lifecycleOp(L,port,'launch',{mark})).data.pid;fs.writeFileSync(path.join(L.home,'transient-busy'),'yes');
    const r=await runEnsure(L,next,port);assert.strictEqual(r.persistent,true,JSON.stringify(r));
    assert.match(fs.readFileSync(path.join(L.home,'legacy.fragment'),'utf8'),/transient\/xin-kernel.service/);
    assert.strictEqual(fs.readFileSync(path.join(L.home,'fragment'),'utf8'),L.unit);
    for(let i=0;i<50&&!fs.existsSync(mark);i++)await sleep(50);assert.strictEqual(fs.readFileSync(mark,'utf8'),'done');
  }finally{killAll(L,executor?[executor]:[]);}
});

test('持久服务：旧 transient 还留着后台进程时，启动新版失败能恢复旧外壳并保留后台工作',async()=>{
  const L=lifecycleHome(),port=await freePort(),old=kernelCopy(L.home,'111111111111'),next=kernelCopy(L.home,'222222222222');
  try {
    await runEnsure(L,old,port,{XIN_FAKE_FAIL:'enable'});fs.writeFileSync(path.join(L.home,'transient-busy'),'yes');
    const r=await runEnsure(L,next,port,{XIN_FAKE_FAIL:'start-once'});
    assert.strictEqual(r.error,'service_failed',JSON.stringify(r));assert.strictEqual((await signedHealth(port)).kernel,'111111111111');
    assert.strictEqual(fs.existsSync(L.unit),false);assert.strictEqual(fs.existsSync(path.join(L.home,'kernel-service.pending.json')),false);
    assert.strictEqual(fs.existsSync(path.join(L.home,'transient-busy')),true);
  }finally{killAll(L);}
});

test('持久服务：并发 ensure 只启动一个实例，两次返回同一健康进程',async()=>{
  const L=lifecycleHome(),port=await freePort(),file=kernelCopy(L.home,'222222222222');
  try {
    const results=await Promise.all([runEnsure(L,file,port),runEnsure(L,file,port)]);
    assert.ok(results.every(r=>r.ok&&r.persistent));assert.strictEqual(results[0].pid,results[1].pid);
    assert.strictEqual(results.filter(r=>r.started).length,1);assert.strictEqual(results.filter(r=>r.already).length,1);
    assert.strictEqual(systemdLog(L).split('\n').filter(l=>l==='systemctl --user start xin-kernel-resident.service').length,1);
  }finally{killAll(L);}
});

test('持久服务：暂停超过旧租期也不抢活进程的启动门；进程崩溃后能重新接手',async()=>{
  const L=lifecycleHome(),port=await freePort(),file=kernelCopy(L.home,'999999999999'),lock=path.join(L.home,'locks/kernel.lock');
  fs.mkdirSync(path.dirname(lock));fs.writeFileSync(lock,String(process.pid));fs.utimesSync(lock,new Date(0),new Date(0));
  try {
    const held=await runEnsure(L,file,port);assert.strictEqual(held.error,'locked');assert.strictEqual(fs.readFileSync(lock,'utf8'),String(process.pid));assert.strictEqual(fs.existsSync(L.unit),false);
    fs.writeFileSync(lock,'2147483647');
    const recovered=await runEnsure(L,file,port);assert.strictEqual(recovered.persistent,true);assert.strictEqual(fs.existsSync(lock),false);
  }finally{killAll(L);}
});

test('持久服务：升级 start 失败恢复旧单元和启用状态，旧内核重新可用',async()=>{
  const L=lifecycleHome(),port=await freePort();
  try {
    await runEnsure(L,kernelCopy(L.home,'333333333333'),port);const before=fs.readFileSync(L.unit,'utf8');
    const result=await runEnsure(L,kernelCopy(L.home,'444444444444'),port,{XIN_FAKE_FAIL:'start-once'});
    assert.strictEqual(result.ok,false);assert.strictEqual(result.serviceError,'service_start_failed');assert.strictEqual(fs.readFileSync(L.unit,'utf8'),before);
    assert.strictEqual(fs.readFileSync(path.join(L.home,'enabled'),'utf8'),'yes');
    let health;for(let i=0;i<30;i++){try{health=await signedHealth(port);if(health.ok)break;}catch{}await sleep(50);}
    assert.strictEqual(health.kernel,'333333333333');
  }finally{killAll(L);}
});

test('持久服务：未启用的已有单元若 enable 部分成功后报错，也恢复未启用状态且不重启健康实例',async()=>{
  const L=lifecycleHome(),port=await freePort(),file=kernelCopy(L.home,'aaaaaaaaaaaa');
  try {
    const first=await runEnsure(L,file,port),before=fs.readFileSync(L.unit,'utf8');await serviceControl(L,'disable');
    const r=await runEnsure(L,file,port,{XIN_FAKE_FAIL:'enable-partial'});
    assert.strictEqual(r.pid,first.pid);assert.strictEqual(r.persistent,false);assert.strictEqual(r.serviceError,'service_enable_failed');
    assert.strictEqual(fs.existsSync(path.join(L.home,'enabled')),false);assert.strictEqual(fs.readFileSync(L.unit,'utf8'),before);
  }finally{killAll(L);}
});

for(const action of ['enable','start'])test('持久服务：安装进程在 '+action+' 前被杀后，下次启动先恢复旧配置再确认健康',async()=>{
  const L=lifecycleHome(),port=await freePort(),old=kernelCopy(L.home,'cccccccccccc'),next=kernelCopy(L.home,'dddddddddddd'),pending=path.join(L.home,'kernel-service.pending.json');
  try {
    await runEnsure(L,old,port);const before=fs.readFileSync(L.unit,'utf8');
    await assert.rejects(runEnsure(L,next,port,{XIN_FAKE_CRASH:action,XIN_ENV_PROBE:'ibk_DUMMY_SENTINEL'}),e=>e.signal==='SIGKILL');
    assert.strictEqual(fs.statSync(pending).mode&0o777,0o600);const tx=JSON.parse(fs.readFileSync(pending));
    assert.strictEqual(tx.prior,before);assert.strictEqual(tx.phase,action==='enable'?'prepared':'activation');
    assert.ok(!fs.readFileSync(pending,'utf8').includes('ibk_DUMMY_SENTINEL'));assert.ok(!systemdLog(L).includes('ibk_DUMMY_SENTINEL'));
    const recovered=await runEnsure(L,old,port);
    assert.strictEqual(recovered.persistent,true,JSON.stringify(recovered));assert.strictEqual(fs.readFileSync(L.unit,'utf8'),before);
    assert.strictEqual(fs.existsSync(pending),false);assert.strictEqual((await signedHealth(port)).kernel,'cccccccccccc');
  }finally{killAll(L);}
});

test('持久服务：记录已落盘但首次服务文件还没写入就中断，也能接续安装',async()=>{
  const L=lifecycleHome(),port=await freePort(),file=kernelCopy(L.home,'abababababab'),pending=path.join(L.home,'kernel-service.pending.json');
  fs.writeFileSync(pending,JSON.stringify({v:1,file:L.unit,prior:null,target:'# Managed by xin-kernel\n[Service]\n',enabled:false,running:false,legacyRunning:false,legacyFile:null,port,phase:'prepared'}),{mode:0o600});
  try { const r=await runEnsure(L,file,port);assert.strictEqual(r.persistent,true,JSON.stringify(r));assert.strictEqual(fs.existsSync(pending),false); }
  finally{killAll(L);}
});

test('持久服务：回退命令也失败时保留安装记录，不另起实例；用户总线恢复后可接续恢复',async()=>{
  const L=lifecycleHome(),port=await freePort(),old=kernelCopy(L.home,'eeeeeeeeeeee'),next=kernelCopy(L.home,'ffffffffffff'),pending=path.join(L.home,'kernel-service.pending.json');
  try {
    await runEnsure(L,old,port);const before=fs.readFileSync(L.unit,'utf8');
    const failed=await runEnsure(L,next,port,{XIN_FAKE_FAIL:'daemon-reload'});
    assert.strictEqual(failed.error,'service_recovery_failed');assert.ok(fs.existsSync(pending));assert.ok(!systemdLog(L).includes('systemd-run'));
    const recovered=await runEnsure(L,old,port);assert.strictEqual(recovered.persistent,true,JSON.stringify(recovered));
    assert.strictEqual(fs.readFileSync(L.unit,'utf8'),before);assert.strictEqual(fs.existsSync(pending),false);
  }finally{killAll(L);}
});

test('持久服务：启动命令成功但 HTTP 不健康时撤销安装，回退临时服务而不留下错误开机配置',async()=>{
  const L=lifecycleHome(),port=await freePort();
  try {
    const r=await runEnsure(L,kernelCopy(L.home,'777777777777'),port,{XIN_FAKE_UNHEALTHY:'1'});
    assert.strictEqual(r.ok,true);assert.strictEqual(r.persistent,false);assert.strictEqual(r.serviceError,'service_not_healthy');
    assert.strictEqual(fs.existsSync(L.unit),false);assert.strictEqual(fs.existsSync(path.join(L.home,'enabled')),false);
    assert.strictEqual((await signedHealth(port)).kernel,'777777777777');
  }finally{killAll(L);}
});

test('持久服务：不覆盖站长自己的同名单元，也不把环境秘密写进服务文件',async()=>{
  const L=lifecycleHome(),port=await freePort(),file=kernelCopy(L.home,'555555555555');
  try {
    await runEnsure(L,file,port,{XIN_ENV_PROBE:'private-probe-secret'});
    assert.ok(!fs.readFileSync(L.unit,'utf8').includes('private-probe-secret'));
    fs.writeFileSync(L.unit,'[Service]\nExecStart=/custom/service\n');
    const before=systemdLog(L),result=await runEnsure(L,file,port);
    assert.strictEqual(result.persistent,false);assert.strictEqual(result.serviceError,'service_unmanaged');
    assert.strictEqual(fs.readFileSync(L.unit,'utf8'),'[Service]\nExecStart=/custom/service\n');assert.strictEqual(systemdLog(L),before);
  }finally{killAll(L);}
});

test('持久服务：模拟用户管理器重启从磁盘单元启动，0600 环境恢复，已授权执行进程在换壳后继续完成',async()=>{
  const L=lifecycleHome(),port=await freePort(),mark=path.join(L.home,'executor.done');let executor=0;
  try {
    await runEnsure(L,kernelCopy(L.home,'666666666666'),port,{XIN_ENV_PROBE:'recovered'});
    executor=(await lifecycleOp(L,port,'launch',{mark})).data.pid;
    await serviceControl(L,'stop');await serviceControl(L,'start');
    let health;for(let i=0;i<30;i++){try{health=await signedHealth(port);if(health.ok)break;}catch{}await sleep(50);}
    assert.strictEqual(health.kernel,'666666666666');assert.deepStrictEqual((await lifecycleOp(L,port,'env')).data,{probe:'recovered'});
    for(let i=0;i<50&&!fs.existsSync(mark);i++)await sleep(50);
    assert.strictEqual(fs.readFileSync(mark,'utf8'),'done');assert.strictEqual(fs.statSync(path.join(L.home,'kernel.env.json')).mode&0o777,0o600);
  }finally{killAll(L,executor?[executor]:[]);}
});

// 正式站自动回滚到不认识持久服务的旧版时，旧版会另起临时单元占住端口，持久服务每次启动都因端口被占而退出。
// 没有上限它会每 2 秒重启一次、一直不停（真 systemd 255 上实测）；上限写在 [Unit] 里才生效。
test('持久服务：一分钟内连续起不来 10 次就停手，不会没完没了地重启', async () => {
  const { kernelServiceUnit } = await load('../site/xin/vm-kernel.mjs');
  const text = kernelServiceUnit('/home/x/.xin', 8797), unit = text.slice(text.indexOf('[Unit]'), text.indexOf('[Service]'));
  assert.match(unit, /^StartLimitIntervalSec=60$/m);
  assert.match(unit, /^StartLimitBurst=10$/m);
  assert.match(text, /^Restart=always$/m); assert.match(text, /^RestartSec=2$/m);
});

test('持久服务：特殊路径按 systemd 规则转义并实际启动；拒绝注入额外指令的换行',async()=>{
  const {kernelServiceUnit}=await load('../site/xin/vm-kernel.mjs');
  const text=kernelServiceUnit('/tmp/a b%$"\\tail',8797);
  assert.ok(text.includes('Environment="XIN_HOME=/tmp/a b%%$\\"\\\\tail"'));
  assert.throws(()=>kernelServiceUnit('/tmp/a\nExecStart=/bad',8797),/bad_service_value/);
  const L=lifecycleHome('xin k%$"-'),port=await freePort();
  try {
    const r=await runEnsure(L,kernelCopy(L.home,'888888888888'),port);
    assert.strictEqual(r.persistent,true,JSON.stringify(r));assert.strictEqual((await signedHealth(port)).kernel,'888888888888');
    if(fs.existsSync('/usr/bin/systemd-analyze'))await new Promise((ok,no)=>execFile('/usr/bin/systemd-analyze',['--user','verify','--man=no',L.unit],{env:{...process.env,XDG_RUNTIME_DIR:L.home}},e=>e?no(e):ok()));
  }finally{killAll(L);}
});

test('持久服务：旧版回滚步骤保留数据和单元备份，原临时服务启动方式仍可用',async()=>{
  const L=lifecycleHome(),port=await freePort(),file=kernelCopy(L.home,'bbbbbbbbbbbb');
  try {
    await runEnsure(L,file,port);fs.writeFileSync(path.join(L.home,'user-data'),'keep');
    await serviceControl(L,'disable');await serviceControl(L,'stop');fs.renameSync(L.unit,L.unit+'.rollback-backup');await serviceControl(L,'daemon-reload');
    const env={...process.env,XIN_HOME:L.home,XDG_CONFIG_HOME:L.config,PATH:L.bin+':'+process.env.PATH};
    await new Promise((ok,no)=>execFile(path.join(L.bin,'systemd-run'),['--user','--unit=xin-kernel','--collect','-p','KillMode=process','-p','Restart=always','-p','RestartSec=2',process.execPath,file,'serve','--port',String(port)],{env},e=>e?no(e):ok()));
    let health;for(let i=0;i<30;i++){try{health=await signedHealth(port);if(health.ok)break;}catch{}await sleep(50);}
    assert.strictEqual(health.kernel,'bbbbbbbbbbbb');assert.strictEqual(fs.existsSync(path.join(L.home,'enabled')),false);
    assert.strictEqual(fs.readFileSync(path.join(L.home,'user-data'),'utf8'),'keep');assert.ok(fs.existsSync(L.unit+'.rollback-backup'));
  }finally{killAll(L);}
});

test('日志太大就换一份，不会一直长下去', async () => {
  const f = await kernelFixture({ kernel: { logMaxBytes: 2000 } });
  try {
    for (let i = 0; i < 40; i++) await f.request('GET', '/xin/health');
    const log = path.join(f.home, 'logs', 'kernel.jsonl');
    assert.ok(fs.statSync(log).size <= 2000 + 400, '当前日志 ' + fs.statSync(log).size + ' 字节');
    assert.ok(fs.existsSync(log + '.1'), '旧的那份留一份');
  } finally { await f.k.close(); }
});
