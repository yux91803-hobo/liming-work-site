// 小芯聊天：Worker 登录 / 转发 InstaBox，以及 vm-agent 把 Claude Code / Codex 的输出整理成事件
const test = require('node:test');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { captureRunContext } = require('./helpers/run-context.cjs');
process.env.XIN_CODEX_TRANSPORT = 'exec'; // Legacy adapter remains covered; app-server has separate protocol tests.
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
// 这个文件在测试进程里直接调控制器模块（系统提示、记忆、好感度……），用的就是上面这个 XIN_HOME：测试进程自己当主人
// （正式环境里这些代码跑在常驻状态进程里，test/helpers/own-state.cjs）。要起控制器子进程的测试各用 agentEnv(t) 自己的目录和状态进程。
test.before(() => require('./helpers/own-state.cjs').ownState());
const load = rel => import(pathToFileURL(path.join(__dirname, rel)).href);
// A whole fresh module graph (vm-agent and every module it imports) that reads the current environment.
// A query string on vm-agent alone no longer suffices: shared modules such as vm-base are cached by URL.
function freshAgentUrl(tag) {
  const src = path.join(__dirname, '../site/xin'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-mod-' + tag + '-'));
  for (const f of fs.readdirSync(src).filter(f => /^vm-.*\.mjs$/.test(f))) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  return pathToFileURL(path.join(dir, 'vm-agent.mjs')).href;
}
// 换了 XIN_HOME 的整套新模块要写库时：先让这套模块拿那个目录的所有权（它在测试里扮演那个目录的状态进程）
async function freshOwnedAgent(tag) {
  const url = freshAgentUrl(tag);
  const { ownership } = await import(url.replace(/vm-agent\.mjs$/, 'vm-base.mjs'));
  if (!ownership.owning) ownership.take({ waitMs: 5000 });
  return import(url);
}
const PW = 'correct horse battery';
const AGENT_TEXT = '// fake vm-agent\n';
const ORIGIN = 'https://liming-work.com';

function mkEnv(extra) {
  return Object.assign({
    OWNER_PASSWORD: PW,
    INSTABOX_API_KEY: 'ibk_test_key_1234567890',
    XIN_MACHINE: 'li',
    XIN_LOGIN_LIMIT: { limit: async () => ({ success: true }) },
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
// 控制器文件一次 exec 装到电脑上：argv 是 node -e <安装小程序> <目录>，标准输入是要装的文件（按顺序）
const isInstall = c => c.key.endsWith('/exec') && JSON.parse(c.body).argv[1] === '-e';
const installed = calls => calls.filter(isInstall).flatMap(c => JSON.parse(JSON.parse(c.body).stdin));

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

test('登录限流的绑定没配上：不收密码（503），也不发 cookie', async () => {
  const m = await fresh();
  for (const XIN_LOGIN_LIMIT of [undefined, {}]) {
    const r = await m.handleXin(req('/api/xin/login', { body: { password: PW } }), mkEnv({ XIN_LOGIN_LIMIT }), null);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.headers.get('set-cookie'), null);
    assert.strictEqual((await r.json()).error, 'no_rate_limit');
  }
});

test('找不到云电脑时：预览和任务回调回 502 加说明，不抛成 500', async () => {
  const m = await fresh(), env = mkEnv({ XIN_TASK_SUPERVISOR: { idFromName: () => 'id', get: () => ({ fetch: async () => new Response('{}') }) } }), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [{ status: 500, body: { error: { code: 'internal', message: 'down' } } }] });
  try {
    const p = await m.handleXin(new Request(ORIGIN + '/api/xin/preview/' + 'a'.repeat(32) + '/index.html', { headers: { cookie: ck } }), env, null);
    // 预览先问控制器要元数据（这一步就要找云电脑）：找不到也只是 5xx 加说明
    assert.ok(p.status === 502 || p.status === 503, String(p.status));
    const token = await m._callbackToken(env);
    const c = await m.handleXin(new Request(ORIGIN + '/api/xin/task-event', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ bg: 1, version: 2 }) }), env, null);
    assert.strictEqual(c.status, 502);
    assert.strictEqual((await c.json()).ok, false);
  } finally { ib.restore(); }
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
      { body: { stdout: '{"ok":true}', stderr: '', exitCode: 0 } },
      { body: { stdout: JSON.stringify({ sid: 'sabc123', run: 'rabc123' }), stderr: '', exitCode: 0 } }
    ],
    'PUT /v1/machines/m_abc/activity-leases/xin-rabc123': [{ body: {} }]
  });
  const waits = [];
  try {
    const r = await m.handleXin(req('/api/xin/call', { body: { op: 'send', args: { agent: 'claude', text: '你好' } }, headers: { cookie: ck } }), env, { waitUntil: p => waits.push(p) });
    const d = await r.json();
    await Promise.all(waits);
    assert.deepStrictEqual(d, { ok: true, data: { sid: 'sabc123', run: 'rabc123' } });
    const execs = ib.calls.filter(c => c.key.endsWith('/exec'));
    assert.strictEqual(execs.length, 3);
    const body = JSON.parse(execs[0].body);
    assert.strictEqual(body.argv[0], 'node');
    assert.match(body.argv[1], /^\/data\/home\/\.xin\/agent\/vm-agent-[0-9a-f]{12}\.mjs$/);
    assert.strictEqual(body.argv[2], 'send');
    assert.deepStrictEqual(JSON.parse(body.stdin), { agent: 'claude', text: '你好' });
    // 一次 exec 装好：argv 是 node -e <安装小程序> <目录>，标准输入是要装的文件
    const install = JSON.parse(execs[1].body);
    assert.deepStrictEqual([install.argv[0], install.argv[1], install.argv[3]], ['node', '-e', '/data/home/.xin/agent']);
    assert.deepStrictEqual(JSON.parse(install.stdin).map(f => [f.path, f.text, f.mode]), [[body.argv[1], AGENT_TEXT, '0755']]);
    assert.deepStrictEqual(JSON.parse(execs[2].body), body, '装好后原样再跑一次');
    assert.ok(!ib.calls.some(c => c.key.startsWith('PUT /v1/machines/m_abc/files')));
    assert.ok(ib.calls.some(c => c.key.includes('activity-leases')));
    for (const c of ib.calls) assert.strictEqual(c.init.headers['X-API-Key'], 'ibk_test_key_1234567890');
  } finally { ib.restore(); }
});

test('上传小芯脚本：按 import 递归带上全部本地模块，文件名带内容摘要，import 指向对应的新文件名', async () => {
  const site = path.join(__dirname, '../site');
  const assets = { fetch: async r => { const f = path.join(site, new URL(r.url).pathname); return fs.existsSync(f) ? new Response(fs.readFileSync(f, 'utf8')) : new Response('nope', { status: 404 }); } };
  const m = await fresh(), env = mkEnv({ ASSETS: assets }), ck = await login(m, env);
  const ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [
      { body: { stdout: '', stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/data/home/.xin/agent/vm-base-x.mjs'", exitCode: 1 } },
      { body: { stdout: '{"ok":true}', stderr: '', exitCode: 0 } },
      { body: { stdout: JSON.stringify({ ok: true, agents: [] }), stderr: '', exitCode: 0 } }
    ]
  });
  try {
    const d = await (await m.handleXin(req('/api/xin/call', { body: { op: 'ping' }, headers: { cookie: ck } }), env, null)).json();
    assert.strictEqual(d.ok, true);
    const puts = installed(ib.calls).map(f => ({ name: path.basename(f.path), body: f.text }));
    const uploaded = new Map(puts.map(p => [p.name, p.body]));
    const local = fs.readdirSync(path.join(site, 'xin')).filter(f => /^vm-.*\.mjs$/.test(f));
    for (const f of local) assert.ok([...uploaded.keys()].some(n => new RegExp('^' + f.replace('.mjs', '') + '-[0-9a-f]{12}\\.mjs$').test(n)), '没有上传 ' + f);
    assert.strictEqual(puts.at(-1).name.startsWith('vm-agent-'), true, '依赖先传，入口最后传');
    for (const [name, body] of uploaded) for (const dep of [...body.matchAll(/from '\.\/(vm-[^']+)'/g)].map(x => x[1])) {
      assert.match(dep, /-[0-9a-f]{12}\.mjs$/, name + ' 里的 import 没有改成带摘要的文件名');
      assert.ok(uploaded.has(dep), name + ' 引用了没上传的 ' + dep);
    }
  } finally { ib.restore(); }
});

test('上传小芯脚本：缺模块或模块循环引用时明确报错，不上传半套', async () => {
  const files = { '/xin/vm-agent.mjs': "import { a } from './vm-a.mjs';\n", '/xin/vm-a.mjs': "import { b } from './vm-b.mjs';\nexport const a = 1;\n", '/xin/vm-b.mjs': "import { a } from './vm-a.mjs';\nexport const b = 2;\n" };
  for (const [files2, code] of [[files, 'module_cycle'], [{ '/xin/vm-agent.mjs': "import { a } from './vm-missing.mjs';\n" }, 'no_runtime']]) {
    const m = await fresh(), env = mkEnv({ ASSETS: { fetch: async r => files2[new URL(r.url).pathname] ? new Response(files2[new URL(r.url).pathname]) : new Response('nope', { status: 404 }) } }), ck = await login(m, env);
    const ib = fakeIB({ 'GET /v1/machines': [MACHINES] });
    try {
      const d = await (await m.handleXin(req('/api/xin/call', { body: { op: 'ping' }, headers: { cookie: ck } }), env, null)).json();
      assert.strictEqual(d.ok, false); assert.ok(!ib.calls.some(c => c.key.startsWith('PUT') || c.key.endsWith('/exec')), code);
      assert.match(d.msg, code === 'module_cycle' ? /循环依赖/ : /缺 vm-missing\.mjs/);
    } finally { ib.restore(); }
  }
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

test('Codex 每一轮都带小芯的设定（developer_instructions），续接对话也带；第一句不再拼设定；前台教派分身，每日任务、分身自己不教；分身在沙盒里', async () => {
  const { agentArgs, systemPrompt, taskSystemPrompt } = await load('../site/xin/vm-agent.mjs');
  const dev = a => JSON.parse(a[a.findIndex(x => x.startsWith('developer_instructions='))].slice('developer_instructions='.length));
  for (const sess of [{ started: false, agentSid: null }, { started: true, agentSid: 'th-1' }]) {
    const [, a] = agentArgs('codex', sess, '你好', '');
    const i = a.findIndex(x => x.startsWith('developer_instructions='));
    assert.ok(i > 0 && a[i - 1] === '-c');
    assert.strictEqual(dev(a), systemPrompt(undefined, { tasks: true }));
    assert.strictEqual(a[a.length - 1], '你好');
    assert.ok(a.includes('--dangerously-bypass-approvals-and-sandbox') && !a.includes('--sandbox'));
  }
  const p = systemPrompt();
  assert.ok(p.includes('你就是小芯') && p.includes('第一人称') && p.includes('自己的电脑') && p.includes('不要说出'));
  assert.ok(!p.includes('xin task new') && systemPrompt(undefined, { tasks: true }).includes('xin task new'));
  const [, d] = agentArgs('codex', { started: false }, '每日', '', { role: 'daily' });
  assert.ok(!dev(d).includes('xin task new'));
  // 分身：自己的设定（在后台、别问问题、只改自己的目录、不可撤销的先 xin task ask），沙盒（只能写自己的目录等），-C 自己的目录
  const task = { kind: 'task', no: 7, title: '编译 LED', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'xin-taskdir-')), started: false };
  task.sid = 'sprofiletest';
  task.workspace = (await load('../site/xin/vm-runtime.mjs')).prepareWorkspace(task, process.env.XIN_HOME);
  const [, t] = agentArgs('codex', task, '做', '', { role: 'task', sandbox: true });
  assert.strictEqual(dev(t), taskSystemPrompt(task));
  assert.ok(dev(t).includes('后台任务 7「编译 LED」') && dev(t).includes('xin task ask') && dev(t).includes(task.workspace.work) && !dev(t).includes('xin task new'));
  assert.ok(!t.includes('--dangerously-bypass-approvals-and-sandbox') && t.includes('default_permissions="xin-task"'));
  const profile = t.find(x => x.startsWith('permissions.xin-task.filesystem='));
  assert.ok(profile.includes(JSON.stringify(task.workspace.work) + '="write"'));
  assert.ok(profile.includes(JSON.stringify(process.env.XIN_HOME) + '="deny"'));
  assert.ok(!profile.includes(JSON.stringify(process.env.XIN_HOME) + '="write"'));
  // 沙盒里插件要人批准，后台没人批：分身的插件全关
  assert.ok(!t.some(x => /^mcp_servers\.[^.]+\.enabled=true$/.test(x)));
  assert.deepStrictEqual(t.slice(-3), ['-C', task.workspace.work, '做']);
  // 关掉沙盒（XIN_TASK_SANDBOX=0 时 runner 传 sandbox:false）：照旧完全放权
  const [, t2] = agentArgs('codex', task, '做', '', { role: 'task', sandbox: false });
  assert.ok(t2.includes('--dangerously-bypass-approvals-and-sandbox') && !t2.includes('--sandbox'));
});

test('记忆：remember 去掉换行；用户明确说的马上生效，观察和推测先待确认；同样的内容不重复记', async () => {
  const { remember, listMemory } = await load('../site/xin/vm-agent.mjs');
  assert.strictEqual(remember('  '), '');
  assert.strictEqual(remember('用户叫小李\n在学定时器', { basis: 'stated' }), '用户叫小李 在学定时器');
  remember('喜欢先看代码');
  remember('用户叫小李 在学定时器', { basis: 'stated' });
  const items = listMemory().filter(i => /小李|先看代码/.test(i.content)).map(i => [i.content, i.status, i.basis]).sort();
  assert.deepStrictEqual(items, [['喜欢先看代码', 'pending', 'observed'], ['用户叫小李 在学定时器', 'active', 'stated']]);
});

test('记忆：设定里带记忆库的内容；空的写「还是空的」；太长截断并提醒整理；教它分清依据', async () => {
  const { systemPrompt } = await load('../site/xin/vm-agent.mjs');
  assert.ok(systemPrompt('- 用户叫小李').includes('<<<记忆\n- 用户叫小李\n记忆>>>'));
  assert.ok(systemPrompt('').includes('（还是空的）'));
  const long = systemPrompt('x'.repeat(20000));
  assert.ok(long.includes('该整理了') && long.length < systemPrompt('').length + 8200, '长记忆截断到上限以内');
  for (const p of [systemPrompt(''), systemPrompt('', { tasks: true })]) assert.ok(p.includes('xin remember') && p.includes('stated') && p.includes('inferred') && p.includes('xin') && p.includes('forget'));
});

test('记忆：Codex 每轮的 developer_instructions 里带着确认过的记忆', async () => {
  const { agentArgs, remember } = await load('../site/xin/vm-agent.mjs');
  remember('最近在调 I2C', { basis: 'stated', type: 'project' });
  remember('也许讨厌长代码', { basis: 'inferred' });
  const [, a] = agentArgs('codex', { started: true, agentSid: 'th-1' }, '你好', '');
  const dev = JSON.parse(a.find(x => x.startsWith('developer_instructions=')).slice('developer_instructions='.length));
  assert.ok(dev.includes('最近在调 I2C') && !dev.includes('也许讨厌长代码'), '只带确认过的，推测不当成事实');
});

