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

/* ---------- 内核配置（Durable Object 实例 xin-inbox 里，§4.2、§14.5） ----------
   端口令牌：发布私有端口时带 rotateToken 拿到（InstaBox 只在那一刻给一次）；30 天换一次，被 InstaBox 拒了就作废重换。
   钥匙：随机 32 字节，和端口令牌、站长密码都无关；30 天换一把，最多留两把（文件里新旧都在，换的时候不断线）。
   installedKid：已经写进电脑上 kernel-keys.json 的那把；和当前 kid 不一样时 Worker 先装钥匙再签名。 */
const CONFIG_KEY = 'kernel:config', ROTATE_MS = 30 * 86400e3;
export class KernelConfigStore {
  constructor(storage, { ib, ibErr = async r => ({ status: r.status, code: 'http_' + r.status, msg: '' }), now = Date.now, random = n => crypto.getRandomValues(new Uint8Array(n)) }) {
    this.storage = storage; this.ib = ib; this.ibErr = ibErr; this.now = now; this.random = random; this.inflight = null;
  }
  // 同一个实例里同时来的 get 共用一次刷新，免得连着换两次令牌、把刚拿到的那个作废
  get({ machineId }) {
    if (!this.inflight) this.inflight = this.refresh(machineId).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async refresh(machineId) {
    const now = this.now();
    let c = (await this.storage.get(CONFIG_KEY)) || { keys: [] }, dirty = false;
    if (c.machineId !== machineId) { c = { ...c, machineId, token: null, url: null, tokenAt: 0, installedKid: null }; dirty = true; }
    if (!c.token || c.tokenInvalid || now - (c.tokenAt || 0) > ROTATE_MS) {
      const r = await this.ib(`/v1/machines/${machineId}/ports`, { method: 'POST', body: JSON.stringify({ port: KERNEL_PORT, name: 'xin-kernel', access: 'private', rotateToken: true }) });
      if (!r.ok) throw await this.ibErr(r);
      const d = await r.json();
      if (!d.token || !d.url) throw { status: 502, code: 'no_port_token', msg: 'InstaBox 没有给出内核端口的令牌' };
      c = { ...((await this.storage.get(CONFIG_KEY)) || c), machineId, url: d.url, token: d.token, tokenAt: now, tokenInvalid: false };
      if (dirty) c.installedKid = null;
      dirty = true;
    }
    const cur = (c.keys || []).at(-1);
    if (!cur || now - cur.at > ROTATE_MS) { c.keys = [...(c.keys || []), { kid: 'k' + hex(this.random(5)), key: b64url(this.random(32)), at: now }].slice(-2); dirty = true; }
    if (dirty) await this.storage.put(CONFIG_KEY, c);
    return this.view(c);
  }
  view(c) {
    const cur = c.keys.at(-1);
    return { url: c.url, token: c.token, kid: cur.kid, key: cur.key, keys: Object.fromEntries(c.keys.map(k => [k.kid, k.key])), installedKid: c.installedKid || null };
  }
  async markInstalled(kid) { const c = await this.storage.get(CONFIG_KEY); if (c) { c.installedKid = kid; await this.storage.put(CONFIG_KEY, c); } }
  // 只作废「出错时用的那个」令牌：别的 isolate 拿着更早的令牌来报错时，不再白换一次
  async invalidateToken(token) { const c = await this.storage.get(CONFIG_KEY); if (c && c.token && c.token === token) { c.tokenInvalid = true; await this.storage.put(CONFIG_KEY, c); } }
}
