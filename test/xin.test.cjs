// 小芯聊天：Worker 登录 / 转发 InstaBox，以及 vm-agent 把 Claude Code / Codex 的输出整理成事件
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// vm-agent 的记事本写到临时目录（要在第一次 import 之前设好）
const os = require('node:os'), fs = require('node:fs');
process.env.XIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-test-'));
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

test('思考强度：自动时写代码的活用 max，聊天不指定；手动指定原样用', async () => {
  const { resolveEffort } = await load('../site/xin/vm-agent.mjs');
  for (const t of ['帮我写一个 STM32 点灯的 main.c', '编译报错了：undefined reference', '这段代码有 bug', '```c\nint a;\n```', '把 led.c 改一下', '实现一个 I2C 驱动'])
    assert.strictEqual(resolveEffort('auto', t), 'max', t);
  for (const t of ['你好', 'GPIO 的推挽输出是什么意思？', 'APB2 的时钟是多少'])
    assert.strictEqual(resolveEffort('auto', t), '', t);
  assert.strictEqual(resolveEffort(undefined, '写代码'), 'max');
  assert.strictEqual(resolveEffort('high', '写代码'), 'high');
  assert.strictEqual(resolveEffort('max', '你好'), 'max');
  assert.strictEqual(resolveEffort('low', '你好'), 'low');
  assert.strictEqual(resolveEffort('xhigh', '你好'), '');   // 不认识的值当自动
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
  const env = Object.assign({}, process.env, { XIN_HOME: home, XIN_WORK: path.join(home, 'work'), XIN_STALL_MS: '800', PATH: bin + ':' + process.env.PATH });
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
test('改名、删除、文件这几个 op 都转给 vm-agent', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/exec': [{ body: { stdout: '{"ok":true}', stderr: '', exitCode: 0 } }] });
  try {
    for (const op of ['rename', 'forget', 'files']) {
      const d = await (await m.handleXin(req('/api/xin/call', { body: { op, args: { sid: 'sabc123' } }, headers: { cookie: ck } }), env, null)).json();
      assert.deepStrictEqual(d, { ok: true, data: { ok: true } }, op);
    }
    assert.deepStrictEqual(ib.calls.filter(c => c.key.endsWith('/exec')).map(c => JSON.parse(c.body).argv[2]), ['rename', 'forget', 'files']);
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

function agentEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-files-')), work = path.join(home, 'work');
  const env = Object.assign({}, process.env, { XIN_HOME: path.join(home, 'xin'), XIN_WORK: work });
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
  assert.strictEqual(op('rename', { sid: 'sdone00001', title: '  点灯\n程序  ' }).session.title, '点灯 程序');
  assert.strictEqual(op('sessions').sessions.find(s => s.sid === 'sdone00001').title, '点灯 程序');
  assert.strictEqual(op('rename', { sid: 'sdone00001', title: '   ' }).error, 'empty');
  assert.strictEqual(op('rename', { sid: '../x', title: 'a' }).error, 'bad_sid');
  assert.strictEqual(op('rename', { sid: 'snone00001', title: 'a' }).error, 'no_session');
  assert.strictEqual(op('forget', { sid: 'sbusy00001' }).error, 'busy');
  assert.ok(fs.existsSync(path.join(sess, 'sbusy00001.json')));
  assert.deepStrictEqual(op('forget', { sid: 'sdone00001' }), { ok: true });
  assert.deepStrictEqual(['sdone00001.json', 'rdone00001.jsonl', 'rdone00001.json'].map(f => fs.existsSync(path.join(f[0] === 's' ? sess : runs, f))), [false, false, false]);
  assert.deepStrictEqual(op('sessions').sessions.map(s => s.sid), ['sbusy00001']);
  assert.deepStrictEqual(op('forget', { sid: 'sdone00001' }), { ok: true, already: true });
  assert.strictEqual(op('forget', { sid: '../../etc' }).error, 'bad_sid');
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
  const { op, xin } = agentEnv();
  const r = op('screen');
  assert.strictEqual(r.error, 'no_terminal');
  assert.ok(fs.readFileSync(path.join(xin, 'screen.log'), 'utf8').includes('小芯的屏幕'));
});
