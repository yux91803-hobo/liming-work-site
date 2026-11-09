// Controller-owned browser authority and action ledger. No executor supplies page facts or grants.
import crypto from 'node:crypto';
import {journal,okId} from './vm-base.mjs';
const digest=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export const BROWSER_CATEGORIES={read:'浏览查询',external:'外部操作',profile:'修改个人资料',send:'发送消息或发帖',authorize:'授权第三方',publish:'部署或公开发布',delete:'删除内容',security:'修改账号安全',payment:'付款'};
const levels=Object.keys(BROWSER_CATEGORIES);
export function browserURL(value){
 let u;try{u=new URL(String(value));}catch{throw Error('请输入完整网址');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port))throw Error('只支持不带账号信息的公开 HTTP/HTTPS 网址');
 return u;
}
export function browserRisk(op,node={},page={},declared='read'){
 const field=[node.type,node.name,node.autocomplete,node.label].join(' ');
 if(op==='fill'&&/password|passwd|one-time-code|otp|验证码|密码|口令|密钥|银行卡|信用卡|api.?key|secret|token|cvv|cvc|cc-|(?:^|\W)pin(?:\W|$)/i.test(field))return {ownerInput:true,category:'login',reason:'登录和验证信息由站长接管输入'};
 if(page.login||node.type==='password')return {ownerInput:true,category:'login',reason:'需要站长登录'};
 const text=[node.label,node.role,node.title,node.href,node.formAction,node.formLabel].join(' '),found=new Set();
 const rules={payment:/支付|付款|结账|转账|购买|订阅续费|checkout|pay(?:ment)?\b|purchase|place.order/i,
  delete:/删除|清空|销毁|注销账号|\bdelete\b|\berase\b|\bremove\b|destroy|terminate.account/i,
  security:/改.*密码|重置.*密码|两步验证|二步验证|双重验证|安全设置|绑定手机|解绑|恢复码|reset.password|change.password|two.factor|\b2fa\b|security.settings/i,
  send:/发送|发帖|发布评论|提交评论|私信|回复|\bsend\b|\breply\b|\bpost\b|\bcomment\b/i,
  authorize:/授权|允许访问|连接应用|第三方应用|\bauthorize\b|grant.access|connect.app|oauth.*consent/i,
  profile:/修改资料|编辑资料|保存资料|更新资料|头像|昵称|edit.profile|save.profile|update.profile|avatar|display.name/i,
  publish:/部署|公开发布|上线|发布版本|\bdeploy\b|\bpublish\b|release.version/i};
 if(!['open','snapshot','screenshot','scroll','back'].includes(op)){
  for(const [category,re] of Object.entries(rules))if(re.test(text))found.add(category);
  if(!found.size){
   const search=/search|搜索|查询|检索|筛选/i.test(text+field),link=node.tag==='a'&&/^https?:\/\//.test(node.href||'');
   const local=/展开|收起|下一页|上一页|详情|返回|关闭|播放|暂停|放大|缩小|复制|expand|collapse|next.page|previous.page|details|close|play|pause|zoom|copy/i.test(text);
   if(!search&&!link&&!local)found.add('external');
  }
 }
 if(declared!=='read'){if(!BROWSER_CATEGORIES[declared])throw Error('未知操作类别');found.add(declared);}
 const categories=[...found].sort((a,b)=>levels.indexOf(b)-levels.indexOf(a));
 return {category:categories[0]||'read',categories,ownerInput:false,reason:categories.map(c=>BROWSER_CATEGORIES[c]).join('、')||'普通浏览或查询'};
}
const safeNode=n=>Object.fromEntries(['id','tag','role','label','title','type','name','autocomplete','href','formAction','formLabel'].filter(k=>typeof n?.[k]==='string').map(k=>[k,n[k].slice(0,k==='href'||k==='formAction'?2000:300)]));
export class BrowserAuthority {
 constructor({now=Date.now}={}){this.now=now;}
 db(){const d=journal.db;d.exec(`CREATE TABLE IF NOT EXISTS browser_sites(origin TEXT PRIMARY KEY,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS browser_tasks(sid TEXT PRIMARY KEY,token_hash TEXT NOT NULL,generation INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS browser_pages(id TEXT PRIMARY KEY,task TEXT NOT NULL,url TEXT NOT NULL,origin TEXT NOT NULL,mode TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 1,snapshot TEXT,paused INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS browser_actions(task TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,page TEXT NOT NULL,category TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,result TEXT,approval TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(task,key));
 CREATE TABLE IF NOT EXISTS browser_grants(task TEXT NOT NULL,origin TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(task,origin,category,scope));`);return d;}
 paused(){const d=this.db();d.exec('CREATE TABLE IF NOT EXISTS browser_control(id INTEGER PRIMARY KEY,task TEXT,page TEXT,paused INTEGER NOT NULL)');return !!d.prepare('SELECT paused FROM browser_control WHERE id=1').get()?.paused;}
 use(task,op){const d=this.db();d.exec('CREATE TABLE IF NOT EXISTS browser_budget(task TEXT PRIMARY KEY,actions INTEGER NOT NULL,images INTEGER NOT NULL,downloads INTEGER NOT NULL)');
  return journal.atomic(()=>{const b=d.prepare('SELECT * FROM browser_budget WHERE task=?').get(task)||{actions:0,images:0,downloads:0},field=op==='screenshot'?'images':op==='download'?'downloads':'actions',max=field==='images'?20:field==='downloads'?10:160;
   if(b[field]>=max)throw Error('这项工作的浏览器操作已达到上限，请先汇报现有结果');b[field]++;d.prepare('INSERT INTO browser_budget VALUES(?,?,?,?) ON CONFLICT(task) DO UPDATE SET actions=excluded.actions,images=excluded.images,downloads=excluded.downloads').run(task,b.actions,b.images,b.downloads);return b;
  });}
 sites(){return this.db().prepare('SELECT origin FROM browser_sites ORDER BY origin').all().map(r=>r.origin);}
 setSite(origin,allowed){origin=browserURL(origin).origin;return journal.atomic(()=>{if(allowed)this.db().prepare('INSERT OR REPLACE INTO browser_sites VALUES(?,?)').run(origin,this.now());else this.db().prepare('DELETE FROM browser_sites WHERE origin=?').run(origin);return {origin,allowed:!!allowed};});}
 issue(task,lifetime=4*3600e3){
  if(!okId(task,'s'))throw Error('后台任务编号不对');
  const token=crypto.randomBytes(32).toString('hex');journal.atomic(()=>this.db().prepare('INSERT INTO browser_tasks VALUES(?,?,1,?,0) ON CONFLICT(sid) DO UPDATE SET token_hash=excluded.token_hash,generation=generation+1,expires=excluded.expires,revoked=0').run(task,digest(token),this.now()+Math.min(4*3600e3,Math.max(1000,lifetime))));return token;
 }
 authorize(task,token){const r=this.db().prepare('SELECT * FROM browser_tasks WHERE sid=?').get(task);if(!r||r.revoked||r.expires<=this.now()||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||!crypto.timingSafeEqual(Buffer.from(r.token_hash,'hex'),Buffer.from(digest(token),'hex')))throw Error('浏览器临时凭证已过期或不属于这项任务');return r;}
 revoke(task){return journal.atomic(()=>{this.db().prepare('UPDATE browser_tasks SET revoked=1 WHERE sid=?').run(task);this.db().prepare('UPDATE browser_pages SET paused=1 WHERE task=?').run(task);});}
 page(task,id){const p=this.db().prepare('SELECT * FROM browser_pages WHERE id=? AND task=?').get(id,task);if(!p)throw Error('这个页面不属于当前任务');return p;}
 open(task,url,{login=false}={}){
  const u=browserURL(url),mode=login?'login':'public';if(login&&!this.sites().includes(u.origin))return {needsWhitelist:true,origin:u.origin};
  const id='b'+crypto.randomBytes(12).toString('hex');journal.atomic(()=>this.db().prepare('INSERT INTO browser_pages(id,task,url,origin,mode,updated) VALUES(?,?,?,?,?,?)').run(id,task,u.href,u.origin,mode,this.now()));return {id,url:u.href,origin:u.origin,mode};
 }
 navigate(task,id,url){const p=this.page(task,id),u=browserURL(url);if(p.mode==='login'&&!this.sites().includes(u.origin))return {needsWhitelist:true,origin:u.origin};
  journal.atomic(()=>this.db().prepare('UPDATE browser_pages SET url=?,origin=?,epoch=epoch+1,snapshot=NULL,updated=? WHERE id=?').run(u.href,u.origin,this.now(),id));return this.page(task,id);
 }
 snapshot(task,id,nodes,facts={}){
  const p=this.page(task,id);if(p.paused||this.paused())return {paused:true};
  if(!Array.isArray(nodes)||nodes.length>200)throw Error('页面元素快照过大');
  const clean=nodes.map(safeNode),seen=new Set();for(const n of clean){if(!n.id||seen.has(n.id))throw Error('页面元素编号不完整');seen.add(n.id);}
  const data={id:crypto.randomBytes(16).toString('hex'),epoch:p.epoch,nodes:clean,facts:{login:!!facts.login,account:String(facts.account||'').slice(0,200),recipient:String(facts.recipient||'').slice(0,200),action:String(facts.action||'').slice(0,500),session:/^[a-f0-9]{64}$/.test(facts.session||'')?facts.session:''}};
  journal.atomic(()=>this.db().prepare('UPDATE browser_pages SET snapshot=?,updated=? WHERE id=?').run(JSON.stringify(data),this.now(),id));return data;
 }
 propose(task,request){
  if(!request||!/^[a-zA-Z0-9_-]{8,100}$/.test(request.key||''))throw Error('操作缺少幂等标识');
  return journal.atomic(()=>{
   const d=this.db(),p=this.page(task,request.page);if(p.paused||this.paused())return {paused:true};
   const old=d.prepare('SELECT * FROM browser_actions WHERE task=? AND key=?').get(task,request.key),hash=digest(request);
   if(old){if(old.digest!==hash)throw Error('同一个操作标识不能用于不同内容');return this.receipt(old);}
   const snap=p.snapshot&&JSON.parse(p.snapshot);if(!snap||snap.id!==request.snapshot||snap.epoch!==p.epoch)return {stale:true};
   const node=request.element?snap.nodes.find(n=>n.id===request.element):{};if(request.element&&!node)return {stale:true};
   if(!['click','fill','select','press','scroll','back','screenshot','download'].includes(request.op))throw Error('不支持的浏览器操作');
   const risk=browserRisk(request.op,node,snap.facts,request.category||'read');
   if(risk.ownerInput){d.prepare('UPDATE browser_pages SET paused=1 WHERE id=?').run(p.id);return {ownerInput:true,origin:p.origin,reason:risk.reason};}
   if(['fill','select','press'].includes(request.op)&&(typeof request.value!=='string'||request.value.length>2000))throw Error('输入参数必须是不超过 2000 字的文本');
   this.use(task,request.op);
   // Scope facts come from the controller snapshot, never from the executor's claimed intent.
   const scope=digest(snap.facts),categories=risk.categories,
     granted=categories.every(c=>d.prepare('SELECT 1 FROM browser_grants WHERE task=? AND origin=? AND category=? AND scope=?').get(task,p.origin,c,scope)),
     state=granted?'ready':'pending',approval=granted?null:crypto.randomBytes(16).toString('hex');
   const body={...request,origin:p.origin,categories,scope};
   d.prepare('INSERT INTO browser_actions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(task,request.key,hash,p.id,risk.category,JSON.stringify(body),state,null,approval,this.now(),this.now());
   return this.receipt(d.prepare('SELECT * FROM browser_actions WHERE task=? AND key=?').get(task,request.key));
  });
 }
 receipt(row){return {key:row.key,page:row.page,category:row.category,state:row.state,approval:row.approval,...(row.result?{result:JSON.parse(row.result)}:{})};}
 decide(task,key,{approval,approve,scope='once'}={}){
  return journal.atomic(()=>{const d=this.db(),r=d.prepare('SELECT * FROM browser_actions WHERE task=? AND key=?').get(task,key);if(!r||r.state!=='pending'||r.approval!==approval)throw Error('这份确认已过期');
   const b=JSON.parse(r.body),p=this.page(task,r.page),snap=p.snapshot&&JSON.parse(p.snapshot);if(!snap||snap.id!==b.snapshot||p.origin!==b.origin||snap.epoch!==p.epoch)throw Error('页面已经变化，请重新核对');
   if(!['once','task'].includes(scope))throw Error('请选择仅此一步或本任务内同类操作');
   if(approve&&scope==='task')for(const c of b.categories)d.prepare('INSERT OR REPLACE INTO browser_grants VALUES(?,?,?,?,?)').run(task,b.origin,c,b.scope,this.now());
   d.prepare('UPDATE browser_actions SET state=?,updated=? WHERE task=? AND key=?').run(approve?'ready':'denied',this.now(),task,key);return {approved:!!approve};
  });
 }
 start(task,key){return journal.atomic(()=>{const d=this.db(),r=d.prepare('SELECT * FROM browser_actions WHERE task=? AND key=?').get(task,key);if(!r)throw Error('找不到浏览器操作');
  if(r.state==='done'||r.state==='uncertain')return this.receipt(r);
  if(r.state==='started'){d.prepare("UPDATE browser_actions SET state='uncertain',updated=? WHERE task=? AND key=?").run(this.now(),task,key);return {...this.receipt(r),state:'uncertain'};}
  if(r.state!=='ready')throw Error('这一步尚未获得确认');const b=JSON.parse(r.body),p=this.page(task,r.page),snap=p.snapshot&&JSON.parse(p.snapshot);
  if(p.paused||this.paused())throw Error('站长正在接管，请等待交还');if(!snap||snap.id!==b.snapshot||snap.epoch!==p.epoch)throw Error('页面已经变化，请重新获取快照');
  d.prepare("UPDATE browser_actions SET state='started',updated=? WHERE task=? AND key=?").run(this.now(),task,key);return {...this.receipt(r),state:'started',execute:true,operation:b};
 });}
 finish(task,key,result){return journal.atomic(()=>{const d=this.db(),r=d.prepare('SELECT * FROM browser_actions WHERE task=? AND key=?').get(task,key);if(!r||r.state!=='started')throw Error('这一步不在执行中');
  d.prepare("UPDATE browser_actions SET state='done',result=?,updated=? WHERE task=? AND key=?").run(JSON.stringify(result),this.now(),task,key);return {ok:true};
 });}
 takeover(task,id,paused){return journal.atomic(()=>{const p=this.page(task,id);if(!paused&&p.mode==='login'&&!this.sites().includes(p.origin))throw Error('登录站点已不在白名单，请先关闭登录页');this.paused();this.db().prepare('INSERT INTO browser_control VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET task=excluded.task,page=excluded.page,paused=excluded.paused').run(task,id,paused?1:0);this.db().prepare('UPDATE browser_pages SET paused=?,epoch=epoch+1,snapshot=NULL,updated=? WHERE id=?').run(paused?1:0,this.now(),id);return {paused:!!paused};});}
}
