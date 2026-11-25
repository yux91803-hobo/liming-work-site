// Execution identity fences late reports. It is not an authorization credential.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Publish the reader/bridge before enabling allocation, so the rollback target understands in-flight attempts.
export const ATTEMPTS_DEFAULT = true;
export const attemptsEnabled = (env = process.env) => env.XIN_RUN_ATTEMPTS === '1' || env.XIN_RUN_ATTEMPTS !== '0' && ATTEMPTS_DEFAULT;
export const nextAttempt = meta => meta?.attempt || meta?.attemptProtocol === 1 ? crypto.randomBytes(16).toString('hex') : null;
export const staleAttempt = () => ({ error: 'stale_attempt', msg: '这一轮的执行尝试已过期，报告未应用' });
export function attemptError(meta, { run, attempt } = {}) {
  if (!meta?.attempt && !attempt) return null; // Old in-flight runners remain untagged until they exit.
  return run && meta?.run === run && meta.attempt && meta.attempt === attempt ? null : staleAttempt();
}
export function assertAttempt(meta, context) {
  const error = attemptError(meta, context);
  if (error) throw Object.assign(new Error(error.msg), { code: error.error });
}

export const FINALIZATION_DEFAULT = true;
export const finalizationEnabled = (env = process.env) => env.XIN_RUN_FINALIZATION === '1' || env.XIN_RUN_FINALIZATION !== '0' && FINALIZATION_DEFAULT;
export const hasFinalization = m => m?.finalProtocol === 1 && /^r[0-9a-z]{6,24}$/.test(m.run) && /^[a-f0-9]{32}$/.test(m.attempt);
const MAX_BYTES = 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const PHASES = ['prepared', 'steer', 'budget', 'publication-plan', 'ready', 'intent', 'effects'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, names) => object(value) && Object.keys(value).every(key => Object.hasOwn(names, key) && names[key](value[key]));
const optional = test => x => x === undefined || test(x);
const string = limit => x => typeof x === 'string' && x.length <= limit;
const hex = x => typeof x === 'string' && DIGEST.test(x);
const number = x => Number.isFinite(x) && x >= 0;
const bool = x => typeof x === 'boolean';
const at = x => Number.isSafeInteger(x) && x > 0;
const usage = x => keys(x, {input:number, output:number, cached:number, ctx:number, win:number, total:number, incl:bool});
const viewports = x => Array.isArray(x) && x.length <= 4 && x.every(v => keys(v, {width:number, checks:number}));
const browserCheck = x => keys(x, {ok:bool, error:string(1200), entry:string(2048), digest:hex, viewports}) && bool(x.ok) && (!x.ok || hex(x.digest));
const changes = x => keys(x, {agentSid:string(100), started:bool, ctxWin:number, hUsage:usage, frontUsage:usage});
const steerClaims = x => Array.isArray(x) && x.length > 0 && x.length <= 128 && x.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{4,80}$/.test(id));
const steer = x => keys(x, {prepared:hex, claims:steerClaims}) && hex(x.prepared) && steerClaims(x.claims);
const budgetSample = x => keys(x, {
  id: id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id),
  sid: sid => typeof sid === 'string' && /^s[0-9a-z]{6,24}$/.test(sid),
  run: run => typeof run === 'string' && /^r[0-9a-z]{6,24}$/.test(run),
  action: action => ['usage','cumulative'].includes(action),
  provider: provider => provider === 'antigravity',
  conversation: conversation => typeof conversation === 'string' && /^[0-9a-zA-Z_-]{1,96}$/.test(conversation),
  usage: v => v === null || object(v)
}) && typeof x.id === 'string' && typeof x.sid === 'string' && typeof x.run === 'string' && ['usage','cumulative'].includes(x.action);
const budget = x => keys(x, {prepared:hex, samples:v=>Array.isArray(v)&&v.length<=128&&v.every(budgetSample)}) && hex(x.prepared) && Array.isArray(x.samples);
const fileHashes = x => {
  if (!object(x)) return false;
  const entries = Object.entries(x);
  return entries.length <= 10000 && entries.every(([name, hash]) => name.length <= 4096 && !name.includes('\0') &&
    name.split('/').every(part => part && part !== '.' && part !== '..') && hex(hash));
};
const publicationPlan = x => keys(x, {prepared:hex, inventory:hex, workVersion:hex, originalVersion:hex, after:fileHashes, current:fileHashes}) &&
  Object.keys(x).length === 6;
