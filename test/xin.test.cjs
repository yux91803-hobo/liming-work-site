// 小芯聊天：Worker 登录 / 转发 InstaBox，以及 vm-agent 把 Claude Code / Codex 的输出整理成事件
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// vm-agent 的记事本写到临时目录（要在第一次 import 之前设好）
const os = require('node:os'), fs = require('node:fs');
process.env.XIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-test-'));
// 删对话、每日任务会顺手清 Codex / Claude 自己的会话记录：测试里一律指到空的临时目录，不碰本机真的记录
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-codex-'));
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-claude-'));
// Harness（dsh）也一样：会话目录指到临时目录；命令指到一个不存在的路径（本机装了 dsh 也不会被测试用到）
process.env.XIN_DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-dsh-'));
process.env.XIN_DSH = path.join(process.env.XIN_DSH_HOME, 'no-dsh');
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
  // 真实输出：模型元数据警告只是状态，不算错
  assert.deepStrictEqual(fromCodex({ type: 'item.completed', item: { id: 'i5', type: 'error', message: 'Model metadata for `x` not found.' } }, st), [{ t: 'status', text: 'Model metadata for `x` not found.' }]);
  assert.strictEqual(st.failed, undefined);
  fromCodex({ type: 'error', message: 'unexpected status 401' }, st);
  assert.deepStrictEqual(fromCodex({ type: 'turn.failed', error: { message: 'unexpected status 401' } }, st), [{ t: 'err', text: 'unexpected status 401' }]);
  assert.strictEqual(st.failed, true);
});

test('系统提示里列出了 xin 的全部动作', async () => {
  const { systemPrompt, ACTS } = await load('../site/xin/vm-agent.mjs');
  const p = systemPrompt();
  for (const k of Object.keys(ACTS)) assert.ok(p.includes(k + '（'), k);
});

test('思考强度：只认这个模型真正支持的档位，别的（以前的 auto、空的、别家的档）用默认 high', async () => {
  const { resolveEffort, effortSpec } = await load('../site/xin/vm-agent.mjs');
  assert.deepStrictEqual(effortSpec('harness').efforts, ['off', 'low', 'high', 'max']);
  for (const m of ['glm-5.3-flash', 'glm-5.3', 'kimi-k3.1-pro']) assert.deepStrictEqual(effortSpec('codex', m).efforts, ['low', 'high', 'max'], m);
  for (const m of ['glm-5.3-flash', 'glm-5.3']) assert.deepStrictEqual(effortSpec('harness', m).efforts, ['low', 'high', 'max'], m);
  assert.deepStrictEqual(effortSpec('codex', 'deepseek-v4.1-flash').efforts, ['off', 'low', 'high', 'max']);
  assert.strictEqual(resolveEffort('harness', 'glm-5.3', 'off'), 'high');
  assert.strictEqual(resolveEffort('codex', 'deepseek-v4.1-flash', 'off'), 'off');
  assert.deepStrictEqual(effortSpec('claude').efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.strictEqual(resolveEffort('harness', null, 'off'), 'off');
  assert.strictEqual(resolveEffort('harness', null, 'max'), 'max');
  assert.strictEqual(resolveEffort('codex', 'glm-5.3', 'off'), 'high');      // GLM 不能关思考
  assert.strictEqual(resolveEffort('codex', 'kimi-k3.1-pro', 'low'), 'low');
  assert.strictEqual(resolveEffort('codex', 'glm-5.3-flash', 'xhigh'), 'high');
  assert.strictEqual(resolveEffort('claude', null, 'xhigh'), 'xhigh');
  assert.strictEqual(resolveEffort('claude', null, 'off'), 'high');
  for (const e of ['auto', '', undefined, 'MAX']) assert.strictEqual(resolveEffort('codex', 'glm-5.3', e), 'high', String(e));
});

test('思考强度：Codex 用 -c model_reasoning_effort（续接也带），Claude 用 --effort；不指定就不加', async () => {
  const { agentArgs } = await load('../site/xin/vm-agent.mjs');
  const fresh = { started: false, agentSid: null }, cont = { started: true, agentSid: 'th-1' };
  let [cmd, a] = agentArgs('codex', fresh, '写代码', 'max');
  assert.strictEqual(cmd, 'codex');
  assert.strictEqual(a[a.indexOf('model_reasoning_effort="max"') - 1], '-c');
  [, a] = agentArgs('codex', cont, '再改改', 'max');
  assert.deepStrictEqual(a.slice(0, 2), ['exec', 'resume']);
  assert.ok(a.includes('model_reasoning_effort="max"') && a[a.length - 2] === 'th-1' && a[a.length - 1] === '再改改');
  [, a] = agentArgs('codex', fresh, '你好', '');
  assert.ok(!a.some(x => x.startsWith('model_reasoning_effort')));
  [, a] = agentArgs('codex', fresh, '直接回答', 'off', { model: 'deepseek-v4.1-flash' });
  assert.ok(a.includes('model="deepseek-v4.1-flash"') && a.includes('model_reasoning_effort="none"'));
  [cmd, a] = agentArgs('claude', { started: false, agentSid: 'u-1' }, '写代码', 'max');
  assert.strictEqual(cmd, 'claude');
  assert.deepStrictEqual(a.slice(a.indexOf('--effort'), a.indexOf('--effort') + 2), ['--effort', 'max']);
  [, a] = agentArgs('claude', { started: false, agentSid: 'u-1' }, '你好', '');
  assert.ok(!a.includes('--effort'));
});

test('附带页面信息：接在消息后面给 AI，没有就原样；太长截断', async () => {
  const { withContext } = await load('../site/xin/vm-agent.mjs');
  assert.strictEqual(withContext('这行什么意思', ''), '这行什么意思');
  assert.strictEqual(withContext('这行什么意思', undefined), '这行什么意思');
  const t = withContext('这行什么意思', '【用户正在看】STM32 学习台 · GPIO\n【用户选中的内容】\nGPIOA->CRL |= 0x3;');
  assert.ok(t.startsWith('这行什么意思\n\n---\n'));
  assert.ok(t.includes('GPIOA->CRL |= 0x3;'));
  assert.ok(withContext('x', 'y'.repeat(50000)).length < 12200);
});

test('系统提示告诉 AI 附带信息是什么', async () => {
  const { systemPrompt } = await load('../site/xin/vm-agent.mjs');
  assert.ok(systemPrompt().includes('【用户选中的内容】'));
});

test('wake：睡着的叫醒（resume），关机的开机（start），醒着的不动，冷却中不动', async () => {
  for (const [state, extra, expect] of [['suspended', {}, 'resume'], ['stopped', {}, 'start'], ['running', {}, 'none'], ['suspended', { cooldownUntil: new Date(Date.now() + 600000).toISOString() }, 'cooldown']]) {
    const m = await fresh(), env = mkEnv(), ck = await login(m, env);
    const ib = fakeIB({
      'GET /v1/machines': [MACHINES],
      'GET /v1/machines/m_abc': [{ body: Object.assign({ id: 'm_abc', state }, extra) }],
      'POST /v1/machines/m_abc/resume': [{ status: 202, body: { id: 'op_1' } }],
      'POST /v1/machines/m_abc/start': [{ status: 202, body: { id: 'op_2' } }]
    });
    try {
      const d = await (await m.handleXin(req('/api/xin/call', { body: { op: 'wake' }, headers: { cookie: ck } }), env, null)).json();
      assert.strictEqual(d.ok, true, state);
      assert.strictEqual(d.data.action, expect, state);
      const posts = ib.calls.filter(c => c.key.startsWith('POST'));
      assert.strictEqual(posts.length, expect === 'resume' || expect === 'start' ? 1 : 0, state);
      if (posts.length) assert.ok(posts[0].init.headers['Idempotency-Key']);
      assert.ok(!ib.calls.some(c => c.key.endsWith('/exec')));
    } finally { ib.restore(); }
  }
});

test('Codex 每一轮都带小芯的设定（developer_instructions），续接对话也带；第一句不再拼设定', async () => {
  const { agentArgs, systemPrompt } = await load('../site/xin/vm-agent.mjs');
  for (const sess of [{ started: false, agentSid: null }, { started: true, agentSid: 'th-1' }]) {
    const [, a] = agentArgs('codex', sess, '你好', '');
    const i = a.findIndex(x => x.startsWith('developer_instructions='));
    assert.ok(i > 0 && a[i - 1] === '-c');
    assert.strictEqual(JSON.parse(a[i].slice('developer_instructions='.length)), systemPrompt());
    assert.strictEqual(a[a.length - 1], '你好');
  }
  const p = systemPrompt();
  assert.ok(p.includes('你就是小芯') && p.includes('第一人称') && p.includes('自己的电脑') && p.includes('不要说出'));
});

test('记事本：remember 记一条（带日期、去掉换行），没有文件时先写标题', async () => {
  const { remember, readMemory, MEM_FILE } = await load('../site/xin/vm-agent.mjs');
  try { fs.unlinkSync(MEM_FILE()); } catch (e) {}
  assert.strictEqual(remember('  '), '');
  assert.strictEqual(remember('用户叫小李\n在学定时器'), '用户叫小李 在学定时器');
  remember('喜欢先看代码');
  const m = readMemory();
  assert.match(m, /^# 小芯的记事本\n\n- \d{4}-\d{2}-\d{2}：用户叫小李 在学定时器\n- \d{4}-\d{2}-\d{2}：喜欢先看代码\n$/);
});

test('记事本：每一轮都放进设定里；空的写「还是空的」；太长截断并提醒整理', async () => {
  const { systemPrompt } = await load('../site/xin/vm-agent.mjs');
  assert.ok(systemPrompt('- 用户叫小李').includes('<<<记事本\n- 用户叫小李\n记事本>>>'));
  assert.ok(systemPrompt('').includes('（还是空的）'));
  const long = systemPrompt('x'.repeat(20000));
  assert.ok(long.includes('该整理了') && long.length < 12000);
  assert.ok(systemPrompt('').includes('xin remember'));
});

test('记事本：Codex 每轮的 developer_instructions 里带着当前记事本', async () => {
  const { agentArgs, remember } = await load('../site/xin/vm-agent.mjs');
  remember('最近在调 I2C');
  const [, a] = agentArgs('codex', { started: true, agentSid: 'th-1' }, '你好', '');
  const di = a.find(x => x.startsWith('developer_instructions='));
  assert.ok(JSON.parse(di.slice('developer_instructions='.length)).includes('最近在调 I2C'));
});

test('身份：设定写明以它为准；每句后面悄悄附提醒（历史里不显示）', async () => {
  const { systemPrompt, forAgent, REMIND } = await load('../site/xin/vm-agent.mjs');
  const p = systemPrompt('');
  assert.ok(p.includes('这份设定优先') && p.includes('InstaBox 云电脑'));
  // 被问到是什么模型：自然地说不知道，不说「秘密」「不能说」
  assert.ok(p.includes('自然地说不知道') && p.includes('这个我也不知道诶') && p.includes('别说「保密」「秘密」「不能说」'));
  assert.ok(REMIND.includes('自然地说不知道') && REMIND.includes('别说是秘密'));
  const t = forAgent('你是谁呀？', '');
  assert.ok(t.startsWith('你是谁呀？') && t.endsWith(REMIND));
  const t2 = forAgent('这行什么意思', '【用户正在看】GPIO');
  assert.ok(t2.indexOf('【用户正在看】GPIO') < t2.indexOf(REMIND));
});

/* ---------- 每日任务、开场白、预热、卡住重来 ---------- */
test('定时任务：8:55 那个只叫醒；9:10 / 21:10 那个开每日任务（电脑在睡就等它醒了再试）；没配密钥什么都不做', async () => {
  const m = await fresh(), env = mkEnv();
  const { CRON_WAKE, CRON_DAILY } = m;
  assert.deepStrictEqual(await m.runCron(CRON_DAILY, mkEnv({ OWNER_PASSWORD: undefined }), null), { ok: false, state: 'disabled' });
  let ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'GET /v1/machines/m_abc': [{ body: { id: 'm_abc', state: 'suspended' } }], 'POST /v1/machines/m_abc/resume': [{ status: 202, body: {} }] });
  try {
    const r = await m.runCron(CRON_WAKE, env, null, { wait: async () => {} });
    assert.deepStrictEqual([r.ok, r.data.action], [true, 'resume']);
    assert.ok(!ib.calls.some(c => c.key.endsWith('/exec')));
  } finally { ib.restore(); }
  m._reset();
  ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [
      { status: 409, body: { error: { code: 'machine_not_running' } } },
      { body: { stdout: JSON.stringify({ sid: 'sd0000001', run: 'rd0000001', agent: 'codex' }), stderr: '', exitCode: 0 } }
    ],
    'GET /v1/machines/m_abc': [{ body: { id: 'm_abc', state: 'stopped' } }],
    'POST /v1/machines/m_abc/start': [{ status: 202, body: {} }],
    'PUT /v1/machines/m_abc/activity-leases/xin-rd0000001': [{ body: {} }]
  });
  const waits = [];
  try {
    const r = await m.runCron(CRON_DAILY, env, { waitUntil: p => waits.push(p) }, { wait: async () => {} });
    await Promise.all(waits);
    assert.deepStrictEqual(r, { ok: true, data: { sid: 'sd0000001', run: 'rd0000001', agent: 'codex' } });
    const execs = ib.calls.filter(c => c.key.endsWith('/exec'));
    assert.strictEqual(execs.length, 2);
    assert.strictEqual(JSON.parse(execs[1].body).argv[2], 'daily');
    assert.ok(ib.calls.some(c => c.key.endsWith('/start')) && ib.calls.some(c => c.key.includes('activity-leases')));
  } finally { ib.restore(); }
});

