// 云端任务的执行：把一个台账任务登记成平板的后台任务（ctx.jobs，kind 'cloud'，归当前平板对话），
// 在后台连上那台云电脑、补发发件箱、跟着云端对话走，等这一轮结束再交还结果；完成通知由上游 tool-jobs 发给平板 AI。
//   派活和接着做：dispatch()、tell()。进行中的补充要求用 steer 插进本轮，做完以后用 queue 在原对话里开新一轮。
//   断线：退避重连，接回跟随时从上次看到的位置往回补齐，不重复、不漏步骤。
//   取消：平板引擎退出类原因（cancel-reasons.js）只是不跟了，云端照常；其余原因走 stop() 的四步停止（设计 §5.6）。
import { isDetachReason } from './cancel-reasons.js';
import { redactText } from './redact.js';
import { lastAssistantText, stepOf, turnOutcome, clip } from './steps.js';

export const ACTIVE_STATUSES = Object.freeze(['dispatching', 'running', 'stopping']);
const ACTIVE = new Set(ACTIVE_STATUSES);
const FATAL = new Set(['NO_SSH_TARGET', 'session/conflict', 'OUTBOX_SESSION_ID_MISMATCH', 'shared', 'MKDIR_FAILED', 'LEDGER_TASK_NOT_FOUND', 'SESSION_GONE']);
const PREFIX = { tool: '▸ ', say: '· ', end: '■ ' };
const MAX_STEPS = 50;
const MAX_EVENTS = 400;

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

const notFound = err => err && err.code === 'session/not-found';

