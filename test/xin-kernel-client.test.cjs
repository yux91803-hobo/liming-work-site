// 小芯内核：Worker 这一侧（src/xin-kernel.js）——Durable Object 里的内核配置、请求结果分类。
// 设计见 docs/xin-kernel-design.md §4.2、§14.2、§14.5。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = rel => import(pathToFileURL(path.join(__dirname, rel)).href);
const DAY = 86400e3, T0 = 1794550000000;

function memStorage() {
  const m = new Map();
  return { m, get: async k => m.get(k), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => m.delete(k) };
}
function fakePorts() {
  const calls = []; let n = 0;
  const ib = async (p, init = {}) => {
    calls.push({ path: p, method: init.method, body: init.body && JSON.parse(init.body) });
    n++;
    return new Response(JSON.stringify({ port: 8797, access: 'private', url: 'https://8797-abc.instabox.tech', token: 'ibp_tok' + n }), { status: 201 });
  };
  return { ib, calls };
}
async function store(o = {}) {
  const { KernelConfigStore } = await load('../src/xin-kernel.js');
  const storage = o.storage || memStorage(), ports = o.ports || fakePorts();
  let now = o.now || T0;
  let r = 0; const random = n => Uint8Array.from({ length: n }, () => (r++ % 251) + 1);
  const s = new KernelConfigStore(storage, { ib: ports.ib, now: () => now, random });
  return { s, storage, ports, setNow: t => { now = t; } };
}

test('第一次 get：发布私有端口（换新令牌）、生成钥匙，还没装到电脑上', async () => {
  const { s, ports } = await store();
  const c = await s.get({ machineId: 'm_abc' });
  assert.deepStrictEqual(ports.calls, [{ path: '/v1/machines/m_abc/ports', method: 'POST', body: { port: 8797, name: 'xin-kernel', access: 'private', rotateToken: true } }]);
  assert.strictEqual(c.url, 'https://8797-abc.instabox.tech');
  assert.strictEqual(c.token, 'ibp_tok1');
  assert.match(c.kid, /^k[0-9a-f]{10}$/);
  assert.strictEqual(Buffer.from(c.key, 'base64url').length, 32);
  assert.deepStrictEqual(Object.keys(c.keys), [c.kid]);
  assert.strictEqual(c.installedKid, null);
});

test('第二次 get 不再调 InstaBox；同时来的两个 get 也只发布一次', async () => {
  const { s, ports } = await store();
  const [a, b] = await Promise.all([s.get({ machineId: 'm_abc' }), s.get({ machineId: 'm_abc' })]);
  assert.strictEqual(a.token, b.token);
  await s.get({ machineId: 'm_abc' });
  assert.strictEqual(ports.calls.length, 1);
});

test('30 天后换钥匙，旧的留着；再过 30 天最老的那把没了', async () => {
  const { s, setNow } = await store();
  const c1 = await s.get({ machineId: 'm_abc' });
  await s.markInstalled(c1.kid);
  setNow(T0 + 31 * DAY);
  const c2 = await s.get({ machineId: 'm_abc' });
  assert.notStrictEqual(c2.kid, c1.kid);
  assert.deepStrictEqual(Object.keys(c2.keys).sort(), [c1.kid, c2.kid].sort());
  assert.strictEqual(c2.installedKid, c1.kid, '新钥匙还没装上');
  setNow(T0 + 62 * DAY);
  const c3 = await s.get({ machineId: 'm_abc' });
  assert.deepStrictEqual(Object.keys(c3.keys).sort(), [c2.kid, c3.kid].sort());
});

test('令牌 30 天换一次；作废后换新的；拿旧令牌来作废不会白换', async () => {
  const { s, ports, setNow } = await store();
  const c1 = await s.get({ machineId: 'm_abc' });
  await s.invalidateToken(c1.token);
  const c2 = await s.get({ machineId: 'm_abc' });
  assert.strictEqual(c2.token, 'ibp_tok2');
  await s.invalidateToken('ibp_tok1');   // 别的 isolate 还拿着旧令牌：不再换
  assert.strictEqual((await s.get({ machineId: 'm_abc' })).token, 'ibp_tok2');
  setNow(T0 + 31 * DAY);
  assert.strictEqual((await s.get({ machineId: 'm_abc' })).token, 'ibp_tok3');
  assert.strictEqual(ports.calls.length, 3);
});

test('机器换了：换令牌，已装的钥匙作废', async () => {
  const { s, ports } = await store();
  const c1 = await s.get({ machineId: 'm_abc' }); await s.markInstalled(c1.kid);
  const c2 = await s.get({ machineId: 'm_xyz' });
  assert.strictEqual(ports.calls.at(-1).path, '/v1/machines/m_xyz/ports');
  assert.notStrictEqual(c2.token, c1.token);
  assert.strictEqual(c2.installedKid, null);
});

test('发布端口失败：抛出 InstaBox 的错误，不存半套配置', async () => {
  const ib = async () => new Response(JSON.stringify({ error: { code: 'machine_cooldown', retryAfterSeconds: 60 } }), { status: 409 });
  const storage = memStorage();
  const { s } = await store({ storage, ports: { ib, calls: [] } });
  await assert.rejects(s.get({ machineId: 'm_abc' }), e => e.status === 409);
  assert.ok(!storage.m.get('kernel:config')?.token);
});

