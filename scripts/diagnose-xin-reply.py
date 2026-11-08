"""One read-only VM exec. Print only failure categories and counters from the failed deployment's time window."""
import json,os,sys,urllib.request
API='https://api.instabox.sh'
key=os.environ.get('XIN_INSTABOX_API_KEY','')
if not key:raise RuntimeError('Configured InstaBox credential is required')
def api(route,data=None):
    req=urllib.request.Request(API+route,headers={'X-API-Key':key,'Content-Type':'application/json'},data=None if data is None else json.dumps(data).encode())
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
source=open('scripts/probe-xin-reply.cjs').read()
result=api('/v1/machines/'+machine['id']+'/exec',{'argv':['node','-e',source],'timeoutSeconds':150})
if result.get('exitCode')!=0:raise RuntimeError('Read-only diagnosis failed, exit '+str(result.get('exitCode')))
evidence=json.loads(result.get('stdout','{}'))
print('FRONT_EVIDENCE '+json.dumps(evidence,ensure_ascii=True),flush=True)
