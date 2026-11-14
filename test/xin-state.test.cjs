const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');const {pathToFileURL}=require('node:url');
const moduleUrl=pathToFileURL(path.join(__dirname,'../site/xin/vm-state.mjs')).href;
async function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-state-'));const {StateJournal}=await import(moduleUrl);const j=new StateJournal(root);t.after(()=>{j.close();fs.rmSync(root,{recursive:true,force:true});});return{root,j};}
function crash(root,afterCommit){const source=`import {StateJournal} from ${JSON.stringify(moduleUrl)};const j=new StateJournal(${JSON.stringify(root)});${afterCommit?'j.recover=()=>process.exit(71);':''}j.atomic(()=>{j.write(${JSON.stringify(root+'/sessions/stest001.json')},JSON.stringify({sid:'stest001',runs:['rtest001']}));j.append(${JSON.stringify(root+'/runs/rtest001.jsonl')},{t:'user',text:'one accepted input'});j.enqueueLaunch('rtest001','stest001',0);${afterCommit?'':'process.kill(process.pid,"SIGKILL");'}return {sid:'stest001',run:'rtest001'};},{id:'send:stable-id',digest:'original'});`;return spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000});}
test('接单事务提交前崩溃：输入、记录和启动意图一起回滚',async t=>{const {root,j}=await fixture(t);const r=crash(root,false);assert.equal(r.signal,'SIGKILL');j.recover();assert.equal(fs.existsSync(root+'/sessions/stest001.json'),false);assert.deepEqual(j.pendingLaunches(),[]);assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n,0);});
test('提交后投影前崩溃：重启补全记录、唯一事件和启动意图，同消息重发复用回执',async t=>{
 const {root,j}=await fixture(t);assert.equal(crash(root,true).status,71);j.recover();assert.equal(JSON.parse(fs.readFileSync(root+'/sessions/stest001.json')).sid,'stest001');assert.equal(j.pendingLaunches().length,1);
 const result=j.atomic(()=>assert.fail('duplicate input must not execute again'),{id:'send:stable-id',digest:'original'});assert.deepEqual(result,{sid:'stest001',run:'rtest001'});j.recover();assert.equal(fs.readFileSync(root+'/runs/rtest001.jsonl','utf8').trim().split('\n').length,1);
 assert.equal(j.atomic(()=>assert.fail('changed payload must be rejected'),{id:'send:stable-id',digest:'changed'}).error,'message_conflict');
});
test('事务将元数据、完成事件和回执一起提交；投影重放不重复追加',async t=>{
 const {root,j}=await fixture(t);j.atomic(()=>{j.write(root+'/task.json','{"status":"done"}');j.enqueueHandoff({id:'h1',parent:'sparent01',task:'stest001',version:'v1',payload:{ok:true}});j.append(root+'/events.jsonl',{t:'done'});return{ok:true};},{id:'complete:1',digest:'v1'});
 assert.equal(j.handoff('h1').state,'pending');j.db.prepare('UPDATE appends SET projected=0').run();j.recover();assert.equal(fs.readFileSync(root+'/events.jsonl','utf8').trim().split('\n').length,1);assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n,1);
});
test('执行启动按用户、完成续接、例行顺序；重复完成只有一个收件项',async t=>{const {j}=await fixture(t);j.atomic(()=>{j.enqueueLaunch('rbackground','s1',2);j.enqueueLaunch('revent','s1',1);j.enqueueLaunch('ruser','s1',0);for(let n=0;n<3;n++)j.enqueueHandoff({id:'same',parent:'s1',task:'t1',version:'v1',payload:{ok:true}});});assert.deepEqual(j.pendingLaunches().map(x=>x.run),['ruser','revent','rbackground']);assert.equal(j.dueHandoffs().length,1);j.startHandoff('same','revent');j.settleHandoff('same','delivered');assert.equal(j.hasPendingHandoffs(),false);});
test('续接共享 token 预算，缓存输入不重复加总，未知用量单独记录',async t=>{
 const {root}=await fixture(t),{requestBudget}=await import('../site/xin/vm-runtime.mjs');const file=root+'/budget.json',first=requestBudget(file,8,{tokens:100});assert.equal(first(),true);first.recordUsage({input_tokens:70,output_tokens:30,input_tokens_details:{cached_tokens:50}});
 const resumed=requestBudget(file,8,{tokens:100});assert.equal(resumed(),false);resumed.recordUsage(null);const b=JSON.parse(fs.readFileSync(file));assert.equal(b.total,100);assert.equal(b.cached,50);assert.equal(b.unknownUsage,1);assert.equal(b.used,1);
});
test('删除指定对话同时清除日志索引与回执，恢复时不重建已删除记录',async t=>{
 const {root,j}=await fixture(t);for(const sid of ['sdelete01','skeep001'])j.atomic(()=>{j.write(root+'/sessions/'+sid+'.json',JSON.stringify({sid}));j.write(root+'/contexts/'+sid+'.json','{"excerpt":"private"}');return {sid};},{id:sid,digest:sid});
 fs.unlinkSync(root+'/sessions/sdelete01.json');j.dropConversation('sdelete01');j.recover();assert.equal(fs.existsSync(root+'/sessions/sdelete01.json'),false);assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM commands WHERE id=?').get('sdelete01').n,0);assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE name=?').get('contexts/sdelete01.json').n,0);assert.equal(JSON.parse(fs.readFileSync(root+'/sessions/skeep001.json')).sid,'skeep001');
});
test('多个进程同时首次打开新的状态库：初始化遇忙重试，全部成功',async t=>{
 const {spawn}=require('node:child_process');
 for(let round=0;round<3;round++){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-state-race-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=`import {StateJournal} from ${JSON.stringify(moduleUrl)};const j=new StateJournal(${JSON.stringify(root)});j.recover();j.enqueueLaunch('r'+process.pid,'srace0001');j.close();`;
  const codes=await Promise.all(Array.from({length:8},()=>new Promise(ok=>{const c=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','ignore','pipe']});let err='';c.stderr.on('data',d=>err+=d);c.on('close',code=>ok([code,err.replace(/.*ExperimentalWarning.*\n?|.*trace-warnings.*\n?/g,'').trim()]));})));
  for(const [code,err] of codes)assert.equal(code,0,err);
  const {StateJournal}=await import(moduleUrl);const j=new StateJournal(root);assert.equal(j.pendingLaunches().length,8);j.close();
 }
});
test('另一连接正持有写锁时打开状态库：等锁释放后初始化成功，不立刻报 database is locked',async t=>{
 const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-state-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const holder=new DatabaseSync(path.join(root,'workflow.sqlite'));holder.exec('CREATE TABLE x(a); BEGIN IMMEDIATE; INSERT INTO x VALUES(1)');
 const source=`import {StateJournal} from ${JSON.stringify(moduleUrl)};const j=new StateJournal(${JSON.stringify(root)});j.recover();console.log('ready');j.close();`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
 setTimeout(()=>{holder.exec('COMMIT');holder.close();},400);
 const code=await new Promise(ok=>child.on('close',ok));
 assert.equal(code,0,err);assert.equal(out.trim(),'ready');
});
test('别的进程占着写锁时 recover 不等待：没有要补写的就不开写事务',async t=>{
 const {spawn}=require('node:child_process'),{platformTimeout}=require('./helpers/timeout.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-state-idle-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {StateJournal}=await import(moduleUrl);const init=new StateJournal(root);init.recover();init.close();
 const holder=spawn(process.execPath,['-e',`const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(root+'/workflow.sqlite')});d.exec('BEGIN IMMEDIATE');d.prepare("INSERT INTO commands(id,digest,result,at) VALUES('x','d','{}',0)").run();console.log('holding');setTimeout(()=>{d.exec('ROLLBACK');process.exit(0);},${platformTimeout(3000)});`],{stdio:['ignore','pipe','inherit']});
 await new Promise(ok=>holder.stdout.once('data',ok));t.after(()=>holder.kill());
 const j=new StateJournal(root);t.after(()=>j.close());
 const t0=performance.now();j.recover();assert.ok(performance.now()-t0<1000,'recover 等了 '+Math.round(performance.now()-t0)+' ms');
});
test('有提交了但没投影的行时 recover 照样补写',async t=>{
 const {root,j}=await fixture(t);j.recover();
 j.db.prepare("INSERT INTO documents(name,body,dirty) VALUES('sessions/sdirty001.json','{\"sid\":\"sdirty001\"}',1)").run();
 j.recover();assert.equal(JSON.parse(fs.readFileSync(root+'/sessions/sdirty001.json')).sid,'sdirty001');assert.equal(j.db.prepare("SELECT dirty FROM documents WHERE name='sessions/sdirty001.json'").get().dirty,0);
});

// ── 所有权检查（site/xin/vm-kernel-owner.mjs，设计 docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md §6.2）──
// 状态库的每个写入口先问「现在归不归我写」；主人活着、或者该内核当主人但它不在，都不写。
const refuse = { enter() { throw Object.assign(new Error('owner_alive'), { code: 'owner_unavailable', status: 'alive' }); } };
const counting = () => { const c = { entered: 0, released: 0, enter() { c.entered++; return () => { c.released++; }; } }; return c; };

test('没有写权时冷启动不能创建空状态库，已有空文件也不被初始化', async t => {
  const { StateJournal } = await import(moduleUrl);
  for (const emptyFile of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-state-init-owner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'workflow.sqlite');
    if (emptyFile) fs.writeFileSync(file, '');
    const j = new StateJournal(root); j.owner = refuse; t.after(() => j.close());
    assert.throws(() => j.recover(), e => e.code === 'owner_unavailable');
    assert.equal(fs.existsSync(file), emptyFile);
    if (emptyFile) assert.equal(fs.statSync(file).size, 0);
    assert.equal(fs.existsSync(file + '-wal'), false);
  }
});

test('没有写权时不能借读库升级旧 schema 或切换日志模式；失败后连接可重新初始化', async t => {
  const { StateJournal } = await import(moduleUrl), { DatabaseSync } = require('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-state-schema-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'workflow.sqlite'), old = new DatabaseSync(file);
  old.exec("CREATE TABLE launches(run TEXT PRIMARY KEY,sid TEXT NOT NULL,lane INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',at INTEGER NOT NULL)");
  old.close(); const before = fs.readFileSync(file);
  const j = new StateJournal(root); j.owner = refuse; t.after(() => j.close());
  assert.throws(() => j.recover(), e => e.code === 'owner_unavailable');
  assert.equal(j.connection == null, true, '不能缓存初始化失败的连接');
  assert.deepEqual(fs.readFileSync(file), before);
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name), ['launches']);
    assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  } finally { check.close(); }
  j.owner = null; j.recover();
  assert.ok(j.db.prepare('PRAGMA table_info(launches)').all().some(c => c.name === 'attempts'));
});

test('状态库的悬空软链接也拒绝，不在链接目标创建文件', async t => {
  const { root, j } = await fixture(t), target = path.join(root, 'elsewhere.sqlite');
  fs.symlinkSync(target, path.join(root, 'workflow.sqlite'));
  assert.throws(() => j.recover(), /软链接/);
  assert.equal(fs.existsSync(target), false);
});

test('主人活着时状态库的写入口都不执行、不落任何行；读不受影响', async t => {
  const { root, j } = await fixture(t);
  j.atomic(() => { j.write(root + '/a.json', '{"v":1}'); j.enqueueLaunch('r1', 's1'); j.enqueueHandoff({ id: 'h1', parent: 'sp', task: 'st', version: 'v1', payload: {} }); });
  j.db.prepare('UPDATE documents SET dirty=1').run();
  j.owner = refuse;
  const denied = f => assert.throws(f, e => e.code === 'owner_unavailable');
  denied(() => j.atomic(() => j.write(root + '/b.json', '{}')));
  denied(() => j.write(root + '/b.json', '{}'));
  denied(() => j.append(root + '/e.jsonl', { t: 'x' }));
  denied(() => j.recover());
  for (const f of [() => j.enqueueLaunch('r2', 's1'), () => j.dispatched('r1'), () => j.finishLaunch('r1'), () => j.enqueueHandoff({ id: 'h2', parent: 'sp', task: 'st', version: 'v1', payload: {} }),
    () => j.startHandoff('h1', 'r1'), () => j.settleHandoff('h1', 'delivered'), () => j.retryHandoff('h1')]) denied(f);
  assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 1);
  assert.equal(j.launchRecord('r1').state, 'pending');
  assert.equal(j.handoff('h1').state, 'pending');
  assert.equal(j.pendingLaunches().length, 1);
});

test('一次最外层事务只过一次所有权检查；提交、回滚、抛错之后都放掉；没有要投影的就不去检查', async t => {
  const { root, j } = await fixture(t), c = counting(); j.recover(); j.owner = c;
  j.recover(); assert.deepEqual([c.entered, c.released], [0, 0]);
  j.atomic(() => { j.write(root + '/a.json', '{}'); j.atomic(() => j.enqueueLaunch('r1', 's1')); });
  assert.equal(c.entered, 1); assert.equal(c.released, 1);
  assert.deepEqual(j.atomic(() => ({ error: 'no' })), { error: 'no' });
  assert.throws(() => j.atomic(() => { throw new Error('boom'); }), /boom/);
  assert.deepEqual([c.entered, c.released], [3, 3]);
});

test('记忆表已经建好之后，读记忆不需要写权限；表缺了要建时才过所有权检查', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-state-mem-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = pathToFileURL(path.join(__dirname, '../site/xin/vm-base.mjs')).href, mem = pathToFileURL(path.join(__dirname, '../site/xin/vm-memory.mjs')).href;
  const run = body => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { journal } from ${JSON.stringify(base)}; import * as m from ${JSON.stringify(mem)};
     const refuse = { enter() { throw Object.assign(new Error('owner_alive'), { code: 'owner_unavailable' }); } }; ${body}`], { env: { ...process.env, XIN_HOME: root }, encoding: 'utf8' });
  const fresh = run("journal.owner = refuse; try { m.listMemory(); console.log('read'); } catch (e) { console.log(e.code); }");
  assert.equal(fresh.stdout.trim(), 'owner_unavailable', fresh.stderr);
  assert.equal(run("m.listMemory(); console.log('ready');").stdout.trim(), 'ready');
  const later = run("journal.owner = refuse; m.listMemory(); console.log('read');");
  assert.equal(later.stdout.trim(), 'read', later.stderr);
});
