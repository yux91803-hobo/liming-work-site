// Private VM-local protocol. No payloads/credentials in logs, no automatic retry after a write.
// The sync adapter is the small-process fallback in the approved design §6.3.
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BRIDGE_PROTOCOL } from './vm-kernel-owner.mjs';

const SELF = fileURLToPath(import.meta.url);
export const FRAME_MAX = 4 * 1024 * 1024;
export const stateSocket = home => path.join(path.resolve(home), 'run', 'state.sock');
export class StateUnavailable extends Error {
  constructor(code, executed = false) {
    super('小芯的状态进程暂时不可用，请稍后重试');
    this.code = code; this.executed = executed;
  }
}
export function requestState(home, request, { timeoutMs = 60000, id = crypto.randomUUID() } = {}) {
  if(typeof home!=='string'||!home||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000||typeof id!=='string'||!(/^[A-Za-z0-9_-]{8,100}$/).test(id))
    return Promise.reject(new StateUnavailable('state_request',false));
  let body;
  try { body = Buffer.from(JSON.stringify({ ...request, v: BRIDGE_PROTOCOL, id }) + '\n'); }
  catch { return Promise.reject(new StateUnavailable('state_request', false)); }
  if (body.length > FRAME_MAX) return Promise.reject(new StateUnavailable('state_too_large', false));
  return new Promise((resolve, reject) => {
    let sent = false, done = false, size = 0, parts = [];
    const socket = net.createConnection(stateSocket(home));
    const timer = setTimeout(() => finish(new StateUnavailable('state_timeout', sent ? 'unknown' : false)), timeoutMs);
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.on('connect', () => { sent = true; socket.end(body); });
    socket.on('error', () => finish(new StateUnavailable('owner_unavailable', sent ? 'unknown' : false)));
    socket.on('data', b => {
      size += b.length;
      if (size > FRAME_MAX) return finish(new StateUnavailable('state_too_large', 'unknown'));
      parts.push(b); const data = Buffer.concat(parts), end = data.indexOf(10);
      if (end < 0) return;
      let r; try { r = JSON.parse(data.subarray(0, end).toString('utf8')); } catch { return finish(new StateUnavailable('state_response', 'unknown')); }
      if (!r || r.v !== BRIDGE_PROTOCOL || r.id !== id) return finish(new StateUnavailable('state_response', 'unknown'));
      if (!r.ok) return finish(new StateUnavailable(r.error || 'state_response', r.executed === false ? false : 'unknown'));
      finish(null, r.result);
    });
    socket.on('close', () => { if (!done) finish(new StateUnavailable('state_disconnected', sent ? 'unknown' : false)); });
  });
}
export const syncSleep = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
// 设计 §6.2：交不过去（主人正在接手、还没开始听；或者刚被杀、记录还没改回旧模式）就稍等，再按判断规则从头判断一次。
// 只重来「确定没执行」的失败（executed === false）；发出去以后断开、超时（不确定）的不自动重来，免得做两遍。
// fn 每次都要重新判断所有权（是不是主人、记录是什么），不能只重发同一个套接字请求。
const NEVER_RETRY = new Set(['state_request', 'state_too_large', 'state_protocol']);
export function retryUnsent(fn, { deadlineMs = 30000, clock = () => performance.now(), sleep = syncSleep } = {}) {
  const start = clock();
  for (let i = 0; ; i++) {
    try { return fn(); }
    catch (e) {
      if (!e || e.executed !== false || NEVER_RETRY.has(e.code)) throw e;
      const left = deadlineMs - (clock() - start);
      if (left <= 0) throw e;
      sleep(Math.min(50 * 2 ** Math.min(i, 5), 1000, left));
    }
  }
}
// 一次性兼容客户端：记录归内核（或主人活着）时，把这一次命令行调用整个交给状态进程，不取得本地写权。
export function inputArgs(read = () => fs.readFileSync(0, 'utf8')) {
  try { const t = read().trim(), a = t ? JSON.parse(t) : {}; return a && typeof a === 'object' && !Array.isArray(a) ? a : {}; } catch { return {}; }
}
export async function forwardCLI(home, op, { argv = process.argv, env = process.env, stdin = () => '', out = process.stdout, err = process.stderr } = {}) {
  const q = op === 'xin' ? { kind: 'xin', argv: argv.slice(3), run: env.XIN_RUN || null, stdin: stdin() }
    : op === 'reap' ? { kind: 'reap' } : { kind: 'op', op: op === 'locked' ? argv[3] : op, locked: op === 'locked', key: env.XIN_LOCK || null, run: env.XIN_RUN || null, args: inputArgs() };
  try {
    const r = await requestState(home, q);
    if (op === 'xin') { out.write(r.output || ''); process.exitCode = r.code || 0; }
    else out.write(JSON.stringify(r ?? {}));
  } catch (e) {
    if (op === 'xin') { err.write('小芯的状态进程暂时不可用，请稍后重试\n'); process.exitCode = 1; }
    else out.write(JSON.stringify({ error: e.code || 'owner_unavailable', msg: '小芯的状态进程暂时不可用，请稍后重试', executed: e.executed ?? false }));
  }
}
export function requestStateSync(home, request, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000;
  let input;try{input=JSON.stringify({home,request,options:{...options,timeoutMs}});}catch{throw new StateUnavailable('state_request',false);}
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw new StateUnavailable('state_request',false);
  // stdin carries request data; argv and the helper environment contain no request or gateway key.
  const env = Object.fromEntries(['PATH','LANG','LC_ALL','TZ'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const r = spawnSync(process.execPath, [SELF], { input,
    encoding: 'utf8', env, timeout: timeoutMs + 3000, maxBuffer: FRAME_MAX + 65536 });
  if (r.error || r.status !== 0) throw new StateUnavailable('state_client_failed', 'unknown');
  let value; try { value = JSON.parse(r.stdout); } catch { throw new StateUnavailable('state_response', 'unknown'); }
  if (!value.ok) throw new StateUnavailable(value.error, value.executed);
  return value.result;
}
async function main() {
  let q;
  try { q = JSON.parse(fs.readFileSync(0, 'utf8')); }
  catch { process.stdout.write(JSON.stringify({ ok: false, error: 'state_request', executed: false })); return; }
  try { const result = await requestState(q.home, q.request, q.options); process.stdout.write(JSON.stringify({ ok: true, result })); }
  catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e.code || 'state_client_failed', executed: e.executed ?? 'unknown' })); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main();
