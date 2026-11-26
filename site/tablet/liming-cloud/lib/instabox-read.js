// InstaBox 只读状态：只调 GET /v1/machines（按 InstaBox 文档「What wakes a machine」，列表不唤醒机器）。
// 读不到（没 key、401、断网、找不到）一律返回 { known: false, reason }，由选机器退回精简版判断；reason 里不带 key。
import { redactText } from './redact.js';

export const INSTABOX_API = 'https://api.instabox.sh';

export async function readMachine({ readKey, name = null, fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 8000, baseUrl = INSTABOX_API } = {}) {
  const key = typeof readKey === 'string' ? readKey.trim() : '';
  if (!key) return { known: false, reason: '没有只读 key' };
  const hide = text => redactText(String(text || '').split(key).join('[REDACTED]'));
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/v1/machines`, { method: 'GET', headers: { 'X-API-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { known: false, reason: hide(`读不到状态：${err && err.message}`) };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const code = body && body.error && typeof body.error.code === 'string' ? ` ${body.error.code}` : '';
    return { known: false, reason: hide(`读不到状态：HTTP ${res.status}${code}`) };
  }
  const list = body && Array.isArray(body.machines) ? body.machines : null;
  if (!list) return { known: false, reason: '读不到状态：返回格式不对' };
  const found = name ? list.filter(m => m && m.name === name) : list;
  if (found.length !== 1) {
    return { known: false, reason: found.length ? `账号里有 ${found.length} 台，不知道是哪台` : `账号里没有 ${name || '机器'}` };
  }
  const m = found[0];
  const state = String(m.state || m.status || '');
  const awake = state === 'running';
  const cool = Date.parse(m.cooldownUntil || '');
  const started = Date.parse(m.runStartedAt || '');
  const maxRun = Number(m.maxRunMinutes);
  return {
    known: true,
    id: String(m.id || ''),
    name: String(m.name || ''),
    state,
    awake,
    cooldownUntil: Number.isFinite(cool) && cool > now ? cool : null,
    remainingMin: awake && Number.isFinite(started) && maxRun > 0 ? Math.floor((started + maxRun * 60e3 - now) / 60e3) : null,
  };
}
