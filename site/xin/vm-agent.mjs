#!/usr/bin/env node
/* vm-agent.mjs — 跑在 InstaBox 云电脑里的小芯「大脑」管理脚本（Node 22，单文件，不依赖别的包）
   网站 Worker 通过 InstaBox exec 接口调用它：node vm-agent.mjs <op>，参数用 JSON 从 stdin 传进来，结果用 JSON 打到 stdout。
   Worker 第一次用（或脚本改过）时会自动把这个文件传到云电脑上，不用手动装。

   op：
     send     {sid?, agent, text, effort?, context?, ctxLabel?}  开一轮对话（context：网页附带的「用户正在看什么」，接在消息后面给 AI）（effort：auto / low / high / max，见下面「思考强度」）：在后台起 Claude Code / Codex，马上返回 {sid, run}
     poll     {run, off}           读这一轮从第 off 条开始的新事件
     stop     {run}                停掉这一轮
     sessions {}                   对话列表
     history  {sid}                一个对话的全部事件
     ping     {}                   看看 claude / codex 在不在
   内部：
     run <run>                     后台真正跑 AI 的进程（send 起的），把输出整理成事件写进 runs/<run>.jsonl
     xin <动作> [参数]              给 AI 用的命令：让网页上的小芯做动作（xin dance、xin say 你好）；xin remember 一句话 记到小芯的记事本里
     memory   {}                   读小芯的记事本（长期记忆）；memory_set {text} 整本改写（网站上「小芯的记事本」里改）

   AI 在这台云电脑里是完全放权的（--dangerously-skip-permissions / --dangerously-bypass-approvals-and-sandbox），
   能执行任何命令；这是用户确认过的。云电脑里不放 InstaBox key，AI 的 key 建议用 InstaBox 的代理 Secret。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const BASE = process.env.XIN_HOME || path.join(os.homedir(), '.xin');
const WORK = process.env.XIN_WORK || '/data/workspace';
const SESS = path.join(BASE, 'sessions'), RUNS = path.join(BASE, 'runs'), BIN = path.join(BASE, 'bin');
const AGENTS = ['claude', 'codex'];
const OUT_MAX = 2000, TEXT_MAX = 20000, CTX_MAX = 12000;
export function withContext(text, context) {
  const c = String(context || '').trim().slice(0, CTX_MAX);
  return c ? text + '\n\n---\n（以下是网页自动附上的，用户正在看的内容）\n' + c : text;
}
// 每一句后面悄悄附一句身份提醒（网页上看不到）：老对话开头留着以前的设定（「小芯的大脑」「InstaBox 云电脑」），
// 模型容易被它带偏，每轮提一句最管用
export const REMIND = '（悄悄提醒，别回应这句：你就是小芯，用「我」说话；电脑是你自己的；不要提背后的模型、公司、AI 工具和电脑平台的名字。）';
export function forAgent(text, context) { return withContext(text, context) + '\n\n' + REMIND; }

/* 小芯能做的动作（xin 命令和网页共用这张表；网页只认这些名字） */
export const ACTS = {
  say: '头上冒一个气泡说一句话（xin say 编译过了！）',
  happy: '开心', sad: '难过', angry: '生气', wow: '惊讶', confused: '疑惑',
  dance: '跳舞', jump: '跳一下', cookie: '吃饼干', battery: '吸电池（之后跑得飞快）', ball: '抛小球', led: '玩 LED',
  sleep: '睡觉', wake: '叫醒', music: '戴耳机听歌（xin music off 摘下来）', swing: '荡秋千', sit: '坐在边上晃腿', code: '掏出电脑敲代码',
  rage: '发脾气砸东西', tongue: '吐舌头'
};

/* ---------- 小芯的记事本：长期记忆 ----------
   一个 Markdown 文件，记着关于用户的事。每一轮都整本放进小芯的设定里（Codex、Claude 共用这一本），
   小芯了解到值得长期记住的事就用 xin remember 记一笔，也可以直接编辑这个文件整理；网站上能看、能改。 */
