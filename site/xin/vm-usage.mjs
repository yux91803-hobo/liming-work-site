// 用量看板的数据：额度窗口、光环等级、消耗速率预测、按北京日汇总 token。都是纯函数，读写文件在 vm-agent.mjs。
// 光环阈值和预测规则照 Agent HUD（README：已用 <70% 绿、≥70% 黄、≥90% 红；docs/agent-contract.md：预测按读数重算，
// 读数没有新的就不能还说「几点用完」）。
const DAY = 86400e3, BJ = 8 * 3600e3;

// 一个额度文件（{checkedAt, buckets:[{id, remaining, resetAt}]}）→ 每个窗口已用多少。重置时间过了的旧读数按已重置。
export function quotaWindows(quota, now = Date.now()) {
  if (!quota || !Array.isArray(quota.buckets)) return [];
  return quota.buckets.filter(b => b && typeof b.id === 'string' && Number.isFinite(b.remaining) && Number.isFinite(b.resetAt)).map(b => {
    const reset = b.resetAt <= now, used = reset ? 0 : Math.round(Math.min(1, Math.max(0, 1 - b.remaining)) * 1e4) / 1e4;
    return { id: b.id, kind: /-5h$/.test(b.id) ? '5h' : /-weekly$/.test(b.id) ? 'week' : 'other', used, resetAt: b.resetAt, reset };
  });
}

// 所有模型的所有窗口里用得最多的那项：ok / warn / high / out；没有读数返回 null（光环不上色）。
export function glowLevel(quotas, now = Date.now()) {
  const used = (quotas || []).flatMap(q => quotaWindows(q, now)).map(w => w.used);
  if (!used.length) return null;
  const top = Math.max(...used);
  return top >= 1 ? 'out' : top >= 0.9 ? 'high' : top >= 0.7 ? 'warn' : 'ok';
}

// 预计这个窗口什么时候用完（时间戳），算不出或重置前用不完就是 null。
// 只用同一个窗口周期（id 和重置时间都相同）最近 2 小时的读数；最新读数超过 30 分钟就不预测。
export function forecast(samples, window, now = Date.now()) {
  const list = (samples || []).filter(s => s && s.id === window.id && s.resetAt === window.resetAt && s.at >= now - 2 * 3600e3 && s.at <= now).sort((a, b) => a.at - b.at);
  if (list.length < 2) return null;
  const first = list[0], last = list.at(-1);
  if (last.at < now - 30 * 60e3 || last.at === first.at) return null;
  const rate = (first.remaining - last.remaining) / (last.at - first.at);
  if (!(rate > 0)) return null;
  const at = Math.round(last.at + last.remaining / rate);
  return at < window.resetAt ? at : null;
}

const bjDate = at => new Date(at + BJ).toISOString().slice(0, 10);
const zero = () => ({ input: 0, cached: 0, output: 0, runs: 0 });
// model-stats.jsonl 的记录 → 最近 30 个北京日（按模型）和今天 / 7 天 / 30 天合计。没有用量的轮次只算轮数。
export function usageSummary(lines, now = Date.now()) {
  const today = bjDate(now), dates = [];
  for (let i = 29; i >= 0; i--) dates.push(bjDate(now - i * DAY));
  const byDate = new Map(dates.map(d => [d, {}])), seven = new Set(dates.slice(-7));
  const totals = { today: zero(), d7: zero(), d30: zero() };
  let since = null;
  for (const r of lines || []) {
    if (!r || !Number.isFinite(r.at) || !r.model) continue;
    since = since == null ? r.at : Math.min(since, r.at);
    const date = bjDate(r.at), day = byDate.get(date);
    if (!day) continue;
    const u = r.usage || {}, add = t => { t.input += u.input || 0; t.cached += u.cached || 0; t.output += u.output || 0; t.runs++; };
    add(day[r.model] || (day[r.model] = zero()));
    add(totals.d30); if (seven.has(date)) add(totals.d7); if (date === today) add(totals.today);
  }
  for (const t of Object.values(totals)) t.hit = t.input > 0 ? t.cached / t.input : null;
  return { days: dates.map(date => ({ date, models: byDate.get(date) })), totals, since };
}
