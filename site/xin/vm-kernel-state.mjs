// One owner, one VM-local socket. The HTTP shell stays outside this process.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { BRIDGE_PROTOCOL, Ownership } from './vm-kernel-owner.mjs';
import { FRAME_MAX, stateSocket } from './vm-kernel-client.mjs';

const KINDS = new Set(['op','named','write','append','xin','reap','control']);
const ID = /^[A-Za-z0-9_-]{8,100}$/;

// Snapshot only the existing backup allowlist. API keys, logins and push data stay in the VM.
const BACKUP_ITEMS = ['sessions', 'runs', 'messages', 'agent-sessions', 'budgets', 'daily.md', 'memory.md', 'model-stats.jsonl', 'quota-history.jsonl',
  'bond.json', 'next.json', 'moves.json', 'plugins.json', 'daily-done.json', 'daily-last.json', 'task-seq.json', 'tasks-index.json',
  'front-antigravity-quota.json', 'antigravity-quota.json', 'antigravity-argon-quota.json'];

function freezeArchiveInputs(home, staged, pinned, names) {
  const files = [];
  function add(name) {
    const source = path.join(home, name);
    let stat;
    try { stat = fs.lstatSync(source); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isDirectory()) {
      fs.mkdirSync(path.join(staged, name), { recursive: true });
      for (const child of fs.readdirSync(source)) {
        if (!child.endsWith('.tmp') && !child.includes('.journal-')) add(path.join(name, child));
      }
      return;
    }
    if (!stat.isFile()) throw Object.assign(Error('备份包含非常规文件'), { code: 'backup_input' });
    // JSON projections are replaced atomically. For append-only logs keep a fixed prefix.
    const grows = name.endsWith('.jsonl');
    const link = path.join(grows ? pinned : staged, name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.linkSync(source, link);
    const snapshot = fs.lstatSync(link);
    if (snapshot.dev !== stat.dev || snapshot.ino !== stat.ino || snapshot.size < stat.size)
      throw Object.assign(Error('备份文件已变'), { code: 'backup_input' });
    if (grows) files.push({ name, size: stat.size });
  }
  for (const name of names) add(name);
  return files;
}

function snapshotArchiveDb(db, stage) {
  const file = path.join(stage, 'workflow.sqlite');
  db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
  fs.chmodSync(file, 0o600);
  const staged = new DatabaseSync(file);
  const names = ['workflow.sqlite'];
  try {
    const runs = staged.prepare("SELECT run FROM launches WHERE state IN ('pending','dispatched')").all().map(row => row.run);
    if (runs.length) {
      staged.prepare("UPDATE launches SET state='pending' WHERE state='dispatched'").run();
      fs.writeFileSync(path.join(stage, 'restore-stop.json'), JSON.stringify({ at: Date.now(), runs }), { mode: 0o600 });
      names.push('restore-stop.json');
    }
  } finally { staged.close(); }
  return names;
}

async function archiveState(home, db, dir, file) {
  const root = fs.mkdtempSync(path.join(dir, '.stage-'));
  const staged = path.join(root, 'snapshot'), pinned = path.join(root, 'pinned');
  try {
    fs.mkdirSync(staged, { mode: 0o700 });
    const names = snapshotArchiveDb(db, staged);
    const files = freezeArchiveInputs(home, staged, pinned, BACKUP_ITEMS);
    for (const { name, size } of files) {
      const output = path.join(staged, name);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      if (size) await pipeline(fs.createReadStream(path.join(pinned, name), { end: size - 1 }), fs.createWriteStream(output, { mode: 0o600 }));
      else fs.writeFileSync(output, '', { mode: 0o600 });
      if (fs.statSync(output).size !== size) throw Object.assign(Error('备份文件尺寸已变'), { code: 'backup_input' });
    }
    const items = BACKUP_ITEMS.filter(name => fs.existsSync(path.join(staged, name)));
    const tmp = path.join(root, 'state.tar.gz');
    await new Promise((resolve, reject) => execFile('tar', ['-czf', tmp, '-C', staged, ...names, ...items],
      { timeout: 60000, maxBuffer: 256 * 1024 }, (error) => error ? reject(error) : resolve()));
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

export function createBackupExporter({ home, getDb, today }) {
  const pending = new Map();
  const dir = path.join(home, 'exports');
  return async function backupExport(keep = 3) {
    const date = today(), file = path.join(dir, 'state-' + date.replace(/-/g, '') + '.tar.gz');
    if (pending.has(file)) return pending.get(file);
    const build = async () => {
      try {
        if (!fs.existsSync(file)) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          await archiveState(home, getDb(), dir, file);
          for (const old of fs.readdirSync(dir).filter(n => /^state-\d{8}\.tar\.gz$/.test(n)).sort().slice(0, -keep))
            try { fs.unlinkSync(path.join(dir, old)); } catch { /* removed concurrently */ }
        }
        const hash = crypto.createHash('sha256'); let size = 0;
        for await (const chunk of fs.createReadStream(file)) { size += chunk.length; hash.update(chunk); }
        return { ok: true, file, size, sha256: hash.digest('hex'), date };
      } catch (error) {
        return { error: 'tar_failed', msg: '打包失败（' + (error.code || 'backup_failed') + '）' };
      }
    };
    const result = build().finally(() => pending.delete(file));
    pending.set(file, result);
    return result;
  };
}

export async function createStateServer({ home, owner = new Ownership(home), initialize = () => {}, handle, drain = () => {},
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
      await Promise.all([waitIdle(), drain()]);
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
