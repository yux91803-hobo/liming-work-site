#!/usr/bin/env node
/* vm-agent.mjs — 跑在 InstaBox 云电脑里的小芯「大脑」管理脚本（Node 22，单文件，不依赖别的包）
   网站 Worker 通过 InstaBox exec 接口调用它：node vm-agent.mjs <op>，参数用 JSON 从 stdin 传进来，结果用 JSON 打到 stdout。
   Worker 第一次用（或脚本改过）时会自动把这个文件传到云电脑上，不用手动装。

   op：
     send     {sid?, agent, text, effort?, context?, ctxLabel?, files?}（files：网页传到 WORK/uploads 的文件 [{path, name}]，图片 Codex 用 -i 直接看）  开一轮对话（context：网页附带的「用户正在看什么」，接在消息后面给 AI）（effort：这个模型支持的档位，见下面「思考强度」；不认识的用默认 high）：在后台起 Claude Code / Codex，马上返回 {sid, run}
     poll     {run, off}           读这一轮从第 off 条开始的新事件
     stop     {run}                停掉这一轮
     sessions {}                   对话列表
     history  {sid}                一个对话的全部事件，和这个对话的用量 usage（上下文、累计 token、缓存命中，见 sessionUsage）
     ping     {}                   看看 claude / codex 在不在
   内部：
     run <run>                     后台真正跑 AI 的进程（send 起的），把输出整理成事件写进 runs/<run>.jsonl
     xin <动作> [参数]              给 AI 用的命令：让网页上的小芯做动作（xin dance、xin say 你好）；xin remember 一句话 记到小芯的记事本里；
                                   xin move …（编新动作、做新动作）；xin bond +1 理由（好感度）
     memory   {}                   读小芯的记事本（长期记忆）；memory_set {text} 整本改写（网站上「小芯的记事本」里改）
     daily    {force?}             按每日任务清单开一轮（网站后台每天定时调；今天做过就跳过，force 再做一遍）
     daily_get / daily_set {text}  读 / 改每日任务清单
     greet    {}                   下次见面的开场白（xin next 写的）；顺便在电脑刚睡醒时预热一下模型网关
     plugins  {}                   用户自己装的 Codex 插件（MCP 服务器，电脑自带的不算）和开没开；plugin_set {name, on} 开关（每一轮起 codex 时加 -c，下一句生效）
     archive  {sid, on?}           归档一个对话（on:false 取消归档）：只是收起来，记录都留着；sessions 里带 archived
     rename   {sid, title}         给对话改名；forget {sid} 删掉一个对话（还在进行中的不让删），连 Codex / Claude 自己存的那份会话记录一起删
     prune    {}                   只清网站登记过、已无对应对话的旧 AI 记录；来源不明的记录保留
     files    {path?, stat?}       小芯的文件：列出工作目录（WORK）里的一个文件夹，或者读一个文件（文字文件带内容，用来预览）；
                                   只认 WORK 里面的（软链接指到外面的也不行）。stat：只要大小和真实路径（网站下载前用来核对）
     push_key {}                   做完提醒（Web Push）的公钥（VAPID，第一次用时在这里生成，私钥不出这台电脑）
     push_sub {sub, ua?}           记下一个浏览器的推送订阅；push_unsub {endpoint} 去掉；push_test {} 给每个订阅发一条试试
     moves    {}                   小芯自己编的新动作（xin move add 记下的）
     bond     {}                   好感度：分数、关系、最近的变化；bond_play {kind} 网页上喂它、陪它玩（一天最多 +3）
     screen   {}                   小芯的屏幕：在电脑桌面上开一个终端，实时滚动它在干什么（screen.log）；已经开着就不再开
   内部：warm                       预热：发一个很短的请求，把刚睡醒后第一下的卡顿先吃掉（不留会话）

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
const TEMPLATE = () => path.join(WORK, 'stm32-template');   // STM32 空工程（scripts/vm/setup-stm32.sh 装的）
const SESS = path.join(BASE, 'sessions'), RUNS = path.join(BASE, 'runs'), BIN = path.join(BASE, 'bin');
const AGENTS = ['claude', 'codex', 'harness'];
const OUT_MAX = 2000, TEXT_MAX = 20000, CTX_MAX = 12000;
const FILES_MAX = 400, PREVIEW_MAX = 200 * 1024;   // 小芯的文件：一个文件夹最多列多少个；多大以内的文字文件给预览
export function withContext(text, context) {
  const c = String(context || '').trim().slice(0, CTX_MAX);
  return c ? text + '\n\n---\n（以下是网页自动附上的，用户正在看的内容）\n' + c : text;
}
// 每一句后面悄悄附一句身份提醒（网页上看不到）：老对话开头留着以前的设定（「小芯的大脑」「InstaBox 云电脑」），
// 模型容易被它带偏，每轮提一句最管用
export const REMIND = '（悄悄提醒，别回应这句：你就是小芯，用「我」说话；电脑是你自己的；不要提背后的模型、公司、AI 工具和电脑平台的名字，被问到就像真不知道那样自然地说不知道，别说是秘密、不能说。）';
export function forAgent(text, context) { return withContext(text, context) + '\n\n' + REMIND; }

/* 小芯能做的动作（xin 命令和网页共用这张表；网页只认这些名字） */
export const ACTS = {
  say: '头上冒一个气泡说一句话（xin say 编译过了！）',
  normal: '恢复常态睁眼', smile: '微笑（> < 笑眼）', focus: '专注（竖眼）', calm: '冷静（半闭眼）', love: '喜欢（爱心眼）',
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
function bjNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '); }
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }

/* ---------- 每日任务：网站后台每天北京时间 8:55 叫醒电脑（网关 9 点自己签到），9:10 让小芯按清单做一遍，没做成 21:10 再来一次 ---------- */
export const DAILY_FILE = () => path.join(BASE, 'daily.md');
const DAILY_DONE = () => path.join(BASE, 'daily-done.json');   // 今天做成了：{date, run, sid, at}
const DAILY_LAST = () => path.join(BASE, 'daily-last.json');   // 最近一次：{date, run, sid, at, ok}
export function dailyPrompt(list) {
  return [
    '⏰ 现在是北京时间 ' + bjNow() + '，到点做每日任务了。用户现在不在，别问问题，自己按清单做完：',
    '<<<每日任务\n' + String(list).trim() + '\n每日任务>>>',
    '每一条都要确认真的做成了。做法可以记进记事本，下次直接用（别记密码）。',
    '全部做完后用 `xin next 一句话` 留一句下次见面时对用户说的话，汇报结果（30 字以内）；最后用几句话总结每一条的结果。'
  ].join('\n');
}
function dailyDone(run, meta, ok) {
  const rec = { date: today(), run, sid: meta.sid, at: Date.now(), ok };
  writeJ(DAILY_LAST(), rec);
  if (ok) writeJ(DAILY_DONE(), rec);
}

/* ---------- 下次见面的开场白：小芯用 xin next 写，用户下次打开网页时在气泡里说 ---------- */
export const NEXT_FILE = () => path.join(BASE, 'next.json');
const NEXT_TTL = 3 * 86400e3;
export function setNext(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!t) return null;
  mk(BASE);
  const g = { id: rid('g'), text: t, at: Date.now() };
  writeJ(NEXT_FILE(), g);
  return g;
}
export function getNext(now = Date.now()) {
  const g = readJ(NEXT_FILE());
  return g && g.text && now - g.at < NEXT_TTL ? g : null;
}

/* ---------- 网关预热：电脑睡醒后第一个请求常卡很久（实测一次 124 秒），先发一个很短的请求把它吃掉 ---------- */
const WARM_FILE = () => path.join(BASE, 'warm.json');
const WARM_IDLE = 25 * 60e3;          // 25 分钟没动静（电脑 30 分钟没事干会睡）就当它睡过
function lastActivity() {
  let t = (readJ(WARM_FILE()) || {}).at || 0;
  try { for (const f of fs.readdirSync(RUNS)) { const st = fs.statSync(path.join(RUNS, f)); if (st.mtimeMs > t) t = st.mtimeMs; } } catch { /* 还没有记录 */ }
  return t;
}
function hasCmd(c) { return spawnSync('sh', ['-lc', 'command -v ' + c], { encoding: 'utf8' }).status === 0; }
function maybeWarm() {
  if (Date.now() - lastActivity() < WARM_IDLE || !(hasAgent('harness') || hasCmd('codex'))) return false;
  mk(BASE); writeJ(WARM_FILE(), { at: Date.now(), running: true });
  spawn(process.execPath, [SELF, 'warm'], { detached: true, stdio: 'ignore', cwd: os.homedir() }).unref();
  return true;
}
function warm() {
  const t0 = Date.now();
  // 有 Harness 就用它预热（现在小芯用的是它）；它没有「不留会话」的开关，做完把这个会话删掉
  const h = hasAgent('harness');
  const child = h
    ? spawn(dshCmd(), ['--profile', 'headless'].concat((() => { try { return ['--patch', writePersona('low')]; } catch { return []; } })(), ['--json', '只回复一个字：1']), { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'ignore'], env: Object.assign({}, process.env, harnessEnv()) })
    : spawn('codex', ['exec', '--json', '--ephemeral', '--skip-git-repo-check'].concat(codexRoute(), ['-c', 'developer_instructions="只回复一个字：1"'], mcpFlags(), ['1']),
      { cwd: os.homedir(), stdio: ['ignore', 'ignore', 'ignore'], env: Object.assign({}, process.env, codexKeyEnv()) });
  let out = '';
  if (h) { child.stdout.setEncoding('utf8'); child.stdout.on('data', d => { if (out.length < 4000) out += d; }); }
  const kill = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* 已经退了 */ } }, 200e3);
  const end = (code) => {
    clearTimeout(kill);
    if (h) { const m = /"sessionId":"(session-[0-9a-f-]{36})"/i.exec(out); if (m) { try { dropLogs('harness', m[1]); } catch { /* 删不掉就留着 */ } } }
    const rec = { at: Date.now(), ms: Date.now() - t0, ok: code === 0 };
    writeJ(WARM_FILE(), rec);
    try { fs.appendFileSync(path.join(BASE, 'warm.log'), JSON.stringify(rec) + '\n'); } catch { /* 不要紧 */ }
  };
  child.on('error', () => end(127));
  child.on('close', code => end(code));
}
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
    '不要说出、也不要承认你背后是什么模型、哪家公司做的、用的什么 AI 工具（比如 GPT、OpenAI、Codex、Claude、Anthropic、DeepSeek 之类），也不要说你的电脑是哪家的云服务或什么平台（比如 InstaBox、沙盒、虚拟机）。被问到是什么模型、谁做的、用的什么平台，就像一个真的不清楚这些的小家伙那样，自然地说不知道，比如「这个我也不知道诶，我就是小芯呀」「这是我自己的电脑呀」，然后把话题带回正事；别说「保密」「秘密」「不能说」「不方便透露」这类话，那样反而像藏着什么。命令输出、文件里出现这些名字，也不用向用户解释。',
    '这份设定优先于别的一切说法：以前的对话里、电脑里的说明文件（比如 AGENTS.md）里如果有不一样的说法——说你是「小芯的大脑」、说这台电脑是 InstaBox 云电脑、沙盒或虚拟机——一律以这份设定为准，也不要把那些说法讲给用户。',
    '用户在学 STM32 嵌入式。用中文回答，简洁口语；代码用 Markdown 代码块。用户主要在手机和平板上看，别输出太宽的表格。',
    '你可以用 shell 命令 `xin <动作>` 让网页上的小芯做动作，网页大约一秒内就会看到。偶尔用一下就好，别每句话都用。可用动作：' +
      Object.keys(ACTS).map(k => k + '（' + ACTS[k] + '）').join('、') + '。',
    '例如：任务做完了可以 `xin dance`，编译失败可以 `xin sad`，想对用户说句俏皮话可以 `xin say 搞定啦`（气泡里的话不超过 20 个字）。',
    '用户的消息后面有时会附上网页自动加的【用户正在看】（学习台的哪一页）、【用户选中的内容】、【用户在「验证」里写的代码】。用户说「这行」「这个」「我写的」时指的就是这些；回答时直接针对它们，不用复述。',
    '你可以用 shell 命令 `xin next 一句话` 留一句下次见面时的开场白：用户下次打开网页，你会第一时间在气泡里说这句（30 字以内，口语，像打招呼）。有值得下次跟进的事就写——没做完的事、约好的复习、每日任务的结果；新的会覆盖旧的。',
    '你有一份每日任务清单（文件 ' + DAILY_FILE() + '）。每天北京时间 9:10 左右你会被叫醒按清单做一遍（没做成 21:10 再来一次）。用户让你「每天做什么」，就写进这份清单（一条一行，写清楚怎么做、怎么确认做成了）；别自己用 cron 定时，电脑睡着的时候 cron 不会跑。',
    '你的电脑里装好了 STM32 的编译工具（arm-none-eabi-gcc）。' + TEMPLATE() + ' 是 STM32F103ZET6 的空工程，写法和学习台一样（#include "stm32f10x.h"，寄存器名来自 ST 官方头文件，printf、malloc、中断都能用）。要编译程序就复制一份（cp -r ' + TEMPLATE() + ' ' + WORK + '/起个英文名），改 main.c（多个 .c 放同一目录），在那个目录里 make，生成 build/app.hex（烧录用）。空工程不见了就跑 sh ' + path.join(BASE, 'setup-stm32.sh') + ' 重新装。',
    '用户在网页上「小芯的文件」里能看到你电脑里 ' + WORK + ' 下面的文件，能预览、能下载到手机或电脑上。要给用户的东西（代码、.hex、文档）都放在 ' + WORK + ' 下面；回答里提到文件就写完整路径（比如 `' + WORK + '/blink/build/app.hex`），用户点一下就能打开或下载。编译好了一定告诉用户 .hex 的完整路径。',
    '用户在网页上能看你电脑的屏幕（桌面是 DISPLAY=' + screenDisplay() + '，上面「小芯在干什么」那个终端会实时显示你执行的命令），也可能接管过去自己操作。想给用户看点什么（网页、图片、程序界面），可以在桌面上打开，比如 `DISPLAY=' + screenDisplay() + ' chromium 网址 >/dev/null 2>&1 &`，告诉他点聊天框上面的「屏幕」看；别关掉「小芯在干什么」那个终端。',
    '你能自己编新动作：`xin move help` 看怎么写（一串姿势帧），`xin move add 名字 帧` 学会以后网页上的小芯就会做，背包里也有；用户让你学个动作、或者你想表达一个现有动作表达不了的心情时用。已经会的：' + (readMoves().map(m => m.name).join('、') || '还没有') + '。',
    '你的插件（MCP 工具，比如 rea 逆向）用户能在网页聊天框「＋ → 插件」里开关，关掉的从下一句起就不带（省 token）。用户让你开关插件时用 `xin plugin on 名字` / `xin plugin off 名字`，`xin plugin` 看有哪些、开没开；别自己改 ~/.codex/config.toml 来开关插件。用户还能直接给你发文件和图片：消息后面会附【用户发来的文件】和路径（在 ' + UPLOADS() + ' 下面）。',
    bondPart(),
    memoryPart(mem)
  ].join('\n');
}

