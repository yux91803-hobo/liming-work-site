const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
const load = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-runtime.mjs')).href);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-runtime-test-'));
  for (const d of ['control/sessions', 'control/runs', 'project', 'profile', 'codex']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const env = { ...process.env, XIN_HOME: path.join(root, 'control'), XIN_WORK: root, CODEX_HOME: path.join(root, 'codex'), XIN_TASK_MAX: '1' };
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, `require('node:os').homedir=()=>${JSON.stringify(path.join(root, 'profile'))};require('node:module').syncBuiltinESMExports();`);
  env.NODE_OPTIONS = '--require=' + preload;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const call = (op, args) => {
    const r = spawnSync(process.execPath, [agent, 'locked', op], { env, input: JSON.stringify(args), encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const task = { sid: 'sruntime001', no: 1, kind: 'task', tkind: 'code', title: 'test', dir: path.join(root, 'project'), goal: 'test',
    status: 'running', model: 'glm-5.3', runs: ['rruntime001'], created: Date.now(), inbox: [] };
  const save = () => fs.writeFileSync(path.join(env.XIN_HOME, 'sessions', task.sid + '.json'), JSON.stringify(task));
  const read = () => JSON.parse(fs.readFileSync(path.join(env.XIN_HOME, 'sessions', task.sid + '.json')));
  save();
  fs.writeFileSync(path.join(env.XIN_HOME, 'runs/rruntime001.json'), JSON.stringify({ sid: task.sid, started: Date.now(), pid: process.pid }));
  fs.writeFileSync(path.join(env.XIN_HOME, 'runs/rruntime001.jsonl'), '');
  return { root, control: env.XIN_HOME, env, task, save, read, call };
}

test('分身修改副本，检查原文件并发变更；删除和冲突不会自动写回', async t => {
  const f = fixture(t), r = await load();
  fs.writeFileSync(path.join(f.task.dir, 'main.c'), 'original');
  fs.writeFileSync(path.join(f.task.dir, 'keep.txt'), 'keep');
  f.task.workspace = r.prepareWorkspace(f.task, f.control);
  fs.writeFileSync(path.join(f.task.workspace.work, 'main.c'), 'task edit');
  fs.unlinkSync(path.join(f.task.workspace.work, 'keep.txt'));
  fs.writeFileSync(path.join(f.task.dir, 'main.c'), 'foreground edit');
  const p = r.publishWorkspace(f.task, f.control);
  assert.equal(p.pending, true); assert.deepEqual(p.conflicts, ['main.c']); assert.deepEqual(p.deleted, ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(f.task.dir, 'main.c'), 'utf8'), 'foreground edit');
  assert.equal(fs.readFileSync(path.join(f.task.dir, 'keep.txt'), 'utf8'), 'keep');
  const done = r.publishWorkspace(f.task, f.control, true);
  assert.equal(done.ok, true); assert.equal(fs.readFileSync(path.join(f.task.dir, 'main.c'), 'utf8'), 'task edit');
  assert.equal(fs.existsSync(path.join(f.task.dir, 'keep.txt')), false);
  assert.equal(fs.readFileSync(path.join(done.backup, 'main.c'), 'utf8'), 'foreground edit');
});

test('新增文件和普通修改自动写回；中断恢复保留未完成的副本', async t => {
  const f = fixture(t), r = await load();
  fs.writeFileSync(path.join(f.task.dir, 'main.c'), 'original');
  f.task.workspace = r.prepareWorkspace(f.task, f.control);
  fs.writeFileSync(path.join(f.task.workspace.work, 'main.c'), 'partial');
  fs.mkdirSync(path.join(f.task.workspace.work, 'build'));
  fs.writeFileSync(path.join(f.task.workspace.work, 'build/app.hex'), ':00000001FF');
  const resumed = r.prepareWorkspace(f.task, f.control);
  assert.equal(fs.readFileSync(path.join(resumed.work, 'main.c'), 'utf8'), 'partial');
  assert.equal(fs.readFileSync(path.join(f.task.dir, 'main.c'), 'utf8'), 'original');
  assert.equal(r.publishWorkspace(f.task, f.control).files, 2);
  assert.equal(fs.readFileSync(path.join(f.task.dir, 'build/app.hex'), 'utf8'), ':00000001FF');
});

test('源项目和结果中出现软链接都拒绝，不读取或覆盖外部文件', async t => {
  const f = fixture(t), r = await load();
  fs.writeFileSync(path.join(f.root, 'outside'), 'outside');
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.task.dir, 'link'));
  assert.throws(() => r.prepareWorkspace(f.task, f.control), /软链接/);
  fs.unlinkSync(path.join(f.task.dir, 'link'));
  f.task.workspace = r.prepareWorkspace(f.task, f.control);
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.task.workspace.work, 'link'));
  assert.throws(() => r.publishWorkspace(f.task, f.control), /软链接/);
  assert.equal(fs.readFileSync(path.join(f.root, 'outside'), 'utf8'), 'outside');
});

