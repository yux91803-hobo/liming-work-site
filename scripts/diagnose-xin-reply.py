"""One read-only VM exec. Print only failure categories and counters from the failed deployment's time window."""
import json,os,sys,urllib.request
API='https://api.instabox.sh'
key=os.environ.get('XIN_INSTABOX_API_KEY','')
if not key:raise RuntimeError('Configured InstaBox credential is required')
def api(route,data=None):
    req=urllib.request.Request(API+route,headers={'X-API-Key':key,'Content-Type':'application/json'},data=None if data is None else json.dumps(data).encode())
    with urllib.request.urlopen(req,timeout=60) as r:return json.load(r)
machines=api('/v1/machines').get('machines',[])
machine=next((m for m in machines if m.get('name')=='li'),machines[0] if len(machines)==1 else None)
if not machine:raise RuntimeError('Configured VM was not found')
state=api('/v1/machines/'+machine['id'])
print('MACHINE '+json.dumps({k:state.get(k) for k in ('state','runStartedAt','cooldownUntil')}),flush=True)
if state.get('cooldownUntil'):
    from datetime import datetime,timezone
    if datetime.fromisoformat(state['cooldownUntil'].replace('Z','+00:00'))>datetime.now(timezone.utc):
        print('DIAGNOSE_DEFERRED_COOLDOWN',flush=True);sys.exit(0)
source=r'''
const fs=require('node:fs'),path=require('node:path');
const base='/data/home/.xin',start=Date.parse('2026-11-08T14:07:00Z'),end=Date.parse('2026-11-08T14:11:00Z');
const lines=file=>{try{return fs.readFileSync(path.join(base,file),'utf8').split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});}catch{return [];}};
const category=s=>/前台未完成回复/.test(s)?'incomplete_response':/HTTP\s*(\d+)/.test(s)?'http_'+/HTTP\s*(\d+)/.exec(s)[1]:/time.?out|超时/i.test(s)?'timeout':/sqlite|database.*lock/i.test(s)?'database':/abort|cancel|停止/i.test(s)?'cancelled':'other';
const failure=lines('logs/front.jsonl').filter(e=>e.at>=start&&e.at<=end).map(e=>({at:new Date(e.at).toISOString(),outcome:e.outcome,errorType:category(e.error||''),calls:(e.calls||[]).map(c=>({call:c.call,errorType:c.error?category(c.error):null}))}));
const stats=lines('model-stats.jsonl').filter(e=>e.at>=start&&e.at<=end&&e.kind==='chat').map(e=>({at:new Date(e.at).toISOString(),model:e.model,ok:e.ok,ms:e.ms,usage:e.usage}));
process.stdout.write(JSON.stringify({failure,stats}));
'''
result=api('/v1/machines/'+machine['id']+'/exec',{'argv':['node','-e',source],'timeoutSeconds':30})
if result.get('exitCode')!=0:raise RuntimeError('Read-only diagnosis failed, exit '+str(result.get('exitCode')))
evidence=json.loads(result.get('stdout','{}'))
print('FRONT_EVIDENCE '+json.dumps(evidence,ensure_ascii=True),flush=True)
