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
test('奶龙点名直接生成一次后台 Kimi 工作，前台始终 DeepSeek 且不允许模型回退',async t=>{
 const f=fixture(t),{run}=f.front(),a=f.call('front_immediate',{run});assert.equal(a.terminal,true);assert.equal(a.text,'好，我这就去弄。');assert.equal(a.task.model,'kimi-k3.1-pro');assert.equal(a.task.web,true);assert.equal(a.task.strictModel,true);
 const record=JSON.parse(fs.readFileSync(f.control+'/sessions/'+a.task.sid+'.json'));assert.deepEqual(record.fallbacks,[]);assert.equal(record.requestedModel,'kimi-k3.1-pro');assert.equal(JSON.parse(fs.readFileSync(f.control+'/runs/'+run+'.json')).model,'deepseek-v4.1-flash');
 assert.equal(f.call('front_immediate',{run}).task.sid,a.task.sid);assert.equal(f.call('tasks',{all:true}).tasks.filter(t=>t.parent==='swebfront01').length,1);
});
test('明确先讨论或只点模型名，不会被快速接单路径变成实际工作',async t=>{
 const f=fixture(t),{run}=f.front('你让 Kimi 画奶龙，但我们先讨论再动手');assert.equal(f.call('front_immediate',{run}).terminal,undefined);assert.equal(f.call('tasks',{all:true}).tasks.length,1);
});
test('快速接单尊重暂不动手与显式调度参数，不误解不要先讨论',async t=>{
 const f=fixture(t);
 for(const text of ['让 Kimi 画奶龙，不要现在开始','让 Kimi 画奶龙，xin task new --title exact --dir /data/workspace/demo -- 画奶龙']){const {run}=f.front(text);assert.equal(f.call('front_immediate',{run}).terminal,undefined);}
 const {run}=f.front('让 Kimi 画奶龙，不要先讨论，直接制作');assert.equal(f.call('front_immediate',{run}).terminal,true);
});
test('指定入口连续报错仅重试同一个 Kimi，不静默回退其它可用模型',async t=>{
 const f=fixture(t);fs.unlinkSync(f.control+'/sessions/'+f.task.sid+'.json');const bin=f.root+'/bin',log=f.root+'/models.jsonl';fs.mkdirSync(bin);f.env.PATH=bin+':'+process.env.PATH;f.env.XIN_TASK_SANDBOX='0';
 fs.writeFileSync(bin+'/codex','#!'+process.execPath+'\n'+`const fs=require('node:fs'),a=process.argv.slice(2),v=a.find(x=>x.startsWith('model='));if(!v){console.log('[]');process.exit(0);}fs.appendFileSync(${JSON.stringify(log)},v.slice(6)+'\\n');setTimeout(()=>{console.log(JSON.stringify({type:'error',message:'provider unavailable'}));process.exit(1);},150);`,{mode:0o755});
 const task=f.call('task_new',{kind:'research',goal:'strict provider fixture',model:'kimi-k3.1-pro',named:true,strictModel:true}).task;
 const deadline=Date.now()+15000;let h;while(Date.now()<deadline){h=f.call('history',{sid:task.sid}).task;if(['failed','done','waiting'].includes(h.status))break;await new Promise(ok=>setTimeout(ok,60));}
 assert.equal(h.status,'failed',JSON.stringify(h));assert.equal(h.actualModel,'kimi-k3.1-pro');assert.equal(h.requestedModel,'kimi-k3.1-pro');assert.deepEqual(fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse),['kimi-k3.1-pro','kimi-k3.1-pro']);
});
test('进度按真实检查阶段回答，不凭空报已完成或泄露内部模型',async t=>{
 const f=fixture(t),{run,sid}=f.front('现在进度怎么样');f.task.parent=sid;f.task.stage='checking';f.task.web=true;f.save();
 const r=f.call('front_immediate',{run});assert.equal(r.terminal,true);assert.match(r.text,/实际打开|检查/);assert.doesNotMatch(r.text,/Kimi|GLM|DeepSeek|分身|任务\s*\d|\d+%/);
});
test('带有补充要求的进度句继续交前台理解，不被快捷状态答复吞掉',async t=>{
 const f=fixture(t),{run,sid}=f.front('现在进度怎么样？把奶龙背景改成蓝色');f.task.parent=sid;f.save();assert.equal(f.call('front_immediate',{run}).terminal,undefined);
});
test('普通聊天超时不制造后台任务，明确工作仍保留原话交给后台',async t=>{
 const f=fixture(t),{run}=f.front('你好');const file=f.control+'/runs/'+run+'.json',m=JSON.parse(fs.readFileSync(file));delete m.frontNamed;m.frontWeb=false;fs.writeFileSync(file,JSON.stringify(m));
 assert.equal(f.call('front_fallback',{run}).error,'front_timeout');assert.equal(f.call('tasks',{all:true}).tasks.length,1);
 m.frontRequest='检查电路图';m.text=m.frontRequest;fs.writeFileSync(file,JSON.stringify(m));assert.equal(f.call('front_fallback',{run}).terminal,true);
});
test('网页上下文里提及 STM32 不强制固件构建，原始固件工程仍保留强制核验',async t=>{
 const f=await web(t);f.task.goal='画 STM32 的交互网页';assert.equal(f.r.stm32Task(f.task),false);f.task.workspace.stm32=true;assert.equal(f.r.stm32Task(f.task),true);
});
test('预览接口要求站长登录，只交付校验过的快照并隔离脚本与站长 API',async t=>{
 const api=await import('../src/xin.js');api._reset();const id='a'.repeat(32),origin='https://liming-work.com',pw='correct horse battery';
 const env={OWNER_PASSWORD:pw,INSTABOX_API_KEY:'ibk_test_private',ASSETS:{fetch:async()=>new Response('// fake agent')}};
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
 const api=await import('../src/xin.js');api._reset();const origin='https://liming-work.com',pw='correct horse battery',id='b'.repeat(32),env={OWNER_PASSWORD:pw,INSTABOX_API_KEY:'ibk_test_private',ASSETS:{fetch:async()=>new Response('// fake agent')}};
 const r=await api.handleXin(new Request(origin+'/api/xin/login',{method:'POST',headers:{'X-Xin':'1','Content-Type':'application/json'},body:JSON.stringify({password:pw})}),env,null),cookie=r.headers.get('set-cookie').split(';')[0],real=global.fetch;
 global.fetch=async(url)=>{const u=new URL(url);if(u.pathname==='/v1/machines')return Response.json({machines:[{id:'m_test',name:'li'}]});if(u.pathname.endsWith('/exec'))return Response.json({exitCode:0,stdout:JSON.stringify({real:'/data/home/.xin/codex.key',size:12,sha256:'a'.repeat(64)})});assert.fail('private file must never be fetched');};t.after(()=>{global.fetch=real;api._reset();});
 assert.equal((await api.handleXin(new Request(origin+'/api/xin/preview/'+id+'/index.html',{headers:{cookie}}),env,null)).status,502);
});
