// 小芯内核：Worker 这一侧（签名、请求、结果分类、内核配置）。设计见 docs/xin-kernel-design.md §4.2、§14。
// 内核那一侧在 site/xin/vm-kernel.mjs；签名规则两边必须一样（test/xin-kernel-auth.test.cjs 核对）。
export const KERNEL_PORT = 8797;
const enc = new TextEncoder();
function b64url(buf) { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64url(s) { const t = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(t + '='.repeat((4 - t.length % 4) % 4)), c => c.charCodeAt(0)); }
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }

/* ---------- 第二层认证（§14.5） ---------- */
export async function signKernelRequest({ key, kid, method, target, body = '', now = Date.now(), nonce }) {
  nonce = nonce || b64url(crypto.getRandomValues(new Uint8Array(16)));
  const bodySha256 = hex(await crypto.subtle.digest('SHA-256', typeof body === 'string' ? enc.encode(body) : body));
  const str = ['xin-kernel-v1', String(method).toUpperCase(), target, String(now), nonce, bodySha256].join('\n');
  const k = await crypto.subtle.importKey('raw', fromB64url(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64url(await crypto.subtle.sign('HMAC', k, enc.encode(str)));
  return `XinKernel-HMAC-SHA256 kid=${kid},ts=${now},nonce=${nonce},sig=${sig}`;
}
// 给网页的错误信息里不留令牌、密钥、签名（规则和内核的 redact 一样）
export function redact(text) {
  return String(text ?? '').replace(/\b(?:ibp|ibk|iba)_[A-Za-z0-9_-]+/g, '<hidden>').replace(/\bBearer\s+\S+/gi, 'Bearer <hidden>').replace(/\bsig=[^,\s]+/g, 'sig=<hidden>');
}
