// 小芯内核（第 1 步）：云电脑上常驻的 HTTP 外壳。设计见 docs/xin-kernel-design.md §4、§10 第 1 步、§14。
// 只用 node 内置模块，不 import 别的 vm-*.mjs：Worker 把它单独按内容哈希上传（vm-kernel-<hash>.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const KERNEL_PORT = 8797;
const SELF = fileURLToPath(import.meta.url);
// 上传到电脑上的文件名是 vm-kernel-<sha256 前 12 位>.mjs；健康检查据此认版本（本地直接跑时是 dev）
export const KERNEL_VERSION = (/^vm-kernel-([0-9a-f]{12})\.mjs$/.exec(path.basename(SELF)) || [])[1] || 'dev';
// 请求体上限按字节算：Worker 那边最多放进来 65536 个字符（src/xin.js），全是中文时约 19 万字节，这里要收得下
const BODY_MAX = 262144, OUT_MAX = 4 * 1024 * 1024, ERR_TAIL = 8192;
export const AUTH_WINDOW_MS = 300000, NONCE_KEEP_MS = 600000;

/* ---------- 第二层认证（§14.5） ----------
   X-Xin-Auth: XinKernel-HMAC-SHA256 kid=<kid>,ts=<毫秒>,nonce=<base64url 16 字节>,sig=<base64url>
   钥匙是 Durable Object 随机生成的 32 字节，和 InstaBox 端口令牌、站长密码都无关；Worker 的签名在 src/xin-kernel.js。 */
export function canonical({ method, target, ts, nonce, bodySha256 }) {
  return ['xin-kernel-v1', String(method).toUpperCase(), target, String(ts), nonce, bodySha256].join('\n');
}
export function parseAuth(header) {
  const m = /^XinKernel-HMAC-SHA256 kid=([A-Za-z0-9_-]{1,40}),ts=(\d{1,16}),nonce=([A-Za-z0-9_-]{16,64}),sig=([A-Za-z0-9_-]{43})$/.exec(String(header || ''));
  return m ? { kid: m[1], ts: Number(m[2]), nonce: m[3], sig: m[4] } : null;
}
// 钥匙文件 {"v":1,"keys":{"<kid>":"<base64url 32 字节>"}}：修改时间变了才重读；软链接、坏文件都当没有钥匙
export class KeyRing {
  constructor(file) { this.file = file; this.stamp = null; this.map = new Map(); }
  keys() {
    let st = null;
    try { st = fs.lstatSync(this.file); } catch { /* 没有文件 */ }
    const stamp = st ? [st.ino, st.size, st.mtimeMs, st.isSymbolicLink()].join(':') : 'none';
    if (stamp === this.stamp) return this.map;
    this.stamp = stamp; this.map = new Map();
    if (!st || !st.isFile()) return this.map;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && d.v === 1 && d.keys && typeof d.keys === 'object')
        for (const [kid, v] of Object.entries(d.keys)) {
          const key = typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(kid) ? Buffer.from(v, 'base64url') : null;
          if (key && key.length === 32) this.map.set(kid, key);
        }
    } catch { this.map = new Map(); }
    return this.map;
  }
}
// 用过的随机数存在内核自己的 SQLite 里：内核重启了也认得；超过 10 分钟的顺手删掉
export class NonceStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') try { fs.chmodSync(file, 0o600); } catch { /* 刚建的文件 */ }
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    this.prune = this.db.prepare('DELETE FROM nonces WHERE at < ?');
    this.add = this.db.prepare('INSERT OR IGNORE INTO nonces(nonce, at) VALUES(?, ?)');
  }
  seen(nonce, now) {
    this.prune.run(now - NONCE_KEEP_MS);
    return this.add.run(nonce, now).changes === 0;
  }
}
export function verifyRequest({ method, target, header, body, keys, nonces, now }) {
  if (!header) return { ok: false, reason: 'missing' };
  const a = parseAuth(header);
  if (!a) return { ok: false, reason: 'malformed' };
  const key = keys.get(a.kid);
  if (!key) return { ok: false, reason: 'unknown_kid' };
  if (Math.abs(now - a.ts) > AUTH_WINDOW_MS) return { ok: false, reason: 'expired' };
  const bodySha256 = crypto.createHash('sha256').update(body == null ? '' : body).digest('hex');
  const want = crypto.createHmac('sha256', key).update(canonical({ method, target, ts: a.ts, nonce: a.nonce, bodySha256 })).digest();
  const got = Buffer.from(a.sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, reason: 'bad_sig' };
  if (nonces.seen(a.nonce, now)) return { ok: false, reason: 'replay' };
  return { ok: true, kid: a.kid };
}
// 日志和给 Worker 的错误信息里不留令牌、密钥、签名（规则和 src/xin-kernel.js 的 redact 一样）
export function redact(text) {
  return String(text ?? '').replace(/\b(?:ibp|ibk|iba)_[A-Za-z0-9_-]+/g, '<hidden>').replace(/\bBearer\s+\S+/gi, 'Bearer <hidden>').replace(/\bsig=[^,\s]+/g, 'sig=<hidden>');
}

/* ---------- 状态进程看护（第 2 步第 2 批，docs/superpowers/plans/2026-11-15-xin-state-owner-switch.md） ----------
   内核模式下唯一写状态库的是常驻状态进程（node vm-agent-<hash>.mjs serve --parent-pipe），由外壳拉起、看住。
   - 期望（模式 + 代号）随 /xin/op 来，代号由 Durable Object 在看到新部署时加一；只认不比已见代号小的期望，
     刷新部署时新旧两版 isolate 同时在线也不会来回切。期望存在 kernel-owner.json，外壳自己重启后不等请求就拉起。
   - 同版本的请求经本机套接字交给它；别的照旧起控制器，那一版控制器自己经桥交给主人。
   - 状态进程意外退出：记录留在 kernel（停着不写，#140），按退避重起；连续 giveUpMs 起不来才改回旧模式、推送一次，
     这一代号不再试，代号变大（新部署）才重新开始。
   - 要旧模式、换版本、外壳正常停止：先发控制命令 release 让它排空交回 legacy。
   只用内置模块：套接字协议和 vm-kernel-client.mjs 的一样（测试核对协议号）。 */
