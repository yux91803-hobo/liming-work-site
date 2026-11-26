// 最小零依赖 dsh web 客户端：GET /?token= 换 dsh-auth-* Cookie、POST /api/<端点> 一元 RPC、
// /api/remote.mux WebSocket 流式订阅、401 自动重登、超时与 AbortSignal 取消。
// 协议对照 DSH Go packages/dsh_client/lib/src/{connection,carrier,rpc,mux}.dart。
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { redactText, redactValue } from './redact.js';

const ENDPOINT_SEGMENT_RE = /^[A-Za-z0-9_$.-]+$/;

export class DshRpcError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${redactText(message)}`);
    this.name = 'DshRpcError';
    this.code = code;
    this.details = redactValue(details);
  }
}

export class DshHttpError extends Error {
  constructor(status, message, body = '') {
    super(redactText(message));
    this.name = 'DshHttpError';
    this.status = status;
    this.code = `HTTP_${status}`;
    this.body = redactText(body);
  }
}

export class DshTransportError extends Error {
  constructor(message, opts = {}) {
    super(redactText(message));
    this.name = 'DshTransportError';
    this.code = opts.code || 'TRANSPORT_ERROR';
    if (opts.closeCode !== undefined) this.closeCode = opts.closeCode;
    if (opts.reason !== undefined) this.reason = redactText(opts.reason);
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export class DshProtocolError extends Error {
  constructor(message) {
    super(redactText(message));
    this.name = 'DshProtocolError';
    this.code = 'PROTOCOL_ERROR';
  }
}

export function checkRemoteEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new DshProtocolError('无效的 Remote endpoint：不能为空');
  }
  const segments = endpoint.split('/');
  if (segments.some(seg => !seg || seg === '.' || seg === '..' || !ENDPOINT_SEGMENT_RE.test(seg))) {
    throw new DshProtocolError(`无效的 Remote endpoint：${endpoint}`);
  }
}

function normalizeBaseUrl(baseUrl) {
  const url = new URL(String(baseUrl));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DshProtocolError(`不支持的协议：${url.protocol}`);
  }
  const cleanPath = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${cleanPath}`;
}

function extractAuthCookie(setCookieHeaders) {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : (setCookieHeaders ? [setCookieHeaders] : []);
  for (const raw of list) {
    const pair = String(raw).split(';')[0].trim();
    if (pair.startsWith('dsh-auth-') && pair.includes('=')) {
      return pair;
    }
  }
  return null;
}

