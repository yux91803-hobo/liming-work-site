// DSH Go 原生界面（设计 §5.4）：输入框上方一行状态条，点开是「云端任务」面板（对话详情「插件」页签和聊天页弹层）。
// 规格照 ccch1mneyyy/dsh-go 的 docs/plugins：面板视图只放结构，状态、用时、步骤、结果用绑定从推来的数据里取；
// 任务多了少了、某件从进行中变成做完时才让 App 重新取视图（refresh）。点按落到 on('cloud-tasks')，按 event.action 分：
//   tell:<任务号>（表单提交：插话或接着做）、stop:<任务号>（确认）、retrystop:<任务号>、insert:<任务号>（老 App 没有表单时）、limit（每台上限）。
import { ACTIVE_STATUSES } from './runner.js';
import { beijingHHMM } from './selector.js';
import { clip } from './steps.js';
import { byteLength, createThrottledEmitter, MAX_EMIT_BYTES } from './throttle.js';

export const STRIP_ID = 'cloud-status';
export const PANEL_ID = 'cloud-tasks';
const ACTIVE = new Set(ACTIVE_STATUSES);
const MAX_CARDS = 6;
const LOW_MIN = 30;

function mine(tasks, sessionId) {
  return tasks.filter(t => !sessionId || t.tabletSessionId === sessionId).sort((a, b) => b.createdAt - a.createdAt);
}

