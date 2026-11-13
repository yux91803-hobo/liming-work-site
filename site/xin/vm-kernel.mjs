// 小芯内核（第 1 步）：云电脑上常驻的 HTTP 外壳。设计见 docs/xin-kernel-design.md §4、§10 第 1 步、§14。
// 只用 node 内置模块，不 import 别的 vm-*.mjs：Worker 把它单独按内容哈希上传（vm-kernel-<hash>.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const KERNEL_PORT = 8797;
const SELF = fileURLToPath(import.meta.url);
// 上传到电脑上的文件名是 vm-kernel-<sha256 前 12 位>.mjs；健康检查据此认版本（本地直接跑时是 dev）
export const KERNEL_VERSION = (/^vm-kernel-([0-9a-f]{12})\.mjs$/.exec(path.basename(SELF)) || [])[1] || 'dev';
const BODY_MAX = 65536, OUT_MAX = 4 * 1024 * 1024, ERR_TAIL = 8192;
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

/* ---------- HTTP 外壳（§4.2、§14.2） ----------
   第 1 步不改控制器：/xin/op 在本机起 `node vm-agent-<hash>.mjs <op>`，参数走标准输入，和 InstaBox exec 一模一样。
   每个回应都带 X-Xin-Kernel 头；出错时 executed 说清楚控制器到底跑没跑，Worker 据此决定能不能退回 exec。
   对方断开（超时、网络断）时不杀已经起来的控制器：让它做完并存下结果，同一编号再来就拿到存下的结果。 */