test('权限配置禁止管理目录和凭据；shell 不继承网关 key，只开放项目副本', async t => {
  const f = fixture(t), r = await load(); f.task.workspace = r.prepareWorkspace(f.task, f.control);
  const flags = r.permissionArgs(f.task, f.control);
  const fsArg = flags.find(s => s.startsWith('permissions.xin-task.filesystem='));
  assert.ok(fsArg.includes(JSON.stringify(f.control) + '="deny"'));
  assert.ok(fsArg.includes(JSON.stringify(f.task.dir) + '="read"'));
  assert.ok(fsArg.includes(JSON.stringify(f.task.workspace.work) + '="write"'));
  assert.ok(flags.includes('shell_environment_policy.inherit="none"'));
  const env = flags.find(s => s.startsWith('shell_environment_policy.set='));
  assert.ok(!/KEY|TOKEN|CODEX_HOME/.test(env)); assert.ok(env.includes('XIN_TASK_IO'));
});

test('旧轮次退出不会完成当前的新轮次', t => {
  const f = fixture(t); f.task.runs.push('rruntime002'); f.save();
  fs.writeFileSync(path.join(f.control, 'runs/rruntime001.jsonl'), JSON.stringify({ t: 'text', text: 'old result' }) + '\n');
  assert.deepEqual(f.call('task_finish', { sid: f.task.sid, run: 'rruntime001', ok: true }), {});
  assert.equal(f.read().status, 'running'); assert.equal(f.read().result, undefined);
});

test('提出问题时尚未退出的任务仍占用目录和并发额度', t => {
  const f = fixture(t);
  f.call('task_ask', { sid: f.task.sid, question: '允许发布吗？' });
  assert.equal(f.read().status, 'running'); assert.equal(f.read().pendingQuestion, '允许发布吗？');
  const second = f.call('task_new', { goal: 'second', title: 'second', dir: f.task.dir });
  assert.equal(second.task.status, 'queued');
  f.call('task_stop', { sid: second.task.sid });
  f.call('task_finish', { sid: f.task.sid, run: 'rruntime001', ok: true });
  assert.equal(f.read().status, 'waiting');
});

test('STM32 检查要求针对最终源码编译，并写齐四项手册依据', async t => {
  const f = fixture(t), r = await load();
  fs.writeFileSync(path.join(f.task.dir,'main.c'),'#include "stm32f10x.h"\nint main(void){}');
  fs.writeFileSync(path.join(f.task.dir,'Makefile'),'CC=arm-none-eabi-gcc\n');
  f.task.tkind='review'; f.task.workspace=r.prepareWorkspace(f.task,f.control);
  assert.match(r.validateTask(f.task,f.control,{}).error,/成功编译记录/);
  const meta={compileTrusted:true,compileOk:true,compileDigest:r.sourceDigest(f.task.workspace.work)};
  assert.match(r.validateTask(f.task,f.control,{...meta,compileTrusted:false}).error,/成功编译记录/);
  assert.match(r.validateTask(f.task,f.control,meta).error,/xin-review.json/);
  fs.writeFileSync(path.join(f.task.workspace.work,'xin-review.json'),JSON.stringify({verdict:'pass',checks:['clock','pinmap','peripheral_clock','interrupt'].map(id=>({id,status:'pass',reference:'RM0008 RCC/AFIO/TIM',evidence:'main.c:1，已核对寄存器配置'}))}));
  assert.equal(r.validateTask(f.task,f.control,meta).reviewed,true);
  const report=JSON.parse(fs.readFileSync(path.join(f.task.workspace.work,'xin-review.json')));for(const c of report.checks)if(c.id!=='clock')delete c.reference;fs.writeFileSync(path.join(f.task.workspace.work,'xin-review.json'),JSON.stringify(report));
  const missing=r.validateTask(f.task,f.control,meta).error;for(const id of ['pinmap','peripheral_clock','interrupt'])assert.ok(missing.includes(id));
  fs.appendFileSync(path.join(f.task.workspace.work,'main.c'),'\n// later change');
  assert.match(r.validateTask(f.task,f.control,meta).error,/最终源码/);
});


