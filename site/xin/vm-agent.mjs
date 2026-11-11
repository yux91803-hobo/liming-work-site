#!/usr/bin/env node
/* vm-agent.mjs — 跑在 InstaBox 云电脑里的小芯「大脑」管理脚本（Node 22，与 vm-runtime.mjs 配套，不依赖 npm 包）
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
     memory_list {} / memory_add {content, type} / memory_update {id, content?, type?, private?, confirm?} / memory_forget {id}：小芯的记忆（网站上「小芯的记忆」）
     memory   {}                   以前的记事本 memory.md（只读兼容；第一次用记忆库时已导入成待确认）
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
import * as runtime from './vm-runtime.mjs';
import { StateJournal, inputDigest } from './vm-state.mjs';
import { workVersion, handoffId, handoffPrompt, publicCompletion, foregroundContext } from './vm-handoff.mjs';
import { BASE, journal, WORK, today, readText, hasCmd, mk, rid, okId, readJ, writeJ, cut, processIdentity, alive, processGroupMembers, signalProcessGroup, UPLOADS, readTail, TASK_SANDBOX } from './vm-base.mjs';
import { ACTS, setNext, claimNext, MOVES_MAX, cleanMove, readMoves, writeMoves, MOVE_HELP, bondLevel, bondAdd, bondInfo } from './vm-companion.mjs';
import { bareCmd, screenLog, openScreen, setScreenTag } from './vm-screen.mjs';
import { fromClaude, fromCodex, fromHarness } from './vm-events.mjs';
import { resolveEffort, HARNESS_WIN, HARNESS_MODELS, harnessModel, HARNESS_ROUTE, CODEX_ROUTE, CODEX_MODELS, codexModel, modelLabel, AUTO_EFFORT, ROUTES, KIND_NAMES, namedModel, route } from './vm-models.mjs';
import { withContext, forAgent, MEM_FILE, readMemory, DAILY_FILE, dailyPrompt, remember, systemPrompt, frontMaterials, TIANQI_REMIND, tianqiPrompt, taskSystemPrompt } from './vm-persona.mjs';
export * from './vm-base.mjs';
export * from './vm-companion.mjs';
export * from './vm-screen.mjs';
export * from './vm-events.mjs';
export * from './vm-models.mjs';
export * from './vm-persona.mjs';
import { addMemory, updateMemory, forgetMemory, forgetByKeyword, listMemory, memoryPreferences,setMemoryPreferences,MEMORY_TYPES, MEMORY_BASIS } from './vm-memory.mjs';
import {recallAll,turnGuidance,safeContextEvents,dropRecall} from './vm-context.mjs';
import {dailyEvidence,dailyContext} from './vm-daily.mjs';
import {openFrontProvider,preferredFrontModel,frontModelInfo,OPUS_FRONT_MODEL} from './vm-front-opus.mjs';
import {reportLearning,learningEvidence} from './vm-learning.mjs';
export * from './vm-memory.mjs';
import { memoryActivity, idleMemoryReview } from './vm-memory-idle.mjs';

const SELF = fileURLToPath(import.meta.url);
function workBudget(sid){return runtime.requestBudget(path.join(BASE,'budgets',sid+'.json'),Number(process.env.XIN_TASK_REQUEST_LIMIT)||128,{tokens:Number(process.env.XIN_TASK_TOKEN_LIMIT)||1500000});}
const SESS = path.join(BASE, 'sessions'), RUNS = path.join(BASE, 'runs'), BIN = path.join(BASE, 'bin');
const AGENTS = ['claude', 'codex', 'harness'];
const TEXT_MAX = 20000;
const FILES_MAX = 400, PREVIEW_MAX = 200 * 1024;   // 小芯的文件：一个文件夹最多列多少个；多大以内的文字文件给预览


/* ---------- 每日任务：网站后台每天北京时间 8:55 叫醒电脑（网关 9 点自己签到），9:10 让小芯按清单做一遍，没做成 21:10 再来一次 ---------- */
const DAILY_DONE = () => path.join(BASE, 'daily-done.json');   // 今天做成了：{date, run, sid, at}
const DAILY_LAST = () => path.join(BASE, 'daily-last.json');   // 最近一次：{date, run, sid, at, ok}
function dailyDone(run, meta, ok) {
  const rec = { date: meta.dailyDate || today(), run, sid: meta.sid, at: Date.now(), ok };
  writeJ(DAILY_LAST(), rec);
  if (ok) writeJ(DAILY_DONE(), rec);
}


/* ---------- 网关预热：电脑睡醒后第一个请求常卡很久（实测一次 124 秒），先发一个很短的请求把它吃掉 ---------- */
const WARM_FILE = () => path.join(BASE, 'warm.json');
const WARM_IDLE = 25 * 60e3;          // 25 分钟没动静（电脑 30 分钟没事干会睡）就当它睡过
function lastActivity() {
  let t = (readJ(WARM_FILE()) || {}).at || 0;
  try { for (const f of fs.readdirSync(RUNS)) { const st = fs.statSync(path.join(RUNS, f)); if (st.mtimeMs > t) t = st.mtimeMs; } } catch { /* 还没有记录 */ }
  return t;
}
function maybeWarm() {
  const quota=readJ(path.join(BASE,'front-antigravity-quota.json'));
  if(preferredFrontModel()!==runtime.FRONT_MODEL&&!(quota?.blocked&&quota.retryAt>Date.now()))return false;
  if (Date.now() - lastActivity() < WARM_IDLE || !(hasAgent('harness') || hasCmd('codex'))) return false;
  mk(BASE); writeJ(WARM_FILE(), { at: Date.now(), running: true });
  spawn(process.execPath, [SELF, 'warm'], { detached: true, stdio: 'ignore', cwd: os.homedir() }).unref();
  return true;
}
function warm() {
  const t0 = Date.now();
  // 默认模式用 Codex：有 codex 就用它、用前台聊天的默认模型预热（和 Harness 走同一个网关）；没有才用 Harness
  // （Harness 没有「不留会话」的开关，做完把这个会话删掉）
  const h = !hasCmd('codex') && hasAgent('harness');
  const child = h
    ? spawn(dshCmd(), ['--profile', 'headless'].concat((() => { try { return ['--patch', writePersona('low')]; } catch { return []; } })(), ['--json', '只回复一个字：1']), { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'ignore'], env: Object.assign({}, process.env, harnessEnv()) })
    : spawn('codex', ['exec', '--json', '--ephemeral', '--skip-git-repo-check'].concat(codexRoute(ROUTES.chat[0]), ['-c', 'developer_instructions="只回复一个字：1"'], mcpFlags(), ['1']),
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
export async function pushAll(msg, delivery = {}) {
  const recipient = s => crypto.createHash('sha256').update(s.endpoint).digest('hex');
  const subs = readSubs().filter(s => !(delivery.skip || []).includes(recipient(s)));
  if (!subs.length) return [];
  const keys = vapidKeys(), body = JSON.stringify(msg), gone = [], out = [];
  await Promise.all(subs.map(async sub => {
    if(delivery.respectWatching && deviceWatching(msg.sid,sub.deviceId)){out.push({endpoint:sub.endpoint.slice(0,60),status:null,viewed:true,...(delivery.ids?{recipient:recipient(sub)}:{})});return;}
    let status = 0;
    try {
      const r = await fetch(sub.endpoint, {
        method: 'POST', body: pushEncrypt(body, sub.keys.p256dh, sub.keys.auth), signal: AbortSignal.timeout(10000),
        headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high', Authorization: vapidHeader(sub.endpoint, keys) }
      });
      status = r.status;
    } catch { status = -1; }
    if (status === 404 || status === 410) gone.push({endpoint:sub.endpoint,revision:sub.revision||String(sub.at||'')+JSON.stringify(sub.keys)});
    out.push({ endpoint: sub.endpoint.slice(0, 60), status, ...(delivery.ids ? { recipient: recipient(sub) } : {}) });
  }));
  if(gone.length) lockedCall('tasks','push_gone',{endpoints:gone});
  return out;
}
const NOTICE_DIR = () => path.join(BASE, 'outbox');
function enqueueNotice(t, msg) {
  const id = crypto.createHash('sha256').update(t.sid + ':' + taskVersion(t)).digest('hex').slice(0,32);
  mk(NOTICE_DIR()); const f = path.join(NOTICE_DIR(), id + '.json');
  if (!fs.existsSync(f)) writeJ(f, { id, msg, state: 'pending', attempts: 0, nextAt: Date.now(), delivered: [], created: Date.now() });
  return id;
}
async function deliverNotice(id) {
  if (!/^[a-f0-9]{32}$/.test(id || '')) return;
  const claim = lockedCall('tasks', 'notice_claim', { id });
  if (!claim.notice) return;
  const n = claim.notice;
  const results = await pushAll(n.msg, { skip: n.delivered, ids: true, respectWatching:true });
  lockedCall('tasks', 'notice_done', { id, claim: n.claim, results });
}
async function flushNotices() {
  let names = []; try { names = fs.readdirSync(NOTICE_DIR()); } catch { return; }
  let count=0;
  for (const name of names.filter(n => /^[a-f0-9]{32}\.json$/.test(n))) {
    const n = readJ(path.join(NOTICE_DIR(), name));
    if (n?.state === 'pending' && n.nextAt <= Date.now()) { await deliverNotice(n.id); if(++count>=32)break; }
  }
}


const sessF = sid => path.join(SESS, sid + '.json');
const runF = run => path.join(RUNS, run + '.jsonl');
const metaF = run => path.join(RUNS, run + '.json');
const seenF = run => path.join(RUNS, run + '.seen');   // 网页最近一次来取这一轮的进度（看修改时间）
// flock 的锁随进程退出自动释放；--close 不让后台 runner 继承锁。锁文件不能删，避免等待者锁住旧 inode。
// 同一会话的发送、改名、归档、删除和 runner 更新用同一把锁；已有对话按 sid 分别加锁。
// 后台任务的记录（派、排队、收尾、补充、停）都用同一把锁 tasks，等得久一点
function lockedCall(key, op, args) {
  if (key !== 'new' && key !== 'daily' && key !== 'tasks' && !okId(key, 's')) return { error: 'bad_sid', msg: '对话编号不对' };
  const dir = path.join(BASE, 'locks'); mk(dir);
  const r = spawnSync('flock', ['--exclusive', '--timeout', key === 'tasks' ? '20' : '3', '--conflict-exit-code', '73', '--close',
    path.join(dir, key + '.lock'), process.execPath, SELF, 'locked', op],
  { env:{...process.env,XIN_LOCK:key}, encoding: 'utf8', input: JSON.stringify(args || {}), maxBuffer: 2 * 1024 * 1024 });
  if (r.status === 73) return { error: 'busy', msg: '上一句还没做完，请稍后再试' };
  if (r.error || r.status !== 0) return { error: 'lock_failed', msg: r.error && r.error.code === 'ENOENT'
    ? '云电脑缺少 flock，暂时不能安全更新对话' : '暂时不能安全更新对话，请重试' };
  try { return JSON.parse(r.stdout); } catch { return { error: 'lock_failed', msg: '保存对话的结果不完整，请重试' }; }
}
// 后台任务的记录也是会话文件，但归 tasks 锁管（调度会整份改写它）
function patchSession(sid, changes) { return lockedCall(isTask(readJ(sessF(sid))) ? 'tasks' : sid, 'session_patch', { sid, changes }); }
function applyRunPatch(run,changes){
  const current=readJ(metaF(run));if(!current)return null;
  if(changes?.stopped&&current.ended)return current;
  for(const k of ['pid','identity','childPid','childIdentity','threadId','turnId','transport','compileOk','compileDigest','compileTrusted','stopped','ended','died','orphanStopping','model','effort','from','fallbacks','frontUsage','webCheck'])if(Object.prototype.hasOwnProperty.call(changes||{},k))current[k]=changes[k];
  writeJ(metaF(run),current);return current;
}
function patchRun(run,changes){
  const m=readJ(metaF(run));if(!m)return null;
  const key=m.task||isTask(readJ(sessF(m.sid)))?'tasks':m.sid;
  if(process.argv[2]==='locked'&&process.env.XIN_LOCK===key)return applyRunPatch(run,changes);
  const r=lockedCall(key,'run_patch',{run,changes});if(r.error)throw new Error(r.msg||r.error);return r.meta;
}
function unwatched(run) { let t = 0; try { t = fs.statSync(seenF(run)).mtimeMs; } catch { /* 网页一次都没来取过 */ } return Date.now() - t > UNWATCHED_MS; }
function emit(run, ev) { if(journal.active)journal.append(runF(run),ev);else fs.appendFileSync(runF(run), JSON.stringify(ev) + '\n'); screenLog(ev); }
function events(run) {
  let t; try { t = fs.readFileSync(runF(run), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of t.split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { /* 写到一半的行，下次再读 */ } }
  return out;
}


/* ---------- 后台跑一轮 ---------- */
// xin 命令装两份：~/.xin/bin（PATH 里排最前）和 ~/.local/bin（Codex 用 bash -lc 跑命令，登录 shell 会重置 PATH，但 ~/.local/bin 一直在）
function installXin() {
  const sh = '#!/bin/sh\nexec "' + process.execPath + '" "' + SELF + '" xin "$@"\n';
  mk(BASE); fs.writeFileSync(path.join(BASE, 'shell-env.sh'), 'export PATH=' + JSON.stringify(BIN) + ':"$PATH"\n');
  for (const d of BASE === path.join(os.homedir(), '.xin') ? [BIN, path.join(os.homedir(), '.local', 'bin')] : [BIN]) {
    try { mk(d); fs.writeFileSync(path.join(d, 'xin'), sh, { mode: 0o755 }); fs.chmodSync(path.join(d, 'xin'), 0o755); } catch { /* 写不了就算了 */ }
  }
}
/* ---------- Harness（DeepSeek Harness，命令 dsh） ----------
   dsh --profile headless --json：一句话一个进程，事件一行一个 JSON（session / status / text / tool_call / tool_result / final）。
   线路（本地网关、这一轮选择的模型）和小芯的设定（system-prompt 的 personaPrefix）都写进一个 --patch 文件，
   每一轮都带：不靠 ~/.dsh 里的配置，Harness 重装、升级、~/.dsh 被清掉都不影响小芯（只是 Harness 自己的旧会话接不上）。
   网关的 key 在 ~/.xin/harness.key（只有自己能读），起的时候用环境变量 XIN_HARNESS_KEY 交给它（线路里写的是 apiKeyEnv）。
   接着聊用 --session-id。
   权限：DSH_PERMISSION_MODE=danger-full-access（和 Codex 的 --dangerously-bypass-approvals-and-sandbox 一样，用户确认过）。 */
const HARNESS_KEY = () => path.join(BASE, 'harness.key');
// 模型、强度和插件状态共同决定文件名，几个对话同时发送时互不覆盖。
const HARNESS_PERSONA = (model, effort, purge) => path.join(BASE, 'harness-persona.' + model + '.' + effort + (purge == null ? '' : '.purge-' + (purge ? 'on' : 'off')) + '.yml');
function dshCmd() {
  if (process.env.XIN_DSH) return process.env.XIN_DSH;
  const p = path.join(os.homedir(), '.local', 'bin', 'dsh');
  return fs.existsSync(p) ? p : 'dsh';
}
function hasAgent(agent) { if (agent !== 'harness') return hasCmd(agent); const c = dshCmd(); return c !== 'dsh' ? fs.existsSync(c) : hasCmd('dsh'); }
function writePersona(effort, model) {
  mk(BASE);
  const R = HARNESS_ROUTE, M = harnessModel(model), q = JSON.stringify, e = resolveEffort('harness', M.id, effort);
  const purge = harnessPurgeInstalled() ? pluginState()['harness:purge'] !== false : null, out = HARNESS_PERSONA(M.id, e, purge);
  const t = out + '.' + process.pid + '.tmp';
  // 字符串都用 JSON 写：JSON 字符串就是合法的 YAML 双引号字符串
  fs.writeFileSync(t, [
    '# 天启用的 Harness：线路、思考强度和设定（网站每一轮起 Harness 前重写，不用改 ~/.dsh 里的配置）',
    '- id: llm-pi-ai', '  config:', '    providers:', '      ' + R.provider + ':',
    '        displayName: ' + q(R.name), '        apiKeyEnv: XIN_HARNESS_KEY', '        api: ' + R.api, '        baseURL: ' + q(R.baseURL),
    '        models:'].concat(HARNESS_MODELS.flatMap(m => [
    '          - id: ' + q(m.id), '            name: ' + q(m.name), '            contextWindow: ' + m.win,
    '            reasoningEfforts:'].concat(m.efforts.map(x => '              ' + x + ': ' + (x === 'off' ? 'none' : x)))), [
    '- id: agent-default-model', '  config:', '    provider: ' + R.provider, '    model: ' + q(M.id), '    reasoningEffort: ' + e,
    '- id: system-prompt', '  config:', '    personaPrefix: ' + q(tianqiPrompt())
  ], purge == null ? [] : ['- id: dsh-purge', '  config:', '    enabled: ' + purge], ['']).join('\n'));
  fs.renameSync(t, out);
  // Earlier patches embedded Xiaoxin's notebook. They are regenerated caches: drop any still carrying it.
  for (const n of fs.readdirSync(BASE).filter(n => /^harness-persona\..+\.yml$/.test(n))) {
    const f = path.join(BASE, n);
    if (f !== out && readText(f).includes('<<<记事本')) { try { fs.unlinkSync(f); } catch { /* removed concurrently */ } }
  }
  return out;
}
function harnessEnv() {
  const env = { DSH_PERMISSION_MODE: 'danger-full-access' };
  const key = readText(HARNESS_KEY()).trim();
  if (key) env.XIN_HARNESS_KEY = key;
  return env;
}

function authorModels(deps){return [...new Set(deps.flatMap(d=>(d.actualModels&&d.actualModels.length?d.actualModels:[d.actualModel||d.model])).filter(Boolean))];}
function reviewAuthors(t){return [...new Set((t.reviewAuthors||[]).concat(authorModels((t.after||[]).map(no=>findTask({no})).filter(Boolean))))];}
// 实际运行记录：每一轮 / 每个任务用了哪个模型、为什么、多久、成没成（调候选顺序用）。最多留 3000 条
const STATS_F = () => path.join(BASE, 'model-stats.jsonl');
function statAdd(rec) {
  try {
    mk(BASE);
    const f = STATS_F();
    if (rec.run && readText(f).split('\n').some(line => { try { return JSON.parse(line).run === rec.run; } catch { return false; } })) return;
    fs.appendFileSync(f, JSON.stringify(rec) + '\n');
    if (fs.statSync(f).size > 1024 * 1024) { const lines = readText(f).trim().split('\n'), tmp=f+'.'+process.pid+'.tmp'; fs.writeFileSync(tmp, lines.slice(-3000).join('\n') + '\n');fs.renameSync(tmp,f); }
  } catch { /* 记不下来不影响干活 */ }
}
export function modelStats(days = 14) {
  const since = Date.now() - days * 86400e3, out = {};
  for (const line of readText(STATS_F()).split('\n')) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || r.at < since || !r.model) continue;
    const k = r.agent + ':' + r.model, s = out[k] || (out[k] = { agent: r.agent, model: r.model, n: 0, ok: 0, ms: 0, fails: 0, fellBack: 0 });
    s.n++; if (r.ok) { s.ok++; s.ms += r.ms || 0; } else if (!r.stopped) s.fails++;
    if (r.from) s.fellBack++;
    if(r.usage){s.input=(s.input||0)+(r.usage.input||0);s.cached=(s.cached||0)+(r.usage.cached||0);s.output=(s.output||0)+(r.usage.output||0);}
  }
  return Object.values(out).map(s => Object.assign(s, { avgMs: s.ok ? Math.round(s.ms / s.ok) : 0 })).sort((a, b) => b.n - a.n);
}
const CODEX_KEY = () => process.env.XIN_CODEX_KEY_FILE || path.join(BASE, 'codex.key');
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
    fs.writeFileSync(t, JSON.stringify(Object.assign({}, cat, { models: list.map(x => add.find(m => m.slug === (x && x.slug)) || x).concat(add.filter(m => !list.some(x => x && x.slug === m.slug))) })));
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
  // extra.role：front（前台聊天，教它派后台任务）/ task（后台分身，sess 就是任务记录）/ daily（每日任务）
  // 后台分身在独立 mount/PID namespace 里运行；仅项目副本、私有 home/tmp/io 可写。
  // app-server 与 MCP 都在同一容器里；长期网关 key 只留在控制器的推理代理。
  const M = codexModel(extra && extra.model), role = (extra && extra.role) || 'front';
  const imgs = M.image ? ((extra && extra.images) || []).reduce((a, p) => a.concat(['-i', p]), []) : [];
  const dev = role === 'task' ? taskSystemPrompt(sess) : systemPrompt(undefined, { tasks: role === 'front' });
  const boxed = role === 'task' && !!(extra && extra.sandbox);
  const sandbox = boxed
    ? runtime.permissionArgs(sess, BASE, [...new Set((sess.files || []).map(f=>f.path).concat((extra && extra.images) || []))])
    : ['--dangerously-bypass-approvals-and-sandbox'];
  // Native agents bypass our task tree, queue and budget accounting; dispatch only through xin task.
  const common = ['--json', '--skip-git-repo-check'].concat(sandbox, codexRoute(M.id), ['-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false', '-c', 'developer_instructions=' + JSON.stringify(dev)])
    .concat(effort ? ['-c', 'model_reasoning_effort="' + (effort === 'off' ? 'none' : effort) + '"'] : [], boxed ? taskMcpFlags(sess) : ['-c', 'shell_environment_policy.set.BASH_ENV=' + JSON.stringify(path.join(BASE, 'shell-env.sh'))].concat(mcpFlags()));
  if (sess.started && sess.agentSid) return ['codex', ['exec', 'resume'].concat(imgs, common, [sess.agentSid, text])];
  return ['codex', ['exec'].concat(imgs, common, ['-C', (role === 'task' && (sess.workspace?.work || sess.dir)) || WORK, text])];
}
function killTree(c) {
  if (!c || !c.pid) return;
  const identity=c.xinIdentity||processIdentity(c.pid);
  signalProcessGroup(c.pid,identity);
  setTimeout(()=>signalProcessGroup(c.pid,identity,'SIGKILL'),2000).unref();
}
// When a front turn ends in the fallback or an error, keep a short record of what it tried (logs/front.jsonl, last 200).
// Command shape only — option names and the enumerated kind/model/basis/type values — never titles, goals or the user's words.
export function frontCallShape(name, args, result) {
  const argv = Array.isArray(args?.argv) ? args.argv.map(String) : null, keep = [];
  if (argv) {
    for (let i = 1; i < argv.length && argv[i] !== '--'; i++) {
      const x = argv[i];
      if (i === 1 || (i === 2 && argv[1] === 'task' && /^[a-z]+$/.test(x)) || /^--[a-z-]+$/.test(x)) keep.push(x.slice(0, 20));
      if (/^--(?:kind|model|basis|type)$/.test(x) && argv[i + 1] && !argv[i + 1].startsWith('--')) keep.push(argv[i + 1].slice(0, 40));
    }
  }
  const call = argv ? keep.join(' ') : name === 'finish_event' ? 'finish_event ' + String(args?.action || '?').slice(0, 20) : name + (args ? '' : '（参数不是有效 JSON）');
  return { call: call.slice(0, 200), ...(result?.error ? { error: String(result.msg || result.error).slice(0, 200) } : result?.terminal ? { terminal: true } : {}) };
}
export function frontLog(entry) {
  try {
    const f = path.join(BASE, 'logs', 'front.jsonl'); mk(path.dirname(f));
    const lines = readText(f).split('\n').filter(Boolean).slice(-199); lines.push(JSON.stringify({ at: Date.now(), ...entry }));
    fs.writeFileSync(f, lines.join('\n') + '\n');
  } catch { /* diagnostics never break a turn */ }
}
export function frontDiagnostics(meta,events,logs=[]){
  const kind=s=>/sqlite|database.*lock/i.test(s)?'database':/abort|cancel/i.test(s)?'cancelled':/time.?out|超时/i.test(s)?'timeout':/fetch|HTTP|network|网关|gateway|socket/i.test(s)?'gateway':s?'controller':null;
  return {ended:!!meta.ended,stopped:!!meta.stopped,replyBytes:Buffer.byteLength(String(meta.reply||'')),
    events:events.map(e=>({t:e.t,...(e.t==='done'?{ok:e.ok,stopped:!!e.stopped,ms:e.ms}:{}),...(['text','err'].includes(e.t)?{bytes:Buffer.byteLength(String(e.text||'')),...(e.t==='err'?{errorType:kind(e.text||'')}:{} )}:{})})),
    traces:logs.filter(l=>l.run===meta.run).map(l=>({outcome:l.outcome,errorType:kind(l.error||''),calls:(l.calls||[]).map(c=>({call:c.call,...(c.error?{errorType:kind(c.error)}:{})}))}))};
}
/* ---------- 检测与恢复（方案 B） ----------
   天启、Claude 旧模式和每日任务是完全放权的，技术上拦不住它们碰控制器的目录。这里只做「看得见、找得回」：
   - boundary.jsonl：它们执行的命令里出现控制器目录（每日任务只记密钥、状态库、控制器脚本这些）或改记忆、好感度的 xin 命令时记一条；
   - integrity.jsonl：网站发现云电脑上的控制器脚本和这一版不一致并已重传时记一条（见 src/xin.js 的 verifyAgent）；
   - exports/：每天把状态库（含记忆）整份导出一次，留最近 7 份。
   只记时间、对话和命令开头，不记输出。 */