test('Worker 有 scheduled 入口，交给 runCron', async () => {
  const w = (await load('../src/worker.js')).default;
  assert.strictEqual(typeof w.scheduled, 'function');
  const waits = [];
  await w.scheduled({ cron: '10 1,13 * * *' }, mkEnv({ OWNER_PASSWORD: undefined }), { waitUntil: p => waits.push(p) });
  assert.strictEqual(waits.length, 1);
  assert.deepStrictEqual(await waits[0], { ok: false, state: 'disabled' });
});

test('wrangler：正式站有两个定时任务，测试站一个都没有', () => {
  const src = fs.readFileSync(path.join(__dirname, '../wrangler.jsonc'), 'utf8');
  const top = src.slice(0, src.indexOf('"env"')), stg = src.slice(src.indexOf('"env"'));
  assert.match(top, /"triggers":\s*\{\s*"crons":\s*\["55 0 \* \* \*", "10 1,13 \* \* \*"\]\s*\}/);
  assert.match(stg, /"triggers":\s*\{\s*"crons":\s*\[\]\s*\}/);
});

test('开场白：xin next 写一句，3 天内有效；设定里教了 xin next 和每日任务清单', async () => {
  const { setNext, getNext, systemPrompt, dailyPrompt, DAILY_FILE } = await load('../site/xin/vm-agent.mjs');
  assert.strictEqual(setNext('  '), null);
  const g = setNext('今天签到好啦\n连签 10 天');
  assert.strictEqual(g.text, '今天签到好啦 连签 10 天');
  assert.deepStrictEqual(getNext(), g);
  assert.strictEqual(getNext(Date.now() + 4 * 86400e3), null);
  const p = systemPrompt('');
  assert.ok(p.includes('xin next') && p.includes(DAILY_FILE()) && p.includes('别自己用 cron'));
  const d = dailyPrompt('- 网关签到');
  assert.ok(d.includes('<<<每日任务\n- 网关签到\n每日任务>>>') && d.includes('xin next') && d.includes('别问问题'));
});

test('真跑 vm-agent（假 codex）：第一次卡住 → 自动重来 → 做完；记下今天做过，再叫就跳过；开场白取得到', async () => {
  const { execFileSync } = require('node:child_process');
  const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-daily-')), bin = path.join(home, 'fakebin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), [
    '#!/bin/sh',
    'case "$*" in *--ephemeral*) exit 0;; esac',
    'n=$(cat "$XIN_HOME/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$XIN_HOME/n"',
    'echo \'{"type":"thread.started","thread_id":"th-1"}\'',
    'if [ "$n" = 1 ]; then sleep 30; exit 0; fi',
    'xin next 今天签到好啦 >/dev/null',
    'echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"签到好了"}}\'',
    'echo \'{"type":"turn.completed","usage":{}}\''
  ].join('\n'), { mode: 0o755 });
  // hasCmd 走登录 shell（sh -lc），会重写 PATH；把假 codex 写进 HOME/.profile，登录后还能找到
  fs.writeFileSync(path.join(home, '.profile'), 'PATH="' + bin + ':$PATH"\nexport PATH\n');
  const env = Object.assign({}, process.env, { HOME: home, XIN_HOME: home, XIN_WORK: path.join(home, 'work'), XIN_STALL_MS: '800', PATH: bin + ':' + process.env.PATH });
  const op = (name, args) => JSON.parse(execFileSync(process.execPath, [agent, name], { env, input: JSON.stringify(args || {}) }).toString());
  assert.deepStrictEqual(op('daily'), { skipped: 'empty' });
  op('daily_set', { text: '- 网关签到' });
  const r = op('daily');
  assert.strictEqual(r.agent, 'codex');
  let p = null;
  for (let i = 0; i < 60; i++) { p = op('poll', { run: r.run, off: 0 }); if (p.done) break; await new Promise(s => setTimeout(s, 200)); }
  const ts = p.events.map(e => e.t);
  assert.deepStrictEqual(ts, ['user', 'status', 'text', 'done'], JSON.stringify(p.events));
  assert.strictEqual(p.events[1].text, '这次连接卡住了，重新连一次…');
  assert.strictEqual(p.events[3].ok, true);
  assert.strictEqual(op('daily').skipped, 'done');
  assert.strictEqual(op('daily_get').done.run, r.run);
  assert.strictEqual(op('greet').text, '今天签到好啦');
  const sess = op('sessions').sessions.find(s => s.sid === r.sid);
  assert.match(sess.title, /^每日任务 · \d\d-\d\d$/);
});

/* ---------- 小芯的文件、对话改名 / 删除 ---------- */
test('改名、归档、删除、文件、插件这几个 op 都转给 vm-agent', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/exec': [{ body: { stdout: '{"ok":true}', stderr: '', exitCode: 0 } }] });
  try {
    for (const op of ['rename', 'archive', 'forget', 'files', 'plugins', 'plugin_set']) {
      const d = await (await m.handleXin(req('/api/xin/call', { body: { op, args: { sid: 'sabc123' } }, headers: { cookie: ck } }), env, null)).json();
      assert.deepStrictEqual(d, { ok: true, data: { ok: true } }, op);
    }
    assert.deepStrictEqual(ib.calls.filter(c => c.key.endsWith('/exec')).map(c => JSON.parse(c.body).argv[2]), ['rename', 'archive', 'forget', 'files', 'plugins', 'plugin_set']);
  } finally { ib.restore(); }
});

test('下载：先让 vm-agent 核对路径，再按它给的真实路径从 InstaBox 原样转过来（附件、不缓存）', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const P = '/data/workspace/点灯/build/app.hex', REAL = '/data/workspace/blink/build/app.hex', BODY = ':00000001FF\n';
  const ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [{ body: { stdout: JSON.stringify({ path: P, real: REAL, dir: false, size: BODY.length }), stderr: '', exitCode: 0 } }],
    'GET /v1/machines/m_abc/files/content': [(u, init) => new Response(BODY, { status: 200, headers: { 'content-length': String(BODY.length), 'content-type': 'application/octet-stream' } })]
  });
  try {
    const r = await m.handleXin(new Request(ORIGIN + '/api/xin/file?path=' + encodeURIComponent(P), { headers: { cookie: ck } }), env, null);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await r.text(), BODY);
    assert.strictEqual(r.headers.get('content-type'), 'application/octet-stream');
    assert.strictEqual(r.headers.get('content-disposition'), `attachment; filename="app.hex"; filename*=UTF-8''app.hex`);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
    assert.strictEqual(r.headers.get('content-length'), String(BODY.length));
    const ex = JSON.parse(ib.calls.find(c => c.key.endsWith('/exec')).body);
    assert.strictEqual(ex.argv[2], 'files');
    assert.deepStrictEqual(JSON.parse(ex.stdin), { path: P, stat: true });
    const get = ib.calls.find(c => c.key.endsWith('/files/content'));
    assert.strictEqual(get.url.searchParams.get('path'), REAL);
    assert.strictEqual(get.init.headers['X-API-Key'], 'ibk_test_key_1234567890');
  } finally { ib.restore(); }
});

test('给小芯发文件：原样转给 InstaBox，写进 uploads/北京日期/ 下面（文件名去掉路径和怪字符）；图片能在聊天里直接显示', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const BODY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'PUT /v1/machines/m_abc/files': [async (u, init) => new Response(JSON.stringify({ path: u.searchParams.get('path') }), { status: 201 })] });
  const up = (name, body, headers) => m.handleXin(new Request(ORIGIN + '/api/xin/upload?name=' + encodeURIComponent(name), {
    method: 'POST', headers: Object.assign({ cookie: ck, 'x-xin': '1', origin: ORIGIN, 'content-type': 'application/octet-stream', 'content-length': String(body.length) }, headers || {}), body
  }), env, null, Date.UTC(2026, 10, 5, 16, 30, 5));   // 北京时间 11-06 00:30:05
  try {
    const r = await up('../照片 1.PNG', BODY);
    assert.strictEqual(r.status, 200);
    const d = (await r.json()).data;
    assert.match(d.path, /^\/data\/workspace\/uploads\/20261106\/003005-[0-9a-f]{4}-照片 1\.PNG$/);
    assert.deepStrictEqual([d.name, d.size, d.image], ['照片 1.PNG', BODY.length, true]);
    const put = ib.calls.find(c => c.key === 'PUT /v1/machines/m_abc/files');
    assert.deepStrictEqual([put.url.searchParams.get('path'), put.url.searchParams.get('parents')], [d.path, 'true']);
    assert.strictEqual(put.init.headers['X-API-Key'], 'ibk_test_key_1234567890');
    assert.deepStrictEqual(new Uint8Array(await new Response(put.init.body).arrayBuffer()), BODY);
    const r2 = await up('说明书.pdf', BODY);
    assert.strictEqual((await r2.json()).data.image, false);
    // 不登录、别的网站、没有 x-xin、太大：都不行，也不碰 InstaBox
    const n = ib.calls.length;
    assert.strictEqual((await up('a.txt', BODY, { cookie: '' })).status, 401);
    assert.strictEqual((await up('a.txt', BODY, { origin: 'https://evil.example' })).status, 403);
    assert.strictEqual((await up('a.txt', BODY, { 'x-xin': '' })).status, 403);
    assert.strictEqual((await up('a.txt', BODY, { 'content-length': String(100 * 1024 * 1024 + 1) })).status, 413);
    assert.strictEqual(ib.calls.length, n);
  } finally { ib.restore(); }
  // 聊天里显示发过的图片：?img=1 按图片类型 inline；svg 和别的文件还是附件下载
  const stat = o => ({ body: { stdout: JSON.stringify(o), stderr: '', exitCode: 0 } });
  const P = '/data/workspace/uploads/20261106/003005-ab12-a.png';
  const ib2 = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [stat({ path: P, real: P, dir: false, size: 3 }), stat({ path: '/data/workspace/x.svg', real: '/data/workspace/x.svg', dir: false, size: 3 })],
    'GET /v1/machines/m_abc/files/content': [() => new Response('abc', { status: 200 })]
  });
  try {
    const g = p => m.handleXin(new Request(ORIGIN + '/api/xin/file?img=1&path=' + encodeURIComponent(p), { headers: { cookie: ck } }), env, null);
    const r = await g(P);
    assert.deepStrictEqual([r.status, r.headers.get('content-type'), r.headers.get('content-disposition').split(';')[0]], [200, 'image/png', 'inline']);
    const r2 = await g('/data/workspace/x.svg');
    assert.deepStrictEqual([r2.headers.get('content-type'), r2.headers.get('content-disposition').split(';')[0]], ['application/octet-stream', 'attachment']);
  } finally { ib2.restore(); }
});

