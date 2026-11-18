// 天启搬到 li2（docs/superpowers/specs/2026-11-18-tianqi-li2-design.md §4.1）：同一个 Worker 两个范围。
// /api/tq/* 用 li2 的 key 和电脑，小芯的 /api/xin/* 照旧；缓存按电脑分开；发给 li2 的 exec 带 XIN_ROLE=tianqi。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = rel => import(pathToFileURL(path.join(__dirname, rel)).href);
const PW = 'correct horse battery';
const XIN_KEY = 'ibk_test_key_1234567890', TQ_KEY = 'ibk_tq_key_0987654321';
const ORIGIN = 'https://liming-work.com';
const NOT_TQ = { error: 'not_in_tianqi', msg: '天启没有这个功能' };

function mkEnv(extra) {
  return Object.assign({
    OWNER_PASSWORD: PW, INSTABOX_API_KEY: XIN_KEY, XIN_MACHINE: 'li',
    XIN_LOGIN_LIMIT: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async r => {
      const p = new URL(r.url).pathname;
      if (p === '/xin/vm-agent.mjs') return new Response('// fake vm-agent\n');
      if (p === '/xin/vm-kernel.mjs') return new Response('// fake vm-kernel\n');
      return new Response('nope', { status: 404 });
    } }
  }, extra || {});
}
const tqEnv = extra => mkEnv(Object.assign({ TQ_INSTABOX_API_KEY: TQ_KEY, XIN_TQ_MACHINE: 'li2' }, extra || {}));
function req(p, opt = {}) {
  const h = Object.assign({ 'content-type': 'application/json', 'x-xin': '1', origin: ORIGIN }, opt.headers || {});
  return new Request(ORIGIN + p, { method: opt.method || 'POST', headers: h, body: opt.body === undefined ? undefined : JSON.stringify(opt.body) });
}
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
async function fresh() { const m = await load('../src/xin.js'); m._reset(); return m; }
async function login(m, env) {
  const r = await m.handleXin(req('/api/xin/login', { body: { password: PW } }), env, null);
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}
// 假的 InstaBox：按请求头 X-API-Key 认是哪个账号，记下每个请求
const ACCOUNTS = { [XIN_KEY]: [{ id: 'm_li', name: 'li', state: 'running' }], [TQ_KEY]: [{ id: 'm_li2', name: 'li2', state: 'running' }] };
function fakeIB(handler) {
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), c = { method: init.method || 'GET', path: u.pathname, key: (init.headers || {})['X-API-Key'], raw: init.body };
    Object.defineProperty(c, 'json', { get() { try { return JSON.parse(c.raw); } catch { return null; } } });
    calls.push(c);
    if (c.method === 'GET' && c.path === '/v1/machines') return json({ machines: ACCOUNTS[c.key] || [] });
    return handler(c, u, init);
  };
  return { calls, restore() { globalThis.fetch = real; } };
}
const execs = calls => calls.filter(c => c.path.endsWith('/exec'));

test('没配天启 key：/api/tq/me 回 enabled:false、authed 跟小芯是同一个登录；别的接口都回「天启还没配好」，一个 InstaBox 请求都不发', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const ib = fakeIB(() => { throw new Error('不该调 InstaBox'); });
  try {
    const me = await (await m.handleXin(new Request(ORIGIN + '/api/tq/me', { headers: { cookie: ck } }), env, null)).json();
    assert.deepEqual(me, { enabled: false, authed: true });
    const w = (await load('../src/worker.js')).default;
    assert.deepEqual(await (await w.fetch(new Request(ORIGIN + '/api/tq/me'), env, null)).json(), { enabled: false, authed: false }, 'Worker 把 /api/tq 交给 handleXin');
    const blocked = [
      req('/api/tq/call', { body: { op: 'sessions' }, headers: { cookie: ck } }),
      new Request(ORIGIN + '/api/tq/file?path=/data/workspace/a', { headers: { cookie: ck } }),
      new Request(ORIGIN + '/api/tq/upload?name=a.txt', { method: 'POST', headers: { cookie: ck, 'x-xin': '1', origin: ORIGIN, 'content-length': '1' }, body: 'x' })
    ];
    for (const r of blocked) {
      const res = await m.handleXin(r, env, null);
      assert.equal(res.status, 404, r.url);
      assert.deepEqual(await res.json(), { error: 'disabled', msg: '天启还没配好' }, r.url);
    }
    assert.equal(ib.calls.length, 0);
  } finally { ib.restore(); }
});

