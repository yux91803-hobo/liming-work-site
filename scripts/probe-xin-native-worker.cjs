// Exercise the production NativeWorker adapter with pixels containing an unknown synthetic value.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),{pathToFileURL}=require('node:url');
const root=path.join('/data/home/.xin/diagnostic','native-worker-'+crypto.randomBytes(8).toString('hex'));
fs.mkdirSync(root,{recursive:true,mode:0o700});process.env.XIN_HOME=path.join(root,'control');
const out={},phase=name=>{out.phase=name;process.stdout.write(JSON.stringify({phase:name})+'\n');};let client,finishing=false;
const deadline=setTimeout(()=>{out.error='native_worker_deadline';finish();},105000);
function finish(){if(finishing)return;finishing=true;clearTimeout(deadline);client?.close();process.stdout.write(JSON.stringify(out)+'\n');setTimeout(()=>process.exit(out.error?1:0),1000);}
(async()=>{try{
 const worker=await import(pathToFileURL(process.argv[1]).href),profiles=await import(pathToFileURL(process.argv[2]).href),b=await import(pathToFileURL(process.argv[3]).href),runtime=await import(pathToFileURL(process.argv[4]).href);
 const sid='sdiag'+crypto.randomBytes(6).toString('hex'),run='rdiag'+crypto.randomBytes(6).toString('hex');b.writeJ(path.join(b.BASE,'sessions',sid+'.json'),{sid,agent:'codex',kind:'task',status:'running',runs:[run]});b.writeJ(path.join(b.BASE,'runs',run+'.json'),{sid,run,started:Date.now()});
 const p=profiles.ensureNativeProfile({sid,kind:'worker',loginHome:'/data/home'}),agent=path.join(p.agents,'xin-confined-worker');fs.mkdirSync(agent,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(agent,'agent.md'),'---\nname: xin-confined-worker\ndescription: Xiaoxin controlled background worker.\nmainAgent: true\nsubagent: false\ntools:\n  - search_web\n  - read_url_content\n  - finish\n---\nReturn structured actions to the external controller. File and shell operations are unavailable as native tools. Never delegate or schedule.\n',{mode:0o600});
 const binary=runtime.antigravityBinary('/data/home');if(!binary)throw Error('native_missing');
 const visual='PIXEL-'+crypto.randomBytes(5).toString('hex').toUpperCase(),image=path.join(root,'pixels.png'),chrome=['/usr/lib/chromium/chromium','/usr/bin/chromium'].find(f=>fs.existsSync(f));if(!chrome)throw Error('capture_missing');
 phase('synthetic-pixels');const html='<html><body style="margin:0;background:white"><div style="padding:24px;font:bold 80px monospace;color:black">'+visual+'</div></body></html>';
 const capture=cp.spawnSync(chrome,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--hide-scrollbars','--no-first-run','--user-data-dir='+path.join(root,'capture'),'--window-size=1100,200','--virtual-time-budget=500','--screenshot='+image,'data:text/html,'+encodeURIComponent(html)],{stdio:'ignore',timeout:15000,killSignal:'SIGKILL'});if(capture.status!==0||!fs.existsSync(image))throw Error('capture_failed');
 const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),65000);let id='';
 try{
  phase('production-worker-adapter');client=await worker.openNativeWorker({binary,profile:p,signal:stop.signal,model:runtime.AGY_MODEL,settings:runtime.AGY_SETTINGS,record:(value,chosen)=>{id=value;profiles.recordNativeSession({sid,run,id});out.actualModel=chosen.model;out.providerModel=chosen.providerModel;}});
  const a=await client.propose('这是控制器合成看图验收。只读图片里唯一一行字符，逐字抄入 text。不要工具、不要查询或记忆。必须作为助手文字输出严格 JSON：{"action":"final","command":"","text":"图片原文"}。不要代码围栏。',worker.nativeWorkerImages([image]),()=>false);
  out.pixelAnswerMatches=a.action==='final'&&a.command===''&&a.text.includes(visual);
  out.privateSession=/^[a-f0-9-]{36}$/i.test(id)&&fs.existsSync(path.join(p.app,'conversations',id+'.db'));
  out.noGlobalSession=!fs.existsSync(path.join('/data/home/.gemini/antigravity-cli/conversations',id+'.db'));
  out.authReferencePreserved=fs.lstatSync(path.join(p.app,'antigravity-oauth-token')).isSymbolicLink();
  out.nativeOwnerRecord=b.journal.db.prepare('SELECT count(*) n FROM native_profile_sessions WHERE sid=? AND run=?').get(sid,run).n===1;
  if(out.actualModel!==runtime.AGY_MODEL||!['pixelAnswerMatches','privateSession','noGlobalSession','authReferencePreserved','nativeOwnerRecord'].every(k=>out[k]===true))out.error='native_worker_proof_incomplete';
 }finally{clearTimeout(timer);client?.close();client=null;}
 }catch(e){out.error=out.error||'native_worker_preflight_failed';out.errorKinds=Object.entries({timeout:/timeout|超时|abort/i,model:/model|型号|High/i,format:/JSON|动作|格式/i,auth:/auth|credential|登录/i,missing:/missing|not found|ENOENT/i,permission:/permission|denied/i}).filter(([,re])=>re.test(String(e.message))).map(([name])=>name);out.errorCode=typeof e.code==='string'&&/^[A-Z0-9_]+$/.test(e.code)?e.code:null;}
 finally{finish();}
})().catch(()=>{out.error='native_worker_preflight_failed';finish();});
