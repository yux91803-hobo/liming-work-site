// Fixed state operations. The bridge never accepts a callback, module path or SQL.
import * as memory from './vm-memory.mjs';
import { recallDb, syncRecall, dropRecall } from './vm-context.mjs';
import { learningDb, reportLearning } from './vm-learning.mjs';
import { applyMemoryReview, reserveMemoryReview, settleUsage } from './vm-memory-idle.mjs';
import { claimNext, bondAdd } from './vm-companion.mjs';
import path from 'node:path';
import { BASE, journal, okId, readJ, writeJ } from './vm-base.mjs';
import { requestBudget } from './vm-runtime.mjs';
import { loginStore, normalizeSite } from './vm-logins.mjs';
import { inputDigest } from './vm-state.mjs';

export function initializeStateTables() { memory.memoryDb(); recallDb(); learningDb(); }
export function stateLoginSave(a, dir, windowFile) {
  if (typeof a.site !== 'string' || normalizeSite(a.site) !== a.site || !Array.isArray(a.cookies)) return { saved: false };
  const store = loginStore(dir);
  if (a.window) {
    const window = readJ(windowFile);
    if (window?.id !== a.window || window.removals?.[a.site]?.id !== store.removals()[a.site]?.id) return { saved: false };
    return store.save(a.site, a.cookies);
  }
  if (!okId(a.sid, 's') || !okId(a.run, 'r') || !a.expected) return { saved: false };
  const meta = readJ(path.join(BASE, 'runs', a.run + '.json'));
  const task = readJ(path.join(BASE, 'sessions', a.sid + '.json'));
  if (!meta?.task || meta.sid !== a.sid || task?.runs?.at(-1) !== a.run || !task.sites?.includes(a.site) || meta.ended || meta.stopped) return { saved: false };
  return store.save(a.site, a.cookies, a.expected);
}
export function taskBudget(a) {
  if (!okId(a.sid, 's') || !okId(a.run, 'r')) return { error: 'bad_budget' };
  const meta = readJ(path.join(BASE, 'runs', a.run + '.json'));
  const task = readJ(path.join(BASE, 'sessions', a.sid + '.json'));
  const handoff = meta?.handoff && journal.handoff(meta.handoff);
  const scoped = meta?.task ? meta.sid === a.sid && task?.runs?.at(-1) === a.run : handoff?.run === a.run && handoff.task === a.sid && handoff.state === 'running';
  if (!scoped || task?.kind !== 'task' || meta.ended || meta.stopped) return { error: 'stale_budget' };
  const file = path.join(BASE, 'budgets', a.sid + '.json');
  const store = { read: () => readJ(file, {}), write: value => writeJ(file, value) };
  const take = requestBudget(store, Number(process.env.XIN_TASK_REQUEST_LIMIT) || 128, { tokens: Number(process.env.XIN_TASK_TOKEN_LIMIT) || 1500000 });
  if (a.action === 'take') return { sid: a.sid, allowed: take() };
  if (a.action === 'usage') { take.recordUsage(a.usage); return { sid: a.sid, ok: true }; }
  if (a.action === 'cumulative' && a.provider === 'antigravity' && /^[0-9a-zA-Z_-]{1,96}$/.test(a.conversation || ''))
    return { sid: a.sid, delta: take.recordCumulativeUsage(a.provider, a.conversation, a.usage) };
  return { error: 'bad_budget' };
}
export function budgetCommand(args, attempt) {
  return { id: 'task-budget:' + args.run + ':' + (attempt || 'legacy') + ':' + args.id, digest: inputDigest(args) };
}
export function restoreBudget(samples, meta) {
  let restored = false;
  const seen = new Set();
  for (const args of samples) {
    if (args.run !== meta.run || seen.has(args.id)) continue;
    seen.add(args.id);
    const command = budgetCommand(args, meta.attempt);
    const stamp = journal.commandReceipt(command.id);
    if (stamp) {
      restored ||= stamp.digest === command.digest && args.action === 'cumulative';
      continue;
    }
    try { const applied = taskBudget(args); restored = restored || !!applied.delta; }
    catch (error) { if (error.code !== 'budget_regression') throw error; }
  }
  return restored;
}
export const stateOperations = Object.freeze({
  'memory.preferences': memory.setMemoryPreferences,
  'memory.meta': memory.setMemoryMeta,
  'memory.snapshot': memory.memorySnapshot,
  'memory.supersede': memory.supersedeMemory,
  'memory.restore': memory.restoreMemoryVersion,
  'memory.add': memory.addMemory,
  'memory.update': memory.updateMemory,
  'memory.learning': memory.learningMemory,
  'memory.forget': memory.forgetMemory,
  'memory.forgetKeyword': memory.forgetByKeyword,
  'memory.import': memory.importLegacyNotebook,
  'recall.sync': syncRecall,
  'recall.drop': dropRecall,
  'learning.report': reportLearning,
  'memoryReview.apply': applyMemoryReview,
  'memoryReview.reserve': reserveMemoryReview,
  'memoryReview.settle': settleUsage,
  'companion.claim': claimNext,
  'companion.bond': bondAdd
});