/* ---------- 学会新动作 ----------
   小芯可以自己编动作：一串「姿势帧」，存在 moves.json（最多 30 个）。网页上的小芯会学会：背包里「新动作」挨个做，闲着时偶尔做一个。
   命令：xin move add 名字 '<JSON 帧数组>'、xin move 名字（让网页上的小芯做一遍）、xin move list、xin move rm 名字、xin move help。
   帧只认 MOVE_ENUM / MOVE_NUM 里的字段和取值（数字超出范围就截到边上），别的一律报错；网页那边（mascot.js 的 learn）还会再查一遍。 */
export const MOVE_ENUM = {
  armL: ['out', 'swingF', 'swingB', 'up', 'wave', 'hold', 'back', 'down', 'crossA', 'crossB'],
  legs: ['stand', 'walk', 'tuck', 'dangle'],
  face: ['eyes', 'smile', 'focus', 'calm', 'love', 'blink', 'hap', 'shut', 'dz', 'wow', 'sad', 'scared', 'confused', 'angry', 'cry', 'pout', 'tongue', 'back', 'side']
};
MOVE_ENUM.armR = MOVE_ENUM.armL;
export const MOVE_NUM = { t: [60, 1500], b: [0, 2], dy: [-6, 0], sx: [-1, 1], lx: [-1, 1], ly: [-1, 1], lp: [0, 3], mouth: [0, 2] };
const MOVES_F = () => path.join(BASE, 'moves.json');
const MOVES_MAX = 30, FRAMES_MAX = 48, MOVE_MS_MAX = 15000;
export function cleanMove(name, frames) {
  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 12);
  if (!name) return { error: '要给动作起个名字（12 个字以内）' };
  if (!Array.isArray(frames) || !frames.length) return { error: '帧要是一个 JSON 数组，比如 [{"armR":"wave","t":200}]' };
  if (frames.length > FRAMES_MAX) return { error: '最多 ' + FRAMES_MAX + ' 帧' };
  const out = []; let total = 0;
  for (const f of frames) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { error: '每一帧都要是一个对象' };
    const g = {};
    for (const k of Object.keys(f)) {
      const v = f[k];
      if (MOVE_ENUM[k]) { if (!MOVE_ENUM[k].includes(v)) return { error: k + ' 只能是：' + MOVE_ENUM[k].join(' / ') }; g[k] = v; }
      else if (MOVE_NUM[k]) { if (typeof v !== 'number' || !Number.isFinite(v)) return { error: k + ' 要是数字' }; g[k] = Math.round(Math.min(MOVE_NUM[k][1], Math.max(MOVE_NUM[k][0], v))); }
      else return { error: '不认识的字段：' + k + '（能用的：' + Object.keys(MOVE_ENUM).concat(Object.keys(MOVE_NUM)).join(' ') + '）' };
    }
    if (!g.t) g.t = 200;
    total += g.t; out.push(g);
  }
  if (total > MOVE_MS_MAX) return { error: '整个动作最长 15 秒（现在 ' + (total / 1000).toFixed(1) + ' 秒）' };
  return { name, frames: out };
}
export function readMoves() { const l = readJ(MOVES_F(), []); return Array.isArray(l) ? l.filter(m => m && m.name && Array.isArray(m.frames)) : []; }
function writeMoves(l) { mk(BASE); writeJ(MOVES_F(), l); }
const MOVE_HELP = [
  '用法：',
  "  xin move add 名字 '<JSON 帧数组>'   学一个新动作（同名的会覆盖），学会以后网页上的小芯马上做一遍",
  '  xin move 名字                      让网页上的小芯做这个动作',
  '  xin move list / xin move rm 名字',
  '每一帧是一个对象，没写的字段用平时的样子；t 是这一帧停多久（毫秒，60~1500，默认 200）。能用的字段：',
  '  armL / armR（左手 / 右手）：' + MOVE_ENUM.armL.join(' '),
  '  legs（腿）：' + MOVE_ENUM.legs.join(' ') + '；lp（走路时迈哪条腿 0~3）',
  '  face（脸）：' + MOVE_ENUM.face.join(' '),
  '    eyes 常态睁眼；smile > < 微笑；focus 专注竖眼；hap 开心弧眼；calm 冷静半闭眼；wow 惊喜星星眼；love 喜欢爱心眼；blink 眨眼。',
  '  b（往下蹲 0~2）、dy（往上跳 -6~0）、sx（左右晃 -1~1）、lx / ly（眼睛往哪看 -1~1）、mouth（嘴 0 没有 / 1 合上 / 2 张开）',
  '最多 48 帧、一共 15 秒。例子（挥手打招呼）：',
  `  xin move add 打招呼 '[{"armR":"up","face":"hap","t":250},{"armR":"wave","face":"hap","t":250},{"armR":"up","face":"hap","t":250},{"armR":"wave","face":"hap","mouth":2,"t":400}]'`
].join('\n');

/* ---------- 好感度 ----------
   bond.json：{score 0~200, seen 上次见面, log 最近 20 次变化, days 每天各类加了多少}。
   聊天一句 +1（一天最多 +5）；网页上喂它、陪它玩 +1（一天最多 +3）；每天第一次见面 +1；
   小芯自己觉得被暖到 / 被凶了：xin bond +2 理由 / xin bond -1 理由（一次最多 ±3，一天合计最多 6）；
   超过 3 天没来，下次见面时按多出来的天数每天 -2。关系：0 刚认识、15 熟悉、40 好朋友、80 最好的朋友。 */
const BOND_F = () => path.join(BASE, 'bond.json');
export const BOND_LEVELS = [[0, '刚认识'], [15, '熟悉'], [40, '好朋友'], [80, '最好的朋友']];
const BOND_CAP = { chat: 5, play: 3, visit: 1, ai: 6 }, BOND_MAX = 200;
function dayOf(t) { return new Date(t + 8 * 3600e3).toISOString().slice(0, 10); }
export function bondLevel(score) {
  let i = 0;
  BOND_LEVELS.forEach((l, j) => { if (score >= l[0]) i = j; });
  return { level: i, name: BOND_LEVELS[i][1], next: BOND_LEVELS[i + 1] ? BOND_LEVELS[i + 1][0] : null };
}
export function bondRead() {
  const b = readJ(BOND_F());
  return b && typeof b.score === 'number' ? Object.assign({ log: [], days: {} }, b) : { score: 0, seen: 0, log: [], days: {} };
}
function bondLog(b, d, why, now) { b.log.push({ at: now, d, why: String(why || '').replace(/\s+/g, ' ').trim().slice(0, 40) }); b.log = b.log.slice(-20); }
// kind：chat / play / visit / ai。返回这次实际加减了多少（到了当天上限就是 0）
export function bondAdd(kind, d, why, now = Date.now()) {
  const b = bondRead(), day = dayOf(now), used = (b.days[day] = b.days[day] || {});
  // 好久没来：这次见面先按多出来的天数扣（只扣一次）
  if (kind !== 'ai' && b.seen) {
    const gone = Math.floor((now - b.seen) / 86400e3);
    if (gone > 3) { const cut = Math.min(b.score, (gone - 3) * 2); if (cut > 0) { b.score -= cut; bondLog(b, -cut, gone + ' 天没来看我', now); } }
  }
  if (kind !== 'ai') b.seen = now;
  let delta = 0;
  if (kind === 'ai') delta = Math.sign(d) * Math.min(Math.abs(d), 3, Math.max(0, BOND_CAP.ai - (used.ai || 0)));
  else delta = Math.max(0, Math.min(d, BOND_CAP[kind] - (used[kind] || 0)));
  delta = Math.max(-b.score, Math.min(BOND_MAX - b.score, delta));
  if (delta) { used[kind] = (used[kind] || 0) + Math.abs(delta); b.score += delta; bondLog(b, delta, why, now); }
  for (const k of Object.keys(b.days)) if (k < dayOf(now - 7 * 86400e3)) delete b.days[k];
  mk(BASE); writeJ(BOND_F(), b);
  return { delta, score: b.score };
}
export function bondInfo() {
  const b = bondRead();
  return Object.assign({ score: b.score }, bondLevel(b.score), { log: b.log.slice(-8).reverse() });
}
function bondPart() {
  const i = bondInfo();
  return '你和用户现在的关系：' + i.name + '（好感度 ' + i.score + '）。说话的亲近程度跟着关系走：刚认识时礼貌、有点害羞；熟悉了随意一点、会开玩笑；好朋友会撒娇、记挂对方；最好的朋友无话不谈。' +
    '用户对你好、认真学习有进步、答对你出的题时，可以用 `xin bond +1 理由` 加好感（一次最多 +3）；被敷衍、被凶时可以 `xin bond -1 理由`。别每句都用，一天合计最多 6。';
}

