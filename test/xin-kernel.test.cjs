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
  const file = process.env.XIN_HOME + '/runs/' + a.run + '.jsonl';
  let lines = []; try { lines = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean); } catch {}
  const off = a.off | 0, evs = lines.slice(off).map(l => JSON.parse(l));
  process.stdout.write(JSON.stringify({ events: evs, off: off + evs.length, pos: (off + evs.length) * 10, done: evs.some(e => e.t === 'done') }));
}
else if (op === 'bad_poll') process.stdout.write(JSON.stringify({ error: 'no_run', msg: '找不到这一轮' }));
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