test('下载：文件名里有中文和引号也能存；没登录 401；路径不对 400；工作目录外面 403；文件夹 400；没有 404', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const get = (p, cookie) => m.handleXin(new Request(ORIGIN + '/api/xin/file?path=' + encodeURIComponent(p), { headers: cookie ? { cookie } : {} }), env, null);
  const stat = o => ({ body: { stdout: JSON.stringify(o), stderr: '', exitCode: 0 } });
  const ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [
      stat({ path: '/data/workspace/说明 "v1".txt', real: '/data/workspace/说明 "v1".txt', dir: false, size: 2 }),
      stat({ error: 'outside', msg: '只能看 /data/workspace 里面的文件' }),
      stat({ path: '/data/workspace/blink', real: '/data/workspace/blink', dir: true }),
      stat({ error: 'not_found', msg: '没有这个文件' })
    ],
    'GET /v1/machines/m_abc/files/content': [() => new Response('hi')]
  });
  try {
    const ok = await get('/data/workspace/说明 "v1".txt', ck);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers.get('content-disposition'), `attachment; filename="__ _v1_.txt"; filename*=UTF-8''%E8%AF%B4%E6%98%8E%20%22v1%22.txt`);
    assert.strictEqual((await get('/data/workspace/a.hex')).status, 401);
    assert.strictEqual((await get('data/workspace/a.hex', ck)).status, 400);
    assert.strictEqual((await get('/data/workspace/a\nb', ck)).status, 400);
    assert.strictEqual((await get('/etc/passwd', ck)).status, 403);
    assert.strictEqual((await get('/data/workspace/blink', ck)).status, 400);
    assert.strictEqual((await get('/data/workspace/nope', ck)).status, 404);
    assert.strictEqual(ib.calls.filter(c => c.key.endsWith('/files/content')).length, 1);
  } finally { ib.restore(); }
});

test('下载：云电脑在睡觉时回 503 + waking（网页等它醒了再下）', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [{ status: 409, body: { error: { code: 'machine_not_running' } } }],
    'GET /v1/machines/m_abc': [{ body: { id: 'm_abc', state: 'suspended' } }],
    'POST /v1/machines/m_abc/resume': [{ status: 202, body: {} }]
  });
  try {
    const r = await m.handleXin(new Request(ORIGIN + '/api/xin/file?path=%2Fdata%2Fworkspace%2Fa.hex', { headers: { cookie: ck } }), env, null);
    assert.strictEqual(r.status, 503);
    assert.strictEqual((await r.json()).state, 'waking');
  } finally { ib.restore(); }
});

function agentEnv(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-files-')), work = path.join(home, 'work');
  const env = Object.assign({}, process.env, { XIN_HOME: path.join(home, 'xin'), XIN_WORK: work }, extraEnv);
  const { execFileSync } = require('node:child_process');
  const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
  const op = (name, args) => JSON.parse(execFileSync(process.execPath, [agent, name], { env, input: JSON.stringify(args || {}) }).toString());
  return { home, work, xin: env.XIN_HOME, op };
}

test('小芯的文件：列文件夹（文件夹在前、不列隐藏的）、预览文字文件、二进制只给下载，工作目录外面一律不行', () => {
  const { home, work, op } = agentEnv();
  fs.mkdirSync(path.join(work, 'blink', 'build'), { recursive: true });
  fs.writeFileSync(path.join(work, 'blink', 'main.c'), 'int main(void) { return 0; }\n');
  fs.writeFileSync(path.join(work, 'blink', 'build', 'app.bin'), Buffer.from([0x00, 0x50, 0x00, 0x20, 0xff]));
  fs.writeFileSync(path.join(work, 'blink', 'build', 'app.hex'), ':00000001FF\n');
  fs.writeFileSync(path.join(work, 'blink', 'big.txt'), 'x'.repeat(210 * 1024));
  fs.writeFileSync(path.join(work, '.secret'), 'no');
  fs.writeFileSync(path.join(work, 'readme.md'), '# 你好');
  fs.writeFileSync(path.join(home, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(home, 'outside.txt'), path.join(work, 'link.txt'));
  fs.symlinkSync(home, path.join(work, 'up'));

  const root = op('files', {});
  assert.strictEqual(root.path, work);
  assert.deepStrictEqual(root.entries.map(e => [e.name, e.dir]), [['blink', true], ['up', true], ['link.txt', false], ['readme.md', false]]);
  const dir = op('files', { path: work + '/blink' });
  assert.deepStrictEqual(dir.entries.map(e => e.name), ['build', 'big.txt', 'main.c']);
  assert.strictEqual(op('files', { path: work + '/blink/main.c' }).text, 'int main(void) { return 0; }\n');
  assert.strictEqual(op('files', { path: work + '/blink/build/app.hex' }).text, ':00000001FF\n');
  const bin = op('files', { path: work + '/blink/build/app.bin' });
  assert.deepStrictEqual([bin.binary, bin.text, bin.size], [true, undefined, 5]);
  const big = op('files', { path: work + '/blink/big.txt' });
  assert.deepStrictEqual([big.big, big.text], [true, undefined]);
  const st = op('files', { path: work + '/blink/main.c', stat: true });
  assert.deepStrictEqual([st.real, st.dir, st.size, st.text], [fs.realpathSync(path.join(work, 'blink', 'main.c')), false, 29, undefined]);
  // 外面的：绝对路径、../ 跳出去、软链接指到外面
  for (const p of ['/etc/passwd', work + '/../outside.txt', '../outside.txt', work + '/link.txt', work + '/up/outside.txt', work + '/up', work + 'x/a']) {
    assert.strictEqual(op('files', { path: p }).error, 'outside', p);
  }
  assert.strictEqual(op('files', { path: work + '/nope.c' }).error, 'not_found');
});

test('对话改名、删除（连同每一轮的记录）；还在进行中的不让删', () => {
  const { xin, op } = agentEnv();
  const sess = path.join(xin, 'sessions'), runs = path.join(xin, 'runs');
  fs.mkdirSync(sess, { recursive: true }); fs.mkdirSync(runs, { recursive: true });
  const mkSess = (sid, run, done) => {
    fs.writeFileSync(path.join(sess, sid + '.json'), JSON.stringify({ sid, agent: 'codex', title: '老名字', runs: [run], created: 1, updated: 1 }));
    fs.writeFileSync(path.join(runs, run + '.jsonl'), JSON.stringify({ t: 'user', text: '你好' }) + '\n' + (done ? JSON.stringify({ t: 'done', ok: true }) + '\n' : ''));
    fs.writeFileSync(path.join(runs, run + '.json'), JSON.stringify({ run, sid, started: Date.now(), pid: process.pid }));
  };
  mkSess('sdone00001', 'rdone00001', true);
  mkSess('sbusy00001', 'rbusy00001', false);
  // 上一句还在跑：回 busy，带上 sid，网页好接着打开同一对话
  assert.deepStrictEqual(op('send', { sid: 'sbusy00001', text: '再问一句' }), { error: 'busy', msg: '上一句还没做完，请稍后再试', run: 'rbusy00001', sid: 'sbusy00001' });
  assert.strictEqual(op('rename', { sid: 'sdone00001', title: '  点灯\n程序  ' }).session.title, '点灯 程序');
  assert.strictEqual(op('sessions').sessions.find(s => s.sid === 'sdone00001').title, '点灯 程序');
  assert.strictEqual(op('rename', { sid: 'sdone00001', title: '   ' }).error, 'empty');
  assert.strictEqual(op('rename', { sid: '../x', title: 'a' }).error, 'bad_sid');
  assert.strictEqual(op('rename', { sid: 'snone00001', title: 'a' }).error, 'no_session');
  assert.strictEqual(op('forget', { sid: 'sbusy00001' }).error, 'busy');
  assert.ok(fs.existsSync(path.join(sess, 'sbusy00001.json')));
  assert.deepStrictEqual(op('forget', { sid: 'sdone00001' }), { ok: true, freed: 0 });
  assert.deepStrictEqual(['sdone00001.json', 'rdone00001.jsonl', 'rdone00001.json'].map(f => fs.existsSync(path.join(f[0] === 's' ? sess : runs, f))), [false, false, false]);
  assert.deepStrictEqual(op('sessions').sessions.map(s => s.sid), ['sbusy00001']);
  assert.deepStrictEqual(op('forget', { sid: 'sdone00001' }), { ok: true, already: true });
  assert.strictEqual(op('forget', { sid: '../../etc' }).error, 'bad_sid');
});

test('插件：只列用户自己装的（电脑自带的不显示、不让关）和开没开；开关记下来，每轮起 codex 时加 -c（只给自己装的）；小芯挪走的 REA 并回配置、记成关着', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-plug-'));
  const codexHome = path.join(tmp, 'codex'), sys = path.join(tmp, 'etc.toml'), bin = path.join(tmp, 'bin'), home = path.join(tmp, 'home');
  fs.mkdirSync(codexHome); fs.mkdirSync(bin); fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n\n[features]\nmemories = true\n');
  fs.writeFileSync(path.join(codexHome, 'rea.mcp.toml'), '[mcp_servers.rea]\ncommand = "/opt/rea/run"\nargs = []\n\n[mcp_servers.rea.env]\nJAVA_HOME = "/usr/lib/jvm"\n');
  fs.writeFileSync(sys, '[mcp_servers.instabox]\ncommand = "/usr/local/bin/instabox-mcp"\n\n[mcp_servers."open-computer-use"]\ncommand = "/usr/local/bin/oc"\n');
  fs.writeFileSync(path.join(home, '.local', 'bin', 'xin-rea'), '#!/bin/bash\nSEG=/data/home/.codex/rea.mcp.toml\n');
  // 假的 codex mcp list --json：按两个配置文件里写了的服务器回
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n[ "$1 $2 $3" = "mcp list --json" ] || exit 3\nprintf \'[\'; sep=""\n' +
    'for n in $(grep -ho "^\\[mcp_servers\\.[^].]*\\]" "$CODEX_HOME/config.toml" "$XIN_CODEX_SYS" | sed -e "s/^\\[mcp_servers\\.//" -e "s/\\]$//" -e "s/\\"//g"); do printf "%s{\\"name\\":\\"%s\\",\\"enabled\\":true,\\"transport\\":{\\"type\\":\\"stdio\\",\\"command\\":\\"/x/%s-bin\\"}}" "$sep" "$n" "$n"; sep=","; done\nprintf \']\'\n', { mode: 0o755 });
  const { op, xin: xinDir } = agentEnv({ CODEX_HOME: codexHome, XIN_CODEX_SYS: sys, HOME: home, PATH: bin + ':' + process.env.PATH });
  const r = op('plugins');
  assert.deepStrictEqual(r.merged, ['rea']);
  assert.deepStrictEqual(r.plugins.map(p => [p.name, p.on, p.cmd]), [['rea', false, 'rea-bin']]);
  assert.strictEqual(r.plugins[0].desc, '逆向分析（Ghidra）');
  const cfg = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.ok(cfg.startsWith('model = "x"') && cfg.includes('[mcp_servers.rea]') && cfg.includes('JAVA_HOME'));
  assert.ok(fs.existsSync(path.join(codexHome, 'rea.mcp.toml.merged')) && !fs.existsSync(path.join(codexHome, 'rea.mcp.toml')));
  assert.ok(fs.existsSync(path.join(codexHome, 'config.toml.xin-bak')));
  assert.match(fs.readFileSync(path.join(home, '.local', 'bin', 'xin-rea'), 'utf8'), /exec xin plugin "\$1" rea/);
  assert.deepStrictEqual(op('plugins').merged, []);   // 只并一次
  assert.strictEqual(op('plugin_set', { name: 'instabox', on: false }).error, 'builtin');
  assert.deepStrictEqual(op('plugin_set', { name: 'rea', on: true }), { ok: true, name: 'rea', on: true });
  assert.strictEqual(op('plugin_set', { name: 'nope', on: true }).error, 'no_plugin');
  assert.strictEqual(op('plugin_set', { name: 'a b', on: true }).error, 'bad_name');
  assert.deepStrictEqual(op('plugins').plugins.map(p => [p.name, p.on]), [['rea', true]]);
  // 每轮起 codex 的参数：开关变成 -c；配置里没有的名字、电脑自带的（手动塞进 plugins.json 的）都不加
  const st = JSON.parse(fs.readFileSync(path.join(xinDir, 'plugins.json'), 'utf8'));
  st.state.ghost = false; st.state.instabox = false; fs.writeFileSync(path.join(xinDir, 'plugins.json'), JSON.stringify(st));
  const saved = [process.env.XIN_HOME, process.env.CODEX_HOME, process.env.XIN_CODEX_SYS];
  process.env.XIN_HOME = xinDir; process.env.CODEX_HOME = codexHome; process.env.XIN_CODEX_SYS = sys;
  try {
    // 换了 XIN_HOME 要重新载入（BASE 在载入时定好），后面加个参数当成新模块
    const { mcpFlags, agentArgs } = await import(pathToFileURL(path.join(__dirname, '../site/xin/vm-agent.mjs')).href + '?plug');
    assert.deepStrictEqual(mcpFlags(), ['-c', 'mcp_servers.rea.enabled=true']);
    // glm-5.3-flash 看不了图：图片不用 -i
    const [, a] = agentArgs('codex', { started: false }, '你好', '', { images: ['/data/workspace/uploads/1/a.png', '/data/workspace/uploads/1/b.jpg'] });
    assert.deepStrictEqual(a.slice(0, 2), ['exec', '--json']);
    assert.ok(!a.includes('-i'));
    assert.ok(a.join(' ').includes('-c mcp_servers.rea.enabled=true') && !a.join(' ').includes('instabox'));
    const [, b] = agentArgs('codex', { started: true, agentSid: 'th-1' }, '你好', '', { images: ['/x/a.png'] });
    assert.deepStrictEqual(b.slice(0, 3), ['exec', 'resume', '--json']);
    assert.deepStrictEqual(b.slice(-2), ['th-1', '你好']);
  } finally { [process.env.XIN_HOME, process.env.CODEX_HOME, process.env.XIN_CODEX_SYS] = saved; }
});

