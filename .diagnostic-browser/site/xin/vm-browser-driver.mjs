// Playwright stays in the controller process tree. Its pipe and profiles are never mounted in a task.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {processIdentity,signalProcessGroup} from './vm-base.mjs';

export const BROWSER_DRIVER=String.raw`import sys,json,asyncio,hashlib,base64,os
from urllib.parse import urlparse
from playwright.async_api import async_playwright

DESCRIBE="""e=>{
 const safeText=root=>{const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),out=[];let n,total=0,count=0;while((n=w.nextNode())&&count++<30000&&total<700){const p=n.parentElement;if(!p||p.closest('input,textarea,[contenteditable],script,style,noscript')||!p.getClientRects().length||getComputedStyle(p).visibility==='hidden')continue;const t=n.textContent.trim();if(t){out.push(t);total+=t.length+1;}}return out.join(' ').slice(0,700);};
 const label=(e.getAttribute('aria-label')||e.labels&&Array.from(e.labels).map(x=>safeText(x)).join(' ')||(e.matches('input,textarea,select,[contenteditable]')?'':safeText(e))||e.getAttribute('title')||e.getAttribute('placeholder')||e.name||'').trim();
 const f=e.form||e.closest('form');
 return {tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||'',label:label.slice(0,300),title:e.title||'',
  type:e.type||'',name:e.name||'',autocomplete:e.autocomplete||'',href:e.href||'',
  formAction:f?f.action:'',formLabel:f?(f.getAttribute('aria-label')||safeText(f)||'').slice(0,700):''};
}"""
FACTS="""()=>{
 const visible=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length),fields=Array.from(document.querySelectorAll('input')).filter(visible);
 const login=fields.some(e=>/password|passwd|one-time-code|otp|verification|验证码|密码|动态码|安全码|auth.?code|verify.?code|(?:^|\W)pin(?:\W|$)/i.test([e.type,e.name,e.id,e.autocomplete,e.getAttribute('aria-label'),e.labels&&Array.from(e.labels).map(l=>l.innerText).join(' ')].join(' ')));
 const to=fields.filter(e=>/recipient|addressee|^(?:to|cc|bcc)$|收件人|接收人/i.test([e.name,e.id,e.getAttribute('aria-label')].join(' '))).map(e=>e.value).join(';').slice(0,500);
 const account=document.querySelector('[data-account],header [aria-label*=account i],header [aria-label*=账户],header [aria-label*=账号]');
 return {login,recipient:to,account:account?(account.getAttribute('data-account')||account.innerText||account.getAttribute('aria-label')||'').slice(0,200):'',action:location.origin+location.pathname};
}"""
SECRET='input,textarea,[contenteditable=true]'
BODY_TEXT="""()=>{const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),out=[];let n,total=0,count=0;while((n=w.nextNode())&&count++<30000&&total<14000){const e=n.parentElement;if(!e||e.closest('input,textarea,[contenteditable],script,style,noscript')||!e.getClientRects().length||getComputedStyle(e).visibility==='hidden')continue;const t=n.textContent.trim();if(t){out.push(t);total+=t.length+1;}}return out.join(' ').slice(0,14000);}"""
def origin(url):
 u=urlparse(url);return u.scheme+'://'+u.netloc
def cleanurl(url):
 from urllib.parse import parse_qsl,urlencode,urlunparse
 import re
 u=urlparse(url);q=[(k,'[已隐藏]' if re.search(r'password|passwd|secret|token|api.?key|^code$|authorization',k,re.I) else v) for k,v in parse_qsl(u.query,keep_blank_values=True)]
 fragment=u.fragment
 if re.search(r'(?:password|secret|token|api.?key|authorization|code)=',fragment,re.I):fragment=''
 return urlunparse((u.scheme,u.netloc,u.path,u.params,urlencode(q),fragment))

async def main():
 p=await async_playwright().start();pages={};contexts={};browsers={};config={}
 async def close_context(key):
  ctx=contexts.pop(key,None);browser=browsers.pop(key,None)
  try:
   if ctx:await ctx.close()
  finally:
   if browser:await browser.close()
 async def facts(page,ctx):
  f=await page.evaluate(FACTS)
  # A change of login session must invalidate a grant even without a visible account name.
  cookies=await ctx.cookies([page.url]);identity=sorted((c['name'],c['value'],c['domain']) for c in cookies)
  f['session']=hashlib.sha256(json.dumps(identity).encode()).hexdigest();return f
 async def snapshot(q):
  v=pages[q['id']];page=v['page'];ctx=v['ctx'];v['nodes']={};nodes=[]
  for e in (await page.query_selector_all('a,button,input,select,textarea,[role=button],[role=link]'))[:500]:
   if len(nodes)>=200:break
   if not await e.is_visible():continue
   n=await e.evaluate(DESCRIBE)
   # Never expose input values, including password/OTP values supplied by the owner.
   key=str(len(nodes)+1);n['id']=key;v['nodes'][key]=e;nodes.append(n)
  return {'url':cleanurl(page.url),'title':(await page.title())[:300],
    'text':await page.evaluate(BODY_TEXT),
    'nodes':nodes,'facts':await facts(page,ctx),'navigation':v['nav'],'headful':v['headful'],'blockedOrigin':v.get('blocked')}
 async def open_page(q):
  if q['id'] in pages:return await snapshot(q)
  else:
   mode=q['mode'];key=q['profile'];ctx=contexts.get(key);headful=bool(q.get('headful'))
   if ctx is not None:headful=next((x['headful'] for x in pages.values() if x['profile']==key),headful)
   if ctx is None:
    args=['--disable-dev-shm-usage','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--proxy-bypass-list=<-loopback>']
    if headful:args+=['--start-maximized']
    launch={'executable_path':config['chromium'],'headless':not headful,'chromium_sandbox':config.get('sandbox',True),
      'proxy':{'server':config['proxy']},'args':args,'env':{**os.environ,'DISPLAY':config.get('display',':1')}}
    options={'service_workers':'block','accept_downloads':False,'permissions':[],'viewport':{'width':1280,'height':800}}
    if mode=='public':
     browser=await p.chromium.launch(**launch);ctx=await browser.new_context(**options);browsers[key]=browser
    else:ctx=await p.chromium.launch_persistent_context(key,**launch,**options)
    contexts[key]=ctx
   page=await ctx.new_page();page.set_default_timeout(10000)
   v={'page':page,'ctx':ctx,'nodes':{},'nav':0,'headful':headful,'profile':key,'mode':mode,'allowed':q.get('allowed',[])};pages[q['id']]=v
   async def route(r,request,*,v=v,page=page):
    u=urlparse(r.request.url)
    if u.scheme not in ('http','https'):return await r.abort()
    if r.request.is_navigation_request() and r.request.frame==page.main_frame and v['mode']=='login' and origin(r.request.url) not in v['allowed']:
     v['blocked']=origin(r.request.url);return await r.abort()
    await r.continue_()
   await page.route('**/*',route)
   page.on('framenavigated',lambda frame,v=v,page=page:v.update(nav=v['nav']+1,nodes={}) if frame==page.main_frame else None)
   page.on('popup',lambda popup:asyncio.create_task(popup.close()))
   try:await page.goto(q['url'],wait_until='domcontentloaded',timeout=25000)
   except Exception:
    if not v.get('blocked'):raise
   return await snapshot(q)
 try:
  while True:
   line=await asyncio.to_thread(sys.stdin.readline)
   if not line:break
   q={}
   try:
    q=json.loads(line);op=q['op'];result={}
    if op=='init':config=q;result={'ready':True}
    elif op=='display':
     config['display']=q['display'];os.environ['DISPLAY']=q['display'];result={'ok':True}
    elif op=='open':result=await open_page(q)
    elif op=='snapshot':result=await snapshot(q)
    elif op=='inspect':
     v=pages[q['id']];e=v['nodes'].get(q.get('element'))
     if e is None or not await e.evaluate('e=>e.isConnected'):result={'stale':True}
     else:result={'node':await e.evaluate(DESCRIBE),'facts':await facts(v['page'],v['ctx']),'navigation':v['nav'],'url':cleanurl(v['page'].url)}
    elif op=='screenshot':
     v=pages[q['id']];fmt=q.get('format','png');result={'image':base64.b64encode(await v['page'].screenshot(type=fmt,**({'quality':70} if fmt=='jpeg' else {}),mask=[frame.locator(SECRET) for frame in v['page'].frames],mask_color='#999999')).decode()}
    elif op=='action':
     v=pages[q['id']];page=v['page'];e=v['nodes'].get(q.get('element'));action=q['action']
     if q.get('navigation')!=v['nav']:raise RuntimeError('页面已跳转，请重新获取快照')
     if action in ('click','fill','select','press'):
      if e is None or not await e.evaluate('e=>e.isConnected'):raise RuntimeError('元素已变化，请重新获取快照')
      if await e.evaluate(DESCRIBE)!=q.get('expected') or await facts(page,v['ctx'])!=q.get('facts'):raise RuntimeError('页面内容或账户已变化，请重新获取快照')
      if action=='click':await e.click(force=True,timeout=500)
      elif action=='fill':await e.fill(q['value'],timeout=500)
      elif action=='select':await e.select_option(q['value'],timeout=500)
      else:
       if q['value'] not in ('Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Space'):raise RuntimeError('不允许这组快捷键')
       await e.press(q['value'],timeout=500)
     elif action=='scroll':await page.mouse.wheel(0,max(-2000,min(2000,int(q.get('value',600)))))
     elif action=='back':await page.go_back(wait_until='domcontentloaded',timeout=20000)
     else:raise RuntimeError('不支持此操作')
     await page.wait_for_timeout(200);result=await snapshot(q)
    elif op=='download':
     # Read a bounded anonymous stream. No browser cookie jar or owner login is used.
     def download():
      import urllib.request
      class Redirect(urllib.request.HTTPRedirectHandler):
       def redirect_request(self,req,fp,code,msg,headers,newurl):
        u=urlparse(newurl)
        if u.scheme not in ('http','https') or u.username or u.password:raise RuntimeError('下载跳转网址不受支持')
        return super().redirect_request(req,fp,code,msg,headers,newurl)
      opener=urllib.request.build_opener(urllib.request.ProxyHandler({'http':config['proxy'],'https':config['proxy']}),Redirect())
      with opener.open(q['url'],timeout=25) as r:
       if int(r.headers.get('content-length','0'))>20*1024*1024:raise RuntimeError('公开下载超过 20 MB')
       body=r.read(20*1024*1024+1)
       if len(body)>20*1024*1024:raise RuntimeError('公开下载超过 20 MB')
       return {'data':base64.b64encode(body).decode(),'type':r.headers.get('content-type','application/octet-stream')}
     result=await asyncio.to_thread(download)
    elif op=='fresh-public':
     saved=[{'op':'open','id':pid,'url':cleanurl(x['page'].url),'profile':x['profile'],'mode':'public','allowed':[],'headful':x['headful']} for pid,x in pages.items() if x['mode']=='public']
     for key in {x['profile'] for x in saved}:await close_context(key)
     for x in saved:pages.pop(x['id'])
     for x in saved:await open_page(x)
     result={'reopened':[x['id'] for x in saved]}
    elif op=='sites':
     for v in pages.values():
      if v['mode']=='login':v['allowed']=q['allowed']
     result={'ok':True}
    elif op=='headful':
     v=pages[q['id']]
     if not v['headful']:
      key=v['profile'];saved=[{'op':'open','id':pid,'url':x['page'].url,'profile':key,'mode':x['mode'],'allowed':x['allowed'],'headful':True} for pid,x in pages.items() if x['profile']==key]
      await close_context(key)
      for x in saved:pages.pop(x['id'])
      for x in saved:await open_page(x)
      result={'reopened':[x['id'] for x in saved]}
     await pages[q['id']]['page'].bring_to_front()
    elif op=='front':await pages[q['id']]['page'].bring_to_front();result={'ok':True}
    elif op=='close':
     v=pages.pop(q['id'],None)
     if v:await v['page'].close()
     if v and not any(x['profile']==v['profile'] for x in pages.values()):await close_context(v['profile'])
     result={'ok':True}
    else:raise RuntimeError('未知控制器请求')
    print(json.dumps({'id':q.get('request'),'result':result},ensure_ascii=True),flush=True)
   except Exception as e:
    # Avoid library exception text: it can contain URLs, field values or page excerpts.
    print(json.dumps({'id':q.get('request'),'error':str(e) if isinstance(e,RuntimeError) else '浏览器操作未完成，请重新查看页面','kind':type(e).__name__,'op':q.get('op')}),flush=True)
 finally:
  for key in list(contexts):
   try:await close_context(key)
   except Exception:pass
  await p.stop()
asyncio.run(main())`;