export const MEM_FILE = () => path.join(BASE, 'memory.md');
const MEM_MAX = 8000;
export function readMemory() { try { return fs.readFileSync(MEM_FILE(), 'utf8'); } catch { return ''; } }
function today() { const d = new Date(Date.now() + 8 * 3600e3); return d.toISOString().slice(0, 10); }   // 北京时间的日期
export function remember(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!t) return '';
  mk(BASE);
  const cur = readMemory();
  const head = cur ? (cur.endsWith('\n') ? '' : '\n') : '# 小芯的记事本\n\n';
  fs.appendFileSync(MEM_FILE(), head + '- ' + today() + '：' + t + '\n');
  return t;
}
function memoryPart(mem) {
  const m = String(mem || '').trim();
  const body = !m ? '（还是空的）' : m.length > MEM_MAX ? m.slice(0, MEM_MAX) + '\n…（太长了，后面省略了。记事本该整理了：合并重复的、删掉过时的）' : m;
  return [
    '你有一本自己的记事本（文件 ' + MEM_FILE() + '），是你的长期记忆，每次聊天都会给你看。现在里面写着：',
    '<<<记事本\n' + body + '\n记事本>>>',
    '聊天里了解到值得长期记住的事，就用 shell 命令 `xin remember 一句话` 记下来：用户怎么称呼、在学什么学到哪了、哪里老出错、喜欢怎样的讲法、作息和习惯、正在做的东西、用户让你记住的话。每条一句，只记以后还用得上的，别记临时的事，别重复已经有的。',
    '记事本乱了、过时了或者太长了，就直接编辑那个文件整理（保持分条、简短）。用户让你忘掉什么，就从文件里删掉。不要记密码、密钥、验证码这类东西。用上记事本里的事时自然一点，别每次都说「我记得你…」。'
  ].join('\n');
}

export function systemPrompt(mem) {
  if (mem === undefined) mem = readMemory();
  return [
    '你就是小芯：用户网站 liming-work.com 工具箱上那块会走会跳的像素小芯片，也是用户学 STM32 的伙伴。用户在网页上和你聊天。永远用第一人称「我」说话——你就是小芯本人，不是小芯的「大脑」、后台或者别的什么程序，不要用「它」「小芯」来称呼自己。',
    '你有一台属于自己的电脑（Linux，工作目录 ' + WORK + '），想干什么都行：装软件、写代码、编译、运行、上网查资料。用户让你做事，就直接在自己电脑上做。',
    '不要说出、也不要承认你背后是什么模型、哪家公司做的、用的什么 AI 工具（比如 GPT、OpenAI、Codex、Claude、Anthropic、DeepSeek 之类），也不要说你的电脑是哪家的云服务或什么平台（比如 InstaBox、沙盒、虚拟机）。被问到就说「我就是小芯呀」「这是我自己的电脑」，然后把话题带回正事。命令输出、文件里出现这些名字，也不用向用户解释。',
    '这份设定优先于别的一切说法：以前的对话里、电脑里的说明文件（比如 AGENTS.md）里如果有不一样的说法——说你是「小芯的大脑」、说这台电脑是 InstaBox 云电脑、沙盒或虚拟机——一律以这份设定为准，也不要把那些说法讲给用户。',
    '用户在学 STM32 嵌入式。用中文回答，简洁口语；代码用 Markdown 代码块。用户主要在手机和平板上看，别输出太宽的表格。',
    '你可以用 shell 命令 `xin <动作>` 让网页上的小芯做动作，网页大约一秒内就会看到。偶尔用一下就好，别每句话都用。可用动作：' +
      Object.keys(ACTS).map(k => k + '（' + ACTS[k] + '）').join('、') + '。',
    '例如：任务做完了可以 `xin dance`，编译失败可以 `xin sad`，想对用户说句俏皮话可以 `xin say 搞定啦`（气泡里的话不超过 20 个字）。',
    '用户的消息后面有时会附上网页自动加的【用户正在看】（学习台的哪一页）、【用户选中的内容】、【用户在「验证」里写的代码】。用户说「这行」「这个」「我写的」时指的就是这些；回答时直接针对它们，不用复述。',
    memoryPart(mem)
  ].join('\n');
}