test('身份：设定写明以它为准；每句后面悄悄附提醒（历史里不显示）', async () => {
  const { systemPrompt, forAgent, REMIND } = await load('../site/xin/vm-agent.mjs');
  const p = systemPrompt('');
  assert.ok(p.includes('这份设定优先') && p.includes('InstaBox 云电脑'));
  // 被问到是什么模型：自然地说不知道，不说「秘密」「不能说」
  assert.ok(p.includes('如实简短回答') && !p.includes('像一个真的不清楚'));
  assert.ok(REMIND.includes('不编造') && !REMIND.includes('真不知道'));
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

test('wrangler：没有 XIN_STATE_OWNER 开关了（删旧模式第 2 步），正式站和测试站都有 version_metadata 绑定', () => {
  const src = fs.readFileSync(path.join(__dirname, '../wrangler.jsonc'), 'utf8');
  const top = src.slice(0, src.indexOf('"env"')), stg = src.slice(src.indexOf('"env"'));
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /"XIN_STATE_OWNER"/, '正式站、测试站都不再设');
  for (const part of [top, stg]) assert.match(part, /"version_metadata":\s*\{\s*"binding":\s*"CF_VERSION_METADATA"\s*\}/);
});

test('wrangler：正式站有两个定时任务，测试站一个都没有', () => {
  const src = fs.readFileSync(path.join(__dirname, '../wrangler.jsonc'), 'utf8');
  const top = src.slice(0, src.indexOf('"env"')), stg = src.slice(src.indexOf('"env"'));
  assert.match(top, /"triggers":\s*\{\s*"crons":\s*\["55 0 \* \* \*", "10 1,13 \* \* \*"\]\s*\}/);
  assert.match(stg, /"triggers":\s*\{\s*"crons":\s*\[\]\s*\}/);
});

test('开场白：xin next 写一句，3 天内有效（主动跟进默认关，打开才说）；设定里不再教 xin next，每日任务清单照旧', async () => {
  const { setNext, getNext, systemPrompt, dailyPrompt, DAILY_FILE } = await load('../site/xin/vm-agent.mjs');
  assert.strictEqual(setNext('  '), null);
  const g = setNext('今天签到好啦\n连签 10 天');
  assert.strictEqual(g.text, '今天签到好啦 连签 10 天');
  assert.strictEqual(getNext(), null, '主动跟进默认关（站长 2026-11-11 不要），开场白不说');
  const { setMemoryPreferences } = await load('../site/xin/vm-memory.mjs');
  setMemoryPreferences({ followups: true });
  assert.deepStrictEqual(getNext(), g);
  assert.strictEqual(getNext(Date.now() + 4 * 86400e3), null);
  const p = systemPrompt('');
  assert.ok(!p.includes('xin next') && p.includes(DAILY_FILE()) && p.includes('别自己用 cron'));
  const d = dailyPrompt('- 网关签到');
  assert.ok(d.includes('<<<每日任务\n- 网关签到\n每日任务>>>') && !d.includes('xin next') && d.includes('别问问题'));
});

test('真跑 vm-agent（假 codex）：第一次卡住 → 自动重来 → 做完；记下今天做过，再叫就跳过；开场白默认不说，打开主动跟进才取得到', async t => {
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
  const ensureState = require('./helpers/state-mode.cjs').stateClient(t, env);
  const op = (name, args) => { ensureState(); return JSON.parse(execFileSync(process.execPath, [agent, name], { env, input: JSON.stringify(args || {}) }).toString()); };
  assert.deepStrictEqual(op('daily'), { skipped: 'empty' });
  op('daily_set', { text: '- 网关签到' });
  const r = op('daily');
  assert.strictEqual(r.agent, 'codex');
  let p = null, completed = null;
  // A model turn can finish before the controller has published the daily task and its day marker.
  for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) { p = op('poll', { run: r.run, off: 0 }); if (p.done) { completed=op('tasks',{all:true}).tasks.find(t=>t.sid===r.sid);if(completed?.status==='done')break; } await new Promise(s => setTimeout(s, 200)); }
  assert.strictEqual(completed?.status,'done',JSON.stringify({done:p?.done,task:completed?.status}));
  const ts = p.events.map(e => e.t);
  assert.deepStrictEqual(ts, ['user', 'status', 'text', 'done'], JSON.stringify(p.events));
  assert.strictEqual(p.events[1].text, '这次连接卡住了，重新连一次…');
  assert.strictEqual(p.events[3].ok, true);
  assert.strictEqual(op('daily').skipped, 'done');
  assert.strictEqual(op('daily_get').done.run, r.run);
  assert.strictEqual(op('greet').text, undefined, '主动跟进默认关：每日任务留的开场白不说');
  op('memory_preferences_set', { followups: true });
  assert.strictEqual(op('greet').text, '今天签到好啦');
  const sess = op('tasks', { all: true }).tasks.find(s => s.sid === r.sid);
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

// 每个测试自己的目录；起控制器之前先起真的常驻状态进程（test/helpers/state-mode.cjs）。测试里自己起控制器、执行进程的，先调 ensureState()
function agentEnv(t, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-files-')), work = path.join(home, 'work');
  const env = Object.assign({}, process.env, { XIN_HOME: path.join(home, 'xin'), XIN_WORK: work }, extraEnv);
  const ensureState = require('./helpers/state-mode.cjs').stateClient(t, env);
  env.NODE_OPTIONS = (env.NODE_OPTIONS || '') + ' --require=' + path.join(__dirname,'helpers/front-responses.cjs');
  const { execFileSync } = require('node:child_process');
  const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
  const op = (name, args) => { ensureState(); return JSON.parse(execFileSync(process.execPath, [agent, name], { env, input: JSON.stringify(args || {}) }).toString()); };
  return { home, work, xin: env.XIN_HOME, op, ensureState };
}

test('前台缓存：系统提示每轮一字不差（不带时间、记忆、每日记录）；这些资料放在本轮输入里，排在历史之后、原话之前', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-cache-')), log = path.join(tmp, 'front.log');
  const { op } = agentEnv(t, { XIN_FRONT_TEST_LOG: log });
  const done = async run => { for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) { if (op('poll', { run, off: 0 }).done) return; await new Promise(ok => setTimeout(ok, 120)); } assert.fail('这一轮没有结束'); };
  const a = op('send', { agent: 'codex', text: '第一句' }); await done(a.run);
  // 两轮之间记忆变了：以前会让系统提示跟着变，缓存失效
  assert.ok(op('memory_add', { content: '讲代码先给结论', type: 'profile' }).ok);
  const b = op('send', { sid: a.sid, text: '第二句' }); await done(b.run);
  const reqs = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(reqs.length, 2);
  assert.strictEqual(reqs[0].instructions, reqs[1].instructions);
  for (const bad of ['<<<记忆', '当前北京时间', '每日任务资料']) assert.ok(!reqs[1].instructions.includes(bad), bad);
  const text = m => typeof m.content === 'string' ? m.content : m.content.map(c => c.text || '').join('');
  const input = reqs[1].input, mat = input.findIndex(m => m.role === 'user' && text(m).includes('<<<记忆'));
  assert.ok(mat > 0, '资料在本轮输入里');
  assert.match(text(input[mat]), /讲代码先给结论/);
  assert.match(text(input[mat]), /当前北京时间/);
  assert.ok(input.slice(0, mat).some(m => text(m).includes('第一句')), '历史在资料前面');
  assert.match(text(input[input.length - 1]), /第二句/);
  assert.ok(!input.slice(mat + 1).some(m => text(m).includes('<<<记忆')), '资料只有一份');
});

test('小芯的文件：列文件夹（文件夹在前、不列隐藏的）、预览文字文件、二进制只给下载，工作目录外面一律不行', t => {
  const { home, work, op } = agentEnv(t);
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

test('对话改名、删除（连同每一轮的记录）；还在进行中的不让删', t => {
  const { xin, op } = agentEnv(t);
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

test('插件：只列用户自己装的（电脑自带的不显示、不让关）和开没开；开关记下来，每轮起 codex 时加 -c（只给自己装的）；小芯挪走的 REA 并回配置、记成关着', async t => {
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
  const { op, xin: xinDir } = agentEnv(t, { CODEX_HOME: codexHome, XIN_CODEX_SYS: sys, HOME: home, PATH: bin + ':' + process.env.PATH });
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
    const { mcpFlags, agentArgs } = await import(freshAgentUrl('plug'));
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
    const { agentArgs, codexKeyEnv, CODEX_MODELS } = await freshOwnedAgent('cxroute');
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

test('发文件：send 带 files（只认上传目录里的普通文件）；消息里列出路径；默认模式按能不能看图挑模型、思考强度一律最高；只发文件不说话也行', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-files-send-'));
  const bin = path.join(tmp, 'bin'), log = path.join(tmp, 'args.log');
  fs.mkdirSync(bin);
  // 假的 codex：把参数一行一个记下来，再回一句
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\ncase "$*" in *--ephemeral*) exit 0;; esac\nfor a in "$@"; do printf "%s\\n" "$a"; done > "' + log + '"\n' +
    'echo \'{"type":"thread.started","thread_id":"th-1"}\'\necho \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"看到了"}}\'\necho \'{"type":"turn.completed","usage":{}}\'\n', { mode: 0o755 });
  const { work, op, xin } = agentEnv(t, { PATH: bin + ':' + process.env.PATH, XIN_FRONT_TEST_LOG:log });
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
  for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) { p = op('poll', { run: r.run, off: 0 }); if (p.done) break; await new Promise(ok => setTimeout(ok, 150)); }
  const user = p.events[0];
  assert.deepStrictEqual(user.files, [{ name: '板子.jpg', path: img, size: 3, image: true }, { name: '说明.pdf', path: pdf, size: 3, image: false }]);
  assert.strictEqual(user.text, '');
  const request = JSON.parse(fs.readFileSync(log,'utf8').trim().split('\n').pop());
  assert.equal(request.model,'deepseek-v4.1-flash');
  const prompt = JSON.stringify(request.input);
  assert.ok(prompt.includes(img) && prompt.includes(pdf));
  assert.ok(prompt.includes('图片已经直接给你看了。'));
  assert.ok(!prompt.includes('你现在用的模型看不了图片内容'));
  const parts = request.input.find(x=>x.role==='user'&&Array.isArray(x.content)&&x.content.some(c=>c.type==='input_image')).content;
  assert.deepStrictEqual(parts.filter(x=>x.type==='input_image'),[{type:'input_image',image_url:'data:image/jpeg;base64,'+Buffer.from('jpg').toString('base64'),detail:'auto'}]);
  assert.ok(request.instructions.includes('看图读图直接回答'));
  assert.ok(!request.instructions.includes('必须交给 vision 工作读取'));
  assert.strictEqual(op('tasks',{sid:r.sid}).tasks.length,0,'前台读图回答没有派后台任务');
  assert.equal(p.events.find(e=>e.t==='done').model,'deepseek-v4.1-flash');
  // 用户点名 GLM-5.3：这一句用它（网页传的 model / effort 不管），图片照样 -i，悄悄告诉它别提换模型；对话上记下最近用的模型
  const r2 = op('send', { sid: r.sid, model: 'kimi-k3.1-pro', effort: 'low', text: '用 GLM-5.3 看看这张呢', files: [{ path: img, name: '板子.jpg' }] });
  assert.ok(r2.run, JSON.stringify(r2));
  assert.strictEqual(r2.model, 'deepseek-v4.1-flash');
  for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) { p = op('poll', { run: r2.run, off: 0 }); if (p.done) break; await new Promise(ok => setTimeout(ok, 150)); }
  const request2 = JSON.parse(fs.readFileSync(log,'utf8').trim().split('\n').pop());
  assert.equal(request2.model,'deepseek-v4.1-flash');
  assert.ok(JSON.stringify(request2).includes('本轮已记录用户指定'));
  assert.deepEqual([p.events.find(e=>e.t==='done').model,p.events.find(e=>e.t==='done').why],['deepseek-v4.1-flash','chat']);
  assert.equal(op('sessions').sessions.find(x=>x.sid===r.sid).model,'deepseek-v4.1-flash');
  // 点名看不了图的 GLM-5.3 Flash 却发了图：路由器不让，换成能看图的（前台默认那个）
  const r3 = op('send', { sid: r.sid, text: '用 GLM-5.3 Flash 看图', files: [{ path: img, name: '板子.jpg' }] });
  assert.strictEqual(r3.model, 'deepseek-v4.1-flash');
  for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) { p = op('poll', { run: r3.run, off: 0 }); if (p.done) break; await new Promise(ok => setTimeout(ok, 150)); }
  // 每一轮都记进运行记录（调候选顺序用）
  const stats = fs.readFileSync(path.join(xin, 'model-stats.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(stats.map(x => [x.agent, x.model, x.kind, x.why, x.ok]), [['codex', 'deepseek-v4.1-flash', 'chat', 'chat', true], ['codex', 'deepseek-v4.1-flash', 'chat', 'chat', true], ['codex', 'deepseek-v4.1-flash', 'chat', 'chat', true]]);
});

test('路由器：按类别挑（不是排名）；点名只认能干的（看不了图的不给图）；小芯提议的也要校验；avoid 里的不用；候选全被排除时退回能用的', async () => {
  const { route, namedModel, ROUTES, AUTO_EFFORT, CODEX_MODELS } = await load('../site/xin/vm-agent.mjs');
  assert.strictEqual(AUTO_EFFORT, 'max');
  // 每个类别的候选都是 Codex 里配好的模型
  for (const k of Object.keys(ROUTES)) for (const id of ROUTES[k]) assert.ok(CODEX_MODELS.some(m => m.id === id), k + ':' + id);
  assert.deepStrictEqual(route({}), { model: 'deepseek-v4.1-flash', why: 'chat', kind: 'chat', fallbacks: [], note: '' });
  assert.strictEqual(route({ kind: 'code' }).model, 'glm-5.3');
  assert.strictEqual(route({ kind: 'quick' }).model, 'glm-5.3-flash');
  assert.strictEqual(route({ kind: 'nope' }).kind, 'chat');
  // 看图：看不了图的 GLM-5.3 Flash 不在候选里，点名它也不给
  assert.deepStrictEqual(route({ kind: 'quick', images: true }).fallbacks, ['glm-5.3']);
  assert.strictEqual(route({ kind: 'quick', images: true }).model, 'deepseek-v4.1-flash');
  const v = route({ want: 'glm-5.3-flash', named: true, images: true });
  assert.deepStrictEqual([v.model, v.why], ['deepseek-v4.1-flash', 'chat']);
  assert.match(v.note, /GLM-5.3 Flash 看不了图/);
  // 点名、提议
  assert.deepStrictEqual([route({ want: 'kimi-k3.1-pro', named: true }).model, route({ want: 'kimi-k3.1-pro', named: true }).why], ['kimi-k3.1-pro', 'named']);
  assert.deepStrictEqual([route({ kind: 'code', want: 'deepseek-v4.1-flash' }).model, route({ kind: 'code', want: 'deepseek-v4.1-flash' }).why], ['deepseek-v4.1-flash', 'picked']);
  assert.match(route({ kind: 'code', want: 'gpt-9' }).note, /没有叫 gpt-9 的模型/);
  assert.strictEqual(route({ kind: 'code', want: 'gpt-9' }).model, 'glm-5.3');
  // 复核不能使用实际作者，即使点名也不能绕过；普通任务仍尊重点名。
  assert.strictEqual(route({ kind: 'review', avoid: ['kimi-k3.1-pro'] }).model, 'glm-5.3');
  assert.strictEqual(route({ kind: 'review', want: 'kimi-k3.1-pro', avoid: ['kimi-k3.1-pro'] }).model, 'glm-5.3');
  assert.strictEqual(route({ kind: 'review', want: 'kimi-k3.1-pro', named: true, avoid: ['kimi-k3.1-pro'] }).error, 'independent_review_model');
  assert.strictEqual(route({kind:'code',want:'kimi-k3.1-pro',named:true,avoid:['kimi-k3.1-pro']}).model,'kimi-k3.1-pro');
  assert.strictEqual(route({ kind: 'hard', images: true, avoid: ['kimi-k3.1-pro', 'glm-5.3', 'deepseek-v4.1-flash'] }).model, 'glm-5.3');
  // 用户点名：要有「用 / 换成 / 让…」或者「…来做」，光提到名字不算
  for (const [t, want] of [['用 Kimi 检查一下', 'kimi-k3.1-pro'], ['换成GLM-5.3 Flash', 'glm-5.3-flash'], ['这次用glm5.3写', 'glm-5.3'], ['用 GLM 写', 'glm-5.3'],
    ['让 DeepSeek 来回答', 'deepseek-v4.1-flash'], ['kimi 来做这个', 'kimi-k3.1-pro'], ['改用 deepseek v4.1 flash', 'deepseek-v4.1-flash'], ['交给智谱', 'glm-5.3'],
    ['Kimi 是什么', null], ['GLM 和 DeepSeek 哪个好', null], ['用定时器做呼吸灯', null], ['', null]])
    assert.strictEqual(namedModel(t), want, t);
});

test('前台固定模型：网关失败时不换模型或悄悄执行工作', async () => {
  const { frontTurn } = await load('../site/xin/vm-runtime.mjs');
  let hits=0;
  await assert.rejects(frontTurn({baseURL:'http://fake/v1',key:'test',input:[],instructions:'test',
    fetch:async (url,init)=>{hits++;assert.equal(JSON.parse(init.body).model,'deepseek-v4.1-flash');return new Response('',{status:429});},
    command:()=>assert.fail('不能执行'),fallback:()=>assert.fail('连接失败不制造派活成功')
  }),/429/);
  assert.equal(hits,1);
});

test('每日任务用默认模式：Codex 按 daily 类别挑模型、思考强度最高；电脑里没有 codex 就报错，不偷偷换成 Harness', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-daily-codex-'));
  const bin = path.join(tmp, 'bin'), log = path.join(tmp, 'args.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\ncase "$*" in *--ephemeral*) exit 0;; esac\nfor a in "$@"; do printf "%s\\n" "$a"; done > "' + log + '"\n' +
    'echo \'{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a54"}\'\necho \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"做完了"}}\'\necho \'{"type":"turn.completed","usage":{}}\'\n', { mode: 0o755 });
  // 有 Harness（假 dsh 在）也不用它
  const dsh = path.join(bin, 'dsh');
  fs.writeFileSync(dsh, '#!/bin/sh\necho should-not-run > "' + path.join(tmp, 'dsh-ran') + '"\n', { mode: 0o755 });
  const home = path.join(tmp, 'home'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.profile'), 'PATH="' + bin + ':$PATH"\nexport PATH\n');
  const { op } = agentEnv(t, { HOME: home, PATH: bin + ':' + process.env.PATH, XIN_DSH: dsh });
  op('daily_set', { text: '- 网关签到' });
  const r = op('daily');
  assert.deepStrictEqual([r.agent, r.model], ['codex', 'glm-5.3'], JSON.stringify(r));
  let p;
  for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) { p = op('poll', { run: r.run, off: 0 }); if (p.done) break; await new Promise(ok => setTimeout(ok, 150)); }
  const args = fs.readFileSync(log, 'utf8').split('\n');
  assert.ok(args.includes('model="glm-5.3"') && args.includes('model_reasoning_effort="max"'), args.join(' '));
  assert.ok(!fs.existsSync(path.join(tmp, 'dsh-ran')));
  // 没有 codex：报错（Harness 在也不用）
  const home2 = path.join(tmp, 'home2'); fs.mkdirSync(home2);
  const bin2 = path.join(tmp, 'bin2'); fs.mkdirSync(bin2); fs.copyFileSync(dsh, path.join(bin2, 'dsh')); fs.chmodSync(path.join(bin2, 'dsh'), 0o755);
  fs.writeFileSync(path.join(home2, '.profile'), 'PATH="' + bin2 + ':/usr/bin:/bin"\nexport PATH\n');
  const e2 = agentEnv(t, { HOME: home2, PATH: bin2 + ':/usr/bin:/bin', XIN_DSH: path.join(bin2, 'dsh') });
  e2.op('daily_set', { text: '- 网关签到' });
  const r2 = e2.op('daily');
  assert.deepStrictEqual([r2.error, r2.msg], ['no_agent', '电脑里没有 codex，每日任务做不了']);
});

/* ---------- 后台任务（分身） ---------- */
// 假 codex：前台说 TEST_DISPATCH 就派一个任务；分身（设定里有【你现在在后台】）有 task-wait 文件就一直等，要确认的先 xin task ask
function fakeTaskCodex(dir) {
  const bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(log, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), [
    '#!/bin/sh',
    'case "$*" in *--ephemeral*) exit 0;; esac',
    'L="' + log + '"',
    'exec 9>"$L/seq.lock"; flock 9',
    'n=$(cat "$L/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$L/n"',
    // 先写工作目录、再写参数，都先写临时名再改名：测试看到 args.N 时内容完整、cwd.N 也已经在了（新执行机忙时读到一半，#133 合并后 CI）
    'pwd > "$L/.cwd.$n" && mv "$L/.cwd.$n" "$L/cwd.$n"; for a in "$@"; do printf "%s\\n" "$a"; done > "$L/.args.$n" && mv "$L/.args.$n" "$L/args.$n"',
    'flock -u 9; exec 9>&-',
    'printf \'{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-%012d"}\\n\' $n',
    'echo \'{"type":"turn.started"}\'',
    'case "$*" in',
    '  *【你现在在后台】*)',
    '    while [ -f "$L/task-wait" ]; do sleep 0.1; done',
    '    case "$*" in *要确认*) xin task ask 要删掉旧的 build 目录吗 > "$L/ask-out";; esac',
    '    echo \'{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"make","aggregated_output":"ok","exit_code":0,"status":"completed"}}\'',
    '    echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"编好了：/data/workspace/blink/build/app.hex"}}\';;',
    '  *TEST_DISPATCH*)',
    '    xin task new --kind code --title "编译 LED" -- 编译 blink 工程 > "$L/xin-out" 2>&1',
    '    echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"交给分身去弄啦"}}\';;',
    '  *) echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"好的"}}\';;',
    'esac',
    'echo \'{"type":"turn.completed","usage":{}}\''
  ].join('\n'), { mode: 0o755 });
  return { bin, log, args: () => fs.readdirSync(log).filter(f => /^args\.\d+$/.test(f)).sort((a, b) => a.split('.')[1] - b.split('.')[1]).map(f => fs.readFileSync(path.join(log, f), 'utf8')) };
}
async function until(fn, ms = 15000, what = '') {
  const t0 = performance.now(); let v; ms = platformTimeout(ms);
  while (performance.now() - t0 < ms) { v = fn(); if (v) return v; await new Promise(ok => setTimeout(ok, 120)); }
  throw new Error('等不到：' + what + ' ' + JSON.stringify(v));
}