const prepared = x => keys(x, {at, code:Number.isSafeInteger, ok:bool, timeout:bool, transient:bool, changes,
  usage: v => v === null || usage(v), delta:usage, cost:number, ms:number, reply:string(20000),
  model:string(128), providerModel:string(128), from:string(128), recordStats:bool}) &&
  at(x.at) && Number.isSafeInteger(x.code) && bool(x.ok) && bool(x.timeout) && bool(x.transient) && changes(x.changes) &&
  (x.usage === null || usage(x.usage)) && number(x.ms) && bool(x.recordStats);
const ready = x => keys(x, {prepared:hex, workspace:hex, webCheck:browserCheck, pageCheck:browserCheck, compileTrusted:bool,
  compileOk:bool, compileDigest:hex}) && hex(x.prepared);
const intent = x => keys(x, {ready:hex, inventory:hex}) && hex(x.ready) && hex(x.inventory);
const names = x => Array.isArray(x) && x.length <= 10000 && x.every(string(4096));
const publication = x => keys(x, {ok:bool, pending:bool, id:string(80), files:number, backup:string(4096),
  deleted:d => number(d) || names(d), changes:names, conflicts:names}) && (x.ok === true ||
    x.pending === true && /^publish-[a-f0-9]{64}$/.test(x.id) && names(x.changes) && names(x.deleted) && names(x.conflicts));
const clickCheck = x => keys(x, {selector:string(200), expectSelector:string(200), expectText:string(200),
  expectClass:string(80), expectAttribute:a=>keys(a,{name:string(128),value:string(200)})});
const preview = x => keys(x, {id:string(32), title:string(80), url:string(128), ready:bool, run:string(25), at,
  viewports, checks: c => Array.isArray(c) && c.length <= 8 && c.every(clickCheck)}) &&
  /^[a-f0-9]{32}$/.test(x.id) && x.ready === true && x.url === '/xin/preview.html?id=' + x.id;
const verification = x => keys(x, {applicable:bool, compiled:bool, reviewed:bool, hardware:bool}) && bool(x.applicable);
const effects = x => keys(x, {intent:hex, publication, preview, verification, error:string(2000), retry:v=>v==='web'||v==='validation'}) && hex(x.intent);
const validators = { prepared, steer, budget, 'publication-plan':publicationPlan, ready, intent, effects };
const invalid = () => Object.assign(Error('收尾记录无法验证'), { code: 'finalization_invalid' });
const conflict = () => Object.assign(Error('同一执行尝试的收尾内容发生冲突'), { code: 'finalization_conflict' });
const absent = e => e.code === 'ENOENT';

