// DSH（Cordis）插件入口（阶段 2 最小骨架）：挂载台账、密钥存储、发件箱、SSH 隧道与生命周期清理。
// 本阶段不注册面向模型的工具、不挂载 UI 面板（分别在阶段 3、4 接入）。
import { DEFAULT_CLOUD_DIR, createLedger } from './ledger.js';
import { createOutbox } from './outbox.js';
import { createRedactingLogger } from './redact.js';
import { createSecretsStore } from './secrets.js';
import { createTunnelManager } from './ssh-tunnel.js';

export const name = 'liming-cloud';

export function createCloudRuntime(config = {}) {
  const dir = config.dir || DEFAULT_CLOUD_DIR;
  const secrets = createSecretsStore({
    dir,
    filePath: config.secretsFile,
  });
  const logger = createRedactingLogger(config.logger, () => secrets.knownSecrets());
  const ledger = createLedger({
    dir,
    filePath: config.ledgerFile,
    workspaceRoot: config.workspaceRoot,
    migrations: config.migrations,
    now: config.now,
  });
  const outbox = createOutbox(ledger, {
    now: config.now,
    generateRequestId: config.generateRequestId,
  });
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
    logger.info('liming-cloud 核心台账与传输骨架已就绪');
  }

  async function stop() {
    await tunnels.closeAll();
    logger.info('liming-cloud 隧道与资源已清理');
  }

  return {
    dir,
    secrets,
    ledger,
    outbox,
    tunnels,
    logger,
    start,
    stop,
  };
}

export function apply(ctx, config = {}) {
  let rawLogger = null;
  try { rawLogger = typeof ctx.logger === 'function' ? ctx.logger(name) : null; } catch {}
  const runtime = createCloudRuntime({ ...config, logger: config.logger || rawLogger });
  ctx.effect(() => {
    try {
      runtime.start();
    } catch (err) {
      runtime.logger.error(`liming-cloud 初始化失败：${err.message}`);
    }
    return () => runtime.stop();
  });
  return runtime;
}
