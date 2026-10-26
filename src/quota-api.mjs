// quota-api.mjs — GET /api/hub/quota（登录校验由外层 hub 负责）
// 返回 JSON 数组，字段为驼峰：
// [{ accountId, label, active(boolean), plan,
//    daily: { usedPct, resetAt }, cycle: { usedPct, resetAt },
//    checkedAt, source, updatedAt }]
// usedPct / resetAt / checkedAt / source 可能为 null（未查询）。

const SQL =
  'SELECT account_id, label, active, plan, daily_used_pct, daily_reset_at, cycle_used_pct, cycle_reset_at, ' +
  'checked_at, source, updated_at FROM hub_quota ORDER BY active DESC, account_id';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v) => (v === null || v === undefined ? null : String(v));

export function mapRow(r) {
  return {
    accountId: str(r.account_id),
    label: str(r.label),
    active: Number(r.active) === 1,
    plan: str(r.plan),
    daily: { usedPct: num(r.daily_used_pct), resetAt: str(r.daily_reset_at) },
    cycle: { usedPct: num(r.cycle_used_pct), resetAt: str(r.cycle_reset_at) },
    checkedAt: str(r.checked_at),
    source: str(r.source),
    updatedAt: str(r.updated_at)
  };
}

export async function handleQuota(env) {
  try {
    const res = await env.DB.prepare(SQL).all();
    const rows = Array.isArray(res && res.results) ? res.results : [];
    return json(rows.map(mapRow));
  } catch (err) {
    // 首次同步之前表还不存在
    if (/no such table/i.test(String(err && err.message))) return json([]);
    return json({ error: 'quota_unavailable' }, 500);
  }
}
