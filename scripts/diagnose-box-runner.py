"""Read only counters from this CI account. Never print environment values or runner log bodies."""
import glob,json,os,re,subprocess
from pathlib import Path
metrics={'cpus':os.cpu_count(),'load':os.getloadavg()}
try:
    mem=dict((k,int(v)) for k,v in re.findall(r'^(MemTotal|MemAvailable):\s+(\d+)',Path('/proc/meminfo').read_text(),re.M))
    metrics['memoryKiB']=mem
except OSError:pass
version=subprocess.run(['node','-p','process.version'],text=True,capture_output=True,timeout=5).stdout.strip()
metrics['node']=version if re.fullmatch(r'v[0-9.]+',version) else 'unknown'
samples=[]
for kind in ['Worker','Runner']:
    files=sorted(glob.glob('/var/lib/liming-actions/runner/_diag/'+kind+'_*.log'),key=os.path.getmtime)[-10:]
    for file in files:
        with open(file,'rb') as f:
            f.seek(max(0,os.path.getsize(file)-1024*1024));body=f.read().decode(errors='replace')
        lines=[s for s in body.splitlines() if re.search(r'2026-11-09[ T]12:[1-5][0-9]:',s)]
        body='\n'.join(lines)
        if not body:continue
        samples.append({'kind':kind,'at':int(os.path.getmtime(file)),'linesInDeploymentWindow':len(lines),
            'memoryErrors':len(re.findall(r'OutOfMemory|heap out of memory|ENOMEM',body,re.I)),
            'killed':len(re.findall(r'SIGKILL|\bkilled\b',body,re.I)),
            'terminated':len(re.findall(r'SIGTERM|\bterminated\b',body,re.I)),
            'connectionErrors':len(re.findall(r'lost.*connection|disconnect|connection.*(?:lost|fail|close)',body,re.I)),
            'cancelled':len(re.findall(r'cancelled|canceled|abandoned',body,re.I)),
            'timeouts':len(re.findall(r'timed out|TimeoutException|TaskCanceledException',body,re.I)),
            'sessionConflict':len(re.findall(r'session.*(?:conflict|already exists)|\b409\b',body,re.I)),
            'jobMissing':len(re.findall(r'job.*(?:not found|abandon)|abandoned',body,re.I)),
            'httpErrorCodes':sorted(set(re.findall(r'\b(?:401|403|404|408|429|500|502|503|504)\b',body))),
            'exceptionTypes':sorted(set(re.findall(r'\b(?:System\.)?[A-Za-z][A-Za-z0-9.]{0,100}Exception\b',body)))[:20],
            'errorComponents':sorted(set(re.findall(r'\b(?:ERR|WARN) ([A-Za-z][A-Za-z0-9.]{0,60})\]',body)))[:20],
            'exitCodes':re.findall(r'exit(?:ed)? (?:with )?code[: =]+(-?\d+)',body,re.I)[-8:]})
metrics['runnerLogCounters']=samples
pages=[]
for folder in ['pages','blocks']:
    for p in sorted(Path('/var/lib/liming-actions/runner/_diag',folder).glob('*'),key=lambda p:p.stat().st_mtime)[-25:]:
        if not p.is_file() or p.stat().st_mtime<1794228300:continue
        with p.open('rb') as f:
            f.seek(max(0,p.stat().st_size-2*1024*1024));body=f.read().decode(errors='replace')
        passed=[int(n) for n in re.findall(r'\bok (\d+) -',body)]
        failed=[int(n) for n in re.findall(r'\bnot ok (\d+) -',body)]
        if passed or failed:pages.append({'kind':folder,'at':int(p.stat().st_mtime),'maxPassedTest':max(passed,default=0),'failedTestNumbers':failed[-10:],'summary':re.findall(r'# (?:tests|pass|fail|cancelled|skipped|duration_ms) [0-9.]+',body)[-8:]})
metrics['recentTestOutputCounters']=pages
print('BOX_COUNTERS '+json.dumps(metrics),flush=True)
