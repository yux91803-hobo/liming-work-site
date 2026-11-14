// One owner, one VM-local socket. The HTTP shell stays outside this process.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { BRIDGE_PROTOCOL, Ownership } from './vm-kernel-owner.mjs';
import { FRAME_MAX, stateSocket } from './vm-kernel-client.mjs';

const KINDS = new Set(['op','named','write','append','xin','reap','control']);
const ID = /^[A-Za-z0-9_-]{8,100}$/;
export async function createStateServer({ home, owner = new Ownership(home), initialize = () => {}, handle,
  tick, tickMs = 5000, beforeRelease = () => {}, maxActive = 32, headerMs = 10000, log = () => {} }) {
  const file = stateSocket(home), directory = path.dirname(file), before = owner.record();
  if (before.busy) throw Object.assign(new Error('状态主人仍在运行'), { code: 'owner_busy' });
  const lease = owner.take();
  let timer, active = 0, draining = false, stopped = false, stopPromise, stamp;
  const waiters = [], sockets = new Set(), started = Date.now();
  const record = value => { try { log(value); } catch { /* Diagnostics never change execution. */ } };
  const idle = () => { if (!active) for (const done of waiters.splice(0)) done(); };
  const waitIdle = () => active ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let chunks = [], bytes = 0, received = false;
    const header = setTimeout(() => socket.destroy(), headerMs);
    socket.on('close', () => clearTimeout(header));
    const reply = (request, value) => {
      if (socket.destroyed) return;
      let body;
      try { body = JSON.stringify({ v: request.v, id: request.id, ...value }) + '\n'; }
      catch { body = JSON.stringify({ v: request.v, id: request.id, ok: false, error: 'state_response', executed: 'unknown' }) + '\n'; }
      if (Buffer.byteLength(body) > FRAME_MAX) body = JSON.stringify({ v: request.v, id: request.id, ok: false, error: 'state_too_large', executed: 'unknown' }) + '\n';
      socket.end(body);
    };
    socket.on('data', async b => {
      if (received) return;
      bytes += b.length;
      if (bytes > FRAME_MAX) { received = true; clearTimeout(header); socket.destroy(); return; }
      chunks.push(b); const data = Buffer.concat(chunks), end = data.indexOf(10);
      if (end < 0) return;
      received = true; socket.handling = true; clearTimeout(header); chunks = null;
      let q; try { q = JSON.parse(data.subarray(0,end).toString('utf8')); } catch { socket.destroy(); return; }
      if (!q || typeof q.id!=='string' || !ID.test(q.id) || !Number.isInteger(q.v) || q.v < Math.max(1,BRIDGE_PROTOCOL-1) || q.v > BRIDGE_PROTOCOL || !KINDS.has(q.kind)) {
        reply(q || {}, { ok: false, error: 'state_protocol', executed: false }); return;
      }
      if (q.kind === 'control') {
        if (q.op === 'health') reply(q, { ok: true, result: { pid: process.pid, epoch: lease.epoch, protocol: BRIDGE_PROTOCOL, up: Date.now()-started, active, draining } });
        else if (q.op === 'release' && q.mode === 'legacy') {
          try { reply(q, { ok: true, result: await stop({ legacy: true }) }); }
          catch { reply(q, { ok: false, error: 'state_drain', executed: 'unknown' }); }
        } else reply(q, { ok: false, error: 'state_request', executed: false });
        return;
      }
      // Reports and single writes can finish an already accepted async operation while draining.
      const report = ['named','write','append'].includes(q.kind) || q.kind === 'op' && q.locked;
      if (stopped || draining && !report || active >= (report ? maxActive*2 : maxActive)) {
        reply(q, { ok: false, error: draining ? 'state_draining' : 'state_busy', executed: false }); return;
      }
      active++; const t0 = Date.now(); let ok = false;
      try { const result = await handle(q); ok = true; reply(q, { ok: true, result }); }
      catch (e) { reply(q, { ok: false, error: typeof e.code === 'string' ? e.code : 'state_failed', executed: 'unknown' }); }
      finally { active--; idle(); record({ kind: q.kind, ok, ms: Date.now()-t0 }); }
    });
  });
  let closedResolve;
  const closed = new Promise(resolve => { closedResolve = resolve; });
  server.on('close', () => closedResolve());
  const unlink = () => {
    try { const now = fs.lstatSync(file); if (stamp && now.isSocket() && now.ino === stamp.ino && now.dev === stamp.dev) fs.unlinkSync(file); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  };
  function stop({ legacy = false } = {}) {
    if (stopPromise) return stopPromise;
    draining = true; owner.draining = true; clearTimeout(timer);
    stopPromise = (async () => {
      await waitIdle();
      // No await between the final flush, closing writable handles and handing ownership back.
      beforeRelease(); stopped = true; server.close();
      for (const s of sockets) if (!s.handling) s.destroy();
      lease.release(legacy ? 'legacy' : undefined); unlink();
      return { mode: legacy ? 'legacy' : 'kernel', epoch: lease.epoch + (legacy ? 1 : 0) };
    })();
    return stopPromise;
  }
  async function cycle() {
    if (draining || stopped) return;
    active++;
    let delay = tickMs;
    try { const next = await tick(); if (Number.isFinite(next) && next > 0) delay = next; }
    catch { record({ kind: 'tick', ok: false }); }
    finally { active--; idle(); if (!draining) timer = setTimeout(cycle,delay); }
  }
  try {
    const init = initialize(); if (init?.then) throw Error('状态初始化必须同步完成');
    let st; try { st = fs.lstatSync(directory); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st && (!st.isDirectory() || st.isSymbolicLink())) throw Error('状态套接字目录不安全');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory,0o700);
    let stale; try { stale = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stale) { if (!stale.isSocket()) throw Error('状态套接字路径不是套接字'); fs.unlinkSync(file); }
    await new Promise((resolve,reject) => { server.once('error',reject); server.listen(file,resolve); });
    fs.chmodSync(file,0o600); stamp = fs.lstatSync(file);
    if (tick) timer = setTimeout(cycle,tickMs);
    return { file, epoch: lease.epoch, close: stop, closed };
  } catch (e) {
    clearTimeout(timer); for (const s of sockets) s.destroy();
    try { server.close(); unlink(); } catch { /* Not listening yet. */ }
    try { beforeRelease(); } catch (flushError) { lease.release(); throw flushError; }
    lease.release(before.mode); throw e;
  }
}
