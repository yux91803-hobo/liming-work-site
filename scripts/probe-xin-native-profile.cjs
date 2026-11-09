// Synthetic native image and private-HOME checks; never prints prompt, response, credentials, or owner conversations.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const home='/data/home',binary=['.local/bin/agy','.gemini/bin/agy'].map(p=>path.join(home,p)).find(p=>fs.existsSync(p));
const out={available:!!binary};let stderr='',child,pending=new Map(),seq=0,text='',sid='',profile='';
let env={HOME:home,PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'};
function rpc(method,params,ms=20000){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('rpc_timeout'));},ms);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
function end(){if(child&&!child.killed){child.stdin.end();child.kill('SIGTERM');}}
(async()=>{try{
 if(!binary)return;
 const help=cp.spawnSync(binary,['acp','--help'],{env,encoding:'utf8',timeout:7000});out.profileFlag=((help.stdout||'')+(help.stderr||'')).includes('--app-data-dir');out.settingsFlag=((help.stdout||'')+(help.stderr||'')).includes('--settings');if(!out.profileFlag)return;
 const auth=path.join(home,'.gemini/antigravity-cli/antigravity-oauth-token');out.existingSignIn=fs.existsSync(auth);if(!out.existingSignIn)return;
 const root=path.join(home,'.xin/diagnostic/native-profile-home-'+crypto.randomBytes(8).toString('hex')),work=path.join(root,'work'),agents=path.join(root,'.gemini/config/agents');profile=path.join(root,'.gemini/antigravity-cli');
 for(const dir of [profile,work,agents])fs.mkdirSync(dir,{recursive:true,mode:0o700});
 fs.symlinkSync(auth,path.join(profile,'antigravity-oauth-token'));
 const settings={useG1Credits:false,toolPermission:'strict',allowNonWorkspaceAccess:false,permissions:{deny:['command(*)','read_file(*)','write_file(*)','execute_url(*)','mcp(*)'],allow:[]}};
 fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify(settings),{mode:0o600});
 fs.writeFileSync(path.join(agents,'xin-front-controller.md'),'---\nname: xin-front-controller\ndescription: Synthetic private profile verification\nmainAgent: true\nsubagent: false\ntools:\n  - finish\n---\nOnly return JSON with text and calls. Calls is empty. Do not execute tools or remember.\n',{mode:0o600});
 env={...env,HOME:root};out.noPaidCredits=true;out.privateHome=true;out.canonicalRoot=fs.realpathSync(root)===root;
 out.pythonPlaywright=cp.spawnSync('python3',['-c',"import importlib.util;print(bool(importlib.util.find_spec('playwright')))"],{env,encoding:'utf8',timeout:5000}).stdout?.trim()==='True';
 out.displaySockets=(()=>{try{return fs.readdirSync('/tmp/.X11-unix').filter(n=>/^X[0-9]+$/.test(n)).slice(0,4);}catch{return [];}})();
 const stat=fs.statSync(binary),header=stat.size<16384?fs.readFileSync(binary,'utf8'):'';out.launcherScript=header.startsWith('#!');out.launcherUsesHome=out.launcherScript&&header.includes('HOME');out.launcherResolved=fs.realpathSync(binary).replace(home,'<home>');
 const version=cp.spawnSync(binary,['--version'],{env,encoding:'utf8',timeout:5000});out.privateVersionCode=version.status;out.privateVersionMissing=/not found|ENOENT/i.test(version.stderr||'');

 const args=['acp','--app-data-dir',profile,'--agent','xin-front-controller','--log-file','/dev/null'];if(out.settingsFlag)args.push('--settings',JSON.stringify(settings));
 child=cp.spawn(binary,args,{cwd:work,env,stdio:['pipe','pipe','pipe']});child.stderr.on('data',s=>{stderr=(stderr+s).slice(-8000);});child.stdout.setEncoding('utf8');let buffer='';
 child.stdout.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){let q;try{q=JSON.parse(buffer.slice(0,n));}catch{buffer=buffer.slice(n+1);continue;}buffer=buffer.slice(n+1);
  if(q.method){if(Object.hasOwn(q,'id'))child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:q.id,...(q.method==='session/request_permission'?{result:{outcome:{outcome:'cancelled'}}}:{error:{code:-32601,message:'No file or terminal capability'}})})+'\n');else if(q.method==='session/update'&&q.params?.update?.sessionUpdate==='agent_message_chunk')text+=q.params.update.content?.text||'';continue;}
  const p=pending.get(q.id);if(p){clearTimeout(p.timer);pending.delete(q.id);q.error?p.reject(Error('native_rpc_error')):p.resolve(q.result||{});}
 }});
 child.on('close',(code,signal)=>{out.nativeExit=code;out.nativeSignal=signal;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('native_closed'));}pending.clear();});child.on('error',()=>{});child.stdin.on('error',()=>{});
 const init=await rpc('initialize',{protocolVersion:1,clientInfo:{name:'xin-profile-preflight',version:'1'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});out.imageCapability=init.agentCapabilities?.promptCapabilities?.image===true;out.loadSession=init.agentCapabilities?.loadSession===true;
 const session=await rpc('session/new',{cwd:work,mcpServers:[]});sid=session.sessionId;out.uuidSession=/^[a-f0-9-]{36}$/i.test(sid||'');
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
 end();
 const synthetic='HOME-'+crypto.randomBytes(6).toString('hex'),schema={type:'object',properties:{text:{type:'string'},calls:{type:'array',maxItems:0,items:{type:'object'}}},required:['text','calls'],additionalProperties:false};
 const cli=cp.spawnSync(binary,['-p','只返回 JSON，text 照写 '+synthetic+'，calls 为空。','--agent','xin-front-controller','--model','gemini-3.8-flash-high','--settings',JSON.stringify(settings),'--json-schema',JSON.stringify(schema),'--output-format','stream-json','--disable-slash-commands','--print-timeout','45s','--new-project'],{cwd:work,env,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
 const rows=String(cli.stdout||'').split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}}),result=rows.findLast(r=>r.event==='result')?.result,actual=rows.find(r=>r.event==='init')?.init?.model;
 out.headlessActual=actual||null;out.headlessAnswer=cli.status===0&&JSON.stringify(result?.structured_output||result?.response||'').includes(synthetic);
 const id=result?.conversation_id;out.headlessOwnedSession=typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id)&&fs.existsSync(path.join(profile,'conversations',id+'.db'));
 out.headlessSessionInDefault=typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id)&&fs.existsSync(path.join(home,'.gemini/antigravity-cli/conversations',id+'.db'));
 out.authReferencePreserved=fs.lstatSync(path.join(profile,'antigravity-oauth-token')).isSymbolicLink();

 }catch(e){out.error=['rpc_timeout','native_rpc_error','native_closed'].includes(e.message)?e.message:'preflight_unavailable';}
 finally{end();out.stderrBytes=Buffer.byteLength(stderr);out.errorKinds=Object.entries({missing:/not found|ENOENT|No such file/i,permission:/EACCES|permission denied/i,auth:/auth|login|credential|sign.in/i,agent:/agent/i,config:/settings|config|yaml|json/i,unknownOption:/unknown option|unrecognized.*argument|unexpected.*argument/i,runtime:/module|shared librar|bun|node|panic|unhandled/i}).filter(([,re])=>re.test(stderr)).map(([name])=>name);out.errorOptions=[...stderr.matchAll(/--[a-z][a-z-]{1,60}/g)].map(x=>x[0]).filter((x,i,a)=>a.indexOf(x)===i).slice(-12);process.stdout.write(JSON.stringify(out));setTimeout(()=>process.exit(0),1000).unref();}
})().catch(()=>{end();process.stdout.write(JSON.stringify({error:'preflight_unavailable'}));});