test('后台任务：前台派分身马上回话；分身在自己的目录、沙盒里按 code 类挑模型干完；结果先存再交回对话（卡片、history），前台下一句带上结果、只带一次；对话列表里没有任务', async tc => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-task-'));
  const fc = fakeTaskCodex(tmp);
  const { op, work, xin } = agentEnv(tc, { PATH: fc.bin + ':' + process.env.PATH, XIN_FRONT_TEST_LOG:path.join(tmp,'front.jsonl') });
  const r = op('send', { agent: 'codex', text: '请 TEST_DISPATCH 一下' });
  const front = await until(() => { const p = op('poll', { run: r.run, off: 0 }); return p.done && p; }, 15000, '前台这一轮');
  const card = front.events.find(e => e.t === 'task');
  assert.ok(card && card.no === 1 && card.title === '编译 LED' && card.kind === 'code' && card.model === 'glm-5.3', JSON.stringify(front.events));
  assert.deepStrictEqual(front.events.filter(e => e.t === 'text').map(e => e.text), ['好的'], '派活后用模型自己的话，不套固定一句');
  assert.ok(!fs.existsSync(path.join(fc.log,'xin-out')), '前台不执行 shell');
  const done = await until(() => { const d = op('tasks', { sid: r.sid }); return d.tasks[0] && d.tasks[0].status === 'done' && d.tasks[0].delivery?.state==='delivered' && d; }, 15000, '任务做完并自动交付');
  const t = done.tasks[0];
  assert.deepStrictEqual([t.no, t.parent, t.kind, t.model, t.why, t.result.ok, t.result.text], [1, r.sid, 'code', 'glm-5.3', 'code', true, '编好了：/data/workspace/blink/build/app.hex']);
  assert.strictEqual(t.dir, path.join(work, 'tasks', '1-编译-LED'));
  assert.strictEqual(done.bg, 0);
  // 分身那一轮：在自己的目录里、沙盒、思考强度最高、设定是分身的
  const all = fc.args(), ta = all.find(a => a.includes('【你现在在后台】')).split('\n');
  assert.ok(ta.includes('default_permissions="xin-task"') && ta.some(x => x.startsWith('permissions.xin-task.filesystem=')) && !ta.includes('--dangerously-bypass-approvals-and-sandbox') && ta.includes('model="glm-5.3"') && ta.includes('model_reasoning_effort="max"'));
  assert.notStrictEqual(ta[ta.indexOf('-C') + 1], t.dir);
  assert.ok(ta[ta.indexOf('-C') + 1].includes('xin-task-'));
  const cwds = fs.readdirSync(fc.log).filter(f => f.startsWith('cwd.')).map(f => fs.readFileSync(path.join(fc.log, f), 'utf8').trim());
  assert.ok(cwds.some(d => d.includes('xin-task-') && d.endsWith('/work')), cwds.join());
  // 对话列表里没有任务；对话的 history 带着任务；任务自己的 history 能看过程
  assert.deepStrictEqual(op('sessions').sessions.map(x => x.sid), [r.sid]);
  const h = op('history', { sid: r.sid });
  assert.deepStrictEqual(h.tasks.map(x => [x.no, x.status]), [[1, 'done']]);
  assert.ok(h.runs[0].started > 0);
  const th = op('history', { sid: t.sid });
  assert.ok(th.task && th.task.goal === '请 TEST_DISPATCH 一下' && th.runs[0].events[0].text === '请 TEST_DISPATCH 一下' && th.runs[0].events.some(e => e.t === 'tool_end' && e.detail === 'make'), JSON.stringify(th).slice(0, 400));
  // 前台下一句带上结果；做成了以后就不再带
  const r2 = op('send', { sid: r.sid, text: '怎么样了' });
  const second = await until(() => {const p=op('poll', { run: r2.run, off: 0 });return p.done&&p;}, 15000, '前台第二句');
  assert.ok(h.runs.flatMap(r=>r.events).some(e=>e.t==='text'&&e.taskResult&&e.text.includes('编好了：/data/workspace/blink/build/app.hex')),'完成后主动交付真实结果');
  const p2=JSON.parse(fs.readFileSync(path.join(tmp,'front.jsonl'),'utf8').trim().split('\n').pop());assert.ok(p2.input.some(e=>e.role==='assistant'&&e.content.includes('编好了：/data/workspace/blink/build/app.hex')),'后续聊天保留已交付的真实结果');
  const r3 = op('send', { sid: r.sid, text: '好' });
  await until(() => op('poll', { run: r3.run, off: 0 }).done, 15000, '前台第三句');
  const p3 = JSON.parse(fs.readFileSync(path.join(tmp,'front.jsonl'),'utf8').trim().split('\n').pop()).input.at(-1).content;
  const p3all = JSON.stringify(JSON.parse(fs.readFileSync(path.join(tmp,'front.jsonl'),'utf8').trim().split('\n').pop()).input);
  // 提到前面说过的词：旧对话原话不再每轮自动塞（联调 #115–#117），原话只在历史里出现
  const r4 = op('send', { sid: r.sid, text: 'test_dispatch 结果呢' });
  await until(() => op('poll', { run: r4.run, off: 0 }).done, 15000, '前台第四句');
  const p4 = JSON.parse(fs.readFileSync(path.join(tmp,'front.jsonl'),'utf8').trim().split('\n').pop()).input;
  assert.ok(p4.some(e=>e.role==='user'&&String(e.content).includes('请 TEST_DISPATCH 一下')),'原话在上下文里');
  assert.ok(!p4.some(e=>String(e.content).includes('相关旧话')&&String(e.content).includes('TEST_DISPATCH')),JSON.stringify(p4.map(e=>String(e.content).slice(0,60))));
  assert.ok(!p3.includes('<后台任务>') && !p3all.includes('<后台任务>') && !p3all.includes('任务 1「编译 LED」做完了'), p3.slice(-300));
  // 运行记录里也有分身那一轮
  const stats = fs.readFileSync(path.join(xin, 'model-stats.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(stats.some(x => x.kind === 'code' && x.model === 'glm-5.3' && x.ok));
  // 有任务在做时不让删对话；都做完了删对话连任务一起删
  assert.strictEqual(op('forget', { sid: r.sid }).ok, true);
  assert.strictEqual(fs.existsSync(path.join(xin, 'sessions', t.sid + '.json')), false);
});

test('后台任务：同时最多两个；同一个项目目录排队；补充要求等这一步做完接着做；停掉的不再做；分身要确认就停在「等你确认」，回复了接着做', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-task2-'));
  const fc = fakeTaskCodex(tmp);
  const { op, work, xin, home } = agentEnv(t, { PATH: fc.bin + ':' + process.env.PATH, XIN_FRONT_TEST_LOG:path.join(tmp,'front.jsonl') });
  const r = op('send', { agent: 'codex', text: '你好' });
  const actor = captureRunContext(xin, r.run);
  await until(() => op('poll', { run: r.run, off: 0 }).done, 15000, '前台');
  const { execFileSync } = require('node:child_process');
  const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
  const env = Object.assign({}, process.env, actor, { XIN_HOME: xin, XIN_WORK: work, PATH: path.join(xin, 'bin') + ':' + fc.bin + ':' + process.env.PATH });
  const xinTask = (...a) => { try { return execFileSync(process.execPath, [agent, 'xin', 'task', ...a], { env, input: '' }).toString(); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };
  fs.writeFileSync(path.join(fc.log, 'task-wait'), '');
  assert.match(xinTask('new', '--title', 'A', '--dir', path.join(work, 'blink'), '--', '改 blink'), /任务 1「A」/);
  assert.match(xinTask('new', '-t', 'B', '-d', 'blink', '-k', 'quick', '--', '再改 blink'), /任务 2「B」（杂活，GLM-5.3 Flash/);
  assert.match(xinTask('new', '--title', 'C', '--kind', 'research', '--model', 'deepseek-v4.1-flash', '--', '查资料'), /任务 3「C」（查资料，DeepSeek V4.1 Flash/);
  const st = () => Object.fromEntries(op('tasks', { sid: r.sid }).tasks.map(t => [t.title, t.status]));
  await until(() => { const s = st(); return s.A === 'running' && s.C === 'running' && s; }, 15000, 'A、C 在做');
  assert.deepStrictEqual(st(), { A: 'running', B: 'queued', C: 'running' });   // B 和 A 同一个目录，等着
  // 有任务在做、排队时兄弟说别的：前台这一轮不带「进行中 / 排队中」（像 opencode 任务还在跑时不发通知；联调 #113–#116）
  const rr = op('send', { sid: r.sid, text: '在吗' });
  await until(() => op('poll', { run: rr.run, off: 0 }).done, 15000, '前台（任务在做）');
  const qr = JSON.stringify(JSON.parse(fs.readFileSync(path.join(tmp,'front.jsonl'),'utf8').trim().split('\n').pop()).input);
  assert.ok(qr.includes('在吗') && !qr.includes('<后台任务>') && !qr.includes('进行中（'), qr.slice(-400));
  assert.strictEqual(op('tasks', { sid: r.sid }).bg, 3);
  // 不认识的模型、类型、目录在外面：不派
  assert.match(xinTask('new', '--title', 'X', '--model', 'gpt-9', '--', 'x'), /没有这个模型/);
  assert.match(xinTask('new', '--title', 'X', '--kind', 'nope', '--', 'x'), /类型只能是/);
  assert.match(xinTask('new', '--title', 'X', '--dir', '/etc', '--', 'x'), /项目目录要在/);
  // 补充要求：A 在做，记下来
  assert.match(xinTask('tell', '1', '再加个呼吸灯'), /任务 1 这一轮跑完就按你说的接着做/);   // exec 方式中途接不了补充：这一轮跑完再按补充接着做（下面检查确实接着做了）
  // 停掉 C
  assert.match(xinTask('stop', '3'), /停了：任务 3/);
  await until(() => st().C === 'stopped', 10000, 'C 停了');
  const c = op('tasks', { sid: r.sid }).tasks.find(t => t.title === 'C');
  assert.deepStrictEqual([c.result.ok, c.result.text], [false, '做到一半被停下了。']);
  // 放行：A 做完这一步 → 按补充接着做一轮 → 做完；B 接着开始、做完
  fs.unlinkSync(path.join(fc.log, 'task-wait'));
  await until(() => { const s = st(); return s.A === 'done' && s.B === 'done' && s; }, 20000, 'A、B 做完');
  const a = op('history', { sid: op('tasks', { sid: r.sid }).tasks.find(t => t.title === 'A').sid });
  assert.deepStrictEqual(a.runs.map(x => x.events[0].text), ['改 blink', '再加个呼吸灯']);
  assert.ok(fc.args().some(x => x.includes('用户在你干活时补充了') && x.includes('- 再加个呼吸灯')));
  // 要确认的：停在等你确认（带问题）；回复了接着做
  assert.match(xinTask('new', '--title', 'D', '--', '清理 build，要确认'), /任务 4「D」/);
  const d = await until(() => { const x = op('tasks', { sid: r.sid }).tasks.find(t => t.title === 'D'); return x && x.status === 'waiting' && x; }, 15000, 'D 等确认');
  assert.strictEqual(d.question, '要删掉旧的 build 目录吗');
  const r2 = op('send', { sid: r.sid, text: '嗯' });
  await until(() => op('poll', { run: r2.run, off: 0 }).done, 15000, '前台');
  assert.ok(fs.readFileSync(path.join(tmp,'front.jsonl'),'utf8').includes('任务 4「D」在等用户确认：要删掉旧的 build 目录吗'));
  // 后台任务快照单独一条、带标签、在兄弟的原话前面；原话是最后一条，不夹快照（联调 #113、#114）
  const q=JSON.parse(fs.readFileSync(path.join(tmp,'front.jsonl'),'utf8').trim().split('\n').pop()).input;
  const snap=q.findIndex(e=>typeof e.content==='string'&&e.content.startsWith('<后台任务>\n'));
  assert.ok(snap>=0&&snap<q.length-1&&q[snap].content.endsWith('\n</后台任务>')&&q[snap].content.includes('任务 4「D」在等用户确认：要删掉旧的 build 目录吗'),JSON.stringify(q.map(e=>[e.role,String(e.content).slice(0,40)])));
  assert.ok(q.at(-1).role==='user'&&q.at(-1).content.includes('嗯')&&!q.at(-1).content.includes('后台任务'),String(q.at(-1).content).slice(-200));
  // 最后一条是兄弟的原话、不带标签；它前面控制器附上的每一条都用成对标签包着（联调 #118：资料没有结尾，兄弟的话被当成资料）
  assert.ok(!/^<(资料|注意事项|后台任务)>/.test(q.at(-1).content));
  const tail=[];for(let i=q.length-2;i>=0&&q[i].role==='user';i--)tail.push(String(q[i].content));
  assert.ok(tail.length>=2&&tail.every(c=>/^<(资料|注意事项|后台任务)>\n[\s\S]*\n<\/\1>$/.test(c)),JSON.stringify(tail.map(c=>c.slice(0,30)+'…'+c.slice(-20))));
  assert.match(xinTask('tell', '4', '删吧'), /任务 4 接着做了/);
  await until(() => op('tasks', { sid: r.sid }).tasks.find(t => t.title === 'D').status === 'done', 15000, 'D 做完');
  assert.ok(fc.args().some(x => x.includes('用户回复：删吧') && x.includes('（你之前问的是：要删掉旧的 build 目录吗）')));
  // 分身里不能再派分身、不能停别的任务；xin task list / show
  assert.match(xinTask('list'), /任务 1「A」做完了（写代码，GLM-5.3）[\s\S]*任务 3「C」已停止/);
  assert.match(xinTask('show', '1'), /工作目录：.*blink[\s\S]*最近执行的命令：\n  ✓ make[\s\S]*结果：编好了/);
});

// 任务时限由常驻状态进程按它自己的环境算（XIN_TASK_TIMEOUT_MS），命令行进程的环境改不了它：
// 「到时间停下」和「被杀后接着做」要不同的时限，各起一个状态进程（以前在同一条测试里靠改命令行进程的环境切换）
async function taskTimeoutFixture(tc, timeoutMs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-task3-'));
  const fc = fakeTaskCodex(tmp);
  // 进程报到（写下 pid）前不会被当成断了：留够启动时间，CI 机器忙时也不误判
  const { op, work, xin } = agentEnv(tc, { PATH: fc.bin + ':' + process.env.PATH, XIN_TASK_TIMEOUT_MS: timeoutMs, XIN_DEAD_MS: '3000' });
  const r = op('send', { agent: 'codex', text: '你好' });
  const actor = captureRunContext(xin, r.run);
  await until(() => op('poll', { run: r.run, off: 0 }).done, 15000, '前台');
  const { execFileSync } = require('node:child_process');
  const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
  const env = Object.assign({}, process.env, actor, { XIN_HOME: xin, XIN_WORK: work, XIN_TASK_TIMEOUT_MS: timeoutMs, XIN_DEAD_MS: '3000', PATH: path.join(xin, 'bin') + ':' + fc.bin + ':' + process.env.PATH });
  const xinTask = (...a) => execFileSync(process.execPath, [agent, 'xin', 'task', ...a], { env, input: '' }).toString();
  return { fc, op, work, xin, r, agent, env, xinTask };
}

test('后台任务：到时间没做完停下（算没做成）', async tc => {
  const { fc, op, r, xinTask } = await taskTimeoutFixture(tc, '1500');
  fs.writeFileSync(path.join(fc.log, 'task-wait'), '');
  xinTask('new', '--title', '慢活', '--', '慢慢做');
  // #133 合并后 CI（新执行机）上这里偶尔 45 秒都等不到：失败时把任务状态、错误和每一轮的事件一起带出来，下次能看出卡在哪一步
  const t = await until(() => { const x = op('tasks', { sid: r.sid }).tasks[0]; return x && x.status === 'failed' && x; }, 15000, '超时').catch(e => {
    const x = op('tasks', { sid: r.sid }).tasks[0] || {}; let h = {}; try { h = op('history', { sid: x.sid }); } catch { /* 读不到 */ }
    throw new Error(e.message + ' DIAG ' + JSON.stringify({ status: x.status, err: x.result && x.result.err, runs: (h.runs || []).map(rr => (rr.events || []).map(ev => ev.t + (ev.text ? ':' + String(ev.text).slice(0, 60) : '')).slice(-8)) }));
  });
  assert.match(t.result.err, /^超时（60 分钟）$/);
});

test('后台任务：runner 中途被杀，下次有人来看时接着做一次（提醒它先查现状），再断就等用户', async tc => {
  // 这个任务测的是被杀后接着做，不是超时：时限给足，别让忙的机器先把它判成超时
  const { fc, op, r, xin, xinTask } = await taskTimeoutFixture(tc, '120000');
  const { execFileSync } = require('node:child_process');
  fs.writeFileSync(path.join(fc.log, 'task-wait'), '');
  // 被杀：把分身那一轮的 runner 和它起的 codex 一起杀掉（模拟电脑重启）
  xinTask('new', '--title', '会断的', '--', '做');
  const t2 = await until(() => { const x = op('tasks', { sid: r.sid }).tasks.find(y => y.title === '会断的'); return x && x.status === 'running' && x; }, 15000, '在做');
  const sess = JSON.parse(fs.readFileSync(path.join(xin, 'sessions', t2.sid + '.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(xin, 'runs', sess.runs[0] + '.json'), 'utf8'));
  await until(() => { const m = JSON.parse(fs.readFileSync(path.join(xin, 'runs', sess.runs[0] + '.json'), 'utf8')); return m.pid; }, 5000, 'pid');
  const m2 = JSON.parse(fs.readFileSync(path.join(xin, 'runs', sess.runs[0] + '.json'), 'utf8'));
  try { process.kill(m2.pid, 'SIGKILL'); } catch { /* 已经没了 */ }
  try { execFileSync('pkill', ['-9', '-f', fc.bin + '/codex']); } catch { /* 没有 */ }
  fs.unlinkSync(path.join(fc.log, 'task-wait'));
  await new Promise(ok => setTimeout(ok, 500));
  const t3 = await until(() => { const x = op('tasks', { sid: r.sid }).tasks.find(y => y.title === '会断的'); return x && x.status === 'done' && x; }, 15000, '接着做完');
  const h = op('history', { sid: t3.sid });
  assert.deepStrictEqual(h.runs.map(x => x.events[0].text), ['做', '（中途断了，接着做）']);
  assert.ok(h.runs[0].events.some(e => e.t === 'err' && /中途断了/.test(e.text)));
  assert.ok(fc.args().some(x => x.includes('刚才电脑暂停或重启，这一轮中途断了')));
  assert.ok(meta.sandbox === true && meta.deadline > meta.started);
});


test('分身配合：--review 做完再派一个分身换个模型、在同一个目录检查（拿到前一个的结果）；--after 等前一个做完；任务中心拿得到全部任务、各模型的统计、对话名字和每日任务', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-task4-'));
  const fc = fakeTaskCodex(tmp);
  const { op, work, xin } = agentEnv(t, { PATH: fc.bin + ':' + process.env.PATH });
  const r = op('send', { agent: 'codex', text: '你好' });
  const actor = captureRunContext(xin, r.run);
  await until(() => op('poll', { run: r.run, off: 0 }).done, 15000, '前台');
  const { execFileSync } = require('node:child_process');
  const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
  const env = Object.assign({}, process.env, actor, { XIN_HOME: xin, XIN_WORK: work, PATH: path.join(xin, 'bin') + ':' + fc.bin + ':' + process.env.PATH });
  const xinTask = (...a) => execFileSync(process.execPath, [agent, 'xin', 'task', ...a], { env, input: '' }).toString();
  fs.writeFileSync(path.join(fc.log, 'task-wait'), '');
  const out = xinTask('new', '--kind', 'code', '--title', '点灯', '--dir', 'pb5', '--review', '--', '写 PB5 点灯并编译');
  assert.match(out, /任务 1「点灯」（写代码，GLM-5.3，[\s\S]*检查任务 2（Kimi K3.1 Pro）等它做完就开始/);
  assert.match(xinTask('new', '--kind', 'research', '--title', '接着查', '--after', '1', '--', '在点灯基础上查串口'), /任务 3「接着查」/);
  const ts = () => op('tasks', { sid: r.sid }).tasks;
  let list = await until(() => { const x = ts(); return x.length === 3 && x[0].status === 'running' && x; }, 15000, '任务 1 在做');
  assert.deepStrictEqual(list.map(t => [t.no, t.kind, t.status, t.after]), [[1, 'code', 'running', []], [2, 'review', 'queued', [1]], [3, 'research', 'queued', [1]]]);
  assert.strictEqual(list[1].dir, list[0].dir);
  assert.notStrictEqual(list[1].model, list[0].model);   // 换个模型检查
  // 前台这一轮带了两张卡片
  const evs = op('poll', { run: r.run, off: 0 }).events.filter(e => e.t === 'task');
  assert.deepStrictEqual(evs.map(e => [e.no, e.kind]), [[1, 'code'], [2, 'review'], [3, 'research']]);
  fs.unlinkSync(path.join(fc.log, 'task-wait'));
  list = await until(() => { const x = ts(); return x.every(t => t.status === 'done') && x; }, 20000, '都做完');
  // 检查的那个分身拿到了前一个的结果和「检查」的要求；用的是另一个模型
  const rv = fc.args().find(a => a.includes('【后台任务 2：检查：点灯】'));
  assert.ok(rv && rv.includes('【任务 1「点灯」的结果（做完了') && rv.includes('你的活是检查上面这些结果') && rv.includes('model="kimi-k3.1-pro"'), (rv || '').slice(0, 300));
  assert.ok(list[2].startedAt >= list[0].endedAt, '任务 3 等任务 1 做完才开始');
  // 任务中心：全部任务、对话名字、统计、每日任务
  const all = op('tasks', { all: true });
  assert.deepStrictEqual(all.tasks.map(t => t.no), [1, 2, 3]);
  assert.strictEqual(all.titles[r.sid], '你好');
  assert.ok(all.stats.some(x => x.model === 'glm-5.3' && x.n >= 1 && x.ok >= 1) && all.stats.some(x => x.model === 'kimi-k3.1-pro'));
  assert.ok(all.daily && 'last' in all.daily && all.daily.today);
});

test('后台任务的租约：vm-agent 说有任务在做就续一个小时，都做完了就撤；新加的 op Worker 都放行', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  for (const op of ['tasks', 'task_stop', 'task_tell']) assert.ok(m.OPS.has(op), op);
  const ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [{ body: { stdout: JSON.stringify({ tasks: [], active: [], bg: 1, lease: 'renew' }), stderr: '', exitCode: 0 } },
      { body: { stdout: JSON.stringify({ tasks: [], active: [], bg: 0, lease: 'drop' }), stderr: '', exitCode: 0 } }],
    'PUT /v1/machines/m_abc/activity-leases/xin-tasks': [{ body: {} }],
    'DELETE /v1/machines/m_abc/activity-leases/xin-tasks': [{ body: {} }]
  });
  try {
    for (let i = 0; i < 2; i++) {
      const waits = [];
      await m.handleXin(req('/api/xin/call', { body: { op: 'tasks', args: { sid: 'sabc123' } }, headers: { cookie: ck } }), env, { waitUntil: p => waits.push(p) });
      await Promise.all(waits);
    }
    const put = ib.calls.find(c => c.key === 'PUT /v1/machines/m_abc/activity-leases/xin-tasks');
    assert.deepStrictEqual(JSON.parse(put.body), { ttlSeconds: 3600 });
    assert.ok(ib.calls.some(c => c.key === 'DELETE /v1/machines/m_abc/activity-leases/xin-tasks'));
  } finally { ib.restore(); }
});

