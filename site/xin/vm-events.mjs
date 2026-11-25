// Normalises Claude Code / Codex / Harness JSON output into the controller's event format.
import { cut } from './vm-base.mjs';
import { bareCmd } from './vm-screen.mjs';
export const OUT_MAX = 2000;   // 一个工具输出最多带回多少字

/* ---------- 把 Claude Code / Codex 的 JSON 输出整理成统一的事件 ----------
   {t:'text', text}                    AI 说的话
   {t:'tool', id, name, detail}        AI 开始执行一个工具（命令、改文件…）
   {t:'tool_end', id, ok, out, name?, detail?}
   {t:'status', text}                  临时状态（重连之类），不算错
   {t:'think', text, src}              它在想什么：src 'model' 是模型自己的思考（英文居多，只在终端里画），'status' 是前台概括的一句（状态行）
   {t:'err', text}                     出错
   state 里记 sid（AI 自己的会话号）、failed、cost */
export function detailOf(name, input) {
  input = input || {};
  if (name === 'Bash') return String(input.command || '');
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern) + (input.path ? '  ' + input.path : '');
  if (input.url) return String(input.url);
  if (input.description) return String(input.description);
  if (input.query) return String(input.query);
  try { return cut(JSON.stringify(input), 300); } catch { return ''; }
}
export function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => x && (x.text != null ? x.text : x.type === 'image' ? '[图片]' : '')).filter(Boolean).join('\n');
  return c == null ? '' : JSON.stringify(c);
}
export function fromClaude(o, state) {
  const out = [];
  if (!o || typeof o !== 'object') return out;
  if (o.type === 'system' && o.subtype === 'init') { if (o.session_id) state.sid = o.session_id; if (o.model) state.model = o.model; return out; }
  if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
    if (o.error || o.is_api_error_message) {
      const t = o.message.content.map(c => c && c.text).filter(Boolean).join('\n') || String(o.error);
      state.failed = true; state.errShown = true;
      out.push({ t: 'err', text: t });
      return out;
    }
    for (const c of o.message.content) {
      if (!c) continue;
      if (c.type === 'text' && c.text && c.text.trim()) out.push({ t: 'text', text: c.text });
      else if (c.type === 'tool_use') out.push({ t: 'tool', id: c.id, name: c.name, detail: cut(detailOf(c.name, c.input), 600) });
    }
    return out;
  }
  if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
    for (const c of o.message.content) {
      if (c && c.type === 'tool_result') out.push({ t: 'tool_end', id: c.tool_use_id, ok: !c.is_error, out: cut(resultText(c.content), OUT_MAX) });
    }
    return out;
  }
  if (o.type === 'result') {
    if (typeof o.total_cost_usd === 'number') state.cost = o.total_cost_usd;
    // 模型的上下文上限（网页显示上下文用了多少）；几个模型时取最大的那个（主模型）
    for (const k in o.modelUsage || {}) { const w = o.modelUsage[k] && o.modelUsage[k].contextWindow; if (w > (state.ctxWin || 0)) state.ctxWin = w; }
    if (o.session_id) state.sid = o.session_id;
    if (o.is_error) {
      state.failed = true;
      if (!state.errShown) { state.errShown = true; out.push({ t: 'err', text: String(o.result || o.subtype || '出错了') }); }
    }
  }
  return out;
}
export function codexCmd(c) {
  if (Array.isArray(c)) { const i = c.indexOf('-lc'); return i >= 0 && c[i + 1] ? c[i + 1] : c.join(' '); }
  return String(c || '');
}
export function fromCodex(o, state) {
  const out = [];
  if (!o || typeof o !== 'object') return out;
  if(o.type==='xin.usage'){
    const u=o.usage||{},p=state.frontUsage||{input:0,output:0,cached:0};
    const input=p.input+(u.input_tokens||0),output=p.output+(u.output_tokens||0);
    state.frontUsage={input,output,cached:p.cached+(u.cache_read_tokens||0),total:input+output,ctx:(u.input_tokens||0)+(u.output_tokens||0),win:1000000};return out;
  }
  if(o.type==='xin.steer_ack'&&typeof o.claim==='string'){state.ackedSteers=[...new Set([...(state.ackedSteers||[]),o.claim])].slice(-128);return out;}
  if (o.type === 'thread.started') { if (o.thread_id) state.sid = o.thread_id; return out; }
  if (o.type === 'error') {
    const m = String(o.message || '');
    if (/^Reconnecting/i.test(m)) out.push({ t: 'status', text: m });
    else { state.lastErr = m; }
    return out;
  }
  if (o.type === 'turn.failed') {
    state.failed = true; state.errShown = true;
    out.push({ t: 'err', text: String((o.error && o.error.message) || state.lastErr || '这一轮失败了') });
    return out;
  }
  const it = o.item;
  if (!it || (o.type !== 'item.started' && o.type !== 'item.completed' && o.type !== 'item.updated')) return out;
  const done = o.type === 'item.completed';
  // 真的开始干活了（说了话、执行了命令、改了文件、调了插件）：之后失败也不换模型重来，免得同一件事做两遍
  if (/^(agent_message|command_execution|file_change|mcp_tool_call|web_search)$/.test(it.type || '')) state.worked = true;
  switch (it.type) {
    case 'agent_message': if (done && it.text) out.push({ t: 'text', text: it.text }); break;
    case 'command_execution': {
      const detail = cut(codexCmd(it.command), 600);
      if (o.type === 'item.started') out.push({ t: 'tool', id: it.id, name: 'Bash', detail });
      else if (done) out.push({ t: 'tool_end', id: it.id, name: 'Bash', detail, ok: it.exit_code === 0 || (it.exit_code == null && it.status === 'completed'), out: cut(it.aggregated_output || '', OUT_MAX) });
      break;
    }
    case 'file_change': if (done) {
      const kind = c => c.kind ? (typeof c.kind==='object'?c.kind.type:c.kind) + ' ' : '', changes = it.changes || [];
      const detail = changes.map(c => kind(c) + c.path).join('\n');
      // 改动差异（Codex app-server 的 FileUpdateChange.diff）按文件拼起来，网页的终端画成红绿行；旧的 exec 事件没有就是空的
      const diff = changes.filter(c => typeof c.diff === 'string' && c.diff).map(c => '--- ' + kind(c) + c.path + '\n' + c.diff.replace(/\n+$/, '')).join('\n');
      out.push({ t: 'tool_end', id: it.id, name: 'Edit', detail: cut(detail, 600), ok: it.status !== 'failed', out: cut(diff, OUT_MAX) });
    } break;
    case 'mcp_tool_call': {
      const detail = [it.server, it.tool].filter(Boolean).join(' · ');
      if (o.type === 'item.started') out.push({ t: 'tool', id: it.id, name: 'MCP', detail });
      else if (done) out.push({ t: 'tool_end', id: it.id, name: 'MCP', detail, ok: it.status !== 'failed', out: cut(it.error ? (it.error.message || JSON.stringify(it.error)) : resultText(it.result && it.result.content), OUT_MAX) });
      break;
    }
    case 'web_search': {
      // 开始时就说在搜什么（知道的话），做完再给一条；打开网页（action.type = open_page）记成 WebFetch，不混成搜索
      const open = (it.action && it.action.type === 'open_page') || false, name = open ? 'WebFetch' : 'WebSearch';
      const detail = String((open ? it.action.url || it.query : it.query || (it.action && it.action.query)) || '');
      if (o.type === 'item.started') { if (detail) out.push({ t: 'tool', id: it.id, name, detail }); }
      else if (done) out.push({ t: 'tool_end', id: it.id, name, detail, ok: true, out: '' });
      break;
    }
    case 'reasoning': if (done && it.text) { const t = thoughtLine(it.text); if (t) out.push({ t: 'think', text: t, src: 'model' }); } break;
    case 'error': if (done) out.push({ t: 'status', text: String(it.message || '') }); break;   // Codex 的警告（真失败看 turn.failed）
    default: break;   // todo_list 之类不显示
  }
  return out;
}

