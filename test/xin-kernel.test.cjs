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
const op = process.argv[2];
let input = ''; for await (const c of process.stdin) input += c;
const a = input ? JSON.parse(input) : {};
const count = n => { const f = process.env.XIN_HOME + '/' + n + '.count'; let k = 0; try { k = Number(fs.readFileSync(f, 'utf8')) || 0; } catch {} fs.writeFileSync(f, String(k + 1)); };
if (op === 'echo') process.stdout.write(JSON.stringify(a));
else if (op === 'slow') { await new Promise(r => setTimeout(r, a.ms || 500)); if (a.mark) fs.writeFileSync(a.mark, 'done'); process.stdout.write('{"ok":true}'); }
else if (op === 'boom') { process.stderr.write('line1\\nleak ibp_LEAKED1\\nboom happened\\n'); process.exit(1); }
else if (op === 'garbage') process.stdout.write('not json');
else if (op === 'env') process.stdout.write(JSON.stringify({ probe: process.env.XIN_ENV_PROBE || null }));
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
    r = await f.op('echo', { text: 'x'.repeat(70000) });
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
    for (const end = Date.now() + platformTimeout(3000); Date.now() < end && !s.messages.length;) await sleep(30);
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
    for (const end = Date.now() + platformTimeout(3000); Date.now() < end && !s.messages.length;) await sleep(30);
    appendEv(f, 'rstream02', { t: 'done' });
    const t0 = Date.now();
    await Promise.race([s.done, sleep(platformTimeout(2000))]);
    assert.ok(s.ended, '做完以后流要关');
    assert.ok(Date.now() - t0 < platformTimeout(1500));
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