test('xin task 的参数：长短选项、--after 逗号分隔、-- 后面是要求；缺值报错', async () => {
  const { parseTaskArgs } = await load('../site/xin/vm-agent.mjs');
  assert.deepStrictEqual(parseTaskArgs(['--kind', 'code', '-t', '编译', '--file', 'a.png', '-f', 'b.png', '--after', '3,4', '--', '编', '译']),
    { files: ['a.png', 'b.png'], after: [3, 4], plugins: [], kind: 'code', title: '编译', goal: '编 译' });
  assert.deepStrictEqual(parseTaskArgs(['--model=kimi-k3.1-pro', '查', '资料']).model, 'kimi-k3.1-pro');
  assert.deepStrictEqual(parseTaskArgs(['--review', '-t', '点灯', '--', '写']), { files: [], after: [], plugins: [], review: true, title: '点灯', goal: '写' });
  assert.strictEqual(parseTaskArgs(['--title']).error, '--title 后面要写值');
  assert.strictEqual(parseTaskArgs(['--nope', 'x']).error, '不认识的选项：--nope');
});

test('Harness（天启）：dsh headless --json 起，带天启自己的设定（--patch）、满权限、网关 key 用环境变量；事件整理、会话号、接着聊（--session-id）、用量；删对话连它的会话一起删', async t => {
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
  const { xin, op } = agentEnv(t, { XIN_DSH: dsh, XIN_DSH_HOME: dshHome });
  fs.mkdirSync(xin, { recursive: true });
  fs.writeFileSync(path.join(xin, 'harness.key'), 'gw-key-123\n', { mode: 0o600 });
  assert.ok(op('ping').agents.includes('harness'));
  const poll = async run => { let p; for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) { p = op('poll', { run, off: 0 }); if (p.done) return p; await new Promise(ok => setTimeout(ok, 150)); } return p; };
  const stale = path.join(xin, 'harness-persona.glm-5.3.high.yml');   // 旧版设定副本里带着小芯的记事本
  fs.writeFileSync(stale, '    personaPrefix: "你就是小芯…<<<记事本\\n- 旧记录\\n记事本>>>"\n');
  const r = op('send', { agent: 'harness', text: '-看看目录', effort: 'off' });   // 天启要明确指定；思考强度「关」
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
  // 天启是独立功能：自己的设定，不带小芯的记事本、好感度；聊天不加小芯的好感；每句附的是天启的提醒
  assert.ok(persona.includes('- id: system-prompt') && persona.includes('personaPrefix: "你是「天启」'));
  assert.ok(!persona.includes('<<<记事本') && !persona.includes('xin bond') && !persona.includes('xin remember') && !persona.includes('你和用户现在的关系'), persona.slice(0, 400));
  assert.equal(op('bond').score, 0);
  assert.ok(!fs.existsSync(stale), '带小芯记事本的旧设定副本已清理');
  assert.ok(calls.join('\n').includes('你是天启，不是小芯') && !calls.join('\n').includes('你就是小芯'), calls.join('\n').slice(0, 300));
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

test('Harness 事件整理：出错、没做完都说清楚；会话号格式不对不拿去拼路径', async t => {
  const { fromHarness } = await load('../site/xin/vm-agent.mjs');
  const st = {};
  assert.deepStrictEqual(fromHarness({ type: 'error', message: 'MISSING_CREDENTIAL' }, st), [{ t: 'err', text: 'MISSING_CREDENTIAL' }]);
  assert.ok(st.failed);
  const st2 = {};
  assert.deepStrictEqual(fromHarness({ type: 'status', phase: 'turn_end', reason: { kind: 'aborted' } }, st2), [{ t: 'err', text: '这一轮没做完（aborted）' }]);
  assert.deepStrictEqual(fromHarness({ type: 'final', text: 'x' }, {}), []);
  assert.deepStrictEqual(fromHarness({ type: 'thinking', text: 'x' }, {}), []);
  const { xin, op } = agentEnv(t);
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

test('归档：只是收起来（记录、AI 的会话记录都留着），能取消；对话列表带 archived，归档的排在后面', t => {
  const { xin, op } = agentEnv(t);
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

test('删对话时连 Codex / Claude 自己的会话记录一起删；没有对应对话的旧记录也清掉（只清网站开的、1 小时前的）', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-logs-'));
  const codexHome = path.join(tmp, 'codex'), claudeHome = path.join(tmp, 'claude'), bin = path.join(tmp, 'bin'), log = path.join(tmp, 'codex.log');
  fs.mkdirSync(bin);
  // 假的 codex：记下参数，像真的 `codex delete --force <id>` 一样删掉记录文件
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho "$@" >> "' + log + '"\n[ "$1" = delete ] && [ "$2" = --force ] && find "$CODEX_HOME/sessions" -name "*-$3.jsonl" -delete\nexit 0\n', { mode: 0o755 });
  const { xin, op } = agentEnv(t, { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, PATH: bin + ':' + process.env.PATH });
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

test('对话的用量：Codex 取记录里最后一条 token_count（累计、最近一次、上限），做完那一轮的 done 和 history 都带上；Claude 把每条回答的 usage 去重加起来', async t => {
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
  const { xin, op } = agentEnv(t, { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, PATH: bin + ':' + process.env.PATH });
  const want1 = { ctx: 120342, win: 258400, input: 3699260, cached: 3567104, output: 28753, total: 3728013 };
  const r = op('send', { agent: 'codex', text: '你好' });
  let p = null;
  for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) { p = op('poll', { run: r.run, off: 0 }); if (p.done) break; await new Promise(ok => setTimeout(ok, 150)); }
  const done = p.events.find(e => e.t === 'done');
  assert.equal(done.usage.total,13);
  const legacy=JSON.parse(fs.readFileSync(path.join(xin,'sessions',r.sid+'.json'),'utf8'));
  delete legacy.frontUsage; Object.assign(legacy,{agentSid:id1,started:true});
  fs.writeFileSync(path.join(xin,'sessions',r.sid+'.json'),JSON.stringify(legacy));
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

test('推送订阅：只收 https 和对的钥匙；同一个地址只记一次；最多 8 个；能去掉；VAPID 私钥文件只有自己能读', t => {
  const { xin, op } = agentEnv(t);
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

test('做完提醒：网页没在看时做完就推送（解得开、带标题和回答开头、点了打开那段对话），网页在看时不推；推送服务说订阅没了就删掉', async tc => {
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
    const env = Object.assign({}, process.env, { XIN_HOME: path.join(home, 'xin'), XIN_WORK: path.join(home, 'work'), NODE_OPTIONS:(process.env.NODE_OPTIONS||'')+' --require='+path.join(__dirname,'helpers/front-responses.cjs'), XIN_FRONT_TEST_DELAY:'1000', XIN_FRONT_TEST_TEXT:'编好啦！\n\n```c\nint main(void){}\n```\n烧录文件在 /data/workspace/blink/build/app.hex', XIN_PUSH_INSECURE: '1', PATH: bin + ':' + process.env.PATH });
    const ensureState = require('./helpers/state-mode.cjs').stateClient(tc, env);
    const op = (name, args) => { ensureState(); return JSON.parse(execFileSync(process.execPath, [agent, name], { env, input: JSON.stringify(args || {}) }).toString()); };
    const br = fakeBrowser();
    assert.strictEqual(op('push_sub', { deviceId:'test-device-1', sub: { endpoint: `http://127.0.0.1:${port}/push/a`, keys: br.keys } }).ok, true);
    const wait = async (run, watch) => {
      for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) {
        const p = watch ? op('poll', { run, off: 0, deviceId:'test-device-1',tabId:'test-tab-1',watching:true }) : JSON.parse(fs.readFileSync(path.join(home, 'xin', 'runs', run + '.jsonl'), 'utf8').trim().split('\n').pop());
        if (watch ? p.done : p.t === 'done') return;
        await new Promise(s => setTimeout(s, 150));
      }
      throw new Error('没做完');
    };
    // 1. 发完就没人看了：推送
    const r1 = op('send', { agent: 'codex', text: '写个点灯程序' });
    await wait(r1.run, false);
    for (const end = performance.now() + platformTimeout(5000); performance.now() < end && !got.length;) await new Promise(s => setTimeout(s, 100));
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
  const local = new Set(['status', 'wake', 'screen_off', 'delivery', 'deliveries']);   // 这几个 Worker 自己调 InstaBox 或只读待送达，不进云电脑（screen 两边都有）
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

test('新动作：xin move add 学会（网页马上做一遍）、xin move 名字 让网页做、list、rm；坏 JSON 给出用法', t => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const { xin, op, ensureState } = agentEnv(t);
  const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
  const runs = path.join(xin, 'runs'); fs.mkdirSync(runs, { recursive: true });
  const run = 'rmove000001'; fs.writeFileSync(path.join(runs, run + '.jsonl'), '');
  const env = Object.assign({}, process.env, { XIN_HOME: xin, XIN_RUN: run });
  const xinCmd = (...a) => (ensureState(), spawnSync(process.execPath, [agent, 'xin', 'move', ...a], { env, encoding: 'utf8' }));
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

test('好感度、新动作进了设定；greet 顺便带回去；xin bond 在聊天里留一条', async t => {
  const { spawnSync } = require('node:child_process');
  const { xin, op } = agentEnv(t);
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
  // 2026-11-12 站长：提示词照 Muse 来，Muse 没有亲密度就不用——设定里不再按好感度定语气；xin bond 和页面上的小芯照旧
  assert.ok(!p.includes('你和用户现在的关系') && !p.includes('xin bond') && p.includes('xin move help') && p.includes('已经会的：还没有'), p.slice(-600));
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

test('登录窗口（浏览器第二步）：先开桌面，云电脑开登录窗口，回能接管的链接（15 分钟）；窗口开不起来说清楚、不给链接；网站登录的几个操作放行', async () => {
  const m = await fresh(), env = mkEnv(), ck = await login(m, env);
  const ib = fakeIB({
    'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/desktop': [{ body: { installed: true, running: true } }, { body: { installed: true, running: true } }],
    'POST /v1/machines/m_abc/exec': [{ body: { stdout: '{"ok":true,"site":"bilibili.com"}', stderr: '', exitCode: 0 } }, { body: { stdout: '{"error":"failed","msg":"登录窗口开不了沙盒"}', stderr: '', exitCode: 0 } },
      { body: { stdout: '{"ok":true,"sites":[],"window":null}', stderr: '', exitCode: 0 } }],
    'POST /v1/machines/m_abc/desktop/stream': [(u, init) => new Response(JSON.stringify({ url: 'https://dashboard.instabox.sh/desktop/m_abc#token=' + (JSON.parse(init.body).viewOnly ? 'v' : 'c'), expiresAt: 'z' }))]
  });
  const call = async (op, args) => (await m.handleXin(req('/api/xin/call', { body: { op, args }, headers: { cookie: ck } }), env, null)).json();
  try {
    const r = await call('login_open', { sid: 'stask0000001' });
    assert.deepStrictEqual(r, { ok: true, data: { url: 'https://dashboard.instabox.sh/desktop/m_abc#token=c', expiresAt: 'z', control: true, terminal: false, site: 'bilibili.com' } });
    const ex = JSON.parse(ib.calls.find(x => x.key.endsWith('/exec')).body);
    assert.deepStrictEqual([ex.argv[2], JSON.parse(ex.stdin)], ['login_open', { sid: 'stask0000001' }]);
    assert.ok(ib.calls.findIndex(x => x.key.endsWith('/desktop')) < ib.calls.findIndex(x => x.key.endsWith('/exec')), '先开桌面再开窗口');
    assert.deepStrictEqual(JSON.parse(ib.calls.find(x => x.key.endsWith('/desktop/stream')).body), { viewOnly: false, ttlSeconds: 900 });
    const bad = await call('login_open', { url: 'https://www.bilibili.com/' });
    assert.deepStrictEqual([bad.ok, bad.msg], [false, '登录窗口开不了沙盒']);
    assert.strictEqual(ib.calls.filter(x => x.key.endsWith('/desktop/stream')).length, 1, '窗口没开起来就不给接管链接');
    assert.deepStrictEqual((await call('logins', {})).data, { ok: true, sites: [], window: null });
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

test('小芯的屏幕：screen.log 每一类事件写成好读的一行（命令去掉 /bin/bash -lc 外壳，输出太长只留前面）；电脑里没终端时 screen 说清楚', async t => {
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
  const { op, xin } = agentEnv(t, { PATH: bin });
  const r = op('screen');
  assert.strictEqual(r.error, 'no_terminal');
  assert.ok(fs.readFileSync(path.join(xin, 'screen.log'), 'utf8').includes('小芯的屏幕'));
});

test('天启独立：天启里的 xin 命令不写小芯的记事本、好感度、开场白、动作，也不派后台任务', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-tianqi-')), xin = path.join(home, 'xin'), run = 'rtianqi0001';
  fs.mkdirSync(path.join(xin, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(xin, 'runs', run + '.json'), JSON.stringify({ run, sid: 'stianqi0001', agent: 'harness', started: Date.now() }));
  fs.writeFileSync(path.join(xin, 'runs', run + '.jsonl'), '');
  const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
  const env = Object.assign({}, process.env, { XIN_HOME: xin, XIN_WORK: path.join(home, 'work'), XIN_RUN: run });
  require('./helpers/state-mode.cjs').stateMode(t, env);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));   // 状态进程停下以后再删
  for (const argv of [['remember', '天启记的'], ['bond', '+2', '理由'], ['next', '明天见'], ['move', 'add', '挥手', '[{"armR":"wave"}]'], ['dance'], ['task', 'new', '--', '做点事']]) {
    const r = require('node:child_process').spawnSync(process.execPath, [agent, 'xin', ...argv], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 1, argv.join(' '));
    assert.match(r.stdout, /天启模式是独立功能/);
  }
  for (const f of ['memory.md', 'bond.json', 'next.json', 'moves.json', 'tasks-index.json']) assert.ok(!fs.existsSync(path.join(xin, f)), f);
  assert.strictEqual(fs.readFileSync(path.join(xin, 'runs', run + '.jsonl'), 'utf8'), '');
});

test('记事本超过上限：保留开头和最新的记录，只省略中间', async () => {
  const { memoryView, systemPrompt } = await load('../site/xin/vm-agent.mjs');
  const lines = ['# 小芯的记事本', '', '- 称呼：小李'].concat(Array.from({ length: 1000 }, (_, i) => '- 2026-11-' + String(i).padStart(4, '0') + '：第 ' + i + ' 条记录'));
  const v = memoryView(lines.join('\n'));
  assert.ok(v.length < 8200, v.length);
  assert.ok(v.includes('- 称呼：小李') && v.includes('第 999 条记录') && v.includes('中间较早的内容太长'));
  assert.ok(!v.includes('第 500 条记录'));
  assert.strictEqual(memoryView('- 短的'), '- 短的');
  assert.ok(systemPrompt(lines.join('\n')).includes('第 999 条记录'));
});

// 2026-11-12 站长：「按 Muse 的来……能抄他的就抄他的」。前台加回 Muse 式的人设和说话方式（你是谁、看重什么、怎么说话），
// 推翻 11-10「前台少限定」的做法（那时前台是 Claude Opus，现在是 DeepSeek）；Muse 没有亲密度，所以仍不带关系等级和好感度
test('默认模式前台：Muse 式人设和说话方式，不带会变的分数（保持缓存），表情仍是可用工具；好感度、开场白不出现，记忆自己打理', async () => {
  const { systemPrompt } = await load('../site/xin/vm-agent.mjs');
  const p = systemPrompt('', { tasks: true });
  assert.ok(p.includes('兄弟') && p.includes('北京时间') && p.includes('原话照传') && p.includes('明确同意') && p.includes('我查了') && p.includes('密钥'));
  assert.ok(p.includes('## 你是谁') && p.includes('## 你看重的') && p.includes('## 怎么说话') && p.includes('像朋友在聊天软件里发消息'));
  assert.ok(!p.includes('你和用户现在的关系') && !p.includes('亲近程度'));
  assert.ok(!/好感度 \d/.test(p));
  assert.ok(!p.includes('"bond"') && !p.includes('["xin","next"') && p.includes('["xin","dance"]'));
  assert.ok(p.includes('"--quote"') && p.includes('由你自己打理') && !p.includes('待兄弟确认'));
});

/* ---------- 小芯内核通道（docs/xin-kernel-design.md §4.2、§14.2；计划 Task 6） ---------- */
// 假的 Durable Object 命名空间：按名字建真的 XinTaskSupervisor，存储放内存
function fakeDO(m, envRef) {
  const objs = new Map();
  return {
    objs,
    idFromName: n => n,
    get(id) {
      if (!objs.has(id)) {
        const values = new Map(), state = { alarm: null };
        state.storage = { get: async k => values.get(k), put: async (k, v) => { values.set(k, structuredClone(v)); }, delete: async k => Array.isArray(k) ? k.forEach(x => values.delete(x)) : values.delete(k),
          list: async ({ prefix } = {}) => new Map([...values].filter(([k]) => !prefix || k.startsWith(prefix)).sort(([a], [b]) => a < b ? -1 : 1)),
          setAlarm: async t => { state.alarm = t; }, getAlarm: async () => state.alarm, deleteAlarm: async () => { state.alarm = null; } };
        state.waitUntil = () => {};
        objs.set(id, { o: new m.XinTaskSupervisor(state, envRef), state, values });
      }
      const { o } = objs.get(id);
      return { fetch: (url, init) => { (objs.get(id).seen = objs.get(id).seen || []).push(new URL(url).pathname); return o.fetch(new Request(url, init)); } };
    }
  };
}
const KERNEL_TEXT = '// fake kernel\n';
function kernelEnv(m, extra) {
  const env = mkEnv(Object.assign({ XIN_TRANSPORT: 'kernel', ASSETS: { fetch: async r => { const p = new URL(r.url).pathname; return p === '/xin/vm-agent.mjs' ? new Response(AGENT_TEXT) : p === '/xin/vm-kernel.mjs' ? new Response(KERNEL_TEXT) : new Response('nope', { status: 404 }); } } }, extra));
  env.XIN_TASK_SUPERVISOR = fakeDO(m, env);
  return env;
}
// 假内核默认报「和这次部署同一版本」（电脑上的内核是新的）；测升级的用例自己传旧版本号
const KERNEL_HASH = require('node:crypto').createHash('sha256').update(KERNEL_TEXT).digest('hex').slice(0, 12);
const kres = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'x-xin-kernel': KERNEL_HASH, ...headers } });
const PORT_TOKEN = n => ({ status: 201, body: { url: 'https://8797-abc.instabox.tech', token: 'ibp_t' + n, access: 'private' } });
const execArgv = c => JSON.parse(c.body).argv;
function waiter() { const ps = []; return { ctx: { waitUntil: p => ps.push(p) }, settle: () => Promise.allSettled(ps) }; }
async function callOp(m, env, ck, op, args, ctx) {
  return (await m.handleXin(req('/api/xin/call', { body: { op, args: args || {} }, headers: { cookie: ck } }), env, ctx || null)).json();
}

test('内核通道：只读操作走内核，不调 exec；第一次用会装钥匙，第二次不再装', async () => {
  const m = await fresh(), env = kernelEnv(m), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /xin/op': [() => kres(200, { ok: true, data: { sessions: [] } })] });
  try {
    const d = await callOp(m, env, ck, 'sessions');
    assert.deepStrictEqual(d, { ok: true, data: { sessions: [] } });
    assert.ok(!ib.calls.some(c => c.key.endsWith('/exec')), '不该调 exec');
    const put = ib.calls.find(c => c.key === 'PUT /v1/machines/m_abc/files');
    assert.strictEqual(put.url.searchParams.get('path'), '/data/home/.xin/kernel-keys.json');
    assert.strictEqual(put.url.searchParams.get('mode'), '0600');
    const kid = Object.keys(JSON.parse(put.body).keys)[0];
    const op = ib.calls.find(c => c.key === 'POST /xin/op');
    assert.strictEqual(op.url.host, '8797-abc.instabox.tech');
    assert.strictEqual(op.init.headers.authorization, 'Bearer ibp_t1');
    assert.match(op.init.headers['x-xin-auth'], new RegExp('kid=' + kid + ','));
    assert.match(JSON.parse(op.body).agent, /^\/data\/home\/\.xin\/agent\/vm-agent-[0-9a-f]{12}\.mjs$/);
    await callOp(m, env, ck, 'sessions');
    assert.strictEqual(ib.calls.filter(c => c.key.startsWith('PUT')).length, 1);
    assert.strictEqual(ib.calls.filter(c => c.key.endsWith('/ports')).length, 1);
  } finally { ib.restore(); }
});

test('内核 502：只读的 history 退回 exec，并在后台起 ensure', async () => {
  const m = await fresh(), env = kernelEnv(m), ck = await login(m, env), w = waiter();
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /xin/op': [() => new Response('The sandbox service disconnected', { status: 502 })],
    'POST /v1/machines/m_abc/exec': [(u, init) => new Response(JSON.stringify({ stdout: JSON.parse(init.body).argv.includes('ensure') ? '{"ok":true,"started":true}' : '{"runs":[]}', stderr: '', exitCode: 0 }))] });
  try {
    const d = await callOp(m, env, ck, 'history', { sid: 'sabc123' }, w.ctx);
    await w.settle();
    assert.deepStrictEqual(d, { ok: true, data: { runs: [] } });
    const argvs = ib.calls.filter(c => c.key.endsWith('/exec')).map(execArgv);
    assert.ok(argvs.some(a => a[2] === 'history'));
    const ensure = argvs.find(a => a.includes('ensure'));
    assert.ok(ensure, '后台要起 ensure');
    assert.strictEqual(ensure[0], 'node'); assert.match(ensure[1], /\/vm-kernel-[0-9a-f]{12}\.mjs$/);
    assert.deepStrictEqual(ensure.slice(2), ['ensure', '--port', '8797']);
  } finally { ib.restore(); }
});

test('内核 502：不带编号又会改东西的 memory_add 不退回 exec，报不确定', async () => {
  const m = await fresh(), env = kernelEnv(m), ck = await login(m, env), w = waiter();
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /xin/op': [() => new Response('bad gateway', { status: 502 })],
    'POST /v1/machines/m_abc/exec': [{ body: { stdout: '{"ok":true}', stderr: '', exitCode: 0 } }] });
  try {
    const d = await callOp(m, env, ck, 'memory_add', { content: '记住这个' }, w.ctx);
    await w.settle();
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.msg, '不确定刚才的操作有没有做完，请刷新看看');
    assert.ok(!ib.calls.filter(c => c.key.endsWith('/exec')).some(c => execArgv(c)[2] === 'memory_add'), '不能再用 exec 做一遍');
  } finally { ib.restore(); }
});

test('send 断线：带 clientId 的退回 exec，参数原样（控制器按编号去重）', async () => {
  const m = await fresh(), env = kernelEnv(m), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /xin/op': [() => { throw new TypeError('fetch failed'); }],
    'POST /v1/machines/m_abc/exec': [{ body: { stdout: JSON.stringify({ sid: 's1', run: 'r1' }), stderr: '', exitCode: 0 } }],
    'POST /state': [{ body: { ok: true } }] });
  try {
    const d = await callOp(m, env, ck, 'send', { text: '你好', clientId: 'cid-12345678' });
    assert.deepStrictEqual(d, { ok: true, data: { sid: 's1', run: 'r1' } });
    const sent = JSON.parse(ib.calls.find(c => c.key === 'POST /xin/op').body).args;
    const ex = JSON.parse(ib.calls.find(c => c.key.endsWith('/exec')).body);
    assert.strictEqual(ex.argv[2], 'send');
    assert.deepStrictEqual(JSON.parse(ex.stdin), sent);
    assert.strictEqual(sent.clientId, 'cid-12345678');
  } finally { ib.restore(); }
});

test('内核说做了但出错：不退回 exec；给网页的错误信息脱敏', async () => {
  const m = await fresh(), env = kernelEnv(m), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /xin/op': [() => kres(200, { ok: false, executed: true, error: 'agent_failed', msg: 'vm-agent 出错（退出码 1）：x ibp_XYZSECRET' })] });
  try {
    const d = await callOp(m, env, ck, 'history', { sid: 'sabc123' });
    assert.strictEqual(d.ok, false);
    assert.match(d.msg, /vm-agent 出错/);
    assert.ok(!d.msg.includes('XYZSECRET'));
    assert.ok(!ib.calls.some(c => c.key.endsWith('/exec')));
  } finally { ib.restore(); }
});

test('端口令牌被拒（没有内核头的 401）：换令牌再试一次就通', async () => {
  const m = await fresh(), env = kernelEnv(m), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1), PORT_TOKEN(2)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /xin/op': [() => new Response('This URL is private', { status: 401 }), () => kres(200, { ok: true, data: { ok: 1 } })] });
  try {
    const d = await callOp(m, env, ck, 'sessions');
    assert.deepStrictEqual(d, { ok: true, data: { ok: 1 } });
    const ops = ib.calls.filter(c => c.key === 'POST /xin/op');
    assert.deepStrictEqual(ops.map(c => c.init.headers.authorization), ['Bearer ibp_t1', 'Bearer ibp_t2']);
    assert.ok(!ib.calls.some(c => c.key.endsWith('/exec')));
  } finally { ib.restore(); }
});

test('内核不认识这把钥匙：重装钥匙再试', async () => {
  const m = await fresh(), env = kernelEnv(m), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /xin/op': [() => kres(401, { ok: false, executed: false, error: 'kernel_auth', reason: 'unknown_kid' }), () => kres(200, { ok: true, data: { ok: 2 } })] });
  try {
    assert.deepStrictEqual(await callOp(m, env, ck, 'sessions'), { ok: true, data: { ok: 2 } });
    assert.strictEqual(ib.calls.filter(c => c.key.startsWith('PUT')).length, 2);
  } finally { ib.restore(); }
});

test('内核那边电脑在睡（503）：回 waking 并替它 resume，不退回 exec', async () => {
  const m = await fresh(), env = kernelEnv(m), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /xin/op': [() => new Response('Sandbox is waking up', { status: 503, headers: { 'retry-after': '5' } })],
    'GET /v1/machines/m_abc': [{ body: { id: 'm_abc', state: 'suspended' } }], 'POST /v1/machines/m_abc/resume': [{ status: 202, body: {} }] });
  try {
    const d = await callOp(m, env, ck, 'sessions');
    assert.strictEqual(d.state, 'waking');
    assert.ok(!ib.calls.some(c => c.key.endsWith('/exec')));
  } finally { ib.restore(); }
});

test('XIN_TRANSPORT 不设：有 Durable Object 也照旧走 exec，不发布端口', async () => {
  const m = await fresh(), env = kernelEnv(m, { XIN_TRANSPORT: undefined }), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/exec': [{ body: { stdout: '{"sessions":[]}', stderr: '', exitCode: 0 } }] });
  try {
    assert.deepStrictEqual(await callOp(m, env, ck, 'sessions'), { ok: true, data: { sessions: [] } });
    assert.ok(!ib.calls.some(c => c.key.endsWith('/ports') || c.key === 'POST /xin/op'));
  } finally { ib.restore(); }
});

test('verifyAgent 也核对内核文件', async () => {
  const m = await fresh(), env = kernelEnv(m);
  const ib = fakeIB({ 'POST /v1/machines/m_abc/exec': [{ body: { stdout: '', stderr: '', exitCode: 0 } }] });
  try {
    await m.verifyAgent(env, ORIGIN, 'm_abc', Date.now());
    const argv = execArgv(ib.calls[0]);
    assert.strictEqual(argv[0], 'sha256sum');
    assert.ok(argv.some(p => /\/vm-kernel-[0-9a-f]{12}\.mjs$/.test(p)), argv.join(' '));
  } finally { ib.restore(); }
});

/* ---------- 一次请求的子请求数（#144 正式联调失败，正式运行 43632754629） ----------
   Cloudflare Workers 免费套餐：一次请求最多 50 个子请求，fetch 和读静态资源（ASSETS）都算；Durable Object 是内部服务，另有上限。
   #144 换了控制器，冷启动的那次请求先读 29 个模块文件，再逐个 PUT 上传，传到第 20 个时超了，控制器入口没传上去，联调失败、自动回滚。
   端口令牌是 Durable Object 自己去要的（KernelConfigStore），算在它那次请求里，这里不计。 */
const FREE_SUBREQUESTS = 50;
const SITE_DIR = path.join(__dirname, '../site');
const siteAssets = () => ({ fetch: async r => { const f = path.join(SITE_DIR, new URL(r.url).pathname); return fs.existsSync(f) ? new Response(fs.readFileSync(f, 'utf8')) : new Response('nope', { status: 404 }); } });
const sha256hex = t => require('node:crypto').createHash('sha256').update(t).digest('hex');
const REAL_KERNEL_HASH = sha256hex(fs.readFileSync(path.join(SITE_DIR, 'xin/vm-kernel.mjs'), 'utf8')).slice(0, 12);
function subrequests(env) {
  const s = { used: 0, keys: [] }, inner = globalThis.fetch, assets = env.ASSETS;
  const charge = key => { s.used++; s.keys.push(key); if (s.used > FREE_SUBREQUESTS) throw new Error('Too many subrequests.'); };
  globalThis.fetch = async (url, init = {}) => { const u = new URL(url); if (!u.pathname.endsWith('/ports')) charge((init.method || 'GET') + ' ' + u.pathname); return inner(url, init); };
  env.ASSETS = { fetch: async r => { charge('ASSETS ' + new URL(r.url).pathname); return assets.fetch(r); } };
  s.restore = () => { globalThis.fetch = inner; env.ASSETS = assets; };
  return s;
}
test('冷启动、电脑醒着、这次部署换了控制器（内核通道）：子请求不超过免费套餐的 50 个，控制器一次装好，照常回答', async t => {
  const m = await fresh(), env = kernelEnv(m, { ASSETS: siteAssets() }), ck = await login(m, env), w = waiter();
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /xin/op': [() => kres(409, { ok: false, executed: false, error: 'agent_missing' }, { 'x-xin-kernel': REAL_KERNEL_HASH }), () => kres(200, { ok: true, data: { sessions: [] } }, { 'x-xin-kernel': REAL_KERNEL_HASH })],
    'POST /v1/machines/m_abc/exec': [{ body: { stdout: '{"ok":true}', stderr: '', exitCode: 0 } }] });
  const sub = subrequests(env);
  try {
    const d = await callOp(m, env, ck, 'sessions', {}, w.ctx);
    await w.settle();
    assert.deepStrictEqual(d, { ok: true, data: { sessions: [] } }, '用了 ' + sub.used + ' 个子请求：' + sub.keys.join(', '));
    t.diagnostic('这次请求用了 ' + sub.used + ' 个子请求（免费套餐上限 50）');
    // 模块再多几个也不该逼近上限：留 10 个余量，快到了这里先红
    assert.ok(sub.used <= FREE_SUBREQUESTS - 10, '子请求 ' + sub.used + ' 个，离免费套餐的 50 个太近：' + sub.keys.join(', '));
    const files = installed(ib.calls), local = fs.readdirSync(path.join(SITE_DIR, 'xin')).filter(f => /^vm-.*\.mjs$/.test(f));
    assert.ok(ib.calls.filter(isInstall).length >= 1);
    for (const f of local) assert.ok(files.some(x => new RegExp('/' + f.replace('.mjs', '') + '-[0-9a-f]{12}\\.mjs$').test(x.path)), '没有装 ' + f);
    assert.match(files.at(-1).path, /\/vm-agent-[0-9a-f]{12}\.mjs$/, '入口最后装');
    assert.strictEqual(files.at(-1).mode, '0755');
    assert.strictEqual(files.at(-1).path, JSON.parse(ib.calls.filter(c => c.key === 'POST /xin/op').at(-1).body).agent, '装的就是内核要跑的那个入口');
    for (const x of files) assert.strictEqual(x.sha256, sha256hex(x.text), x.path);
    for (const c of ib.calls.filter(isInstall)) assert.ok(Buffer.byteLength(JSON.parse(c.body).stdin) <= 1048576, 'exec 的标准输入最多 1 MiB');
    assert.deepStrictEqual(ib.calls.filter(c => c.key.startsWith('PUT')).map(c => c.url.searchParams.get('path')), ['/data/home/.xin/kernel-keys.json'], '控制器文件不再逐个 PUT');
  } finally { sub.restore(); ib.restore(); }
});