const BOUNDARY_F = () => path.join(BASE, 'logs', 'boundary.jsonl'), INTEGRITY_F = () => path.join(BASE, 'logs', 'integrity.jsonl');
function logLine(file, entry, keep = 500) {
  try {
    mk(path.dirname(file));
    const lines = readText(file).split('\n').filter(Boolean).slice(-(keep - 1)); lines.push(JSON.stringify({ at: Date.now(), ...entry }));
    const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
  } catch { /* a diagnostic that cannot be written never breaks the turn */ }
}
function recentLines(file, days = 7) {
  const since = Date.now() - days * 86400e3;
  return readText(file).split('\n').flatMap(l => { try { const o = JSON.parse(l); return o.at >= since ? [o] : []; } catch { return []; } });
}
const SENSITIVE_PATH = /\.xin\/(?:workflow\.sqlite|[a-z-]+\.key|agent\/|push\/|exports\/|logs\/)/;
export function boundaryKind(meta, ev) {
  if (!meta || !ev || ev.t !== 'tool') return null;
  const privileged = meta.agent === 'harness' || meta.agent === 'claude', daily = meta.kind === 'daily';
  if (!privileged && !daily) return null;
  const d = String(ev.detail || '').split(BASE + '/').join('~/.xin/');   // the controller directory, wherever it is configured
  if (SENSITIVE_PATH.test(d)) return 'sensitive';
  if (daily) return null;   // the daily routine legitimately reads its own list and notes
  if (/(?:^|[\s;&|(`])xin\s+(?:remember|forget|bond)\b/.test(d)) return 'xin';
  return /(?:~|\$HOME|\$\{HOME\})\/\.xin\b/.test(d) || /\/\.xin\//.test(d) ? 'dir' : null;
}
function boundaryNote(meta, ev) {
  const kind = boundaryKind(meta, ev);
  if (kind) logLine(BOUNDARY_F(), { sid: meta.sid, run: meta.run, agent: meta.kind === 'daily' ? 'daily' : meta.agent, kind, cmd: String(ev.detail || '').slice(0, 200) });
}
export function exportState(keep = 7) {
  const dir = path.join(BASE, 'exports'), file = path.join(dir, 'workflow-' + today().replace(/-/g, '') + '.sqlite');
  if (fs.existsSync(file)) return { skipped: 'exists', file };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // VACUUM INTO writes a consistent, compact copy without blocking writers for long; the name is fixed, not user input.
  journal.db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'"); fs.chmodSync(file, 0o600);
  const old = fs.readdirSync(dir).filter(n => /^workflow-\d{8}\.sqlite$/.test(n)).sort().slice(0, -keep);
  for (const n of old) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* removed concurrently */ } }
  return { ok: true, file, removed: old.length };
}
// 只重试尚未开始工作的 CLI：开始处理后可能长时间不输出，网络超时由 CLI 自己处理，避免重复投递同一轮。
const STALL_MS = Number(process.env.XIN_STALL_MS) || 75000;
function runner(run) {
  const meta = readJ(metaF(run));
  if (!meta) process.exit(1);
  if(meta.stopped){emit(run,{t:'done',ok:false,stopped:true,code:0});patchRun(run,{ended:Date.now()});journal.finishLaunch(run);if(meta.task)lockedCall('tasks','task_finish',{sid:meta.sid,run,ok:false,stopped:true});return;}
  meta.pid = process.pid; meta.identity = processIdentity(process.pid); patchRun(run,{pid:meta.pid,identity:meta.identity});
  const sess = readJ(sessF(meta.sid));
  mk(WORK); installXin();
  const cwd = meta.cwd || WORK; mk(cwd);
  if (meta.task) setScreenTag('[任务 ' + meta.no + '] ');   // 「小芯在干什么」终端里分得清是哪个分身
  const role = meta.kind === 'daily' ? 'daily' : meta.task ? 'task' : 'front';
  const t0 = Date.now(), usageBefore=sessionUsage(sess), state = {};
  let finished = false, stderr = '', child = null, app = null, appCode = null, retried = false, restarting = false, stallTm = 0, deadTm = 0;
  let bridgeTm = 0, steering = false, proxy = null;
  const saveState = () => {
    const changes = {};
    if (state.sid) { changes.agentSid = state.sid; changes.started = true; }
    if (state.ctxWin) changes.ctxWin = state.ctxWin;
    if (state.frontUsage) changes.frontUsage = state.frontUsage;
    if (state.hUsage) changes.hUsage = state.hUsage;
    const r = patchSession(meta.sid, changes);
    if (r.error) {
      state.failed = true;
      if (!state.errShown) { state.errShown = true; emit(run, { t: 'err', text: r.msg }); }
    }
    return r.session || readJ(sessF(meta.sid), sess);
  };
  const finish = (code, why) => {
    if (finished) return;
    if (steering) { setTimeout(() => finish(code, why), 100); return; }
    if(meta.task&&child&&processGroupMembers(child.pid,child.xinIdentity).length){
      const first=!state.cleanupSince;state.cleanupSince=state.cleanupSince||Date.now();
      clearTimeout(stallTm);clearTimeout(deadTm);clearInterval(bridgeTm);
      if(first||Date.now()-state.cleanupSince>=2000)signalProcessGroup(child.pid,child.xinIdentity,first?'SIGTERM':'SIGKILL');
      setTimeout(()=>finish(code,why),100);return;
    }
    finished = true; clearTimeout(stallTm); clearTimeout(deadTm); clearInterval(bridgeTm);
    if (state.timeout && !why) why = '超过 ' + Math.round(((meta.deadline || 0) - meta.started) / 60e3) + ' 分钟还没做完，停下了';
    // Harness 的用量：这个对话以前的加上这一轮的（只在做完时加一次）
    if (meta.agent === 'harness' && state.hu) {
      const prev = (readJ(sessF(meta.sid), sess) || {}).hUsage || { input: 0, output: 0 };
      const input = (prev.input || 0) + state.hu.input, output = (prev.output || 0) + state.hu.output;
      state.hUsage = { ctx: state.hu.last, win: HARNESS_WIN, input, output, total: input + output };
    }
    const s = saveState();
    let m = readJ(metaF(run), meta);
    let stopped = !!m.stopped;
    let ok = !stopped && code === 0 && !state.failed && !state.timeout;
    if(ok&&meta.task&&s.web&&!s.pendingQuestion&&!s.approval&&s.workspace){
      lockedCall('tasks','task_stage',{sid:meta.sid,run,stage:'checking'});
      emit(run,{t:'tool',id:'xin-web-check',name:'检查网页',detail:'实际打开电脑和手机预览，点击交互并检查页面错误'});
      let check;try{check=runtime.checkWebWorkspace(s);}catch(e){check={ok:false,error:e.message};}
      m=patchRun(run,{webCheck:{...check,trusted:true}});stopped=!!m.stopped;ok=ok&&!stopped;
      emit(run,{t:'tool_end',id:'xin-web-check',name:'检查网页',ok:!!check.ok,out:check.error||'电脑和手机交互检查通过'});
    }
    if(ok && meta.task && !s.pendingQuestion && !s.approval && s.workspace && runtime.stm32Task(s)) {
      emit(run,{t:'tool',id:'xin-build',name:'编译核验',detail:'控制器在隔离副本执行受控构建，并检查本次新生成的固件产物'});
      let build;try{build=runtime.compileWorkspace(s);}catch(e){build={ok:false,output:e.message};}
      m=patchRun(run,{compileTrusted:true,compileOk:!!build?.ok,compileDigest:build?.digest});
      stopped=!!m.stopped;ok=ok&&!stopped;
      emit(run,{t:'tool_end',id:'xin-build',name:'编译核验',detail:'受控构建 / '+(build?.artifacts||[]).join('、'),ok:!!build?.ok,out:build?.output||''});
    }
    if (!ok && !stopped && !state.errShown) {
      const tail = stderr.trim().split('\n').slice(-6).join('\n');
      emit(run, { t: 'err', text: why || tail || ('退出码 ' + code) });
    }
    // 前台这一句带上了哪些任务结果：做成了就记下前台已经知道了（没做成下一句再带）。在 done 之前记，免得用户紧接着发的下一句又带一遍
    // Completion and the final stop decision are committed under the conversation/task lock below.
    // usage：这个对话到这一轮为止的用量（网页聊天框底下那一行）；model：这一轮实际用的模型（网页在回答下面写出来），why：为什么挑它，from：先试了哪个没接上
    const doneEv = { t: 'done', ok, stopped, code, ms: Date.now() - t0, cost: state.cost, effort: meta.effort || '', usage: sessionUsage(s) };
    if (meta.model && meta.agent !== 'claude') Object.assign(doneEv, { model: meta.model }, meta.why ? { why: meta.why } : {}, meta.from ? { from: meta.from } : {}, meta.providerModel ? {providerModel:meta.providerModel} : {});
    const stat=meta.agent !== 'claude'&&!state.frontReceipt ? { at:Date.now(),agent:meta.agent,model:meta.model||'',kind:meta.routeKind||meta.kind||'chat',why:meta.why||'',ms:Date.now()-t0,from:meta.from||undefined,...(doneEv.usage?{usage:{input:Math.max(0,doneEv.usage.input-(usageBefore?.input||0)),cached:Math.max(0,(doneEv.usage.cached||0)-(usageBefore?.cached||0)),output:Math.max(0,doneEv.usage.output-(usageBefore?.output||0))}}:{}) } : null;
    const completion=lockedCall(meta.task?'tasks':meta.sid,'run_complete',{run,done:doneEv,stat});
    if(completion.error){finished=false;setTimeout(()=>finish(code,why),1000);return;}
    if(completion.done){Object.assign(doneEv,completion.done);ok=doneEv.ok;stopped=doneEv.stopped;}
    if (meta.task) {
      killTree(child); // 收掉本轮进程组，包括仍持有临时预览端口的子进程
      // 后台任务：结果先存进任务记录（接着做、等确认还是收尾、排下一个），要推送的在锁外发
      const r = lockedCall('tasks', 'task_finish', { sid: meta.sid, run, ok, stopped, timeout: !!state.timeout, model: meta.model });
      if (r && r.notice) { setTimeout(() => process.exit(0), 20000).unref(); deliverNotice(r.notice).catch(() => {}); }
      return;
    }
    if (meta.kind === 'daily') dailyDone(run, meta, ok);
    // 做完提醒：你不在看（关了网页、切到别的应用）才发；你自己停的、每日任务不发
    else if (!stopped&&meta.kind!=='handoff') {
      const last = events(run).filter(e => e.t === 'text').pop();
      const text = plainText(last && last.text, 120);
      setTimeout(() => process.exit(0), 20000).unref();
      pushAll({ title: ok ? '小芯做完了' : '小芯没做成', body: text || (ok ? '点开看看' : '点开看看怎么回事'), tag: 'xin-' + meta.sid, sid: meta.sid, url: '/#xin=' + meta.sid },{respectWatching:true}).catch(() => {});
    }
    if (!stopped) lockedCall(meta.sid, 'continue_steers', { sid: meta.sid, run });
  };
  const norm = meta.agent === 'claude' ? fromClaude : meta.agent === 'harness' ? fromHarness : fromCodex;
  const start = async () => {
    // 每次都重新读会话：重来时 AI 的会话号可能已经有了，要接着那个会话
    let patch = null;
    if (meta.agent === 'harness') { try { patch = writePersona(meta.effort, meta.model); } catch { /* 写不了就用 Harness 自己的设定 */ } }
    const currentSession = readJ(sessF(meta.sid), sess);
    if(currentSession.tkind==='review'&&reviewAuthors(currentSession).includes(meta.model)){finish(127,'独立复核模型与实际作者相同，已拒绝启动。');return;}
    let invocation;
    try { invocation = meta.task&&meta.model===runtime.AGY_MODEL?[process.execPath,[SELF,'agy-run',run]]:agentArgs(meta.agent, currentSession, meta.text, meta.effort || '', { images: meta.images || [], patch, model: meta.model, role, sandbox: !!meta.sandbox }); }
    catch (e) { finish(127, e.message); return; }
    const [cmd, args] = invocation;
    let got = false, buf = '';
    const accept = o => {
      if (agentProgress(meta.agent, o)) { got = true; clearTimeout(stallTm); }
      for (const ev of norm(o, state)) {
        boundaryNote(meta, ev);
        if (ev.t === 'err' && canSwitch()) { state.heldErr = ev; got = true; clearTimeout(stallTm); continue; }
        emit(run, ev); if (ev.t !== 'status') { got = true; clearTimeout(stallTm); }
        if (meta.task && ev.t === 'tool_end' && ev.ok && /(?:^|\W)(?:make|arm-none-eabi-gcc|cmake)(?:\s|$)/.test(ev.detail || '')) {
          const m = readJ(metaF(run), meta); m.compileOk = true;
          if (currentSession.workspace) { try { m.compileDigest = runtime.sourceDigest(currentSession.workspace.work); } catch {} }
          patchRun(run,{compileOk:m.compileOk,compileDigest:m.compileDigest});
        }
      }
      if (state.sid && !state.sidSaved) { saveState(); state.sidSaved = true; }
    };
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
      const spawnOptions = {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
        env: Object.assign({}, process.env, meta.agent === 'harness' ? harnessEnv() : meta.agent === 'codex' ? codexKeyEnv() : {}, { PATH: BIN + ':' + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin'), XIN_RUN: run, XIN_HOME: BASE })
      };
      app = null; appCode = null;
      if (meta.agent === 'codex' && meta.model!==runtime.AGY_MODEL && process.env.XIN_CODEX_TRANSPORT !== 'exec') {
        const config = [];
        for (let i = 0; i < args.length; i++) if (args[i] === '-c') config.push('-c', args[++i]);
        if (!meta.sandbox) config.push('-c', 'sandbox_mode="danger-full-access"');
        let container;
        if(meta.sandbox){
          // Private network: the container reaches only the pinned inference proxy and public-web egress.
          proxy=await runtime.taskNetwork(currentSession.workspace,{baseURL:CODEX_ROUTE.baseURL,key:codexKeyEnv().XIN_CODEX_KEY,model:meta.model,takeBudget:workBudget(meta.sid)});
          container=runtime.containerAppServer(currentSession,config,{proxy,catalog:codexCatalog()});
        }
        app = runtime.appServer(container?.command || cmd, config, { commandArgs:container?.args, spawn: { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] }, cwd,
          thread: currentSession.started ? currentSession.agentSid : null, text: meta.text, images: meta.images || [], model: meta.model,
          effort: meta.effort, boxed: false, rollback: !!meta.from && !!meta.turnId && !!currentSession.started, emit: accept,
          turn: (threadId, turnId) => { Object.assign(meta, { threadId, turnId }); patchRun(run,{threadId,turnId,transport:'app-server'}); },
          complete: code => { appCode = code; },
          stop: killTree,
          fail: e => { state.failed = true; state.heldErr = { t: 'err', text: e.message }; },
          approve: request => approvalRequest(run, meta, request)
        });
        child = app.child;
      } else child = spawn(cmd, args, spawnOptions);
      child.xinIdentity=processIdentity(child.pid);
      patchRun(run,{childPid:child.pid,childIdentity:child.xinIdentity});
    } catch (e) { proxy?.close(); proxy=null; finish(127, '启动 ' + cmd + ' 失败：' + e.message); return; }
    child.on('error', e => finish(127, e.code === 'ENOENT' ? '云电脑里没有 ' + cmd + ' 命令' : '启动 ' + cmd + ' 失败：' + e.message));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      if (app) return;  // app-server has its own JSON-RPC parser
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line || line[0] !== '{') continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        // Codex JSON 不转发思考增量，Claude 通过 partial messages 报 message_start。
        // 确认任务开始就停止网页重放；之后即使暂时静默也交给 CLI 自己的网络超时与重试。
        accept(o);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); });
    child.on('close', code => {
      proxy?.close(); proxy=null;
      clearTimeout(stallTm);
      if (restarting) { restarting = false; start(); return; }
      const c = appCode == null ? code == null ? 1 : code : appCode;
      if((c!==0||state.failed)&&sess.strictModel&&meta.model!==runtime.AGY_MODEL&&!state.strictRetried&&!state.worked&&!state.timeout&&!(readJ(metaF(run),meta)||{}).stopped){
        state.strictRetried=true;emit(run,{t:'status',text:'执行入口暂时没接上，正在按原安排重试。'});
        Object.assign(state,{failed:false,errShown:false,heldErr:null,lastErr:''});stderr='';start();return;
      }
      // 模型还没开始干活就失败了：换候选里的下一个模型再试一次（用户自己停的不换）
      const quotaFallback=c===75&&meta.model===runtime.AGY_MODEL&&!state.switched&&!state.timeout&&safeFallbacks().length;
      if ((c !== 0 || state.failed) && (canSwitch()||quotaFallback) && !(readJ(metaF(run), meta) || {}).stopped) {
        const from = meta.model;
        const candidates=safeFallbacks();
        if(!candidates.length){finish(c,'独立复核候选已改变，未回退到实际作者模型。');return;}
        state.switched = true; meta.from = from; meta.model = candidates[0]; meta.fallbacks = candidates.slice(1);meta.effort=AUTO_EFFORT;
        patchRun(run,{model:meta.model,effort:meta.effort,from,fallbacks:meta.fallbacks});
        if(quotaFallback)meta.text='原执行入口额度已耗尽。请先读取同一项目副本中的现有文件，再继续原要求；保留已完成的改动，不重复执行已完成的外部操作。\n'+meta.text;
        if(meta.task){const saved=lockedCall('tasks','task_model',{sid:meta.sid,run,model:meta.model,worked:!!state.worked});if(saved.error){finish(127,'无法保存任务实际模型，未执行回退。');return;}}
        emit(run, { t: 'status', text: from===runtime.AGY_MODEL?'原执行入口暂不可用，保留现有文件继续处理。':modelLabel(from) + ' 没接上，换 ' + modelLabel(meta.model) + ' 再试…' });
        Object.assign(state, { failed: false, errShown: false, heldErr: null, lastErr: '' }); stderr = '';
        start(); return;
      }
      if (state.heldErr) { emit(run, state.heldErr); state.heldErr = null; }
      const reviewFailure=sess.tkind==='review'&&(c!==0||state.failed)&&!state.worked&&!state.timeout&&!state.switched&&!safeFallbacks().length;
      finish(c,reviewFailure?'独立复核候选已耗尽，未回退到实际作者模型。':undefined);
    });
    armStall();
  };
  // 能不能换模型重来：只有 Codex（模型是路由器挑的），还有备选，这一轮还没换过，模型还没真的开始干活
  const safeFallbacks=()=>{const current=readJ(sessF(meta.sid),sess);if(current.strictModel)return [];const avoid=current.tkind==='review'?reviewAuthors(current):[];return (meta.fallbacks||[]).filter(id=>!avoid.includes(id)&&CODEX_MODELS.some(m=>m.id===id&&(!(meta.images||[]).length||m.image)));};
  const canSwitch = () => meta.agent === 'codex' && !state.switched && !state.worked && !state.timeout && safeFallbacks().length > 0;
  // 后台任务到点没做完：停下（算没做成）
  if (meta.deadline) deadTm = setTimeout(() => { state.timeout = true; restarting = false; emit(run, { t: 'status', text: '到时间了，先停下' }); killTree(child); }, Math.max(1000, meta.deadline - Date.now()));
  bridgeTm = setInterval(async () => {
    try {
      runtime.drainBridge(sess.workspace, a => {
        if (a.op === 'remember') { const r = addMemory({ content: a.text, source: 'worker', evidence: { sid: meta.sid, run } }); return r.error ? r.msg : '已记成待确认的项目记录：' + r.item.content; }
        if (a.op === 'ask') { const r = lockedCall('tasks', 'task_ask', { sid: meta.sid, question: a.text }); return r.error ? r.msg : '已记下问题，请结束本轮，等待用户回复。'; }
        return '不支持这个操作';
      });
      if (!app || steering || finished) return;
      const m = readJ(metaF(run), meta), queue = (m.steers || []).filter(x => x.state === 'pending');
      if (!queue.length || !m.turnId) return;
      steering = true;
      for (const q of queue) {
        try { await app.steer(q.text, q.id); lockedCall(meta.task ? 'tasks' : meta.sid, 'steer_ack', { run, id: q.id, state: 'accepted' }); }
        catch (e) { lockedCall(meta.task ? 'tasks' : meta.sid, 'steer_ack', { run, id: q.id, state: 'next', error: e.message }); }
      }
    } catch { /* pending input stays durable and is retried */ }
    finally { steering = false; }
  }, 300);
  const term = external => {
    restarting = false;
    // Host shutdown sends SIGTERM too. Only an explicit stop owns the stopped flag;
    // otherwise leave this run unfinished so the supervisor recovers its checkpoint.
    if (external && meta.task && !state.timeout && !readJ(metaF(run), meta)?.stopped) {
      finished = true; killTree(child); process.exit(143);
    }
    killTree(child);
  };
  process.on('SIGTERM', () => term(true)); process.on('SIGINT', () => term(false));
  if (meta.agent === 'codex' && role === 'front') {
    const immediate=lockedCall('tasks','front_immediate',{run});
    if(immediate.error){state.failed=true;finish(1,immediate.msg||immediate.error);return;}
    if(immediate.terminal){state.frontReceipt=!immediate.reply;if(immediate.reply&&meta.frontUsage)state.frontUsage=meta.frontUsage;lockedCall(meta.sid,'front_reply',{run,text:immediate.text});finish(0);return;}
    const context=foregroundContext(sess,run,r=>safeContextEvents(r,events,'own')),input=context.input;
    journal.write(path.join(BASE,'contexts',meta.sid+'.json'),JSON.stringify(context.checkpoint));
    try {
      // 会变的资料（记忆、每日记录、当前时间）放在历史之后：系统提示和历史这段前缀每轮不变，缓存才命中
      input.push({role:'user',content:frontMaterials()});
      if(!meta.handoff){const guide=turnGuidance({sid:meta.sid,text:meta.frontRequest||'',context:meta.context||''});if(guide)input.push({role:'user',content:guide});}
      input.push(frontUserInput(meta));
    }
    catch(e) { state.failed=true;finish(1,e.message);return; }
    const deliver=args=>lockedCall('tasks','handoff_finish',{run,...args});
    const handoffBudget=meta.handoff?workBudget(journal.handoff(meta.handoff)?.task||meta.sid):null;
    if(meta.handoffFallback){deliver({action:'deliver',text:''});finish(0);return;}
    const action = argv => lockedCall('tasks','front_action',{run,argv});
    const calls = [];let usedFallback = false;
    const trace = (name, args, result) => { if (calls.length < 12) calls.push(frontCallShape(name, args, result)); };
    const fallback = () => {
      usedFallback = true;
      const r = lockedCall('tasks','front_fallback',{run});
      if (r.error) throw new Error(r.msg || r.error);
      return r.text;
    };
    const controller = new AbortController();
    const cancel = () => { controller.abort(); if(!finished){state.failed=!readJ(metaF(run))?.stopped;finish(0);} };
    process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
    let provider;const protocol={};
    const infer=async()=>{
      provider=await openFrontProvider({baseURL:CODEX_ROUTE.baseURL,key:codexKeyEnv().XIN_CODEX_KEY,signal:controller.signal,
        protocol:e=>{const p=protocol[e.kind]||(protocol[e.kind]={count:0,bytes:0,fields:[]});p.count++;p.bytes+=e.bytes||0;p.fields=[...new Set(p.fields.concat(e.inputFields||[]))];},
        quotaState:readJ(path.join(BASE,'front-antigravity-quota.json')),
        quota:quota=>lockedCall('tasks','front_quota',{quota}),
        model:chosen=>{const r=lockedCall(meta.sid,'front_model',{run,...chosen});if(r.error)throw Error(r.msg||r.error);meta.model=chosen.model;meta.providerModel=chosen.providerModel;if(['quota','format','front_model'].includes(chosen.reason))meta.from=OPUS_FRONT_MODEL;}
      });
      if(meta.frontFiles?.some(f=>f.image)&&provider.image===false){
        patchRun(run,{frontSeesImages:false,images:[]});
        const vision=lockedCall('tasks','front_immediate',{run});if(vision.error)throw Error(vision.msg||vision.error);
        if(vision.terminal)return vision.text;
        throw Error('当前前台没有视觉输入，无法读取图片');
      }
      return runtime.frontTurn({baseURL:CODEX_ROUTE.baseURL,key:codexKeyEnv().XIN_CODEX_KEY,request:provider.request,ms:meta.model===runtime.FRONT_MODEL?25000:65000,
      instructions:systemPrompt(undefined,{tasks:true,materials:false}),acts:Object.keys(ACTS),input,command:action,fallback,trace,signal:controller.signal,handoff:!!meta.handoff,lookupBeforeAnswer:!meta.handoff&&runtime.frontLookupRequired(meta.frontRequest||''),deliver,takeBudget:handoffBudget,
      usage:u=>{if(u){
        handoffBudget?.recordUsage(u);
        const prev = state.frontUsage || usageBefore || {input:0,output:0,cached:0};
        state.frontUsage = {input:prev.input+(u.input_tokens||0),output:prev.output+(u.output_tokens||0),cached:prev.cached+(u.input_tokens_details?.cached_tokens||0),ctx:(u.input_tokens||0)+(u.output_tokens||0),win:1000000};
        state.frontUsage.total=state.frontUsage.input+state.frontUsage.output;
        patchRun(run,{frontUsage:state.frontUsage});
      }}
    });};
    infer().then(text=>{if(usedFallback)frontLog({run,outcome:'fallback',calls});if(!finished){if(text){const r=lockedCall(meta.sid,'front_reply',{run,text});if(r.error){state.failed=true;finish(1,r.msg||r.error);return;}}finish(0);}})
      .catch(e=>{if(!finished){frontLog({run,outcome:usedFallback?'fallback':'error',error:String(e.message||e).slice(0,300),calls,...(Object.keys(protocol).length?{protocol}:{})});state.failed=true;finish(1,e.message);}})
      .finally(()=>provider?.close());
  } else start();
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
function codexLogs(home = CODEX_HOME()) {
  const out = [], root = path.join(home, 'sessions');
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
// 删对话时，状态库之外还留着它内容的几处（审查问题 5）：发送回执（带标题）、推送队列里它的条目（结果正文）、
// 前台诊断日志里它的条目、跨对话检索索引。都按对话编号认领，别的对话不动。
function dropConversationTraces(sid, runs) {
  const own = new Set(runs);
  const sweep = (dir, mine) => {
    let names = []; try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (!/^[A-Za-z0-9_-]{8,80}\.json$/.test(n)) continue;
      const f = path.join(dir, n);
      try { if (mine(readJ(f))) fs.unlinkSync(f); } catch { /* 删不掉就留着 */ }
    }
  };
  sweep(path.join(BASE, 'messages'), r => r?.sid === sid);
  sweep(NOTICE_DIR(), n => n?.msg?.sid === sid);
  try {
    const f = path.join(BASE, 'logs', 'front.jsonl'), lines = readText(f).split('\n').filter(Boolean);
    const keep = lines.filter(l => { try { return !own.has(JSON.parse(l).run); } catch { return true; } });
    if (keep.length !== lines.length) fs.writeFileSync(f, keep.length ? keep.join('\n') + '\n' : '');
  } catch { /* 没有这个文件 */ }
  try { dropRecall(sid); } catch { /* 下次同步会清 */ }
}
// 推送队列里已送达或已放弃的条目，7 天后删掉
function pruneNotices(now = Date.now(), maxAge = 7 * 86400e3) {
  let names = [], removed = 0; try { names = fs.readdirSync(NOTICE_DIR()); } catch { return removed; }
  for (const n of names.filter(x => /^[a-f0-9]{32}\.json$/.test(x))) {
    const f = path.join(NOTICE_DIR(), n), v = readJ(f);
    if (v && (v.state === 'delivered' || v.state === 'failed') && now - (v.deliveredAt || v.created || now) > maxAge) { try { fs.unlinkSync(f); removed++; } catch { /* 下次 */ } }
  }
  return removed;
}
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
  // 30 天前的写回备份、7 天前已送达的推送条目（返回结果只把字节数算进 bytes，字段不变）
  try { res.bytes += runtime.pruneBackups(BASE).bytes; } catch { /* 下次 */ }
  try { pruneNotices(); } catch { /* 下次 */ }
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
function harnessPurgeInstalled() {
  const p = readJ(path.join(DSH_HOME(), 'profiles', 'headless', 'package.json'), {});
  return !!(p.dependencies && p.dependencies['dsh-purge-community']);
}
// 后台分身：插件全关（自己装的、电脑自带的都关）
export function mcpAllOff() {
  const out = [];
  for (const n of new Set([...mcpUser(), ...mcpBuiltin()])) if (PLUGIN_RE.test(n)) out.push('-c', 'mcp_servers.' + n + '.enabled=false');
  return out;
}
export const TASK_REA_TOOLS = ['open_binary', 'close_binary', 'binary_session', 'binary_overview', 'list_documents', 'list_names', 'list_strings', 'procedure_info',
  'read_function_instructions', 'read_bytes', 'find_xrefs_to_name', 'resolve_native_call_targets', 'inline_comment', 'analyze_function', 'search_bytes', 'address_to_file_offset'];
function taskMcpFlags(t) {
  const allowed = new Set((t.plugins || []).filter(n => n === 'rea' && mcpUser().has(n)));
  const flags = [...new Set([...mcpUser(), ...mcpBuiltin()])].flatMap(name => ['-c', 'mcp_servers.' + name + '.enabled=' + allowed.has(name)]
    .concat(allowed.has(name) ? ['-c', 'mcp_servers.' + name + '.default_tools_approval_mode="prompt"',
      '-c', 'mcp_servers.' + name + '.enabled_tools=' + JSON.stringify(TASK_REA_TOOLS)].concat(TASK_REA_TOOLS.flatMap(tool =>
        ['-c', 'mcp_servers.' + name + '.tools.' + tool + '.approval_mode="approve"'])) : []));
  if (allowed.has('rea')) {
    if (!fs.existsSync('/usr/bin/bwrap')) throw new Error('后台 REA 需要 bubblewrap；请运行 scripts/vm/setup-xin-runtime.sh');
    const r=spawnSync('codex',['mcp','get','rea','--json'],{encoding:'utf8',env:codexEnv(),timeout:15000});
    if (r.status!==0) throw new Error('读不出 REA 的本机启动配置');
    const {roots,...confined}=runtime.mcpTransport(t,BASE,JSON.parse(r.stdout)); t.mcpRoots=roots;
    for (const [k,v] of Object.entries(confined)) flags.push('-c','mcp_servers.rea.'+k+'='+(k==='env' ? '{'+Object.entries(v).map(([name,value])=>JSON.stringify(name)+'='+JSON.stringify(value)).join(',')+'}' : JSON.stringify(v)));
  }
  return flags;
}
async function approvalRequest(run, meta, request) {
  // File-system escalation is never granted by a background model or its prompt.
  if (request.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (request.method === 'mcpServer/elicitation/request') return { action: 'decline' };
  if (!meta.task || request.method !== 'item/tool/requestUserInput') return { decision: 'decline' };
  const id = rid('a');
  const p = request.params || {};
  lockedCall('tasks', 'task_approval', { sid: meta.sid, run, id, method: request.method, kind: 'input', question: cut((p.questions || []).map(q => q.question).join('\n'), 450) });
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 350));
    const m = readJ(metaF(run));
    if (!m || m.stopped || m.ended) return { answers: {} };
    const reply = (m.approvalReplies || {})[id];
    if (reply) return { answers: Object.fromEntries((p.questions || []).map(q => [q.id, { answers: [reply] }])) };
  }
}
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
  let tip = '';
  if (files.some(f => f.image)) {
    // 前台用 Responses input_image；Codex 后台用 -i；Harness 用自己的工具打开路径。
    if (agent === 'codex') tip = seesImages ? '\n图片已经直接给你看了。' : '\n你现在用的模型看不了图片内容，要看图的话如实跟用户说。';
    else if (agent === 'harness') tip = seesImages ? '\n图片在你电脑上，用工具打开上面的路径就能看。' : '\n你现在用的模型看不了图片内容，要看图的话如实跟用户说。';
    else tip = '\n图片用 Read 工具打开就能看。';
  }
  return '\n\n【用户发来的文件（已经在你电脑上）】\n' + files.map(f => '- ' + f.path + '（' + f.name + '，' + (f.image ? '图片，' : '') + sizeText(f.size) + '）').join('\n') + tip;
}

// Only the controller reads uploads and constructs image parts. The foreground has no file-reading tool.
export function frontUserInput(meta) {
  const images = Array.isArray(meta.images) ? meta.images : [];
  if (!images.length) return {role:'user',content:meta.text};
  const checked = checkFiles(meta.frontFiles);
  if (checked.error) throw Error('图片没有成功传给我：'+checked.msg);
  const content = [{type:'input_text',text:meta.text}];
  const root = fs.realpathSync(UPLOADS()) + path.sep;
  for (const file of images) {
    if (!checked.files.some(f=>f.image && f.path===file)) throw Error('图片没有成功传给我：文件不在本轮上传列表里');
    let fd;
    try {
      fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(fd).isFile() || !fs.realpathSync('/proc/self/fd/'+fd).startsWith(root)) throw Error('文件不在上传目录里');
      const ext=path.extname(file).slice(1).toLowerCase(),mime=ext==='jpg'||ext==='jpeg'?'image/jpeg':'image/'+ext;
      content.push({type:'input_image',image_url:'data:'+mime+';base64,'+fs.readFileSync(fd).toString('base64'),detail:'auto'});
    } catch { throw Error('图片没有成功传给我：请重新上传这张图片'); }
    finally { if(fd!==undefined)fs.closeSync(fd); }
  }
  return {role:'user',content};
}

/* ---------- 一个对话的用量 ----------
   网页聊天框底下那一行：上下文（最近一次请求占了多少 / 模型上限）、这个对话累计消耗的 token、缓存命中率。
   Codex：记录里每次请求后都有一条 token_count：total_token_usage 是整个会话累计的（续接也接着算），last_token_usage 是最近一次请求，
          model_context_window 是上限。取最后一条就行，从文件尾巴往前找。
   Claude：记录里每条回答带 usage（同一条回答拆成几行时 usage 重复，按回答 id 去重），加起来；上限用跑的时候 Claude 报的（没有就当 20 万）。 */
function codexUsage(id, home) {
  const l = codexLogs(home).filter(x => x.id === id).sort((a, b) => b.mtime - a.mtime)[0];
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
    if(isTask(s)&&s.antigravityConversation){const b=readJ(path.join(BASE,'budgets',s.sid+'.json'));if(b?.total)return {input:b.input||0,output:b.output||0,cached:b.cached||0,total:b.total,ctx:s.frontUsage?.ctx||0,win:1000000};}
    if (s?.agent === 'codex' && s.frontUsage) return s.frontUsage;
    if (!s || !okAgentSid(s.agent, s.agentSid) || !s.started) return null;
    if (s.agent === 'harness') return s.hUsage && s.hUsage.total ? s.hUsage : null;
    const id = s.agentSid.toLowerCase();
    return s.agent === 'claude' ? claudeUsage(id, s.ctxWin) : s.agent === 'codex' ? codexUsage(id, s.workspace ? path.join(s.workspace.home,'.codex') : undefined) : null;
  } catch { return null; }
}

/* ---------- 对外的 op ---------- */
// 开一轮：记下这一轮要给 AI 的话，历史里放 userEv（用户看到的那句），在后台起 runner
function launch(s, m, userEv) {
  memoryActivity(); // All foreground/background work preempts an in-flight idle review.
  const run = rid('r');
  writeJ(metaF(run), Object.assign({ run, sid: s.sid, agent: s.agent, started: Date.now() }, m));
  if(userEv)emit(run, userEv);
  s.runs.push(run); s.updated = Date.now(); if(isTask(s))saveTask(s);else writeJ(sessF(s.sid),s);
  rememberAgentSession(s.agent, s.agentSid);
  journal.enqueueLaunch(run,s.sid,m.kind==='handoff'?1:m.kind==='daily'?2:0);
  journal.defer(dispatchLaunches);
  journal.defer(ensureWatchdog);
  return run;
}
function dispatchLaunches(){
  if(journal.active)return;
  for(const job of process.env.XIN_LOCK?[]:journal.launchedRuns()){
    const m=readJ(metaF(job.run));if(!m||m.ended){journal.finishLaunch(job.run);continue;}
    if(alive(m.pid,m.identity)||Date.now()-Math.max(m.started,job.dispatchedAt||0)<15000)continue;
    if(!m.task&&m.agent==='codex'&&!m.stopped&&job.attempts<2){startRunner(job.run);journal.dispatched(job.run);}
    else if(runDone(job.run))journal.finishLaunch(job.run);
  }
  for(const job of journal.pendingLaunches()){
    const meta=readJ(metaF(job.run));if(!meta||meta.ended){journal.finishLaunch(job.run);continue;}
    if(alive(meta.pid,meta.identity)){journal.dispatched(job.run);continue;}
    const own=readJ(sessF(job.sid));
    // Only the latest turns can still be running; a long-lived conversation must not re-read its whole history here.
    const earlier=(own?.runs||[]).slice(-4).filter(r=>r!==job.run).some(r=>{const m=readJ(metaF(r));return m&&!runDone(r)&&alive(m.pid,m.identity);});
    if(earlier)continue;
    startRunner(job.run);journal.dispatched(job.run);
  }
}
function startRunner(run){
  // The per-run lifetime lock prevents a crash/retry between spawn and receipt from executing twice.
  mk(path.join(BASE,'locks'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'XIN_RUN' && k !== 'XIN_LOCK' && !/^CODEX_(?!HOME$)/.test(k)));
  const child = spawn('flock', ['-n','--close',path.join(BASE,'locks',run+'.lock'),process.execPath, SELF, 'run', run], { detached: true, stdio: 'ignore', cwd: os.homedir(), env });
  child.on('error',()=>{emit(run,{t:'err',text:'执行进程未能启动，已保留输入'});patchRun(run,{died:true,ended:Date.now()});journal.finishLaunch(run);});
  child.unref();
}
function lastRun(s) { return s && s.runs && s.runs.length ? s.runs[s.runs.length - 1] : null; }
function runDone(run) {
  const m = readJ(metaF(run));
  if (m && m.ended) return true;
  // done 总是最后一条：只看文件尾巴（后台任务的记录可能很长）
  if (readTail(runF(run), 8192).includes('"t":"done"')) return true;
  // 后台进程没了却没写 done（云电脑重启、被杀）：补一条，记下是断掉的（后台任务据此决定要不要接着做）
  if (m && Date.now() - m.started > (Number(process.env.XIN_DEAD_MS) || 15000) && !alive(m.pid, m.identity)) {
    if(!m.task&&m.agent==='codex'&&!m.stopped){
      const job=journal.launchRecord(run);
      if(job&&job.state!=='finished'&&(job.attempts<2||Date.now()-job.dispatchedAt<15000)){
        if(!journal.active&&!process.env.XIN_LOCK)dispatchLaunches();return false;
      }
    }
    if(m.childPid && processGroupMembers(m.childPid,m.childIdentity).length){
      signalProcessGroup(m.childPid,m.childIdentity,m.orphanStopping && Date.now()-m.orphanStopping>2000?'SIGKILL':'SIGTERM');
      if(!m.orphanStopping)patchRun(run,{orphanStopping:Date.now()});
      if(processGroupMembers(m.childPid,m.childIdentity).length) return false;
    }
    emit(run, { t: 'err', text: '这一轮中途断了（云电脑重启或进程被杀）' });
    emit(run, { t: 'done', ok: false, code: -1, ms: Date.now() - m.started });
    patchRun(run,{died:true,ended:Date.now()});
    return true;
  }
  return false;
}
function summary(s) {
  const r = lastRun(s);
  return { sid: s.sid, agent: s.agent, title: s.title, created: s.created, updated: s.updated, turns: (s.runs || []).length, active: r && !runDone(r) ? r : null, archived: !!s.archived, model: s.model || null, ...(s.main ? { main: true } : {}) };
}
// 主对话：一直聊下去的那一个（默认模式），所有设备共用。别的对话照常新建。归档后它变回普通对话，下一句再开一个新的主对话。
const MAIN_F = () => path.join(BASE, 'main.json');
export function mainSid() {
  const m = readJ(MAIN_F()), s = m && okId(m.sid, 's') ? readJ(sessF(m.sid)) : null;
  return s && s.main && !s.archived && s.agent === 'codex' && !isTask(s) ? s.sid : null;
}

/* ---------- 后台任务（分身） ----------
   默认模式下，前台的小芯（用户直接聊的那个）遇到要花时间的活，用 `xin task new …` 派一个分身在后台干，马上回用户一句、结束这一轮，
   用户可以接着聊；分身做完，结果先存进任务记录，再交回所属对话：网页上出一张结果卡片、没在看就推送，前台下一句自动带上结果摘要。
   - 任务也是一个「对话」（sessions/<sid>.json，kind:'task'），有自己的 Codex 会话和一轮轮记录，复用 launch / runner / poll / history；
     对话列表里不显示。编号 no 从 1 往上数（用户、前台说「任务 3」）。
   - 状态：queued 排队 → running 在做 → done 做完 / failed 没做成 / stopped 停了；waiting 等用户确认（分身 xin task ask、或中途断了两次）。
   - 调度：同时最多 TASK_MAX 个；同一个项目目录同时只跑一个（不会两个分身改同一份文件）；--after 的等前置任务做完（前置没做成就不开始）。
   - 每个任务一个工作目录（--dir 指定 WORK 里的项目，没指定就 WORK/tasks/编号-标题），默认在 Codex 沙盒里跑：
     只能写项目副本及私有 home/tmp/io；控制目录、长期 key 和宿主进程不映射，REA 按白名单开放。
   - 超时（默认 60 分钟，最多 180）停掉，算没做成。电脑重启、进程被杀：本地 watchdog 与外部 Durable Object alarm 监督，恢复后接着做一次，
     提醒它先查现状、别重复有副作用的事；再断就等用户决定。
   - 所有任务记录的读改写都在同一把锁（tasks）里做；推送在锁外发。 */
const TASK_MAX = Number(process.env.XIN_TASK_MAX) || 2;
const TASK_MIN = 60, TASK_MIN_MAX = 180;
export const TASK_KINDS = ['quick', 'code', 'research', 'hard', 'vision', 'review'];
export const TASK_STATUS = { queued: '排队中', running: '进行中', stopping: '正在停止', waiting: '等你确认', done: '做完了', failed: '没做成', stopped: '已停止' };
const TASKS_DIR = () => path.join(WORK, 'tasks');
const TASK_SEQ = () => path.join(BASE, 'task-seq.json');
const RESUME_TEXT = '（刚才电脑暂停或重启，这一轮中途断了。先检查现在的状态——看看文件、编译结果、还在不在跑的进程——已经做过的有副作用的事别再做一遍，然后接着把任务做完。）';
const isTask = s => !!s && s.kind === 'task';
const isBackground = t => ['queued','running','stopping'].includes(t.status) || t.status==='waiting' && !!t.approval;
const isFinished = t => t.status === 'done' || t.status === 'failed' || t.status === 'stopped';
function cleanupFinishedTask(t){
  if(!isFinished(t))return;
  try{t.temporaryCleaned=runtime.cleanupTaskTemporary(t);}
  catch(e){t.cleanupError=e.message;if(t.result)t.result.text+='\n临时文件未能清理：'+e.message;}
}
function occupiesTask(t) {
  if (t.status === 'running' || t.status === 'stopping') return true;
  const r = lastRun(t);
  return t.status === 'waiting' && r && !runDone(r);
}
function taskIndexEntry(t){
  if(!isFinished(t))return t;
  const out={};for(const k of ['sid','no','parent','kind','tkind','title','model','requestedModel','requestedNamed','strictModel','actualModel','actualModels','reviewAuthors','why','status','created','updated','startedAt','endedAt','dir','after','frontSeen','question','note','verification','dailyDate','web','preview','stage','frontRun','processesCleaned','temporaryCleaned','delivery','autoContinues'])if(t[k]!==undefined)out[k]=t[k];
  out.runs=lastRun(t)?[lastRun(t)]:[];out.turnsCount=t.turnsCount??(t.runs||[]).length;
  if(t.result)out.result={...t.result,text:cut(t.result.text,2000)};return out;
}
const taskLockHeld = () => process.argv[2]==='locked' && process.env.XIN_LOCK==='tasks';
function listTasks() {
  const index=path.join(BASE,'tasks-index.json'),cached=readJ(index);
  if(cached?.version===3 && Array.isArray(cached.tasks)) return cached.tasks.sort((a,b)=>a.no-b.no);
  if(!taskLockHeld()){lockedCall('tasks','task_index',{});const fresh=readJ(index);if(fresh?.version===3&&Array.isArray(fresh.tasks))return fresh.tasks.sort((a,b)=>a.no-b.no);}
  let names=[];try{names=fs.readdirSync(SESS);}catch{return [];}
  names=[...new Set(names.concat(journal.stagedNames('sessions/').map(n=>n.slice('sessions/'.length))))];
  const all=names.filter(f=>/^s[0-9a-z]+\.json$/.test(f)).map(f=>readJ(path.join(SESS,f))).filter(isTask).sort((a,b)=>a.no-b.no);
  if(taskLockHeld()) {try{writeJ(index,{version:3,tasks:all.map(taskIndexEntry)});}catch{}}
  return all;
}
function findTask(a, all) {
  all = all || listTasks();
  if (a && okId(a.sid, 's')) { const t=readJ(sessF(a.sid));return isTask(t)?t:null; }
  const no = Number(a && a.no);
  const t=Number.isInteger(no)&&no>0?all.find(t=>t.no===no):null;return t?readJ(sessF(t.sid),t):null;
}
function saveTask(t) {
  t.updated = Date.now(); mk(SESS); writeJ(sessF(t.sid), t);
  if(t.parent&&['done','failed','waiting'].includes(t.status)&&!t.pendingQuestion&&t.result){
    const parent=readJ(sessF(t.parent));
    if(parent?.agent==='codex'){
      const id=handoffId(t);
      if(t.delivery?.id!==id){t.delivery={id,version:workVersion(t),state:'pending'};writeJ(sessF(t.sid),t);}
      journal.enqueueHandoff({id,parent:t.parent,task:t.sid,version:workVersion(t),payload:{status:t.status,no:t.no}});
      journal.defer(ensureWatchdog);
    }
  }
  try {
    const index = path.join(BASE, 'tasks-index.json'), all = readJ(index);
    if(all?.version===3 && Array.isArray(all.tasks)) writeJ(index,{version:3,tasks:all.tasks.filter(x=>x.sid!==t.sid).concat(taskIndexEntry(t))});
    else if(taskLockHeld()) listTasks();
  } catch { /* next read rebuilds the index from durable records */ }
  queueControllerEvent();
}
function rememberCallback(callback) {
  if (!callback || !/^https:\/\//.test(callback.url || '') || !/^[a-zA-Z0-9_-]{43}$/.test(callback.token || '')) return;
  const u = new URL(callback.url);
  if (u.pathname !== '/api/xin/task-event') return;
  mk(BASE); writeJ(path.join(BASE, 'callback.json'), { url: u.href, token: callback.token });
}
function queueControllerEvent() {
  const callback = readJ(path.join(BASE, 'callback.json'));
  if (!callback) return;
  const bg = listTasks().filter(isBackground).length+journal.handoffCount();
  const f = path.join(BASE, 'controller-event.json'), old = readJ(f, {}) || {};
  if (old.bg === bg) return;
  writeJ(f, { bg, version: (old.version || 0) + 1, at: Date.now(), acknowledged: false });
  journal.defer(()=>spawn(process.execPath, [SELF, 'callback'], { detached: true, stdio: 'ignore', cwd: os.homedir() }).unref());
}
async function flushControllerEvent() {
  const callback = readJ(path.join(BASE, 'callback.json'));
  if (!callback) return;
  for (let n = 0; n < 3; n++) {
    const f = path.join(BASE, 'controller-event.json'), state = readJ(f);
    if (!state || state.acknowledged) return;
    try {
      const r = await fetch(callback.url, { method: 'POST', headers: { authorization: 'Bearer ' + callback.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bg: state.bg, version: state.version }), signal: AbortSignal.timeout(10000) });
      if(r.ok){lockedCall('tasks','controller_ack',{version:state.version});return;}
    } catch { /* keep the event durable; active runners and DO alarms retry */ }
    await new Promise(resolve => setTimeout(resolve, 1500 * (n + 1)));
  }
}
// 文件尾巴里最近的事件（不整份读：后台任务的记录可能很长）
function tailEvents(run, n = 32768) {
  const out = [];
  for (const line of readTail(runF(run), n).split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { /* 读到的第一行可能是半截 */ } }
  return out;
}
// 任务现在在干什么（卡片上一行小字）
function taskActivity(run) {
  const evs = tailEvents(run, 16384);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.t === 'tool') return '在执行：' + bareCmd(e.detail || e.name || '').replace(/\s+/g, ' ').slice(0, 90);
    if (e.t === 'tool_end') return e.ok ? '执行完：' + bareCmd(e.detail || e.name || '').replace(/\s+/g, ' ').slice(0, 80) : '有一步没成功，在想办法';
    if (e.t === 'text') return plainText(e.text, 90);
    if (e.t === 'status' && e.text && !/^Model metadata/i.test(e.text)) return String(e.text).slice(0, 90);
  }
  return '';
}
export function taskSummary(t, full) {
  const r = lastRun(t);
  const out = { sid: t.sid, no: t.no, parent: t.parent || null, title: t.title, kind: t.tkind, model: t.model, why: t.why || '', status: t.status,
    requestedModel:t.requestedModel||null,actualModel:t.actualModel||((t.runs||[]).length?t.model:null),independent:t.tkind==='review'?!!(t.reviewAuthors?.length)&&!t.reviewAuthors.includes(t.actualModel||t.model):undefined,
    created: t.created, startedAt: t.startedAt || 0, endedAt: t.endedAt || 0, dir: t.dir, after: t.after || [], turns: t.turnsCount ?? (t.runs || []).length, question: t.question || '' };
  if (t.status === 'running' && r) out.activity = t.stage==='checking'?'正在检查网页的动画和交互':taskActivity(r);
  if (t.result) out.result = { ok: !!t.result.ok, text: full ? t.result.text : cut(t.result.text, 2000), err: t.result.err || '', at: t.result.at || 0 };
  if (t.inbox && t.inbox.length) out.inbox = t.inbox.length;
  if (t.note) out.note = t.note;
  if (t.approval || t.publication) out.approval = { id: t.approval?.id || 'publish', kind: t.publication ? 'publish' : t.approval?.kind || 'tool' };
  if (t.publication) out.publication = t.publication;
  if (t.verification) out.verification = t.verification;
  if(t.web)out.web=true;
  if(t.strictModel)out.strictModel=true;
  if(t.stage)out.stage=t.stage;
  if(t.preview&&t.preview.run===r)out.preview=t.preview;
  if(t.delivery)out.delivery=t.delivery;
  if(t.web&&isFinished(t))out.cleanup={processesGone:!!t.processesCleaned,tmpCleaned:!!t.temporaryCleaned};
  if (full) out.goal = t.goal;
  return out;
}
// 项目目录：只能在 WORK 里面（软链接指到外面的也不行），不能是 WORK 本身；没指定就 WORK/tasks/编号-标题
function taskDir(no, title, want) {
  const work = path.resolve(WORK);
  let realWork = work; try { realWork = fs.realpathSync(work); } catch { /* 还没建 */ }
  const inside = (p, w) => p.startsWith(w + '/');
  if (want) {
    const p = path.resolve(work, String(want));
    if (!inside(p, work)) return { error: '项目目录要在 ' + work + ' 里面' };
    mk(p);
    let real = p; try { real = fs.realpathSync(p); } catch { /* 刚建 */ }
    if (!inside(real, realWork)) return { error: '项目目录要在 ' + work + ' 里面（软链接指到外面了）' };
    return { dir: real };
  }
  const slug = String(title || '').replace(/[^\w一-龥]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  const p = path.join(TASKS_DIR(), no + (slug ? '-' + slug : ''));
  mk(p);
  const real = fs.realpathSync(p);
  if (!inside(real, realWork)) return { error: '任务目录的软链接指到了工作目录外面' };
  return { dir: real };
}
const overlaps = (a, b) => !!a && !!b && (a === b || a.startsWith(b + '/') || b.startsWith(a + '/'));
// 派任务（在 tasks 锁里）：a = {parent, kind, title, goal, model, named, dir, files, after, minutes}
function taskNew(a) {
  const goal = String(a.goal || '').trim().slice(0, a.frontRun ? TEXT_MAX : 12000);
  if (!goal) return { error: 'empty', msg: '要写清楚让分身做什么（xin task new --title 标题 -- 要求，或者从标准输入给）' };
  const kind = a.daily ? 'daily' : TASK_KINDS.includes(a.kind) ? a.kind : 'code';
  const title = (String(a.title || '').replace(/\s+/g, ' ').trim() || goal.replace(/\s+/g, ' ')).slice(0, 40);
  const all = listTasks();
  const after = [...new Set((Array.isArray(a.after) ? a.after : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  for (const n of after) if (!all.some(t => t.no === n)) return { error: 'no_task', msg: '没有任务 ' + n };
  // 文件：只认 WORK 里的普通文件（用户发来的图片、项目里的文件）
  const files = [];
  for (const f of (Array.isArray(a.files) ? a.files : []).slice(0, 10)) {
    const p = path.resolve(WORK, String(f));
    let real = '', st = null; try { real = fs.realpathSync(p); st = fs.statSync(real); } catch { return { error: 'no_file', msg: '找不到文件：' + f }; }
    let realWork = path.resolve(WORK); try { realWork = fs.realpathSync(realWork); } catch { /* 没建 */ }
    if (!real.startsWith(realWork + '/') || !st.isFile()) return { error: 'bad_file', msg: '文件要在 ' + WORK + ' 里面：' + f };
    files.push({ path: p, name: path.basename(p), size: st.size, image: IMG_RE.test(p) });
  }
  // 检查别的任务：避开被检查的那个模型（换个模型看，才看得出问题）
  const avoid = kind === 'review' ? authorModels(after.map(n=>all.find(t=>t.no===n)).filter(d=>d?.status==='done')) : [];
  const agyState=readJ(path.join(BASE,'antigravity-quota.json'),{}),images=files.some(f=>f.image);
  const preferAgy=!a.named&&!a.daily&&!images&&(kind==='quick'||kind==='research'||kind==='code'&&a.web)&&runtime.antigravityBinary()&&(!agyState.blocked||Date.now()>=agyState.retryAt);
  const rt = route({ kind: images ? (kind === 'review' ? 'review' : 'vision') : kind, want: preferAgy?runtime.AGY_MODEL:a.model||null, named: !!a.named, images, avoid });
  if(rt.error)return {error:rt.error,msg:rt.note};
  const seq = (readJ(TASK_SEQ(), {}) || {}).n || all.reduce((m, t) => Math.max(m, t.no || 0), 0);
  const no = seq + 1;
  if (a.daily) mk(WORK);
  const d = a.daily ? { dir: WORK } : taskDir(no, title, a.dir);
  if (d.error) return { error: 'bad_dir', msg: d.error };
  writeJ(TASK_SEQ(), { n: no });
  const minutes = Math.min(TASK_MIN_MAX, Math.max(5, Math.round(Number(a.minutes) || TASK_MIN)));
  const t = { sid: rid('s'), kind: 'task', no, parent: okId(a.parent, 's') ? a.parent : null, agent: 'codex', title, goal, userRequest:String(a.userRequest||'').slice(0,TEXT_MAX), tkind: kind,
    model: rt.model, requestedModel:a.model||null,requestedNamed:!!a.named,actualModel:null,actualModels:[],reviewAuthors:[],why: rt.why, fallbacks: rt.fallbacks, note: rt.note || '', files, dir: d.dir, after, minutes,
    plugins: [...new Set((a.plugins || []).filter(n => n === 'rea' && mcpUser().has(n)))], dailyDate: a.daily ? today() : null,
    frontRun:a.frontRun||null,web:!!a.web,strictModel:!!a.strictModel&&rt.model!==runtime.AGY_MODEL,status: 'queued', created: Date.now(), updated: Date.now(), runs: [], agentSid: null, started: false, resumes: 0, inbox: [] };
  if(t.strictModel)t.fallbacks=[];
  saveTask(t);
  memoryActivity();
  if (a.daily) writeJ(DAILY_LAST(), { date: t.dailyDate, run: null, sid: t.sid, at: Date.now(), ok: null, status: 'queued' });
  scheduleNow();
  ensureWatchdog();
  return { task: taskSummary(readJ(sessF(t.sid)) || t) };
}
// 第一轮给分身的话：任务要求、前置任务的结果、用户给的文件
function taskFirstText(t, deps) {
  const parts = ['【后台任务 ' + t.no + '：' + t.title + '】', t.goal];
  if(t.frontRun) parts.push('上面的要求是用户原话。标题只作标识，不是新增需求；用户没指定的造型、配色、技术栈和交互由你自行决定。原话里的派工、指定模型和要求前台立即回复等安排已经由控制器处理，不要重复派活。');
  if(t.userRequest && t.userRequest!==t.goal) parts.push('【用户原话，独立核对前台转述是否准确；具体技术结论以官方手册为准】\n'+t.userRequest);
  for (const d of deps) {
    parts.push('\n【任务 ' + d.no + '「' + d.title + '」的结果（' + (TASK_STATUS[d.status] || d.status) + '，它的工作目录 ' + d.dir + '）】\n' + cut(d.result ? d.result.text : '', 6000));
  }
  if (t.tkind === 'review' && deps.length) parts.push('\n你的活是检查上面这些结果：在你自己的项目副本里看实际文件、能编译的编译一遍、能跑的跑一遍，看对不对、有没有漏。小问题直接改好并说明改了什么；大问题写清楚，别大改。' +
    '要求里的说法本身也可能有错，以芯片参考手册、数据手册为准。STM32 的程序重点核对：时钟是不是真的配到了代码假设的频率；引脚用的复用功能、要不要重映射（AFIO_MAPR，对照数据手册的引脚复用表）；外设和 GPIO 的时钟开没开；中断向量、优先级和标志清除。');
  if (t.tkind === 'review') parts.push('STM32 工程必须在最终改动后成功执行 make 或 CMake 构建；多个入口时在根目录 xin-build.json 指定 system、directory，可用 artifacts 指定相对根目录的产物路径。并写 xin-review.json：{"verdict":"pass","checks":[{"id":"clock","status":"pass","reference":"RM0008 的具体章节或寄存器","evidence":"源码文件:行号，以及实际配置和推导"}]}。checks 必须覆盖 clock、pinmap、peripheral_clock、interrupt；不涉及的项用 not_applicable，并说明依据。没有上板就明确写未上板验证，不得把编译通过说成硬件测试通过。');
  const f = filesPart(t.files || [], 'codex', codexModel(t.model).image);
  return forAgent(parts.join('\n'), '') + f;
}
function startTask(t, all) {
  const deps = (t.after || []).map(n => all.find(x => x.no === n)).filter(Boolean);
  const first = !(t.runs && t.runs.length);
  delete t.verification;
  t.deadline = t.deadline || Date.now() + (Number(process.env.XIN_TASK_TIMEOUT_MS) || (t.minutes || TASK_MIN) * 60e3);
  // The author might have fallen back to a different model after the review was queued.
  if (t.tkind === 'review') {
    t.reviewAuthors=[...new Set((first?[]:t.reviewAuthors||[]).concat(authorModels(deps)))];
    if(deps.some(d=>!authorModels([d]).length)){t.status='waiting';t.question='作者实际模型未知，不能验证独立复核，请补全作者信息。';saveTask(t);return false;}
    const rt = route({ kind: 'review',want:t.requestedModel||(t.why==='named'?t.model:null),named:t.requestedNamed??t.why==='named', images: (t.files || []).some(f => f.image), avoid:t.reviewAuthors });
    if(rt.error){t.status='waiting';t.question=rt.note;t.endedAt=Date.now();t.frontSeen=false;saveTask(t);return false;}
    t.model = rt.model; t.fallbacks = t.strictModel?[]:rt.fallbacks; t.why = rt.why;
  }
  // 项目副本和任务自己的会话都在系统临时目录里；电脑重启后它们可能已经没了（审查问题 16）。
  // 这时副本会按原项目重新拷一份，旧会话也续接不上：不再续接，开新会话，并把原要求和现状说清楚，而不是直接算没做成。
  const lost = !first && !t.dailyDate && !!t.workspace && !fs.existsSync(t.workspace.work);
  try { if (!t.dailyDate) t.workspace = runtime.prepareWorkspace(t, BASE); }
  catch (e) { failTask(t, '没有启动任务：' + e.message); return false; }
  if (lost) { t.agentSid = null; t.started = false; delete t.antigravityConversation; }
  const text = first ? t.dailyDate ? forAgent(t.goal, '') : taskFirstText(t, deps)
    : lost ? forAgent('电脑重启过，上一轮的项目副本和过程记录都没了，现在的目录是按原项目重新拷贝的。原来的要求：\n' + cut(t.goal || '', 10000) + '\n先看看现在的文件，再接着做' + (t.next ? '：' + t.next : '。'), '')
    : forAgent(t.next || '接着做。', '');
  const userText = first ? t.goal : String(t.nextShow || t.next || '接着做');
  const cm = codexModel(t.model);
  Object.assign(t, { status: 'running',stage:'working',actualModel:t.model,question: '', next: null, nextShow: null, startedAt: t.startedAt || Date.now() });
  const run = launch(t, { text, effort: t.model===runtime.AGY_MODEL?'high':AUTO_EFFORT, kind: t.dailyDate ? 'daily' : 'task', routeKind: t.tkind, task: true, no: t.no, model: t.model, why: t.why, fallbacks: first||t.model===runtime.AGY_MODEL ? t.fallbacks || [] : [],
    images: first && cm.image ? (t.files || []).filter(f => f.image).map(f => f.path) : [], cwd: t.workspace?.work || WORK, sandbox: !t.dailyDate && TASK_SANDBOX(),
    deadline: t.deadline }, { t: 'user', text: userText, at: Date.now() });
  if (t.dailyDate) writeJ(DAILY_LAST(), { date: t.dailyDate, run, sid: t.sid, at: Date.now(), ok: null });
}
function failTask(t, why) {
  Object.assign(t, { status: 'failed', result: { ok: false, text: why, at: Date.now() }, endedAt: Date.now(), frontSeen: false });
  saveTask(t);
}
// 排队的能开始就开始（在 tasks 锁里）
function scheduleNow() {
  const all = listTasks();
  let running = all.filter(occupiesTask).length;
  for (const t of all.filter(t => t.status === 'queued').sort((a, b) => (a.queuedAt || a.created) - (b.queuedAt || b.created))) {
    if (running >= TASK_MAX) break;
    const deps = (t.after || []).map(n => all.find(x => x.no === n));
    const bad = deps.filter(d => !d || d.status === 'failed' || d.status === 'stopped');
    if (bad.length) { failTask(t, '前置任务' + bad.map(d => d ? ' ' + d.no : '').join('、') + ' 没做成，这个任务没开始。'); continue; }
    if (deps.some(d => d.status !== 'done')) continue;
    if (all.some(x => x !== t && occupiesTask(x) && overlaps(x.dir, t.dir))) continue;
    if (startTask(t, all) !== false) running++;
  }
}
const taskPush = (t, title, body) => ({ title, body: plainText(body, 120) || '点开看看', tag: 'xin-task-' + t.no, sid: t.parent || '', url: t.parent ? '/#xin=' + t.parent : '/#xin' });
// 一轮做完（runner 调，在 tasks 锁里）：先把结果存进任务记录，再决定接着做、等用户，还是收尾；要推送的交回 runner 在锁外发
function taskFinish(a) {
  const t = readJ(sessF(a.sid));
  // A late exit from a cancelled/replaced turn must never complete the new turn.
  if (!isTask(t) || lastRun(t) !== a.run || t.finishedRun === a.run || (t.status !== 'running' && t.status !== 'waiting' && t.status !== 'stopping')) return {};
  const evs = tailEvents(a.run, 65536);
  const runMeta = readJ(metaF(a.run), {});
  // Successful publication must never outlive a still-running producer.
  if(t.web&&runMeta.childPid&&processGroupMembers(runMeta.childPid,runMeta.childIdentity).length)return {error:'cleanup_pending'};
  if(t.web)t.processesCleaned=true;
  const actual=a.model||runMeta.model||t.actualModel||t.model;
  if(actual){t.model=t.actualModel=actual;t.actualModels=[...new Set((t.actualModels||[]).concat(actual))];}
  if (a.timeout || a.died || a.stopped) delete t.approval;
  const pending = (runMeta.steers || []).filter(x => x.state === 'pending' || x.state === 'next');
  if (pending.length) t.inbox = (t.inbox || []).concat(pending.map(x => ({ text: x.text, at: x.at })));
  const last = evs.filter(e => e.t === 'text').pop(), err = evs.filter(e => e.t === 'err').pop();
  let notify = null;
  if (t.status === 'stopping') { t.status = 'stopped'; t.endedAt = Date.now(); }                  // 进程真正退出后才释放目录
  else if ((t.status === 'waiting' || t.pendingQuestion) && !a.died && !a.timeout && !a.stopped) {
    t.status='waiting';t.question=t.pendingQuestion||t.question;delete t.pendingQuestion;
    Object.assign(t,{endedAt:Date.now(),frontSeen:false});notify=taskPush(t,'我这边需要你确认：'+t.title,t.question);
  }
  else if (!a.stopped && !a.timeout && !a.died && t.inbox && t.inbox.length) {                  // 干活时用户补充了话：接着做
    t.next = '用户在你干活时补充了：\n' + t.inbox.map(x => '- ' + x.text).join('\n') + '\n按补充的要求接着做（已经做对的不用重做）。';
    t.nextShow = t.inbox.map(x => x.text).join('\n');
    Object.assign(t, { inbox: [], status: 'queued', queuedAt: Date.now() });
  } else if (a.died) {                                                                              // 电脑重启、进程被杀
    if ((t.resumes || 0) < 1) Object.assign(t, { resumes: (t.resumes || 0) + 1, next: RESUME_TEXT, nextShow: '（中途断了，接着做）', status: 'queued', queuedAt: Date.now() });
    else {
      Object.assign(t, { status: 'waiting', question: '这个任务中途断了两次（电脑暂停或重启），要接着做吗？', endedAt: Date.now(), frontSeen: false });
      notify = taskPush(t, '我这边中途断了：' + t.title, t.question);
    }
  } else {
    let ok = !!a.ok && !a.stopped && !a.timeout;
    let publication = null;
    if (ok && t.workspace) {
      try {
        if(t.web&&(!runMeta.webCheck?.trusted||!runMeta.webCheck.ok)){
          const error='网页尚未通过实际浏览器检查：'+(runMeta.webCheck?.error||'缺少检查记录')+'。请修好自包含 HTML 和 xin-web.json 后结束，控制器会重新检查。';
          if((t.webRetries||0)<2){t.webRetries=(t.webRetries||0)+1;t.status='queued';t.stage='working';t.next=error;t.nextShow='（修正网页交互检查）';t.finishedRun=a.run;saveTask(t);scheduleNow();return {};}
          throw Error(error);
        }
        const verification = runtime.validateTask(t, BASE, runMeta);
        if (verification.error) {
          if ((t.validationRetries || 0) < 1) {
            t.validationRetries = (t.validationRetries || 0) + 1; t.status = 'queued'; t.next = verification.error;
            t.nextShow = '（补齐编译或检查证据）'; t.finishedRun = a.run; saveTask(t); scheduleNow(); return {};
          }
          throw new Error(verification.error);
        }
        if (verification.applicable) t.verification = verification;
        publication = runtime.publishWorkspace(t, BASE);
        if(t.web&&!publication.pending)t.preview=runtime.publishWebPreview(t,BASE,runMeta.webCheck);
      }
      catch (e) { ok = false; t.publicationError = e.message; }
    }
    t.status = a.stopped ? 'stopped' : ok ? 'done' : 'failed';
    const answer = ((last && last.text) || (a.timeout ? '超过 ' + t.minutes + ' 分钟还没做完，停下了。' : ok ? '做完了。' : '没做成。'));
    t.result = { ok, text: cut(t.workspace ? answer.split(t.workspace.work).join(t.dir) : answer, 8000),
      err: ok ? '' : String(t.publicationError || (a.timeout ? '超时（' + t.minutes + ' 分钟）' : (err && err.text) || '')).slice(0, 600), at: Date.now() };
    if(t.web){t.result.internalText=t.result.text;t.result.internalError=t.result.err;t.result.err='';t.result.text=ok&&t.preview?.run===a.run?'我画好了，点下面的预览就能看。':a.stopped?'好，我停下了。':'这次还没完成，成品尚未通过检查。我保留了进度，可以继续处理。';}
    if (publication?.pending) {
      t.status = 'waiting'; t.publication = publication;
      t.question = '结果还未写回项目：' + (publication.deleted.length ? '将删除 ' + publication.deleted.length + ' 个原文件；' : '') +
        (publication.conflicts.length ? publication.conflicts.length + ' 个文件在任务期间被改过；' : '') + '允许这次写回吗？';
      t.result.ok = false;
    } else if (publication?.ok) t.publicationReceipt = publication;
    Object.assign(t, { endedAt: Date.now(), frontSeen: false });
    if(t.web&&ok&&t.preview?.ready)t.stage='ready';
    if (!a.stopped) notify = taskPush(t, (ok ? '我弄好了：' : '我没做成：') + t.title, t.result.text);
  }
  t.finishedRun = a.run;
  cleanupFinishedTask(t);
  if (t.dailyDate && isFinished(t)) dailyDone(a.run, { sid: t.sid, dailyDate: t.dailyDate }, t.status === 'done');
  saveTask(t);
  const notice = notify&&t.delivery?.state!=='pending' ? enqueueNotice(t, notify) : null;
  scheduleNow();
  return notice ? { notice, notify } : {};
}
// 用户（或前台）给任务补充要求：在做就等这一步做完接着做；还没开始就并进要求；做完了、停了、在等确认就接着做
function taskTell(a) {
  const t = findTask(a);
  if (!t) return { error: 'no_task', msg: '找不到这个任务' };
  if (t.approval) {
    if (t.approval.kind !== 'input' && !['approve', 'deny'].includes(a.decision)) return { error: 'needs_decision', msg: '请点「允许这一次」或「拒绝」' };
    if (t.approval.kind === 'input' && !String(a.text || '').trim()) return { error: 'empty', msg: '请回复问题' };
    const r = lastRun(t), m = readJ(metaF(r));
    if (!m || runDone(r)) return { error: 'ended', msg: '这一轮已经结束，不能再批准' };
    m.approvalReplies = { ...(m.approvalReplies || {}), [t.approval.id]: t.approval.kind === 'input' ? String(a.text).slice(0,4000) : a.decision }; writeJ(metaF(r), m);
    delete t.approval; t.question = ''; t.status = 'running'; saveTask(t);
    return { ok: true, msg: a.decision === 'approve' ? '已允许这一次' : '已拒绝', task: taskSummary(t) };
  }
  if (t.publication) {
    if (!['approve', 'deny'].includes(a.decision)) return { error: 'needs_decision', msg: '结果涉及删除或覆盖冲突，请明确选择是否允许' };
    if (a.decision === 'approve') {
      try { t.publicationReceipt = runtime.publishWorkspace(t, BASE, true);if(t.web){t.preview=runtime.publishWebPreview(t,BASE,readJ(metaF(lastRun(t)),{}).webCheck);t.result.text='我画好了，点下面的预览就能看。';t.stage='ready';} }
      catch (e) { return { error: 'conflict', msg: e.message }; }
      t.status = 'done'; t.result.ok = true;
    } else { t.status = 'stopped'; t.result.ok = false; t.result.text += '\n原项目未更改，任务副本保留。'; }
    delete t.publication; t.question = ''; t.endedAt = Date.now(); t.result.at = Date.now(); t.frontSeen = false; cleanupFinishedTask(t);saveTask(t); scheduleNow();
    return { ok: true, msg: a.decision === 'approve' ? '结果已写回' : '已保留原文件', task: taskSummary(t) };
  }
  if(t.status==='stopping')return {error:'busy',msg:'任务正在停止，退出后再继续'};
  const text = String(a.text || '').trim().slice(0, 4000) || '接着做';
  if(t.tkind==='review'&&t.status==='waiting'){const requested=namedModel(text);if(requested){t.requestedModel=requested;t.requestedNamed=true;}}
  if (t.status === 'running') {
    const r = lastRun(t), m = r && readJ(metaF(r));
    if (m?.transport === 'app-server' && !t.pendingQuestion) {
      m.steers = (m.steers || []).concat([{ id: a.clientId || rid('u'), text, at: Date.now(), state: 'pending' }]);
      writeJ(metaF(r), m);
      return { ok: true, msg: '已送入当前任务', task: taskSummary(t) };
    }
    t.inbox = (t.inbox || []).concat([{ text, at: Date.now() }]);
    if(t.pendingQuestion){delete t.pendingQuestion;t.question='';}
    saveTask(t);
    return { ok: true, msg: '记下了：任务 ' + t.no + ' 这一步做完就按你说的接着做', task: taskSummary(t) };
  }
  if (t.status === 'queued' && !(t.runs && t.runs.length)) {
    t.goal += '\n补充：' + text; saveTask(t);
    return { ok: true, msg: '任务 ' + t.no + ' 还没开始，补充的要求并进去了', task: taskSummary(t) };
  }
  if (t.status === 'queued') { t.next = (t.next ? t.next + '\n' : '') + '用户又说：' + text; t.nextShow = (t.nextShow ? t.nextShow + '\n' : '') + text; saveTask(t); return { ok: true, msg: '记下了', task: taskSummary(t) }; }
  const waiting = t.status === 'waiting', interrupted = waiting && /中途断了/.test(t.question || '');
  if (isFinished(t)) { if(t.status==='done') { t.workspace = null; t.started = false; t.agentSid = null; } t.deadline = null; t.validationRetries = 0; delete t.publicationError; }
  const active = lastRun(t);
  if (active && !runDone(active)) {
    t.inbox = (t.inbox || []).concat([{ text, at: Date.now() }]);
    if(t.pendingQuestion||t.status==='waiting'){delete t.pendingQuestion;t.question='';t.status='running';}
    saveTask(t);
    return { ok: true, msg: '已收到，当前进程退出后接着做', task: taskSummary(t) };
  }
  Object.assign(t, { next: (waiting ? '用户回复：' : '用户又说：') + text + (waiting && t.question ? '\n（你之前问的是：' + t.question + '）' : ''), nextShow: text,
    status: 'queued', queuedAt: Date.now(), question: '', frontSeen: true });
  if (waiting) t.deadline = null;
  if (interrupted) t.resumes = 0;
  saveTask(t);
  scheduleNow();
  return { ok: true, msg: '任务 ' + t.no + ' 接着做了', task: taskSummary(readJ(sessF(t.sid)) || t) };
}
function taskStop(a) {
  const t = findTask(a);
  if (!t) return { error: 'no_task', msg: '找不到这个任务' };
  if (isFinished(t)) return { ok: true, already: true, task: taskSummary(t) };
  const activeRun = lastRun(t), wasRunning = !!activeRun && !runDone(activeRun);
  delete t.approval; delete t.publication; delete t.pendingQuestion;
  Object.assign(t, { status: wasRunning ? 'stopping' : 'stopped', result: { ok: false, text: wasRunning ? '做到一半被停下了。' : '还没做完就停了。', at: Date.now() }, endedAt: wasRunning ? 0 : Date.now(), inbox: [], frontSeen: false });
  cleanupFinishedTask(t);
  saveTask(t);
  const r = lastRun(t), m = r && readJ(metaF(r));
  if (wasRunning && m && !runDone(r)) { patchRun(r,{stopped:true});journal.defer(()=>signalProcessGroup(m.pid,m.identity,'SIGTERM')); }
  scheduleNow();
  return { ok: true, task: taskSummary(t) };
}
// 分身遇到要用户确认的事：记下问题，这一轮结束后任务停在「等你确认」
function taskAsk(a) {
  const t = findTask(a);
  if (!t) return { error: 'no_task', msg: '找不到这个任务' };
  const q = String(a.question || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!q) return { error: 'empty', msg: '用法：xin task ask 要用户确认的事（一句话说清楚）' };
  // Asking is a transition request. Keep the project occupied until the turn exits.
  Object.assign(t, { pendingQuestion: q, question: q }); saveTask(t);
  return { ok: true };
}
const taskVersion = workVersion;
function taskSeen(a) {
  for (const entry of (Array.isArray(a.sids) ? a.sids : [])) {
    const sid = typeof entry === 'string' ? entry : entry.sid, t = findTask({ sid });
    if (t && !t.frontSeen && (typeof entry === 'string' || entry.version === taskVersion(t))) { t.frontSeen = true; saveTask(t); }
  }
  return { ok: true };
}
// 收拾（在 tasks 锁里）：进程没了的接着做或等用户；做完却没收尾的补上；再排一次队
function taskTick() {
  const out = [];
  for (const t of listTasks().filter(t=>t.status==='running'||t.status==='stopping'||t.status==='waiting'&&t.approval)) {
    const r = lastRun(t), m = r && readJ(metaF(r));
    if (!r || !m || !runDone(r)) continue;
    const m2 = readJ(metaF(r)) || m;
    if (m2.died) { const x = taskFinish({ sid: t.sid, run: r, died: true }); if (x.notice) out.push(x.notice); }
    else if (Date.now() - (m2.ended || 0) > 60e3) {
      const d = tailEvents(r, 8192).filter(e => e.t === 'done').pop() || {};
      const x = taskFinish({ sid: t.sid, run: r, ok: !!d.ok, stopped: !!d.stopped, model: m2.model });
      if (x.notice) out.push(x.notice);
    }
  }
  scheduleNow();
  return { notify: out };
}
// 不在锁里：要不要收拾（有在跑的已经结束、或者排队的可能能开始了）
function taskNeedsTick(all) {
  const running = all.filter(t=>t.status==='running'||t.status==='stopping'||t.status==='waiting'&&t.approval);
  if (running.some(t => { const r = lastRun(t); return !r || runDone(r); })) return true;
  return all.some(t => t.status === 'queued') && running.length < TASK_MAX;
}
function tickTasks() {
  const all = listTasks();
  if (!taskNeedsTick(all)) return;
  const r = lockedCall('tasks', 'task_tick', {});
  for (const n of (r && r.notify) || []) deliverNotice(n).catch(() => {});
}
function ensureWatchdog() {
  if(journal.active){journal.defer(ensureWatchdog);return;}
  // flock lives outside every task's writable roots and is released by the kernel on exit.
  mk(path.join(BASE, 'locks'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'XIN_RUN' && k !== 'XIN_LOCK' && !/^CODEX_(?!HOME$)/.test(k)));
  spawn('flock', ['-n', '--close', path.join(BASE, 'locks/watchdog.lock'), process.execPath, SELF, 'watchdog'],
    { detached: true, stdio: 'ignore', cwd: os.homedir(), env }).unref();
}
function ensureMemoryIdle() {
  if (journal.active) { journal.defer(ensureMemoryIdle); return; }
  if (!(readText(CODEX_KEY()) || readText(HARNESS_KEY())).trim()) return;
  mk(path.join(BASE, 'locks'));
  // Only a local child after real work completes. Never registered as a task, callback, alarm or lease.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'XIN_RUN' && k !== 'XIN_LOCK'));
  const child = spawn('flock', ['-w','3','--close',path.join(BASE,'locks/memory-idle.lock'),process.execPath,SELF,'memory-idle'],
    {detached:true,stdio:'ignore',cwd:os.homedir(),env});
  child.on('error', () => {}); child.unref();
}
/* ---------- 新旧控制器交班（审查问题 20） ----------
   云电脑上的脚本按内容摘要命名，部署一次路径就变一次。网站每次直接调用控制器时记下这次用的是哪一份（controller-current.json）；
   长期运行的 watchdog 每轮看一眼：网站已经在用更新的那份，就起一个新版 watchdog 接班（等这把锁放开），自己退出，
   不再用旧代码和新代码一起改状态库。正在跑的任务轮次照旧用旧代码跑完这一轮。 */
const CURRENT_F = () => path.join(BASE, 'controller-current.json');
function markCurrentController() {
  try {
    if (readJ(CURRENT_F())?.self === SELF) return;
    mk(BASE); const tmp = CURRENT_F() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ self: SELF, at: Date.now() })); fs.renameSync(tmp, CURRENT_F());
  } catch { /* 记不下来就下次 */ }
}
function newerController() {
  const cur = readJ(CURRENT_F());
  // 只认同一个目录里、按摘要命名的控制器入口：这份记录被改成别的路径时不跟着去执行
  const ok = typeof cur?.self === 'string' && cur.self !== SELF && path.dirname(cur.self) === path.dirname(SELF) && /^vm-agent-[a-f0-9]{12}\.mjs$/.test(path.basename(cur.self));
  return ok && fs.existsSync(cur.self) ? cur.self : null;
}
function handOverWatchdog(next) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'XIN_RUN' && k !== 'XIN_LOCK' && !/^CODEX_(?!HOME$)/.test(k)));
  // -w：等这个旧 watchdog 退出、放开锁以后接上
  mk(path.join(BASE, 'locks'));
  spawn('flock', ['-w', '60', '--close', path.join(BASE, 'locks/watchdog.lock'), process.execPath, next, 'watchdog'], { detached: true, stdio: 'ignore', cwd: os.homedir(), env }).unref();
}
async function watchdog() {
  for (;;) {
    const next = newerController();
    if (next) { handOverWatchdog(next); return; }
    try { journal.recover();dispatchLaunches();tickTasks();pumpHandoffs();await flushNotices(); await flushControllerEvent(); } catch { /* transient errors are retried */ }
    const active = listTasks().some(isBackground);
    const pending = readJ(path.join(BASE, 'controller-event.json'));
    const notices=fs.existsSync(NOTICE_DIR()) && fs.readdirSync(NOTICE_DIR()).some(n=>/^[a-f0-9]{32}\.json$/.test(n) && readJ(path.join(NOTICE_DIR(),n))?.state==='pending');
    if (!active && !notices && !journal.hasPendingHandoffs() && !journal.hasOpenLaunches() && (!pending || pending.acknowledged)) return;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
// 网页最近有没有在看这个对话（tasks 轮询会碰一下）：在看就不推送，卡片自己会更新
const convSeenF = sid => path.join(RUNS, 'conv-' + sid + '.seen');
const validDevice = id => typeof id==='string' && /^[A-Za-z0-9_-]{8,80}$/.test(id);
const deviceWatchDir = (sid,id) => path.join(BASE,'presence',sid,id);
function watchDevice(sid,a) {
  if(!okId(sid,'s')||!validDevice(a.deviceId))return;
  const dir=deviceWatchDir(sid,a.deviceId),tab=validDevice(a.tabId)?a.tabId:'legacy',f=path.join(dir,tab+'.seen');
  try{if(a.watching===true){mk(dir);fs.writeFileSync(f,'');}else fs.unlinkSync(f);}catch{}
}
function deviceWatching(sid,id) {
  if(!okId(sid,'s')||!validDevice(id))return false;
  const dir=deviceWatchDir(sid,id);let watching=false;
  try{for(const name of fs.readdirSync(dir)){if(!/^[A-Za-z0-9_-]+\.seen$/.test(name))continue;const f=path.join(dir,name);if(Date.now()-fs.statSync(f).mtimeMs<15000)watching=true;else fs.unlinkSync(f);}}catch{}
  return watching;
}
// 前台下一句带上的后台任务情况：做完 / 没做成 / 停了但前台还不知道的写结果，等确认的写问题，进行中、排队的写一句
export function isWebRequest(text){return /(?:画|绘制|制作|生成|做).{0,24}(?:奶龙|动画|交互|网页|页面|网站)|(?:网页|动画|交互).{0,12}(?:做|制作|生成|画)/i.test(String(text||''))&&!/^(?:什么是|解释|怎么|如何|为什么)/.test(String(text||'').trim());}
function pumpHandoffs(){
  for(const h of journal.dueHandoffs())lockedCall(h.parent,'handoff_start',{id:h.id,sid:h.parent});
}
function handoffStart(a){
  const h=journal.handoff(a.id);if(!h||!['pending','running'].includes(h.state))return {};
  const t=readJ(sessF(h.task)),s=readJ(sessF(h.parent));
  if(!s||s.agent!=='codex'){journal.settleHandoff(h.id,'cancelled');return {};}
  if(!t||taskVersion(t)!==h.version){journal.settleHandoff(h.id,'superseded');return {};}
  if(h.state==='running'){
    if(h.run&&!runDone(h.run))return {};
    journal.retryHandoff(h.id);return {};
  }
  const last=lastRun(s);if(last&&!runDone(last))return {waiting:true};
  if(journal.pendingLaunches().some(j=>j.sid===s.sid&&j.lane===0))return {waiting:true};
  // Repairs are bounded per work item, independent of how often completion is replayed.
  const run=launch(s,{kind:'handoff',handoff:h.id,handoffFallback:h.attempts>=2,model:preferredFrontModel(),why:'completion',effort:AUTO_EFFORT,
    text:handoffPrompt(t,taskNotes(s.sid).text),injected:[{sid:t.sid,version:taskVersion(t)}]},null);
  journal.startHandoff(h.id,run);return {run};
}
function handoffFinish(a){
  const m=readJ(metaF(a.run)),h=m?.handoff&&journal.handoff(m.handoff);
  if(!h||h.state!=='running'||h.run!==a.run||m.stopped)return {terminal:true,text:''};
  const t=readJ(sessF(h.task));
  if(!t||taskVersion(t)!==h.version){journal.settleHandoff(h.id,'superseded');return {terminal:true,text:''};}
  const action=a.action==='silent'?'silent':'delivered';
  if(action==='silent'&&t.status!=='done')return {error:'needs_delivery',msg:'失败或需要确认必须如实告知用户'};
  journal.settleHandoff(h.id,action);
  t.delivery={id:h.id,state:action,version:h.version,run:a.run,at:Date.now()};t.frontSeen=true;
  if(action==='delivered'){
    const text=publicCompletion(t,a.text);t.result={...t.result,text};
    emit(a.run,{t:'text',text,taskResult:{sid:t.sid,at:t.result.at,status:t.status,endedAt:t.endedAt}});
    enqueueNotice(t,taskPush(t,t.status==='done'?'我弄好了：'+t.title:'我这边有个进展：'+t.title,text));
  }
  saveTask(t);return {terminal:true,text:''};
}
export function frontImmediate(a){
  const m=okId(a.run,'r')&&readJ(metaF(a.run));if(!m||m.stopped||m.ended||m.task||m.kind==='daily')return {};
  if(m.reply!==undefined)return {terminal:true,reply:true,text:m.reply};
  const receipt=readJ(path.join(RUNS,a.run+'.front.json'));if(receipt)return receipt;
  const created=listTasks().find(t=>t.parent===m.sid&&t.frontRun===a.run);if(created)return {terminal:true,text:'好，我这就去弄。',task:taskSummary(created)};
  if ((m.frontFiles||[]).some(f=>f.image) && !(m.frontSeesImages ?? !!frontModelInfo(m.model||preferredFrontModel()).image)) {
    // A real capability fallback, independent of whether a text-only model happens to ask for it.
    // frontAction keeps task creation, original attachments, explicit model choice and replay receipts together.
    return frontAction({run:a.run,argv:['xin','task','new','--kind','vision','--title','看图回答',...(m.frontWeb?['--web']:[]),'--',
      '查看用户附的图片，依据实际图片回答或完成原要求，不猜测图片中不可辨认的内容。原始要求：\n'+(m.frontRequest||'看看我发的图片。')]});
  }
  // Natural-language intent and follow-up routing belong to structured inference, not keyword dispatch.
  return {};
}
function frontOriginalRequest(run, meta) {
  const original = events(run).find(e=>e.t==='user');
  return String(original?.text || meta.frontRequest || ((meta.frontFiles||[]).length ?
    meta.frontFiles.every(f=>f.image) ? '看看我发的图片。' : '看看我发的文件。' : '')).trim();
}
export function frontAction(a) {
  const m = okId(a.run,'r') && readJ(metaF(a.run));
  if (!m || m.agent !== 'codex' || m.task || m.kind === 'daily' || m.stopped || m.ended) return {error:'bad_front',msg:'前台轮次不可用'};
  if (!runtime.frontCommand(a.argv, Object.keys(ACTS))) return {error:'请派出去：前台只允许 xin task、remember/recall 和小芯自己的表情、好感度、开场白、动作'};
  const [,act,sub,...rest] = a.argv;
  if(act==='recall'){
    const query=[sub,...rest].join(' ').trim();if(!query)return {error:'请写历史关键词'};
    return recallAll(query);
  }
  const handoff=m.handoff&&journal.handoff(m.handoff);
  if(m.handoff&&(!handoff||handoff.state!=='running'||handoff.run!==a.run||taskVersion(readJ(sessF(handoff.task),{}))!==handoff.version))return {error:'stale',msg:'这份结果已被新的要求替代'};
  if(handoff&&sub==='new')return {error:'continue_original',msg:'完成事件只能继续原工作，不能新建重复工作'};
  if (act === 'task' && sub === 'new') {
    const options = parseTaskArgs(rest);
    if (options.error) return {error:options.error};
    if (options.after.some(no=>!listTasks().some(t=>t.no===no && t.parent===m.sid))) return {error:'前置工作不属于这个对话'};
  }
  if (act !== 'task') { const c = companionCmd(a.argv.slice(1), a.run); return c && c.code === 0 ? { text: c.text } : { error: c ? c.text : '不支持这个操作' }; }
  const mine = listTasks().filter(t=>t.parent === m.sid);
  if (sub === 'list') return {tasks:mine.map(taskSummary),daily:dailyEvidence()};
  const mutation = readJ(path.join(RUNS,a.run+'.front.json'));
  if (mutation) return mutation;
  let r;
  if (sub === 'new') {
    const o = parseTaskArgs(rest);
    if (o.error) return {error:o.error};
    const original = frontOriginalRequest(a.run,m);
    if (!original) return {error:'找不到本轮用户原话，不能替用户编写要求'};
    if (o.kind && !TASK_KINDS.includes(o.kind)) return {error:'未知工作类型：'+o.kind+'（可用：'+TASK_KINDS.join('、')+'）'};
    // A model the user named is recorded from their own words and applied regardless; a loosely written --model must not block dispatch.
    if (o.model && !m.frontNamed && o.model!==runtime.AGY_MODEL && !CODEX_MODELS.some(x=>x.id===o.model)) return {error:'未知模型：'+o.model+'（可用：'+CODEX_MODELS.map(x=>x.id).concat(runtime.AGY_MODEL).join('、')+'）'};
    const previous = mine.find(t=>t.frontRun===a.run);
    if (previous) return {terminal:true,text:'好，我这就去弄。',task:taskSummary(previous)};
    const requested = m.frontNamed || o.model;
    r = taskNew({parent:m.sid,...o,goal:original,web:!!o.web,strictModel:!!m.frontNamed,frontRun:a.run,files:[...new Set([...(o.files||[]),...(m.frontFiles||[]).map(f=>f.path)])],model:requested,named:!!m.frontNamed,userRequest:original});
  } else {
    const t = mine.find(t=>String(t.no)===rest[0]);
    if (!t) return {error:'找不到这个对话里的工作'};
    if (sub === 'show') {
      const run = lastRun(t);
      return {task:taskSummary(t),question:t.question,result:t.result,activity:run ? taskActivity(run) : '',updated:t.updated};
    }
    if(handoff&&sub==='tell'){
      if(t.sid!==handoff.task)return {error:'scope',msg:'完成事件只能继续对应工作'};
      if((t.autoContinues||0)>=2)return {error:'budget',msg:'自动续接预算已用完，请如实汇报结果'};
      t.autoContinues=(t.autoContinues||0)+1;saveTask(t);
    }
    r = sub === 'tell' ? taskTell({no:t.no,text:rest.slice(1).join(' ')}) : taskStop({no:t.no});
  }
  if (r.error) return r;
  if(handoff){journal.settleHandoff(handoff.id,'continued');const result={terminal:true,text:'',task:r.task};writeJ(path.join(RUNS,a.run+'.front.json'),result);return result;}
  if (sub === 'new' && parseTaskArgs(rest).review && r.task.kind !== 'review') {
    const task=r.task;
    const review=taskNew({parent:m.sid,kind:'review',title:('检查：'+task.title).slice(0,40),after:[task.no],dir:task.dir,
      goal:'检查前一步的结果、实际文件和验证证据；按用户原始要求复核：\n'+(events(a.run).find(e=>e.t==='user')||{}).text});
    if (review.task) emit(a.run,{t:'task',...review.task,at:Date.now()});
    else r.reviewError=review.msg||review.error;
  }
  const result = {terminal:true,text:sub === 'stop' ? (r.task?.status==='stopping' ? '好，我正在停下。' : '好，我停下了。') : '好，我这就去弄。',task:r.task,...(r.reviewError?{reviewError:r.reviewError}:{} )};
  if(r.reviewError) result.text+='复核还没安排成功，我需要再确认一下。';
  writeJ(path.join(RUNS,a.run+'.front.json'),result);
  if (r.task) emit(a.run,{t:'task',...r.task,at:Date.now()});
  return result;
}
export function frontFallback(a) {
  const m = readJ(metaF(a.run));
  if (!m || m.stopped || m.ended) return {error:'stopped',msg:'这一轮已经停止'};
  const mutation = readJ(path.join(RUNS,a.run+'.front.json'));
  if (mutation) return mutation;
  if(m.handoff)return handoffFinish({run:a.run,action:'deliver',text:''});
  const active = listTasks().filter(t=>t.parent===m.sid && !isFinished(t));
  // Ambiguous follow-up is not silently applied to an arbitrary running job.
  if (active.length) return {text:'我还在处理之前的事。这句是补充刚才的要求，还是要另外做一件事？'};
  return {error:'front_timeout',msg:'这句话已保存，但我暂时没能安排好，请重试。'};
}
export function taskNotes(sid, all) {
  const mine = (all || listTasks()).filter(t => t.parent === sid);
  const lines = [], seen = [];
  for (const t of mine) {
    const head = '- 任务 ' + t.no + '「' + t.title + '」';
    if (isFinished(t) && !t.frontSeen) { lines.push(head + (TASK_STATUS[t.status] || t.status) + '：' + cut(t.result ? t.result.text : '', 1500).replace(/\n{2,}/g, '\n')+(t.preview?.ready?' 真实预览地址：'+t.preview.url:'')); seen.push({ sid: t.sid, version: taskVersion(t) }); }
    else if (t.status === 'waiting') { lines.push(head + '在等用户确认：' + t.question); if (!t.frontSeen) seen.push({ sid: t.sid, version: taskVersion(t) }); }
    else if (t.status === 'running') lines.push(head + '进行中（' + Math.max(1, Math.round((Date.now() - (t.startedAt || t.created)) / 60e3)) + ' 分钟）');
    else if (t.status === 'queued') lines.push(head + '排队中' + (t.after && t.after.length ? '（等任务 ' + t.after.join('、') + ' 做完）' : ''));
  }
  return { text: lines.length ? '\n\n【后台任务的最新情况（真实快照；只按已知状态第一人称汇报，不猜百分比；要细节用 xin task show 编号，编号和模型不主动展示）】\n' + lines.join('\n') : '', seen };
}
// 网站该不该替电脑续「有活在干」的租约（任务在后台跑，等模型回话时电脑看起来像闲着）：有任务就每 20 分钟续一次，没了就撤
const LEASE_F = () => path.join(BASE, 'tasks-lease.json');
function leaseHint(bg) {
  const l = readJ(LEASE_F(), {}) || {};
  if (bg > 0 && (!l.on || Date.now() - (l.at || 0) > 20 * 60e3)) { mk(BASE); writeJ(LEASE_F(), { on: true, at: Date.now() }); return 'renew'; }
  if (!bg && l.on) { writeJ(LEASE_F(), { on: false, at: Date.now() }); return 'drop'; }
  return null;
}
function bgInfo(all) {
  const state = readJ(path.join(BASE, 'controller-event.json'));
  const bg = (all || listTasks()).filter(isBackground).length+journal.handoffCount();
  const lease = leaseHint(bg);
  const version = state?.version || 0;
  return lease ? { bg, lease, version } : { bg, version };
}
const ops = {
  // 网站发现控制器脚本被改过并已重传（src/xin.js 的 verifyAgent）：记下来
  integrity_event(a){const files=(Array.isArray(a.files)?a.files:[]).filter(f=>/^vm-[a-z0-9-]+\.mjs$/.test(f)).slice(0,32);if(files.length)logLine(INTEGRITY_F(),{files});return {ok:true};},
  // 记忆的可读导出（条目、依据、出处）；整份状态库的每日副本在 exports/
  memory_export(){return {exportedAt:Date.now(),items:listMemory(),types:MEMORY_TYPES,basis:MEMORY_BASIS};},
  learning_report(a){return reportLearning(a);},
  memory_preferences(){return memoryPreferences();},
  memory_preferences_set(a){return setMemoryPreferences(a);},
  preview_asset(a){return runtime.previewAsset(BASE,a);},
  steer(a) {
    if (!okId(a.sid, 's') || !okId(a.run, 'r')) return { error: 'bad_id', msg: '对话或轮次不对' };
    const s = readJ(sessF(a.sid)), m = readJ(metaF(a.run));
    if (!s || !m || m.sid !== a.sid) return { error: 'stale', msg: '这一轮已经变化，请重新打开对话' };
    const text = String(a.text || '').trim().slice(0, 4000), id = /^[a-zA-Z0-9_-]{8,80}$/.test(a.clientId || '') ? a.clientId : rid('u');
    if (!text) return { error: 'empty', msg: '补充消息是空的' };
    if(m.stopped)return {error:'stopped',msg:'这一轮正在停止，请下一轮再发'};
    if((m.steers||[]).length>=128)return {error:'full',msg:'当前轮次补充已满，请等下一轮发送'};
    const existing = (m.steers || []).find(x => x.id === id);
    if (existing) return { ok: true, id, state: existing.state };
    const prior=readJ(path.join(BASE,'messages',id+'.json'));
    if(prior?.sid===a.sid) return {...prior,ok:true,next:true,id};
    if(lastRun(s)!==a.run) return {error:'stale',msg:'这一轮已经变化，请重新打开对话'};
    if (runDone(a.run)) return { ...ops.send({ sid: a.sid, text, clientId:id }), next: true, id };
    m.steers = (m.steers || []).concat([{ id, text, at: Date.now(), state: 'pending' }]); writeJ(metaF(a.run), m);
    memoryActivity();
    emit(a.run, { t: 'user', text, at: Date.now(), steer: true, clientId: id });
    return { ok: true, id, state: 'pending' };
  },
  memory() {
    const text = readMemory();
    return { text, path: MEM_FILE(), size: Buffer.byteLength(text) };
  },
  // 小芯的记忆（vm-memory.mjs）：网页「小芯的记忆」看、加、确认、改、设隐私、忘掉
  memory_list() {
    const items = listMemory().map(it=>({...it,evidence:[...learningEvidence(it.id),...it.evidence].slice(0,3)})), titles = {};
    for (const sid of new Set(items.flatMap(it => it.evidence.map(e => e.sid)).filter(sid => okId(sid, 's')))) {
      const s = readJ(sessF(sid));
      if (s) titles[sid] = isTask(s) ? '后台任务：' + s.title : s.title || '';
    }
    return { items, titles, types: MEMORY_TYPES, basis: MEMORY_BASIS };
  },
  memory_add(a) { const r = addMemory({ content: a.content, type: a.type, source: 'user' }); return r.error ? r : { ok: true, item: r.item, duplicate: !!r.duplicate }; },
  memory_update(a) {
    if (!/^m[0-9a-z]{6,40}$/.test(a.id || '')) return { error: 'bad_id', msg: '记忆编号不对' };
    return updateMemory(a.id, { content: a.content, type: a.type, private: typeof a.private === 'boolean' ? a.private : undefined, confirm: !!a.confirm }, 'user');
  },
  memory_forget(a) {
    if (!/^m[0-9a-z]{6,40}$/.test(a.id || '')) return { error: 'bad_id', msg: '记忆编号不对' };
    return forgetMemory(a.id, 'user');
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
    rememberCallback(a._callback);
    const clientId = /^[a-zA-Z0-9_-]{8,80}$/.test(a.clientId || '') ? a.clientId : null;
    const receipt = clientId ? path.join(BASE, 'messages', clientId + '.json') : null;
    if (receipt) {
      const previous = readJ(receipt);
      if (previous && (!a.sid || previous.sid === a.sid)) return previous;
    }
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
      if (r && !runDone(r)) {
        const current=readJ(metaF(r));
        if(current?.kind!=='handoff')return { error: 'busy', msg: '上一句还没做完，请稍后再试', run: r, sid: s.sid };
        patchRun(r,{stopped:true});journal.defer(()=>signalProcessGroup(current.pid,current.identity,'SIGTERM'));
      }
    } else {
      // No mode named: the default mode, never the fully privileged one. The retired Claude mode only continues old conversations.
      if (a.agent === 'claude') return { error: 'retired', msg: 'Claude 旧模式不再新建对话，以前的对话可以接着聊' };
      const agent = AGENTS.includes(a.agent) ? a.agent : 'codex';
      // 两台设备同时发出主对话的第一句：后到的这一句不再另开一个，让网页打开已有的那个再发
      const main = a.main && agent === 'codex', existing = main ? mainSid() : null;
      if (existing) return { error: 'busy', msg: '请再发一次', sid: existing };
      s = { ...(main ? { main: true } : {}), sid: rid('s'), agent, title: (text || files.map(f => f.name).join('、')).replace(/\s+/g, ' ').slice(0, 40), agentSid: agent === 'claude' ? crypto.randomUUID() : null, started: false, runs: [], created: Date.now(), updated: Date.now() };
    }
    if (s.main && !a.sid) writeJ(MAIN_F(), { sid: s.sid });
    const ctxLabel = String(a.ctxLabel || '').slice(0, 160);
    if (s.agent !== 'harness') try { bondAdd('chat', 1, '陪我聊天'); } catch { /* 好感度记不下来不影响聊天 */ }   // 天启聊天不算小芯的好感
    // 只发了文件没说话：给 AI 的话里补一句
    const said = text || (files.every(f => f.image) ? '看看我发的图片。' : '看看我发的文件。');
    const userEv = { t: 'user', text, at: Date.now() };
    if (ctxLabel) userEv.ctx = ctxLabel;
    if (files.length) userEv.files = files.map(f => ({ name: f.name, path: f.path, size: f.size, image: f.image }));
    // 前台优先 Antigravity Opus；实际额度耗尽才回 DeepSeek。点名只记给后台。
    // Harness（天启模式）按网页选的，续聊没带 model 时保留对话里的选择。
    let rt = null, cm = null;
    if (s.agent === 'codex') {
      rt = { model: preferredFrontModel(), why: 'chat', fallbacks: [] };
      cm = frontModelInfo(rt.model);
    } else if (s.agent === 'harness') cm = harnessModel(a.model || s.model);
    if (cm) s.model = cm.id;
    const effort = s.agent === 'codex' ? AUTO_EFFORT : resolveEffort(s.agent, cm ? cm.id : null, a.effort);
    // 用户点名只指定后台执行模型，前台始终不变
    const hint = s.agent === 'codex' && namedModel(text) ? '\n（本轮已记录用户指定的执行模型，task new 会自动应用；前台不切换。只说好，我来。）' : '';
    // 默认模式：带上这个对话的后台任务情况（做完的结果前台还不知道的、在等确认的、在做的）
    const all = s.agent === 'codex' ? listTasks() : [];
    const tn = s.agent === 'codex' ? taskNotes(s.sid, all) : { text: '', seen: [] };
    const run = launch(s, Object.assign({ frontNamed: s.agent === 'codex' ? namedModel(text) : null, frontRequest:text,context:String(a.context||'').slice(0,12000),frontWeb:isWebRequest(text),frontFiles: files,frontSeesImages:!!(cm && cm.image), text: (s.agent === 'harness' ? withContext(said, a.context) + '\n\n' + TIANQI_REMIND : forAgent(said, a.context)) + filesPart(files, s.agent, !!(cm && cm.image)) + hint + tn.text, effort, images: cm && cm.image ? files.filter(f => f.image).map(f => f.path) : [] },
      cm ? { model: cm.id } : {}, rt ? { why: rt.why, fallbacks: rt.fallbacks } : {}, tn.seen.length ? { injected: tn.seen } : {}), userEv);
    const result = Object.assign({ sid: s.sid, run, agent: s.agent, title: s.title }, s.main ? { main: true, turns: s.runs.length } : {}, cm ? { model: cm.id } : {}, s.agent === 'codex' ? bgInfo(all) : {});
    if (receipt) { mk(path.dirname(receipt)); writeJ(receipt, result); }
    return result;
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
    rememberCallback(a._callback);
    try { pruneLogs(); } catch { /* 清不了不影响每日任务 */ }
    try { tickTasks(); } catch { /* 收拾不了不影响每日任务 */ }
    try { exportState(); } catch { /* 导不出来不影响每日任务，明天再试 */ }
    const list = readText(DAILY_FILE()).trim();
    if (!list) return { skipped: 'empty' };
    const done = readJ(DAILY_DONE());
    if (done && done.date === today() && !a.force) return { skipped: 'done', done };
    const last = readJ(DAILY_LAST());
    if (last && last.run && fs.existsSync(metaF(last.run)) && !runDone(last.run)) return { skipped: 'running', run: last.run, sid: last.sid };
    const existing = listTasks().find(t => t.dailyDate === today() && !isFinished(t));
    if (existing) return { skipped: 'running', sid: existing.sid, run: lastRun(existing) };
    // 每日任务用默认模式（Codex 自动挑模型、思考强度最高）。Harness 是天启模式，用户想用才用：Codex 用不了就报错，不偷偷换成 Harness
    if (!hasAgent('codex')) return { error: 'no_agent', msg: '电脑里没有 codex，每日任务做不了' };
    mk(SESS); mk(RUNS);
    const result = lockedCall('tasks', 'task_new', { daily: true, title: '每日任务 · ' + today().slice(5), goal: dailyPrompt(list), minutes: 180 });
    if (result.error) return result;
    const t = readJ(sessF(result.task.sid));
    return { sid: t.sid, run: lastRun(t), agent: 'codex', model: t.model, ...bgInfo() };
  },
  greet(a={}) {
    flushNotices().catch(() => {});
    const warming = maybeWarm();
    const g = a.agent==='harness'?null:claimNext(Date.now(),validDevice(a.deviceId)?a.deviceId:'legacy');
    let bond = null;
    if(a.agent!=='harness')try { bondAdd('visit', 1, '今天来看我了'); bond = bondInfo(); } catch { /* 记不下来就不带 */ }
    let bg = {};
    try { tickTasks(); bg = bgInfo(); } catch { /* 收拾不了就算了 */ }
    return Object.assign({ warming, bond, moves: readMoves(), main: mainSid() }, bg, g || {});
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
    list.push({ revision:rid('p'), endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, ua: String(a.ua || '').slice(0, 160), ...(validDevice(a.deviceId)?{deviceId:a.deviceId}:{}), at: Date.now() });
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
  plugins(a = {}) {
    if (a.agent === 'harness') return { plugins: harnessPurgeInstalled() ? [{ name: 'purge', desc: '提示词与规则管理，下一句生效', on: pluginState()['harness:purge'] !== false, agent: 'harness' }] : [], merged: [] };
    if (a.agent === 'claude') return { plugins: [], merged: [] };
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
    if (a.agent === 'harness') {
      if (name !== 'purge' || !harnessPurgeInstalled()) return { error: 'no_plugin', msg: '没有这个 Harness 插件：' + name };
      const st = pluginState(); st['harness:purge'] = !!a.on; savePluginState(st);
      return { ok: true, name, on: st['harness:purge'], agent: 'harness' };
    }
    if (a.agent === 'claude') return { error: 'no_plugin', msg: 'Claude 暂未接入插件' };
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
    s.title = title; if(isTask(s))saveTask(s);else writeJ(sessF(a.sid),s);
    return { ok: true, session: summary(s) };
  },
  // 归档：收起来不在「最近的对话」里占地方，记录都留着（AI 自己那份会话记录也不删），随时能取消归档、接着聊
  archive(a) {
    if (!okId(a.sid, 's')) return { error: 'bad_sid', msg: '对话编号不对' };
    const s = readJ(sessF(a.sid));
    if (!s) return { error: 'no_session', msg: '找不到这个对话' };
    if (a.on === false) { delete s.archived; delete s.archivedAt; } else { s.archived = true; s.archivedAt = Date.now(); }
    // 主对话归档 = 重新开始：这一个变回普通对话（记录都在），下一句会开一个新的主对话
    if (s.main && s.archived) { delete s.main; writeJ(MAIN_F(), {}); }
    if(isTask(s))saveTask(s);else writeJ(sessF(a.sid),s);
    return { ok: true, session: summary(s) };
  },
  forget(a) {
    if (!okId(a.sid, 's')) return { error: 'bad_sid', msg: '对话编号不对' };
    const s = readJ(sessF(a.sid));
    if (!s) return { ok: true, already: true };
    if (s.main) return { error: 'main', msg: '这是一直聊的那个对话，不能直接删；想重新开始先归档' };
    const r = lastRun(s);
    if (r && !runDone(r)) return { error: 'busy', msg: '这个对话还在进行中，先停下来再删' };
    if (isTask(s)) return { error: 'bad_sid', msg: '后台任务跟着它的对话一起删' };
    // 这个对话派出去的后台任务还在排队、在做：先停掉再删（等确认的、做完的跟着一起删）
    const busyTasks = listTasks().filter(t => t.parent === a.sid && (occupiesTask(t) || t.status === 'queued'));
    if (busyTasks.length) return { error: 'busy', msg: '这个对话还有后台任务在做（任务 ' + busyTasks.map(t => t.no).join('、') + '），先停掉再删' };
    for (const run of s.runs || []) for (const f of [runF(run), metaF(run), seenF(run), path.join(RUNS,run+'.front.json')]) { try { fs.unlinkSync(f); } catch { /* 本来就没有 */ } }
    fs.unlinkSync(sessF(a.sid));
    journal.dropConversation(a.sid,s.runs||[]);try{fs.unlinkSync(path.join(BASE,'contexts',a.sid+'.json'));}catch{}
    try { fs.unlinkSync(convSeenF(a.sid)); } catch { /* 没有 */ }
    dropConversationTraces(a.sid, s.runs || []);
    // AI 自己那份会话记录也删掉；顺手把别的没有对应对话的旧记录清一清
    let freed = 0, pruned = null;
    try { freed = (lockedCall('tasks', 'task_drop', { parent: a.sid }).bytes || 0); } catch { /* 删不掉就留着 */ }
    try { freed += dropLogs(s.agent, s.agentSid); } catch { /* 删不掉就留着，不影响网站这边 */ }
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
    watchDevice(readJ(metaF(a.run))?.sid,a);
    runDone(a.run); // 进程已死时先把 done 写进记录，再决定这次能不能告诉网页「读完了」
    const evs = events(a.run), off = Math.max(0, a.off | 0);
    const slice = evs.slice(off, off + 400);
    const sid = (readJ(metaF(a.run)) || {}).sid, latest = sid && lastRun(readJ(sessF(sid)));
    // meta.ended 会先于同一笔提交里的回复/done 行落到磁盘（recover 先写文档，再追加 jsonl）。
    // 只看到 ended 就告诉网页读完，网页会停轮询，助手正文永远画不出来。
    const closed = evs.some(e => e && e.t === 'done');
    return { events: slice, off: off + slice.length, done: closed && off + slice.length >= evs.length, ...(latest && latest !== a.run ? { next: latest } : {}) };
  },
  stop(a) {
    if (!okId(a.run, 'r')) return { error: 'bad_run', msg: '编号不对' };
    const m = readJ(metaF(a.run));
    if (!m) return { error: 'no_run', msg: '找不到这一轮' };
    if (runDone(a.run)) return { ok: true, already: true };
    const latest=patchRun(a.run,{stopped:true});if(latest?.ended)return {ok:true,already:true};
    journal.defer(()=>signalProcessGroup(m.pid,m.identity,'SIGTERM'));
    return { ok: true };
  },
  sessions() {
    mk(SESS);
    const list = fs.readdirSync(SESS).filter(f => /^s[0-9a-z]+\.json$/.test(f)).map(f => readJ(path.join(SESS, f))).filter(s => s && !isTask(s));
    list.sort((x, y) => (y.main ? 1 : 0) - (x.main ? 1 : 0) || (y.updated || 0) - (x.updated || 0));
    // 没归档的、归档的各给最近 60 个（归档的多了也不会把正在用的挤出去）
    return { sessions: list.filter(s => !s.archived).slice(0, 60).concat(list.filter(s => s.archived).slice(0, 60)).map(summary) };
  },
  history(a) {
    if (!okId(a.sid, 's')) return { error: 'bad_sid', msg: '对话编号不对' };
    const s = readJ(sessF(a.sid));
    if (!s) return { error: 'no_session', msg: '找不到这个对话' };
    // 一页 30 轮；before：再往前翻（主对话一直聊下去，早先的也要看得到）
    const allRuns = s.runs || [], at = okId(a.before, 'r') ? allRuns.indexOf(a.before) : -1, end = at >= 0 ? at : allRuns.length;
    const runs = allRuns.slice(Math.max(0, end - 30), end);
    // started：每一轮什么时候开始的（后台任务的结果卡片按时间插在这些轮之间）
    const diagnostics=a.diagnose?readText(path.join(BASE,'logs','front.jsonl')).split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}}):[];
    const out = runs.map(r => { runDone(r); const evs=events(r),m=readJ(metaF(r))||{};return {run:r,events:evs,done:evs.some(e=>e&&e.t==='done'),started:m.started||0,...(a.diagnose?{diagnostics:frontDiagnostics(m,evs,diagnostics)}:{})}; });
    const last = out[out.length - 1];
    // active.started：网页重新打开面板时，「思考中 · N 秒」接着算，不从 0 开始
    const res = { session: summary(s), usage: sessionUsage(s), runs: out, more: end > 30, active: at < 0 && last && !last.done ? { run: last.run, off: last.events.length, started: last.started } : null };
    if (isTask(s)) res.task = taskSummary(s, true);                                   // 看一个后台任务的过程
    else if (s.agent === 'codex') res.tasks = listTasks().filter(t => t.parent === s.sid).map(t => taskSummary(t));   // 这个对话派出去的任务
    return res;
  },
  // 后台任务：这个对话的（sid）或者全部的（all），外加所有还没做完的；网页轮询它更新任务卡片，顺便收拾（接着做断掉的、排队）
  tasks(a = {}) {
    try { tickTasks(); } catch { /* 收拾不了就先看现状 */ }
    if(!journal.active){dispatchLaunches();pumpHandoffs();}
    const all = listTasks();
    watchDevice(a.sid,a);
    if (okId(a.sid, 's') && a.watching !== false) { mk(RUNS); try { fs.writeFileSync(convSeenF(a.sid), ''); } catch { /* 记不下来就当没在看 */ } }
    const mine = a.all ? all.slice(-60) : okId(a.sid, 's') ? all.filter(t => t.parent === a.sid) : [];
    const active = all.filter(t => !isFinished(t));
    // 最近 10 分钟结束的（哪个对话的都算）：网页据此知道别的对话里的任务做完了，让小芯冒个气泡
    const recent = all.filter(t => isFinished(t) && (t.endedAt || 0) > Date.now() - 600e3 && !mine.includes(t));
    const out = Object.assign({ tasks: mine.map(t => taskSummary(t)), active: active.map(t => taskSummary(t)), recent: recent.map(t => taskSummary(t)) }, bgInfo(all));
    if (a.all) {
      // 任务中心：各模型最近 14 天用得怎么样、每个任务是哪个对话派的、每日任务做得怎么样
      out.stats = modelStats();
      out.antigravity = readJ(path.join(BASE,'antigravity-quota.json')) || null;
      out.frontAntigravity = readJ(path.join(BASE,'front-antigravity-quota.json')) || null;
      const titles = {};
      for (const t of mine) if (t.parent && !(t.parent in titles)) titles[t.parent] = (readJ(sessF(t.parent)) || {}).title || '';
      out.titles = titles;
      out.daily = { last: readJ(DAILY_LAST()) || null, done: readJ(DAILY_DONE()) || null, today: today() };
      // 最近 7 天：完全放权的对话碰过控制器目录几次、控制器脚本被改过并修复几次（工作台只在不为 0 时提示）
      out.watch = { boundary: recentLines(BOUNDARY_F()).length, integrity: recentLines(INTEGRITY_F()).length };
    }
    return out;
  },
  task_stop(a) { return lockedCall('tasks', 'task_stop', { sid: a.sid, no: a.no,clientId:a.clientId }); },
  task_tell(a) { return lockedCall('tasks', 'task_tell', { sid: a.sid, no: a.no, text: a.text, decision: a.decision,clientId:a.clientId }); }
};
// 只在 tasks 锁里跑的（main 里分派）
const iops = {
  front_model(a){
    const m=readJ(metaF(a.run));if(!m||m.task||m.agent!=='codex'||m.stopped||m.ended||![runtime.FRONT_MODEL,OPUS_FRONT_MODEL].includes(a.model))return {error:'bad_front_model'};
    m.model=a.model;m.providerModel=String(a.providerModel||a.model).slice(0,200);if(['quota','format','front_model'].includes(a.reason))m.from=OPUS_FRONT_MODEL;else delete m.from;writeJ(metaF(a.run),m);
    const s=readJ(sessF(m.sid));if(s){s.model=a.model;writeJ(sessF(m.sid),s);}return {ok:true};
  },
  front_quota(a){
    if(a.quota?.model!==OPUS_FRONT_MODEL||!Array.isArray(a.quota.buckets))return {error:'bad_quota'};
    const f=path.join(BASE,'front-antigravity-quota.json'),old=readJ(f),quota=runtime.mergeAntigravityQuota(old,a.quota);
    writeJ(f,quota);return {quota};
  },
  front_reply(a){const m=readJ(metaF(a.run));if(!m||m.task||m.stopped||m.ended)return {};if(m.reply!==undefined)return {already:true};m.reply=String(a.text||'').slice(0,TEXT_MAX);writeJ(metaF(a.run),m);if(m.reply)emit(a.run,{t:'text',text:m.reply});return {ok:true};},
  handoff_start:handoffStart,handoff_finish:handoffFinish,
  front_immediate:frontImmediate,
  task_stage(a){const t=readJ(sessF(a.sid));if(!isTask(t)||lastRun(t)!==a.run||!['working','checking'].includes(a.stage))return {error:'stale'};t.stage=a.stage;saveTask(t);return {ok:true};},
  task_model(a){const t=readJ(sessF(a.sid));if(!isTask(t)||lastRun(t)!==a.run)return {error:'stale'};if(a.worked&&t.model!==a.model)t.actualModels=[...new Set([...(t.actualModels||[]),t.model])];if(t.model===runtime.AGY_MODEL){t.agentSid=null;t.started=false;}t.model=t.actualModel=a.model;saveTask(t);return {ok:true};},
  agy_quota(a){const f=path.join(BASE,'antigravity-quota.json');writeJ(f,runtime.mergeAntigravityQuota(readJ(f),a.quota));return {ok:true};},
  agy_conversation(a){const t=readJ(sessF(a.sid));if(!isTask(t)||lastRun(t)!==a.run||!UUID_RE.test(a.id||''))return {error:'stale'};t.antigravityConversation=a.id;saveTask(t);return {ok:true};},
  run_stat(a){statAdd(a);return {ok:true};},
  controller_ack(a){const f=path.join(BASE,'controller-event.json'),s=readJ(f);if(s?.version===a.version){s.acknowledged=true;writeJ(f,s);}return {ok:true};},
  run_complete(a){
    const m=readJ(metaF(a.run));if(!m)return {error:'no_run'};
    if(m.ended){const done=tailEvents(a.run).filter(e=>e.t==='done').pop();return {done,already:true};}
    if(!m.task&&!journal.active){
      if(a.stat){const saved=lockedCall('tasks','run_stat',{...a.stat,run:a.run,ok:!!a.done?.ok&&!m.stopped,stopped:!!m.stopped});if(saved.error)return saved;}
      listTasks();return journal.atomic(()=>iops.run_complete({...a,stat:null}));
    }
    const done={...a.done,stopped:!!m.stopped,ok:!!a.done?.ok&&!m.stopped};
    if(a.stat){const stat={...a.stat,run:a.run,ok:done.ok,stopped:done.stopped};const saved=taskLockHeld()?iops.run_stat(stat):lockedCall('tasks','run_stat',stat);if(saved.error)return saved;}
    if(done.ok&&!m.task&&m.injected?.length)journal.defer(()=>lockedCall('tasks','task_seen',{sids:m.injected}));
    emit(a.run,done);m.ended=Date.now();writeJ(metaF(a.run),m);journal.finishLaunch(a.run);
    memoryActivity(); // Count the quiet window from the latest completion as well as the latest input.
    journal.defer(ensureMemoryIdle);
    const pending=(m.steers||[]).filter(x=>x.state==='pending'||x.state==='next');
    if(!m.task&&!done.stopped&&pending.length){
      for(const q of pending)q.state='consumed';writeJ(metaF(a.run),m);
      const next=ops.send({sid:m.sid,text:pending.map(q=>q.text).join('\n'),clientId:pending[0].id});
      return {done,next};
    }
    return {done};
  },
  run_patch(a){if(!okId(a.run,'r'))return {error:'bad_run'};return {meta:applyRunPatch(a.run,a.changes)};},
  task_index(){listTasks();return {ok:true};},
  push_gone(a){writeSubs(readSubs().filter(s=>!(a.endpoints||[]).some(x=>x.endpoint===s.endpoint&&x.revision===(s.revision||String(s.at||'')+JSON.stringify(s.keys)))));return {ok:true};},
  notice_claim(a) {
    if (!/^[a-f0-9]{32}$/.test(a.id || '')) return {};
    const f = path.join(NOTICE_DIR(), a.id + '.json'), n = readJ(f);
    if (!n || n.state !== 'pending' || n.nextAt > Date.now() || n.claimedAt > Date.now()-30000) return {};
    n.claim = rid('n'); n.claimedAt = Date.now(); n.attempts++; writeJ(f,n); return { notice:n };
  },
  notice_done(a) {
    if (!/^[a-f0-9]{32}$/.test(a.id || '')) return {};
    const f = path.join(NOTICE_DIR(), a.id + '.json'), n = readJ(f);
    if (!n || n.claim !== a.claim) return {};
    const results = Array.isArray(a.results) ? a.results : [];
    n.delivered = [...new Set(n.delivered.concat(results.filter(r => r.viewed || r.status >= 200 && r.status < 300 || r.status===404 || r.status===410).map(r => r.recipient)))];
    n.lastStatuses = results.map(r=>r.status); n.claimedAt = 0;
    if (!results.length || results.every(r => r.viewed || r.status >= 200 && r.status < 300 || r.status===404 || r.status===410)) { n.state = 'delivered'; n.deliveredAt = Date.now(); }
    else if (n.attempts >= 8 || Date.now()-n.created > 86400e3) n.state='failed';
    else n.nextAt = Date.now() + Math.min(300000,15000*2**n.attempts);
    writeJ(f,n); return { ok:true };
  },
  continue_steers(a) {
    const s = readJ(sessF(a.sid)), m = readJ(metaF(a.run));
    if (!s || !m || lastRun(s) !== a.run || m.stopped) return {};
    const pending = (m.steers || []).filter(x => x.state === 'pending' || x.state === 'next');
    if (!pending.length) return {};
    // Mark input consumed and start under the conversation lock, so reconnects cannot deliver it twice.
    for (const q of pending) q.state = 'consumed'; writeJ(metaF(a.run), m);
    return ops.send({ sid: a.sid, text: pending.map(x => x.text).join('\n') });
  },
  front_action: frontAction, front_fallback: frontFallback, task_new: taskNew, task_finish: taskFinish, task_tell: taskTell, task_stop: taskStop, task_ask: taskAsk, task_seen: taskSeen, task_tick: taskTick,
  task_approval(a) {
    const t = readJ(sessF(a.sid));
    if (!isTask(t) || lastRun(t) !== a.run || !occupiesTask(t)) return { error: 'stale' };
    t.approval = { id: a.id, method: a.method, kind: a.kind }; t.status = 'waiting'; t.question = a.question; saveTask(t);
    return { ok: true };
  },
  steer_ack(a) {
    const m = readJ(metaF(a.run)); if (!m) return { error: 'no_run' };
    const q = (m.steers || []).find(x => x.id === a.id);
    if (q) { q.state = a.state; if (a.error) q.error = cut(a.error, 200); writeJ(metaF(a.run), m); }
    return { ok: true };
  },
  task_drop(a) {
    let bytes = 0;
    for (const entry of listTasks().filter(x => x.parent === a.parent && !occupiesTask(x) && x.status !== 'queued')) {
      const t=readJ(sessF(entry.sid),entry);
      for (const run of t.runs || []) for (const f of [runF(run), metaF(run), seenF(run), path.join(RUNS,run+'.front.json')]) { try { fs.unlinkSync(f); } catch { /* 本来就没有 */ } }
      try { fs.unlinkSync(sessF(t.sid)); } catch { /* 没有 */ }
      journal.dropConversation(t.sid,t.runs||[]);
      try { bytes += dropLogs('codex', t.agentSid); } catch { /* 删不掉就留着 */ }
      const left = runtime.dropTaskFiles(t, BASE); bytes += left.bytes;
      if (left.kept.length) logLine(path.join(BASE, 'logs', 'forget.jsonl'), { task: t.sid, kept: left.kept.length });
    }
    try { fs.unlinkSync(path.join(BASE,'tasks-index.json')); } catch {}
    listTasks();queueControllerEvent();
    return { ok: true, bytes };
  }
};

/* ---------- xin task：前台派分身、看进度、补充、停；分身请用户确认 ----------
   xin task new [--kind 类型] [--title 标题] [--model 模型] [--dir 项目目录] [--file 文件]… [--after 编号,编号] [--minutes 分钟] [-- 要求…]
     （要求也可以从标准输入给：xin task new --title 标题 <<'EOF' … EOF）
   xin task list | show 编号 | tell 编号 补充的话 | stop 编号 | ask 要用户确认的事（只在分身里用） */
function readStdin() {
  try { const st = fs.fstatSync(0); if (!st.isFIFO() && !st.isFile()) return ''; return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
export function parseTaskArgs(argv) {
  const o = { files: [], after: [], plugins: [] }, rest = [];
  const alias = { k: 'kind', t: 'title', m: 'model', d: 'dir', f: 'file', a: 'after' };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--') { rest.push(...argv.slice(i + 1)); break; }
    if(x==='--web'){o.web=true;continue;}
    if (x === '--review' || x === '-r') { o.review = true; continue; }   // 做完再派一个分身换模型检查
    const m = /^(?:--([a-z]+)|-([a-z]))(?:=(.*))?$/.exec(x);
    if (!m || !(m[1] || alias[m[2]])) { rest.push(x); continue; }
    const k = m[1] || alias[m[2]], v = m[3] !== undefined ? m[3] : argv[++i];
    if (v === undefined) return { error: '--' + k + ' 后面要写值' };
    if (k === 'file') o.files.push(v);
    else if (k === 'plugin') o.plugins.push(v);
    else if (k === 'after') o.after.push(...String(v).split(/[,，、\s]+/).filter(Boolean).map(Number));
    else if (['kind', 'title', 'model', 'dir', 'minutes'].includes(k)) o[k] = v;
    else return { error: '不认识的选项：--' + k };
  }
  o.goal = rest.join(' ').trim();
  return o;
}
const TASK_HELP = [
  '用法：',
  "  xin task new --kind code --title 标题 [--model 模型] [--dir 项目目录] [--file 文件] [--after 编号] [--review] -- 详细要求",
  '    --after 编号：等那个任务做完再开始（它的结果会交给这个任务）；--review：做完再派一个分身用另一个模型检查一遍',
  "  xin task new --kind code --title 标题 <<'EOF'",
  '  详细要求（写清楚做什么、做到什么程度算完、东西放哪）',
  '  EOF',
  '  xin task list            这个对话的后台任务',
  '  xin task show 编号        进度、结果、最近执行的命令',
  '  xin task tell 编号 话     补充要求 / 回复它的问题 / 让它接着做',
  '  xin task stop 编号        停掉',
  '类型：' + TASK_KINDS.map(k => k + '（' + KIND_NAMES[k] + '）').join('、') + '；模型：' + CODEX_MODELS.map(m => m.id).join('、')
].join('\n');
function taskLine(t) {
  const mins = n => Math.max(1, Math.round(n / 60e3)) + ' 分钟';
  const st = t.status === 'running' ? '进行中 ' + mins(Date.now() - (t.startedAt || t.created)) : (TASK_STATUS[t.status] || t.status);
  const actual=t.actualModel||((t.runs||[]).length||t.turnsCount?t.model:null);
  const model=actual===runtime.AGY_MODEL?'Gemini 3.8 Flash High':CODEX_MODELS.find(m=>m.id===actual)?.name||actual||'尚未执行';
  return '任务 ' + t.no + '「' + t.title + '」' + st + '（' + KIND_NAMES[t.tkind || t.kind] + '，' + model + '）' + (t.question ? '：等你确认「' + t.question + '」' : '');
}
function taskCmd(argv) {
  const sub = argv[0] || '', run = process.env.XIN_RUN;
  const meta = okId(run, 'r') ? readJ(metaF(run)) : null;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { console.log(TASK_HELP); return sub ? 0 : 2; }
  if (sub === 'new') {
    if (!meta) { console.log('现在不在对话里，派不了任务'); return 1; }
    if (meta.task) { console.log('分身里不能再派分身：要拆开做的话，在最后的总结里写清楚建议怎么拆'); return 1; }
    if (meta.kind === 'daily') { console.log('每日任务里不派分身，自己做完'); return 1; }
    const o = parseTaskArgs(argv.slice(1));
    if (o.error) { console.log(o.error + '\n' + TASK_HELP); return 2; }
    if (!o.goal) o.goal = readStdin().trim();
    if (!o.goal) { console.log('要写清楚让分身做什么\n' + TASK_HELP); return 2; }
    if (o.kind && !TASK_KINDS.includes(o.kind)) { console.log('类型只能是：' + TASK_KINDS.join(' / ')); return 2; }
    if (o.model && o.model!==runtime.AGY_MODEL && !CODEX_MODELS.some(m => m.id === o.model)) { console.log('没有这个模型：' + o.model + '（能用的：' + CODEX_MODELS.map(m => m.id).concat(runtime.AGY_MODEL).join('、') + '）'); return 2; }
    // 用户这一句点名的就是这个模型：当成用户点名（检查任务也照用）
    const said = (events(run).find(e => e.t === 'user') || {}).text || '';
    if (meta.frontNamed) o.model = meta.frontNamed;
    const named = !!o.model && namedModel(said) === o.model;
    // A live foreground executor forwards the user's words. A manual CLI call after a turn
    // has ended is an operator-supplied task and keeps its explicit command-line requirement.
    const fromFront=meta.agent==='codex'&&!meta.ended;
    const original=fromFront?frontOriginalRequest(run,meta):o.goal;
    if(!original){console.log('找不到本轮用户原话，不能替用户编写要求');return 1;}
    const r = lockedCall('tasks', 'task_new', { parent: meta.sid, kind: o.kind, title: o.title, goal: original, frontRun:fromFront?run:undefined,web:o.web,strictModel:!!meta.frontNamed,userRequest:fromFront?original:said, model: o.model, named, dir: o.dir, files: fromFront?[...new Set([...(o.files||[]),...(meta.frontFiles||[]).map(f=>f.path)])]:o.files, after: o.after, minutes: o.minutes, plugins: o.plugins });
    if (r.error) { console.log(r.msg || r.error); return 1; }
    const t = r.task;
    emit(run, { t: 'task', sid: t.sid, no: t.no, title: t.title, kind: t.kind, model: t.model, why: t.why, status: t.status, after: t.after, at: Date.now() });
    let out = '派出去了：任务 ' + t.no + '「' + t.title + '」（' + KIND_NAMES[t.kind] + '，' + modelLabel(t.model) + '，' + TASK_STATUS[t.status] + '，工作目录 ' + t.dir + '）。' + (t.note ? t.note + '。' : '');
    // --review：再派一个检查任务，等它做完、换个模型、在同一个目录里检查
    if (o.review && t.kind !== 'review') {
      const rv = lockedCall('tasks', 'task_new', { parent: meta.sid, kind: 'review', title: ('检查：' + t.title).slice(0, 40), after: [t.no], dir: t.dir,
        userRequest:said, goal: '检查任务 ' + t.no + '「' + t.title + '」做出来的东西对不对、有没有漏。原来的要求：\n' + cut(o.goal, 10000) });
      if (rv.task) {
        const v = rv.task;
        emit(run, { t: 'task', sid: v.sid, no: v.no, title: v.title, kind: v.kind, model: v.model, why: v.why, status: v.status, after: v.after, at: Date.now() });
        out += '检查任务 ' + v.no + '（' + modelLabel(v.model) + '）等它做完就开始。';
      } else out += '检查任务没派成：' + (rv.msg || rv.error) + '。';
    }
    console.log(out + '它在后台做，做完结果会自动出现在聊天里；你不用等，回用户一句就结束这一轮。');
    return 0;
  }
  if (sub === 'ask') {
    if (!meta || !meta.task) { console.log('xin task ask 只在后台任务里用（要问用户就直接在回答里问）'); return 1; }
    const r = lockedCall('tasks', 'task_ask', { sid: meta.sid, question: argv.slice(1).join(' ') });
    if (r.error) { console.log(r.msg || r.error); return r.error === 'empty' ? 2 : 1; }
    console.log('记下了。现在结束这一轮（最后一条消息说清楚做到哪了、要用户确认什么）；用户回复后会接着叫你。');
    return 0;
  }
  const all = listTasks();
  if (sub === 'list') {
    const parent = meta && !meta.task ? meta.sid : null;
    const mine = all.filter(t => t.parent === parent), others = all.filter(t => t.parent !== parent && !isFinished(t));
    if (!mine.length && !others.length) console.log('还没有后台任务');
    if (mine.length) console.log(mine.slice(-20).map(taskLine).join('\n'));
    if (others.length) console.log((mine.length ? '\n' : '') + '别的对话里还没做完的：\n' + others.map(taskLine).join('\n'));
    console.log(dailyContext());
    return 0;
  }
  const t = findTask({ no: argv[1] }, all);
  if (!t) { console.log(argv[1] ? '没有任务 ' + argv[1] : TASK_HELP); return 1; }
  if (sub === 'show') {
    const lines = [taskLine(t), '工作目录：' + t.dir, '要求：' + cut(t.goal, 1500)];
    const r = lastRun(t);
    if (r) {
      const cmds = tailEvents(r, 65536).filter(e => e.t === 'tool_end').slice(-6).map(e => '  ' + (e.ok ? '✓ ' : '✗ ') + bareCmd(e.detail || e.name || '').replace(/\s+/g, ' ').slice(0, 160));
      if (cmds.length) lines.push('最近执行的命令：\n' + cmds.join('\n'));
      if (t.status === 'running') lines.push('现在：' + (taskActivity(r) || '在想'));
    }
    if (t.inbox && t.inbox.length) lines.push('等这一步做完再告诉它的：' + t.inbox.map(x => x.text).join(' / '));
    if (t.result) lines.push('结果：' + cut(t.result.text, 3000) + (t.result.err ? '\n出错：' + t.result.err : ''));
    console.log(lines.join('\n'));
    return 0;
  }
  // 分身在沙盒里：从它那里起别的任务会把沙盒带过去，所以分身只能看，不能补充、停别的任务
  if ((sub === 'tell' || sub === 'stop') && meta && meta.task) { console.log('分身里不能补充、停别的任务'); return 1; }
  if (sub === 'tell') {
    const text = argv.slice(2).join(' ').trim() || readStdin().trim();
    if (!text) { console.log('用法：xin task tell 编号 补充的话'); return 2; }
    const r = lockedCall('tasks', 'task_tell', { no: t.no, text });
    console.log(r.error ? r.msg || r.error : r.msg);
    return r.error ? 1 : 0;
  }
  if (sub === 'stop') {
    const r = lockedCall('tasks', 'task_stop', { no: t.no });
    console.log(r.error ? r.msg || r.error : r.already ? '任务 ' + t.no + ' 已经结束了' : '停了：任务 ' + t.no);
    return r.error ? 1 : 0;
  }
  console.log(TASK_HELP);
  return 2;
}

// 小芯自己的表情、开场白、好感度、新动作和记事：shell 里的 xin 命令和前台的结构化函数共用。run：事件写进哪一轮
function companionCmd(argv, run) {
  const act = argv[0], arg = argv.slice(1).join(' ').trim(), live = okId(run, 'r') && fs.existsSync(runF(run));
  if (act === 'next') {
    const g = setNext(arg);
    return g ? { code: 0, text: '下次见面会说：' + g.text } : { code: 2, text: '用法：xin next 下次见面要说的一句话' };
  }
  if (act === 'move') {
    const sub = argv[1] || '';
    if (!sub || sub === 'help' || sub === '-h' || sub === '--help') return { code: sub ? 0 : 2, text: MOVE_HELP };
    const list = readMoves();
    if (sub === 'list') return { code: 0, text: list.length ? list.map(m => m.name + '（' + m.frames.length + ' 帧）').join('\n') : '还没有学过新动作' };
    if (sub === 'rm') {
      const name = argv.slice(2).join(' ').trim(), left = list.filter(m => m.name !== name);
      if (left.length === list.length) return { code: 1, text: '没有叫「' + name + '」的动作' };
      writeMoves(left); return { code: 0, text: '忘掉了：' + name };
    }
    if (sub === 'add') {
      let frames;
      try { frames = JSON.parse(argv.slice(3).join(' ')); } catch (e) { return { code: 2, text: '帧不是合法的 JSON：' + e.message + '\n' + MOVE_HELP }; }
      const m = cleanMove(argv[2], frames);
      if (m.error) return { code: 2, text: m.error };
      const left = list.filter(x => x.name !== m.name);
      if (left.length >= MOVES_MAX) return { code: 1, text: '最多记 ' + MOVES_MAX + ' 个动作，先 xin move rm 一个' };
      left.push({ name: m.name, frames: m.frames, at: Date.now() }); writeMoves(left);
      if (live) emit(run, { t: 'move', name: m.name, frames: m.frames });
      return { code: 0, text: '学会了：' + m.name + '（' + m.frames.length + ' 帧）' + (live ? '，网页上的小芯马上做一遍' : '') };
    }
    const name = argv.slice(1).join(' ').trim(), m = list.find(x => x.name === name);
    if (!m) return { code: 1, text: '还没学过「' + name + '」。会的：' + (list.map(x => x.name).join('、') || '还没有') + '\n' + MOVE_HELP };
    if (!live) return { code: 1, text: '现在没有在和网页聊天，小芯看不到' };
    emit(run, { t: 'xin', act: 'move', arg: m.name, frames: m.frames });
    return { code: 0, text: '小芯收到：' + m.name };
  }
  if (act === 'bond') {
    const d = Number(argv[1]), why = argv.slice(2).join(' ').trim();
    if (!/^[+-]?\d+$/.test(argv[1] || '') || !d || !why) return { code: 2, text: '用法：xin bond +1 理由（或 -1 理由，一次最多 ±3，一天合计最多 6）' };
    const r = bondAdd('ai', d, why);
    if (r.delta && live) emit(run, Object.assign({ t: 'bond', d: r.delta, why: why.slice(0, 40) }, bondInfo()));
    return { code: 0, text: r.delta ? '好感度 ' + (r.delta > 0 ? '+' : '') + r.delta + '，现在 ' + r.score + '（' + bondLevel(r.score).name + '）' : '今天的好感度已经加减够多了，这次不算（现在 ' + r.score + '）' };
  }
  if (act === 'remember' || act === 'forget') {
    const meta = live ? readJ(metaF(run)) : null;
    // Memory changes belong to a real turn of Xiaoxin. A bare shell (no run, or a made-up one) cannot write or erase it.
    if (!meta) return { code: 1, text: '现在不在小芯的对话里，不能改记忆。' };
    // Who is remembering decides how much it counts: the user's own chat, the daily routine, or a background worker.
    const source = meta.kind === 'daily' ? 'daily' : meta.task ? 'worker' : 'chat';
    if (act === 'forget') {
      const r = forgetByKeyword(arg, source);
      return r.ok ? { code: 0, text: '忘掉了：' + r.text } : { code: r.error === 'empty' ? 2 : 1, text: r.error === 'empty' ? '用法：xin forget 关键词' : r.msg };
    }
    // A completion event carries a worker's output, never the owner's words: nothing about the owner is learned from it.
    if (meta.kind === 'handoff') return { code: 1, text: '这一轮是后台结果的汇报，里面没有兄弟的原话，不记个人记忆。' };
    const o = { type: source === 'daily' ? 'procedure' : 'profile', basis: 'observed' }, words = [];
    for (let i = 1; i < argv.length; i++) {
      if (['--type', '--basis', '--quote'].includes(argv[i]) && argv[i + 1]) o[argv[i].slice(2)] = argv[++i]; else words.push(argv[i]);
    }
    const content = words.join(' ');
    let quote = '';
    if (source === 'chat') {
      // "The owner said so" has to be shown, not claimed: the quote (or the statement itself) must appear verbatim in
      // what the owner wrote this turn. Otherwise it is kept as a candidate, exactly like an observation.
      const flat = t => String(t || '').replace(/\s+/g, ' ').trim();
      const said = events(run).filter(e => e.t === 'user').map(e => String(e.text || '')).join('\n'), cited = flat(o.quote || content);
      const shown = cited.length >= 2 && flat(said).includes(cited);
      if (o.basis === 'stated' && !shown) o.basis = 'observed';
      quote = shown ? cited : said;
    }
    const r = addMemory({ content, type: o.type, basis: o.basis, source, evidence: { sid: meta.sid, run, quote } });
    if (r.error) return { code: r.error === 'empty' ? 2 : 1, text: r.error === 'empty' ? '用法：xin remember [--basis stated|observed|inferred] [--type profile|learning|project|procedure|self] [--quote 用户原话片段] 一句话' : r.msg };
    const it = r.item;
    if (live && it.status === 'active') emit(run, { t: 'mem', text: it.content });
    return { code: 0, text: it.status === 'active' ? '记住了：' + it.content : it.status === 'private' ? '这是个人敏感的事，只记成隐私、不主动用：' + it.content : '先记成候选，以后反复出现才当真：' + it.content };
  }
  if (!ACTS[act]) return null;
  if (!live) return { code: 1, text: '现在没有在和网页聊天，小芯看不到' };
  if (act === 'music' && arg && !/^(on|off)$/.test(arg)) return { code: 2, text: 'xin music on 或 xin music off' };
  emit(run, { t: 'xin', act, arg: arg.slice(0, 80) });
  return { code: 0, text: '小芯收到：' + act + (arg ? ' ' + arg.slice(0, 80) : '') };
}
function xinCmd(argv) {
  const act = argv[0], run = process.env.XIN_RUN, meta = okId(run, 'r') ? readJ(metaF(run)) : null;
  // 天启是独立功能：不读写小芯的记事本、好感度、动作、开场白和后台任务
  if (meta && meta.agent === 'harness') { console.log('天启模式是独立功能，不使用小芯的 xin 命令（记事本、好感度、动作、开场白、后台任务等）。'); return 1; }
  if (act === 'recall') {
    if(meta?.task){console.log('后台只使用任务内的资料，不检索私人聊天。');return 1;}
    const q=argv.slice(1).join(' ').trim();if(!q){console.log('用法：xin recall 关键词');return 2;}
    console.log(JSON.stringify(recallAll(q)));return 0;
  }
  if (act === 'task') return taskCmd(argv.slice(1));
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
  const c = act && act !== '-h' && act !== '--help' ? companionCmd(argv, run) : null;
  if (c) { console.log(c.text); return c.code; }
  console.log('用法：xin <动作> [参数]\n' + Object.keys(ACTS).map(k => '  ' + k.padEnd(8) + ACTS[k]).join('\n') + '\n  remember 记到记忆里（xin remember [--basis stated|observed|inferred] [--type 类型] 一句话）\n  forget   忘掉记忆里的一件事（xin forget 关键词）\n  next     下次见面的开场白（xin next 一句话）\n  move     编新动作、做新动作（xin move help）\n  bond     好感度（xin bond +1 理由）\n  task     后台任务：派分身、看进度、补充、停（xin task help）');
  return act && act !== '-h' && act !== '--help' ? 2 : 0;
}

function main() {
  journal.recover();
  let op = process.argv[2];
  const locked = op === 'locked';
  if (locked) op = process.argv[3];
  if (op === 'run') { runner(process.argv[3]); return; }
  if(op==='agy-run'){
    const run=process.argv[3],m=readJ(metaF(run)),t=m&&readJ(sessF(m.sid));
    if(!m?.task||!t?.workspace||m.model!==runtime.AGY_MODEL){process.exitCode=1;return;}
    const clientDir=path.join(BASE,'antigravity-client');mk(clientDir);
    runtime.antigravityWork(t,{clientDir,quotaState:readJ(path.join(BASE,'antigravity-quota.json')),text:m.text,instructions:taskSystemPrompt(t),budget:workBudget(t.sid),quota:quota=>lockedCall('tasks','agy_quota',{quota}),conversation:id=>lockedCall('tasks','agy_conversation',{sid:t.sid,run,id}),ask:text=>lockedCall('tasks','task_ask',{sid:t.sid,question:text}),remember:text=>addMemory({content:text,source:'worker',evidence:{sid:t.sid,run}})})
      .then(code=>{process.exitCode=code;}).catch(e=>{process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:e.message}})+'\n');process.exitCode=1;});return;
  }
  if (op === 'warm') { warm(); return; }
  if (op === 'memory-idle') { idleMemoryReview().catch(() => {}); return; }
  if (op === 'callback') { flushControllerEvent().catch(() => {}); return; }
  if (op === 'watchdog') { watchdog().catch(() => {}); return; }
  if (op === 'xin') { process.exitCode = xinCmd(process.argv.slice(3)); return; }
  if (op === 'pushq') { let m = null; try { m = JSON.parse(process.argv[3] || ''); } catch { /* 坏的就不发 */ } if (m) pushAll(m).catch(() => {}); return; }
  const internal = locked && Object.prototype.hasOwnProperty.call(iops, op);
  if (!Object.prototype.hasOwnProperty.call(ops, op) && !(locked && op === 'session_patch') && !internal) {
    process.stdout.write(JSON.stringify({ error: 'bad_op', msg: '不认识的操作' })); return;
  }
  let args = {};
  try { const t = fs.readFileSync(0, 'utf8').trim(); if (t) args = JSON.parse(t); } catch { args = {}; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  if(locked&&!process.env.XIN_LOCK){
    const sid=args.sid||readJ(metaF(args.run||''))?.sid;
    process.env.XIN_LOCK=['send','session_patch','run_complete','continue_steers'].includes(op)&&sid&&!isTask(readJ(sessF(sid)))?sid:'tasks';
  }
  if (op === 'session_patch' && locked && okId(args.sid, 's')) {
    const s = readJ(sessF(args.sid));
    if (!s) { process.stdout.write(JSON.stringify({ error: 'no_session', msg: '找不到这个对话' })); return; }
    for (const k of ['agentSid', 'started', 'ctxWin', 'hUsage', 'frontUsage']) if (Object.prototype.hasOwnProperty.call(args.changes || {}, k)) s[k] = args.changes[k];
    s.updated = Date.now(); if(isTask(s))saveTask(s);else writeJ(sessF(args.sid), s); rememberAgentSession(s.agent, s.agentSid);
    process.stdout.write(JSON.stringify({ session: s })); return;
  }
  if (internal) {
    let res; try { res = transactionalOp(op,args,()=>iops[op](args));dispatchLaunches(); } catch (e) { res = { error: 'internal', msg: String(e && e.message || e) }; }
    process.stdout.write(JSON.stringify(res || {})); return;
  }
  if (!Object.prototype.hasOwnProperty.call(ops, op)) { process.stdout.write(JSON.stringify({ error: 'bad_op', msg: '不认识的操作' })); return; }
  if (!locked) markCurrentController();
  // 发给主对话的话不带编号：先认出是哪一个，按它自己的锁排队（重发时的摘要仍按「没带编号」算，见 transactionalOp）
  if (op === 'send' && !args.sid && args.main && !args.mainSid) { const m = mainSid(); if (m) { args.sid = m; args.mainSid = m; } }
  const key = ['push_key','push_sub','push_unsub'].includes(op) ? 'tasks' : op === 'daily' ? 'daily' : ['send', 'steer', 'rename', 'archive', 'forget'].includes(op)
    ? (okId(args.sid, 's') ? isTask(readJ(sessF(args.sid))) ? 'tasks' : args.sid : op === 'send' && !args.sid ? 'new' : null) : null;
  if (!locked && key) { process.stdout.write(JSON.stringify(lockedCall(key, op, args))); return; }
  Promise.resolve().then(() => transactionalOp(op,args,()=>ops[op](args || {}))).then(res=>{dispatchLaunches();return res;}).catch(e => ({ error: 'internal', msg: String(e && e.message || e) }))
    .then(res => { process.stdout.write(JSON.stringify(res)); });
}

function transactionalOp(op,args,fn){
  const locked=process.argv[2]==='locked';
  if(!locked)return fn();
  const taskScope=process.env.XIN_LOCK==='tasks'&&Object.hasOwn(iops,op);
  if(!taskScope&&!['send','handoff_start','front_reply','front_model','continue_steers'].includes(op))return fn();
  // Initialize the compatibility index before opening SQLite: no child may wait on our transaction while holding tasks.lock.
  if(op==='send'||op==='continue_steers'){mk(SESS);mk(RUNS);listTasks();}
  let command=null;
  if(op==='send'&&/^[a-zA-Z0-9_-]{8,80}$/.test(args.clientId||'')){
    const {sid,agent,text,effort,model,context,ctxLabel,files}=args;
    command={id:'send:'+args.clientId,digest:inputDigest({sid:args.mainSid?null:sid||null,agent:agent||null,text:text||'',effort:effort||null,model:model||null,context:context||'',ctxLabel:ctxLabel||'',files:files||[],...(args.main?{main:true}:{})})};
  }else if(['task_tell','task_stop'].includes(op)&&/^[a-zA-Z0-9_-]{8,80}$/.test(args.clientId||'')){
    command={id:op+':'+args.clientId,digest:inputDigest(args)};
  }else if(op==='front_action'&&(['remember','forget','task','bond','next','move'].includes(args.argv?.[1])||Object.hasOwn(ACTS,args.argv?.[1]||''))&&!['list','show'].includes(args.argv?.[2])){
    command={id:'front:'+args.run+':'+inputDigest(args.argv).slice(0,20),digest:inputDigest({run:args.run,argv:args.argv})};
  }
  return journal.atomic(fn,command);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main();
