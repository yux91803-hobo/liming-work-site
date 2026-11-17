const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync,spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {stateMode}=require('./helpers/state-mode.cjs'),{stopOwned}=require('./helpers/stop-owned.cjs');
const AGENT=path.join(__dirname,'../site/xin/vm-agent.mjs');
// 测试进程里直接加载的控制器模块用临时目录，不碰这台机器真的 ~/.xin（以前这里没设，会写进运行测试那台机器的家目录）
process.env.XIN_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'xin-controller-proc-'));
const url=name=>pathToFileURL(path.join(__dirname,'../site/xin/'+name+'.mjs')).href;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t,mode='kernel'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xin-controller-')),home=path.join(dir,'xin'),bin=path.join(dir,'bin');
  fs.mkdirSync(bin);fs.mkdirSync(home);fs.mkdirSync(path.join(home,'sessions'));fs.mkdirSync(path.join(home,'runs'));
  for(const name of ['codex','claude','agy','dsh'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const env={...process.env,XIN_HOME:home,XIN_WORK:path.join(dir,'work'),XIN_DSH:path.join(bin,'dsh'),XIN_AGY_HOME:dir,
    XIN_ANTIGRAVITY_BIN:'',XIN_FRONT_PROVIDER:'deepseek',CODEX_HOME:path.join(dir,'codex'),CLAUDE_CONFIG_DIR:path.join(dir,'claude'),PATH:bin+':'+process.env.PATH};
  const start=()=>stateMode(t,env);
  const owner=mode==='kernel'?start():null;
  t.after(()=>stopOwned(home,dir));
  const cli=(op,args={})=>{const r=spawnSync(process.execPath,[AGENT,op],{env,input:JSON.stringify(args),encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const js=code=>{const r=spawnSync(process.execPath,['--input-type=module','-e',`import * as b from ${JSON.stringify(url('vm-base'))};import * as m from ${JSON.stringify(url('vm-memory'))};import * as c from ${JSON.stringify(url('vm-context'))};import * as l from ${JSON.stringify(url('vm-learning'))};const out=await(async()=>{${code}})();process.stdout.write(JSON.stringify(out??null));`],{env,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  return {dir,home,env,owner,start,cli,js};
}
async function rpc(f,q,options){const {requestState}=await import(url('vm-kernel-client'));return requestState(f.home,q,options);}
async function settle(f,run){for(let i=0;i<100;i++){if(f.cli('poll',{run}).done)return;await sleep(30);}assert.fail('fake executor did not settle');}

for(const mode of ['legacy','kernel'])test(mode+'：主对话回执、重送冲突、结束后续聊及天启独立保持一致',async t=>{
  const f=fixture(t,mode),a=f.cli('send',{main:true,text:'第一句',clientId:'same-receipt-0001'});
  assert.ok(a.sid&&a.run,JSON.stringify(a));
  assert.deepEqual(f.cli('send',{main:true,text:'第一句',clientId:'same-receipt-0001'}),a);
  assert.equal(f.cli('send',{main:true,text:'不同内容',clientId:'same-receipt-0001'}).error,'message_conflict');
  await settle(f,a.run);
  const b=f.cli('send',{main:true,text:'下一句',clientId:'same-receipt-0002'});assert.equal(b.sid,a.sid);assert.notEqual(b.run,a.run);
  assert.equal(f.cli('greet').main,a.sid);
  const h=f.cli('send',{agent:'harness',main:true,text:'天启'});assert.equal(h.agent,'harness',JSON.stringify(h));assert.notEqual(h.sid,a.sid);assert.equal(h.main,undefined);
  assert.deepEqual(f.js(`return b.journal.db.prepare("SELECT id FROM commands WHERE id LIKE 'send:%' ORDER BY id").all().map(r=>r.id);`),['send:same-receipt-0001','send:same-receipt-0002']);
});

test('内核接管后，原生数据库句柄只读；关 query_only 也不能越权，具名修改仍可用',async t=>{
  const f=fixture(t),r=f.js(`const d=b.journal.db;const denied=[];
    for(const off of [false,true]){if(off)d.exec('PRAGMA query_only=OFF');try{d.prepare("UPDATE memory_meta SET value='1'").run();denied.push(false);}catch(e){denied.push(e.errcode===8);}}
    let local;try{b.journal.atomic(()=>m.setMemoryMeta('bad',1));local='allowed';}catch(e){local=e.code;}
    m.setMemoryMeta('bridge-value',7);return {denied,local,value:m.memoryMeta('bridge-value')};`);
  assert.deepEqual(r,{denied:[true,true],local:'owner_unavailable',value:7});
});

test('旧模式的可写句柄不能活过写权作用域；后续读是原生只读',async t=>{
  const f=fixture(t,'legacy'),r=f.js(`let old;b.journal.writing(()=>{old=b.journal.db;});
    let closed=false;try{old.prepare('SELECT 1').get();}catch{closed=true;}
    const release=b.ownership.enter(),scoped=b.journal.db;release();
    let scopedClosed=false;try{scoped.prepare('SELECT 1').get();}catch{scopedClosed=true;}
    let readonly=false;try{b.journal.db.exec('CREATE TABLE forbidden(x)');}catch(e){readonly=e.errcode===8;}
    return {closed,scopedClosed,readonly};`);
  assert.deepEqual(r,{closed:true,scopedClosed:true,readonly:true});
});

test('socket 路径只是线索：记录仍归 legacy 时继续受控旧路径，不盲信遗留监听器',async t=>{
  const f=fixture(t,'legacy'),net=require('node:net');let requests=0;
  fs.mkdirSync(path.join(f.home,'run'));const server=net.createServer(s=>{requests++;s.destroy();});
  await new Promise(resolve=>server.listen(path.join(f.home,'run','state.sock'),resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  assert.equal(f.cli('daily_set',{text:'照常保存清单'}).ok,true);assert.equal(requests,0);
});

test('记忆、检索和学习在所有者进程提交，忘掉清除衍生证据；凭据不入库',async t=>{
  const f=fixture(t),r=f.js(`const a=m.addMemory({content:'回答先给结论',source:'user'}).item;
    const secret=m.addMemory({content:'网关密码是 abc12345',source:'chat'});m.setMemoryPreferences({learning:true});
    const learn=l.reportLearning({agent:'codex',events:[{id:'kernel-learning-01',topic:'gpio',exercise:'led-init',kind:'code',answer:'LED_PORT->BSRR = GPIO_BSRR_BS0;',correct:true,independent:true}]});
    c.syncRecall();const learned=m.listMemory().find(i=>i.type==='learning');
    m.forgetMemory(learned.id);m.updateMemory(a.id,{content:'先说结论再讲原因'});
    return {secret:secret.error,learn:learn.accepted,events:l.learningDb().prepare('SELECT count(*) n FROM learning_events').get().n,list:m.listMemory().map(i=>i.content)};`);
  assert.deepEqual(r,{secret:'secret',learn:1,events:0,list:['先说结论再讲原因']});
});

test('同时执行 xin 命令时每轮身份独立，天启命令不能借用小芯的身份',async t=>{
  const f=fixture(t);
  f.js(`for(const [run,agent] of [['rkernel001','codex'],['rkernel002','harness']]){
    b.writeJ(b.BASE+'/runs/'+run+'.json',{run,sid:'skernel001',agent,started:Date.now()});b.journal.append(b.BASE+'/runs/'+run+'.jsonl',{t:'user',text:'回答先给结论'});
  }`);
  const [a,b]=await Promise.all([
    rpc(f,{kind:'xin',run:'rkernel001',argv:['remember','--basis','stated','回答先给结论']}),
    rpc(f,{kind:'xin',run:'rkernel002',argv:['remember','不应写进去的内容']})
  ]);
  assert.equal(a.code,0,a.output);assert.match(a.output,/记住了/);assert.equal(b.code,1);assert.match(b.output,/天启模式是独立功能/);
  assert.deepEqual(f.cli('memory_list').items.map(i=>i.content),['回答先给结论']);
});

test('空闲整理跨进程保留原话核验和预算结算，不能把模型编的引文记成事实',async t=>{
  const f=fixture(t),r=f.js(`const i=await import(${JSON.stringify(url('vm-memory-idle'))}),now=Date.now(),sid='sreview001',run='rreview001';
    b.writeJ(b.BASE+'/sessions/'+sid+'.json',{sid,agent:'codex',runs:[run],created:now-60000});
    b.writeJ(b.BASE+'/runs/'+run+'.json',{run,sid,agent:'codex',started:now-60000,ended:now-59000});
    b.journal.append(b.BASE+'/runs/'+run+'.jsonl',{t:'user',text:'我以后都想先看  波形，再看寄存器',at:now-60000});
    i.memoryActivity(now-60000);m.setMemoryMeta('idle_deep_at',now);
    const limits={...i.MEMORY_IDLE,minChars:1,minRuns:1},plan=i.memoryReviewPlan(now,limits),s=plan.sources[0];
    const ticket=i.reserveMemoryReview(plan,now,limits);i.settleUsage(ticket,{input_tokens:12,output_tokens:3});
    const proposal={content:'喜欢先看波形再看寄存器',type:'profile',basis:'stated',scope:'long-term',topic:'PWM',replaces:null,evidence:[{sid:s.sid,run:s.run,event:s.event,quote:s.text}]};
    const result=i.applyMemoryReview(plan,[{...proposal,evidence:[{...proposal.evidence[0],quote:'模型编的引文'}]},proposal]);
    return {result,budget:m.memoryMeta(ticket.key),item:m.listMemory()[0]};`);
  assert.equal(r.result.rejected,1);assert.equal(r.result.accepted,1);assert.equal(r.budget.calls,1);assert.equal(r.budget.tokens,15);
  assert.equal(r.item.status,'active');assert.equal(r.item.evidence[0].quote,'我以后都想先看  波形，再看寄存器');
});

test('同一编号的具名操作和单次追加留回执；重送不重复、内容冲突被拒绝',async t=>{
  const f=fixture(t),q={kind:'append',name:'bridge-events.jsonl',event:{t:'text',text:'只写一次'}};
  await rpc(f,q,{id:'append-once-0001'});await rpc(f,q,{id:'append-once-0001'});
  assert.equal(fs.readFileSync(path.join(f.home,q.name),'utf8').trim().split('\n').length,1);
  assert.equal((await rpc(f,{...q,event:{t:'text',text:'冒用编号'}},{id:'append-once-0001'})).error,'message_conflict');
  const named={kind:'named',name:'memory.add',args:[{content:'喜欢看波形图',source:'user'}]};
  const a=await rpc(f,named,{id:'named-once-0001'}),b=await rpc(f,named,{id:'named-once-0001'});
  assert.equal(a.item.id,b.item.id);assert.equal(f.cli('memory_list').items.length,1);
  assert.equal((await rpc(f,{kind:'named',name:'exec_sql',args:['DELETE FROM memory_items']})).error,'bad_op');
});

test('投影暂时失败而进程仍活着：下一次请求先恢复投影，再重放已提交回执',async t=>{
  const f=fixture(t,'legacy'),file=path.join(f.home,'projection-retry.json'),preload=path.join(f.dir,'projection-fault.cjs');
  fs.writeFileSync(preload,`const fs=require('node:fs'),rename=fs.renameSync;let once=true;fs.renameSync=(a,b)=>{if(once&&b===${JSON.stringify(file)}){once=false;throw Object.assign(Error('synthetic projection failure'),{code:'EIO'});}return rename(a,b);};`);
  f.env.NODE_OPTIONS='--require='+preload;f.start();
  const q={kind:'write',name:path.basename(file),body:'{"value":1}'},options={id:'projection-retry-0001'};
  await assert.rejects(rpc(f,q,options),e=>e.executed==='unknown');assert.equal(fs.existsSync(file),false);
  await rpc(f,q,options);assert.deepEqual(JSON.parse(fs.readFileSync(file)),{value:1});
  assert.equal(f.js(`return b.journal.db.prepare("SELECT revision FROM documents WHERE name='projection-retry.json'").get().revision;`),1);
});

test('杀死状态进程后旧入口拒绝写；重启恢复同一业务回执，不重新创建一轮',async t=>{
  const f=fixture(t),args={main:true,text:'重启不重发',clientId:'crash-business-0001'},a=f.cli('send',args);await settle(f,a.run);
  f.owner.child.kill('SIGKILL');await f.owner.exited;
  const before=fs.readFileSync(path.join(f.home,'sessions',a.sid+'.json'),'utf8');
  assert.equal(f.cli('send',{main:true,text:'不能偷偷走旧路'}).error,'owner_unavailable');
  assert.equal(fs.readFileSync(path.join(f.home,'sessions',a.sid+'.json'),'utf8'),before);
  f.start();assert.deepEqual(f.cli('send',args),a);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'sessions',a.sid+'.json'))).runs.length,1);
});

test('同一个长进程活过 legacy→kernel→legacy，单次写每次重新判断所有权',async t=>{
  const f=fixture(t,'legacy'),script=`import {setMemoryMeta,memoryMeta} from ${JSON.stringify(url('vm-memory'))};import readline from 'node:readline';
    setMemoryMeta('phase',0);console.log('ready');for await(const line of readline.createInterface({input:process.stdin})){setMemoryMeta('phase',Number(line));console.log(memoryMeta('phase'));}`;
  const c=spawn(process.execPath,['--input-type=module','-e',script],{env:f.env,stdio:['pipe','pipe','pipe']});
  let buffer='',notify;const lines=[];c.stdout.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const i=buffer.indexOf('\n');lines.push(buffer.slice(0,i));buffer=buffer.slice(i+1);}notify?.();});
  const next=()=>new Promise((resolve,reject)=>{const tm=setTimeout(()=>reject(Error('reporter timeout')),5000);const take=()=>{if(lines.length){clearTimeout(tm);notify=null;resolve(lines.shift());}};notify=take;take();});
  t.after(()=>c.kill('SIGKILL'));assert.equal(await next(),'ready');
  c.stdin.write('1\n');assert.equal(await next(),'1');const owner=f.start();
  c.stdin.write('2\n');assert.equal(await next(),'2');
  assert.equal((await rpc(f,{kind:'control',op:'release',mode:'legacy'})).mode,'legacy');await owner.exited;
  c.stdin.write('3\n');assert.equal(await next(),'3');assert.equal(f.js(`return m.memoryMeta('phase');`),3);
});

test('父管道断开会排空退出并保留 kernel 记录，不能默默改回 legacy',async t=>{
  const f=fixture(t);f.owner.child.stdin.end();await f.owner.exited;
  assert.equal(f.cli('daily_set',{text:'不能本地写'}).error,'owner_unavailable');
  assert.equal(fs.existsSync(path.join(f.home,'daily.md')),false);
  f.start();assert.equal(f.cli('sessions').sessions.length,0);
});

for(const committed of [false,true])test((committed?'提交后、投影前':'提交前')+'被 kill -9：重启只恢复已提交的状态和事件',async t=>{
  const f=fixture(t,'legacy');f.cli('sessions');
  const code=`import {ownership,journal,BASE} from ${JSON.stringify(url('vm-base'))};
    ownership.take();journal.recover();${committed?"journal.recover=()=>process.kill(process.pid,'SIGKILL');":''}
    journal.atomic(()=>{journal.write(BASE+'/fault.json','{"value":1}');journal.append(BASE+'/fault.jsonl',{t:'text',text:'已提交的事件'});
      ${committed?'':"process.kill(process.pid,'SIGKILL');"}return {ok:true};},{id:'fault:stable',digest:'fault'});`;
  const crashed=spawnSync(process.execPath,['--input-type=module','-e',code],{env:f.env,encoding:'utf8'});
  assert.equal(crashed.signal,'SIGKILL',crashed.stderr);
  assert.equal(f.cli('sessions').error,'owner_unavailable');
  const owner=f.start(),file=path.join(f.home,'fault.json'),events=path.join(f.home,'fault.jsonl');
  assert.equal(fs.existsSync(file),committed);assert.equal(fs.existsSync(events),committed);
  assert.equal(f.js(`return b.journal.db.prepare("SELECT count(*) n FROM commands WHERE id='fault:stable'").get().n;`),committed?1:0);
  if(committed){assert.deepEqual(JSON.parse(fs.readFileSync(file)),{value:1});assert.equal(fs.readFileSync(events,'utf8').trim().split('\n').length,1);}
  owner.child.kill('SIGKILL');await owner.exited;f.start();
  if(committed)assert.equal(fs.readFileSync(events,'utf8').trim().split('\n').length,1);
});

test('取得独占锁后再次检查旧控制器；等待期间出现未兼容旧版本也不接管、不杀旧任务',async t=>{
  const f=fixture(t,'legacy'),dir=path.join(f.dir,'agent'),release=path.join(f.dir,'release');fs.mkdirSync(dir);
  for(const name of fs.readdirSync(path.dirname(AGENT)).filter(n=>/^vm-.*\.mjs$/.test(n)))fs.copyFileSync(path.join(path.dirname(AGENT),name),path.join(dir,name));
  const old=path.join(dir,'vm-agent-000000000001.mjs');fs.writeFileSync(old,"console.log('old');setInterval(()=>{},1000);");
  const locker=spawn(process.execPath,['--input-type=module','-e',`import {Ownership} from ${JSON.stringify(url('vm-kernel-owner'))};import fs from 'node:fs';
    const o=new Ownership(process.env.XIN_HOME);o.hold();console.log('held');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){o.close();clearInterval(t);}},10);`],{env:f.env,stdio:['ignore','pipe','pipe']});
  await new Promise(resolve=>locker.stdout.once('data',resolve));
  const next=spawn(process.execPath,[path.join(dir,'vm-agent.mjs'),'serve'],{env:f.env,stdio:['ignore','pipe','pipe']});
  const exited=new Promise(resolve=>next.once('exit',(code,signal)=>resolve({code,signal})));let err='';next.stderr.on('data',b=>err+=b);
  let opened=false;
  for(const end=performance.now()+5000;performance.now()<end;){
    try{opened=fs.readdirSync('/proc/'+next.pid+'/fd').some(n=>{try{return fs.readlinkSync('/proc/'+next.pid+'/fd/'+n)===path.join(f.home,'owner.sqlite');}catch{return false;}});}catch{}
    if(opened)break;await sleep(10);
  }
  assert.equal(opened,true,'new controller passed the first scan and opened owner.sqlite');await sleep(30);
  const previous=spawn(process.execPath,[old,'watchdog'],{env:f.env,stdio:['ignore','pipe','pipe']});
  await new Promise(resolve=>previous.stdout.once('data',resolve));fs.writeFileSync(release,'release');
  const tm=setTimeout(()=>next.kill('SIGKILL'),5000);const result=await exited;clearTimeout(tm);
  assert.equal(result.code,1,err);assert.match(err,/state_compat/);assert.equal(fs.existsSync(path.join(f.home,'workflow.sqlite')),false);
  const {Ownership}=await import(url('vm-kernel-owner'));const owner=new Ownership(f.home);assert.equal(owner.record().mode,'legacy');assert.equal(owner.record().epoch,2);owner.close();
  assert.doesNotThrow(()=>process.kill(previous.pid,0));
});

test('异步调用交错等待时 locked/key/run 都留在各自上下文，不改全局环境',async()=>{
  await require('./helpers/own-state.cjs').ownState();   // 测试进程里直接调控制器：测试进程自己当主人
  const {createController}=await import(url('vm-kernel-controller')),{callContext}=await import(url('vm-kernel-context'));
  const original=process.env.XIN_RUN;
  const controller=createController({ops:{async probe(a){await sleep(a.delay);return {...callContext()};}},iops:{},isTask:()=>false,
    markCurrentController:()=>{},dispatchLaunches:()=>{}});
  const [a,b]=await Promise.all([controller.invoke({op:'probe',args:{delay:20},run:'raaaaaa'}),controller.invoke({op:'probe',args:{delay:1},run:'rbbbbbb'})]);
  assert.equal(a.run,'raaaaaa');assert.equal(b.run,'rbbbbbb');assert.equal(a.locked,false);assert.equal(b.locked,false);assert.equal(process.env.XIN_RUN,original);
});

// 第 2 批（docs/superpowers/plans/2026-11-15-xin-state-owner-switch.md Task 1）
const ownerRecord=async home=>{const {Ownership}=await import(url('vm-kernel-owner'));const o=new Ownership(home);try{return o.record({waitMs:0});}finally{o.close();}};
test('owner-legacy：主人活着不改；被 kill -9 后把 kernel 改回 legacy；本来就是 legacy 不动',async t=>{
  const f=fixture(t,'legacy'),owner=f.start();
  assert.deepEqual(f.cli('owner-legacy'),{error:'owner_busy'});
  owner.child.kill('SIGKILL');await owner.exited;
  assert.equal((await ownerRecord(f.home)).mode,'kernel');
  assert.deepEqual(f.cli('owner-legacy'),{ok:true,mode:'legacy',epoch:2});
  assert.deepEqual(f.cli('owner-legacy'),{ok:true,unchanged:true,mode:'legacy',epoch:2});
  assert.equal(f.cli('sessions').error,undefined);
});
test('空闲时一分钟一检，有活时五秒：pendingWork 看待派发、后台任务、通知、交接和控制器回调',async t=>{
  const f=fixture(t,'legacy');
  const ask=code=>{const r=spawnSync(process.execPath,[...require('./helpers/own-state.cjs').OWN_IMPORT,'--input-type=module','-e',`import {pendingWork} from ${JSON.stringify(pathToFileURL(AGENT).href)};import {journal} from ${JSON.stringify(url('vm-base'))};${code};process.stdout.write(JSON.stringify(pendingWork()));`],{env:f.env,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  assert.equal(ask(''),false,'什么都没有：一分钟一检');
  assert.equal(ask("journal.enqueueLaunch('rpendingx01','s0000000001',0)"),true,'有待派发的一轮：五秒一检');
});
test('从 legacy 拿到所有权时先备份一份；从 kernel 记录接回不备份',async t=>{
  const f=fixture(t,'legacy');f.cli('sessions');
  const dir=path.join(f.home,'backups','owner-switch'),first=f.start();
  assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.sqlite')).length,1);
  first.child.kill('SIGKILL');await first.exited;
  f.start();assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.sqlite')).length,1);
});
test('切换窗口里来写（主人拿了锁还没开始听）：稍等后交给主人，只写一次',async t=>{
  const f=fixture(t,'legacy');f.cli('sessions');
  const holder=spawn(process.execPath,['--input-type=module','-e',`import {Ownership} from ${JSON.stringify(url('vm-kernel-owner'))};const o=new Ownership(process.env.XIN_HOME);o.take();console.log('held');setInterval(()=>{},1000);`],{env:f.env,stdio:['ignore','pipe','pipe']});
  const held=new Promise(resolve=>holder.once('exit',resolve));t.after(()=>{holder.kill('SIGKILL');return held;});
  await new Promise(resolve=>holder.stdout.once('data',resolve));
  const writer=spawn(process.execPath,['--input-type=module','-e',`import {journal,BASE} from ${JSON.stringify(url('vm-base'))};journal.append(BASE+'/window.jsonl',{t:'text',text:'切换窗口里的一条'});`],{env:f.env,stdio:['ignore','pipe','pipe']});
  let err='';writer.stderr.on('data',b=>err+=b);
  const wrote=new Promise(resolve=>writer.once('exit',code=>resolve(code)));
  await sleep(300);
  holder.kill('SIGKILL');await held;
  f.start();
  assert.equal(await wrote,0,err);
  assert.equal(fs.readFileSync(path.join(f.home,'window.jsonl'),'utf8').trim().split('\n').length,1);
});
