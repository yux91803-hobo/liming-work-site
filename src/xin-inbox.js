// 待送达：发给小芯的消息先存在 Durable Object（实例 xin-inbox）里，存好了才对网页说「收到了」，再由这里把它送进云电脑。
// 设计见 docs/xin-kernel-design.md §14.1、§14.4。编号就是网页的 clientId：和控制器的去重（send:<clientId>）、回执、轮次号一一对应。
// 补偿靠几层：每行自己记状态和下次时间；尝试前先写租约；闹钟开头先给自己续上；打开网页和定时任务会「踢」一下；24 小时送不到就标出来。
import { redact } from './xin-kernel.js';

export const BACKOFF_S = [5, 15, 30, 60, 120, 300, 600];
const ROW = 'inbox:row:', LEASE_MS = 120000, GUARD_MS = 120000, GIVE_UP_MS = 24 * 3600e3, KEEP_MS = 7 * 24 * 3600e3, LIST_DELIVERED_MS = 10 * 60e3, WAKE_MS = 5000;
const WAKE_FAST = 20;   // 叫醒中：前这么多次几秒一试，再叫不醒（InstaBox 那边出故障）就按退避放慢
const TRANSIENT = new Set(['busy', 'lock_failed', 'internal']);   // 控制器的临时错误：过一会儿再送
const ID = /^[A-Za-z0-9_-]{8,80}$/;
const enc = new TextEncoder();
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
async function digestOf(args) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(stable(args))));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export class Inbox {
  constructor(storage, { deliver, now = Date.now, budgetMs = 6000 }) {
    this.storage = storage; this.deliver = deliver; this.now = now; this.budgetMs = budgetMs;
    this.mutations = Promise.resolve();
  }
  // 只串行化存储变更，不在这里等待云电脑。新消息、闹钟、迟到的回应和确认共用同一条写入队列。
  serial(fn) { const p = this.mutations.then(fn); this.mutations = p.catch(() => {}); return p; }
  // 存好了才返回；新的一行（或到期的旧行）当场送一次，最多等 budgetMs，没等到就先回「在送」
  async accept({ id, op, args }) {
    if (typeof id !== 'string' || !ID.test(id)) return { error: 'bad_id' };
    args = args && typeof args === 'object' ? args : {};
    const digest = await digestOf(args);
    const conflict = await this.serial(async () => {
      const old = await this.storage.get(ROW + id);
      if (old) return old.digest !== digest;
      const now = this.now(), seq = ((await this.storage.get('inbox:seq')) || 0) + 1;
      await this.storage.put('inbox:meta', { v: 1 });   // 有行就一定有标记，闹钟能认出这是待送达
      await this.storage.put('inbox:seq', seq);
      await this.storage.put(ROW + id, { id, op, args, digest, seq, state: 'pending', attempts: 0, backoff: 0, nextAt: now, leaseUntil: 0, createdAt: now,
        firstAttemptAt: 0, deliveredAt: 0, finishedAt: 0, result: null, wait: null, error: null, acked: false, woke: false });
      return false;
    });
    if (conflict) return { error: 'conflict' };
    return { view: await this.told(await this.attempt(id, this.budgetMs)) };
  }
  // 当场就失败的：这次回应已经把结果告诉发送方了，算确认过；下次打开网页不再报一遍
  async told(view) { if (view && view.state === 'failed') await this.ack(view.id); return view; }
  due(row, now = this.now()) { return row.state === 'pending' && row.nextAt <= now && row.leaseUntil <= now; }
  async attempt(id, budgetMs) {
    const claim = await this.serial(async () => {
      const now = this.now(), row = await this.storage.get(ROW + id), head = (await this.rows()).find(r => r.state === 'pending');
      if (!row || !this.due(row, now) || head?.id !== id) return { view: row ? this.viewOf(row, head) : null };
      row.leaseUntil = now + LEASE_MS; row.attempts++;
      if (!row.firstAttemptAt) row.firstAttemptAt = now;
      await this.storage.put(ROW + id, row);
      await this.armBefore(row.leaseUntil);   // 尝试半路没了：租约到期时闹钟还会来
      return { row };
    });
    if (!claim.row) { await this.schedule(); return claim.view; }
    const p = this.deliverRow(claim.row);
    if (budgetMs > 0) {
      let timer;
      try { await Promise.race([p, new Promise(r => { timer = setTimeout(r, budgetMs); })]); }
      finally { clearTimeout(timer); }
    } else await p;
    return this.serial(async () => this.viewOf(await this.storage.get(ROW + id), (await this.rows()).find(r => r.state === 'pending')));
  }
  async deliverRow(row) {
    let r;
    try { r = await this.deliver(row); } catch (e) { r = { ok: false, state: 'error', msg: String(e && (e.msg || e.message) || e) }; }
    await this.serial(async () => {
      const latest = await this.storage.get(ROW + row.id);
      // 租约过期后可能已开始下一次尝试，旧回应不能覆盖新尝试的状态；重送仍沿用同一 clientId。
      if (!latest || latest.state !== 'pending' || latest.attempts !== row.attempts) return;
      this.settle(latest, r, this.now());
      await this.storage.put(ROW + row.id, latest);
      if (latest.state === 'delivered' && (latest.woke || latest.deliveredAt - latest.firstAttemptAt > WAKE_MS)) await this.recordWake(latest.deliveredAt - latest.firstAttemptAt, latest.deliveredAt);
    });
    await this.schedule();
  }
  settle(row, r, now) {
    row.leaseUntil = 0;
    if (r && r.ok) {
      const d = r.data;
      if (!d || !d.error) { Object.assign(row, { state: 'delivered', result: d ?? {}, deliveredAt: now, finishedAt: now, wait: null, error: null }); return; }
      if (TRANSIENT.has(d.error)) { this.retry(row, now, { state: 'busy', msg: d.msg || '小芯那边正忙' }); return; }
      Object.assign(row, { state: 'failed', result: d, error: { code: d.error, msg: d.msg || d.error }, wait: null, finishedAt: now });
      return;
    }
    const st = r && r.state, ra = Number(r && r.retryAfter) || 0;
    if (st === 'waking') {
      row.woke = true;
      if (row.attempts > WAKE_FAST) this.retry(row, now, { state: 'waking', msg: '唤醒中' });
      else this.waitUntil(row, now, now + Math.max(3, ra) * 1000, { state: 'waking', msg: '唤醒中' });
      return;
    }
    if (st === 'cooldown') { const until = now + (ra || 60) * 1000; this.waitUntil(row, now, until, { state: 'cooldown', until, msg: '云电脑在冷却' }); return; }
    if (st === 'busy') { this.retry(row, now, { state: 'busy', msg: 'InstaBox 忙' }); return; }
    this.retry(row, now, { state: 'retrying', msg: redact(r && r.msg || '连不上云电脑') });
  }
  retry(row, now, wait) {
    const s = BACKOFF_S[Math.min(row.backoff || 0, BACKOFF_S.length - 1)];
    row.backoff = (row.backoff || 0) + 1;
    this.waitUntil(row, now, now + s * 1000, wait);
  }
  waitUntil(row, now, nextAt, wait) {
    if (now - row.createdAt > GIVE_UP_MS) { this.giveUp(row, now); return; }
    row.nextAt = nextAt; row.wait = { ...wait, until: wait.until ?? nextAt };
  }
  giveUp(row, now) { Object.assign(row, { state: 'failed', leaseUntil: 0, wait: null, error: { code: 'gave_up', msg: '24 小时都没送到' }, finishedAt: now }); }
  async rows() { return [...(await this.storage.list({ prefix: ROW })).values()].sort((a, b) => a.seq - b.seq); }
  // 闹钟定到最早该再送的那一行；都送完了就不留闹钟
  async schedule() {
    return this.serial(async () => {
      const now = this.now(), head = (await this.rows()).find(r => r.state === 'pending');
      if (!head) { await this.storage.deleteAlarm(); return; }
      // 后面的行即使已到期也不能越过队首；不能因此在一小时冷却期内每秒空转一次。
      await this.storage.setAlarm(Math.max(now + 1000, Math.min(head.nextAt, head.createdAt + GIVE_UP_MS + 1), head.leaseUntil));
    });
  }
  async armBefore(t) { const cur = await this.storage.getAlarm(); if (cur == null || cur > t) await this.storage.setAlarm(t); }
  async alarm() {
    const now = this.now();
    await this.serial(async () => {
      await this.storage.setAlarm(now + GUARD_MS);   // 先续上：下面干到一半实例没了，闹钟还会再来
      for (const row of await this.rows()) {
        const fin = row.finishedAt || row.deliveredAt;
        if (row.state !== 'pending' && fin && now - fin > KEEP_MS) await this.storage.delete(ROW + row.id);
      }
    });
    for (const row of await this.rows()) {
      if (row.state !== 'pending') continue;
      if (now - row.createdAt > GIVE_UP_MS && row.leaseUntil <= now) {
        await this.serial(async () => {
          const latest = await this.storage.get(ROW + row.id);
          if (latest?.state === 'pending' && latest.leaseUntil <= now) { this.giveUp(latest, now); await this.storage.put(ROW + row.id, latest); }
        });
        continue;
      }
      if (!this.due(row, this.now())) break;
      await this.attempt(row.id, 0);
      const after = await this.storage.get(ROW + row.id);
      if (after && after.state === 'pending') break;
    }
    await this.schedule();
  }
  // 打开网页、定时任务来踢一下：闹钟丢了能补上；退避中的提前到现在（人已经来了，别再等几分钟）；冷却中的不动，冷却没结束叫不醒
  async kick() {
    return this.serial(async () => {
      const now = this.now(), pending = (await this.rows()).filter(r => r.state === 'pending');
      if (!pending.length) return;
      for (const r of pending) if (r.nextAt > now && r.leaseUntil <= now && !(r.wait && r.wait.state === 'cooldown')) { r.nextAt = now; await this.storage.put(ROW + r.id, r); }
      const t = now + 1000, cur = await this.storage.getAlarm();
      if (cur == null || cur > t) await this.storage.setAlarm(t);
    });
  }
  async view(id) {
    return this.serial(async () => {
      const row = typeof id === 'string' && await this.storage.get(ROW + id);
      if (!row) return null;
      if (row.state !== 'pending' && !row.acked) { row.acked = true; await this.storage.put(ROW + id, row); }
      return this.viewOf(row, (await this.rows()).find(r => r.state === 'pending'));
    });
  }
  async ack(id) { return this.serial(async () => { const row = typeof id === 'string' && await this.storage.get(ROW + id); if (row) { row.acked = true; await this.storage.put(ROW + id, row); } }); }
  async list() {
    const now = this.now();
    const all = await this.rows(), head = all.find(r => r.state === 'pending');
    const rows = all.filter(r => r.state === 'pending' || (r.state === 'failed' && !r.acked) || (r.state === 'delivered' && !r.acked && now - r.deliveredAt < LIST_DELIVERED_MS));
    return { rows: rows.map(r => this.viewOf(r, head)), wakes: await this.stats() };
  }
  async recordWake(ms, at) {
    const w = ((await this.storage.get('inbox:wakes')) || []).concat([{ ms, at }]).slice(-50);
    await this.storage.put('inbox:wakes', w);
  }
  async stats() {
    const ms = ((await this.storage.get('inbox:wakes')) || []).map(w => w.ms).sort((a, b) => a - b);
    if (!ms.length) return { count: 0, p50: 0, max: 0, over45: 0 };
    return { count: ms.length, p50: ms[Math.floor((ms.length - 1) / 2)], max: ms.at(-1), over45: ms.filter(x => x > 45000).length };
  }
  viewOf(row, head) {
    if (!row) return null;
    const a = row.args || {};
    const wait = row.state === 'pending' && head && head.id !== row.id
      ? head.wait || { state: 'retrying', until: Math.max(head.nextAt, head.leaseUntil), msg: '前面还有消息等待送达' } : row.wait;
    return { id: row.id, state: row.state, attempts: row.attempts, createdAt: row.createdAt, deliveredAt: row.deliveredAt || 0,
      result: row.result, error: row.error, sid: a.sid || null, main: !!a.main, text: typeof a.text === 'string' ? a.text : '', files: Array.isArray(a.files) ? a.files : [],
      wait: row.state === 'pending' ? wait : null };
  }
}
