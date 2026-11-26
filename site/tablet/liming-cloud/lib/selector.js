// 选机器（设计 §5.3）：纯函数，不写调度器。顺序：
//   点名 / 接着做 → 只认那台；否则排除冷却中和已满的，再按「本轮剩余不足的靠后 → 同项目或 STM32 → 醒着 → 平板任务少 → 最久没用」挑。
// InstaBox 读 CPU 的接口会唤醒机器，所以不比 CPU（设计里的「再比 CPU」不做）。
export const DEFAULT_MAX_PER_MACHINE = 2;
export const LOW_REMAINING_MIN = 45;
export const ACTIVE_STATUSES = Object.freeze(['dispatching', 'running', 'stopping']);
export const STM32_RE = /stm32|arm-none-eabi|openocd|st-?link|cubemx|cubeide|keil|单片机|固件|烧录/i;

const ACTIVE = new Set(ACTIVE_STATUSES);

// 北京时间 HH:MM（不依赖 ICU）
export function beijingHHMM(ms) {
  const d = new Date(ms + 8 * 3600e3);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function coolingUntil(status, now) {
  return status && status.known && Number.isFinite(status.cooldownUntil) && status.cooldownUntil > now ? status.cooldownUntil : null;
}

function lowRemaining(status) {
  return Boolean(status && status.known && status.awake && Number.isFinite(status.remainingMin) && status.remainingMin < LOW_REMAINING_MIN);
}

function freezeWarning(name, status) {
  return `${name} 大约 ${Math.max(0, Math.round(status.remainingMin))} 分钟后会暂停，到时任务冻结，冷却结束后接着跑`;
}

export function chooseMachine({
  machines = [],
  tasks = [],
  task = '',
  machine = null,
  project = null,
  continueOf = null,
  maxPerMachine = DEFAULT_MAX_PER_MACHINE,
  stm32Machine = 'li',
  now = Date.now(),
} = {}) {
  const limit = Number.isInteger(maxPerMachine) && maxPerMachine > 0 ? maxPerMachine : DEFAULT_MAX_PER_MACHINE;
  const byName = new Map(machines.map(m => [m.name, m]));
  const active = name => tasks.filter(t => t.machine === name && ACTIVE.has(t.status)).length;
  const lastUsed = name => tasks.filter(t => t.machine === name).reduce((max, t) => Math.max(max, t.updatedAt || t.createdAt || 0), 0);
  const blockedReason = (m) => {
    const until = coolingUntil(m.status, now);
    if (until) return `${m.name} 在冷却（到 ${beijingHHMM(until)}）`;
    const n = active(m.name);
    if (n >= limit) return `${m.name} 已有 ${n} 个平板任务在跑（上限 ${limit}）`;
    return null;
  };
  const pinned = (name, why) => {
    const m = byName.get(name);
    if (!m) return { ok: false, reason: `没有配置机器 ${name}` };
    const blocked = blockedReason(m);
    if (blocked) return { ok: false, reason: blocked };
    const out = { ok: true, machine: name, reason: `${name}：${why}` };
    if (lowRemaining(m.status)) out.warning = freezeWarning(name, m.status);
    return out;
  };

  if (continueOf) {
    const prev = tasks.find(t => t.taskId === continueOf);
    if (!prev) return { ok: false, reason: `台账里没有任务 ${continueOf}` };
    return pinned(prev.machine, `接着 ${continueOf} 做，对话在这台上`);
  }
  if (machine) return pinned(machine, '点名用这台');
  if (machines.length === 0) return { ok: false, reason: '还没配置云电脑' };

  const notes = [];
  const candidates = [];
  for (const m of machines) {
    const blocked = blockedReason(m);
    if (blocked) notes.push(blocked);
    else candidates.push(m);
  }
  if (candidates.length === 0) {
    const untils = machines.map(m => coolingUntil(m.status, now)).filter(Boolean);
    if (untils.length === machines.length) {
      const earliestAt = Math.min(...untils);
      return { ok: false, reason: `两台都在冷却，最早 ${beijingHHMM(earliestAt)} 能用（${notes.join('；')}）`, earliestAt };
    }
    return { ok: false, reason: `现在派不了：${notes.join('；')}` };
  }

  const wantsStm32 = STM32_RE.test(String(task || ''));
  const sameProject = name => Boolean(project) && tasks.some(t => t.machine === name && t.project === project);
  const affinity = m => (sameProject(m.name) || (wantsStm32 && m.name === stm32Machine)) ? 1 : 0;
  const awakeScore = m => (!m.status || !m.status.known) ? 1 : (m.status.awake ? 2 : 0);
  const ranked = [...candidates].sort((a, b) =>
    (lowRemaining(a.status) - lowRemaining(b.status))
    || (affinity(b) - affinity(a))
    || (awakeScore(b) - awakeScore(a))
    || (active(a.name) - active(b.name))
    || (lastUsed(a.name) - lastUsed(b.name)));
  const chosen = ranked[0];

  const why = [];
  if (sameProject(chosen.name)) why.push(`项目 ${project} 在这台上`);
  else if (wantsStm32 && chosen.name === stm32Machine) why.push('要用 STM32 工具链');
  if (!chosen.status || !chosen.status.known) why.push(`${chosen.name} 状态未知${chosen.status && chosen.status.reason ? `（${chosen.status.reason}）` : ''}`);
  else why.push(chosen.status.awake ? '醒着' : '睡着，派活会叫醒它（约 40 秒）');
  why.push(active(chosen.name) ? `平板在这台有 ${active(chosen.name)} 个任务` : '平板在这台没有任务');
  for (const m of machines) {
    if (m !== chosen && (!m.status || !m.status.known)) notes.push(`${m.name} 状态未知`);
  }
  const out = { ok: true, machine: chosen.name, reason: `${chosen.name}：${why.join('，')}${notes.length ? `（${notes.join('；')}）` : ''}` };
  const warnings = [];
  if (lowRemaining(chosen.status)) warnings.push(freezeWarning(chosen.name, chosen.status));
  if (wantsStm32 && chosen.name !== stm32Machine) warnings.push(`${chosen.name} 没有 STM32 工具链，编译烧录要等 ${stm32Machine} 能用`);
  if (warnings.length) out.warning = warnings.join('；');
  return out;
}
