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
   installedKid：已经写进电脑上 kernel-keys.json 的那把；和当前 kid 不一样时 Worker 先装钥匙再签名。
   期望 owner {mode, gen}（第 2 批，docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md §6.4）：mode 固定 kernel（删旧模式第 2 步去掉了 XIN_STATE_OWNER）；
   gen 是部署代号，存在 kernel-owner 里，这次的部署编号（CF_VERSION_METADATA.id）和存的不一样就加一（回滚也是一次新部署）。
   外壳只认不比见过的小的代号：刚部署时新旧两版的 isolate 同时在发请求，模式只跟新的走，不来回切。 */
const CONFIG_KEY = 'kernel:config', OWNER_KEY = 'kernel-owner', ROTATE_MS = 30 * 86400e3;
export class KernelConfigStore {
  constructor(storage, { ib, ibErr = async r => ({ status: r.status, code: 'http_' + r.status, msg: '' }), now = Date.now, random = n => crypto.getRandomValues(new Uint8Array(n)), deploy = 'dev' }) {
    this.storage = storage; this.ib = ib; this.ibErr = ibErr; this.now = now; this.random = random; this.inflight = null;
    this.deploy = typeof deploy === 'string' && deploy ? deploy : 'dev'; this.mode = 'kernel'; this.gen = null;
  }
  // 一个 Durable Object 实例只属于一次部署：代号算一次就记住
  async ownerGen() {
    if (this.gen != null) return this.gen;
    const o = (await this.storage.get(OWNER_KEY)) || {};
    if (o.deploy === this.deploy && Number.isSafeInteger(o.gen)) return (this.gen = o.gen);
    const next = { deploy: this.deploy, gen: (Number.isSafeInteger(o.gen) ? o.gen : 0) + 1 };
    await this.storage.put(OWNER_KEY, next);
    return (this.gen = next.gen);
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
    return { ...this.view(c), owner: { mode: this.mode, gen: await this.ownerGen() } };
  }
  view(c) {
    const cur = c.keys.at(-1);
    return { url: c.url, token: c.token, kid: cur.kid, key: cur.key, keys: Object.fromEntries(c.keys.map(k => [k.kid, k.key])), installedKid: c.installedKid || null };
  }
  async markInstalled(kid) { const c = await this.storage.get(CONFIG_KEY); if (c) { c.installedKid = kid; await this.storage.put(CONFIG_KEY, c); } }
  // 只作废「出错时用的那个」令牌：别的 isolate 拿着更早的令牌来报错时，不再白换一次
  async invalidateToken(token) { const c = await this.storage.get(CONFIG_KEY); if (c && c.token && c.token === token) { c.tokenInvalid = true; await this.storage.put(CONFIG_KEY, c); } }
}

/* ---------- 请求内核、给结果分类（§14.2） ----------
   内核的每个回应都带 X-Xin-Kernel 头；没有这个头的回应是 InstaBox 自己回的（端口令牌不对、正在叫醒、冷却），请求没到内核。
   四种结果：ok（成功）、executed_error（做了但出错，不能换通道重来）、not_sent（确定没执行）、unknown（不知道执行没有）。 */
export const READ_OPS = new Set(['status', 'ping', 'poll', 'sessions', 'history', 'memory', 'memory_list', 'memory_export', 'memory_preferences', 'learning_report',
  'daily_get', 'files', 'plugins', 'moves', 'bond', 'tasks', 'usage', 'logins', 'preview_asset', 'greet']);
export const KEYED_OPS = new Set(['send', 'steer', 'task_tell', 'task_stop']);   // 控制器按 clientId 去重（vm-agent.mjs 的 transactionalOp、steer）
// 本身重做无害的：stop（已经停了就回 already）、daily（控制器按日期和在跑的每日任务认得出做过了，vm-agent.mjs 的 ops.stop、ops.daily）。
// 内核没在跑（502）时这两个最不能卡住：出问题时要停得下来，定时的每日任务不能因此跳过。
export const IDEMPOTENT_OPS = new Set(['stop', 'daily']);
export function retrySafe(op, args) {
  return READ_OPS.has(op) || IDEMPOTENT_OPS.has(op) || (KEYED_OPS.has(op) && typeof args?.clientId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(args.clientId));
}
export async function kernelFetch({ config, method, target, body = '', timeoutMs = 90000, fetchImpl = fetch, now = Date.now }) {
  const headers = { authorization: 'Bearer ' + config.token, 'x-xin-auth': await signKernelRequest({ key: config.key, kid: config.kid, method, target, body, now: now() }) };
  if (body) headers['content-type'] = 'application/json';
  return fetchImpl(config.url.replace(/\/$/, '') + target, { method, headers, body: body || undefined, signal: AbortSignal.timeout(timeoutMs) });
}
export async function classifyKernelResponse(r) {
  const version = r.headers.get('x-xin-kernel');   // 内核文件名里的哈希：和这次部署的不一样就该升级了
  if (version) {
    let d = null; try { d = await r.json(); } catch { /* 坏了 */ }
    // 外壳收到过期望以后，回应都带 owner（状态进程的情况）；usage 再带 ops（各操作耗时）
    if (d && d.ok === true) return { kind: 'ok', data: d.data, version, ...(d.owner && typeof d.owner === 'object' ? { owner: d.owner } : {}), ...(d.ops && typeof d.ops === 'object' ? { ops: d.ops } : {}) };
    // 主人暂时不在（状态进程正在重起或排空）：确定没执行，稍等再来
    if (d && d.executed === false && d.error === 'owner_unavailable') return { kind: 'not_sent', reason: 'owner_unavailable', retryAfter: Math.min(60, Math.max(1, Number(d.retryAfter) || 3)), version };
    if (d && d.executed === false) return { kind: 'not_sent', reason: d.error === 'kernel_auth' ? (d.reason === 'unknown_kid' ? 'unknown_kid' : 'kernel_auth') : d.error, version };
    if (d && d.executed === true) return { kind: 'executed_error', error: d.error, msg: d.msg, version };
    return { kind: 'unknown', reason: d && d.executed === 'unknown' && typeof d.error === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(d.error) ? d.error : 'bad_kernel_reply', version };
  }
  if (r.status === 401 || r.status === 403) return { kind: 'not_sent', reason: 'gate_auth' };
  if (r.status === 503) return { kind: 'not_sent', reason: 'waking', retryAfter: Number(r.headers.get('retry-after')) || 3 };
  if (r.status === 409) {
    let e = {}; try { e = (await r.json()).error || {}; } catch { /* 不是 JSON */ }
    const retryAfter = e.retryAfterSeconds || Number(r.headers.get('retry-after')) || 0;
    if (e.code === 'machine_cooldown') return { kind: 'not_sent', reason: 'cooldown', retryAfter: retryAfter || 60 };
    if (e.code === 'operation_conflict' || e.code === 'machine_not_running') return { kind: 'not_sent', reason: 'waking', retryAfter: retryAfter || 3 };
  }
  return { kind: 'unknown', reason: 'http_' + r.status };
}
export async function kernelRequest({ config, agentPath, op, args, owner, timeoutMs, fetchImpl, now }) {
  const body = JSON.stringify({ agent: agentPath, op, args: args || {}, ...(owner ? { owner } : {}) });
  let r;
  try { r = await kernelFetch({ config, method: 'POST', target: '/xin/op', body, timeoutMs, fetchImpl, now }); }
  catch (e) { return { kind: 'unknown', reason: e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network' }; }
  return classifyKernelResponse(r);
}
