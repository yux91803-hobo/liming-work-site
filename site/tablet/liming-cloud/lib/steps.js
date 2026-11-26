// 云端对话事件 → 「步骤」的投影（纯函数）。只取三类：调了什么工具、AI 简短的回话、这一轮怎么结束的；
// 不搬运工具的完整输出。每条都截短，面板、后台任务输出和状态条共用。事件格式见真实 dsh web 的 session/follow。
// job/registered 不算一步：真实 Harness 里前台 bash 也会登记，和 tool/call 重复。
const MAX_LINE = 120;

export function clip(text, max = MAX_LINE) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
}

function toolArgs(name, raw) {
  let args = raw;
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw); } catch { return clip(raw, 80); }
  }
  if (!args || typeof args !== 'object') return '';
  if (name === 'bash') return clip(args.description || args.command || '', 80);
  const first = args.description || args.path || args.file_path || args.url || args.query || args.pattern || args.command;
  return first ? clip(first, 80) : '';
}

// 一轮结束的原因 → 台账状态、后台任务结果、给人看的一句话
export function turnOutcome(reason) {
  const kind = reason && reason.kind;
  switch (kind) {
    case 'completed': return { status: 'completed', job: 'completed', label: '完成' };
    case 'max-tokens': return { status: 'completed', job: 'completed', label: '完成（输出到了长度上限）' };
    case 'aborted': return { status: 'stopped', job: 'killed', label: '已停止' };
    case 'interrupted': return { status: 'interrupted', job: 'failed', label: '云端中断' };
    case 'error': {
      const e = reason.error || {};
      return { status: 'failed', job: 'failed', label: `出错：${clip(e.message || e.code || '未知错误', 80)}` };
    }
    default: return { status: 'failed', job: 'failed', label: `结束（${kind || '原因不明'}）` };
  }
}

// 一个事件 → 一条步骤（不是步骤类的事件返回 null）
export function stepOf(event) {
  if (!event || typeof event.type !== 'string') return null;
  const d = event.data || {};
  const seq = event.seq;
  if (event.type === 'tool/call') {
    const args = toolArgs(d.name, d.arguments);
    return { seq, kind: 'tool', text: clip(`${d.name}${args ? ` · ${args}` : ''}`) };
  }
  if (event.type === 'assistant/message') {
    const text = textOf(d.message && d.message.content);
    return text.trim() ? { seq, kind: 'say', text: clip(text) } : null;
  }
  if (event.type === 'turn/end') return { seq, kind: 'end', text: turnOutcome(d.reason).label };
  return null;
}

// 这一轮 AI 最后说的话（结果摘要）：从后往前找，不越过 fromSeq（这一轮的起点）
export function lastAssistantText(events, { fromSeq = 0, max = 800 } = {}) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || (e.seq ?? 0) <= fromSeq) break;
    if (e.type !== 'assistant/message') continue;
    const text = textOf(e.data && e.data.message && e.data.message.content).trim();
    if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
  return '';
}