// Harness 的事件 → 网页的事件。用量（step_end 的 usage）攒在 state.hu：最近一步的输入算上下文，加起来算消耗
export function harnessResult(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) return r.map(harnessResult).join('');
  if (typeof r === 'object' && typeof r.text === 'string') return r.text;
  return JSON.stringify(r);
}
function harnessError(value, depth = 0) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || depth >= 4) return '';
  for (const key of ['message', 'error', 'reason', 'code']) {
    const text = harnessError(value[key], depth + 1);
    if (text) return text;
  }
  return '';
}
export function fromHarness(o, state) {
  const out = [];
  if (!o || typeof o !== 'object') return out;
  state.tools = state.tools || {};
  switch (o.type) {
    case 'session': if (typeof o.sessionId === 'string') state.sid = o.sessionId; break;
    case 'text': if (o.text) out.push({ t: 'text', text: String(o.text) }); break;
    case 'tool_call': {
      const inp = o.input || {}, name = o.tool === 'bash' ? 'Bash' : String(o.tool || '工具');
      const detail = cut(typeof inp.command === 'string' ? inp.command : JSON.stringify(inp), 600);
      state.tools[o.callId] = { name, detail };
      out.push({ t: 'tool', id: o.callId, name, detail });
      break;
    }
    case 'tool_result': {
      const t = state.tools[o.callId] || { name: '工具', detail: '' };
      out.push({ t: 'tool_end', id: o.callId, name: t.name, detail: t.detail, ok: o.status === 'completed', out: cut(harnessResult(o.result != null ? o.result : o.error), OUT_MAX) });
      break;
    }
    case 'status':
      if (o.phase === 'step_end' && o.usage) {
        // inputTokens 只是没命中缓存的输入，命中缓存的在 cacheReadTokens（站长 11-20：以前漏了它，上下文算成 5 千、实际 35 万）
        const u = o.usage, hu = state.hu = state.hu || { input: 0, cached: 0, output: 0, last: 0, hit: false };
        const hit = u.cacheReadTokens || 0;
        hu.input += (u.inputTokens || 0) + hit; hu.cached += hit; hu.output += u.outputTokens || 0;
        if (typeof u.cacheReadTokens === 'number') hu.hit = true;   // 报了缓存命中才往外给 cached（老版本不报，网页就不显示命中率）
        hu.last = u.totalTokens || (u.inputTokens || 0) + hit + (u.outputTokens || 0);
      }
      if (o.phase === 'turn_end' && o.reason && o.reason.kind && o.reason.kind !== 'completed' && !state.errShown) {
        state.failed = true; state.errShown = true;
        out.push({ t: 'err', text: harnessError(o.reason.message) || harnessError(o.reason.error) || ('这一轮没做完（' + o.reason.kind + '）') });
      }
      break;
    case 'error': {
      state.failed = true;
      if (!state.errShown) { state.errShown = true; out.push({ t: 'err', text: harnessError(o.message) || harnessError(o.error) || harnessError(o.code) || '出错了' }); }
      break;
    }
    case 'thinking': {
      // 天启的思考（DeepSeek 多半想的是中文）：一段一段来，攒到一句话完了再给；思考从来不变成聊天里的话
      state.think = (state.think || '') + String(o.text || o.thinking || '');
      const m = /^([\s\S]*[。！？.!?])([^。！？.!?]*)$/.exec(state.think);
      if (m) { state.think = m[2]; const t = thoughtLine(lastSentence(m[1])); if (t) out.push({ t: 'think', text: t, src: 'model' }); }
      else if (state.think.length > 400) state.think = state.think.slice(-200);
      break;
    }
    default: break;   // final 不显示（final 和 text 一样）
  }
  return out;
}

