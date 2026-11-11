// Per-turn guidance and literal cross-conversation recall. Only the controller indexes raw default chat.
import fs from 'node:fs';
import path from 'node:path';
import {BASE,journal,readJ,readText,okId} from './vm-base.mjs';
import {memoryDb,memoryMeta,setMemoryMeta,memoryBlocked,memoryBlockedText,memorySensitivity} from './vm-memory.mjs';
import {learningGuidance} from './vm-learning.mjs';

const sess=sid=>path.join(BASE,'sessions',sid+'.json'),meta=run=>path.join(BASE,'runs',run+'.json'),raw=run=>path.join(BASE,'runs',run+'.jsonl');
const normal=s=>s?.agent==='codex'&&!s.kind&&!s.dailyDate;
const date=at=>new Date(Number(at)+8*3600e3).toISOString().slice(0,16).replace('T',' ');
function schema(){
  const d=memoryDb();
  d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(sid UNINDEXED,run UNINDEXED,event UNINDEXED,role UNINDEXED,at UNINDEXED,title UNINDEXED,text,tokenize='trigram');
    CREATE TABLE IF NOT EXISTS recall_sources (run TEXT PRIMARY KEY,sid TEXT NOT NULL,stamp TEXT NOT NULL);`);
  return d;
}
function events(run){return readText(raw(run)).split('\n').flatMap(line=>{try{const e=JSON.parse(line);return e.t==='user'||e.t==='text'?[e]:[];}catch{return [];}});}
// Only spans that are themselves a credential or an identity number. Commit hashes, UUIDs, preview ids and long
// identifiers are ordinary conversation, not secrets.
const SECRET_SPANS=[[/((?:密码|口令|验证码|动态码|校验码|\bpassword\b|\bpasswd\b|\bpin\b)\s*(?:是|为|:|：|=)?\s*)[A-Za-z0-9!@#$%^&*._-]{4,}/gi,'$1（已隐藏）'],
  [/\b(?:sk|ibk|ghp|gho|github_pat|xox[abp]|AKIA)[-_A-Za-z0-9]{8,}/g,'（已隐藏）'],[/(?<!\d)\d{17}[\dXx](?!\d)/g,'（已隐藏）'],[/(?<!\d)\d{16,19}(?!\d)/g,'（已隐藏）']];
export function redactSecrets(text){let s=String(text||'');for(const [re,to] of SECRET_SPANS)s=s.replace(re,to);return s;}
// scope 'recall': what may be indexed for other conversations — a turn with anything sensitive stays out entirely.
// scope 'own': the same conversation's context for the next turn. The owner just said these words here, so the turn
// is kept and only credential-like spans are masked; dropping it made the foreground forget whole turns.
// Deliberately forgotten content is excluded in both scopes.
export function safeContextEvents(run, read=events, scope='recall'){
  const m=readJ(meta(run));if(!m||m.agent!=='codex'||!normal(readJ(sess(m.sid)))||m.task||m.kind&&m.kind!=='handoff'||memoryBlocked('',{sid:m.sid,run}))return [];
  const own=scope==='own',d=memoryDb();
  if(!own&&d.prepare("SELECT 1 FROM memory_evidence e JOIN memory_items i ON i.id=e.item WHERE e.sid=? AND e.run=? AND i.status='private' LIMIT 1").get(m.sid,run))return [];
  const es=read(run).filter(e=>m.kind==='handoff'?e.t==='text'&&e.taskResult:e.t==='user'||e.t==='text');
  if(es.some(e=>memoryBlockedText(e.text||'',Number(e.at)||m.started||0)))return [];
  if(own)return es.map(e=>({...e,text:redactSecrets(e.text)}));
  if(es.some(e=>memorySensitivity(e.text||'')))return [];
  return es;
}
export function syncRecall(){
  const d=schema(),valid=new Set();let names=[];try{names=fs.readdirSync(path.join(BASE,'sessions'));}catch{}
  return journal.atomic(()=>{
    const revision=memoryMeta('revision')||'',unchanged=memoryMeta('recall_revision')===revision;
    const seen=new Map(d.prepare('SELECT run,sid,stamp FROM recall_sources').all().map(r=>[r.run,r]));
    for(const name of names){
      if(!/^s[0-9a-z]{6,24}\.json$/.test(name))continue;const s=readJ(path.join(BASE,'sessions',name));if(!normal(s))continue;
      for(const run of s.runs||[]){
        if(!okId(run,'r'))continue;
        let st;try{st=fs.statSync(raw(run));}catch{continue;}
        // Forgotten, blocked and private state only changes together with the memory revision. While it is unchanged,
        // an indexed run whose file and title are unchanged is skipped without reading its meta or querying memory.
        const file=st.size+':'+st.mtimeMs+':'+(s.title||''),known=seen.get(run);
        if(unchanged&&known?.sid===s.sid&&(known.stamp===file+':'||known.stamp===file+':blocked')){valid.add(run);continue;}
        const m=readJ(meta(run));
        if(!m?.ended||m.sid!==s.sid||m.agent!=='codex'||m.task||m.kind&&m.kind!=='handoff')continue;
        valid.add(run);
        const forbidden=memoryBlocked('',{sid:s.sid,run})||d.prepare("SELECT 1 FROM memory_evidence e JOIN memory_items i ON i.id=e.item WHERE e.run=? AND i.status='private' LIMIT 1").get(run);
        const stamp=file+':'+(forbidden?'blocked':'');
        if(known?.stamp===stamp&&known.sid===s.sid)continue;
        d.prepare('DELETE FROM recall_fts WHERE run=?').run(run);
        const es=forbidden?[]:safeContextEvents(run),title=memorySensitivity(s.title||'')?'一段对话':String(s.title||'一段对话').slice(0,80);
        for(const [i,e] of es.entries()){
          const text=String(e.text||'');if(!text.trim())continue;
          d.prepare('INSERT INTO recall_fts(sid,run,event,role,at,title,text) VALUES(?,?,?,?,?,?,?)').run(s.sid,run,i,e.t==='user'?'user':'assistant',Number(e.at)||m.started||0,title,text);
        }
        d.prepare('INSERT INTO recall_sources(run,sid,stamp) VALUES(?,?,?) ON CONFLICT(run) DO UPDATE SET stamp=excluded.stamp,sid=excluded.sid').run(run,s.sid,stamp);
      }
    }
    for(const r of seen.values())if(!valid.has(r.run)){d.prepare('DELETE FROM recall_fts WHERE run=?').run(r.run);d.prepare('DELETE FROM recall_sources WHERE run=?').run(r.run);}
    if(!unchanged)setMemoryMeta('recall_revision',revision);
  });
}
// 删对话时立刻把它从跨对话检索里拿掉（下次同步本来也会清，这里不等）
export function dropRecall(sid){
  if(!okId(sid,'s'))return;const d=schema();
  d.prepare('DELETE FROM recall_fts WHERE sid=?').run(sid);d.prepare('DELETE FROM recall_sources WHERE sid=?').run(sid);
}
export function recallAll(query,limit=8,sync=true){
  const q=String(query||'').trim().slice(0,80);if(!q)return {matches:[],more:false};
  if(sync)syncRecall();const d=schema(),count=Math.min(8,Math.max(1,limit));
  const rows=[...q].length>=3?d.prepare('SELECT * FROM recall_fts WHERE text MATCH ? ORDER BY rank,CAST(at AS INTEGER) DESC LIMIT ?').all('"'+q.replace(/"/g,'""')+'"',count+1):
    d.prepare('SELECT * FROM recall_fts WHERE instr(lower(text),lower(?))>0 ORDER BY CAST(at AS INTEGER) DESC LIMIT ?').all(q,count+1);
  const good=rows.filter(r=>!memoryBlocked('',r)&&!memoryBlockedText(r.text,Number(r.at))&&!memorySensitivity(r.text)&&normal(readJ(sess(r.sid))));
  return {matches:good.slice(0,count).map(r=>{const at=r.text.toLowerCase().indexOf(q.toLowerCase()),start=Math.max(0,at-100);return {sid:r.sid,run:r.run,title:r.title,date:date(r.at),role:r.role,text:r.text.slice(start,start+600),url:'/#xin='+r.sid};}),more:good.length>count};
}
const words=text=>[...new Set(String(text||'').toLowerCase().match(/[a-z][a-z0-9_]{1,25}|[\u4e00-\u9fff]{2,6}/g)||[])].filter(s=>!['用户','小芯','什么','怎么','一下','现在','看看','以前','这次','你好'].includes(s));
const relevant=(content,keys)=>keys.some(k=>content.toLowerCase().includes(k)||k.length>=4&&content.includes(k.slice(0,2)));
export function turnGuidance({text='',context='',sid='',now=Date.now()}={}){
  // Do not turn credentials or other private current input into an automatic cross-chat search key.
  const privateInput=!!memorySensitivity(text+' '+context),keys=privateInput?[]:words(text+' '+context),rows=memoryDb().prepare("SELECT * FROM memory_items WHERE status='active' ORDER BY COALESCE(confirmed,updated) DESC").all();
  const lines=[];let used=0;
  const learning=privateInput?'':learningGuidance(text+' '+context,now);if(learning){lines.push(learning);used+=learning.length;}
  for(const it of rows){
    if(memorySensitivity(it.content))continue;
    if(it.type!=='profile'&&!relevant(it.content,keys))continue;
    const age=now-(it.confirmed||it.updated),stale=['learning','project'].includes(it.type)&&age>90*86400e3;
    const action=it.type==='profile'?'交流时照顾':it.type==='learning'?'辅导时从这里接上':it.type==='project'?'处理相关事情时先核对进展':'自然交流时可参考';
    const line=action+'：'+it.content.slice(0,100)+(stale?'（很久没确认，使用前轻轻问一下，别强推）':'');
    if(used+line.length>430)continue;lines.push(line);used+=line.length;
  }
  // 不再每轮自动塞别的对话里的原话（「相关旧话」）：像 Letta 的 conversation_search 那样由模型需要时调 xin recall 查，
  // 每轮自动带的只留提炼过的注意事项（像 Open WebUI 的 <memory_context>）。原话里的「只回复 …」被塞到兄弟这句话跟前时，
  // DeepSeek 会照旧话回（联调 #111、#115–#117）。
  return lines.length?'<注意事项>\n'+lines.join('\n')+'\n</注意事项>':'';
}
export function taskMemory(goal,max=800){
  const keys=words(goal),items=memoryDb().prepare("SELECT content FROM memory_items WHERE status='active' AND type='profile' ORDER BY updated DESC").all();
  return items.filter(i=>!memorySensitivity(i.content)&&(relevant(i.content,keys)||/结论|简洁|简短|解释|中文|称呼|代码风格/.test(i.content))).map(i=>'- '+i.content).join('\n').slice(0,max);
}
