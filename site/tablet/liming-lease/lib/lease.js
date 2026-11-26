// InstaBox 活动租约（设计 §5.8）：平板派来的活在这台云电脑上跑时（有对话在忙、或有后台命令在跑），持有租约 tablet-cloud，
// 不让机器在模型长时间思考、没有输出时被当成空闲暂停；全部空闲 2 分钟后释放。免费版上租约不延长本轮运行时间（InstaBox 文档）。
// 只用写权限的 key（machines:write，没有删除权限），放在 ~/.liming-cloud/lease.key；任何失败只记日志，绝不影响任务本身。
import fs from 'node:fs';
import path from 'node:path';

export const LEASE_ID = 'tablet-cloud';
export const DEFAULTS = Object.freeze({ ttlSeconds: 3600, renewMs: 20 * 60e3, releaseAfterMs: 2 * 60e3, retryMs: 60e3 });

export function readLeaseFiles(dir) {
  const warnings = [];
  let key = null;
  let name = null;
  try {
    const file = path.join(dir, 'lease.key');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077)) {
      warnings.push('lease.key 要是权限为 600 的普通文件（chmod 600 ~/.liming-cloud/lease.key）');
    } else {
      key = fs.readFileSync(file, 'utf8').trim() || null;
    }
  } catch {}
  try { name = fs.readFileSync(path.join(dir, 'machine-name'), 'utf8').trim() || null; } catch {}
  return { key, name, warnings };
}

export function createLeaseKeeper({
  readKey,
  machineName,
  fetchImpl = globalThis.fetch,
  logger = null,
  baseUrl = 'https://api.instabox.sh',
  ttlSeconds = DEFAULTS.ttlSeconds,
  renewMs = DEFAULTS.renewMs,
  releaseAfterMs = DEFAULTS.releaseAfterMs,
  retryMs = DEFAULTS.retryMs,
  timeoutMs = 15000,
} = {}) {
  const busy = new Set();
  let held = false;
  let mayHaveLease = false;
  let machineId = null;
  let renewTimer = null;
  let releaseTimer = null;
  let retryTimer = null;
  let inflight = null;
  let lastError = null;
  let disposed = false;

  const hide = (text, key) => (key ? String(text).split(key).join('[REDACTED]') : String(text)).replace(/ibk_[A-Za-z0-9_-]+/g, 'ibk_[REDACTED]');
  const log = (level, msg, key) => { try { logger?.[level]?.(hide(`[liming-lease] ${msg}`, key)); } catch {} };
  const clear = (t) => { if (t) clearTimeout(t); return null; };
  const timer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };

  async function call(method, urlPath, key, body) {
    const res = await fetchImpl(`${baseUrl}${urlPath}`, {
      method,
      redirect: 'error',
      headers: { 'X-API-Key': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try { json = await res.json(); } catch {}
    if (!res.ok) throw new Error(`HTTP ${res.status}${json && json.error && json.error.code ? ` ${json.error.code}` : ''}`);
    return json;
  }

  async function resolveId(key) {
    if (machineId) return machineId;
    const name = machineName();
    if (!name) throw new Error('没有 ~/.liming-cloud/machine-name，不知道这台叫什么');
    const data = await call('GET', '/v1/machines', key);
    const found = (data && Array.isArray(data.machines) ? data.machines : []).filter(m => m && m.name === name);
    if (found.length === 0) throw Object.assign(new Error(`账号里找不到叫 ${name} 的机器，不拿租约`), { permanent: true });
    if (found.length > 1) throw Object.assign(new Error(`账号里叫 ${name} 的有 ${found.length} 台，不拿租约`), { permanent: true });
    machineId = found[0].id;
    return machineId;
  }

  async function acquire() {
    if (disposed || busy.size === 0) return;
    retryTimer = clear(retryTimer);
    const key = readKey();
    if (!key) { log('warn', '没有 ~/.liming-cloud/lease.key，不拿租约（任务照常跑，只是长时间没输出时机器可能被暂停）'); return; }
    try {
      const id = await resolveId(key);
      if (disposed || !busy.size) return;
      mayHaveLease = true;
      await call('PUT', `/v1/machines/${id}/activity-leases/${LEASE_ID}`, key, { ttlSeconds });
      if (!held) log('info', `拿到租约 ${LEASE_ID}`);
      held = true;
      lastError = null;
      renewTimer = clear(renewTimer);
      if (!disposed && busy.size) renewTimer = timer(() => { renewTimer = null; if (busy.size) run(acquire); }, renewMs);
    } catch (err) {
      lastError = hide(err && err.message, key);
      log('warn', `拿租约失败：${lastError}`, key);
      if (!err.permanent && busy.size && !disposed) {
        retryTimer = clear(retryTimer);
        retryTimer = timer(() => { retryTimer = null; run(acquire); }, retryMs);
      }
    }
  }

  async function release() {
    if (busy.size) return;
    renewTimer = clear(renewTimer);
    retryTimer = clear(retryTimer);
    if (!mayHaveLease || !machineId) return;
    const key = readKey();
    held = false;
    mayHaveLease = false;
    if (!key) return;
    try {
      await call('DELETE', `/v1/machines/${machineId}/activity-leases/${LEASE_ID}`, key);
      log('info', `都空闲了，放掉租约 ${LEASE_ID}`);
    } catch (err) {
      lastError = hide(err && err.message, key);
      log('warn', `放租约失败（租约到期会自己结束）：${lastError}`, key);
    }
  }

  // 同一时间只跑一个网络动作，按顺序来
  function run(fn) {
    const next = (inflight || Promise.resolve()).then(fn, fn).catch(() => {});
    inflight = next;
    return next;
  }

  function setBusy(source, isBusy) {
    if (disposed) return;
    const before = busy.size;
    if (isBusy) busy.add(source); else busy.delete(source);
    if (busy.size > 0) {
      releaseTimer = clear(releaseTimer);
      if (before === 0 && (!held || !renewTimer)) run(acquire);
    } else if (before > 0) {
      releaseTimer = clear(releaseTimer);
      releaseTimer = timer(() => { releaseTimer = null; if (busy.size === 0) run(release); }, releaseAfterMs);
    }
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    releaseTimer = clear(releaseTimer);
    busy.clear();
    await run(release);
  }

  function state() {
    return { held, machineId, busy: busy.size, lastError };
  }

  return { setBusy, dispose, state };
}