export function createRunner({
  jobs,
  ledger,
  outbox,
  remote,
  logger = null,
  now = Date.now,
  provider = 'xin-gateway',
  followIdleMs = 60000,
  reconnectMs = [2000, 5000, 15000, 30000, 60000],
  maxReconnects = 40,
  stopJobWaitMs = 15000,
  onChange = () => {},
} = {}) {
  const live = new Map();
  const stops = new Map();
  const log = (level, msg) => { try { logger?.[level]?.(redactText(msg)); } catch {} };
  const changed = taskId => { try { onChange(taskId); } catch {} };

  function steps(taskId) {
    const e = live.get(taskId);
    return e ? e.steps.slice() : [];
  }

  function isLive(taskId) {
    return live.has(taskId);
  }

  // 残留进程只能按工作目录归属。一个正在使用的项目目录不交给第二个任务。
  function otherProjectTask({ machine, project, taskId }) {
    return ledger.listTasks({ machine, statuses: ACTIVE_STATUSES }).find(t => t.project === project && t.taskId !== taskId);
  }

  // 新任务：先记台账、写发件箱，再登记后台任务（真正发出去在后台）
  function dispatch({ machine, title, project, text, tabletSessionId, model = null, toolCall }) {
    const other = project && otherProjectTask({ machine, project });
    if (other) throw Object.assign(new Error(`${machine} 上项目 ${project} 正由任务 ${other.taskId} 使用，可向该任务补充要求`), { code: 'PROJECT_BUSY' });
    const task = ledger.createTask({ machine, title, project: project || undefined, tabletSessionId });
    const entry = outbox.enqueue(task.taskId, { text, mode: 'queue' });
    ledger.updateTask(task.taskId, t => ({ ...t, model: model || null, modelSelected: false, runRequestIds: [entry.requestId], runUserSeq: 0, runEndSeq: 0, runEndReason: null }));
    const jobId = start(task.taskId, { toolCall });
    return { ...ledger.getTask(task.taskId), jobId };
  }

  function start(taskId, { toolCall } = {}) {
    const task = ledger.getTask(taskId);
    if (!task) throw new Error(`台账里没有任务 ${taskId}`);
    if (live.has(taskId)) return live.get(taskId).jobId;
    const entry = {
      taskId, jobId: null, handle: null, client: null, abort: new AbortController(), settled: false,
      steps: [], events: [], seenSeq: task.lastSeq || 0, lastUserSeq: task.runUserSeq || 0, endSeq: task.runEndSeq || 0, endReason: task.runEndReason || null,
      cancelled: false, stopPromise: null,
      lastSave: -Infinity,
    };
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    entry.settle = (outcome) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.abort.abort();
      if (live.get(taskId) === entry) live.delete(taskId);
      resolveDone(outcome);
      changed(taskId);
    };
    live.set(taskId, entry);
    const jobId = jobs.start({
      kind: 'cloud',
      label: `${task.machine} · ${task.title}`,
      ...(task.tabletSessionId ? { owner: task.tabletSessionId } : {}),
      ...(toolCall ? { toolCall } : {}),
      outputLimitBytes: 8192,
      run(handle) {
        entry.handle = handle;
        entry.jobId = handle.id;
        Promise.resolve()
          .then(() => drive(entry))
          .then(outcome => entry.settle(outcome), err => entry.settle(failed(entry, err)));
        return { done, cancel: reason => onCancel(entry, reason) };
      },
    });
    entry.jobId = jobId;
    ledger.updateTask(taskId, t => ({ ...t, jobId }));
    changed(taskId);
    return jobId;
  }

  function progress(entry, line) {
    try { entry.handle?.updateProgress(clip(line, 100)); } catch {}
  }

  function failed(entry, err) {
    const msg = redactText(err && err.message ? err.message : String(err));
    log('warn', `云端任务 ${entry.taskId} 失败：${msg}`);
    if (entry.cancelled) return { status: 'killed', detail: '已取消' };
    const lost = err && err.code === 'LOST_TRACK';   // 只是平板这边跟丢了，云端可能还在跑：不改状态，留给对账
    try {
      ledger.updateTask(entry.taskId, t => (!lost && ACTIVE.has(t.status) && t.status !== 'stopping'
        ? { ...t, status: 'failed', endedAt: now(), lastError: msg, noticeState: 'pending', lastSeq: Math.max(t.lastSeq, entry.seenSeq) }
        : { ...t, lastError: msg }));
    } catch {}
    try { entry.handle?.append(`\n没做成：${msg}\n`); } catch {}
    return { status: 'failed', detail: clip(msg, 120) };
  }

  function detached() {
    return { status: 'killed', detail: '平板这边不再跟踪，云端任务照常进行' };
  }

  async function drive(entry) {
    let attempt = 0;
    for (;;) {
      if (entry.abort.signal.aborted) return entry.stopPromise ? await entry.stopPromise.then(stoppedOutcome) : detached();
      const task = ledger.getTask(entry.taskId);
      if (!task) throw Object.assign(new Error(`台账里没有任务 ${entry.taskId}`), { code: 'LEDGER_TASK_NOT_FOUND' });
      let conn = null;
      let delay;
      const seenAtConnect = entry.seenSeq;
      try {
        progress(entry, attempt ? `重新连接 ${task.machine}…` : `连接 ${task.machine}…`);
        conn = await remote.connect(task.machine, entry.taskId, { signal: entry.abort.signal });
        if (entry.abort.signal.aborted) continue;
        entry.client = conn.client;
        await prepare(entry, conn.client);
        if (entry.abort.signal.aborted) continue;
        return await follow(entry, conn.client);
      } catch (err) {
        if (entry.abort.signal.aborted) continue;
        if (notFound(err) && !pendingOutbox(entry.taskId)) {
          throw Object.assign(new Error('云端对话不见了（可能被删了或云电脑重装过），不重新派'), { code: 'SESSION_GONE' });
        }
        if (FATAL.has(err && err.code)) throw err;
        remote.invalidate?.(task.machine);
        if (entry.seenSeq > seenAtConnect) attempt = 0;
        attempt += 1;
        if (attempt > maxReconnects) {
          throw Object.assign(new Error(`暂时跟丢了：连不上 ${task.machine}，已重试 ${maxReconnects} 次。云端任务可能还在跑（比如机器在冷却），台账留着；站长回到这段对话或打开面板时再接上`), { code: 'LOST_TRACK' });
        }
        delay = reconnectMs[Math.min(attempt - 1, reconnectMs.length - 1)];
        const msg = redactText(err && err.message ? err.message : String(err));
        log('warn', `云端任务 ${entry.taskId}：${msg}，${delay}ms 后重连`);
        progress(entry, `连不上 ${task.machine}，稍后重试：${clip(msg, 50)}`);
        try { ledger.updateTask(entry.taskId, t => ({ ...t, lastError: msg })); } catch {}
      } finally {
        entry.client = null;
        try { await conn?.release?.(); } catch {}
      }
      await sleep(delay, entry.abort.signal);
    }
  }

  async function ensureSession(client, task) {
    try {
      await client.state(task.cloudSessionId);
    } catch (err) {
      if (!notFound(err)) throw err;
      const created = await client.createSession({ sessionId: task.cloudSessionId, cwd: task.cwd });
      if (!created || created.sessionId !== task.cloudSessionId) {
        throw Object.assign(new Error(`云端建的对话编号（${created && created.sessionId}）不是 ${task.cloudSessionId}，不再重复派发`), { code: 'OUTBOX_SESSION_ID_MISMATCH' });
      }
    }
  }

  async function prepare(entry, client) {
    const task = ledger.getTask(entry.taskId);
    await remote.ensureProjectDir(task.machine, task.cwd);
    if (entry.abort.signal.aborted) return;
    if (task.model && !task.modelSelected) {
      await ensureSession(client, task);
      await client.rpc('session/selectModel', { request: { sessionId: task.cloudSessionId, provider, model: task.model } });
      ledger.updateTask(entry.taskId, t => ({ ...t, modelSelected: true }));
    }
    if (entry.abort.signal.aborted) return;
    await outbox.flushOutbox(entry.taskId, client);
    changed(entry.taskId);
  }

  function pendingOutbox(taskId) {
    const t = ledger.getTask(taskId);
    return t ? t.outbox.some(e => e.status !== 'acked') : false;
  }

  // 这一轮看到哪了：lastSeq、本轮我们那条消息的位置、本轮结束的位置一起存，重启后接着跟的时候用
  function position(entry, t) {
    return { lastSeq: Math.max(t.lastSeq, entry.seenSeq), runUserSeq: entry.lastUserSeq, runEndSeq: entry.endSeq, runEndReason: entry.endReason };
  }

  function observe(entry, event) {
    if (!event || typeof event.seq !== 'number' || event.seq <= entry.seenSeq) return;
    entry.seenSeq = event.seq;
    if (event.type === 'user/message') {   // 只有用户消息才要读台账里这一轮的请求编号
      const runIds = new Set(ledger.getTask(entry.taskId)?.runRequestIds || []);
      if (runIds.has(event.data?.source?.rpcId)) entry.lastUserSeq = event.seq;
    }
    if (event.type === 'turn/end') { entry.endSeq = event.seq; entry.endReason = event.data?.reason || null; }
    entry.events.push(event);
    if (entry.events.length > MAX_EVENTS) entry.events.splice(0, entry.events.length - MAX_EVENTS);
    const step = stepOf(event);
    if (step) {
      entry.steps.push(step);
      if (entry.steps.length > MAX_STEPS) entry.steps.splice(0, entry.steps.length - MAX_STEPS);
      try { entry.handle?.append(`${PREFIX[step.kind] || ''}${step.text}\n`); } catch {}
      if (step.kind === 'tool' || step.kind === 'say') progress(entry, step.text);
      changed(entry.taskId);
    }
    if (performance.now() - entry.lastSave > 5000) {   // 间隔用单调时钟
      entry.lastSave = performance.now();
      try { ledger.updateTask(entry.taskId, t => ({ ...t, ...position(entry, t) })); } catch {}
    }
  }

  // 跟随流的第一帧只给最近一段；比上次看到的位置新、但中间有缺口时，用 session/page 往回补齐
  async function catchUp(entry, client, sessionId, records, hasMore) {
    let all = records;
    let more = hasMore;
    while (more && all.length && all[0].seq > entry.seenSeq + 1) {
      const page = await client.page(sessionId, { beforeSeq: all[0].seq, maxMessages: 200 });
      const older = (page.records || []).map(r => r.event).filter(Boolean);
      if (!older.length) break;
      all = [...older, ...all];
      more = page.hasMore;
    }
    return all;
  }

  function doneNow(entry) {
    return entry.lastUserSeq > 0 && entry.endSeq > entry.lastUserSeq;
  }

  async function follow(entry, client) {
    const task = ledger.getTask(entry.taskId);
    const sid = task.cloudSessionId;
    const stream = client.followSession(sid);
    const onAbort = () => { try { stream.close(); } catch {} };
    entry.abort.signal.addEventListener('abort', onAbort, { once: true });
    progress(entry, `在 ${task.machine} 上进行中`);
    try {
      for (;;) {
        let frame;
        try {
          frame = await stream.nextFrame(followIdleMs);
        } catch (err) {
          if (err && err.code === 'TIMEOUT' && !entry.abort.signal.aborted) {
            // 心跳：连接还在就继续等。云端重启后没加载的对话 session/state 会报 not-found，那不是对话不见了
            await client.state(sid).catch(e => { if (!notFound(e)) throw e; });
            continue;
          }
          throw err;
        }
        if (frame.done) {
          if (entry.abort.signal.aborted) throw new Error('已停止跟随');
          throw new Error('云端跟随流结束了');
        }
        const v = frame.value || {};
        let events = [];
        if (v.type === 'snapshot') events = await catchUp(entry, client, sid, (v.records || []).map(r => r.event).filter(Boolean), v.hasMore);
        else if (v.type === 'event' && v.event) events = [v.event];
        for (const e of events) observe(entry, e);
        if (!doneNow(entry)) continue;
        if (pendingOutbox(entry.taskId)) {   // 这一轮结束时还有没送到的补充要求：现在补发，接着等
          await outbox.flushOutbox(entry.taskId, client);
          continue;
        }
        return await finish(entry);
      }
    } finally {
      entry.abort.signal.removeEventListener('abort', onAbort);
      try { await stream.close(); } catch {}
    }
  }

  async function finish(entry) {
    const current = ledger.getTask(entry.taskId);
    if (current && current.status === 'stopping') {
      // 停止请求已经记下：结果以四步停止的复核为准
      const r = entry.stopPromise ? await entry.stopPromise : await stop(entry.taskId, { reason: current.stopRequest?.reason || '', source: current.stopRequest?.source || 'resume' });
      return stoppedOutcome(r);
    }
    const outcome = turnOutcome(entry.endReason);
    const summary = redactText(lastAssistantText(entry.events, { fromSeq: entry.lastUserSeq }));
    let leftoverPids;
    if (outcome.status === 'interrupted' && !otherProjectTask(current)) {
      // 云端 Harness 崩过：原来的前台命令会变成孤儿接着跑（实测 E6），清掉这个项目目录下的残留进程
      try { leftoverPids = (await remote.killLeftovers(current.machine, current.cwd)).found; } catch (err) { log('warn', `云端中断后清残留进程失败：${err && err.message}`); }
    }
    if (entry.abort.signal.aborted) return entry.stopPromise ? stoppedOutcome(await entry.stopPromise) : detached();
    ledger.updateTask(entry.taskId, t => ({
      ...t, ...position(entry, t), status: outcome.status, endedAt: now(), summary, noticeState: 'pending', lastError: null,
      ...(leftoverPids ? { leftoverPids } : {}),
    }));
    try { entry.handle?.append(`\n结果（${outcome.label}）：${summary || '（这一轮没有文字总结）'}\n`); } catch {}
    return { status: outcome.job, detail: outcome.label };
  }

  function stoppedOutcome(r) {
    return { status: 'killed', detail: r && r.status === 'stopped' ? '已停止（云端已确认停干净）' : `停止中，还没确认：${clip(r && r.detail || '', 80)}` };
  }

  function onCancel(entry, reason) {
    if (entry.cancelled) return;
    entry.cancelled = true;
    if (isDetachReason(reason)) {
      log('info', `平板不再跟踪云端任务 ${entry.taskId}（${reason}），云端照常`);
      entry.settle(detached());
      return;
    }
    entry.stopPromise = stop(entry.taskId, { reason: String(reason ?? ''), source: 'job' });
    entry.stopPromise.then(r => entry.settle(stoppedOutcome(r)), err => entry.settle(stoppedOutcome({ status: 'stopping', detail: err && err.message })));
  }

  // 补充要求：进行中且平板在跟 → 插进本轮；否则在原对话里排一轮新的，登记新的后台任务
  async function tell(taskId, text, { toolCall } = {}) {
    const task = ledger.getTask(taskId);
    if (!task) return { ok: false, reason: `台账里没有任务 ${taskId}` };
    if (task.status === 'stopping') return { ok: false, taskId, reason: '这个任务正在停止，等停完再说' };
    const entry = live.get(taskId);
    if (ACTIVE.has(task.status)) {
      const e = outbox.enqueue(taskId, { text, mode: 'steer' });
      ledger.updateTask(taskId, t => ({ ...t, runRequestIds: [...(t.runRequestIds || []), e.requestId] }));
      let delivered = false;
      if (entry?.client) {
        try {
          await outbox.flushOutbox(taskId, entry.client);
          delivered = ledger.getTask(taskId)?.outbox.some(item => item.requestId === e.requestId && item.status === 'acked');
        } catch (err) { log('warn', `插话暂时没送到：${err && err.message}`); }
      }
      changed(taskId);
      return { ok: true, taskId, mode: 'steer', requestId: e.requestId, delivered, jobId: entry?.jobId || task.jobId };
    }
    const other = otherProjectTask(task);
    if (other) return { ok: false, taskId, reason: `${task.machine} 上项目 ${task.project} 正由任务 ${other.taskId} 使用` };
    const e = outbox.enqueue(taskId, { text, mode: 'queue' });
    ledger.updateTask(taskId, t => ({ ...t, status: 'dispatching', runRequestIds: [e.requestId], runUserSeq: 0, runEndSeq: 0, runEndReason: null, endedAt: null, noticeState: 'none', summary: '', lastError: null, stopRequest: null }));
    const jobId = start(taskId, { toolCall });
    return { ok: true, taskId, mode: 'queue', requestId: e.requestId, delivered: false, jobId };
  }

  // 四步停止（设计 §5.6）：先记「停止中」，再 1 停当前一轮、2 停后台命令、3 清项目目录下的残留进程、4 复核；
  // 四项都确认了才记「已停止」。哪一步做不下去就保持「停止中」，下次连上接着做（可以重复执行）。
  async function stop(taskId, { reason = '', source = 'panel' } = {}) {
    if (stops.has(taskId)) return stops.get(taskId);
    const task = ledger.getTask(taskId);
    if (!task) return { status: 'missing', detail: `台账里没有任务 ${taskId}` };
    if (!ACTIVE.has(task.status)) return { status: task.status, detail: '任务已经结束了' };
    ledger.updateTask(taskId, t => ({ ...t, status: 'stopping', stopRequest: t.stopRequest || { source, reason: redactText(reason), requestedAt: now() } }));
    const pending = Promise.resolve().then(() => confirmStop(task)).finally(() => stops.delete(taskId));
    stops.set(taskId, pending);
    const entry = live.get(taskId);
    if (entry) {
      entry.stopPromise = pending;
      entry.abort.abort();
    }
    changed(taskId);
    return pending;
  }

  async function readStopState(client, sid, requestIds) {
    const state = await client.state(sid).catch(err => { if (!notFound(err)) throw err; return { running: false, queue: null }; });
    if (Array.isArray(state.queue)) {
      return { state, queued: state.queue.filter(item => requestIds.has(item.rpcId)) };
    }
    // 冷态 state 不显示队列。读持久化 inbox，避免下次加载对话时恢复已停止的请求。
    const snapshot = await client.rpc('session/projections', { request: { sessionId: sid } });
    if (!snapshot) return { state, queued: [] };
    if (snapshot.kind !== 'sequenced') throw new Error('云端队列未能确认');
    const inbox = snapshot.values?.inbox;
    const messages = [...(inbox?.['next-turn'] || []), ...(inbox?.['next-step'] || [])];
    return { state, queued: messages.filter(message => requestIds.has(message.source?.rpcId)) };
  }

  async function confirmStop(task) {
    const { taskId } = task;
    const sid = task.cloudSessionId;
    let conn = null;
    try {
      // 先挡住新的发件，再等本地已发出的请求结清，避免 cancel 先于仍在送达的请求。
      await outbox.waitForIdle(taskId);
      conn = await remote.connect(task.machine, `${taskId}:stop`);
      const client = conn.client;
      const requestIds = new Set(task.outbox.map(item => item.requestId));
      for (const item of (await readStopState(client, sid, requestIds)).queued) {
        await client.rpc('session/updateQueue', { request: { sessionId: sid, itemId: item.id, action: { kind: 'remove' } } })
          .catch(err => { if (err?.code !== 'session/queue-item-not-found') throw err; });
      }
      try { await client.cancel(sid); } catch (err) { if (!notFound(err)) throw err; }
      const listJobs = async () => { try { return await client.readJobListOnce(sid); } catch (err) { if (notFound(err)) return []; throw err; } };
      const deadline = performance.now() + stopJobWaitMs;
      for (;;) {
        const running = (await listJobs()).filter(j => j.status === 'running' || j.status === 'stopping');
        if (!running.length) break;
        for (const j of running) if (j.status === 'running') await client.killJob(sid, j.id || j.jobId).catch(err => { if (!notFound(err)) throw err; });
        if (performance.now() > deadline) throw new Error(`还有 ${running.length} 个后台命令没停下：${running.map(j => clip(j.label || j.id, 40)).join('、')}`);
        await sleep(300);
      }
      const other = otherProjectTask(task);
      if (other) throw new Error(`任务 ${other.taskId} 仍在使用这个项目目录，暂不清理进程`);
      const left = await remote.killLeftovers(task.machine, task.cwd);
      const { state, queued } = await readStopState(client, sid, requestIds);
      const stillJobs = (await listJobs()).filter(j => j.status === 'running' || j.status === 'stopping');
      const problems = [];
      if (state.running) problems.push('云端这一轮还在跑');
      if (queued.length) problems.push(`还有 ${queued.length} 条本任务的消息在排队`);
      if (stillJobs.length) problems.push(`还有 ${stillJobs.length} 个后台命令`);
      if (left.remain.length) problems.push(`项目目录下还有进程没停掉（PID ${left.remain.join(', ')}）`);
      if (problems.length) throw new Error(problems.join('；'));
      ledger.updateTask(taskId, t => ({
        ...t, status: 'stopped', endedAt: now(), lastError: null,
        outbox: t.outbox.filter(item => item.status === 'acked'),
        stopRequest: { ...(t.stopRequest || {}), confirmedAt: now(), killedPids: left.found },
      }));
      log('info', `云端任务 ${taskId} 已停止${left.found.length ? `，清掉了 ${left.found.length} 个残留进程` : ''}`);
      return { status: 'stopped', detail: left.found.length ? `清掉了项目目录下 ${left.found.length} 个残留进程` : '' };
    } catch (err) {
      const msg = redactText(err && err.message ? err.message : String(err));
      try { ledger.updateTask(taskId, t => ({ ...t, lastError: msg })); } catch {}
      log('warn', `云端任务 ${taskId} 还没停干净：${msg}`);
      return { status: 'stopping', detail: msg };
    } finally {
      try { await conn?.release?.(); } catch {}
      changed(taskId);
    }
  }

  // 面板上的「停止」：直接走四步停止，不经过取消原因；停完结掉平板这边的后台任务
  async function stopFromPanel(taskId) {
    const entry = live.get(taskId);
    if (entry && !entry.cancelled) {
      entry.cancelled = true;
      entry.stopPromise = stop(taskId, { source: 'panel' });
      const r = await entry.stopPromise;
      entry.settle(stoppedOutcome(r));
      return r;
    }
    return stop(taskId, { source: 'panel' });
  }

  async function dispose() {
    for (const entry of [...live.values()]) {
      entry.cancelled = true;
      entry.settle(detached());
    }
  }

  return { dispatch, start, tell, stop, stopFromPanel, steps, isLive, dispose };
}
