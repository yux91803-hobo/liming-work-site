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
const SCHEMA = `CREATE TABLE IF NOT EXISTS memory_items (id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, norm TEXT NOT NULL,
        basis TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, confirmed INTEGER);
      CREATE TABLE IF NOT EXISTS memory_evidence (item TEXT NOT NULL, sid TEXT, run TEXT, quote TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_log (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_forgotten (norm TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, body TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_replacements (old TEXT PRIMARY KEY, next TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_proposals (item TEXT PRIMARY KEY, replaces TEXT, scope TEXT NOT NULL DEFAULT 'long-term');
      CREATE TABLE IF NOT EXISTS memory_observations (item TEXT NOT NULL, sid TEXT NOT NULL, run TEXT NOT NULL, quote_hash TEXT NOT NULL, day TEXT NOT NULL, topic TEXT NOT NULL,
        PRIMARY KEY(item,sid,run,quote_hash));
      CREATE TABLE IF NOT EXISTS memory_blocked_sources (sid TEXT NOT NULL, run TEXT NOT NULL, PRIMARY KEY(sid,run));
      CREATE TABLE IF NOT EXISTS memory_retired (norm TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_suppressed_phrases (hash TEXT PRIMARY KEY, length INTEGER NOT NULL, fingerprint INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_by_status ON memory_items(status, type, updated);
      CREATE INDEX IF NOT EXISTS memory_evidence_item ON memory_evidence(item);`;
const SCHEMA_NAMES = [...SCHEMA.matchAll(/CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/g)].map(m => m[1]);
function db() {
  const d = journal.db;
  if (!ready) {
    // 表和索引都在就不碰：读记忆不需要写权限（状态库归别的进程写的时候也能读）。缺了才建，建表是写，要过所有权检查。
    const have = d.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (' + SCHEMA_NAMES.map(() => '?').join(',') + ')').get(...SCHEMA_NAMES).n;
    if (have < SCHEMA_NAMES.length) journal.writing(() => d.exec(SCHEMA));
    // DDL participates in the caller's transaction too. Do not cache schema readiness before commit:
    // a rejected first command can roll the new tables back while this process continues running.
    if (journal.active) journal.defer(() => { ready = true; }); else ready = true;
  }
  return d;
}

const clean = text => String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, ITEM_MAX);
// Normalised form for duplicates and forgetting: width-folded, lower-case, no spaces or punctuation.
export const memoryNorm = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const hash = norm => crypto.createHash('sha256').update(norm).digest('hex');
const rolling = text => { let h=0;for(let i=0;i<text.length;i++)h=(Math.imul(h,31)+text.charCodeAt(i))>>>0;return h; };
function suppressPhrase(text) {
  const norm=memoryNorm(text);if(!norm)return;
  db().prepare('INSERT OR IGNORE INTO memory_suppressed_phrases(hash,length,fingerprint) VALUES(?,?,?)').run(hash(norm),norm.length,rolling(norm));
}
let textRules=null;
export function memoryBlockedText(text, at=Date.now()) {
  const revision=memoryMeta('revision');
  if(!textRules||textRules.revision!==revision){
    const phrases=db().prepare('SELECT * FROM memory_suppressed_phrases').all(),groups=new Map();
    for(const p of phrases){if(!groups.has(p.length))groups.set(p.length,new Map());const g=groups.get(p.length);if(!g.has(p.fingerprint))g.set(p.fingerprint,new Set());g.get(p.fingerprint).add(p.hash);}
    // Legacy forgetting stored only an irreversible hash, without a source or phrase length. Old raw
    // text cannot safely be classified in that case; never send text older than that decision back.
    const opaque=db().prepare('SELECT max(f.at) AS at FROM memory_forgotten f LEFT JOIN memory_suppressed_phrases p ON p.hash=f.norm WHERE p.hash IS NULL').get().at||0;
    textRules={revision,groups,opaque};
  }
  if(textRules.opaque && at<=textRules.opaque)return true;
  const norm=memoryNorm(text);
  for(const [len,patterns] of textRules.groups){
    if(len>norm.length)continue;
    let power=1,h=rolling(norm.slice(0,len));for(let i=1;i<len;i++)power=Math.imul(power,31)>>>0;
    for(let i=0;i<=norm.length-len;i++){
      const candidates=patterns.get(h);if(candidates?.has(hash(norm.slice(i,i+len))))return true;
      if(i+len<norm.length)h=(Math.imul((h-Math.imul(norm.charCodeAt(i),power))>>>0,31)+norm.charCodeAt(i+len))>>>0;
    }
  }
  return false;
}

