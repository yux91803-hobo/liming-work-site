// 平板 liming-cloud 测试用的假云端 dsh web（内存里）。只模拟插件用到、并在真实 0.2.2-rc.3 上实测过的行为：
//   未知对话 session/prompt 报 session/not-found；session/create 同编号同目录的空白对话返回原编号、换目录 session/conflict；
//   同一请求编号只收一次；轮次进行中 steer 插进本轮、queue 排到下一轮；session/follow 先给 snapshot 再逐条给 event；
//   session/cancel 让进行中的一轮以 aborted 结束；job/list 里停掉的后台命令留着 status: killed。
'use strict';

class RpcError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function createFakeCloud() {
  const sessions = new Map();
  const calls = [];

  function session(id) {
    const s = sessions.get(id);
    if (!s) throw new RpcError('session/not-found', `session ${id} not found`);
    return s;
  }
  function push(s, type, data) {
    const event = { seq: ++s.seqBase, type, time: Date.now(), data };
    s.events.push(event);
    for (const w of [...s.watchers]) w(event);
    return event;
  }
  function startTurn(s, msg) {
    s.turn += 1;
    s.running = true;
    push(s, 'turn/start', { turn: s.turn });
    push(s, 'user/message', { role: 'user', content: [{ type: 'text', text: msg.text }], source: { kind: 'user', rpcId: msg.requestId } });
    if (s.autoReply) setImmediate(() => cloud.finishTurn(s.id, s.autoReply(msg)));
  }