export function elapsedText(task, now) {
  const from = task.startedAt || task.createdAt || now;
  const ms = Math.max(0, (task.endedAt || now) - from);
  const min = Math.floor(ms / 60e3);
  if (min < 1) return `${Math.floor(ms / 1000)} 秒`;
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

export function statusText(task) {
  switch (task.status) {
    case 'dispatching': return (task.outbox || []).some(e => e.status !== 'acked') ? '正在送达' : '派发中';
    case 'running': return task.lastError ? '进行中（连接不稳，正在重连）' : '进行中';
    case 'stopping': return '停止中（正在确认）';
    case 'completed': return task.noticeState === 'pending' ? '完成（未读）' : '完成';
    case 'failed': return task.lastError ? `没做成：${clip(task.lastError, 40)}` : '没做成';
    case 'stopped': return '已停止';
    case 'interrupted': return '云端中断';
    default: return task.status;
  }
}

function machineLine(name, st, now) {
  if (!st || !st.known) return `${name}：状态未知`;
  if (st.cooldownUntil && st.cooldownUntil > now) return `${name}：冷却到 ${beijingHHMM(st.cooldownUntil)}`;
  if (st.awake) return Number.isFinite(st.remainingMin) ? `${name}：醒着，本轮还能跑约 ${st.remainingMin} 分钟` : `${name}：醒着`;
  return `${name}：睡着`;
}

export function stripFor({ tasks, sessionId, statuses = {}, now = Date.now() }) {
  const list = mine(tasks, sessionId);
  const active = list.filter(t => ACTIVE.has(t.status));
  for (const t of active) {
    const st = statuses[t.machine];
    if (st && st.known && st.cooldownUntil && st.cooldownUntil > now) return { text: `${t.machine} 冷却到 ${beijingHHMM(st.cooldownUntil)}`, icon: 'cloud', tone: 'warn' };
  }
  for (const t of active) {
    const st = statuses[t.machine];
    if (st && st.known && st.awake && Number.isFinite(st.remainingMin) && st.remainingMin < LOW_MIN) return { text: `${t.machine} 剩 ${st.remainingMin} 分钟`, icon: 'cloud', tone: 'warn' };
  }
  if (active.length === 1) {
    const t = active[0];
    return { text: `${t.machine} ${t.status === 'stopping' ? '停止中' : '进行中'} · ${elapsedText(t, now)}`, icon: 'cloud' };
  }
  if (active.length > 1) return { text: `${active.length} 个云端任务进行中`, icon: 'cloud' };
  const unread = list.filter(t => t.noticeState === 'pending').length;
  if (unread) return { text: `${unread} 件云端任务完成（未读）`, icon: 'cloud', tone: 'good' };
  return null;
}

function category(t) {
  return ACTIVE.has(t.status) ? (t.status === 'stopping' ? 'stopping' : 'active') : 'done';
}

export function structureKey({ tasks, sessionId }) {
  return mine(tasks, sessionId).slice(0, MAX_CARDS).map(t => `${t.taskId}:${category(t)}`).join(',');
}

const has = (caps, type) => Array.isArray(caps && caps.components) && caps.components.includes(type);

function card(t, v2) {
  const at = path => ({ $: `data.t.${t.taskId}.${path}` });
  const children = [
    { type: 'text', text: `**${clip(t.title, 60)}**` },
    { type: 'keyValue', items: [['机器', t.machine], ['状态', at('status')], ['用时', at('elapsed')]] },
    { type: 'steps', items: at('steps') },
    { type: 'text', tone: 'muted', text: at('summary') },
  ];
  const tellForm = (label, submitLabel) => ({
    type: 'collapsible', label, children: [{
      type: 'form', submit: `tell:${t.taskId}`, submitLabel, children: [
        { type: 'textField', label: '要说的话', bind: `data.drafts.${t.taskId}`, multiline: true, maxLines: 6, maxLength: 2000, required: true },
      ],
    }],
  });
  const c = category(t);
  if (c === 'active') {
    children.push(v2 ? tellForm('插话', '发给云端') : { type: 'actions', items: [{ label: '插话', action: `insert:${t.taskId}` }] });
    children.push({ type: 'confirm', id: `stop:${t.taskId}`, confirmLabel: '停止任务', cancelLabel: '不停' });
  } else if (c === 'stopping') {
    children.push({ type: 'actions', items: [{ label: '再试一次停止', action: `retrystop:${t.taskId}` }] });
  } else {
    children.push(v2 ? tellForm('接着做', '接着做') : { type: 'actions', items: [{ label: '接着做', action: `insert:${t.taskId}` }] });
  }
  return { type: 'stack', children };
}

export function panelView({ tasks, sessionId, caps }) {
  const v2 = has(caps, 'form') && has(caps, 'textField');
  const list = mine(tasks, sessionId).slice(0, MAX_CARDS);
  const children = [{ type: 'callout', tone: 'info', text: { $: 'data.machines' } }];
  if (list.length === 0) {
    children.push(has(caps, 'emptyState')
      ? { type: 'emptyState', icon: 'cloud', title: '还没有云端任务', message: '在对话里让 AI 把长任务交给云电脑' }
      : { type: 'text', tone: 'muted', text: '还没有云端任务。在对话里让 AI 把长任务交给云电脑。' });
  }
  for (const t of list) children.push(card(t, v2));
  if (has(caps, 'stepper')) children.push({ type: 'stepper', label: '每台同时最多', bind: 'data.limit', min: 1, max: 5, onChange: 'limit' });
  return v2 ? { v: 2, type: 'stack', children } : { type: 'stack', children };
}

export function panelData({ tasks, sessionId, steps, statuses = {}, limit, machines = ['li', 'li2'], now = Date.now() }) {
  const list = mine(tasks, sessionId).slice(0, MAX_CARDS);
  const t = {};
  for (const task of list) {
    const recent = (steps(task.taskId) || []).slice(-3);
    const live = ACTIVE.has(task.status);
    t[task.taskId] = {
      status: statusText(task),
      elapsed: elapsedText(task, now),
      steps: recent.map((s, i) => ({ label: clip(s.text, 80), status: live && i === recent.length - 1 ? 'current' : 'done' })),
      summary: task.summary ? clip(task.summary, 600) : '',
    };
  }
  return fitPanelData({ machines: machines.map(n => machineLine(n, statuses[n], now)).join(' · '), limit, t });
}

// 超过 32 KiB 时依次：摘要截短、去掉步骤、去掉旧任务
export function fitPanelData(data, maxBytes = MAX_EMIT_BYTES) {
  if (byteLength(data) <= maxBytes) return data;
  const out = { ...data, t: { ...data.t } };
  for (const id of Object.keys(out.t)) out.t[id] = { ...out.t[id], summary: clip(out.t[id].summary, 120) };
  if (byteLength(out) <= maxBytes) return out;
  for (const id of Object.keys(out.t)) out.t[id] = { ...out.t[id], steps: [] };
  const ids = Object.keys(out.t);
  while (byteLength(out) > maxBytes && ids.length) delete out.t[ids.pop()];
  return out;
}

export function createPanelActions({ runner, settings, notify = () => {} }) {
  return (scope, event) => {
    const action = String(event && event.action || '');
    const value = (event && event.value) || {};
    const [kind, taskId] = action.split(/:(.*)/s);
    if (kind === 'tell' && taskId) {
      const text = String((value.values || {})[`data.drafts.${taskId}`] ?? value.value ?? '').trim();
      if (!text) return { toast: '先写点什么' };
      return {
        pending: { label: '正在发送' },
        result: async () => {
          const r = await runner.tell(taskId, text);
          notify(taskId);
          if (!r.ok) return { toast: clip(r.reason, 36) };
          return { toast: r.mode === 'steer' ? (r.delivered ? '已插进这一轮' : '暂时连不上，连上后补发') : '在原对话里接着做了', patch: { drafts: { [taskId]: '' } } };
        },
      };
    }
    if (kind === 'stop' && taskId) {
      if (!value.confirmed) return undefined;
      return {
        pending: { label: '正在停止', timeoutMs: 60000 },
        result: async () => {
          const r = await runner.stopFromPanel(taskId);
          notify(taskId);
          return { toast: r.status === 'stopped' ? '已停止' : '停止中，还在确认' };
        },
      };
    }
    if (kind === 'retrystop' && taskId) {
      return {
        pending: { label: '正在停止', timeoutMs: 60000 },
        result: async () => {
          const r = await runner.stop(taskId, { source: 'panel' });
          notify(taskId);
          return { toast: r.status === 'stopped' ? '已停止' : `还没停干净：${clip(r.detail, 24)}` };
        },
      };
    }
    if (kind === 'insert' && taskId) return { insert: `请用 cloud_tell 给云端任务 ${taskId} 补充：` };
    if (kind === 'limit') {
      try {
        const s = settings.set({ maxConcurrentPerMachine: Number(value.value) });
        notify(null);
        return { toast: `每台最多 ${s.maxConcurrentPerMachine} 个` };
      } catch (err) {
        return { toast: clip(err.message, 36) };
      }
    }
    return undefined;
  };
}

// 挂到 ctx.dshGo（只在装了 dsh-go 桥接的主机上会进来）
export function attachUi(ctx, { runner, ledger, settings, readStatus, subscribe, recovery, machines = () => ['li', 'li2'], now = Date.now, statusEveryMs = 60e3, tickMs = 15e3 }) {
  const dshGo = ctx.dshGo;
  const statuses = {};
  let statusTimer = null;
  let watchers = 0;
  let lastKey = null;
  let lastRefresh = 0;

  async function refreshStatuses() {
    await Promise.all(machines().map(async m => { try { statuses[m] = await readStatus(m); } catch {} }));
  }
  function watchStatuses(on) {
    watchers += on ? 1 : -1;
    if (watchers > 0 && !statusTimer) {
      refreshStatuses().then(() => changed(null));
      statusTimer = setInterval(() => { refreshStatuses().then(() => changed(null)); }, statusEveryMs);
      statusTimer.unref?.();
    } else if (watchers <= 0 && statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }
  const subs = new Set();
  function changed(taskId) { for (const s of [...subs]) s(taskId); }
  subscribe(changed);

  function maybeRefresh(sessionId) {
    const key = structureKey({ tasks: ledger.listTasks(), sessionId });
    if (lastKey !== null && key !== lastKey && now() - lastRefresh > 1000) {
      lastRefresh = now();
      try { dshGo.refresh(PANEL_ID); } catch {}
    }
    lastKey = key;
  }

  function live(scope, emit, build) {
    const out = createThrottledEmitter(emit);
    const push = () => { try { out.push(build()); } catch {} };
    const onChange = () => push();
    subs.add(onChange);
    watchStatuses(true);
    const tick = setInterval(push, tickMs);
    tick.unref?.();
    push();
    return () => { subs.delete(onChange); clearInterval(tick); out.close(); watchStatuses(false); };
  }

  dshGo.strip(STRIP_ID, (scope, emit) => live(scope, emit, () => stripFor({ tasks: ledger.listTasks(), sessionId: scope && scope.sessionId, statuses, now: now() })));

  dshGo.panel(PANEL_ID, {
    view: (scope, caps) => {
      lastKey = structureKey({ tasks: ledger.listTasks(), sessionId: scope && scope.sessionId });
      return panelView({ tasks: ledger.listTasks(), sessionId: scope && scope.sessionId, caps });
    },
    data: (scope, emit) => {
      const sessionId = scope && scope.sessionId;
      // 站长打开面板 = 在场：没在跟的任务这时候接上（需要时叫醒机器）
      if (sessionId && recovery) recovery.sweep({ sessionId, userPresent: true }).catch(() => {});
      return live(scope, emit, () => {
        maybeRefresh(sessionId);
        return panelData({ tasks: ledger.listTasks(), sessionId, steps: id => runner.steps(id), statuses, limit: settings.get().maxConcurrentPerMachine, machines: machines(), now: now() });
      });
    },
  });

  dshGo.on(PANEL_ID, createPanelActions({ runner, settings, notify: changed }));
}
