// Liming 工具箱 Worker：/api/* 走这里，其余交给静态资源（SPA 回退）。
// 互传存储：SQLite 版 Durable Object（免费套餐可用），文件按 1.5 MiB 一行存入 SQLite，每次上传请求 9 MiB = 6 行。
import { DurableObject } from 'cloudflare:workers';

export const LIMITS = {
  fileMax: 4 * 1024 ** 3,         // 单文件 4 GB（= 总空间）
  spaceMax: 4 * 1024 ** 3,        // 总空间 4 GB（免费套餐 SQLite DO 共 5 GB，留 ~1 GB 余量）
  textMax: 100 * 1024,            // 单条文字 100 KB
  thumbMax: 96 * 1024,            // 预览图 dataURL
  row: 1536 * 1024,               // 每行 1.5 MiB（SQLite 单值上限 2 MB）；4 GB ≈ 2 731 行
  chunk: 6 * 1536 * 1024,         // 每次上传请求 9 MiB = 6 行（Worker 请求体上限 100 MB）
  stale: 2 * 3600 * 1000,         // 未完成的上传 2 小时无进展即清理
  ttl: 24 * 3600 * 1000,          // 24 小时后自动删除
  maxItems: 500,
};
const COOKIE = 'lm_tx';
const SESSION_DAYS = 180;
const SESSION_RENEW_DAYS = 30;    // 剩余不足 30 天时，/me 自动续签（滑动过期）
const PURGE_BATCH = 60;           // 每批删除的数据行数（≈ 90 MB），避免一次删 4 GB 超出 CPU 时间

const SEC_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' };
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS, ...extra } });
const err = (status, code) => json({ error: code }, status);