export const BRIDGE_PROTOCOL = 1;
const STATE_FRAME_MAX = 4 * 1024 * 1024;
const stateError = (code, executed) => Object.assign(new Error(code), { code, executed });
export function stateCall(home, request, { timeoutMs = 60000 } = {}) {
  const id = crypto.randomUUID();
  let body;
  try { body = Buffer.from(JSON.stringify({ ...request, v: BRIDGE_PROTOCOL, id }) + '\n'); } catch { return Promise.reject(stateError('state_request', false)); }
  if (body.length > STATE_FRAME_MAX) return Promise.reject(stateError('state_too_large', false));
  return new Promise((resolve, reject) => {
    let sent = false, done = false, size = 0;
    const parts = [], socket = net.createConnection(path.join(home, 'run', 'state.sock'));
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => finish(stateError('state_timeout', sent ? 'unknown' : false)), timeoutMs);
    socket.on('connect', () => { sent = true; socket.end(body); });
    socket.on('error', () => finish(stateError('owner_unavailable', sent ? 'unknown' : false)));
    socket.on('data', b => {
      size += b.length;
      if (size > STATE_FRAME_MAX) return finish(stateError('state_too_large', 'unknown'));
      parts.push(b); const data = Buffer.concat(parts), end = data.indexOf(10);
      if (end < 0) return;
      let r; try { r = JSON.parse(data.subarray(0, end).toString('utf8')); } catch { return finish(stateError('state_response', 'unknown')); }
      if (!r || r.v !== BRIDGE_PROTOCOL || r.id !== id) return finish(stateError('state_response', 'unknown'));
      if (!r.ok) return finish(stateError(r.error || 'state_response', r.executed === false ? false : 'unknown'));
      finish(null, r.result);
    });
    socket.on('close', () => finish(stateError('state_disconnected', sent ? 'unknown' : false)));
  });
}
const agentHash = a => (/vm-agent-([0-9a-f]{12})\.mjs$/.exec(a || '') || [])[1] || null;
// 每个操作留最近 200 次走套接字的耗时（毫秒）
function opStats() {
  const by = new Map(), all = [];
  const push = (list, ms) => { list.push(ms); if (list.length > 200) list.shift(); };
  const sum = list => { const s = [...list].sort((a, b) => a - b), at = q => s[Math.min(s.length - 1, Math.floor(q * s.length))]; return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] }; };
  return {
    add(op, ms) { ms = Math.round(ms * 10) / 10; push(all, ms); if (!by.has(op)) by.set(op, []); push(by.get(op), ms); },
    summary() { return all.length ? { all: sum(all), byOp: Object.fromEntries([...by].map(([k, v]) => [k, sum(v)])) } : { all: { n: 0 }, byOp: {} }; }
  };
}
export function createStateKeeper({ home, env = process.env, clock = () => performance.now(), backoffMs = [1000, 2000, 5000, 10000, 30000, 60000],
  giveUpMs = 180000, readyMs = 60000, hardMs = 60000, log = () => {}, spawnImpl = spawn } = {}) {
  const desireFile = path.join(home, 'kernel-owner.json');
  const s = { want: null, gen: -1, agent: null, phase: 'off', child: null, epoch: null, pid: null, readyAt: 0, restarts: 0, failures: 0,
    failingSince: null, lastError: null, fallbackGen: null, timer: null, closed: false };
  let waiters = [];
  const wake = () => { const ws = waiters; waiters = []; for (const w of ws) w.done(route(w.agent) === 'socket'); };
  // 一次性跑控制器的一个命令（owner-legacy、pushq）：不经过 runAgent，不算进 spawns
  function runOnce(agent, args, timeoutMs, { detached = false } = {}) {
    return new Promise(resolve => {
      let c, out = '';
      try { c = spawnImpl(process.execPath, [agent, ...args], { env: { ...env, XIN_HOME: home }, stdio: ['ignore', detached ? 'ignore' : 'pipe', 'ignore'], detached }); }
      catch { resolve(null); return; }
      if (detached) { c.on('error', () => {}); c.unref(); resolve(null); return; }
      const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* 已经退出 */ } }, timeoutMs);
      c.stdout.on('data', b => { out += b; });
      c.on('error', () => { clearTimeout(timer); resolve(null); });
      c.on('close', () => { clearTimeout(timer); let r = null; try { r = JSON.parse(out); } catch { /* 看不懂 */ } resolve(r); });
    });
  }
  function persist() {
    const tmp = desireFile + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify({ mode: s.want, gen: s.gen, agent: s.agent }), { mode: 0o600 }); fs.renameSync(tmp, desireFile); }
    catch { try { fs.unlinkSync(tmp); } catch { /* 没写成 */ } }
  }
  function route(agent) {
    if (!s.child || s.child.agent !== agent) return 'spawn';
    return s.phase === 'running' ? 'socket' : s.phase === 'starting' ? 'wait' : 'spawn';
  }
  function reconcile() {
    if (s.closed) return;
    const wanted = s.want === 'kernel' && !!s.agent && !(s.fallbackGen !== null && s.gen <= s.fallbackGen);
    if (s.child) { if (s.phase !== 'stopping' && (!wanted || s.child.agent !== s.agent)) stop(); return; }
    if (!wanted) { clearTimeout(s.timer); if (s.phase !== 'fallback') s.phase = 'off'; return; }
    if (s.phase !== 'waiting') start();
  }
  function start() {
    const agent = s.agent, t0 = clock();
    let child;
    s.phase = 'starting'; s.epoch = null; s.pid = null;
    try { child = spawnImpl(process.execPath, [agent, 'serve', '--parent-pipe'], { env: { ...env, XIN_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { failed('spawn_failed'); return; }
    child.agent = agent; s.child = child;
    log({ event: 'start', agent: agentHash(agent) });
    let out = '', err = '', ready = false, readyTimedOut = false;
    const readyTimer = setTimeout(() => { if (!ready) { readyTimedOut = true; try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } } }, readyMs);
    child.stdin.on('error', () => {}); child.on('error', () => {});
    child.stdout.on('data', b => {
      if (ready) return;
      out += b; const nl = out.indexOf('\n');
      if (nl < 0) { if (out.length > 4096) out = out.slice(-4096); return; }
      let r = null; try { r = JSON.parse(out.slice(0, nl)); } catch { /* 不是就绪那一行 */ }
      if (!r || r.ready !== true) { out = out.slice(nl + 1); return; }
      ready = true; clearTimeout(readyTimer); child.readyAt = clock();
      if (s.child !== child || s.phase !== 'starting') return;
      Object.assign(s, { phase: 'running', epoch: Number.isSafeInteger(r.epoch) ? r.epoch : null, pid: child.pid, readyAt: Date.now() });
      log({ event: 'ready', agent: agentHash(agent), epoch: s.epoch, ms: Math.round(clock() - t0) });
      wake();
    });
    child.stderr.on('data', b => { err = (err + b.toString('utf8')).slice(-ERR_TAIL); });
    child.on('exit', (code, signal) => {
      clearTimeout(readyTimer);
      if (s.child !== child) return;
      s.child = null; s.epoch = null; s.pid = null;
      log({ event: 'exit', agent: agentHash(agent), code, signal });
      const stopping = s.phase === 'stopping';
      if (stopping || s.closed) { s.phase = 'off'; child.stopped?.(); reconcile(); wake(); return; }
      if (ready && clock() - child.readyAt >= 60000) { s.failures = 0; s.failingSince = null; }
      if (ready) s.restarts++;
      const reason = (/\b((?:state|owner)_[a-z_]+)/.exec(err) || [])[1] || (readyTimedOut ? 'state_ready_timeout' : 'exit ' + (signal || code));
      failed(reason);
      wake();
    });
  }
  function failed(reason) {
    s.failures++; s.lastError = reason;
    if (s.failingSince === null) s.failingSince = clock();
    if (s.want === 'kernel' && clock() - s.failingSince >= giveUpMs) { giveUp(); return; }
    s.phase = 'waiting'; clearTimeout(s.timer);
    s.timer = setTimeout(() => { if (s.phase === 'waiting') { s.phase = 'off'; reconcile(); } }, backoffMs[Math.min(s.failures - 1, backoffMs.length - 1)]);
  }
  async function giveUp() {
    const agent = s.agent;
    s.phase = 'fallback'; s.fallbackGen = s.gen; clearTimeout(s.timer);
    log({ event: 'giveup', agent: agentHash(agent), reason: s.lastError });
    const r = await runOnce(agent, ['owner-legacy'], 10000);
    log({ event: 'reset', agent: agentHash(agent), ok: !!(r && r.ok) });
    runOnce(agent, ['pushq', JSON.stringify({ title: '小芯', body: '常驻状态进程起不来，已自动改回旧方式：' + s.lastError, tag: 'xin-owner', url: '/#xin' })], 0, { detached: true });
  }
  // 让它排空交回 legacy；没在听（还在启动）就关标准输入，退出以后用 owner-legacy 补上（主人已经换人就不会改）
  function stop(waitMs = 60000) {
    const child = s.child;
    if (!child || s.phase === 'stopping') return child?.stopping || Promise.resolve();
    s.phase = 'stopping';
    log({ event: 'stop', agent: agentHash(child.agent) });
    child.stopping = new Promise(resolve => { child.stopped = resolve; });
    stateCall(home, { kind: 'control', op: 'release', mode: 'legacy' }, { timeoutMs: waitMs })
      .catch(() => { try { child.stdin.end(); } catch { /* 已经关了 */ } });
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } }, waitMs);
    return child.stopping.then(async () => { clearTimeout(kill); if (s.want !== 'kernel' || s.closed) await runOnce(child.agent, ['owner-legacy'], 10000); });
  }
  return {
    want({ mode, gen, agent }) {
      if (s.closed || !Number.isSafeInteger(gen) || gen < s.gen) return false;
      const changed = mode !== s.want || gen !== s.gen || agent !== s.agent;
      if (s.fallbackGen !== null && gen > s.fallbackGen) Object.assign(s, { fallbackGen: null, failures: 0, failingSince: null, phase: s.phase === 'fallback' ? 'off' : s.phase });
      Object.assign(s, { want: mode, gen, agent });
      if (changed) persist();
      reconcile();
      return true;
    },
    route,
    ready(agent, ms) {
      const r = route(agent);
      if (r !== 'wait') return Promise.resolve(r === 'socket');
      return new Promise(resolve => {
        const w = { agent, done: v => { clearTimeout(timer); resolve(v); } };
        const timer = setTimeout(() => { waiters = waiters.filter(x => x !== w); resolve(route(agent) === 'socket'); }, ms);
        waiters.push(w);
      });
    },
    async call(request, { timeoutMs = hardMs } = {}) {
      const child = s.child;
      const hard = setTimeout(() => { if (child && s.child === child) { log({ event: 'hard_limit', agent: agentHash(child.agent) }); try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } } }, hardMs);
      try { return await stateCall(home, request, { timeoutMs: Math.max(timeoutMs, hardMs + 1000) }); }
      finally { clearTimeout(hard); }
    },
    summary() {
      return { want: s.want, mode: s.phase === 'running' ? 'kernel' : 'legacy', epoch: s.epoch, phase: s.phase, gen: s.gen < 0 ? null : s.gen,
        agent: agentHash(s.child?.agent || s.agent), pid: s.pid, up: s.phase === 'running' ? Date.now() - s.readyAt : null,
        restarts: s.restarts, failures: s.failures, lastError: s.lastError, fallback: s.phase === 'fallback' };
    },
    seen: () => s.gen >= 0,
    async close({ release = false } = {}) {
      if (s.closed) return; s.closed = true; clearTimeout(s.timer);
      if (!s.child) return;
      if (release) await Promise.race([stop(20000), new Promise(r => setTimeout(r, 25000))]);
      else { try { s.child.stdin.end(); } catch { /* 已经关了 */ } }
    },
    // 外壳启动时：上次存下的期望是 kernel、控制器文件还在，就不等请求马上拉起
    resume(agentOk = () => true) {
      let d = null; try { d = JSON.parse(fs.readFileSync(desireFile, 'utf8')); } catch { return; }
      if (d && d.mode === 'kernel' && Number.isSafeInteger(d.gen) && d.gen >= 0 && agentOk(d.agent) && fs.existsSync(d.agent)) this.want(d);
    }
  };
}

