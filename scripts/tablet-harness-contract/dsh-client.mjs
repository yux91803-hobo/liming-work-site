// 最小零依赖 dsh web 客户端：登录换 cookie、POST /api/<端点> 一元 RPC、/api/remote.mux 流式订阅。
// 协议对照 DSH Go packages/dsh_client/lib/src/{connection,carrier,rpc_envelope,mux}.dart。
import { randomUUID } from 'node:crypto';

export class DshRpcError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'DshRpcError';
    this.code = code;
    this.details = details;
  }
}

export class DshClient {
  constructor(baseUrl, cookieHeader) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cookieHeader = cookieHeader;
  }

  static async login(baseUrl, token) {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const res = await fetch(`${cleanBase}/?token=${encodeURIComponent(token)}`, {
      method: 'GET',
      redirect: 'manual',
    });
    if (res.status !== 303 && res.status !== 302) {
      const body = await res.text().catch(() => '');
      throw new Error(`dsh web login failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    let authPair = null;
    for (const raw of setCookies) {
      const first = String(raw).split(';')[0].trim();
      if (first.startsWith('dsh-auth-')) {
        authPair = first;
        break;
      }
    }
    if (!authPair) {
      throw new Error(`dsh web login returned no dsh-auth cookie (headers: ${JSON.stringify(setCookies)})`);
    }
    return new DshClient(cleanBase, authPair);
  }

  async rpc(endpoint, args = {}, { timeoutMs = 15000 } = {}) {
    const rpcId = randomUUID();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`RPC ${endpoint} timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: this.cookieHeader,
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: endpoint,
          payload: { args },
        }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (res.status !== 200) {
        throw new Error(`HTTP ${res.status} from /api/${endpoint}: ${text.slice(0, 300)}`);
      }
      const env = JSON.parse(text);
      if (env?.type !== 'server-response' || !env.result) {
        throw new Error(`invalid server-response from ${endpoint}: ${text.slice(0, 300)}`);
      }
      if (env.result.ok === true) return env.result.value;
      const err = env.result.error || { code: 'unknown', message: text };
      throw new DshRpcError(err.code || 'unknown', err.message || 'remote error', err.details || {});
    } finally {
      clearTimeout(timer);
    }
  }

  openStream(endpoint, args = {}) {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/remote.mux';
    const streamId = randomUUID();
    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: this.cookieHeader },
    });
    const queue = [];
    const waiters = [];
    let closed = false;
    let failure = null;

    function wakeAll() {
      while (waiters.length > 0 && (queue.length > 0 || closed || failure)) {
        const w = waiters.shift();
        if (queue.length > 0) w.resolve({ done: false, value: queue.shift() });
        else if (failure) w.reject(failure);
        else w.resolve({ done: true, value: undefined });
      }
    }

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint,
        payload: { args },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let frame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch (err) {
        failure = err;
        wakeAll();
        return;
      }
      if (frame.streamId !== streamId) return;
      if (frame.type === 'item') {
        queue.push(frame.value);
        wakeAll();
      } else if (frame.type === 'end') {
        closed = true;
        wakeAll();
      } else if (frame.type === 'error') {
        const e = frame.error || {};
        failure = new DshRpcError(e.code || 'stream/error', e.message || 'stream error', e.details || {});
        wakeAll();
      }
    });
    ws.addEventListener('error', (ev) => {
      if (!closed && !failure) {
        failure = new Error(`mux websocket error on ${endpoint}: ${ev?.message || 'socket error'}`);
        wakeAll();
      }
    });
    ws.addEventListener('close', () => {
      closed = true;
      wakeAll();
    });

    function nextFrame(timeoutMs = 10000) {
      if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() });
      if (failure) return Promise.reject(failure);
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`stream ${endpoint} timed out waiting for frame (${timeoutMs}ms)`));
        }, timeoutMs);
        const entry = {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        };
        waiters.push(entry);
      });
    }

    async function close() {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'cancel', streamId }));
        }
      } catch {}
      try { ws.close(); } catch {}
      closed = true;
      wakeAll();
    }

    return { nextFrame, close };
  }

  createSession({ sessionId, cwd }) {
    const request = { cwd };
    if (sessionId !== undefined) request.sessionId = sessionId;
    return this.rpc('session/create', { request });
  }

  listSessions() {
    return this.rpc('session/list', { _request: {} });
  }

  prompt(sessionId, text, { requestId = randomUUID(), mode = 'queue' } = {}) {
    return this.rpc('session/prompt', {
      request: {
        requestId,
        sessionId,
        mode,
        content: [{ type: 'text', text }],
      },
    });
  }

  cancel(sessionId) {
    return this.rpc('session/cancel', { request: { sessionId } });
  }

  page(sessionId, opts = {}) {
    const request = { address: { kind: 'session', sessionId } };
    if (opts.throughSeq !== undefined) request.throughSeq = opts.throughSeq;
    if (opts.beforeSeq !== undefined) request.beforeSeq = opts.beforeSeq;
    if (opts.maxMessages !== undefined) request.maxMessages = opts.maxMessages;
    return this.rpc('session/page', { request });
  }

  state(sessionId) {
    return this.rpc('session/state', { request: { sessionId } });
  }

  archiveSession(sessionId, { stopActivity = true } = {}) {
    return this.rpc('workspace/archiveSession', { request: { sessionId, stopActivity } });
  }

  killJob(sessionId, jobId) {
    return this.rpc('job/kill', { request: { sessionId, jobId } });
  }

  async readJobListOnce(sessionId, timeoutMs = 8000) {
    const stream = this.openStream('job/list', { request: { sessionId } });
    try {
      const first = await stream.nextFrame(timeoutMs);
      if (first.done) return [];
      return Array.isArray(first.value?.jobs) ? first.value.jobs : [];
    } finally {
      await stream.close();
    }
  }

  async activateSession(sessionId, timeoutMs = 10000) {
    const stream = this.openStream('session/follow', {
      request: {
        address: { kind: 'session', sessionId },
        activate: true,
      },
    });
    try {
      const frame = await stream.nextFrame(timeoutMs);
      return frame.value;
    } finally {
      await stream.close();
    }
  }

  async readAllEvents(sessionId) {
    const p = await this.page(sessionId, { maxMessages: 500 });
    return (p.records || []).map(r => r.event).filter(Boolean);
  }
}