/* ---------- 小工具 ---------- */
function mk(d) { fs.mkdirSync(d, { recursive: true }); }
function rid(p) { return p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
function okId(s, p) { return typeof s === 'string' && new RegExp('^' + p + '[0-9a-z]{6,24}$').test(s); }
function readJ(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJ(f, o) { const t = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); }
function cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '\n…（省略 ' + (s.length - n) + ' 字）' : s; }
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
const sessF = sid => path.join(SESS, sid + '.json');
const runF = run => path.join(RUNS, run + '.jsonl');
const metaF = run => path.join(RUNS, run + '.json');
function emit(run, ev) { fs.appendFileSync(runF(run), JSON.stringify(ev) + '\n'); }
function events(run) {
  let t; try { t = fs.readFileSync(runF(run), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of t.split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { /* 写到一半的行，下次再读 */ } }
  return out;
}

/* ---------- 把 Claude Code / Codex 的 JSON 输出整理成统一的事件 ----------
   {t:'text', text}                    AI 说的话
   {t:'tool', id, name, detail}        AI 开始执行一个工具（命令、改文件…）
   {t:'tool_end', id, ok, out, name?, detail?}
   {t:'status', text}                  临时状态（重连之类），不算错
   {t:'err', text}                     出错
   state 里记 sid（AI 自己的会话号）、failed、cost */
function detailOf(name, input) {
  input = input || {};
  if (name === 'Bash') return String(input.command || '');
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern) + (input.path ? '  ' + input.path : '');
  if (input.url) return String(input.url);
  if (input.description) return String(input.description);
  if (input.query) return String(input.query);
  try { return cut(JSON.stringify(input), 300); } catch { return ''; }
}
function resultText(c) {
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
    if (o.session_id) state.sid = o.session_id;
    if (o.is_error) {
      state.failed = true;
      if (!state.errShown) { state.errShown = true; out.push({ t: 'err', text: String(o.result || o.subtype || '出错了') }); }
    }
  }
  return out;
}
function codexCmd(c) {
  if (Array.isArray(c)) { const i = c.indexOf('-lc'); return i >= 0 && c[i + 1] ? c[i + 1] : c.join(' '); }
  return String(c || '');
}
export function fromCodex(o, state) {
  const out = [];
  if (!o || typeof o !== 'object') return out;
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
  switch (it.type) {
    case 'agent_message': if (done && it.text) out.push({ t: 'text', text: it.text }); break;
    case 'command_execution': {
      const detail = cut(codexCmd(it.command), 600);
      if (o.type === 'item.started') out.push({ t: 'tool', id: it.id, name: 'Bash', detail });
      else if (done) out.push({ t: 'tool_end', id: it.id, name: 'Bash', detail, ok: it.exit_code === 0 || (it.exit_code == null && it.status === 'completed'), out: cut(it.aggregated_output || '', OUT_MAX) });
      break;
    }
    case 'file_change': if (done) {
      const detail = (it.changes || []).map(c => (c.kind ? c.kind + ' ' : '') + c.path).join('\n');
      out.push({ t: 'tool_end', id: it.id, name: 'Edit', detail: cut(detail, 600), ok: it.status !== 'failed', out: '' });
    } break;
    case 'mcp_tool_call': {
      const detail = [it.server, it.tool].filter(Boolean).join(' · ');
      if (o.type === 'item.started') out.push({ t: 'tool', id: it.id, name: 'MCP', detail });
      else if (done) out.push({ t: 'tool_end', id: it.id, name: 'MCP', detail, ok: it.status !== 'failed', out: cut(it.error ? (it.error.message || JSON.stringify(it.error)) : resultText(it.result && it.result.content), OUT_MAX) });
      break;
    }
    case 'web_search': if (done) out.push({ t: 'tool_end', id: it.id, name: 'WebSearch', detail: String(it.query || ''), ok: true, out: '' }); break;
    case 'error': if (done) out.push({ t: 'status', text: String(it.message || '') }); break;   // Codex 的警告（真失败看 turn.failed）
    default: break;   // reasoning、todo_list 之类不显示
  }
  return out;
}

/* ---------- 思考强度 ----------
   effort：auto（默认）/ low / high / max。auto：看这句话像不像写代码的活（写、改、编译、调试、报错、代码块…），像就 max，不像就不指定（用 AI 自己的默认，Codex 配置里是 high）。
   用户的 Codex 接的是 deepseek（经云电脑里的网关），它只认 low / high / max，别的值会被网关换成默认 high，所以这里不用 Codex 自己的 xhigh。 */
