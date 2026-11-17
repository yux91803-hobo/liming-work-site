const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process'), { pathToFileURL } = require('node:url');
const url = name => pathToFileURL(path.join(__dirname, '../site/xin/' + name + '.mjs')).href;
const client = () => import(url('vm-kernel-client'));
const failure = (code = 'state_disconnected', executed = 'unknown') => Object.assign(new Error(code), { code, executed });

function clockOptions(deadlineMs = 300) {
  let now = 0;
  const sleeps = [];
  return { deadlineMs, clock: () => now, sleep: ms => { sleeps.push(ms); now += ms; }, sleeps };
}

test('报告重试只开放已核对的三个操作；普通未知写不重放', async () => {
  const { retryLockedReport, retryUnsent } = await client();
  for (const op of ['front_immediate', 'front_model', 'agy_conversation']) {
    let calls = 0;
    assert.equal(retryLockedReport(op, () => { if (++calls === 1) throw failure(); return 'reported'; }, clockOptions()), 'reported', op);
    assert.equal(calls, 2, op);
  }
  for (const op of ['task_new', 'task_finish', 'run_complete', 'front_action', 'steer_take', 'front_quota', 'agy_quota', 'future_report']) {
    let calls = 0;
    assert.throws(() => retryLockedReport(op, () => { calls++; throw failure(); }, clockOptions()), e => e.code === 'state_disconnected', op);
    assert.equal(calls, 1, op);
  }
  let calls = 0;
  assert.throws(() => retryUnsent(() => { calls++; throw failure(); }, clockOptions()), e => e.executed === 'unknown');
  assert.equal(calls, 1, '原入口继续拒绝未知执行结果');
});

test('报告重试不吞协议、过期 attempt、业务失败；共享一个单调截止时间', async () => {
  const { retryLockedReport } = await client();
  for (const code of ['state_response', 'state_protocol', 'state_request', 'state_too_large', 'state_failed', 'stale', 'stale_attempt']) {
    for (const executed of [false, 'unknown', true]) {
      let calls = 0;
      assert.throws(() => retryLockedReport('front_model', () => { calls++; throw failure(code, executed); }, clockOptions()), e => e.code === code);
      assert.equal(calls, 1, code + ':' + executed);
    }
  }
  const options = clockOptions(), remaining = [];
  assert.throws(() => retryLockedReport('front_immediate', left => { remaining.push(left); throw failure(); }, options), e => e.executed === 'unknown');
  assert.deepEqual(remaining, [300, 250, 150]);
  assert.deepEqual(options.sleeps, [50, 100, 150]);
  for (const code of ['state_busy', 'state_draining', 'owner_unavailable']) {
    let calls = 0;
    assert.equal(retryLockedReport('front_model', () => { if (++calls === 1) throw failure(code, false); return 'ok'; }, clockOptions()), 'ok');
    assert.equal(calls, 2);
  }
  let calls = 0;
  assert.throws(() => retryLockedReport('front_model', () => {
    throw ++calls === 1 ? failure() : failure('owner_unavailable', false);
  }, clockOptions()), e => e.code === 'state_disconnected' && e.executed === 'unknown', '后来的连接失败不能把之前是否提交未知说成确定未执行');
  for (const deadlineMs of [0, -1, NaN, Infinity, 300001]) {
    assert.throws(() => retryLockedReport('front_model', () => assert.fail('错误预算不得调用'), { deadlineMs }), e => e.code === 'state_request');
  }
});

