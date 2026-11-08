const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
const url=n=>pathToFileURL(path.join(__dirname,'../site/xin/'+n+'.mjs')).href;
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-retention-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return code=>{const r=spawnSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
 import * as r from ${JSON.stringify(url('vm-retention'))};import * as m from ${JSON.stringify(url('vm-memory'))};import * as b from ${JSON.stringify(url('vm-base'))};import * as c from ${JSON.stringify(url('vm-context'))};
 const now=Date.now(),old=now-40*86400e3;b.mk(b.BASE+'/sessions');b.mk(b.BASE+'/runs');
 const chat=(n,extra={})=>{const sid='sretain00'+n,run='rretain00'+n;const s={sid,agent:'codex',title:'定时器对话 '+n,created:old,updated:old,runs:[run],...extra};b.writeJ(b.BASE+'/sessions/'+sid+'.json',s);b.writeJ(b.BASE+'/runs/'+run+'.json',{sid,run,agent:s.agent,started:old,ended:old+100});b.journal.append(b.BASE+'/runs/'+run+'.jsonl',{t:'user',text:'TIM 输入捕获 '+n,at:old});b.journal.append(b.BASE+'/runs/'+run+'.jsonl',{t:'text',text:'先看看捕获标志 '+n,at:old});m.setMemoryMeta('idle_cursor:'+sid,{run,event:1,offset:0});return s;};
 const consent=()=>{const p=r.retentionPreview(now);return r.setRetention({enabled:true,token:p.token,confirm:'processed-chat-30-days'},now);};
 const op=(name,args={})=>{const v=spawnSync(process.execPath,[${JSON.stringify(path.join(__dirname,'../site/xin/vm-agent.mjs'))},name],{input:JSON.stringify(args),env:process.env,encoding:'utf8'});if(v.status!==0)throw Error(v.stderr);return JSON.parse(v.stdout);};
 const out=await(async()=>{${code}})();process.stdout.write(JSON.stringify(out));`],{env:{...process.env,XIN_HOME:path.join(root,'xin'),XIN_WORK:path.join(root,'work'),CODEX_HOME:path.join(root,'codex')},encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
}
test('默认关闭、预览不删；只列已整理且闲置30天的默认对话，保留/近期/未整理/任务未完/天启不删',t=>{
 const run=fixture(t),r=run(`chat(1);chat(2,{updated:now});const un=chat(3);m.setMemoryMeta('idle_cursor:'+un.sid,null);const keep=chat(4);r.keepConversation({sid:keep.sid,keep:true});chat(5,{agent:'harness'});const busy=chat(6);b.writeJ(b.BASE+'/runs/'+busy.runs[0]+'.json',{sid:busy.sid,agent:'codex',started:old});const p=r.retentionPreview(now);
 return {enabled:p.enabled,eligible:p.eligible.map(x=>x.sid),excluded:p.excluded.map(x=>x.reason).sort(),exists:fs.existsSync(b.BASE+'/sessions/sretain001.json'),bad:r.prepareRetentionDelete('sretain001',now),n:b.journal.db.prepare('SELECT count(*) n FROM appends').get().n};`);
 assert.equal(r.enabled,false);assert.deepEqual(r.eligible,['sretain001']);assert.deepEqual(r.excluded,['busy','kept','recent','unprocessed']);assert.equal(r.exists,true);assert.equal(r.bad.error,'disabled');assert.equal(r.n,12);
});
test('首次开启必须确认最新具体清单；随口文字、过期token、清单变化不能批准',t=>{
 const run=fixture(t),r=run(`chat(1);const p=r.retentionPreview(now),a={enabled:true,token:p.token,confirm:'processed-chat-30-days'};
 const ordinary=r.setRetention({...a,confirm:'好'},now),expired=r.setRetention(a,now+16*60e3);r.keepConversation({sid:'sretain001',keep:true});const changed=r.setRetention(a,now);
 const fresh=r.retentionPreview(now),enabled=r.setRetention({...a,token:fresh.token},now);return {ordinary,expired,changed,enabled,exists:fs.existsSync(b.BASE+'/sessions/sretain001.json')};`);
 for(const k of ['ordinary','expired','changed'])assert.equal(r[k].error,'preview_required');assert.equal(r.enabled.enabled,true);assert.equal(r.enabled.count,0);assert.equal(r.exists,true);
});
test('任一设备最近看过旧对话，也算活动，不趁正在阅读时清理',t=>{
 const run=fixture(t),r=run(`chat(1);b.mk(b.BASE+'/presence/sretain001/device001');fs.writeFileSync(b.BASE+'/presence/sretain001/device001/tab001.seen','');return r.retentionPreview(now);`);
 assert.equal(r.eligible.length,0);assert.equal(r.excluded[0].reason,'recent');
});
test('清理含数据库、原文、回忆索引、上下文、通知与已结束任务；保留记忆引文标题、工程和天启；准备后重启不复活',t=>{
 const run=fixture(t),r=run(`const s=chat(1);chat(2,{agent:'harness'});const task=chat(3,{kind:'task',parent:s.sid,status:'done'});
 b.writeJ(b.BASE+'/contexts/'+s.sid+'.json',{text:'TIM 输入捕获 1'});b.writeJ(b.BASE+'/outbox/'+'a'.repeat(32)+'.json',{parent:s.sid,msg:{url:'/#xin='+s.sid,body:'原文通知'}});
 b.writeJ(b.BASE+'/tasks-index.json',{version:3,tasks:[task]});b.mk(process.env.XIN_WORK);fs.writeFileSync(process.env.XIN_WORK+'/keep.c','USER PROJECT');
 const item=m.addMemory({content:'TIM 输入捕获已学过',basis:'stated',evidence:{sid:s.sid,run:s.runs[0],quote:'TIM 输入捕获 1',at:old}}).item;
 b.journal.db.prepare('INSERT INTO commands(id,digest,result,at) VALUES(?,?,?,?)').run('front:'+s.runs[0]+':test','digest',JSON.stringify({text:'TIM 输入捕获 1'}),old);c.syncRecall();consent();
 const prepared=r.prepareRetentionDelete(s.sid,now),beforeFinish=fs.existsSync(b.BASE+'/sessions/'+s.sid+'.json');b.journal.recover();const afterDb=b.journal.db.prepare("SELECT count(*) n FROM appends WHERE name LIKE '%retain001%'").get().n;
 const hidden=c.recallAll('输入捕获 1').matches.length,finished=r.finishRetentionDelete(s.sid,()=>({ok:true}));b.journal.recover();
 const history=op('history',{sid:s.sid}),replay=op('send',{sid:s.sid,text:'旧请求重放'}),memory=op('memory_list');
 return {prepared,beforeFinish,afterDb,hidden,finished,history,replay,files:[fs.existsSync(b.BASE+'/sessions/'+s.sid+'.json'),fs.existsSync(b.BASE+'/sessions/'+task.sid+'.json'),fs.existsSync(b.BASE+'/sessions/sretain002.json'),fs.existsSync(process.env.XIN_WORK+'/keep.c')],
 quoted:memory.items[0].evidence[0],title:memory.titles[s.sid],commands:b.journal.db.prepare("SELECT count(*) n FROM commands WHERE id LIKE 'front:rretain001:%'").get().n,outbox:fs.existsSync(b.BASE+'/outbox/'+'a'.repeat(32)+'.json')};`);
 assert.equal(r.prepared.ok,true);assert.equal(r.beforeFinish,true);assert.equal(r.afterDb,0);assert.equal(r.hidden,0);assert.equal(r.finished.ok,true);assert.equal(r.history.error,'no_session');assert.equal(r.replay.error,'no_session');assert.deepEqual(r.files,[false,false,true,true]);assert.equal(r.quoted.quote,'TIM 输入捕获 1');assert.equal(r.quoted.deleted,true);assert.equal(r.title,'定时器对话 1');assert.equal(r.commands,0);assert.equal(r.outbox,false);
});
test('副本清理出错会留下待处理账本，可恢复且幂等，不冒充已经清完',t=>{
 const run=fixture(t),r=run(`chat(1);consent();r.prepareRetentionDelete('sretain001',now);const first=r.finishRetentionDelete('sretain001',()=>({error:'busy'})),pending=r.retentionPending();
 const second=r.finishRetentionDelete('sretain001',()=>({ok:true})),third=r.finishRetentionDelete('sretain001',()=>{throw Error('must not repeat');});return {first,pending,second,third,n:r.retentionPending().length};`);
 assert.equal(r.first.error,'cleanup_pending');assert.deepEqual(r.pending,['sretain001']);assert.equal(r.second.ok,true);assert.equal(r.third.already,true);assert.equal(r.n,0);
});
test('Codex索引只清网站拥有的指定ID；保留独立会话和history其它行，不改数据库结构',t=>{
 const run=fixture(t),r=run(`const home=process.env.CODEX_HOME;b.mk(home);const a='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
 const d=new DatabaseSync(home+'/state_5.sqlite');d.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT);CREATE TABLE turns(id INTEGER PRIMARY KEY,thread_id TEXT REFERENCES threads(id),body TEXT)');d.prepare('INSERT INTO threads VALUES(?,?)').run(a,'原话');d.prepare('INSERT INTO threads VALUES(?,?)').run(other,'独立会话');d.prepare('INSERT INTO turns(thread_id,body) VALUES(?,?)').run(a,'原话副本');d.prepare('INSERT INTO turns(thread_id,body) VALUES(?,?)').run(other,'另一个副本');d.close();
 const lines=[JSON.stringify({session_id:a,text:'原话'}),JSON.stringify({session_id:other,text:'独立原话'})];fs.writeFileSync(home+'/history.jsonl',lines.join('\\n')+'\\n');r.purgeCodexIndexes(home,a);
 const after=new DatabaseSync(home+'/state_5.sqlite');return {rows:after.prepare('SELECT * FROM threads').all(),turns:after.prepare('SELECT thread_id FROM turns').all(),history:fs.readFileSync(home+'/history.jsonl','utf8'),tables:after.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n,otherLine:lines[1]};`);
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].title,'独立会话');assert.equal(r.turns.length,1);assert.equal(r.turns[0].thread_id,r.rows[0].id);assert.ok(r.history.includes(r.otherLine));assert.doesNotMatch(r.history,/"原话"/);assert.equal(r.tables,2);
});
test('首建保留表事务回滚后仍可用；用户活动时空闲清理让开，不续活动或任务租约',t=>{
 const run=fixture(t),r=run(`try{b.journal.atomic(()=>{r.retentionPreview(now);throw Error('rollback');});}catch{}
 chat(1);const active=chat(2,{updated:now});b.writeJ(b.BASE+'/runs/'+active.runs[0]+'.json',{sid:active.sid,agent:'codex',started:now});consent();m.setMemoryMeta('idle_activity',{at:now,id:'active'});b.writeJ(b.BASE+'/tasks-lease.json',{sentinel:'unchanged'});
 const worker=spawnSync(process.execPath,[${JSON.stringify(path.join(__dirname,'../site/xin/vm-agent.mjs'))},'memory-idle'],{env:process.env,encoding:'utf8'});
 return {status:worker.status,exists:fs.existsSync(b.BASE+'/sessions/sretain001.json'),activity:m.memoryMeta('idle_activity'),lease:b.readJ(b.BASE+'/tasks-lease.json')};`);
 assert.equal(r.status,0);assert.equal(r.exists,true);assert.equal(r.activity.id,'active');assert.equal(r.lease.sentinel,'unchanged');
});