test('Codex 线路每轮自己带：本地网关 + 选的模型（默认 glm-5.3-flash，不认识的当默认）；模型资料照抄一份补上这几个模型；看不了图的不用 -i；key 先用 codex.key，没有用 harness.key', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-cxroute-'));
  const codexHome = path.join(tmp, 'codex'), xinDir = path.join(tmp, 'xin');
  fs.mkdirSync(codexHome); fs.mkdirSync(xinDir);
  const src = path.join(codexHome, 'models.json');
  fs.writeFileSync(src, JSON.stringify({ models: [{ slug: 'gpt-5.5', context_window: 272000, input_modalities: ['text', 'image'] }, { slug: 'deepseek-v4.1-flash', display_name: 'DeepSeek', context_window: 1000000, input_modalities: ['text', 'image'], model_messages: { instructions_template: 'T' } }] }));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_catalog_json = "' + src + '"\nmodel = "deepseek-v4.1-flash"\n');
  fs.writeFileSync(path.join(xinDir, 'harness.key'), 'hk\n');
  const saved = [process.env.XIN_HOME, process.env.CODEX_HOME];
  process.env.XIN_HOME = xinDir; process.env.CODEX_HOME = codexHome;
  try {
    const { agentArgs, codexKeyEnv, CODEX_MODELS } = await import(pathToFileURL(path.join(__dirname, '../site/xin/vm-agent.mjs')).href + '?cxroute');
    const [, a] = agentArgs('codex', { started: false }, '你好', '');
    const cs = a.filter((x, i) => a[i - 1] === '-c');
    const cat = path.join(xinDir, 'codex-models.json');
    for (const want of ['model_provider="xin-gateway"', 'model_providers.xin-gateway.base_url="http://127.0.0.1:8788/v1"', 'model_providers.xin-gateway.wire_api="responses"',
      'model_providers.xin-gateway.env_key="XIN_CODEX_KEY"', 'model="glm-5.3-flash"', 'model_context_window=1000000', 'model_catalog_json=' + JSON.stringify(cat)])
      assert.ok(cs.includes(want), want + ' 不在 ' + JSON.stringify(cs));
    assert.deepStrictEqual(CODEX_MODELS.map(m => m.id), ['glm-5.3-flash', 'glm-5.3', 'kimi-k3.1-pro', 'deepseek-v4.1-flash']);
    const list = JSON.parse(fs.readFileSync(cat, 'utf8')).models;
    assert.deepStrictEqual(list.map(m => m.slug), ['gpt-5.5', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'glm-5.3', 'kimi-k3.1-pro']);
    const g = list[2];
    assert.deepStrictEqual([g.display_name, g.context_window, g.max_context_window, g.input_modalities, g.model_messages], ['GLM-5.3 Flash', 1000000, 1000000, ['text'], { instructions_template: 'T' }]);
    assert.deepStrictEqual([list[3].display_name, list[3].input_modalities, list[4].display_name, list[4].input_modalities], ['GLM-5.3', ['text', 'image'], 'Kimi K3.1 Pro', ['text', 'image']]);
    // 换模型：能看图的用 -i；不认识的当默认
    const [, k] = agentArgs('codex', { started: true, agentSid: 'th-1' }, '看图', '', { model: 'kimi-k3.1-pro', images: ['/x/a.png'] });
    assert.ok(k.includes('model="kimi-k3.1-pro"') && !k.includes('model="glm-5.3-flash"'));
    assert.deepStrictEqual(k.slice(0, 4), ['exec', 'resume', '-i', '/x/a.png']);
    const [, f] = agentArgs('codex', { started: false }, '看图', '', { model: 'gpt-9', images: ['/x/a.png'] });
    assert.ok(f.includes('model="glm-5.3-flash"') && !f.includes('-i'));
    // 续接也带
    const [, b] = agentArgs('codex', { started: true, agentSid: 'th-1' }, '再说', '');
    assert.ok(b.includes('model="glm-5.3-flash"') && b.slice(-2).join() === 'th-1,再说');
    assert.deepStrictEqual(codexKeyEnv(), { XIN_CODEX_KEY: 'hk' });
    fs.writeFileSync(path.join(xinDir, 'codex.key'), 'ck\n');
    assert.deepStrictEqual(codexKeyEnv(), { XIN_CODEX_KEY: 'ck' });
    // 配置里没写模型资料：不加 model_catalog_json，别的照带
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n');
    fs.rmSync(cat);
    const [, c] = agentArgs('codex', { started: false }, '你好', '');
    assert.ok(c.includes('model="glm-5.3-flash"') && !c.some(x => x.startsWith('model_catalog_json')));
  } finally { [process.env.XIN_HOME, process.env.CODEX_HOME] = saved; }
});

test('发文件：send 带 files（只认上传目录里的普通文件）；消息里列出路径（Codex 现在的模型看不了图，不用 -i）；只发文件不说话也行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-files-send-'));
  const bin = path.join(tmp, 'bin'), log = path.join(tmp, 'args.log');
  fs.mkdirSync(bin);
  // 假的 codex：把参数一行一个记下来，再回一句
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\ncase "$*" in *--ephemeral*) exit 0;; esac\nfor a in "$@"; do printf "%s\\n" "$a"; done > "' + log + '"\n' +
    'echo \'{"type":"thread.started","thread_id":"th-1"}\'\necho \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"看到了"}}\'\necho \'{"type":"turn.completed","usage":{}}\'\n', { mode: 0o755 });
  const { work, op } = agentEnv({ PATH: bin + ':' + process.env.PATH });
  const up = path.join(work, 'uploads', '20261106');
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, '003005-ab12-板子.jpg'), 'jpg');
  fs.writeFileSync(path.join(up, '003006-cd34-说明.pdf'), 'pdf');
  fs.writeFileSync(path.join(work, 'secret.txt'), 'x');
  fs.symlinkSync(path.join(work, 'secret.txt'), path.join(up, 'link.txt'));
  const img = path.join(up, '003005-ab12-板子.jpg'), pdf = path.join(up, '003006-cd34-说明.pdf');
  // 不在上传目录里、软链接指到外面、不存在、太多：都不行
  assert.strictEqual(op('send', { agent: 'codex', text: 'x', files: [{ path: path.join(work, 'secret.txt') }] }).error, 'bad_file');
  assert.strictEqual(op('send', { agent: 'codex', text: 'x', files: [{ path: path.join(up, 'link.txt') }] }).error, 'bad_file');
  assert.strictEqual(op('send', { agent: 'codex', text: 'x', files: [{ path: path.join(up, '../../uploads/20261106/../../secret.txt') }] }).error, 'bad_file');
  assert.strictEqual(op('send', { agent: 'codex', text: 'x', files: [{ path: path.join(up, 'none.png') }] }).error, 'no_file');
  assert.strictEqual(op('send', { agent: 'codex', text: 'x', files: Array.from({ length: 11 }, () => ({ path: img })) }).error, 'bad_files');
  assert.strictEqual(op('send', { agent: 'codex', text: '  ' }).error, 'empty');
  const r = op('send', { agent: 'codex', text: '', files: [{ path: img, name: '板子.jpg' }, { path: pdf, name: '说明.pdf' }] });
  assert.ok(r.run, JSON.stringify(r));
  assert.strictEqual(r.title, '板子.jpg、说明.pdf');
  let p = null;
  for (let i = 0; i < 60; i++) { p = op('poll', { run: r.run, off: 0 }); if (p.done) break; await new Promise(ok => setTimeout(ok, 150)); }
  const user = p.events[0];
  assert.deepStrictEqual(user.files, [{ name: '板子.jpg', path: img, size: 3, image: true }, { name: '说明.pdf', path: pdf, size: 3, image: false }]);
  assert.strictEqual(user.text, '');
  const args = fs.readFileSync(log, 'utf8').split('\n');
  assert.deepStrictEqual(args.slice(0, 2), ['exec', '--json']);
  assert.ok(!args.includes('-i'));
  assert.ok(args.includes('model_reasoning_effort="high"'));   // 没选思考强度：明确带默认 high
  const prompt = args.join('\n');
  assert.ok(prompt.includes('看看我发的文件。') && prompt.includes('【用户发来的文件（已经在你电脑上）】') && prompt.includes(img + '（板子.jpg，图片，3 B）') && prompt.includes(pdf + '（说明.pdf，3 B）') && prompt.includes('看不了图片'), prompt.slice(-400));
  // 换成能看图的模型接着聊：这一轮用它，图片用 -i，对话上记下模型
  const r2 = op('send', { sid: r.sid, model: 'glm-5.3', effort: 'max', text: '这张呢', files: [{ path: img, name: '板子.jpg' }] });
  assert.ok(r2.run, JSON.stringify(r2));
  for (let i = 0; i < 60; i++) { p = op('poll', { run: r2.run, off: 0 }); if (p.done) break; await new Promise(ok => setTimeout(ok, 150)); }
  const args2 = fs.readFileSync(log, 'utf8').split('\n');
  assert.deepStrictEqual(args2.slice(0, 4), ['exec', 'resume', '-i', img]);
  assert.ok(args2.includes('model="glm-5.3"') && args2.includes('model_reasoning_effort="max"') && args2.join('\n').includes('图片已经直接给你看了'));
  assert.strictEqual(op('sessions').sessions.find(x => x.sid === r.sid).model, 'glm-5.3');
});

