// Private local daemon and per-turn Unix-socket proxy. No browser debugging port is exposed.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {BASE,readJ,processIdentity,alive,okId} from './vm-base.mjs';
import {screenDisplay} from './vm-screen.mjs';
import {BrowserControl} from './vm-browser-control.mjs';
import {BrowserDriver} from './vm-browser-driver.mjs';

const root=()=>path.join(BASE,'browser'),infoFile=()=>path.join(root(),'service.json');
const matches=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const socketListen=(server,socket)=>new Promise((resolve,reject)=>{try{fs.unlinkSync(socket);}catch{}server.once('error',reject);server.listen(socket,()=>{fs.chmodSync(socket,0o600);resolve();});});
function requestSocket(info,body,ms=180000){return new Promise((resolve,reject)=>{
 const req=http.request({socketPath:info.socket,method:'POST',path:'/',headers:{authorization:'Bearer '+info.token,'content-type':'application/json'}},res=>{
  let body='',bytes=0;res.setEncoding('utf8');res.on('data',s=>{bytes+=Buffer.byteLength(s);if(bytes>4*1024*1024){req.destroy(Error('浏览器回执过大'));return;}body+=s;});
  res.on('end',()=>{try{const r=JSON.parse(body);r.error?reject(Error(r.error)):resolve(r);}catch(e){reject(e);}});
 });req.setTimeout(ms,()=>req.destroy(Error('浏览器控制器暂时没有回应，请先查看状态')));req.on('error',reject);req.end(JSON.stringify(body));
});}
export async function browserOwner(self,op,args={},options={}){
 let info=readJ(infoFile());if(!info||!alive(info.pid,info.identity)){
  if(options.start===false)return {inactive:true};
  fs.mkdirSync(root(),{recursive:true,mode:0o700});const lock=path.join(root(),'starting');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;try{if(Date.now()-fs.statSync(lock).mtimeMs>30000)fs.unlinkSync(lock);}catch{}}
  if(fd!==undefined){
   fs.closeSync(fd);const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!['XIN_RUN','XIN_LOCK'].includes(k)));
   const child=spawn(process.execPath,[self,'browser-daemon'],{detached:true,stdio:'ignore',env});child.on('error',()=>{});child.unref();
  }
  for(let i=0;i<150;i++){info=readJ(infoFile());if(info&&alive(info.pid,info.identity))break;await pause(100);}
  if(!info||!alive(info.pid,info.identity))throw Error('浏览器控制器未能启动');
 }
 return requestSocket(info,{op,args});
}
export function browserOwnerSync(self,op,args={},options={start:op!=='pause'}){
 const r=spawnSync(process.execPath,[self,'browser-rpc'],{input:JSON.stringify({op,args,options}),encoding:'utf8',timeout:Math.min(190000,Number(options.timeout)||190000),maxBuffer:4*1024*1024,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!['XIN_RUN','XIN_LOCK'].includes(k)))});
 try{if(r.status!==0)throw Error();return JSON.parse(r.stdout);}catch{return {error:'browser_unavailable',msg:'浏览器控制器暂时没有回应，请重试或打开屏幕查看'};}
}
async function run(command,args,ms=150000,env){return new Promise((resolve,reject)=>{
 const child=spawn(command,args,{stdio:'ignore',...(env?{env}:{})}),timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('浏览器依赖准备超时'));},ms);timer.unref();
 child.on('error',()=>{clearTimeout(timer);reject(Error('浏览器运行环境不可用'));});child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('浏览器运行环境尚未准备好'));});
});}
export async function browserPython(){
 // Match the driver's private HOME: a package installed only for the controller user disappears there.
 const env={PATH:process.env.PATH||'/usr/bin:/bin',HOME:root(),LANG:'C.UTF-8'};
 const custom=process.env.XIN_BROWSER_PYTHON;if(custom){await run(custom,['-c','import playwright.async_api'],10000,env);return custom;}
 const probe=spawnSync('python3',['-c','import playwright.async_api'],{stdio:'ignore',timeout:10000,env});if(probe.status===0)return 'python3';
 const home=path.join(root(),'runtime'),python=path.join(home,'bin','python');
 if(!fs.existsSync(python))await run('python3',['-m','venv',home],30000);
 await run(python,['-m','pip','install','--disable-pip-version-check','playwright==1.64.1']);return python;
}
export async function serveBrowser({egressFactory,driverFactory,resolveTask,notifyResume}={}){
 fs.mkdirSync(root(),{recursive:true,mode:0o700});const socket=path.join(root(),'service.sock'),token=crypto.randomBytes(32).toString('hex');
 const network=await egressFactory({socketPath:path.join(root(),'egress.sock')}),peers=new Set();
 const bridge=net.createServer(client=>{peers.add(client);const upstream=net.connect(network.socket);peers.add(upstream);client.pipe(upstream);upstream.pipe(client);for(const s of [client,upstream]){s.on('error',()=>s.destroy());s.on('close',()=>peers.delete(s));}});
 await new Promise((resolve,reject)=>{bridge.once('error',reject);bridge.listen(0,'127.0.0.1',resolve);});
 const displayReady=()=>fs.existsSync('/tmp/.X11-unix/X'+screenDisplay().replace(/^:/,'').split('.')[0]);
 let actual=null,boot=null,control;
 const ensure=async()=>{
  if(actual&&!actual.closed)return actual;if(boot)return boot;
  boot=(async()=>{const chromium=[process.env.XIN_CHROMIUM,'/usr/lib/chromium/chromium','/usr/bin/chromium'].find(p=>p&&fs.existsSync(p));if(!chromium)throw Error('电脑尚未安装 Chromium');
   const python=await browserPython();actual=driverFactory?await driverFactory():new BrowserDriver({root:root(),python,chromium,proxy:'http://127.0.0.1:'+bridge.address().port,display:screenDisplay()});await actual.ready;control?.live.clear();return actual;
  })();try{return await boot;}finally{boot=null;}
 };
 const facade={get ready(){return ensure();},async call(q){const d=await ensure();if(q.op==='headful')await d.call({op:'display',display:screenDisplay()});return d.call(q);}};
 control=new BrowserControl({driver:facade,resolveTask,displayReady});let chain=Promise.resolve();
 const dispatch=async({op,args:a={}})=>{
  if(op==='state')return {...await control.state(),preparing:!!boot};
  if(op==='register')return {token:control.register(a.sid)};
  if(op==='request'){const t=control.task(a.sid);if(t.status!=='running')return {paused:true,reason:'工作已暂停或结束'};return control.request(a.sid,a.token,a.request);}
  if(op==='site'){if(typeof a.allowed!=='boolean')throw Error('网站设置不完整');return control.site(a.origin,a.allowed);}
  if(['allow','takeover'].includes(op)&&!actual){
   if(op==='allow'){const w=control.waiting(a.sid);if(!w||w.id!==a.id)throw Error('登录请求已变化，请重新查看');}else control.a.page(a.sid,a.page);
   ensure().catch(()=>{});return {preparing:true,task:a.sid,page:a.page,id:a.id};
  }
  if(op==='allow')return control.allowWait(a.sid,a.id);
  if(op==='takeover')return control.takeover(a.sid,a.page);
  if(op==='release')return control.release(a.sid,a.page,a.clientId);
  if(op==='decide')return control.decide(a.sid,a.id,a);
  if(op==='pause')return control.pause(a.paused===true,a.clientId);
  if(op==='purge'){if(control.a.paused()&&control.db().prepare('SELECT 1 FROM browser_pages WHERE task=?').get(a.sid))throw Error('站长正在接管，此刻不清理浏览器记录');return control.revoke(a.sid);}
  if(op==='revoke')return control.revoke(a.sid);
  if(op==='retire'){
   try{control.a.authorize(a.sid,a.token);control.a.db().prepare('UPDATE browser_tasks SET revoked=1 WHERE sid=?').run(a.sid);}catch{}
   return {ok:true};
  }
  throw Error('未知的浏览器控制请求');
 };
 let flushing=false;
 const flush=async()=>{if(flushing||!notifyResume)return;flushing=true;try{for(const job of control.resumes()){const r=await notifyResume(job);if(r&&!r.error)control.resumed(job.id);}}finally{flushing=false;}};
 const resumeTimer=setInterval(()=>flush().catch(()=>{}),5000);resumeTimer.unref();
 const server=http.createServer(async(req,res)=>{
  const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
  if(req.method!=='POST'||req.url!=='/'||!matches(req.headers.authorization,'Bearer '+token))return reply(403,{error:'浏览器控制凭证不对'});
  try{
   let bytes=0,body='';for await(const c of req){bytes+=c.length;if(bytes>65536)return reply(413,{error:'浏览器请求过大'});body+=c;}
   const q=JSON.parse(body);
   // Observing state never queues behind a slow page. Pause closes the admission gate immediately,
   // then waits for the previously admitted operation before returning control to the owner.
   if(q.op==='state')return reply(200,await dispatch(q));
   if(q.op==='pause'&&q.args?.paused===true)await control.pause(true);
   const next=chain.then(()=>dispatch(q));chain=next.catch(()=>{});reply(200,await next);setTimeout(()=>flush().catch(()=>{}),0).unref();
  }catch(e){reply(400,{error:e.message||'浏览器请求没有完成'});}
 });
 server.requestTimeout=190000;server.headersTimeout=10000;await socketListen(server,socket);
 const info={pid:process.pid,identity:processIdentity(process.pid),socket,token};const file=infoFile(),tmp=file+'.'+process.pid;
 fs.writeFileSync(tmp,JSON.stringify(info),{mode:0o600});fs.renameSync(tmp,file);try{fs.unlinkSync(path.join(root(),'starting'));}catch{}
 flush().catch(()=>{});
 const close=async()=>{clearInterval(resumeTimer);server.close();for(const s of peers)s.destroy();bridge.close();network.close();await actual?.close();try{if(readJ(file)?.pid===process.pid)fs.unlinkSync(file);}catch{}};
 return {server,control,close};
}