const OP_NAME = /^[a-z][a-z0-9_]{0,39}$/, AGENT_NAME = /^vm-agent-[0-9a-f]{12}\.mjs$/;
export async function createKernel({ home, port = 0, env = process.env, now = Date.now, opTimeoutMs = 40000, maxConcurrent = 16, logFile, logMaxBytes = 2 * 1024 * 1024,
  pollEveryMs = 250, keepWatchMs = 4000, heartbeatMs = 15000, maxStreamMs = 600000 }) {
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
  // 起一次控制器：结果 {code, stdout, stderr, timedOut}；起不来时 {spawnError}
  function runAgent(agent, op, args) {
    return new Promise(resolve => {
      let child;
      try { child = spawn(process.execPath, [agent, op], { env, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (e) { resolve({ spawnError: String(e && e.message || e) }); return; }
      running++;
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
    if (!d || !agentOk(d.agent) || !OP_NAME.test(d.op || '') || (d.args != null && (typeof d.args !== 'object' || Array.isArray(d.args)))) return [400, { ok: false, executed: false, error: 'bad_request' }];
    rec.op = d.op;
    if (d.args && typeof d.args.clientId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(d.args.clientId)) rec.id = d.args.clientId;
    if (!fs.existsSync(d.agent)) return [409, { ok: false, executed: false, error: 'agent_missing' }];
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
        const r = await runAgent(agent, 'poll', { ...base, off, ...(pos != null ? { pos } : {}) });
        let d = null; try { d = r.code === 0 && !r.timedOut ? JSON.parse(r.stdout) : null; } catch { d = null; }
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
      if (req.method === 'GET' && url.pathname === '/xin/health') { answer(200, { ok: true, kernel: KERNEL_VERSION, pid: process.pid, up: now() - started }); return; }
      if (req.method === 'POST' && url.pathname === '/xin/op') { const [status, b] = await op(body, rec); answer(status, b); return; }
      if (req.method === 'GET' && url.pathname === '/xin/stream') { const r = await stream(req, res, url, rec, t0); if (r) answer(r[0], r[1]); return; }
      answer(404, { ok: false, executed: false, error: 'not_found' });
    } catch (e) {
      answer(500, { ok: false, executed: false, error: 'kernel_error', msg: redact(String(e && e.message || e)) });
    }
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });
  return {
    port: server.address().port,
    close: () => new Promise(ok => { server.close(() => { try { nonces.db.close(); } catch { /* 已关 */ } ok(); }); server.closeAllConnections(); })
  };
}

/* ---------- 常驻和升级（§5.1）：ensure / serve ----------
   Worker 经 InstaBox exec 跑 `node vm-kernel-<hash>.mjs ensure --port 8797`：
   - 先把这次 exec 的环境存成 kernel.env.json（0600），serve 起控制器时照用，和以前 exec 起控制器一模一样（PATH、TMPDIR、DISPLAY…）；
   - 已经有同一版本在跑就什么都不做；版本不同先停旧的；
   - 用 systemd 用户服务常驻：KillMode=process（停内核不连带杀掉控制器起的后台进程，和 exec 时一样它们自己活着）、
     Restart=always（挂了自动重启）；电脑上没有用户总线时直接起一个脱离的进程（挂了由 Worker 下次 ensure 拉起）。 */
const UNIT = 'xin-kernel';
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
  return fs.existsSync(process.env.XIN_SYSTEMD_BUS || '/run/user/' + uid + '/bus') && which('systemd-run');
}
// 同一时刻只让一个 ensure 动手（锁文件里写进程号，进程没了或超过 30 秒就当失效）
function takeLock(file, waitMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const deadline = Date.now() + waitMs; ;) {
    try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
    catch (e) { if (e.code !== 'EEXIST') return false; }
    let pid = 0, age = 0;
    try { pid = Number(fs.readFileSync(file, 'utf8')) || 0; age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
    if (!pid || !alive(pid) || age > 30000) { try { fs.unlinkSync(file); } catch { /* 别人删了 */ } continue; }
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
async function ensure(port) {
  const home = homeDir(), out = r => process.stdout.write(JSON.stringify(r));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const envFile = path.join(home, 'kernel.env.json'), tmp = envFile + '.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(process.env), { mode: 0o600 }); fs.renameSync(tmp, envFile);
  const lock = path.join(home, 'locks', 'kernel.lock');
  const locked = takeLock(lock, 10000);
  try {
    const cur = await localHealth(home, port);
    if (cur && cur.kernel === KERNEL_VERSION) return out({ ok: true, already: true, pid: cur.pid });
    if (!locked) return out({ ok: false, error: 'locked' });
    const bus = hasBus(), env = busEnv(process.env);
    const ctl = args => spawnSync('systemctl', ['--user', ...args], { env, timeout: 10000, stdio: 'ignore' });
    if (bus) ctl(['stop', UNIT + '.service']);
    if (cur && cur.pid && alive(cur.pid)) { try { process.kill(cur.pid, 'SIGTERM'); } catch { /* 已经退出 */ } for (let i = 0; i < 25 && alive(cur.pid); i++) sleepSync(200); }
    const argv = [process.execPath, SELF, 'serve', '--port', String(port)];
    let started = false;
    if (bus) {
      const run = () => spawnSync('systemd-run', ['--user', '--unit=' + UNIT, '--collect', '-p', 'KillMode=process', '-p', 'Restart=always', '-p', 'RestartSec=2', ...argv], { env, timeout: 15000, stdio: 'ignore' });
      let r = run();
      if (r.status !== 0) { ctl(['reset-failed', UNIT + '.service']); r = run(); }
      started = r.status === 0;
    }
    if (!started) {
      fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
      const fd = fs.openSync(path.join(home, 'logs', 'kernel.out'), 'a', 0o600);
      const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', fd, fd], env: process.env, cwd: os.homedir() });
      c.unref(); fs.closeSync(fd);
    }
    for (const deadline = Date.now() + 8000; Date.now() < deadline; await new Promise(r => setTimeout(r, 200))) {
      const h = await localHealth(home, port);
      if (h && h.kernel === KERNEL_VERSION) return out({ ok: true, started: true, pid: h.pid, systemd: bus });
    }
    return out({ ok: false, error: 'not_healthy' });
  } finally { if (locked) try { fs.unlinkSync(lock); } catch { /* 已删 */ } }
}
async function serve(port) {
  const home = homeDir();
  let env = process.env;
  try { const saved = JSON.parse(fs.readFileSync(path.join(home, 'kernel.env.json'), 'utf8')); if (saved && typeof saved === 'object') env = saved; } catch { /* 没存过就用自己的 */ }
  const k = await createKernel({ home, port, env });
  const stop = () => k.close().then(() => process.exit(0));
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