test('所有 Codex 角色关闭原生分身，配置在容器转换后仍生效', async t => {
  const f=fixture(t),r=await load();f.task.workspace=r.prepareWorkspace(f.task,f.control);
  const {agentArgs}=await import(pathToFileURL(agent).href);
  for(const role of ['front','daily','task']){
    const [,args]=agentArgs('codex',f.task,'test','max',{role,sandbox:role==='task'});
    const config=[];for(let i=0;i<args.length;i++)if(args[i]==='-c')config.push('-c',args[++i]);
    const effective=role==='task'?r.containerAppServer(f.task,config,{proxy:{baseURL:'http://127.0.0.1:1/v1',token:'test-token'}}).args:config;
    assert.ok(effective.includes('features.multi_agent=false'),role);
    assert.ok(effective.includes('features.multi_agent_v2=false'),role);
  }
});

test('任务命令桥只处理本任务的记忆和提问，不接受任意操作', async t => {
  const f = fixture(t), r = await load(); f.task.workspace = r.prepareWorkspace(f.task, f.control);
  const io = f.task.workspace.io, name = 'a'.repeat(24) + '.request';
  fs.writeFileSync(path.join(io, name), JSON.stringify({ op: 'remember', text: 'test' }));
  const seen = []; r.drainBridge(f.task.workspace, a => { seen.push(a); return 'ok'; });
  assert.deepEqual(seen, [{ op: 'remember', text: 'test' }]);
  assert.equal(fs.readFileSync(path.join(io, name.replace('.request', '.reply')), 'utf8'), 'ok');
  const bad = spawnSync(process.execPath, [path.join(f.task.workspace.home, 'bin/xin'), 'task', 'new', 'bad'], { env: { ...f.env, XIN_TASK_IO: io }, encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /只允许/);
});

test('app-server 按当前轮次接收 steer，保留 session，结束时不会误报退出错误', async t => {
  const r = await load(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-rpc-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = path.join(root, 'fake.cjs'), log = path.join(root, 'rpc.jsonl');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
const emit=o=>console.log(JSON.stringify(o));
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
if(m.method==='initialize')emit({id:m.id,result:{userAgent:'fake'}});
if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'thread-1'}}});
if(m.method==='turn/start'){emit({id:m.id,result:{turn:{id:'turn-1'}}});emit({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});}
if(m.method==='turn/steer'){emit({id:m.id,result:{turnId:'turn-1'}});emit({method:'item/completed',params:{item:{id:'answer',type:'agentMessage',text:'steered: '+m.params.input[0].text}}});emit({method:'turn/completed',params:{turn:{id:'turn-1',status:'completed'}}});}
});`, { mode: 0o755 });
  const events = []; let resolveTurn; const started = new Promise(ok => resolveTurn = ok);
  let code; const client = r.appServer(fake, [], { spawn: { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
    cwd: root, model: 'test', text: 'original', emit: e => events.push(e), turn: () => resolveTurn(), complete: c => code = c, fail: e => assert.fail(e.message) });
  t.after(() => client.child.kill('SIGKILL'));
  await started; await client.steer('correct direction', 'message-id-1');
  await new Promise(ok => client.child.on('close', ok));
  assert.equal(code, 0); assert.ok(events.some(e => e.item?.text === 'steered: correct direction'));
  const request = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).find(x => x.method === 'turn/steer');
  assert.equal(request.params.expectedTurnId, 'turn-1'); assert.equal(request.params.clientUserMessageId, 'message-id-1');
});

test('推理代理只接受本轮凭证、固定模型和 responses 路径，结束立即撤销', async t => {
  const http=require('node:http'), r=await load();let hits=0;
  const gateway=http.createServer((req,res)=>{hits++;assert.equal(req.headers.authorization,'Bearer gateway-dummy');res.end('{"ok":true}');});
  await new Promise(ok=>gateway.listen(0,'127.0.0.1',ok));t.after(()=>gateway.close());
  const p=await r.inferenceProxy({baseURL:'http://127.0.0.1:'+gateway.address().port+'/v1',key:'gateway-dummy',model:'task-model',maxRequests:1});t.after(()=>p.close());
  const post=(url,token,model)=>fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({model})});
  assert.equal((await post(p.baseURL+'/responses','wrong','task-model')).status,401);
  assert.equal((await post(p.baseURL+'/admin',p.token,'task-model')).status,403);
  assert.equal((await post(p.baseURL+'/responses',p.token,'other-model')).status,403);
  assert.equal(hits,0);
  assert.equal((await post(p.baseURL+'/responses',p.token,'task-model')).status,200);
  assert.equal((await post(p.baseURL+'/responses',p.token,'task-model')).status,429);
  assert.equal(hits,1);p.close();await assert.rejects(post(p.baseURL+'/responses',p.token,'task-model'));
});

test('写回删除必须给明确决定，普通文字不能批准；允许后保留备份',async t=>{
  const f=fixture(t),r=await load();
  fs.writeFileSync(path.join(f.task.dir,'old.txt'),'original');
  f.task.workspace=r.prepareWorkspace(f.task,f.control);
  fs.unlinkSync(path.join(f.task.workspace.work,'old.txt'));
  f.task.publication=r.publishWorkspace(f.task,f.control);f.task.status='waiting';f.task.result={ok:false,text:'ready'};f.save();
  assert.equal(f.call('task_tell',{sid:f.task.sid,text:'yes'}).error,'needs_decision');
  assert.equal(fs.readFileSync(path.join(f.task.dir,'old.txt'),'utf8'),'original');
  assert.equal(f.call('task_tell',{sid:f.task.sid,decision:'approve'}).ok,true);
  const task=f.read();assert.equal(task.status,'done');assert.equal(fs.existsSync(path.join(f.task.dir,'old.txt')),false);
  assert.equal(fs.readFileSync(path.join(task.publicationReceipt.backup,'old.txt'),'utf8'),'original');
});

test('停止尚未退出或原生问题仍占用进程时，不能删除所属对话',t=>{
  const f=fixture(t),sid='sparent001';f.task.parent=sid;f.task.status='stopping';f.save();
  fs.writeFileSync(path.join(f.control,'sessions',sid+'.json'),JSON.stringify({sid,agent:'codex',runs:[]}));
  assert.equal(f.call('forget',{sid}).error,'busy');assert.ok(fs.existsSync(path.join(f.control,'sessions',sid+'.json')));
  f.task.status='waiting';f.task.approval={kind:'input',id:'input-1'};f.save();
  assert.equal(f.call('forget',{sid}).error,'busy');assert.equal(f.read().approval.id,'input-1');
});

test('一个设备正在看对话不会压掉另一台设备的推送，同设备后台标签不会清掉前台标签',async t=>{
  const f=fixture(t),http=require('node:http'),crypto=require('node:crypto');f.env.XIN_PUSH_INSECURE='1';
  const got=[];const server=http.createServer((q,r)=>{q.resume();q.on('end',()=>{got.push(q.url);r.writeHead(201);r.end();});});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>server.close());
  const ec=crypto.createECDH('prime256v1');ec.generateKeys();const keys={p256dh:ec.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')};
  for(const [name,deviceId] of [['desktop','desktop-device'],['phone','phone-device'],['legacy',undefined]])assert.equal(f.call('push_sub',{deviceId,sub:{endpoint:'http://127.0.0.1:'+server.address().port+'/'+name,keys}}).ok,true);
  const sid='sparent001';f.call('tasks',{sid,deviceId:'desktop-device',tabId:'visible-tab',watching:true});
  f.call('tasks',{sid,deviceId:'desktop-device',tabId:'background-tab',watching:false});
  const js=`import {pushAll} from ${JSON.stringify(pathToFileURL(agent).href)};console.log(JSON.stringify(await pushAll({sid:${JSON.stringify(sid)},title:'test'},{ids:true,respectWatching:true})));`;
  const execFile=require('node:util').promisify(require('node:child_process').execFile);
  const result=await execFile(process.execPath,['--input-type=module','-e',js],{env:f.env});
  assert.deepEqual(got.sort(),['/legacy','/phone']);
  const rows=JSON.parse(result.stdout);assert.equal(rows.filter(r=>r.viewed).length,1);assert.equal(rows.filter(r=>r.status===201).length,2);
});

test('任务预算跨代理重启和续接累计，不因换一轮重新变满',async t=>{
  const f=fixture(t),r=await load(),file=path.join(f.control,'budgets',f.task.sid+'.json');
  const first=r.requestBudget(file,2);assert.equal(first(),true);
  const resumed=r.requestBudget(file,2);assert.equal(resumed(),true);assert.equal(resumed(),false);
  assert.equal(JSON.parse(fs.readFileSync(file)).used,2);assert.equal(fs.statSync(file).mode&0o777,0o600);
});

test('普通前台对话变化不再让任务轮询逐个读取全部会话，索引只在任务锁内创建',t=>{
  const f=fixture(t);f.call('tasks',{all:true});
  const index=path.join(f.control,'tasks-index.json');assert.equal(JSON.parse(fs.readFileSync(index)).version,3);
  const unrelated=path.join(f.control,'sessions','sunrelated01.json'),hits=path.join(f.root,'unrelated-reads');
  fs.writeFileSync(unrelated,JSON.stringify({sid:'sunrelated01',agent:'codex',title:'unrelated',runs:[],large:'x'.repeat(100000)}));
  fs.appendFileSync(path.join(f.root,'preload.cjs'),`;{const fs=require('node:fs'),real=fs.readFileSync;fs.readFileSync=function(p,...args){if(String(p)===${JSON.stringify(unrelated)})fs.appendFileSync(${JSON.stringify(hits)},'read');return real.call(this,p,...args);};}`);
  const before=fs.statSync(index).mtimeMs;
  for(let i=0;i<3;i++)assert.equal(f.call('tasks',{all:true}).tasks.length,1);
  assert.equal(fs.existsSync(hits),false);assert.equal(fs.statSync(index).mtimeMs,before);
});

test('点名只在明确换模型时生效，假设、问句、引用和否定都不改变路由',async()=>{
  const {namedModel}=await import(pathToFileURL(agent).href);
  for(const text of ['如果用 Kimi 的话会怎样','为什么用 Kimi','有人说用 Kimi 比较好','不要换成GLM','是否用 Kimi','能不能用 Kimi？','代码里写 "用 Kimi"','例如让 Kimi 来检查'])assert.equal(namedModel(text),null,text);
  assert.equal(namedModel('这次用 Kimi 检查一下'),'kimi-k3.1-pro');
});

test('并发补充任务与编译元数据更新共用任务锁，不覆盖已收到的补充',async t=>{
  const f=fixture(t);const mf=path.join(f.control,'runs/rruntime001.json');
  fs.writeFileSync(mf,JSON.stringify({sid:f.task.sid,task:true,started:Date.now(),pid:process.pid,transport:'app-server',steers:[]}));
  const execFile=require('node:util').promisify(require('node:child_process').execFile);
  const jobs=[];fs.mkdirSync(path.join(f.control,'locks'),{recursive:true});
  for(let i=0;i<12;i++){
    const program=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,${JSON.stringify([agent,'task_tell'])},{stdio:['pipe','inherit','inherit']});c.stdin.end(${JSON.stringify(JSON.stringify({sid:f.task.sid,text:'supplement-'+i}))});c.on('exit',n=>process.exit(n));`;
    jobs.push(execFile(process.execPath,['-e',program],{env:f.env}));
    const patch=`const {spawn}=require('node:child_process');const c=spawn('flock',${JSON.stringify(['--exclusive','--close',path.join(f.control,'locks/tasks.lock'),process.execPath,agent,'locked','run_patch'])},{stdio:['pipe','inherit','inherit']});c.stdin.end(${JSON.stringify(JSON.stringify({run:'rruntime001',changes:{compileDigest:'digest-'+i}}))});c.on('exit',n=>process.exit(n));`;
    fs.mkdirSync(path.join(f.control,'locks'),{recursive:true});jobs.push(execFile(process.execPath,['-e',patch],{env:{...f.env,XIN_LOCK:'tasks'}}));
  }
  await Promise.all(jobs);
  const m=JSON.parse(fs.readFileSync(mf));assert.equal(m.steers.length,12);assert.equal(new Set(m.steers.map(x=>x.text)).size,12);assert.match(m.compileDigest,/^digest-/);
});