/* ---------- HTTP 外壳（§4.2、§14.2） ----------
   第 1 步不改控制器：/xin/op 在本机起 `node vm-agent-<hash>.mjs <op>`，参数走标准输入，和 InstaBox exec 一模一样。
   每个回应都带 X-Xin-Kernel 头；出错时 executed 说清楚控制器到底跑没跑，Worker 据此决定能不能退回 exec。
   对方断开（超时、网络断）时不杀已经起来的控制器：让它做完并存下结果，同一编号再来就拿到存下的结果。 */
const OP_NAME = /^[a-z][a-z0-9_]{0,39}$/, AGENT_NAME = /^vm-agent-[0-9a-f]{12}\.mjs$/;
export async function createKernel({ home, port = 0, env = process.env, now = Date.now, opTimeoutMs = 40000, maxConcurrent = 16, logFile, logMaxBytes = 2 * 1024 * 1024,
  pollEveryMs = 250, keepWatchMs = 4000, heartbeatMs = 15000, maxStreamMs = 600000, keeper: keeperOptions = {}, readyWaitMs = 15000 }) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const agentDir = path.join(home, 'agent'), ring = new KeyRing(path.join(home, 'kernel-keys.json'));
  const nonces = new NonceStore(path.join(home, 'kernel.sqlite'));
  logFile = logFile || path.join(home, 'logs', 'kernel.jsonl');
  const started = now();
  let running = 0;
  // 只记时间、方法、路由、操作名、状态码、耗时、clientId；不记请求头、请求体、钥匙、签名、令牌和消息内容
  const log = rec => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify({ at: now(), ...rec }) + '\n', { mode: 0o600 });
      if (fs.statSync(logFile).size > logMaxBytes) fs.renameSync(logFile, logFile + '.1');   // 只留当前和上一份，不会一直长
    } catch { /* 日志写不下不影响请求 */ }
  };
  const reply = (res, status, body) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-xin-kernel': KERNEL_VERSION });
    res.end(JSON.stringify(body));
  };
  const agentOk = a => typeof a === 'string' && path.dirname(a) === agentDir && AGENT_NAME.test(path.basename(a));
  // 状态进程看护：内核模式下操作和轮询经本机套接字交给它；spawns 数外壳起了几次控制器（内核模式下应当不再增加）
  let spawns = 0;
  const stats = opStats(), keeper = createStateKeeper({ home, env, log: rec => log({ route: 'state', ...rec }), ...keeperOptions });
  const ownerView = () => ({ ...keeper.summary(), spawns });
  const OWNER_OK = o => !!o && typeof o === 'object' && (o.mode === 'kernel' || o.mode === 'legacy') && Number.isSafeInteger(o.gen) && o.gen >= 0;
  async function viaState(op, args, rec) {
    rec.via = 'state';
    const t0 = performance.now(), call = keeper.call({ kind: 'op', op, args, locked: false });
    // 等它的计时器做完就清掉：外壳常驻，不能每次操作都留一个 opTimeoutMs 长的计时器
    let timer; const r = await Promise.race([call.then(v => ({ v }), e => ({ e })), new Promise(ok => { timer = setTimeout(() => ok({ timeout: true }), opTimeoutMs); })]);
    clearTimeout(timer);
    if (r.timeout) return [200, { ok: false, executed: 'unknown', error: 'agent_timeout', msg: '状态进程超过 ' + Math.round(opTimeoutMs / 1000) + ' 秒没做完' }];
    if (r.e) return r.e.executed === false ? [503, { ok: false, executed: false, error: 'owner_unavailable', retryAfter: 3 }]
      : [200, { ok: false, executed: 'unknown', error: typeof r.e.code === 'string' ? r.e.code : 'state_failed' }];
    stats.add(op, performance.now() - t0);
    return [200, { ok: true, data: r.v }];
  }
  // 起一次控制器：结果 {code, stdout, stderr, timedOut}；起不来时 {spawnError}
  function runAgent(agent, op, args) {
    return new Promise(resolve => {
      let child;
      try { child = spawn(process.execPath, [agent, op], { env, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (e) { resolve({ spawnError: String(e && e.message || e) }); return; }
      running++; spawns++;
      let out = [], outLen = 0, err = '', timedOut = false, done = false, code = null;
      const finish = extra => { if (done) return; done = true; running--; clearTimeout(timer); clearTimeout(grace); resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: err, timedOut, ...extra }); };
      const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } }, opTimeoutMs);
      let grace = null;
      child.stdout.on('data', b => { if (outLen < OUT_MAX) { out.push(b); outLen += b.length; } });
      child.stderr.on('data', b => { err = (err + b.toString('utf8')).slice(-ERR_TAIL); });
      child.on('error', e => finish({ spawnError: String(e && e.message || e) }));
      // 控制器起的后台进程都是 stdio:'ignore'，正常会等到 close；万一有谁拿着管道不放，退出后最多再等 2 秒
      child.on('exit', c => { code = c; grace = setTimeout(() => finish(), 2000); });
      child.on('close', c => { if (code == null) code = c; finish(); });
      child.stdin.on('error', () => { /* 子进程没读就退出了 */ });
      child.stdin.end(JSON.stringify(args || {}));
    });
  }
  async function op(body, rec) {
    let d;
    try { d = JSON.parse(body); } catch { return [400, { ok: false, executed: false, error: 'bad_request' }]; }
    if (!d || !agentOk(d.agent) || !OP_NAME.test(d.op || '') || (d.args != null && (typeof d.args !== 'object' || Array.isArray(d.args))) ||
        (d.owner !== undefined && !OWNER_OK(d.owner))) return [400, { ok: false, executed: false, error: 'bad_request' }];
    rec.op = d.op;
    if (d.args && typeof d.args.clientId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(d.args.clientId)) rec.id = d.args.clientId;
    if (!fs.existsSync(d.agent)) return [409, { ok: false, executed: false, error: 'agent_missing' }];
    // 期望（模式 + 代号）先交给看护；同版本的状态进程在跑就走套接字，还在启动就等一会儿
    if (d.owner) keeper.want({ mode: d.owner.mode, gen: d.owner.gen, agent: d.agent });
    let route = keeper.route(d.agent);
    if (route === 'wait') { await keeper.ready(d.agent, readyWaitMs); route = keeper.route(d.agent); }
    if (route === 'socket') return viaState(d.op, d.args || {}, rec);
    if (running >= maxConcurrent) return [503, { ok: false, executed: false, error: 'kernel_busy' }];
    const r = await runAgent(d.agent, d.op, d.args || {});
    if (r.spawnError) return [500, { ok: false, executed: false, error: 'spawn_failed', msg: redact(r.spawnError) }];
    if (r.timedOut) return [200, { ok: false, executed: true, error: 'agent_timeout', msg: '控制器超过 ' + Math.round(opTimeoutMs / 1000) + ' 秒没做完，已停止' }];
    const tail = redact(r.stderr.trim().split('\n').slice(-3).join(' '));
    if (r.code !== 0) return [200, { ok: false, executed: true, error: 'agent_failed', msg: 'vm-agent 出错（退出码 ' + r.code + '）：' + tail }];
    try { return [200, { ok: true, data: JSON.parse(r.stdout) }]; }
    catch { return [200, { ok: false, executed: true, error: 'agent_output', msg: 'vm-agent 的输出看不懂' }]; }
  }
  /* 流（§14.3）：只是传输方式变了——运行记录一变就调一次控制器的 poll，把结果原样推出去，不拆、不攒。
     没变化也每 keepWatchMs 调一次，保住控制器那边「有人在看」的标记（它 8 秒没人看就改发通知）。 */
  const RUN = /^r[0-9a-z]{6,24}$/, DEVICE = /^[A-Za-z0-9_-]{8,64}$/;
  const pause = ms => new Promise(r => setTimeout(r, ms));
  async function stream(req, res, url, rec, t0) {
    const q = url.searchParams, agent = q.get('agent'), run = q.get('run') || '';
    rec.op = 'stream';
    if (!agentOk(agent) || !RUN.test(run)) return [400, { ok: false, executed: false, error: 'bad_request' }];
    if (!fs.existsSync(agent)) return [409, { ok: false, executed: false, error: 'agent_missing' }];
    const base = { run, watching: q.get('watching') === '1' };
    for (const k of ['deviceId', 'tabId']) if (DEVICE.test(q.get(k) || '')) base[k] = q.get(k);
    let off = Math.max(0, parseInt(q.get('off') || '0', 10) || 0), pos = /^\d+$/.test(q.get('pos') || '') ? Number(q.get('pos')) : null;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-xin-kernel': KERNEL_VERSION });
    res.flushHeaders();
    let closed = false; res.on('close', () => { closed = true; });
    const file = path.join(home, 'runs', run + '.jsonl'), end = now() + maxStreamMs;
    let stamp = null, lastPoll = -Infinity, lastBeat = now(), why = 'timeout';
    const stampOf = () => { try { const st = fs.statSync(file); return st.size + ':' + st.mtimeMs; } catch { return 'none'; } };
    while (!closed && now() < end) {
      const cur = stampOf();
      if ((cur !== stamp || now() - lastPoll >= keepWatchMs) && running < maxConcurrent) {
        stamp = cur; lastPoll = now();
        const args = { ...base, off, ...(pos != null ? { pos } : {}) };
        let d = null;
        if (keeper.route(agent) === 'socket') {   // 内核模式：轮询也交给状态进程，不起控制器
          const t1 = performance.now();
          try { d = await keeper.call({ kind: 'op', op: 'poll', args, locked: false }, { timeoutMs: opTimeoutMs }); stats.add('poll', performance.now() - t1); } catch { d = null; }
        } else {
          const r = await runAgent(agent, 'poll', args);
          try { d = r.code === 0 && !r.timedOut ? JSON.parse(r.stdout) : null; } catch { d = null; }
        }
        if (closed) break;
        if (!d || d.error) { res.write('event: error\ndata: ' + JSON.stringify(d && d.error ? d : { error: 'poll_failed' }) + '\n\n'); why = 'error'; break; }
        const evs = Array.isArray(d.events) ? d.events : [];
        if (evs.length || d.done) { res.write('id: ' + (typeof d.pos === 'number' ? d.pos : d.off) + '\ndata: ' + JSON.stringify(d) + '\n\n'); lastBeat = now(); }
        if (Number.isInteger(d.off)) off = d.off;
        pos = typeof d.pos === 'number' ? d.pos : null;
        if (d.done) { why = 'done'; break; }
        if (evs.length >= 400) stamp = null;   // poll 一次最多给 400 条：还有就马上接着取
      }
      if (now() - lastBeat >= heartbeatMs) { res.write(': hb\n\n'); lastBeat = now(); }
      await pause(pollEveryMs);
    }
    if (closed) why = 'closed';
    res.end();
    log({ ...rec, status: 200, ms: now() - t0, reason: why });
    return null;
  }
  const server = http.createServer(async (req, res) => {
    const t0 = now(), url = new URL(req.url, 'http://kernel'), rec = { method: req.method, route: url.pathname };
    const answer = (status, body) => { reply(res, status, body); log({ ...rec, status, ms: now() - t0, ...(body.error ? { error: body.error } : {}), ...(body.reason ? { reason: body.reason } : {}) }); };
    try {
      const chunks = []; let size = 0, tooBig = false;
      for await (const c of req) { size += c.length; if (size > BODY_MAX) { tooBig = true; break; } chunks.push(c); }
      if (tooBig) { answer(413, { ok: false, executed: false, error: 'too_large' }); req.destroy(); return; }
      const body = Buffer.concat(chunks).toString('utf8');
      const auth = verifyRequest({ method: req.method, target: req.url, header: req.headers['x-xin-auth'], body, keys: ring.keys(), nonces, now: now() });
      if (!auth.ok) { answer(401, { ok: false, executed: false, error: 'kernel_auth', reason: auth.reason }); return; }
      if (req.method === 'GET' && url.pathname === '/xin/health') { answer(200, { ok: true, kernel: KERNEL_VERSION, pid: process.pid, up: now() - started, spawns, owner: ownerView(), ops: stats.summary() }); return; }
      if (req.method === 'POST' && url.pathname === '/xin/op') {
        const [status, b] = await op(body, rec);
        // 收到过期望以后，每个回应都带上状态由谁在管；usage 再带各操作的耗时（用量页显示）
        answer(status, keeper.seen() ? { ...b, owner: ownerView(), ...(rec.op === 'usage' ? { ops: stats.summary() } : {}) } : b);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/xin/stream') { const r = await stream(req, res, url, rec, t0); if (r) answer(r[0], r[1]); return; }
      answer(404, { ok: false, executed: false, error: 'not_found' });
    } catch (e) {
      answer(500, { ok: false, executed: false, error: 'kernel_error', msg: redact(String(e && e.message || e)) });
    }
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });
  keeper.resume(agentOk);   // 上次存下的期望是内核模式：不等请求就拉起状态进程
  return {
    port: server.address().port,
    // release：外壳正常停止（换版本、回滚时 systemctl stop）先让状态进程排空交回 legacy；只关管道时状态进程保留 kernel 记录（#140）
    close: async ({ release = false } = {}) => {
      await keeper.close({ release });
      await new Promise(ok => { server.close(() => { try { nonces.db.close(); } catch { /* 已关 */ } ok(); }); server.closeAllConnections(); });
    }
  };
}

