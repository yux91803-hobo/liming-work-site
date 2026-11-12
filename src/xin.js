// 小芯聊天：网站 ⇄ InstaBox 云电脑里的 AI（Claude Code / Codex）
//
// 只给站长自己用：要先用密码登录（OWNER_PASSWORD），登录后发一个签过名的 cookie，30 天有效；改密码以后旧 cookie 全部失效。
// 没配 OWNER_PASSWORD（至少 12 位）和 INSTABOX_API_KEY 时整个功能关着（测试站就是这样）。
//
// 接口：
//   GET  /api/xin/me       {enabled, authed}
//   POST /api/xin/login    {password}
//   POST /api/xin/logout
//   POST /api/xin/call     {op, args}   op = status | wake | ping | send | poll | stop | sessions | history | memory_list | memory_add | memory_update | memory_forget（小芯的记忆）| memory | memory_set（以前的记事本）
//                                       | greet | daily | daily_get | daily_set | rename | archive | forget（对话改名 / 归档 / 删除）| files（小芯的文件：列文件夹、预览）
//                                       | push_key | push_sub | push_unsub | push_test（做完提醒）| moves（新动作）| bond | bond_play（好感度）
//                                       | screen {control?}（小芯的屏幕：开桌面、桌面上开终端、要一个短时的桌面链接）| screen_off（作废桌面链接）
//                                       | tasks {sid?, all?} | task_stop {sid} | task_tell {sid, text}（后台任务：卡片、看过程、停、补充）
//                                       | logins | login_remove {site} | login_open {sid?|url?} | login_done（站长的网站登录，docs/xin-browser-v2-design.md）
//                                       | usage（用量看板：额度、预计用完、每天的 token）
//   GET  /api/xin/file?path=/data/workspace/…   下载小芯电脑里的一个文件（先让 vm-agent 核对在工作目录里，再从 InstaBox 原样转过来）
// status、wake 直接调 InstaBox 的机器接口（wake：打开网页时把睡着的云电脑叫醒，已经醒着就什么都不做）；其余都转成 InstaBox exec：node <vm-agent.mjs> <op>，参数从 stdin 传进去（见 site/xin/vm-agent.mjs）。
// 返回 {ok:true, data} 或 {ok:false, state, msg, retryAfter}：state = waking（云电脑在睡，唤醒中）、cooldown（跑满 8 小时后的冷却）、busy、error。
const API = 'https://api.instabox.sh';
const COOKIE = '__Host-xin';
const SESSION_SEC = 30 * 86400;
const AGENT_ASSET = '/xin/vm-agent.mjs';
const VM_DIR = '/data/home/.xin/agent';
export const OPS = new Set(['status', 'wake', 'ping', 'send', 'steer', 'poll', 'stop', 'sessions', 'history', 'memory', 'memory_set', 'memory_list', 'memory_add', 'memory_update', 'memory_forget','memory_preferences','memory_preferences_set','learning_report', 'greet', 'daily', 'daily_get', 'daily_set', 'rename', 'archive', 'forget', 'files', 'plugins', 'plugin_set',
  'push_key', 'push_sub', 'push_unsub', 'push_test', 'moves', 'bond', 'bond_play', 'screen', 'screen_off', 'tasks', 'task_stop', 'task_tell', 'usage',
  'logins', 'login_open', 'login_done', 'login_remove']);
const SCREEN_W = 1280, SCREEN_H = 800, SCREEN_VIEW_TTL = 1800, SCREEN_CTL_TTL = 900;   // 桌面大小；链接多久内能打开（秒）
const FILE_MAX = 100 * 1024 * 1024;   // 下载最大 100 MB（和上传一样大：发给小芯的文件也能原样下回来）
const UPLOAD_MAX = 100 * 1024 * 1024, UPLOAD_DIR = '/data/workspace/uploads';   // 给小芯发文件：一个最大 100 MB（Cloudflare Worker 收请求的上限），放在它工作目录的 uploads/日期/ 下面
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
// Same policy is exercised by the controller's browser check in vm-runtime.mjs.
const WEB_PREVIEW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const HDRS = { 'Content-Type': 'application/json; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

const enc = new TextEncoder();
function json(body, status = 200, extra) { return new Response(JSON.stringify(body), { status, headers: { ...HDRS, ...(extra || {}) } }); }
function b64url(buf) { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function sameBytes(a, b) {
  a = new Uint8Array(a); b = new Uint8Array(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a[i] | 0) ^ (b[i] | 0);
  return d === 0;
}

export function enabled(env) {
  return typeof env.OWNER_PASSWORD === 'string' && env.OWNER_PASSWORD.length >= 12 && typeof env.INSTABOX_API_KEY === 'string' && env.INSTABOX_API_KEY.length > 8;
}

/* ---------- 登录 ---------- */
let keyCache = null;
async function signKey(env) {
  if (keyCache && keyCache.pw === env.OWNER_PASSWORD) return keyCache.key;
  // 签 cookie 的钥匙从密码派生：改了密码，以前发出去的 cookie 自动作废
  const base = await crypto.subtle.importKey('raw', enc.encode(env.OWNER_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = await crypto.subtle.sign('HMAC', base, enc.encode('liming-xin-session-v1'));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  keyCache = { pw: env.OWNER_PASSWORD, key };
  return key;
}
async function makeCookie(env, now) {
  const exp = Math.floor(now / 1000) + SESSION_SEC;
  const sig = await crypto.subtle.sign('HMAC', await signKey(env), enc.encode('v1.' + exp));
  return 'v1.' + exp + '.' + b64url(sig);
}
async function callbackToken(env) {
  return b64url(await crypto.subtle.sign('HMAC', await signKey(env), enc.encode('xin-task-callback-v1')));
}
function supervisor(env) { return env.XIN_TASK_SUPERVISOR?.get(env.XIN_TASK_SUPERVISOR.idFromName('xin-tasks')); }
async function recordTasks(env, state) {
  const stub = supervisor(env); if (!stub) return;
  const r = await stub.fetch('https://xin.internal/state', { method: 'POST', body: JSON.stringify(state) });
  if (!r.ok) throw new Error('后台任务监督状态没有保存');
}
function readCookie(req) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(/;\s*/)) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i) === COOKIE) return part.slice(i + 1); }
  return '';
}
export async function authed(req, env, now = Date.now()) {
  if (!enabled(env)) return false;
  const m = /^v1\.(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(readCookie(req));
  if (!m || Number(m[1]) * 1000 < now) return false;
  const want = await crypto.subtle.sign('HMAC', await signKey(env), enc.encode('v1.' + m[1]));
  return sameBytes(enc.encode(b64url(want)), enc.encode(m[2]));
}
async function checkPassword(env, pw) {
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(String(pw))), crypto.subtle.digest('SHA-256', enc.encode(env.OWNER_PASSWORD))]);
  return sameBytes(a, b);
}
function cookieHeader(v, maxAge) { return `${COOKIE}=${v}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`; }