  const cloud = {
    sessions,
    calls,
    offline: false,
    stubbornCancel: false,          // 停不下来：cancel 回 accepted 但这一轮照跑
    coldSessions: new Set(),        // 云端重启后没加载的对话：cancel、state、job/list 报 session/not-found（实测）
    // 测试控制：结束当前一轮（AI 说一句话，然后 turn/end）
    finishTurn(id, text = '完成', reason = { kind: 'completed' }) {
      const s = session(id);
      if (!s.running) return;
      if (text) push(s, 'assistant/message', { turn: s.turn, message: { role: 'assistant', content: [{ type: 'text', text }] } });
      push(s, 'turn/end', { turn: s.turn, reason });
      s.running = false;
      const next = s.queue.shift();
      if (next) startTurn(s, next);
    },
    toolCall(id, name, args) {
      const s = session(id);
      push(s, 'tool/call', { turn: s.turn, name, arguments: JSON.stringify(args) });
    },
    addJob(id, job) {
      const s = session(id);
      s.jobs.push({ status: 'running', kind: 'bash', startedAt: Date.now(), ...job });
      push(s, 'job/registered', { jobId: job.id, label: job.label || '' });
    },
    userMessages(id) {
      return session(id).events.filter(e => e.type === 'user/message').map(e => ({ text: e.data.content[0].text, rpcId: e.data.source.rpcId, seq: e.seq }));
    },
    turnStarts(id) {
      return session(id).events.filter(e => e.type === 'turn/start').length;
    },
    client() {
      const guard = (name) => { calls.push(name); if (cloud.offline) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
      return {
        async createSession({ sessionId, cwd }) {
          guard('session/create');
          const s = sessions.get(sessionId);
          if (s) {
            if (s.cwd !== cwd) throw new RpcError('session/conflict', 'cwd differs');
            if (s.turn > 0) {
              const other = `session-${sessions.size + 1}`;
              sessions.set(other, newSession(other, cwd));
              return { sessionId: other };
            }
            return { sessionId };
          }
          sessions.set(sessionId, newSession(sessionId, cwd));
          return { sessionId };
        },
        async prompt(sessionId, text, { requestId, mode = 'queue' } = {}) {
          guard('session/prompt');
          const s = session(sessionId);
          s.prompts.push({ text, requestId, mode });
          if (s.requestIds.has(requestId)) return { accepted: true };
          s.requestIds.add(requestId);
          const msg = { text, requestId };
          if (!s.running) startTurn(s, msg);
          else if (mode === 'steer') push(s, 'user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } });
          else s.queue.push(msg);
          return { accepted: true };
        },
        async cancel(sessionId) {
          guard('session/cancel');
          if (cloud.coldSessions.has(sessionId)) throw new RpcError('session/not-found', 'not attached');
          const s = session(sessionId);
          if (s.running && !cloud.stubbornCancel) cloud.finishTurn(sessionId, '', { kind: 'aborted', reason: { kind: 'user' } });
          return { accepted: true };
        },
        async state(sessionId) {
          guard('session/state');
          if (cloud.coldSessions.has(sessionId)) throw new RpcError('session/not-found', 'not attached');
          const s = session(sessionId);
          return { cursor: s.seqBase, active: true, running: s.running, queue: s.queue.map(q => q.text), pendingInput: [] };
        },
        async listSessions() {
          guard('session/list');
          return { items: [...sessions.values()].map(s => ({ sessionId: s.id, running: s.running, projections: { asOfSeq: s.seqBase } })) };
        },
        async page(sessionId, { beforeSeq, maxMessages = 1000 } = {}) {
          guard('session/page');
          const s = session(sessionId);
          const older = s.events.filter(e => beforeSeq === undefined || e.seq < beforeSeq);
          const records = older.slice(-maxMessages).map(event => ({ type: 'event', event }));
          return { cursor: s.seqBase, records, hasMore: older.length > records.length };
        },
        async rpc(endpoint, args) {
          guard(endpoint);
          if (endpoint === 'session/selectModel') {
            const s = session(args.request.sessionId);
            s.model = { provider: args.request.provider, model: args.request.model };
            return { selected: s.model };
          }
          throw new RpcError('rpc/unknown', endpoint);
        },
        async readJobListOnce(sessionId) {
          guard('job/list');
          if (cloud.coldSessions.has(sessionId)) throw new RpcError('session/not-found', 'not attached');
          return session(sessionId).jobs.map(j => ({ ...j }));
        },
        async killJob(sessionId, jobId) {
          guard('job/kill');
          const j = session(sessionId).jobs.find(x => x.id === jobId);
          if (!j || j.status !== 'running') return { outcome: 'already-finished' };
          if (!j.unkillable) { j.status = 'killed'; j.detail = 'cancelled by the user'; }
          return { outcome: 'requested' };
        },
        followSession(sessionId, { tailRecords = Infinity } = {}) {
          guard('session/follow');
          const s = session(sessionId);
          const queue = [];
          const waiters = [];
          let closed = false;
          const deliver = (frame) => {
            if (closed) return;
            const w = waiters.shift();
            if (w) w.resolve({ done: false, value: frame });
            else queue.push(frame);
          };
          const tail = s.events.slice(-tailRecords);
          queue.push({ type: 'snapshot', cursor: s.seqBase, records: tail.map(event => ({ type: 'event', event })), hasMore: tail.length < s.events.length });
          const watcher = (event) => deliver({ type: 'event', event });
          s.watchers.add(watcher);
          const stream = {
            nextFrame(timeoutMs = 10000) {
              if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
              if (closed) return Promise.resolve({ done: true });
              return new Promise((resolve, reject) => {
                const entry = { resolve, reject };
                waiters.push(entry);
                if (timeoutMs > 0) setTimeout(() => { const i = waiters.indexOf(entry); if (i >= 0) { waiters.splice(i, 1); reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); } }, timeoutMs).unref?.();
              });
            },
            async close() { closed = true; s.watchers.delete(watcher); for (const w of waiters.splice(0)) w.resolve({ done: true }); },
            // 测试控制：模拟断线
            drop() { closed = true; s.watchers.delete(watcher); for (const w of waiters.splice(0)) w.reject(Object.assign(new Error('mux stream disconnected'), { code: 'STREAM_DISCONNECTED' })); },
          };
          s.streams.add(stream);
          return stream;
        },
      };
    },
    dropStreams(id) {
      const s = session(id);
      for (const st of [...s.streams]) st.drop();
      s.streams.clear();
    },
  };

  function newSession(id, cwd) {
    return { id, cwd, events: [], seqBase: 0, turn: 0, running: false, queue: [], requestIds: new Set(), prompts: [], watchers: new Set(), streams: new Set(), jobs: [], model: null, autoReply: null };
  }
  return cloud;
}

// 假的 ctx.jobs：照 dsh-jobs 的 JobSpec / JobHandle / JobHooks 形状
function createFakeJobs() {
  const jobs = new Map();
  let n = 0;
  return {
    jobs,
    start(spec) {
      const id = `${spec.kind}-${(++n).toString(16).padStart(4, '0')}`;
      const rec = { id, spec, output: [], progress: null, outcome: null, hooks: null };
      const handle = { id, append: (t) => { if (!rec.outcome) rec.output.push(t); }, updateProgress: (l) => { rec.progress = l; } };
      rec.hooks = spec.run(handle);
      rec.settled = rec.hooks.done.then(o => { rec.outcome = o; return o; });
      jobs.set(id, rec);
      return id;
    },
    kill(id, reason) { const rec = jobs.get(id); rec.hooks.cancel(reason); return rec.settled; },
    get(id) { return jobs.get(id); },
  };
}

async function until(fn, ms = 3000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) return null;
    await new Promise(r => setTimeout(r, 10));
  }
}

module.exports = { createFakeCloud, createFakeJobs, until, RpcError };