test('配了 key：/api/tq 用 li2 的 key 找 li2，exec 带 XIN_ROLE=tianqi；/api/xin 照旧用 li 的 key，请求体不带 envs', async () => {
  const m = await fresh(), env = tqEnv(), ck = await login(m, env);
  const ib = fakeIB(c => c.path.endsWith('/exec') ? json({ exitCode: 0, stdout: c.json.argv[0] === 'sha256sum' ? '' : JSON.stringify({ sessions: [] }), stderr: '' }) : json({ error: { code: 'unexpected' } }, 500));
  try {
    const waits = [], ctx = { waitUntil: p => waits.push(p) };
    const tq = await (await m.handleXin(req('/api/tq/call', { body: { op: 'sessions' }, headers: { cookie: ck } }), env, ctx)).json();
    assert.deepEqual(tq, { ok: true, data: { sessions: [] } });
    await Promise.all(waits);
    const tqExec = execs(ib.calls);
    for (const c of tqExec) { assert.equal(c.path, '/v1/machines/m_li2/exec'); assert.equal(c.key, TQ_KEY); }
    assert.deepEqual(tqExec.find(c => c.json.argv[0] === 'node').json.envs, { XIN_ROLE: 'tianqi' });
    assert.ok(tqExec.some(c => c.json.argv[0] === 'sha256sum'), '天启打开对话列表时顺手核对 li2 上的脚本');
    ib.calls.length = 0;
    const xin = await (await m.handleXin(req('/api/xin/call', { body: { op: 'sessions' }, headers: { cookie: ck } }), env, null)).json();
    assert.equal(xin.ok, true);
    const xinExec = execs(ib.calls);
    assert.equal(xinExec.length, 1);
    assert.deepEqual([xinExec[0].path, xinExec[0].key, 'envs' in xinExec[0].json], ['/v1/machines/m_li/exec', XIN_KEY, false]);
  } finally { ib.restore(); }
});

test('天启范围里小芯专属的操作回「天启没有这个功能」，不碰电脑', async () => {
  const m = await fresh(), env = tqEnv(), ck = await login(m, env);
  const ib = fakeIB(() => { throw new Error('不该调 InstaBox'); });
  try {
    for (const op of ['greet', 'daily', 'tasks', 'task_tell', 'memory_list', 'push_key', 'bond', 'moves', 'screen', 'logins', 'plugins', 'learning_report']) {
      const r = await m.handleXin(req('/api/tq/call', { body: { op }, headers: { cookie: ck } }), env, null);
      assert.equal(r.status, 400, op);
      assert.deepEqual(await r.json(), NOT_TQ, op);
    }
    for (const [p, method] of [['/api/tq/backups', 'GET'], ['/api/tq/backup', 'POST'], ['/api/tq/task-event', 'POST']]) {
      const r = await m.handleXin(req(p, { method, body: method === 'POST' ? {} : undefined, headers: { cookie: ck } }), env, null);
      assert.equal(r.status, 404, p);
      assert.deepEqual(await r.json(), NOT_TQ, p);
    }
    assert.equal(ib.calls.length, 0);
  } finally { ib.restore(); }
});

test('两边交替请求：电脑列表各查一次，不互相冲掉', async () => {
  const m = await fresh(), env = tqEnv(), ck = await login(m, env);
  const ib = fakeIB(() => json({ exitCode: 0, stdout: '{"sessions":[]}', stderr: '' }));
  try {
    for (const p of ['/api/tq/call', '/api/xin/call', '/api/tq/call', '/api/xin/call']) {
      const d = await (await m.handleXin(req(p, { body: { op: 'sessions' }, headers: { cookie: ck } }), env, null)).json();
      assert.equal(d.ok, true, p);
    }
    assert.equal(ib.calls.filter(c => c.path === '/v1/machines').length, 2);
  } finally { ib.restore(); }
});