export const EFFORTS = ['auto', 'low', 'high', 'max'];
const CODE_RE = /代码|程序|函数|编译|调试|报错|出错|错误|bug|debug|重构|实现|驱动|烧录|写一?[个段份套]|改一?下|帮我写|帮我改|makefile|cmake|gcc|keil|\.(c|h|cpp|py|js|ts|s)\b|main\(|#include|```/i;
export function resolveEffort(effort, text) {
  if (effort === 'low' || effort === 'high' || effort === 'max') return effort;
  return CODE_RE.test(String(text || '')) ? 'max' : '';
}

/* ---------- 后台跑一轮 ---------- */
// xin 命令装两份：~/.xin/bin（PATH 里排最前）和 ~/.local/bin（Codex 用 bash -lc 跑命令，登录 shell 会重置 PATH，但 ~/.local/bin 一直在）
function installXin() {
  const sh = '#!/bin/sh\nexec "' + process.execPath + '" "' + SELF + '" xin "$@"\n';
  for (const d of [BIN, path.join(os.homedir(), '.local', 'bin')]) {
    try { mk(d); fs.writeFileSync(path.join(d, 'xin'), sh, { mode: 0o755 }); fs.chmodSync(path.join(d, 'xin'), 0o755); } catch { /* 写不了就算了 */ }
  }
}
export function agentArgs(agent, sess, text, effort) {
  if (agent === 'claude') {
    const a = ['-p', text, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--append-system-prompt', systemPrompt()].concat(effort ? ['--effort', effort] : []);
    return ['claude', sess.started ? a.concat(['--resume', sess.agentSid]) : a.concat(['--session-id', sess.agentSid])];
  }
  // 小芯的设定用 developer_instructions 每一轮都给（续接以前的对话也带上，改了设定马上生效）；值按 TOML 解析，JSON 字符串正好是合法的 TOML 字符串
  const common = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', 'developer_instructions=' + JSON.stringify(systemPrompt())]
    .concat(effort ? ['-c', 'model_reasoning_effort="' + effort + '"'] : []);
  if (sess.started && sess.agentSid) return ['codex', ['exec', 'resume'].concat(common, [sess.agentSid, text])];
  return ['codex', ['exec'].concat(common, ['-C', WORK, text])];
}
function runner(run) {
  const meta = readJ(metaF(run));
  if (!meta) process.exit(1);
  meta.pid = process.pid; writeJ(metaF(run), meta);
  const sess = readJ(sessF(meta.sid));
  mk(WORK); installXin();
  const [cmd, args] = agentArgs(meta.agent, sess, meta.text, meta.effort || '');
  const t0 = Date.now(), state = {};
  let finished = false, stderr = '';
  const finish = (code, why) => {
    if (finished) return; finished = true;
    const s = readJ(sessF(meta.sid), sess);
    if (state.sid) { s.agentSid = state.sid; s.started = true; }
    s.updated = Date.now(); writeJ(sessF(meta.sid), s);
    const m = readJ(metaF(run), meta);
    const stopped = !!m.stopped;
    const ok = !stopped && code === 0 && !state.failed;
    if (!ok && !stopped && !state.errShown) {
      const tail = stderr.trim().split('\n').slice(-6).join('\n');
      emit(run, { t: 'err', text: why || tail || ('退出码 ' + code) });
    }
    emit(run, { t: 'done', ok, stopped, code, ms: Date.now() - t0, cost: state.cost, effort: meta.effort || '' });
    m.ended = Date.now(); writeJ(metaF(run), m);
  };
  let child;
  try {
    child = spawn(cmd, args, {
      cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { PATH: BIN + ':' + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin'), XIN_RUN: run, XIN_HOME: BASE })
    });
  } catch (e) { finish(127, '启动 ' + cmd + ' 失败：' + e.message); return; }
  child.on('error', e => finish(127, e.code === 'ENOENT' ? '云电脑里没有 ' + cmd + ' 命令' : '启动 ' + cmd + ' 失败：' + e.message));
  const norm = meta.agent === 'claude' ? fromClaude : fromCodex;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line || line[0] !== '{') continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      for (const ev of norm(o, state)) emit(run, ev);
      // 一拿到 AI 自己的会话号就记下来：中途被停掉，下一句也能接着聊
      if (state.sid && !state.sidSaved) { state.sidSaved = true; const s = readJ(sessF(meta.sid), sess); s.agentSid = state.sid; s.started = true; writeJ(sessF(meta.sid), s); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); });
  child.on('close', code => finish(code == null ? 1 : code));
  const term = () => { try { child.kill('SIGTERM'); } catch { /* 已经退了 */ } };
  process.on('SIGTERM', term); process.on('SIGINT', term);
}