test('旧回调的确认不能覆盖较新的待投递状态，旧推送响应不能删除新订阅',t=>{
  const f=fixture(t),event=path.join(f.control,'controller-event.json');
  fs.writeFileSync(event,JSON.stringify({version:2,bg:1,acknowledged:false}));
  f.call('controller_ack',{version:1});assert.equal(JSON.parse(fs.readFileSync(event)).acknowledged,false);
  f.call('controller_ack',{version:2});assert.equal(JSON.parse(fs.readFileSync(event)).acknowledged,true);
  f.env.XIN_PUSH_INSECURE='1';const crypto=require('node:crypto'),ec=crypto.createECDH('prime256v1');ec.generateKeys();
  const sub={endpoint:'http://127.0.0.1:9999/owned-test',keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}};
  f.call('push_sub',{sub,deviceId:'test-device'});const file=path.join(f.control,'push/subs.json'),old=JSON.parse(fs.readFileSync(file))[0];
  f.call('push_sub',{sub,deviceId:'test-device'});f.call('push_gone',{endpoints:[{endpoint:sub.endpoint,revision:old.revision}]});
  assert.equal(JSON.parse(fs.readFileSync(file)).length,1);
});

test('完成记录的索引只留摘要，完整要求和全部轮次仍保留在原记录里',t=>{
  const f=fixture(t);f.task.goal='原始要求'.repeat(2000);f.task.runs=['rruntime000','rruntime001'];f.save();f.call('tasks',{all:true});
  f.call('task_finish',{sid:f.task.sid,run:'rruntime001',ok:true});
  const entry=JSON.parse(fs.readFileSync(path.join(f.control,'tasks-index.json'))).tasks.find(x=>x.sid===f.task.sid);
  assert.equal(entry.goal,undefined);assert.equal(entry.turnsCount,2);assert.equal(entry.runs.length,1);
  assert.equal(f.read().goal,'原始要求'.repeat(2000));assert.equal(f.read().runs.length,2);
});

