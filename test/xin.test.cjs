// 小芯聊天：Worker 登录 / 转发 InstaBox，以及 vm-agent 把 Claude Code / Codex 的输出整理成事件
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = rel => import(pathToFileURL(path.join(__dirname, rel)).href);
const PW = 'correct horse battery';
const AGENT_TEXT = '// fake vm-agent\n';
const ORIGIN = 'https://liming-work.com';

function mkEnv(extra) {
  return Object.assign({
    OWNER_PASSWORD: PW,
    INSTABOX_API_KEY: 'ibk_test_key_1234567890',
    XIN_MACHINE: 'li',
    ASSETS: { fetch: async req => new URL(req.url).pathname === '/xin/vm-agent.mjs' ? new Response(AGENT_TEXT) : new Response('nope', { status: 404 }) }
  }, extra || {});
}
function req(p, opt = {}) {
  const h = Object.assign({ 'content-type': 'application/json', 'x-xin': '1', origin: ORIGIN }, opt.headers || {});
  return new Request(ORIGIN + p, { method: opt.method || 'POST', headers: h, body: opt.body === undefined ? undefined : JSON.stringify(opt.body) });
}
async function fresh() { const m = await load('../src/xin.js'); m._reset(); return m; }
async function login(m, env) {
  const r = await m.handleXin(req('/api/xin/login', { body: { password: PW } }), env, null);
  assert.strictEqual(r.status, 200);
  const sc = r.headers.get('set-cookie');
  return sc.split(';')[0];
}

// 假的 InstaBox：按 [方法 路径] 依次返回
function fakeIB(routes) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), key = (init.method || 'GET') + ' ' + u.pathname;
    calls.push({ key, url: u, init, body: init.body });
    const list = routes[key];
    if (!list || !list.length) throw new Error('意外的请求 ' + key);
    const h = list.length > 1 ? list.shift() : list[0];
    return typeof h === 'function' ? h(u, init) : new Response(JSON.stringify(h.body), { status: h.status || 200 });
  };
  return { calls, restore() { globalThis.fetch = real; } };
}
const MACHINES = { body: { machines: [{ id: 'm_abc', name: 'li', state: 'running' }] } };

test('没配密钥：功能关着，/me 报 enabled=false，登录 404', async () => {
  const m = await fresh();
  const env = mkEnv({ OWNER_PASSWORD: undefined });
  const me = await (await m.handleXin(new Request(ORIGIN + '/api/xin/me'), env, null)).json();
  assert.deepStrictEqual(me, { enabled: false, authed: false });
  const r = await m.handleXin(req('/api/xin/login', { body: { password: 'x' } }), env, null);
  assert.strictEqual(r.status, 404);
});

test('密码太短（少于 12 位）也当没配', async () => {
  const m = await fresh();
  assert.strictEqual(m.enabled(mkEnv({ OWNER_PASSWORD: 'short' })), false);
  assert.strictEqual(m.enabled(mkEnv()), true);
});

test('登录：跨站、缺头、密码错都拒绝；对了发 cookie', async () => {
  const m = await fresh(), env = mkEnv();
  assert.strictEqual((await m.handleXin(req('/api/xin/login', { body: { password: PW }, headers: { origin: 'https://evil.example' } }), env, null)).status, 403);
  assert.strictEqual((await m.handleXin(req('/api/xin/login', { body: { password: PW }, headers: { 'x-xin': '' } }), env, null)).status, 403);
  assert.strictEqual((await m.handleXin(req('/api/xin/login', { body: { password: PW }, headers: { 'content-type': 'text/plain' } }), env, null)).status, 403);
  assert.strictEqual((await m.handleXin(req('/api/xin/login', { body: { password: 'wrong password!!' } }), env, null)).status, 401);
  const r = await m.handleXin(req('/api/xin/login', { body: { password: PW } }), env, null);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /^__Host-xin=v1\.\d+\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/);
});

test('cookie：能用；篡改、过期、改密码以后都失效', async () => {
  const m = await fresh(), env = mkEnv();
  const ck = await login(m, env);
  const me = c => m.handleXin(new Request(ORIGIN + '/api/xin/me', { headers: { cookie: c } }), env, null).then(r => r.json());
  assert.strictEqual((await me(ck)).authed, true);
  const [name, v] = ck.split('=');
  const parts = v.split('.');
  assert.strictEqual((await me(name + '=v1.' + (Number(parts[1]) + 1) + '.' + parts[2])).authed, false);
  assert.strictEqual(await m.authed(new Request(ORIGIN, { headers: { cookie: ck } }), env, Date.now() + 31 * 86400e3), false);
  const env2 = mkEnv({ OWNER_PASSWORD: 'another long password' });
  assert.strictEqual(await m.authed(new Request(ORIGIN, { headers: { cookie: ck } }), env2), false);
});

