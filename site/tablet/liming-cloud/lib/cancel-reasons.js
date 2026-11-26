// 平板后台任务被取消时，原因决定要不要停云端（设计 §5.6 取消原因表）。
// 下面这些是平板引擎自己退出、清理时 dsh-jobs 给的原因：只说明平板不跟了，云端任务照常跑，绝不停云端。
// 其余原因（模型调 job_kill 填的话、网页「停止」的 cancelled by the user、归档对话的 session archived）都要停云端。
// 原因字符串在真实 Harness 0.2.2-rc.1 和 0.2.2-rc.3 上实测过（设计 §11 E7b–E7e）；单测会扫已装 Harness 的源码防漂移。
export const DETACH_ONLY_REASONS = Object.freeze(['owner disposed', 'jobs service disposed', 'jobs teardown', 'teardown']);

const DETACH = new Set(DETACH_ONLY_REASONS);

export function isDetachReason(reason) {
  return DETACH.has(String(reason ?? '').trim());
}
