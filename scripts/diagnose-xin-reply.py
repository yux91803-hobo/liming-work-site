"""Bounded synthetic reply comparison. Output counters, capability metadata and two sanitized legacy methods only."""
import hashlib,json,os,re,sys,time,urllib.parse,urllib.request,uuid
from pathlib import Path
API='https://api.instabox.sh'
key=os.environ.get('XIN_INSTABOX_API_KEY','')
if not key:raise RuntimeError('Configured InstaBox credential is required')
def api(route,data=None):
    headers={'X-API-Key':key,'Content-Type':'application/json'}
    if route.endswith(('/resume','/start')):headers['Idempotency-Key']=str(uuid.uuid4())
    req=urllib.request.Request(API+route,headers=headers,data=None if data is None else json.dumps(data).encode())
    with urllib.request.urlopen(req,timeout=280) as r:return json.load(r)
machines=api('/v1/machines').get('machines',[])
machine=next((m for m in machines if m.get('name')=='li'),machines[0] if len(machines)==1 else None)
if not machine:raise RuntimeError('Configured VM was not found')
state=api('/v1/machines/'+machine['id'])
print('MACHINE '+json.dumps({k:state.get(k) for k in ('state','runStartedAt','cooldownUntil')}),flush=True)
if os.environ.get('XIN_DIAG_MODE')=='native-profile':
    from datetime import datetime,timezone
    cooling=state.get('cooldownUntil') and datetime.fromisoformat(state['cooldownUntil'].replace('Z','+00:00'))>datetime.now(timezone.utc)
    if state.get('state')!='running' or cooling:
        print('NATIVE_PROFILE_DEFERRED_NOT_RUNNING_OR_COOLDOWN',flush=True);sys.exit(0)
    source=Path('scripts/probe-xin-native-profile.cjs').read_text()
    result=api('/v1/machines/'+machine['id']+'/exec',{'argv':['node','-e',source],'timeoutSeconds':160})
    if result.get('exitCode')!=0:raise RuntimeError('Native profile synthetic preflight did not complete')
    evidence=json.loads(result.get('stdout','{}'));print('NATIVE_PROFILE '+json.dumps(evidence,ensure_ascii=True),flush=True);sys.exit(0)
if os.environ.get('XIN_DIAG_MODE')=='native-storage':
    if state.get('state')!='running':
        print('NATIVE_STORAGE_DEFERRED_NOT_RUNNING',flush=True);sys.exit(0)
    source=r'''
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),home='/data/home';
const candidates=['.local/bin/agy','.gemini/bin/agy'].map(x=>path.join(home,x)),binary=candidates.find(p=>fs.existsSync(p));
const out={available:!!binary,roots:{},help:{},storage:{}};
if(binary)for(const args of [['--help'],['acp','--help']]){const r=cp.spawnSync(binary,args,{encoding:'utf8',timeout:6000,env:{HOME:home,PATH:'/usr/local/bin:/usr/bin:/bin'}});out.help[args.join(' ')]={status:r.status,text:((r.stdout||'')+(r.stderr||'')).replace(/\x1b\[[0-9;]*m/g,'').slice(0,18000)};}
const safe=s=>/^[a-f0-9-]{16,}$/i.test(s)?'<id>':s.replace(/[a-f0-9]{24,}/ig,'<id>');
for(const rel of ['.gemini','.gemini/antigravity-cli','.gemini/antigravity','.gemini/tmp','.local/share/agy']){
 const root=path.join(home,rel);try{out.roots[rel]=fs.readdirSync(root,{withFileTypes:true}).slice(0,60).map(e=>({name:safe(e.name),directory:e.isDirectory(),extension:e.isFile()?path.extname(e.name):null}));}catch{out.roots[rel]=null;}
}
const {DatabaseSync}=require('node:sqlite');
for(const rel of ['.gemini/antigravity-cli','.gemini/antigravity']){
 const root=path.join(home,rel),info={};
 for(const folder of ['conversations','brain','annotations','log','implicit','cache']){try{const list=fs.readdirSync(path.join(root,folder),{withFileTypes:true});info[folder]={count:list.length,shapes:list.slice(0,8).map(e=>({directory:e.isDirectory(),uuid:/^[a-f0-9-]{36}(?:\.[a-z0-9]+)?$/i.test(e.name),extension:e.isFile()?path.extname(e.name):null}))};}catch{}}
 const file=path.join(root,'conversation_summaries.db');if(fs.existsSync(file)){const db=new DatabaseSync(file,{readOnly:true});try{info.schema=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t=>({table:t.name,columns:db.prepare('PRAGMA table_info("'+t.name.replaceAll('"','""')+'")').all().map(c=>({name:c.name,type:c.type}))}));}finally{db.close();}}
 out.storage[rel]=info;
}
process.stdout.write(JSON.stringify(out));'''
    r=api('/v1/machines/'+machine['id']+'/exec',{'argv':['node','-e',source],'timeoutSeconds':35})
    if r.get('exitCode')!=0:raise RuntimeError('Native storage inspection failed')
    print('NATIVE_STORAGE '+json.dumps(json.loads(r.get('stdout','{}')),ensure_ascii=True),flush=True);sys.exit(0)
