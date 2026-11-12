// 后台任务一轮失败时，分清「临时的」（断线、网关暂时不可用、限流）和「做不下去的」（预算用完、上下文超长、
// 权限、超时、复核约束）。临时的由控制器等一会儿用同一个副本、同一个会话接着做，不交给前台模型判断。
// 参考 Grok Bot host/runner/transient-stream-error.ts（TRANSIENT_ERRNO_CODES / TRANSIENT_MESSAGE_TOKENS）。
const TRANSIENT = [
  /\b(?:ECONNRESET|ETIMEDOUT|EPIPE|ECONNABORTED|ECONNREFUSED|ENETRESET|ENETDOWN|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)\b/i,
  /socket hang up|premature close|stream (?:closed|disconnected)|closed stream|connection (?:reset|closed|terminated)|network error|fetch failed/i,
  /\b(?:429|500|502|503|504)\b/, /too many requests|rate.?limit|overloaded|service unavailable|bad gateway|gateway time-?out|temporarily unavailable/i
];
// 出现任何一个就不是临时错误，即使同时带着 5xx 或断线字样
const TERMINAL = [
  /budget|预算/i, /context[_ ](?:length|window)|too large|maximum context/i, /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid api key/i,
  /未知模型|model not found|not_found_error/i, /超过 \d+ 分钟/, /复核/
];
export function transientFailure(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim() || TERMINAL.some(r => r.test(s))) return false;
  return TRANSIENT.some(r => r.test(s));
}
// 拿去判断的只是「让这一轮结束的那个错误」：结束原因；没有就是最后一条错误事件；都没有才看 stderr 最后 6 行。
// 以前把这一轮所有错误事件和 stderr 后 2000 字一起判断，前面已经恢复了的断线重连字样会让后来真正的失败也被当成临时的，
// 白白重试三次（最长等 20 分钟）。Grok Bot 也只看结束这次流的那个错误（transient-stream-error.ts 的 isTransientStreamError(err)）。
export function finalFailure({ why = '', errs = [], stderr = '' } = {}) {
  if (String(why || '').trim()) return String(why);
  const last = (errs || []).filter(x => String(x || '').trim()).at(-1);
  if (last) return String(last);
  return String(stderr || '').trim().split('\n').slice(-6).join('\n');
}
const DEFAULT_DELAYS = [60000, 240000, 900000];
// 第 n 次重试前等多久（毫秒）；次数上限就是这张表的长度。XIN_RETRY_DELAYS_MS（逗号分隔）给测试调短。
export function retryDelays(env = process.env) {
  const list = String(env.XIN_RETRY_DELAYS_MS || '').split(',').map(Number).filter(n => Number.isFinite(n) && n > 0);
  return list.length ? list : DEFAULT_DELAYS.slice();
}
export const RETRY_TEXT = '（刚才连接模型出错，这一轮中断了。先看看现在的文件和进度，已经做过的有副作用的事别重做，接着把任务做完。）';