test('实际启动分身时把用户原话与前台转述分别交给模型',async t=>{
  const f=fixture(t),bin=path.join(f.root,'bin'),log=path.join(f.root,'args.json');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'codex'),`#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:'thread.started',thread_id:'source-request-test'}));console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'checked'}}));console.log(JSON.stringify({type:'turn.completed',usage:{}}));`,{mode:0o755});
  f.env.PATH=bin+':'+process.env.PATH;f.env.XIN_CODEX_TRANSPORT='exec';
  f.task.status='stopped';f.save();
  const task=f.call('task_new',{kind:'review',goal:'前台转述：PB5 默认映射',userRequest:'用户原话：TIM3_CH2 到 PB5，按手册确认重映射',title:'source propagation',dir:path.join(f.root,'second-project')}).task;
  for(let i=0;i<80;i++){const h=f.call('history',{sid:task.sid});if(h.task.status==='done')break;await new Promise(ok=>setTimeout(ok,100));}
  const args=JSON.parse(fs.readFileSync(log,'utf8')),prompt=args.at(-1);
  assert.match(prompt,/前台转述：PB5 默认映射/);assert.match(prompt,/用户原话：TIM3_CH2 到 PB5/);assert.match(prompt,/独立核对前台转述是否准确/);
});

test('系统 SIGTERM 保留后台断点并续接，用户停止不被自动重启', async t => {
  const f=fixture(t);fs.unlinkSync(path.join(f.control,'sessions',f.task.sid+'.json'));
  const bin=path.join(f.root,'bin');fs.mkdirSync(bin);f.env.PATH=bin+':'+process.env.PATH;f.env.XIN_CODEX_TRANSPORT='exec';
  fs.writeFileSync(path.join(bin,'codex'),'#!/bin/sh\nprintf \'%s\\n\' \'{"type":"thread.started","thread_id":"graceful-fixture"}\'\nif [ ! -f .checkpoint ]; then printf ONCE > .checkpoint; sleep 30; fi\nprintf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"recovered"}}\' \'{"type":"turn.completed"}\'\n',{mode:0o755});
  const wait=async fn=>{for(let i=0;i<100;i++){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}throw Error('fixture did not reach checkpoint');};
  const start=async dir=>{
    fs.mkdirSync(dir,{recursive:true});const a=f.call('task_new',{kind:'research',dir,goal:'fixture',title:'graceful fixture'}).task;
    const s=await wait(()=>{const v=JSON.parse(fs.readFileSync(path.join(f.control,'sessions',a.sid+'.json')));return v.workspace&&fs.existsSync(path.join(v.workspace.work,'.checkpoint'))?v:null;});
    return {sid:s.sid,meta:JSON.parse(fs.readFileSync(path.join(f.control,'runs',s.runs.at(-1)+'.json')))};
  };
  const a=await start(path.join(f.root,'resume'));
  process.kill(a.meta.pid,'SIGTERM');
  const done=await wait(()=>{f.call('tasks',{});const s=JSON.parse(fs.readFileSync(path.join(f.control,'sessions',a.sid+'.json')));return s.status==='done'?s:null;});
  assert.equal(done.runs.length,2);assert.equal(done.resumes,1);assert.equal(fs.readFileSync(path.join(done.dir,'.checkpoint'),'utf8'),'ONCE');
  const b=await start(path.join(f.root,'stop'));
  f.call('task_stop',{sid:b.sid});
  const stopped=await wait(()=>{f.call('tasks',{});const s=JSON.parse(fs.readFileSync(path.join(f.control,'sessions',b.sid+'.json')));return s.status==='stopped'?s:null;});
  assert.equal(stopped.runs.length,1);assert.equal(stopped.resumes,0);
});

test('完成事件可见时统计已保存，收尾重试去重且以最终停止状态记账', t => {
  const f=fixture(t),run='rruntime001',meta=path.join(f.control,'runs',run+'.json');
  const m=JSON.parse(fs.readFileSync(meta));m.stopped=true;fs.writeFileSync(meta,JSON.stringify(m));
  const stat={at:Date.now(),agent:'codex',model:'deepseek-v4.1-flash',ok:true,ms:10};
  const completed=f.call('run_complete',{run,stat,done:{t:'done',ok:true}});
  assert.equal(completed.done.ok,false);assert.equal(completed.done.stopped,true);
  const stats=()=>fs.readFileSync(path.join(f.control,'model-stats.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(stats().length,1);assert.equal(stats()[0].run,run);assert.equal(stats()[0].ok,false);assert.equal(stats()[0].stopped,true);
  assert.ok(fs.readFileSync(path.join(f.control,'runs',run+'.jsonl'),'utf8').includes('"t":"done"'));
  f.call('run_complete',{run,stat,done:{t:'done',ok:true}});f.call('run_stat',{...stat,run});assert.equal(stats().length,1);
});