test('Harness：dsh headless --json 起，带小芯设定（--patch）、满权限、网关 key 用环境变量；事件整理、会话号、接着聊（--session-id）、用量；删对话连它的会话一起删', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-harness-'));
  const dshHome = path.join(tmp, 'dsh'), log = path.join(tmp, 'calls.log'), dsh = path.join(tmp, 'dsh-bin');
  const SID = 'session-1de23629-51a4-47e9-8626-be15439b8b66';
  // 假的 dsh：记下参数和环境，建一个会话目录，按真 dsh 的格式吐事件
  fs.writeFileSync(dsh, '#!/bin/sh\n{ printf "ARGS"; for a in "$@"; do printf " [%s]" "$a"; done; echo; echo "KEY=$XIN_HARNESS_KEY MODE=$DSH_PERMISSION_MODE"; } >> "' + log + '"\n' +
    'mkdir -p "$XIN_DSH_HOME/sessions/--w--/' + SID + '" "$XIN_DSH_HOME/storages/session_projcache/sessions"; echo x > "$XIN_DSH_HOME/sessions/--w--/' + SID + '/session.v4.jsonl.zstd"; echo {} > "$XIN_DSH_HOME/storages/session_projcache/sessions/' + SID + '.json"\n' +
    'echo \'{"type":"session","sessionId":"' + SID + '","cwd":"/w"}\'\n' +
    'echo \'{"type":"status","phase":"turn_start","turn":1}\'\n' +
    'echo \'{"type":"thinking","text":"想一想"}\'\n' +
    'echo \'{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"ls /w","description":"看看"}}\'\n' +
    'printf \'%s\\n\' \'{"type":"tool_result","callId":"c1","status":"completed","result":"a\\nb\\n"}\'\n' +
    'echo \'{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":5000,"outputTokens":20,"totalTokens":5020}}\'\n' +
    'echo \'{"type":"text","text":"有 a 和 b"}\'\n' +
    'echo \'{"type":"status","phase":"step_end","turn":1,"step":2,"usage":{"inputTokens":6000,"outputTokens":30,"totalTokens":6030}}\'\n' +
    'echo \'{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}\'\n' +
    'echo \'{"type":"final","text":"有 a 和 b"}\'\n', { mode: 0o755 });
  const { xin, op } = agentEnv({ XIN_DSH: dsh, XIN_DSH_HOME: dshHome });
  fs.mkdirSync(xin, { recursive: true });
  fs.writeFileSync(path.join(xin, 'harness.key'), 'gw-key-123\n', { mode: 0o600 });
  assert.ok(op('ping').agents.includes('harness'));
  const poll = async run => { let p; for (let i = 0; i < 60; i++) { p = op('poll', { run, off: 0 }); if (p.done) return p; await new Promise(ok => setTimeout(ok, 150)); } return p; };
  const r = op('send', { text: '-看看目录', effort: 'off' });   // 没指定 AI：默认 Harness；思考强度「关」
  assert.strictEqual(r.agent, 'harness');
  const p = await poll(r.run);
  assert.deepStrictEqual(p.events.map(e => e.t), ['user', 'tool', 'tool_end', 'text', 'done'], JSON.stringify(p.events));
  assert.deepStrictEqual([p.events[1].name, p.events[1].detail, p.events[2].ok, p.events[2].out], ['Bash', 'ls /w', true, 'a\nb\n']);
  const done = p.events[4];
  assert.ok(done.ok);
  assert.deepStrictEqual(done.usage, { ctx: 6030, win: 1000000, input: 11000, output: 50, total: 11050 });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.match(calls[0], /^ARGS \[--profile\] \[headless\] \[--patch\] \[[^\]]+harness-persona\.deepseek-v4\.1-flash\.off\.yml\] \[--json\] \[ -看看目录/);
  assert.ok(calls.includes('KEY=gw-key-123 MODE=danger-full-access'), calls.join('\n').slice(-300));
  const persona = fs.readFileSync(path.join(xin, 'harness-persona.deepseek-v4.1-flash.off.yml'), 'utf8');
  // 思考强度：档位对照表（关 = none）+ 这一轮用的档
  assert.ok(persona.includes('            reasoningEfforts:\n              off: none\n              low: low\n              high: high\n              max: max\n') && persona.includes('    reasoningEffort: off\n'), persona.slice(0, 900));
  assert.ok(persona.includes('- id: system-prompt') && persona.includes('personaPrefix: "你就是小芯'));
  // 线路也在这个补丁里：不靠 ~/.dsh 里的配置
  assert.ok(persona.includes('- id: llm-pi-ai') && persona.includes('apiKeyEnv: XIN_HARNESS_KEY') && persona.includes('baseURL: "http://127.0.0.1:8788/v1"') &&
    persona.includes('- id: agent-default-model') && persona.includes('provider: xin-gateway') && persona.includes('model: "deepseek-v4.1-flash"'), persona.slice(0, 600));
  const sess = JSON.parse(fs.readFileSync(path.join(xin, 'sessions', r.sid + '.json'), 'utf8'));
  assert.deepStrictEqual([sess.agentSid, sess.started], [SID, true]);
  // 接着聊：--session-id；用量累加
  const r2 = op('send', { sid: r.sid, text: '再说一句', effort: 'xhigh' });   // 不支持的档：用默认 high
  const p2 = await poll(r2.run);
  assert.match(fs.readFileSync(log, 'utf8').trim().split('\n').filter(l => l.startsWith('ARGS')).pop(), /harness-persona\.deepseek-v4\.1-flash\.high\.yml/);
  assert.ok(fs.readFileSync(path.join(xin, 'harness-persona.deepseek-v4.1-flash.high.yml'), 'utf8').includes('    reasoningEffort: high\n'));
  assert.strictEqual(fs.readFileSync(log, 'utf8').split('[--session-id] [' + SID + ']').length, 2);   // 第二句才带
  assert.deepStrictEqual(p2.events.pop().usage, { ctx: 6030, win: 1000000, input: 22000, output: 100, total: 22100 });
  assert.deepStrictEqual(op('history', { sid: r.sid }).usage.total, 22100);
  // 换 Harness 模型后，续聊没再指定 model 也保留选择；插件开关分开存，不覆盖先前一轮的补丁。
  const profile = path.join(dshHome, 'profiles', 'headless'); fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-purge-community': 'file:fixture.tgz' } }));
  assert.deepStrictEqual(op('plugins', { agent: 'harness' }).plugins.map(p => [p.name, p.on]), [['purge', true]]);
  assert.ok(op('plugin_set', { agent: 'harness', name: 'purge', on: false }).ok);
  const r3 = op('send', { sid: r.sid, text: '切换到 GLM', model: 'glm-5.3', effort: 'off' });
  assert.ok((await poll(r3.run)).events.pop().ok);
  const offFile = path.join(xin, 'harness-persona.glm-5.3.high.purge-off.yml'), offPatch = fs.readFileSync(offFile, 'utf8');
  assert.ok(offPatch.includes('    model: "glm-5.3"\n    reasoningEffort: high\n'));
  assert.ok(offPatch.includes('contextWindow: 1000000') && offPatch.endsWith('- id: dsh-purge\n  config:\n    enabled: false\n'));
  assert.strictEqual(op('history', { sid: r.sid }).session.model, 'glm-5.3');
  assert.ok(op('plugin_set', { agent: 'harness', name: 'purge', on: true }).ok);
  const r4 = op('send', { sid: r.sid, text: '保留这个模型' });
  assert.ok((await poll(r4.run)).events.pop().ok);
  assert.ok(fs.readFileSync(path.join(xin, 'harness-persona.glm-5.3.high.purge-on.yml'), 'utf8').endsWith('    enabled: true\n'));
  assert.strictEqual(fs.readFileSync(offFile, 'utf8'), offPatch);
  assert.strictEqual(op('history', { sid: r.sid }).session.model, 'glm-5.3');
  assert.deepStrictEqual(op('plugins', { agent: 'claude' }).plugins, []);
  // 清旧记录：Harness 的会话号不算坏文件；对话还在，不删
  assert.deepStrictEqual(op('prune'), { codex: 0, claude: 0, harness: 0, bytes: 0 });
  // 删对话：连 Harness 的会话目录和缓存一起删
  assert.ok(op('forget', { sid: r.sid }).ok);
  assert.ok(!fs.existsSync(path.join(dshHome, 'sessions', '--w--', SID)));
  assert.ok(!fs.existsSync(path.join(dshHome, 'storages', 'session_projcache', 'sessions', SID + '.json')));
});

test('Harness 事件整理：出错、没做完都说清楚；会话号格式不对不拿去拼路径', async () => {
  const { fromHarness } = await load('../site/xin/vm-agent.mjs');
  const st = {};
  assert.deepStrictEqual(fromHarness({ type: 'error', message: 'MISSING_CREDENTIAL' }, st), [{ t: 'err', text: 'MISSING_CREDENTIAL' }]);
  assert.ok(st.failed);
  const st2 = {};
  assert.deepStrictEqual(fromHarness({ type: 'status', phase: 'turn_end', reason: { kind: 'aborted' } }, st2), [{ t: 'err', text: '这一轮没做完（aborted）' }]);
  assert.deepStrictEqual(fromHarness({ type: 'final', text: 'x' }, {}), []);
  assert.deepStrictEqual(fromHarness({ type: 'thinking', text: 'x' }, {}), []);
  const { xin, op } = agentEnv();
  fs.mkdirSync(path.join(xin, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(xin, 'sessions', 'sh00000001.json'), JSON.stringify({ sid: 'sh00000001', agent: 'harness', title: 'x', agentSid: '../../x', started: true, runs: [], created: 1, updated: 1 }));
  assert.strictEqual(op('prune').skipped, 'bad_session_file');
  assert.strictEqual(op('history', { sid: 'sh00000001' }).usage, null);
});

test('发文件提示：Codex / Harness / Claude 按能不能看图写清楚；Harness 没有 -i，能看图也只说用工具打开路径', async () => {
  const { filesPart } = await load('../site/xin/vm-agent.mjs');
  const img = [{ path: '/data/workspace/uploads/a.png', name: 'a.png', size: 3, image: true }];
  const mix = img.concat([{ path: '/data/workspace/uploads/b.pdf', name: 'b.pdf', size: 4, image: false }]);
  assert.ok(filesPart(img, 'codex', true).includes('图片已经直接给你看了。'));
  assert.ok(filesPart(img, 'codex', false).includes('看不了图片内容'));
  assert.ok(filesPart(img, 'harness', true).includes('用工具打开上面的路径就能看') && !filesPart(img, 'harness', true).includes('已经直接给你看了'));
  assert.ok(filesPart(img, 'harness', false).includes('看不了图片内容'));
  assert.ok(filesPart(img, 'claude', true).includes('图片用 Read 工具打开就能看'));
  assert.ok(filesPart(mix, 'harness', false).includes('a.png') && filesPart(mix, 'harness', false).includes('b.pdf'));
  assert.strictEqual(filesPart([], 'harness', true), '');
  assert.ok(!filesPart([{ path: '/x', name: 'a.txt', size: 1, image: false }], 'harness', true).includes('看不了'));
});

test('归档：只是收起来（记录、AI 的会话记录都留着），能取消；对话列表带 archived，归档的排在后面', () => {
  const { xin, op } = agentEnv();
  const sess = path.join(xin, 'sessions'), runs = path.join(xin, 'runs');
  fs.mkdirSync(sess, { recursive: true }); fs.mkdirSync(runs, { recursive: true });
  const mk = (sid, updated) => {
    fs.writeFileSync(path.join(sess, sid + '.json'), JSON.stringify({ sid, agent: 'codex', title: sid, runs: ['r' + sid.slice(1)], created: 1, updated }));
    fs.writeFileSync(path.join(runs, 'r' + sid.slice(1) + '.jsonl'), JSON.stringify({ t: 'done', ok: true }) + '\n');
  };
  mk('sa00000001', 3); mk('sb00000001', 2); mk('sc00000001', 1);
  const r = op('archive', { sid: 'sa00000001' });
  assert.deepStrictEqual([r.ok, r.session.archived], [true, true]);
  assert.deepStrictEqual(op('sessions').sessions.map(s => [s.sid, s.archived]), [['sb00000001', false], ['sc00000001', false], ['sa00000001', true]]);
  assert.ok(fs.existsSync(path.join(runs, 'ra00000001.jsonl')));
  assert.strictEqual(op('history', { sid: 'sa00000001' }).runs.length, 1);   // 归档的照样能打开
  assert.strictEqual(op('archive', { sid: 'sa00000001', on: false }).session.archived, false);
  assert.deepStrictEqual(op('sessions').sessions.map(s => s.sid), ['sa00000001', 'sb00000001', 'sc00000001']);
  assert.ok(!('archivedAt' in JSON.parse(fs.readFileSync(path.join(sess, 'sa00000001.json'), 'utf8'))));
  assert.strictEqual(op('archive', { sid: '../x' }).error, 'bad_sid');
  assert.strictEqual(op('archive', { sid: 'snone00001' }).error, 'no_session');
});

test('删对话时连 Codex / Claude 自己的会话记录一起删；没有对应对话的旧记录也清掉（只清网站开的、1 小时前的）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-logs-'));
  const codexHome = path.join(tmp, 'codex'), claudeHome = path.join(tmp, 'claude'), bin = path.join(tmp, 'bin'), log = path.join(tmp, 'codex.log');
  fs.mkdirSync(bin);
  // 假的 codex：记下参数，像真的 `codex delete --force <id>` 一样删掉记录文件
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho "$@" >> "' + log + '"\n[ "$1" = delete ] && [ "$2" = --force ] && find "$CODEX_HOME/sessions" -name "*-$3.jsonl" -delete\nexit 0\n', { mode: 0o755 });
  const { xin, op } = agentEnv({ CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, PATH: bin + ':' + process.env.PATH });
  const id = n => '01a1a1f7-0000-7000-8000-' + String(n).padStart(12, '0');
  const old = (Date.now() - 2 * 3600e3) / 1000;
  const cxDir = path.join(codexHome, 'sessions', '2026', '11', '05');
  fs.mkdirSync(cxDir, { recursive: true });
  const cx = (n, originator, recent) => {
    const f = path.join(cxDir, 'rollout-2026-11-05T10-00-00-' + id(n) + '.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'session_meta', payload: { id: id(n), cwd: '/data/workspace', originator } }) + '\n' + 'x'.repeat(1000) + '\n');
    if (!recent) fs.utimesSync(f, old, old);
    return f;
  };
  const clDir = path.join(claudeHome, 'projects', '-data-workspace');
  fs.mkdirSync(clDir, { recursive: true });
  const cl = (n, promptSource, recent) => {
    const f = path.join(clDir, id(n) + '.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'user', sessionId: id(n), promptSource, message: { role: 'user', content: '你好' } }) + '\n');
    if (!recent) fs.utimesSync(f, old, old);
    return f;
  };
  const sess = path.join(xin, 'sessions'), runs = path.join(xin, 'runs');
  fs.mkdirSync(sess, { recursive: true }); fs.mkdirSync(runs, { recursive: true });
  const mkSess = (sid, agent, agentSid) => {
    const run = 'r' + sid.slice(1);
    fs.writeFileSync(path.join(sess, sid + '.json'), JSON.stringify({ sid, agent, title: '对话', agentSid, started: true, runs: [run], created: 1, updated: 1 }));
    fs.writeFileSync(path.join(runs, run + '.jsonl'), JSON.stringify({ t: 'done', ok: true }) + '\n');
    fs.writeFileSync(path.join(runs, run + '.json'), JSON.stringify({ run, sid, started: 1, pid: process.pid }));
  };
  const fA = cx(1, 'codex_exec'), fB = cx(2, 'codex_exec');                    // 两个对话在用的
  const fOrphan = cx(3, 'codex_exec');                                          // 对话早删了的：清掉
  const fMine = cx(4, 'codex_cli_rs');                                          // 自己在终端里开的：不动
  const fNew = cx(5, 'codex_exec', true);                                       // 刚开的、还没记进对话：不动
  const fC = cl(6, 'sdk'), cOrphan = cl(7, 'sdk'), cMine = cl(8, 'user');
  fs.mkdirSync(path.join(clDir, id(6), 'subagents'), { recursive: true });     // Claude 会话的同名文件夹也一起删
  mkSess('sa00000001', 'codex', id(1));
  mkSess('sb00000001', 'codex', id(2));
  mkSess('sc00000001', 'claude', id(6));
  // 已失去网页关联的记录必须有网站自己的归属登记，不能只凭 exec / SDK 标记来删。
  const owned = path.join(xin, 'agent-sessions'); fs.mkdirSync(owned);
  for (const [agent, n] of [['codex', 3], ['codex', 5], ['claude', 7]])
    fs.writeFileSync(path.join(owned, agent + '-' + id(n) + '.json'), JSON.stringify({ agent, id: id(n) }));
  const exists = l => l.map(f => fs.existsSync(f));

  const r = op('forget', { sid: 'sa00000001' });
  assert.ok(r.ok && r.freed > 2000, JSON.stringify(r));
  assert.deepStrictEqual(exists([fA, fB, fOrphan, fMine, fNew]), [false, true, false, true, true]);
  assert.deepStrictEqual(exists([fC, cOrphan, cMine]), [true, false, true]);
  // Codex 的用它自己的命令删（连它的索引一起清）
  assert.deepStrictEqual(fs.readFileSync(log, 'utf8').trim().split('\n').sort(), ['delete --force ' + id(1), 'delete --force ' + id(3)]);

  assert.ok(op('forget', { sid: 'sc00000001' }).ok);
  assert.deepStrictEqual(exists([fC, path.join(clDir, id(6))]), [false, false]);
  assert.deepStrictEqual(op('prune'), { codex: 0, claude: 0, harness: 0, bytes: 0 });

  // 有一个对话文件读不出来：整个不清，宁可留着
  fs.utimesSync(fNew, old, old);
  fs.writeFileSync(path.join(sess, 'sbad000001.json'), '{坏了');
  assert.strictEqual(op('prune').skipped, 'bad_session_file');
  assert.ok(fs.existsSync(fNew));
  fs.unlinkSync(path.join(sess, 'sbad000001.json'));

  // codex 删不掉（版本老、没这个命令）：直接删文件
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const size = fs.statSync(fNew).size;
  assert.deepStrictEqual(op('prune'), { codex: 1, claude: 0, harness: 0, bytes: size });
  assert.deepStrictEqual(exists([fB, fNew, fMine, cMine]), [true, false, true, true]);
  // 对话的会话号不像样（被改坏了）：不拿它去拼路径
  fs.writeFileSync(path.join(sess, 'sd00000001.json'), JSON.stringify({ sid: 'sd00000001', agent: 'codex', title: 'x', agentSid: '../../etc/passwd', runs: [], created: 1, updated: 1 }));
  assert.deepStrictEqual(op('forget', { sid: 'sd00000001' }), { ok: true, freed: 0 });
  assert.ok(fs.existsSync(fB));
});

