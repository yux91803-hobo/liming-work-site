const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const { lockedSpawn } = require('./helpers/locked.cjs');
const { platformTimeout } = require('./helpers/timeout.cjs');
const {stopOwned}=require('./helpers/stop-owned.cjs');
const {pathToFileURL}=require('node:url');
const agent=path.join(__dirname,'../site/xin/vm-agent.mjs'),load=()=>import('../site/xin/vm-runtime.mjs');
test('Antigravity 额度同时受五小时和周限额约束，持久记录真实恢复时间',async()=>{
 const r=await load(),now=Date.parse('2026-11-07T12:00:00Z'),five=now+3600000,week=now+7*86400000;
 const input=(a,b)=>({command:{data:{groups:[{buckets:[{id:'gemini-5h',remaining_fraction:a,reset_time:new Date(five).toISOString()},{id:'gemini-weekly',remaining_fraction:b,reset_time:new Date(week).toISOString()}]},{buckets:[{id:'3p-weekly',remaining_fraction:0,reset_time:new Date(week).toISOString()}]}]}}});
 assert.equal(r.antigravityQuota(input(.8,1),now).blocked,false);assert.equal(r.antigravityQuota(input(0,1),now).retryAt,five);assert.equal(r.antigravityQuota(input(0,0),now).retryAt,week);
 assert.throws(()=>r.antigravityQuota({}),/额度/);const bad=input(0,1);bad.command.data.groups[0].buckets[0].reset_time='unknown';assert.throws(()=>r.antigravityQuota(bad),/字段/);
 assert.deepEqual(r.AGY_SETTINGS.permissions.deny,['command(*)','read_file(*)','write_file(*)','execute_url(*)','mcp(*)']);assert.equal(r.AGY_SETTINGS.useG1Credits,false);
 const exhausted=r.antigravityQuota(input(0,1),now),late=r.antigravityQuota(input(.9,1),now+1000);assert.equal(r.mergeAntigravityQuota(exhausted,late,now+1000).retryAt,five);assert.equal(r.mergeAntigravityQuota(exhausted,late,five+1).blocked,false);
});
test('Claude 周限额用完时五小时限额被停用、不带恢复时间：算额度用完（前台改用 DeepSeek），不报字段不完整',async()=>{
 const r=await load(),now=Date.parse('2026-11-11T04:30:00Z'),week=Date.parse('2026-11-15T10:46:26Z');
 // 云电脑上 /usage 实际返回的形状
 const usage={command:{data:{groups:[{buckets:[{id:'gemini-weekly',window:'weekly',remaining_fraction:.98,reset_time:'2026-11-14T11:52:32Z'},{id:'gemini-5h',window:'5h',remaining_fraction:.99,reset_time:'2026-11-11T05:33:10Z'}]},
  {buckets:[{id:'3p-weekly',window:'weekly',remaining_fraction:0,reset_time:'2026-11-15T10:46:26Z'},{id:'3p-5h',window:'5h',disabled:true,remaining_fraction:.857}]}]}}};
 const q=r.antigravityQuota(usage,now,'claude-opus-4.6');
 assert.equal(q.blocked,true);assert.equal(q.retryAt,week);assert.deepEqual(q.buckets.map(b=>b.id),['3p-weekly']);
 assert.equal(r.antigravityQuota(usage,now).blocked,false,'Gemini 不受影响');
 // 没有停用标记、只是缺恢复时间：仍然当成数据不可信
 const bad=structuredClone(usage);delete bad.command.data.groups[1].buckets[1].disabled;assert.throws(()=>r.antigravityQuota(bad,now,'claude-opus-4.6'),/字段/);
 // 全部都停用：没有可核对的限额
 const off=structuredClone(usage);off.command.data.groups[1].buckets.forEach(b=>b.disabled=true);assert.throws(()=>r.antigravityQuota(off,now,'claude-opus-4.6'),/字段/);
});
test('CLI 续接返回整段累计用量：按持久水位记增量，重启和重复响应不重复计费',async t=>{
 const r=await load(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'xin-agy-budget-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=dir+'/budget.json',first=r.requestBudget(file,128,{tokens:10000}),a={input_tokens:2212,output_tokens:2431,cache_read_tokens:0,total_tokens:4643};first();assert.deepEqual(first.recordCumulativeUsage('antigravity','own',a),a);
 const resumed=r.requestBudget(file,128,{tokens:10000}),b={input_tokens:12190,output_tokens:4829,cache_read_tokens:0,total_tokens:17019};const delta=resumed.recordCumulativeUsage('antigravity','own',b);assert.equal(delta.input_tokens,9978);assert.equal(delta.output_tokens,2398);assert.equal(delta.total_tokens,12376);
 resumed.recordCumulativeUsage('antigravity','own',b);assert.equal(JSON.parse(fs.readFileSync(file)).total,17019);assert.equal(resumed(),false);assert.throws(()=>resumed.recordCumulativeUsage('antigravity','own',a),/倒退/);
});
function fixture(t,mode='ok'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-agy-test-')),control=root+'/control',profile=root+'/profile',bin=root+'/bin',log=root+'/calls.jsonl';for(const p of [control+'/sessions',control+'/runs',profile,bin])fs.mkdirSync(p,{recursive:true});
 const preload=root+'/preload.cjs';fs.writeFileSync(preload,'require("node:os").homedir=()=>'+JSON.stringify(profile)+';require("node:module").syncBuiltinESMExports();');
 const agy=bin+'/agy';fs.writeFileSync(agy,'#!'+process.execPath+'\n'+`const fs=require('node:fs'),a=process.argv.slice(2),quota=a[a.indexOf('-p')+1]==='/usage',log=${JSON.stringify(log)},mode=${JSON.stringify(mode)};fs.appendFileSync(log,JSON.stringify({quota,args:a.filter((_,i)=>i===a.indexOf('--model')+1||i===a.indexOf('--effort')+1),key:!!process.env.XIN_CODEX_KEY,cwd:process.cwd()})+'\\n');const count=fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse).filter(x=>x.quota).length;const send=o=>console.log(JSON.stringify(o));if(quota){send({event:'result',result:{status:'SUCCESS',command:{data:{groups:[{buckets:[{id:'gemini-5h',remaining_fraction:mode==='quota'&&count>1?0:1,reset_time:new Date(Date.now()+3600000).toISOString()},{id:'gemini-weekly',remaining_fraction:1,reset_time:new Date(Date.now()+604800000).toISOString()}]}]}}}});process.exit(0);}if(mode==='crash'){process.stderr.write('unknown flag');process.exit(2);}send({event:'init',init:{model:mode==='wrong'?'another-model':a[a.indexOf('--model')+1]}});if(mode==='unfinished'){send({event:'result',result:{conversation_id:'12345678-1234-1234-1234-123456789abc',status:'ERROR',response:''}});process.exit(0);}const turns=fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse).filter(x=>!x.quota).length;if(mode==='stall'||mode==='stall2'&&turns>1){setInterval(()=>{},1e9);return;}if(mode==='stall2'){send({event:'result',result:{conversation_id:'12345678-1234-1234-1234-123456789abc',status:'SUCCESS',structured_output:{action:'shell',command:'echo half > half.txt',text:''},usage:{input_tokens:20,output_tokens:8}}});process.exit(0);}if(mode==='quota')send({event:'step_update',step_update:{state:'DONE',step_type:'search_web',step_index:1}});send({event:'result',result:{conversation_id:'12345678-1234-1234-1234-123456789abc',status:mode==='quota'?'ERROR':'SUCCESS',structured_output:{action:'final',command:'',text:'真实入口完成'},usage:{input_tokens:20,output_tokens:8}}});`,{mode:0o755});
 fs.writeFileSync(bin+'/codex','#!'+process.execPath+'\n'+`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(root+'/fallback.log')},'codex\\n');fs.appendFileSync(${JSON.stringify(root+'/fallback.args')},process.argv.slice(2).join(' ')+'\\n');console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'保留原进度后完成'}}));`,{mode:0o755});
 const env={...process.env,PATH:bin+':'+process.env.PATH,NODE_OPTIONS:'--require='+preload,XIN_HOME:control,XIN_WORK:root+'/work',CODEX_HOME:profile+'/.codex',XIN_AGY_HOME:profile,XIN_ANTIGRAVITY_BIN:agy,XIN_CODEX_TRANSPORT:'exec',XIN_TASK_SANDBOX:'0',XIN_CODEX_KEY:'must-not-reach-agy',XIN_AGY_IDLE_MS:'1500'};
  const ensureState=require('./helpers/state-mode.cjs').stateClient(t,env);
 const call=(op,args={})=>{ ensureState();const r=lockedSpawn(agent,op,args,{env,encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 t.after(()=>stopOwned(control,root));
 const wait=async sid=>{let task;for(const end=Date.now()+platformTimeout(15000);Date.now()<end;){task=call('history',{sid}).task;if(['done','failed','waiting'].includes(task.status))return task;await new Promise(r=>setTimeout(r,50));}assert.fail(JSON.stringify(task));};
 return {root,control,log,call,wait};
}
test('普通资料任务真正交给 Gemini 4 Hydrogen（查资料用 medium），前台模型和网关密钥不交给 agy',async t=>{
 const f=fixture(t),task=f.call('task_new',{kind:'research',goal:'fixture research'}).task;assert.equal(task.model,'gemini-4-hydrogen');const done=await f.wait(task.sid);assert.equal(done.status,'done',JSON.stringify(done));assert.equal(done.actualModel,'gemini-4-hydrogen');
 const calls=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse);assert.ok(calls.length>=3);assert.ok(calls.every(x=>!x.key&&x.cwd===f.control+'/antigravity-client'));assert.deepEqual(calls.find(x=>!x.quota).args,['gemini-4-hydrogen-medium','medium']);
 const quota=JSON.parse(fs.readFileSync(f.control+'/antigravity-quota.json'));assert.equal(quota.blocked,false);assert.equal(quota.buckets.length,2);
 const named=f.call('task_new',{kind:'research',goal:'named work',model:'kimi-k3.1-pro',named:true,strictModel:true}).task;assert.equal(named.model,'kimi-k3.1-pro');await f.wait(named.sid);
});
test('额度耗尽可在查过资料后转交其它入口，倒计时期间不重复请求 agy，到期才再探测',async t=>{
 const f=fixture(t,'quota'),task=f.call('task_new',{kind:'research',goal:'quota continuation'}).task,done=await f.wait(task.sid);assert.equal(done.status,'done',JSON.stringify(done));assert.notEqual(done.actualModel,'gemini-4-hydrogen');assert.equal(fs.readFileSync(f.root+'/fallback.log','utf8').trim(),'codex');
 const authors=JSON.parse(fs.readFileSync(f.control+'/sessions/'+task.sid+'.json')).actualModels;assert.ok(authors.includes('gemini-4-hydrogen'));assert.ok(authors.includes(done.actualModel));
 const review=f.call('task_new',{kind:'review',goal:'independent audit',model:'gemini-4-hydrogen',named:true,after:[task.no]});assert.equal(review.error,'independent_review_model');
 const state=JSON.parse(fs.readFileSync(f.control+'/antigravity-quota.json'));assert.equal(state.blocked,true);assert.ok(state.retryAt>Date.now());const count=fs.readFileSync(f.log,'utf8').trim().split('\n').length;
 const next=f.call('task_new',{kind:'research',goal:'cooldown task'}).task;assert.notEqual(next.model,'gemini-4-hydrogen');await f.wait(next.sid);assert.equal(fs.readFileSync(f.log,'utf8').trim().split('\n').length,count);
 state.retryAt=Date.now()-1;fs.writeFileSync(f.control+'/antigravity-quota.json',JSON.stringify(state));const retry=f.call('task_new',{kind:'research',goal:'expired quota'}).task;assert.equal(retry.model,'gemini-4-hydrogen');await f.wait(retry.sid);assert.ok(fs.readFileSync(f.log,'utf8').trim().split('\n').length>count);
});
test('实际返回其它模型时拒绝执行，不把它当 Hydrogen 成功',async t=>{const f=fixture(t,'wrong'),a=f.call('task_new',{kind:'research',goal:'identity verification'}).task;const done=await f.wait(a.sid);assert.equal(done.status,'done');assert.notEqual(done.actualModel,'gemini-4-hydrogen');});

// 2026-11-12 正式站联调：Gemini（Antigravity）2 分 20 秒一个字不回，后台任务卡到超时。站长：「Gemini 一两分钟不回就换模型」。
// 参考 opencode 的 chunkTimeout（packages/core/src/v1/config/provider.ts：两段输出之间等不到就中止）、Codex 的 stream_idle_timeout_ms（codex-rs/model-provider-info：默认 300 秒，按服务商可改）
test('Gemini 一直不出声：到了闲置时限就换别的模型接着做，记下原因；之后 15 分钟内新任务先不派给 Gemini',async t=>{
 const f=fixture(t,'stall'),task=f.call('task_new',{kind:'research',goal:'stall research'}).task;assert.equal(task.model,'gemini-4-hydrogen');
 const t0=Date.now(),done=await f.wait(task.sid);assert.equal(done.status,'done',JSON.stringify(done));assert.notEqual(done.actualModel,'gemini-4-hydrogen');
 assert.ok(Date.now()-t0<platformTimeout(12000),'没有等满 4 分钟');
 assert.match(fs.readFileSync(f.root+'/fallback.log','utf8'),/codex/);
 const stats=fs.readFileSync(f.control+'/model-stats.jsonl','utf8').trim().split('\n').map(JSON.parse),last=stats.at(-1);
 assert.equal(last.from,'gemini-4-hydrogen');assert.match(last.fromErr||'',/没有任何回应/);
 const issue=f.call('tasks',{all:true}).antigravityIssue;assert.equal(issue.kind,'stall');assert.ok(Date.now()-issue.at<platformTimeout(15000));
 const next=f.call('task_new',{kind:'research',goal:'after stall'}).task;assert.notEqual(next.model,'gemini-4-hydrogen','刚卡过，先不派给 Gemini');await f.wait(next.sid);
 const st=JSON.parse(fs.readFileSync(f.control+'/antigravity-stall.json'));st.at=Date.now()-16*60e3;fs.writeFileSync(f.control+'/antigravity-stall.json',JSON.stringify(st));
 assert.equal(f.call('task_new',{kind:'research',goal:'later'}).task.model,'gemini-4-hydrogen','过了 15 分钟照常');
});
test('Gemini 干了一步以后才卡住：一样换模型，接手的模型先读副本里已有的文件、不重复做完的外部操作',async t=>{
 const f=fixture(t,'stall2'),task=f.call('task_new',{kind:'research',goal:'stall after work'}).task,done=await f.wait(task.sid);
 assert.equal(done.status,'done',JSON.stringify(done));assert.notEqual(done.actualModel,'gemini-4-hydrogen');
 const runs=JSON.parse(fs.readFileSync(f.control+'/sessions/'+task.sid+'.json')).runs,meta=JSON.parse(fs.readFileSync(f.control+'/runs/'+runs.at(-1)+'.json'));
 assert.equal(meta.from,'gemini-4-hydrogen');
 const ev=fs.readFileSync(f.control+'/runs/'+runs.at(-1)+'.jsonl','utf8');assert.match(ev,/echo half/,'Gemini 做过的那一步留在过程里');
 assert.match(fs.readFileSync(f.root+'/fallback.args','utf8'),/先读取同一项目副本中的现有文件/);
});

// 2026-11-13 #131 正式站联调：Gemini 约 2 分钟后回了「没做完」（状态不是 SUCCESS），控制器换 Kimi 做完了，联调却因为「不是额度原因」判失败、回滚。
// 同一时间单独探测：只回「OK」也要 118 秒（平时 40 多秒），是 Gemini 服务那边慢。和不出声一样记下来，联调据此认可这次换模型。
test('Gemini 回了没做完（状态不是 SUCCESS）：错误里写明状态，记下来，15 分钟内新任务先不派给它；换别的模型做完',async t=>{
 const f=fixture(t,'unfinished'),task=f.call('task_new',{kind:'research',goal:'unfinished research'}).task;assert.equal(task.model,'gemini-4-hydrogen');
 const done=await f.wait(task.sid);assert.equal(done.status,'done',JSON.stringify(done));assert.notEqual(done.actualModel,'gemini-4-hydrogen');
 const last=fs.readFileSync(f.control+'/model-stats.jsonl','utf8').trim().split('\n').map(JSON.parse).at(-1);
 assert.equal(last.from,'gemini-4-hydrogen');assert.match(last.fromErr||'',/状态 ERROR/);
 const issue=f.call('tasks',{all:true}).antigravityIssue;assert.equal(issue.kind,'status');assert.equal(issue.status,'ERROR');
 assert.notEqual(f.call('task_new',{kind:'research',goal:'after unfinished'}).task.model,'gemini-4-hydrogen');
});
test('agy 命令自己没跑起来（没有结果、退出码不为 0）：多半是我们这边调用出错，错误里写明退出码，不记成 Gemini 不可用',async t=>{
 const f=fixture(t,'crash'),task=f.call('task_new',{kind:'research',goal:'crash research'}).task;assert.equal(task.model,'gemini-4-hydrogen');
 await f.wait(task.sid);
 const last=fs.readFileSync(f.control+'/model-stats.jsonl','utf8').trim().split('\n').map(JSON.parse).at(-1);
 assert.equal(last.from,'gemini-4-hydrogen');assert.match(last.fromErr||'',/没有返回结果，退出码 2/);
 assert.equal(f.call('tasks',{all:true}).antigravityIssue,null);
 assert.equal(f.call('task_new',{kind:'research',goal:'after crash'}).task.model,'gemini-4-hydrogen','照常派给 Gemini');
});

// 站长 2026-11-13：「后台干活优先也派 hydrogen，根据任务难度选择思考强度」。前台按类别派活（类别就是难度），控制器按类别定思考强度：
// 参考 Codex 的 model_reasoning_effort / plan_mode_reasoning_effort（规划和执行各用各的强度）、opencode 每个 agent 自己的 reasoningEffort、
// Antigravity Orchestrator（Carbon 规划、Hydrogen 执行）。实测每一步：low 3 秒、medium 5 秒、high 7 秒、xhigh 30 秒。
test('后台优先派 Hydrogen，按类别定思考强度：杂活 low、查资料 medium、写代码和网页 high、难题 xhigh、检查 high',async t=>{
 const f=fixture(t),want={quick:'low',research:'medium',code:'high',hard:'xhigh'};
 for(const [kind,effort] of Object.entries(want)){
  const task=f.call('task_new',{kind,goal:kind+' work'}).task;assert.equal(task.model,'gemini-4-hydrogen',kind);
  const done=await f.wait(task.sid);assert.equal(done.status,'done',kind+JSON.stringify(done));assert.equal(done.actualModel,'gemini-4-hydrogen',kind);
  const last=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse).filter(x=>!x.quota).at(-1);
  assert.deepEqual(last.args,['gemini-4-hydrogen-'+effort,effort],kind);
 }
 const web=f.call('task_new',{kind:'code',goal:'web page',web:true}).task;assert.equal(web.model,'gemini-4-hydrogen','web');
 // 检查：作者不是 Hydrogen 时也交给它（high）；作者是 Hydrogen 时换别的模型看
 const other=f.call('task_new',{kind:'code',goal:'kimi wrote it',model:'kimi-k3.1-pro',named:true}).task;await f.wait(other.sid);
 const r1=f.call('task_new',{kind:'review',goal:'review kimi',after:[other.no]}).task;assert.equal(r1.model,'gemini-4-hydrogen','review of kimi');const r1done=await f.wait(r1.sid);assert.equal(r1done.actualModel,'gemini-4-hydrogen','开工时重新挑模型也保留 Hydrogen');
 const hy=f.call('task_new',{kind:'code',goal:'hydrogen wrote it'}).task;await f.wait(hy.sid);
 const r2=f.call('task_new',{kind:'review',goal:'review hydrogen',after:[hy.no]}).task;assert.notEqual(r2.model,'gemini-4-hydrogen');
});
test('不交给 Hydrogen 的：带图片、电脑维护、看图；不再用 Gemini 3.8 Flash：点名 Gemini / Flash 都交给 Hydrogen',async t=>{
 const f=fixture(t);
 fs.mkdirSync(f.root+'/work/uploads',{recursive:true});fs.writeFileSync(f.root+'/work/uploads/a.png','x');
 assert.notEqual(f.call('task_new',{kind:'quick',goal:'look',files:['uploads/a.png']}).task.model,'gemini-4-hydrogen');
 assert.notEqual(f.call('task_new',{kind:'system',goal:'disk'}).task.model,'gemini-4-hydrogen');
 assert.notEqual(f.call('task_new',{kind:'vision',goal:'see'}).task.model,'gemini-4-hydrogen');
 // 站长 2026-11-13：「以后也不用 3.8 flash 了」
 const {namedModel}=await import(pathToFileURL(path.join(__dirname,'../site/xin/vm-models.mjs')).href);
 for(const text of ['你让 Gemini 3.8 Flash 去画个奶龙','用 Gemini 写','交给 Hydrogen 做','让 Gemini 4 Hydrogen 查一下','用 antigravity 做'])assert.equal(namedModel(text),'gemini-4-hydrogen',text);
 const old=f.call('task_new',{kind:'research',goal:'old flash id',model:'gemini-3.8-flash-high',named:true}).task;assert.notEqual(old.model,'gemini-3.8-flash-high');
 await f.wait(old.sid);
 assert.ok((fs.existsSync(f.log)?fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse):[]).every(x=>x.quota||!/3\.8/.test(x.args[0])),'没有一次调用 Flash');
});
test('额度按组算：Gemini 4 Argon 的单独周限额用完，不算 Hydrogen / Flash 用完；Gemini 组用完才算',async()=>{
 const r=await import(pathToFileURL(path.join(__dirname,'../site/xin/vm-runtime.mjs')).href);
 const later=new Date(Date.now()+3600e3).toISOString(),groups=(gemini,argon)=>({command:{data:{groups:[
  {name:'Gemini Models',buckets:[{id:'gemini-weekly',remaining_fraction:gemini,reset_time:later},{id:'gemini-5h',remaining_fraction:1,reset_time:later}]},
  {name:'Claude and GPT models',buckets:[{id:'3p-weekly',remaining_fraction:0,reset_time:later}]},
  {name:'Gemini 4 Argon',buckets:[{id:'gemini-argon-wtu-weekly',remaining_fraction:argon,reset_time:later}]}]}}});
 for(const m of ['gemini-4-hydrogen','gemini-3.8-flash-high','gemini-4-hydrogen-medium']){
  const q=r.antigravityQuota(groups(.5,0),Date.now(),m);assert.equal(q.blocked,false,m);assert.deepEqual(q.buckets.map(b=>b.id).sort(),['gemini-5h','gemini-weekly'],m);
  assert.equal(r.antigravityQuota(groups(0,1),Date.now(),m).blocked,true,m);
 }
});
