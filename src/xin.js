// 小芯聊天：网站 ⇄ InstaBox 云电脑里的 AI（Claude Code / Codex）
//
// 只给站长自己用：要先用密码登录（OWNER_PASSWORD），登录后发一个签过名的 cookie，30 天有效；改密码以后旧 cookie 全部失效。
// 没配 OWNER_PASSWORD（至少 12 位）和 INSTABOX_API_KEY 时整个功能关着（测试站就是这样）。
//
// 接口：
//   GET  /api/xin/me       {enabled, authed}
//   POST /api/xin/login    {password}
//   POST /api/xin/logout
//   POST /api/xin/call     {op, args}   op = status | wake | ping | send | poll | stop | sessions | history | memory | memory_set（小芯的记事本）
//                                       | greet | daily | daily_get | daily_set | rename | forget（对话改名 / 删除）| files（小芯的文件：列文件夹、预览）
//   GET  /api/xin/file?path=/data/workspace/…   下载小芯电脑里的一个文件（先让 vm-agent 核对在工作目录里，再从 InstaBox 原样转过来）
// status、wake 直接调 InstaBox 的机器接口（wake：打开网页时把睡着的云电脑叫醒，已经醒着就什么都不做）；其余都转成 InstaBox exec：node <vm-agent.mjs> <op>，参数从 stdin 传进去（见 site/xin/vm-agent.mjs）。
// 返回 {ok:true, data} 或 {ok:false, state, msg, retryAfter}：state = waking（正在唤醒云电脑）、cooldown（跑满 8 小时后的冷却）、busy、error。
const API = 'https://api.instabox.sh';
const COOKIE = '__Host-xin';
const SESSION_SEC = 30 * 86400;
const AGENT_ASSET = '/xin/vm-agent.mjs';
const VM_DIR = '/data/home/.xin/agent';
const OPS = new Set(['status', 'wake', 'ping', 'send', 'poll', 'stop', 'sessions', 'history', 'memory', 'memory_set', 'greet', 'daily', 'daily_get', 'daily_set', 'rename', 'forget', 'files']);
const FILE_MAX = 64 * 1024 * 1024;   // 下载最大 64 MB（.hex、.bin 才几十 KB）
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
async function agentScript(env, origin) {
  if (agentCache) return agentCache;
  const r = await env.ASSETS.fetch(new Request(origin + AGENT_ASSET));
  if (!r.ok) throw { status: 500, code: 'no_agent', msg: '网站里缺 vm-agent.mjs' };
  const text = await r.text();
  const h = hex(await crypto.subtle.digest('SHA-256', enc.encode(text))).slice(0, 12);
  agentCache = { text, path: `${VM_DIR}/vm-agent-${h}.mjs` };
  return agentCache;
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
  if (c === 'machine_not_running' || c === 'operation_conflict' || c === 'host_unavailable') return { ok: false, state: 'waking', msg: '正在唤醒云电脑…', retryAfter: 3 };
  if (c === 'machine_cooldown') return { ok: false, state: 'cooldown', msg: '云电脑连续跑满了时长，正在冷却', retryAfter: e.retryAfter || 60 };
  if (e.status === 429 || e.status === 503) return { ok: false, state: 'busy', msg: 'InstaBox 忙，稍等', retryAfter: e.retryAfter || 5 };
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
      const u = await ib(env, `/v1/machines/${id}/files?path=${encodeURIComponent(agent.path)}&parents=true&mode=0755`, { method: 'PUT', body: agent.text, headers: { 'Content-Type': 'application/octet-stream' } });
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
  if (op === 'status') {
    const r = await ib(env, '/v1/machines/' + m.id);
    if (!r.ok) return explain(await ibErr(r));
    const d = await r.json();
    return { ok: true, data: { name: d.name, state: d.state, cooldownUntil: d.cooldownUntil || null } };
  }
  try {
    const data = await exec(env, origin, m.id, op, args);
    // AI 在等模型回话时云电脑看起来是闲着的：挂一个「有活在干」的租约，别让它半路自己暂停
    const lease = (method, run) => ib(env, `/v1/machines/${m.id}/activity-leases/xin-${run}`, method === 'PUT' ? { method, body: JSON.stringify({ ttlSeconds: 1800 }) } : { method }).catch(() => null);
    if ((op === 'send' || op === 'daily') && data && data.run && ctx) ctx.waitUntil(lease('PUT', data.run));
    if (op === 'poll' && data && data.done && args && args.run && ctx) ctx.waitUntil(lease('DELETE', args.run));
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
  if (d.size > FILE_MAX) return json({ error: 'too_large', msg: '文件太大了（超过 64 MB）' }, 413);
  let f;
  try {
    const m = await machine(env, now);
    f = await fetch(API + `/v1/machines/${m.id}/files/content?path=` + encodeURIComponent(d.real), { headers: { 'X-API-Key': env.INSTABOX_API_KEY } });
  } catch (e) { return json(explain(e || {}), 502); }
  if (!f.ok) return json(explain(await ibErr(f)), 502);
  const name = d.path.split('/').pop() || 'file';
  const h = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'none'; sandbox"
  };
  const len = f.headers.get('content-length'); if (len) h['Content-Length'] = len;
  return new Response(f.body, { status: 200, headers: h });
}

/* ---------- 路由 ---------- */
export async function handleXin(req, env, ctx, now = Date.now()) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/^\/api\/xin\/?/, '');
  if (p === 'me' && req.method === 'GET') return json({ enabled: enabled(env), authed: await authed(req, env, now) });
  if (p === 'file' && req.method === 'GET') return download(req, env, ctx, url, now);
  if (!['login', 'logout', 'call'].includes(p)) return json({ error: 'not_found' }, 404);
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
    if (env.XIN_LOGIN_LIMIT && typeof env.XIN_LOGIN_LIMIT.limit === 'function') {
      const { success } = await env.XIN_LOGIN_LIMIT.limit({ key: 'login:' + ip });
      if (!success) return json({ error: 'rate_limited', msg: '试太多次了，过一分钟再试' }, 429);
    }
    if (!(await checkPassword(env, body.password))) return json({ error: 'wrong_password', msg: '密码不对' }, 401);
    return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(await makeCookie(env, now), SESSION_SEC) });
  }
  if (!(await authed(req, env, now))) return json({ error: 'unauthorized', msg: '要先登录' }, 401);
  const op = String(body.op || '');
  if (!OPS.has(op)) return json({ error: 'bad_op' }, 400);
  const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  return json(await call(env, url.origin, op, args, ctx, now));
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
    r = await call(env, CRON_ORIGIN, op, {}, ctx, Date.now());
    if (r.ok || (r.state !== 'waking' && r.state !== 'busy')) return r;
    await wait(Math.min(30, Math.max(5, r.retryAfter || 5)) * 1000);
  }
  return r;
}

// 测试用：清掉缓存
export function _reset() { keyCache = null; machineCache = null; agentCache = null; }
