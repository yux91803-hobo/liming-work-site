const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');const {pathToFileURL}=require('node:url');
const agent=path.join(__dirname,'../site/xin/vm-agent.mjs'),load=()=>import('../site/xin/vm-runtime.mjs');
const html='<!doctype html><html><head><title>奶龙</title><style>body{margin:0}</style></head><body><button id="dance">跳舞</button><div id="dragon"></div><script>dance.onclick=()=>dragon.classList.add("dancing")</script></body></html>';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-web-test-')),control=path.join(root,'control'),project=path.join(root,'project');
 for(const p of [control+'/sessions',control+'/runs',project,root+'/profile',root+'/codex'])fs.mkdirSync(p,{recursive:true});
 const preload=root+'/preload.cjs';fs.writeFileSync(preload,'require("node:os").homedir=()=>'+JSON.stringify(root+'/profile')+';require("node:module").syncBuiltinESMExports();');
 const env={...process.env,XIN_HOME:control,XIN_WORK:root,CODEX_HOME:root+'/codex',XIN_TASK_MAX:'1',NODE_OPTIONS:'--require='+preload,XIN_CODEX_TRANSPORT:'exec'};
 const task={sid:'sweb'+crypto.randomBytes(7).toString('hex'),no:1,kind:'task',tkind:'code',title:'fixture',goal:'fixture',dir:project,status:'running',model:'glm-5.3',runs:['rwebholder01'],inbox:[],created:Date.now()};
 const save=()=>fs.writeFileSync(control+'/sessions/'+task.sid+'.json',JSON.stringify(task));save();fs.writeFileSync(control+'/runs/rwebholder01.json',JSON.stringify({sid:task.sid,pid:process.pid,started:Date.now()}));fs.writeFileSync(control+'/runs/rwebholder01.jsonl','');
 const call=(op,args={})=>{const r=spawnSync(process.execPath,[agent,'locked',op],{env,input:JSON.stringify(args),encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 const front=(text='你让 Kimi 去画个奶龙')=>{const sid='swebfront01',run='rwebfront01';fs.writeFileSync(control+'/sessions/'+sid+'.json',JSON.stringify({sid,agent:'codex',runs:[run]}));fs.writeFileSync(control+'/runs/'+run+'.json',JSON.stringify({sid,run,agent:'codex',model:'deepseek-v4.1-flash',frontNamed:'kimi-k3.1-pro',frontWeb:true,frontRequest:text,text,started:Date.now()}));fs.writeFileSync(control+'/runs/'+run+'.jsonl',JSON.stringify({t:'user',text})+'\n');return {sid,run};};
 t.after(async()=>{const a=await import(pathToFileURL(agent).href);for(let i=0;i<20;i++){let found=false;for(const n of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)&&Number(n)!==process.pid)){try{if(!fs.readFileSync('/proc/'+n+'/environ','utf8').split('\0').includes('XIN_HOME='+control))continue;const identity=a.processIdentity(Number(n));if(identity&&!['Z','X'].includes(identity.state)){found=true;a.signalProcessGroup(Number(n),identity,'SIGKILL');}}catch{}}if(!found)break;await new Promise(ok=>setTimeout(ok,30));}if(task.workspace)fs.rmSync(path.dirname(task.workspace.work),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});
 return {root,control,project,task,env,save,call,front};
}
async function web(t){const f=fixture(t),r=await load();fs.writeFileSync(f.project+'/index.html',html);fs.writeFileSync(f.project+'/xin-web.json',JSON.stringify({entry:'index.html',title:'奶龙',checks:[{selector:'#dance',expectSelector:'#dragon',expectClass:'dancing'}]}));f.task.web=true;f.task.workspace=r.prepareWorkspace(f.task,f.control);return {...f,r};}
test('前台派活逐字使用用户原话，丢弃模型扩写，长消息的最后一段和原图都保留',t=>{
 const f=fixture(t),original='让 Kimi 按这张图做个网页。\n颜色按我说的红色，按钮保留。\n'+'原话细节。'.repeat(2600)+'\n最后一条要求也不能丢。';
 const {run}=f.front(original),file=f.root+'/uploads/photo.png';fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'png');
 const mf=f.control+'/runs/'+run+'.json',meta=JSON.parse(fs.readFileSync(mf));meta.frontFiles=[{path:file,name:'photo.png',image:true}];meta.frontRequest='元数据里的另一种扩写也不能覆盖原文';fs.writeFileSync(mf,JSON.stringify(meta));
 const argv=['xin','task','new','--kind','code','--web','--title','做网页','--','额外新增绿色3D造型，必须使用 React，加十种动画和导航栏'];
 const result=f.call('front_action',{run,argv});assert.equal(result.terminal,true);
 const task=JSON.parse(fs.readFileSync(f.control+'/sessions/'+result.task.sid+'.json'));
 assert.equal(task.goal,original);assert.equal(task.userRequest,original);assert.deepEqual(task.files.map(x=>x.path),[file]);assert.equal(task.web,true);
 assert.ok(!task.goal.includes('绿色3D'));assert.equal(f.call('front_action',{run,argv}).task.sid,task.sid,'重放不重复派工');
});
test('前台确实不支持视觉时自动派一个 vision 工作，原图和原话照传，重复启动不再派一次',t=>{
 const f=fixture(t),original='图里写的是什么？',{run}=f.front(original),file=f.root+'/uploads/photo.png';fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'png');
 const mf=f.control+'/runs/'+run+'.json',meta=JSON.parse(fs.readFileSync(mf));Object.assign(meta,{model:'glm-5.3-flash',frontSeesImages:false,frontNamed:null,frontWeb:false,images:[],frontFiles:[{path:file,name:'photo.png',image:true}]});fs.writeFileSync(mf,JSON.stringify(meta));
 const first=f.call('front_immediate',{run}),again=f.call('front_immediate',{run});assert.equal(first.terminal,true);assert.equal(first.task.kind,'vision');assert.equal(again.task.sid,first.task.sid);
 const task=JSON.parse(fs.readFileSync(f.control+'/sessions/'+first.task.sid+'.json'));assert.equal(task.goal,original);assert.deepEqual(task.files.map(x=>x.path),[file]);
 assert.notEqual(task.model,'glm-5.3-flash');assert.equal(f.call('tasks',{all:true}).tasks.length,2,'只有占位任务和这一个看图任务');
});
test('前台能看图时不自动派活；根据图片制作时仍保留正常 code/web 派工',t=>{
 const f=fixture(t),original='根据图片做个能打开的交互网页',{run}=f.front(original),file=f.root+'/uploads/photo.webp';fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'webp');
 const mf=f.control+'/runs/'+run+'.json',meta=JSON.parse(fs.readFileSync(mf));Object.assign(meta,{frontSeesImages:true,frontFiles:[{path:file,name:'photo.webp',image:true}],images:[file]});fs.writeFileSync(mf,JSON.stringify(meta));
 assert.equal(f.call('front_immediate',{run}).terminal,undefined);assert.equal(f.call('tasks',{all:true}).tasks.length,1);
 const result=f.call('front_action',{run,argv:['xin','task','new','--kind','code','--web','--title','图片做网页','--','前台自己加的技术方案']});assert.equal(result.task.kind,'code');assert.equal(result.task.web,true);
 const task=JSON.parse(fs.readFileSync(f.control+'/sessions/'+result.task.sid+'.json'));assert.equal(task.goal,original);assert.deepEqual(task.files.map(x=>x.path),[file]);
});
test('前台只编码本轮已验证的上传图片；PDF 不冒充图片，丢失文件或指向外部的软链接明确失败',t=>{
 const f=fixture(t),dir=f.root+'/uploads';fs.mkdirSync(dir);const png=dir+'/a.png',webp=dir+'/b.webp',pdf=dir+'/c.pdf';for(const [p,data] of [[png,'png'],[webp,'webp'],[pdf,'pdf']])fs.writeFileSync(p,data);
 const meta={text:'图片已经直接给你看了。',frontFiles:[png,webp,pdf].map(p=>({path:p,name:path.basename(p)})),images:[png,webp]};
 const js=code=>{const r=spawnSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';import * as a from ${JSON.stringify(pathToFileURL(agent).href)};const meta=${JSON.stringify(meta)};${code}`],{env:f.env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 const content=js('console.log(JSON.stringify(a.frontUserInput(meta).content));');assert.deepEqual(content.filter(x=>x.type==='input_image').map(x=>x.image_url),['data:image/png;base64,'+Buffer.from('png').toString('base64'),'data:image/webp;base64,'+Buffer.from('webp').toString('base64')]);
 fs.unlinkSync(png);assert.match(js('try{a.frontUserInput(meta);console.log(JSON.stringify("unexpected"))}catch(e){console.log(JSON.stringify(e.message))}'),/图片没有成功传给我/);
 const outside=f.root+'/outside.txt';fs.writeFileSync(outside,'not an upload');fs.symlinkSync(outside,png);assert.match(js('try{a.frontUserInput(meta);console.log(JSON.stringify("unexpected"))}catch(e){console.log(JSON.stringify(e.message))}'),/图片没有成功传给我/);
});
test('xin task list/show 第一行按 actualModel 显示，Antigravity 和未知模型不误标成默认 GLM',t=>{
 const f=fixture(t),{run,sid}=f.front('查看任务');Object.assign(f.task,{no:24,parent:sid,status:'done',actualModel:'gemini-3.8-flash-high',model:'glm-5.3-flash'});f.save();
 const cli=(...argv)=>{const r=spawnSync(process.execPath,[agent,'xin','task',...argv],{env:{...f.env,XIN_RUN:run},encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.split('\n')[0];};
 for(const args of [['list'],['show','24']]){const line=cli(...args);assert.match(line,/Gemini 3\.8 Flash High/);assert.doesNotMatch(line,/GLM/);}
 const index=f.control+'/tasks-index.json';fs.unlinkSync(index);f.task.actualModel='future-vision-model';f.save();assert.match(cli('show','24'),/future-vision-model/);assert.doesNotMatch(cli('list'),/GLM/);
 fs.unlinkSync(index);Object.assign(f.task,{actualModel:null,status:'queued',runs:[]});f.save();assert.match(cli('show','24'),/尚未执行/);
});
test('网页清单只接受自包含 HTML、实际点击检查和副本内路径',async t=>{
 const f=await web(t),file=f.task.workspace.work+'/xin-web.json',initial=JSON.parse(fs.readFileSync(file));assert.equal(f.r.webManifest(f.task).title,'奶龙');
 for(const entry of ['../outside.html','/etc/passwd']){fs.writeFileSync(file,JSON.stringify({...initial,entry}));assert.throws(()=>f.r.webManifest(f.task),/HTML|副本/);}
 fs.writeFileSync(file,JSON.stringify({...initial,checks:[]}));assert.throws(()=>f.r.webManifest(f.task),/点击检查/);fs.writeFileSync(file,JSON.stringify(initial));
 fs.appendFileSync(f.task.workspace.work+'/index.html','<script src="https://example.com/app.js"></script>');assert.throws(()=>f.r.webManifest(f.task),/自包含/);
 fs.writeFileSync(f.task.workspace.work+'/index.html',html+'<img src="data:image/png;base64,AAAA">');assert.ok(f.r.webManifest(f.task));
});
test('预览快照绑定已检查 HTML，临时目录清理和修改原稿不影响成品',async t=>{
 const f=await web(t),m=f.r.webManifest(f.task),shot=f.task.workspace.tmp+'/shot.png';fs.writeFileSync(shot,Buffer.from('89504e470d0a1a0a00000000','hex'));
 assert.throws(()=>f.r.publishWebPreview(f.task,f.control,{ok:false}),/浏览器检查/);
 const preview=f.r.publishWebPreview(f.task,f.control,{ok:true,digest:m.digest,screenshot:shot,viewports:[{width:1280,checks:1},{width:390,checks:1}]}),a=f.r.previewAsset(f.control,{id:preview.id});assert.equal(fs.readFileSync(a.real,'utf8'),html);
 fs.appendFileSync(f.task.workspace.work+'/index.html','<!-- changed -->');assert.throws(()=>f.r.publishWebPreview(f.task,f.control,{ok:true,digest:m.digest}),/最终修改/);
 assert.equal(f.r.cleanupTaskTemporary({...f.task,status:'done'}),true);assert.equal(fs.readFileSync(a.real,'utf8'),html);assert.match(preview.url,/^\/xin\/preview.html\?id=[a-f0-9]{32}$/);
 assert.ok(f.r.previewAsset(f.control,{id:'../escape'}).error);assert.ok(f.r.previewAsset(f.control,{id:preview.id,file:'manifest.json'}).error);
});
test('待写回网页收到允许或拒绝后都清理 tmp；允许后的快照继续可读',async t=>{
 for(const decision of ['approve','deny']){
  const f=await web(t),m=f.r.webManifest(f.task),shot=f.task.workspace.tmp+'/shot.png';fs.writeFileSync(shot,Buffer.from('89504e470d0a1a0a00000000','hex'));
  Object.assign(f.task,{status:'waiting',publication:{pending:true},processesCleaned:true,result:{ok:false,text:'prepared'}});f.save();
  fs.writeFileSync(f.control+'/runs/rwebholder01.json',JSON.stringify({sid:f.task.sid,ended:true,webCheck:{trusted:true,ok:true,digest:m.digest,screenshot:shot,viewports:[{width:1280,checks:1},{width:390,checks:1}]}}));
  const r=f.call('task_tell',{sid:f.task.sid,decision});assert.equal(r.task.status,decision==='approve'?'done':'stopped');assert.deepEqual(r.task.cleanup,{processesGone:true,tmpCleaned:true});assert.deepEqual(fs.readdirSync(f.task.workspace.tmp),[]);
  const listed=f.call('tasks',{all:true}).tasks.find(x=>x.sid===f.task.sid);assert.deepEqual(listed.cleanup,r.task.cleanup);
  if(decision==='approve')assert.equal(fs.readFileSync(f.r.previewAsset(f.control,{id:r.task.preview.id}).real,'utf8'),html);else assert.equal(r.task.preview,undefined);
 }
});
test('奶龙由结构化语义派工创建一次后台 Kimi 工作，前台保持 DeepSeek',async t=>{
 const f=fixture(t),{run}=f.front();assert.equal(f.call('front_immediate',{run}).terminal,undefined);const a=f.call('front_action',{run,argv:['xin','task','new','--kind','code','--web','--title','奶龙互动网页','--','画奶龙互动网页']});assert.equal(a.terminal,true);assert.equal(a.text,'好，我这就去弄。');assert.equal(a.task.model,'kimi-k3.1-pro');assert.equal(a.task.web,true);assert.equal(a.task.strictModel,true);
 const record=JSON.parse(fs.readFileSync(f.control+'/sessions/'+a.task.sid+'.json'));assert.deepEqual(record.fallbacks,[]);assert.equal(record.requestedModel,'kimi-k3.1-pro');assert.equal(JSON.parse(fs.readFileSync(f.control+'/runs/'+run+'.json')).model,'deepseek-v4.1-flash');
 assert.equal(f.call('front_immediate',{run}).task.sid,a.task.sid);assert.equal(f.call('tasks',{all:true}).tasks.filter(t=>t.parent==='swebfront01').length,1);
});
test('明确先讨论或只点模型名，不会被快速接单路径变成实际工作',async t=>{
 const f=fixture(t),{run}=f.front('你让 Kimi 画奶龙，但我们先讨论再动手');assert.equal(f.call('front_immediate',{run}).terminal,undefined);assert.equal(f.call('tasks',{all:true}).tasks.length,1);
});
test('否定句、明确目录和直接制作都交给语义调度，关键词不擅自执行',async t=>{
 const f=fixture(t);
 for(const text of ['让 Kimi 画奶龙，不要现在开始','让 Kimi 画奶龙，xin task new --title exact --dir /data/workspace/demo -- 画奶龙']){const {run}=f.front(text);assert.equal(f.call('front_immediate',{run}).terminal,undefined);}
 const {run}=f.front('让 Kimi 画奶龙，不要先讨论，直接制作');assert.equal(f.call('front_immediate',{run}).terminal,undefined);assert.equal(f.call('tasks',{all:true}).tasks.length,1);
});
test('指定入口连续报错仅重试同一个 Kimi，不静默回退其它可用模型',async t=>{
 const f=fixture(t);fs.unlinkSync(f.control+'/sessions/'+f.task.sid+'.json');const bin=f.root+'/bin',log=f.root+'/models.jsonl';fs.mkdirSync(bin);f.env.PATH=bin+':'+process.env.PATH;f.env.XIN_TASK_SANDBOX='0';
 fs.writeFileSync(bin+'/codex','#!'+process.execPath+'\n'+`const fs=require('node:fs'),a=process.argv.slice(2),v=a.find(x=>x.startsWith('model='));if(!v){console.log('[]');process.exit(0);}fs.appendFileSync(${JSON.stringify(log)},v.slice(6)+'\\n');setTimeout(()=>{console.log(JSON.stringify({type:'error',message:'provider unavailable'}));process.exit(1);},150);`,{mode:0o755});
 const task=f.call('task_new',{kind:'research',goal:'strict provider fixture',model:'kimi-k3.1-pro',named:true,strictModel:true}).task;
 const deadline=Date.now()+15000;let h;while(Date.now()<deadline){h=f.call('history',{sid:task.sid}).task;if(['failed','done','waiting'].includes(h.status))break;await new Promise(ok=>setTimeout(ok,60));}
 assert.equal(h.status,'failed',JSON.stringify(h));assert.equal(h.actualModel,'kimi-k3.1-pro');assert.equal(h.requestedModel,'kimi-k3.1-pro');assert.deepEqual(fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse),['kimi-k3.1-pro','kimi-k3.1-pro']);
});
test('进度查询工具返回真实检查阶段，交给前台解释',async t=>{
 const f=fixture(t),{run,sid}=f.front('现在进度怎么样');f.task.parent=sid;f.task.stage='checking';f.task.web=true;f.save();
 assert.equal(f.call('front_immediate',{run}).terminal,undefined);const r=f.call('front_action',{run,argv:['xin','task','show','1']});assert.equal(r.task.stage,'checking');assert.match(r.task.activity,/检查/);assert.equal(r.task.preview,undefined);
});
test('带有补充要求的进度句继续交前台理解，不被快捷状态答复吞掉',async t=>{
 const f=fixture(t),{run,sid}=f.front('现在进度怎么样？把奶龙背景改成蓝色');f.task.parent=sid;f.save();assert.equal(f.call('front_immediate',{run}).terminal,undefined);
});
test('聊天和工作语义调度超时均保留原话，不制造未确定的后台任务',async t=>{
 const f=fixture(t),{run}=f.front('你好');const file=f.control+'/runs/'+run+'.json',m=JSON.parse(fs.readFileSync(file));delete m.frontNamed;m.frontWeb=false;fs.writeFileSync(file,JSON.stringify(m));
 assert.equal(f.call('front_fallback',{run}).error,'front_timeout');assert.equal(f.call('tasks',{all:true}).tasks.length,1);
 m.frontRequest='检查电路图';m.text=m.frontRequest;fs.writeFileSync(file,JSON.stringify(m));assert.equal(f.call('front_fallback',{run}).error,'front_timeout');assert.equal(f.call('tasks',{all:true}).tasks.length,1);
});
test('网页上下文里提及 STM32 不强制固件构建，原始固件工程仍保留强制核验',async t=>{
 const f=await web(t);f.task.goal='画 STM32 的交互网页';assert.equal(f.r.stm32Task(f.task),false);f.task.workspace.stm32=true;assert.equal(f.r.stm32Task(f.task),true);
});
test('预览接口要求站长登录，只交付校验过的快照并隔离脚本与站长 API',async t=>{
 const api=await import('../src/xin.js');api._reset();const id='a'.repeat(32),origin='https://liming-work.com',pw='correct horse battery';
 const env={OWNER_PASSWORD:pw,INSTABOX_API_KEY:'ibk_test_private',XIN_LOGIN_LIMIT:{limit:async()=>({success:true})},ASSETS:{fetch:async()=>new Response('// fake agent')}};
 const login=await api.handleXin(new Request(origin+'/api/xin/login',{method:'POST',headers:{'X-Xin':'1','Content-Type':'application/json'},body:JSON.stringify({password:pw})}),env,null);
 const cookie=login.headers.get('set-cookie').split(';')[0],req=(suffix='',authed=true)=>new Request(origin+'/api/xin/preview/'+id+'/index.html'+suffix,{headers:authed?{cookie}:{}});
 const real=global.fetch;let corrupt=false,reads=0;
 global.fetch=async(url,init={})=>{const u=new URL(url);if(u.pathname==='/v1/machines')return Response.json({machines:[{id:'m_test',name:'li'}]});if(u.pathname.endsWith('/exec')){const b=JSON.parse(init.body);assert.equal(b.argv.at(-1),'preview_asset');return Response.json({exitCode:0,stdout:JSON.stringify({real:'/data/home/.xin/previews/'+id+'/index.html',size:Buffer.byteLength(html),sha256:crypto.createHash('sha256').update(html).digest('hex'),mime:'text/html'})});}if(u.pathname.endsWith('/files/content')){reads++;assert.equal(u.searchParams.get('path'),'/data/home/.xin/previews/'+id+'/index.html');return new Response(corrupt?'changed':html);}throw Error('unexpected preview fetch');};
 t.after(()=>{global.fetch=real;api._reset();});
 assert.equal((await api.handleXin(req('',false),env,null)).status,401);assert.equal(reads,0);
 const r=await api.handleXin(req(),env,null);assert.equal(r.status,200);assert.equal(await r.text(),html);assert.match(r.headers.get('Content-Type'),/text\/html/);const csp=r.headers.get('Content-Security-Policy');assert.match(csp,/sandbox allow-scripts/);assert.doesNotMatch(csp,/allow-same-origin/);assert.match(csp,/connect-src 'none'/);assert.equal(csp,(await load()).WEB_PREVIEW_CSP);
 assert.match((await api.handleXin(req('?download=1'),env,null)).headers.get('Content-Disposition'),/attachment/);
 corrupt=true;assert.equal((await api.handleXin(req(),env,null)).status,502);
 assert.equal(api.OPS.has('preview_asset'),false);
});
test('预览元数据不能把私有控制文件伪装成网页',async t=>{
 const api=await import('../src/xin.js');api._reset();const origin='https://liming-work.com',pw='correct horse battery',id='b'.repeat(32),env={OWNER_PASSWORD:pw,INSTABOX_API_KEY:'ibk_test_private',XIN_LOGIN_LIMIT:{limit:async()=>({success:true})},ASSETS:{fetch:async()=>new Response('// fake agent')}};
 const r=await api.handleXin(new Request(origin+'/api/xin/login',{method:'POST',headers:{'X-Xin':'1','Content-Type':'application/json'},body:JSON.stringify({password:pw})}),env,null),cookie=r.headers.get('set-cookie').split(';')[0],real=global.fetch;
 global.fetch=async(url)=>{const u=new URL(url);if(u.pathname==='/v1/machines')return Response.json({machines:[{id:'m_test',name:'li'}]});if(u.pathname.endsWith('/exec'))return Response.json({exitCode:0,stdout:JSON.stringify({real:'/data/home/.xin/codex.key',size:12,sha256:'a'.repeat(64)})});assert.fail('private file must never be fetched');};t.after(()=>{global.fetch=real;api._reset();});
 assert.equal((await api.handleXin(new Request(origin+'/api/xin/preview/'+id+'/index.html',{headers:{cookie}}),env,null)).status,502);
});
test('点名模型已记录时，前台多写或写错的 --model 不挡派工；没点名时写错模型或类型会给出可选值',async t=>{
 const f=fixture(t),{run}=f.front();
 const a=f.call('front_action',{run,argv:['xin','task','new','--kind','code','--web','--model','kimi','--title','奶龙互动网页','--','画奶龙互动网页']});
 assert.equal(a.terminal,true);assert.equal(a.task.model,'kimi-k3.1-pro');assert.equal(a.task.web,true);
 const sid='swebfront02',other='rwebfront02',text='帮我查一下资料';
 fs.writeFileSync(f.control+'/sessions/'+sid+'.json',JSON.stringify({sid,agent:'codex',runs:[other]}));
 fs.writeFileSync(f.control+'/runs/'+other+'.json',JSON.stringify({sid,run:other,agent:'codex',model:'deepseek-v4.1-flash',frontNamed:null,frontRequest:text,text,started:Date.now()}));
 fs.writeFileSync(f.control+'/runs/'+other+'.jsonl',JSON.stringify({t:'user',text})+'\n');
 assert.match(f.call('front_action',{run:other,argv:['xin','task','new','--model','kimi','--','查资料']}).error,/^未知模型：kimi（可用：.*kimi-k3\.1-pro/);
 assert.match(f.call('front_action',{run:other,argv:['xin','task','new','--kind','web','--','查资料']}).error,/^未知工作类型：web（可用：quick、code/);
 assert.equal(f.call('tasks',{all:true}).tasks.filter(x=>x.parent===sid).length,0);
});
test('前台兜底记录只留命令形状：选项名和类型、模型、依据取值，不留标题、要求或要记的话',async()=>{
 const a=await import(pathToFileURL(agent).href);
 assert.deepEqual(a.frontCallShape('xin',{argv:['xin','task','new','--kind','code','--web','--model','kimi','--title','秘密标题','--','画我的秘密']},{error:'未知模型：kimi'}),{call:'task new --kind code --web --model kimi --title',error:'未知模型：kimi'});
 assert.deepEqual(a.frontCallShape('xin',{argv:['xin','remember','--basis','stated','--type','profile','我住在某个地方']},{text:'ok'}),{call:'remember --basis stated --type profile'});
 assert.deepEqual(a.frontCallShape('xin',{argv:['xin','task','new','--','做']},{terminal:true,text:'好'}),{call:'task new',terminal:true});
 assert.equal(a.frontCallShape('xin',null,{error:'x'}).call,'xin（参数不是有效 JSON）');
});
function chromium(){
 const pw='/opt/pw-browsers',found=[process.env.CHROMIUM_PATH,'/usr/lib/chromium/chromium','/usr/bin/google-chrome','/usr/bin/chromium'];
 try{for(const d of fs.readdirSync(pw).filter(d=>/^chromium-\d+$/.test(d)))found.push(pw+'/'+d+'/chrome-linux64/chrome',pw+'/'+d+'/chrome-linux/chrome');}catch{}
 return found.find(p=>p&&fs.existsSync(p));
}
test('网页验收用真浏览器点击：变化在下一帧或稍后（1.5 秒内）出现也算通过；一直没出现时说清楚看到的状态和连续点击的规则',async()=>{
 const browser=chromium();assert.ok(browser,'需要 Chromium：设置 CHROMIUM_PATH');
 const r=await load(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'xin-webcheck-'));
 const page=script=>'<!doctype html><html><head><title>奶龙</title></head><body><button id="wave" data-count="0" style="width:120px;height:40px">挥手</button><div id="dragon" style="width:80px;height:80px">龙</div><script>'+script+'</script></body></html>';
 const check=(name,script,checks)=>{const file=path.join(dir,name+'.html'),tmp=fs.mkdtempSync(path.join(dir,'tmp-'));fs.writeFileSync(file,page(script));
  const o=spawnSync(process.execPath,['--input-type=module','-e',r.WEB_BROWSER_CHECK,file,tmp,JSON.stringify({checks}),r.WEB_PREVIEW_CSP,browser],{encoding:'utf8',timeout:60000});
  try{return JSON.parse(o.stdout.trim());}catch{throw Error('检查脚本没有输出结果：'+o.stderr.slice(-500));}};
 const later=check('later','wave.onclick=()=>setTimeout(()=>{wave.dataset.count="1";},500)',[{selector:'#wave',expectSelector:'#wave',expectAttribute:{name:'data-count',value:'1'}}]);
 assert.equal(later.ok,true,later.error);assert.deepEqual(later.viewports.map(v=>v.width),[1280,390]);
 const gone=check('gone','wave.onclick=()=>{dragon.classList.add("happy");setTimeout(()=>dragon.classList.remove("happy"),30);}',[{selector:'#wave',expectSelector:'#dragon',expectClass:'happy'}]);
 assert.equal(gone.ok,false);assert.match(gone.error,/^点击 #wave 后 1\.5 秒内没有得到预期变化（#dragon 没有 class happy）；检查在同一页面按顺序连续点击/);
 const attr=check('attr','wave.onclick=()=>{wave.dataset.count="2";}',[{selector:'#wave',expectSelector:'#wave',expectAttribute:{name:'data-count',value:'1'}}]);
 assert.equal(attr.ok,false);assert.match(attr.error,/#wave 的 data-count 是 "2"，不是 "1"/);
});
