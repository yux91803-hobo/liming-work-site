// hub.js — LIMING AI 协作中心 · Worker 只读 API（ESM，零依赖，只用 Web Crypto）
// 由现有 worker 在 url.pathname 以 /api/hub/ 开头时调用：return handleHub(request, env, deps)
import { handleQuota } from './quota-api.mjs';

const COOKIE = 'lm_hub';
const MAX_AGE = 15552000;                       // 180 天（秒）
const FEED_LIMIT = 200;                         // 不指定批次时：全部批次最新 200 条
const BATCH_FEED_LIMIT = 2000;                  // 指定批次时：该批次全部消息（上限 2000）
const enc = new TextEncoder();

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex',
};

function respond(request, status, data, extra = {}) {
  const headers = new Headers(BASE_HEADERS);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  const noBody = status === 204 || request.method === 'HEAD';
  return new Response(noBody ? null : JSON.stringify(data ?? null), { status, headers });
}
const err = (request, status, msg, extra) => respond(request, status, { error: msg }, extra);

/* ---------------- 加密工具 ---------------- */

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a, b) {
  // 常量时间比较：遍历长度只取决于 a，不因首个不同字节提前退出；长度差异并入 diff
  const x = a instanceof Uint8Array ? a : enc.encode(String(a));
  const y = b instanceof Uint8Array ? b : enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ (y[i] ?? 0);
  return diff === 0;
}

async function makeToken(key, exp) {
  return `${exp}.${b64url(await hmac(key, 'hub:' + exp))}`;
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function isAuthed(request, env) {
  if (!env.HUB_KEY) return false;
  const tok = readCookie(request, COOKIE);
  if (!tok) return false;
  const dot = tok.indexOf('.');
  if (dot < 1) return false;
  const exp = tok.slice(0, dot);
  if (!/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) <= Math.floor(Date.now() / 1000)) return false;   // 过期
  const expected = await makeToken(env.HUB_KEY, exp);
  return timingSafeEqual(tok, expected);
}

