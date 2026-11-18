// One owner, one VM-local socket. The HTTP shell stays outside this process.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { BRIDGE_PROTOCOL, Ownership } from './vm-kernel-owner.mjs';
import { FRAME_MAX, stateSocket } from './vm-kernel-client.mjs';

const KINDS = new Set(['op','named','write','append','xin','reap','control']);
const ID = /^[A-Za-z0-9_-]{8,100}$/;
export async function createStateServer({ home, owner = new Ownership(home), initialize = () => {}, handle,
  tick, reconcile, hasWork = () => false, tickMs = 5000, wallClock = Date.now, recoveryGapMs = 30000, beforeRelease = () => {}, maxActive = 32, headerMs = 10000, log = () => {} }) {
  const file = stateSocket(home), directory = path.dirname(file);
  if (owner.record().busy) throw Object.assign(new Error('状态主人仍在运行'), { code: 'owner_busy' });
  let lease;
  let timer, active = 0, draining = false, stopped = false, stopPromise, stamp, nextTick = tickMs;
  let cycling = null, lastSweep = null, timerDue = 0;
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
      // Reconcile before handling resumed work. The synchronous state scan starts now;
      // notification/network waits can finish in the background while reports are served.
      const wall = wallClock();
      if ((tick || reconcile) && (q.kind !== 'control' || q.op === 'health') && (lastSweep === null || wall - lastSweep > recoveryGapMs || wall < lastSweep)) cycle();
      if (q.kind === 'control') {
        if (q.op === 'health') reply(q, { ok: true, result: { pid: process.pid, epoch: lease.epoch, protocol: BRIDGE_PROTOCOL, up: Date.now()-started, active, draining, nextTickMs: nextTick, rss: process.memoryUsage().rss } });
        // 交回：排空、放锁退出，记录留在 kernel，等下一个状态进程接手（删旧模式第 2 步：不再改回 legacy）。
        // 旧外壳发的 mode:'legacy' 也一样处理。
        else if (q.op === 'release') {
          try { reply(q, { ok: true, result: await stop() }); }
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
      finally { active--; idle(); wakeForWork(); record({ kind: q.kind, ok, ms: Date.now()-t0 }); }
    });
  });
  let closedResolve;
  const closed = new Promise(resolve => { closedResolve = resolve; });
  server.on('close', () => closedResolve());
  const unlink = () => {
    try { const now = fs.lstatSync(file); if (stamp && now.isSocket() && now.ino === stamp.ino && now.dev === stamp.dev) fs.unlinkSync(file); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  };
  function stop() {
    if (stopPromise) return stopPromise;
    draining = true; owner.draining = true; clearTimeout(timer);
    stopPromise = (async () => {
      await waitIdle();
      // No await between the final flush, closing writable handles and handing ownership back.
      beforeRelease(); stopped = true; server.close();
      for (const s of sockets) if (!s.handling) s.destroy();
      lease.release(); unlink();
      return { mode: 'kernel', epoch: lease.epoch };
    })();
    return stopPromise;
  }
  function workPending() {
    try { return !!hasWork(); } catch { record({ kind: 'tick', ok: false }); return false; }
  }
  function scheduleTick(delay) {
    clearTimeout(timer); nextTick = delay; timerDue = performance.now() + delay; timer = setTimeout(cycle,delay);
  }
  function wakeForWork() {
    // Only move an existing deadline earlier. Polling must never postpone recovery.
    if (!draining && !stopped && !cycling && timerDue - performance.now() > tickMs && workPending()) scheduleTick(tickMs);
  }
  function cycle() {
    if (draining || stopped) return cycling;
    if (cycling) {
      if (reconcile) { lastSweep = wallClock(); try { reconcile(); } catch { record({ kind: 'tick', ok: false }); } }
      return cycling;
    }
    clearTimeout(timer); active++; lastSweep = wallClock();
    let next;
    try { reconcile?.(); next = tick?.(); } catch { record({ kind: 'tick', ok: false }); }
    cycling = Promise.resolve(next).then(value => {
      nextTick = Number.isFinite(value) && value > 0 ? value : tickMs;
    }, () => { nextTick = tickMs; record({ kind: 'tick', ok: false }); }).finally(() => {
      cycling = null; active--; idle(); if (!draining) scheduleTick(workPending() ? Math.min(nextTick,tickMs) : nextTick);
    });
    return cycling;
  }
  try {
    lease = owner.take({ initialize: before => {
      let st; try { st = fs.lstatSync(directory); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (st && (!st.isDirectory() || st.isSymbolicLink())) throw Error('状态套接字目录不安全');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory,0o700);
      let stale; try { stale = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (stale) { if (!stale.isSocket()) throw Error('状态套接字路径不是套接字'); fs.unlinkSync(file); }
      return initialize(before);
    } });
    await new Promise((resolve,reject) => { server.once('error',reject); server.listen(file,resolve); });
    fs.chmodSync(file,0o600); stamp = fs.lstatSync(file);
    if (tick || reconcile) scheduleTick(0);
    return { file, epoch: lease.epoch, close: stop, closed };
  } catch (e) {
    clearTimeout(timer); for (const s of sockets) s.destroy();
    try { server.close(); unlink(); } catch { /* Not listening yet. */ }
    try { beforeRelease(); } finally { lease?.release(); }
    throw e;
  }
}
// 设计 §6.9 第 2 步：从旧模式切到内核之前留一份一致的备份（VACUUM INTO 是一致的快照）。
// 第 2 批计划定的：一天最多一次，留最新两份，目录 0700、文件 0600；先写 .tmp 再改名，读的人看不到写了一半的文件。
const SNAPSHOT = /^workflow-(\d+)\.sqlite$/;
export function snapshotBeforeSwitch(db, home, { now = Date.now(), everyMs = 86400000, keep = 2 } = {}) {
  const dir = path.join(path.resolve(home), 'backups', 'owner-switch');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const have = fs.readdirSync(dir).map(n => SNAPSHOT.exec(n)).filter(Boolean).map(m => ({ name: m[0], at: Number(m[1]) })).sort((a, b) => b.at - a.at);
  if (have.length && now - have[0].at < everyMs) return null;
  const file = path.join(dir, 'workflow-' + now + '.sqlite'), tmp = file + '.tmp';
  try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  db.prepare('VACUUM INTO ?').run(tmp); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file);
  for (const old of [{ name: path.basename(file) }, ...have].slice(keep)) fs.unlinkSync(path.join(dir, old.name));
  return file;
}
