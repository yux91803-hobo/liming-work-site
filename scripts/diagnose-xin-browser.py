"""Bounded browser preflight; no VM wake, owner history reads, login or data deletion."""
import hashlib,json,os,re,signal,sys,urllib.parse,urllib.request
from datetime import datetime,timezone
from pathlib import Path

API='https://api.instabox.sh'
key=os.environ.get('XIN_INSTABOX_API_KEY','')
if not key:raise RuntimeError('Configured InstaBox credential is required')
def expired(*_):raise TimeoutError('Browser preflight total deadline exceeded')
signal.signal(signal.SIGALRM,expired);signal.alarm(360)
def api(route,data=None,timeout=20):
    req=urllib.request.Request(API+route,headers={'X-API-Key':key,'Content-Type':'application/json'},data=None if data is None else json.dumps(data).encode())
    with urllib.request.urlopen(req,timeout=timeout) as r:return json.load(r)
machines=api('/v1/machines').get('machines',[])
machine=next((m for m in machines if m.get('name')=='li'),machines[0] if len(machines)==1 else None)
if not machine:raise RuntimeError('Configured VM was not found')
state=api('/v1/machines/'+machine['id'])
print('MACHINE '+json.dumps({k:state.get(k) for k in ('state','runStartedAt','cooldownUntil')}),flush=True)
cooling=state.get('cooldownUntil') and datetime.fromisoformat(state['cooldownUntil'].replace('Z','+00:00'))>datetime.now(timezone.utc)
if state.get('state')!='running' or cooling:
    print('BROWSER_PREFLIGHT_DEFERRED_NOT_RUNNING_OR_COOLDOWN',flush=True);sys.exit(0)
root=Path('.diagnostic-browser/site/xin');names={}
def bundle(name):
    if name in names:return names[name]
    text=(root/name).read_text()
    for dep in sorted(set(re.findall(r"from '\./(vm-[a-z0-9-]+\.mjs)'",text))):text=text.replace("from './"+dep+"'","from './"+bundle(dep)+"'")
    hashed=name[:-4]+'-'+hashlib.sha256(text.encode()).hexdigest()[:12]+'.mjs'
    target='/data/home/.xin/diagnostic/browser-modules/'+hashed
    req=urllib.request.Request(API+'/v1/machines/'+machine['id']+'/files?'+urllib.parse.urlencode({'path':target,'parents':'true','mode':'0644'}),method='PUT',headers={'X-API-Key':key,'Content-Type':'application/octet-stream'},data=text.encode())
    with urllib.request.urlopen(req,timeout=30) as r:r.read()
    names[name]=hashed
    return hashed
worker=os.environ.get('XIN_BROWSER_PROBE')=='native-worker'
entries=['vm-native-worker.mjs','vm-native-profiles.mjs','vm-base.mjs','vm-runtime.mjs'] if worker else ['vm-browser-service.mjs','vm-runtime.mjs','vm-base.mjs','vm-browser-driver.mjs']
paths=['/data/home/.xin/diagnostic/browser-modules/'+bundle(n) for n in entries]
print('BROWSER_PREFLIGHT_PHASE uploaded '+str(len(names))+' code modules',flush=True)
source=Path('scripts/probe-xin-native-worker.cjs' if worker else 'scripts/probe-xin-browser.cjs').read_text()
result=api('/v1/machines/'+machine['id']+'/exec',{'argv':['node','-e',source,*paths],'timeoutSeconds':140 if worker else 240},timeout=160 if worker else 260)
rows=[]
for line in result.get('stdout','').splitlines():
    try:rows.append(json.loads(line))
    except (ValueError,TypeError):pass
print('BROWSER_PHASES '+json.dumps([r['phase'] for r in rows if isinstance(r,dict) and set(r)=={'phase'}]),flush=True)
print('BROWSER_EXEC '+json.dumps({'exitCode':result.get('exitCode'),'stderrBytes':len(result.get('stderr','').encode())}),flush=True)
evidence=next((r for r in reversed(rows) if isinstance(r,dict) and set(r)!={'phase'}),{})
print('BROWSER_PREFLIGHT '+json.dumps(evidence),flush=True)
if result.get('exitCode')!=0 or evidence.get('error') or not evidence.get('pixelAnswerMatches' if worker else 'recoveredURL'):raise RuntimeError('Real native worker preflight failed' if worker else 'Real browser and sandbox preflight failed')