const cookieAttrs = (maxAge) => `Path=/api/hub; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/* ---------------- D1 ---------------- */

async function all(env, sql, params = []) {
  const res = await env.DB.prepare(sql).bind(...params).all();
  return (res && res.results) || [];
}

function parseDeps(v) {
  if (v === null || v === undefined || v === '') return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
}

// since 统一成 UTC ISO（毫秒为 0 时省略），SQL 里再用 julianday() 比较，不受时区写法/毫秒有无影响
function normSince(v) {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace('.000Z', 'Z');
}

const param = (url, name) => {
  const v = url.searchParams.get(name);
  return v === null || v.trim() === '' ? null : v;
};

/* ---------------- 路由 ---------------- */

const ROUTES = {
  '/api/hub/login': 'POST',
  '/api/hub/logout': 'POST',
  '/api/hub/me': 'GET',
  '/api/hub/batches': 'GET',
  '/api/hub/tasks': 'GET',
  '/api/hub/messages': 'GET',
  '/api/hub/feed': 'GET',
  '/api/hub/quota': 'GET',                       // [HUB-Q1] Hark 额度
};

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin || origin === 'null') return false;
  try { const o = new URL(origin); return o.host === url.host && o.protocol === url.protocol; }
  catch { return false; }
}

export async function handleHub(request, env = {}, deps = {}) {
  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (!['GET', 'HEAD', 'POST'].includes(method)) return err(request, 405, 'method not allowed', { Allow: 'GET, HEAD, POST' });
    if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request, url)) return err(request, 403, 'cross-origin request');

    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const want = ROUTES[path];
    if (!want) return err(request, 404, 'not found');
    const ok = want === 'POST' ? method === 'POST' : method === 'GET' || method === 'HEAD';
    if (!ok) return err(request, 405, 'method not allowed', { Allow: want === 'POST' ? 'POST' : 'GET, HEAD' });

    if (path === '/api/hub/login') return await login(request, env, deps);
    if (path === '/api/hub/logout') return respond(request, 204, null, { 'Set-Cookie': `${COOKIE}=; ${cookieAttrs(0)}` });

    const authed = await isAuthed(request, env);
    if (path === '/api/hub/me') return respond(request, 200, { authed });
    if (!authed) return err(request, 401, 'unauthorized');

    if (path === '/api/hub/batches') {
      const rows = await all(env, 'SELECT batch, phase, started_at, synced_at FROM batches ORDER BY started_at DESC, batch ASC');
      const counts = await all(env, 'SELECT batch, status, COUNT(*) AS n FROM tasks GROUP BY batch, status');
      const map = new Map();
      for (const c of counts) {
        const m = map.get(c.batch) || {};
        m[c.status ?? 'unknown'] = Number(c.n);
        map.set(c.batch, m);
      }
      return respond(request, 200, rows.map((r) => ({
        batch: r.batch, phase: r.phase ?? null, started_at: r.started_at ?? null, synced_at: r.synced_at ?? null,
        counts: map.get(r.batch) || {},
      })));
    }

    if (path === '/api/hub/tasks') {
      const batch = param(url, 'batch');
      if (!batch) return err(request, 400, 'missing batch');
      const rows = await all(env,
        'SELECT batch, task_id, title, owner, status, depends_on, retries, max_retries, dispatched_at, last_check, updated_at FROM tasks WHERE batch = ?1 ORDER BY task_id ASC',
        [batch]);
      return respond(request, 200, rows.map((r) => ({
        batch: r.batch, task_id: r.task_id, title: r.title ?? null, owner: r.owner ?? null, status: r.status ?? null,
        depends_on: parseDeps(r.depends_on), retries: r.retries ?? null, max_retries: r.max_retries ?? null,
        dispatched_at: r.dispatched_at ?? null, last_check: r.last_check ?? null, updated_at: r.updated_at ?? null,
      })));
    }

    if (path === '/api/hub/messages') {
      const batch = param(url, 'batch'), task = param(url, 'task');
      if (!batch || !task) return err(request, 400, 'missing batch or task');
      const rows = await all(env,
        'SELECT id, sender, kind, body, ts FROM messages WHERE batch = ?1 AND task_id = ?2 ORDER BY ts ASC, id ASC',
        [batch, task]);
      return respond(request, 200, rows.map((r) => ({ id: r.id, sender: r.sender ?? null, kind: r.kind ?? null, body: r.body ?? null, ts: r.ts ?? null })));
    }

    if (path === '/api/hub/feed') {
      const rawSince = param(url, 'since');
      const since = rawSince === null ? null : normSince(rawSince);
      if (rawSince !== null && since === null) return err(request, 400, 'invalid since');
      const batch = param(url, 'batch');
      const rows = batch === null
        ? await all(env,
          'SELECT id, batch, task_id, sender, kind, body, ts FROM messages WHERE (?1 IS NULL OR julianday(ts) > julianday(?1)) ORDER BY julianday(ts) DESC, id DESC LIMIT ?2',
          [since, FEED_LIMIT])
        : await all(env,
          'SELECT id, batch, task_id, sender, kind, body, ts FROM messages WHERE batch = ?1 AND (?2 IS NULL OR julianday(ts) > julianday(?2)) ORDER BY julianday(ts) DESC, id DESC LIMIT ?3',
          [batch, since, BATCH_FEED_LIMIT]);
      return respond(request, 200, rows.map((r) => ({
        id: r.id, batch: r.batch, task_id: r.task_id, sender: r.sender ?? null, kind: r.kind ?? null, body: r.body ?? null, ts: r.ts ?? null,
      })));
    }

    if (path === '/api/hub/quota') {
      // [HUB-Q1] 查询交给 handleQuota；它的响应体重新用 respond() 包一层，统一鉴权后的安全头 / HEAD 处理
      const r = await handleQuota(env);
      if (r.status !== 200) return err(request, 500, 'internal error');
      return respond(request, 200, await r.json());
    }

    return err(request, 404, 'not found');
  } catch {
    return err(request, 500, 'internal error');      // 不向客户端暴露内部细节
  }
}

async function login(request, env, deps) {
  if (!env.HUB_PASSWORD || !env.HUB_KEY) return err(request, 503, 'hub not configured');
  const limiter = deps && deps.limiter;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (limiter && await limiter.check(ip)) return err(request, 429, 'too many attempts');

  let body;
  try { body = await request.json(); } catch { return err(request, 400, 'invalid json'); }
  const pw = body && typeof body.password === 'string' ? body.password : null;
  if (pw === null || pw === '') return err(request, 400, 'missing password');

  const [given, expected] = await Promise.all([hmac(env.HUB_KEY, 'pw:' + pw), hmac(env.HUB_KEY, 'pw:' + env.HUB_PASSWORD)]);
  if (!timingSafeEqual(given, expected)) {
    if (limiter) await limiter.fail(ip);
    return err(request, 401, 'wrong password');
  }
  if (limiter) await limiter.ok(ip);
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const token = await makeToken(env.HUB_KEY, exp);
  return respond(request, 204, null, { 'Set-Cookie': `${COOKIE}=${token}; ${cookieAttrs(MAX_AGE)}` });
}
