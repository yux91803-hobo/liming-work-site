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
 const r=await load(),dir=require('./helpers/tmp.cjs').tmpDir('xin-agy-budget-');   // 进程退出时删：状态进程是后起的，在 t.after 里删会抢在停它之前
 const file=dir+'/budget.json',first=r.requestBudget(file,128,{tokens:10000}),a={input_tokens:2212,output_tokens:2431,cache_read_tokens:0,total_tokens:4643};first();assert.deepEqual(first.recordCumulativeUsage('antigravity','own',a),a);
 const resumed=r.requestBudget(file,128,{tokens:10000}),b={input_tokens:12190,output_tokens:4829,cache_read_tokens:0,total_tokens:17019};const delta=resumed.recordCumulativeUsage('antigravity','own',b);assert.equal(delta.input_tokens,9978);assert.equal(delta.output_tokens,2398);assert.equal(delta.total_tokens,12376);
 resumed.recordCumulativeUsage('antigravity','own',b);assert.equal(JSON.parse(fs.readFileSync(file)).total,17019);assert.equal(resumed(),false);assert.throws(()=>resumed.recordCumulativeUsage('antigravity','own',a),/倒退/);
});
function fixture(t,mode='ok'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-agy-test-')),control=root+'/control',profile=root+'/profile',bin=root+'/bin',log=root+'/calls.jsonl';for(const p of [control+'/sessions',control+'/runs',profile,bin])fs.mkdirSync(p,{recursive:true});
 const preload=root+'/preload.cjs';fs.writeFileSync(preload,'require("node:os").homedir=()=>'+JSON.stringify(profile)+';require("node:module").syncBuiltinESMExports();');
 const agy=bin+'/agy';
 fs.writeFileSync(agy,'#!'+process.execPath+'\n'+`
 const fs=require('node:fs'),a=process.argv.slice(2),mode=${JSON.stringify(mode)},root=${JSON.stringify(root)},log=${JSON.stringify(log)};
 const model=a[a.indexOf('--model')+1],quota=a[a.indexOf('-p')+1]==='/usage';
 const send=o=>console.log(JSON.stringify(o));
 fs.appendFileSync(log,JSON.stringify({quota,args:quota?[]:[model,a[a.indexOf('--effort')+1]],key:!!process.env.XIN_CODEX_KEY,
   cwd:process.cwd(),conversation:a.includes('--conversation'),model,prompt:a[a.indexOf('-p')+1]})+'\\n');
 const records=fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse);
 const count=records.filter(x=>x.quota).length,turns=records.filter(x=>!x.quota).length;
 const conversation=model?.startsWith('gemini-4-argon')?'22345678-1234-1234-1234-123456789abc':'12345678-1234-1234-1234-123456789abc';
 if(quota){
  const reset=new Date(Date.now()+604800000).toISOString();
  const groups=[{buckets:[
    {id:'gemini-5h',remaining_fraction:mode==='quota'&&count>1?0:1,reset_time:new Date(Date.now()+3600000).toISOString()},
    {id:'gemini-weekly',remaining_fraction:1,reset_time:reset}]}];
  if(mode!=='noargon')groups.push({buckets:[{id:'gemini-argon-wtu-weekly',remaining_fraction:mode==='argonquota'&&count>1?0:1,reset_time:reset}]});
  send({event:'result',result:{status:'SUCCESS',command:{data:{groups}}}});process.exit(0);
 }
 if(mode==='crash'){process.stderr.write('unknown flag');process.exit(2);}
 send({event:'init',init:{model:mode==='wrong'?'another-model':model}});
 const result=(action,command='',text='真实入口完成',status='SUCCESS')=>send({event:'result',result:{conversation_id:conversation,
   status,structured_output:{action,command,text},usage:{input_tokens:20,output_tokens:8}}});
 if(mode==='unfinished'){send({event:'result',result:{conversation_id:conversation,status:'ERROR',response:''}});process.exit(0);}
 if(mode==='stall'||mode==='stall2'&&turns>1){setInterval(()=>{},1e9);return;}
 if(mode==='stall2'||mode==='quota'&&turns===1){result('shell','echo half > half.txt','');process.exit(0);}
 if(mode==='quota'&&turns===2&&fs.existsSync(root+'/hold-neon')){
  fs.writeFileSync(root+'/neon-at','');
  while(!fs.existsSync(root+'/release-neon'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
 }
 const exhausted=mode==='argonquota'||mode==='quota'&&!model.startsWith('gemini-4-argon');
 if(exhausted)send({event:'step_update',step_update:{state:'DONE',step_type:'search_web',step_index:1}});
 if(mode==='steps'){
  send({event:'step_update',step_update:{state:'ACTIVE',step_type:'search_web',step_index:1,tool_info:{parameters:{query:'Gemini 4 Hydrogen review'}}}});
  send({event:'step_update',step_update:{state:'ACTIVE',step_type:'search_web',step_index:1,tool_info:{parameters:{query:'Gemini 4 Hydrogen review'}}}});
  send({event:'step_update',step_update:{state:'DONE',step_type:'search_web',step_index:1,tool_info:{parameters:{query:'Gemini 4 Hydrogen review'}}}});
  send({event:'step_update',step_update:{state:'ACTIVE',step_type:'read_url_content',step_index:2}});
  send({event:'step_update',step_update:{state:'DONE',step_type:'read_url_content',step_index:2,tool_info:{parameters:{url:'https://deepmind.google/models'}}}});
 }
 result('final','','真实入口完成',exhausted?'ERROR':'SUCCESS');`,{mode:0o755});
 fs.writeFileSync(bin+'/codex','#!'+process.execPath+'\n'+`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(root+'/fallback.log')},'codex\\n');fs.appendFileSync(${JSON.stringify(root+'/fallback.args')},process.argv.slice(2).join(' ')+'\\n');console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'保留原进度后完成'}}));`,{mode:0o755});
 const env={...process.env,PATH:bin+':'+process.env.PATH,NODE_OPTIONS:'--require='+preload,XIN_HOME:control,XIN_WORK:root+'/work',CODEX_HOME:profile+'/.codex',XIN_AGY_HOME:profile,XIN_ANTIGRAVITY_BIN:agy,XIN_CODEX_TRANSPORT:'exec',XIN_TASK_SANDBOX:'0',XIN_CODEX_KEY:'must-not-reach-agy',XIN_AGY_IDLE_MS:'1500'};
  const ensureState=require('./helpers/state-mode.cjs').stateClient(t,env);
 const call=(op,args={})=>{ ensureState();const r=lockedSpawn(agent,op,args,{env,encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 t.after(()=>stopOwned(control,root));
 const wait=async sid=>{let task;for(const end=performance.now()+platformTimeout(15000);performance.now()<end;){task=call('history',{sid}).task;if(['done','failed','waiting'].includes(task.status))return task;await new Promise(r=>setTimeout(r,50));}assert.fail(JSON.stringify(task));};
 return {root,control,log,call,wait};
}
test('普通资料任务真正交给 Gemini 4 Hydrogen High，前台模型和网关密钥不交给 agy',async t=>{
 const f=fixture(t),task=f.call('task_new',{kind:'research',goal:'fixture research'}).task;assert.equal(task.model,'gemini-4-hydrogen');const done=await f.wait(task.sid);assert.equal(done.status,'done',JSON.stringify(done));assert.equal(done.actualModel,'gemini-4-hydrogen');
 const calls=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse);assert.ok(calls.length>=3);assert.ok(calls.every(x=>!x.key&&x.cwd===f.control+'/antigravity-client'));assert.deepEqual(calls.find(x=>!x.quota).args,['gemini-4-hydrogen-high','high']);
 const quota=JSON.parse(fs.readFileSync(f.control+'/antigravity-quota.json'));assert.equal(quota.blocked,false);assert.deepEqual(quota.buckets.map(b=>b.id),['gemini-5h','gemini-weekly']);
 const named=f.call('task_new',{kind:'research',goal:'named work',model:'kimi-k3.1-pro',named:true,strictModel:true}).task;assert.equal(named.model,'kimi-k3.1-pro');await f.wait(named.sid);
});
test('Hydrogen High 资料任务额度用尽后转 DeepSeek，保留用量和副本，Argon 检查仍可用',async t=>{
 const f=fixture(t,'quota'),dir=f.root+'/work/project';fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/half.txt','half\n');
 const task=f.call('task_new',{kind:'research',dir,goal:'research after Gemini quota'}).task;
 assert.equal(task.model,'gemini-4-hydrogen');
 const done=await f.wait(task.sid);assert.equal(done.status,'done');assert.equal(done.actualModel,'deepseek-v4.1-flash');
 assert.ok(f.call('history',{sid:task.sid}).usage.total>=28);
 assert.equal(fs.readFileSync(JSON.parse(fs.readFileSync(f.control+'/sessions/'+task.sid+'.json')).workspace.work+'/half.txt','utf8').trim(),'half');
 assert.equal(f.call('tasks',{all:true}).antigravity.blocked,true);
 const count=fs.readFileSync(f.log,'utf8').trim().split('\n').length;
 const next=f.call('task_new',{kind:'research',goal:'skip blocked Gemini'}).task;assert.equal(next.model,'deepseek-v4.1-flash');await f.wait(next.sid);
 assert.equal(fs.readFileSync(f.log,'utf8').trim().split('\n').length,count);
 const review=f.call('task_new',{kind:'review',goal:'Argon remains available'}).task;assert.equal(review.model,'gemini-4-argon');await f.wait(review.sid);
});
test('Argon 额度耗尽可在检查后转交其它入口，倒计时期间不重复请求 agy，到期才再探测',async t=>{
 const f=fixture(t,'argonquota'),task=f.call('task_new',{kind:'review',goal:'quota continuation'}).task,done=await f.wait(task.sid);assert.equal(done.status,'done',JSON.stringify(done));assert.notEqual(done.actualModel,'gemini-4-argon');assert.equal(fs.readFileSync(f.root+'/fallback.log','utf8').trim(),'codex');
 assert.ok(f.call('history',{sid:task.sid}).usage.total>=28,'转到网关后保留 Argon 已用的 token');
 const authors=JSON.parse(fs.readFileSync(f.control+'/sessions/'+task.sid+'.json')).actualModels;assert.ok(authors.includes('gemini-4-argon'));assert.ok(authors.includes(done.actualModel));
 const review=f.call('task_new',{kind:'review',goal:'independent audit',model:'gemini-4-argon',named:true,after:[task.no]});assert.equal(review.error,'independent_review_model');
 const state=JSON.parse(fs.readFileSync(f.control+'/antigravity-argon-quota.json'));assert.equal(state.blocked,true);assert.ok(state.retryAt>Date.now());const count=fs.readFileSync(f.log,'utf8').trim().split('\n').length;
 const next=f.call('task_new',{kind:'review',goal:'cooldown task'}).task;assert.notEqual(next.model,'gemini-4-argon');await f.wait(next.sid);assert.equal(fs.readFileSync(f.log,'utf8').trim().split('\n').length,count);
 state.retryAt=Date.now()-1;fs.writeFileSync(f.control+'/antigravity-argon-quota.json',JSON.stringify(state));const retry=f.call('task_new',{kind:'review',goal:'expired quota'}).task;assert.equal(retry.model,'gemini-4-argon');await f.wait(retry.sid);assert.ok(fs.readFileSync(f.log,'utf8').trim().split('\n').length>count);
});
test('实际返回其它模型时拒绝执行，不把它当指定的 Hydrogen 成功',async t=>{const f=fixture(t,'wrong'),a=f.call('task_new',{kind:'research',goal:'identity verification'}).task;const done=await f.wait(a.sid);assert.equal(done.status,'done');assert.notEqual(done.actualModel,'gemini-4-hydrogen');});

test('Gemini 旧额度文件已用完时改派 Argon，两个池都用完时走各自网关候选',async t=>{
 const f=fixture(t);
 const blocked=model=>({model,blocked:true,retryAt:Date.now()+3600000,buckets:[]});
 fs.writeFileSync(f.control+'/antigravity-argon-quota.json',JSON.stringify(blocked('gemini-4-argon')));
 const research=f.call('task_new',{kind:'research',goal:'Hydrogen does not use the Argon quota pool'}).task;assert.equal(research.model,'gemini-4-hydrogen');await f.wait(research.sid);
 fs.unlinkSync(f.control+'/antigravity-argon-quota.json');
 fs.writeFileSync(f.control+'/antigravity-quota.json',JSON.stringify(blocked('gemini-4-hydrogen')));
 const code=f.call('task_new',{kind:'code',goal:'code with the other pool'}).task;
 assert.equal(code.model,'gemini-4-argon');
 assert.equal(JSON.parse(fs.readFileSync(f.control+'/sessions/'+code.sid+'.json')).fallbacks[0],'glm-5.3');await f.wait(code.sid);
 fs.writeFileSync(f.control+'/antigravity-argon-quota.json',JSON.stringify(blocked('gemini-4-argon')));
 for(const [kind,model] of [['code','glm-5.3'],['research','deepseek-v4.1-flash']]){
  const task=f.call('task_new',{kind,goal:kind+' after both pools'}).task;
  assert.equal(task.model,model);await f.wait(task.sid);
 }
 fs.unlinkSync(f.control+'/antigravity-quota.json');fs.unlinkSync(f.control+'/antigravity-argon-quota.json');
 const fresh=f.call('task_new',{kind:'code',goal:'neon after reset'}).task;
 assert.equal(fresh.model,'gemini-4-neon');
 assert.deepEqual(JSON.parse(fs.readFileSync(f.control+'/sessions/'+fresh.sid+'.json')).fallbacks.slice(0,2),['gemini-4-argon','glm-5.3']);await f.wait(fresh.sid);
});
test('Neon 额度用完转 Argon High，开新供应商会话并保留两个模型的用量和作者',async t=>{
 const f=fixture(t,'quota'),task=f.call('task_new',{kind:'code',goal:'continue after Neon quota'}).task;
 const done=await f.wait(task.sid);
 assert.equal(done.status,'done');assert.equal(done.actualModel,'gemini-4-argon');
 const calls=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse).filter(x=>!x.quota);
 assert.deepEqual(calls.map(c=>c.args),[['gemini-4-neon-high','high'],['gemini-4-neon-high','high'],['gemini-4-argon-high','high']]);
 assert.deepEqual(calls.map(c=>c.conversation),[false,true,false],'Neon 续接自身，Argon 使用新会话');
 assert.match(calls[2].prompt,/先读取同一项目副本中的现有文件/);
 assert.equal(f.call('history',{sid:task.sid}).usage.total,56,'两次独立的供应商用量都保留');
 const saved=JSON.parse(fs.readFileSync(f.control+'/sessions/'+task.sid+'.json'));
 assert.deepEqual(saved.actualModels,['gemini-4-neon','gemini-4-argon']);
 const quota=f.call('tasks',{all:true}).antigravityArgon;
 assert.equal(quota.blocked,false);assert.deepEqual(quota.buckets.map(b=>b.id),['gemini-argon-wtu-weekly']);
 const review=f.call('task_new',{kind:'review',goal:'review both authors',after:[task.no]}).task;
 assert.equal(review.model,'glm-5.3');await f.wait(review.sid);
});
test('账号没有 Argon 额度组时用 DeepSeek 完成，不写错误的 Gemini 池记录',async t=>{
 const f=fixture(t,'noargon'),task=f.call('task_new',{kind:'research',goal:'research without Argon',model:'gemini-4-argon',named:true}).task;
 assert.equal(task.model,'gemini-4-argon');
 const done=await f.wait(task.sid);
 assert.equal(done.status,'done');assert.equal(done.actualModel,'deepseek-v4.1-flash');
 assert.equal(fs.existsSync(f.control+'/antigravity-quota.json'),false);
});
test('已排队的 Argon 检查会在作者从 Neon 换到 Argon 后重新选择 GLM',async t=>{
 const f=fixture(t,'quota');fs.writeFileSync(f.root+'/hold-neon','');
 const author=f.call('task_new',{kind:'code',goal:'author with a pending quota handoff'}).task;
 const until=performance.now()+platformTimeout(10000);
 while(!fs.existsSync(f.root+'/neon-at')){
  assert.ok(performance.now()<until,'Neon 已执行一步后到达可复现的交接点');
  await new Promise(resolve=>setTimeout(resolve,30));
 }
 const review=f.call('task_new',{kind:'review',goal:'independent review',after:[author.no]}).task;
 assert.equal(review.model,'gemini-4-argon');assert.equal(review.status,'queued');
 fs.writeFileSync(f.root+'/release-neon','');
 assert.equal((await f.wait(author.sid)).actualModel,'gemini-4-argon');
 assert.equal((await f.wait(review.sid)).actualModel,'glm-5.3');
});

// 2026-11-12 正式站联调：Gemini（Antigravity）2 分 20 秒一个字不回，后台任务卡到超时。站长：「Gemini 一两分钟不回就换模型」。
// 参考 opencode 的 chunkTimeout（packages/core/src/v1/config/provider.ts：两段输出之间等不到就中止）、Codex 的 stream_idle_timeout_ms（codex-rs/model-provider-info：默认 300 秒，按服务商可改）
test('Gemini 一直不出声：到了闲置时限就换别的模型接着做，记下原因；之后 15 分钟内新任务先不派给 Gemini',async t=>{
 const f=fixture(t,'stall'),task=f.call('task_new',{kind:'research',goal:'stall research'}).task;assert.equal(task.model,'gemini-4-hydrogen');
 const t0=performance.now(),done=await f.wait(task.sid);assert.equal(done.status,'done',JSON.stringify(done));assert.notEqual(done.actualModel,'gemini-4-hydrogen');
 assert.ok(performance.now()-t0<platformTimeout(12000),'没有等满 4 分钟');
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

test('Gemini 和第一个网关候选先后未能开始工作：下一候选继续，原始故障和插话各保留一次', async t => {
  const f = fixture(t, 'stall');
  const calls = path.join(f.root, 'gateway-chain.jsonl');
  fs.writeFileSync(path.join(f.root, 'bin', 'codex'), '#!' + process.execPath + '\n' + `
const fs=require('node:fs'), args=process.argv.slice(2);
const model=JSON.parse(args.find(arg=>arg.startsWith('model=')).slice(6));
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({model,text:args.at(-1)})+'\\n');
if (model.startsWith('glm-')) { process.stderr.write('upstream 503 before work'); process.exit(1); }
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'合成任务已完成'}}));
`, { mode: 0o755 });
  const task = f.call('task_new', { kind:'code', title:'候选顺序合成测试', goal:'同一副本继续完成', model:'gemini-4-hydrogen', named:true }).task;
  const run = JSON.parse(fs.readFileSync(path.join(f.control, 'sessions', task.sid + '.json'), 'utf8')).runs[0];
  const runFile = path.join(f.control, 'runs', run + '.json');
  const transport = () => JSON.parse(fs.readFileSync(runFile, 'utf8')).transport;
  for (const until = performance.now() + platformTimeout(4000); transport() !== 'antigravity' && performance.now() < until;)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(transport(), 'antigravity');
  const tell = f.call('task_tell', { sid:task.sid, text:'保持补充 AX7GB', clientId:'gateway-chain-input' });
  assert.equal(tell.delivery, 'now');
  const done = await f.wait(task.sid), before = f.call('history', { sid:task.sid }).runs;
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.equal(done.actualModel, 'kimi-k3.1-pro');
  assert.equal(before.length, 1, '同一执行轮次保留原始请求');
  assert.equal(before[0].events.filter(e => e.t === 'user' && e.clientId === 'gateway-chain-input').length, 1);
  assert.equal(before[0].events.filter(e => e.t === 'done').length, 1);
  const attempts = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(attempts.map(x => x.model), ['glm-5.3', 'kimi-k3.1-pro']);
  assert.ok(attempts.every(x => x.text.split('保持补充 AX7GB').length === 2));
  const receipt = before[0].events.find(e => e.t === 'done');
  assert.equal(receipt.from, 'gemini-4-hydrogen');
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

test('后台按类别派 Neon High、Neon Extra 和 Argon，杂活交 DeepSeek',async t=>{
 const f=fixture(t);
 for(const [kind,model,effort] of [['code','gemini-4-neon','high'],['hard','gemini-4-neon','xhigh'],['research','gemini-4-hydrogen','high']]){
  const task=f.call('task_new',{kind,goal:kind+' work'}).task;
  assert.equal(task.model,model,kind);
  assert.equal((await f.wait(task.sid)).actualModel,model,kind);
  const calls=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse).filter(x=>!x.quota);
  assert.deepEqual(calls.at(-1).args,[model+'-'+effort,effort],kind);
 }
 const quick=f.call('task_new',{kind:'quick',goal:'small work'}).task;
 assert.equal(quick.model,'deepseek-v4.1-flash'); await f.wait(quick.sid);
 const author=f.call('task_new',{kind:'code',goal:'gateway wrote it',model:'glm-5.3',named:true}).task;
 await f.wait(author.sid);
 const review=f.call('task_new',{kind:'review',goal:'review the code',after:[author.no]}).task;
 assert.equal(review.model,'gemini-4-argon');
 assert.equal((await f.wait(review.sid)).actualModel,'gemini-4-argon');
 const last=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse).filter(x=>!x.quota).at(-1);
 assert.deepEqual(last.args,['gemini-4-argon-high','high']);
 const argon=f.call('task_new',{kind:'code',goal:'argon wrote it',model:'gemini-4-argon',named:true}).task;
 await f.wait(argon.sid);
 const independent=f.call('task_new',{kind:'review',goal:'review argon',after:[argon.no]}).task;
 assert.equal(independent.model,'glm-5.3');await f.wait(independent.sid);
});
test('Neon 的 Extra 只跟随用户点名，Hydrogen 点名仍是 high',async t=>{
 const f=fixture(t);
 for(const [userRequest,model,effort] of [['用 Neon Extra 写个脚本','gemini-4-neon','xhigh'],['加一个 extra 按钮','gemini-4-neon','high'],['用 Hydrogen 写个脚本','gemini-4-hydrogen','high']]){
  const task=f.call('task_new',{kind:'code',goal:'write code',userRequest,model,named:true}).task;
  assert.equal((await f.wait(task.sid)).actualModel,model);
  const last=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse).filter(x=>!x.quota).at(-1);
  assert.deepEqual(last.args,[model+'-'+effort,effort],userRequest);
 }
});
test('不交给 Antigravity 的任务：图片、杂活、电脑维护、看图；带图代码保留代码候选',async t=>{
 const f=fixture(t);
 fs.mkdirSync(f.root+'/work/uploads',{recursive:true});fs.writeFileSync(f.root+'/work/uploads/a.png','x');
 for(const kind of ['quick','system','vision'])assert.equal(f.call('task_new',{kind,goal:kind+' work'}).task.model,'deepseek-v4.1-flash');
 const image=f.call('task_new',{kind:'code',goal:'code from picture',files:['uploads/a.png']}).task;
 assert.equal(image.model,'glm-5.3');
 const {namedModel,modelLabel}=await import(pathToFileURL(path.join(__dirname,'../site/xin/vm-models.mjs')).href);
 for(const text of ['你让 Gemini 3.8 Flash 去画个奶龙','交给 Hydrogen 做','让 Gemini 4 Hydrogen 查一下'])assert.equal(namedModel(text),'gemini-4-hydrogen',text);
 for(const text of ['用 Gemini 写','用 antigravity 做','用 Neon 写','让 Gemini 4 Neon 来做'])assert.equal(namedModel(text),'gemini-4-neon',text);
 for(const text of ['让 Argon 查一下','交给 Gemini 4 Argon 检查'])assert.equal(namedModel(text),'gemini-4-argon',text);
 assert.equal(modelLabel('gemini-4-neon'),'Gemini 4 Neon');assert.equal(modelLabel('gemini-4-argon'),'Gemini 4 Argon');
 const old=f.call('task_new',{kind:'research',goal:'old flash id',model:'gemini-3.8-flash-high',named:true}).task;
 assert.notEqual(old.model,'gemini-3.8-flash-high');await f.wait(old.sid);
 assert.ok((fs.existsSync(f.log)?fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse):[]).every(x=>x.quota||!/3\.8/.test(x.args[0])));
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
 // 站长 11-19：Neon 和 Hydrogen 同一个 Gemini 池；Argon 单独一池
 assert.equal(r.antigravityQuota(groups(.5,0),Date.now(),'gemini-4-neon').blocked,false);
 assert.equal(r.antigravityQuota(groups(.5,0),Date.now(),'gemini-4-argon').blocked,true);
 assert.equal(r.antigravityQuota(groups(0,1),Date.now(),'gemini-4-argon').blocked,false);
});

test('Antigravity 模型表：Hydrogen、Neon 在 Gemini 池，Argon 单独一池；没有的档位降到它最高的那档',async()=>{
 const r=await import(pathToFileURL(path.join(__dirname,'../site/xin/vm-runtime.mjs')).href);
 assert.deepEqual(Object.keys(r.AGY_CATALOG),['gemini-4-hydrogen','gemini-4-neon','gemini-4-argon']);
 assert.deepEqual(['gemini-4-hydrogen','gemini-4-neon','gemini-4-argon','glm-5.3'].map(r.agyPool),['gemini','gemini','argon',null]);
 assert.equal(r.isAgyModel('gemini-4-neon'),true);assert.equal(r.isAgyModel('gemini-3.8-flash'),false);
 assert.equal(r.agyEffort('research','gemini-4-hydrogen'),'high');
 assert.equal(r.agyProviderModel('gemini-4-neon','xhigh'),'gemini-4-neon-xhigh');
 assert.equal(r.agyProviderModel('gemini-4-argon','xhigh'),'gemini-4-argon-high');
 assert.equal(r.agyProviderModel('gemini-4-argon','max'),'gemini-4-argon-high');
 assert.deepEqual(['code','hard','review','research','quick'].map(k=>r.agyEffort(k,'gemini-4-neon')),['high','xhigh','high','medium','low']);
 assert.deepEqual(['code','hard','review','research'].map(k=>r.agyEffort(k,'gemini-4-argon')),['high','high','high','medium']);
});

test('先用哪个 Antigravity 模型（站长 11-19）：写代码、难题 Neon，池用完换 Argon；检查 Argon、查资料 Hydrogen；其余类别不用 Antigravity',async()=>{
 const {agyPick,agyNext}=await import(pathToFileURL(path.join(__dirname,'../site/xin/vm-models.mjs')).href);
 const ok=()=>true,noGemini=p=>p!=='gemini',none=()=>false;
 assert.deepEqual(['code','hard','review','research','quick','daily','system','vision'].map(kind=>agyPick({kind,poolOk:ok})),
  ['gemini-4-neon','gemini-4-neon','gemini-4-argon','gemini-4-hydrogen',null,null,null,null]);
 assert.equal(agyPick({kind:'code',poolOk:noGemini}),'gemini-4-argon');assert.equal(agyPick({kind:'code',poolOk:none}),null);
 assert.equal(agyPick({kind:'research',poolOk:noGemini}),null);
 assert.equal(agyPick({kind:'review',poolOk:ok,avoid:['gemini-4-argon']}),null,'检查要独立：作者是 Argon 就不用 Argon');
 assert.equal(agyPick({kind:'code',poolOk:ok,avoid:['gemini-4-neon']}),'gemini-4-argon');
 assert.deepEqual(agyNext({kind:'code',model:'gemini-4-neon',poolOk:ok}),['gemini-4-argon']);
 assert.deepEqual(agyNext({kind:'code',model:'gemini-4-neon',poolOk:p=>p!=='argon'}),[]);
 assert.deepEqual(agyNext({kind:'research',model:'gemini-4-argon',poolOk:ok}),[]);
});
test('Gemini 后台的搜索、读网页：一开始就报搜什么（同一步只报一次），做完再报；读网页记成打开网页，不混成搜索',async t=>{
 const f=fixture(t,'steps'),task=f.call('task_new',{kind:'research',goal:'fixture research'}).task;const done=await f.wait(task.sid);assert.equal(done.status,'done',JSON.stringify(done));
 const evs=f.call('history',{sid:task.sid}).runs.flatMap(r=>r.events||[]).filter(e=>e.t==='tool'||e.t==='tool_end').map(e=>[e.t,e.name,e.detail]);
 assert.deepEqual(evs,[['tool','WebSearch','Gemini 4 Hydrogen review'],['tool_end','WebSearch','Gemini 4 Hydrogen review'],['tool_end','WebFetch','https://deepmind.google/models']]);
});