test('登录限流：超了回 429', async () => {
  const m = await fresh();
  const env = mkEnv({ XIN_LOGIN_LIMIT: { limit: async () => ({ success: false }) } });
  const r = await m.handleXin(req('/api/xin/login', { body: { password: PW } }), env, null);
  assert.strictEqual(r.status, 429);
});

test('没登录不能调用', async () => {
  const m = await fresh();
  const r = await m.handleXin(req('/api/xin/call', { body: { op: 'sessions' } }), mkEnv(), null);
  assert.strictEqual(r.status, 401);
});

test('不认识的 op 拒绝', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const r = await m.handleXin(req('/api/xin/call', { body: { op: 'rm -rf' }, headers: { cookie: ck } }), env, null);
  assert.strictEqual(r.status, 400);
});

test('send：脚本没传上去时自动上传再跑，并挂活动租约', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [
      { body: { stdout: '', stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/data/home/.xin/agent/vm-agent-x.mjs'", exitCode: 1 } },
      { body: { stdout: JSON.stringify({ sid: 'sabc123', run: 'rabc123' }), stderr: '', exitCode: 0 } }
    ],
    'PUT /v1/machines/m_abc/files': [{ status: 201, body: { created: true } }],
    'PUT /v1/machines/m_abc/activity-leases/xin-rabc123': [{ body: {} }]
  });
  const waits = [];
  try {
    const r = await m.handleXin(req('/api/xin/call', { body: { op: 'send', args: { agent: 'claude', text: '你好' } }, headers: { cookie: ck } }), env, { waitUntil: p => waits.push(p) });
    const d = await r.json();
    await Promise.all(waits);
    assert.deepStrictEqual(d, { ok: true, data: { sid: 'sabc123', run: 'rabc123' } });
    const execs = ib.calls.filter(c => c.key.endsWith('/exec'));
    assert.strictEqual(execs.length, 2);
    const body = JSON.parse(execs[0].body);
    assert.strictEqual(body.argv[0], 'node');
    assert.match(body.argv[1], /^\/data\/home\/\.xin\/agent\/vm-agent-[0-9a-f]{12}\.mjs$/);
    assert.strictEqual(body.argv[2], 'send');
    assert.deepStrictEqual(JSON.parse(body.stdin), { agent: 'claude', text: '你好' });
    const put = ib.calls.find(c => c.key === 'PUT /v1/machines/m_abc/files');
    assert.strictEqual(put.url.searchParams.get('path'), body.argv[1]);
    assert.strictEqual(put.body, AGENT_TEXT);
    assert.ok(ib.calls.some(c => c.key.includes('activity-leases')));
    for (const c of ib.calls) assert.strictEqual(c.init.headers['X-API-Key'], 'ibk_test_key_1234567890');
  } finally { ib.restore(); }
});

test('云电脑关机了：替它开机，回 waking', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [{ status: 409, body: { error: { code: 'machine_not_running', retryable: false } } }],
    'GET /v1/machines/m_abc': [{ body: { id: 'm_abc', state: 'stopped' } }],
    'POST /v1/machines/m_abc/start': [{ status: 202, body: { id: 'op_1' } }]
  });
  try {
    const d = await (await m.handleXin(req('/api/xin/call', { body: { op: 'sessions' }, headers: { cookie: ck } }), env, null)).json();
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.state, 'waking');
    const st = ib.calls.find(c => c.key.endsWith('/start'));
    assert.ok(st.init.headers['Idempotency-Key']);
  } finally { ib.restore(); }
});

test('冷却中：回 cooldown 和要等的秒数', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [{ status: 409, body: { error: { code: 'machine_cooldown', retryable: true, retryAfterSeconds: 420 } } }]
  });
  try {
    const d = await (await m.handleXin(req('/api/xin/call', { body: { op: 'poll', args: { run: 'rabc123', off: 0 } }, headers: { cookie: ck } }), env, null)).json();
    assert.deepStrictEqual([d.state, d.retryAfter], ['cooldown', 420]);
  } finally { ib.restore(); }
});

