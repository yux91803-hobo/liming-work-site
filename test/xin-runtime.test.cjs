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
  t.after(async () => {
    // Detached runners/watchdogs must exit before removing their preload and state.
    const r = await import(pathToFileURL(agent).href);
    const owned = () => fs.readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== process.pid).flatMap(n => {
      try {
        if (!fs.readFileSync('/proc/' + n + '/environ', 'utf8').split('\0').includes('XIN_HOME=' + env.XIN_HOME)) return [];
        const identity = r.processIdentity(Number(n));
        return identity && !['Z', 'X'].includes(identity.state) ? [{ pid: Number(n), identity }] : [];
      } catch { return []; }
    });
    const deadline = Date.now() + 5000;
    while (owned().length && Date.now() < deadline) {
      for (const p of owned()) r.signalProcessGroup(p.pid, p.identity, 'SIGKILL');
      await new Promise(ok => setTimeout(ok, 30));
    }
    assert.equal(owned().length, 0, 'fixture processes must exit before removing their state');
    fs.rmSync(root, { recursive: true, force: true });
  });
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
  const io = f.task.workspace.io, name = require('node:crypto').randomBytes(12).toString('hex') + '.request';
  fs.writeFileSync(path.join(io, name), JSON.stringify({ op: 'remember', text: 'test' }));
  const seen = []; r.drainBridge(f.task.workspace, a => { seen.push(a); return 'ok'; });
  assert.deepEqual(seen, [{ op: 'remember', text: 'test' }]);
  assert.equal(fs.readFileSync(path.join(io, name.replace('.request', '.reply')), 'utf8'), 'ok');
  fs.unlinkSync(path.join(io,name.replace('.request','.reply')));
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
  let observed;
  const wait=async fn=>{const deadline=Date.now()+30000;while(Date.now()<deadline){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}throw Error('fixture did not reach checkpoint: '+JSON.stringify(observed));};
  const start=async dir=>{
    fs.mkdirSync(dir,{recursive:true});const a=f.call('task_new',{kind:'research',dir,goal:'fixture',title:'graceful fixture'}).task;
    const s=await wait(()=>{const v=JSON.parse(fs.readFileSync(path.join(f.control,'sessions',a.sid+'.json'))),m=JSON.parse(fs.readFileSync(path.join(f.control,'runs',v.runs.at(-1)+'.json')));observed={phase:'start',status:v.status,modelSession:!!v.agentSid,child:!!m.childPid};return v.agentSid&&m.childIdentity&&v.workspace&&fs.existsSync(path.join(v.workspace.work,'.checkpoint'))?v:null;});
    return {sid:s.sid,meta:JSON.parse(fs.readFileSync(path.join(f.control,'runs',s.runs.at(-1)+'.json')))};
  };
  const a=await start(path.join(f.root,'resume'));
  process.kill(a.meta.pid,'SIGTERM');
  const done=await wait(()=>{f.call('tasks',{});const s=JSON.parse(fs.readFileSync(path.join(f.control,'sessions',a.sid+'.json')));observed={phase:'resume',status:s.status,turns:s.runs.length,resumes:s.resumes};return s.status==='done'?s:null;});
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