test('对话的用量：Codex 取记录里最后一条 token_count（累计、最近一次、上限），做完那一轮的 done 和 history 都带上；Claude 把每条回答的 usage 去重加起来', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-usage-'));
  const codexHome = path.join(tmp, 'codex'), claudeHome = path.join(tmp, 'claude'), bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const id1 = '01a1a903-c5b4-75b0-a77d-233a63d598c6', id2 = '3f6c9a50-1111-4222-8333-444455556666';
  // Codex 的记录：两条 token_count（取后一条）、一条 info 是空的；最后跟一段很长的命令输出（从尾巴往前读 256KB 找不到，要多读一些）
  const cxDir = path.join(codexHome, 'sessions', '2026', '11', '05');
  fs.mkdirSync(cxDir, { recursive: true });
  const tc = (total, last) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 } } });
  fs.writeFileSync(path.join(cxDir, 'rollout-2026-11-05T00-02-39-' + id1 + '.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: id1, originator: 'codex_exec' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
    tc({ input_tokens: 1000, cached_input_tokens: 500, output_tokens: 10, total_tokens: 1010 }, { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 }),
    tc({ input_tokens: 3699260, cached_input_tokens: 3567104, output_tokens: 28753, reasoning_output_tokens: 11523, total_tokens: 3728013 }, { input_tokens: 118789, output_tokens: 1553, total_tokens: 120342 }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(300 * 1024) } })
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(bin, 'codex'), [
    '#!/bin/sh',
    'case "$*" in *--ephemeral*) exit 0;; esac',
    'echo \'{"type":"thread.started","thread_id":"' + id1 + '"}\'',
    'echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"好了"}}\'',
    'echo \'{"type":"turn.completed","usage":{}}\''
  ].join('\n'), { mode: 0o755 });
  const { xin, op } = agentEnv({ CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, PATH: bin + ':' + process.env.PATH });
  const want1 = { ctx: 120342, win: 258400, input: 3699260, cached: 3567104, output: 28753, total: 3728013 };
  const r = op('send', { agent: 'codex', text: '你好' });
  let p = null;
  for (let i = 0; i < 60; i++) { p = op('poll', { run: r.run, off: 0 }); if (p.done) break; await new Promise(ok => setTimeout(ok, 150)); }
  const done = p.events.find(e => e.t === 'done');
  assert.deepStrictEqual(done.usage, want1, JSON.stringify(p.events));
  assert.deepStrictEqual(op('history', { sid: r.sid }).usage, want1);

  // Claude：同一条回答拆成几行（后面那行的 usage 才是最终的），子任务（isSidechain）算进消耗、不算上下文；上限用跑的时候记下的
  const clDir = path.join(claudeHome, 'projects', '-data-workspace');
  fs.mkdirSync(clDir, { recursive: true });
  const as = (id, u, side) => JSON.stringify({ type: 'assistant', isSidechain: !!side, message: { id, role: 'assistant', usage: u } });
  fs.writeFileSync(path.join(clDir, id2 + '.jsonl'), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '你好' } }),
    as('m1', { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000, output_tokens: 1 }),
    as('m1', { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000, output_tokens: 200 }),
    as('m3', { input_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300, output_tokens: 400 }),
    as('m2', { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 50 }, true)
  ].join('\n') + '\n');
  const sess = path.join(xin, 'sessions');
  fs.writeFileSync(path.join(sess, 'scl0000001.json'), JSON.stringify({ sid: 'scl0000001', agent: 'claude', title: 'c', agentSid: id2, started: true, ctxWin: 1000000, runs: [], created: 1, updated: 1 }));
  assert.deepStrictEqual(op('history', { sid: 'scl0000001' }).usage, { ctx: 5720, win: 1000000, input: 10433, cached: 5100, output: 650, total: 11083 });
  // 还没开始的、会话号不像样的：没有用量
  fs.writeFileSync(path.join(sess, 'snew000001.json'), JSON.stringify({ sid: 'snew000001', agent: 'claude', title: 'n', agentSid: crypto.randomUUID(), started: false, runs: [], created: 1, updated: 1 }));
  fs.writeFileSync(path.join(sess, 'sbad000001.json'), JSON.stringify({ sid: 'sbad000001', agent: 'codex', title: 'b', agentSid: '../x', started: true, runs: [], created: 1, updated: 1 }));
  assert.strictEqual(op('history', { sid: 'snew000001' }).usage, null);
  assert.strictEqual(op('history', { sid: 'sbad000001' }).usage, null);
});

test('设定里教了：STM32 空工程怎么编译、文件写完整路径（「考考我」已经去掉）', async () => {
  const { systemPrompt } = await load('../site/xin/vm-agent.mjs');
  const p = systemPrompt('');
  assert.ok(p.includes('/stm32-template') && p.includes('make') && p.includes('build/app.hex') && p.includes('setup-stm32.sh'));
  assert.ok(p.includes('小芯的文件') && p.includes('完整路径'));
  assert.ok(!p.includes('考考我'));
});

test('STM32 环境脚本：语法对、头文件版本固定、不用 nosys.specs、带 syscalls.c、自己的 main.c 不覆盖', () => {
  const { spawnSync } = require('node:child_process');
  const f = path.join(__dirname, '../scripts/vm/setup-stm32.sh');
  assert.strictEqual(spawnSync('sh', ['-n', f]).status, 0);
  const s = fs.readFileSync(f, 'utf8');
  assert.match(s, /cmsis_device_f1\/v\d+\.\d+\.\d+/);
  assert.match(s, /CMSIS_5\/\d+\.\d+\.\d+/);
  assert.ok(!s.includes('nosys.specs'));
  assert.ok(s.includes('cat > "$T/syscalls.c"') && s.includes('_sbrk') && s.includes('__attribute__((weak))'));
  assert.ok(s.includes('[ -f "$T/main.c" ] ||'));
  assert.ok(s.includes('LENGTH = 512K') && s.includes('LENGTH = 64K'));
});

