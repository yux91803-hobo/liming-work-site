const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync,execFileSync}=require('node:child_process');
const script=path.resolve(__dirname,'../scripts/ci-proof.mjs');
test('只有同一 PR 运行的两份成功证据且 Git 树相同才复用；代码改动、错来源、缺证据均拒绝',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ci-proof-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'}).toString().trim();
  git('init','-q');fs.writeFileSync(root+'/app.txt','tested code');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
  const head=git('rev-parse','HEAD'),event=root+'/.git/event.json';fs.writeFileSync(event,JSON.stringify({pull_request:{head:{sha:head}}}));
  const env={...process.env,GITHUB_EVENT_NAME:'pull_request',GITHUB_EVENT_PATH:event,GITHUB_RUN_ID:'123',CI_CHECKED_HEAD:head,CI_CHECKED_RUN:'123'};
  const run=(args,extra={})=>spawnSync(process.execPath,[script,...args],{cwd:root,env:{...env,...extra},encoding:'utf8'});
  for(const kind of ['check','e2e'])assert.equal(run(['write',kind]).status,0);
  assert.equal(run(['verify']).status,0);
  git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','same tree, different commit');
  assert.equal(run(['verify']).status,0,'squash 等提交编号变化但代码树完全一致时可复用');
  assert.notEqual(run(['verify'],{CI_CHECKED_RUN:'124'}).status,0);
  assert.notEqual(run(['verify'],{CI_CHECKED_HEAD:'f'.repeat(40)}).status,0);
  fs.writeFileSync(root+'/app.txt','different code');assert.notEqual(run(['verify']).status,0,'未提交的代码变化也不能复用');git('add','app.txt');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','different tree');
  assert.notEqual(run(['verify']).status,0,'相同分支或相同 PR 编号也不能复用不同代码的测试');
  git('reset','--hard',head);fs.unlinkSync(root+'/.ci-proof/e2e.json');assert.notEqual(run(['verify']).status,0);
  assert.notEqual(run(['write','check'],{GITHUB_EVENT_NAME:'push'}).status,0);
});
test('正式发布只选对应合并的同仓库 PR 成功运行；失败运行、过期证据、别的 head 或 fork 均不能复用',async()=>{
  const yaml=fs.readFileSync(path.resolve(__dirname,'../.github/workflows/deploy.yml'),'utf8');
  const body=yaml.match(/\n          script: \|\n((?: {12}[^\n]*\n|\n)+)/)?.[1];assert.ok(body,'存在正式发布的来源核对脚本');
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const execute=new AsyncFunction('github','context','core',body.split('\n').map(l=>l.slice(12)).join('\n'));
  const head='a'.repeat(40),merged='b'.repeat(40);
  async function run(changes={}){
    const outputs={},p={merged:true,merge_commit_sha:merged,number:94,base:{ref:'main'},head:{sha:head,repo:{full_name:'owner/site'}},...changes.pr};
    const source={id:77,conclusion:'success',head_sha:head,...changes.run};
    const artifacts=changes.artifacts||['tested-tree-check','tested-tree-e2e'].map(name=>({name,expired:false}));
    const rest={repos:{listPullRequestsAssociatedWithCommit:()=>{}},pulls:{get:async()=>({data:p})},actions:{listWorkflowRunArtifacts:()=>{},listWorkflowRuns:async()=>({data:{workflow_runs:[{...source,id:76,conclusion:'failure'},source]}})}};
    const github={rest,paginate:async(fn,args)=>fn===rest.repos.listPullRequestsAssociatedWithCommit?[{number:94}]:
      fn===rest.actions.listWorkflowRunArtifacts?(assert.equal(args.run_id,77),artifacts):assert.fail('unexpected endpoint')};
    await execute(github,{repo:{owner:'owner',repo:'site'},sha:merged},{setOutput:(k,v)=>{outputs[k]=v;},info:()=>{}});return outputs;
  }
  assert.deepEqual(await run(),{run:'77',head});
  await assert.rejects(run({run:{head_sha:'c'.repeat(40)}}));
  await assert.rejects(run({run:{conclusion:'failure'}}));
  await assert.rejects(run({artifacts:[{name:'tested-tree-check',expired:false},{name:'tested-tree-e2e',expired:true}]}));
  await assert.rejects(run({pr:{merge_commit_sha:'c'.repeat(40)}}));
  await assert.rejects(run({pr:{head:{sha:head,repo:{full_name:'outsider/fork'}}}}));
});
// 2026-11-14 运行 43559539100：同一个 e2e 作业在执行机上被跑了两遍，先结束的那遍传了报告，后结束的那遍（测试全过）因为报告同名得到 409，正式站没有部署
test('浏览器检查报告的名字每次执行都不同：同一个作业被跑两遍时不会因为同名而失败',()=>{
  const yaml=fs.readFileSync(path.resolve(__dirname,'../.github/workflows/deploy.yml'),'utf8');
  const step=yaml.indexOf('浏览器端到端测试'),stamp=yaml.indexOf('echo "E2E_REPORT_ID=$(date +%s%N)-$$" >> "$GITHUB_ENV"'),first=yaml.indexOf('python test/e2e/stm32_e2e.py');
  assert.ok(step>0&&stamp>step&&stamp<first,'测试那一步一开头就定下这次执行自己的编号（测试失败时也已经有了）');
  assert.match(yaml,/name: e2e-report-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ env\.E2E_REPORT_ID \}\}\n/);
});
