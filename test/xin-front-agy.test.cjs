const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { platformTimeout } = require('./helpers/timeout.cjs');
const {spawnSync}=require('node:child_process');
const {stopOwned}=require('./helpers/stop-owned.cjs');
const agent=path.join(__dirname,'../site/xin/vm-agent.mjs');
function fixture(t,mode='ok'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-front-agy-')),control=root+'/control',home=root+'/home',work=root+'/work',bin=root+'/bin',log=root+'/native.jsonl',gateway=root+'/gateway.jsonl';
 for(const dir of [control+'/sessions',control+'/runs',home,work+'/uploads',bin])fs.mkdirSync(dir,{recursive:true});
 const preload=root+'/preload.cjs';fs.writeFileSync(preload,`
 require('node:os').homedir=()=>${JSON.stringify(home)};require('node:module').syncBuiltinESMExports();
 const fs=require('node:fs'),real=fetch;global.fetch=async function(url,init){
 if(!String(url).endsWith('/v1/responses'))return real(url,init);const body=JSON.parse(init.body);
 if(String(body.instructions||'').startsWith('你是聊天界面的状态栏')){const st=${JSON.stringify(root+'/status-text')};fs.appendFileSync(${JSON.stringify(root+'/status.jsonl')},JSON.stringify(body)+'\\n');return new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:fs.existsSync(st)?fs.readFileSync(st,'utf8'):''}]}],usage:{input_tokens:30,output_tokens:4}}));}
 fs.appendFileSync(${JSON.stringify(gateway)},JSON.stringify(body)+'\\n');
 return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'deepseek-quota-answer'}]}],usage:{input_tokens:8,output_tokens:5}}));};`);
 fs.writeFileSync(bin+'/agy','#!'+process.execPath+'\n'+`
 const fs=require('node:fs'),a=process.argv.slice(2),modeFile=${JSON.stringify(root+'/mode')},mode=fs.existsSync(modeFile)?fs.readFileSync(modeFile,'utf8'):${JSON.stringify(mode)},log=${JSON.stringify(log)};
 const record=o=>fs.appendFileSync(log,JSON.stringify(o)+'\\n'),send=o=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\\n');
 record({argv:a,key:!!process.env.XIN_CODEX_KEY,cwd:process.cwd()});
 const rows=()=>fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse);
 if(a.includes('/usage')){const slow=${JSON.stringify(root+'/slow-usage-ms')};if(fs.existsSync(slow))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(fs.readFileSync(slow,'utf8')));const count=rows().filter(x=>x.argv?.includes('/usage')).length;console.log(JSON.stringify({event:'result',result:{command:{data:{groups:[
 {buckets:[{id:'3p-5h',remaining_fraction:0,reset_time:new Date(Date.now()+3600000).toISOString()}]},
 {buckets:[{id:'gemini-argon-wtu-weekly',remaining_fraction:0,reset_time:new Date(Date.now()+3600000).toISOString()}]},
 mode==='weekly'?{buckets:[{id:'gemini-weekly',remaining_fraction:0,reset_time:new Date(Date.now()+4*86400000).toISOString()},{id:'gemini-5h',window:'5h',disabled:true,remaining_fraction:.857}]}:
 {buckets:[{id:'gemini-5h',remaining_fraction:mode==='blocked'||mode==='midquota'&&count>1?0:1,reset_time:new Date(Date.now()+3600000).toISOString()},
 {id:'gemini-weekly',remaining_fraction:1,reset_time:new Date(Date.now()+7*86400000).toISOString()}]}]}}}}));process.exit(0);}
 if(a.includes('--model')){
  console.log(JSON.stringify({event:'init',init:{model:a[a.indexOf('--model')+1]}}));
  console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',conversation_id:'12345678-1234-1234-1234-123456789abc',
   structured_output:{action:'final',command:'',text:'后台测试完成'},usage:{input_tokens:12,output_tokens:5}}}));
  process.exit(0);
 }
 if(a.includes('--help')){console.log('acp --agent --settings');process.exit(0);}
 let prompts=0,held=null;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);record(q);if(!q.method)return;
 if(q.method==='initialize')send({id:q.id,result:{protocolVersion:1,agentCapabilities:{promptCapabilities:{image:mode!=='noimage'}}}});
 else if(q.method==='session/new')send({id:q.id,result:{sessionId:'native-synthetic-session',models:{currentModelId:'another',availableModels:[...(mode==='missing'?[]:[{modelId:mode==='alias'?'MODEL_GEMINI_4_HYDROGEN_MEDIUM':'gemini-4-hydrogen-medium',name:'Gemini 4 Hydrogen (Medium)'},...(mode==='nohigh'?[]:[{modelId:mode==='alias'?'MODEL_GEMINI_4_HYDROGEN_HIGH':'gemini-4-hydrogen-high',name:'Gemini 4 Hydrogen (High)'}])]),{modelId:'claude-opus-5-5-high',name:'Claude Opus 5.5 (High)'}]}}});
 else if(q.method==='session/set_model')send({id:q.id,result:{}});
 else if(q.method==='session/cancel'){if(held!==null){const id=held;held=null;send({id,result:{stopReason:'cancelled'}});}}
 else if(q.method==='session/prompt'){
 prompts++;
 if((mode==='websteer'||mode==='weblimit')&&prompts===1){const S='native-synthetic-session';held=q.id;
  send({method:'session/update',params:{sessionId:S,update:{sessionUpdate:'tool_call',toolCallId:'call_s1',title:'"hydrogen score" on Web',kind:'search',status:'in_progress',rawInput:{query:'hydrogen score'}}}});
  setTimeout(()=>send({method:'session/update',params:{sessionId:S,update:{sessionUpdate:'tool_call_update',toolCallId:'call_s1',kind:'search',status:'completed'}}}),1200);
  return;}
 if(mode==='hang')return;
 if(mode==='stalled_reply'||mode==='upstream_capacity'||mode==='stalled_after_memory'&&prompts===2){
  const fragment=mode==='upstream_capacity'?'**API Error: UNAVAILABLE (code 503)**: No capacity available for model gemini-4-hydrogen-high on the server.':'未完成的模型输出';
  for(let i=0;i<3;i++)send({method:'session/update',params:{sessionId:'native-synthetic-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:fragment}}}});
  return;
 }
 if(mode==='transient'||mode==='midquota'&&prompts===2){send({id:q.id,error:{code:429,message:mode==='transient'?'rate limit, retry shortly':'quota exhausted'}});return;}
 if(mode==='web'&&prompts===1){
 const opts=[{optionId:'allow-1',kind:'allow_once',name:'Allow'},{optionId:'reject-1',kind:'reject_once',name:'Reject'}],S='native-synthetic-session';
 send({id:910,method:'session/request_permission',params:{sessionId:S,options:opts,toolCall:{toolCallId:'call_s1',title:'"Gemini 4 Hydrogen score" on Web',kind:'search',rawInput:{query:'Gemini 4 Hydrogen score'}}}});
 send({id:911,method:'session/request_permission',params:{sessionId:S,options:opts,toolCall:{toolCallId:'call_t1',title:'Run rm -rf /tmp/x',kind:'execute',rawInput:{command:'rm -rf /tmp/x'}}}});
 send({id:912,method:'session/request_permission',params:{sessionId:S,options:opts,toolCall:{toolCallId:'call_f9',title:'Read notes.txt',kind:'search',rawInput:{path:'/data/home/notes.txt'}}}});
 send({method:'session/update',params:{sessionId:S,update:{sessionUpdate:'tool_call',toolCallId:'call_s1',title:'"Gemini 4 Hydrogen score" on Web',kind:'search',status:'in_progress',rawInput:{query:'Gemini 4 Hydrogen score'}}}});
 send({method:'session/update',params:{sessionId:S,update:{sessionUpdate:'tool_call_update',toolCallId:'call_s1',title:'"Gemini 4 Hydrogen score" on Web',kind:'search',status:'completed',rawInput:{query:'Gemini 4 Hydrogen score'}}}});
 send({method:'session/update',params:{sessionId:S,update:{sessionUpdate:'tool_call',toolCallId:'call_u1',title:'artificialanalysis.ai/models',kind:'fetch',status:'in_progress',rawInput:{url:'https://artificialanalysis.ai/models'}}}});
 send({method:'session/update',params:{sessionId:S,update:{sessionUpdate:'tool_call_update',toolCallId:'call_u1',kind:'fetch',status:'completed'}}});
 }
 if(mode==='deny'){
 send({id:900,method:'session/request_permission',params:{sessionId:'native-synthetic-session',options:[]}});
 send({id:901,method:'fs/write_text_file',params:{path:${JSON.stringify(root+'/must-not-exist')},content:'denied'}});
 }
 let text='native-front-answer',calls=[];
 const promptText=q.params.prompt.find(b=>b.type==='text').text;let body;
 try{body=JSON.parse(promptText);}catch{body={input:[{role:'user',content:promptText}]};}
 const current=JSON.stringify(body.input||[]);
 if(current.includes('FRONT_DISPATCH')){text='';calls=[{name:'xin',argv:['xin','task','new','--kind','code','--model','glm-5.3','--title','fixture','--','模型自己扩写的配色和技术栈']}];}
 if(mode==='claim')text=prompts===1?'我查了，今天已经签到了。':'查不到当天记录，暂时不能确认。';
 if(['midquota','stalled_after_memory'].includes(mode)&&prompts===1){text='';calls=[{name:'xin',argv:['xin','remember','--basis','stated','--type','profile','喜欢先看时序图']}];}
 if((body.tools||[]).some(t=>t.name==='finish_event')){text='';calls=[{name:'finish_event',action:'deliver',text:'我核对好了，原生前台已交付结果。'}];}
 if(mode==='think')send({method:'session/update',params:{sessionId:'native-synthetic-session',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:"I'm thinking through how to approach this.\\n\\nThe user is greeting me, so a short friendly reply fits. Keep it brief."}}}});
 const answer=mode==='plain'&&prompts===1?text:mode==='broken'?'{"text":"半截回复':mode==='fenced'?'好的，按格式回复：\\n'+String.fromCharCode(96).repeat(3)+'json\\n'+JSON.stringify({text})+'\\n'+String.fromCharCode(96).repeat(3)+'\\n':JSON.stringify({text,calls});const reply=()=>{send({method:'session/update',params:{sessionId:'native-synthetic-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:answer}}}});
 send({id:q.id,result:{stopReason:'end_turn'}});};if(mode==='think')setTimeout(reply,400);else reply();
 }else send({id:q.id,result:{}});
 });`,{mode:0o755});
 // Only dispatched test tasks use this fake CLI; no real service is contacted.
 fs.writeFileSync(bin+'/codex','#!'+process.execPath+'\n'+`console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'后台测试完成'}}));`,{mode:0o755});
 const env={...process.env,HOME:home,XIN_HOME:control,XIN_WORK:work,XIN_AGY_HOME:home,XIN_ANTIGRAVITY_BIN:bin+'/agy',NODE_OPTIONS:'--require='+preload,PATH:bin+':'+process.env.PATH,XIN_CODEX_TRANSPORT:'exec',XIN_TASK_SANDBOX:'0',XIN_CODEX_KEY:'must-not-reach-native'};
  const ensureState=require('./helpers/state-mode.cjs').stateClient(t,env);
 delete env.XIN_FRONT_PROVIDER;
 const call=(op,args={})=>{ ensureState();const r=spawnSync(process.execPath,[agent,op],{env,input:JSON.stringify(args),encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);const d=JSON.parse(r.stdout);assert.ok(!d.error,JSON.stringify(d));return d;};
 const wait=async run=>{const until=performance.now()+platformTimeout(15000);while(performance.now()<until){const p=call('poll',{run,off:0});if(p.done)return p;await new Promise(r=>setTimeout(r,70));}assert.fail('synthetic front did not finish');};
 const rows=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 t.after(()=>stopOwned(control,root));
 return {root,control,home,work,env,log,gateway,call,wait,rows};
}
test('前台默认用 Gemini 4 Hydrogen（思考强度高），Claude、Argon 的额度用完不影响它；原生端没有网关密钥或执行权限',async t=>{
 const f=fixture(t,'deny'),sent=f.call('send',{agent:'codex',text:'你好'}),done=await f.wait(sent.run);
 const end=done.events.find(e=>e.t==='done');assert.equal(end.ok,true);assert.equal(end.model,'gemini-4-hydrogen');assert.equal(f.rows(f.gateway).length,0);
 assert.equal(done.events.find(e=>e.t==='text').text,'native-front-answer');
 const records=f.rows(f.log);assert.ok(records.filter(r=>r.argv).every(r=>!r.key&&r.cwd===f.control+'/front-antigravity'));
 const init=records.find(r=>r.method==='initialize');assert.equal(init.params.clientCapabilities.terminal,false);assert.equal(init.params.clientCapabilities.fs.writeTextFile,false);
 assert.deepEqual(records.find(r=>r.method==='session/new').params.mcpServers,[]);
 assert.equal(records.find(r=>r.method==='session/set_model').params.modelId,'gemini-4-hydrogen-high','思考强度默认高（站长 11-18）');
 assert.equal(records.find(r=>r.id===900&&!r.method).result.outcome.outcome,'cancelled');assert.equal(records.find(r=>r.id===901&&!r.method).error.code,-32601);
 assert.equal(fs.existsSync(f.root+'/must-not-exist'),false);
 const session=f.call('history',{sid:sent.sid}).session;assert.equal(session.model,'gemini-4-hydrogen');
 const q=JSON.parse(fs.readFileSync(f.control+'/front-antigravity-quota.json'));assert.equal(q.blocked,false);assert.equal(q.buckets.length,2);assert.ok(q.buckets.every(b=>/^gemini-(?!argon-)/.test(b.id)),'只看 Gemini 组：Claude、Argon 用完不算');
});
// 2026-11-15 正式站：电脑暂停几个小时后醒来，第一次调 Antigravity 核对额度，CLI 先检查更新、再刷新过期令牌，用了约 26 秒，
// 原来写死的 25 秒时限正好不够，那一轮回复失败。时限改由 XIN_AGY_QUOTA_MS 管（默认 90 秒），这里用缩小的时间模拟冷启动。
test('Antigravity 冷启动慢：额度核对的时限由 XIN_AGY_QUOTA_MS 管，比冷启动还短才报「暂时无法核对」',async t=>{
 const f=fixture(t);fs.writeFileSync(f.root+'/slow-usage-ms','1500');
 f.env.XIN_AGY_QUOTA_MS='500';
 const short=f.call('send',{agent:'codex',text:'你好'}),failed=await f.wait(short.run);
 assert.equal(failed.events.find(e=>e.t==='done').ok,false,'时限比冷启动短：这一轮失败');
 assert.ok(failed.events.some(e=>e.t==='err'&&/暂时无法核对/.test(e.text||'')),JSON.stringify(failed.events));
 const usage=f.rows(f.log).find(r=>r.argv?.includes('/usage'));assert.equal(usage.argv[usage.argv.indexOf('--print-timeout')+1],'1s','CLI 自己的时限跟着一起放宽');
});
test('Antigravity 冷启动慢：时限够的时候照常用 Hydrogen 回答',async t=>{
 const f=fixture(t);fs.writeFileSync(f.root+'/slow-usage-ms','1500');
 f.env.XIN_AGY_QUOTA_MS='8000';
 const sent=f.call('send',{agent:'codex',text:'你好'}),done=await f.wait(sent.run),end=done.events.find(e=>e.t==='done');
 assert.equal(end.ok,true,JSON.stringify(done.events));assert.equal(end.model,'gemini-4-hydrogen');
 const usage=f.rows(f.log).find(r=>r.argv?.includes('/usage'));assert.equal(usage.argv[usage.argv.indexOf('--print-timeout')+1],'8s');
});
test('额度核对默认时限盖得住实测的冷启动（26 秒），默认 90 秒',async t=>{
 const f=fixture(t);delete f.env.XIN_AGY_QUOTA_MS;
 const r=spawnSync(process.execPath,['--input-type=module','-e',"const m=await import("+JSON.stringify(require('node:url').pathToFileURL(path.join(__dirname,'../site/xin/vm-front-agy.mjs')).href)+");console.log(m.AGY_QUOTA_MS)"],{env:f.env,encoding:'utf8',timeout:20000});
 assert.equal(r.status,0,r.stderr);assert.equal(Number(r.stdout.trim()),90000);
});
test('Hydrogen 的图片提示与直接视觉块一致，读图聊天不派活',async t=>{
 const f=fixture(t),file=f.work+'/uploads/photo.png',bytes=Buffer.from('synthetic-png-fixture');fs.writeFileSync(file,bytes);
 const sent=f.call('send',{agent:'codex',text:'图里写的是什么',files:[{path:file,name:'photo.png'}]}),done=await f.wait(sent.run);
 assert.equal(done.events.find(e=>e.t==='done').model,'gemini-4-hydrogen');
 const prompt=f.rows(f.log).find(r=>r.method==='session/prompt').params.prompt;
 assert.deepEqual(prompt.find(b=>b.type==='image'),{type:'image',mimeType:'image/png',data:bytes.toString('base64')});
 assert.match(prompt.find(b=>b.type==='text').text,/图片已经直接给你看了/);assert.doesNotMatch(prompt.find(b=>b.type==='text').text,/你现在用的模型看不了图片内容/);
 assert.deepEqual(f.call('tasks',{sid:sent.sid}).tasks,[]);
});
test('接口用提供方枚举标识 Hydrogen（High）时仍可运行，保留实际 ID，不误当成未知前台模型',async t=>{
 const f=fixture(t,'alias'),sent=f.call('send',{agent:'codex',text:'你好'}),done=await f.wait(sent.run),end=done.events.find(e=>e.t==='done');
 assert.equal(end.ok,true);assert.equal(end.model,'gemini-4-hydrogen');assert.equal(end.providerModel,'MODEL_GEMINI_4_HYDROGEN_HIGH');
 assert.equal(f.rows(f.log).find(r=>r.method==='session/set_model').params.modelId,'MODEL_GEMINI_4_HYDROGEN_HIGH');
});
test('前台自己查（站长 11-18）：代理只多搜索和读网页两样；权限只批这两样，跑命令、读文件的照样拒；网页步骤记进这一轮',async t=>{
 const f=fixture(t,'web'),sent=f.call('send',{agent:'codex',text:'Gemini 4 Hydrogen 中档多少分'}),done=await f.wait(sent.run);
 assert.equal(done.events.find(e=>e.t==='done').ok,true);assert.equal(done.events.find(e=>e.t==='text').text,'native-front-answer');
 const agent=fs.readFileSync(f.home+'/.gemini/config/agents/xin-front-controller.md','utf8');
 assert.match(agent,/tools:\n  - finish\n  - search_web\n  - read_url_content\n/);
 const reply=id=>f.rows(f.log).find(r=>r.id===id&&!r.method)?.result?.outcome;
 assert.deepEqual(reply(910),{outcome:'selected',optionId:'allow-1'},'搜索公开网页：批');
 assert.deepEqual(reply(911),{outcome:'cancelled'},'跑命令：拒');
 assert.deepEqual(reply(912),{outcome:'cancelled'},'读文件（不是网页搜索）：拒');
 const steps=done.events.filter(e=>e.t==='tool'||e.t==='tool_end').map(e=>[e.t,e.name,e.detail||'',e.ok]);
 assert.deepEqual(steps,[['tool','WebSearch','Gemini 4 Hydrogen score',undefined],['tool_end','WebSearch','Gemini 4 Hydrogen score',true],
  ['tool','WebFetch','https://artificialanalysis.ai/models',undefined],['tool_end','WebFetch','https://artificialanalysis.ai/models',true]]);
});
test('前台查的时候插话：等手上的搜索做完，取消这一次，隔一会儿在同一个会话里把补充接着发（li 实测的做法）',async t=>{
 const keep={gap:process.env.XIN_FRONT_STEER_GAP_MS};process.env.XIN_FRONT_STEER_GAP_MS='300';t.after(()=>{if(keep.gap===undefined)delete process.env.XIN_FRONT_STEER_GAP_MS;else process.env.XIN_FRONT_STEER_GAP_MS=keep.gap;});
 const f=fixture(t,'websteer'),sent=f.call('send',{agent:'codex',text:'Gemini 4 Hydrogen 多少分'});
 for(const end=performance.now()+15000;performance.now()<end;){const p=f.call('poll',{run:sent.run,off:0});if((p.events||[]).some(e=>e.t==='tool'&&e.name==='WebSearch'))break;await new Promise(r=>setTimeout(r,100));}
 const st=f.call('steer',{sid:sent.sid,run:sent.run,text:'只要高档的分数',clientId:'steer-front-0001'});assert.equal(st.ok,true,JSON.stringify(st));
 const done=await f.wait(sent.run);assert.equal(done.events.find(e=>e.t==='done').ok,true);
 const rows=f.rows(f.log),prompts=rows.filter(r=>r.method==='session/prompt'),cancel=rows.findIndex(r=>r.method==='session/cancel');
 assert.ok(cancel>0,'发了取消');assert.equal(prompts.length,2);
 assert.ok(rows.indexOf(prompts[1])>cancel,'取消以后才发补充');
 assert.equal(prompts[1].params.sessionId,prompts[0].params.sessionId,'同一个会话');
 assert.match(prompts[1].params.prompt[0].text,/兄弟中途补充[\s\S]*只要高档的分数/);
 assert.equal(done.events.filter(e=>e.t==='text').pop().text,'native-front-answer');
});
test('前台查资料最多 3 分钟（测试里缩短）：到时间取消，再要一句按查到的收尾',async t=>{
 const keep={lim:process.env.XIN_FRONT_LOOKUP_MS,gap:process.env.XIN_FRONT_STEER_GAP_MS};process.env.XIN_FRONT_LOOKUP_MS='3000';process.env.XIN_FRONT_STEER_GAP_MS='300';
 t.after(()=>{for(const [k,v] of [['XIN_FRONT_LOOKUP_MS',keep.lim],['XIN_FRONT_STEER_GAP_MS',keep.gap]])if(v===undefined)delete process.env[k];else process.env[k]=v;});
 const f=fixture(t,'weblimit'),sent=f.call('send',{agent:'codex',text:'Gemini 4 Hydrogen 多少分'}),done=await f.wait(sent.run);
 assert.equal(done.events.find(e=>e.t==='done').ok,true);
 const rows=f.rows(f.log),prompts=rows.filter(r=>r.method==='session/prompt');
 assert.ok(rows.some(r=>r.method==='session/cancel'));assert.equal(prompts.length,2);
 assert.match(prompts[1].params.prompt[0].text,/时间到了：按已经查到的回答/);
});
test('账号里没有高档的 Hydrogen 就用中档，不改用 DeepSeek',async t=>{
 const f=fixture(t,'nohigh'),sent=f.call('send',{agent:'codex',text:'你好'}),done=await f.wait(sent.run),end=done.events.find(e=>e.t==='done');
 assert.equal(end.ok,true);assert.equal(end.model,'gemini-4-hydrogen');assert.equal(end.providerModel,'gemini-4-hydrogen-medium');
 assert.equal(f.rows(f.log).find(r=>r.method==='session/set_model').params.modelId,'gemini-4-hydrogen-medium');
});
test('Hydrogen 用纯文字聊天时直接当作回复交付，不再报格式错误，也不切模型',async t=>{
 const f=fixture(t,'plain'),sent=f.call('send',{agent:'codex',text:'你觉得人生有什么意义？'}),done=await f.wait(sent.run);
 const end=done.events.find(e=>e.t==='done');assert.equal(end.ok,true);assert.equal(end.model,'gemini-4-hydrogen');assert.equal(end.from,undefined);
 assert.equal(done.events.find(e=>e.t==='text').text,'native-front-answer');
 assert.equal(f.rows(f.log).filter(r=>r.method==='session/prompt').length,1);assert.equal(f.rows(f.gateway).length,0);
 assert.deepEqual(f.call('tasks',{sid:sent.sid}).tasks,[]);
});
for (const [mode, why] of [['stalled_reply', 'front_timeout_fallback'], ['upstream_capacity', 'front_capacity_fallback']]) {
 test(`Hydrogen 输出片段后没有结束，DeepSeek 继续答一次（${mode}）`, async t => {
  const f = fixture(t, mode);
  f.env.XIN_AGY_PROMPT_MS = '900';
  const text = '请给这轮一个真实的回复', sent = f.call('send', {agent:'codex', text});
  const done = await f.wait(sent.run);
  const end = done.events.find(e => e.t === 'done');
  assert.deepEqual([end.ok, end.model, end.from, end.why], [true, 'deepseek-v4.1-flash', 'gemini-4-hydrogen', why]);
  assert.deepEqual(done.events.filter(e=>e.t==='user').map(e=>e.text), [text]);
  assert.deepEqual(done.events.filter(e=>e.t==='text').map(e=>e.text), ['deepseek-quota-answer']);
  assert.equal(done.events.some(e=>e.t==='err'), false);
  assert.equal(f.rows(f.log).filter(r=>r.method==='session/prompt').length, 1);
  const requests = f.rows(f.gateway);
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0].input), /真实的回复/);
  assert.match(requests[0].instructions, /当前前台没有直接搜网页或读网页的工具/);
  assert.equal(JSON.parse(fs.readFileSync(f.control+'/front-antigravity-quota.json')).blocked, false);
  assert.deepEqual(f.call('tasks',{sid:sent.sid}).tasks, []);
  fs.writeFileSync(f.root+'/mode', 'ok');
  const next = f.call('send', {sid:sent.sid,text:'下一句话'});
  assert.equal((await f.wait(next.run)).events.find(e=>e.t==='done').model, 'gemini-4-hydrogen');
 });
}
test('Hydrogen 在记忆操作后超时，不把这一轮交给备用模型重新执行', async t => {
 const f = fixture(t, 'stalled_after_memory');
 f.env.XIN_AGY_PROMPT_MS = '900';
 const sent = f.call('send', {agent:'codex', text:'你好'}), done = await f.wait(sent.run);
 assert.equal(done.events.find(e=>e.t==='done').ok, false);
 assert.equal(f.rows(f.gateway).length, 0);
 assert.equal(f.call('memory_list').items.filter(i=>i.content==='喜欢先看时序图').length, 1);
});
test('Hydrogen 把协议包在代码块和说明文字里、省略空 calls 时照常解析，不需要修正',async t=>{
 const f=fixture(t,'fenced'),sent=f.call('send',{agent:'codex',text:'你好'}),done=await f.wait(sent.run);
 const end=done.events.find(e=>e.t==='done');assert.equal(end.ok,true);assert.equal(end.model,'gemini-4-hydrogen');
 assert.equal(done.events.find(e=>e.t==='text').text,'native-front-answer');
 assert.equal(f.rows(f.log).filter(r=>r.method==='session/prompt').length,1);assert.equal(f.rows(f.gateway).length,0);
});
test('修正一次后仍是坏格式时，本轮改由 DeepSeek 用同一上下文回答，不把格式错误给用户，也不重复派活',async t=>{
 const f=fixture(t,'broken'),sent=f.call('send',{agent:'codex',text:'你觉得人生有什么意义？'}),done=await f.wait(sent.run);
 const end=done.events.find(e=>e.t==='done');assert.equal(end.ok,true);assert.equal(end.model,'deepseek-v4.1-flash');assert.equal(end.from,'gemini-4-hydrogen');
 assert.equal(end.why,'chat');
 assert.equal(done.events.find(e=>e.t==='text').text,'deepseek-quota-answer');
 assert.equal(f.rows(f.log).filter(r=>r.method==='session/prompt').length,2);
 const bodies=f.rows(f.gateway);assert.equal(bodies.length,1);assert.equal(bodies[0].model,'deepseek-v4.1-flash');assert.match(JSON.stringify(bodies[0].input),/人生有什么意义/);
 assert.deepEqual(f.call('tasks',{sid:sent.sid}).tasks,[]);
 // Format trouble is not a quota cooldown: the next turn tries Hydrogen again.
 assert.equal(fs.existsSync(f.control+'/front-antigravity-quota.json')&&JSON.parse(fs.readFileSync(f.control+'/front-antigravity-quota.json')).blocked,false);
});
test('控制器拒绝记录 Hydrogen（bad_front_model）时本轮改用 DeepSeek，记录切换原因而不是报错',async t=>{
 const f=fixture(t,'ok'),script=`
 import {openFrontProvider} from ${JSON.stringify(require('node:url').pathToFileURL(path.join(__dirname,'../site/xin/vm-front-agy.mjs')).href)};
 const seen=[],p=await openFrontProvider({binary:${JSON.stringify(f.root+'/bin/agy')},cwd:${JSON.stringify(f.root+'/front')},baseURL:'http://127.0.0.1:9/v1',key:'k',
  model:c=>{seen.push(c);if(c.model==='gemini-4-hydrogen')throw Error('bad_front_model');}});
 const out=await p.request({input:[{role:'user',content:'你好'}],tools:[]});p.close();
 console.log(JSON.stringify({seen,text:out.output[0].content[0].text}));`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{env:f.env,encoding:'utf8',timeout:20000});
 assert.equal(r.status,0,r.stderr);const d=JSON.parse(r.stdout.trim().split('\n').at(-1));
 assert.deepEqual(d.seen.map(c=>[c.model,c.reason]),[['gemini-4-hydrogen',null],['deepseek-v4.1-flash','front_model']]);
 assert.equal(d.text,'deepseek-quota-answer');assert.equal(f.rows(f.gateway).length,1);
 assert.equal(f.rows(f.log).filter(r=>r.method==='session/prompt').length,0);
});
test('前台协议解析：容忍代码块、前后说明和缺省 calls，纯文字当聊天；不从文字推断工具，仍拒绝越权工具和超量调用',async()=>{
 const {frontOutput}=await import(require('node:url').pathToFileURL(path.join(__dirname,'../site/xin/vm-front-agy.mjs')).href);
 const view=o=>o.output.map(x=>x.type==='message'?x.content[0].text:[x.name,JSON.parse(x.arguments)]);
 assert.deepEqual(view(frontOutput('{"text":"你好","calls":[]}')),['你好']);
 assert.deepEqual(view(frontOutput('好的\n```json\n{"text":"含 {括号} 和 \\"引号\\""}\n```\n谢谢')),['含 {括号} 和 "引号"']);
 assert.deepEqual(view(frontOutput('先说明 {"text":"","calls":[{"name":"xin","argv":["xin","task","list"]}]} 结尾')),[['xin',{argv:['xin','task','list']}]]);
 assert.deepEqual(view(frontOutput('人生的意义在于体验，我可以帮你派个任务去查。')),['人生的意义在于体验，我可以帮你派个任务去查。']);
 assert.equal(frontOutput('我去 xin task new 帮你做').output.filter(x=>x.type==='function_call').length,0);
 for(const bad of ['','   ','{"text":"半截','{"text":"","calls":[]}','前缀 "calls": [','{"text":"x","calls":"xin"}'])assert.throws(()=>frontOutput(bad),undefined,bad);
 assert.throws(()=>frontOutput('{"text":"","calls":[{"name":"shell","argv":["rm"]}]}'),/不允许的工具/);
 assert.throws(()=>frontOutput(JSON.stringify({text:'',calls:Array(6).fill({name:'xin',argv:['xin','task','list']})})),/字段不完整/);
 assert.throws(()=>frontOutput('完成事件也用纯文字',{prose:false}));
 assert.deepEqual(view(frontOutput('{"text":"","calls":[{"name":"finish_event","action":"deliver","text":"交付"}]}',{prose:false})),[['finish_event',{action:'deliver',text:'交付'}]]);
});
test('确认 Gemini 额度耗尽才切 DeepSeek，同一份图片与原话继续使用，冷却期间不反复试 Hydrogen',async t=>{
 const f=fixture(t,'blocked'),file=f.work+'/uploads/photo.png';fs.writeFileSync(file,'same-image');
 const sent=f.call('send',{agent:'codex',text:'图里写了什么',files:[{path:file,name:'photo.png'}]}),done=await f.wait(sent.run);
 const end=done.events.find(e=>e.t==='done');assert.equal(end.ok,true);assert.equal(end.model,'deepseek-v4.1-flash');assert.equal(end.from,'gemini-4-hydrogen');
 assert.equal(end.why,'front_quota_fallback');
 const body=f.rows(f.gateway)[0];assert.equal(body.model,'deepseek-v4.1-flash');assert.ok(body.input.at(-1).content.some(b=>b.type==='input_image'));assert.match(body.input.at(-1).content[0].text,/图里写了什么/);
 assert.equal(f.rows(f.log).filter(r=>r.method==='session/prompt').length,0);
 const count=f.rows(f.log).length,next=f.call('send',{sid:sent.sid,text:'继续聊'});await f.wait(next.run);assert.equal(f.rows(f.log).length,count);
 const q=JSON.parse(fs.readFileSync(f.control+'/front-antigravity-quota.json'));assert.ok(q.blocked&&q.retryAt>Date.now());
 q.retryAt=Date.now()-1;fs.writeFileSync(f.control+'/front-antigravity-quota.json',JSON.stringify(q));fs.writeFileSync(f.root+'/mode','ok');
 const recovered=f.call('send',{sid:sent.sid,text:'额度恢复后继续聊'}),after=await f.wait(recovered.run);assert.equal(after.events.find(e=>e.t==='done').model,'gemini-4-hydrogen');
});
test('Gemini 周限额用完、五小时限额被停用且不带恢复时间：照常改用 DeepSeek 回复，不报额度字段不完整',async t=>{
 const f=fixture(t,'weekly'),sent=f.call('send',{agent:'codex',text:'只回复 front-weekly'}),done=await f.wait(sent.run);
 const end=done.events.find(e=>e.t==='done');assert.equal(end.ok,true,JSON.stringify(done.events));assert.equal(end.model,'deepseek-v4.1-flash');
 assert.equal(done.events.find(e=>e.t==='text').text,'deepseek-quota-answer');assert.equal(f.rows(f.log).filter(r=>r.method==='session/prompt').length,0);
 const q=JSON.parse(fs.readFileSync(f.control+'/front-antigravity-quota.json'));assert.ok(q.blocked&&q.retryAt>Date.now()+3*86400000);assert.deepEqual(q.buckets.map(b=>b.id),['gemini-weekly']);
});
test('中途真实耗尽按同一上下文接给 DeepSeek，已执行的记忆调用不重复执行',async t=>{
 const f=fixture(t,'midquota'),sent=f.call('send',{agent:'codex',text:'请记住：喜欢先看时序图'}),done=await f.wait(sent.run);
 assert.equal(done.events.find(e=>e.t==='done').model,'deepseek-v4.1-flash');
 const payload=f.rows(f.gateway)[0];assert.ok(payload.input.some(i=>i.type==='function_call_output'));
 const items=f.call('memory_list').items;assert.equal(items.filter(i=>i.content==='喜欢先看时序图').length,1);
 assert.equal(f.rows(f.log).filter(r=>r.method==='session/prompt').length,2);
});
test('普通限流且真实额度还有剩余时不偷偷换模型，也不制造后台任务',async t=>{
 const f=fixture(t,'transient'),sent=f.call('send',{agent:'codex',text:'你好'}),done=await f.wait(sent.run);
 assert.equal(done.events.find(e=>e.t==='done').ok,false);assert.equal(f.rows(f.gateway).length,0);assert.deepEqual(f.call('tasks',{sid:sent.sid}).tasks,[]);
});
test('Hydrogen 派工仍由控制器原话照传，模型补写的造型、配色和技术栈不进入 goal',async t=>{
 const f=fixture(t),text='FRONT_DISPATCH：做一个钟表。',sent=f.call('send',{agent:'codex',text}),done=await f.wait(sent.run);
 assert.equal(done.events.find(e=>e.t==='done').ok,true);
 const tasks=f.call('tasks',{sid:sent.sid}).tasks;assert.equal(tasks.length,1);
 const original=JSON.parse(fs.readFileSync(f.control+'/sessions/'+tasks[0].sid+'.json'));assert.equal(original.goal,text);assert.equal(original.userRequest,text);
});
test('Hydrogen 未查询却声称查过时，补上的真实查询输入没有因增量偏移而漏掉',async t=>{
 const f=fixture(t,'claim'),sent=f.call('send',{agent:'codex',text:'你好'}),done=await f.wait(sent.run);
 assert.equal(done.events.find(e=>e.t==='text').text,'查不到当天记录，暂时不能确认。');
 const prompts=f.rows(f.log).filter(r=>r.method==='session/prompt');assert.equal(prompts.length,2);
 const input=JSON.parse(prompts[1].params.prompt.find(b=>b.type==='text').text).input;
 assert.ok(input.some(i=>i.type==='function_call'&&i.call_id==='controller_lookup'));
 assert.ok(input.some(i=>i.type==='function_call_output'&&JSON.parse(i.output).daily));
});
test('后台完成仍由默认 Hydrogen 接回、持久交付一次，完成事件不会被改成新工作',async t=>{
 const f=fixture(t),sent=f.call('send',{agent:'codex',text:'FRONT_DISPATCH：整理一份说明。'});await f.wait(sent.run);
 const until=performance.now()+platformTimeout(10000);let visible=[];
 while(performance.now()<until){f.call('tasks',{sid:sent.sid});const h=f.call('history',{sid:sent.sid});visible=h.runs.flatMap(r=>r.events).filter(e=>e.t==='text'&&e.taskResult);if(visible.length)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(visible.length,1);assert.match(visible[0].text,/原生前台已交付结果/);
 const h=f.call('history',{sid:sent.sid});assert.equal(h.runs.flatMap(r=>r.events).filter(e=>e.t==='text'&&e.taskResult).length,1);
 assert.equal(f.call('tasks',{sid:sent.sid}).tasks.length,1);
 assert.ok(h.runs.flatMap(r=>r.events).filter(e=>e.t==='done').every(e=>e.model==='gemini-4-hydrogen'));
});
test('用户停止 Hydrogen 会取消原生请求，保留已停止结果，不按超时派活或切 DeepSeek',async t=>{
 const f=fixture(t,'hang'),sent=f.call('send',{agent:'codex',text:'你好'});
 const until=performance.now()+platformTimeout(5000);while(!f.rows(f.log).some(r=>r.method==='session/prompt')){assert.ok(performance.now()<until);await new Promise(r=>setTimeout(r,40));}
 f.call('stop',{run:sent.run});const done=await f.wait(sent.run);assert.equal(done.events.find(e=>e.t==='done').stopped,true);
 assert.equal(f.rows(f.gateway).length,0);assert.deepEqual(f.call('tasks',{sid:sent.sid}).tasks,[]);
});

// 站长 2026-11-13：前台换 Gemini 4 Hydrogen、思考强度默认中，额度用完再切 DeepSeek，Claude 不再用。
// 账号里没有 Hydrogen（比如换了没有它的账号）：本轮改用 DeepSeek 回复并记下原因（unavailable），不让整轮报错；正式站联调会因为没有额度证据而判失败，提醒去查账号。
test('账号里没有 Gemini 4 Hydrogen：本轮改用 DeepSeek 回复、记下原因，不发提示给 agy，也不改用 Claude',async t=>{
 const f=fixture(t,'missing'),sent=f.call('send',{agent:'codex',text:'你好'}),done=await f.wait(sent.run);
 const end=done.events.find(e=>e.t==='done');assert.equal(end.ok,true,JSON.stringify(done.events));assert.equal(end.model,'deepseek-v4.1-flash');assert.equal(end.from,'gemini-4-hydrogen');
 assert.equal(done.events.find(e=>e.t==='text').text,'deepseek-quota-answer');
 assert.equal(f.rows(f.log).filter(r=>r.method==='session/prompt').length,0);
 assert.ok(!f.rows(f.log).some(r=>r.method==='session/set_model'&&/claude/.test(r.params.modelId)),'不改用 Claude');
});
test('前台的状态行：一开始用 DeepSeek Flash（思考关掉）概括站长这句话记成 think；Hydrogen 推来的思考也记成 think（src model，去掉开头客套）；回复照旧由 Hydrogen 给、不走网关',async t=>{
 const f=fixture(t,'think');fs.writeFileSync(f.root+'/status-text','回复问候');
 const sent=f.call('send',{agent:'codex',text:'你好呀'}),done=await f.wait(sent.run);
 assert.equal(done.events.find(e=>e.t==='done').model,'gemini-4-hydrogen');assert.equal(f.rows(f.gateway).length,0,'回复没有走 DeepSeek');
 const thinks=done.events.filter(e=>e.t==='think').map(e=>[e.src,e.text]);
 assert.deepEqual(thinks.find(x=>x[0]==='status'),['status','回复问候']);
 assert.deepEqual(thinks.find(x=>x[0]==='model'),['model','The user is greeting me, so a short friendly reply fits.']);
 const st=f.rows(f.root+'/status.jsonl');assert.equal(st.length,1);assert.equal(st[0].model,'deepseek-v4.1-flash');assert.deepEqual(st[0].reasoning,{effort:'none'});assert.match(JSON.stringify(st[0].input),/你好呀/);
 const stat=f.rows(f.control+'/model-stats.jsonl').find(r=>r.kind==='status');assert.ok(stat,'状态那一句的 token 记进用量');assert.equal(stat.model,'deepseek-v4.1-flash');assert.equal(stat.run,sent.run);
 assert.ok(f.rows(f.control+'/model-stats.jsonl').some(r=>r.run===sent.run&&r.kind!=='status'),'这一轮自己的记录还在');
});
