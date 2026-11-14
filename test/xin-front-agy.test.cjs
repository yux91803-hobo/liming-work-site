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
 if(!String(url).endsWith('/v1/responses'))return real(url,init);const body=JSON.parse(init.body);fs.appendFileSync(${JSON.stringify(gateway)},JSON.stringify(body)+'\\n');
 return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'deepseek-quota-answer'}]}],usage:{input_tokens:8,output_tokens:5}}));};`);
 fs.writeFileSync(bin+'/agy','#!'+process.execPath+'\n'+`
 const fs=require('node:fs'),a=process.argv.slice(2),modeFile=${JSON.stringify(root+'/mode')},mode=fs.existsSync(modeFile)?fs.readFileSync(modeFile,'utf8'):${JSON.stringify(mode)},log=${JSON.stringify(log)};
 const record=o=>fs.appendFileSync(log,JSON.stringify(o)+'\\n'),send=o=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\\n');
 record({argv:a,key:!!process.env.XIN_CODEX_KEY,cwd:process.cwd()});
 const rows=()=>fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse);
 if(a.includes('/usage')){const count=rows().filter(x=>x.argv?.includes('/usage')).length;console.log(JSON.stringify({event:'result',result:{command:{data:{groups:[
 {buckets:[{id:'3p-5h',remaining_fraction:0,reset_time:new Date(Date.now()+3600000).toISOString()}]},
 {buckets:[{id:'gemini-argon-wtu-weekly',remaining_fraction:0,reset_time:new Date(Date.now()+3600000).toISOString()}]},
 mode==='weekly'?{buckets:[{id:'gemini-weekly',remaining_fraction:0,reset_time:new Date(Date.now()+4*86400000).toISOString()},{id:'gemini-5h',window:'5h',disabled:true,remaining_fraction:.857}]}:
 {buckets:[{id:'gemini-5h',remaining_fraction:mode==='blocked'||mode==='midquota'&&count>1?0:1,reset_time:new Date(Date.now()+3600000).toISOString()},
 {id:'gemini-weekly',remaining_fraction:1,reset_time:new Date(Date.now()+7*86400000).toISOString()}]}]}}}}));process.exit(0);}
 if(a.includes('--help')){console.log('acp --agent --settings');process.exit(0);}
 let prompts=0;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);record(q);if(!q.method)return;
 if(q.method==='initialize')send({id:q.id,result:{protocolVersion:1,agentCapabilities:{promptCapabilities:{image:mode!=='noimage'}}}});
 else if(q.method==='session/new')send({id:q.id,result:{sessionId:'native-synthetic-session',models:{currentModelId:'another',availableModels:[...(mode==='missing'?[]:[{modelId:mode==='alias'?'MODEL_GEMINI_4_HYDROGEN_MEDIUM':'gemini-4-hydrogen-medium',name:'Gemini 4 Hydrogen (Medium)'},{modelId:'gemini-4-hydrogen-high',name:'Gemini 4 Hydrogen (High)'}]),{modelId:'claude-opus-5-5-high',name:'Claude Opus 5.5 (High)'}]}}});
 else if(q.method==='session/set_model')send({id:q.id,result:{}});
 else if(q.method==='session/prompt'){
 prompts++;
 if(mode==='hang')return;
 if(mode==='transient'||mode==='midquota'&&prompts===2){send({id:q.id,error:{code:429,message:mode==='transient'?'rate limit, retry shortly':'quota exhausted'}});return;}
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
 if(mode==='midquota'&&prompts===1){text='';calls=[{name:'xin',argv:['xin','remember','--basis','stated','--type','profile','喜欢先看时序图']}];}
 if((body.tools||[]).some(t=>t.name==='finish_event')){text='';calls=[{name:'finish_event',action:'deliver',text:'我核对好了，原生前台已交付结果。'}];}
 const answer=mode==='plain'&&prompts===1?text:mode==='broken'?'{"text":"半截回复':mode==='fenced'?'好的，按格式回复：\\n'+String.fromCharCode(96).repeat(3)+'json\\n'+JSON.stringify({text})+'\\n'+String.fromCharCode(96).repeat(3)+'\\n':JSON.stringify({text,calls});send({method:'session/update',params:{sessionId:'native-synthetic-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:answer}}}});
 send({id:q.id,result:{stopReason:'end_turn'}});
 }else send({id:q.id,result:{}});
 });`,{mode:0o755});
 // Only dispatched test tasks use this fake CLI; no real service is contacted.
 fs.writeFileSync(bin+'/codex','#!'+process.execPath+'\n'+`console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'后台测试完成'}}));`,{mode:0o755});
 const env={...process.env,HOME:home,XIN_HOME:control,XIN_WORK:work,XIN_AGY_HOME:home,XIN_ANTIGRAVITY_BIN:bin+'/agy',NODE_OPTIONS:'--require='+preload,PATH:bin+':'+process.env.PATH,XIN_CODEX_TRANSPORT:'exec',XIN_TASK_SANDBOX:'0',XIN_CODEX_KEY:'must-not-reach-native'};
  const ensureState=require('./helpers/state-mode.cjs').stateClient(t,env);
 delete env.XIN_FRONT_PROVIDER;
 const call=(op,args={})=>{ ensureState();const r=spawnSync(process.execPath,[agent,op],{env,input:JSON.stringify(args),encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);const d=JSON.parse(r.stdout);assert.ok(!d.error,JSON.stringify(d));return d;};
 const wait=async run=>{const until=Date.now()+platformTimeout(15000);while(Date.now()<until){const p=call('poll',{run,off:0});if(p.done)return p;await new Promise(r=>setTimeout(r,70));}assert.fail('synthetic front did not finish');};
 const rows=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 t.after(()=>stopOwned(control,root));
 return {root,control,home,work,env,log,gateway,call,wait,rows};
}
test('前台默认用 Gemini 4 Hydrogen（思考强度中），Claude、Argon 的额度用完不影响它；原生端没有网关密钥或执行权限',async t=>{
 const f=fixture(t,'deny'),sent=f.call('send',{agent:'codex',text:'你好'}),done=await f.wait(sent.run);
 const end=done.events.find(e=>e.t==='done');assert.equal(end.ok,true);assert.equal(end.model,'gemini-4-hydrogen');assert.equal(f.rows(f.gateway).length,0);
 assert.equal(done.events.find(e=>e.t==='text').text,'native-front-answer');
 const records=f.rows(f.log);assert.ok(records.filter(r=>r.argv).every(r=>!r.key&&r.cwd===f.control+'/front-antigravity'));
 const init=records.find(r=>r.method==='initialize');assert.equal(init.params.clientCapabilities.terminal,false);assert.equal(init.params.clientCapabilities.fs.writeTextFile,false);
 assert.deepEqual(records.find(r=>r.method==='session/new').params.mcpServers,[]);
 assert.equal(records.find(r=>r.method==='session/set_model').params.modelId,'gemini-4-hydrogen-medium','思考强度默认中');
 assert.equal(records.find(r=>r.id===900&&!r.method).result.outcome.outcome,'cancelled');assert.equal(records.find(r=>r.id===901&&!r.method).error.code,-32601);
 assert.equal(fs.existsSync(f.root+'/must-not-exist'),false);
 const session=f.call('history',{sid:sent.sid}).session;assert.equal(session.model,'gemini-4-hydrogen');
 const q=JSON.parse(fs.readFileSync(f.control+'/front-antigravity-quota.json'));assert.equal(q.blocked,false);assert.equal(q.buckets.length,2);assert.ok(q.buckets.every(b=>/^gemini-(?!argon-)/.test(b.id)),'只看 Gemini 组：Claude、Argon 用完不算');
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
test('接口用提供方枚举标识 Hydrogen（Medium）时仍可运行，保留实际 ID，不误当成未知前台模型',async t=>{
 const f=fixture(t,'alias'),sent=f.call('send',{agent:'codex',text:'你好'}),done=await f.wait(sent.run),end=done.events.find(e=>e.t==='done');
 assert.equal(end.ok,true);assert.equal(end.model,'gemini-4-hydrogen');assert.equal(end.providerModel,'MODEL_GEMINI_4_HYDROGEN_MEDIUM');
 assert.equal(f.rows(f.log).find(r=>r.method==='session/set_model').params.modelId,'MODEL_GEMINI_4_HYDROGEN_MEDIUM');
});
test('Hydrogen 用纯文字聊天时直接当作回复交付，不再报格式错误，也不切模型',async t=>{
 const f=fixture(t,'plain'),sent=f.call('send',{agent:'codex',text:'你觉得人生有什么意义？'}),done=await f.wait(sent.run);
 const end=done.events.find(e=>e.t==='done');assert.equal(end.ok,true);assert.equal(end.model,'gemini-4-hydrogen');assert.equal(end.from,undefined);
 assert.equal(done.events.find(e=>e.t==='text').text,'native-front-answer');
 assert.equal(f.rows(f.log).filter(r=>r.method==='session/prompt').length,1);assert.equal(f.rows(f.gateway).length,0);
 assert.deepEqual(f.call('tasks',{sid:sent.sid}).tasks,[]);
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
 const until=Date.now()+platformTimeout(10000);let visible=[];
 while(Date.now()<until){f.call('tasks',{sid:sent.sid});const h=f.call('history',{sid:sent.sid});visible=h.runs.flatMap(r=>r.events).filter(e=>e.t==='text'&&e.taskResult);if(visible.length)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(visible.length,1);assert.match(visible[0].text,/原生前台已交付结果/);
 const h=f.call('history',{sid:sent.sid});assert.equal(h.runs.flatMap(r=>r.events).filter(e=>e.t==='text'&&e.taskResult).length,1);
 assert.equal(f.call('tasks',{sid:sent.sid}).tasks.length,1);
 assert.ok(h.runs.flatMap(r=>r.events).filter(e=>e.t==='done').every(e=>e.model==='gemini-4-hydrogen'));
});
test('用户停止 Hydrogen 会取消原生请求，保留已停止结果，不按超时派活或切 DeepSeek',async t=>{
 const f=fixture(t,'hang'),sent=f.call('send',{agent:'codex',text:'你好'});
 const until=Date.now()+platformTimeout(5000);while(!f.rows(f.log).some(r=>r.method==='session/prompt')){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,40));}
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