test('冷启动、这次部署换了控制器（exec 通道）：一样不超 50 个子请求，装好后再跑一次', async t => {
  const m = await fresh(), env = mkEnv({ ASSETS: siteAssets() }), ck = await login(m, env);
  let agentRuns = 0;
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /v1/machines/m_abc/exec': [(u, init) => {
      if (JSON.parse(init.body).argv[1] === '-e') return new Response(JSON.stringify({ stdout: '{"ok":true}', stderr: '', exitCode: 0 }));
      return new Response(JSON.stringify(agentRuns++ ? { stdout: '{"sessions":[]}', stderr: '', exitCode: 0 } : { stdout: '', stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/data/home/.xin/agent/vm-base-x.mjs'", exitCode: 1 }));
    }] });
  const sub = subrequests(env);
  try {
    const d = await callOp(m, env, ck, 'sessions');
    assert.deepStrictEqual(d, { ok: true, data: { sessions: [] } }, '用了 ' + sub.used + ' 个子请求：' + sub.keys.join(', '));
    t.diagnostic('这次请求用了 ' + sub.used + ' 个子请求（免费套餐上限 50）');
    assert.ok(sub.used <= FREE_SUBREQUESTS - 10, '子请求 ' + sub.used + ' 个：' + sub.keys.join(', '));
    assert.strictEqual(agentRuns, 2);
    assert.ok(!ib.calls.some(c => c.key.startsWith('PUT')), '控制器文件不再逐个 PUT');
    assert.match(installed(ib.calls).at(-1).path, /\/vm-agent-[0-9a-f]{12}\.mjs$/);
  } finally { sub.restore(); ib.restore(); }
});

