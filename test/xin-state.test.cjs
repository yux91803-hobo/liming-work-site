const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');const {pathToFileURL}=require('node:url');
const moduleUrl=pathToFileURL(path.join(__dirname,'../site/xin/vm-state.mjs')).href;
async function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-state-'));const {StateJournal}=await import(moduleUrl);const j=new StateJournal(root);t.after(()=>{j.close();fs.rmSync(root,{recursive:true,force:true});});return{root,j};}
function crash(root,afterCommit){const source=`import {StateJournal} from ${JSON.stringify(moduleUrl)};const j=new StateJournal(${JSON.stringify(root)});${afterCommit?'j.recover=()=>process.exit(71);':''}j.atomic(()=>{j.write(${JSON.stringify(root+'/sessions/stest001.json')},JSON.stringify({sid:'stest001',runs:['rtest001']}));j.append(${JSON.stringify(root+'/runs/rtest001.jsonl')},{t:'user',text:'one accepted input'});j.enqueueLaunch('rtest001','stest001',0);${afterCommit?'':'process.kill(process.pid,"SIGKILL");'}return {sid:'stest001',run:'rtest001'};},{id:'send:stable-id',digest:'original'});`;return spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000});}
test('接单事务提交前崩溃：输入、记录和启动意图一起回滚',async t=>{const {root,j}=await fixture(t);const r=crash(root,false);assert.equal(r.signal,'SIGKILL');j.recover();assert.equal(fs.existsSync(root+'/sessions/stest001.json'),false);assert.deepEqual(j.pendingLaunches(),[]);assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n,0);});
test('提交后投影前崩溃：重启补全记录、唯一事件和启动意图，同消息重发复用回执',async t=>{
 const {root,j}=await fixture(t);assert.equal(crash(root,true).status,71);j.recover();assert.equal(JSON.parse(fs.readFileSync(root+'/sessions/stest001.json')).sid,'stest001');assert.equal(j.pendingLaunches().length,1);
 const result=j.atomic(()=>assert.fail('duplicate input must not execute again'),{id:'send:stable-id',digest:'original'});assert.deepEqual(result,{sid:'stest001',run:'rtest001'});j.recover();assert.equal(fs.readFileSync(root+'/runs/rtest001.jsonl','utf8').trim().split('\n').length,1);
 assert.equal(j.atomic(()=>assert.fail('changed payload must be rejected'),{id:'send:stable-id',digest:'changed'}).error,'message_conflict');
});
test('事务将元数据、完成事件和回执一起提交；投影重放不重复追加',async t=>{
 const {root,j}=await fixture(t);j.atomic(()=>{j.write(root+'/task.json','{"status":"done"}');j.enqueueHandoff({id:'h1',parent:'sparent01',task:'stest001',version:'v1',payload:{ok:true}});j.append(root+'/events.jsonl',{t:'done'});return{ok:true};},{id:'complete:1',digest:'v1'});
 assert.equal(j.handoff('h1').state,'pending');j.db.prepare('UPDATE appends SET projected=0').run();j.recover();assert.equal(fs.readFileSync(root+'/events.jsonl','utf8').trim().split('\n').length,1);assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n,1);
});
test('执行启动按用户、完成续接、例行顺序；重复完成只有一个收件项',async t=>{const {j}=await fixture(t);j.atomic(()=>{j.enqueueLaunch('rbackground','s1',2);j.enqueueLaunch('revent','s1',1);j.enqueueLaunch('ruser','s1',0);for(let n=0;n<3;n++)j.enqueueHandoff({id:'same',parent:'s1',task:'t1',version:'v1',payload:{ok:true}});});assert.deepEqual(j.pendingLaunches().map(x=>x.run),['ruser','revent','rbackground']);assert.equal(j.dueHandoffs().length,1);j.startHandoff('same','revent');j.settleHandoff('same','delivered');assert.equal(j.hasPendingHandoffs(),false);});
test('续接共享 token 预算，缓存输入不重复加总，未知用量单独记录',async t=>{
 const {root}=await fixture(t),{requestBudget}=await import('../site/xin/vm-runtime.mjs');const file=root+'/budget.json',first=requestBudget(file,8,{tokens:100});assert.equal(first(),true);first.recordUsage({input_tokens:70,output_tokens:30,input_tokens_details:{cached_tokens:50}});
 const resumed=requestBudget(file,8,{tokens:100});assert.equal(resumed(),false);resumed.recordUsage(null);const b=JSON.parse(fs.readFileSync(file));assert.equal(b.total,100);assert.equal(b.cached,50);assert.equal(b.unknownUsage,1);assert.equal(b.used,1);
});
test('删除指定对话同时清除日志索引与回执，恢复时不重建已删除记录',async t=>{
 const {root,j}=await fixture(t);for(const sid of ['sdelete01','skeep001'])j.atomic(()=>{j.write(root+'/sessions/'+sid+'.json',JSON.stringify({sid}));j.write(root+'/contexts/'+sid+'.json','{"excerpt":"private"}');return {sid};},{id:sid,digest:sid});
 fs.unlinkSync(root+'/sessions/sdelete01.json');j.dropConversation('sdelete01');j.recover();assert.equal(fs.existsSync(root+'/sessions/sdelete01.json'),false);assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM commands WHERE id=?').get('sdelete01').n,0);assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE name=?').get('contexts/sdelete01.json').n,0);assert.equal(JSON.parse(fs.readFileSync(root+'/sessions/skeep001.json')).sid,'skeep001');
});
test('多个进程同时首次打开新的状态库：初始化遇忙重试，全部成功',async t=>{
 const {spawn}=require('node:child_process');
 for(let round=0;round<3;round++){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-state-race-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=`import {StateJournal} from ${JSON.stringify(moduleUrl)};const j=new StateJournal(${JSON.stringify(root)});j.recover();j.enqueueLaunch('r'+process.pid,'srace0001');j.close();`;
  const codes=await Promise.all(Array.from({length:8},()=>new Promise(ok=>{const c=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','ignore','pipe']});let err='';c.stderr.on('data',d=>err+=d);c.on('close',code=>ok([code,err.replace(/.*ExperimentalWarning.*\n?|.*trace-warnings.*\n?/g,'').trim()]));})));
  for(const [code,err] of codes)assert.equal(code,0,err);
  const {StateJournal}=await import(moduleUrl);const j=new StateJournal(root);assert.equal(j.pendingLaunches().length,8);j.close();
 }
});
test('另一连接正持有写锁时打开状态库：等锁释放后初始化成功，不立刻报 database is locked',async t=>{
 const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-state-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const holder=new DatabaseSync(path.join(root,'workflow.sqlite'));holder.exec('CREATE TABLE x(a); BEGIN IMMEDIATE; INSERT INTO x VALUES(1)');
 const source=`import {StateJournal} from ${JSON.stringify(moduleUrl)};const j=new StateJournal(${JSON.stringify(root)});j.recover();console.log('ready');j.close();`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
 setTimeout(()=>{holder.exec('COMMIT');holder.close();},400);
 const code=await new Promise(ok=>child.on('close',ok));
 assert.equal(code,0,err);assert.equal(out.trim(),'ready');
});
test('别的进程占着写锁时 recover 不等待：没有要补写的就不开写事务',async t=>{
 const {spawn}=require('node:child_process'),{platformTimeout}=require('./helpers/timeout.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-state-idle-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {StateJournal}=await import(moduleUrl);const init=new StateJournal(root);init.recover();init.close();
 const holder=spawn(process.execPath,['-e',`const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(root+'/workflow.sqlite')});d.exec('BEGIN IMMEDIATE');d.prepare("INSERT INTO commands(id,digest,result,at) VALUES('x','d','{}',0)").run();console.log('holding');setTimeout(()=>{d.exec('ROLLBACK');process.exit(0);},${platformTimeout(3000)});`],{stdio:['ignore','pipe','inherit']});
 await new Promise(ok=>holder.stdout.once('data',ok));t.after(()=>holder.kill());
 const j=new StateJournal(root);t.after(()=>j.close());
 const t0=Date.now();j.recover();assert.ok(Date.now()-t0<1000,'recover 等了 '+(Date.now()-t0)+' ms');
});
test('有提交了但没投影的行时 recover 照样补写',async t=>{
 const {root,j}=await fixture(t);j.recover();
 j.db.prepare("INSERT INTO documents(name,body,dirty) VALUES('sessions/sdirty001.json','{\"sid\":\"sdirty001\"}',1)").run();
 j.recover();assert.equal(JSON.parse(fs.readFileSync(root+'/sessions/sdirty001.json')).sid,'sdirty001');assert.equal(j.db.prepare("SELECT dirty FROM documents WHERE name='sessions/sdirty001.json'").get().dirty,0);
});
