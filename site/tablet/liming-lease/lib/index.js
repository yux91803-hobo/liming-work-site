// DSH（Cordis）插件入口：装在 li、li2 的 dsh web 配置里。有对话在忙（agent/status: running）或有后台命令在跑
// （对话日志里 job/registered 到 job/settled 之间）就持有 InstaBox 活动租约，全部空闲 2 分钟后释放。见 lease.js。
import os from 'node:os';
import path from 'node:path';
import { createLeaseKeeper, readLeaseFiles } from './lease.js';

export const name = 'liming-lease';

export function apply(ctx, config = {}) {
  const dir = config.dir || path.join(os.homedir(), '.liming-cloud');
  let logger = null;
  try { logger = typeof ctx.logger === 'function' ? ctx.logger(name) : null; } catch {}
  const first = readLeaseFiles(dir);
  for (const w of first.warnings) { try { logger?.warn?.(w); } catch {} }
  const keeper = createLeaseKeeper({
    readKey: () => readLeaseFiles(dir).key,
    machineName: () => readLeaseFiles(dir).name,
    logger,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.renewMs ? { renewMs: config.renewMs } : {}),
    ...(config.releaseAfterMs ? { releaseAfterMs: config.releaseAfterMs } : {}),
  });

  ctx.on('agent/status', ({ agent, status }) => {
    if (agent && agent.id) keeper.setBusy(`agent:${agent.id}`, status === 'running');
  });
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent && agent.id) keeper.setBusy(`agent:${agent.id}`, false);
  });
  ctx.on('session/event', (_session, event) => {
    const jobId = event && event.data && event.data.jobId;
    if (!jobId) return;
    if (event.type === 'job/registered') keeper.setBusy(`job:${jobId}`, true);
    else if (event.type === 'job/settled') keeper.setBusy(`job:${jobId}`, false);
  });

  ctx.effect(() => () => keeper.dispose());
  return keeper;
}
