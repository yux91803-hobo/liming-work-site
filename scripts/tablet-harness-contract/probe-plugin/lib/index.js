// 契约验证探针插件：零外部依赖，仅用 Node 内置模块与 Harness 公开 ctx 服务。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export const name = 'tablet-contract-probe';
export const inject = ['tools', 'jobs', 'agents', 'sessions'];

function textFromMessage(msg) {
  if (!msg || !Array.isArray(msg.content)) return '';
  return msg.content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');
}

function isNoticeForTask(event, task) {
  if (!event || event.type !== 'user/message' || !event.data) return null;
  const src = event.data.source;
  if (!src || src.form !== 'notice') return null;
  const text = textFromMessage(event.data);
  if (src.kind === 'tool-jobs') {
    if ((task.jobId && text.includes(task.jobId)) || (task.taskId && text.includes(task.taskId))) {
      return 'tool-jobs';
    }
  }
  if (src.kind === 'liming-cloud' && src.taskId === task.taskId) {
    return 'liming-cloud';
  }
  return null;
}

export function apply(ctx) {
  const probeDir = process.env.CONTRACT_PROBE_DIR;
  if (!probeDir) return;
  fs.mkdirSync(probeDir, { recursive: true });

  const eventsFile = path.join(probeDir, 'events.jsonl');
  const ledgerFile = path.join(probeDir, 'ledger.json');
  const controlFile = path.join(probeDir, 'control.json');

  function logEvent(ev) {
    fs.appendFileSync(eventsFile, JSON.stringify({ at: Date.now(), ...ev }) + '\n');
  }

  function readLedger() {
    try {
      return JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    } catch {
      return { tasks: {} };
    }
  }

  function writeLedger(data) {
    const tmp = `${ledgerFile}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, ledgerFile);
  }

  function updateTask(taskId, mutator) {
    const ledger = readLedger();
    const cur = ledger.tasks[taskId] || { taskId };
    ledger.tasks[taskId] = mutator(cur);
    writeLedger(ledger);
    return ledger.tasks[taskId];
  }

  const liveJobs = new Map(); // taskId -> { jobId, sessionId, resolveDone, settled }

  function registerProbeJob({ sessionId, taskId, label, toolCall }) {
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const entry = { taskId, sessionId, jobId: null, settled: false, resolveDone: null };
    const settleOnce = (outcome) => {
      if (entry.settled) return;
      entry.settled = true;
      resolveDone(outcome);
    };
    entry.resolveDone = settleOnce;

    const jobId = ctx.jobs.start({
      kind: 'cloud',
      label: label || `cloud task ${taskId}`,
      owner: sessionId,
      ...(toolCall ? { toolCall } : {}),
      run(handle) {
        handle.updateProgress(`running ${taskId}`);
        return {
          done,
          cancel(reason) {
            logEvent({
              type: 'job/cancel',
              taskId,
              jobId: handle.id,
              sessionId,
              reason: reason === undefined ? null : reason,
            });
            settleOnce({ status: 'killed', detail: reason });
          },
        };
      },
    });
    entry.jobId = jobId;
    liveJobs.set(taskId, entry);
    updateTask(taskId, () => ({
      taskId,
      sessionId,
      jobId,
      status: 'running',
      noticeState: 'none',
      summary: '',
      confirmedBy: null,
      confirmedSeq: null,
    }));
    logEvent({ type: 'job/started', taskId, jobId, sessionId });
    return { taskId, jobId };
  }

  // 注册一个使用标准 JSON Schema（required 为数组）的探针工具，供 E7b 测模型调 job_kill，同时核验 §11 Schema 约束。
  ctx.tools.register({
    name: 'probe_start_job',
    description: 'Start a controllable background cloud probe job for contract testing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: 'Unique task identifier.' },
        label: { type: 'string', description: 'Short task label.' },
      },
      required: ['task_id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          jobId: { type: 'string' },
        },
        required: ['taskId', 'jobId'],
      },
      render: (_args, value) => [{ type: 'text', text: `started probe job ${value.jobId} for task ${value.taskId}` }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.id;
      if (!sessionId) throw new Error('probe_start_job requires an active agent');
      return registerProbeJob({
        sessionId,
        taskId: args.task_id,
        label: args.label || `probe ${args.task_id}`,
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
      });
    },
  });

  // 监听代理忙闲事件（验证 §11 liming-lease 依赖的 agent/status）
  ctx.on('agent/status', ({ agent, status }) => {
    logEvent({ type: 'agent/status', sessionId: agent.id, status });
  });

  // 进程内监听 session/event：只有确认通知写进日志后才把台账改成 confirmed（设计 §5.5 & §7 补验 1）
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return;
    const ledger = readLedger();
    let changed = false;
    for (const task of Object.values(ledger.tasks)) {
      if (task.sessionId !== session.id) continue;
      if (task.noticeState === 'confirmed') continue;
      const via = isNoticeForTask(event, task);
      if (!via) continue;
      task.noticeState = 'confirmed';
      task.confirmedBy = via;
      task.confirmedSeq = event.seq;
      task.confirmedMessageId = event.data.id;
      changed = true;
      logEvent({
        type: 'notice/confirmed',
        taskId: task.taskId,
        jobId: task.jobId,
        sessionId: session.id,
        via,
        seq: event.seq,
        messageId: event.data.id,
      });
    }
    if (changed) writeLedger(ledger);
  });

  // 重启后代理加载出现时检查「完成未告诉」：先查日志去重，找不到才补投一次（设计 §5.5 & §7 补验 2）
  ctx.on('agent/created', ({ agent, source }) => {
    logEvent({ type: 'agent/created', sessionId: agent.id, source });
    const ledger = readLedger();
    const pendingTasks = Object.values(ledger.tasks).filter(
      t => t.sessionId === agent.id && t.status === 'completed' && t.noticeState === 'pending',
    );
    if (pendingTasks.length === 0) return;

    const existingEvents = typeof agent.session.snapshotEvents === 'function'
      ? agent.session.snapshotEvents()
      : [];
    const toDeliver = [];
    let ledgerChanged = false;

    for (const task of pendingTasks) {
      const hit = existingEvents.find(ev => isNoticeForTask(ev, task) !== null);
      if (hit) {
        const via = isNoticeForTask(hit, task);
        task.noticeState = 'confirmed';
        task.confirmedBy = `${via}:dedup-on-load`;
        task.confirmedSeq = hit.seq;
        ledgerChanged = true;
        logEvent({
          type: 'notice/deduped',
          taskId: task.taskId,
          sessionId: agent.id,
          via,
          seq: hit.seq,
        });
      } else {
        toDeliver.push(task);
      }
    }
    if (ledgerChanged) writeLedger(ledger);

    if (toDeliver.length > 0) {
      setImmediate(() => {
        const live = ctx.agents.get(agent.id);
        if (!live) return;
        for (const task of toDeliver) {
          const msg = Object.freeze({
            id: randomUUID(),
            role: 'user',
            content: [{
              type: 'text',
              text: `[liming-cloud] 云端任务 ${task.taskId} 已完成：${task.summary || '完成'}`,
            }],
            source: Object.freeze({
              kind: 'liming-cloud',
              form: 'notice',
              summary: `云端任务 ${task.taskId} 已完成`,
              taskId: task.taskId,
            }),
          });
          const method = live.status === 'idle' ? 'followup' : 'inject';
          logEvent({
            type: 'notice/catchup-sent',
            taskId: task.taskId,
            sessionId: agent.id,
            method,
            messageId: msg.id,
          });
          if (method === 'followup') live.followup(msg);
          else live.inject(msg);
        }
      });
    }
  });

  // 本地控制 HTTP 服务，供契约测试驱动后台任务起停与读取台账
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/ledger') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(readLedger()));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404); res.end(); return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (pathname === '/start-job') {
          const started = registerProbeJob({
            sessionId: body.sessionId,
            taskId: body.taskId,
            label: body.label,
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(started));
          return;
        }
        if (pathname === '/finish-job') {
          const entry = liveJobs.get(body.taskId);
          if (!entry) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `unknown live taskId ${body.taskId}` }));
            return;
          }
          const status = body.status || 'completed';
          const summary = body.result || `done ${body.taskId}`;
          // 先写台账「完成，通知未确认」，再结算后台任务（设计 §5.5 步骤 1 -> 2）
          const beforeSettle = updateTask(body.taskId, cur => ({
            ...cur,
            status,
            noticeState: 'pending',
            summary,
          }));
          logEvent({
            type: 'task/marked-pending',
            taskId: body.taskId,
            jobId: entry.jobId,
            noticeState: beforeSettle.noticeState,
          });
          entry.resolveDone({ status, result: summary });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, taskId: body.taskId, jobId: entry.jobId, beforeSettle }));
          return;
        }
        if (pathname === '/seed-pending-notice') {
          const rec = updateTask(body.taskId, () => ({
            taskId: body.taskId,
            sessionId: body.sessionId,
            jobId: body.jobId || `cloud-seed-${body.taskId}`,
            status: 'completed',
            noticeState: 'pending',
            summary: body.summary || `seeded result ${body.taskId}`,
            confirmedBy: null,
            confirmedSeq: null,
          }));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(rec));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `unknown route ${pathname}` }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });

  ctx.effect(() => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      fs.writeFileSync(controlFile, JSON.stringify({ port, pid: process.pid }), { mode: 0o600 });
      logEvent({ type: 'probe/ready', port, pid: process.pid });
    });
    return () => {
      try { fs.rmSync(controlFile, { force: true }); } catch {}
      server.closeAllConnections?.();
      return new Promise(resolve => server.close(() => resolve()));
    };
  });
}