/* ---------- 它在想什么、在做哪一步（状态行、任务卡片上的一行字）----------
   站长 2026-11-16：「希望像 grok bot 那样根据用户的输入问题显示相关的文字」「派了后台任务也要动态地在动」。 */
// 模型的思考 → 一行：有 **粗体** 标题就用标题（openai/codex codex-rs/tui/src/chatwidget.rs 的 extract_first_bold），
// 没有就去掉 Gemini 开头那句客套、取第一句（最多 160 字）；太短的不要
export function thoughtLine(text) {
  const raw = String(text || ''), bold = /\*\*([^*\n]{3,80})\*\*/.exec(raw);
  if (bold) return bold[1].trim();
  let t = raw.replace(/\s+/g, ' ').trim().replace(/^(I'm|I am) thinking through how to approach this\.?\s*/i, '');
  const m = /^(.{4,160}?[。！？.!?])(\s|$|[^.\d])/.exec(t);
  t = (m ? m[1] : t).slice(0, 160).trim();
  return [...t].length >= 8 ? t : '';
}
function lastSentence(s) {
  const parts = String(s || '').replace(/\s+/g, ' ').trim().split(/(?<=[。！？.!?])\s*/).filter(Boolean);
  // 最后一句太碎（只有几个字）就把前一句也带上
  let t = parts.pop() || '';
  while (parts.length && [...t].length < 8) t = parts.pop() + t;
  return t;
}
const hasCJK = s => /[\u3400-\u9fff]/.test(String(s || ''));
const shortPath = p => { const a = String(p || '').split('/').filter(Boolean); return a.length > 2 ? a.slice(-2).join('/') : a.join('/'); };
const shortUrl = u => String(u || '').replace(/^[a-z]+:\/\//i, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
const plain = (t, n) => { const s = String(t || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/^[ \t]*(#{1,6}|>+)[ \t]*/gm, '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// 最近的事件 → 「现在在做什么」一句（任务摘要的 activity；小芯岛和聊天里后台那一行用）。
// 从后往前找第一个有意义的：搜索、打开 / 读网页、执行命令、修改文件、它自己说的话、中文的思考、临时状态；内部命令（xin 后面不是 browser 的）不算
export function stepActivity(evs) {
  for (let i = (evs || []).length - 1; i >= 0; i--) {
    const e = evs[i] || {}, name = String(e.name || ''), d = bareCmd(String(e.detail || '')).replace(/\s+/g, ' ').trim();
    if (e.t === 'tool' || e.t === 'tool_end') {
      if (name === 'Bash' && /^xin(\s|$)/.test(d)) {
        const b = /^xin\s+browser\s+open\s+(\S+)/.exec(d);
        if (b) return (e.t === 'tool' ? '在打开网页：' : '在读网页：') + shortUrl(b[1]).slice(0, 80);
        continue;
      }
      if (e.t === 'tool_end' && e.ok === false) return '上一步失败，正在调整';
      if (name === 'WebSearch') return (e.t === 'tool' ? '在搜索：' : '在看搜索结果：') + d.slice(0, 80);
      if (name === 'WebFetch') return (e.t === 'tool' ? '在打开网页：' : '在读网页：') + shortUrl(d).slice(0, 80);
      if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return (e.t === 'tool' ? '在修改：' : '修改了：') + d.split('\n').map(l => shortPath(l.replace(/^(add|update|delete|create)\s+/, ''))).join('、').slice(0, 80);
      return (e.t === 'tool' ? '在执行：' : '执行完：') + (d || name).slice(0, e.t === 'tool' ? 90 : 80);
    }
    if (e.t === 'text' && e.text) return plain(e.text, 90);
    if (e.t === 'think' && e.text && hasCJK(e.text)) return '在想：' + plain(e.text, 80);
    if (e.t === 'status' && e.text && !/^Model metadata/i.test(e.text)) return String(e.text).slice(0, 90);
  }
  return '';
}