test('要装的文件超过一次 exec 能带的输入（1 MiB）：按顺序分几次装，入口在最后一次', async () => {
  const big = name => '// ' + name + ' ' + '模'.repeat(150000) + '\nexport const ' + name + ' = 1;\n';   // 每个约 450 KB（中文按 3 字节算）
  const files = { '/xin/vm-agent.mjs': "import { a } from './vm-a.mjs';\nimport { b } from './vm-b.mjs';\nimport { c } from './vm-c.mjs';\n", '/xin/vm-a.mjs': big('a'), '/xin/vm-b.mjs': big('b'), '/xin/vm-c.mjs': big('c') };
  const m = await fresh(), env = mkEnv({ ASSETS: { fetch: async r => files[new URL(r.url).pathname] ? new Response(files[new URL(r.url).pathname]) : new Response('nope', { status: 404 }) } }), ck = await login(m, env);
  let agentRuns = 0;
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [(u, init) => JSON.parse(init.body).argv[1] === '-e' ? new Response(JSON.stringify({ stdout: '{"ok":true}', stderr: '', exitCode: 0 }))
      : new Response(JSON.stringify(agentRuns++ ? { stdout: '{"ok":true}', stderr: '', exitCode: 0 } : { stdout: '', stderr: 'Error [ERR_MODULE_NOT_FOUND]: Cannot find module x', exitCode: 1 }))] });
  try {
    assert.strictEqual((await callOp(m, env, ck, 'ping')).ok, true);
    const batches = ib.calls.filter(isInstall).map(c => JSON.parse(c.body).stdin);
    assert.ok(batches.length >= 2, '应分几次装，实际 ' + batches.length + ' 次');
    for (const b of batches) assert.ok(Buffer.byteLength(b) <= 1048576, '一次最多 1 MiB：' + Buffer.byteLength(b));
    assert.deepStrictEqual(installed(ib.calls).map(x => path.basename(x.path).replace(/-[0-9a-f]{12}\.mjs$/, '')), ['vm-a', 'vm-b', 'vm-c', 'vm-agent']);
    assert.deepStrictEqual(JSON.parse(batches.at(-1)).map(x => path.basename(x.path).replace(/-[0-9a-f]{12}\.mjs$/, '')).at(-1), 'vm-agent', '入口在最后一次');
  } finally { ib.restore(); }
});