/* ---------- 做完提醒（Web Push） ---------- */
function pushDecrypt(body, uaEcdh, auth) {   // 模拟浏览器那一端：按 RFC 8291 解开
  const crypto = require('node:crypto');
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], as = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', uaEcdh.computeSecret(as), Buffer.from(auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), as]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.strictEqual(pt[pt.length - 1], 2, '最后一条记录以 0x02 结尾');
  return { rs, idlen, text: pt.subarray(0, pt.length - 1).toString() };
}
function fakeBrowser() {
  const crypto = require('node:crypto');
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  return { ecdh: ua, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

test('推送加密（RFC 8291 aes128gcm）：浏览器那端解得开；VAPID 签名验得过，aud 是推送服务的源', async () => {
  const crypto = require('node:crypto');
  const { pushEncrypt, vapidHeader, vapidKeys } = await load('../site/xin/vm-agent.mjs');
  const br = fakeBrowser();
  const msg = JSON.stringify({ title: '小芯做完了', body: '编好啦：app.hex' });
  const out = pushDecrypt(pushEncrypt(msg, br.keys.p256dh, br.keys.auth), br.ecdh, br.keys.auth);
  assert.deepStrictEqual(out, { rs: 4096, idlen: 65, text: msg });
  assert.throws(() => pushEncrypt('x', 'AAAA', br.keys.auth));
  const keys = vapidKeys();
  assert.strictEqual(vapidKeys().publicKey, keys.publicKey, '钥匙只生成一次');
  const h = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys, Date.UTC(2026, 10, 4));
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert.ok(m, h);
  assert.strictEqual(m[4], keys.publicKey);
  const raw = Buffer.from(m[4], 'base64url');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.deepStrictEqual(claims, { aud: 'https://fcm.googleapis.com', exp: Date.UTC(2026, 10, 4) / 1000 + 12 * 3600, sub: 'https://liming-work.com' });
});

test('推送订阅：只收 https 和对的钥匙；同一个地址只记一次；最多 8 个；能去掉；VAPID 私钥文件只有自己能读', () => {
  const { xin, op } = agentEnv();
  const k = op('push_key');
  assert.match(k.key, /^[A-Za-z0-9_-]{87}$/);
  assert.strictEqual(op('push_key').key, k.key);
  assert.strictEqual(fs.statSync(path.join(xin, 'push', 'vapid.json')).mode & 0o777, 0o600);
  const br = fakeBrowser();
  const sub = n => ({ endpoint: 'https://push.example.com/send/' + n, keys: br.keys });
  assert.strictEqual(op('push_sub', { sub: { endpoint: 'http://push.example.com/x', keys: br.keys } }).error, 'bad_sub');
  assert.strictEqual(op('push_sub', { sub: { endpoint: 'https://push.example.com/x', keys: { p256dh: 'AAAA', auth: br.keys.auth } } }).error, 'bad_sub');
  assert.strictEqual(op('push_sub', { sub: 'nope' }).error, 'bad_sub');
  assert.strictEqual(op('push_sub', { sub: sub(1), ua: 'iPhone' }).subs, 1);
  assert.strictEqual(op('push_sub', { sub: sub(1) }).subs, 1);
  for (let i = 2; i <= 10; i++) op('push_sub', { sub: sub(i) });
  const saved = JSON.parse(fs.readFileSync(path.join(xin, 'push', 'subs.json'), 'utf8'));
  assert.deepStrictEqual(saved.map(s => s.endpoint.split('/').pop()), ['3', '4', '5', '6', '7', '8', '9', '10']);
  assert.strictEqual(op('push_unsub', { endpoint: sub(10).endpoint }).subs, 7);
  assert.strictEqual(op('push_key').subs, 7);
});

test('做完提醒：网页没在看时做完就推送（解得开、带标题和回答开头、点了打开那段对话），网页在看时不推；推送服务说订阅没了就删掉', async () => {
  const http = require('node:http');
  const { execFileSync } = require('node:child_process');
  const got = [];
  let reply = 201;
  const srv = http.createServer((q, r) => { const b = []; q.on('data', c => b.push(c)); q.on('end', () => { got.push({ url: q.url, headers: q.headers, body: Buffer.concat(b) }); r.writeHead(reply); r.end(); }); });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port;
  try {
    const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-push-')), bin = path.join(home, 'fakebin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), [
      '#!/bin/sh',
      'echo \'{"type":"thread.started","thread_id":"th-1"}\'',
      'sleep 1',
      // dash 的 echo 会把 \\n 变成真换行，JSON 就断了：用 printf %s
      'printf \'%s\\n\' \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"编好啦！\\n\\n```c\\nint main(void){}\\n```\\n烧录文件在 /data/workspace/blink/build/app.hex"}}\'',
      'echo \'{"type":"turn.completed","usage":{}}\''
    ].join('\n'), { mode: 0o755 });
    const env = Object.assign({}, process.env, { XIN_HOME: path.join(home, 'xin'), XIN_WORK: path.join(home, 'work'), XIN_PUSH_INSECURE: '1', PATH: bin + ':' + process.env.PATH });
    const op = (name, args) => JSON.parse(execFileSync(process.execPath, [agent, name], { env, input: JSON.stringify(args || {}) }).toString());
    const br = fakeBrowser();
    assert.strictEqual(op('push_sub', { sub: { endpoint: `http://127.0.0.1:${port}/push/a`, keys: br.keys } }).ok, true);
    const wait = async (run, watch) => {
      for (let i = 0; i < 80; i++) {
        const p = watch ? op('poll', { run, off: 0 }) : JSON.parse(fs.readFileSync(path.join(home, 'xin', 'runs', run + '.jsonl'), 'utf8').trim().split('\n').pop());
        if (watch ? p.done : p.t === 'done') return;
        await new Promise(s => setTimeout(s, 150));
      }
      throw new Error('没做完');
    };
    // 1. 发完就没人看了：推送
    const r1 = op('send', { agent: 'codex', text: '写个点灯程序' });
    await wait(r1.run, false);
    for (let i = 0; i < 40 && !got.length; i++) await new Promise(s => setTimeout(s, 100));
    assert.strictEqual(got.length, 1);
    const g = got[0];
    assert.strictEqual(g.url, '/push/a');
    assert.strictEqual(g.headers['content-encoding'], 'aes128gcm');
    assert.strictEqual(g.headers.ttl, '86400');
    assert.match(g.headers.authorization, /^vapid t=[^.]+\.[^.]+\.[^,]+, k=[A-Za-z0-9_-]{87}$/);
    const msg = JSON.parse(pushDecrypt(g.body, br.ecdh, br.keys.auth).text);
    assert.strictEqual(msg.title, '小芯做完了');
    assert.ok(msg.body.startsWith('编好啦！') && !msg.body.includes('```') && msg.body.includes('app.hex'), msg.body);
    assert.deepStrictEqual([msg.tag, msg.sid, msg.url], ['xin-' + r1.sid, r1.sid, '/#xin=' + r1.sid]);
    // 2. 网页一直在取进度：不推送
    const r2 = op('send', { sid: r1.sid, text: '再来一次' });
    // 这一轮还在跑时读历史：带着它什么时候开始的（网页重新打开面板，「思考中 · N 秒」接着算）
    const h2 = op('history', { sid: r1.sid });
    assert.ok(h2.active && h2.active.run === r2.run && typeof h2.active.started === 'number' && Math.abs(Date.now() - h2.active.started) < 5000, JSON.stringify(h2.active));
    await wait(r2.run, true);
    await new Promise(s => setTimeout(s, 600));
    assert.strictEqual(got.length, 1, '网页在看的时候不推送');
    // 3. 推送服务说订阅没了（410）：删掉。推送服务就在这个进程里，要用异步的 execFile，不然它答不了话
    reply = 410;
    const t = await new Promise((ok, no) => {
      const c = require('node:child_process').execFile(process.execPath, [agent, 'push_test'], { env }, (e, out) => (e ? no(e) : ok(JSON.parse(out))));
      c.stdin.end('{}');
    });
    assert.deepStrictEqual([t.ok, t.results[0].status], [false, 410]);
    assert.strictEqual(op('push_key').subs, 0);
    // 删对话时连「网页取过进度」的记号一起删
    assert.ok(fs.existsSync(path.join(home, 'xin', 'runs', r2.run + '.seen')));
    op('forget', { sid: r1.sid });
    assert.ok(!fs.existsSync(path.join(home, 'xin', 'runs', r2.run + '.seen')));
    // 小芯的屏幕：每一轮同时写进 screen.log（你说的、它说的、做完没有）
    const scr = fs.readFileSync(path.join(home, 'xin', 'screen.log'), 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(/── 你（\d\d:\d\d）：写个点灯程序/.test(scr) && scr.includes('小芯：编好啦！') && scr.includes('── 做完了'), scr);
  } finally { srv.close(); }
});

test('sw.js：收到推送弹通知（标题、正文、点了去哪），点通知打开或切到网站；不拦截请求', () => {
  const src = fs.readFileSync(path.join(__dirname, '../site/sw.js'), 'utf8');
  const L = {};
  const shown = [], opened = [], posted = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (k, f) => { L[k] = f; },
    skipWaiting() {}, clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve(self._wins || []), openWindow: u => { opened.push(u); return Promise.resolve(); } },
    registration: { showNotification: (t, o) => { shown.push([t, o]); return Promise.resolve(); } }
  };
  new Function('self', 'URL', src)(self, URL);
  assert.ok(!L.fetch, '不拦截请求');
  let p;
  L.push({ data: { json: () => ({ title: '小芯做完了', body: '编好啦', tag: 'xin-sabc12345', sid: 'sabc12345', url: '/#xin=sabc12345' }) }, waitUntil: x => { p = x; } });
  assert.deepStrictEqual([shown[0][0], shown[0][1].body, shown[0][1].tag, shown[0][1].data], ['小芯做完了', '编好啦', 'xin-sabc12345', { url: '/#xin=sabc12345', sid: 'sabc12345' }]);
  const click = data => new Promise(ok => L.notificationclick({ notification: { close() {}, data }, waitUntil: x => x.then(ok) }));
  return click({ url: '/#xin=sabc12345', sid: 'sabc12345' }).then(() => {
    assert.deepStrictEqual(opened, [ORIGIN + '/#xin=sabc12345']);
    self._wins = [{ url: ORIGIN + '/tools/', postMessage: m => posted.push(m), focus: () => Promise.resolve('focused') }];
    return click({ url: '/#xin=sabc12345', sid: 'sabc12345' });
  }).then(() => {
    assert.deepStrictEqual(posted, [{ type: 'xin-open', sid: 'sabc12345' }]);
    assert.strictEqual(opened.length, 1, '网站开着就不再新开');
  });
});

