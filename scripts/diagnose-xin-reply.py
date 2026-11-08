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
    with urllib.request.urlopen(req,timeout=170) as r:return json.load(r)
machines=api('/v1/machines').get('machines',[])
machine=next((m for m in machines if m.get('name')=='li'),machines[0] if len(machines)==1 else None)
if not machine:raise RuntimeError('Configured VM was not found')
state=api('/v1/machines/'+machine['id'])
print('MACHINE '+json.dumps({k:state.get(k) for k in ('state','runStartedAt','cooldownUntil')}),flush=True)
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
    result=api('/v1/machines/'+machine['id']+'/exec',{'argv':['node','-e',source,entry,mode],'timeoutSeconds':150})
    if result.get('exitCode')!=0:raise RuntimeError('Synthetic diagnosis failed, exit '+str(result.get('exitCode')))
    evidence=json.loads(result.get('stdout','{}'))
    print(label+' '+json.dumps(evidence,ensure_ascii=True),flush=True)

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
probe(bundle(Path('site/xin')),'deepseek','CANDIDATE_DEEPSEEK_EVIDENCE')
probe(bundle(Path('.diagnostic-opus/site/xin')),'native','CANDIDATE_OPUS_EVIDENCE')
