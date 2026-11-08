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
    files=sorted(glob.glob('/var/lib/liming-actions/runner/_diag/'+kind+'_*.log'),key=os.path.getmtime)[-3:]
    for file in files:
        with open(file,'rb') as f:
            f.seek(max(0,os.path.getsize(file)-1024*1024));body=f.read().decode(errors='replace')
        samples.append({'kind':kind,'at':int(os.path.getmtime(file)),
            'memoryErrors':len(re.findall(r'OutOfMemory|heap out of memory|ENOMEM',body,re.I)),
            'killed':len(re.findall(r'SIGKILL|\bkilled\b',body,re.I)),
            'terminated':len(re.findall(r'SIGTERM|\bterminated\b',body,re.I)),
            'connectionErrors':len(re.findall(r'lost.*connection|disconnect|connection.*(?:lost|fail|close)',body,re.I)),
            'cancelled':len(re.findall(r'cancelled|canceled|abandoned',body,re.I)),
            'exitCodes':re.findall(r'exit(?:ed)? (?:with )?code[: =]+(-?\d+)',body,re.I)[-8:]})
metrics['runnerLogCounters']=samples
print('BOX_COUNTERS '+json.dumps(metrics),flush=True)
