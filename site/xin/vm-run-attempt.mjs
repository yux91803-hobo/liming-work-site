// Execution identity fences late reports. It is not an authorization credential.
import crypto from 'node:crypto';

// Publish the reader/bridge before enabling allocation, so the rollback target understands in-flight attempts.
export const ATTEMPTS_DEFAULT = true;
export const attemptsEnabled = (env = process.env) => env.XIN_RUN_ATTEMPTS === '1' || env.XIN_RUN_ATTEMPTS !== '0' && ATTEMPTS_DEFAULT;
export const nextAttempt = meta => meta?.attempt || meta?.attemptProtocol === 1 ? crypto.randomBytes(16).toString('hex') : null;
export const staleAttempt = () => ({ error: 'stale_attempt', msg: '这一轮的执行尝试已过期，报告未应用' });
export function attemptError(meta, { run, attempt } = {}) {
  if (!meta?.attempt && !attempt) return null; // Old in-flight runners remain untagged until they exit.
  return run && meta?.run === run && meta.attempt && meta.attempt === attempt ? null : staleAttempt();
}
export function assertAttempt(meta, context) {
  const error = attemptError(meta, context);
  if (error) throw Object.assign(new Error(error.msg), { code: error.error });
}