// 学习记录、主动跟进（下次见面的开场白）：站长 2026-11-11 说小芯不是专门为学习做的，这两项不要。网页上不再有开关，默认关；
// 代码和已存数据都留着，只有明确设成 true 才会再开。
export const memoryPreferences=()=>({followups:memoryMeta('preferences',{}).followups===true,learning:memoryMeta('preferences',{}).learning===true});
export function setMemoryPreferences(changes) {
  const keys=['followups','learning'].filter(k=>Object.hasOwn(changes||{},k));
  if(!keys.length||keys.some(k=>typeof changes[k]!=='boolean'))return {error:'bad_setting',msg:'开关值不对'};
  return journal.atomic(()=>{setMemoryMeta('preferences',{...memoryPreferences(),...Object.fromEntries(keys.map(k=>[k,changes[k]]))});return memoryPreferences();});
}
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
  setMemoryMeta('revision', crypto.randomUUID());
}
function evidence(item, e, at = Date.now()) {
  if (!e) return;
  const quote = String(e.quote || '').slice(0, 200); // Preserve the user's exact whitespace and punctuation.
  if (!quote && !e.sid) return;
  if (!db().prepare('SELECT 1 FROM memory_evidence WHERE item=? AND sid IS ? AND run IS ? AND quote=?').get(item, e.sid || null, e.run || null, quote)) {
    db().prepare('INSERT INTO memory_evidence(item,sid,run,quote,at) VALUES(?,?,?,?,?)').run(item, e.sid || null, e.run || null, quote, e.at || at);
    // A run that becomes the source of a private item leaves the recall index; consumers key their caches on the revision.
    if (e.sid && e.run) setMemoryMeta('revision', crypto.randomUUID());
  }
}
const row = id => db().prepare('SELECT * FROM memory_items WHERE id=?').get(id);

// Shared with the controller's idle reviewer. No model can execute these helpers.
export const memoryDb = () => db();
export function memoryMeta(key, fallback = null) {
  const r = db().prepare('SELECT value FROM memory_meta WHERE key=?').get(key);
  try { return r ? JSON.parse(r.value) : fallback; } catch { return fallback; }
}
export function setMemoryMeta(key, value) {
  db().prepare('INSERT INTO memory_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}
export function memorySnapshot(id, reason) {
  const item = row(id);
  if (item) db().prepare('INSERT INTO memory_versions(item,body,reason,at) VALUES(?,?,?,?)').run(id,
    JSON.stringify({ item, evidence: db().prepare('SELECT * FROM memory_evidence WHERE item=?').all(id) }), reason, Date.now());
}
export function memoryBlocked(content, ev) {
  return !!db().prepare('SELECT 1 FROM memory_forgotten WHERE norm=?').get(hash(memoryNorm(content))) ||
    !!(ev?.sid && ev?.run && db().prepare('SELECT 1 FROM memory_blocked_sources WHERE sid=? AND run=?').get(ev.sid, ev.run)) ||
    !!(Number.isFinite(ev?.at) && db().prepare('SELECT 1 FROM memory_retired WHERE norm=? AND at>=?').get(hash(memoryNorm(content)),ev.at));
}
function retireSources(it) {
  db().prepare('INSERT INTO memory_retired(norm,at) VALUES(?,?) ON CONFLICT(norm) DO UPDATE SET at=excluded.at').run(hash(it.norm),Date.now());
  for (const e of db().prepare('SELECT sid,run FROM memory_evidence WHERE item=?').all(it.id))
    if (e.sid && e.run) db().prepare('INSERT OR IGNORE INTO memory_blocked_sources(sid,run) VALUES(?,?)').run(e.sid,e.run);
}

export function supersedeMemory(oldId, nextId, actor = 'idle') {
  const old = row(oldId), next = row(nextId);
  if (!old || !next || oldId === nextId || !['active','pending'].includes(old.status) || next.status !== 'active') return false;
  memorySnapshot(oldId, 'supersede');
  db().prepare("UPDATE memory_items SET status='superseded',updated=? WHERE id=?").run(Date.now(), oldId);
  db().prepare('INSERT INTO memory_replacements(old,next,at) VALUES(?,?,?) ON CONFLICT(old) DO UPDATE SET next=excluded.next,at=excluded.at').run(oldId, nextId, Date.now());
  retireSources(old);
  log(oldId, 'supersede', actor, { next: nextId });
  return true;
}

// A rollback is an explicit user action, never an idle-model operation. Forgotten items have no snapshot to restore.
export function restoreMemoryVersion(version) {
  return journal.atomic(() => {
    const v = db().prepare('SELECT * FROM memory_versions WHERE id=?').get(version);
    if (!v || !row(v.item)) return { error: 'not_found' };
    const saved = JSON.parse(v.body), it = saved.item;
    const replacement = db().prepare('SELECT next FROM memory_replacements WHERE old=?').get(it.id);
    if (replacement && row(replacement.next)?.status === 'active') {
      memorySnapshot(replacement.next, 'rollback');
      retireSources(row(replacement.next));
      db().prepare("UPDATE memory_items SET status='pending',updated=? WHERE id=?").run(Date.now(), replacement.next);
    }
    memorySnapshot(it.id, 'rollback');
    db().prepare('UPDATE memory_items SET type=?,content=?,norm=?,basis=?,status=?,confirmed=?,updated=? WHERE id=?')
      .run(it.type, it.content, it.norm, it.status === 'active' ? 'stated' : it.basis, it.status, Date.now(), Date.now(), it.id);
    db().prepare('DELETE FROM memory_replacements WHERE old=?').run(it.id);
    log(it.id, 'rollback', 'user', { version });
    return { item: row(it.id) };
  });
}

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
    if (source !== 'user' && memoryBlocked(text, ev)) return { error: 'forgotten', msg: '用户让我忘掉或纠正过这件事，不再记。' };
    // Only what the user said (or the user's own edits) counts at once; daily procedures are Xiaoxin's own know-how.
    let status = source === 'user' || source === 'daily' || source === 'chat' && basis === 'stated' ? 'active' : 'pending';
    if ((sens === 'personal' || sens === 'word') && source !== 'user') status = 'private';
    const now = Date.now(), same = db().prepare('SELECT * FROM memory_items WHERE norm=? AND status IN ' + LIVE).get(norm);
    if (same) {
      memorySnapshot(same.id, 'evidence');
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
      if (next.norm !== it.norm) retireSources(it);
    }
    if (changes.type && MEMORY_TYPES[changes.type]) next.type = changes.type;
    if (changes.private === true) next.status = 'private';
    else if (changes.private === false && it.status === 'private') next.status = 'active';
    if (changes.confirm) { if (next.status === 'pending') next.status = 'active'; next.confirmed = now; if (next.basis !== 'stated') next.basis = 'stated'; }
    if (changes.content != null && next.status === 'pending') { next.status = 'active'; next.confirmed = now; }
    memorySnapshot(id, 'user_update');
    db().prepare('UPDATE memory_items SET content=?,norm=?,type=?,basis=?,status=?,confirmed=?,updated=? WHERE id=?')
      .run(next.content, next.norm, next.type, next.basis, next.status, next.confirmed, now, id);
    log(id, 'update', actor, { from: { type: it.type, status: it.status }, to: { type: next.type, status: next.status }, edited: changes.content != null });
    const proposal = db().prepare('SELECT replaces FROM memory_proposals WHERE item=?').get(id);
    if (changes.confirm && next.status === 'active' && proposal?.replaces) supersedeMemory(proposal.replaces, id, actor);
    return { item: row(id) };
  });
}

