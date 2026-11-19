// 小芯的记忆（vm-memory.mjs）：分类型、有依据和出处；敏感内容不记；忘掉的不再记回来；旧记事本导入成待确认。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { stateMode } = require('./helpers/state-mode.cjs'), { OWN_IMPORT } = require('./helpers/own-state.cjs'), { tmpDir } = require('./helpers/tmp.cjs');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
const MEMORY = pathToFileURL(path.join(__dirname, '../site/xin/vm-memory.mjs')).href;

function home(t, notebook) {
  const dir = tmpDir('xin-memory-'), xin = path.join(dir, 'xin');   // 进程退出时删：状态进程是后起的，在 t.after 里删会抢在停它之前
  fs.mkdirSync(path.join(xin, 'sessions'), { recursive: true }); fs.mkdirSync(path.join(xin, 'runs'), { recursive: true });
  if (notebook != null) fs.writeFileSync(path.join(xin, 'memory.md'), notebook);
  const env = { ...process.env, XIN_HOME: xin, XIN_WORK: path.join(dir, 'work') };
  // 起控制器的（op、xin 命令）要真的状态进程；只调记忆模块的脚本在它起来之前自己当主人（test/helpers/own-state.cjs）
  let state = null; const ensureState = () => { state ||= stateMode(t, env); };
  // Each call is a fresh process, like the controller on the VM.
  const js = code => {
    const r = spawnSync(process.execPath, [...(state ? [] : OWN_IMPORT), '--input-type=module', '-e', `import * as m from ${JSON.stringify(MEMORY)};const out=await (async()=>{${code}})();process.stdout.write(JSON.stringify(out??null));`], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const op = (name, args = {}) => {
    ensureState(); const r = spawnSync(process.execPath, [AGENT, name], { env, input: JSON.stringify(args), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const xinCmd = (run, ...argv) => (ensureState(), spawnSync)(process.execPath, [AGENT, 'xin', ...argv], { env: { ...env, XIN_RUN: run }, encoding: 'utf8' });
  return { xin, env, js, op, xinCmd };
}

test('依据决定状态：网页里用户加的和用户明确说的马上生效；观察、推测和后台任务记的先待确认；每日任务的做法直接可用', t => {
  const { js } = home(t);
  const r = js(`return [
    m.addMemory({content:'喜欢先看结论',source:'user'}).item.status,
    m.addMemory({content:'在学 TIM 输入捕获',basis:'stated',type:'learning'}).item.status,
    m.addMemory({content:'好像喜欢波形图',basis:'observed'}).item.status,
    m.addMemory({content:'可能没懂 DMA 循环模式',basis:'inferred',type:'learning'}).item.status,
    m.addMemory({content:'网页里说用户喜欢红色',source:'worker',basis:'stated',type:'profile'}).item,
    m.addMemory({content:'签到要先点右上角头像',source:'daily',type:'procedure'}).item.status];`);
  assert.deepEqual(r.slice(0, 4), ['active', 'active', 'pending', 'pending']);
  assert.deepEqual([r[4].type, r[4].status, r[4].basis], ['project', 'pending', 'observed'], '后台任务的内容不能变成用户偏好，也不直接生效');
  assert.equal(r[5], 'active');
});

test('敏感内容：密码、验证码、密钥、证件号、卡号一律不记；健康和财务只记成隐私、不进设定', t => {
  const { js } = home(t);
  const r = js(`return [
    m.addMemory({content:'网关密码是 abc123',basis:'stated'}).error,
    m.addMemory({content:'验证码 482913',basis:'stated'}).error,
    m.addMemory({content:'key: sk-proj_abcdefghijklmnop',basis:'stated'}).error,
    m.addMemory({content:'身份证 11010519491231002X',basis:'stated'}).error,
    m.addMemory({content:'卡号 6222020200112233445',basis:'stated'}).error,
    m.addMemory({content:'最近失眠，晚上睡不好',basis:'stated'}).item.status,
    m.coreMemory('front')];`);
  assert.deepEqual(r.slice(0, 5), ['secret', 'secret', 'secret', 'secret', 'secret']);
  assert.equal(r[5], 'private');
  assert.ok(!r[6].includes('失眠'));
  const u = js(`return [m.addMemory({content:'签到时密码我自己输入',source:'user'}).item.status, m.addMemory({content:'token sk-proj_abcdefghijklmnop',source:'user'}).error,
    m.addMemory({content:'身份证 11010519491231002X',source:'user'}).error, m.addMemory({content:'网关签到不用记密码',source:'legacy'}).item.status, m.addMemory({content:'网关密码是 abc12345',source:'user'}).error,
    m.addMemory({content:'key ghp_abcdefghijklmnopqrstuvwxyz0123',source:'legacy'}).error];`);
  assert.deepEqual(u, ['active', 'secret', 'secret', 'private', 'secret', 'secret'], '用户自己写的说明可以留；密钥、证件号本身谁都不收；旧记事本里提到密码的只当隐私');
});

test('忘掉：删掉内容和出处，只留摘要标记；之后聊天、后台都不能再记回来，用户自己在网页加可以', t => {
  const { js } = home(t);
  const id = js(`return m.addMemory({content:'喜欢熬夜写代码',basis:'stated',evidence:{sid:'sabc12345',run:'rabc12345',quote:'我喜欢熬夜写代码'}}).item.id;`);
  assert.equal(js(`return m.forgetMemory(${JSON.stringify(id)}).ok;`), true);
  const after = js(`const d=(await import(${JSON.stringify(pathToFileURL(path.join(__dirname, '../site/xin/vm-base.mjs')).href)})).journal.db;
    return [d.prepare('SELECT count(*) n FROM memory_items').get().n, d.prepare('SELECT count(*) n FROM memory_evidence').get().n,
      d.prepare("SELECT count(*) n FROM memory_log WHERE detail LIKE '%熬夜%'").get().n,
      m.addMemory({content:'喜欢 熬夜写代码！',basis:'stated'}).error, m.addMemory({content:'喜欢熬夜写代码',source:'worker'}).error,
      m.addMemory({content:'喜欢熬夜写代码',source:'user'}).item.status];`);
  assert.deepEqual(after, [0, 0, 0, 'forgotten', 'forgotten', 'active']);
});

test('按关键词忘掉：只有一条就忘掉；好几条时列出来让用户说清楚，不乱删', t => {
  const { js } = home(t);
  const r = js(`m.addMemory({content:'在做 PWM 呼吸灯',basis:'stated',type:'project'});m.addMemory({content:'PWM 频率喜欢 1kHz',basis:'stated'});
    m.addMemory({content:'用串口 115200',basis:'stated'});
    return [m.forgetByKeyword('PWM').error, m.forgetByKeyword('串口').text, m.forgetByKeyword('不存在的事').error, m.listMemory().length];`);
  assert.deepEqual(r, ['ambiguous', '用串口 115200', 'not_found', 2]);
});

test('旧记事本：第一次用时导入成待确认（保留原文和日期作出处），只导一次，原文件不动；设定里单独标明还没确认', t => {
  const notebook = '# 小芯的记事本\n\n- 2026-11-04：用户叫小李\n- 2026-11-05：在学定时器\n用户自己写的一行\n';
  const { js, xin } = home(t, notebook);
  const r = js(`const first=m.importLegacyNotebook(), again=m.importLegacyNotebook(), list=m.listMemory();
    return {first,again,list:list.map(i=>[i.content,i.status,i.basis,i.type,i.evidence[0].quote,new Date(i.created).toISOString().slice(0,10)]),core:m.coreMemory('front'),worker:m.coreMemory('worker')};`);
  assert.equal(r.first.imported, 3); assert.equal(r.again.skipped, true);
  assert.deepEqual(r.list.map(x => x.slice(0, 4)).sort(), [['在学定时器', 'pending', 'legacy', 'unsorted'], ['用户叫小李', 'pending', 'legacy', 'unsorted'], ['用户自己写的一行', 'pending', 'legacy', 'unsorted']]);
  assert.ok(r.list.some(x => x[4] === '- 2026-11-04：用户叫小李' && x[5] === '2026-11-04'));
  assert.match(r.core, /旧记事本里的内容（用户还没确认/); assert.ok(r.core.includes('用户叫小李'));
  assert.equal(r.worker, '', '后台任务看不到未确认的旧内容');
  assert.equal(fs.readFileSync(path.join(xin, 'memory.md'), 'utf8'), notebook);
});

test('旧记事本后来又多了几行（例如回滚期间旧版本记的）：只补导新行；用户改过或忘掉的原行不会回来；旧格式的导入记录也能接上', t => {
  const notebook = '# 小芯的记事本\n\n- 2026-11-04：用户叫小李\n- 2026-11-05：在学定时器\n';
  const { js, xin } = home(t, notebook);
  const file = path.join(xin, 'memory.md');
  const first = js(`const r=m.importLegacyNotebook();const it=m.listMemory().find(i=>i.content==='在学定时器');m.updateMemory(it.id,{content:'在学定时器和 PWM'},'user');
    const li=m.listMemory().find(i=>i.content==='用户叫小李');m.forgetMemory(li.id,'user');return r;`);
  assert.equal(first.imported, 2);
  fs.appendFileSync(file, '- 2026-11-08：喜欢先看图再看代码\n');
  const r = js(`const r=m.importLegacyNotebook(),again=m.importLegacyNotebook();return {r,again,list:m.listMemory().map(i=>i.content).sort()};`);
  assert.equal(r.r.imported, 1); assert.equal(r.again.skipped, true);
  assert.deepEqual(r.list, ['喜欢先看图再看代码', '在学定时器和 PWM']);
  // A record written before line hashes were kept: rebuilt from the quoted lines, so only the newest line comes in.
  js(`const {journal}=await import(${JSON.stringify(pathToFileURL(path.join(__dirname, '../site/xin/vm-base.mjs')).href)});
    const v=JSON.parse(journal.db.prepare("SELECT value FROM memory_meta WHERE key='legacy_import'").get().value);delete v.lines;
    journal.atomic(()=>journal.db.prepare("UPDATE memory_meta SET value=? WHERE key='legacy_import'").run(JSON.stringify(v)));return null;`);
  fs.appendFileSync(file, '- 2026-11-08：晚上九点后不想被提醒\n');
  const b = js(`return {r:m.importLegacyNotebook(),list:m.listMemory().map(i=>i.content).sort()};`);
  assert.equal(b.r.imported, 1);
  assert.deepEqual(b.list, ['喜欢先看图再看代码', '在学定时器和 PWM', '晚上九点后不想被提醒']);
});

test('设定里给谁看什么：前台不带做事方法；每日任务带；后台任务只带确认过、不隐私的「关于你」', t => {
  const { js } = home(t);
  const r = js(`m.addMemory({content:'称呼小李',source:'user'});m.addMemory({content:'学到 I2C 了',source:'user',type:'learning'});
    m.addMemory({content:'签到先点头像',source:'daily',type:'procedure'});m.addMemory({content:'也许周末有空',basis:'inferred'});
    return [m.coreMemory('front'),m.coreMemory('daily'),m.coreMemory('worker')];`);
  assert.ok(r[0].includes('称呼小李') && r[0].includes('学到 I2C 了') && !r[0].includes('签到先点头像') && !r[0].includes('也许周末有空'));
  assert.ok(r[1].includes('签到先点头像'));
  assert.ok(r[2].includes('称呼小李') && !r[2].includes('学到 I2C 了'));
});

test('确认过的旧记事本 unsorted 在前台和每日任务可见，待确认仍标注；隐私和后台隔离不变',t=>{
  const {js}=home(t);
  const r=js(`const a=m.addMemory({content:'旧笔记：正在做温度记录仪',source:'legacy'}).item;
    m.updateMemory(a.id,{confirm:true});
    m.addMemory({content:'旧笔记：可能喜欢先看例子',source:'legacy'});
    const p=m.addMemory({content:'旧笔记：只在记忆页保留',source:'legacy'}).item;m.updateMemory(p.id,{private:true});
    return {front:m.coreMemory('front'),daily:m.coreMemory('daily'),worker:m.coreMemory('worker')};`);
  for(const audience of ['front','daily']){
    assert.match(r[audience],/旧记事本：\n- 旧笔记：正在做温度记录仪/);
    assert.match(r[audience],/用户还没确认[\s\S]*可能喜欢先看例子/);
    assert.doesNotMatch(r[audience],/只在记忆页保留/);
  }
  assert.doesNotMatch(r.worker,/旧笔记/);
});

test('网页上的记忆页：列出（带出处和对话名）、加、确认、改、设隐私、忘掉；编号不对就拒绝', t => {
  const { op, xin } = home(t);
  fs.writeFileSync(path.join(xin, 'sessions', 'smemchat01.json'), JSON.stringify({ sid: 'smemchat01', agent: 'codex', title: '聊 PWM', runs: [] }));
  const added = op('memory_add', { content: '喜欢先看结论', type: 'profile' });
  assert.equal(added.item.status, 'active');
  // A chat observation with evidence, then confirmed by the user.
  const run = 'rmemchat01'; fs.writeFileSync(path.join(xin, 'runs', run + '.json'), JSON.stringify({ run, sid: 'smemchat01', agent: 'codex', started: Date.now() }));
  fs.writeFileSync(path.join(xin, 'runs', run + '.jsonl'), JSON.stringify({ t: 'user', text: '我还是先看波形吧' }) + '\n');
  const r = spawnSync(process.execPath, [AGENT, 'xin', 'remember', '--basis', 'observed', '好像喜欢先看波形'], { env: { ...process.env, XIN_HOME: xin, XIN_RUN: run }, encoding: 'utf8' });
  assert.match(r.stdout, /候选/);
  let list = op('memory_list');
  const obs = list.items.find(i => i.content === '好像喜欢先看波形');
  assert.equal(obs.status, 'pending'); assert.equal(obs.evidence[0].quote, '我还是先看波形吧'); assert.equal(list.titles.smemchat01, '聊 PWM');
  assert.equal(op('memory_update', { id: obs.id, confirm: true }).item.status, 'active');
  assert.equal(op('memory_update', { id: obs.id, content: '喜欢先看波形再看寄存器' }).item.content, '喜欢先看波形再看寄存器');
  assert.equal(op('memory_update', { id: added.item.id, private: true }).item.status, 'private');
  assert.equal(op('memory_update', { id: added.item.id, private: false }).item.status, 'active');
  assert.equal(op('memory_forget', { id: added.item.id }).ok, true);
  list = op('memory_list');
  assert.deepEqual(list.items.map(i => i.content), ['喜欢先看波形再看寄存器']);
  assert.equal(op('memory_update', { id: '../x' }).error, 'bad_id');
  assert.equal(op('memory_add', { content: '密码 123456' }).error, 'secret');
});

test('后台任务的「记住」进待确认的项目记录；天启里不能记', t => {
  const { op, xin, xinCmd } = home(t);
  const run = 'rmemtask01';
  fs.writeFileSync(path.join(xin, 'runs', run + '.json'), JSON.stringify({ run, sid: 'smemtask01', agent: 'codex', task: true, kind: 'task', started: Date.now() }));
  fs.writeFileSync(path.join(xin, 'runs', run + '.jsonl'), '');
  assert.match(xinCmd(run, 'remember', '--type', 'profile', '--basis', 'stated', '用户喜欢蓝色').stdout, /候选/);
  const it = op('memory_list').items[0];
  assert.deepEqual([it.type, it.status, it.source], ['project', 'pending', 'worker']);
  const tq = 'rmemtq0001';
  fs.writeFileSync(path.join(xin, 'runs', tq + '.json'), JSON.stringify({ run: tq, sid: 'smemtq0001', agent: 'harness', started: Date.now() }));
  fs.writeFileSync(path.join(xin, 'runs', tq + '.jsonl'), '');
  const r = xinCmd(tq, 'remember', '天启记的');
  assert.equal(r.status, 1); assert.match(r.stdout, /天启模式是独立功能/);
  assert.equal(op('memory_list').items.length, 1);
});

test('首次建记忆表的事务回滚后，同一进程仍能重新初始化；数据库改动只新增表，旧结构仍可读', t => {
  const {js} = home(t);
  const r = js(`const {journal}=await import(${JSON.stringify(pathToFileURL(path.join(__dirname, '../site/xin/vm-base.mjs')).href)});
    journal.atomic(()=>{m.addMemory({content:'这条应随事务回滚',source:'user'});return {error:'injected'};});
    const saved=m.addMemory({content:'回滚之后仍能正常记忆',source:'user'});
    const tables=journal.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
    return {status:saved.item.status,content:m.listMemory().map(x=>x.content),tables,
      oldQuery:journal.db.prepare("SELECT content FROM memory_items WHERE status IN ('active','pending','private')").all().map(x=>x.content)};`);
  assert.equal(r.status,'active');assert.deepEqual(r.content,['回滚之后仍能正常记忆']);assert.deepEqual(r.oldQuery,r.content);
  for (const table of ['memory_items','memory_evidence','memory_log','memory_forgotten','memory_meta','memory_versions','memory_replacements']) assert.ok(r.tables.includes(table));
});

test('小芯自己记：「你明确说的」要在本轮原话里找得到，找不到只当候选；汇报后台结果的那一轮和对话之外都不能改记忆', t => {
  const { op, xin, xinCmd } = home(t);
  const chat = (run, text, extra = {}) => {
    fs.writeFileSync(path.join(xin, 'runs', run + '.json'), JSON.stringify({ run, sid: 'smemself01', agent: 'codex', started: Date.now(), ...extra }));
    fs.writeFileSync(path.join(xin, 'runs', run + '.jsonl'), text == null ? '' : JSON.stringify({ t: 'user', text }) + '\n');
  };
  fs.writeFileSync(path.join(xin, 'sessions', 'smemself01.json'), JSON.stringify({ sid: 'smemself01', agent: 'codex', title: '聊天', runs: [] }));
  chat('rmemself01', '那开漏呢');
  // The model claims the owner said something that is nowhere in this turn.
  assert.match(xinCmd('rmemself01', 'remember', '--basis', 'stated', '兄弟是做电机控制的工程师').stdout, /候选/);
  assert.match(xinCmd('rmemself01', 'remember', '--basis', 'stated', '--quote', '我是工程师', '兄弟是工程师').stdout, /候选/, '编出来的引文也不算');
  chat('rmemself02', '以后讲代码都先给结论，\n  再讲细节');
  assert.match(xinCmd('rmemself02', 'remember', '--basis', 'stated', '--quote', '讲代码都先给结论， 再讲细节', '讲代码先给结论再讲细节').stdout, /记住了/, '引文只忽略空白差异');
  chat('rmemself03', '我叫小李');
  assert.match(xinCmd('rmemself03', 'remember', '--basis', 'stated', '我叫小李').stdout, /记住了/, '没给引文时，内容本身就是原话也算');
  const items = Object.fromEntries(op('memory_list').items.map(i => [i.content, [i.status, i.basis, i.evidence[0].quote]]));
  assert.deepEqual(items['兄弟是做电机控制的工程师'], ['pending', 'observed', '那开漏呢']);
  assert.deepEqual(items['兄弟是工程师'].slice(0, 2), ['pending', 'observed']);
  assert.deepEqual(items['讲代码先给结论再讲细节'], ['active', 'stated', '讲代码都先给结论， 再讲细节']);
  assert.deepEqual(items['我叫小李'], ['active', 'stated', '我叫小李']);
  // A completion event carries a worker's output, not the owner's words.
  chat('rmemself04', null, { kind: 'handoff' });
  const h = xinCmd('rmemself04', 'remember', '--basis', 'stated', '兄弟喜欢紫色');
  assert.equal(h.status, 1); assert.match(h.stdout, /不记个人记忆/);
  // Outside a turn of Xiaoxin (no run, or a run that does not exist) memory can be neither written nor erased.
  for (const run of ['', 'rnotarun001']) for (const argv of [['remember', '--basis', 'stated', '随便写一条'], ['forget', '小李']]) {
    const r = spawnSync(process.execPath, [AGENT, 'xin', ...argv], { env: { ...process.env, XIN_HOME: xin, XIN_WORK: path.join(xin, '../work'), XIN_RUN: run }, encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stdout, /不在小芯的对话里/);
  }
  assert.equal(op('memory_list').items.length, 4);
});

test('每日任务的设定只带它自己的做法，不带站长的画像', t => {
  const { js } = home(t);
  const [front, daily] = js(`m.addMemory({content:'回答先给结论',source:'user'});m.addMemory({content:'在做电机控制',source:'user',type:'project'});
    m.addMemory({content:'签到先点头像',source:'daily',type:'procedure'});return [m.coreMemory('front'),m.coreMemory('daily')];`);
  assert.match(front, /回答先给结论/); assert.match(front, /在做电机控制/);
  assert.match(daily, /签到先点头像/); assert.doesNotMatch(daily, /回答先给结论|在做电机控制/);
});