/* ---------- InstaBox ---------- */
function ib(env, path, init = {}) {
  return fetch(API + path, { ...init, headers: { 'X-API-Key': env.INSTABOX_API_KEY, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}
async function ibErr(r) {
  let e = {};
  try { e = (await r.json()).error || {}; } catch { /* 不是 JSON */ }
  return { status: r.status, code: e.code || 'http_' + r.status, msg: e.message || '', retryAfter: e.retryAfterSeconds || Number(r.headers.get('retry-after')) || 0 };
}
let machineCache = null;
async function machine(env, now) {
  if (machineCache && machineCache.key === env.INSTABOX_API_KEY && now - machineCache.at < 600000) return machineCache.m;
  const r = await ib(env, '/v1/machines');
  if (!r.ok) throw await ibErr(r);
  const list = (await r.json()).machines || [];
  const want = env.XIN_MACHINE || 'li';
  const m = list.find(x => x.name === want || x.id === want) || (list.length === 1 ? list[0] : null);
  if (!m) throw { status: 404, code: 'no_machine', msg: '找不到云电脑「' + want + '」' };
  machineCache = { key: env.INSTABOX_API_KEY, at: now, m: { id: m.id, name: m.name } };
  return machineCache.m;
}
let agentCache = null;
// vm-agent.mjs and every local module it imports (recursively) go to the VM under content-hashed names.
// Dependencies are hashed first, so any change anywhere renames everything that imports it.
const MODULE_IMPORT = /from '\.\/(vm-[a-z0-9-]+\.mjs)'/g;
async function agentScript(env, origin) {
  if (agentCache) return agentCache;
  const sources = new Map(), order = [];
  const visit = async (file, chain) => {
    if (chain.includes(file)) throw { status: 500, code: 'module_cycle', msg: '小芯脚本的模块有循环依赖：' + chain.concat(file).join(' → ') };
    if (sources.has(file)) return;
    const r = await env.ASSETS.fetch(new Request(origin + '/xin/' + file));
    if (!r.ok) throw file === 'vm-agent.mjs' ? { status: 500, code: 'no_agent', msg: '网站里缺 vm-agent.mjs' } : { status: 500, code: 'no_runtime', msg: '网站里缺 ' + file };
    const text = await r.text();
    sources.set(file, text);
    for (const dep of new Set([...text.matchAll(MODULE_IMPORT)].map(m => m[1]))) await visit(dep, chain.concat(file));
    order.push(file);
  };
  await visit(AGENT_ASSET.split('/').pop(), []);
  const names = new Map(), texts = new Map(), digests = new Map();
  for (const file of order) {   // dependencies before dependants
    let text = sources.get(file);
    for (const dep of new Set([...text.matchAll(MODULE_IMPORT)].map(m => m[1]))) text = text.replaceAll("from './" + dep + "'", "from './" + names.get(dep) + "'");
    const sha256 = hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
    names.set(file, file.replace(/\.mjs$/, '-') + sha256.slice(0, 12) + '.mjs');
    texts.set(file, text); digests.set(file, sha256);
  }
  const entry = AGENT_ASSET.split('/').pop();
  const dependencies = order.filter(f => f !== entry).map(f => ({ text: texts.get(f), path: VM_DIR + '/' + names.get(f), sha256: digests.get(f) }));
  agentCache = { text: texts.get(entry), path: VM_DIR + '/' + names.get(entry), sha256: digests.get(entry), dependencies };
  return agentCache;
}
function putAgentFile(env, id, file, mode) {
  return ib(env, `/v1/machines/${id}/files?path=${encodeURIComponent(file.path)}&parents=true&mode=${mode}`, { method: 'PUT', body: file.text, headers: { 'Content-Type': 'application/octet-stream' } });
}
// The controller's scripts live on a machine where fully privileged agents also run. A script is found by the hash in
// its name, so a file edited in place would keep being executed. Every ten minutes (per isolate) compare what is on
// the machine with what this deployment ships; anything different is replaced and the incident is written down.
let verifiedAt = 0;
export async function verifyAgent(env, origin, id, now = Date.now()) {
  if (now - verifiedAt < 600000) return { skipped: true };
  verifiedAt = now;
  const agent = await agentScript(env, origin), files = [...agent.dependencies, agent];
  const r = await ib(env, `/v1/machines/${id}/exec`, { method: 'POST', body: JSON.stringify({ argv: ['sha256sum', '--', ...files.map(f => f.path)], timeoutSeconds: 20 }) });
  if (!r.ok) { verifiedAt = 0; return { skipped: true }; }   // asleep or busy: the request that follows reports it; check again next time
  const found = new Map();
  for (const line of String((await r.json()).stdout || '').split('\n')) { const m = /^([a-f0-9]{64})\s+\*?(\S.*)$/.exec(line); if (m) found.set(m[2], m[1]); }
  // A missing file is uploaded by exec() when it is first needed; only a present file with other content is an incident.
  const changed = files.filter(f => found.has(f.path) && found.get(f.path) !== f.sha256);
  if (!changed.length) return { ok: true };
  for (const f of files) { const u = await putAgentFile(env, id, f, f === agent ? '0755' : '0644'); if (!u.ok) { verifiedAt = 0; throw await ibErr(u); } }
  await exec(env, origin, id, 'integrity_event', { files: changed.map(f => f.path.split('/').pop()) }).catch(() => null);
  return { ok: false, repaired: changed.length };
}
function uuid() { return crypto.randomUUID(); }

// 云电脑没在跑：自己暂停的（空闲）exec 会自动叫醒；被手动暂停 / 关机的，这里替它 resume / start
async function wakeUp(env, id) {
  const r = await ib(env, '/v1/machines/' + id);
  if (!r.ok) return ibErr(r);
  const st = (await r.json()).state;
  const op = st === 'stopped' ? 'start' : 'resume';
  const w = await ib(env, `/v1/machines/${id}/${op}`, { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: '{}' });
  if (w.ok || w.status === 202) return null;
  return ibErr(w);
}
function explain(e) {
  const c = e.code;
  if (c === 'machine_not_running' || c === 'operation_conflict' || c === 'host_unavailable') return { ok: false, state: 'waking', msg: '唤醒中…', retryAfter: 3 };
  if (c === 'machine_cooldown') return { ok: false, state: 'cooldown', msg: '云电脑连续跑满了时长，正在冷却', retryAfter: e.retryAfter || 60 };
  if (e.status === 429 || e.status === 503) return { ok: false, state: 'busy', msg: 'InstaBox 忙，稍等', retryAfter: e.retryAfter || 5 };
  if (c === 'permission_denied') return { ok: false, state: 'error', msg: '这个 InstaBox key 不能生成桌面链接：要用创建这台云电脑的人自己的 key' };
  if (e.status === 401 || e.status === 403) return { ok: false, state: 'error', msg: 'InstaBox key 不能用（' + c + '）' };
  if (c === 'max_run_disabled') return { ok: false, state: 'error', msg: '云电脑的最长运行时间被设成了 0，到 InstaBox 后台改一下' };
  return { ok: false, state: 'error', msg: e.msg || c || '云电脑出错了' };
}

async function exec(env, origin, id, op, args, retried) {
  const agent = await agentScript(env, origin);
  const r = await ib(env, `/v1/machines/${id}/exec`, { method: 'POST', body: JSON.stringify({ argv: ['node', agent.path, op], stdin: JSON.stringify(args || {}), timeoutSeconds: 40 }) });
  if (!r.ok) throw await ibErr(r);
  const res = await r.json();
  if (res.exitCode !== 0) {
    // 脚本还没传上去，或者改过了（文件名带内容的哈希）：传一份再跑
    if (!retried && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(res.stderr || '')) {
      for (const dependency of agent.dependencies) {
        const d = await putAgentFile(env, id, dependency, '0644');
        if (!d.ok) throw await ibErr(d);
      }
      const u = await putAgentFile(env, id, agent, '0755');
      if (!u.ok) throw await ibErr(u);
      return exec(env, origin, id, op, args, true);
    }
    if (res.oomKilled) throw { status: 500, code: 'oom', msg: '云电脑内存不够，脚本被杀了' };
    throw { status: 500, code: 'agent_failed', msg: 'vm-agent 出错（退出码 ' + res.exitCode + '）：' + String(res.stderr || '').trim().split('\n').slice(-3).join(' ') };
  }
  try { return JSON.parse(res.stdout); } catch { throw { status: 500, code: 'agent_output', msg: 'vm-agent 的输出看不懂' }; }
}

async function call(env, origin, op, args, ctx, now) {
  let m;
  try { m = await machine(env, now); } catch (e) { return explain(e); }
  if (op === 'wake') {
    const r = await ib(env, '/v1/machines/' + m.id);
    if (!r.ok) return explain(await ibErr(r));
    const d = await r.json();
    if (d.cooldownUntil && Date.parse(d.cooldownUntil) > now) return { ok: true, data: { state: d.state, action: 'cooldown', cooldownUntil: d.cooldownUntil } };
    if (d.state !== 'suspended' && d.state !== 'stopped') return { ok: true, data: { state: d.state, action: 'none' } };
    const op2 = d.state === 'stopped' ? 'start' : 'resume';
    const w = await ib(env, `/v1/machines/${m.id}/${op2}`, { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: '{}' });
    if (!w.ok && w.status !== 202) { const e = await ibErr(w); if (e.code !== 'operation_conflict') return explain(e); }
    return { ok: true, data: { state: d.state, action: op2 } };
  }
  /* 小芯的屏幕：先把桌面开起来（已经开着就什么都不做），在桌面上开那个滚动显示它在干什么的终端（开不了也不影响看），
     再要一个短时链接（InstaBox 的桌面查看页，能嵌进 iframe）：观看时服务器丢掉键盘鼠标，接管时能操作。screen_off 把链接全部作废 */
  /* 登录窗口（docs/xin-browser-v2-design.md 第 7 节）：和「屏幕」一样先把桌面开起来，云电脑在桌面上开登录窗口，回一个能接管的桌面链接 */
  if (op === 'screen' || op === 'login_open') {
    const ds = await ib(env, `/v1/machines/${m.id}/desktop`, { method: 'POST', body: JSON.stringify({ action: 'start', width: SCREEN_W, height: SCREEN_H }) });
    if (!ds.ok) {
      const e = await ibErr(ds);
      if (e.code === 'machine_not_running') { const w = await wakeUp(env, m.id); if (w && w.code !== 'operation_conflict') return explain(w); }
      return explain(e);
    }
    const d = await ds.json();
    if (!d.running) return d.installing ? { ok: false, state: 'waking', msg: '正在给电脑装桌面…', retryAfter: 10 } : { ok: false, state: 'error', msg: d.hint || '桌面没开起来' };
    let term = null, login = null;
    if (op === 'login_open') {
      try { login = await exec(env, origin, m.id, 'login_open', { sid: args && args.sid, url: args && args.url }); } catch (e) { return explain(e); }
      if (!login || login.error) return { ok: false, state: 'error', msg: (login && login.msg) || '登录窗口没开起来' };
    } else {
      try { term = await exec(env, origin, m.id, 'screen', {}); } catch (e) { term = { error: (e && e.code) || 'exec' }; }
    }
    const control = op === 'login_open' || !!(args && args.control);
    const r = await ib(env, `/v1/machines/${m.id}/desktop/stream`, { method: 'POST', body: JSON.stringify({ viewOnly: !control, ttlSeconds: control ? SCREEN_CTL_TTL : SCREEN_VIEW_TTL }) });
    if (!r.ok) return explain(await ibErr(r));
    const link = await r.json();
    return { ok: true, data: { url: link.url, expiresAt: link.expiresAt, control, terminal: !!(term && term.ok), ...(login ? { site: login.site } : {}) } };
  }
  if (op === 'screen_off') {
    const r = await ib(env, `/v1/machines/${m.id}/desktop/stream`, { method: 'DELETE' });
    if (!r.ok && r.status !== 204) return explain(await ibErr(r));
    return { ok: true, data: { ok: true } };
  }
  if (op === 'status') {
    const r = await ib(env, '/v1/machines/' + m.id);
    if (!r.ok) return explain(await ibErr(r));
    const d = await r.json();
    return { ok: true, data: { name: d.name, state: d.state, cooldownUntil: d.cooldownUntil || null } };
  }
  try {
    if (supervisor(env) && ['send', 'daily'].includes(op)) args = { ...(args || {}), _callback: { url: origin + '/api/xin/task-event', token: await callbackToken(env) } };
    const data = await exec(env, origin, m.id, op, args);
    // 打开网页（greet）时顺手核对云电脑上的控制器脚本有没有被改过；不挡这次请求
    if (op === 'greet' && ctx) ctx.waitUntil(verifyAgent(env, origin, m.id, now).catch(() => null));
    // AI 在等模型回话时云电脑看起来是闲着的：挂一个「有活在干」的租约，别让它半路自己暂停
    const lease = (method, id, ttl) => ib(env, `/v1/machines/${m.id}/activity-leases/xin-${id}`, method === 'PUT' ? { method, body: JSON.stringify({ ttlSeconds: ttl || 1800 }) } : { method }).catch(() => null);
    if ((op === 'send' || op === 'daily') && data && data.run && ctx) ctx.waitUntil(lease('PUT', data.run));
    if (op === 'poll' && data && data.done && args && args.run && ctx) ctx.waitUntil(lease('DELETE', args.run));
    // 后台任务（分身）：vm-agent 说有任务在做就续一个小时（它每 20 分钟提醒一次），都做完了就撤
    if (!supervisor(env) && !env.XIN_TASK_LEASE_MANAGED && data && data.lease === 'renew' && ctx) ctx.waitUntil(lease('PUT', 'tasks', 3600));
    if (!supervisor(env) && !env.XIN_TASK_LEASE_MANAGED && data && data.lease === 'drop' && ctx) ctx.waitUntil(lease('DELETE', 'tasks'));
    if (supervisor(env) && data && Number.isInteger(data.bg)) {
      await recordTasks(env, { bg: data.bg, ...(data.version != null ? { version: data.version } : {}), machine: m.id, observedAt: Date.now() });
    }
    return { ok: true, data };
  } catch (e) {
    if (e && e.code === 'machine_not_running') {
      const w = await wakeUp(env, m.id);
      if (w && w.code !== 'operation_conflict') return explain(w);
    }
    if (e && e.status === 404) machineCache = null;
    return explain(e || {});
  }
}

/* ---------- 下载小芯的文件 ----------
   GET（浏览器直接下载）：cookie 是 SameSite=Strict，别的网站带不上；回的是附件（attachment + nosniff + sandbox），不会当网页打开。
   先让 vm-agent 核对路径（在工作目录里、软链接没指到外面、是文件、不太大），再用它给的真实路径从 InstaBox 取原始字节。 */
function asciiName(n) { return n.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'file'; }
async function download(req, env, ctx, url, now) {
  if (!enabled(env)) return json({ error: 'disabled' }, 404);
  if (!(await authed(req, env, now))) return json({ error: 'unauthorized', msg: '要先登录' }, 401);
  const p = url.searchParams.get('path') || '';
  if (!p.startsWith('/') || p.length > 1024 || /[\x00-\x1f]/.test(p)) return json({ error: 'bad_path', msg: '路径不对' }, 400);
  const r = await call(env, url.origin, 'files', { path: p, stat: true }, ctx, now);
  if (!r.ok) return json(r, 503, r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : undefined);
  const d = r.data || {};
  if (d.error) return json({ error: d.error, msg: d.msg }, d.error === 'not_found' ? 404 : 403);
  if (d.dir) return json({ error: 'is_dir', msg: '这是文件夹，不能下载' }, 400);
  if (d.size > FILE_MAX) return json({ error: 'too_large', msg: '文件太大了（超过 100 MB）' }, 413);
  let f;
  try {
    const m = await machine(env, now);
    f = await fetch(API + `/v1/machines/${m.id}/files/content?path=` + encodeURIComponent(d.real), { headers: { 'X-API-Key': env.INSTABOX_API_KEY } });
  } catch (e) { return json(explain(e || {}), 502); }
  if (!f.ok) return json(explain(await ibErr(f)), 502);
  const name = d.path.split('/').pop() || 'file';
  // ?img=1：聊天里显示你发过的图片（只认 png / jpg / gif / webp，不认 svg），按图片类型、inline 回；别的一律当附件下载
  const img = url.searchParams.get('img') === '1' && IMG_TYPES[(name.split('.').pop() || '').toLowerCase()];
  const h = {
    'Content-Type': img || 'application/octet-stream',
    'Content-Disposition': `${img ? 'inline' : 'attachment'}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'none'; sandbox"
  };
  const len = f.headers.get('content-length'); if (len) h['Content-Length'] = len;
  return new Response(f.body, { status: 200, headers: h });
}

/* ---------- 给小芯发文件：网页把文件原样 POST 过来（?name=文件名），直接写进它电脑的 uploads/日期/ 下面 ----------
   和 /call 一样防跨站（本站页面、带 x-xin: 1）；要登录；最大 100 MB；文件名只留最后一段、去掉怪字符，前面加时间免得重名。
   返回在它电脑上的路径，发消息时带上（vm-agent 的 send 会再核对一遍在不在上传目录里）。 */
export function uploadName(raw) {
  let n = String(raw || '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f"<>|:*?]/g, '').replace(/^\.+/, '').trim();
  if (n.length > 80) { const i = n.lastIndexOf('.'), ext = i > 0 && n.length - i <= 10 ? n.slice(i) : ''; n = n.slice(0, 80 - ext.length) + ext; }
  return n || 'file';
}
async function upload(req, env, ctx, url, now) {
  const origin = req.headers.get('origin');
  if ((origin && origin !== url.origin) || req.headers.get('x-xin') !== '1') return json({ error: 'forbidden' }, 403);
  if (!enabled(env)) return json({ error: 'disabled' }, 404);
  if (!(await authed(req, env, now))) return json({ error: 'unauthorized', msg: '要先登录' }, 401);
  const len = Number(req.headers.get('content-length') || NaN);
  if (!(len >= 0)) return json({ error: 'length_required', msg: '缺文件大小' }, 411);
  if (len > UPLOAD_MAX) return json({ error: 'too_large', msg: '文件太大了（最大 100 MB）' }, 413);
  const name = uploadName(url.searchParams.get('name'));
  const bj = new Date(now + 8 * 3600e3).toISOString();   // 北京时间：日期做文件夹，时分秒做前缀
  const dest = `${UPLOAD_DIR}/${bj.slice(0, 10).replace(/-/g, '')}/${bj.slice(11, 19).replace(/:/g, '')}-${uuid().slice(0, 4)}-${name}`;
  let m;
  try { m = await machine(env, now); } catch (e) { return json(explain(e || {}), 502); }
  const body = req.body || new Uint8Array(0);
  const put = () => fetch(API + `/v1/machines/${m.id}/files?path=${encodeURIComponent(dest)}&parents=true`,
    { method: 'PUT', headers: { 'X-API-Key': env.INSTABOX_API_KEY, 'Content-Type': 'application/octet-stream', 'Content-Length': String(len) }, body, duplex: 'half' });
  let r;
  try { r = await put(); } catch (e) { return json({ ok: false, state: 'error', msg: '传不上去：' + String(e && e.message || e) }, 502); }
  if (!r.ok) {
    const e = await ibErr(r);
    if (e.code === 'machine_not_running') { const w = await wakeUp(env, m.id); if (!w || w.code === 'operation_conflict') return json({ ok: false, state: 'waking', msg: '唤醒中…', retryAfter: 3 }, 503); }
    return json(explain(e), e.status === 429 || e.status === 503 ? 503 : 502);
  }
  return json({ ok: true, data: { path: dest, name, size: len, image: !!IMG_TYPES[(name.split('.').pop() || '').toLowerCase()] } });
}

/* ---------- 路由 ---------- */
export async function handleXin(req, env, ctx, now = Date.now()) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/^\/api\/xin\/?/, '');
  if(p.startsWith('preview/')){
    if(req.method!=='GET')return json({error:'method'},405);
    if(!(await authed(req,env,now)))return json({error:'unauthorized',msg:'请先登录小芯聊天，再打开预览'},401);
    const match=/^preview\/([a-f0-9]{32})\/(index\.html|preview\.png)$/.exec(p);
    if(!match)return json({error:'bad_preview',msg:'预览地址不正确'},400);
    const r=await call(env,url.origin,'preview_asset',{id:match[1],file:match[2]},ctx,now);
    if(!r.ok)return json(r,503,r.retryAfter?{'Retry-After':String(r.retryAfter)}:undefined);
    const d=r.data||{};if(d.error)return json({error:d.error,msg:d.msg},d.error==='not_found'?404:400);
    const expected='/data/home/.xin/previews/'+match[1]+'/'+match[2];
    if(d.real!==expected||!Number.isInteger(d.size)||d.size<1||d.size>2*1024*1024||!/^[a-f0-9]{64}$/.test(d.sha256||''))return json({error:'bad_preview',msg:'预览记录不完整'},502);
    let asset;
    try{const m=await machine(env,now);asset=await fetch(API+'/v1/machines/'+m.id+'/files/content?path='+encodeURIComponent(d.real),{headers:{'X-API-Key':env.INSTABOX_API_KEY}});}
    catch(e){return json(explain(e||{}),502);}
    if(!asset.ok)return json({error:'preview_unavailable',msg:'预览暂时未能读取，请重试'},502);
    const bytes=await asset.arrayBuffer();if(bytes.byteLength!==d.size||hex(await crypto.subtle.digest('SHA-256',bytes))!==d.sha256)return json({error:'preview_changed',msg:'预览文件校验失败'},502);
    const download=url.searchParams.get('download')==='1',html=match[2]==='index.html';
    return new Response(bytes,{headers:{'Content-Type':download?'application/octet-stream':html?'text/html; charset=utf-8':'image/png','Content-Disposition':download?'attachment; filename="xiaoxin.html"':'inline','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer','Content-Security-Policy':WEB_PREVIEW_CSP}});
  }
  if (p === 'task-event' && req.method === 'POST') {
    if (!enabled(env) || !supervisor(env)) return json({ error: 'disabled' }, 404);
    const token = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!sameBytes(enc.encode(token), enc.encode(await callbackToken(env)))) return json({ error: 'unauthorized' }, 401);
    const text = await req.text(); if (text.length > 4096) return json({ error: 'too_large' }, 413);
    let state; try { state = JSON.parse(text); } catch { return json({ error: 'bad_json' }, 400); }
    if (!Number.isInteger(state.bg) || state.bg < 0 || state.bg > 100 || !Number.isSafeInteger(state.version) || state.version < 0) return json({ error: 'bad_state' }, 400);
    let m;
    try { m = await machine(env, now); } catch (e) { return json(explain(e || {}), 502); }
    await recordTasks(env, { bg: state.bg, version: state.version, machine: m.id, observedAt: now });
    return json({ ok: true });
  }
  if (p === 'me' && req.method === 'GET') return json({ enabled: enabled(env), authed: await authed(req, env, now) });
  if (p === 'file' && req.method === 'GET') return download(req, env, ctx, url, now);
  if ((p === 'backups' || p === 'backup') && req.method === 'GET') return backupDownload(req, env, url, now);
  if (p === 'upload' && req.method === 'POST') return upload(req, env, ctx, url, now);
  if (!['login', 'logout', 'call', 'backup'].includes(p)) return json({ error: 'not_found' }, 404);
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  // 防跨站：只认本站页面发来的 JSON 请求（cookie 本身也是 SameSite=Strict）
  const origin = req.headers.get('origin');
  if ((origin && origin !== url.origin) || req.headers.get('x-xin') !== '1' || !(req.headers.get('content-type') || '').includes('application/json')) return json({ error: 'forbidden' }, 403);
  if (!enabled(env)) return json({ error: 'disabled' }, 404);
  let body;
  try { const t = await req.text(); if (t.length > 65536) return json({ error: 'too_large' }, 413); body = t ? JSON.parse(t) : {}; } catch { return json({ error: 'bad_json' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'bad_json' }, 400);

  if (p === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) });
  if (p === 'login') {
    const ip = req.headers.get('cf-connecting-ip') || 'x';
    // 没有限流就不收密码：配置漏了绑定时宁可登不上，也不让人无限次猜（审查问题 17）
    if (!env.XIN_LOGIN_LIMIT || typeof env.XIN_LOGIN_LIMIT.limit !== 'function') return json({ error: 'no_rate_limit', msg: '登录限流没配好，暂时不能登录' }, 503);
    const { success } = await env.XIN_LOGIN_LIMIT.limit({ key: 'login:' + ip });
    if (!success) return json({ error: 'rate_limited', msg: '试太多次了，过一分钟再试' }, 429);
    if (!(await checkPassword(env, body.password))) return json({ error: 'wrong_password', msg: '密码不对' }, 401);
    return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(await makeCookie(env, now), SESSION_SEC) });
  }
  if (!(await authed(req, env, now))) return json({ error: 'unauthorized', msg: '要先登录' }, 401);
  // 现在备份：做今天的机外备份（已有就跳过）；正式站发布后的联调靠它当场验证整条备份链路
  if (p === 'backup') return json(await backupNow(env, ctx, now));
  const op = String(body.op || '');
  if (!OPS.has(op)) return json({ error: 'bad_op' }, 400);
  const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  return json(await call(env, url.origin, op, args, ctx, now));
}


/* ---------- 机外加密备份（设计见 docs/xin-reliability-usage-design.md 的 C 部分） ----------
   每天把云电脑打的状态包（vm-agent 的 backup_export：状态库快照 + 对话过程、消息、清单，tar.gz）取回来，加密后存进
   XinTaskSupervisor 的另一个实例 xin-backups（和任务租约的 xin-tasks 分开，不需要迁移），只留 30 天。
   密钥 = HKDF-SHA256（站长登录密码，每份随机盐，固定标签），AES-256-GCM、每份随机 IV；备份旁边不存密钥。
   参考 Grok Bot box-store-sync/（云电脑状态同步到云端存储，坏了能整体恢复）。
   免费版 Worker 每次调用 CPU 只有 10 ms：不压缩、密文全程按二进制传和存（0.6 MB 转一次 base64 就要 30 多 ms），
   Worker 里只做 sha256、HKDF、AES-GCM 这几样原生运算（合计几 ms）。 */
// 一份最大 5 MB（Durable Object 一个值连键最多 8 MB）。现在一份约 0.6 MB
const BACKUP_KEEP_DAYS = 30, BACKUP_MAX = 5 * 1024 * 1024, BACKUP_INFO = 'liming-xin-backup-v1';
function backupStore(env) { return env.XIN_TASK_SUPERVISOR?.get(env.XIN_TASK_SUPERVISOR.idFromName('xin-backups')); }
const bjDay = t => new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
const okDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
// 只给 16 字节的盐、12 字节的 IV 用（很短）；密文不经过它
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function backupKey(password, salt) {
  const ikm = await crypto.subtle.importKey('raw', enc.encode(password), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(BACKUP_INFO) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function backupCall(env, action, body) {
  const r = await backupStore(env).fetch('https://xin.internal/backup/' + action, { method: 'POST', body: JSON.stringify(body || {}) });
  return r.json();
}
// 一份备份的参数（解密要用的盐、IV 等，不含密文）放在 x-backup 头里，密文是请求 / 响应体本身
async function backupGet(env, date) {
  const r = await backupStore(env).fetch('https://xin.internal/backup/get', { method: 'POST', body: JSON.stringify({ date }) });
  if (!r.ok) return null;
  return { head: JSON.parse(r.headers.get('x-backup') || '{}'), data: new Uint8Array(await r.arrayBuffer()) };
}
export async function backupNow(env, ctx, now = Date.now()) {
  if (!enabled(env)) return { state: 'disabled' };
  if (!backupStore(env)) return { state: 'no_store' };
  const date = bjDay(now);
  if ((await backupCall(env, 'has', { date })).has) return { skipped: 'exists', date };
  const r = await call(env, CRON_ORIGIN, 'backup_export', {}, ctx, now);
  if (!r.ok) return { error: 'export_failed', state: r.state, msg: r.msg };
  const d = r.data || {};
  if (d.error || typeof d.file !== 'string' || !d.file.startsWith('/') || !Number.isInteger(d.size) || d.size < 1 || d.size > BACKUP_MAX || !/^[a-f0-9]{64}$/.test(d.sha256 || ''))
    return { error: 'bad_export', msg: d.msg || '导出记录不完整' };
  let f;
  try { const m = await machine(env, now); f = await fetch(API + '/v1/machines/' + m.id + '/files/content?path=' + encodeURIComponent(d.file), { headers: { 'X-API-Key': env.INSTABOX_API_KEY } }); }
  catch (e) { return { error: 'fetch_failed', msg: explain(e || {}).msg }; }
  if (!f.ok) return { error: 'fetch_failed', msg: explain(await ibErr(f)).msg };
  const bytes = new Uint8Array(await f.arrayBuffer());
  if (bytes.length !== d.size || hex(await crypto.subtle.digest('SHA-256', bytes)) !== d.sha256) return { error: 'mismatch', msg: '取回的文件和导出记录对不上' };
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await backupKey(env.OWNER_PASSWORD, salt), bytes));
  const meta = { v: 1, date, at: now, size: d.size, sha256: d.sha256 };
  const head = { ...meta, alg: 'AES-256-GCM', kdf: 'HKDF-SHA256', info: BACKUP_INFO, salt: b64(salt), iv: b64(iv) };
  const saved = await (await backupStore(env).fetch('https://xin.internal/backup/put', { method: 'POST', headers: { 'x-backup': JSON.stringify({ meta, head, keepDays: BACKUP_KEEP_DAYS }) }, body: data })).json();
  return saved.ok ? { ok: true, date, size: d.size, removed: saved.removed || 0 } : { error: 'store_failed', msg: saved.error };
}
// 取回（要先登录）：backups 列出；backup?date= 用现在的密码解密下载；改过密码解不开时 raw=1 下载加密原件
// （第一行是参数 JSON，换行后是密文），用 scripts/xin-backup-decrypt.mjs 和当时的密码离线解
async function backupDownload(req, env, url, now) {
  if (!enabled(env) || !backupStore(env)) return json({ error: 'disabled' }, 404);
  if (!(await authed(req, env, now))) return json({ error: 'unauthorized', msg: '要先登录' }, 401);
  if (url.pathname.endsWith('/backups')) return json(await backupCall(env, 'list'));
  const date = url.searchParams.get('date') || '';
  if (!okDay(date)) return json({ error: 'bad_date', msg: '日期不对' }, 400);
  const rec = await backupGet(env, date);
  if (!rec) return json({ error: 'not_found', msg: '没有这一天的备份' }, 404);
  const name = 'xin-state-' + date.replace(/-/g, '');
  const head = type => ({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  if (url.searchParams.get('raw') === '1') return new Response(new Blob([JSON.stringify(rec.head) + '\n', rec.data]), { headers: { ...head('application/octet-stream'), 'Content-Disposition': 'attachment; filename="' + name + '.backup"' } });
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.head.iv) }, await backupKey(env.OWNER_PASSWORD, unb64(rec.head.salt)), rec.data); }
  catch { return json({ error: 'old_password', msg: '这份备份是用以前的登录密码加密的：加上 &raw=1 下载加密原件，再用 scripts/xin-backup-decrypt.mjs 和当时的密码解开' }, 409); }
  return new Response(plain, { headers: { ...head('application/octet-stream'), 'Content-Disposition': 'attachment; filename="' + name + '.tar.gz"' } });
}

/* ---------- 定时任务（Cloudflare Cron，只在正式站配了） ----------
   北京时间 8:55 叫醒电脑：网关 9:00 自己签到要电脑醒着；
   北京时间 9:10、21:10 让小芯按每日任务清单做一遍（今天做成了 21:10 那次会跳过）。 */
export const CRON_WAKE = '55 0 * * *', CRON_DAILY = '10 1,13 * * *';
const CRON_ORIGIN = 'https://liming-work.com';   // 取 vm-agent.mjs 用（静态资源，和域名无关）
const pause = ms => new Promise(r => setTimeout(r, ms));
export async function runCron(cron, env, ctx, opt = {}) {
  if (!enabled(env)) return { ok: false, state: 'disabled' };
  const op = cron === CRON_WAKE ? 'wake' : 'daily';
  const wait = opt.wait || pause;
  let r = null;
  // 云电脑在睡觉 / 正在醒：等一会儿再试，最多等 3 分钟左右
  for (let i = 0; i < 12; i++) {
    r = await call(env, CRON_ORIGIN, op, {}, ctx, opt.now || Date.now());
    if (r.ok || (r.state !== 'waking' && r.state !== 'busy')) break;
    await wait(Math.min(30, Math.max(5, r.retryAfter || 5)) * 1000);
  }
  // 每日任务那两次顺手做机外备份（今天已有就跳过）；备份没成不影响每日任务的结果，下一次再来
  // （结果不挂在返回值上：每日任务的返回格式不变；做没做成看设置里「机外备份」那一行）
  if (op === 'daily' && r && r.ok) { try { await backupNow(env, ctx, opt.now || Date.now()); } catch { /* 下一次再来 */ } }
  return r;
}

// 测试用：清掉缓存
export function _reset() { keyCache = null; machineCache = null; agentCache = null; verifiedAt = 0; }
export const _callbackToken = env => callbackToken(env);   // 测试用：任务回调的令牌

// Durable alarms keep running after a browser closes or the VM restarts. No alarms remain when idle.
export class XinTaskSupervisor {
  constructor(state, env) { this.state = state; this.env = env; }
  async releaseLease(current) {
    const response = current.machine && await ib(this.env, `/v1/machines/${current.machine}/activity-leases/xin-tasks`, { method: 'DELETE' }).catch(() => null);
    const latest = await this.state.storage.get('tasks') || current;
    if (latest.bg > 0) return; // a task may have started while the network request was in flight
    latest.leaseCleanup = !!current.machine && (!response || !response.ok && response.status !== 404);
    await this.state.storage.put('tasks', latest);
    if (latest.leaseCleanup) await this.state.storage.setAlarm(Date.now() + 60000);
    else await this.state.storage.deleteAlarm();
  }
  // 机外备份另用一个实例（xin-backups）：摘要 backup-meta:日期（列表只读它）、参数加二进制密文 backup:日期；存新的时删 keepDays 天前的
  async backup(action, req) {
    const s = this.state.storage;
    if (action === 'put') {
      let a; try { a = JSON.parse(req.headers.get('x-backup') || ''); } catch { a = {}; }
      const meta = a.meta || {}, head = a.head || {}, data = new Uint8Array(await req.arrayBuffer());
      if (!okDay(meta.date) || head.date !== meta.date || !data.length) return json({ error: 'bad_backup' });
      await s.put('backup:' + meta.date, { ...head, data }); await s.put('backup-meta:' + meta.date, meta);
      const cutoff = new Date(Date.parse(meta.date + 'T00:00:00Z') - (Number(a.keepDays) || BACKUP_KEEP_DAYS) * 86400e3).toISOString().slice(0, 10);
      const old = [...(await s.list({ prefix: 'backup-meta:' })).keys()].map(k => k.slice('backup-meta:'.length)).filter(d => d < cutoff);
      if (old.length) await s.delete(old.flatMap(d => ['backup:' + d, 'backup-meta:' + d]));
      return json({ ok: true, removed: old.length });
    }
    const a = await req.json().catch(() => ({}));
    if (action === 'has') return json({ has: okDay(a.date) && !!(await s.get('backup-meta:' + a.date)) });
    if (action === 'list') return json({ backups: [...(await s.list({ prefix: 'backup-meta:' })).values()].sort((x, y) => y.date.localeCompare(x.date)) });
    if (action === 'get') {
      const rec = okDay(a.date) && await s.get('backup:' + a.date);
      if (!rec || !(rec.data instanceof Uint8Array || rec.data instanceof ArrayBuffer)) return json({ error: 'not_found' }, 404);
      const { data, ...head } = rec;
      return new Response(data, { headers: { 'x-backup': JSON.stringify(head) } });
    }
    return json({ error: 'bad_action' }, 400);
  }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/backup/')) return this.backup(path.slice('/backup/'.length), req);
    const incoming = await req.json(), current = await this.state.storage.get('tasks') || {};
    if (incoming.version != null && current.version != null && (incoming.version < current.version || incoming.version === current.version && incoming.bg !== current.bg)) return json({ ok: true, stale: true });
    // A browser's old read cannot cancel a newer controller callback.
    if (incoming.version == null && current.observedAt > incoming.observedAt) return json({ ok: true, stale: true });
    const next = { ...current, ...incoming };
    await this.state.storage.put('tasks', next);
    if(next.bg>0){const alarm=await this.state.storage.getAlarm?.();if(!alarm||alarm>Date.now()+60000)await this.state.storage.setAlarm(Date.now()+60000);}
    else {
      await this.releaseLease(next);
    }
    return json({ ok: true });
  }
  async alarm() {
    const current = await this.state.storage.get('tasks');
    if (!current) return;
    if (current.bg <= 0) { if (current.leaseCleanup) await this.releaseLease(current); return; }
    let delay = 60000;
    try {
      const status = await ib(this.env, '/v1/machines/' + current.machine);
      if (!status.ok) throw await ibErr(status);
      const m = await status.json();
      if (m.cooldownUntil && Date.parse(m.cooldownUntil) > Date.now()) delay = Math.max(60000, Date.parse(m.cooldownUntil) - Date.now() + 5000);
      else {
        const response = await call({ ...this.env, XIN_TASK_SUPERVISOR: undefined, XIN_TASK_LEASE_MANAGED:true }, CRON_ORIGIN, 'tasks', { _watchdog: true }, { waitUntil: p => this.state.waitUntil(p) }, Date.now());
        if (response.ok) {
          const bg = response.data.bg || 0;
          const latest = await this.state.storage.get('tasks') || current;
          const next = response.data.version != null && latest.version > response.data.version ? latest : { ...latest, bg, version: response.data.version ?? latest.version, observedAt: Date.now() };
          await this.state.storage.put('tasks', next);
          if (next.bg === 0) { await this.releaseLease(next); return; }
          const lease = await ib(this.env, `/v1/machines/${current.machine}/activity-leases/xin-tasks`, { method: 'PUT', body: JSON.stringify({ ttlSeconds: 3600 }) });
          if (!lease.ok) throw await ibErr(lease);
          const afterLease=await this.state.storage.get('tasks');if(afterLease?.bg===0)await this.releaseLease(afterLease);
        }
      }
    } finally {
      const latest = await this.state.storage.get('tasks');
      if (latest?.bg > 0) await this.state.storage.setAlarm(Date.now() + delay);
    }
  }
}