test('status 不经过 exec（不会把云电脑叫醒）', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'GET /v1/machines/m_abc': [{ body: { name: 'li', state: 'suspended' } }] });
  try {
    const d = await (await m.handleXin(req('/api/xin/call', { body: { op: 'status' }, headers: { cookie: ck } }), env, null)).json();
    assert.deepStrictEqual(d, { ok: true, data: { name: 'li', state: 'suspended', cooldownUntil: null } });
    assert.ok(!ib.calls.some(c => c.key.endsWith('/exec')));
  } finally { ib.restore(); }
});

test('Worker 把 /api/xin 交给小芯，其余 /api 仍 404', async () => {
  const w = (await load('../src/worker.js')).default;
  const env = mkEnv({ OWNER_PASSWORD: undefined });
  const r = await w.fetch(new Request(ORIGIN + '/api/xin/me'), env, null);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await w.fetch(new Request(ORIGIN + '/api/other'), env, null)).status, 404);
});

/* ---------- vm-agent：输出整理 ---------- */
test('Claude：文字、工具调用、工具结果、花费', async () => {
  const { fromClaude } = await load('../site/xin/vm-agent.mjs');
  const st = {};
  assert.deepStrictEqual(fromClaude({ type: 'system', subtype: 'init', session_id: 'u-1', model: 'm' }, st), []);
  assert.strictEqual(st.sid, 'u-1');
  assert.deepStrictEqual(fromClaude({ type: 'assistant', message: { content: [{ type: 'text', text: '好' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make' } }] } }, st),
    [{ t: 'text', text: '好' }, { t: 'tool', id: 't1', name: 'Bash', detail: 'make' }]);
  assert.deepStrictEqual(fromClaude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'error: x' }] }] } }, st),
    [{ t: 'tool_end', id: 't1', ok: false, out: 'error: x' }]);
  assert.deepStrictEqual(fromClaude({ type: 'result', is_error: false, total_cost_usd: 0.02 }, st), []);
  assert.strictEqual(st.cost, 0.02);
});

test('Claude：没登录（真实输出）只报一次错', async () => {
  const { fromClaude } = await load('../site/xin/vm-agent.mjs');
  const st = {};
  const a = fromClaude({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, error: 'authentication_failed', is_api_error_message: true }, st);
  assert.deepStrictEqual(a, [{ t: 'err', text: 'Not logged in · Please run /login' }]);
  assert.deepStrictEqual(fromClaude({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }, st), []);
  assert.strictEqual(st.failed, true);
});

test('Codex：会话号、重连只是状态、命令、文件改动、失败', async () => {
  const { fromCodex } = await load('../site/xin/vm-agent.mjs');
  const st = {};
  fromCodex({ type: 'thread.started', thread_id: 'th-1' }, st);
  assert.strictEqual(st.sid, 'th-1');
  assert.deepStrictEqual(fromCodex({ type: 'error', message: 'Reconnecting... 2/5 (401)' }, st), [{ t: 'status', text: 'Reconnecting... 2/5 (401)' }]);
  assert.deepStrictEqual(fromCodex({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: ['bash', '-lc', 'gcc a.c'], status: 'in_progress' } }, st),
    [{ t: 'tool', id: 'i1', name: 'Bash', detail: 'gcc a.c' }]);
  assert.deepStrictEqual(fromCodex({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'gcc a.c', aggregated_output: 'ok', exit_code: 0, status: 'completed' } }, st),
    [{ t: 'tool_end', id: 'i1', name: 'Bash', detail: 'gcc a.c', ok: true, out: 'ok' }]);
  assert.deepStrictEqual(fromCodex({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: '/w/a.c', kind: 'add' }], status: 'completed' } }, st),
    [{ t: 'tool_end', id: 'i2', name: 'Edit', detail: 'add /w/a.c', ok: true, out: '' }]);
  assert.deepStrictEqual(fromCodex({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: '好了' } }, st), [{ t: 'text', text: '好了' }]);
  assert.deepStrictEqual(fromCodex({ type: 'item.completed', item: { id: 'i4', type: 'reasoning', text: '想想' } }, st), []);
  fromCodex({ type: 'error', message: 'unexpected status 401' }, st);
  assert.deepStrictEqual(fromCodex({ type: 'turn.failed', error: { message: 'unexpected status 401' } }, st), [{ t: 'err', text: 'unexpected status 401' }]);
  assert.strictEqual(st.failed, true);
});

test('系统提示里列出了 xin 的全部动作', async () => {
  const { systemPrompt, ACTS } = await load('../site/xin/vm-agent.mjs');
  const p = systemPrompt();
  for (const k of Object.keys(ACTS)) assert.ok(p.includes(k + '（'), k);
});
