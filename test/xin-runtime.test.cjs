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
  fs.appendFileSync(path.join(f.task.workspace.work,'main.c'),'\n// later change');
  assert.match(r.validateTask(f.task,f.control,meta).error,/最终源码/);
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
