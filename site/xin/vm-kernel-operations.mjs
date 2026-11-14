// Fixed state operations. The bridge never accepts a callback, module path or SQL.
import * as memory from './vm-memory.mjs';
import { recallDb, syncRecall, dropRecall } from './vm-context.mjs';
import { learningDb, reportLearning } from './vm-learning.mjs';
import { applyMemoryReview, reserveMemoryReview, settleUsage } from './vm-memory-idle.mjs';
import { claimNext, bondAdd } from './vm-companion.mjs';

export function initializeStateTables() { memory.memoryDb(); recallDb(); learningDb(); }
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
