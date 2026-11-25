// Private VM-local protocol. No payloads/credentials in logs; unknown writes need an explicit replay guarantee.
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
// 状态进程接管或重启时，只重试明确未执行的请求。其余写请求要有单独的重放保证。
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
const TRANSPORT_RETRY = new Set(['owner_unavailable', 'state_disconnected', 'state_timeout', 'state_client_failed']);
const REPORT_UNSENT = new Set(['owner_unavailable', 'state_busy', 'state_draining']);
const reportUnavailable = e => e && (e.executed === false && REPORT_UNSENT.has(e.code) || e.executed === 'unknown' && TRANSPORT_RETRY.has(e.code));
// Startup probes are read-only; losing their reply must not abandon a newly dispatched runner.
export async function waitForState(home, { deadlineMs = 30000 } = {}) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300000) throw new StateUnavailable('state_request', false);
  const start = performance.now(); let failure;
  for (let i = 0; ; i++) {
    const remaining = deadlineMs - (performance.now() - start);
    if (i && remaining <= 0) throw failure;
    try { return await requestState(home, { kind: 'control', op: 'health' }, { timeoutMs: Math.min(3000, Math.max(1, Math.ceil(remaining))) }); }
    catch (e) {
      if (!reportUnavailable(e)) throw e;
      failure = e;
      const left = deadlineMs - (performance.now() - start);
      if (left <= 0) throw e;
      await new Promise(resolve => setTimeout(resolve, Math.min(50 * 2 ** Math.min(i, 5), 1000, left)));
    }
  }
}
// Same-attempt reports only: assignments, or the foreground's existing run/frontRun receipt.
// Quota reports also append a sample outside the journal, so are not safe to replay here.
const LOCKED_REPORTS = new Set(['front_immediate', 'front_model', 'agy_conversation', 'task_budget']);
function retryReport(fn, { deadlineMs = 30000, clock = () => performance.now(), sleep = syncSleep } = {}) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300000) throw new StateUnavailable('state_request', false);
  const start = clock(); let failure, uncertain;
  for (let i = 0; ; i++) {
    const remaining = deadlineMs - (clock() - start);
    if (i && remaining <= 0) throw failure;
    try { return fn(Math.max(1, Math.ceil(remaining))); }
    catch (e) {
      if (!reportUnavailable(e)) throw e;
      // A later connection refusal cannot prove an earlier, unanswered attempt did
      // not commit. Preserve uncertainty so an outer retry cannot mint a new ID.
      if (e.executed === 'unknown') uncertain = e;
      failure = uncertain || e;
      const left = deadlineMs - (clock() - start);
      if (left <= 0) throw failure;
      sleep(Math.min(50 * 2 ** Math.min(i, 5), 1000, left));
    }
  }
}
export function retryLockedReport(op, fn, options) {
  return LOCKED_REPORTS.has(op) ? retryReport(fn, options) : retryUnsent(fn, options);
}
// These named callbacks only change journal/SQLite state. Keep this list explicit: a new
// callback that sends network requests or performs external actions must not inherit replay.
const RECEIPTED_NAMES = new Set([
  'memory.preferences', 'memory.meta', 'memory.snapshot', 'memory.supersede', 'memory.restore',
  'memory.add', 'memory.update', 'memory.learning', 'memory.forget', 'memory.forgetKeyword', 'memory.import',
  'recall.sync', 'recall.drop', 'learning.report', 'memoryReview.apply', 'memoryReview.reserve',
  'memoryReview.settle', 'companion.claim', 'companion.bond'
]);
// 一次性兼容客户端把命令交给状态进程。
function inputArgs(read = () => fs.readFileSync(0, 'utf8')) {
  try { const t = read().trim(), a = t ? JSON.parse(t) : {}; return a && typeof a === 'object' && !Array.isArray(a) ? a : {}; } catch { return {}; }
}
export async function forwardCLI(home, op, { argv = process.argv, env = process.env, stdin = () => '', out = process.stdout, err = process.stderr } = {}) {
  const context = { run: env.XIN_RUN || null, attempt: env.XIN_ATTEMPT || null };
  const q = op === 'xin' ? { kind: 'xin', argv: argv.slice(3), ...context, stdin: stdin() }
    : op === 'reap' ? { kind: 'reap', ...context } : { kind: 'op', op: op === 'locked' ? argv[3] : op, locked: op === 'locked', key: env.XIN_LOCK || null, ...context, args: inputArgs() };
  try {
    const r = await requestState(home, q);
    if (op === 'xin') { out.write(r.output || (r.error ? r.msg + '\n' : '')); process.exitCode = r.error ? 1 : r.code || 0; }
    else out.write(JSON.stringify(r ?? {}));
  } catch (e) {
    if (op === 'xin') { err.write('小芯的状态进程暂时不可用，请稍后重试\n'); process.exitCode = 1; }
    else out.write(JSON.stringify({ error: e.code || 'owner_unavailable', msg: '小芯的状态进程暂时不可用，请稍后重试', executed: e.executed ?? false }));
  }
}
export function requestStateSync(home, request, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000, id = options.id ?? crypto.randomUUID();
  const deadlineMs = options.deadlineMs ?? 30000;
  let input;try{input=JSON.stringify({home,request,options:{timeoutMs,id}});}catch{throw new StateUnavailable('state_request',false);}
  const message = JSON.parse(input);
  const q = message.request;
  const receipted = q?.kind === 'write' || q?.kind === 'append' || q?.kind === 'named' && RECEIPTED_NAMES.has(q.name);
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw new StateUnavailable('state_request',false);
  if(receipted&&(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>300000))throw new StateUnavailable('state_request',false);
  // stdin carries request data; argv and the helper environment contain no request or gateway key.
  const env = Object.fromEntries(['PATH','LANG','LC_ALL','TZ'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const send = remaining => {
    const waitMs = Math.min(timeoutMs, remaining ?? timeoutMs);
    message.options.timeoutMs = waitMs;
    const payload = waitMs === timeoutMs ? input : JSON.stringify(message);
    const r = spawnSync(process.execPath, [SELF], { input: payload,
      encoding: 'utf8', env, timeout: waitMs + 3000, maxBuffer: FRAME_MAX + 65536 });
    if (r.error || r.status !== 0) throw new StateUnavailable('state_client_failed', 'unknown');
    let value; try { value = JSON.parse(r.stdout); } catch { throw new StateUnavailable('state_response', 'unknown'); }
    if (!value.ok) throw new StateUnavailable(value.error, value.executed);
    return value.result;
  };
  // The controller commits bridge:<id> with the change. Retransmission keeps both the
  // exact request and its ID, including when COMMIT succeeded but the reply was lost.
  return receipted ? retryReport(send, { deadlineMs }) : send();
}
async function main() {
  let q;
  try { q = JSON.parse(fs.readFileSync(0, 'utf8')); }
  catch { process.stdout.write(JSON.stringify({ ok: false, error: 'state_request', executed: false })); return; }
  try { const result = await requestState(q.home, q.request, q.options); process.stdout.write(JSON.stringify({ ok: true, result })); }
  catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e.code || 'state_client_failed', executed: e.executed ?? 'unknown' })); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main();