test('提问后快速回复会清掉对应 pendingQuestion，下一轮完成不再重复等待',async t=>{
 const f=fixture(t),bin=path.join(f.root,'bin');fs.mkdirSync(bin);f.env.PATH=bin+':'+process.env.PATH;f.env.XIN_CODEX_TRANSPORT='exec';
 fs.writeFileSync(path.join(bin,'codex'),'#!/bin/sh\necho \'{"type":"thread.started","thread_id":"answer-fixture"}\'\necho \'{"type":"item.completed","item":{"type":"agent_message","text":"answer handled"}}\'\necho \'{"type":"turn.completed"}\'\n',{mode:0o755});
 f.call('task_ask',{sid:f.task.sid,question:'是否继续？'});f.call('task_tell',{sid:f.task.sid,text:'继续'});
 assert.equal(f.read().pendingQuestion,undefined);assert.equal(f.read().question,'');
 fs.appendFileSync(path.join(f.control,'runs/rruntime001.jsonl'),JSON.stringify({t:'done',ok:true})+'\n');
 f.call('task_finish',{sid:f.task.sid,run:'rruntime001',ok:true});
 const deadline=Date.now()+15000;let task;
 while(Date.now()<deadline){f.call('tasks',{});task=f.read();if(['done','failed','waiting'].includes(task.status))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(task.status,'done',JSON.stringify(task));assert.equal(task.runs.length,2);assert.equal(task.pendingQuestion,undefined);
});
test('答复之后出现的新问题不能被旧 inbox 吞掉',t=>{
 const f=fixture(t);f.call('task_ask',{sid:f.task.sid,question:'旧问题'});f.call('task_tell',{sid:f.task.sid,text:'旧问题的答复'});f.call('task_ask',{sid:f.task.sid,question:'新问题'});
 f.call('task_finish',{sid:f.task.sid,run:'rruntime001',ok:true});const s=f.read();assert.equal(s.status,'waiting');assert.equal(s.question,'新问题');assert.equal(s.inbox[0].text,'旧问题的答复');
});

test('独立复核不忽略 avoid，点名作者及耗尽全部视觉候选均明确拒绝',async()=>{
 const {route,CODEX_MODELS}=await import(pathToFileURL(agent).href);
 const visual=CODEX_MODELS.filter(m=>m.image).map(m=>m.id);
 const none=route({kind:'review',images:true,avoid:visual});assert.equal(none.model,null);assert.equal(none.error,'no_independent_model');
 const same=route({kind:'review',want:'deepseek-v4.1-flash',named:true,avoid:['deepseek-v4.1-flash']});assert.equal(same.model,null);assert.equal(same.error,'independent_review_model');assert.match(same.note,/实际作者/);
});
test('原任务 fallback 与复核 fallback 组合：requestedModel 保持原值，actualModel 避开实际作者',async t=>{
 const f=fixture(t);fs.unlinkSync(path.join(f.control,'sessions',f.task.sid+'.json'));const bin=path.join(f.root,'bin');fs.mkdirSync(bin);f.env.PATH=bin+':'+process.env.PATH;f.env.XIN_CODEX_TRANSPORT='exec';const log=path.join(f.root,'models.jsonl');
 fs.writeFileSync(path.join(bin,'codex'),'#!'+process.execPath+'\n'+`const fs=require('node:fs');const a=process.argv.slice(2),v=a.find(s=>s.startsWith('model='));if(!v){console.log('[]');process.exit(0);}const model=JSON.parse(v.slice(6)),role=a.join(' ').includes('REVIEW_CASE')?'review':'author';fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({role,model})+'\\n');if(role==='author'&&model==='glm-5.3'||role==='review'&&model==='deepseek-v4.1-flash'){setTimeout(()=>{console.log(JSON.stringify({type:'error',message:'provider unavailable'}));process.exit(1);},300);}else{console.log(JSON.stringify({type:'thread.started',thread_id:role+'-fixture'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));console.log(JSON.stringify({type:'turn.completed'}));}` ,{mode:0o755});
 const a=f.call('task_new',{kind:'research',goal:'AUTHOR_CASE',dir:f.task.dir,model:'glm-5.3',named:true}).task;
 const review=f.call('task_new',{kind:'review',goal:'REVIEW_CASE',after:[a.no],dir:f.task.dir,model:'deepseek-v4.1-flash',named:true}).task;
 const deadline=Date.now()+20000;let ah,rh;
 while(Date.now()<deadline){f.call('tasks',{});ah=f.call('history',{sid:a.sid}).task;rh=f.call('history',{sid:review.sid}).task;if(['done','failed','waiting'].includes(rh.status))break;await new Promise(r=>setTimeout(r,100));}
 ah=f.call('history',{sid:a.sid}).task;rh=f.call('history',{sid:review.sid}).task;
 assert.equal(ah.status,'done',JSON.stringify(ah));assert.equal(rh.status,'done',JSON.stringify(rh));
 assert.equal(ah.requestedModel,'glm-5.3');assert.equal(ah.actualModel,'kimi-k3.1-pro');assert.equal(rh.requestedModel,'deepseek-v4.1-flash');assert.equal(rh.actualModel,'glm-5.3');assert.equal(rh.independent,true);
 const attempts=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(attempts.filter(x=>x.role==='review').map(x=>x.model),['deepseek-v4.1-flash','glm-5.3']);
 const bad=f.call('task_new',{kind:'review',goal:'same author',after:[a.no],dir:f.task.dir,model:ah.actualModel,named:true});assert.equal(bad.error,'independent_review_model');
});

test('组长退出后，单独存活且忽略 TERM 的孙进程仍会被清理，换进程组也不释放目录',async t=>{
 const {spawn}=require('node:child_process'),{once}=require('node:events'),r=await import(pathToFileURL(agent).href);
 for(const separate of [false,true]){
  const f=fixture(t),pidFile=path.join(f.root,'grandchild'),release=path.join(f.root,'release');let identity,leader;
  const script=`import os,sys,time,signal\np=os.fork()\nif p==0:\n ${separate?'os.setpgid(0,0)':'pass'}\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n open(sys.argv[1],'w').write(str(os.getpid()))\n while True:time.sleep(1)\nelse:\n while not os.path.exists(sys.argv[2]):time.sleep(.01)\n`;
  leader=spawn('python3',['-c',script,pidFile,release],{detached:true,stdio:'ignore'});t.after(()=>{if(identity)r.signalProcessGroup(leader.pid,identity,'SIGKILL');});
  const wait=async fn=>{const end=Date.now()+10000;while(Date.now()<end){const v=fn();if(v)return v;await new Promise(ok=>setTimeout(ok,30));}throw Error('process fixture timeout');};
  await wait(()=>fs.existsSync(pidFile));identity=r.processIdentity(leader.pid);assert.ok(identity);
  const exited=once(leader,'exit');fs.writeFileSync(release,'1');await exited;
  assert.equal(r.processIdentity(leader.pid),null);assert.equal(r.processGroupMembers(leader.pid,identity).length,1);
  const meta={sid:f.task.sid,task:true,pid:leader.pid,identity,childPid:leader.pid,childIdentity:identity,started:Date.now()-20000};fs.writeFileSync(path.join(f.control,'runs/rruntime001.json'),JSON.stringify(meta));
  assert.ok(f.call('history',{sid:f.task.sid}).active,'must retain occupancy while a TERM-resistant descendant lives');
  await new Promise(ok=>setTimeout(ok,2100));await wait(()=>!f.call('history',{sid:f.task.sid}).active);
  assert.equal(r.processGroupMembers(leader.pid,identity).length,0);assert.equal(JSON.parse(fs.readFileSync(path.join(f.control,'runs/rruntime001.json'))).died,true);
  assert.deepEqual(r.processGroupMembers(process.pid,{...r.processIdentity(process.pid),boot:'wrong-boot'}),[]);
 }
});
test('嵌套 Core/Src STM32 工程、CMake 和显式构建目录均被识别，删除标记不能绕过',async t=>{
 const f=fixture(t),r=await load(),firmware=path.join(f.task.dir,'firmware');fs.mkdirSync(path.join(firmware,'Core/Src'),{recursive:true});fs.writeFileSync(path.join(firmware,'Core/Src/main.c'),'#include "stm32f1xx_hal.h"');fs.writeFileSync(path.join(firmware,'Makefile'),'all:; arm-none-eabi-gcc');
 f.task.workspace=r.prepareWorkspace(f.task,f.control);assert.equal(r.stm32Task(f.task),true);let p=r.buildPlan(f.task);assert.equal(p.directory,path.join(f.task.workspace.work,'firmware'));assert.equal(p.system,'make');
 fs.unlinkSync(path.join(f.task.workspace.work,'firmware/Makefile'));fs.writeFileSync(path.join(f.task.workspace.work,'firmware/CMakeLists.txt'),'project(stm32 C ASM)');p=r.buildPlan(f.task);assert.equal(p.system,'cmake');assert.equal(p.commands.length,2);
 fs.writeFileSync(path.join(f.task.workspace.work,'xin-build.json'),JSON.stringify({system:'cmake',directory:'firmware',artifacts:['firmware/Release/custom.elf']}));p=r.buildPlan(f.task);assert.deepEqual(p.artifacts,['firmware/Release/custom.elf']);
 fs.rmSync(path.join(f.task.workspace.work,'firmware'),{recursive:true});fs.unlinkSync(path.join(f.task.workspace.work,'xin-build.json'));assert.equal(r.stm32Task(f.task),true);assert.ok(r.compileWorkspace(f.task).output.includes('构建入口'));
});
test('多个 STM32 构建入口与越界构建配置不能静默选择或跳过',async t=>{
 const f=fixture(t),r=await load();f.task.goal='STM32 build';f.task.workspace=r.prepareWorkspace(f.task,f.control);
 for(const d of ['one','two']){fs.mkdirSync(path.join(f.task.workspace.work,d));fs.writeFileSync(path.join(f.task.workspace.work,d,'Makefile'),'all:');}
 assert.equal(r.stm32Task(f.task),true);assert.throws(()=>r.buildPlan(f.task),/唯一构建入口/);
 fs.writeFileSync(path.join(f.task.workspace.work,'xin-build.json'),JSON.stringify({directory:'../control',system:'make'}));assert.throws(()=>r.buildPlan(f.task),/副本内/);
 fs.writeFileSync(path.join(f.task.workspace.work,'xin-build.json'),JSON.stringify({directory:'one',system:'make',artifacts:['../../secret.hex']}));assert.throws(()=>r.buildPlan(f.task),/副本内/);
});

test('受控构建验证任意新产物，拒绝旧 HEX、非 ARM ELF 及输出软链接',async t=>{
 const f=fixture(t),r=await load(),cp=require('node:child_process'),{syncBuiltinESMExports}=require('node:module');f.task.goal='STM32 build';fs.writeFileSync(path.join(f.task.dir,'Makefile'),'all:');f.task.workspace=r.prepareWorkspace(f.task,f.control);
 const work=f.task.workspace.work,artifact=path.join(work,'Release/custom.hex');fs.mkdirSync(path.dirname(artifact));const hex=':0100000001FE\n:00000001FF\n';fs.writeFileSync(artifact,hex);fs.utimesSync(artifact,new Date(2000,0,1),new Date(2000,0,1));
 const real=cp.spawnSync;let generate=()=>{};
 cp.spawnSync=(cmd,args)=>{assert.equal(cmd,'/usr/bin/sudo');assert.ok(args.includes('/usr/bin/make'));assert.ok(args.includes(work));generate();return {status:0,stdout:'build',stderr:''};};syncBuiltinESMExports();
 try{
  assert.equal(r.compileWorkspace(f.task).ok,false,'old valid HEX is not build evidence');
  fs.utimesSync(artifact,new Date(Date.now()+60000),new Date(Date.now()+60000));assert.equal(r.compileWorkspace(f.task).ok,false,'future-dated unchanged HEX is not build evidence');
  generate=()=>fs.writeFileSync(artifact,hex);let built=r.compileWorkspace(f.task);assert.equal(built.ok,true);assert.ok(built.artifacts.includes('Release/custom.hex'));
  fs.unlinkSync(artifact);const elf=path.join(work,'Release/custom.elf');generate=()=>{const b=Buffer.alloc(52);b.set([127,69,76,70,1,1,1]);b.writeUInt16LE(62,18);fs.writeFileSync(elf,b);};assert.equal(r.compileWorkspace(f.task).ok,false);
  generate=()=>{const b=Buffer.alloc(52);b.set([127,69,76,70,1,1,1]);b.writeUInt16LE(40,18);fs.writeFileSync(elf,b);};assert.equal(r.compileWorkspace(f.task).ok,true);
  fs.unlinkSync(elf);const outside=path.join(f.control,'secret.hex');fs.writeFileSync(outside,hex);generate=()=>fs.symlinkSync(outside,artifact);built=r.compileWorkspace(f.task);assert.equal(built.ok,false);assert.match(built.output,/软链接/);assert.equal(fs.readFileSync(outside,'utf8'),hex);
 }finally{cp.spawnSync=real;syncBuiltinESMExports();}
});

test('前台指定模型只影响后台；结构化桥拒绝跨对话操作，预算派活去重', async t => {
  const f=fixture(t), sid='sfronttest01', run='rfronttest01';
  const meta={run,sid,agent:'codex',model:'deepseek-v4.1-flash',frontNamed:'kimi-k3.1-pro',text:'让 Kimi 去画一个 SVG',started:Date.now()};
  fs.writeFileSync(path.join(f.control,'sessions',sid+'.json'),JSON.stringify({sid,agent:'codex',runs:[run]}));
  fs.writeFileSync(path.join(f.control,'runs',run+'.json'),JSON.stringify(meta));
  fs.writeFileSync(path.join(f.control,'runs',run+'.jsonl'),JSON.stringify({t:'user',text:meta.text})+'\n');
  assert.ok(f.call('front_action',{run,argv:['sh','-c','pwd']}).error);
  assert.ok(f.call('front_action',{run,argv:['xin','task','tell','1','change']}).error);
  const r=f.call('front_action',{run,argv:['xin','task','new','--kind','code','--model','glm-5.3','--','画 SVG']});
  assert.equal(r.terminal,true);assert.equal(r.task.model,'kimi-k3.1-pro');assert.equal(r.task.why,'named');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.control,'runs',run+'.json'))).model,'deepseek-v4.1-flash');
  const fallback=f.call('front_fallback',{run});assert.equal(fallback.task.sid,r.task.sid);
  assert.equal(f.call('front_action',{run,argv:['xin','task','new','--','duplicate']}).task.sid,r.task.sid);
  const saved=JSON.parse(fs.readFileSync(path.join(f.control,'sessions',r.task.sid+'.json')));
  assert.equal(saved.requestedModel,'kimi-k3.1-pro');assert.equal(saved.requestedNamed,true);
});
test('前台超预算自动保存原话为后台工作，停止后不再派活',async t=>{
  const f=fixture(t), sid='sfronttest02', run='rfronttest02';
  fs.writeFileSync(path.join(f.control,'sessions',sid+'.json'),JSON.stringify({sid,agent:'codex',runs:[run]}));
  const file=path.join(f.control,'runs',run+'.json');
  const m={run,sid,agent:'codex',model:'deepseek-v4.1-flash',text:'检查电路图',started:Date.now()};
  fs.writeFileSync(file,JSON.stringify(m));fs.writeFileSync(path.join(f.control,'runs',run+'.jsonl'),JSON.stringify({t:'user',text:m.text})+'\n');
  const r=f.call('front_fallback',{run});assert.equal(r.terminal,true);
  assert.match(JSON.parse(fs.readFileSync(path.join(f.control,'sessions',r.task.sid+'.json'))).goal,/检查电路图/);
  fs.writeFileSync(file,JSON.stringify({...m,stopped:true}));assert.ok(f.call('front_fallback',{run}).error);
});
test('前台对 ask 的回复用 tell 续接同一工作，不重复 new；跨对话依赖拒绝',async t=>{
  const f=fixture(t),sid='sfronttest03',run='rfronttest03';
  fs.writeFileSync(path.join(f.control,'sessions',sid+'.json'),JSON.stringify({sid,agent:'codex',runs:[run]}));
  const put=run=>{fs.writeFileSync(path.join(f.control,'runs',run+'.json'),JSON.stringify({run,sid,agent:'codex',text:'补充要求',started:Date.now()}));fs.writeFileSync(path.join(f.control,'runs',run+'.jsonl'),JSON.stringify({t:'user',text:'补充要求'})+'\n');};
  put(run);
  assert.ok(f.call('front_action',{run,argv:['xin','task','new','--after','1','--','不应创建']}).error);
  const created=f.call('front_action',{run,argv:['xin','task','new','--','绘图']}).task;
  const file=path.join(f.control,'sessions',created.sid+'.json'),task=JSON.parse(fs.readFileSync(file));
  task.status='waiting';task.question='要用红色吗？';fs.writeFileSync(file,JSON.stringify(task));
  const follow='rfronttell03';put(follow);
  const r=f.call('front_action',{run:follow,argv:['xin','task','tell',String(task.no),'是，用红色']});
  assert.equal(r.task.sid,task.sid);assert.equal(r.terminal,true);
  const saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.question,'');assert.match(saved.next,/是，用红色/);
});
test('只清理本任务私有 tmp；等待期间保留，项目输出与其它目录不碰',async t=>{
  const f=fixture(t),r=await load();f.task.workspace=r.prepareWorkspace(f.task,f.control);
  const tmp=f.task.workspace.tmp;fs.writeFileSync(path.join(tmp,'secret'),'fixture');fs.writeFileSync(path.join(f.task.workspace.work,'output.txt'),'keep');
  assert.equal(r.cleanupTaskTemporary({...f.task,status:'waiting'}),false);assert.ok(fs.existsSync(path.join(tmp,'secret')));
  assert.equal(r.cleanupTaskTemporary({...f.task,status:'done'}),true);assert.deepEqual(fs.readdirSync(tmp),[]);assert.ok(fs.existsSync(path.join(f.task.workspace.work,'output.txt')));
  assert.throws(()=>r.cleanupTaskTemporary({...f.task,status:'done',workspace:{...f.task.workspace,tmp:f.root}}),/归属/);
});
test('真实完成推送以第一人称给用户，内部模型记录仍保留',async t=>{
  const f=fixture(t);f.task.parent='sfrontnotice';f.task.title='画 SVG';f.save();
  fs.writeFileSync(path.join(f.control,'runs','rruntime001.jsonl'),JSON.stringify({t:'text',text:'我画好了。'})+'\n');
  const out=f.call('task_finish',{sid:f.task.sid,run:'rruntime001',ok:true,model:'glm-5.3'});
  assert.equal(out.notify.title,'我弄好了：画 SVG');assert.equal(out.notify.body,'我画好了。');
  assert.equal(f.read().actualModel,'glm-5.3');
});
