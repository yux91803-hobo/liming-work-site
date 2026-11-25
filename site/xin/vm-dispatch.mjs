// Durable launch intent stays in the journal; the existing flock owns each runner's lifetime.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { BASE, journal, ownership, readJ, writeJ, mk, alive, processIdentity, processGroupMembers, readTail, signalProcessGroup } from './vm-base.mjs';
import { callContext, withCallContext, lockHeld } from './vm-kernel-context.mjs';
import { finalizationEvidence, nextAttempt } from './vm-run-attempt.mjs';

export function runnerAlive(run, meta) {
  if (alive(meta?.pid, meta?.identity) || meta?.launcher?.identity && alive(meta.launcher.pid, meta.launcher.identity)) return true;
  const file = path.join(BASE, 'locks', run + '.lock');
  if (!fs.existsSync(file)) return false;
  // The runner can be alive before its registration reaches a restarting owner.
  // An inconclusive probe must not authorize another execution.
  const probe = spawnSync('flock', ['-n', '--conflict-exit-code', '73', file, 'true'], { stdio: 'ignore', timeout: 1000 });
  return probe.status !== 0;
}

export function createDispatcher({ self, metaF, sessF, runF, lockedCall, emit, patchRun, finalizations, finalizeRun, allowHostLaunch = () => true }) {
  const dead = (run, m, started = m.started) => Date.now() - started > (Number(process.env.XIN_DEAD_MS) || 15000) && !runnerAlive(run, m);
  function stopOrphan(run, m) {
    if (m.childPid && processGroupMembers(m.childPid, m.childIdentity).length) {
      signalProcessGroup(m.childPid, m.childIdentity, m.orphanStopping && Date.now() - m.orphanStopping > 2000 ? 'SIGKILL' : 'SIGTERM');
      if (!m.orphanStopping) patchRun(run, { orphanStopping: Date.now() });
      return processGroupMembers(m.childPid, m.childIdentity).length > 0;
    }
    return false;
  }
  function recoverFinalization(run, m, evidence) {
    if (journal.active || !ownership.owning || ownership.draining) return false;
    try {
      const exited = dead(run, m);
      if (exited && stopOrphan(run, m) || !exited && !evidence.ready) return false;
      return !!finalizeRun(m, {evidence, abandon:!evidence.ready}).ok;
    } catch { return false; } // Isolate an unavailable projection or workspace from unrelated runs.
  }
  function runDone(run) {
    const m = readJ(metaF(run));
    if (m?.ended) return true;
    const evidence = finalizationEvidence(finalizations, m);
    if (evidence) return recoverFinalization(run, m, evidence);
    if (readTail(runF(run), 8192).includes('"t":"done"')) return true;
    if (!m || !dead(run, m)) return false;
    const key = m.task ? 'tasks' : m.sid;
    if (!lockHeld(key)) return !!lockedCall(key, 'run_recover', { run }).done;
    if (stopOrphan(run, m)) return false;
    if (!m.task && m.agent === 'codex' && !m.stopped) {
      const job = journal.launchRecord(run);
      if (job && job.state !== 'finished' && (job.attempts < 2 || Date.now() - job.dispatchedAt < 15000)) return false;
    }
    emit(run, { t: 'err', text: '这一轮中途断了（云电脑重启或进程被杀）' });
    emit(run, { t: 'done', ok: false, code: -1, ms: Date.now() - m.started });
    patchRun(run, { died: true, ended: Date.now() });
    return true;
  }
  // 派发认领和新执行编号在同一事务提交。执行进程启动前即可核对编号。
  function startRunner(job) {
    const run = job.run;
    let attempt = null, claimed = false;
    journal.atomic(() => {
      const meta = readJ(metaF(run));
      if (!allowHostLaunch(meta)) return;
      if (!(claimed = journal.claimLaunch(job))) return;
      attempt = nextAttempt(meta);
      if (attempt) writeJ(metaF(run), { ...meta, attempt, pid: null, identity: null, launcher: null, childPid: null, childIdentity: null });
    });
    if (!claimed) return false;
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
    return true;
  }
  function dispatch(scan) {
    if (journal.active || !ownership.owning || ownership.draining) return;
    for (const job of scan ? journal.launchedRuns() : []) {
      const m = readJ(metaF(job.run));
      if (!m || m.ended) { journal.finishLaunch(job.run); continue; }
      const evidence = finalizationEvidence(finalizations, m);
      if (evidence) { recoverFinalization(job.run, m, evidence); continue; }
      if (Date.now() - Math.max(m.started, job.dispatchedAt || 0) < 15000 || runnerAlive(job.run, m)) continue;
      if (m.childPid && processGroupMembers(m.childPid, m.childIdentity).length) { runDone(job.run); continue; }
      if (!m.task && m.agent === 'codex' && !m.stopped && job.attempts < 2) startRunner(job);
      else if (runDone(job.run)) journal.finishLaunch(job.run);
    }
    for (const job of journal.pendingLaunches()) {
      const meta = readJ(metaF(job.run));
      if (!meta || meta.ended) { journal.finishLaunch(job.run); continue; }
      const evidence = finalizationEvidence(finalizations, meta);
      if (evidence) { recoverFinalization(job.run, meta, evidence); continue; }
      if (runnerAlive(job.run, meta)) { journal.claimLaunch(job); continue; }
      const own = readJ(sessF(job.sid));
      const earlier = (own?.runs || []).slice(-4).filter(r => r !== job.run).some(r => {
        const m = readJ(metaF(r));
        return m && !runDone(r) && (finalizationEvidence(finalizations, m) || runnerAlive(r, m));
      });
      if (!earlier) startRunner(job);
    }
  }
  function dispatchLaunches() {
    const scan = !callContext().key;
    return withCallContext({ locked: false, key: null, run: null, attempt: null }, () => dispatch(scan));
  }
  return { dispatchLaunches, runDone };
}