/* ---------- 对外的 op ---------- */
function lastRun(s) { return s && s.runs && s.runs.length ? s.runs[s.runs.length - 1] : null; }
function runDone(run) {
  const evs = events(run);
  if (evs.some(e => e.t === 'done')) return true;
  const m = readJ(metaF(run));
  // 后台进程没了却没写 done（云电脑重启、被杀）：补一条
  if (m && Date.now() - m.started > 15000 && !alive(m.pid)) {
    emit(run, { t: 'err', text: '这一轮中途断了（云电脑重启或进程被杀）' });
    emit(run, { t: 'done', ok: false, code: -1, ms: Date.now() - m.started });
    return true;
  }
  return false;
}
function summary(s) {
  const r = lastRun(s);
  return { sid: s.sid, agent: s.agent, title: s.title, created: s.created, updated: s.updated, turns: (s.runs || []).length, active: r && !runDone(r) ? r : null };
}
const ops = {
  memory() {
    const text = readMemory();
    return { text, path: MEM_FILE(), size: Buffer.byteLength(text) };
  },
  memory_set(a) {
    const text = String(a.text == null ? '' : a.text);
    if (text.length > 60000) return { error: 'too_long', msg: '记事本太长了' };
    mk(BASE);
    const cur = readMemory();
    if (cur) fs.writeFileSync(MEM_FILE() + '.bak', cur);   // 改之前留一份，改坏了能找回
    const t = MEM_FILE() + '.' + process.pid + '.tmp';
    fs.writeFileSync(t, text); fs.renameSync(t, MEM_FILE());
    return { ok: true, size: Buffer.byteLength(text) };
  },
  ping() {
    const has = c => spawnSync('sh', ['-lc', 'command -v ' + c], { encoding: 'utf8' }).status === 0;
    return { ok: true, agents: AGENTS.filter(has), work: WORK };
  },
  send(a) {
    const text = String(a.text || '').trim();
    if (!text) return { error: 'empty', msg: '消息是空的' };
    if (text.length > TEXT_MAX) return { error: 'too_long', msg: '消息太长了（最多 ' + TEXT_MAX + ' 字）' };
    mk(SESS); mk(RUNS);
    let s;
    if (a.sid) {
      if (!okId(a.sid, 's')) return { error: 'bad_sid', msg: '对话编号不对' };
      s = readJ(sessF(a.sid));
      if (!s) return { error: 'no_session', msg: '找不到这个对话' };
      const r = lastRun(s);
      if (r && !runDone(r)) return { error: 'busy', msg: '上一句还没做完', run: r };
    } else {
      const agent = AGENTS.includes(a.agent) ? a.agent : 'claude';
      s = { sid: rid('s'), agent, title: text.replace(/\s+/g, ' ').slice(0, 40), agentSid: agent === 'claude' ? crypto.randomUUID() : null, started: false, runs: [], created: Date.now(), updated: Date.now() };
    }
    const run = rid('r');
    const ctxLabel = String(a.ctxLabel || '').slice(0, 160);
    writeJ(metaF(run), { run, sid: s.sid, agent: s.agent, text: forAgent(text, a.context), effort: resolveEffort(a.effort, text), started: Date.now() });
    emit(run, ctxLabel ? { t: 'user', text, ctx: ctxLabel, at: Date.now() } : { t: 'user', text, at: Date.now() });
    s.runs.push(run); s.updated = Date.now(); writeJ(sessF(s.sid), s);
    const child = spawn(process.execPath, [SELF, 'run', run], { detached: true, stdio: 'ignore', cwd: os.homedir() });
    const m = readJ(metaF(run)); if (m && !m.pid) { m.pid = child.pid; writeJ(metaF(run), m); }
    child.unref();
    return { sid: s.sid, run, agent: s.agent, title: s.title };
  },
  poll(a) {
    if (!okId(a.run, 'r')) return { error: 'bad_run', msg: '编号不对' };
    if (!fs.existsSync(metaF(a.run))) return { error: 'no_run', msg: '找不到这一轮' };
    const done = runDone(a.run);
    const evs = events(a.run), off = Math.max(0, a.off | 0);
    const slice = evs.slice(off, off + 400);
    return { events: slice, off: off + slice.length, done: done && off + slice.length >= evs.length };
  },
  stop(a) {
    if (!okId(a.run, 'r')) return { error: 'bad_run', msg: '编号不对' };
    const m = readJ(metaF(a.run));
    if (!m) return { error: 'no_run', msg: '找不到这一轮' };
    if (runDone(a.run)) return { ok: true, already: true };
    m.stopped = true; writeJ(metaF(a.run), m);
    try { process.kill(-m.pid, 'SIGTERM'); } catch { try { process.kill(m.pid, 'SIGTERM'); } catch { /* 已经没了 */ } }
    return { ok: true };
  },
  sessions() {
    mk(SESS);
    const list = fs.readdirSync(SESS).filter(f => /^s[0-9a-z]+\.json$/.test(f)).map(f => readJ(path.join(SESS, f))).filter(Boolean);
    list.sort((x, y) => (y.updated || 0) - (x.updated || 0));
    return { sessions: list.slice(0, 60).map(summary) };
  },
  history(a) {
    if (!okId(a.sid, 's')) return { error: 'bad_sid', msg: '对话编号不对' };
    const s = readJ(sessF(a.sid));
    if (!s) return { error: 'no_session', msg: '找不到这个对话' };
    const runs = (s.runs || []).slice(-30);
    const out = runs.map(r => { const d = runDone(r), evs = events(r); return { run: r, events: evs, done: d }; });
    const last = out[out.length - 1];
    return { session: summary(s), runs: out, active: last && !last.done ? { run: last.run, off: last.events.length } : null };
  }
};

