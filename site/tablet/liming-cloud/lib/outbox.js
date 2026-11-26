// 发件箱引擎：严格遵守「先写台账，再发云端」与阶段 1 真实 Harness 契约边界。
// 恢复与发送顺序：先调 session/prompt(sessionId, requestId)，仅在云端返回 session/not-found 时才调
// session/create({ sessionId, cwd }) 并核对返回的 sessionId 与预期完全一致；session/conflict 如实报错。
import { randomUUID } from 'node:crypto';
import { redactError, redactText } from './redact.js';

export class OutboxError extends Error {
  constructor(code, message, details = {}) {
    super(redactText(message));
    this.name = 'OutboxError';
    this.code = code;
    this.details = details;
  }
}

export function generateRequestId() {
  return `req_${randomUUID()}`;
}

function extractSessionId(created) {
  if (!created || typeof created !== 'object') return null;
  if (typeof created.sessionId === 'string') return created.sessionId;
  if (typeof created.id === 'string') return created.id;
  if (created.session && typeof created.session.id === 'string') return created.session.id;
  return null;
}

export function createOutbox(ledger, options = {}) {
  const now = options.now || Date.now;
  const genRequestId = options.generateRequestId || generateRequestId;
  const taskLocks = new Map();

  function serializeTask(taskId, fn) {
    const prev = taskLocks.get(taskId) || Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    const settled = run.then(() => {}, () => {});
    taskLocks.set(taskId, settled);
    settled.then(() => {
      if (taskLocks.get(taskId) === settled) taskLocks.delete(taskId);
    });
    return run;
  }

  // 先原子写入台账发件箱（status: 'pending'），不发任何网络请求。
  function enqueue(taskId, message) {
    const task = ledger.getTask(taskId);
    if (!task) {
      throw new OutboxError('OUTBOX_TASK_NOT_FOUND', `找不到任务：${taskId}`);
    }
    const text = typeof message?.text === 'string' ? message.text : '';
    if (!text) {
      throw new OutboxError('OUTBOX_EMPTY_TEXT', '发件箱消息正文不能为空');
    }
    const mode = message.mode || 'queue';
    if (mode !== 'queue' && mode !== 'steer') {
      throw new OutboxError('OUTBOX_INVALID_MODE', `不支持的发送模式：${mode}`);
    }
    const requestId = message.requestId || genRequestId();
    const sessionId = message.sessionId || task.cloudSessionId;
    const cwd = message.cwd || task.cwd;
    const createdAt = Number(now());

    const updated = ledger.appendOutboxEntry(taskId, {
      requestId,
      sessionId,
      cwd,
      text,
      mode,
      createdAt,
    });
    return updated.outbox.find(item => item.requestId === requestId);
  }

  async function deliverSingle(taskId, requestId, client) {
    const task = ledger.getTask(taskId);
    if (!task) {
      throw new OutboxError('OUTBOX_TASK_NOT_FOUND', `找不到任务：${taskId}`);
    }
    const entry = task.outbox.find(item => item.requestId === requestId);
    if (!entry) {
      throw new OutboxError('OUTBOX_ENTRY_NOT_FOUND', `任务 ${taskId} 找不到发件箱条目 ${requestId}`);
    }
    if (entry.status === 'acked') {
      return {
        requestId,
        sessionId: entry.sessionId,
        status: 'acked',
        skipped: true,
        createdSession: false,
      };
    }

    ledger.updateOutboxEntry(taskId, requestId, cur => ({
      ...cur,
      attempts: (cur.attempts || 0) + 1,
    }));

    let createdSession = false;
    let promptRes;
    try {
      promptRes = await client.prompt(entry.sessionId, entry.text, {
        requestId: entry.requestId,
        mode: entry.mode,
      });
    } catch (err) {
      if (err?.code === 'session/not-found') {
        let created;
        try {
          created = await client.createSession({
            sessionId: entry.sessionId,
            cwd: entry.cwd,
          });
        } catch (createErr) {
          const safeErr = redactError(createErr);
          ledger.updateOutboxEntry(taskId, requestId, cur => ({
            ...cur,
            lastError: safeErr.message,
          }));
          throw safeErr;
        }
        const returnedId = extractSessionId(created);
        if (returnedId !== entry.sessionId) {
          const mismatch = new OutboxError(
            'OUTBOX_SESSION_ID_MISMATCH',
            `云端 session/create 返回的对话编号（${returnedId ?? 'null'}）与预期（${entry.sessionId}）不一致，已拒绝重复派发`,
            { expectedSessionId: entry.sessionId, returnedSessionId: returnedId },
          );
          ledger.updateOutboxEntry(taskId, requestId, cur => ({
            ...cur,
            lastError: mismatch.message,
          }));
          throw mismatch;
        }
        createdSession = true;
        try {
          promptRes = await client.prompt(entry.sessionId, entry.text, {
            requestId: entry.requestId,
            mode: entry.mode,
          });
        } catch (retryErr) {
          const safeErr = redactError(retryErr);
          ledger.updateOutboxEntry(taskId, requestId, cur => ({
            ...cur,
            lastError: safeErr.message,
          }));
          throw safeErr;
        }
      } else {
        const safeErr = redactError(err);
        ledger.updateOutboxEntry(taskId, requestId, cur => ({
          ...cur,
          lastError: safeErr.message,
        }));
        throw safeErr;
      }
    }

    if (!promptRes || promptRes.accepted !== true) {
      const rejected = new OutboxError(
        'OUTBOX_NOT_ACCEPTED',
        `云端未确认接受请求 ${requestId}`,
        { response: promptRes ?? null },
      );
      ledger.updateOutboxEntry(taskId, requestId, cur => ({
        ...cur,
        lastError: rejected.message,
      }));
      throw rejected;
    }

    const ackTs = Number(now());
    ledger.updateTask(taskId, cur => {
      const idx = cur.outbox.findIndex(item => item.requestId === requestId);
      if (idx >= 0) {
        cur.outbox[idx] = {
          ...cur.outbox[idx],
          status: 'acked',
          ackedAt: ackTs,
          lastError: null,
        };
      }
      if (cur.status === 'dispatching') {
        cur.status = 'running';
        if (cur.startedAt === null) cur.startedAt = ackTs;
      }
      cur.lastError = null;
      return cur;
    });

    return {
      requestId,
      sessionId: entry.sessionId,
      status: 'acked',
      skipped: false,
      createdSession,
    };
  }

  function flushOutbox(taskId, client) {
    return serializeTask(taskId, async () => {
      const task = ledger.getTask(taskId);
      if (!task) {
        throw new OutboxError('OUTBOX_TASK_NOT_FOUND', `找不到任务：${taskId}`);
      }
      const sent = [];
      const skipped = [];
      for (const entry of task.outbox) {
        if (entry.status === 'acked') {
          skipped.push(entry.requestId);
          continue;
        }
        const res = await deliverSingle(taskId, entry.requestId, client);
        sent.push(res);
      }
      const latest = ledger.getTask(taskId);
      const pendingRemaining = latest ? latest.outbox.filter(item => item.status !== 'acked').length : 0;
      return { taskId, sent, skipped, pendingRemaining };
    });
  }

  async function enqueueAndFlush(taskId, message, client) {
    const entry = enqueue(taskId, message);
    const flush = await flushOutbox(taskId, client);
    return { entry, flush };
  }

  return {
    enqueue,
    deliverEntry: (taskId, requestId, client) => serializeTask(taskId, () => deliverSingle(taskId, requestId, client)),
    flushOutbox,
    enqueueAndFlush,
  };
}