test('装控制器文件的小程序（在电脑上跑）：按顺序写、摘要对上才换名、权限照给的；摘要或路径不对就停下，不留半个文件', async () => {
  const { AGENT_INSTALL } = await fresh(), { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-install-'));
  try {
    const run = list => spawnSync(process.execPath, ['-e', AGENT_INSTALL, dir], { input: JSON.stringify(list), encoding: 'utf8' });
    const item = (name, text, mode = '0644') => ({ path: path.join(dir, name), mode, sha256: sha256hex(text), text });
    const base = item('vm-base-0123456789ab.mjs', 'export const x = 1;\n'), agent = item('vm-agent-ba9876543210.mjs', "import { x } from './vm-base-0123456789ab.mjs';\n// 中文注释\n", '0755');
    let r = run([base, agent]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(agent.path, 'utf8'), agent.text);
    assert.strictEqual(fs.statSync(agent.path).mode & 0o777, 0o755);
    assert.strictEqual(fs.statSync(base.path).mode & 0o777, 0o644);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [path.basename(agent.path), path.basename(base.path)].sort(), '不留临时文件');
    // 被改过的文件：照这一版的内容重写
    fs.writeFileSync(base.path, 'process.exit(0)\n');
    r = run([base]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(base.path, 'utf8'), base.text);
    // 摘要不对：在它这里停下，前面的写好了，它和后面的都不写，不留临时文件
    const first = item('vm-first-111111111111.mjs', 'export const f = 1;\n'), wrong = { ...item('vm-agent-222222222222.mjs', 'export const w = 1;\n'), sha256: '0'.repeat(64) }, later = item('vm-later-333333333333.mjs', 'export const l = 1;\n');
    r = run([first, wrong, later]);
    assert.notStrictEqual(r.status, 0);
    // Worker 只把标准错误的最后两行报给网页：这里只留一行原因，不能是一串调用栈
    assert.strictEqual(r.stderr.trim(), 'digest mismatch: vm-agent-222222222222.mjs');
    assert.ok(fs.existsSync(first.path) && !fs.existsSync(wrong.path) && !fs.existsSync(later.path));
    assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.tmp')), fs.readdirSync(dir).join(' '));
    // 只写这个目录里、按摘要命名的 vm-*.mjs，权限只认 0644 / 0755
    for (const bad of [{ ...item('vm-x-444444444444.mjs', 'x'), path: path.join(dir, '..', 'vm-x-444444444444.mjs') }, item('run.sh', 'x'), item('vm-agent-555555555555.mjs', 'x', '4755'), item('vm-agent.mjs', 'x')]) {
      r = run([bad]);
      assert.notStrictEqual(r.status, 0, bad.path + ' ' + bad.mode);
      assert.strictEqual(r.stderr.trim(), 'bad file: ' + path.basename(bad.path));
      assert.ok(!fs.existsSync(bad.path), bad.path);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ---------- 待送达和流的接线（计划 Task 8） ---------- */
const inboxOf = env => { env.XIN_TASK_SUPERVISOR.get('xin-inbox'); return env.XIN_TASK_SUPERVISOR.objs.get('xin-inbox'); };
const sendArgs = { agent: 'codex', text: '你好', clientId: 'cid-inbox-0001' };

/* ---------- 状态由谁管：期望和部署代号（第 2 批计划 Task 4） ---------- */
test('内核模式：每次操作把期望放进请求体；usage 的结果带上主人状态和耗时，别的操作不带', async () => {
  const m = await fresh(), env = kernelEnv(m, { CF_VERSION_METADATA: { id: 'ver-a' } }), ck = await login(m, env);
  const owner = { want: 'kernel', mode: 'kernel', epoch: 2, phase: 'running', up: 5000, restarts: 0, lastError: null, spawns: 0 };
  const ops = { all: { n: 3, p50: 4, p95: 9, max: 9 }, byOp: { usage: { n: 1, p50: 4, p95: 4, max: 4 } } };
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /xin/op': [() => kres(200, { ok: true, data: { sessions: [] }, owner }), () => kres(200, { ok: true, data: { days: [] }, owner, ops })] });
  try {
    assert.deepStrictEqual(await callOp(m, env, ck, 'sessions'), { ok: true, data: { sessions: [] } });
    const u = await callOp(m, env, ck, 'usage');
    assert.strictEqual(u.ok, true); assert.deepStrictEqual(u.data.owner, { ...owner, ops });
    const bodies = ib.calls.filter(c => c.key === 'POST /xin/op').map(c => JSON.parse(c.body));
    assert.deepStrictEqual(bodies.map(b => b.owner), [{ mode: 'kernel', gen: 1 }, { mode: 'kernel', gen: 1 }]);
  } finally { ib.restore(); }
});

test('主人暂时不在：不退 exec，回可重试的「稍等」；待送达当作临时错误重送', async () => {
  const m = await fresh(), env = kernelEnv(m, { XIN_INBOX: '1' }), ck = await login(m, env);
  const busy = () => kres(503, { ok: false, executed: false, error: 'owner_unavailable', retryAfter: 3 });
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /xin/op': [busy, busy, () => kres(200, { ok: true, data: { sid: 's1', run: 'r5' } })],
    'POST /v1/machines/m_abc/exec': [{ body: { stdout: '{"sessions":[]}', stderr: '', exitCode: 0 } }] });
  try {
    assert.deepStrictEqual(await callOp(m, env, ck, 'sessions'), { ok: false, state: 'busy', msg: '小芯正在换状态进程，稍等', retryAfter: 3 });
    assert.ok(!ib.calls.some(c => c.key.endsWith('/exec')), '主人暂时不在不退 exec（exec 起的控制器也只能等它）');
    const first = await callOp(m, env, ck, 'send', sendArgs);
    assert.deepStrictEqual([first.ok, first.accepted, first.delivery.state], [false, true, 'pending'], JSON.stringify(first));
    inboxOf(env).values.get('inbox:row:cid-inbox-0001').nextAt = 0;   // 到了该再送的时间
    assert.deepStrictEqual(await callOp(m, env, ck, 'send', sendArgs), { ok: true, data: { sid: 's1', run: 'r5' } });
    assert.ok(!ib.calls.some(c => c.key.endsWith('/exec')));
  } finally { ib.restore(); }
});

// #156 正式联调失败（北京 2026-11-16 20:00）：部署后外壳换状态进程的几秒里，内核起的控制器进程连不上它，
// 把「没执行」当结果打印回来（vm-kernel-client.mjs：{error:'owner_unavailable', executed:false}），内核包成 ok 交回来，
// Worker 当成功给了网页和联调，联调第一个 usage 就判失败、自动回滚。和内核自己回 owner_unavailable 是一回事：都回「稍等」
test('状态进程正在换：控制器把「没执行」当结果回来，也回可重试的「稍等」（内核和 exec 两条路）；别的出错照旧', async () => {
  const unavailable = { error: 'owner_unavailable', msg: '小芯的状态进程暂时不可用，请稍后重试', executed: false };
  {
    const m = await fresh(), env = kernelEnv(m), ck = await login(m, env);
    const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
      'POST /xin/op': [() => kres(200, { ok: true, data: unavailable }), () => kres(200, { ok: true, data: { usage: { today: 1 } } }), () => kres(200, { ok: true, data: { error: 'not_found', msg: '没有这个对话' } })] });
    try {
      assert.deepStrictEqual(await callOp(m, env, ck, 'usage'), { ok: false, state: 'busy', msg: '小芯正在换状态进程，稍等', retryAfter: 3 });
      assert.ok(!ib.calls.some(c => c.key.endsWith('/exec')), '不退 exec');
      const after = await callOp(m, env, ck, 'usage');
      assert.deepStrictEqual([after.ok, after.data && after.data.usage], [true, { today: 1 }], '换好以后照常');
      assert.deepStrictEqual(await callOp(m, env, ck, 'history', { sid: 'sx' }), { ok: true, data: { error: 'not_found', msg: '没有这个对话' } }, '没写 executed:false 的出错照旧交给网页');
    } finally { ib.restore(); }
  }
  {
    const m = await fresh(), env = kernelEnv(m, { XIN_TRANSPORT: undefined }), ck = await login(m, env);
    const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/exec': [{ body: { stdout: JSON.stringify(unavailable), stderr: '', exitCode: 0 } }] });
    try {
      assert.deepStrictEqual(await callOp(m, env, ck, 'sessions'), { ok: false, state: 'busy', msg: '小芯正在换状态进程，稍等', retryAfter: 3 });
    } finally { ib.restore(); }
  }
});

// #158 的正式联调这样失败、回滚（北京 2026-11-16 23:12，只读查了电脑上的 kernel.jsonl）：部署后外壳停旧的状态进程的那几百毫秒里，
// usage 交给当场起的控制器，它连上了正在停的旧进程、发出去以后连接断了，vm-kernel-client.mjs 记成「不知道执行没有」（executed:'unknown'），
// 不是 #157 认的 executed:false。只读的、带去重标识的（retrySafe，和换通道重来用同一条规则）重来无害，也回「稍等」；别的不知道做没做，照旧交出去
test('状态进程正在换、请求发出去后连接断了（executed:unknown）：能安全重来的（只读、带 clientId）也回「稍等」；改名这类照旧交出去', async () => {
  const lost = { error: 'owner_unavailable', msg: '小芯的状态进程暂时不可用，请稍后重试', executed: 'unknown' };
  const busy = { ok: false, state: 'busy', msg: '小芯正在换状态进程，稍等', retryAfter: 3 };
  {
    const m = await fresh(), env = kernelEnv(m), ck = await login(m, env);
    const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
      'POST /xin/op': [() => kres(200, { ok: true, data: lost }), () => kres(200, { ok: true, data: lost }), () => kres(200, { ok: true, data: lost })] });
    try {
      assert.deepStrictEqual(await callOp(m, env, ck, 'usage'), busy, '只读的 usage');
      assert.deepStrictEqual(await callOp(m, env, ck, 'tasks'), busy, '只读的 tasks');
      assert.deepStrictEqual(await callOp(m, env, ck, 'rename', { sid: 'sx', title: '新名字' }), { ok: true, data: lost }, '改名不知道做没做：照旧交出去，不叫人重来');
      assert.ok(!ib.calls.some(c => c.key.endsWith('/exec')), '不退 exec');
    } finally { ib.restore(); }
  }
  {
    const m = await fresh(), env = kernelEnv(m, { XIN_TRANSPORT: undefined }), ck = await login(m, env);
    const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/exec': [{ body: { stdout: JSON.stringify(lost), stderr: '', exitCode: 0 } }] });
    try {
      assert.deepStrictEqual(await callOp(m, env, ck, 'greet'), busy, 'exec 通道也一样（greet 只读）');
    } finally { ib.restore(); }
  }
});

test('send 走待送达：电脑醒着时和以前一样回 run，控制器拿到的是同一个 clientId', async () => {
  const m = await fresh(), env = kernelEnv(m, { XIN_TRANSPORT: undefined, XIN_INBOX: '1' }), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/exec': [{ body: { stdout: JSON.stringify({ sid: 's1', run: 'r1' }), stderr: '', exitCode: 0 } }] });
  try {
    assert.deepStrictEqual(await callOp(m, env, ck, 'send', sendArgs), { ok: true, data: { sid: 's1', run: 'r1' } });
    const ex = JSON.parse(ib.calls.find(c => c.key.endsWith('/exec')).body);
    assert.strictEqual(JSON.parse(ex.stdin).clientId, 'cid-inbox-0001');
    const row = inboxOf(env).values.get('inbox:row:cid-inbox-0001');
    assert.deepStrictEqual([row.state, row.result.run], ['delivered', 'r1']);
  } finally { ib.restore(); }
});

