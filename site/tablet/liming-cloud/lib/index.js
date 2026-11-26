// DSH（Cordis）插件入口：平板本机 AI 按需把活派给 li、li2 云电脑（设计 docs/superpowers/specs/2026-11-26-tablet-cloud-tasks-design.md）。
// 注册 cloud_run、cloud_tell、cloud_machines 三个工具和一段使用说明；任务的进度、列表、停止复用原生 job_output、job_list、job_kill。
import { DEFAULT_CLOUD_DIR, createLedger } from './ledger.js';
import { createOutbox } from './outbox.js';
import { createRedactingLogger } from './redact.js';
import { createSecretsStore } from './secrets.js';
import { createTunnelManager } from './ssh-tunnel.js';
import { createRemote } from './remote.js';
import { createRunner } from './runner.js';
import { createCloudTools } from './tools.js';
import { createSettings } from './settings.js';
import { readMachine } from './instabox-read.js';
import { createRecovery } from './recovery.js';
import { attachUi } from './ui.js';

export const name = 'liming-cloud';
export const inject = ['tools', 'jobs', 'agents', 'systemPrompt'];

export const GUIDANCE = [
  '你可以把活交给站长的两台云电脑（li、li2）在后台做：用 cloud_run。',
  '长任务、写代码和编译、查资料写报告、要用云端浏览器的事就派；随手能答的不派。派之前不用问站长，派完接着和站长聊，不要干等。',
  '进度用 job_output 看，job_list 列出，job_kill 停止；做完会自动通知你，再把结果告诉站长。补充要求或接着做用 cloud_tell。',
  '两台现状用 cloud_machines 看。挑机器的理由和提醒（比如「大约 N 分钟后会暂停」）照实转告站长。',
].join('\n');

export function createCloudRuntime(config = {}) {
  const dir = config.dir || DEFAULT_CLOUD_DIR;
  const secrets = createSecretsStore({ dir, filePath: config.secretsFile });
  const logger = createRedactingLogger(config.logger, () => secrets.knownSecrets());
  const ledger = createLedger({
    dir,
    filePath: config.ledgerFile,
    workspaceRoot: config.workspaceRoot,
    migrations: config.migrations,
    now: config.now,
  });
  const outbox = createOutbox(ledger, { now: config.now, generateRequestId: config.generateRequestId });
  const tunnels = createTunnelManager({
    sshBin: config.sshBin,
    controlDir: config.controlDir,
    idleCloseMs: config.idleCloseMs,
    backoffMs: config.backoffMs,
    connectTimeoutMs: config.connectTimeoutMs,
    execTimeoutMs: config.execTimeoutMs,
    stopGraceMs: config.stopGraceMs,
    logger,
  });

  function start() {
    ledger.init();
    logger.info('liming-cloud 已就绪');
  }

  async function stop() {
    await tunnels.closeAll();
  }

  return { dir, secrets, ledger, outbox, tunnels, logger, start, stop };
}

export function apply(ctx, config = {}) {
  let rawLogger = null;
  try { rawLogger = typeof ctx.logger === 'function' ? ctx.logger(name) : null; } catch {}
  const runtime = createCloudRuntime({ ...config, logger: config.logger || rawLogger });
  const { secrets, ledger, outbox, tunnels, logger } = runtime;
  const settings = createSettings({ dir: runtime.dir, config });
  const remote = createRemote({ secrets, tunnels, direct: config.direct || null, launchCommand: config.launchCommand });
  // 任务一有变化就通知界面（状态条、面板）
  const listeners = new Set();
  const notify = (taskId) => { for (const l of [...listeners]) { try { l(taskId); } catch {} } };
  const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
  const runner = createRunner({ jobs: ctx.jobs, ledger, outbox, remote, logger, provider: config.provider || 'xin-gateway', onChange: notify });
  const readStatus = async (machine) => {
    if (config.statuses && config.statuses[machine]) return config.statuses[machine];
    let readKey = '';
    try { readKey = secrets.getMachine(machine)?.readKey || ''; } catch {}
    return readMachine({ readKey, name: machine });
  };

  const recovery = createRecovery({ runner, ledger, agents: ctx.agents, readStatus, logger, onChange: notify });

  for (const def of createCloudTools({ runner, ledger, remote, readStatus, settings: () => settings.get() })) ctx.tools.register(def);
  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    ctx.systemPrompt.section({ name: 'liming-cloud', order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS'), text: GUIDANCE });
  }

  // 状态条和「云端任务」面板：只在装了 dsh-go 桥接的主机上挂（写 ['dshGo']，不放进顶层 inject，见 DSH Go docs/plugins/slots.md）
  ctx.inject(['dshGo'], (uiCtx) => attachUi(uiCtx, { runner, ledger, settings, readStatus, subscribe, recovery, machines: () => remote.machines() }));

  // 对话日志里出现通知才记「已告诉」；代理出现（站长回到某段对话）时补说、接上没在跟的任务
  ctx.on('session/event', (session, event) => { try { recovery.onSessionEvent(session, event); } catch (err) { logger.warn(`确认通知出错：${err.message}`); } });
  ctx.on('agent/created', ({ agent }) => { try { recovery.onAgentCreated(agent); } catch (err) { logger.warn(`对账出错：${err.message}`); } });

  ctx.effect(() => {
    try {
      runtime.start();
      recovery.sweep().catch(err => logger.warn(`启动对账出错：${err.message}`));
    } catch (err) {
      logger.error(`liming-cloud 初始化失败：${err.message}`);
    }
    return async () => {
      recovery.dispose();
      await runner.dispose();
      await remote.dispose();
      await runtime.stop();
    };
  });
  return { ...runtime, settings, remote, runner, recovery };
}