function httpExchange(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = 15000, signal, extraSecrets } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DshTransportError(`${method} 请求已取消`, { code: 'ABORTED' }));
      return;
    }
    const url = new URL(urlString);
    const mod = url.protocol === 'https:' ? https : http;
    const reqHeaders = { ...headers };
    let payload = null;
    if (body !== null && body !== undefined) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      reqHeaders['content-length'] = String(payload.length);
    }

    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      try { req.destroy(); } catch {}
      fail(new DshTransportError(`${method} ${url.pathname} 请求已取消`, { code: 'ABORTED' }));
    };

    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', err => fail(new DshTransportError(
          redactText(`${method} ${url.pathname} 读取响应失败：${err.message}`, extraSecrets),
          { code: 'SOCKET_ERROR', cause: err },
        )));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    req.on('error', (err) => {
      fail(new DshTransportError(
        redactText(`${method} ${url.pathname} 连接失败：${err.message}`, extraSecrets),
        { code: 'SOCKET_ERROR', cause: err },
      ));
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { req.destroy(); } catch {}
        fail(new DshTransportError(`${method} ${url.pathname} 超时（${timeoutMs}ms）`, { code: 'TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (payload) req.write(payload);
    req.end();
  });
}

export class DshClient {
  constructor(options = {}) {
    if (typeof options === 'string') {
      options = { baseUrl: options, cookieHeader: arguments[1] };
    }
    if (!options.baseUrl) {
      throw new DshProtocolError('DshClient 需要 baseUrl');
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.hostHeader = options.hostHeader || null;
    this.cookieHeader = options.cookieHeader || null;
    this.launchToken = options.token || null;
    this.onTokenRefresh = typeof options.onTokenRefresh === 'function' ? options.onTokenRefresh : null;
    this.defaultTimeoutMs = options.timeoutMs || 15000;
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this._loginInFlight = null;
    this._activeStreams = new Set();
  }

  static async login(baseUrl, token, opts = {}) {
    const client = new DshClient({ ...opts, baseUrl, token });
    await client.login(token, opts);
    return client;
  }

  _secrets() {
    const list = [];
    if (this.launchToken) list.push(this.launchToken);
    if (this.cookieHeader) list.push(this.cookieHeader);
    return list;
  }

  _baseHeaders(extra = {}) {
    const headers = { ...extra };
    if (this.hostHeader) headers.host = this.hostHeader;
    return headers;
  }

  async login(token = this.launchToken, { timeoutMs = this.defaultTimeoutMs, signal } = {}) {
    if (!token || typeof token !== 'string') {
      throw new DshHttpError(401, '缺少 dsh web 启动令牌，无法登录');
    }
    this.launchToken = token;
    const secrets = this._secrets();
    const res = await httpExchange(`${this.baseUrl}/?token=${encodeURIComponent(token)}`, {
      method: 'GET',
      headers: this._baseHeaders(),
      timeoutMs,
      signal,
      extraSecrets: secrets,
    });
    if (res.statusCode === 401) {
      throw new DshHttpError(401, 'dsh web 启动令牌被拒绝（401）', redactText(res.body.slice(0, 200), secrets));
    }
    if (res.statusCode !== 303 && res.statusCode !== 302) {
      throw new DshHttpError(
        res.statusCode,
        `dsh web 登录返回非预期状态码 HTTP ${res.statusCode}`,
        redactText(res.body.slice(0, 200), secrets),
      );
    }
    const authCookie = extractAuthCookie(res.headers['set-cookie']);
    if (!authCookie) {
      throw new DshProtocolError('dsh web 登录重定向响应缺少 dsh-auth-* Cookie');
    }
    this.cookieHeader = authCookie;
    return authCookie;
  }

  async _relogin({ timeoutMs = this.defaultTimeoutMs, signal } = {}) {
    if (this._loginInFlight) return this._loginInFlight;
    const task = (async () => {
      this.cookieHeader = null;
      if (this.launchToken) {
        try {
          return await this.login(this.launchToken, { timeoutMs, signal });
        } catch (err) {
          if (!(err instanceof DshHttpError && err.status === 401 && this.onTokenRefresh)) {
            throw err;
          }
        }
      }
      if (this.onTokenRefresh) {
        const fresh = await this.onTokenRefresh();
        if (fresh) return await this.login(fresh, { timeoutMs, signal });
      }
      throw new DshHttpError(401, 'dsh web 会话失效且无法重新获取启动令牌');
    })();
    this._loginInFlight = task;
    try {
      return await task;
    } finally {
      if (this._loginInFlight === task) this._loginInFlight = null;
    }
  }

  async ensureLoggedIn(opts = {}) {
    if (this.cookieHeader) return this.cookieHeader;
    return this._relogin(opts);
  }

  async checkHealth({ timeoutMs = 5000, signal } = {}) {
    try {
      const headers = this._baseHeaders();
      if (this.cookieHeader) headers.cookie = this.cookieHeader;
      const res = await httpExchange(`${this.baseUrl}/`, {
        method: 'GET',
        headers,
        timeoutMs,
        signal,
        extraSecrets: this._secrets(),
      });
      if (res.statusCode === 200) return 'ok';
      if (res.statusCode === 401 || res.statusCode === 403) return 'unauthorized';
      return 'unreachable';
    } catch {
      return 'unreachable';
    }
  }

  async rpc(endpoint, args = {}, { timeoutMs = this.defaultTimeoutMs, signal, retryAuth = true } = {}) {
    checkRemoteEndpoint(endpoint);
    if (!this.cookieHeader && (this.launchToken || this.onTokenRefresh)) {
      await this.ensureLoggedIn({ timeoutMs, signal });
    }
    const rpcId = randomUUID();
    const body = JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    });
    const headers = this._baseHeaders({ 'content-type': 'application/json' });
    if (this.cookieHeader) headers.cookie = this.cookieHeader;
    const secrets = this._secrets();

    const res = await httpExchange(`${this.baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers,
      body,
      timeoutMs,
      signal,
      extraSecrets: secrets,
    });

    if (res.statusCode === 401 && retryAuth && (this.launchToken || this.onTokenRefresh)) {
      await this._relogin({ timeoutMs, signal });
      return this.rpc(endpoint, args, { timeoutMs, signal, retryAuth: false });
    }

    if (res.statusCode !== 200) {
      throw new DshHttpError(
        res.statusCode,
        `RPC /api/${endpoint} 返回 HTTP ${res.statusCode}`,
        redactText(res.body.slice(0, 300), secrets),
      );
    }

    let env;
    try {
      env = JSON.parse(res.body);
    } catch {
      throw new DshProtocolError(`RPC /api/${endpoint} 返回非 JSON 内容`);
    }
    if (!env || env.type !== 'server-response' || !env.result || typeof env.result !== 'object') {
      throw new DshProtocolError(`RPC /api/${endpoint} 返回了非法 server-response 信封`);
    }
    if (env.result.ok === true) return env.result.value;
    const err = env.result.error || { code: 'unknown', message: 'remote error' };
    throw new DshRpcError(
      err.code || 'unknown',
      redactText(err.message || 'remote error', secrets),
      redactValue(err.details || {}, secrets),
    );
  }

  openStream(endpoint, args = {}, { signal, openTimeoutMs = this.defaultTimeoutMs, retryAuth = true } = {}) {
    checkRemoteEndpoint(endpoint);
    const client = this;
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/api/remote.mux`;
    const streamId = randomUUID();
    const WS = this.WebSocketImpl;

    const queue = [];
    const waiters = [];
    const uplinkQueue = [];
    let ws = null;
    let opened = false;
    let closed = false;
    let endedGracefully = false;
    let closedByCaller = false;
    let failure = null;

    function wakeAll() {
      while (waiters.length > 0 && (queue.length > 0 || failure || closed)) {
        const w = waiters.shift();
        if (queue.length > 0) w.resolve({ done: false, value: queue.shift() });
        else if (failure) w.reject(failure);
        else w.resolve({ done: true, value: undefined });
      }
    }

    function failStream(err) {
      if (!failure) failure = err;
      closed = true;
      wakeAll();
    }

    const onAbort = () => {
      if (closed) return;
      closedByCaller = true;
      try { ws?.close(); } catch {}
      failStream(new DshTransportError(`mux 流 ${endpoint} 已取消`, { code: 'ABORTED' }));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    async function connectSocket(allowRetryAuth) {
      if (closed) return;
      if (!client.cookieHeader && (client.launchToken || client.onTokenRefresh)) {
        await client.ensureLoggedIn({ timeoutMs: openTimeoutMs, signal });
      }
      if (closed) return;

      await new Promise((resolve, reject) => {
        const headers = {};
        if (client.cookieHeader) headers.Cookie = client.cookieHeader;
        if (client.hostHeader) headers.Host = client.hostHeader;
        let sock;
        try {
          sock = new WS(wsUrl, { headers });
        } catch (err) {
          reject(new DshTransportError(`无法创建 mux WebSocket：${err.message}`, { code: 'WS_CREATE_FAILED', cause: err }));
          return;
        }
        ws = sock;
        let openSettled = false;
        let didOpen = false;
        const openTimer = openTimeoutMs > 0
          ? setTimeout(() => {
            if (openSettled) return;
            openSettled = true;
            try { sock.close(); } catch {}
            reject(new DshTransportError(`mux 连接 ${endpoint} 超时（${openTimeoutMs}ms）`, { code: 'TIMEOUT' }));
          }, openTimeoutMs)
          : null;
        openTimer?.unref?.();

        sock.addEventListener('open', () => {
          if (openTimer) clearTimeout(openTimer);
          openSettled = true;
          didOpen = true;
          if (closed) {
            try { sock.close(); } catch {}
            resolve();
            return;
          }
          opened = true;
          sock.send(JSON.stringify({
            type: 'open',
            streamId,
            endpoint,
            payload: { args },
          }));
          while (uplinkQueue.length > 0 && sock.readyState === WS.OPEN) {
            sock.send(uplinkQueue.shift());
          }
          resolve();
        });

        sock.addEventListener('message', (ev) => {
          if (closed || ws !== sock) return;
          let frame;
          try {
            frame = JSON.parse(String(ev.data));
          } catch {
            failStream(new DshProtocolError(`mux 流 ${endpoint} 收到非法 JSON 帧`));
            try { sock.close(); } catch {}
            return;
          }
          if (!frame || frame.streamId !== streamId) return;
          if (frame.type === 'item') {
            queue.push(frame.value);
            wakeAll();
          } else if (frame.type === 'end') {
            endedGracefully = true;
            closed = true;
            wakeAll();
          } else if (frame.type === 'error') {
            const e = frame.error || {};
            const secrets = client._secrets();
            failStream(new DshRpcError(
              e.code || 'stream/error',
              redactText(e.message || 'stream error', secrets),
              redactValue(e.details || {}, secrets),
            ));
          }
        });

        sock.addEventListener('error', (ev) => {
          if (ws !== sock) return;
          const msg = redactText(ev?.message || ev?.error?.message || 'websocket error', client._secrets());
          if (!openSettled) {
            if (openTimer) clearTimeout(openTimer);
            openSettled = true;
            reject(new DshTransportError(`mux 流 ${endpoint} 连接错误：${msg}`, { code: 'STREAM_ERROR' }));
            return;
          }
          if (didOpen && !closed && !endedGracefully && !closedByCaller) {
            failStream(new DshTransportError(`mux 流 ${endpoint} 意外断开：${msg}`, { code: 'STREAM_DISCONNECTED' }));
          }
        });

        sock.addEventListener('close', (ev) => {
          if (ws !== sock) return;
          if (openTimer) clearTimeout(openTimer);
          if (!openSettled) {
            openSettled = true;
            reject(new DshTransportError(
              `mux 流 ${endpoint} 握手前关闭（code=${ev?.code ?? 'unknown'}）`,
              { code: 'STREAM_DISCONNECTED', closeCode: ev?.code, reason: ev?.reason },
            ));
            return;
          }
          if (!didOpen) return;
          if (!closed && !endedGracefully && !closedByCaller) {
            failStream(new DshTransportError(
              `mux 流 ${endpoint} 意外断开（code=${ev?.code ?? 'unknown'}）`,
              { code: 'STREAM_DISCONNECTED', closeCode: ev?.code, reason: ev?.reason },
            ));
          } else {
            closed = true;
            wakeAll();
          }
        });
      }).catch(async (err) => {
        if (!closed && allowRetryAuth && (client.launchToken || client.onTokenRefresh)) {
          const health = await client.checkHealth({ timeoutMs: Math.min(openTimeoutMs, 5000), signal });
          if (health === 'unauthorized') {
            await client._relogin({ timeoutMs: openTimeoutMs, signal });
            return connectSocket(false);
          }
        }
        throw err;
      });
    }

    const readyPromise = closed
      ? Promise.reject(failure || new DshTransportError('stream closed', { code: 'ABORTED' }))
      : connectSocket(retryAuth).catch((err) => {
        failStream(err);
      });

    function nextFrame(timeoutMs = 10000) {
      if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() });
      if (failure) return Promise.reject(failure);
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve, reject) => {
        const entry = {
          resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
          reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
        };
        const timer = timeoutMs > 0
          ? setTimeout(() => {
            const idx = waiters.indexOf(entry);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(new DshTransportError(`mux 流 ${endpoint} 等待下一帧超时（${timeoutMs}ms）`, { code: 'TIMEOUT' }));
          }, timeoutMs)
          : null;
        timer?.unref?.();
        waiters.push(entry);
      });
    }

    function send(value) {
      if (closed) throw new DshTransportError(`mux 流 ${endpoint} 已关闭`, { code: 'STREAM_CLOSED' });
      const payload = JSON.stringify({ type: 'item', streamId, value });
      if (opened && ws && ws.readyState === WS.OPEN) ws.send(payload);
      else uplinkQueue.push(payload);
    }

    function endUplink() {
      if (closed) return;
      const payload = JSON.stringify({ type: 'end', streamId });
      if (opened && ws && ws.readyState === WS.OPEN) ws.send(payload);
      else uplinkQueue.push(payload);
    }

    async function close() {
      if (closedByCaller && closed) return;
      closedByCaller = true;
      closed = true;
      client._activeStreams.delete(handle);
      if (signal) signal.removeEventListener('abort', onAbort);
      try {
        if (opened && ws && ws.readyState === WS.OPEN) {
          ws.send(JSON.stringify({ type: 'cancel', streamId }));
        }
      } catch {}
      try { ws?.close(); } catch {}
      wakeAll();
    }

    const handle = {
      streamId,
      endpoint,
      ready: readyPromise,
      nextFrame,
      send,
      endUplink,
      close,
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const step = await nextFrame(0);
            if (step.done) break;
            yield step.value;
          }
        } finally {
          await close();
        }
      },
    };

    this._activeStreams.add(handle);
    return handle;
  }

  async close() {
    const streams = [...this._activeStreams];
    this._activeStreams.clear();
    await Promise.all(streams.map(s => s.close().catch(() => {})));
  }

  createSession({ sessionId, cwd }, opts = {}) {
    const request = { cwd };
    if (sessionId !== undefined) request.sessionId = sessionId;
    return this.rpc('session/create', { request }, opts);
  }

  listSessions(opts = {}) {
    return this.rpc('session/list', { _request: {} }, opts);
  }

  prompt(sessionId, text, { requestId = randomUUID(), mode = 'queue', ...opts } = {}) {
    return this.rpc('session/prompt', {
      request: {
        requestId,
        sessionId,
        mode,
        content: [{ type: 'text', text }],
      },
    }, opts);
  }

  cancel(sessionId, opts = {}) {
    return this.rpc('session/cancel', { request: { sessionId } }, opts);
  }

  page(sessionId, pageOpts = {}, rpcOpts = {}) {
    const request = { address: { kind: 'session', sessionId } };
    if (pageOpts.throughSeq !== undefined) request.throughSeq = pageOpts.throughSeq;
    if (pageOpts.beforeSeq !== undefined) request.beforeSeq = pageOpts.beforeSeq;
    if (pageOpts.maxMessages !== undefined) request.maxMessages = pageOpts.maxMessages;
    return this.rpc('session/page', { request }, rpcOpts);
  }

  state(sessionId, opts = {}) {
    return this.rpc('session/state', { request: { sessionId } }, opts);
  }

  killJob(sessionId, jobId, opts = {}) {
    return this.rpc('job/kill', { request: { sessionId, jobId } }, opts);
  }

  followSession(sessionId, { activate = false, ...opts } = {}) {
    const request = { address: { kind: 'session', sessionId } };
    if (activate) request.activate = true;
    return this.openStream('session/follow', { request }, opts);
  }

  watchJobs(sessionId, opts = {}) {
    return this.openStream('job/list', { request: { sessionId } }, opts);
  }

  openSessionControl(sessionId, opts = {}) {
    return this.openStream('session/control', { request: { sessionId } }, opts);
  }

  async readJobListOnce(sessionId, { timeoutMs = 8000, signal } = {}) {
    const stream = this.watchJobs(sessionId, { signal, openTimeoutMs: timeoutMs });
    try {
      const first = await stream.nextFrame(timeoutMs);
      if (first.done) return [];
      return Array.isArray(first.value?.jobs) ? first.value.jobs : [];
    } finally {
      await stream.close();
    }
  }
}

export function createDshClient(options) {
  return new DshClient(options);
}