function privateDirectory(file, create = false) {
  if (create) {
    try { fs.mkdirSync(file, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const s = fs.lstatSync(file);
  if (!s.isDirectory() || (s.mode & 0o777) !== 0o700 || s.uid !== process.getuid()) throw invalid();
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function loadFinalization(file, meta, phase) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || (s.mode & 0o777) !== 0o600 || s.uid !== process.getuid() || s.size <= 65 || s.size > MAX_BYTES) throw invalid();
    const bytes = Buffer.alloc(s.size + 1);
    let size = 0;
    for (let n; size < bytes.length && (n = fs.readSync(fd, bytes, size, bytes.length - size)) > 0; ) size += n;
    if (size !== s.size || bytes[64] !== 10) throw invalid();
    const hash = bytes.toString('ascii', 0, 64), body = bytes.subarray(65, size);
    if (!hex(hash) || hash !== digest(body)) throw invalid();
    let entry;
    try { entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw invalid(); }
    if (!keys(entry, {v:x=>x===1, phase:x=>x===phase, run:x=>x===meta.run, attempt:x=>x===meta.attempt,
      sid:x=>x===meta.sid, data:validators[phase]}) || Object.keys(entry).length !== 6) throw invalid();
    return { state:'valid', digest:hash, data:entry.data };
  } finally { fs.closeSync(fd); }
}

export function createFinalizationStore(base) {
  const root = path.join(base, 'finalization');
  function directory(meta, phase, create) {
    if (!hasFinalization(meta) || !/^s[0-9a-z]{6,24}$/.test(meta.sid) || !PHASES.includes(phase)) throw invalid();
    privateDirectory(root, create);
    const dir = path.join(root, meta.run + '.' + meta.attempt);
    privateDirectory(dir, create);
    return dir;
  }
  function read(meta, phase) {
    try {
      const dir = directory(meta, phase, false);
      try { return loadFinalization(path.join(dir, phase), meta, phase); }
      catch (e) {
        if (!absent(e)) throw e;
        const partial = fs.readdirSync(dir).some(n => n.startsWith(phase + '.') && n.endsWith('.tmp'));
        return { state:partial ? 'partial' : 'missing' };
      }
    } catch (e) { return { state:absent(e) ? 'missing' : 'invalid' }; }
  }
  function write(meta, phase, data, { flushEvents = false } = {}) {
    const body = Buffer.from(JSON.stringify({v:1, phase, run:meta.run, attempt:meta.attempt, sid:meta.sid, data}));
    if (body.length + 65 > MAX_BYTES || !Object.hasOwn(validators, phase)) throw invalid();
    const normalized = JSON.parse(body).data;
    if (!validators[phase](normalized)) throw invalid();
    const hash = digest(body), dir = directory(meta, phase, true), target = path.join(dir, phase);
    const prior = read(meta, phase);
    if (prior.state === 'valid') { if (prior.digest !== hash) throw conflict(); return prior; }
    if (prior.state === 'invalid') throw invalid();
    const tmp = path.join(dir, phase + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      // Retain evidence of an interrupted write. A complete hard link is published without replacing an older result.
      try {
        syncDirectory(base); syncDirectory(root); syncDirectory(dir);
        if (flushEvents) {
          const runs = path.join(base, 'runs'), file = path.join(runs, meta.run + '.jsonl');
          try {
            const log = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            try { if (!fs.fstatSync(log).isFile()) throw invalid(); fs.fsyncSync(log); } finally { fs.closeSync(log); }
            syncDirectory(runs);
          } catch (e) { if (!absent(e)) throw e; } // A silent handoff can finish without a prior log line.
        }
        fs.writeFileSync(fd, Buffer.concat([Buffer.from(hash + '\n'), body])); fs.fsyncSync(fd);
      }
      finally { fs.closeSync(fd); }
      try { fs.linkSync(tmp, target); }
      catch (e) { if (e.code !== 'EEXIST' || loadFinalization(target, meta, phase).digest !== hash) throw conflict(); }
      syncDirectory(dir);
    } catch (e) { throw Object.assign(invalid(), { code:e.code === 'finalization_conflict' ? e.code : 'finalization_invalid' }); }
    fs.unlinkSync(tmp);
    return { state:'valid', digest:hash, data:normalized };
  }
  function forget(runs) {
    const own = new Set(runs);
    try {
      privateDirectory(root);
      for (const name of fs.readdirSync(root)) {
        const match = /^(r[0-9a-z]{6,24})\.[a-f0-9]{32}$/.exec(name);
        if (match && own.has(match[1])) fs.rmSync(path.join(root, name), {recursive:true,force:true});
      }
    } catch { /* An ordinary forget remains usable without finalization files. */ }
  }
  return { read, write, forget };
}

export function finalizationEvidence(store, meta) {
  if (!hasFinalization(meta)) return null;
  const prepared = store.read(meta, 'prepared'), ready = store.read(meta, 'ready');
  if (prepared.state === 'missing' && ready.state === 'missing') return null;
  if (prepared.state === 'valid' && ready.state === 'valid' && ready.data.prepared === prepared.digest)
    return { prepared, ready };
  const reason = ready.state === 'invalid' || prepared.state === 'invalid' || ready.state === 'valid' ? 'invalid' :
    ready.state === 'partial' || prepared.state === 'partial' ? 'partial' : 'prepared';
  return { reason, ...(prepared.state === 'valid' ? {prepared} : {}) };
}