/* ---------- 请求和结果分类（§14.2） ---------- */
const CONFIG = { url: 'https://8797-abc.instabox.tech', token: 'ibp_tok1', kid: 'k0123456789', key: Buffer.alloc(32, 3).toString('base64url') };
const AGENT = '/data/home/.xin/agent/vm-agent-0123456789ab.mjs';
const K = { 'x-xin-kernel': '0123456789ab' };
const resp = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
async function classify(response) {
  const { kernelRequest } = await load('../src/xin-kernel.js');
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); if (response instanceof Error) throw response; return response; };
  const r = await kernelRequest({ config: CONFIG, agentPath: AGENT, op: 'history', args: { sid: 's1' }, fetchImpl });
  return { r, seen };
}

test('分类：有内核头的三种', async () => {
  assert.deepStrictEqual((await classify(resp(200, { ok: true, data: { a: 1 } }, K))).r, { kind: 'ok', data: { a: 1 } });
  assert.deepStrictEqual((await classify(resp(200, { ok: false, executed: true, error: 'agent_failed', msg: 'x' }, K))).r, { kind: 'executed_error', error: 'agent_failed', msg: 'x' });
  assert.deepStrictEqual((await classify(resp(409, { ok: false, executed: false, error: 'agent_missing' }, K))).r, { kind: 'not_sent', reason: 'agent_missing' });
  assert.deepStrictEqual((await classify(resp(503, { ok: false, executed: false, error: 'kernel_busy' }, K))).r, { kind: 'not_sent', reason: 'kernel_busy' });
  assert.deepStrictEqual((await classify(resp(401, { ok: false, executed: false, error: 'kernel_auth', reason: 'unknown_kid' }, K))).r, { kind: 'not_sent', reason: 'unknown_kid' });
  assert.deepStrictEqual((await classify(resp(401, { ok: false, executed: false, error: 'kernel_auth', reason: 'replay' }, K))).r, { kind: 'not_sent', reason: 'kernel_auth' });
});

test('分类：没有内核头的是 InstaBox 自己回的', async () => {
  assert.deepStrictEqual((await classify(resp(401, 'This URL is private'))).r, { kind: 'not_sent', reason: 'gate_auth' });
  assert.deepStrictEqual((await classify(resp(403, 'token is not valid'))).r, { kind: 'not_sent', reason: 'gate_auth' });
  assert.deepStrictEqual((await classify(resp(503, 'waking', { 'retry-after': '5' }))).r, { kind: 'not_sent', reason: 'waking', retryAfter: 5 });
  assert.deepStrictEqual((await classify(resp(409, { error: { code: 'machine_cooldown', retryAfterSeconds: 420 } }))).r, { kind: 'not_sent', reason: 'cooldown', retryAfter: 420 });
  assert.deepStrictEqual((await classify(resp(502, 'The sandbox service disconnected'))).r, { kind: 'unknown', reason: 'http_502' });
  assert.deepStrictEqual((await classify(resp(504, 'timeout'))).r, { kind: 'unknown', reason: 'http_504' });
  assert.deepStrictEqual((await classify(new TypeError('fetch failed'))).r, { kind: 'unknown', reason: 'network' });
  // 内核头在但回应体坏了：也不知道执行没有
  assert.deepStrictEqual((await classify(resp(200, 'garbage', K))).r, { kind: 'unknown', reason: 'bad_kernel_reply' });
});

test('请求：带端口令牌和第二层签名，内核认得', async () => {
  const kernel = await load('../site/xin/vm-kernel.mjs');
  const { seen } = await classify(resp(200, { ok: true, data: {} }, K));
  const { url, init } = seen[0];
  assert.strictEqual(url, CONFIG.url + '/xin/op');
  assert.strictEqual(init.method, 'POST');
  assert.strictEqual(init.headers.authorization, 'Bearer ibp_tok1');
  assert.deepStrictEqual(JSON.parse(init.body), { agent: AGENT, op: 'history', args: { sid: 's1' } });
  const keys = new Map([[CONFIG.kid, Buffer.from(CONFIG.key, 'base64url')]]);
  const v = kernel.verifyRequest({ method: 'POST', target: '/xin/op', header: init.headers['x-xin-auth'], body: init.body, keys, nonces: new kernel.NonceStore(':memory:'), now: Date.now() });
  assert.deepStrictEqual(v, { ok: true, kid: CONFIG.kid });
});

test('能安全重来的操作：只读的，或者带编号由控制器去重的', async () => {
  const { retrySafe } = await load('../src/xin-kernel.js');
  assert.strictEqual(retrySafe('history', {}), true);
  assert.strictEqual(retrySafe('poll', { run: 'r1' }), true);
  assert.strictEqual(retrySafe('send', { clientId: 'abcdefgh1' }), true);
  assert.strictEqual(retrySafe('task_tell', { clientId: 'abcdefgh1' }), true);
  assert.strictEqual(retrySafe('send', {}), false);
  assert.strictEqual(retrySafe('steer', { clientId: 'short' }), false);
  assert.strictEqual(retrySafe('memory_add', { clientId: 'abcdefgh1' }), false);
  assert.strictEqual(retrySafe('forget', {}), false);
});
