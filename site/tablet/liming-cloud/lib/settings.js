// 站长可调的设置：~/.liming-cloud/settings.json（目录 700、文件 600）。面板里改了写这里，优先于 cordis.patch.yml 里的插件配置。
// 现在只有一项：每台云电脑同时跑的平板任务上限（初始 2）。
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './ledger.js';

export const SETTINGS_LIMITS = Object.freeze({ maxConcurrentPerMachine: { min: 1, max: 5, default: 2 } });

function clampInt(v, { min, max }) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export function createSettings({ dir, config = {} } = {}) {
  const file = path.join(dir, 'settings.json');
  function readFile() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
  }
  function get() {
    const spec = SETTINGS_LIMITS.maxConcurrentPerMachine;
    const saved = readFile();
    return {
      maxConcurrentPerMachine: clampInt(saved.maxConcurrentPerMachine, spec) ?? clampInt(config.maxConcurrentPerMachine, spec) ?? spec.default,
    };
  }
  function set(patch) {
    const spec = SETTINGS_LIMITS.maxConcurrentPerMachine;
    const next = { ...readFile() };
    if (patch.maxConcurrentPerMachine !== undefined) {
      const n = clampInt(patch.maxConcurrentPerMachine, spec);
      if (n === null) throw new Error(`上限要在 ${spec.min}–${spec.max} 之间`);
      next.maxConcurrentPerMachine = n;
    }
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return get();
  }
  return { file, get, set };
}
