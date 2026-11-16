// 状态行的那一句（docs/superpowers/specs/2026-11-16-xin-workbench-round3-design.md 第 1 节）。
// 站长 2026-11-16：「希望像 grok bot 那样根据用户的输入问题，显示相关的文字」。
// 前台一开始，用网关上最快的模型把站长这句话（带上一轮小芯说的做上下文）概括成「现在要做的事」：6–14 个字、动词开头，
// 如「查 Gemini 4 Hydrogen 的评测」。「正在输入」那一行先写它，做哪一步再换成那一步。
// 照 open-webui 的「任务模型」做法（backend/open_webui/utils/middleware.py：联网前先用小模型从用户这句话生成搜索词，
// 发 status 事件，界面显示「正在搜索 “…”」）。它只决定状态行写什么，不参与回答：5 秒没回、出错、内容不像一句状态都丢掉。
export const STATUS_MODEL = 'deepseek-v4.1-flash';
const PROMPT = '你是聊天界面的状态栏，不回答问题。根据「上一轮小芯说的」和「站长这句话」，写出小芯现在要做的事：' +
  '6 到 14 个字，动词开头，具体到对象（型号、文件、网站、人名照原样写），不加主语、句号、引号、表情。只输出这一句。\n' +
  '例：查 Gemini 4 Hydrogen 的评测\n例：计算定时器溢出时间\n例：查看今天的签到记录\n例：回复问候';

// 模型回的那一句 → 能放进状态行的样子；不像就给空串
export function statusText(raw) {
  let s = String(raw || '').split('\n').map(x => x.trim()).find(Boolean) || '';
  s = s.replace(/^(状态栏?|现在|正在)\s*[:：]\s*/, '');
  s = s.replace(/^[「『“"'‘《【（(\[\s]+/, '').replace(/[」』”"'’》】）)\]\s。．.!！?？,，、;；:：~～…]+$/, '').trim();
  const n = [...s].length;
  if (n < 3 || n > 24) return '';
  if (/^(我|你|好的|当然|抱歉|对不起|作为|嗨|哈)/.test(s)) return '';   // 像在回答、在聊天，不像一句状态
  return s;
}
// 历史里最后一条小芯说的话（字符串，或 Responses 那种 [{type, text}]）
function lastSaid(history) {
  for (let i = (history || []).length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h || h.role !== 'assistant') continue;
    const c = h.content, t = typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p && typeof p.text === 'string' ? p.text : '').join('') : '';
    if (t.trim()) return t.trim();
  }
  return '';
}
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
function outputText(d) {
  if (d && typeof d.output_text === 'string') return d.output_text;
  return ((d && d.output) || []).flatMap(o => (o && o.content) || []).filter(c => c && c.type === 'output_text').map(c => c.text || '').join('');
}
// → {text, model, usage:{input, cached, output}}；出错、超时、空的给 null
export async function frontStatus({ baseURL, key, fetch: f = fetch, text, history, signal, ms = 5000 }) {
  const q = String(text || '').trim();
  if (!q || !baseURL) return null;
  const said = lastSaid(history), ctl = new AbortController(), stop = () => ctl.abort(), timer = setTimeout(stop, ms);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const r = await f(String(baseURL).replace(/\/$/, '') + '/responses', {
      method: 'POST', signal: ctl.signal, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: STATUS_MODEL, stream: false, reasoning: { effort: 'none' }, max_output_tokens: 40, instructions: PROMPT,
        input: [{ role: 'user', content: [{ type: 'input_text', text: (said ? '上一轮小芯说的：' + cut(said, 200) + '\n' : '') + '站长这句话：' + cut(q, 400) }] }] })
    });
    if (!r || !r.ok) return null;
    const d = await r.json(), t = statusText(outputText(d)), u = (d && d.usage) || {};
    return t ? { text: t, model: STATUS_MODEL, usage: { input: u.input_tokens || 0, cached: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0, output: u.output_tokens || 0 } } : null;
  } catch { return null; } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}
