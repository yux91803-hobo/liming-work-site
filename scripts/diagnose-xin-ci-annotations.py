"""Read only the two failed jobs' GitHub transport annotations; never print credentials or test bodies."""
import json,os,re,urllib.error,urllib.request
token=os.environ.get('XIN_DIAG_GITHUB_TOKEN','')
if not token:raise RuntimeError('Ephemeral job token is required')
for job in (129152263533,129164349320):
    req=urllib.request.Request('https://api.github.com/repos/yux91803-hobo/liming-work-site/check-runs/'+str(job)+'/annotations?per_page=100',headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
    try:
        with urllib.request.urlopen(req,timeout=20) as response:rows=json.load(response)
        records=[]
        for row in rows:
            message=str(row.get('message',''));lost=bool(re.search(r'(?:self.hosted runner|runner).*lost communication|lost communication.*runner',message,re.I))
            record={'level':row.get('annotation_level'),'runnerLostCommunication':lost,'timeout':bool(re.search('timed out|timeout',message,re.I))}
            if lost:record['transportReason']=re.sub(r'https?://\S+','<url>',message)[:700]
            records.append(record)
        print('GITHUB_JOB_ANNOTATIONS '+json.dumps({'job':job,'annotations':records}),flush=True)
    except urllib.error.HTTPError as e:print('GITHUB_JOB_ANNOTATIONS '+json.dumps({'job':job,'httpStatus':e.code}),flush=True)