// Separate process: the synchronous helper must use a real socket while its caller
// blocks. Controller.handle owns the actual bridge:<id> transaction, not a mock cache.
async function actor(t, mode = 'after') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-report-'));
  const source = `import net from 'node:net'; import fs from 'node:fs'; import path from 'node:path';
    import { createController } from ${JSON.stringify(url('vm-kernel-controller'))};
    import { journal } from ${JSON.stringify(url('vm-base'))};
    import { stateSocket } from ${JSON.stringify(url('vm-kernel-client'))};
    const home=process.env.XIN_HOME, mode=${JSON.stringify(mode)}, seen=new Set();
    const c=createController({ops:{probe:()=>({ok:true})},iops:{},dispatchLaunches:()=>{},
      xinCmd:()=>0,withCallContext:fn=>fn()});
    fs.mkdirSync(path.join(home,'run'),{recursive:true});
    const server=net.createServer(socket=>{let body='';socket.on('error',()=>{});socket.on('data',b=>{
      body+=b; if(!body.includes('\\n'))return;
      const q=JSON.parse(body.split('\\n')[0]);
      fs.appendFileSync(path.join(home,'requests.jsonl'),JSON.stringify(q)+'\\n');
      const first=!seen.has(q.id);seen.add(q.id);
      if(mode==='before'&&first){socket.destroy();return;}
      const result=c.handle(q);
      if(mode==='depart'&&first){socket.destroy();server.close();return;}
      if(mode==='always'||mode==='after'&&first){socket.destroy();return;}
      if(mode==='protocol'){socket.end(JSON.stringify({v:999,id:q.id,ok:true,result})+'\\n');return;}
      socket.end(JSON.stringify({v:q.v,id:q.id,ok:true,result})+'\\n');
    });});
    server.listen(stateSocket(home),()=>console.log('ready'));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, XIN_HOME: home }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let errors = ''; child.stderr.on('data', b => errors += b);
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill('SIGKILL'); await exited; fs.rmSync(home, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('报告进程没有就绪：' + errors)), 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', () => { clearTimeout(timer); reject(Error(errors)); });
  });
  const requests = () => fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { home, requests };
}

function inspect(home, fn) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'workflow.sqlite'), { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

test('append 已提交但真实套接字丢回包：自动重送保留 ID，事件和事务回执各一条', async t => {
  const f = await actor(t), { requestStateSync } = await client();
  const q = { kind: 'append', name: 'runs/rreport01.jsonl', event: { t: 'note', text: '只记一次' } };
  assert.equal(requestStateSync(f.home, q), undefined);
  const requests = f.requests();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].id, requests[1].id);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(inspect(f.home, db => db.prepare('SELECT COUNT(*) n FROM appends').get().n), 1);
  assert.equal(inspect(f.home, db => db.prepare('SELECT COUNT(*) n FROM commands').get().n), 1);
  const rows = fs.readFileSync(path.join(f.home, q.name), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1); assert.equal(rows[0].text, '只记一次');
});

test('write 处理前断线：同 ID 重投一次提交；显式 ID 再取同回执，换正文拒绝', async t => {
  const f = await actor(t, 'before'), { requestStateSync } = await client();
  const q = { kind: 'write', name: 'contexts/sreport1.json', body: JSON.stringify({ text: '上下文' }) }, options = { id: 'report-write-0001' };
  assert.equal(requestStateSync(f.home, q, options), undefined);
  assert.equal(requestStateSync(f.home, q, options), undefined);
  assert.equal(requestStateSync(f.home, { ...q, body: '{}' }, options).error, 'message_conflict');
  assert.equal(fs.readFileSync(path.join(f.home, q.name), 'utf8'), q.body);
  assert.equal(inspect(f.home, db => db.prepare('SELECT revision FROM documents WHERE name=?').get(q.name).revision), 1);
  assert.ok(f.requests().every(r => r.id === options.id));
});

test('非幂等 named 增量报告丢 ACK：真实控制器的事务回执阻止重复增加', async t => {
  const f = await actor(t), { requestStateSync } = await client();
  const q = { kind: 'named', name: 'companion.bond', args: ['ai', 2, '合成测试', 1794900000000] };
  assert.deepEqual(requestStateSync(f.home, q), { delta: 2, score: 2 });
  const bond = JSON.parse(fs.readFileSync(path.join(f.home, 'bond.json'), 'utf8'));
  assert.equal(bond.score, 2); assert.equal(bond.log.length, 1);
  assert.equal(f.requests().length, 2);
  assert.equal(f.requests()[0].id, f.requests()[1].id);
  assert.equal(inspect(f.home, db => db.prepare('SELECT COUNT(*) n FROM commands').get().n), 1);
});

test('xin、任意 op 和新 named 未知结果默认不重投；协议错误也不重试', async t => {
  const { requestStateSync } = await client();
  for (const q of [{ kind: 'op', op: 'probe' }, { kind: 'xin', argv: [] }, { kind: 'named', name: 'future.named', args: [] }]) {
    const f = await actor(t);
    assert.throws(() => requestStateSync(f.home, q), e => e.code === 'state_disconnected' && e.executed === 'unknown');
    assert.equal(f.requests().length, 1, q.kind);
  }
  const f = await actor(t, 'protocol');
  assert.throws(() => requestStateSync(f.home, { kind: 'append', name: 'reports.jsonl', event: {} }), e => e.code === 'state_response');
  assert.equal(f.requests().length, 1);
});

test('持续丢 ACK 的数据库报告按截止时间退出；数据库中的提交仍只有一条', async t => {
  const f = await actor(t, 'always'), { requestStateSync } = await client();
  const start = performance.now();
  assert.throws(() => requestStateSync(f.home, { kind: 'append', name: 'reports.jsonl', event: { t: 'note' } }, { deadlineMs: 600 }), e => e.executed === 'unknown');
  assert.ok(performance.now() - start < 4000, 'helper 的截止时间有界');
  const requests = f.requests();
  assert.ok(requests.length > 1); assert.equal(new Set(requests.map(r => r.id)).size, 1);
  assert.equal(inspect(f.home, db => db.prepare('SELECT COUNT(*) n FROM appends').get().n), 1);
});

test('提交后进程退出且一直未恢复：最终保留 unknown，外层默认重试不能换 ID 再做', async t => {
  const f = await actor(t, 'depart'), { requestStateSync, retryUnsent } = await client();
  let calls = 0;
  assert.throws(() => retryUnsent(() => {
    calls++;
    return requestStateSync(f.home, { kind: 'append', name: 'reports.jsonl', event: { t: 'note' } }, { deadlineMs: 300 });
  }, clockOptions()), e => e.code === 'state_disconnected' && e.executed === 'unknown');
  assert.equal(calls, 1);
  assert.equal(f.requests().length, 1);
  assert.equal(inspect(f.home, db => db.prepare('SELECT COUNT(*) n FROM appends').get().n), 1);
});


async function healthActor(t, mode = 'recover') {
  const net = require('node:net'), { stateSocket } = await client();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-health-retry-'));
  fs.mkdirSync(path.join(home, 'run'));
  const requests = [];
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    let body = ''; socket.on('error', () => {});
    socket.on('data', b => {
      body += b; if (!body.includes('\n')) return;
      const q = JSON.parse(body.split('\n')[0]); requests.push(q);
      if (mode === 'recover' && requests.length === 1) { socket.destroy(); return; }
      socket.end(JSON.stringify({ v: mode === 'protocol' ? 999 : q.v, id: q.id, ok: true, result: { ready: true } }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(stateSocket(home), resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, requests };
}

test('启动健康探测完整帧后断线：异步等待恢复，只重发只读 health', async t => {
  const f = await healthActor(t), { waitForState } = await client();
  assert.deepEqual(await waitForState(f.home), { ready: true });
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(q => q.kind === 'control' && q.op === 'health'));
});

test('启动健康探测协议错误不重试；永久失联和错误预算有界退出', async t => {
  const f = await healthActor(t, 'protocol'), { waitForState } = await client();
  await assert.rejects(waitForState(f.home), e => e.code === 'state_response');
  assert.equal(f.requests.length, 1);
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-health-missing-'));
  t.after(() => fs.rmSync(missing, { recursive: true, force: true }));
  const start = performance.now();
  await assert.rejects(waitForState(missing, { deadlineMs: 150 }), e => e.code === 'owner_unavailable');
  assert.ok(performance.now() - start < 2500, '失联不能无界重试');
  for (const deadlineMs of [0, -1, NaN, Infinity, 300001]) await assert.rejects(waitForState(f.home, { deadlineMs }), e => e.code === 'state_request');
  assert.equal(f.requests.length, 1, '非法预算不能发送请求');
});
