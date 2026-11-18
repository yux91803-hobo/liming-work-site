const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { lockedSpawn } = require('./helpers/locked.cjs');
const {spawnSync}=require('node:child_process');const {performance}=require('node:perf_hooks');const {pathToFileURL}=require('node:url');
const agent=path.join(__dirname,'../site/xin/vm-agent.mjs');
function fixture(t,{slow=false,slowUser=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-handoff-')),control=root+'/control';for(const p of ['control/sessions','control/runs','profile','work','codex'])fs.mkdirSync(root+'/'+p,{recursive:true});
 const preload=root+'/preload.cjs',calls=root+'/calls.jsonl';
 fs.writeFileSync(preload,`const fs=require('node:fs');require('node:os').homedir=()=>${JSON.stringify(root+'/profile')};require('node:module').syncBuiltinESMExports();global.fetch=async(u,o)=>{const b=JSON.parse(o.body);const hand=b.tools.some(t=>t.name==='finish_event');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({handoff:hand,model:b.model})+'\\n');if(hand&&${slow})await new Promise(r=>setTimeout(r,1500));if(!hand&&${slowUser})while(!fs.existsSync(${JSON.stringify(root+'/release-user-reply')})){if(o.signal?.aborted)throw Error('synthetic request canceled');await new Promise(r=>setTimeout(r,20));}return Response.json({status:'completed',usage:{input_tokens:10,output_tokens:3},output:hand?[{type:'function_call',name:'finish_event',call_id:'event1',arguments:JSON.stringify({action:'deliver',text:'我整理好了，结果已经核对。'})}]:[{type:'message',content:[{type:'output_text',text:'前台仍可聊天'}]}]});};`);
 const env={...process.env,XIN_HOME:control,XIN_WORK:root+'/work',CODEX_HOME:root+'/codex',NODE_OPTIONS:'--require='+preload,XIN_TASK_MAX:'1',XIN_FRONT_PROVIDER:'deepseek'};
  const ensureState=require('./helpers/state-mode.cjs').stateClient(t,env);
 const parent={sid:'shandoffparent',agent:'codex',runs:[],created:Date.now(),title:'fixture'},task={sid:'shandoffwork01',no:1,parent:parent.sid,kind:'task',tkind:'research',title:'整理资料',goal:'整理资料并核对',status:'running',model:'kimi-k3.1-pro',runs:['rhandoffwork01'],dir:root+'/work/project',created:Date.now(),inbox:[]};fs.mkdirSync(task.dir);
 const write=(file,value)=>fs.writeFileSync(control+'/'+file,JSON.stringify(value));write('sessions/'+parent.sid+'.json',parent);write('sessions/'+task.sid+'.json',task);write('runs/rhandoffwork01.json',{sid:task.sid,started:Date.now(),ended:Date.now()});fs.writeFileSync(control+'/runs/rhandoffwork01.jsonl',JSON.stringify({t:'text',text:'资料已整理并核对。'})+'\n');
 const call=(op,args={})=>{ ensureState();const r=spawnSync(process.execPath,[agent,op],{env,input:JSON.stringify(args),encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);const x=JSON.parse(r.stdout);assert.ok(!x.error,JSON.stringify(x));return x;};
 const internal=(op,args={})=>{ensureState();const r=lockedSpawn(agent,op,args,{env,encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 const read=()=>JSON.parse(fs.readFileSync(control+'/sessions/'+task.sid+'.json'));
 const wait=async(fn,timeout=15000)=>{const start=performance.now(),wall=Date.now(),deadline=start+timeout;while(performance.now()<deadline){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw Error('handoff fixture timed out; elapsed='+Math.round(performance.now()-start)+'ms wall='+Math.round(Date.now()-wall)+'ms');};
 t.after(async()=>{const a=await import(pathToFileURL(agent).href);for(let i=0;i<30;i++){let alive=false;for(const n of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)&&+n!==process.pid)){try{if(!fs.readFileSync('/proc/'+n+'/environ','utf8').split('\0').includes('XIN_HOME='+control))continue;const id=a.processIdentity(+n);if(id&&!['Z','X'].includes(id.state)){alive=true;a.signalProcessGroup(+n,id,'SIGKILL');}}catch{}}if(!alive)break;await new Promise(r=>setTimeout(r,30));}fs.rmSync(root,{recursive:true,force:true});});
 return{root,control,parent,task,call,internal,read,wait,calls,write};
}
test('后台完成自动唤回 DeepSeek，持久交付一次，网页关闭也不依赖轮询',async t=>{
 const f=fixture(t);f.internal('task_finish',{sid:f.task.sid,run:'rhandoffwork01',ok:true});
 await f.wait(()=>f.read().delivery?.state==='delivered');const h=f.call('history',{sid:f.parent.sid});
 const visible=h.runs.flatMap(r=>r.events).filter(e=>e.t==='text');assert.equal(visible.length,1);assert.match(visible[0].text,/我整理好了/);assert.equal(visible[0].taskResult.sid,f.task.sid);
 assert.equal(visible[0].taskResult.deliveredAt,f.read().delivery.at,'转达那句带上说出来的时间：页面的框用时算到这时（站长 11-18）');
 const calls=fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,1);assert.equal(calls[0].model,'deepseek-v4.1-flash');
 f.internal('task_finish',{sid:f.task.sid,run:'rhandoffwork01',ok:true});f.call('tasks',{sid:f.parent.sid});assert.equal(f.call('history',{sid:f.parent.sid}).runs.flatMap(r=>r.events).filter(e=>e.t==='text').length,1);
});
test('用户新消息优先于正在生成的完成汇报，旧回调不能覆盖新一轮',async t=>{
 const f=fixture(t,{slow:true});f.internal('task_finish',{sid:f.task.sid,run:'rhandoffwork01',ok:true});await f.wait(()=>fs.existsSync(f.calls));
 const before=f.call('history',{sid:f.parent.sid});assert.ok(before.active);const response=f.call('send',{sid:f.parent.sid,text:'继续和我聊天',clientId:'new-user-message-01'});assert.notEqual(response.run,before.active.run);
 const p=await f.wait(()=>{const p=f.call('poll',{run:response.run,off:0});return p.done?p:null;});assert.ok(p.events.some(e=>e.t==='text'&&e.text==='前台仍可聊天'));
 const log=fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse);assert.equal(log[0].handoff,true);assert.equal(log[1].handoff,false);
});
test('完成事件过期后不播报旧结果；同消息不同内容拒绝，不重复开轮次',async t=>{
 const f=fixture(t);const sent=f.call('send',{sid:f.parent.sid,text:'一次输入',clientId:'stable-input-id01'});const duplicate=f.call('send',{sid:f.parent.sid,text:'一次输入',clientId:'stable-input-id01'});assert.equal(duplicate.run,sent.run);
 const changed=f.internal('send',{sid:f.parent.sid,text:'换成别的内容',clientId:'stable-input-id01'});assert.equal(changed.error,'message_conflict');assert.equal(f.call('history',{sid:f.parent.sid}).runs.length,1);
 const {StateJournal}=await import('../site/xin/vm-state.mjs');const j=new StateJournal(f.control);j.enqueueHandoff({id:'obsolete',parent:f.parent.sid,task:f.task.sid,version:'old-version',payload:{ok:true}});j.close();
 f.internal('handoff_start',{id:'obsolete',sid:f.parent.sid});const fresh=new StateJournal(f.control);assert.equal(fresh.handoff('obsolete').state,'superseded');fresh.close();
});
test('前台进程在接单后被杀，监督器恢复原轮次，输入和可见回复各只有一次',async t=>{
 const f=fixture(t,{slowUser:true}),r=f.call('send',{sid:f.parent.sid,text:'崩溃恢复测试',clientId:'crash-recovery-001'});await f.wait(()=>fs.existsSync(f.calls));const m=JSON.parse(fs.readFileSync(f.control+'/runs/'+r.run+'.json'));assert.ok(m.pid);process.kill(m.pid,'SIGKILL');fs.writeFileSync(f.root+'/release-user-reply','');
 const pending=f.wait(()=>{const p=f.call('poll',{run:r.run,off:0});return p.done?p:null;},25000),wallNow=Date.now;let p;Date.now=()=>wallNow()+60000;try{p=await pending;}finally{Date.now=wallNow;}assert.equal(p.events.filter(e=>e.t==='user').length,1);assert.equal(p.events.filter(e=>e.t==='text').length,1);assert.equal(p.events.find(e=>e.t==='text').text,'前台仍可聊天');assert.equal(f.call('send',{sid:f.parent.sid,text:'崩溃恢复测试',clientId:'crash-recovery-001'}).run,r.run);
});
test('自动返工最多两次，重复回执不重复续接，预算耗尽后只汇报结果',async t=>{
 const f=fixture(t),{StateJournal}=await import('../site/xin/vm-state.mjs'),{workVersion}=await import('../site/xin/vm-handoff.mjs');const j=new StateJournal(f.control);
 f.task.status='failed';f.task.result={ok:false,text:'尚未完成',at:Date.now()};f.task.autoContinues=1;f.write('sessions/'+f.task.sid+'.json',f.task);
 const holder={...f.task,sid:'sholder001',no:2,status:'running',runs:['rholder001'],autoContinues:0};f.write('sessions/'+holder.sid+'.json',holder);f.write('runs/rholder001.json',{sid:holder.sid,pid:process.pid,started:Date.now()});fs.writeFileSync(f.control+'/runs/rholder001.jsonl','');
 const prepare=(id,run)=>{f.parent.runs=[run];f.write('sessions/'+f.parent.sid+'.json',f.parent);f.write('runs/'+run+'.json',{sid:f.parent.sid,agent:'codex',model:'deepseek-v4.1-flash',handoff:id,pid:process.pid,started:Date.now()});fs.writeFileSync(f.control+'/runs/'+run+'.jsonl','');j.enqueueHandoff({id,parent:f.parent.sid,task:f.task.sid,version:workVersion(f.read()),payload:{}});j.startHandoff(id,run);};
 prepare('repair1','rrepair001');const args={run:'rrepair001',argv:['xin','task','tell','1','补齐验证证据']};const r=f.internal('front_action',args);assert.equal(r.terminal,true);assert.equal(r.text,'');assert.equal(f.read().autoContinues,2);assert.equal(f.read().status,'queued');assert.equal(f.internal('front_action',args).task.sid,f.task.sid);assert.equal(f.read().autoContinues,2);
 const task=f.read();task.status='failed';task.result.at++;f.write('sessions/'+task.sid+'.json',task);prepare('repair2','rrepair002');assert.equal(f.internal('front_action',{run:'rrepair002',argv:['xin','task','tell','1','再次返工']}).error,'budget');assert.equal(f.read().autoContinues,2);j.close();
});