test('ensure 按电脑节流，天启的 ensure 带身份', async () => {
  const m = await fresh(), env = tqEnv();
  const ib = fakeIB(() => json({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));
  try {
    const waits = [], ctx = { waitUntil: p => waits.push(p) };
    m._ensureKernel(env, ORIGIN, 'm_li', ctx);
    m._ensureKernel(m.scopeEnv(env, 'tq'), ORIGIN, 'm_li2', ctx);
    m._ensureKernel(env, ORIGIN, 'm_li', ctx);   // 60 秒内同一台：不再跑
    await Promise.all(waits);
    const ens = execs(ib.calls).filter(c => c.json.argv[2] === 'ensure');
    assert.deepEqual(ens.map(c => c.path), ['/v1/machines/m_li/exec', '/v1/machines/m_li2/exec']);
    assert.equal('envs' in ens[0].json, false);
    assert.deepEqual([ens[1].key, ens[1].json.envs], [TQ_KEY, { XIN_ROLE: 'tianqi' }]);
  } finally { ib.restore(); }
});

test('内核配置按电脑分开缓存：小芯的在 xin-inbox，天启的在 tq-inbox', async () => {
  const m = await fresh(), seen = [];
  const sup = { idFromName: n => n, get: name => ({ fetch: async url => { seen.push([name, new URL(url).pathname]); return json({ kid: 'k1', installedKid: 'k1', token: 't', keys: {} }); } }) };
  const env = tqEnv({ XIN_TASK_SUPERVISOR: sup });
  await m._workerKernel(env).get('m_li');
  await m._workerKernel(m.scopeEnv(env, 'tq')).get('m_li2');
  await m._workerKernel(env).get('m_li');   // 5 分钟内同一台：用缓存
  assert.deepEqual(seen, [['xin-inbox', '/kernel/config'], ['tq-inbox', '/kernel/config']]);
});

// Durable Object 的存储（照 test/xin-inbox.test.cjs 的 memStorage，只留用得到的）
function memStorage() {
  const values = new Map(), s = { values, alarm: null };
  Object.assign(s, {
    get: async k => structuredClone(values.get(k)),
    put: async (k, v) => { values.set(k, structuredClone(v)); },
    delete: async k => { for (const x of [].concat(k)) values.delete(x); },
    list: async ({ prefix } = {}) => new Map([...values].filter(([k]) => !prefix || k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
    setAlarm: async t => { s.alarm = t; },
    getAlarm: async () => s.alarm,
    deleteAlarm: async () => { s.alarm = null; }
  });
  return s;
}
// InstaBox 一直忙：只记下每次用的是哪把 key
function busyIB() {
  const keys = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { keys.push((init.headers || {})['X-API-Key']); return json({ error: { code: 'busy' } }, 503); };
  return { keys, restore() { globalThis.fetch = real; } };
}
const accept = (o, headers, id) => o.fetch(new Request('https://xin.internal/inbox/accept', { method: 'POST', headers, body: JSON.stringify({ id, op: 'send', args: { text: '你好' } }) }));

test('天启的待送达：存进 tq-inbox，送的时候用 li2 的 key；闹钟在新实例里醒来也一样', async () => {
  const { XinTaskSupervisor } = await fresh(), ib = busyIB();
  try {
    const storage = memStorage(), env = tqEnv();
    const r = await accept(new XinTaskSupervisor({ storage, waitUntil() {} }, env), { 'x-xin-scope': 'tq' }, 'cid-tq000001');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).view.state, 'pending');
    const realNow = Date.now;   // 十分钟以后（退避早过了），新的 isolate 里闹钟醒来：没有请求告诉它是谁
    Date.now = () => realNow() + 600000;
    try { await new XinTaskSupervisor({ storage, waitUntil() {} }, env).alarm(); } finally { Date.now = realNow; }
    assert.ok(ib.keys.length >= 2, '闹钟又送了一次：' + ib.keys.length);
    assert.deepEqual([...new Set(ib.keys)], [TQ_KEY]);
    assert.equal(storage.values.get('scope'), 'tq');
  } finally { ib.restore(); }
});

test('老的小芯实例（没存范围）照旧；范围对不上回 409', async () => {
  const { XinTaskSupervisor } = await fresh(), ib = busyIB();
  try {
    const env = tqEnv(), old = memStorage();
    assert.equal((await accept(new XinTaskSupervisor({ storage: old, waitUntil() {} }, env), {}, 'cid-xin00001')).status, 200);
    assert.deepEqual([...new Set(ib.keys)], [XIN_KEY]);
    assert.equal(old.values.has('scope'), false, '老实例不写新字段');
    const bad = await accept(new XinTaskSupervisor({ storage: old, waitUntil() {} }, env), { 'x-xin-scope': 'tq' }, 'cid-tq000002');
    assert.deepEqual([bad.status, await bad.json()], [409, { error: 'scope_mismatch' }]);
    const tq = memStorage(); tq.values.set('scope', 'tq');
    const bad2 = await accept(new XinTaskSupervisor({ storage: tq, waitUntil() {} }, env), {}, 'cid-xin00002');
    assert.deepEqual([bad2.status, await bad2.json()], [409, { error: 'scope_mismatch' }]);
  } finally { ib.restore(); }
});

test('Worker 发给 Durable Object 的请求：天启带 x-xin-scope: tq、实例名 tq-inbox；小芯不带头、实例名 xin-inbox', async () => {
  const m = await fresh(), seen = [];
  const sup = { idFromName: n => n, get: name => ({ fetch: async (url, init = {}) => {
    seen.push([name, new URL(url).pathname, new Headers(init.headers).get('x-xin-scope')]);
    return json({ view: { id: 'cid-00000001', state: 'delivered', result: { sid: 's1', run: 'r1' } } });
  } }) };
  const env = tqEnv({ XIN_TASK_SUPERVISOR: sup, XIN_INBOX: '1' }), ck = await login(m, env);
  for (const p of ['/api/tq/call', '/api/xin/call']) {
    const d = await (await m.handleXin(req(p, { body: { op: 'send', args: { text: '你好', clientId: 'cid-00000001' } }, headers: { cookie: ck } }), env, null)).json();
    assert.deepEqual(d, { ok: true, data: { sid: 's1', run: 'r1' } }, p);
  }
  assert.deepEqual(seen, [['tq-inbox', '/inbox/accept', 'tq'], ['xin-inbox', '/inbox/accept', null]]);
});

test('8:55：先叫醒 li、再叫醒 li2；没配天启不碰 li2；li2 出错不改小芯那次的结果；9:10 的每日任务不碰 li2', async () => {
  const m = await fresh();
  // 两台都在睡：查电脑回 suspended，resume 回 202；li2 出错时它那把 key 的请求一律 500；busy 时一律 503
  const run = async (cron, env, mode) => {
    m._reset();
    const calls = [], real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url), key = (init.headers || {})['X-API-Key'], method = init.method || 'GET';
      calls.push([method, u.pathname, key]);
      if (mode === 'busy') return json({ error: { code: 'busy' } }, 503);
      if (mode === 'tq-broken' && key === TQ_KEY) return json({ error: { code: 'internal' } }, 500);
      if (method === 'GET' && u.pathname === '/v1/machines') return json({ machines: ACCOUNTS[key] || [] });
      if (method === 'GET' && /^\/v1\/machines\/m_li2?$/.test(u.pathname)) return json({ state: 'suspended' });
      if (method === 'POST' && u.pathname.endsWith('/resume')) return json({}, 202);
      throw new Error('意外的请求 ' + method + ' ' + u.pathname);
    };
    try { return { r: await m.runCron(cron, env, { waitUntil() {} }, { wait: async () => {} }), calls }; }
    finally { globalThis.fetch = real; }
  };
  const only = await run(m.CRON_WAKE, mkEnv());
  assert.deepEqual(only.r, { ok: true, data: { state: 'suspended', action: 'resume' } });
  assert.ok(only.calls.every(c => c[2] === XIN_KEY), '没配天启：不碰 li2');
  const both = await run(m.CRON_WAKE, tqEnv());
  assert.deepEqual(both.r, only.r);
  assert.deepEqual(both.calls.filter(c => c[1].endsWith('/resume')).map(c => c[1]), ['/v1/machines/m_li/resume', '/v1/machines/m_li2/resume']);
  const broken = await run(m.CRON_WAKE, tqEnv(), 'tq-broken');
  assert.deepEqual(broken.r, only.r);
  assert.ok(broken.calls.some(c => c[2] === TQ_KEY), '试过叫醒 li2');
  const daily = await run(m.CRON_DAILY, tqEnv(), 'busy');
  assert.ok(daily.calls.length > 0 && daily.calls.every(c => c[2] === XIN_KEY), '每日任务只是小芯的');
});
