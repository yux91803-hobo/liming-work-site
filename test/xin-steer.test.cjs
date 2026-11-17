// 后台干活时补充要求（docs/superpowers/specs/2026-11-17-xin-steer-design.md）：
// Gemini（Antigravity）后台每一步之间接补充；交结果前又来补充就再走一步；没正常做完时补充带到下一轮；换模型时交给新模型；
// 同一编号只算一次；tell 的回执说清进了当前这一轮还是要等这一轮跑完。
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { lockedSpawn } = require('./helpers/locked.cjs');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const agent=path.join(__dirname,'../site/xin/vm-agent.mjs');

const { fakeAgy, fakeCodex } = require('./helpers/fake-agy.cjs');
function fixture(t,script,extra={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-steer-')),control=root+'/control',profile=root+'/profile',bin=root+'/bin';
 for(const p of [control+'/sessions',control+'/runs',profile,bin])fs.mkdirSync(p,{recursive:true});
 const preload=root+'/preload.cjs';fs.writeFileSync(preload,'require("node:os").homedir=()=>'+JSON.stringify(profile)+';require("node:module").syncBuiltinESMExports();');
 fs.writeFileSync(root+'/script.json',JSON.stringify(script));
 fs.writeFileSync(bin+'/agy',fakeAgy(root),{mode:0o755});fs.writeFileSync(bin+'/codex',fakeCodex(root),{mode:0o755});
 const env={...process.env,PATH:bin+':'+process.env.PATH,NODE_OPTIONS:'--require='+preload,XIN_HOME:control,XIN_WORK:root+'/work',CODEX_HOME:profile+'/.codex',XIN_AGY_HOME:profile,
  XIN_ANTIGRAVITY_BIN:bin+'/agy',XIN_CODEX_TRANSPORT:'exec',XIN_TASK_SANDBOX:'0',XIN_AGY_IDLE_MS:'60000',...extra};
 const ensureState=require('./helpers/state-mode.cjs').stateClient(t,env);
 const call=(op,args={})=>{ensureState();const r=lockedSpawn(agent,op,args,{env,encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 t.after(()=>stopOwned(control,root));
 const until=async(fn,what,ms=15000)=>{let v;for(const end=performance.now()+platformTimeout(ms);performance.now()<end;){v=fn();if(v)return v;await new Promise(r=>setTimeout(r,30));}assert.fail('等不到：'+what);};
 const at=n=>until(()=>fs.existsSync(root+'/at-'+n),'第 '+n+' 次请求');
 const go=n=>fs.writeFileSync(root+'/go-'+n,'');
 const calls=()=>fs.existsSync(root+'/calls.jsonl')?fs.readFileSync(root+'/calls.jsonl','utf8').trim().split('\n').map(JSON.parse):[];
 // 先调 tasks：有人来看时控制器才检查 runner 还在不在（被杀的这样被发现）
 const status=(sid,want)=>until(()=>{call('tasks',{all:true});const h=call('history',{sid});return want.includes(h.task.status)&&h;},'任务状态 '+want.join('/'),20000);
 const meta=run=>JSON.parse(fs.readFileSync(control+'/runs/'+run+'.json','utf8'));
 return {root,control,call,until,at,go,calls,status,meta};
}

test('Gemini 后台每一步之间接补充：回执说进了当前这一轮；下一步的请求最前面带着补充；同一编号只算一次',async t=>{
 const f=fixture(t,[{action:'shell',command:'echo alpha-main >> list.txt'},{action:'shell',command:'echo beta-backup >> list.txt',gate:true},{action:'final',text:'只列启用的：alpha-main'}]);
 const task=f.call('task_new',{kind:'research',goal:'按顺序核对 alpha-main、beta-backup、gamma-main'}).task;
 await f.at(2);
 const said='刚才那件事，备用的别列，只列实际启用的';
 const r=f.call('task_tell',{sid:task.sid,text:said,clientId:'steer-dup-0001'});
 assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.delivery,'now',JSON.stringify(r));
 // 断线重送：同一编号再来一次，只算一次
 const again=f.call('task_tell',{sid:task.sid,text:said,clientId:'steer-dup-0001'});
 assert.equal(again.ok,true);assert.equal(again.delivery,'now');
 f.go(2);
 const h=await f.status(task.sid,['done','failed']);
 assert.equal(h.task.status,'done',JSON.stringify(h.task));
 const c=f.calls();assert.equal(c.length,3,JSON.stringify(c.map(x=>x.prompt.slice(0,40))));
 assert.ok(!c[0].prompt.includes(said)&&!c[1].prompt.includes(said),'补充之前的请求不带它');
 assert.ok(c[2].prompt.startsWith('【兄弟刚补充了要求】'),c[2].prompt.slice(0,120));
 assert.equal(c[2].prompt.split(said).length-1,1,'只送一次');
 assert.match(c[2].prompt,/正在跑的命令照常做完；还没做的步骤按新要求重新判断；之前查到的结果也按新要求重新筛一遍/);
 // 同一轮做完：没有因为补充再起一轮；补充在这一轮的过程里显示成兄弟的一句话，在第三次请求之前
 assert.equal(h.runs.length,1);
 const evs=h.runs[0].events,steer=evs.findIndex(e=>e.t==='user'&&e.steer);
 assert.ok(steer>0&&evs[steer].text===said,JSON.stringify(evs.map(e=>e.t)));
 assert.equal(evs.filter(e=>e.t==='user'&&e.steer).length,1);
 const m=f.meta(h.runs[0].run);assert.deepEqual(m.steers.map(x=>[x.text,x.state]),[[said,'accepted']]);
 assert.equal(h.task.result.text,'只列启用的：alpha-main');
});

test('Gemini 交了结果，这时又来了补充：不结束，带着补充再走一步，最后的结果按补充改过',async t=>{
 const f=fixture(t,[{action:'final',text:'第一版：alpha-main、beta-backup',gate:true},{action:'final',text:'按补充改过：alpha-main'}]);
 const task=f.call('task_new',{kind:'research',goal:'列出模型'}).task;
 await f.at(1);
 assert.equal(f.call('task_tell',{sid:task.sid,text:'备用的别列'}).delivery,'now');
 f.go(1);
 const h=await f.status(task.sid,['done','failed']);
 assert.equal(h.task.result.text,'按补充改过：alpha-main');
 const c=f.calls();assert.equal(c.length,2);
 assert.ok(c[1].prompt.includes('备用的别列')&&c[1].prompt.includes('你刚才交了结果'),c[1].prompt.slice(0,200));
 assert.equal(h.runs.length,1);
});

test('补充以后任务被停下：补充不丢；前台不带 --continue 的补充不重新开工，兄弟明确说继续以后带着之前的补充接着做',async t=>{
 const f=fixture(t,[{action:'shell',command:'echo alpha-main >> list.txt',gate:true},{action:'final',text:'继续后只列了启用的'}]);
 const task=f.call('task_new',{kind:'research',goal:'核对模型清单'}).task;
 await f.at(1);
 assert.equal(f.call('task_tell',{sid:task.sid,text:'备用的别列'}).delivery,'now');
 assert.equal(f.call('task_stop',{sid:task.sid}).ok,true);
 const stopped=await f.status(task.sid,['stopped']);
 assert.equal(stopped.task.inbox,1,'停下时收到的补充还留着');
 // 前台转过来的补充（没说继续）：不重新开工，回执给出现在的状态
 const front=f.call('task_tell',{sid:task.sid,text:'再加一条',front:true});
 assert.equal(front.ended,true,JSON.stringify(front));assert.equal(front.status,'stopped');
 assert.equal(f.call('history',{sid:task.sid}).task.status,'stopped');
 // 网页任务详情里说继续：接着做，这一轮开头带着停下前的补充
 const go=f.call('task_tell',{sid:task.sid,text:'继续'});
 assert.equal(go.delivery,'resumed',JSON.stringify(go));
 const h=await f.status(task.sid,['done','failed']);
 assert.equal(h.task.status,'done');
 const c=f.calls(),resumed=c.at(-1).prompt;
 assert.ok(resumed.includes('兄弟之前补充过')&&resumed.includes('备用的别列')&&resumed.includes('再加一条')&&resumed.includes('继续'),resumed.slice(0,300));
 assert.ok(resumed.indexOf('兄弟之前补充过')<resumed.indexOf('备用的别列')&&resumed.indexOf('备用的别列')<resumed.indexOf('再加一条')&&resumed.indexOf('再加一条')<resumed.indexOf('用户又说：继续'),'按先后，最后是这一句');
});

test('Gemini 额度用完换模型接着做：这一轮收到的补充一起交给接手的模型',async t=>{
 const f=fixture(t,[{action:'shell',command:'echo alpha-main >> list.txt'},{quota:true,gate:true}]);
 const task=f.call('task_new',{kind:'research',goal:'核对模型清单'}).task;
 await f.at(2);
 assert.equal(f.call('task_tell',{sid:task.sid,text:'备用的别列，只列启用的'}).delivery,'now');
 f.go(2);
 const h=await f.status(task.sid,['done','failed']);
 assert.equal(h.task.status,'done',JSON.stringify(h.task));
 const args=fs.readFileSync(f.root+'/codex.args','utf8');
 assert.ok(args.includes('备用的别列，只列启用的')&&args.includes('兄弟在你之前那个执行入口干活时补充过'),args.slice(0,400));
 const m=f.meta(h.runs[0].run);assert.ok(m.steers.every(x=>x.state==='accepted'),JSON.stringify(m.steers));
});

test('runner 被杀（电脑重启）：自动接着做的那一轮带着之前的补充',async t=>{
 const f=fixture(t,[{action:'shell',command:'echo alpha-main >> list.txt',gate:true},{action:'final',text:'重启后接着做完'}],{XIN_DEAD_MS:'1500'});
 const task=f.call('task_new',{kind:'research',goal:'核对模型清单'}).task;
 await f.at(1);
 assert.equal(f.call('task_tell',{sid:task.sid,text:'备用的别列'}).delivery,'now');
 const run=f.call('history',{sid:task.sid}).runs[0].run;
 const pid=await f.until(()=>f.meta(run).pid,'pid');
 try{process.kill(pid,'SIGKILL');}catch{}
 for(const p of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n))){try{if(fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes(f.root+'/bin/agy'))process.kill(Number(p),'SIGKILL');}catch{}}
 const h=await f.status(task.sid,['done','failed']);
 assert.equal(h.task.status,'done',JSON.stringify(h.task));
 assert.equal(h.runs.length,2);
 const resumed=f.calls().at(-1).prompt;
 assert.ok(resumed.includes('刚才电脑暂停或重启')&&resumed.includes('兄弟之前补充过')&&resumed.includes('备用的别列'),resumed.slice(0,300));
});

test('不能插话的执行方式（点名的 Codex 线路用 exec）：回执说这一轮跑完再按补充接着做；还没开始的任务并进要求',async t=>{
 const f=fixture(t,[{action:'final',text:'x'}]);
 fs.writeFileSync(f.root+'/codex-gate','');
 const task=f.call('task_new',{kind:'research',goal:'核对模型清单',model:'kimi-k3.1-pro',named:true,strictModel:true}).task;
 await f.until(()=>fs.existsSync(f.root+'/codex-at'),'codex 在做');
 // 排在它后面、还没开始的：补充并进要求
 const later=f.call('task_new',{kind:'research',goal:'等前一个做完再整理',after:[task.no],model:'kimi-k3.1-pro',named:true,strictModel:true}).task;
 const merged=f.call('task_tell',{sid:later.sid,text:'整理时只要启用的'});
 assert.equal(merged.delivery,'start',JSON.stringify(merged));
 const r=f.call('task_tell',{sid:task.sid,text:'备用的别列'});
 assert.equal(r.delivery,'next',JSON.stringify(r));assert.match(r.msg,/这一轮跑完/);
 fs.writeFileSync(f.root+'/codex-go','');
 const h=await f.status(task.sid,['done','failed']);
 assert.equal(h.runs.length,2,'这一轮跑完按补充再起一轮');
 await f.status(later.sid,['done','failed']);
 const args=fs.readFileSync(f.root+'/codex.args','utf8');
 assert.ok(args.includes('备用的别列')&&args.includes('整理时只要启用的'),args.slice(-400));
});

test('前台什么时候附 <手上的事>：只认补充、改主意、要停或要接着做的说法，不看词重不重合（#117：每轮都带进行中会把任何一句答成进度）',async()=>{
 const {mentionsWork}=await import('../site/xin/vm-steer.mjs');
 for(const text of ['刚才查模型那件事，备用的别列，只查实际启用的','备用的不用列了','只要正在用的','改成 PA1','先停下','继续','接着做吧','那个任务做到哪了','顺便把蓝灯也加上','算了，不做了'])
  assert.equal(mentionsWork(text),true,text);
 // 正式站联调那句（和派活原话共用「回复、后台、执行」）、平常聊天：不附
 for(const text of ['只回复 陀螺 茶壶 贝壳，不要执行命令，也不要等待后台。','在吗','今天天气怎么样','解释一下 GPIO 的推挽输出','嗯'])
  assert.equal(mentionsWork(text),false,text);
});

// 原对话：note 要回到这里（测试直接建一个对话记录）
function conversation(f){const sid='sconvnote'+Math.random().toString(36).slice(2,8);fs.writeFileSync(f.control+'/sessions/'+sid+'.json',JSON.stringify({sid,agent:'codex',title:'查模型',runs:[],created:Date.now(),updated:Date.now()}));return sid;}
// Read this synthetic fixture only, before teardown; extra controller calls could change the failed state.
function noteDiagnostics(f){
 const read=(name,format='json')=>{try{const body=fs.readFileSync(path.join(f.root,name),'utf8');return format==='text'?body.slice(-16000):format==='jsonl'?body.trim().split('\n').filter(Boolean).map(JSON.parse):JSON.parse(body);}catch(e){return {error:e.code||e.name};}};
 const files=dir=>{try{return fs.readdirSync(path.join(f.control,dir)).filter(n=>/\.jsonl?$/.test(n)).map(name=>({name,value:read('control/'+dir+'/'+name,name.endsWith('.jsonl')?'jsonl':'json')}));}catch(e){return {error:e.code||e.name};}};
 let journal,db;
 try{
  const {DatabaseSync}=require('node:sqlite');db=new DatabaseSync(path.join(f.control,'workflow.sqlite'),{readOnly:true});
  journal={launches:db.prepare('SELECT * FROM launches ORDER BY at').all(),handoffs:db.prepare('SELECT * FROM handoffs ORDER BY nextAt,id').all(),commands:db.prepare('SELECT COUNT(*) AS count FROM commands').get(),
   documents:db.prepare("SELECT name,body FROM documents WHERE name GLOB 'sessions/s*.json' OR name GLOB 'runs/r*.json' ORDER BY name").all().map(r=>({name:r.name,value:JSON.parse(r.body)}))};
 }catch(e){journal={error:e.code||e.name};}finally{db?.close();}
 const calls=read('calls.jsonl','jsonl');
 return {root:f.root,snapshotAt:Date.now(),monotonicMs:performance.now(),defaultUserBusExists:fs.existsSync('/run/user/'+process.getuid()+'/bus'),calls:Array.isArray(calls)?calls.map(c=>({...c,promptLength:String(c?.prompt??'').length,prompt:String(c?.prompt??'').slice(0,2000)})):calls,sessions:files('sessions'),runs:files('runs'),journal,
  modelStats:read('control/model-stats.jsonl','jsonl'),quota:read('control/antigravity-quota.json'),issue:read('control/antigravity-stall.json'),
  budgets:files('budgets'),ownerError:read('control/test-state-error.log','text'),codexFallback:read('codex.args','jsonl')};
}
test('Gemini 后台主动说一句：相关的两条合成一条，任务还在做时回原聊天（不起模型）；回执交回模型、它接着做',async t=>{
 const f=fixture(t,[{action:'note',text:'两份配置写的默认模型不一样，我再核一下实际启动的是哪个'},{action:'note',text:'实际启动的是 config.toml 里的那个'},{action:'shell',command:'echo checked',gate:true},{action:'final',text:'实际启用的只有一个'}],{XIN_NOTE_WAIT_MS:'1200'});
 let lastTasksReply;
 try{
 const sid=conversation(f),task=f.call('task_new',{kind:'research',goal:'查电脑上有哪些 Agent 模型',parent:sid}).task;
 await f.at(3);
 const c=f.calls();
 assert.match(c[1].prompt,/^记下了，过一会儿回原聊天告诉兄弟/);assert.match(c[2].prompt,/^和刚才那条合成一条转告兄弟/);
 const notes=await f.until(()=>{lastTasksReply=f.call('tasks',{sid});const n=lastTasksReply.notes;return n&&n.length&&n;},'原聊天里出现那一句',10000);
 assert.equal(notes.length,1,'合成一条');
 assert.equal(notes[0].text,'两份配置写的默认模型不一样，我再核一下实际启动的是哪个\n实际启动的是 config.toml 里的那个');
 assert.deepEqual(notes[0].task,{sid:task.sid,no:task.no});
 const h=f.call('history',{sid}),run=h.runs.at(-1);
 assert.deepEqual(run.events.map(e=>e.t),['text','done']);assert.equal(run.events[0].text,notes[0].text);
 assert.equal(f.meta(run.run).kind,'note');assert.ok(!f.meta(run.run).model,'没有调模型');
 // 任务的过程里也看得到这两句
 const th=f.call('history',{sid:task.sid});assert.equal(th.runs[0].events.filter(e=>e.t==='note').length,2);
 f.go(3);
 assert.equal((await f.status(task.sid,['done','failed'])).task.status,'done');
 }catch(error){
  try{
  const snapshot={...noteDiagnostics(f),lastTasksReply},print=(section,value)=>{for(const row of Array.isArray(value)?value:[value])t.diagnostic(section+' '+JSON.stringify(row));};
  for(const [section,value] of Object.entries(snapshot)){
   if(section==='journal')for(const [key,rows] of Object.entries(value))print('journal.'+key,rows);else print(section,value);
  }
  }catch(diagnosticError){t.diagnostic('note diagnostics failed: '+(diagnosticError?.code||diagnosticError?.name||'unknown'));}
  throw error;
 }
});

test('主动说的那句还没发出去任务就做完了：不再冒出来（最终结果先到了）',async t=>{
 const f=fixture(t,[{action:'note',text:'我先核一下实际启动的是哪个'},{action:'final',text:'实际启用的是 A'}],{XIN_NOTE_WAIT_MS:'1500'});
 const sid=conversation(f),task=f.call('task_new',{kind:'research',goal:'查模型',parent:sid}).task;
 await f.status(task.sid,['done']);
 await new Promise(r=>setTimeout(r,2500));
 f.call('tasks',{sid});f.call('tasks',{sid});
 assert.equal((f.call('tasks',{sid}).notes||[]).length,0,'最终结果先到了，那句「我先核一下」不发');
 // 原对话里只有交付结果的那一轮（完成交接），没有主动说的那一轮
 assert.equal(f.call('history',{sid}).runs.filter(r=>f.meta(r.run).kind==='note').length,0);
});

test('每件事最多主动说 3 次：之后的只进过程，回执让它把后面的发现写进最后的结果',async t=>{
 const f=fixture(t,[{action:'shell',command:'echo working',gate:true},{action:'final',text:'好了'}],{XIN_NOTE_WAIT_MS:'200'});
 const sid=conversation(f),task=f.call('task_new',{kind:'research',goal:'查模型',parent:sid}).task;
 await f.at(1);
 const run=f.call('history',{sid:task.sid}).runs[0].run;
 for(let i=1;i<=3;i++){
  assert.match(f.call('task_note',{sid:task.sid,run,text:'第 '+i+' 个发现'}).msg,/过一会儿回原聊天告诉兄弟/);
  await f.until(()=>{f.call('tasks',{sid});return (f.call('tasks',{sid}).notes||[]).length===i;},'第 '+i+' 条回到原聊天',30000);
 }
 assert.match(f.call('task_note',{sid:task.sid,run,text:'第 4 个发现'}).msg,/已经主动说过 3 次了，这条只记在过程里；后面的发现写进最后的结果/);
 await new Promise(r=>setTimeout(r,800));f.call('tasks',{sid});
 assert.equal(f.call('tasks',{sid}).notes.length,3);
 assert.equal(f.call('history',{sid:task.sid}).runs[0].events.filter(e=>e.t==='note').length,4,'4 条都在过程里');
 // 同一编号再来一次（重送）：只算一次
 assert.equal(f.call('task_note',{sid:task.sid,run,text:'重送',id:'note-dup-0001'}).ok,true);
 assert.equal(f.call('task_note',{sid:task.sid,run,text:'重送',id:'note-dup-0001'}).duplicate,true);
 f.go(1);
 await f.status(task.sid,['done','failed']);
});

test('Codex 任务经任务桥主动说一句：请求编号去重，转给控制器记下',async()=>{
 const {createTaskBridgeHandler}=await import('../site/xin/vm-task-reports.mjs');
 const seen=[],run={task:true,bridgeProtocol:1,sid:'stask0001',run:'rtask0001'},task={kind:'task',status:'running',workspace:{}};
 const h=createTaskBridgeHandler({loadRun:()=>run,loadTask:()=>task,isTask:t=>t.kind==='task',lastRun:()=>'rtask0001',remember:()=>({}),ask:()=>({}),note:a=>{seen.push(a);return {ok:true,msg:'记下了，过一会儿回原聊天告诉兄弟'};}});
 const r=h({op:'note',sid:'stask0001',run:'rtask0001',id:'0123456789abcdef01234567',text:'两份配置写的默认模型不一样'});
 assert.equal(r.text,'记下了，过一会儿回原聊天告诉兄弟');
 assert.deepEqual(seen,[{sid:'stask0001',run:'rtask0001',id:'b0123456789abcdef01234567',text:'两份配置写的默认模型不一样'}]);
 assert.equal(h({op:'unknown',sid:'stask0001',run:'rtask0001',text:'x'}).error,'bad_bridge_request');
});
