// 小芯内核（第 1 步）：云电脑上常驻的 HTTP 外壳。设计见 docs/xin-kernel-design.md §4、§10 第 1 步、§14。
// 只用 node 内置模块，不 import 别的 vm-*.mjs：Worker 把它单独按内容哈希上传（vm-kernel-<hash>.mjs）。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const KERNEL_PORT = 8797;
export const AUTH_WINDOW_MS = 300000, NONCE_KEEP_MS = 600000;

/* ---------- 第二层认证（§14.5） ----------
   X-Xin-Auth: XinKernel-HMAC-SHA256 kid=<kid>,ts=<毫秒>,nonce=<base64url 16 字节>,sig=<base64url>
   钥匙是 Durable Object 随机生成的 32 字节，和 InstaBox 端口令牌、站长密码都无关；Worker 的签名在 src/xin-kernel.js。 */
export function canonical({ method, target, ts, nonce, bodySha256 }) {
  return ['xin-kernel-v1', String(method).toUpperCase(), target, String(ts), nonce, bodySha256].join('\n');
}
export function parseAuth(header) {
  const m = /^XinKernel-HMAC-SHA256 kid=([A-Za-z0-9_-]{1,40}),ts=(\d{1,16}),nonce=([A-Za-z0-9_-]{16,64}),sig=([A-Za-z0-9_-]{43})$/.exec(String(header || ''));
  return m ? { kid: m[1], ts: Number(m[2]), nonce: m[3], sig: m[4] } : null;
}
// 钥匙文件 {"v":1,"keys":{"<kid>":"<base64url 32 字节>"}}：修改时间变了才重读；软链接、坏文件都当没有钥匙
export class KeyRing {
  constructor(file) { this.file = file; this.stamp = null; this.map = new Map(); }
  keys() {
    let st = null;
    try { st = fs.lstatSync(this.file); } catch { /* 没有文件 */ }
    const stamp = st ? [st.ino, st.size, st.mtimeMs, st.isSymbolicLink()].join(':') : 'none';
    if (stamp === this.stamp) return this.map;
    this.stamp = stamp; this.map = new Map();
    if (!st || !st.isFile()) return this.map;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && d.v === 1 && d.keys && typeof d.keys === 'object')
        for (const [kid, v] of Object.entries(d.keys)) {
          const key = typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(kid) ? Buffer.from(v, 'base64url') : null;
          if (key && key.length === 32) this.map.set(kid, key);
        }
    } catch { this.map = new Map(); }
    return this.map;
  }
}
// 用过的随机数存在内核自己的 SQLite 里：内核重启了也认得；超过 10 分钟的顺手删掉
export class NonceStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') try { fs.chmodSync(file, 0o600); } catch { /* 刚建的文件 */ }
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    this.prune = this.db.prepare('DELETE FROM nonces WHERE at < ?');
    this.add = this.db.prepare('INSERT OR IGNORE INTO nonces(nonce, at) VALUES(?, ?)');
  }
  seen(nonce, now) {
    this.prune.run(now - NONCE_KEEP_MS);
    return this.add.run(nonce, now).changes === 0;
  }
}
export function verifyRequest({ method, target, header, body, keys, nonces, now }) {
  if (!header) return { ok: false, reason: 'missing' };
  const a = parseAuth(header);
  if (!a) return { ok: false, reason: 'malformed' };
  const key = keys.get(a.kid);
  if (!key) return { ok: false, reason: 'unknown_kid' };
  if (Math.abs(now - a.ts) > AUTH_WINDOW_MS) return { ok: false, reason: 'expired' };
  const bodySha256 = crypto.createHash('sha256').update(body == null ? '' : body).digest('hex');
  const want = crypto.createHmac('sha256', key).update(canonical({ method, target, ts: a.ts, nonce: a.nonce, bodySha256 })).digest();
  const got = Buffer.from(a.sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, reason: 'bad_sig' };
  if (nonces.seen(a.nonce, now)) return { ok: false, reason: 'replay' };
  return { ok: true, kid: a.kid };
}
// 日志和给 Worker 的错误信息里不留令牌、密钥、签名（规则和 src/xin-kernel.js 的 redact 一样）
export function redact(text) {
  return String(text ?? '').replace(/\b(?:ibp|ibk|iba)_[A-Za-z0-9_-]+/g, '<hidden>').replace(/\bBearer\s+\S+/gi, 'Bearer <hidden>').replace(/\bsig=[^,\s]+/g, 'sig=<hidden>');
}
