// 通知闭环（设计 §5.5）和重启后的对账（设计 §5.7）。
// 通知：云端这一轮结束时台账先记「待确认」（runner 的 finish）；只有在平板对话日志里看到那条通知（session/event），才记「已告诉」。
//   引擎重启后，某段对话的代理出现（agent/created，站长回到这段对话）时：日志里已有通知就补记，没有就补投一条
//   source { kind: 'liming-cloud', form: 'notice', taskId }（空闲 followup、忙 inject），写进日志后才记「已告诉」。
//   上游限制：插件叫不醒没打开的对话，所以站长回到那段对话前，面板显示「完成（未读）」。
// 对账：进行中、停止中而平板没在跟的任务——
//   停止中：接着走四步停止（站长要停，必要时叫醒机器）；冷却中到点再试。
//   进行中：机器冷却中到点再连；睡着的不叫醒，等站长回到这段对话；这段对话的代理在时才接上（后台任务必须归一个活着的代理）。
import { randomUUID } from 'node:crypto';
import { ACTIVE_STATUSES } from './runner.js';

const ACTIVE = new Set(ACTIVE_STATUSES);
const LABEL = { completed: '完成了', failed: '没做成', stopped: '已停止', interrupted: '云端中断了' };
const STOP_RETRY_MS = [60e3, 5 * 60e3, 15 * 60e3];

function textOf(data) {
  return Array.isArray(data && data.content) ? data.content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n') : '';
}

export function noticeVia(task, event) {
  if (!task || !event || event.type !== 'user/message') return null;
  const src = event.data && event.data.source;
  if (!src || src.form !== 'notice') return null;
  if (src.kind === 'liming-cloud' && src.taskId === task.taskId) return 'liming-cloud';
  if (src.kind === 'tool-jobs' && task.jobId && textOf(event.data).includes(task.jobId)) return 'tool-jobs';
  return null;
}

export function createRecovery({ runner, ledger, agents, readStatus, logger = null, now = Date.now, retryGraceMs = 30e3, onChange = () => {} } = {}) {
  const timers = new Set();
  const sent = new Set();
  const busy = new Set();
  const stopTries = new Map();
  let disposed = false;
  const log = (level, msg) => { try { logger?.[level]?.(msg); } catch {} };

  function later(fn, ms) {
    if (disposed) return;
    const t = setTimeout(() => { timers.delete(t); if (!disposed) fn(); }, Math.max(0, ms));
    t.unref?.();
    timers.add(t);
  }

  function confirm(taskId, via, seq) {
    ledger.updateTask(taskId, t => (t.noticeState === 'pending' ? { ...t, noticeState: 'confirmed', noticeMeta: { via, seq: seq ?? null, at: now() } } : t));
    try { onChange(taskId); } catch {}
  }

  function onSessionEvent(session, event) {
    if (!event || event.type !== 'user/message' || !session || !session.id) return;
    const src = event.data && event.data.source;
    if (!src || src.form !== 'notice') return;
    for (const task of ledger.listTasks({ tabletSessionId: session.id })) {
      if (task.noticeState !== 'pending') continue;
      const via = noticeVia(task, event);
      if (via) confirm(task.taskId, via, event.seq);
    }
  }

  function snapshot(agent) {
    try { return typeof agent?.session?.snapshotEvents === 'function' ? agent.session.snapshotEvents() || [] : []; } catch { return []; }
  }

  function deliverCatchup(sessionId, taskId, key) {
    setImmediate(() => {
      if (disposed) return;
      const live = agents.get(sessionId);
      const t = ledger.getTask(taskId);
      if (!live || !t || t.noticeState !== 'pending') { sent.delete(key); return; }
      const label = LABEL[t.status] || t.status;
      const text = `[云端任务] ${t.machine} · ${t.title}（任务 ${t.taskId}）${label}。结果：${t.summary || t.lastError || '（没有文字总结）'}`;
      const msg = Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: Object.freeze({ kind: 'liming-cloud', form: 'notice', summary: `云端任务 ${t.taskId} ${label}`, taskId: t.taskId }),
      });
      try {
        if (live.status === 'idle') live.followup(msg);
        else live.inject(msg);
        log('info', `补说云端任务 ${t.taskId} 的结果`);
      } catch (err) {
        sent.delete(key);
        log('warn', `补说云端任务 ${t.taskId} 失败：${err && err.message}`);
      }
    });
  }

  async function attach(task, { userPresent = false } = {}) {
    if (disposed || !task || !ACTIVE.has(task.status) || runner.isLive(task.taskId) || busy.has(task.taskId)) return 'skip';
    busy.add(task.taskId);
    try {
      let st = { known: false };
      try { st = await readStatus(task.machine); } catch {}
      if (st && st.known && st.cooldownUntil && st.cooldownUntil > now()) {
        later(() => attach(ledger.getTask(task.taskId), { userPresent }), st.cooldownUntil - now() + retryGraceMs);
        return 'cooling';
      }
      if (task.status === 'stopping') {
        const r = await runner.stop(task.taskId, { source: 'resume' });
        if (r.status === 'stopping') {
          const n = stopTries.get(task.taskId) || 0;
          stopTries.set(task.taskId, n + 1);
          if (n < STOP_RETRY_MS.length) later(() => attach(ledger.getTask(task.taskId)), STOP_RETRY_MS[n]);
        } else stopTries.delete(task.taskId);
        return r.status;
      }
      if (st && st.known && !st.awake && !userPresent) return 'asleep';
      if (!task.tabletSessionId || !agents.get(task.tabletSessionId)) return 'no-owner';
      runner.start(task.taskId);
      return 'attached';
    } catch (err) {
      log('warn', `对账云端任务 ${task.taskId} 失败：${err && err.message}`);
      return 'error';
    } finally {
      busy.delete(task.taskId);
    }
  }

  function onAgentCreated(agent) {
    const sessionId = agent && agent.id;
    if (!sessionId || disposed) return;
    const tasks = ledger.listTasks({ tabletSessionId: sessionId });
    const events = tasks.some(t => t.noticeState === 'pending') ? snapshot(agent) : [];
    for (const t of tasks) {
      if (t.noticeState !== 'pending' || ACTIVE.has(t.status)) continue;
      const hit = events.find(e => noticeVia(t, e));
      if (hit) { confirm(t.taskId, `${noticeVia(t, hit)}:dedup-on-load`, hit.seq); continue; }
      const key = `${t.taskId}:${t.jobId || ''}`;
      if (sent.has(key)) continue;
      sent.add(key);
      deliverCatchup(sessionId, t.taskId, key);
    }
    for (const t of tasks) if (ACTIVE.has(t.status)) attach(t, { userPresent: true });
  }

  async function sweep({ sessionId = null, userPresent = false } = {}) {
    const tasks = ledger.listTasks({ statuses: ACTIVE_STATUSES, ...(sessionId ? { tabletSessionId: sessionId } : {}) });
    const results = {};
    for (const t of tasks) results[t.taskId] = await attach(t, { userPresent });
    return results;
  }

  function dispose() {
    disposed = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  return { onSessionEvent, onAgentCreated, sweep, attach, dispose };
}