/* ---------- 签名会话（HMAC-SHA256） ---------- */
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const v = env.TRANSFER_PW_VERSION || '1';           // 改密码时 +1 可让旧设备全部失效
  const body = `${exp}.${v}`;
  return `${body}.${await hmac(env.TRANSFER_KEY, body)}`;
}
function readCookie(req) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}
async function checkSession(req, env) {
  if (!env.TRANSFER_KEY) return false;
  const c = readCookie(req);
  if (!c) return false;
  const [exp, v, sig] = c.split('.');
  if (!sig || +exp < Date.now() || v !== (env.TRANSFER_PW_VERSION || '1')) return false;
  return safeEq(sig, await hmac(env.TRANSFER_KEY, `${exp}.${v}`));
}
// 只读取过期时间（调用前必须已经 checkSession 通过）
function sessionExp(req) { const c = readCookie(req); return c ? +c.split('.')[0] || 0 : 0; }
// SameSite=Lax：同源 fetch/WS 照常携带；从其他 App 点链接打开时也更稳。非 GET 请求另有 Origin 校验。
const cookie = (val, maxAge) => `${COOKIE}=${val}; Path=/api/transfer; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

/* ---------- 入口 ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try { return await api(req, env, url); }
    catch (e) { return err(500, 'server'); }            // 不记录请求内容
  },
};

async function api(req, env, url) {
  const p = url.pathname.replace(/\/+$/, '');
  if (!p.startsWith('/api/transfer')) return err(404, 'not_found');
  const sub = p.slice('/api/transfer'.length) || '/';
  // 同源校验（非 GET 请求）
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const o = req.headers.get('Origin');
    if (o && o !== url.origin) return err(403, 'origin');
  }
  const ip = req.headers.get('CF-Connecting-IP') || '0';

  if (sub === '/login' && req.method === 'POST') {
    if (!env.TRANSFER_PASSWORD || !env.TRANSFER_KEY) return err(503, 'not_configured');
    const lim = env.LIMITER.get(env.LIMITER.idFromName('login:' + ip));
    const st = await (await lim.fetch('https://l/check')).json();
    if (!st.ok) return json({ error: 'rate_limited', retry: st.retry }, 429);
    let pw = '';
    try { pw = String((await req.json()).password || ''); } catch {}
    const ok = safeEq(await hmac(env.TRANSFER_KEY, 'pw:' + pw), await hmac(env.TRANSFER_KEY, 'pw:' + env.TRANSFER_PASSWORD));
    if (!ok) { await lim.fetch('https://l/fail'); await new Promise(r => setTimeout(r, 400)); return err(401, 'bad_password'); }
    await lim.fetch('https://l/reset');
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(await makeSession(env), SESSION_DAYS * 86400) });
  }
  if (sub === '/logout' && req.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  if (sub === '/me') {
    const authed = await checkSession(req, env);
    const extra = {};
    if (authed && sessionExp(req) - Date.now() < SESSION_RENEW_DAYS * 864e5) extra['Set-Cookie'] = cookie(await makeSession(env), SESSION_DAYS * 86400);
    return json({ authed, configured: !!(env.TRANSFER_PASSWORD && env.TRANSFER_KEY), limits: LIMITS, now: Date.now() }, 200, extra);
  }

  if (!(await checkSession(req, env))) return err(401, 'auth');
  const space = env.SPACE.get(env.SPACE.idFromName('main'));
  return space.fetch(new Request('https://space' + sub + url.search, req));
}

/* ---------- 登录限流：每 IP 15 分钟内最多 8 次失败 ---------- */
export class Limiter extends DurableObject {
  async fetch(req) {
    const path = new URL(req.url).pathname, now = Date.now(), WIN = 15 * 60e3, MAX = 8;
    let s = (await this.ctx.storage.get('s')) || { n: 0, t: now };
    if (now - s.t > WIN) s = { n: 0, t: now };
    if (path === '/check') return Response.json(s.n >= MAX ? { ok: false, retry: Math.ceil((s.t + WIN - now) / 1000) } : { ok: true });
    if (path === '/fail') { s.n++; await this.ctx.storage.put('s', s); await this.ctx.storage.setAlarm(now + WIN + 1000); }
    if (path === '/reset') await this.ctx.storage.deleteAll();
    return Response.json({ ok: true });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

/* ---------- 共享空间 ---------- */
const rid = () => b64u(crypto.getRandomValues(new Uint8Array(12)));
const cleanName = (s) => String(s || 'file').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').slice(0, 180) || 'file';
// RFC 5987：encodeURIComponent 不编码 ' ( ) *，这里补上
const rfc5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const asciiName = (s) => (s.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'file');

// 把请求体按「行」大小直接读进独立的 ArrayBuffer：只拷贝一次，不再整块读入后再 slice（峰值内存减半）
async function readRows(req, want, RW) {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const rows = []; let cur = null, pos = 0, total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const v = value instanceof Uint8Array ? value : new Uint8Array(value);
    let off = 0;
    while (off < v.byteLength) {
      if (total >= want) { try { await reader.cancel(); } catch {} return null; }   // 超长
      if (!cur) { cur = new Uint8Array(Math.min(RW, want - total)); pos = 0; }
      const take = Math.min(cur.length - pos, v.byteLength - off);
      cur.set(v.subarray(off, off + take), pos); pos += take; off += take; total += take;
      if (pos === cur.length) { rows.push(cur.buffer); cur = null; }
    }
  }
  return total === want && !cur ? rows : null;
}

export class Space extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ttl = +env.TRANSFER_TTL_MS || LIMITS.ttl;   // 仅本地测试可缩短
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, kind TEXT, text TEXT, name TEXT, mime TEXT, size INTEGER,
      chunks INTEGER, got INTEGER DEFAULT 0, done INTEGER DEFAULT 0, thumb TEXT, dev TEXT, created INTEGER, expires INTEGER, updated INTEGER)`);
    try { this.sql.exec('ALTER TABLE items ADD COLUMN updated INTEGER'); } catch {}
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chunks(item TEXT, idx INTEGER, data BLOB, PRIMARY KEY(item, idx))`);
    // 心跳由运行时自动回复，不唤醒休眠中的 DO（不产生计费时长）
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', '{"type":"pong"}')); } catch {}
  }
  row(id) { return this.sql.exec('SELECT * FROM items WHERE id=?', id).toArray()[0]; }
  pub(r) { return { id: r.id, kind: r.kind, text: r.text, name: r.name, mime: r.mime, size: r.size, done: !!r.done, got: r.got, chunks: r.chunks, thumb: r.thumb, dev: r.dev, created: r.created, expires: r.expires, updated: r.updated || r.created }; }
  used() { return this.sql.exec("SELECT COALESCE(SUM(size),0) AS s FROM items WHERE kind='file'").one().s; }
  list() { this.sweep(); return this.sql.exec('SELECT * FROM items ORDER BY created DESC').toArray().map(r => this.pub(r)); }
  broadcast(msg) { const s = JSON.stringify(msg); for (const ws of this.ctx.getWebSockets()) try { ws.send(s); } catch {} }
  hasOrphans() { return this.sql.exec('SELECT 1 AS x FROM chunks c LEFT JOIN items i ON i.id=c.item WHERE i.id IS NULL LIMIT 1').toArray().length > 0; }
  // 分批删除已无主的数据行；剩余的由 alarm 继续删
  purge(limit = PURGE_BATCH) {
    this.sql.exec('DELETE FROM chunks WHERE rowid IN (SELECT c.rowid FROM chunks c LEFT JOIN items i ON i.id=c.item WHERE i.id IS NULL LIMIT ?)', limit);
  }
  async schedule() {
    if (this.hasOrphans()) { await this.ctx.storage.setAlarm(Date.now() + 200); return; }
    const a = this.sql.exec('SELECT MIN(expires) AS e FROM items WHERE expires IS NOT NULL').one().e;
    const b = this.sql.exec("SELECT MIN(COALESCE(updated,created)) AS u FROM items WHERE done=0 AND kind='file'").one().u;
    const n = Math.min(a || Infinity, b ? b + LIMITS.stale : Infinity); if (n === Infinity) { await this.ctx.storage.deleteAlarm(); return; }
    if (n) await this.ctx.storage.setAlarm(n + 1000); else await this.ctx.storage.deleteAlarm();
  }
  // 先删条目（立即对所有人消失），数据行先删一小批，其余交给 alarm
  del(id) { this.sql.exec('DELETE FROM items WHERE id=?', id); this.purge(20); }
  sweep() {
    const now = Date.now();
    const gone = this.sql.exec('SELECT id FROM items WHERE expires<=? OR (done=0 AND kind=\'file\' AND COALESCE(updated,created)<?)', now, now - LIMITS.stale).toArray().map(r => r.id);
    gone.forEach(id => this.del(id));
    if (gone.length) this.broadcast({ type: 'removed', ids: gone });
    return gone;
  }
  async alarm() { this.sweep(); this.purge(); await this.schedule(); }

  async fetch(req) {
    const url = new URL(req.url), p = url.pathname, m = req.method;
    let dev = ''; try { dev = decodeURIComponent(req.headers.get('X-Device') || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 24); } catch {}
    let mt;
    if (p === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return err(426, 'upgrade');
      const [c, s] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(s);
      setTimeout(() => this.broadcast({ type: 'peers', n: this.ctx.getWebSockets().length }), 0);
      return new Response(null, { status: 101, webSocket: c });
    }
    if (p === '/items' && m === 'GET') return json({ items: this.list(), used: this.used(), limits: LIMITS, now: Date.now(), peers: this.ctx.getWebSockets().length });
    if (p === '/items' && m === 'DELETE') {
      this.sql.exec('DELETE FROM items'); this.purge(20); await this.schedule();
      this.broadcast({ type: 'cleared' }); return json({ ok: true });
    }
    if (p === '/items/text' && m === 'POST') {
      const b = await req.json().catch(() => ({}));
      const text = String(b.text || '');
      if (!text.trim()) return err(400, 'empty');
      if (enc.encode(text).length > LIMITS.textMax) return err(413, 'text_too_large');
      if (this.count() >= LIMITS.maxItems) return err(409, 'too_many');
      const now = Date.now(), id = rid();
      this.sql.exec('INSERT INTO items(id,kind,text,size,chunks,got,done,dev,created,expires,updated) VALUES(?,?,?,?,0,0,1,?,?,?,?)', id, 'text', text, enc.encode(text).length, dev, now, now + this.ttl, now);
      await this.schedule();
      const it = this.pub(this.row(id)); this.broadcast({ type: 'item', item: it }); return json({ item: it });
    }
    if (p === '/items/file' && m === 'POST') {
      const b = await req.json().catch(() => ({}));
      const size = Math.floor(+b.size || 0);
      if (size <= 0) return err(400, 'empty');
      if (size > LIMITS.fileMax) return err(413, 'file_too_large');
      this.sweep();
      if (this.used() + size > LIMITS.spaceMax) return err(507, 'space_full');
      if (this.count() >= LIMITS.maxItems) return err(409, 'too_many');
      let thumb = typeof b.thumb === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.thumb) && b.thumb.length <= LIMITS.thumbMax ? b.thumb : null;
      const mime = /^[\w.+-]+\/[\w.+-]+$/.test(b.mime || '') ? b.mime : 'application/octet-stream';
      const now = Date.now(), id = rid(), chunks = Math.ceil(size / LIMITS.chunk);
      this.sql.exec('INSERT INTO items(id,kind,name,mime,size,chunks,thumb,dev,created,expires,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, 'file', cleanName(b.name), mime, size, chunks, thumb, dev, now, now + this.ttl, now);
      await this.schedule();
      const it = this.pub(this.row(id)); this.broadcast({ type: 'item', item: it });
      return json({ item: it, chunk: LIMITS.chunk });
    }
    // 续传：返回还缺哪些分块（got 只是计数，不知道缺的是哪几块）
    if ((mt = p.match(/^\/items\/([\w-]{8,32})\/missing$/)) && m === 'GET') {
      const r = this.row(mt[1]);
      if (!r || r.kind !== 'file') return err(404, 'not_found');
      const per = LIMITS.chunk / LIMITS.row;
      const have = new Set(this.sql.exec('SELECT idx FROM chunks WHERE item=? AND idx % ? = 0', r.id, per).toArray().map(x => x.idx / per));
      const missing = []; for (let i = 0; i < r.chunks; i++) if (!have.has(i)) missing.push(i);
      return json({ item: this.pub(r), missing, chunk: LIMITS.chunk });
    }
    if ((mt = p.match(/^\/items\/([\w-]{8,32})\/chunk\/(\d+)$/)) && m === 'PUT') {
      const r = this.row(mt[1]); const idx = +mt[2];
      if (!r || r.kind !== 'file') return err(404, 'not_found');
      if (idx >= r.chunks) return err(400, 'bad_index');
      const want = idx === r.chunks - 1 ? r.size - idx * LIMITS.chunk : LIMITS.chunk;
      // 不再依赖 Content-Length 请求头（经 Worker 转发到 DO 时可能缺失），只按实际字节数校验
      const rows = await readRows(req, want, LIMITS.row);
      if (!rows) return err(400, 'bad_length');
      const cur = this.row(r.id); if (!cur) return err(404, 'not_found');   // 上传途中被取消/删除（await 之后重新读取，避免并发覆盖计数）
      const per = LIMITS.chunk / LIMITS.row, base = idx * per;
      const had = this.sql.exec('SELECT 1 FROM chunks WHERE item=? AND idx=?', r.id, base).toArray().length > 0;
      let got = cur.got, done = 0; const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        rows.forEach((buf, k) => this.sql.exec('INSERT OR REPLACE INTO chunks(item,idx,data) VALUES(?,?,?)', r.id, base + k, buf));
        if (!had) got++;
        done = got >= r.chunks ? 1 : 0;
        this.sql.exec('UPDATE items SET got=?, done=?, updated=? WHERE id=?', got, done, now, r.id);
      });
      if (done) await this.schedule();
      const it = this.pub(this.row(r.id));
      this.broadcast(done ? { type: 'item', item: it } : { type: 'progress', id: r.id, got, chunks: r.chunks, updated: now });
      return json({ item: it });
    }
    if ((mt = p.match(/^\/items\/([\w-]{8,32})\/raw$/)) && (m === 'GET' || m === 'HEAD')) {
      const r = this.row(mt[1]);
      if (!r || r.kind !== 'file' || !r.done || (r.expires && r.expires <= Date.now())) return err(404, 'not_found');
      const dl = url.searchParams.has('dl');
      const etag = `"${r.id}-${r.size}"`;               // 内容不可变，id 即版本
      const h = { ...SEC_HEADERS, 'Content-Type': r.mime, 'Content-Length': String(r.size),
        'Content-Disposition': `${dl ? 'attachment' : 'inline'}; filename="${asciiName(r.name)}"; filename*=UTF-8''${rfc5987(r.name)}`,
        // 每次向服务器确认（304 很便宜）：删除后不会再从浏览器缓存里看到
        'Cache-Control': 'private, no-cache', 'ETag': etag,
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox" };
      h['Accept-Ranges'] = 'bytes';
      const rangeHdr = req.headers.get('Range') || '';
      const ifRange = req.headers.get('If-Range');
      const useRange = rangeHdr && (!ifRange || ifRange === etag);
      if (!useRange && req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ...SEC_HEADERS, 'Cache-Control': h['Cache-Control'], 'ETag': etag } });
      let start = 0, end = r.size - 1, status = 200;
      const rg = useRange ? /^bytes=(\d*)-(\d*)$/.exec(rangeHdr) : null;
      if (rg && (rg[1] || rg[2])) {
        if (rg[1]) { start = +rg[1]; if (rg[2]) end = Math.min(+rg[2], r.size - 1); } else { start = Math.max(0, r.size - +rg[2]); }
        if (start > end || start >= r.size) return new Response(null, { status: 416, headers: { ...SEC_HEADERS, 'Content-Range': `bytes */${r.size}` } });
        status = 206; h['Content-Range'] = `bytes ${start}-${end}/${r.size}`; h['Content-Length'] = String(end - start + 1);
      }
      if (m === 'HEAD') return new Response(null, { status, headers: h });
      // 逐行流式输出（每次只读 1.5 MiB，不会占满 DO 内存）
      const sql = this.sql, id = r.id, RW = LIMITS.row; let i = Math.floor(start / RW); const last = Math.floor(end / RW);
      const body = new ReadableStream({
        pull(ctrl) {
          if (i > last) return ctrl.close();
          const row = sql.exec('SELECT data FROM chunks WHERE item=? AND idx=?', id, i).toArray()[0];
          if (!row) return ctrl.error(new Error('missing'));
          let u = new Uint8Array(row.data); const off = i * RW;
          const a = Math.max(0, start - off), z = Math.min(u.length, end - off + 1);
          if (a || z < u.length) u = u.subarray(a, z);
          i++; ctrl.enqueue(u);
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status, headers: h });
    }
    if ((mt = p.match(/^\/items\/([\w-]{8,32})$/)) && m === 'PATCH') {
      const r = this.row(mt[1]); if (!r) return err(404, 'not_found');
      const b = await req.json().catch(() => ({}));
      this.sql.exec('UPDATE items SET expires=? WHERE id=?', b.keep ? null : Date.now() + this.ttl, r.id);
      await this.schedule();
      const it = this.pub(this.row(r.id)); this.broadcast({ type: 'item', item: it }); return json({ item: it });
    }
    if ((mt = p.match(/^\/items\/([\w-]{8,32})$/)) && m === 'DELETE') {
      this.del(mt[1]); await this.schedule(); this.broadcast({ type: 'removed', ids: [mt[1]] }); return json({ ok: true });
    }
    return err(404, 'not_found');
  }
  count() { return this.sql.exec('SELECT COUNT(*) AS n FROM items').one().n; }
  webSocketMessage(ws, msg) { if (msg === 'ping') try { ws.send('{"type":"pong"}'); } catch {} }   // 兜底（正常由 AutoResponse 处理）
  webSocketClose(ws, code) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code); } catch {} this.broadcast({ type: 'peers', n: this.ctx.getWebSockets().filter(w => w !== ws).length }); }
  webSocketError() {}
}
