// Xiaoxin's own companion state: mascot actions, learned moves, bond (好感度) and the next-visit greeting.
import path from 'node:path';
import { BASE, mk, rid, readJ, writeJ, cut } from './vm-base.mjs';

/* 小芯能做的动作（xin 命令和网页共用这张表；网页只认这些名字） */
export const ACTS = {
  say: '头上冒一个气泡说一句话（xin say 编译过了！）',
  normal: '恢复常态睁眼', smile: '微笑（> < 笑眼）', focus: '专注（竖眼）', calm: '冷静（半闭眼）', love: '喜欢（爱心眼）',
  happy: '开心', sad: '难过', angry: '生气', wow: '惊讶', confused: '疑惑',
  dance: '跳舞', jump: '跳一下', cookie: '吃饼干', battery: '吸电池（之后跑得飞快）', ball: '抛小球', led: '玩 LED',
  sleep: '睡觉', wake: '叫醒', music: '戴耳机听歌（xin music off 摘下来）', swing: '荡秋千', sit: '坐在边上晃腿', code: '掏出电脑敲代码',
  rage: '发脾气砸东西', tongue: '吐舌头'
};


/* ---------- 下次见面的开场白：小芯用 xin next 写，用户下次打开网页时在气泡里说 ---------- */
export const NEXT_FILE = () => path.join(BASE, 'next.json');
export const NEXT_TTL = 3 * 86400e3;
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
export const MOVES_F = () => path.join(BASE, 'moves.json');
export const MOVES_MAX = 30, FRAMES_MAX = 48, MOVE_MS_MAX = 15000;
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
export function writeMoves(l) { mk(BASE); writeJ(MOVES_F(), l); }
export const MOVE_HELP = [
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
export const BOND_F = () => path.join(BASE, 'bond.json');
export const BOND_LEVELS = [[0, '刚认识'], [15, '熟悉'], [40, '好朋友'], [80, '最好的朋友']];
export const BOND_CAP = { chat: 5, play: 3, visit: 1, ai: 6 }, BOND_MAX = 200;
export function dayOf(t) { return new Date(t + 8 * 3600e3).toISOString().slice(0, 10); }
export function bondLevel(score) {
  let i = 0;
  BOND_LEVELS.forEach((l, j) => { if (score >= l[0]) i = j; });
  return { level: i, name: BOND_LEVELS[i][1], next: BOND_LEVELS[i + 1] ? BOND_LEVELS[i + 1][0] : null };
}
export function bondRead() {
  const b = readJ(BOND_F());
  return b && typeof b.score === 'number' ? Object.assign({ log: [], days: {} }, b) : { score: 0, seen: 0, log: [], days: {} };
}
export function bondLog(b, d, why, now) { b.log.push({ at: now, d, why: String(why || '').replace(/\s+/g, ' ').trim().slice(0, 40) }); b.log = b.log.slice(-20); }
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
export function bondPart() {
  const i = bondInfo();
  return '你和用户现在的关系：' + i.name + '（好感度 ' + i.score + '）。说话的亲近程度跟着关系走：刚认识时礼貌、有点害羞；熟悉了随意一点、会开玩笑；好朋友会撒娇、记挂对方；最好的朋友无话不谈。' +
    '用户对你好、认真学习有进步、答对你出的题时，可以用 `xin bond +1 理由` 加好感（一次最多 +3）；被敷衍、被凶时可以 `xin bond -1 理由`。别每句都用，一天合计最多 6。';
}
