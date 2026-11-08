// Owner-approved raw-chat retention. Nothing deletes until the exact preview is confirmed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {BASE,journal,readJ,readText,okId} from './vm-base.mjs';
import {memoryDb,memoryMeta,setMemoryMeta} from './vm-memory.mjs';
export const RETENTION_DAYS=30;
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const session=sid=>path.join(BASE,'sessions',sid+'.json'),meta=run=>path.join(BASE,'runs',run+'.json');
const normal=s=>s?.agent==='codex'&&!s.kind&&!s.dailyDate;
let ready=false;
function schema(){const d=memoryDb();if(ready)return d;d.exec(`CREATE TABLE IF NOT EXISTS retention_keep(sid TEXT PRIMARY KEY,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS retention_deleted(sid TEXT PRIMARY KEY,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS retention_titles(sid TEXT PRIMARY KEY,title TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS retention_jobs(sid TEXT PRIMARY KEY,body TEXT NOT NULL,state TEXT NOT NULL,at INTEGER NOT NULL,error TEXT);`);journal.defer(()=>{ready=true;});return d;}
export const retentionPolicy=()=>memoryMeta('retention_policy',{enabled:false,days:RETENTION_DAYS});
export const retentionDeleted=sid=>okId(sid,'s')&&!!schema().prepare('SELECT 1 FROM retention_deleted WHERE sid=?').get(sid);
export const retentionTitle=sid=>schema().prepare('SELECT * FROM retention_titles WHERE sid=?').get(sid);
function sessions(){let names=[];try{names=fs.readdirSync(path.join(BASE,'sessions'));}catch{}
 return names.filter(n=>/^s[0-9a-z]{6,24}\.json$/.test(n)).flatMap(n=>{const s=readJ(path.join(BASE,'sessions',n));return s?.sid+'.json'===n?[s]:[];});}
