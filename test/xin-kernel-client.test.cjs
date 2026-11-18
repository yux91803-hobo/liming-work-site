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
  const s = new KernelConfigStore(storage, { ib: ports.ib, now: () => now, random, ...('deploy' in o ? { deploy: o.deploy } : {}), ...('mode' in o ? { mode: o.mode } : {}) });
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

test('部署代号：同一部署不变；换了部署（包括回滚到旧版本号）加一；期望固定是常驻进程模式（删旧模式第 2 步去掉了 XIN_STATE_OWNER）', async () => {
  const storage = memStorage();
  const a = await store({ storage, deploy: 'v1' });
  assert.deepStrictEqual((await a.s.get({ machineId: 'm1' })).owner, { mode: 'kernel', gen: 1 }, '不用再配开关');
  assert.deepStrictEqual((await a.s.get({ machineId: 'm1' })).owner, { mode: 'kernel', gen: 1 }, '同一部署不变');
  const b = await store({ storage, deploy: 'v2' });
  assert.deepStrictEqual((await b.s.get({ machineId: 'm1' })).owner, { mode: 'kernel', gen: 2 });
  const c = await store({ storage, deploy: 'v1', mode: 'legacy' });
  assert.deepStrictEqual((await c.s.get({ machineId: 'm1' })).owner, { mode: 'kernel', gen: 3 }, '回滚到旧版本号也是一次新部署；传进来的旧模式不认');
  assert.deepStrictEqual(storage.m.get('kernel-owner'), { deploy: 'v1', gen: 3 });
  assert.deepStrictEqual((await (await store()).s.get({ machineId: 'm1' })).owner, { mode: 'kernel', gen: 1 }, '默认部署 dev');
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
  assert.deepStrictEqual((await classify(resp(200, { ok: true, data: { a: 1 } }, K))).r, { kind: 'ok', data: { a: 1 }, version: '0123456789ab' });
  assert.deepStrictEqual((await classify(resp(200, { ok: false, executed: true, error: 'agent_failed', msg: 'x' }, K))).r, { kind: 'executed_error', error: 'agent_failed', msg: 'x', version: '0123456789ab' });
  assert.deepStrictEqual((await classify(resp(409, { ok: false, executed: false, error: 'agent_missing' }, K))).r, { kind: 'not_sent', reason: 'agent_missing', version: '0123456789ab' });
  assert.deepStrictEqual((await classify(resp(503, { ok: false, executed: false, error: 'kernel_busy' }, K))).r, { kind: 'not_sent', reason: 'kernel_busy', version: '0123456789ab' });
  assert.deepStrictEqual((await classify(resp(401, { ok: false, executed: false, error: 'kernel_auth', reason: 'unknown_kid' }, K))).r, { kind: 'not_sent', reason: 'unknown_kid', version: '0123456789ab' });
  assert.deepStrictEqual((await classify(resp(401, { ok: false, executed: false, error: 'kernel_auth', reason: 'replay' }, K))).r, { kind: 'not_sent', reason: 'kernel_auth', version: '0123456789ab' });
});

test('分类：主人暂时不在算没执行（带 retryAfter）；成功带上主人状态和耗时；不确定带上原因', async () => {
  const owner = { want: 'kernel', mode: 'kernel', epoch: 3, phase: 'running' }, ops = { all: { n: 1, p50: 2, p95: 2, max: 2 }, byOp: {} };
  assert.deepStrictEqual((await classify(resp(503, { ok: false, executed: false, error: 'owner_unavailable', retryAfter: 5, owner }, K))).r, { kind: 'not_sent', reason: 'owner_unavailable', retryAfter: 5, version: '0123456789ab' });
  assert.deepStrictEqual((await classify(resp(503, { ok: false, executed: false, error: 'owner_unavailable' }, K))).r, { kind: 'not_sent', reason: 'owner_unavailable', retryAfter: 3, version: '0123456789ab' });
  assert.deepStrictEqual((await classify(resp(200, { ok: true, data: { a: 1 }, owner }, K))).r, { kind: 'ok', data: { a: 1 }, version: '0123456789ab', owner });
  assert.deepStrictEqual((await classify(resp(200, { ok: true, data: { a: 1 }, owner, ops }, K))).r, { kind: 'ok', data: { a: 1 }, version: '0123456789ab', owner, ops });
  assert.deepStrictEqual((await classify(resp(200, { ok: false, executed: 'unknown', error: 'agent_timeout' }, K))).r, { kind: 'unknown', reason: 'agent_timeout', version: '0123456789ab' });
  assert.deepStrictEqual((await classify(resp(200, { ok: false, executed: 'unknown', error: 'state_disconnected' }, K))).r, { kind: 'unknown', reason: 'state_disconnected', version: '0123456789ab' });
  assert.deepStrictEqual((await classify(resp(200, { ok: false, executed: 'unknown', error: { x: 1 } }, K))).r, { kind: 'unknown', reason: 'bad_kernel_reply', version: '0123456789ab' }, '原因不是短代号就不照抄');
});

