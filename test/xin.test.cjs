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

test('设定里教了：STM32 空工程怎么编译、文件写完整路径、考考我怎么出题', async () => {
  const { systemPrompt } = await load('../site/xin/vm-agent.mjs');
  const p = systemPrompt('');
  assert.ok(p.includes('/stm32-template') && p.includes('make') && p.includes('build/app.hex') && p.includes('setup-stm32.sh'));
  assert.ok(p.includes('小芯的文件') && p.includes('完整路径'));
  assert.ok(p.includes('考考我') && p.includes('一次一道') && p.includes('xin remember'));
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