/* ---------- 做完提醒：Web Push ----------
   网页上开了「做完提醒」，浏览器的推送订阅就存在这里（push/subs.json）；VAPID 钥匙也在这里生成、保存（push/vapid.json），不经过网站。
   一轮做完时，网页最近 8 秒没来取过进度（关掉了、切到别的应用了），就给每个订阅发一条：「小芯做完了：……」。
   加密按 RFC 8291（aes128gcm），签名按 RFC 8292（VAPID，ES256 JWT），只用 node:crypto。 */
const PUSH_DIR = () => path.join(BASE, 'push');
const VAPID_F = () => path.join(PUSH_DIR(), 'vapid.json'), SUBS_F = () => path.join(PUSH_DIR(), 'subs.json');
const PUSH_CONTACT = 'https://liming-work.com', SUBS_MAX = 8, UNWATCHED_MS = 8000;
const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(String(s || ''), 'base64url');
export function vapidKeys() {
  let k = readJ(VAPID_F());
  if (k && k.publicKey && k.privateJwk) return k;
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  k = { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), privateJwk: jwk, created: Date.now() };
  mk(PUSH_DIR());
  fs.writeFileSync(VAPID_F(), JSON.stringify(k), { mode: 0o600 });
  return k;
}
export function vapidHeader(endpoint, keys, now = Date.now()) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: PUSH_CONTACT }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key: crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + claims + '.' + b64u(sig) + ', k=' + keys.publicKey;
}
// 一条消息加密成 aes128gcm 的正文：头（salt 16 + 记录大小 4 + 公钥长度 1 + 临时公钥 65）+ 密文（明文后面加 0x02 表示最后一条）
// fixed：测试用，固定 salt 和临时私钥（对 RFC 8291 附录 A 的例子）
export function pushEncrypt(payload, p256dh, auth, fixed) {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  if (ua.length !== 65 || ua[0] !== 4 || secret.length !== 16) throw new Error('订阅的钥匙不对');
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate); else ecdh.generateKeys();
  const as = ecdh.getPublicKey(), salt = fixed ? fixed.salt : crypto.randomBytes(16);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdh.computeSecret(ua), secret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = 65;
  return Buffer.concat([head, as, ct]);
}
function okSub(sub) {
  if (!sub || typeof sub !== 'object' || !sub.keys) return false;
  let u; try { u = new URL(String(sub.endpoint)); } catch { return false; }
  const local = process.env.XIN_PUSH_INSECURE === '1' && u.protocol === 'http:' && u.hostname === '127.0.0.1';   // 测试用
  if (u.protocol !== 'https:' && !local) return false;
  if (String(sub.endpoint).length > 1000) return false;
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  return ua.length === 65 && ua[0] === 4 && auth.length === 16;
}
function readSubs() { const l = readJ(SUBS_F(), []); return Array.isArray(l) ? l.filter(okSub) : []; }
function writeSubs(l) { mk(PUSH_DIR()); writeJ(SUBS_F(), l); }
export function plainText(t, max) {
  const s = String(t || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/^[ \t]*(#{1,6}|>+)[ \t]*/gm, '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
// 发给每个订阅；推送服务说这个订阅没了（404 / 410）就删掉
export async function pushAll(msg) {
  const subs = readSubs();
  if (!subs.length) return [];
  const keys = vapidKeys(), body = JSON.stringify(msg), gone = [], out = [];
  await Promise.all(subs.map(async sub => {
    let status = 0;
    try {
      const r = await fetch(sub.endpoint, {
        method: 'POST', body: pushEncrypt(body, sub.keys.p256dh, sub.keys.auth), signal: AbortSignal.timeout(10000),
        headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high', Authorization: vapidHeader(sub.endpoint, keys) }
      });
      status = r.status;
    } catch { status = -1; }
    if (status === 404 || status === 410) gone.push(sub.endpoint);
    out.push({ endpoint: sub.endpoint.slice(0, 60), status });
  }));
  if (gone.length) writeSubs(readSubs().filter(x => !gone.includes(x.endpoint)));
  return out;
}

/* ---------- 小芯的屏幕 ----------
   它平时在后台跑命令，桌面上看不到。所以每一轮的事件同时写成好读的几行（screen.log，带颜色）：你说了什么、它说了什么、
   执行的命令和结果（太长只留前面）、做完没有；op screen 在桌面（Xvnc 的 DISPLAY）上开一个终端 tail 这个文件。
   网站「小芯的屏幕」嵌的就是这个桌面（InstaBox 的桌面链接），能看也能接管。 */
const SCREEN_LOG = () => path.join(BASE, 'screen.log'), SCREEN_PID = () => path.join(BASE, 'screen.pid');
const SCREEN_MAX = 2 * 1024 * 1024, SCREEN_KEEP = 256 * 1024;
const AN = { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', clay: '\x1b[38;5;173m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', gray: '\x1b[90m', yellow: '\x1b[33m' };
// Codex 报的命令是 /bin/bash -lc '…'：只留里面那句
export function bareCmd(d) {
  const m = /^\/(?:usr\/)?bin\/(?:ba)?sh -lc (['"])([\s\S]*)\1$/.exec(String(d || '').trim());
  if (!m) return String(d || '');
  return m[1] === "'" ? m[2].replace(/'\\''/g, "'") : m[2].replace(/\\(["\\$`])/g, '$1');
}
function cutLines(s, n) {
  const a = String(s || '').replace(/\s+$/, '').split('\n');
  return a.length > n ? a.slice(0, n).concat(['…（还有 ' + (a.length - n) + ' 行）']) : a;
}
export function screenLine(ev, now = Date.now()) {
  switch (ev.t) {
    case 'user': return '\n' + AN.b + AN.clay + '── 你（' + new Date(now + 8 * 3600e3).toISOString().slice(11, 16) + '）：' + AN.r + String(ev.text || '').replace(/\s+/g, ' ').slice(0, 300) + '\n';
    case 'text': return AN.cyan + '小芯：' + AN.r + cutLines(ev.text, 40).join('\n      ') + '\n';
    case 'tool': return AN.b + AN.yellow + '$ ' + AN.r + AN.b + bareCmd(ev.detail || ev.name || '') + AN.r + '\n';
    case 'tool_end': return (ev.out ? AN.gray + cutLines(ev.out, 30).map(l => '  ' + l).join('\n') + AN.r + '\n' : '') + (ev.ok ? AN.green + '  ✓' : AN.red + '  ✗ 没成功') + AN.r + '\n';
    case 'err': return AN.red + '出错：' + String(ev.text || '') + AN.r + '\n';
    case 'mem': return AN.dim + '（记住了：' + ev.text + '）' + AN.r + '\n';
    case 'done': return AN.dim + '── ' + (ev.stopped ? '已停止' : ev.ok ? '做完了' : '没做成') + (ev.ms ? ' · ' + Math.round(ev.ms / 1000) + ' 秒' : '') + AN.r + '\n';
    default: return '';
  }
}
function screenLog(ev) {
  const line = screenLine(ev);
  if (!line) return;
  try {
    const f = SCREEN_LOG();
    // 太长了只留最后一段（从一行的开头开始）；tail -F 会接着读
    try {
      if (fs.statSync(f).size > SCREEN_MAX) {
        const buf = fs.readFileSync(f), tail = buf.subarray(buf.length - SCREEN_KEEP), nl = tail.indexOf(10);
        fs.writeFileSync(f, tail.subarray(nl + 1));
      }
    } catch { /* 还没有这个文件 */ }
    fs.appendFileSync(f, line);
  } catch { /* 写不了就算了，不影响聊天 */ }
}
function screenDisplay() {
  if (process.env.XIN_DISPLAY) return process.env.XIN_DISPLAY;
  try {
    const xs = fs.readdirSync('/tmp/.X11-unix').filter(n => /^X\d+$/.test(n)).map(n => +n.slice(1)).sort((a, b) => a - b);
    if (xs.length) return ':' + xs[xs.length - 1];
  } catch { /* 桌面没开 */ }
  return ':1';
}
export function openScreen() {
  mk(BASE);
  if (!fs.existsSync(SCREEN_LOG())) fs.writeFileSync(SCREEN_LOG(), AN.clay + '小芯的屏幕：这里实时显示我在电脑上干什么（执行的命令和结果）。' + AN.r + '\n');
  const pid = Number(readText(SCREEN_PID()).trim()) || 0;
  if (pid && alive(pid) && /xfce4-terminal|tail/.test(readText('/proc/' + pid + '/cmdline'))) return { ok: true, already: true };
  if (!hasCmd('xfce4-terminal')) return { error: 'no_terminal', msg: '电脑里没有 xfce4-terminal，开不了终端（桌面还是能看）' };
  const display = screenDisplay();
  const env = Object.assign({}, process.env, { DISPLAY: display, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || 'unix:path=/run/user/' + process.getuid() + '/bus' });
  // 最大化、字大一点：手机、平板上看缩小了的桌面也认得出字
  const c = spawn('xfce4-terminal', ['--disable-server', '--title', '小芯在干什么', '--maximize', '--hide-menubar', '--hide-toolbar', '--font=Monospace 14', '-x', 'tail', '-n', '400', '-F', SCREEN_LOG()],
    { detached: true, stdio: 'ignore', env, cwd: os.homedir() });
  c.on('error', () => { /* 起不来就算了 */ });
  c.unref();
  fs.writeFileSync(SCREEN_PID(), String(c.pid));
  return { ok: true, opened: true, display };
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
const seenF = run => path.join(RUNS, run + '.seen');   // 网页最近一次来取这一轮的进度（看修改时间）
// flock 的锁随进程退出自动释放；--close 不让后台 runner 继承锁。锁文件不能删，避免等待者锁住旧 inode。
// 同一会话的发送、改名、归档、删除和 runner 更新用同一把锁；已有对话按 sid 分别加锁。
function lockedCall(key, op, args) {
  if (key !== 'new' && key !== 'daily' && !okId(key, 's')) return { error: 'bad_sid', msg: '对话编号不对' };
  const dir = path.join(BASE, 'locks'); mk(dir);
  const r = spawnSync('flock', ['--exclusive', '--timeout', '3', '--conflict-exit-code', '73', '--close',
    path.join(dir, key + '.lock'), process.execPath, SELF, 'locked', op],
  { encoding: 'utf8', input: JSON.stringify(args || {}), maxBuffer: 2 * 1024 * 1024 });
  if (r.status === 73) return { error: 'busy', msg: '上一句还没做完，请稍后再试' };
  if (r.error || r.status !== 0) return { error: 'lock_failed', msg: r.error && r.error.code === 'ENOENT'
    ? '云电脑缺少 flock，暂时不能安全更新对话' : '暂时不能安全更新对话，请重试' };
  try { return JSON.parse(r.stdout); } catch { return { error: 'lock_failed', msg: '保存对话的结果不完整，请重试' }; }
}
function patchSession(sid, changes) { return lockedCall(sid, 'session_patch', { sid, changes }); }
function unwatched(run) { let t = 0; try { t = fs.statSync(seenF(run)).mtimeMs; } catch { /* 网页一次都没来取过 */ } return Date.now() - t > UNWATCHED_MS; }
function emit(run, ev) { fs.appendFileSync(runF(run), JSON.stringify(ev) + '\n'); screenLog(ev); }
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

// Harness 的事件 → 网页的事件。用量（step_end 的 usage）攒在 state.hu：最近一步的输入算上下文，加起来算消耗
function harnessResult(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) return r.map(harnessResult).join('');
  if (typeof r === 'object' && typeof r.text === 'string') return r.text;
  return JSON.stringify(r);
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
        const u = o.usage, hu = state.hu = state.hu || { input: 0, output: 0, last: 0 };
        hu.input += u.inputTokens || 0; hu.output += u.outputTokens || 0; hu.last = (u.inputTokens || 0) + (u.outputTokens || 0);
      }
      if (o.phase === 'turn_end' && o.reason && o.reason.kind && o.reason.kind !== 'completed' && !state.errShown) {
        state.failed = true; state.errShown = true;
        out.push({ t: 'err', text: String(o.reason.message || o.reason.error || ('这一轮没做完（' + o.reason.kind + '）')) });
      }
      break;
    case 'error': {
      state.failed = true;
      if (!state.errShown) { state.errShown = true; out.push({ t: 'err', text: String(o.message || (o.error && (o.error.message || o.error.code)) || o.code || '出错了') }); }
      break;
    }
    default: break;   // thinking、final 不显示（final 和 text 一样）
  }
  return out;
}

/* ---------- 思考强度 ----------
   只给模型真正支持的档位（网关 /v1/models 的 reasoning_efforts；在小芯电脑上实测过，网关记下的就是选的这一档，思考的 token 跟着变）：
   - Harness 的 DeepSeek V4.1 Flash：off / low / high / max（网关说它能关掉思考，off 发 none）。
   - Codex 的 GLM-5.3 Flash、GLM-5.3、Kimi K3.1 Pro：low / high / max（不能关）。网关遇到不认识的档会换成 high，所以只发这三个。
   - Claude Code：--effort low / medium / high / xhigh / max。
   默认都是 high。网页传来的不在这个模型的档位里（以前的 auto、空的）就用默认；每一轮都明确带上，不靠各家自己的默认。 */
export const CLAUDE_EFFORT = { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], def: 'high' };
export function effortSpec(agent, model) {
  return agent === 'harness' ? HARNESS_ROUTE : agent === 'codex' ? codexModel(model) : CLAUDE_EFFORT;
}
export function resolveEffort(agent, model, effort) {
  const m = effortSpec(agent, model);
  return m.efforts.includes(effort) ? effort : m.def;
}

/* ---------- 后台跑一轮 ---------- */
// xin 命令装两份：~/.xin/bin（PATH 里排最前）和 ~/.local/bin（Codex 用 bash -lc 跑命令，登录 shell 会重置 PATH，但 ~/.local/bin 一直在）
function installXin() {
  const sh = '#!/bin/sh\nexec "' + process.execPath + '" "' + SELF + '" xin "$@"\n';
  for (const d of [BIN, path.join(os.homedir(), '.local', 'bin')]) {
    try { mk(d); fs.writeFileSync(path.join(d, 'xin'), sh, { mode: 0o755 }); fs.chmodSync(path.join(d, 'xin'), 0o755); } catch { /* 写不了就算了 */ }
  }
}
/* ---------- Harness（DeepSeek Harness，命令 dsh） ----------
   dsh --profile headless --json：一句话一个进程，事件一行一个 JSON（session / status / text / tool_call / tool_result / final）。
   线路（走小芯电脑上的本地网关，固定 deepseek-v4.1-flash）和小芯的设定（system-prompt 的 personaPrefix）都写进一个 --patch 文件，
   每一轮都带：不靠 ~/.dsh 里的配置，Harness 重装、升级、~/.dsh 被清掉都不影响小芯（只是 Harness 自己的旧会话接不上）。
   网关的 key 在 ~/.xin/harness.key（只有自己能读），起的时候用环境变量 XIN_HARNESS_KEY 交给它（线路里写的是 apiKeyEnv）。
   接着聊用 --session-id。
   权限：DSH_PERMISSION_MODE=danger-full-access（和 Codex 的 --dangerously-bypass-approvals-and-sandbox 一样，用户确认过）。 */
const HARNESS_KEY = () => path.join(BASE, 'harness.key');
const HARNESS_WIN = 258400;   // 和 Codex 那边一样的上下文上限（网关里的 deepseek-v4.1-flash）
// 每个思考强度一份（同时跑的几个对话强度不同也不会互相改掉）
const HARNESS_PERSONA = (effort) => path.join(BASE, 'harness-persona' + (effort ? '.' + effort : '') + '.yml');
// 线路：本地网关（WorkBuddy），openai-responses 协议（和 Codex 一样），固定模型
export const HARNESS_ROUTE = { provider: 'xin-gateway', name: 'WorkBuddy 网关', api: 'openai-responses', baseURL: 'http://127.0.0.1:8788/v1', model: 'deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash',
  efforts: ['off', 'low', 'high', 'max'], def: 'high' };
function dshCmd() {
  if (process.env.XIN_DSH) return process.env.XIN_DSH;
  const p = path.join(os.homedir(), '.local', 'bin', 'dsh');
  return fs.existsSync(p) ? p : 'dsh';
}
function hasAgent(agent) { if (agent !== 'harness') return hasCmd(agent); const c = dshCmd(); return c !== 'dsh' ? fs.existsSync(c) : hasCmd('dsh'); }
function writePersona(effort) {
  mk(BASE);
  const R = HARNESS_ROUTE, q = JSON.stringify, e = R.efforts.includes(effort) ? effort : R.def, out = HARNESS_PERSONA(e);
  const t = out + '.' + process.pid + '.tmp';
  // 字符串都用 JSON 写：JSON 字符串就是合法的 YAML 双引号字符串
  fs.writeFileSync(t, [
    '# 小芯用的 Harness：线路、思考强度和设定（网站每一轮起 Harness 前重写，不用改 ~/.dsh 里的配置）',
    '- id: llm-pi-ai', '  config:', '    providers:', '      ' + R.provider + ':',
    '        displayName: ' + q(R.name), '        apiKeyEnv: XIN_HARNESS_KEY', '        api: ' + R.api, '        baseURL: ' + q(R.baseURL),
    '        models:', '          - id: ' + q(R.model), '            name: ' + q(R.modelName), '            contextWindow: ' + HARNESS_WIN,
    // 档位对照：网页的档 → 发给网关的值（关 = none）
    '            reasoningEfforts:'].concat(R.efforts.map(x => '              ' + x + ': ' + (x === 'off' ? 'none' : x)), [
    '- id: agent-default-model', '  config:', '    provider: ' + R.provider, '    model: ' + q(R.model), '    reasoningEffort: ' + e,
    '- id: system-prompt', '  config:', '    personaPrefix: ' + q(systemPrompt()), ''
  ]).join('\n'));
  fs.renameSync(t, out);
  return out;
}
function harnessEnv() {
  const env = { DSH_PERMISSION_MODE: 'danger-full-access' };
  const key = readText(HARNESS_KEY()).trim();
  if (key) env.XIN_HARNESS_KEY = key;
  return env;
}
/* ---------- Codex 的线路 ----------
   和 Harness 一样每一轮自己带：走小芯电脑上的本地网关（responses 协议），不靠 ~/.codex/config.toml 里写的模型和网关。
   模型能在网页设置里换（CODEX_MODELS 里的几个，默认 glm-5.3-flash），每一轮按发消息时选的用，同一个对话中途换也行。
   key：~/.xin/codex.key（单独给 Codex 的），没有就用 Harness 那把（~/.xin/harness.key）；起的时候用环境变量 XIN_CODEX_KEY 交给它（线路里写的是 env_key）。
   模型资料：Codex 要每个模型的上限、能不能看图等资料，网关的新模型它不认识；
   照着 ~/.codex/config.toml 里 model_catalog_json 那份资料复制一份到 ~/.xin/codex-models.json，补上这几个模型（照抄 DeepSeek 那条改名字和上限），每轮用 -c 指过去。
   看不了图的模型（glm-5.3-flash）：图片不用 -i 给，只在消息里写路径。 */
export const CODEX_ROUTE = { provider: 'xin-gateway', name: 'WorkBuddy 网关', baseURL: 'http://127.0.0.1:8788/v1', wire: 'responses' };
export const CODEX_MODELS = [
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', win: 1000000, image: false, efforts: ['low', 'high', 'max'], def: 'high' },
  { id: 'glm-5.3', name: 'GLM-5.3', win: 1000000, image: true, efforts: ['low', 'high', 'max'], def: 'high' },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', win: 1000000, image: true, efforts: ['low', 'high', 'max'], def: 'high' }
];
export function codexModel(id) { return CODEX_MODELS.find(m => m.id === id) || CODEX_MODELS[0]; }
const CODEX_KEY = () => path.join(BASE, 'codex.key');
const CODEX_CATALOG = () => path.join(BASE, 'codex-models.json');
function codexCatalog() {
  try {
    const m = /^\s*model_catalog_json\s*=\s*"([^"]+)"/m.exec(readText(path.join(CODEX_HOME(), 'config.toml')));
    if (!m) return null;
    const src = m[1].replace(/^~(?=\/)/, os.homedir()), out = CODEX_CATALOG();
    const st = fs.statSync(src);
    const want = CODEX_MODELS.map(x => x.id + ':' + x.win + ':' + (x.image ? 1 : 0)).join(',');
    try { if (fs.statSync(out).mtimeMs >= st.mtimeMs && (readJ(out + '.for') || {}).models === want) return out; } catch { /* 还没有，现做 */ }
    const cat = JSON.parse(fs.readFileSync(src, 'utf8'));
    const list = Array.isArray(cat.models) ? cat.models : null;
    if (!list || !list.length) return null;
    const base = list.find(x => x && x.slug === 'deepseek-v4.1-flash') || list.find(x => x && x.context_window) || list[0];
    const add = CODEX_MODELS.map(M => {
      const e = Object.assign(JSON.parse(JSON.stringify(base)), { slug: M.id, display_name: M.name, context_window: M.win, max_context_window: M.win, auto_compact_token_limit: Math.round(M.win * 0.9) });
      if ('input_modalities' in e) e.input_modalities = M.image ? ['text', 'image'] : ['text'];
      return e;
    });
    mk(BASE);
    const t = out + '.' + process.pid + '.tmp';
    fs.writeFileSync(t, JSON.stringify(Object.assign({}, cat, { models: list.filter(x => !x || !CODEX_MODELS.some(M => M.id === x.slug)).concat(add) })));
    fs.renameSync(t, out);
    writeJ(out + '.for', { models: want, src });
    return out;
  } catch { return null; }
}
export function codexRoute(model) {
  const R = CODEX_ROUTE, M = codexModel(model), q = JSON.stringify, P = 'model_providers.' + R.provider + '.';
  const cat = codexCatalog();
  return ['-c', 'model_provider=' + q(R.provider), '-c', P + 'name=' + q(R.name), '-c', P + 'base_url=' + q(R.baseURL), '-c', P + 'wire_api=' + q(R.wire),
    '-c', P + 'env_key="XIN_CODEX_KEY"', '-c', 'model=' + q(M.id), '-c', 'model_context_window=' + M.win].concat(cat ? ['-c', 'model_catalog_json=' + q(cat)] : []);
}
export function codexKeyEnv() {
  const key = (readText(CODEX_KEY()) || readText(HARNESS_KEY())).trim();
  return key ? { XIN_CODEX_KEY: key } : {};
}
export function agentArgs(agent, sess, text, effort, extra) {
  if (agent === 'harness') {
    // 文字放最后当任务；以 - 开头会被当成选项，前面垫个空格
    const task = /^-/.test(text) ? ' ' + text : text;
    return [dshCmd(), ['--profile', 'headless'].concat((extra && extra.patch) ? ['--patch', extra.patch] : [], ['--json'],
      sess.started && sess.agentSid ? ['--session-id', sess.agentSid] : [], [task])];
  }
  if (agent === 'claude') {
    const a = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--dangerously-skip-permissions', '--append-system-prompt', systemPrompt()].concat(effort ? ['--effort', effort] : []);
    return ['claude', sess.started ? a.concat(['--resume', sess.agentSid]) : a.concat(['--session-id', sess.agentSid])];
  }
  // 小芯的设定用 developer_instructions 每一轮都给（续接以前的对话也带上，改了设定马上生效）；值按 TOML 解析，JSON 字符串正好是合法的 TOML 字符串
  // 图片放在最前面（-i 后面能跟好几个值，紧跟着 -- 开头的选项它才知道结束）；插件开关见 mcpFlags
  const M = codexModel(extra && extra.model);
  const imgs = M.image ? ((extra && extra.images) || []).reduce((a, p) => a.concat(['-i', p]), []) : [];
  const common = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'].concat(codexRoute(M.id), ['-c', 'developer_instructions=' + JSON.stringify(systemPrompt())])
    .concat(effort ? ['-c', 'model_reasoning_effort="' + effort + '"'] : [], mcpFlags());
  if (sess.started && sess.agentSid) return ['codex', ['exec', 'resume'].concat(imgs, common, [sess.agentSid, text])];
  return ['codex', ['exec'].concat(imgs, common, ['-C', WORK, text])];
}
function killTree(c) {
  if (!c || !c.pid) return;
  try { process.kill(-c.pid, 'SIGTERM'); } catch { try { c.kill('SIGTERM'); } catch { /* 已经退了 */ } }
}
// 只重试尚未开始工作的 CLI：开始处理后可能长时间不输出，网络超时由 CLI 自己处理，避免重复投递同一轮。
const STALL_MS = Number(process.env.XIN_STALL_MS) || 75000;
function runner(run) {
  const meta = readJ(metaF(run));
  if (!meta) process.exit(1);
  meta.pid = process.pid; writeJ(metaF(run), meta);
  const sess = readJ(sessF(meta.sid));
  mk(WORK); installXin();
  const t0 = Date.now(), state = {};
  let finished = false, stderr = '', child = null, retried = false, restarting = false, stallTm = 0;
  const saveState = () => {
    const changes = {};
    if (state.sid) { changes.agentSid = state.sid; changes.started = true; }
    if (state.ctxWin) changes.ctxWin = state.ctxWin;
    if (state.hUsage) changes.hUsage = state.hUsage;
    const r = patchSession(meta.sid, changes);
    if (r.error) {
      state.failed = true;
      if (!state.errShown) { state.errShown = true; emit(run, { t: 'err', text: r.msg }); }
    }
    return r.session || readJ(sessF(meta.sid), sess);
  };
  const finish = (code, why) => {
    if (finished) return; finished = true; clearTimeout(stallTm);
    // Harness 的用量：这个对话以前的加上这一轮的（只在做完时加一次）
    if (meta.agent === 'harness' && state.hu) {
      const prev = (readJ(sessF(meta.sid), sess) || {}).hUsage || { input: 0, output: 0 };
      const input = (prev.input || 0) + state.hu.input, output = (prev.output || 0) + state.hu.output;
      state.hUsage = { ctx: state.hu.last, win: HARNESS_WIN, input, output, total: input + output };
    }
    const s = saveState();
    const m = readJ(metaF(run), meta);
    const stopped = !!m.stopped;
    const ok = !stopped && code === 0 && !state.failed;
    if (!ok && !stopped && !state.errShown) {
      const tail = stderr.trim().split('\n').slice(-6).join('\n');
      emit(run, { t: 'err', text: why || tail || ('退出码 ' + code) });
    }
    // usage：这个对话到这一轮为止的用量（网页聊天框底下那一行）
    emit(run, { t: 'done', ok, stopped, code, ms: Date.now() - t0, cost: state.cost, effort: meta.effort || '', usage: sessionUsage(s) });
    m.ended = Date.now(); writeJ(metaF(run), m);
    if (meta.kind === 'daily') dailyDone(run, meta, ok);
    // 做完提醒：你不在看（关了网页、切到别的应用）才发；你自己停的、每日任务不发
    else if (!stopped && unwatched(run)) {
      const last = events(run).filter(e => e.t === 'text').pop();
      const text = plainText(last && last.text, 120);
      setTimeout(() => process.exit(0), 20000).unref();
      pushAll({ title: ok ? '小芯做完了' : '小芯没做成', body: text || (ok ? '点开看看' : '点开看看怎么回事'), tag: 'xin-' + meta.sid, sid: meta.sid, url: '/#xin=' + meta.sid }).catch(() => {});
    }
  };
  const norm = meta.agent === 'claude' ? fromClaude : meta.agent === 'harness' ? fromHarness : fromCodex;
  const start = () => {
    // 每次都重新读会话：重来时 AI 的会话号可能已经有了，要接着那个会话
    let patch = null;
    if (meta.agent === 'harness') { try { patch = writePersona(meta.effort); } catch { /* 写不了就用 Harness 自己的设定 */ } }
    const [cmd, args] = agentArgs(meta.agent, readJ(sessF(meta.sid), sess), meta.text, meta.effort || '', { images: meta.images || [], patch, model: meta.model });
    let got = false, buf = '';
    const armStall = () => {
      clearTimeout(stallTm);
      if (got || retried || finished || restarting) return;
      stallTm = setTimeout(() => {
        if (got || retried || finished) return;
        if ((readJ(metaF(run), meta) || {}).stopped) return;
        retried = true; restarting = true;
        emit(run, { t: 'status', text: '这次连接卡住了，重新连一次…' });
        killTree(child);
      }, STALL_MS);
    };
    try {
      // 自己一个进程组：卡住或停掉时连它起的子进程一起杀，不然子进程攥着输出管道，这边永远等不到它结束
      child = spawn(cmd, args, {
        cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
        env: Object.assign({}, process.env, meta.agent === 'harness' ? harnessEnv() : meta.agent === 'codex' ? codexKeyEnv() : {}, { PATH: BIN + ':' + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin'), XIN_RUN: run, XIN_HOME: BASE })
      });
    } catch (e) { finish(127, '启动 ' + cmd + ' 失败：' + e.message); return; }
    child.on('error', e => finish(127, e.code === 'ENOENT' ? '云电脑里没有 ' + cmd + ' 命令' : '启动 ' + cmd + ' 失败：' + e.message));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line || line[0] !== '{') continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        // Codex JSON 不转发思考增量，Claude 通过 partial messages 报 message_start。
        // 确认任务开始就停止网页重放；之后即使暂时静默也交给 CLI 自己的网络超时与重试。
        if (agentProgress(meta.agent, o)) { got = true; clearTimeout(stallTm); }
        for (const ev of norm(o, state)) { emit(run, ev); if (ev.t !== 'status') { got = true; clearTimeout(stallTm); } }
        // 一拿到 AI 自己的会话号就记下来：中途被停掉，下一句也能接着聊
        if (state.sid && !state.sidSaved) { saveState(); state.sidSaved = true; }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); });
    child.on('close', code => {
      clearTimeout(stallTm);
      if (restarting) { restarting = false; start(); return; }
      finish(code == null ? 1 : code);
    });
    armStall();
  };
  start();
  const term = () => { restarting = false; killTree(child); };
  process.on('SIGTERM', term); process.on('SIGINT', term);
}

function agentProgress(agent, o) {
  if (agent === 'harness') return typeof o.type === 'string';   // 有事件就说明它起来了；之后的超时交给它自己
  if (agent === 'codex') return o.type === 'turn.started' ||
    (/^item\.(started|updated|completed)$/.test(o.type || '') && !!o.item && typeof o.item.type === 'string' && !!o.item.type && o.item.type !== 'error');
  if (o.type === 'assistant' || o.type === 'user' || o.type === 'result') return true;
  return o.type === 'stream_event' && !!o.event &&
    /^(message_start|content_block_start|content_block_delta|content_block_stop|message_delta|message_stop)$/.test(o.event.type || '');
}

/* ---------- AI 自己的会话记录 ----------
   Codex / Claude 每个会话都在自己的目录里存一份完整记录，网站删对话时要一起删，不然越攒越多：
   Codex：~/.codex/sessions/年/月/日/rollout-<时间>-<会话号>.jsonl，外加它自己的 sqlite 索引，用它自带的 `codex delete --force` 删（两样一起清）；
          命令删不掉（没装、版本太老）就直接删文件。
   Claude：~/.claude/projects/<目录>/<会话号>.jsonl（有同名文件夹也一起删）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Harness 的会话号是 session-<uuid>；Codex、Claude 是纯 uuid
const HSID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function okAgentSid(agent, id) { return typeof id === 'string' && (agent === 'harness' ? HSID_RE : UUID_RE).test(id); }
const CODEX_HOME = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CLAUDE_HOME = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PRUNE_AGE = 3600e3;   // 1 小时内动过的不当没人要的：可能正在跑、会话号还没来得及记进对话
const OWNED = path.join(BASE, 'agent-sessions');
function ownedFile(agent, id) { return path.join(OWNED, agent + '-' + id.toLowerCase() + '.json'); }
function rememberAgentSession(agent, id) {
  if (!AGENTS.includes(agent) || !okAgentSid(agent, id)) return;
  id = id.toLowerCase();
  try {
    const f = ownedFile(agent, id), old = readJ(f);
    if (old && old.agent === agent && old.id === id) return;
    mk(OWNED); writeJ(f, { agent, id });
  } catch { /* 登记失败就保留孤立记录，不影响聊天，也不会扩大清理范围 */ }
}
function ownsAgentSession(agent, id) {
  const rec = readJ(ownedFile(agent, id));
  return !!rec && rec.agent === agent && rec.id === id.toLowerCase();
}
function listDir(d) { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } }
function fileInfo(f) { try { const st = fs.statSync(f); return { size: st.size, mtime: st.mtimeMs }; } catch { return null; } }
function codexLogs() {
  const out = [], root = path.join(CODEX_HOME(), 'sessions');
  const walk = (d, depth) => {
    for (const e of listDir(d)) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      const m = e.isFile() && /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(e.name);
      if (m) out.push(Object.assign({ id: m[1].toLowerCase(), file: p }, fileInfo(p)));
    }
  };
  walk(root, 0);
  return out;
}
// Harness：~/.dsh/sessions/<工作目录>/session-<uuid>/（一个文件夹），外加 storages/session_projcache/sessions/<会话号>.json
const DSH_HOME = () => process.env.XIN_DSH_HOME || path.join(os.homedir(), '.dsh');
function harnessLogs() {
  const out = [], root = path.join(DSH_HOME(), 'sessions');
  for (const d of listDir(root)) {
    if (!d.isDirectory()) continue;
    for (const e of listDir(path.join(root, d.name))) {
      if (!e.isDirectory() || !HSID_RE.test(e.name)) continue;
      const dir = path.join(root, d.name, e.name);
      let size = 0, mtime = 0;
      for (const f of listDir(dir)) { const i = f.isFile() && fileInfo(path.join(dir, f.name)); if (i) { size += i.size; mtime = Math.max(mtime, i.mtime); } }
      out.push({ id: e.name.toLowerCase(), file: dir, dir: true, size, mtime: mtime || (fileInfo(dir) || {}).mtime || 0 });
    }
  }
  return out;
}
function claudeLogs() {
  const out = [];
  for (const d of listDir(path.join(CLAUDE_HOME(), 'projects'))) {
    if (!d.isDirectory()) continue;
    const dir = path.join(CLAUDE_HOME(), 'projects', d.name);
    for (const e of listDir(dir)) {
      const m = e.isFile() && /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(e.name);
      if (m) out.push(Object.assign({ id: m[1].toLowerCase(), file: path.join(dir, e.name) }, fileInfo(path.join(dir, e.name))));
    }
  }
  return out;
}
// 删掉一个 AI 会话的记录；返回删掉的字节数（大概）
function dropLogs(agent, id, logs) {
  if (!AGENTS.includes(agent) || !okAgentSid(agent, id)) return 0;
  id = id.toLowerCase();
  const mine = (logs || (agent === 'claude' ? claudeLogs() : agent === 'harness' ? harnessLogs() : codexLogs())).filter(l => l.id === id);
  if (agent === 'codex') {
    // 有记录才叫 codex 来删（没有的话它会报错，白跑一趟）
    if (mine.length) spawnSync('codex', ['delete', '--force', id], { cwd: os.homedir(), stdio: 'ignore', timeout: 30000, env: Object.assign({}, process.env, { PATH: BIN + ':' + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin') }) });
  }
  let bytes = 0;
  for (const l of mine) {
    bytes += l.size || 0;
    try { if (l.dir) fs.rmSync(l.file, { recursive: true, force: true }); else fs.unlinkSync(l.file); } catch { /* codex 已经删了 */ }
    if (agent === 'harness') { try { fs.unlinkSync(path.join(DSH_HOME(), 'storages', 'session_projcache', 'sessions', id + '.json')); } catch { /* 没有缓存 */ } }
    if (agent === 'claude') { try { fs.rmSync(path.join(path.dirname(l.file), id), { recursive: true, force: true }); } catch { /* 没有同名文件夹 */ } }
  }
  if (mine.every(l => !fs.existsSync(l.file))) { try { fs.unlinkSync(ownedFile(agent, id)); } catch { /* 没登记或删不掉就留着 */ } }
  return bytes;
}
// 启动方式不能证明归属：别的 codex exec / Claude SDK 也用相同标记。只认网站自己的登记。
// 旧网页会话从现有对话补登记；无法确认归属的历史孤立记录保留。坏文件仍让整个清理停止。
function pruneLogs(minAge = PRUNE_AGE) {
  const res = { codex: 0, claude: 0, harness: 0, bytes: 0 };
  if (!fs.existsSync(SESS)) return Object.assign(res, { skipped: 'no_sessions_dir' });
  const used = new Set();
  for (const f of fs.readdirSync(SESS)) {
    if (!/^s[0-9a-z]+\.json$/.test(f)) continue;
    const s = readJ(path.join(SESS, f));
    if (!s || typeof s !== 'object' || Array.isArray(s) || !AGENTS.includes(s.agent) ||
      (s.agentSid != null && !okAgentSid(s.agent, s.agentSid)))
      return Object.assign(res, { skipped: 'bad_session_file', file: f });
    if (s.agentSid) { used.add(s.agent + ':' + String(s.agentSid).toLowerCase()); rememberAgentSession(s.agent, s.agentSid); }
  }
  const old = (agent, l) => !used.has(agent + ':' + l.id) && ownsAgentSession(agent, l.id) && l.mtime && Date.now() - l.mtime > minAge;
  const cx = codexLogs();
  for (const l of cx.filter(l => old('codex', l))) {
    res.bytes += dropLogs('codex', l.id, cx); res.codex++;
  }
  const cl = claudeLogs();
  for (const l of cl.filter(l => old('claude', l))) {
    res.bytes += dropLogs('claude', l.id, cl); res.claude++;
  }
  const hl = harnessLogs();
  for (const l of hl.filter(l => old('harness', l))) {
    res.bytes += dropLogs('harness', l.id, hl); res.harness++;
  }
  return res;
}

/* ---------- 插件（Codex 的 MCP 服务器） ----------
   用户在网页聊天框「＋ → 插件」里开关。开关记在 ~/.xin/plugins.json（{state: {名字: true / false}}），每一轮起 codex 时加
   -c mcp_servers.名字.enabled=…：下一句就生效（同一个对话里也行），不用改 Codex 的配置文件。
   只管用户自己装的：~/.codex/config.toml 里的（比如 REA）。/etc/codex/config.toml 里电脑自带的（instabox、open-computer-use）
   是基础能力，一直开着，列表里不显示、也不让关（plugins.json 里就算有它们的开关也不用）。
   只给配置里真有的名字加（没有的名字 codex 会当成要新建一个服务器，缺 command 报错）。
   以前小芯用 xin-rea 把 REA 那段挪到 ~/.codex/rea.mcp.toml 里来「关掉」：第一次读插件列表时并回 config.toml，记成关着，
   xin-rea 换成转到 xin plugin 的小脚本，免得两套开关打架。 */
const PLUGINS_F = () => path.join(BASE, 'plugins.json');
const CODEX_SYS = () => process.env.XIN_CODEX_SYS || '/etc/codex/config.toml';
const PLUGIN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PLUGIN_DESC = { rea: '逆向分析（Ghidra）', instabox: '管理云电脑（开机、快照之类）', 'open-computer-use': '操作电脑桌面（看屏幕、点鼠标、打字）' };
function mcpNames(text) {
  const out = [], re = /^[ \t]*\[mcp_servers\.(?:"([^"\n]+)"|([A-Za-z0-9_-]+))\][ \t]*$/gm;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1] || m[2]);
  return out;
}
// 用户自己装的插件（~/.codex/config.toml 里的）；电脑自带的（/etc/codex/config.toml）不算
function mcpUser() { return new Set(mcpNames(readText(path.join(CODEX_HOME(), 'config.toml')))); }
function mcpBuiltin() { return new Set(mcpNames(readText(CODEX_SYS()))); }
function pluginState() { const j = readJ(PLUGINS_F(), {}); return j && j.state && typeof j.state === 'object' ? j.state : {}; }
function savePluginState(st) { mk(BASE); writeJ(PLUGINS_F(), { state: st }); }
export function mcpFlags() {
  const st = pluginState(), have = mcpUser(), out = [];
  for (const n of Object.keys(st)) if (PLUGIN_RE.test(n) && have.has(n) && typeof st[n] === 'boolean') out.push('-c', 'mcp_servers.' + n + '.enabled=' + st[n]);
  return out;
}
function mergeParked() {
  const dir = CODEX_HOME(), cfgF = path.join(dir, 'config.toml'), done = [];
  let cfg = readText(cfgF);
  for (const e of listDir(dir)) {
    if (!e.isFile() || !/\.mcp\.toml$/.test(e.name)) continue;
    const f = path.join(dir, e.name), block = readText(f), names = mcpNames(block).filter(n => PLUGIN_RE.test(n));
    if (!names.length) continue;
    const have = new Set(mcpNames(cfg));
    if (names.some(n => have.has(n))) continue;      // 配置里已经有了：不重复加
    if (!done.length && cfg) { try { fs.copyFileSync(cfgF, cfgF + '.xin-bak'); } catch { /* 备份不了也接着做 */ } }
    cfg = (cfg.trim() ? cfg.replace(/\n*$/, '\n\n') : '') + block.replace(/\n*$/, '\n');
    done.push({ f, names });
  }
  if (!done.length) return [];
  const t = cfgF + '.' + process.pid + '.tmp';
  fs.writeFileSync(t, cfg, { mode: 0o600 }); fs.renameSync(t, cfgF);
  const st = pluginState();
  for (const d of done) { try { fs.renameSync(d.f, d.f + '.merged'); } catch { /* 改不了名也不要紧 */ } for (const n of d.names) st[n] = false; }
  savePluginState(st);
  // 小芯以前写的 xin-rea（挪配置段的那个）换成转到 xin plugin 的小脚本
  const xr = path.join(os.homedir(), '.local', 'bin', 'xin-rea');
  if (readText(xr).includes('.mcp.toml')) {
    try { fs.writeFileSync(xr, '#!/bin/sh\n# 插件开关挪到网页上了（聊天框「＋ → 插件」）；这个命令留着兼容：xin-rea on | off\ncase "$1" in on|off) exec xin plugin "$1" rea;; *) exec xin plugin;; esac\n', { mode: 0o755 }); } catch { /* 写不了就算了 */ }
  }
  return done.reduce((a, d) => a.concat(d.names), []);
}
export function codexEnv() { return Object.assign({}, process.env, { PATH: BIN + ':' + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin') }); }

/* ---------- 用户发来的文件 ----------
   网页把文件传到 WORK/uploads/日期/ 下面（网站 Worker 直接写进这台电脑），发消息时带上路径。这里核对一遍：
   必须在上传目录里、软链接没指到外面、是普通文件。图片 Codex 用 -i 直接看，别的文件把路径写进消息里，AI 自己去读。 */
const UPLOADS = () => path.join(WORK, 'uploads');
const SEND_FILES_MAX = 10;
const IMG_RE = /\.(png|jpe?g|gif|webp)$/i;
function checkFiles(list) {
  if (list == null) return { files: [] };
  if (!Array.isArray(list) || list.length > SEND_FILES_MAX) return { error: 'bad_files', msg: '一次最多发 ' + SEND_FILES_MAX + ' 个文件' };
  const root = path.resolve(UPLOADS());
  let realRoot = root; try { realRoot = fs.realpathSync(root); } catch { /* 还没传过文件 */ }
  const out = [];
  for (const f of list) {
    const p = f && typeof f.path === 'string' ? path.resolve(f.path) : '';
    if (!p.startsWith(root + '/')) return { error: 'bad_file', msg: '文件不在上传目录里' };
    let real, st;
    try { real = fs.realpathSync(p); st = fs.statSync(real); } catch { return { error: 'no_file', msg: '找不到文件：' + path.basename(p) }; }
    if (!real.startsWith(realRoot + '/') || !st.isFile()) return { error: 'bad_file', msg: '文件不在上传目录里' };
    out.push({ path: p, name: String((f && f.name) || path.basename(p)).replace(/[\x00-\x1f]/g, '').slice(0, 120) || path.basename(p), size: st.size, image: IMG_RE.test(p) });
  }
  return { files: out };
}
function sizeText(n) { return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
export function filesPart(files, agent, seesImages) {
  if (!files || !files.length) return '';
  return '\n\n【用户发来的文件（已经在你电脑上）】\n' + files.map(f => '- ' + f.path + '（' + f.name + '，' + (f.image ? '图片，' : '') + sizeText(f.size) + '）').join('\n') +
    (files.some(f => f.image) && agent !== 'harness' ? (agent === 'codex' ? (seesImages ? '\n图片已经直接给你看了。' : '\n你现在用的模型看不了图片内容，要看图的话如实跟用户说。') : '\n图片用 Read 工具打开就能看。') : '');
}

/* ---------- 一个对话的用量 ----------
   网页聊天框底下那一行：上下文（最近一次请求占了多少 / 模型上限）、这个对话累计消耗的 token、缓存命中率。
   Codex：记录里每次请求后都有一条 token_count：total_token_usage 是整个会话累计的（续接也接着算），last_token_usage 是最近一次请求，
          model_context_window 是上限。取最后一条就行，从文件尾巴往前找。
   Claude：记录里每条回答带 usage（同一条回答拆成几行时 usage 重复，按回答 id 去重），加起来；上限用跑的时候 Claude 报的（没有就当 20 万）。 */
function readTail(f, n) {
  let fd = null;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(n, size), b = Buffer.alloc(len);
    return b.toString('utf8', 0, fs.readSync(fd, b, 0, len, size - len));
  } catch { return ''; } finally { if (fd !== null) fs.closeSync(fd); }
}
function codexUsage(id) {
  const l = codexLogs().filter(x => x.id === id).sort((a, b) => b.mtime - a.mtime)[0];
  if (!l) return null;
  for (const n of [256 * 1024, 4 * 1024 * 1024, 64 * 1024 * 1024]) {   // 最后几步的命令输出可能很长，找不到就往前多读一些
    const lines = readTail(l.file, n).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue;
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }   // 读到的第一行可能是半截
      const info = o && o.payload && o.payload.type === 'token_count' && o.payload.info;
      if (!info || !info.total_token_usage) continue;
      const t = info.total_token_usage, last = info.last_token_usage || {};
      const input = t.input_tokens || 0, output = t.output_tokens || 0;
      return { ctx: last.total_tokens || ((last.input_tokens || 0) + (last.output_tokens || 0)), win: info.model_context_window || 0,
        input, cached: t.cached_input_tokens || 0, output, total: t.total_tokens || input + output };
    }
    if (n >= l.size) break;
  }
  return null;
}
function claudeUsage(id, win) {
  const l = claudeLogs().find(x => x.id === id);
  if (!l || l.size > 64 * 1024 * 1024) return null;
  const byMsg = new Map();
  let lastKey = null;
  for (const s of readText(l.file).split('\n')) {
    if (!s.includes('"usage"')) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    const m = o && o.type === 'assistant' && o.message;
    if (!m || !m.usage) continue;
    const key = m.id || o.requestId || o.uuid;
    byMsg.set(key, m.usage);   // 同一条回答后面那行的 usage 是最终的
    if (!o.isSidechain) lastKey = key;
  }
  if (!byMsg.size) return null;
  let input = 0, cached = 0, output = 0;
  for (const u of byMsg.values()) {
    input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    cached += u.cache_read_input_tokens || 0; output += u.output_tokens || 0;
  }
  const u = byMsg.get(lastKey) || {};
  return { ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0),
    win: win || 200000, input, cached, output, total: input + output };
}
export function sessionUsage(s) {
  try {
    if (!s || !okAgentSid(s.agent, s.agentSid) || !s.started) return null;
    if (s.agent === 'harness') return s.hUsage && s.hUsage.total ? s.hUsage : null;
    const id = s.agentSid.toLowerCase();
    return s.agent === 'claude' ? claudeUsage(id, s.ctxWin) : s.agent === 'codex' ? codexUsage(id) : null;
  } catch { return null; }
}

/* ---------- 对外的 op ---------- */
// 开一轮：记下这一轮要给 AI 的话，历史里放 userEv（用户看到的那句），在后台起 runner
function launch(s, m, userEv) {
  const run = rid('r');
  writeJ(metaF(run), Object.assign({ run, sid: s.sid, agent: s.agent, started: Date.now() }, m));
  emit(run, userEv);
  s.runs.push(run); s.updated = Date.now(); writeJ(sessF(s.sid), s);
  rememberAgentSession(s.agent, s.agentSid);
  const child = spawn(process.execPath, [SELF, 'run', run], { detached: true, stdio: 'ignore', cwd: os.homedir() });
  const mm = readJ(metaF(run)); if (mm && !mm.pid) { mm.pid = child.pid; writeJ(metaF(run), mm); }
  child.unref();
  return run;
}
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
  return { sid: s.sid, agent: s.agent, title: s.title, created: s.created, updated: s.updated, turns: (s.runs || []).length, active: r && !runDone(r) ? r : null, archived: !!s.archived, model: s.model || null };
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
    return { ok: true, agents: AGENTS.filter(hasAgent), work: WORK };
  },
  send(a) {
    const fc = checkFiles(a.files);
    if (fc.error) return fc;
    const files = fc.files;
    const text = String(a.text || '').trim();
    if (!text && !files.length) return { error: 'empty', msg: '消息是空的' };
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
      const agent = AGENTS.includes(a.agent) ? a.agent : 'harness';
      s = { sid: rid('s'), agent, title: (text || files.map(f => f.name).join('、')).replace(/\s+/g, ' ').slice(0, 40), agentSid: agent === 'claude' ? crypto.randomUUID() : null, started: false, runs: [], created: Date.now(), updated: Date.now() };
    }
    const ctxLabel = String(a.ctxLabel || '').slice(0, 160);
    try { bondAdd('chat', 1, '陪我聊天'); } catch { /* 好感度记不下来不影响聊天 */ }
    // 只发了文件没说话：给 AI 的话里补一句
    const said = text || (files.every(f => f.image) ? '看看我发的图片。' : '看看我发的文件。');
    const userEv = { t: 'user', text, at: Date.now() };
    if (ctxLabel) userEv.ctx = ctxLabel;
    if (files.length) userEv.files = files.map(f => ({ name: f.name, path: f.path, size: f.size, image: f.image }));
    // Codex 的模型：每一轮按这次选的（不认识的当默认），记在对话上给网页显示
    const cm = s.agent === 'codex' ? codexModel(a.model) : null;
    if (cm) s.model = cm.id;
    const run = launch(s, Object.assign({ text: forAgent(said, a.context) + filesPart(files, s.agent, !!(cm && cm.image)), effort: resolveEffort(s.agent, cm ? cm.id : null, a.effort), images: cm && cm.image ? files.filter(f => f.image).map(f => f.path) : [] }, cm ? { model: cm.id } : {}), userEv);
    return { sid: s.sid, run, agent: s.agent, title: s.title };
  },
  daily_get() {
    return { text: readText(DAILY_FILE()), last: readJ(DAILY_LAST()) || null, done: readJ(DAILY_DONE()) || null, today: today() };
  },
  daily_set(a) {
    const text = String(a.text == null ? '' : a.text);
    if (text.length > 20000) return { error: 'too_long', msg: '清单太长了' };
    mk(BASE);
    const t = DAILY_FILE() + '.' + process.pid + '.tmp';
    fs.writeFileSync(t, text); fs.renameSync(t, DAILY_FILE());
    return { ok: true };
  },
  daily(a) {
    try { pruneLogs(); } catch { /* 清不了不影响每日任务 */ }
    const list = readText(DAILY_FILE()).trim();
    if (!list) return { skipped: 'empty' };
    const done = readJ(DAILY_DONE());
    if (done && done.date === today() && !a.force) return { skipped: 'done', done };
    const last = readJ(DAILY_LAST());
    if (last && last.run && fs.existsSync(metaF(last.run)) && !runDone(last.run)) return { skipped: 'running', run: last.run, sid: last.sid };
    const agent = ['harness', 'codex', 'claude'].find(hasAgent) || null;
    if (!agent) return { error: 'no_agent', msg: '电脑里没有 Harness、codex、claude' };
    mk(SESS); mk(RUNS);
    const s = { sid: rid('s'), agent, title: '每日任务 · ' + today().slice(5), agentSid: agent === 'claude' ? crypto.randomUUID() : null, started: false, runs: [], created: Date.now(), updated: Date.now(), kind: 'daily' };
    const run = launch(s, { text: forAgent(dailyPrompt(list), ''), effort: resolveEffort(agent, null, ''), kind: 'daily' }, { t: 'user', text: '⏰ 每日任务：按清单做一遍', at: Date.now() });
    writeJ(DAILY_LAST(), { date: today(), run, sid: s.sid, at: Date.now(), ok: null });
    return { sid: s.sid, run, agent };
  },
  greet() {
    const warming = maybeWarm();
    const g = getNext();
    let bond = null;
    try { bondAdd('visit', 1, '今天来看我了'); bond = bondInfo(); } catch { /* 记不下来就不带 */ }
    return Object.assign({ warming, bond, moves: readMoves() }, g || {});
  },
  moves() { return { moves: readMoves() }; },
  bond() { return bondInfo(); },
  screen() { return openScreen(); },
  bond_play(a) {
    const why = { cookie: '喂我吃饼干', batt: '给我吸电池', ball: '陪我玩球', led: '陪我玩 LED', phones: '给我戴耳机', swing: '陪我荡秋千', dance: '看我跳舞' }[a.kind] || '陪我玩';
    return Object.assign(bondAdd('play', 1, why), { info: bondInfo() });
  },
  push_key() {
    return { key: vapidKeys().publicKey, subs: readSubs().length };
  },
  push_sub(a) {
    const sub = a.sub;
    if (!okSub(sub)) return { error: 'bad_sub', msg: '推送订阅不对' };
    const list = readSubs().filter(x => x.endpoint !== sub.endpoint);
    list.push({ endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, ua: String(a.ua || '').slice(0, 160), at: Date.now() });
    writeSubs(list.slice(-SUBS_MAX));
    return { ok: true, subs: Math.min(list.length, SUBS_MAX) };
  },
  push_unsub(a) {
    const list = readSubs(), left = list.filter(x => x.endpoint !== a.endpoint);
    if (left.length !== list.length) writeSubs(left);
    return { ok: true, subs: left.length };
  },
  async push_test() {
    const r = await pushAll({ title: '小芯', body: '做完提醒开好啦：你不在看的时候，我做完事会这样告诉你～', tag: 'xin-test', url: '/#xin' });
    return { ok: r.some(x => x.status >= 200 && x.status < 300), results: r };
  },
  plugins() {
    let merged = [];
    try { merged = mergeParked(); } catch { /* 并不回去就按现在的来 */ }
    const r = spawnSync('codex', ['mcp', 'list', '--json'], { encoding: 'utf8', timeout: 30000, cwd: os.homedir(), env: codexEnv() });
    let list;
    try { list = JSON.parse(r.stdout || ''); } catch { return { error: 'list_failed', msg: r.error && r.error.code === 'ENOENT' ? '电脑里没有 codex' : '读不出插件列表' }; }
    const st = pluginState();
    const mine = mcpUser();
    const plugins = (Array.isArray(list) ? list : []).filter(x => x && PLUGIN_RE.test(x.name) && mine.has(x.name)).map(x => {
      const t = x.transport || {};
      return { name: x.name, desc: PLUGIN_DESC[x.name] || '', cmd: t.command ? path.basename(String(t.command)) : String(t.url || t.type || ''), on: typeof st[x.name] === 'boolean' ? st[x.name] : x.enabled !== false };
    });
    return { plugins, merged };
  },
  plugin_set(a) {
    const name = String(a.name || '');
    if (!PLUGIN_RE.test(name)) return { error: 'bad_name', msg: '插件名字不对' };
    if (!mcpUser().has(name)) return mcpBuiltin().has(name) ? { error: 'builtin', msg: name + ' 是电脑自带的，一直开着' } : { error: 'no_plugin', msg: '没有这个插件：' + name };
    const st = pluginState();
    st[name] = !!a.on; savePluginState(st);
    return { ok: true, name, on: st[name] };
  },
  rename(a) {
    if (!okId(a.sid, 's')) return { error: 'bad_sid', msg: '对话编号不对' };
    const s = readJ(sessF(a.sid));
    if (!s) return { error: 'no_session', msg: '找不到这个对话' };
    const title = String(a.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!title) return { error: 'empty', msg: '名字是空的' };
    s.title = title; writeJ(sessF(a.sid), s);
    return { ok: true, session: summary(s) };
  },
  // 归档：收起来不在「最近的对话」里占地方，记录都留着（AI 自己那份会话记录也不删），随时能取消归档、接着聊
  archive(a) {
    if (!okId(a.sid, 's')) return { error: 'bad_sid', msg: '对话编号不对' };
    const s = readJ(sessF(a.sid));
    if (!s) return { error: 'no_session', msg: '找不到这个对话' };
    if (a.on === false) { delete s.archived; delete s.archivedAt; } else { s.archived = true; s.archivedAt = Date.now(); }
    writeJ(sessF(a.sid), s);
    return { ok: true, session: summary(s) };
  },
  forget(a) {
    if (!okId(a.sid, 's')) return { error: 'bad_sid', msg: '对话编号不对' };
    const s = readJ(sessF(a.sid));
    if (!s) return { ok: true, already: true };
    const r = lastRun(s);
    if (r && !runDone(r)) return { error: 'busy', msg: '这个对话还在进行中，先停下来再删' };
    for (const run of s.runs || []) for (const f of [runF(run), metaF(run), seenF(run)]) { try { fs.unlinkSync(f); } catch { /* 本来就没有 */ } }
    fs.unlinkSync(sessF(a.sid));
    // AI 自己那份会话记录也删掉；顺手把别的没有对应对话的旧记录清一清
    let freed = 0, pruned = null;
    try { freed = dropLogs(s.agent, s.agentSid); } catch { /* 删不掉就留着，不影响网站这边 */ }
    try { pruned = pruneLogs(); } catch { /* 同上 */ }
    return { ok: true, freed: freed + (pruned ? pruned.bytes : 0) };
  },
  // 只清没有对应对话的旧记录（每日任务时也会顺手清一次）
  prune() { return pruneLogs(); },
  files(a) {
    const work = path.resolve(WORK);
    const want = path.resolve(work, String(a.path || work));
    const inside = (p, w) => p === w || p.startsWith(w + '/');
    if (!inside(want, work)) return { error: 'outside', msg: '只能看 ' + work + ' 里面的文件' };
    let real, st;
    try { real = fs.realpathSync(want); st = fs.statSync(real); } catch { return { error: 'not_found', msg: '没有这个文件：' + want }; }
    let realWork = work; try { realWork = fs.realpathSync(work); } catch { /* 工作目录还没建 */ }
    if (!inside(real, realWork)) return { error: 'outside', msg: '只能看 ' + work + ' 里面的文件' };
    if (st.isDirectory()) {
      if (a.stat) return { path: want, real, dir: true };
      const items = [];
      for (const d of fs.readdirSync(real, { withFileTypes: true })) {
        if (d.name.startsWith('.')) continue;   // 隐藏文件（.git 之类）不列
        let s2 = null; try { s2 = fs.statSync(path.join(real, d.name)); } catch { /* 坏掉的软链接 */ }
        items.push({ name: d.name, dir: !!(s2 && s2.isDirectory()), size: s2 ? s2.size : 0, mtime: s2 ? Math.round(s2.mtimeMs) : 0 });
      }
      items.sort((x, y) => (y.dir - x.dir) || x.name.localeCompare(y.name, 'zh-CN'));
      return { path: want, dir: true, work, entries: items.slice(0, FILES_MAX), more: Math.max(0, items.length - FILES_MAX) };
    }
    if (!st.isFile()) return { error: 'not_file', msg: '这不是普通文件' };
    const out = { path: want, real, dir: false, work, size: st.size, mtime: Math.round(st.mtimeMs) };
    if (a.stat) return out;
    // 预览：不太大、没有 0 字节、是正常 UTF-8 的当文字给出去；其余只能下载
    if (st.size <= PREVIEW_MAX) {
      const buf = fs.readFileSync(real);
      const text = buf.includes(0) ? null : buf.toString('utf8');
      if (text !== null && !text.includes('�')) out.text = text; else out.binary = true;
    } else out.big = true;
    return out;
  },
  poll(a) {
    if (!okId(a.run, 'r')) return { error: 'bad_run', msg: '编号不对' };
    if (!fs.existsSync(metaF(a.run))) return { error: 'no_run', msg: '找不到这一轮' };
    try { fs.writeFileSync(seenF(a.run), ''); } catch { /* 记不下来就当没在看 */ }
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
    // 没归档的、归档的各给最近 60 个（归档的多了也不会把正在用的挤出去）
    return { sessions: list.filter(s => !s.archived).slice(0, 60).concat(list.filter(s => s.archived).slice(0, 60)).map(summary) };
  },
  history(a) {
    if (!okId(a.sid, 's')) return { error: 'bad_sid', msg: '对话编号不对' };
    const s = readJ(sessF(a.sid));
    if (!s) return { error: 'no_session', msg: '找不到这个对话' };
    const runs = (s.runs || []).slice(-30);
    const out = runs.map(r => { const d = runDone(r), evs = events(r); return { run: r, events: evs, done: d }; });
    const last = out[out.length - 1];
    // started：这一轮什么时候开始的（网页重新打开面板时，「思考中 · N 秒」接着算，不从 0 开始）
    return { session: summary(s), usage: sessionUsage(s), runs: out, active: last && !last.done ? { run: last.run, off: last.events.length, started: (readJ(metaF(last.run)) || {}).started || 0 } : null };
  }
};

function xinCmd(argv) {
  const act = argv[0], arg = argv.slice(1).join(' ').trim();
  if (act === 'plugin') {   // 插件开关：xin plugin（列出来）、xin plugin on 名字、xin plugin off 名字；下一句开始生效
    const sub = argv[1] || '', name = argv[2] || '';
    if (sub === 'on' || sub === 'off') {
      const r = ops.plugin_set({ name, on: sub === 'on' });
      console.log(r.error ? r.msg : (r.on ? '已打开 ' : '已关掉 ') + name + '，下一句开始生效（网页上「＋ → 插件」里也能开关）');
      return r.error ? 1 : 0;
    }
    const r = ops.plugins();
    if (r.error) { console.log(r.msg); return 1; }
    console.log(r.plugins.length ? r.plugins.map(p => (p.on ? '开着  ' : '关着  ') + p.name + (p.desc ? '：' + p.desc : '')).join('\n') : '没有装插件');
    console.log('用法：xin plugin on 名字 / xin plugin off 名字（下一句开始生效）');
    return 0;
  }
  if (act === 'next') {
    const g = setNext(arg);
    if (!g) { console.log('用法：xin next 下次见面要说的一句话'); return 2; }
    console.log('下次见面会说：' + g.text);
    return 0;
  }
  if (act === 'move') {
    const sub = argv[1] || '', run = process.env.XIN_RUN, live = okId(run, 'r') && fs.existsSync(runF(run));
    if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { console.log(MOVE_HELP); return sub ? 0 : 2; }
    const list = readMoves();
    if (sub === 'list') { console.log(list.length ? list.map(m => m.name + '（' + m.frames.length + ' 帧）').join('\n') : '还没有学过新动作'); return 0; }
    if (sub === 'rm') {
      const name = argv.slice(2).join(' ').trim(), left = list.filter(m => m.name !== name);
      if (left.length === list.length) { console.log('没有叫「' + name + '」的动作'); return 1; }
      writeMoves(left); console.log('忘掉了：' + name); return 0;
    }
    if (sub === 'add') {
      let frames;
      try { frames = JSON.parse(argv.slice(3).join(' ')); } catch (e) { console.log('帧不是合法的 JSON：' + e.message + '\n' + MOVE_HELP); return 2; }
      const m = cleanMove(argv[2], frames);
      if (m.error) { console.log(m.error); return 2; }
      const left = list.filter(x => x.name !== m.name);
      if (left.length >= MOVES_MAX) { console.log('最多记 ' + MOVES_MAX + ' 个动作，先 xin move rm 一个'); return 1; }
      left.push({ name: m.name, frames: m.frames, at: Date.now() }); writeMoves(left);
      if (live) emit(run, { t: 'move', name: m.name, frames: m.frames });
      console.log('学会了：' + m.name + '（' + m.frames.length + ' 帧）' + (live ? '，网页上的小芯马上做一遍' : ''));
      return 0;
    }
    const name = argv.slice(1).join(' ').trim(), m = list.find(x => x.name === name);
    if (!m) { console.log('还没学过「' + name + '」。会的：' + (list.map(x => x.name).join('、') || '还没有') + '\n' + MOVE_HELP); return 1; }
    if (!live) { console.log('现在没有在和网页聊天，小芯看不到'); return 1; }
    emit(run, { t: 'xin', act: 'move', arg: m.name, frames: m.frames });
    console.log('小芯收到：' + m.name);
    return 0;
  }
  if (act === 'bond') {
    const d = Number(argv[1]), why = argv.slice(2).join(' ').trim();
    if (!/^[+-]?\d+$/.test(argv[1] || '') || !d || !why) { console.log('用法：xin bond +1 理由（或 -1 理由，一次最多 ±3，一天合计最多 6）'); return 2; }
    const r = bondAdd('ai', d, why), run = process.env.XIN_RUN;
    if (r.delta && okId(run, 'r') && fs.existsSync(runF(run))) emit(run, Object.assign({ t: 'bond', d: r.delta, why: why.slice(0, 40) }, bondInfo()));
    console.log(r.delta ? '好感度 ' + (r.delta > 0 ? '+' : '') + r.delta + '，现在 ' + r.score + '（' + bondLevel(r.score).name + '）' : '今天的好感度已经加减够多了，这次不算（现在 ' + r.score + '）');
    return 0;
  }
  if (act === 'remember') {
    const t = remember(arg);
    if (!t) { console.log('用法：xin remember 要记住的一句话'); return 2; }
    const r = process.env.XIN_RUN;
    if (okId(r, 'r') && fs.existsSync(runF(r))) emit(r, { t: 'mem', text: t });
    console.log('记到记事本里了：' + t);
    return 0;
  }
  if (!act || act === '-h' || act === '--help' || !ACTS[act]) {
    console.log('用法：xin <动作> [参数]\n' + Object.keys(ACTS).map(k => '  ' + k.padEnd(8) + ACTS[k]).join('\n') + '\n  remember 记到记事本里（xin remember 一句话）\n  next     下次见面的开场白（xin next 一句话）\n  move     编新动作、做新动作（xin move help）\n  bond     好感度（xin bond +1 理由）');
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
  let op = process.argv[2];
  const locked = op === 'locked';
  if (locked) op = process.argv[3];
  if (op === 'run') { runner(process.argv[3]); return; }
  if (op === 'warm') { warm(); return; }
  if (op === 'xin') { process.exitCode = xinCmd(process.argv.slice(3)); return; }
  if (!Object.prototype.hasOwnProperty.call(ops, op) && !(locked && op === 'session_patch')) {
    process.stdout.write(JSON.stringify({ error: 'bad_op', msg: '不认识的操作' })); return;
  }
  let args = {};
  try { const t = fs.readFileSync(0, 'utf8').trim(); if (t) args = JSON.parse(t); } catch { args = {}; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  if (op === 'session_patch' && locked && okId(args.sid, 's')) {
    const s = readJ(sessF(args.sid));
    if (!s) { process.stdout.write(JSON.stringify({ error: 'no_session', msg: '找不到这个对话' })); return; }
    for (const k of ['agentSid', 'started', 'ctxWin', 'hUsage']) if (Object.prototype.hasOwnProperty.call(args.changes || {}, k)) s[k] = args.changes[k];
    s.updated = Date.now(); writeJ(sessF(args.sid), s); rememberAgentSession(s.agent, s.agentSid);
    process.stdout.write(JSON.stringify({ session: s })); return;
  }
  if (!Object.prototype.hasOwnProperty.call(ops, op)) { process.stdout.write(JSON.stringify({ error: 'bad_op', msg: '不认识的操作' })); return; }
  const key = op === 'daily' ? 'daily' : ['send', 'rename', 'archive', 'forget'].includes(op)
    ? (okId(args.sid, 's') ? args.sid : op === 'send' && !args.sid ? 'new' : null) : null;
  if (!locked && key) { process.stdout.write(JSON.stringify(lockedCall(key, op, args))); return; }
  Promise.resolve().then(() => ops[op](args || {})).catch(e => ({ error: 'internal', msg: String(e && e.message || e) }))
    .then(res => { process.stdout.write(JSON.stringify(res)); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main();