function processed(s){
 const runs=(s.runs||[]).filter(r=>okId(r,'r')),cursor=memoryMeta('idle_cursor:'+s.sid);if(!cursor||cursor.offset)return false;
 const index=runs.indexOf(cursor.run);if(index<0)return false;
 for(let i=index+1;i<runs.length;i++){const m=readJ(meta(runs[i]));if(!m||!m.kind&&!m.task)return false;}
 const es=readText(path.join(BASE,'runs',cursor.run+'.jsonl')).split('\n').flatMap(l=>{try{const e=JSON.parse(l);return e.t==='user'?[e]:[];}catch{return [];}});
 return cursor.event>=es.length;
}
const reasonText={kept:'已长期保留',recent:'最近 30 天内仍有活动',unprocessed:'原话尚未整理完',busy:'对话或后台任务尚未结束',unknown:'记录不完整，先保留',shared:'AI 会话仍由其他对话使用'};
function viewedAt(sid){
 const time=file=>{try{const st=fs.lstatSync(file);return st.isFile()?st.mtimeMs:0;}catch{return 0;}};
 let at=time(path.join(BASE,'runs','conv-'+sid+'.seen'));
 const root=path.join(BASE,'presence',sid);try{for(const device of fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()))for(const tab of fs.readdirSync(path.join(root,device.name)))at=Math.max(at,time(path.join(root,device.name,tab)));}catch{}
 return at;
}
function catalog(now=Date.now()){
 const d=schema(),all=sessions(),eligible=[],excluded=[],rule=retentionPolicy();
 for(const s of all.filter(s=>okId(s.sid,'s')&&normal(s)&&!retentionDeleted(s.sid))){
  const tasks=all.filter(t=>t.agent==='codex'&&t.kind==='task'&&t.parent===s.sid),group=[s,...tasks],last=Math.max(Number(s.updated)||Number(s.created)||0,...group.map(t=>viewedAt(t.sid)),...group.flatMap(t=>(t.runs||[]).map(r=>Number(readJ(meta(r))?.ended)||Number(readJ(meta(r))?.started)||0)));
  let reason=d.prepare('SELECT 1 FROM retention_keep WHERE sid=?').get(s.sid)?'kept':!last?'unknown':last>now-RETENTION_DAYS*86400e3?'recent':null;
  if(!reason&&group.some(t=>(t.runs||[]).some(r=>!okId(r,'r')||!readJ(meta(r))?.ended)||t.kind==='task'&&!['done','failed','stopped'].includes(t.status)))reason='busy';
  if(!reason&&!processed(s))reason='unprocessed';
  if(!reason&&group.some(t=>t.agentSid&&all.some(x=>!group.some(y=>y.sid===x.sid)&&x.agent===t.agent&&x.agentSid===t.agentSid)))reason='shared';
  if(!reason&&group.some(t=>!okId(t.sid,'s')))reason='unknown';
  if(!reason&&group.some(t=>t.agentSid&&(!/^[a-f0-9-]{36}$/i.test(t.agentSid)||readJ(path.join(BASE,'agent-sessions','codex-'+t.agentSid.toLowerCase()+'.json'))?.id!==t.agentSid.toLowerCase())))reason='unknown';
  const entry={sid:s.sid,title:String(s.title||'一段对话').slice(0,100),lastActivity:last,runs:group.reduce((n,t)=>n+(t.runs||[]).length,0),tasks:tasks.length,keep:reason==='kept'};
  if(reason)excluded.push({...entry,reason,reasonText:reasonText[reason]});else eligible.push({...entry,group:group.map(t=>({sid:t.sid,title:String(t.title||''),agentSid:t.agentSid||null,workspace:t.workspace?{home:t.workspace.home}:null,runs:t.runs||[]}))});
 }
 const digest=sha(JSON.stringify({version:1,impact:IMPACT,eligible,excluded:excluded.filter(x=>x.keep),days:RETENTION_DAYS}));
 return {enabled:rule.enabled===true,days:RETENTION_DAYS,eligible,excluded,digest};
}
const IMPACT=['删除所列对话及其已结束任务的原话、上下文和回执。','清理网站和云电脑本地的 SQLite、回忆索引、网页拥有的 Codex 会话副本和通知队列；未清完会显示待处理。','保留记忆中的短引文、日期和对话标题；保留项目文件、交付物以及天启会话。','模型服务商的云端记录不在这项本地保留规则内。','开启后，同样规则也适用于未来已整理且 30 天不再活动的默认对话。'];
export function retentionPreview(now=Date.now()){
 const p=catalog(now),token=crypto.randomBytes(20).toString('hex');setMemoryMeta('retention_preview',{token,digest:p.digest,at:now});
 return {...p,eligible:p.eligible.map(({group,...e})=>e),token,impact:IMPACT,pending:schema().prepare("SELECT sid,state,error FROM retention_jobs WHERE state!='done'").all()};
}
export function setRetention(a={},now=Date.now()){
 return journal.atomic(()=>{
  if(a.enabled===false){setMemoryMeta('retention_policy',{...retentionPolicy(),enabled:false});return {ok:true,enabled:false};}
  const seen=memoryMeta('retention_preview'),p=catalog(now);
  if(a.enabled!==true||a.confirm!=='processed-chat-30-days'||!seen||seen.token!==a.token||now-seen.at>15*60e3||seen.digest!==p.digest)return {error:'preview_required',msg:'请先查看最新删除清单，再明确确认；清单变化后需要重新查看。'};
  setMemoryMeta('retention_policy',{enabled:true,days:RETENTION_DAYS,approvedAt:now,approvedDigest:p.digest});return {ok:true,enabled:true,count:p.eligible.length};
 });
}
export function keepConversation(a={}){
 if(!okId(a.sid,'s')||!normal(readJ(session(a.sid)))||typeof a.keep!=='boolean')return {error:'bad_session'};
 return journal.atomic(()=>{const d=schema();if(a.keep)d.prepare('INSERT INTO retention_keep(sid,at) VALUES(?,?) ON CONFLICT(sid) DO UPDATE SET at=excluded.at').run(a.sid,Date.now());else d.prepare('DELETE FROM retention_keep WHERE sid=?').run(a.sid);return {ok:true,keep:a.keep};});
}
// Native session cleanup is supplied by the controller, which owns and validates those session registries.
export function prepareRetentionDelete(sid,now=Date.now()){
 return journal.atomic(()=>{
  if(!retentionPolicy().enabled)return {error:'disabled'};
  const p=catalog(now),e=p.eligible.find(x=>x.sid===sid);if(!e)return {error:'no_longer_eligible'};
  const d=schema();d.exec('PRAGMA secure_delete=ON');
  for(const s of e.group){
   d.prepare('INSERT OR IGNORE INTO retention_titles(sid,title,at) VALUES(?,?,?)').run(s.sid,s.title,now);
   d.prepare('INSERT OR IGNORE INTO retention_deleted(sid,at) VALUES(?,?)').run(s.sid,now);
   journal.dropConversation(s.sid,s.runs);
   for(const r of s.runs)d.prepare('DELETE FROM commands WHERE id LIKE ?').run('front:'+r+':%');
   if(d.prepare("SELECT 1 FROM sqlite_master WHERE name='recall_fts'").get()){d.prepare('DELETE FROM recall_fts WHERE sid=?').run(s.sid);d.prepare('DELETE FROM recall_sources WHERE sid=?').run(s.sid);}
  }
  for(const n of d.prepare("SELECT name,body FROM documents WHERE name GLOB 'outbox/*.json'").all()){
   let v;try{v=JSON.parse(n.body);}catch{continue;}
   if(v.parent===sid||v.msg?.url==='/#xin='+sid)d.prepare('DELETE FROM documents WHERE name=?').run(n.name);
  }
  // This is a rebuildable cache; finished task summaries also contain result excerpts.
  d.prepare("DELETE FROM documents WHERE name='tasks-index.json'").run();
  d.prepare('INSERT INTO retention_jobs(sid,body,state,at) VALUES(?,?,?,?) ON CONFLICT(sid) DO UPDATE SET body=excluded.body,state=excluded.state,error=NULL').run(sid,JSON.stringify(e),'pending',now);
  return {ok:true,sid};
 });
}
function unlink(file){try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
export function finishRetentionDelete(sid,cleanupNative,canContinue=()=>true){
 const d=schema(),job=d.prepare("SELECT * FROM retention_jobs WHERE sid=? AND state!='done'").get(sid);if(!job)return {ok:true,already:true};
 try{
  const e=JSON.parse(job.body);
  if(e.sid!==sid||!Array.isArray(e.group)||e.group.some(s=>!okId(s.sid,'s')||!Array.isArray(s.runs)||s.runs.some(run=>!okId(run,'r'))))throw Error('bad_cleanup_plan');
  for(const s of e.group){
   if(!canContinue())throw Error('interrupted');
   for(const run of s.runs){if(!okId(run,'r'))throw Error('bad_run');for(const suffix of ['.json','.jsonl','.seen','.front.json'])unlink(path.join(BASE,'runs',run+suffix));}
   unlink(session(s.sid));unlink(path.join(BASE,'contexts',s.sid+'.json'));unlink(path.join(BASE,'runs','conv-'+s.sid+'.seen'));
   const native=cleanupNative(s);if(native?.error)throw Error('native_copy_pending');
  }
  let names=[];try{names=fs.readdirSync(path.join(BASE,'outbox'));}catch{}
  for(const n of names.filter(n=>/^[a-f0-9]{32}\.json$/.test(n))){const file=path.join(BASE,'outbox',n),v=readJ(file);if(v?.parent===sid||v?.msg?.url==='/#xin='+sid)unlink(file);}
  unlink(path.join(BASE,'tasks-index.json'));
  d.prepare("UPDATE retention_jobs SET state='done',body=?,error=NULL WHERE sid=?").run(JSON.stringify({sid,runs:e.runs,tasks:e.tasks}),sid);
  return {ok:true};
 }catch{
  d.prepare("UPDATE retention_jobs SET state='pending',error='有副本尚未清完，下次空闲重试' WHERE sid=?").run(sid);return {error:'cleanup_pending'};
 }
}
export function retentionDue(now=Date.now()){return retentionPolicy().enabled?catalog(now).eligible.map(e=>e.sid):[];}
export function retentionPending(){return schema().prepare("SELECT sid FROM retention_jobs WHERE state!='done'").all().map(e=>e.sid);}

// Remove only an owned session's rows. In-place blanking keeps unrelated concurrent history appends.
export function purgeCodexIndexes(home,id){
 if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('bad_native_id');id=id.toLowerCase();
 let names=[];try{names=fs.readdirSync(home);}catch(e){if(e.code==='ENOENT')return;throw e;}
 const quote=s=>'"'+s.replaceAll('"','""')+'"';
 for(const name of names.filter(n=>/^(?:state|history)(?:_\d+)?\.sqlite$/.test(n))){
  const file=path.join(home,name);if(fs.lstatSync(file).isSymbolicLink())throw Error('native_index_symlink');
  const d=new DatabaseSync(file);try{
   d.exec('PRAGMA busy_timeout=1000;PRAGMA secure_delete=ON;BEGIN IMMEDIATE');
   const tables=d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all(),ordered=[],seen=new Set();
   const visit=t=>{if(seen.has(t.name))return;seen.add(t.name);for(const child of tables)if(d.prepare('PRAGMA foreign_key_list('+quote(child.name)+')').all().some(f=>f.table===t.name))visit(child);ordered.push(t);};tables.forEach(visit);
   for(const t of ordered){
    const cols=d.prepare('PRAGMA table_info('+quote(t.name)+')').all().filter(c=>['id','thread_id','session_id'].includes(c.name));
    for(const c of cols)d.prepare('DELETE FROM '+quote(t.name)+' WHERE '+quote(c.name)+'=?').run(id);
   }
   d.exec('COMMIT');const ck=d.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(ck?.busy)throw Error('native_index_busy');
  }catch(e){try{d.exec('ROLLBACK');}catch{}throw e;}finally{d.close();}
 }
 const file=path.join(home,'history.jsonl');let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);const st=fs.fstatSync(fd);if(!st.isFile()||st.size>64*1024*1024)throw Error('native_history_unavailable');
  const bytes=fs.readFileSync(fd);let start=0;
  for(let end=0;end<=bytes.length;end++)if(end===bytes.length||bytes[end]===10){
   const line=bytes.subarray(start,end).toString('utf8');let v;try{v=JSON.parse(line);}catch{if(line.includes(id))throw Error('native_history_ambiguous');}
   if(String(v?.session_id||v?.sessionId||'').toLowerCase()===id){const current=Buffer.alloc(end-start);fs.readSync(fd,current,0,current.length,start);if(!current.equals(bytes.subarray(start,end)))throw Error('native_history_changed');fs.writeSync(fd,Buffer.alloc(end-start,32),0,end-start,start);}
   start=end+1;
  }
  fs.fsyncSync(fd);const after=fs.statSync(file);if(after.ino!==st.ino||after.dev!==st.dev)throw Error('native_history_changed');
 }catch(e){if(e.code!=='ENOENT')throw e;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