test('send 走待送达：电脑在睡时先回「已收到」和 waking；到时间再发同一个 clientId 就拿到 run，控制器只做了一次', async () => {
  const m = await fresh(), env = kernelEnv(m, { XIN_TRANSPORT: undefined, XIN_INBOX: '1' }), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'GET /v1/machines/m_abc': [{ body: { id: 'm_abc', state: 'suspended' } }], 'POST /v1/machines/m_abc/resume': [{ status: 202, body: {} }],
    'POST /v1/machines/m_abc/exec': [{ status: 409, body: { error: { code: 'machine_not_running' } } }, { body: { stdout: JSON.stringify({ sid: 's1', run: 'r7' }), stderr: '', exitCode: 0 } }] });
  try {
    const first = await callOp(m, env, ck, 'send', sendArgs);
    assert.deepStrictEqual([first.ok, first.state, first.accepted], [false, 'waking', true]);
    assert.deepStrictEqual([first.delivery.id, first.delivery.state, first.delivery.text], ['cid-inbox-0001', 'pending', '你好']);
    assert.match(first.msg, /已收到/);
    inboxOf(env).values.get('inbox:row:cid-inbox-0001').nextAt = 0;   // 到了该再送的时间
    assert.deepStrictEqual(await callOp(m, env, ck, 'send', sendArgs), { ok: true, data: { sid: 's1', run: 'r7' } });
    const execs = ib.calls.filter(c => c.key.endsWith('/exec'));
    assert.strictEqual(execs.length, 2, '第一次 InstaBox 说电脑没在跑（控制器没执行），第二次才真正执行');
    assert.strictEqual(JSON.parse(execs[0].body).stdin, JSON.parse(execs[1].body).stdin);
  } finally { ib.restore(); }
});

// 2026-11-17 站长：「这次上线之后……先是显示接收中，然后又显示唤醒中」。云电脑上的内核记录里 send 只要几十毫秒，
// 慢在回程：电脑回了以后还同步等后台任务记账（没任务时顺带调 InstaBox 撤租约，那次请求没有超时），拖过待送达当场等的 6 秒。
// 回复不等记账：记账交给 waitUntil 在后台做，慢了、失败了都不拖住、不重发这一句
test('send 走待送达：电脑回了就交给网页，不等后台任务记账（撤租约一直不回也当场回 run，放行以后记账照样做完）', async () => {
  const m = await fresh(), env = kernelEnv(m, { XIN_TRANSPORT: undefined, XIN_INBOX: '1' }), ck = await login(m, env);
  let release; const slow = new Promise(r => { release = r; });
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [{ body: { stdout: JSON.stringify({ sid: 's1', run: 'r1', bg: 0 }), stderr: '', exitCode: 0 } }],
    'PUT /v1/machines/m_abc/activity-leases/xin-r1': [{ body: {} }],
    'DELETE /v1/machines/m_abc/activity-leases/xin-tasks': [() => slow.then(() => new Response('{}'))] });
  try {
    const t0 = performance.now(), d = await callOp(m, env, ck, 'send', sendArgs);
    assert.deepStrictEqual(d, { ok: true, data: { sid: 's1', run: 'r1', bg: 0 } });
    assert.ok(performance.now() - t0 < 3000, '没等撤租约：' + Math.round(performance.now() - t0) + ' 毫秒');
    assert.strictEqual(inboxOf(env).values.get('inbox:row:cid-inbox-0001').state, 'delivered');
    release();
    const tasks = () => env.XIN_TASK_SUPERVISOR.objs.get('xin-tasks')?.values.get('tasks');
    await until(() => tasks() && tasks().leaseCleanup === false, 5000, '记账做完');
    assert.deepStrictEqual([tasks().bg, tasks().machine], [0, 'm_abc']);
  } finally { release(); ib.restore(); }
});

test('后台任务记账失败（监督实例出错）：已经送到的这一句照样算送到、不重发；直接调用的操作也照样拿到结果', async () => {
  const m = await fresh(), env = kernelEnv(m, { XIN_TRANSPORT: undefined, XIN_INBOX: '1' }), ck = await login(m, env), w = waiter();
  const ns = env.XIN_TASK_SUPERVISOR, get = ns.get.bind(ns);
  ns.get = id => id === 'xin-tasks' ? { fetch: async () => new Response('{"error":"down"}', { status: 500 }) } : get(id);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES],
    'POST /v1/machines/m_abc/exec': [{ body: { stdout: JSON.stringify({ sid: 's1', run: 'r1', bg: 0 }), stderr: '', exitCode: 0 } },
      { body: { stdout: JSON.stringify({ tasks: [], bg: 0 }), stderr: '', exitCode: 0 } }],
    'PUT /v1/machines/m_abc/activity-leases/xin-r1': [{ body: {} }] });
  try {
    assert.deepStrictEqual(await callOp(m, env, ck, 'send', sendArgs), { ok: true, data: { sid: 's1', run: 'r1', bg: 0 } });
    const row = inboxOf(env).values.get('inbox:row:cid-inbox-0001');
    assert.deepStrictEqual([row.state, row.attempts], ['delivered', 1]);
    assert.deepStrictEqual(await callOp(m, env, ck, 'tasks', { sid: 's1' }, w.ctx), { ok: true, data: { tasks: [], bg: 0 } });
    await w.settle();
    assert.strictEqual(ib.calls.filter(c => c.key.endsWith('/exec')).length, 2, '这一句只送了一次');
  } finally { ib.restore(); }
});

test('send：待送达存不上时回「消息没存上，请再发一次」，也不去碰电脑', async () => {
  const m = await fresh(), env = kernelEnv(m, { XIN_TRANSPORT: undefined, XIN_INBOX: '1' }), ck = await login(m, env);
  inboxOf(env).state.storage.put = async () => { throw new Error('storage down'); };
  const ib = fakeIB({});
  try {
    // resend：让网页再发时沿用同一个编号（万一其实存上了，待送达认得是同一句，不会变成两轮）
    assert.deepStrictEqual(await callOp(m, env, ck, 'send', sendArgs), { ok: false, state: 'error', resend: true, msg: '消息没存上，请再发一次' });
    assert.strictEqual(ib.calls.length, 0);
  } finally { ib.restore(); }
});

test('send：那一行其实已经存进去、只是这次调用后面出了错——不说「没存上」，回「已收到」（免得重发成两轮）', async () => {
  const m = await fresh(), env = kernelEnv(m, { XIN_TRANSPORT: undefined, XIN_INBOX: '1' }), ck = await login(m, env);
  const st = inboxOf(env).state.storage, getAlarm = st.getAlarm; let fail = 1;
  st.getAlarm = async () => { if (fail-- > 0) throw new Error('storage hiccup'); return getAlarm(); };
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/exec': [{ body: { stdout: JSON.stringify({ sid: 's1', run: 'r1' }), stderr: '', exitCode: 0 } }] });
  try {
    const d = await callOp(m, env, ck, 'send', sendArgs);
    assert.deepStrictEqual([d.ok, d.accepted, d.delivery && d.delivery.id, d.delivery && d.delivery.state], [false, true, 'cid-inbox-0001', 'pending']);
    assert.match(d.msg, /已收到/);
  } finally { ib.restore(); }
});

test('send：存没存上都问不出来时（实例正在重置），回 resend，让网页沿用同一个编号再发', async () => {
  const m = await fresh(), env = kernelEnv(m, { XIN_TRANSPORT: undefined, XIN_INBOX: '1' }), ck = await login(m, env);
  const ns = env.XIN_TASK_SUPERVISOR, get = ns.get.bind(ns);
  ns.get = id => id === 'xin-inbox' ? { fetch: async () => { throw new Error('Durable Object reset because its code was updated.'); } } : get(id);
  const ib = fakeIB({});
  try {
    assert.deepStrictEqual(await callOp(m, env, ck, 'send', sendArgs), { ok: false, state: 'error', resend: true, msg: '消息没存上，请再发一次' });
  } finally { ib.restore(); }
});

test('内核 502：stop 和每日任务重做无害，退回 exec——内核没在跑时照样能停，定时的每日任务照样跑', async () => {
  const m = await fresh(), env = kernelEnv(m), ck = await login(m, env), w = waiter();
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'POST /xin/op': [() => new Response('bad gateway', { status: 502 })],
    'POST /v1/machines/m_abc/exec': [(u, init) => { const a = JSON.parse(init.body).argv; return new Response(JSON.stringify({ stdout: a.includes('ensure') ? '{"ok":true,"started":true}' : a[2] === 'daily' ? '{"skipped":"empty"}' : a[2] === 'stop' ? '{"ok":true}' : '{"error":"not_now"}', stderr: '', exitCode: 0 })); }] });
  try {
    assert.deepStrictEqual(await callOp(m, env, ck, 'stop', { run: 'rabc1234' }, w.ctx), { ok: true, data: { ok: true } });
    const r = await m.runCron(m.CRON_DAILY, env, w.ctx, { wait: async () => {} });
    await w.settle();
    assert.deepStrictEqual(r, { ok: true, data: { skipped: 'empty' } });
  } finally { ib.restore(); }
});

test('send：同一 clientId 换了内容，和控制器一样报冲突，不送', async () => {
  const m = await fresh(), env = kernelEnv(m, { XIN_TRANSPORT: undefined, XIN_INBOX: '1' }), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/exec': [{ body: { stdout: JSON.stringify({ sid: 's1', run: 'r1' }), stderr: '', exitCode: 0 } }] });
  try {
    await callOp(m, env, ck, 'send', sendArgs);
    const d = await callOp(m, env, ck, 'send', { ...sendArgs, text: '另一句' });
    assert.deepStrictEqual(d, { ok: true, data: { error: 'message_conflict', msg: '同一个消息标识对应了不同内容，请重新发送' } });
    assert.strictEqual(ib.calls.filter(c => c.key.endsWith('/exec')).length, 1);
  } finally { ib.restore(); }
});

test('delivery 和 deliveries 只找待送达，不碰 InstaBox', async () => {
  const m = await fresh(), env = kernelEnv(m, { XIN_INBOX: '1' }), ck = await login(m, env);
  const ib = fakeIB({});
  try {
    assert.deepStrictEqual(await callOp(m, env, ck, 'delivery', { id: 'cid-nothing-1' }), { ok: true, data: { error: 'not_found' } });
    assert.deepStrictEqual(await callOp(m, env, ck, 'deliveries'), { ok: true, data: { rows: [], wakes: { count: 0, p50: 0, max: 0, over45: 0 } } });
    assert.strictEqual(ib.calls.length, 0);
  } finally { ib.restore(); }
});

test('打开网页（greet）之后顺手踢一下待送达', async () => {
  const m = await fresh(), env = kernelEnv(m, { XIN_TRANSPORT: undefined, XIN_INBOX: '1' }), ck = await login(m, env), w = waiter();
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/exec': [{ body: { stdout: '{"ok":true}', stderr: '', exitCode: 0 } }] });
  try {
    await callOp(m, env, ck, 'greet', {}, w.ctx); await w.settle();
    assert.ok((inboxOf(env).seen || []).includes('/inbox/kick'));
  } finally { ib.restore(); }
});

test('/api/xin/me：内核通道开着时说可以用流、待送达开着时说有待送达，没开就不带这些字段', async () => {
  const m = await fresh();
  const on = await (await m.handleXin(new Request(ORIGIN + '/api/xin/me'), kernelEnv(m, { XIN_INBOX: '1' }), null)).json();
  assert.deepStrictEqual([on.stream, on.inbox], [true, true]);
  const off = await (await m.handleXin(new Request(ORIGIN + '/api/xin/me'), mkEnv(), null)).json();
  assert.ok(!('stream' in off) && !('inbox' in off));
});

const streamReq = (q, headers) => new Request(ORIGIN + '/api/xin/stream?' + q, { method: 'GET', headers: Object.assign({ 'x-xin': '1' }, headers || {}) });
test('stream：原样透传内核的流，签名的查询串里带上控制器路径', async () => {
  const m = await fresh(), env = kernelEnv(m), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'GET /xin/stream': [() => new Response('id: 10\ndata: {"events":[{"t":"text","text":"整段"}]}\n\nid: 20\ndata: {"events":[],"done":true}\n\n', { status: 200, headers: { 'x-xin-kernel': '0123456789ab', 'content-type': 'text/event-stream; charset=utf-8' } })] });
  try {
    const r = await m.handleXin(streamReq('run=rabc12345&off=0&pos=0&watching=1&deviceId=dev12345', { cookie: ck }), env, null);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/event-stream/);
    const text = await r.text();
    assert.ok(text.includes('data: {"events":[{"t":"text","text":"整段"}]}'));
    assert.ok(text.includes('"done":true'));
    const k = ib.calls.find(c => c.key === 'GET /xin/stream');
    assert.strictEqual(k.url.searchParams.get('run'), 'rabc12345');
    assert.strictEqual(k.url.searchParams.get('watching'), '1');
    assert.match(k.url.searchParams.get('agent'), /^\/data\/home\/\.xin\/agent\/vm-agent-[0-9a-f]{12}\.mjs$/);
    assert.ok(k.init.headers['x-xin-auth']); assert.strictEqual(k.init.headers.authorization, 'Bearer ibp_t1');
  } finally { ib.restore(); }
});

test('stream：没登录 401；内核不在、没开内核通道都回 503 让网页退回轮询', async () => {
  const m = await fresh(), env = kernelEnv(m), ck = await login(m, env);
  const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
    'GET /xin/stream': [() => new Response('bad gateway', { status: 502 })], 'POST /v1/machines/m_abc/exec': [{ body: { stdout: '{"ok":true}', stderr: '', exitCode: 0 } }] });
  try {
    assert.strictEqual((await m.handleXin(streamReq('run=rabc12345'), env, null)).status, 401);
    const down = await m.handleXin(streamReq('run=rabc12345', { cookie: ck }), env, null);
    assert.deepStrictEqual([down.status, await down.json()], [503, { ok: false, state: 'unavailable' }]);
    const off = await m.handleXin(streamReq('run=rabc12345', { cookie: ck }), kernelEnv(m, { XIN_TRANSPORT: undefined }), null);
    assert.strictEqual(off.status, 503);
    assert.strictEqual((await m.handleXin(streamReq('run=../x', { cookie: ck }), env, null)).status, 400);
  } finally { ib.restore(); }
});

test('内核版本和这次部署的不一样：后台起 ensure 升级；一样就不起', async () => {
  const want = require('node:crypto').createHash('sha256').update(KERNEL_TEXT).digest('hex').slice(0, 12);
  for (const [version, expectEnsure] of [['oldoldoldold', true], [want, false]]) {
    const m = await fresh(), env = kernelEnv(m), ck = await login(m, env), w = waiter();
    const ib = fakeIB({ 'GET /v1/machines': [MACHINES], 'POST /v1/machines/m_abc/ports': [PORT_TOKEN(1)], 'PUT /v1/machines/m_abc/files': [{ status: 201, body: {} }],
      'POST /xin/op': [() => kres(200, { ok: true, data: { a: 1 } }, { 'x-xin-kernel': version })],
      'POST /v1/machines/m_abc/exec': [{ body: { stdout: '{"ok":true,"started":true}', stderr: '', exitCode: 0 } }] });
    try {
      assert.deepStrictEqual(await callOp(m, env, ck, 'sessions', {}, w.ctx), { ok: true, data: { a: 1 } });
      await w.settle();
      const ensured = ib.calls.filter(c => c.key.endsWith('/exec')).some(c => execArgv(c).includes('ensure'));
      assert.strictEqual(ensured, expectEnsure, version);
    } finally { ib.restore(); }
  }
});
