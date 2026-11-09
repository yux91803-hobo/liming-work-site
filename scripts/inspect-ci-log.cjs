// Read one synthetic E2E job's log using the runner's short-lived repository token.
// Fetch strips Authorization across the GitHub -> blob-storage redirect.
const fs=require('node:fs');
(async()=>{
 const token=process.env.GITHUB_TOKEN;if(!token)throw Error('Repository token is required');
 const response=await fetch('https://api.github.com/repos/yux91803-hobo/liming-work-site/actions/jobs/128916291097/logs',{headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'},signal:AbortSignal.timeout(45000)});
 console.log(JSON.stringify({phase:'job-log',status:response.status}));if(!response.ok){process.exitCode=1;return;}
 const text=await response.text();fs.mkdirSync('.diagnostic',{recursive:true});fs.writeFileSync('.diagnostic/failed-e2e.log',text,{mode:0o600});
 const failures=text.split('\n').filter(l=>/FAIL |Traceback|TimeoutError|AssertionError|Error:|File ".*test\/e2e\//.test(l));
 console.log(JSON.stringify({bytes:Buffer.byteLength(text),failureLines:failures.slice(-50)},null,2));
})().catch(()=>{console.log('Cannot read synthetic E2E job log');process.exitCode=1;});
