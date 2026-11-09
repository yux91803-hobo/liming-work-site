// Session setup only: no prompts, model inference, owner history reads or account sign-ins.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const home='/data/home',binary=['.local/bin/agy','.gemini/bin/agy'].map(p=>path.join(home,p)).find(p=>fs.existsSync(p));
const baseEnv={HOME:home,PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'},out={available:!!binary,cases:[]};
const classify=e=>({code:e?.code,kinds:Object.entries({agent:/agent/i,missing:/not.found|does not exist|unknown|cannot.find/i,auth:/auth|credential|log.?in|sign.?in/i,directory:/workspace|directory|working.dir/i,storage:/migrat|schema|sqlite|database/i,permission:/denied|permission|not.allowed/i,invalid:/invalid|expired/i}).filter(([,re])=>re.test(JSON.stringify(e))).map(([k])=>k),dataType:typeof e?.data,dataKeys:e?.data&&typeof e.data==='object'?Object.keys(e.data).slice(0,12):[]});
async function inspect(name,{privateHome,custom,privateConfig}){
 const r={name},root=path.join(home,'.xin/diagnostic/native-setup-'+crypto.randomBytes(8).toString('hex')),app=path.join(root,'.gemini/antigravity-cli'),work=path.join(root,'work'),gemini=path.join(root,'.gemini');
 for(const dir of [app,work,path.join(gemini,'config/agents/xin-front-controller')])fs.mkdirSync(dir,{recursive:true,mode:0o700});
 fs.symlinkSync(path.join(home,'.gemini/antigravity-cli/antigravity-oauth-token'),path.join(app,'antigravity-oauth-token'));
 fs.writeFileSync(path.join(app,'settings.json'),JSON.stringify({model:'gemini-3.8-flash-high',useG1Credits:false,toolPermission:'strict',allowNonWorkspaceAccess:false}),{mode:0o600});
 fs.writeFileSync(path.join(gemini,'config/agents/xin-front-controller/agent.md'),'---\nname: xin-front-controller\ndescription: Synthetic native setup\n---\nDo not execute tools. Only return text when explicitly prompted.\n',{mode:0o600});
 const args=['acp','--app-data-dir',app,'--log-file','/dev/null'];if(custom)args.push('--agent','xin-front-controller');if(privateConfig)args.push('--gemini-dir',gemini);
 const child=cp.spawn(binary,args,{cwd:work,env:{...baseEnv,HOME:privateHome?root:home},stdio:['pipe','pipe','pipe']});let seq=0,buffer='',pending=new Map(),closed=false;
 const send=o=>{if(!child.stdin.destroyed)child.stdin.write(JSON.stringify({jsonrpc:'2.0',...o})+'\n');};
 const request=(method,params)=>new Promise((resolve,reject)=>{if(closed)return reject({code:'closed'});const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject({code:'timeout'});},6000);pending.set(id,{resolve,reject,timer});send({id,method,params});});
 child.stderr.resume();child.stdout.setEncoding('utf8');child.stdin.on('error',()=>{});child.on('error',()=>{});
 child.stdout.on('data',s=>{buffer+=s;if(buffer.length>1024*1024){child.kill('SIGKILL');return;}let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);let q;try{q=JSON.parse(line);}catch{continue;}
  if(q.method){if(Object.hasOwn(q,'id'))send({id:q.id,...(q.method==='session/request_permission'?{result:{outcome:{outcome:'cancelled'}}}:{error:{code:-32601,message:'No external tools'}})});continue;}
  const p=pending.get(q.id);if(p){clearTimeout(p.timer);pending.delete(q.id);q.error?p.reject(q.error):p.resolve(q.result||{});}
 }});
 child.on('close',code=>{closed=true;r.exit=code;for(const p of pending.values()){clearTimeout(p.timer);p.reject({code:'closed'});}pending.clear();});
 try{
  const init=await request('initialize',{protocolVersion:1,clientInfo:{name:'xin-setup-only',version:'1'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
  r.initialized=true;r.authMethods=(init.authMethods||[]).map(a=>a.id).filter(id=>typeof id==='string'&&/^[a-z0-9_-]{1,80}$/i.test(id));
  const session=await request('session/new',{cwd:work,mcpServers:[]});r.newSession=!!session.sessionId;r.models=(session.models?.availableModels||[]).map(m=>({id:m.modelId,name:m.name})).slice(0,30);r.config=(session.configOptions||[]).map(c=>({id:c.id,name:c.name,type:c.type,options:(c.options||[]).map(o=>({value:o.value,name:o.name}))})).slice(0,10);
 }catch(e){r.error=classify(e);}finally{child.stdin.end();if(!closed)child.kill('SIGTERM');await new Promise(resolve=>{if(closed)return resolve();const t=setTimeout(()=>{child.kill('SIGKILL');resolve();},1000);child.once('close',()=>{clearTimeout(t);resolve();});});}
 return r;
}
(async()=>{try{if(!binary)return;const help=cp.spawnSync(binary,['acp','--help'],{env:baseEnv,encoding:'utf8',timeout:5000});out.flags=String(help.stdout||help.stderr||'').split('\n').filter(l=>/--(?:app\s|app-data-dir|gemini-dir|agent|model)/.test(l)).map(l=>l.trim()).slice(0,10);
 for(const [name,options] of [['private-custom',{privateHome:true,privateConfig:true,custom:true}],['private-default',{privateHome:true,privateConfig:true,custom:false}],['global-custom',{privateHome:false,privateConfig:false,custom:true}],['global-default',{privateHome:false,privateConfig:false,custom:false}],['global-private-config',{privateHome:false,privateConfig:true,custom:false}]])out.cases.push(await inspect(name,options));
 }catch{out.error='setup_unavailable';}finally{process.stdout.write(JSON.stringify(out));}})();
