// Xiaoxin's long-term memory (default mode only; Tianqi never reads or writes it).
// Small, typed, sourced statements in the controller's SQLite — not a transcript archive. Every change is logged.
// What the user explicitly said is used at once; observations, guesses, worker notes and the old notebook wait
// for confirmation. Forgotten content leaves only a hash, so it is not learned again.
import crypto from 'node:crypto';
import { journal, readText, BASE } from './vm-base.mjs';
import path from 'node:path';

export const MEMORY_TYPES = { profile: '关于你', learning: '学习', project: '在做的事', procedure: '做事方法', self: '小芯自己', unsorted: '旧记事本' };
export const MEMORY_BASIS = { stated: '你明确说的', observed: '观察到的', inferred: '推测的', legacy: '旧记事本' };
const ITEM_MAX = 300, LIVE = "('active','pending','private')";
export const LEGACY_FILE = () => path.join(BASE, 'memory.md');

let ready = false;
function db() {
  const d = journal.db;
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS memory_items (id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, norm TEXT NOT NULL,
        basis TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, confirmed INTEGER);
      CREATE TABLE IF NOT EXISTS memory_evidence (item TEXT NOT NULL, sid TEXT, run TEXT, quote TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_log (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_forgotten (norm TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_by_status ON memory_items(status, type, updated);
      CREATE INDEX IF NOT EXISTS memory_evidence_item ON memory_evidence(item);`);
    ready = true;
  }
  return d;
}

const clean = text => String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, ITEM_MAX);
// Normalised form for duplicates and forgetting: width-folded, lower-case, no spaces or punctuation.
export const memoryNorm = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const hash = norm => crypto.createHash('sha256').update(norm).digest('hex');
// value: looks like a credential or identity number itself — never stored, not even when the user types it.
// word: only mentions passwords/keys — refused from chat and workers, kept private from the old notebook, allowed from the user.
// personal: health and money topics — kept private (never used) unless the user adds them.
const SECRET_VALUE = [/(?:密码|口令|验证码|动态码|校验码|\bpassword\b|\bpasswd\b|\bpin\b)\s*(?:是|为|:|：|=)?\s*[A-Za-z0-9!@#$%^&*._-]{4,}/i,
  /\b(?:sk|ibk|ghp|gho|github_pat|xox[abp]|AKIA)[-_A-Za-z0-9]{8,}/, /[A-Za-z0-9_-]{32,}/, /(?<!\d)\d{17}[\dXx](?!\d)/, /(?<!\d)\d{16,19}(?!\d)/];
const SECRET_WORD = [/密码|口令|验证码|动态码|校验码|私钥|助记词|支付密码/, /\b(?:password|passwd|api[ _-]?key|secret[ _-]?key|access[ _-]?key|private[ _-]?key)\b/i];
const PERSONAL = /生病|疾病|病情|看病|住院|医院|吃药|药物|诊断|抑郁|焦虑|失眠|过敏|怀孕|工资|薪水|收入|存款|贷款|负债|欠款|理财|股票|基金|房贷/;
export function memorySensitivity(text) {
  return SECRET_VALUE.some(r => r.test(text)) ? 'value' : SECRET_WORD.some(r => r.test(text)) ? 'word' : PERSONAL.test(text) ? 'personal' : null;
}
const SECRET_MSG = '这类内容不记：密码、验证码、密钥、证件号和卡号都不保存。';

function log(item, action, actor, detail) {
  db().prepare('INSERT INTO memory_log(item,action,actor,detail,at) VALUES(?,?,?,?,?)').run(item, action, actor, detail == null ? null : JSON.stringify(detail), Date.now());
}
function evidence(item, e, at = Date.now()) {
  if (!e) return;
  const quote = clean(e.quote || '').slice(0, 200);
  if (!quote && !e.sid) return;
  db().prepare('INSERT INTO memory_evidence(item,sid,run,quote,at) VALUES(?,?,?,?,?)').run(item, e.sid || null, e.run || null, quote, e.at || at);
}
const row = id => db().prepare('SELECT * FROM memory_items WHERE id=?').get(id);

// source: user（记忆页）| chat（默认模式聊天）| daily（每日任务）| worker（后台任务）| legacy（旧记事本）
export function addMemory({ content, type = 'profile', basis = 'observed', source = 'chat', evidence: ev = null, at } = {}) {
  const text = clean(content);
  if (!text) return { error: 'empty', msg: '要记的内容是空的' };
  if (!MEMORY_TYPES[type]) type = 'profile';
  if (!MEMORY_BASIS[basis]) basis = 'observed';
  if (source === 'user') basis = 'stated';
  if (source === 'legacy') { type = 'unsorted'; basis = 'legacy'; }
  if (source === 'worker') { type = 'project'; if (basis === 'stated') basis = 'observed'; }
  const sens = memorySensitivity(text);
  if (sens === 'value' || sens === 'word' && source !== 'user' && source !== 'legacy') return { error: 'secret', msg: SECRET_MSG };
  const norm = memoryNorm(text);
  if (!norm) return { error: 'empty', msg: '要记的内容是空的' };
  return journal.atomic(() => {
    if (source !== 'user' && db().prepare('SELECT 1 FROM memory_forgotten WHERE norm=?').get(hash(norm))) return { error: 'forgotten', msg: '用户让我忘掉过这件事，不再记。' };
    // Only what the user said (or the user's own edits) counts at once; daily procedures are Xiaoxin's own know-how.
    let status = source === 'user' || source === 'daily' || source === 'chat' && basis === 'stated' ? 'active' : 'pending';
    if ((sens === 'personal' || sens === 'word') && source !== 'user') status = 'private';
    const now = Date.now(), same = db().prepare('SELECT * FROM memory_items WHERE norm=? AND status IN ' + LIVE).get(norm);
    if (same) {
      const upgrade = same.status === 'pending' && status === 'active';
      db().prepare('UPDATE memory_items SET updated=?, status=?, basis=?, confirmed=? WHERE id=?').run(now, upgrade ? 'active' : same.status,
        upgrade ? basis : same.basis, upgrade ? now : same.confirmed, same.id);
      evidence(same.id, ev, at); if (upgrade) log(same.id, 'confirm', source, { basis });
      return { item: row(same.id), duplicate: true };
    }
    const id = 'm' + now.toString(36) + crypto.randomBytes(4).toString('hex');
    db().prepare('INSERT INTO memory_items(id,type,content,norm,basis,status,source,created,updated,confirmed) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, type, text, norm, basis, status, source, at || now, now, status === 'active' ? now : null);
    evidence(id, ev, at); log(id, 'add', source, { type, basis, status });
    return { item: row(id) };
  });
}

// changes: {content?, type?, private?: boolean, confirm?: true}. Only the user edits through this path.
export function updateMemory(id, changes = {}, actor = 'user') {
  return journal.atomic(() => {
    const it = row(id);
    if (!it || !['active', 'pending', 'private'].includes(it.status)) return { error: 'not_found', msg: '找不到这条记忆' };
    const next = { ...it }, now = Date.now();
    if (changes.content != null) {
      const text = clean(changes.content);
      if (!text) return { error: 'empty', msg: '内容是空的；不想要这条就点「忘掉」' };
      if (memorySensitivity(text) === 'value') return { error: 'secret', msg: SECRET_MSG };
      Object.assign(next, { content: text, norm: memoryNorm(text), basis: 'stated' });
    }
    if (changes.type && MEMORY_TYPES[changes.type]) next.type = changes.type;
    if (changes.private === true) next.status = 'private';
    else if (changes.private === false && it.status === 'private') next.status = 'active';
    if (changes.confirm) { if (next.status === 'pending') next.status = 'active'; next.confirmed = now; if (next.basis !== 'stated') next.basis = 'stated'; }
    if (changes.content != null && next.status === 'pending') { next.status = 'active'; next.confirmed = now; }
    db().prepare('UPDATE memory_items SET content=?,norm=?,type=?,basis=?,status=?,confirmed=?,updated=? WHERE id=?')
      .run(next.content, next.norm, next.type, next.basis, next.status, next.confirmed, now, id);
    log(id, 'update', actor, { from: { type: it.type, status: it.status }, to: { type: next.type, status: next.status }, edited: changes.content != null });
    return { item: row(id) };
  });
}

// Forgetting removes the statement and its quotes; only a hash remains so the same content is not stored again.
export function forgetMemory(id, actor = 'user') {
  return journal.atomic(() => {
    const it = row(id);
    if (!it) return { error: 'not_found', msg: '找不到这条记忆' };
    db().prepare('INSERT OR IGNORE INTO memory_forgotten(norm,at) VALUES(?,?)').run(hash(it.norm), Date.now());
    db().prepare('DELETE FROM memory_evidence WHERE item=?').run(id);
    db().prepare('DELETE FROM memory_items WHERE id=?').run(id);
    log(id, 'forget', actor, { type: it.type });
    return { ok: true };
  });
}
export function forgetByKeyword(keyword, actor = 'chat') {
  const k = clean(keyword).toLowerCase();
  if (k.length < 2) return { error: 'empty', msg: '要写清楚忘掉哪件事（至少两个字）' };
  const hits = db().prepare('SELECT * FROM memory_items WHERE status IN ' + LIVE + ' ORDER BY updated DESC').all().filter(it => it.content.toLowerCase().includes(k));
  if (!hits.length) return { error: 'not_found', msg: '记忆里没有找到和「' + k + '」有关的内容' };
  if (hits.length > 1) return { error: 'ambiguous', msg: '有好几条相关的，请用户说清楚是哪一条，或者在「小芯的记忆」里删：' + hits.slice(0, 6).map(it => '「' + it.content.slice(0, 40) + '」').join('、') };
  forgetMemory(hits[0].id, actor);
  return { ok: true, text: hits[0].content };
}

export function listMemory() {
  importLegacyNotebook();
  const items = db().prepare('SELECT * FROM memory_items WHERE status IN ' + LIVE + ' ORDER BY updated DESC').all();
  const proofs = db().prepare('SELECT * FROM memory_evidence WHERE item=? ORDER BY at DESC LIMIT 3');
  return items.map(it => ({ id: it.id, type: it.type, content: it.content, basis: it.basis, status: it.status, source: it.source,
    created: it.created, updated: it.updated, confirmed: it.confirmed, evidence: proofs.all(it.id).map(e => ({ sid: e.sid, run: e.run, quote: e.quote, at: e.at })) }));
}

// The old Markdown notebook is imported once, as pending items with their original lines as evidence. The file stays.
export function importLegacyNotebook(text = readText(LEGACY_FILE())) {
  const body = String(text || '').trim();
  const d = db(), done = d.prepare("SELECT value FROM memory_meta WHERE key='legacy_import'").get();
  if (done || !body) return { skipped: true };
  return journal.atomic(() => {
    if (d.prepare("SELECT value FROM memory_meta WHERE key='legacy_import'").get()) return { skipped: true };
    let count = 0;
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || /^#/.test(line)) continue;
      const m = /^[-*]\s*(?:(\d{4}-\d{2}-\d{2})[：:]\s*)?(.+)$/.exec(line), content = m ? m[2] : line;
      const at = m && m[1] ? Date.parse(m[1] + 'T12:00:00+08:00') : undefined;
      const r = addMemory({ content, source: 'legacy', evidence: { quote: line, at }, at });
      if (r.item && !r.duplicate) count++;
    }
    d.prepare("INSERT INTO memory_meta(key,value) VALUES('legacy_import',?)").run(JSON.stringify({ at: Date.now(), count, digest: crypto.createHash('sha256').update(body).digest('hex') }));
    return { imported: count };
  });
}

// What a role sees. front: the user's own chat; daily: plus Xiaoxin's procedures; worker: only stable non-private profile notes.
export function coreMemory(audience = 'front', max = audience === 'worker' ? 800 : 2000) {
  importLegacyNotebook();
  const types = audience === 'worker' ? ['profile'] : audience === 'daily' ? ['profile', 'learning', 'project', 'self', 'procedure'] : ['profile', 'learning', 'project', 'self'];
  const rows = db().prepare("SELECT * FROM memory_items WHERE status='active' ORDER BY COALESCE(confirmed, updated) DESC").all();
  const parts = [];
  let used = 0, left = 0;
  const section = (title, list) => {
    if (!list.length) return;
    const lines = [];
    for (const it of list) { const line = '- ' + it.content; if (used + line.length > max) { left++; continue; } used += line.length + 1; lines.push(line); }
    if (lines.length) parts.push(title + '\n' + lines.join('\n'));
  };
  for (const t of types) section(MEMORY_TYPES[t] + '：', rows.filter(it => it.type === t));
  if (audience !== 'worker') section('旧记事本里的内容（用户还没确认，只作参考，别当成确定的事实）：', db().prepare("SELECT * FROM memory_items WHERE status='pending' AND source='legacy' ORDER BY created").all());
  if (left) parts.push('（还有 ' + left + ' 条没放进来）');
  return parts.join('\n');
}
