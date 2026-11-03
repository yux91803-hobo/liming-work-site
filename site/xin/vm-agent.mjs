#!/usr/bin/env node
/* vm-agent.mjs — 跑在 InstaBox 云电脑里的小芯「大脑」管理脚本（Node 22，单文件，不依赖别的包）
   网站 Worker 通过 InstaBox exec 接口调用它：node vm-agent.mjs <op>，参数用 JSON 从 stdin 传进来，结果用 JSON 打到 stdout。
   Worker 第一次用（或脚本改过）时会自动把这个文件传到云电脑上，不用手动装。

   op：
     send     {sid?, agent, text, effort?}  开一轮对话（effort：auto / low / high / max，见下面「思考强度」）：在后台起 Claude Code / Codex，马上返回 {sid, run}
     poll     {run, off}           读这一轮从第 off 条开始的新事件
     stop     {run}                停掉这一轮
     sessions {}                   对话列表
     history  {sid}                一个对话的全部事件
     ping     {}                   看看 claude / codex 在不在
   内部：
     run <run>                     后台真正跑 AI 的进程（send 起的），把输出整理成事件写进 runs/<run>.jsonl
     xin <动作> [参数]              给 AI 用的命令：让网页上的小芯做动作（xin dance、xin say 你好）

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
const OUT_MAX = 2000, TEXT_MAX = 20000;

/* 小芯能做的动作（xin 命令和网页共用这张表；网页只认这些名字） */
export const ACTS = {
  say: '头上冒一个气泡说一句话（xin say 编译过了！）',
  happy: '开心', sad: '难过', angry: '生气', wow: '惊讶', confused: '疑惑',
  dance: '跳舞', jump: '跳一下', cookie: '吃饼干', battery: '吸电池（之后跑得飞快）', ball: '抛小球', led: '玩 LED',
  sleep: '睡觉', wake: '叫醒', music: '戴耳机听歌（xin music off 摘下来）', swing: '荡秋千', sit: '坐在边上晃腿', code: '掏出电脑敲代码',
  rage: '发脾气砸东西', tongue: '吐舌头'
};

export function systemPrompt() {
  return [
    '你是「小芯」的大脑。小芯是用户网站 liming-work.com 工具箱首页上的像素小芯片（一块会走会跳的小芯片），用户在网页上和你聊天；你运行在用户自己的 InstaBox 云电脑里（Debian，工作目录 ' + WORK + '，可以随便装软件、写代码、编译、运行）。',
    '用户在学 STM32 嵌入式。用中文回答，简洁口语；代码用 Markdown 代码块。用户主要在手机和平板上看，别输出太宽的表格。',
    '你可以用 shell 命令 `xin <动作>` 让网页上的小芯做动作，网页大约一秒内就会看到。偶尔用一下就好，别每句话都用。可用动作：' +
      Object.keys(ACTS).map(k => k + '（' + ACTS[k] + '）').join('、') + '。',
    '例如：任务做完了可以 `xin dance`，编译失败可以 `xin sad`，想对用户说句俏皮话可以 `xin say 搞定啦`（气泡里的话不超过 20 个字）。'
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
  const common = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'].concat(effort ? ['-c', 'model_reasoning_effort="' + effort + '"'] : []);
  if (sess.started && sess.agentSid) return ['codex', ['exec', 'resume'].concat(common, [sess.agentSid, text])];
  return ['codex', ['exec'].concat(common, ['-C', WORK, systemPrompt() + '\n\n---\n\n' + text])];
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
    writeJ(metaF(run), { run, sid: s.sid, agent: s.agent, text, effort: resolveEffort(a.effort, text), started: Date.now() });
    emit(run, { t: 'user', text, at: Date.now() });
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
  if (!act || act === '-h' || act === '--help' || !ACTS[act]) {
    console.log('用法：xin <动作> [参数]\n' + Object.keys(ACTS).map(k => '  ' + k.padEnd(8) + ACTS[k]).join('\n'));
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
