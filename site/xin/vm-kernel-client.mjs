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
