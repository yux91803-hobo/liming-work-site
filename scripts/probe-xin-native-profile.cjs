// One synthetic native image call; never prints prompt, response, credentials, or owner conversations.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const home='/data/home',binary=['.local/bin/agy','.gemini/bin/agy'].map(p=>path.join(home,p)).find(p=>fs.existsSync(p));
const out={available:!!binary};let child,pending=new Map(),seq=0,text='',sid='',profile='';
const env={HOME:home,PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'};
function rpc(method,params,ms=20000){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('rpc_timeout'));},ms);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
function end(){if(child&&!child.killed){child.stdin.end();child.kill('SIGTERM');}}
(async()=>{try{
 if(!binary)return;
 const help=cp.spawnSync(binary,['acp','--help'],{env,encoding:'utf8',timeout:7000});out.profileFlag=((help.stdout||'')+(help.stderr||'')).includes('--app-data-dir');if(!out.profileFlag)return;
 const auth=path.join(home,'.gemini/antigravity-cli/antigravity-oauth-token');out.existingSignIn=fs.existsSync(auth);if(!out.existingSignIn)return;
 profile=path.join(home,'.xin/diagnostic/native-profile-'+crypto.randomBytes(8).toString('hex'));fs.mkdirSync(profile,{recursive:true,mode:0o700});
 fs.symlinkSync(auth,path.join(profile,'antigravity-oauth-token'));fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({useG1Credits:false}),{mode:0o600});
 out.noPaidCredits=true;
 child=cp.spawn(binary,['acp','--app-data-dir',profile,'--agent','xin-front-controller','--log-file','/dev/null'],{cwd:profile,env,stdio:['pipe','pipe','pipe']});child.stderr.resume();child.stdout.setEncoding('utf8');let buffer='';
 child.stdout.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){let q;try{q=JSON.parse(buffer.slice(0,n));}catch{buffer=buffer.slice(n+1);continue;}buffer=buffer.slice(n+1);
  if(q.method){if(Object.hasOwn(q,'id'))child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:q.id,...(q.method==='session/request_permission'?{result:{outcome:{outcome:'cancelled'}}}:{error:{code:-32601,message:'No file or terminal capability'}})})+'\n');else if(q.method==='session/update'&&q.params?.update?.sessionUpdate==='agent_message_chunk')text+=q.params.update.content?.text||'';continue;}
  const p=pending.get(q.id);if(p){clearTimeout(p.timer);pending.delete(q.id);q.error?p.reject(Error('native_rpc_error')):p.resolve(q.result||{});}
 }});
 child.on('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('native_closed'));}pending.clear();});child.on('error',()=>{});child.stdin.on('error',()=>{});
 const init=await rpc('initialize',{protocolVersion:1,clientInfo:{name:'xin-profile-preflight',version:'1'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});out.imageCapability=init.agentCapabilities?.promptCapabilities?.image===true;
 const session=await rpc('session/new',{cwd:profile,mcpServers:[]});sid=session.sessionId;out.uuidSession=/^[a-f0-9-]{36}$/i.test(sid||'');
 const models=session.models?.availableModels||[];out.models=models.slice(0,40).map(m=>({id:String(m.modelId).slice(0,100),name:String(m.name||'').slice(0,100)}));
 const target=models.find(m=>m.modelId==='gemini-3.8-flash-high')||models.find(m=>/gemini.*3[. -]8.*flash/i.test(m.name||''));out.selected=target?.modelId||null;if(!target||!out.imageCapability)return;
 if(session.models.currentModelId!==target.modelId)await rpc('session/set_model',{sessionId:sid,modelId:target.modelId});
 const visual='READ-'+crypto.randomBytes(5).toString('hex').toUpperCase(),image=path.join(profile,'synthetic.png'),chrome=['/usr/lib/chromium/chromium','/usr/bin/chromium'].find(p=>fs.existsSync(p));if(!chrome){out.capture=false;return;}
 const html='<html><body style="margin:0;background:white"><div style="padding:30px;font:bold 90px monospace;color:black">'+visual+'</div></body></html>';
 const capture=cp.spawnSync(chrome,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--hide-scrollbars','--no-first-run','--user-data-dir='+path.join(profile,'capture'),'--window-size=1100,220','--virtual-time-budget=500','--screenshot='+image,'data:text/html,'+encodeURIComponent(html)],{env,stdio:'ignore',timeout:20000});out.capture=capture.status===0&&fs.existsSync(image);if(!out.capture)return;
 await rpc('session/prompt',{sessionId:sid,prompt:[{type:'text',text:'这是控制器的合成看图检查。只照写图片中唯一一行字符到 JSON 的 text，calls 为空。不执行动作、不查询、不记忆。'},{type:'image',mimeType:'image/png',data:fs.readFileSync(image).toString('base64')}]},65000);
 out.pixelAnswerMatches=text.includes(visual);
 out.profileConversations=(()=>{try{return fs.readdirSync(path.join(profile,'conversations')).filter(f=>f.endsWith('.db')).length;}catch{return 0;}})();
 out.ownSessionInDefault=out.uuidSession&&fs.existsSync(path.join(home,'.gemini/antigravity-cli/conversations',sid+'.db'));
 out.profileContainsSession=out.uuidSession&&fs.existsSync(path.join(profile,'conversations',sid+'.db'));
 }catch(e){out.error=['rpc_timeout','native_rpc_error','native_closed'].includes(e.message)?e.message:'preflight_unavailable';}
 finally{end();process.stdout.write(JSON.stringify(out));setTimeout(()=>process.exit(0),1000).unref();}
})().catch(()=>{end();process.stdout.write(JSON.stringify({error:'preflight_unavailable'}));});
