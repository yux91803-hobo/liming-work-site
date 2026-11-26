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
    const source={id:77,status:'completed',conclusion:'success',head_sha:head,...changes.run};
    const artifacts=changes.artifacts||['tested-tree-check','tested-tree-e2e'].map(name=>({name,expired:false}));
    const rest={repos:{listPullRequestsAssociatedWithCommit:()=>{}},pulls:{get:async()=>({data:p})},actions:{listWorkflowRunArtifacts:()=>{},listWorkflowRuns:async({status})=>({data:{
      // #205 的成功重跑在指定 status 时查不到，不指定则返回最终结论。
      workflow_runs:status?[]:[{...source,id:76,conclusion:'failure'},source]
    }})}};
    const github={rest,paginate:async(fn,args)=>fn===rest.repos.listPullRequestsAssociatedWithCommit?[{number:94}]:
      fn===rest.actions.listWorkflowRunArtifacts?(assert.equal(args.run_id,77),artifacts):assert.fail('unexpected endpoint')};
    await execute(github,{repo:{owner:'owner',repo:'site'},sha:merged},{setOutput:(k,v)=>{outputs[k]=v;},info:()=>{}});return outputs;
  }
  assert.deepEqual(await run(),{run:'77',head});
  await assert.rejects(run({run:{head_sha:'c'.repeat(40)}}));
  await assert.rejects(run({run:{conclusion:'failure'}}));
  await assert.rejects(run({run:{status:'in_progress'}}));
  await assert.rejects(run({artifacts:[{name:'tested-tree-check',expired:false},{name:'tested-tree-e2e',expired:true}]}));
  await assert.rejects(run({pr:{merge_commit_sha:'c'.repeat(40)}}));
  await assert.rejects(run({pr:{head:{sha:head,repo:{full_name:'outsider/fork'}}}}));
});
// 43572318127 再次出现相同启动编号的 409；名字必须对应实际上传快照，不能依赖测试开始时的环境变量。
test('浏览器报告在测试结束后保存快照，再上传该快照：失败报告也保留，不覆盖先前结果',()=>{
  const yaml=fs.readFileSync(path.resolve(__dirname,'../.github/workflows/deploy.yml'),'utf8');
  const last=yaml.indexOf('python test/e2e/home_e2e.py'),snapshot=yaml.indexOf('准备浏览器检查报告快照'),upload=yaml.indexOf('保存浏览器检查报告');
  assert.ok(last>0&&snapshot>last&&upload>snapshot);
  const prepare=yaml.slice(snapshot,upload),save=yaml.slice(upload,yaml.indexOf('记录浏览器测试通过的代码树'));
  assert.match(prepare,/if: always\(\)/);assert.match(prepare,/id: e2e_report/);assert.match(prepare,/run: node scripts\/ci-e2e-report\.mjs/);
  assert.match(save,/if: always\(\)/);assert.match(save,/name: \$\{\{ steps\.e2e_report\.outputs\.name \}\}/);assert.match(save,/path: \$\{\{ steps\.e2e_report\.outputs\.path \}\}/);
  assert.doesNotMatch(save,/overwrite: true|continue-on-error/);
});

test('报告快照：复制过的启动编号相同时，不同结果仍有不同名字，源日志变化不改变已保存报告',async t=>{
  const {snapshotReport}=await import('../scripts/ci-e2e-report.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ci-report-')),root=path.join(dir,'checkout'),temporary=path.join(dir,'tmp');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'test-results/e2e'),{recursive:true});
  const file=path.join(root,'test-results/e2e/stm32.log');fs.writeFileSync(file,'FAIL splash timeout');fs.writeFileSync(path.join(root,'preview.log'),'preview ready');
  const options={root,temporary,run:'1',attempt:'2',nonce:'cloned-id'};
  const a=snapshotReport(options);fs.writeFileSync(file,'PASS all checks');const b=snapshotReport(options);
  assert.notEqual(a.name,b.name);assert.notEqual(a.path,b.path);
  assert.equal(fs.readFileSync(path.join(a.path,'test-results/e2e/stm32.log'),'utf8'),'FAIL splash timeout');
  assert.equal(fs.readFileSync(path.join(b.path,'test-results/e2e/stm32.log'),'utf8'),'PASS all checks');
  assert.equal(fs.statSync(a.path).mode&0o777,0o700);
});

test('报告快照：相同内容的两次上传也使用新编号；不把其它文件带进报告',async t=>{
  const {snapshotReport}=await import('../scripts/ci-e2e-report.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ci-report-')),root=path.join(dir,'checkout');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'test-results/e2e'),{recursive:true});fs.writeFileSync(path.join(root,'test-results/e2e/one.log'),'PASS');fs.writeFileSync(path.join(root,'private.env'),'not a report');
  fs.mkdirSync(path.join(root,'screens'));fs.writeFileSync(path.join(root,'screens/stm32-drag-failure.png'),'PNG');fs.writeFileSync(path.join(root,'screens/private.png'),'not a report');
  const options={root,temporary:path.join(dir,'tmp'),run:'3',attempt:'1'},a=snapshotReport(options),b=snapshotReport(options);
  assert.equal(a.digest,b.digest);assert.notEqual(a.name,b.name);assert.equal(fs.existsSync(path.join(a.path,'private.env')),false);
  assert.deepEqual(a.files,['screens/stm32-drag-failure.png','test-results/e2e/one.log']);
});

test('报告快照：拒绝指向其它文件的链接和不合法的运行编号',async t=>{
  const {snapshotReport}=await import('../scripts/ci-e2e-report.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ci-report-')),root=path.join(dir,'checkout');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(root);const outside=path.join(dir,'outside');fs.writeFileSync(outside,'private');fs.symlinkSync(outside,path.join(root,'preview.log'));
  assert.throws(()=>snapshotReport({root,temporary:path.join(dir,'tmp'),run:'1',attempt:'1'}),/link|普通文件/);
  assert.throws(()=>snapshotReport({root,temporary:path.join(dir,'tmp'),run:'1\nbad',attempt:'1'}),/编号/);
});