test('网页用到的每个 op，Worker 都放行，vm-agent 也都认识（漏一个线上就是 400 bad_op）', async () => {
  const { OPS } = await load('../src/xin.js');
  const chat = fs.readFileSync(path.join(__dirname, '../site/xin/chat.js'), 'utf8');
  const used = [...new Set([...chat.matchAll(/call\('([a-z_]+)'/g)].map(m => m[1]))];
  assert.ok(used.length > 10, used.join());
  const missing = used.filter(op => !OPS.has(op));
  assert.deepStrictEqual(missing, [], 'Worker 的 OPS 里少了：' + missing.join(', '));
  const agent = fs.readFileSync(path.join(__dirname, '../site/xin/vm-agent.mjs'), 'utf8');
  const local = new Set(['status', 'wake', 'screen_off']);   // 这几个 Worker 自己调 InstaBox，不进云电脑（screen 两边都有）
  const unknown = [...OPS].filter(op => !local.has(op) && !new RegExp('^  (async )?' + op + '\\(', 'm').test(agent));
  assert.deepStrictEqual(unknown, [], 'vm-agent 的 ops 里没有：' + unknown.join(', '));
});

test('推送加密和 RFC 8291 附录 A 的例子逐字节一样（浏览器那边一定解得开）', async () => {
  const { pushEncrypt } = await load('../site/xin/vm-agent.mjs');
  const u = s => Buffer.from(s.replace(/\s+/g, ''), 'base64url');
  const out = pushEncrypt(u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
    { salt: u('DGv6ra1nlYgDCS1FRnbzlw'), asPrivate: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') });
  assert.strictEqual(out.toString('base64url'), `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`.replace(/\s+/g, ''));
});

/* ---------- 学会新动作、好感度 ---------- */
test('新动作：只认能画出来的字段和取值，数字截到范围里，没写 t 用 200；名字、帧数、总时长都有上限', async () => {
  const { cleanMove } = await load('../site/xin/vm-agent.mjs');
  const ok = cleanMove('  挥手  打招呼 ', [{ armR: 'wave', face: 'hap', dy: -9, sx: 0.6 }, { armR: 'up', t: 5000 }]);
  assert.deepStrictEqual(ok, { name: '挥手 打招呼', frames: [{ armR: 'wave', face: 'hap', dy: -6, sx: 1, t: 200 }, { armR: 'up', t: 1500 }] });
  assert.strictEqual(cleanMove('超过十二个字的动作名字会被截断', [{}]).name, '超过十二个字的动作名字会');
  assert.match(cleanMove('', [{}]).error, /名字/);
  assert.match(cleanMove('a', {}).error, /数组/);
  assert.match(cleanMove('a', [{ armR: 'fly' }]).error, /armR 只能是/);
  assert.match(cleanMove('a', [{ item: 'cookie' }]).error, /不认识的字段：item/);
  assert.match(cleanMove('a', [{ fn: 'alert(1)' }]).error, /不认识的字段/);
  assert.match(cleanMove('a', [{ t: '100' }]).error, /t 要是数字/);
  assert.match(cleanMove('a', Array(49).fill({})).error, /最多 48 帧/);
  assert.match(cleanMove('a', Array(11).fill({ t: 1500 })).error, /最长 15 秒/);
});

test('新动作：xin move add 学会（网页马上做一遍）、xin move 名字 让网页做、list、rm；坏 JSON 给出用法', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const { xin, op } = agentEnv();
  const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
  const runs = path.join(xin, 'runs'); fs.mkdirSync(runs, { recursive: true });
  const run = 'rmove000001'; fs.writeFileSync(path.join(runs, run + '.jsonl'), '');
  const env = Object.assign({}, process.env, { XIN_HOME: xin, XIN_RUN: run });
  const xinCmd = (...a) => spawnSync(process.execPath, [agent, 'xin', 'move', ...a], { env, encoding: 'utf8' });
  const add = xinCmd('add', '打招呼', '[{"armR":"up","face":"hap","t":250},{"armR":"wave","t":250}]');
  assert.strictEqual(add.status, 0, add.stdout);
  assert.match(add.stdout, /学会了：打招呼（2 帧），网页上的小芯马上做一遍/);
  assert.strictEqual(xinCmd('add', '坏的', '[{armR:up}]').status, 2);
  assert.match(xinCmd('add', '坏的', '[{"armR":"fly"}]').stdout, /armR 只能是/);
  assert.match(xinCmd('help').stdout, /xin move add 名字/);
  assert.match(xinCmd('list').stdout, /打招呼（2 帧）/);
  assert.strictEqual(xinCmd('打招呼').status, 0);
  assert.strictEqual(xinCmd('不存在').status, 1);
  const evs = fs.readFileSync(path.join(runs, run + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(evs.map(e => e.t + ':' + (e.name || e.arg)), ['move:打招呼', 'xin:打招呼']);
  assert.deepStrictEqual(evs[1].frames, [{ armR: 'up', face: 'hap', t: 250 }, { armR: 'wave', t: 250 }]);
  assert.deepStrictEqual(op('moves').moves.map(m => m.name), ['打招呼']);
  assert.strictEqual(xinCmd('rm', '打招呼').status, 0);
  assert.deepStrictEqual(op('moves').moves, []);
  void execFileSync;
});

test('好感度：聊天一天最多 +5、陪玩最多 +3、每天第一次见面 +1；小芯自己加减一次最多 3、一天合计 6；好久没来会掉；分等级', async () => {
  const { bondAdd, bondInfo, bondLevel, BOND_LEVELS } = await load('../site/xin/vm-agent.mjs');
  fs.rmSync(path.join(process.env.XIN_HOME, 'bond.json'), { force: true });
  const day = Date.UTC(2026, 10, 4, 2);   // 北京时间 11-04 10:00
  for (let i = 0; i < 7; i++) bondAdd('chat', 1, '陪我聊天', day + i);
  assert.strictEqual(bondInfo().score, 5);
  for (let i = 0; i < 5; i++) bondAdd('play', 1, '喂我吃饼干', day + 10 + i);
  assert.strictEqual(bondInfo().score, 8);
  bondAdd('visit', 1, '今天来看我了', day + 20); bondAdd('visit', 1, '今天来看我了', day + 21);
  assert.strictEqual(bondInfo().score, 9);
  assert.strictEqual(bondAdd('ai', 5, '你夸我了', day + 30).delta, 3);
  assert.strictEqual(bondAdd('ai', -2, '你凶我', day + 31).delta, -2);
  assert.strictEqual(bondAdd('ai', 3, '答对了', day + 32).delta, 1, '一天合计 6');
  assert.strictEqual(bondAdd('ai', 1, '再加', day + 33).delta, 0);
  assert.strictEqual(bondInfo().score, 11);
  // 第二天：额度重新算
  assert.strictEqual(bondAdd('chat', 1, '陪我聊天', day + 86400e3).delta, 1);
  // 10 天没来：多出来的 7 天每天 -2（只扣一次），然后这次见面 +1
  const back = day + 11 * 86400e3;
  bondAdd('visit', 1, '今天来看我了', back);
  const info = bondInfo();
  assert.strictEqual(info.score, 12 - 14 < 0 ? 1 : 12 - 14 + 1);
  assert.deepStrictEqual(info.log.slice(0, 2).map(l => l.why), ['今天来看我了', '10 天没来看我']);
  assert.strictEqual(bondAdd('visit', 1, '今天来看我了', back + 1000).delta, 0);
  assert.deepStrictEqual(BOND_LEVELS.map(l => bondLevel(l[0]).name), ['刚认识', '熟悉', '好朋友', '最好的朋友']);
  assert.deepStrictEqual([bondLevel(14).level, bondLevel(15).level, bondLevel(79).next, bondLevel(200).next], [0, 1, 80, null]);
});

test('好感度、新动作进了设定；greet 顺便带回去；xin bond 在聊天里留一条', async () => {
  const { spawnSync } = require('node:child_process');
  const { xin, op } = agentEnv();
  const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
  const g = op('greet');
  assert.deepStrictEqual([g.bond.score, g.bond.name, g.moves], [1, '刚认识', []]);
  const runs = path.join(xin, 'runs'); fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'rbond000001.jsonl'), '');
  const env = Object.assign({}, process.env, { XIN_HOME: xin, XIN_RUN: 'rbond000001' });
  assert.strictEqual(spawnSync(process.execPath, [agent, 'xin', 'bond', 'abc'], { env, encoding: 'utf8' }).status, 2);
  const r = spawnSync(process.execPath, [agent, 'xin', 'bond', '+2', '答对了定时器的题'], { env, encoding: 'utf8' });
  assert.match(r.stdout, /好感度 \+2，现在 3（刚认识）/);
  const ev = JSON.parse(fs.readFileSync(path.join(runs, 'rbond000001.jsonl'), 'utf8').trim());
  assert.deepStrictEqual([ev.t, ev.d, ev.why, ev.score, ev.name], ['bond', 2, '答对了定时器的题', 3, '刚认识']);
  assert.strictEqual(op('bond_play', { kind: 'cookie' }).info.log[0].why, '喂我吃饼干');
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', `import { systemPrompt } from ${JSON.stringify(require('node:url').pathToFileURL(agent).href)}; process.stdout.write(systemPrompt(''));`], { env, encoding: 'utf8' }).stdout;
  assert.ok(p.includes('你和用户现在的关系：刚认识（好感度 4）') && p.includes('xin bond +1 理由') && p.includes('xin move help') && p.includes('已经会的：还没有'), p.slice(-600));
});

/* ---------- 小芯的屏幕 ---------- */
test('小芯的屏幕：开桌面 → 桌面上开终端 → 要观看链接（只看、30 分钟）；接管要能操作的链接（15 分钟）；screen_off 作废全部链接', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/desktop': [{ body: { installed: true, running: true, controller: 'agent' } }],
    'POST /v1/machines/m_abc/exec': [{ body: { stdout: '{"ok":true,"opened":true}', stderr: '', exitCode: 0 } }],
    'POST /v1/machines/m_abc/desktop/stream': [(u, init) => new Response(JSON.stringify({ url: 'https://dashboard.instabox.sh/desktop/m_abc#token=' + (JSON.parse(init.body).viewOnly ? 'v' : 'c'), expiresAt: '2026-11-05T03:00:00Z' }))],
    'DELETE /v1/machines/m_abc/desktop/stream': [{ status: 204 }]
  });
  const call = async (op, args) => (await m.handleXin(req('/api/xin/call', { body: { op, args }, headers: { cookie: ck } }), env, null)).json();
  try {
    const v = await call('screen', {});
    assert.deepStrictEqual(v, { ok: true, data: { url: 'https://dashboard.instabox.sh/desktop/m_abc#token=v', expiresAt: '2026-11-05T03:00:00Z', control: false, terminal: true } });
    const c = await call('screen', { control: true });
    assert.deepStrictEqual([c.data.url.endsWith('token=c'), c.data.control], [true, true]);
    const desk = ib.calls.filter(x => x.key.endsWith('/desktop')).map(x => JSON.parse(x.body));
    assert.deepStrictEqual(desk[0], { action: 'start', width: 1280, height: 800 });
    const streams = ib.calls.filter(x => x.key === 'POST /v1/machines/m_abc/desktop/stream').map(x => JSON.parse(x.body));
    assert.deepStrictEqual(streams, [{ viewOnly: true, ttlSeconds: 1800 }, { viewOnly: false, ttlSeconds: 900 }]);
    assert.strictEqual(JSON.parse(ib.calls.find(x => x.key.endsWith('/exec')).body).argv[2], 'screen');
    assert.deepStrictEqual(await call('screen_off', {}), { ok: true, data: { ok: true } });
    assert.ok(ib.calls.some(x => x.key === 'DELETE /v1/machines/m_abc/desktop/stream'));
  } finally { ib.restore(); }
});

test('小芯的屏幕：电脑在睡就叫醒（waking）；桌面在装回 waking；key 不是创建者自己的给出明白的说法；开不了终端也照样给链接', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const call = async (op, args) => (await m.handleXin(req('/api/xin/call', { body: { op, args }, headers: { cookie: ck } }), env, null)).json();
  let ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/desktop': [{ status: 409, body: { error: { code: 'machine_not_running' } } }, { body: { installed: false, installing: true, running: false } }],
    'GET /v1/machines/m_abc': [{ body: { id: 'm_abc', state: 'suspended' } }],
    'POST /v1/machines/m_abc/resume': [{ status: 202, body: {} }]
  });
  try {
    assert.strictEqual((await call('screen', {})).state, 'waking');
    assert.ok(ib.calls.some(x => x.key.endsWith('/resume')));
    assert.strictEqual((await call('screen', {})).state, 'waking');
  } finally { ib.restore(); }
  m._reset();
  const ck2 = await login(m, env);
  ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/desktop': [{ body: { installed: true, running: true } }],
    'POST /v1/machines/m_abc/exec': [{ body: { stdout: '{"error":"no_terminal"}', stderr: '', exitCode: 0 } }],
    'POST /v1/machines/m_abc/desktop/stream': [{ status: 403, body: { error: { code: 'permission_denied' } } }, { body: { url: 'https://x/desktop/m_abc#token=v', expiresAt: 'z' } }]
  });
  const call2 = async (op, args) => (await m.handleXin(req('/api/xin/call', { body: { op, args }, headers: { cookie: ck2 } }), env, null)).json();
  try {
    const d = await call2('screen', {});
    assert.deepStrictEqual([d.ok, d.state], [false, 'error']);
    assert.match(d.msg, /创建这台云电脑的人自己的 key/);
    const ok = await call2('screen', {});
    assert.deepStrictEqual([ok.ok, ok.data.terminal, ok.data.url], [true, false, 'https://x/desktop/m_abc#token=v']);
  } finally { ib.restore(); }
});

test('小芯的屏幕：screen.log 每一类事件写成好读的一行（命令去掉 /bin/bash -lc 外壳，输出太长只留前面）；电脑里没终端时 screen 说清楚', async () => {
  const { screenLine, bareCmd } = await load('../site/xin/vm-agent.mjs');
  const plain = ev => screenLine(ev, Date.UTC(2026, 10, 5, 2, 30)).replace(/\x1b\[[0-9;]*m/g, '');
  assert.strictEqual(plain({ t: 'user', text: '写个\n点灯程序' }), '\n── 你（10:30）：写个 点灯程序\n');
  assert.strictEqual(plain({ t: 'text', text: '好嘞\n马上' }), '小芯：好嘞\n      马上\n');
  assert.strictEqual(plain({ t: 'tool', detail: "/bin/bash -lc 'cd /data/workspace/blink && make'" }), '$ cd /data/workspace/blink && make\n');
  assert.strictEqual(bareCmd('/bin/bash -lc "echo \\"hi\\""'), 'echo "hi"');
  assert.strictEqual(bareCmd("/bin/bash -lc 'echo '\\''a'\\'''"), "echo 'a'");
  const long = plain({ t: 'tool_end', ok: false, out: Array.from({ length: 35 }, (_, i) => 'line' + i).join('\n') });
  assert.ok(long.includes('  line29\n') && !long.includes('line30') && long.includes('…（还有 5 行）') && long.endsWith('  ✗ 没成功\n'), long);
  assert.strictEqual(plain({ t: 'done', ok: true, ms: 41200 }), '── 做完了 · 41 秒\n');
  assert.strictEqual(plain({ t: 'status', text: 'x' }), '');
  // 这个用例验证「没装终端」；隔离 PATH，避免开发机装着桌面终端时误启动它。
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-no-terminal-'));
  fs.writeFileSync(path.join(bin, 'sh'), '#!/bin/sh\nif [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
  const { op, xin } = agentEnv({ PATH: bin });
  const r = op('screen');
  assert.strictEqual(r.error, 'no_terminal');
  assert.ok(fs.readFileSync(path.join(xin, 'screen.log'), 'utf8').includes('小芯的屏幕'));
});