test('请求：有期望就放进请求体，没有就不带', async () => {
  const { kernelRequest } = await load('../src/xin-kernel.js');
  const seen = [], fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body)); return resp(200, { ok: true, data: {} }, K); };
  await kernelRequest({ config: CONFIG, agentPath: AGENT, op: 'usage', args: {}, owner: { mode: 'kernel', gen: 4 }, fetchImpl });
  await kernelRequest({ config: CONFIG, agentPath: AGENT, op: 'usage', args: {}, fetchImpl });
  assert.deepStrictEqual(seen, [{ agent: AGENT, op: 'usage', args: {}, owner: { mode: 'kernel', gen: 4 } }, { agent: AGENT, op: 'usage', args: {} }]);
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
  assert.deepStrictEqual((await classify(resp(200, 'garbage', K))).r, { kind: 'unknown', reason: 'bad_kernel_reply', version: '0123456789ab' });
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

test('能安全重来的操作：本身重做无害的 stop、daily（控制器按轮次、按日期认得出做过了）', async () => {
  const { retrySafe } = await load('../src/xin-kernel.js');
  assert.strictEqual(retrySafe('stop', { run: 'rabc1234' }), true);
  assert.strictEqual(retrySafe('daily', {}), true);
  assert.strictEqual(retrySafe('daily', { force: true }), true);
  assert.strictEqual(retrySafe('memory_add', {}), false);
  assert.strictEqual(retrySafe('bond_play', {}), false);
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

// 第 2 批（docs/superpowers/plans/2026-11-15-xin-state-owner-switch.md Task 1）：设计 §6.2「交不过去（主人正在接手、还没开始听），稍等再按表重新判断」
test('retryUnsent：确定没执行的稍等再判断；不确定的不重来；过了期限照常抛', async () => {
  const { retryUnsent } = await load('../site/xin/vm-kernel-client.mjs');
  let t = 0; const sleeps = [], clock = () => t, sleep = ms => { sleeps.push(ms); t += ms; };
  const fail = (code, executed) => Object.assign(new Error(code), { code, executed });
  let n = 0;
  assert.strictEqual(retryUnsent(() => { if (++n < 3) throw fail('owner_unavailable', false); return 'ok'; }, { clock, sleep }), 'ok');
  assert.strictEqual(n, 3); assert.deepStrictEqual(sleeps, [50, 100]);
  for (const [code, executed] of [['state_timeout', 'unknown'], ['state_request', false], ['state_too_large', false], ['state_protocol', false]]) {
    n = 0;
    assert.throws(() => retryUnsent(() => { n++; throw fail(code, executed); }, { clock, sleep }), e => e.code === code);
    assert.strictEqual(n, 1, code);
  }
  n = 0;
  assert.throws(() => retryUnsent(() => { n++; throw new Error('boom'); }, { clock, sleep }), /boom/);
  assert.strictEqual(n, 1, '不是桥的失败：不重来');
  n = 0; t = 0; sleeps.length = 0;
  assert.throws(() => retryUnsent(() => { n++; throw fail('owner_unavailable', false); }, { deadlineMs: 300, clock, sleep }), e => e.code === 'owner_unavailable');
  assert.ok(t >= 300, '等满期限：' + t); assert.ok(n > 2, String(n));
  assert.deepStrictEqual(sleeps.slice(0, 2), [50, 100]); assert.ok(sleeps.every(ms => ms > 0 && ms <= 1000), String(sleeps));
});
