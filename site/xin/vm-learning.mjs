// Evidence from the owner's study UI, never from a worker or Tianqi.
import crypto from 'node:crypto';
import path from 'node:path';
import {BASE,journal,readJ,okId} from './vm-base.mjs';
import {memoryDb,memoryPreferences,memoryBlockedText,memorySensitivity,learningMemory} from './vm-memory.mjs';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const topics={gpio:'GPIO',exti:'EXTI',usart:'USART',i2c:'I2C',tim:'定时器',dma:'DMA',adc:'ADC',spi:'SPI'};
const bj=at=>new Date(at+8*3600e3).toISOString().slice(0,10);
export function learningDb(){
 const d=memoryDb();
 if(d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('learning_events','learning_by_scope','learning_profiles','learning_blocked','learning_links')").get().n!==5)
 journal.writing(()=>journal.db.exec(`CREATE TABLE IF NOT EXISTS learning_events (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,topic TEXT NOT NULL,exercise TEXT NOT NULL,kind TEXT NOT NULL,
 answer TEXT NOT NULL,correct INTEGER,independent INTEGER NOT NULL,at INTEGER NOT NULL,url TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS learning_by_scope ON learning_events(scope,at);
 CREATE TABLE IF NOT EXISTS learning_profiles (scope TEXT PRIMARY KEY,item TEXT,state TEXT NOT NULL,mastered INTEGER NOT NULL,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS learning_blocked (hash TEXT PRIMARY KEY,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS learning_links (item TEXT NOT NULL,event TEXT NOT NULL,PRIMARY KEY(item,event));`));return d;
}
export function learningState(events,previous={},now=Date.now()){
 const es=events.filter(e=>e.kind!=='view'&&e.answer&&e.correct!==null&&e.independent&&e.at<=now).sort((a,b)=>a.at-b.at),days=new Set();
 let score=0,weight=0;const seen=new Set();
 for(const e of es){const key=bj(e.at)+':'+e.exercise+':'+sha(e.answer);if(seen.has(key))continue;seen.add(key);
  const w=Math.pow(0.5,Math.max(0,now-e.at)/(14*86400e3));weight+=w;score+=w*(e.correct?1:0);if(e.correct)days.add(bj(e.at));}
 const last=es.at(-1),recentAttempt=events.filter(e=>e.kind!=='view'&&e.answer&&e.correct!==null&&e.at<=now).sort((a,b)=>a.at-b.at).at(-1);
 const passed=last?.correct&&(last.kind==='code'||days.size>=2&&score/weight>=0.7);
 const mastered=!!previous.mastered||!!passed;
 const reviewing=recentAttempt&&!recentAttempt.correct||previous.state==='review'&&!(passed&&last.at>=previous.at);
 const state=reviewing&&mastered?'review':passed?'mastered':mastered?'mastered':recentAttempt?'practising':'seen';
 return {state,mastered,score:weight?score/weight:null,last:recentAttempt};
}
export function reportLearning(a={},now=Date.now()){
 if(!memoryPreferences().learning)return {ok:true,ignored:'disabled'};
 if(a.sid&&!okId(a.sid,'s'))return {error:'bad_session'};
 const s=a.sid&&readJ(path.join(BASE,'sessions',a.sid+'.json'));
 if(a.agent!=='codex'||a.sid&&(!s||s.agent!=='codex'||s.kind)||a.task)return {error:'not_default'};
 if(!Array.isArray(a.events)||a.events.length>30)return {error:'bad_events'};
 return journal.named('learning.report',[a,now],()=>{
  const d=learningDb();
  let accepted=0;const scopes=new Set();
  for(const e of a.events){
   if(!/^[a-zA-Z0-9_-]{8,80}$/.test(e.id||'')||!topics[e.topic]||!/^[a-zA-Z0-9_.:-]{1,80}$/.test(e.exercise||'')||!['view','answer','code'].includes(e.kind))continue;
   const answer=String(e.answer||'').slice(0,3000),scope=e.topic+'/'+e.exercise;
   if(memorySensitivity(answer)||memoryBlockedText(answer,now)||d.prepare('SELECT 1 FROM learning_blocked WHERE hash=?').get(sha(scope)))continue;
   if(e.kind!=='view'&&(!answer.trim()||typeof e.independent!=='boolean'||e.correct!==null&&typeof e.correct!=='boolean'))continue;
   const at=Math.min(now,Math.max(now-7*86400e3,Number(e.at)||now)),correct=e.kind==='view'||e.correct===null?null:e.correct?1:0;
   const url='/tools/stm32/?'+new URLSearchParams({v:e.kind==='code'?'lab':'think',t:e.topic,...(e.kind==='code'?{st:'check',fn:e.exercise}:{s:e.step||'review'})}).toString();
   const saved=d.prepare('INSERT OR IGNORE INTO learning_events(id,scope,topic,exercise,kind,answer,correct,independent,at,url) VALUES(?,?,?,?,?,?,?,?,?,?)').run(e.id,scope,e.topic,e.exercise,e.kind,e.kind==='view'?'':answer,correct,e.independent===true?1:0,at,url);
   if(saved.changes){accepted++;scopes.add(scope);}
  }
  for(const scope of scopes){
   const es=d.prepare('SELECT * FROM learning_events WHERE scope=? ORDER BY at DESC LIMIT 120').all(scope),old=d.prepare('SELECT * FROM learning_profiles WHERE scope=?').get(scope)||{};
   const state=learningState(es,old,now),last=state.last;
   let item=old.item||null;
   if(last){
    const label=state.state==='review'?'需要复习（之前已掌握，最近独立练习又有出错）':state.state==='mastered'?'基本掌握（近期独立练习通过）':'正在练习，尚需巩固';
    const content=topics[last.topic]+' · '+last.exercise+'：'+label+(last.kind==='code'?'；学习台检查结果，不代表已上板验证':'');
    const result=learningMemory({id:item,content,quote:last.answer.slice(0,200),at:last.at});
    if(result.item){item=result.item.id;if(!result.protected)d.prepare('INSERT OR IGNORE INTO learning_links(item,event) VALUES(?,?)').run(item,last.id);}
   }
   d.prepare('INSERT INTO learning_profiles(scope,item,state,mastered,at) VALUES(?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET item=excluded.item,state=excluded.state,mastered=excluded.mastered,at=excluded.at')
    .run(scope,item,state.state,state.mastered?1:0,now);
  }
  return {ok:true,accepted};
 });
}
export function learningGuidance(text='',now=Date.now()){
 if(!memoryPreferences().learning)return '';
 const d=learningDb(),keys=Object.keys(topics).filter(k=>String(text).toLowerCase().includes(k)||text.includes(topics[k]));if(!keys.length)return '';
 const es=d.prepare('SELECT * FROM learning_events ORDER BY at DESC LIMIT 120').all().filter(e=>keys.includes(e.topic));
 if(!es.length)return '';
 const e=es[0],p=d.prepare('SELECT * FROM learning_profiles WHERE scope=?').get(e.scope);
 if(p?.item)return ''; // The typed memory is already included in the turn's guidance.
 return '学习页最近在看 '+topics[e.topic]+'（'+bj(e.at)+'）；看过页面不代表已经掌握，先问一句或从具体练习接上。';
}
export function learningEvidence(item){
 const d=learningDb();return d.prepare('SELECT e.* FROM learning_links l JOIN learning_events e ON e.id=l.event WHERE l.item=? ORDER BY e.at DESC LIMIT 3').all(item)
 .map(e=>({quote:e.answer.slice(0,200),at:e.at,url:e.url,title:'学习台 '+topics[e.topic]+' · '+e.exercise}));
}
