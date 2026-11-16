// Durable launch intent stays in the journal; the existing flock owns each runner's lifetime.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { BASE, journal, ownership, readJ, writeJ, mk, alive, processIdentity, processGroupMembers, readTail, signalProcessGroup } from './vm-base.mjs';
import { callContext, withCallContext, lockHeld } from './vm-kernel-context.mjs';
import { nextAttempt } from './vm-run-attempt.mjs';

export function runnerAlive(run, meta) {
  if (alive(meta?.pid, meta?.identity) || meta?.launcher?.identity && alive(meta.launcher.pid, meta.launcher.identity)) return true;
  const file = path.join(BASE, 'locks', run + '.lock');
  if (!fs.existsSync(file)) return false;
  // The runner can be alive before its registration reaches a restarting owner.
  // An inconclusive probe must not authorize another execution.
  const probe = spawnSync('flock', ['-n', '--conflict-exit-code', '73', file, 'true'], { stdio: 'ignore', timeout: 1000 });
  return probe.status !== 0;
}

export function createDispatcher({ self, metaF, sessF, runF, lockedCall, emit, patchRun }) {
  function runDone(run) {
    const m = readJ(metaF(run));
    if (m?.ended || readTail(runF(run), 8192).includes('"t":"done"')) return true;
    if (!m || Date.now() - m.started <= (Number(process.env.XIN_DEAD_MS) || 15000) || runnerAlive(run, m)) return false;
    const key = m.task ? 'tasks' : m.sid;
    if (!lockHeld(key)) return !!lockedCall(key, 'run_recover', { run }).done;
    if (m.childPid && processGroupMembers(m.childPid, m.childIdentity).length) {
      signalProcessGroup(m.childPid, m.childIdentity, m.orphanStopping && Date.now() - m.orphanStopping > 2000 ? 'SIGKILL' : 'SIGTERM');
      if (!m.orphanStopping) patchRun(run, { orphanStopping: Date.now() });
      if (processGroupMembers(m.childPid, m.childIdentity).length) return false;
    }
    if (!m.task && m.agent === 'codex' && !m.stopped) {
      const job = journal.launchRecord(run);
      if (job && job.state !== 'finished' && (job.attempts < 2 || Date.now() - job.dispatchedAt < 15000)) return false;
    }
    emit(run, { t: 'err', text: '这一轮中途断了（云电脑重启或进程被杀）' });
    emit(run, { t: 'done', ok: false, code: -1, ms: Date.now() - m.started });
    patchRun(run, { died: true, ended: Date.now() });
    return true;
  }
  function startRunner(run) {
    const meta = readJ(metaF(run)), attempt = nextAttempt(meta);
    if (attempt) journal.atomic(() => {
      writeJ(metaF(run), { ...meta, attempt, pid: null, identity: null, launcher: null, childPid: null, childIdentity: null });
      journal.dispatched(run);
    });
    mk(path.join(BASE, 'locks'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['XIN_RUN', 'XIN_ATTEMPT', 'XIN_LOCK'].includes(k) && !/^CODEX_(?!HOME$)/.test(k)));
    if (attempt) Object.assign(env, { XIN_RUN: run, XIN_ATTEMPT: attempt });
    const child = spawn('flock', ['-n', '--close', path.join(BASE, 'locks', run + '.lock'), process.execPath, self, 'run', run], {
      detached: true, stdio: 'ignore', cwd: os.homedir(), env
    });
    child.on('error', () => {
      if (attempt && readJ(metaF(run))?.attempt !== attempt) return;
      emit(run, { t: 'err', text: '执行进程未能启动，已保留输入' });
      patchRun(run, { died: true, ended: Date.now() }); journal.finishLaunch(run);
    });
    child.unref();
    const identity = child.pid && processIdentity(child.pid);
    if (attempt && identity) journal.atomic(() => {
      const current = readJ(metaF(run));
      if (current?.attempt === attempt && !current.ended) writeJ(metaF(run), { ...current, launcher: { pid: child.pid, identity } });
    });
    if (!attempt) journal.dispatched(run);
  }
  function dispatch(scan) {
    if (journal.active || ownership.draining) return;
    let release;
    try { release = ownership.enter(); } catch (e) { if (e.code === 'owner_unavailable') return; throw e; }
    try {
      for (const job of scan ? journal.launchedRuns() : []) {
        const m = readJ(metaF(job.run));
        if (!m || m.ended) { journal.finishLaunch(job.run); continue; }
        if (Date.now() - Math.max(m.started, job.dispatchedAt || 0) < 15000 || runnerAlive(job.run, m)) continue;
        if (m.childPid && processGroupMembers(m.childPid, m.childIdentity).length) { runDone(job.run); continue; }
        if (!m.task && m.agent === 'codex' && !m.stopped && job.attempts < 2) startRunner(job.run);
        else if (runDone(job.run)) journal.finishLaunch(job.run);
      }
      for (const job of journal.pendingLaunches()) {
        const meta = readJ(metaF(job.run));
        if (!meta || meta.ended) { journal.finishLaunch(job.run); continue; }
        if (runnerAlive(job.run, meta)) { journal.dispatched(job.run); continue; }
        const own = readJ(sessF(job.sid));
        const earlier = (own?.runs || []).slice(-4).filter(r => r !== job.run).some(r => {
          const m = readJ(metaF(r)); return m && !runDone(r) && runnerAlive(r, m);
        });
        if (!earlier) startRunner(job.run);
      }
    } finally {
      if (!ownership.owning && ownership.depth === 1) journal.closeWriter();
      release();
    }
  }
  function dispatchLaunches() {
    const scan = !callContext().key;
    return withCallContext({ locked: false, key: null, run: null, attempt: null }, () => dispatch(scan));
  }
  return { dispatchLaunches, runDone };
}
