// Read one synthetic E2E job's log using the runner's short-lived repository token.
// Fetch strips Authorization across the GitHub -> blob-storage redirect.
const fs=require('node:fs');
(async()=>{
 const token=process.env.GITHUB_TOKEN;if(!token)throw Error('Repository token is required');
 const response=await fetch('https://api.github.com/repos/yux91803-hobo/liming-work-site/actions/jobs/128916291097/logs',{headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'},signal:AbortSignal.timeout(45000)});
 console.log(JSON.stringify({phase:'job-log',status:response.status}));if(!response.ok){
  const path=require('node:path'),cp=require('node:child_process'),diag='/var/lib/liming-actions/runner/_diag';
  const listed=cp.spawnSync('rg',['--files','--hidden',diag],{encoding:'utf8',maxBuffer:1024*1024}),from=Date.parse('2026-11-09T00:37:00Z'),until=Date.parse('2026-11-09T00:48:00Z');
  const files=(listed.stdout||'').split('\n').filter(Boolean).filter(f=>{try{const s=fs.lstatSync(f);return s.isFile()&&!s.isSymbolicLink()&&s.size<8*1024*1024&&s.mtimeMs>=from&&s.mtimeMs<=until;}catch{return false;}});
  const redacted=s=>s.replace(/https?:\/\/\S+/g,'[url]').replace(/[A-Za-z0-9_+-]{32,}/g,'[id]').replace(/((?:token|password|secret|authorization)\s*[:=]\s*)\S+/ig,'$1[hidden]');
  const excerpts=[];
  for(const file of files){const content=fs.readFileSync(file,'utf8'),lines=content.split('\n').filter(l=>/FAIL |Traceback|TimeoutError|AssertionError|test\/e2e\/|(?:ERR|WARN).*?(?:ProcessInvoker|Worker|JobRunner|JobServerQueue)|exit code|Exit code/i.test(l)).slice(-50).map(redacted);excerpts.push({file:path.relative(diag,file),bytes:Buffer.byteLength(content),lines});}
  console.log(JSON.stringify({phase:'runner-local-test-logs',files:excerpts},null,2));
  fs.mkdirSync('.diagnostic',{recursive:true});fs.writeFileSync('.diagnostic/failed-e2e.log',JSON.stringify(excerpts,null,2),{mode:0o600});return;
 }
 const text=await response.text();fs.mkdirSync('.diagnostic',{recursive:true});fs.writeFileSync('.diagnostic/failed-e2e.log',text,{mode:0o600});
 const failures=text.split('\n').filter(l=>/FAIL |Traceback|TimeoutError|AssertionError|Error:|File ".*test\/e2e\//.test(l));
 console.log(JSON.stringify({bytes:Buffer.byteLength(text),failureLines:failures.slice(-50)},null,2));
})().catch(()=>{console.log('Cannot read synthetic E2E job log');process.exitCode=1;});