/* ---------- 常驻和升级（§5.1）：ensure / serve ----------
   Worker 经 InstaBox exec 跑 `node vm-kernel-<hash>.mjs ensure --port 8797`：
   - 在启动门内把 exec 的环境存成 kernel.env.json（0600），serve 起控制器时照用（PATH、TMPDIR、DISPLAY…）；
   - 同版本且持久配置/启用/主进程一致时复用；临时单元也要迁移；
   - 用持久 systemd 用户服务常驻：KillMode=process（停内核不连带杀掉后台进程，它们自己活着）、
     Restart=always（挂了自动重启）；电脑上没有用户总线时直接起一个脱离的进程（挂了由 Worker 下次 ensure 拉起）。 */
const UNIT = 'xin-kernel';
const SERVICE_UNIT = 'xin-kernel-resident.service';
const homeDir = () => process.env.XIN_HOME || path.join(os.homedir(), '.xin');
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function busEnv(env) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0, e = { ...env }, dir = '/run/user/' + uid;
  if (!e.XDG_RUNTIME_DIR) e.XDG_RUNTIME_DIR = dir;
  if (!e.DBUS_SESSION_BUS_ADDRESS) e.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + dir + '/bus';
  return e;
}
function hasBus() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const which = c => (process.env.PATH || '/usr/bin:/bin').split(':').some(d => d && fs.existsSync(path.join(d, c)));
  return fs.existsSync(process.env.XIN_SYSTEMD_BUS || '/run/user/' + uid + '/bus') && which('systemctl');
}
// 启动门继续使用兼容旧版的 PID 文件；暂停/慢安装不能仅因超过 30 秒就抢走活进程的门。
function takeLock(file, waitMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const deadline = Date.now() + waitMs; ;) {
    try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
    catch (e) { if (e.code !== 'EEXIST') return false; }
    let pid = 0;
    try { pid = Number(fs.readFileSync(file, 'utf8')) || 0; } catch { continue; }
    if (!pid || !alive(pid)) { try { fs.unlinkSync(file); } catch { /* 别人删了 */ } continue; }
    if (Date.now() > deadline) return false;
    sleepSync(200);
  }
}
async function localHealth(home, port) {
  const keys = new KeyRing(path.join(home, 'kernel-keys.json')).keys(), first = [...keys][0];
  if (!first) return null;
  const [kid, key] = first, ts = Date.now(), nonce = crypto.randomBytes(16).toString('base64url');
  const bodySha256 = crypto.createHash('sha256').update('').digest('hex');
  const sig = crypto.createHmac('sha256', key).update(canonical({ method: 'GET', target: '/xin/health', ts, nonce, bodySha256 })).digest('base64url');
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/xin/health', { headers: { 'x-xin-auth': `XinKernel-HMAC-SHA256 kid=${kid},ts=${ts},nonce=${nonce},sig=${sig}` }, signal: AbortSignal.timeout(2000) });
    const d = await r.json();
    return d && d.ok ? d : null;
  } catch { return null; }
}
const SERVICE_MARK = '# Managed by xin-kernel';
function unitWord(value, exec = false) {
  if (/[\r\n\0]/.test(value)) throw Error('bad_service_value');
  let v = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  if (exec) v = v.replaceAll('$', '$$');
  return '"' + v + '"';
}
export function kernelServiceUnit(home, port) {
  const argv = [process.execPath, SELF, 'serve', '--port', String(port)];
  // 重启有上限：端口被别的外壳占着（回滚到不认识这个单元的旧版）时，起不来 10 次就停在 failed，不再每 2 秒空转；
  // 下一次 ensure 先 stop、reset-failed 再 start，照常接回来。
  return [SERVICE_MARK, '[Unit]', 'Description=Xin resident kernel', 'StartLimitIntervalSec=60', 'StartLimitBurst=10', '', '[Service]',
    'Type=simple', 'ExecStart=' + argv.map(v => unitWord(v, true)).join(' '),
    'Environment=' + unitWord('XIN_HOME=' + home), 'WorkingDirectory=%h',
    'KillMode=process', 'Restart=always', 'RestartSec=2', '', '[Install]', 'WantedBy=default.target', ''].join('\n');
}
function writeServiceUnit(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  finally { try { fs.unlinkSync(tmp); } catch { /* 没有暂存文件 */ } }
}
function readServiceUnit(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 65536) throw Error('service_not_regular');
    return fs.readFileSync(file, 'utf8');
  } catch(e) { if (e.code === 'ENOENT') return null; throw e; }
}
function restoreService(tx, ctl) {
  try {
    const current = readServiceUnit(tx.file);
    if (current !== null && current !== tx.target && current !== tx.prior) return false;
    if (tx.phase === 'activation') {
      const fragment = (ctl(['show', SERVICE_UNIT, '--property=FragmentPath', '--value']).stdout || '').trim();
      if (fragment && ctl(['stop', SERVICE_UNIT]).status !== 0) return false;
    }
    if (!tx.enabled && ctl(['disable', SERVICE_UNIT]).status !== 0 && (current !== null || (ctl(['is-enabled', SERVICE_UNIT]).stdout || '').trim() === 'enabled')) return false;
    if (tx.prior !== null) writeServiceUnit(tx.file, tx.prior);
    else if (current !== null) fs.unlinkSync(tx.file);
    if (ctl(['daemon-reload']).status !== 0) return false;
    if (tx.enabled && ctl(['enable', tx.file]).status !== 0) return false;
    if (tx.prior !== null && tx.running && tx.phase === 'activation' && ctl(['start', SERVICE_UNIT]).status !== 0) return false;
    if (tx.legacyRunning && tx.phase === 'activation') {
      const fragment = (ctl(['show', UNIT + '.service', '--property=FragmentPath', '--value']).stdout || '').trim();
      if (fragment) { if (ctl(['start', UNIT + '.service']).status !== 0) return false; }
      else {
        const r = spawnSync('systemd-run', ['--user', '--unit=' + UNIT, '--collect', '-p', 'KillMode=process', '-p', 'Restart=always', '-p', 'RestartSec=2', process.execPath, tx.legacyFile, 'serve', '--port', String(tx.port)], { env: busEnv(process.env), timeout: 15000, stdio: 'ignore' });
        if (r.status !== 0) return false;
      }
    }
    return true;
  } catch { return false; }
}
async function ensure(port) {
  const home = homeDir(), out = r => process.stdout.write(JSON.stringify(r));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, 'locks', 'kernel.lock'), locked = takeLock(lock, 10000);
  try {
    let cur = await localHealth(home, port);
    if (!locked) return out(cur && cur.kernel === KERNEL_VERSION ? { ok: true, already: true, pid: cur.pid, persistent: false, busy: true } : { ok: false, error: 'locked' });
    const envFile = path.join(home, 'kernel.env.json'), tmp = envFile + '.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(process.env), { mode: 0o600 }); fs.renameSync(tmp, envFile);
    const bus = hasBus(), env = busEnv(process.env), unit = UNIT + '.service';
    const ctl = args => spawnSync('systemctl', ['--user', ...args], { env, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const must = args => { const r = ctl(args); if (r.status !== 0) throw Error('service_' + args[0] + '_failed'); return r; };
    const waitHealth = async (expected = KERNEL_VERSION) => {
      for (const deadline = Date.now() + 8000; Date.now() < deadline; await new Promise(r => setTimeout(r, 200))) {
        const h = await localHealth(home, port); if (h && (!expected || h.kernel === expected)) return h;
      }
      return null;
    };
    let serviceError = null;
    if (bus) {
      const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', SERVICE_UNIT);
      const pendingFile = path.join(home, 'kernel-service.pending.json');
      let prior = null, transaction = null, recovering = false;
      try {
        const pending = readServiceUnit(pendingFile);
        if (pending !== null) {
          recovering = true;
          const tx = JSON.parse(pending);
          if (tx.v !== 1 || tx.file !== file || !['prepared', 'activation'].includes(tx.phase) || typeof tx.enabled !== 'boolean' || typeof tx.running !== 'boolean' || typeof tx.legacyRunning !== 'boolean' || (tx.legacyRunning && (!Number.isInteger(tx.port) || tx.port < 1 || tx.port > 65535 || typeof tx.legacyFile !== 'string' || path.dirname(tx.legacyFile) !== path.dirname(SELF) || !/^vm-kernel-[a-f0-9]{12}\.mjs$/.test(path.basename(tx.legacyFile)))) || typeof tx.target !== 'string' || !tx.target.startsWith(SERVICE_MARK + '\n') || (tx.prior !== null && (typeof tx.prior !== 'string' || !tx.prior.startsWith(SERVICE_MARK + '\n')))) throw Error('service_pending_invalid');
          if (!restoreService(tx, ctl)) throw Error('service_recovery_failed');
          fs.unlinkSync(pendingFile); recovering = false; cur = await localHealth(home, port);
        }
        prior = readServiceUnit(file);
        if (prior !== null && !prior.startsWith(SERVICE_MARK + '\n')) throw Error('service_unmanaged');
        const text = kernelServiceUnit(home, port), fragment = (ctl(['show', SERVICE_UNIT, '--property=FragmentPath', '--value']).stdout || '').trim();
        const residentPid = Number((ctl(['show', SERVICE_UNIT, '--property=MainPID', '--value']).stdout || '').trim());
        if (fragment && fragment !== file) throw Error('service_unmanaged');
        const legacy = (ctl(['show', unit, '--property=FragmentPath', '--value']).stdout || '').trim();
        if (legacy && !/^\/run\/user\/\d+\/systemd\/transient\/xin-kernel\.service$/.test(legacy)) throw Error('service_unmanaged');
        const enabled = (ctl(['is-enabled', SERVICE_UNIT]).stdout || '').trim() === 'enabled';
        if (prior === text && fragment === file && enabled && cur && cur.pid === residentPid && cur.kernel === KERNEL_VERSION) return out({ ok: true, already: true, pid: cur.pid, systemd: true, persistent: true });
        const legacyRunning = !!cur && cur.pid !== residentPid && !!legacy && /^[a-f0-9]{12}$/.test(cur.kernel);
        transaction = { v: 1, file, prior, target: text, enabled, running: !!cur && cur.pid === residentPid, legacyRunning, legacyFile: legacyRunning ? path.join(path.dirname(SELF), 'vm-kernel-' + cur.kernel + '.mjs') : null, port, phase: 'prepared' };
        writeServiceUnit(pendingFile, JSON.stringify(transaction));
        if (prior !== text) writeServiceUnit(file, text);
        // 独立名字不依赖旧 transient 单元的 cgroup 清空；后台执行进程可继续存活。
        must(['enable', file]);
        transaction.phase = 'activation'; writeServiceUnit(pendingFile, JSON.stringify(transaction));
        if (legacy) must(['stop', unit]);
        if (fragment) { must(['stop', SERVICE_UNIT]); ctl(['reset-failed', SERVICE_UNIT]); }
        if (cur && cur.pid && alive(cur.pid)) { try { process.kill(cur.pid, 'SIGTERM'); } catch { /* 已经退出 */ } }
        must(['daemon-reload']); must(['start', SERVICE_UNIT]);
        const h = await waitHealth(); if (!h) throw Error('service_not_healthy');
        const loaded = (must(['show', SERVICE_UNIT, '--property=FragmentPath', '--value']).stdout || '').trim();
        if (loaded !== file || Number((must(['show', SERVICE_UNIT, '--property=MainPID', '--value']).stdout || '').trim()) !== h.pid || (must(['is-enabled', SERVICE_UNIT]).stdout || '').trim() !== 'enabled') throw Error('service_not_persistent');
        fs.unlinkSync(pendingFile); transaction = null;
        return out({ ok: true, started: true, pid: h.pid, systemd: true, persistent: true });
      } catch(e) {
        serviceError = String(e.message || e);
        // 留下未完成记录时不再另起实例；下一次 ensure 在启动门内恢复。
        if (transaction) {
          if (!restoreService(transaction, ctl)) return out({ ok: false, error: 'service_recovery_failed', serviceError, persistent: false });
          fs.unlinkSync(pendingFile);
          if (transaction.legacyRunning || transaction.running) cur = await waitHealth(null);
          transaction = null;
        }
        const h = await localHealth(home, port);
        if (h && h.kernel === KERNEL_VERSION) return out({ ok: true, already: true, pid: h.pid, persistent: false, serviceError });
        if (cur && cur.kernel !== KERNEL_VERSION) return out({ ok: false, error: 'service_failed', serviceError, persistent: false });
        if (recovering || prior !== null || serviceError === 'service_unmanaged' || serviceError === 'service_not_regular' || serviceError === 'service_stop_failed') return out({ ok: false, error: 'service_failed', serviceError, persistent: false });
      }
    } else if (cur && cur.kernel === KERNEL_VERSION) return out({ ok: true, already: true, pid: cur.pid, systemd: false, persistent: false });
    if (cur && cur.pid && alive(cur.pid)) { try { process.kill(cur.pid, 'SIGTERM'); } catch { /* 已经退出 */ } for (let i = 0; i < 25 && alive(cur.pid); i++) sleepSync(200); }
    const argv = [process.execPath, SELF, 'serve', '--port', String(port)];
    let started = false;
    if (bus) {
      const run = () => spawnSync('systemd-run', ['--user', '--unit=' + UNIT, '--collect', '-p', 'KillMode=process', '-p', 'Restart=always', '-p', 'RestartSec=2', ...argv], { env, timeout: 15000, stdio: 'ignore' });
      let r = run();
      if (r.status !== 0) { ctl(['reset-failed', unit]); r = run(); }
      started = r.status === 0;
    }
    if (!started) {
      fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
      const fd = fs.openSync(path.join(home, 'logs', 'kernel.out'), 'a', 0o600);
      const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', fd, fd], env: process.env, cwd: os.homedir() });
      c.unref(); fs.closeSync(fd);
    }
    const h = await waitHealth();
    return out(h ? { ok: true, started: true, pid: h.pid, systemd: started, persistent: false, ...(serviceError ? { serviceError } : {}) } : { ok: false, error: 'not_healthy', persistent: false });
  } finally { if (locked) try { fs.unlinkSync(lock); } catch { /* 已删 */ } }
}
async function serve(port) {
  const home = homeDir();
  let env = process.env;
  try { const saved = JSON.parse(fs.readFileSync(path.join(home, 'kernel.env.json'), 'utf8')); if (saved && typeof saved === 'object') env = saved; } catch { /* 没存过就用自己的 */ }
  const k = await createKernel({ home, port, env });
  const stop = () => k.close({ release: true }).then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
function main() {
  const [cmd, ...rest] = process.argv.slice(2), i = rest.indexOf('--port'), port = i >= 0 ? Number(rest[i + 1]) : KERNEL_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) { process.stdout.write(JSON.stringify({ ok: false, error: 'bad_port' })); return; }
  if (cmd === 'ensure') ensure(port).catch(e => process.stdout.write(JSON.stringify({ ok: false, error: 'ensure_failed', msg: redact(String(e && e.message || e)) })));
  else if (cmd === 'serve') serve(port).catch(e => { process.stderr.write(redact(String(e && e.stack || e)) + '\n'); process.exit(1); });
  else process.stdout.write(JSON.stringify({ ok: false, error: 'bad_command' }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main();