if state.get('cooldownUntil'):
    from datetime import datetime,timezone
    if datetime.fromisoformat(state['cooldownUntil'].replace('Z','+00:00'))>datetime.now(timezone.utc):
        print('DIAGNOSE_DEFERRED_COOLDOWN',flush=True);sys.exit(0)
if state.get('state')!='running':
    api('/v1/machines/'+machine['id']+('/start' if state.get('state')=='stopped' else '/resume'),{})
    for _ in range(15):
        state=api('/v1/machines/'+machine['id'])
        if state.get('state')=='running':break
        time.sleep(2)
    if state.get('state')!='running':raise RuntimeError('VM did not become ready after cooldown')
source=Path('scripts/probe-xin-reply.cjs').read_text()
def probe(entry,mode,label):
    result=api('/v1/machines/'+machine['id']+'/exec',{'argv':['node','-e',source,entry,mode],'timeoutSeconds':240 if mode=='native' else 150})
    if result.get('exitCode')!=0:raise RuntimeError('Synthetic diagnosis failed, exit '+str(result.get('exitCode')))
    evidence=json.loads(result.get('stdout','{}'))
    print(label+' '+json.dumps(evidence,ensure_ascii=True),flush=True)
    return evidence

if os.environ.get('XIN_DIAG_MODE')=='memory-and-native':
    result=api('/v1/machines/'+machine['id']+'/exec',{'argv':['node','-e',Path('scripts/maintain-xin-front.cjs').read_text()],'timeoutSeconds':100})
    print('MEMORY_AND_CAPABILITIES '+json.dumps(json.loads(result.get('stdout','{}')),ensure_ascii=True),flush=True)
    if result.get('exitCode')!=0:raise RuntimeError('Bounded maintenance failed')
elif os.environ.get('XIN_DIAG_MODE')!='protocol':
    probe('/data/home/.xin/agent/vm-agent-158f619f9dcc.mjs','inspect','BASELINE_EVIDENCE')
uploaded=set()
def bundle(root):
    names={};active=set()
    def visit(name):
        if name in names:return names[name]
        if name in active:raise RuntimeError('Module import cycle')
        active.add(name);text=(root/name).read_text();deps=set(re.findall(r"from '\./(vm-[a-z0-9-]+\.mjs)'",text))
        for dep in sorted(deps):text=text.replace("from './"+dep+"'","from './"+visit(dep)+"'")
        hashed=name[:-4]+'-'+hashlib.sha256(text.encode()).hexdigest()[:12]+'.mjs';target='/data/home/.xin/agent/'+hashed
        if hashed not in uploaded:
            req=urllib.request.Request(API+'/v1/machines/'+machine['id']+'/files?'+urllib.parse.urlencode({'path':target,'parents':'true','mode':'0644'}),method='PUT',headers={'X-API-Key':key,'Content-Type':'application/octet-stream'},data=text.encode())
            with urllib.request.urlopen(req,timeout=30) as r:r.read()
            uploaded.add(hashed)
        names[name]=hashed;active.remove(name);return hashed
    return '/data/home/.xin/agent/'+visit('vm-agent.mjs')
if os.environ.get('XIN_DIAG_MODE') not in ('memory-and-native','protocol'):probe(bundle(Path('site/xin')),'deepseek','CANDIDATE_DEEPSEEK_EVIDENCE')
native=probe(bundle(Path('.diagnostic-opus/site/xin')),'native','CANDIDATE_OPUS_EVIDENCE')
if os.environ.get('XIN_DIAG_MODE')=='protocol' and not (native.get('initial',{}).get('text',[False])[0] and native.get('image',{}).get('pixelAnswerMatches') and native.get('image',{}).get('tasks')==0):
    raise RuntimeError('Native foreground protocol or direct image verification failed')