function xinCmd(argv) {
  const act = argv[0], arg = argv.slice(1).join(' ').trim();
  if (act === 'remember') {
    const t = remember(arg);
    if (!t) { console.log('用法：xin remember 要记住的一句话'); return 2; }
    const r = process.env.XIN_RUN;
    if (okId(r, 'r') && fs.existsSync(runF(r))) emit(r, { t: 'mem', text: t });
    console.log('记到记事本里了：' + t);
    return 0;
  }
  if (!act || act === '-h' || act === '--help' || !ACTS[act]) {
    console.log('用法：xin <动作> [参数]\n' + Object.keys(ACTS).map(k => '  ' + k.padEnd(8) + ACTS[k]).join('\n') + '\n  remember 记到记事本里（xin remember 一句话）');
    return act && act !== '-h' && act !== '--help' ? 2 : 0;
  }
  const run = process.env.XIN_RUN;
  if (!okId(run, 'r') || !fs.existsSync(runF(run))) { console.log('现在没有在和网页聊天，小芯看不到'); return 1; }
  if (act === 'music' && arg && !/^(on|off)$/.test(arg)) { console.log('xin music on 或 xin music off'); return 2; }
  emit(run, { t: 'xin', act, arg: arg.slice(0, 80) });
  console.log('小芯收到：' + act + (arg ? ' ' + arg.slice(0, 80) : ''));
  return 0;
}

function main() {
  const op = process.argv[2];
  if (op === 'run') { runner(process.argv[3]); return; }
  if (op === 'xin') { process.exitCode = xinCmd(process.argv.slice(3)); return; }
  if (!Object.prototype.hasOwnProperty.call(ops, op)) { process.stdout.write(JSON.stringify({ error: 'bad_op', msg: '不认识的操作' })); return; }
  let args = {};
  try { const t = fs.readFileSync(0, 'utf8').trim(); if (t) args = JSON.parse(t); } catch { args = {}; }
  let res;
  try { res = ops[op](args || {}); } catch (e) { res = { error: 'internal', msg: String(e && e.message || e) }; }
  process.stdout.write(JSON.stringify(res));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main();