// Only the controller's study reporter calls this. Observed exercise results never become user statements.
export function learningMemory({id,content,quote,at}) {
  return journal.atomic(()=>{
    let it=id&&row(id);
    if(it){
      const userEdit=db().prepare("SELECT 1 FROM memory_log WHERE item=? AND actor='user' AND action IN ('update','supersede','rollback') LIMIT 1").get(id);
      if(userEdit||it.status!=='active'||it.source!=='learning')return {item:it,protected:true};
      if(it.content!==content){memorySnapshot(id,'learning_update');retireSources(it);
        db().prepare('UPDATE memory_items SET content=?,norm=?,updated=? WHERE id=?').run(content,memoryNorm(content),at,id);log(id,'update','learning',{type:'learning'});}
      else db().prepare('UPDATE memory_items SET updated=? WHERE id=?').run(at,id);
    }else{
      const r=addMemory({content,type:'learning',basis:'observed',source:'learning',at});if(r.error)return r;
      it=r.item;if(it.source!=='learning')return {item:it,protected:true};id=it.id;db().prepare("UPDATE memory_items SET status='active' WHERE id=?").run(id);log(id,'activate','learning',{basis:'observed'});
    }
    evidence(id,{quote,at});return {item:row(id)};
  });
}

// Forgetting removes the statement and its quotes; only a hash remains so the same content is not stored again.
export function forgetMemory(id, actor = 'user') {
  return journal.atomic(() => {
    const it = row(id);
    if (!it) return { error: 'not_found', msg: '找不到这条记忆' };
    // Forget the whole chain, including superseded judgements and snapshots. Block the original runs too:
    // a paraphrase extracted from old chat must not recreate what the owner deliberately forgot.
    const ids = new Set([id]);
    const links = db().prepare('SELECT old,next FROM memory_replacements UNION SELECT replaces AS old,item AS next FROM memory_proposals WHERE replaces IS NOT NULL').all();
    for (let n = -1; n !== ids.size;) { n = ids.size; for (const l of links) if (ids.has(l.old) || ids.has(l.next)) { ids.add(l.old); ids.add(l.next); } }
    for (const key of ids) {
      if(db().prepare("SELECT 1 FROM sqlite_master WHERE name='learning_profiles'").get()){
        for(const p of db().prepare('SELECT scope FROM learning_profiles WHERE item=?').all(key)){
          db().prepare('INSERT OR IGNORE INTO learning_blocked(hash,at) VALUES(?,?)').run(hash(p.scope),Date.now());
          db().prepare('DELETE FROM learning_events WHERE scope=?').run(p.scope);
          db().prepare('DELETE FROM learning_profiles WHERE scope=?').run(p.scope);
        }
        db().prepare('DELETE FROM learning_links WHERE item=?').run(key);
      }
      const current = row(key), versions = db().prepare('SELECT body FROM memory_versions WHERE item=?').all(key).map(v => JSON.parse(v.body));
      const all = [...versions, { item: current, evidence: db().prepare('SELECT * FROM memory_evidence WHERE item=?').all(key) }];
      for (const snap of all) {
        if (snap.item) { db().prepare('INSERT OR IGNORE INTO memory_forgotten(norm,at) VALUES(?,?)').run(hash(snap.item.norm), Date.now());suppressPhrase(snap.item.content); }
        for (const e of snap.evidence) {suppressPhrase(e.quote);if (e.sid && e.run) db().prepare('INSERT OR IGNORE INTO memory_blocked_sources(sid,run) VALUES(?,?)').run(e.sid, e.run);}
      }
      db().prepare('DELETE FROM memory_evidence WHERE item=?').run(key);
      db().prepare('DELETE FROM memory_versions WHERE item=?').run(key);
      db().prepare('DELETE FROM memory_observations WHERE item=?').run(key);
      db().prepare('DELETE FROM memory_proposals WHERE item=?').run(key);
      db().prepare('DELETE FROM memory_items WHERE id=?').run(key);
    }
    log(id, 'forget', actor, { type: it.type });
    // The search index is only a cache. Forgetting purges matching cached text in the same transaction.
    if(db().prepare("SELECT 1 FROM sqlite_master WHERE name='recall_fts'").get())for(const r of db().prepare('SELECT rowid,sid,run,text,at FROM recall_fts').all())
      if(memoryBlockedText(r.text,Number(r.at))||memoryBlocked('',r))db().prepare('DELETE FROM recall_fts WHERE rowid=?').run(r.rowid);
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

// The old Markdown notebook is imported as pending items with their original lines as evidence. The file stays.
// Each line is taken in once (remembered by hash). If the old notebook gains lines later — e.g. the previous controller
// ran again after a rollback — only the new lines are imported; lines the user already edited or forgot are not.
const lineHash = line => crypto.createHash('sha256').update(line).digest('hex').slice(0, 24);
export function importLegacyNotebook(text = readText(LEGACY_FILE())) {
  const body = String(text || '').trim();
  if (!body) return { skipped: true };
  const d = db(), digest = crypto.createHash('sha256').update(body).digest('hex'), get = () => d.prepare("SELECT value FROM memory_meta WHERE key='legacy_import'").get();
  const prior = get();
  if (prior && JSON.parse(prior.value).digest === digest) return { skipped: true };
  return journal.atomic(() => {
    const row = get(), meta = row ? JSON.parse(row.value) : null;
    if (meta && meta.digest === digest) return { skipped: true };
    // A record from before line hashes were kept is rebuilt from the lines quoted by imported items.
    const seen = new Set(meta ? meta.lines || d.prepare("SELECT e.quote FROM memory_evidence e JOIN memory_items i ON i.id=e.item WHERE i.source='legacy'").all().map(r => lineHash(r.quote)) : []);
    let count = 0;
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || /^#/.test(line) || seen.has(lineHash(line))) continue;
      seen.add(lineHash(line));
      const m = /^[-*]\s*(?:(\d{4}-\d{2}-\d{2})[：:]\s*)?(.+)$/.exec(line), content = m ? m[2] : line;
      const at = m && m[1] ? Date.parse(m[1] + 'T12:00:00+08:00') : undefined;
      const r = addMemory({ content, source: 'legacy', evidence: { quote: line, at }, at });
      if (r.item && !r.duplicate) count++;
    }
    d.prepare("INSERT INTO memory_meta(key,value) VALUES('legacy_import',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({ at: Date.now(), count: (meta ? meta.count || 0 : 0) + count, digest, lines: [...seen] }));
    return { imported: count };
  });
}

// What a role sees. front: the user's own chat; daily: Xiaoxin's procedures only; worker: only stable non-private profile notes.
export function coreMemory(audience = 'front', max = audience === 'worker' ? 800 : 2000) {
  importLegacyNotebook();
  // The daily routine runs unsandboxed against outside websites: it gets its own procedures, not the owner's profile.
  const types = audience === 'worker' ? ['profile'] : audience === 'daily' ? ['procedure', 'unsorted'] : ['profile', 'learning', 'project', 'self', 'unsorted'];
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