export class BrowserDriver {
 constructor({python='python3',chromium,proxy,display=':1',root,sandbox=true}={}){
  if(!chromium||!proxy||!root)throw Error('浏览器驱动缺少控制器配置');
  fs.mkdirSync(root,{recursive:true,mode:0o700});fs.mkdirSync(path.join(root,'tmp'),{recursive:true,mode:0o700});
  this.root=path.resolve(root);this.seq=0;this.pending=new Map();this.closed=false;
  this.child=spawn(python,['-u','-c',BROWSER_DRIVER],{cwd:this.root,detached:true,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:this.root,TMPDIR:path.join(this.root,'tmp'),LANG:'C.UTF-8',DISPLAY:display}});
  this.child.xinIdentity=processIdentity(this.child.pid);
  const lines=readline.createInterface({input:this.child.stdout});lines.on('line',line=>{
   let m;try{m=JSON.parse(line);}catch{return;}const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Object.assign(Error(m.error),{kind:m.kind,operation:m.op})):p.resolve(m.result);
  });
  this.child.stderr.on('data',()=>{});const fail=()=>{this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('浏览器驱动已停止，操作结果需要重新核对'));}this.pending.clear();};
  this.child.on('error',fail);this.child.on('close',fail);
  this.ready=this.call({op:'init',chromium,proxy,display,sandbox});
 }
 call(data,ms=40000){
  if(this.closed)return Promise.reject(Error('浏览器驱动已停止'));
  return new Promise((resolve,reject)=>{const request=++this.seq,timer=setTimeout(()=>{this.pending.delete(request);reject(Error('浏览器操作超时，结果未确认'));this.abort();},ms);timer.unref();this.pending.set(request,{resolve,reject,timer});
   this.child.stdin.write(JSON.stringify({...data,request})+'\n',e=>{if(e){clearTimeout(timer);this.pending.delete(request);reject(Error('浏览器驱动无法接收请求'));}});
  });
 }
 abort(){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('浏览器驱动需要恢复，操作结果未确认'));}this.pending.clear();signalProcessGroup(this.child.pid,this.child.xinIdentity,'SIGTERM');const timer=setTimeout(()=>signalProcessGroup(this.child.pid,this.child.xinIdentity,'SIGKILL'),1000);timer.unref();}
 async close(){if(this.closed)return;this.child.stdin.end();const child=this.child;const timer=setTimeout(()=>signalProcessGroup(child.pid,child.xinIdentity,'SIGKILL'),5000);timer.unref();await new Promise(resolve=>child.once('close',resolve));clearTimeout(timer);}
}
