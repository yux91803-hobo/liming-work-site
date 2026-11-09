// The only browser API visible to a background task. Page facts always come from the private driver.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {BASE,journal,okId,readJ} from './vm-base.mjs';
import {BrowserAuthority,browserURL,browserRisk,BROWSER_CATEGORIES} from './vm-browser-policy.mjs';

const sha=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const normalTask=s=>s?.agent==='codex'&&s.kind==='task';
export function browserSafeURL(value){
 const u=browserURL(value);for(const k of [...u.searchParams.keys()])if(/password|passwd|secret|token|api.?key|^code$|authorization/i.test(k))u.searchParams.set(k,'[已隐藏]');if(/(?:password|secret|token|api.?key|authorization|code)=/i.test(u.hash))u.hash='';return u.href;
}
const cleanNode=n=>({...n,...(n.href?{href:(()=>{try{return browserSafeURL(n.href);}catch{return '';}})()}:{}),...(n.formAction?{formAction:(()=>{try{return browserSafeURL(n.formAction);}catch{return '';}})()}:{})});
export class BrowserControl {
 constructor({driver,root=path.join(BASE,'browser'),authority=new BrowserAuthority(),resolveTask=sid=>readJ(path.join(BASE,'sessions',sid+'.json')),displayReady=()=>false}={}){
  this.driver=driver;this.root=root;this.a=authority;this.resolveTask=resolveTask;this.displayReady=displayReady;
  fs.mkdirSync(path.join(root,'cards'),{recursive:true,mode:0o700});this.live=new Set();
 }
 db(){const d=this.a.db();d.exec(`CREATE TABLE IF NOT EXISTS browser_runtime(page TEXT PRIMARY KEY,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS browser_cards(id TEXT PRIMARY KEY,task TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS browser_waits(task TEXT PRIMARY KEY,id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS browser_owner_receipts(id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS browser_resumes(id TEXT PRIMARY KEY,task TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending');`);return d;}
 receipt(id,body){const r=this.db().prepare('SELECT * FROM browser_owner_receipts WHERE id=?').get(id);if(!r)return null;if(r.digest!==sha(body))throw Error('同一份确认不能改成另一个决定');return {...JSON.parse(r.result),replayed:true};}
 saveReceipt(id,body,result){this.db().prepare('INSERT INTO browser_owner_receipts VALUES(?,?,?)').run(id,sha(body),JSON.stringify(result));return result;}
 resume(id,task,text){this.db().prepare('INSERT OR IGNORE INTO browser_resumes(id,task,text) VALUES(?,?,?)').run('browser-'+sha(id).slice(0,40),task,text);}
 resumes(){return this.db().prepare("SELECT id,task,text FROM browser_resumes WHERE state='pending' LIMIT 10").all();}
 resumed(id){this.db().prepare("UPDATE browser_resumes SET state='done' WHERE id=?").run(id);}
 task(sid){const t=this.resolveTask(sid);if(!okId(sid,'s')||!normalTask(t))throw Error('浏览器只供默认模式的后台工作使用');return t;}
 register(sid){const t=this.task(sid);if(t.status!=='running')throw Error('工作尚未开始，不能申请浏览器凭证');return this.a.issue(sid);}
 runtime(id){try{return JSON.parse(this.db().prepare('SELECT body FROM browser_runtime WHERE page=?').get(id)?.body||'null');}catch{return null;}}
 async call(q){await this.driver.ready;return this.driver.call(q);}
 wait(task,kind,body){
  const id=sha({task,kind,body}).slice(0,32);journal.atomic(()=>this.db().prepare('INSERT INTO browser_waits VALUES(?,?,?,?,?) ON CONFLICT(task) DO UPDATE SET id=excluded.id,kind=excluded.kind,body=excluded.body,at=excluded.at').run(task,id,kind,JSON.stringify(body),Date.now()));
  return {waiting:true,id,kind,...body};
 }
 waiting(task){const r=this.db().prepare('SELECT * FROM browser_waits WHERE task=?').get(task);return r?{id:r.id,kind:r.kind,...JSON.parse(r.body)}:null;}
 clearWait(task){journal.atomic(()=>this.db().prepare('DELETE FROM browser_waits WHERE task=?').run(task));}
 async picture(page){const image=await this.call({op:'screenshot',id:page,format:'jpeg'});return Buffer.from(image.image,'base64');}
 async waitPage(task,kind,body){
  const wait=this.wait(task,kind,body);if(body.page&&!this.a.paused()){
   try{const image=await this.picture(body.page);if(image.length<800000){fs.writeFileSync(path.join(this.root,'cards',wait.id+'.jpg'),image,{mode:0o600});journal.atomic(()=>this.db().prepare('INSERT OR REPLACE INTO browser_cards VALUES(?,?)').run(wait.id,task));}}catch{ /* An unavailable screenshot is explicit, never substituted with another page. */ }
  }return wait;
 }
 async startPage(task,page,url){
  const profile=path.join(this.root,page.mode==='login'?'login':'public',page.mode==='login'?sha(page.origin).slice(0,24):page.id);
  const data=await this.call({op:'open',id:page.id,url,mode:page.mode,profile,allowed:this.a.sites(),headful:this.displayReady()});this.live.add(page.id);return data;
 }
 async pageData(task,id){
  const p=this.a.page(task,id);if(!this.live.has(id))return this.startPage(task,p,p.url);
  return this.call({op:'snapshot',id});
 }
 async record(task,id,data,{full=false}={}){
  if(this.a.paused())return {paused:true,reason:'站长正在接管，停止读取页面'};
  let p=this.a.page(task,id);const old=this.runtime(id);
  if(data.blockedOrigin)return this.waitPage(task,'whitelist',{page:id,origin:data.blockedOrigin,url:data.blockedOrigin,reason:'登录浏览器的跨站跳转需要先允许这个网站'});
  const url=browserSafeURL(data.url);
  if(url!==p.url||old&&old.navigation!==data.navigation){const nav=this.a.navigate(task,id,url);if(nav.needsWhitelist)return this.waitPage(task,'whitelist',{page:id,origin:nav.origin,url,reason:'登录站点需要单独允许'});p=this.a.page(task,id);}
  const nodes=(data.nodes||[]).map(cleanNode),snapshot=this.a.snapshot(task,id,nodes,{...data.facts,session:sha(data.facts)});
  const info={navigation:data.navigation,nodes:Object.fromEntries((data.nodes||[]).map(n=>[n.id,sha(Object.fromEntries(Object.entries(n).filter(([k])=>k!=='id')))])),facts:sha(data.facts),headful:!!data.headful,title:String(data.title||'').slice(0,300),text:sha(String(data.text||'').slice(0,14000))};
  journal.atomic(()=>this.db().prepare('INSERT INTO browser_runtime VALUES(?,?) ON CONFLICT(page) DO UPDATE SET body=excluded.body').run(id,JSON.stringify(info)));
  if(data.facts?.login){
   const w=await this.waitPage(task,'login',{page:id,origin:p.origin,url,reason:p.mode==='login'?'需要你接管并登录':'需要登录；先允许此网站，再由你接管输入'});
   journal.atomic(()=>this.db().prepare('UPDATE browser_pages SET paused=1 WHERE id=?').run(id));return w;
  }
  const diff=!full&&old&&old.navigation===data.navigation,changed=diff?snapshot.nodes.filter(n=>old.nodes[n.id]!==info.nodes[n.id]):snapshot.nodes,removed=diff?Object.keys(old.nodes).filter(id=>!info.nodes[id]):[];
  return {page:id,url,title:info.title,snapshot:snapshot.id,epoch:snapshot.epoch,nodes:changed,removed,diff:!!diff,...(!diff||old.text!==info.text?{text:String(data.text||'').slice(0,14000)}:{}),untrustedPage:true};
 }
 writeTaskFile(task,bytes,extension,kind='download'){
  const t=this.task(task),io=t.workspace?.io,expected=path.join(process.env.TMPDIR||'/tmp','xin-task-'+task,'io');
  if(!io||path.resolve(io)!==path.resolve(expected))throw Error('工作没有可用的隔离文件目录');
  const C=fs.constants,fd=fs.openSync(io,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);let out;
  const name='browser-'+kind+'-'+crypto.randomBytes(10).toString('hex')+'.'+extension;
  try{out=fs.openSync('/proc/self/fd/'+fd+'/'+name,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);fs.writeFileSync(out,bytes);}finally{if(out!==undefined)fs.closeSync(out);fs.closeSync(fd);}
  return path.join(io,name);
 }
 writeTaskSnapshot(task,bytes){return {file:this.writeTaskFile(task,bytes,'jpg','shot'),type:'image/jpeg',masked:true,imageDigest:crypto.createHash('sha256').update(bytes).digest('hex'),imageBytes:bytes.length};}
 async fresh(task,page,element){
  if(!this.live.has(page))return null;const old=this.runtime(page),x=await this.call({op:'inspect',id:page,element});
  if(!old||x.stale||x.navigation!==old.navigation||sha(x.node)!==old.nodes[element]||sha(x.facts)!==old.facts)return null;return x;
 }
 async request(task,token,q={}){
  this.a.authorize(task,token);this.task(task);
  if(!['list','open','snapshot','screenshot','action','close'].includes(q.op))throw Error('浏览器代理不支持此操作');
  if(q.op==='list')return {pages:this.db().prepare('SELECT id,url,mode,paused FROM browser_pages WHERE task=?').all(task),waiting:this.waiting(task),paused:this.a.paused()};
  const pending=this.waiting(task);if(pending)return {waiting:true,...pending};
  if(this.a.paused())return {paused:true,reason:'站长正在接管，自动浏览已暂停'};
  if(q.op==='open'){
   this.a.use(task,'open');const url=browserURL(q.url);if(q.login===true&&browserRisk('click',{tag:'a',href:url.href}).category!=='read')throw Error('此登录网址可能直接产生外部后果，请从网站首页和实际页面元素申请确认');const p=this.a.open(task,browserSafeURL(url.href),{login:q.login===true});
   if(p.needsWhitelist)return this.wait(task,'whitelist',{origin:p.origin,url:browserSafeURL(url.href),reason:'需要你允许这个登录网站'});
   return this.record(task,p.id,await this.startPage(task,p,url.href));
  }
  const p=this.a.page(task,q.page);if(p.paused)return {paused:true,reason:'此页面需要站长交还后才能继续'};
  if(q.op==='snapshot'){this.a.use(task,'snapshot');const full=q.full===true||!this.live.has(p.id);return this.record(task,p.id,await this.pageData(task,p.id),{full});}
  const req={page:p.id,snapshot:q.snapshot,element:q.element,op:q.action,key:q.key,...(q.value!==undefined?{value:q.value}:{}),...(q.category?{category:q.category}:{})};
  if(q.op==='action'){const previous=this.db().prepare('SELECT state FROM browser_actions WHERE task=? AND key=?').get(task,q.key);if(previous&&['done','started','uncertain'].includes(previous.state)){const receipt=this.a.propose(task,req);return receipt.state==='started'?{...this.a.start(task,q.key),reason:'上次连接中断，操作结果需要站长核对，不能自动重做'}:receipt;}}
  if(!this.live.has(p.id)){await this.record(task,p.id,await this.pageData(task,p.id));return {stale:true,reason:'浏览器已恢复网址，请重新获取快照'};}
  if(q.op==='close'){await this.call({op:'close',id:p.id});this.live.delete(p.id);journal.atomic(()=>{this.db().prepare('DELETE FROM browser_pages WHERE id=?').run(p.id);this.db().prepare('DELETE FROM browser_runtime WHERE page=?').run(p.id);});return {closed:true};}
  if(q.op==='screenshot'){
   this.a.use(task,'screenshot');return this.writeTaskSnapshot(task,await this.picture(p.id));
  }
  const receipt=this.a.propose(task,req);
  if(receipt.ownerInput)return this.waitPage(task,'login',{page:p.id,origin:p.origin,url:p.url,reason:receipt.reason});
  if(receipt.state==='pending'){
   const saved=JSON.parse(this.a.page(task,p.id).snapshot),node=saved.nodes.find(n=>n.id===q.element);
   return this.waitPage(task,'approval',{page:p.id,origin:p.origin,key:q.key,approval:receipt.approval,category:receipt.category,label:node?.label||q.action,account:String(saved.facts?.account||'').slice(0,200),recipient:String(saved.facts?.recipient||'').slice(0,500),value:typeof q.value==='string'?q.value:'',reason:BROWSER_CATEGORIES[receipt.category]});
  }
  if(receipt.state==='started')return {...this.a.start(task,q.key),reason:'上次连接中断，操作结果需要站长核对，不能自动重做'};
  if(receipt.state!=='ready')return receipt;
  let fresh=null;
   if(q.element){fresh=await this.fresh(task,p.id,q.element);if(!fresh){journal.atomic(()=>this.db().prepare("UPDATE browser_actions SET state='stale' WHERE task=? AND key=? AND state='ready'").run(task,q.key));return {stale:true,page:p.id,reason:'元素、账户或页面内容已变化，请重新获取快照'};}}
  const started=this.a.start(task,q.key);if(!started.execute)return started;
  try{
   let result;
   if(q.action==='download'){
    if(fresh?.node?.tag!=='a'||!fresh.node.href)throw Error('公开下载需要快照中的真实链接');
    const url=browserURL(fresh.node.href),data=await this.call({op:'download',url:url.href}),bytes=Buffer.from(data.data,'base64');
    if(bytes.length>20*1024*1024)throw Error('下载超过 20 MB');const ext=/\.([a-z0-9]{1,8})$/i.exec(url.pathname)?.[1]||'bin';
    result={file:this.writeTaskFile(task,bytes,ext),bytes:bytes.length,type:data.type,anonymous:true};
   }else if(q.action==='screenshot')result=this.writeTaskSnapshot(task,await this.picture(p.id));
   else{
    const data=await this.call({op:'action',id:p.id,action:q.action,element:q.element,value:q.value,navigation:this.runtime(p.id).navigation,expected:fresh?.node,facts:fresh?.facts});
    result={performed:true,observed:await this.record(task,p.id,data)};
   }
   this.a.finish(task,q.key,result);return {state:'done',key:q.key,result};
  }catch{
   // The browser may have acted before disconnecting. Never retry this key automatically.
   this.a.start(task,q.key);return {state:'uncertain',key:q.key,reason:'这一步的结果还不能确认，请站长查看；不能重复执行'};
  }
 }
 async state(){
  const waits=this.db().prepare('SELECT * FROM browser_waits ORDER BY at').all().map(r=>{
   const v={task:r.task,id:r.id,kind:r.kind,...JSON.parse(r.body),title:this.resolveTask(r.task)?.title||'这项工作'};
   try{const file=path.join(this.root,'cards',r.id+'.jpg');if(fs.statSync(file).size<800000)v.image='data:image/jpeg;base64,'+fs.readFileSync(file).toString('base64');}catch{v.imageUnavailable=true;}return v;
  });
  return {sites:this.a.sites(),paused:this.a.paused(),pages:this.db().prepare('SELECT id,task,url,origin,mode,paused FROM browser_pages ORDER BY updated DESC LIMIT 30').all().map(p=>({...p,title:this.runtime(p.id)?.title||'',taskTitle:this.resolveTask(p.task)?.title||'这项工作'})),waits};
 }
 async site(origin,allowed){
  const r=this.a.setSite(origin,allowed);if(this.live.size)await this.call({op:'sites',allowed:this.a.sites()});
  if(!allowed){
   for(const p of this.db().prepare("SELECT * FROM browser_pages WHERE origin=? AND mode='login'").all(r.origin)){
    if(this.live.has(p.id)){try{await this.call({op:'close',id:p.id});}catch{}this.live.delete(p.id);}
    journal.atomic(()=>{this.db().prepare('UPDATE browser_pages SET paused=1,snapshot=NULL,epoch=epoch+1 WHERE id=?').run(p.id);this.db().prepare("UPDATE browser_actions SET state='denied' WHERE page=? AND state IN ('ready','pending')").run(p.id);});
    this.wait(p.task,'whitelist',{page:p.id,origin:r.origin,url:p.url,reason:'这个登录站点已移出白名单，请先重新允许'});
   }
   journal.atomic(()=>this.db().prepare('DELETE FROM browser_grants WHERE origin=?').run(r.origin));
  }return r;
 }
 async allowWait(task,id){
  const command='allow:'+task+':'+id,body={task,id},previous=this.receipt(command,body);if(previous)return previous;
  const w=this.waiting(task);if(!w||w.id!==id||!['whitelist','login'].includes(w.kind))throw Error('这个登录请求已变化，请重新查看');
  await this.site(w.origin,true);
  let p=w.page&&this.a.page(task,w.page);
  if(p&&(p.mode==='public'||p.origin!==w.origin)){await this.call({op:'close',id:p.id});this.live.delete(p.id);journal.atomic(()=>this.db().prepare('DELETE FROM browser_pages WHERE id=?').run(p.id));p=null;}
  if(!p){p=this.a.open(task,w.url||w.origin,{login:true});if(p.needsWhitelist)throw Error('网站尚未允许');}
  const data=await this.startPage(task,p,w.url||p.url);await this.record(task,p.id,data);const result={page:p.id,task,needsTakeover:true};return journal.atomic(()=>this.saveReceipt(command,body,result));
 }
 async takeover(task,page){
  const p=this.a.page(task,page);if(p.mode!=='login'||!this.a.sites().includes(p.origin))throw Error('先允许此登录网站，再接管登录');
  if(!this.displayReady())return {needsDesktop:true};
  this.a.takeover(task,page,true);
  if(!this.live.has(page))await this.startPage(task,p,p.url);
  const r=await this.call({op:'headful',id:page});for(const id of r.reopened||[])this.a.navigate(this.a.db().prepare('SELECT task FROM browser_pages WHERE id=?').get(id).task,id,this.a.db().prepare('SELECT url FROM browser_pages WHERE id=?').get(id).url);
  return {paused:true,page,task};
 }
 async release(task,page,requestId=''){
  const command='release:'+task+':'+(requestId||page+':'+this.a.page(task,page).epoch),body={task,page};
  const previous=this.receipt(command,body);if(previous)return previous;
  this.a.paused();const active=this.db().prepare('SELECT * FROM browser_control WHERE id=1').get();
  if(!active?.paused)return {released:false,already:true,task,page};
  if(active.task&&active.page&&(active.task!==task||active.page!==page))throw Error('接管的页面已经变化，请重新查看');
  this.a.takeover(task,page,false);this.clearWait(task);const view=await this.record(task,page,await this.pageData(task,page)),result={released:!view.waiting,task,page,...(view.waiting?{waiting:view}:{})};
  return journal.atomic(()=>{this.db().prepare('UPDATE browser_control SET task=NULL,page=NULL WHERE id=1').run();if(result.released)this.resume(command,task,'站长已交还浏览器。重新获取快照后继续；密码、验证码仍只由站长输入，不要重复已经执行的操作。');return this.saveReceipt(command,body,result);});
 }
 async decide(task,id,{approve,scope='once'}={}){
  const command='decide:'+task+':'+id,body={approve,scope},previous=this.receipt(command,body);if(previous)return previous;
  const w=this.waiting(task);if(!w||w.id!==id||w.kind!=='approval'||typeof approve!=='boolean')throw Error('这份操作确认已变化，请重新查看');
  const action=this.db().prepare('SELECT body FROM browser_actions WHERE task=? AND key=?').get(task,w.key),req=action&&JSON.parse(action.body);
  if(approve&&req?.element&&!await this.fresh(task,w.page,req.element))return journal.atomic(()=>{this.db().prepare("UPDATE browser_actions SET state='stale' WHERE task=? AND key=? AND state='pending'").run(task,w.key);this.clearWait(task);this.resume(command,task,'确认时页面已经变化。重新快照，再根据实际页面重新申请确认，旧操作不能执行。');return this.saveReceipt(command,body,{stale:true,task,page:w.page});});
  return journal.atomic(()=>{this.a.decide(task,w.key,{approval:w.approval,approve,scope});this.clearWait(task);this.resume(command,task,approve?'站长已在确认卡片批准这一步'+(scope==='task'?'及本任务相同站点、账户和收件人范围内的同类操作':'')+'。继续时保留原操作 key '+w.key+'，不重复已执行动作。':'站长没有批准这一步，保留现状，不得换 key 重试；如实汇报尚未执行。');return this.saveReceipt(command,body,{approved:approve,task,key:w.key,page:w.page});});
 }
 async pause(paused,requestId=''){
  const wasPaused=this.a.paused(),active=this.db().prepare('SELECT task,page FROM browser_control WHERE id=1').get();
  if(!paused&&wasPaused&&this.live.size){const reset=await this.call({op:'fresh-public'});for(const id of reset.reopened||[])this.db().prepare('UPDATE browser_pages SET snapshot=NULL,epoch=epoch+1 WHERE id=?').run(id);}
  const p=active?.page&&this.db().prepare('SELECT * FROM browser_pages WHERE id=?').get(active.page);
  if(!paused&&wasPaused&&active?.task&&p&&this.a.sites().includes(p.origin))return this.release(active.task,active.page,requestId);
  journal.atomic(()=>{this.db().prepare('INSERT INTO browser_control VALUES(1,NULL,NULL,?) ON CONFLICT(id) DO UPDATE SET paused=excluded.paused').run(paused?1:0);if(!paused){this.db().prepare('UPDATE browser_pages SET epoch=epoch+1,snapshot=NULL').run();this.db().prepare('UPDATE browser_control SET task=NULL,page=NULL WHERE id=1').run();}});return {paused:!!paused};
 }
 async revoke(task){
  this.a.revoke(task);this.clearWait(task);for(const p of this.db().prepare('SELECT id FROM browser_pages WHERE task=?').all(task)){if(this.live.has(p.id))try{await this.call({op:'close',id:p.id});}catch{}this.live.delete(p.id);}return {revoked:true};
 }
}