export const BROWSER_CLI=String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const a=process.argv.slice(2),op=a.shift(),q={op};
const take=flag=>{const i=a.indexOf(flag);if(i<0)return null;const x=a[i+1];a.splice(i,2);return x;};
if(!op||op==='help'){console.log('浏览器：open 网址 [--login]；list；snapshot 页面 [--full]；screenshot 页面；click/fill/select/press/scroll/back/download 页面 快照 元素 [输入值] --key 本步骤唯一标识 [--category 类别]。只用当前快照中的元素；waiting 时立即结束本轮等站长，不重复操作。');process.exit(0);}
q.key=take('--key');q.category=take('--category');const full=a.indexOf('--full');if(full>=0){q.full=true;a.splice(full,1);}const login=a.indexOf('--login');if(login>=0){q.login=true;a.splice(login,1);}
if(op==='open')q.url=a[0];else if(op!=='list'){
 q.page=a.shift();if(!['snapshot','screenshot','close'].includes(op)){q.op='action';q.action=op;q.snapshot=a.shift();if(!['scroll','back'].includes(op))q.element=a.shift();if(a.length)q.value=a.join(' ');}
}
let cfg;try{cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'browser.json'),'utf8'));}catch{console.error('本轮浏览器入口尚未准备好，请汇报此情况');process.exit(1);}
const req=http.request({socketPath:cfg.socket,method:'POST',path:'/',headers:{authorization:'Bearer '+cfg.token,'content-type':'application/json'}},res=>{let s='';res.setEncoding('utf8');res.on('data',x=>{s+=x;if(s.length>3*1024*1024)req.destroy();});res.on('end',()=>{console.log(s);if(res.statusCode>=400)process.exitCode=1;});});
req.setTimeout(180000,()=>req.destroy(Error('浏览器尚未回应，请保留原 key 查看状态，不重复有后果的操作')));req.on('error',()=>{console.error('浏览器连接未完成；先看状态，有后果的步骤不要换 key 重做');process.exitCode=1;});req.end(JSON.stringify(q));
`;
// Read exactly the controller's masked capture before the writable task copy can be substituted.
export function browserModelImage(t,result){
 if(!result?.masked||result.type!=='image/jpeg')return null;
 const io=path.join(process.env.TMPDIR||'/tmp','xin-task-'+t.sid,'io'),name=path.basename(String(result.file||''));
 if(!okId(t.sid,'s')||path.resolve(t.workspace?.io||'')!==path.resolve(io)||result.file!==path.join(io,name)||!/^browser-shot-[a-f0-9]{20}\.jpg$/.test(name)||!/^[a-f0-9]{64}$/.test(result.imageDigest||''))throw Error('截图归属不正确，未发送给模型');
 let dir,file;
 try{
  const C=fs.constants;dir=fs.openSync(io,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);file=fs.openSync('/proc/self/fd/'+dir+'/'+name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  const st=fs.fstatSync(file);if(!st.isFile()||st.size!==result.imageBytes||st.size>2*1024*1024)throw Error('截图副本无效或过大，未发送给模型');
  const bytes=fs.readFileSync(file);if(crypto.createHash('sha256').update(bytes).digest('hex')!==result.imageDigest)throw Error('截图副本已变化，请重新截图');
  return {type:'image',mimeType:'image/jpeg',data:bytes.toString('base64')};
 }finally{if(file!==undefined)fs.closeSync(file);if(dir!==undefined)fs.closeSync(dir);}
}
export async function attachTaskBrowser(self,t,dir,onWait=()=>{}){
 if(!okId(t.sid,'s')||!t.workspace)throw Error('浏览器入口缺少工作编号');
 const token=crypto.randomBytes(32).toString('hex'),socket=path.join(dir,'browser.sock'),images=[];let capability=null,closed=false;
 const server=http.createServer(async(req,res)=>{
  const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
  if(closed||req.method!=='POST'||req.url!=='/'||!matches(req.headers.authorization,'Bearer '+token))return reply(403,{error:'这份浏览器入口不属于本轮工作'});
  try{let body='',bytes=0;for await(const c of req){bytes+=c.length;if(bytes>32768)return reply(413,{error:'浏览器请求过大'});body+=c;}
   const request=JSON.parse(body);if(!capability)capability=(await browserOwner(self,'register',{sid:t.sid})).token;
   const r=await browserOwner(self,'request',{sid:t.sid,token:capability,request});
   if(request.op==='screenshot'||request.op==='action'&&request.action==='screenshot'){const image=browserModelImage(t,r.result||r);if(image)images.push(image);}
   reply(200,r);if(r.waiting)onWait(r);
  }catch(e){reply(400,{error:e.message||'浏览器操作没有完成'});}
 });
 server.requestTimeout=185000;await socketListen(server,socket);
 fs.writeFileSync(path.join(dir,'browser.json'),JSON.stringify({socket,token}),{mode:0o600});fs.writeFileSync(path.join(dir,'browser-cli.cjs'),BROWSER_CLI,{mode:0o600});
 return {socket,takeImages(){return images.splice(0);},close(){closed=true;images.length=0;server.closeAllConnections();server.close();if(capability)browserOwner(self,'retire',{sid:t.sid,token:capability},{start:false}).catch(()=>{});}};
}
