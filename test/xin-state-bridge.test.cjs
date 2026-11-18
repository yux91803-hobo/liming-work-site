const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process'), { pathToFileURL } = require('node:url');
const url = name => pathToFileURL(path.join(__dirname,'../site/xin/'+name+'.mjs')).href;
const load = async () => ({ ...(await import(url('vm-kernel-client'))), ...(await import(url('vm-kernel-state'))), ...(await import(url('vm-kernel-owner'))) });
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(predicate) { const end=performance.now()+3000; while(!predicate()){assert.ok(performance.now()<end,'等待状态检查超时');await pause(5);} }
function home(t) { const p=fs.mkdtempSync(path.join(os.tmpdir(),'xin-bridge-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p; }
async function local(t, handle, extra={}) {
  const h=home(t), m=await load(), logs=[];
  const server=await m.createStateServer({home:h,handle,log:r=>logs.push(r),...extra});
  t.after(async()=>{await server.close();await server.closed;});
  return {home:h,server,logs,...m};
}
async function actor(t,h) {
  const source=`import {createStateServer} from ${JSON.stringify(url('vm-kernel-state'))};
    import {StateJournal,inputDigest} from ${JSON.stringify(url('vm-state'))};import fs from 'node:fs';
    const home=${JSON.stringify(h)},j=new StateJournal(home);
    const s=await createStateServer({home,initialize:()=>j.recover(),beforeRelease:()=>j.close(),handle:async q=>{
      if(q.op==='delay')await new Promise(r=>setTimeout(r,q.args.ms));
      if(q.op==='write')return j.atomic(()=>{const f=home+'/count.json';let n=0;try{n=JSON.parse(fs.readFileSync(f)).n}catch{}j.write(f,JSON.stringify({n:n+1}));return {n:n+1,pid:process.pid};},{id:q.id,digest:inputDigest(q.args)});
      return {pid:process.pid,text:q.args?.text};
    }});console.log('ready');process.stdin.resume();process.stdin.on('end',()=>s.close());
    s.closed.then(()=>{process.stdin.destroy();});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['pipe','pipe','pipe']});
  let err='';child.stderr.on('data',b=>err+=b);
  const done=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  t.after(async()=>{child.kill('SIGKILL');await done;});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('state actor did not start: '+err)),5000);
    child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',()=>{clearTimeout(timer);reject(Error(err));});
  });
  return {child,done};
}

test('状态进程独占所有权，异步请求保留中文；套接字和目录为私有',async t=>{
  const f=await local(t,q=>({text:q.args.text,pid:process.pid}));
  assert.equal(fs.statSync(path.dirname(f.server.file)).mode&0o777,0o700);
  assert.equal(fs.statSync(f.server.file).mode&0o777,0o600);
  const o=new f.Ownership(f.home,{waitMs:10});t.after(()=>o.close());
  assert.deepEqual(o.record(),{busy:true});
  assert.deepEqual(await f.requestState(f.home,{kind:'op',op:'echo',args:{text:'中文🙂'}}),{text:'中文🙂',pid:process.pid});
});

test('同步桥反复调用同一个常驻进程；辅助进程不加载控制器',async t=>{
  const h=home(t),m=await load(),a=await actor(t,h);
  for(let i=0;i<5;i++)assert.deepEqual(m.requestStateSync(h,{kind:'op',op:'echo',args:{text:String(i)}}),{pid:a.child.pid,text:String(i)});
});

test('没连上是未执行；序列化失败和超大请求不发送',async t=>{
  const h=home(t),m=await load();
  await assert.rejects(m.requestState(h,{kind:'op',op:'echo'}),e=>e.executed===false);
  assert.throws(()=>m.requestStateSync(h,{kind:'op',op:'echo'}),e=>e.executed===false);
  await assert.rejects(m.requestState(h,{kind:'op',args:{x:1n}}),e=>e.code==='state_request'&&e.executed===false);
  assert.throws(()=>m.requestStateSync(h,{kind:'op',args:{x:1n}}),e=>e.code==='state_request'&&e.executed===false);
  await assert.rejects(m.requestState(h,{kind:'op',args:{text:'x'.repeat(m.FRAME_MAX)}}),e=>e.executed===false);
  assert.equal(fs.existsSync(path.join(h,'workflow.sqlite')),false);
});

test('发出后超时是不确定；迟到回应不串到下一次调用，也不自动重做',async t=>{
  let count=0;const f=await local(t,async q=>{if(q.op==='slow'){count++;await pause(100);}return q.op;});
  await assert.rejects(f.requestState(f.home,{kind:'op',op:'slow'},{timeoutMs:20}),e=>e.code==='state_timeout'&&e.executed==='unknown');
  assert.equal(await f.requestState(f.home,{kind:'op',op:'next'}),'next');
  await pause(120);assert.equal(count,1);
});

test('丢回应后用同一编号重送，已提交的写入和回执不重复',async t=>{
  const h=home(t),m=await load();await actor(t,h);
  const req={kind:'op',op:'write',args:{value:1}},id='stable-client-0001';
  const a=m.requestStateSync(h,req,{id}),b=m.requestStateSync(h,req,{id});
  assert.equal(a.n,1);assert.deepEqual(b,a);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h,'count.json'))).n,1);
  assert.equal(m.requestStateSync(h,{...req,args:{value:2}},{id}).error,'message_conflict');
});

test('异步等待时可以接收另一个请求，不把整条请求队列锁住',async t=>{
  let finish;const f=await local(t,q=>q.op==='wait'?new Promise(resolve=>{finish=resolve;}):finish('reported'));
  const waiting=f.requestState(f.home,{kind:'op',op:'wait'});
  while(!finish)await pause(5);
  await f.requestState(f.home,{kind:'named',op:'report'});
  assert.equal(await waiting,'reported');
});

test('公开请求占满并发额度后仍能接收回报，避免等待登录/任务回报时互锁',async t=>{
  const waiting=[];const f=await local(t,q=>q.op==='wait'?new Promise(resolve=>waiting.push(resolve)):(waiting.splice(0).forEach(resolve=>resolve('done')),'reported'),{maxActive:2});
  const a=f.requestState(f.home,{kind:'op',op:'wait'}),b=f.requestState(f.home,{kind:'op',op:'wait'});
  while(waiting.length<2)await pause(5);
  await assert.rejects(f.requestState(f.home,{kind:'op',op:'extra'}),e=>e.code==='state_busy'&&e.executed===false);
  assert.equal(await f.requestState(f.home,{kind:'op',locked:true,op:'report'}),'reported');
  assert.deepEqual(await Promise.all([a,b]),['done','done']);
});

test('排空拒绝新前台请求，但允许报告完成已有等待，随后放锁退出：记录留在 kernel，等下一个主人（删旧模式第 2 步：不再回 legacy）',async t=>{
  let finish;const f=await local(t,q=>q.op==='wait'?new Promise(resolve=>{finish=resolve;}):finish('done'));
  const waiting=f.requestState(f.home,{kind:'op',op:'wait'});while(!finish)await pause(5);
  const release=f.requestState(f.home,{kind:'control',op:'release'});
  await pause(10);
  await assert.rejects(f.requestState(f.home,{kind:'op',op:'new'}),e=>e.code==='state_draining'&&e.executed===false);
  await f.requestState(f.home,{kind:'named',op:'report'});assert.equal(await waiting,'done');
  assert.equal((await release).mode,'kernel');
  const o=new f.Ownership(f.home);t.after(()=>o.close());
  await assert.rejects(f.requestState(f.home,{kind:'op',op:'new'}),e=>e.executed===false);
  const r=o.record();assert.deepEqual([r.mode,r.epoch],['kernel',1]);
});

test('kill -9 后内核记录保留；新主人恢复提交，旧写者不能趁空写',async t=>{
  const h=home(t),m=await load(),a=await actor(t,h);
  const req={kind:'op',op:'write',args:{}},id='stable-crash-0001';const first=m.requestStateSync(h,req,{id});
  a.child.kill('SIGKILL');await a.done;
  const o=new m.Ownership(h,{waitMs:10});t.after(()=>o.close());
  assert.deepEqual([o.record().mode,o.record().epoch],['kernel',1]);
  await assert.rejects(m.requestState(h,req,{id}),e=>e.executed===false);
  const b=await actor(t,h);assert.notEqual(b.child.pid,first.pid);
  assert.deepEqual(m.requestStateSync(h,req,{id}),first);assert.equal(JSON.parse(fs.readFileSync(path.join(h,'count.json'))).n,1);
});

test('SIGSTOP/CONT 超时有界，恢复后仍可请求且不接错回应',async t=>{
  const h=home(t),m=await load(),a=await actor(t,h);a.child.kill('SIGSTOP');
  const t0=performance.now();await assert.rejects(m.requestState(h,{kind:'op',op:'echo'},{timeoutMs:50}),e=>e.executed==='unknown');
  assert.ok(performance.now()-t0<1000);a.child.kill('SIGCONT');
  assert.equal((await m.requestState(h,{kind:'op',op:'echo',args:{text:'恢复'}})).text,'恢复');
});

test('未知协议不执行，出错和诊断不抄请求正文',async t=>{
  let calls=0;const secret='synthetic-private-cookie';const f=await local(t,()=>{calls++;throw Error(secret);});
  const reply=await new Promise(resolve=>{const c=net.createConnection(f.server.file);let s='';c.on('data',b=>s+=b);c.on('end',()=>resolve(JSON.parse(s)));c.end(JSON.stringify({v:99,id:'invalid-version-1',kind:'op'})+'\n');});
  assert.equal(reply.executed,false);assert.equal(calls,0);
  await assert.rejects(f.requestState(f.home,{kind:'op',op:'fail',args:{text:secret}}),e=>e.code==='state_failed'&&!e.message.includes(secret));
  assert.equal(JSON.stringify(f.logs).includes(secret),false);
});

test('套接字路径是普通文件或目录软链接时拒绝，原文件保留',async t=>{
  const h=home(t),m=await load();fs.mkdirSync(path.join(h,'run'));fs.writeFileSync(m.stateSocket(h),'keep');
  await assert.rejects(m.createStateServer({home:h,handle:()=>{}}));assert.equal(fs.readFileSync(m.stateSocket(h),'utf8'),'keep');
  const o=new m.Ownership(h);t.after(()=>o.close());
  assert.deepEqual(o.record(),{mode:'legacy',epoch:0,protocol:0,since:0},'启动校验失败，不能提前提交接管记录');
  fs.unlinkSync(m.stateSocket(h));fs.rmdirSync(path.join(h,'run'));const other=home(t);fs.symlinkSync(other,path.join(h,'run'));
  await assert.rejects(m.createStateServer({home:h,handle:()=>{}}));assert.deepEqual(fs.readdirSync(other),[]);
});

// 第 2 批 Task 1：设计 §6.9 第 2 步「让控制器做一次一致的备份（VACUUM INTO）」；计划定的：一天最多一次，留最新两份
test('切换前的一致备份：一天最多一次，留最新两份，目录 0700、文件 0600',async t=>{
  const h=home(t),m=await load(),{DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(path.join(h,'workflow.sqlite'));t.after(()=>db.close());
  db.exec("CREATE TABLE notes(text TEXT);INSERT INTO notes VALUES('切换前的一行')");
  const T=1794550000000,dir=path.join(h,'backups','owner-switch');
  const first=m.snapshotBeforeSwitch(db,h,{now:T});
  assert.ok(first&&path.dirname(first)===dir,String(first));
  const copy=new DatabaseSync(first,{readOnly:true});assert.equal(copy.prepare('SELECT text FROM notes').get().text,'切换前的一行');copy.close();
  assert.equal(fs.statSync(dir).mode&0o777,0o700);assert.equal(fs.statSync(first).mode&0o777,0o600);
  assert.equal(m.snapshotBeforeSwitch(db,h,{now:T+3600e3}),null,'一天之内不再备份');
  const second=m.snapshotBeforeSwitch(db,h,{now:T+25*3600e3});assert.ok(second&&second!==first);
  const third=m.snapshotBeforeSwitch(db,h,{now:T+50*3600e3});assert.ok(third);
  assert.deepEqual(fs.readdirSync(dir).sort(),[path.basename(second),path.basename(third)].sort(),'只留最新两份，没有临时文件');
});

test('恢复检查：启动即扫；墙上时间跳过 30 秒或倒退时，请求立即触发检查，空闲仍是 60 秒',async t=>{
  let wall=100000,calls=0;
  const f=await local(t,()=>({calls}),{tickMs:60000,wallClock:()=>wall,tick:()=>{calls++;return 60000;}});
  await until(()=>calls===1);
  assert.equal((await f.requestState(f.home,{kind:'control',op:'health'})).nextTickMs,60000);
  wall+=30000;assert.equal((await f.requestState(f.home,{kind:'op',op:'read'})).calls,1);
  wall++;assert.equal((await f.requestState(f.home,{kind:'op',op:'read'})).calls,2);
  wall-=3600000;assert.equal((await f.requestState(f.home,{kind:'op',op:'read'})).calls,3);
  assert.equal((await f.requestState(f.home,{kind:'op',op:'read'})).calls,3);
  await pause(30);assert.equal(calls,3);
});

test('恢复检查不重叠：通知异步等待期间仍可处理请求，长时间跳跃也只保持一次检查',async t=>{
  let wall=100000,calls=0,scans=0,finish;
  const f=await local(t,()=>({calls,scans}),{tickMs:60000,wallClock:()=>wall,reconcile:()=>{scans++;},tick:()=>{calls++;return new Promise(resolve=>{finish=()=>resolve(60000);});}});
  await until(()=>calls===1);
  wall+=3600000;
  const values=await Promise.all(Array.from({length:8},()=>f.requestState(f.home,{kind:'op',op:'read'})));
  assert.ok(values.every(r=>r.calls===1&&r.scans===2));assert.equal(calls,1);finish();
  await pause(10);
  assert.deepEqual(await f.requestState(f.home,{kind:'op',op:'read'}),{calls:1,scans:2});
  await pause(10);
  assert.equal((await f.requestState(f.home,{kind:'control',op:'health'})).active,0);
});

test('SIGSTOP/CONT：空闲 owner 恢复后的首个请求先扫状态，不等待剩余 60 秒',async t=>{
  const h=home(t),m=await load(),clock=path.join(h,'wall'),count=path.join(h,'sweeps');fs.writeFileSync(clock,'100000');
  const source=`import fs from 'node:fs';import {createStateServer} from ${JSON.stringify(url('vm-kernel-state'))};
    let sweeps=0;const server=await createStateServer({home:${JSON.stringify(h)},tickMs:60000,
      wallClock:()=>Number(fs.readFileSync(${JSON.stringify(clock)},'utf8')),
      tick:()=>{fs.writeFileSync(${JSON.stringify(count)},String(++sweeps));return 60000;},handle:()=>({sweeps})});
    console.log('ready');process.stdin.resume();process.stdin.on('end',()=>server.close());server.closed.then(()=>process.stdin.destroy());`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['pipe','pipe','pipe']});
  let error='';child.stderr.on('data',b=>error+=b);const exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{child.kill('SIGCONT');child.kill('SIGKILL');await exited;});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(error||'owner 未就绪')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});});
  await until(()=>fs.existsSync(count)&&fs.readFileSync(count,'utf8')==='1');
  child.kill('SIGSTOP');fs.writeFileSync(clock,'3700000');child.kill('SIGCONT');
  const result=await m.requestState(h,{kind:'op',op:'read'},{timeoutMs:2000});assert.equal(result.sweeps,2);
  assert.equal((await m.requestState(h,{kind:'control',op:'health'})).nextTickMs,60000);
});

test('空闲转有活：新工作把 60 秒等待提前，持续轮询不把到期检查往后推',async t=>{
  let busy=false,calls=0;
  const f=await local(t,q=>{if(q.op==='new')busy=true;return {calls};},{tickMs:40,hasWork:()=>busy,tick:()=>{calls++;return busy?40:60000;}});
  await until(()=>calls===1);await f.requestState(f.home,{kind:'op',op:'new'});
  assert.equal((await f.requestState(f.home,{kind:'control',op:'health'})).nextTickMs,40);
  const end=performance.now()+300;
  while(performance.now()<end)await f.requestState(f.home,{kind:'op',op:'poll'});
  assert.ok(calls>=2,'轮询期间也要按时核对，不能每次请求重置等待');
  busy=false;await until(()=>calls>=3);
  await until(()=>!busy);await pause(50);
  assert.equal((await f.requestState(f.home,{kind:'control',op:'health'})).nextTickMs,60000);
});

test('新工作在通知结束的边界提交：异步循环结束时重查有无工作，不沿用过期的空闲间隔',async t=>{
  let busy=false,finish;
  const f=await local(t,q=>{if(q.op==='new')busy=true;return {};},{tickMs:40,hasWork:()=>busy,tick:()=>new Promise(resolve=>{finish=()=>resolve(60000);})});
  await until(()=>!!finish);await f.requestState(f.home,{kind:'op',op:'new'});finish();
  await pause(5);assert.equal((await f.requestState(f.home,{kind:'control',op:'health'})).nextTickMs,40);
  busy=false;finish();
});
