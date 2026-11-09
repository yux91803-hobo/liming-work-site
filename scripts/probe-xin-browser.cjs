// Exercise only an owned synthetic task, a public page and disposable browser profiles.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),{pathToFileURL}=require('node:url');
const owned=path.join('/data/home/.xin/diagnostic','browser-'+crypto.randomBytes(8).toString('hex'));
for(const dir of ['control','projects/probe','tmp'])fs.mkdirSync(path.join(owned,dir),{recursive:true,mode:0o700});
process.env.XIN_HOME=path.join(owned,'control');process.env.XIN_WORK=path.join(owned,'projects');process.env.TMPDIR=path.join(owned,'tmp');
const out={},phase=name=>{out.phase=name;process.stdout.write(JSON.stringify({phase:name})+'\n');};let service,network,b,task,direct;
const limit=setTimeout(()=>{out.error='preflight_deadline';finish();},215000);let finishing=false;
async function finish(){if(finishing)return;finishing=true;clearTimeout(limit);try{await direct?.close();network?.close();await service?.close();}catch{}process.stdout.write(JSON.stringify(out)+'\n');setTimeout(()=>process.exit(out.error?1:0),1000);}
const classify=e=>Object.entries({timeout:/timeout|超时/i,python:/python|playwright|运行环境|依赖/i,sandbox:/sandbox|bwrap|namespace|permission|sudo|operation not permitted/i,display:/display|x11|xserver/i,ssl:/ssl|certificate/i,network:/net::|connection|连接|proxy/i,closed:/closed|已停止|恢复/i,missing:/not found|ENOENT|不存在/i}).filter(([,re])=>re.test(String(e?.message||e))).map(([kind])=>kind);
(async()=>{try{
 const browser=await import(pathToFileURL(process.argv[1]).href),runtime=await import(pathToFileURL(process.argv[2]).href);
 b=await import(pathToFileURL(process.argv[3]).href);task={sid:'sdiag'+crypto.randomBytes(6).toString('hex'),agent:'codex',kind:'task',status:'running',title:'合成公开浏览验证',dir:path.join(owned,'projects/probe'),runs:[]};
 task.workspace=runtime.prepareWorkspace(task,b.BASE);b.writeJ(path.join(b.BASE,'sessions',task.sid+'.json'),task);
 phase('python-private-home');const python=await browser.browserPython();out.privatePython=python==='python3'||python.startsWith(path.join(b.BASE,'browser/runtime/'));
 out.pythonVenv=python!=='python3';
 phase('direct-headful-sandbox-launch');const {BrowserDriver}=await import(pathToFileURL(process.argv[4]).href);let driverStderr='';
 direct=new BrowserDriver({root:path.join(owned,'direct'),python,chromium:'/usr/lib/chromium/chromium',proxy:'http://127.0.0.1:9',display:':1'});direct.child.stderr.on('data',s=>{driverStderr=(driverStderr+s).slice(-12000);});
 try{await direct.ready;const view=await direct.call({op:'open',id:'launch',url:'data:text/html,<title>Owned browser verification</title><p>synthetic page</p>',mode:'public',profile:path.join(owned,'direct/profile'),headful:true,allowed:[]});out.directHeadful=view.headful===true;}
 catch(e){out.driverErrorKinds=classify(String(e.message)+' '+driverStderr);out.driverExit=direct.child.exitCode;out.driverModuleMissing=/No module named/.test(driverStderr);out.driverNoSandbox=/No usable sandbox|namespace.*(?:not permitted|denied)|SUID sandbox/i.test(String(e.message)+' '+driverStderr);out.driverX11=/Missing X server|cannot open display|X11.*failed/i.test(String(e.message)+' '+driverStderr);throw e;}
 await direct.close();direct=null;
 const start=()=>browser.serveBrowser({egressFactory:runtime.egressProxy,resolveTask:sid=>sid===task.sid?task:null});
 service=await start();network=await runtime.taskNetwork(task.workspace,null,dir=>browser.attachTaskBrowser('unused',task,dir));
 async function boxed(command,args){
  const spec=runtime.containerCommand(task,command,args,{},[],network.network);out.realTaskSandbox=spec.command==='/usr/bin/sudo'&&spec.args.includes('--unshare-net')&&spec.args.includes('--no-new-privs');
  return new Promise((resolve,reject)=>{const child=cp.spawn(spec.command,spec.args,{detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH||'/usr/bin:/bin'}}),identity=b.processIdentity(child.pid);let stdout='',stderr='';
   const timer=setTimeout(()=>{b.signalProcessGroup(child.pid,identity,'SIGKILL');reject(Error('boxed_timeout'));},55000);
   child.stdout.on('data',s=>{stdout+=s;if(stdout.length>1024*1024)b.signalProcessGroup(child.pid,identity,'SIGKILL');});child.stderr.on('data',s=>{stderr=(stderr+s).slice(-12000);});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code!==0){out.boxExit=code;out.boxErrorKinds=classify(stdout+' '+stderr);try{const r=JSON.parse(stdout),e=r.error;out.syntheticBrokerCause=r.cause;out.syntheticBrokerKind=r.kind;if(typeof e==='string')out.syntheticBrokerError=e.replace(/https?:\/\/\S+/g,'<url>').replaceAll(owned,'<owned>').slice(0,240);}catch{}reject(Error('sandbox_command_failed'));return;}try{resolve(JSON.parse(stdout.trim()));}catch{reject(Error('sandbox_receipt_invalid'));}});
  });
 }
 const cli=args=>boxed(process.execPath,[path.join(task.workspace.home,'bin/xin'),'browser',...args]);
 phase('sandbox-isolation');const privateFile=path.join(b.BASE,'controller-private-check');fs.writeFileSync(privateFile,'synthetic owner-only marker');
 const checks=await boxed(process.execPath,['-e',`const fs=require('node:fs'),net=require('node:net');const q={privateHidden:!fs.existsSync(${JSON.stringify(privateFile)}),ownerLoginHidden:!fs.existsSync('/data/home/.gemini/antigravity-cli/antigravity-oauth-token'),x11Hidden:!fs.existsSync('/tmp/.X11-unix'),namespace:fs.readlinkSync('/proc/self/ns/net'),noNewPrivs:/NoNewPrivs:\\s+1/.test(fs.readFileSync('/proc/self/status','utf8'))};const s=net.connect({host:'127.0.0.1',port:6080});s.setTimeout(500);const done=blocked=>{s.destroy();console.log(JSON.stringify({...q,vncBlocked:blocked}));};s.once('connect',()=>done(false));s.once('error',()=>done(true));s.once('timeout',()=>done(true));`]);
 out.isolated=checks.privateHidden&&checks.ownerLoginHidden&&checks.x11Hidden&&checks.noNewPrivs&&checks.vncBlocked&&checks.namespace!==fs.readlinkSync('/proc/self/ns/net');
 phase('public-browser-through-task-proxy');const opened=await cli(['open','https://example.org/']);out.publicPage=/Example Domain/i.test(opened.title||'')&&opened.url==='https://example.org/';
 const page=opened.page;if(!page)throw Error('public_page_missing');out.headful=service.control.runtime(page)?.headful===true;
 phase('masked-screenshot-image-queue');const shot=await cli(['screenshot',page]),images=network.takeBrowserImages();out.maskedImage=shot.masked===true&&images.length===1&&images[0].mimeType==='image/jpeg'&&Buffer.from(images[0].data,'base64')[0]===255;out.imageDrainedOnce=network.takeBrowserImages().length===0;
 phase('owner-pause');await service.control.pause(true);const paused=await cli(['snapshot',page]);out.ownerPause=paused.paused===true;await service.control.pause(false);
 phase('owned-service-restart');await service.close();service=null;service=await start();const recovered=await cli(['snapshot',page,'--full']);out.recoveredURL=recovered.page===page&&recovered.url==='https://example.org/'&&/Example Domain/i.test(recovered.title||'')&&recovered.snapshot!==opened.snapshot;
 out.recoveredHeadful=service.control.runtime(page)?.headful===true;
 out.noOwnerLogin=true;
 if(!['privatePython','realTaskSandbox','isolated','publicPage','headful','maskedImage','imageDrainedOnce','ownerPause','recoveredURL','recoveredHeadful'].every(k=>out[k]===true))out.error='browser_proof_incomplete';
 }catch(e){out.error=out.error||'browser_preflight_failed';out.errorKinds=classify(e);out.errorCode=typeof e.code==='string'&&/^[A-Z0-9_]+$/.test(e.code)?e.code:null;}
 finally{await finish();}
})().catch(()=>{out.error='browser_preflight_failed';finish();});
