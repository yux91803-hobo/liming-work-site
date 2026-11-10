// 主对话：一直聊下去的那一个，所有设备共用；别的对话照常新建。归档 = 重新开始，不能直接删。历史能往前翻页。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-main-')), xin = path.join(dir, 'xin');
  fs.mkdirSync(path.join(xin, 'sessions'), { recursive: true }); fs.mkdirSync(path.join(xin, 'runs'), { recursive: true });
  // Stand-in CLIs first on PATH: a test must never start a real agent that happens to be installed on this machine.
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  for (const cmd of ['claude', 'codex', 'agy']) fs.writeFileSync(path.join(bin, cmd), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, XIN_HOME: xin, XIN_WORK: path.join(dir, 'work'), XIN_DSH: path.join(dir, 'no-dsh'), XIN_FRONT_PROVIDER: 'deepseek',
    XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), PATH: bin + ':' + process.env.PATH };
  const op = (name, args = {}) => {
    const r = spawnSync(process.execPath, [AGENT, name], { env, input: JSON.stringify(args), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  // 等这一轮结束（没有真实模型，前台会很快报错收尾），下一句才发得进去
  const settle = run => { for (let i = 0; i < 200; i++) { if (op('poll', { run, off: 0 }).done) return; spawnSync('sleep', ['0.1']); } assert.fail('这一轮没有结束'); };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sess = sid => JSON.parse(fs.readFileSync(path.join(xin, 'sessions', sid + '.json'), 'utf8'));
  return { dir, xin, op, settle, sess };
}

test('主对话：第一句开出来，之后不带编号的话都进同一个；别的对话照常新建，互不影响', t => {
  const { op, settle, sess, xin } = home(t);
  assert.equal(op('greet').main, null);
  const a = op('send', { main: true, text: '你好', clientId: 'main-first-0001' });
  assert.ok(a.sid && a.run && a.main === true && a.agent === 'codex', JSON.stringify(a));
  assert.equal(sess(a.sid).main, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(xin, 'main.json'), 'utf8')), { sid: a.sid });
  assert.equal(op('greet').main, a.sid);
  // 同一句重发（断网后原样再发）：还是原来的回执，不多一轮
  assert.deepEqual(op('send', { main: true, text: '你好', clientId: 'main-first-0001' }), a);
  settle(a.run);
  const b = op('send', { main: true, text: '接着说', clientId: 'main-next-00002' });
  assert.equal(b.sid, a.sid); assert.notEqual(b.run, a.run); assert.equal(sess(a.sid).runs.length, 2);
  settle(b.run);
  assert.deepEqual(op('send', { main: true, text: '接着说', clientId: 'main-next-00002' }), b);
  const other = op('send', { text: '另一个话题' });
  assert.notEqual(other.sid, a.sid); assert.equal(other.main, undefined); assert.equal(sess(other.sid).main, undefined);
  const list = op('sessions').sessions;
  assert.equal(list[0].sid, a.sid); assert.equal(list[0].main, true);
  assert.deepEqual(list.filter(s => s.main).map(s => s.sid), [a.sid]);
});

test('主对话只属于默认模式：天启的新对话带了 main 也只是普通对话', t => {
  const { op, sess } = home(t);
  const h = op('send', { main: true, agent: 'harness', text: '你好' });
  assert.equal(h.agent, 'harness'); assert.equal(h.main, undefined); assert.equal(sess(h.sid).main, undefined);
  assert.equal(op('greet').main, null);
});

test('主对话不能直接删；归档后变回普通对话、记录都在，下一句开一个新的主对话', t => {
  const { op, settle, sess } = home(t);
  const a = op('send', { main: true, text: '第一段' }); settle(a.run);
  const del = op('forget', { sid: a.sid });
  assert.equal(del.error, 'main'); assert.match(del.msg, /归档/); assert.equal(sess(a.sid).runs.length, 1);
  assert.equal(op('archive', { sid: a.sid, on: true }).session.archived, true);
  assert.equal(sess(a.sid).main, undefined); assert.equal(op('greet').main, null);
  const b = op('send', { main: true, text: '重新开始' }); settle(b.run);
  assert.notEqual(b.sid, a.sid); assert.equal(b.main, true); assert.equal(op('greet').main, b.sid);
  // 取消归档：旧的那个还是普通对话，不会抢回主对话
  op('archive', { sid: a.sid, on: false });
  assert.equal(sess(a.sid).main, undefined); assert.equal(op('greet').main, b.sid);
  assert.equal(op('history', { sid: a.sid }).runs.length, 1);
  assert.equal(op('forget', { sid: a.sid }).ok, true);
});

test('历史一页 30 轮，带 before 往前翻；更早的那页不算「正在回复」', t => {
  const { op, xin } = home(t);
  const runs = Array.from({ length: 70 }, (_, i) => 'r' + String(i).padStart(8, '0'));
  for (const [i, run] of runs.entries()) {
    fs.writeFileSync(path.join(xin, 'runs', run + '.json'), JSON.stringify({ run, sid: 'smainpage01', agent: 'codex', started: 1000 + i, ended: 2000 + i, code: 0 }));
    fs.writeFileSync(path.join(xin, 'runs', run + '.jsonl'), [{ t: 'user', text: '问 ' + i }, { t: 'text', text: '答 ' + i }, { t: 'done', ok: true }].map(e => JSON.stringify(e)).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(xin, 'sessions', 'smainpage01.json'), JSON.stringify({ sid: 'smainpage01', agent: 'codex', main: true, title: '小芯', started: true, runs, created: 1, updated: 2 }));
  const p1 = op('history', { sid: 'smainpage01' });
  assert.deepEqual(p1.runs.map(r => r.run), runs.slice(40)); assert.equal(p1.more, true); assert.equal(p1.session.main, true);
  const p2 = op('history', { sid: 'smainpage01', before: p1.runs[0].run });
  assert.deepEqual(p2.runs.map(r => r.run), runs.slice(10, 40)); assert.equal(p2.more, true); assert.equal(p2.active, null);
  assert.equal(p2.runs[0].events[0].text, '问 10');
  const p3 = op('history', { sid: 'smainpage01', before: p2.runs[0].run });
  assert.deepEqual(p3.runs.map(r => r.run), runs.slice(0, 10)); assert.equal(p3.more, false);
  // 不认识的 before：当作没带，给最近一页
  assert.deepEqual(op('history', { sid: 'smainpage01', before: 'rnotthere01' }).runs.map(r => r.run), runs.slice(40));
});
