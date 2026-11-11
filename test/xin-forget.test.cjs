// 删对话时连它在状态库之外留下的东西一起删（审查问题 5）；别的对话的不动。每日清理只删过期的写回备份和推送条目。
const test = require('node:test');
const { platformTimeout } = require('./helpers/timeout.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-forget-')), xin = path.join(dir, 'xin'), tmp = path.join(dir, 'tmp');
  for (const d of ['sessions', 'runs', 'messages', 'outbox', 'logs', 'workspaces', 'budgets', 'previews', 'backups']) fs.mkdirSync(path.join(xin, d), { recursive: true });
  fs.mkdirSync(tmp);
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  for (const cmd of ['claude', 'codex', 'agy']) fs.writeFileSync(path.join(bin, cmd), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // TMPDIR：任务副本（os.tmpdir()/xin-task-<编号>）放在这个测试自己的目录里
  const env = { ...process.env, TMPDIR: tmp, XIN_HOME: xin, XIN_WORK: path.join(dir, 'work'), XIN_DSH: path.join(dir, 'no-dsh'), XIN_FRONT_PROVIDER: 'deepseek',
    XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), PATH: bin + ':' + process.env.PATH };
  const op = (name, args = {}) => { const r = spawnSync(process.execPath, [AGENT, name], { env, input: JSON.stringify(args), encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const settle = run => { for (const end = Date.now() + platformTimeout(20000); Date.now() < end;) { if (op('poll', { run, off: 0 }).done) return; spawnSync('sleep', ['0.1']); } assert.fail('这一轮没有结束'); };
  t.after(() => stopOwned(xin, dir));
  const put = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); return p; };
  return { xin, tmp, op, settle, put };
}
const ID = n => String(n).repeat(32).slice(0, 32);

test('删对话：发送回执、推送条目、前台诊断、任务副本、工作区清单、用量记录、网页预览一起删；别的对话的都还在', t => {
  const { xin, tmp, op, settle, put } = home(t);
  const a = op('send', { text: '要删的对话', clientId: 'receipt-mine-01' }); settle(a.run);
  const b = op('send', { text: '留着的对话', clientId: 'receipt-keep-01' }); settle(b.run);
  assert.ok(fs.existsSync(path.join(xin, 'messages', 'receipt-mine-01.json')));
  // 两个对话各有一个做完的后台任务，各有一份网页预览
  const task = (sid, parent, no, id) => {
    put(path.join(xin, 'sessions', sid + '.json'), { sid, kind: 'task', parent, no, title: '任务' + no, status: 'done', runs: [], created: 1, endedAt: 2,
      result: { ok: true, text: 'ok', at: 2 }, preview: { ready: true, url: '/xin/preview.html?id=' + id } });
    put(path.join(tmp, 'xin-task-' + sid, 'work', 'main.c'), 'int main(){}');
    put(path.join(tmp, 'xin-task-' + sid, 'home', '.codex', 'sessions', 'rollout.jsonl'), '{}');
    put(path.join(xin, 'workspaces', sid + '.json'), { original: '/data/workspace/x' });
    put(path.join(xin, 'budgets', sid + '.json'), { total: 10 });
    put(path.join(xin, 'previews', id, 'index.html'), '<p>hi</p>');
    put(path.join(xin, 'previews', id, 'manifest.json'), { id, sid });
  };
  task('staskmine01', a.sid, 1, ID(1)); task('staskkeep01', b.sid, 2, ID(2));
  // 工具链常见的只读目录也要删得掉
  fs.chmodSync(path.join(tmp, 'xin-task-staskmine01', 'home', '.codex'), 0o500);
  try { fs.unlinkSync(path.join(xin, 'tasks-index.json')); } catch { /* 让控制器重建任务索引 */ }
  put(path.join(xin, 'outbox', ID('a') + '.json'), { id: ID('a'), state: 'delivered', msg: { sid: a.sid, body: '结果正文' }, created: Date.now() });
  put(path.join(xin, 'outbox', ID('b') + '.json'), { id: ID('b'), state: 'delivered', msg: { sid: b.sid, body: '别的' }, created: Date.now() });
  put(path.join(xin, 'logs', 'front.jsonl'), [{ run: a.run, outcome: 'error' }, { run: b.run, outcome: 'error' }].map(x => JSON.stringify(x)).join('\n') + '\n');

  const r = op('forget', { sid: a.sid });
  assert.equal(r.ok, true, JSON.stringify(r));
  const gone = p => !fs.existsSync(p), there = p => fs.existsSync(p);
  assert.ok(gone(path.join(xin, 'messages', 'receipt-mine-01.json')) && there(path.join(xin, 'messages', 'receipt-keep-01.json')), '回执');
  assert.ok(gone(path.join(xin, 'outbox', ID('a') + '.json')) && there(path.join(xin, 'outbox', ID('b') + '.json')), '推送条目');
  assert.deepEqual(fs.readFileSync(path.join(xin, 'logs', 'front.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).run), [b.run], '前台诊断');
  for (const [mine, keep] of [[path.join(tmp, 'xin-task-staskmine01'), path.join(tmp, 'xin-task-staskkeep01')], [path.join(xin, 'workspaces', 'staskmine01.json'), path.join(xin, 'workspaces', 'staskkeep01.json')],
    [path.join(xin, 'budgets', 'staskmine01.json'), path.join(xin, 'budgets', 'staskkeep01.json')], [path.join(xin, 'previews', ID(1)), path.join(xin, 'previews', ID(2))]])
    assert.ok(gone(mine) && there(keep), mine);
  assert.ok(gone(path.join(xin, 'sessions', 'staskmine01.json')) && there(path.join(xin, 'sessions', 'staskkeep01.json')));
  assert.ok(r.freed > 0);
});

test('删对话不删别人的预览：预览清单上写的不是这个任务，就不动', t => {
  const { xin, op, settle, put } = home(t);
  const a = op('send', { text: '对话' }); settle(a.run);
  put(path.join(xin, 'sessions', 'staskmine02.json'), { sid: 'staskmine02', kind: 'task', parent: a.sid, no: 1, title: 't', status: 'done', runs: [], preview: { ready: true, url: '/xin/preview.html?id=' + ID(3) } });
  put(path.join(xin, 'previews', ID(3), 'manifest.json'), { id: ID(3), sid: 'sothertask1' });
  try { fs.unlinkSync(path.join(xin, 'tasks-index.json')); } catch { /* 重建 */ }
  assert.equal(op('forget', { sid: a.sid }).ok, true);
  assert.ok(fs.existsSync(path.join(xin, 'previews', ID(3))));
});

test('每日清理：30 天前的写回备份、7 天前已送达的推送条目删掉；新的和还没送达的留着', t => {
  const { xin, op, put } = home(t);
  const day = 86400e3, now = Date.now();
  put(path.join(xin, 'backups', 'task-3-' + (now - 31 * day), 'main.c'), 'old');
  put(path.join(xin, 'backups', 'task-4-' + (now - 2 * day), 'main.c'), 'new');
  put(path.join(xin, 'outbox', ID('c') + '.json'), { id: ID('c'), state: 'delivered', deliveredAt: now - 8 * day, msg: { sid: 'sx' } });
  put(path.join(xin, 'outbox', ID('d') + '.json'), { id: ID('d'), state: 'delivered', deliveredAt: now - 1 * day, msg: { sid: 'sx' } });
  put(path.join(xin, 'outbox', ID('e') + '.json'), { id: ID('e'), state: 'pending', created: now - 9 * day, msg: { sid: 'sx' } });
  op('prune');
  assert.ok(!fs.existsSync(path.join(xin, 'backups', 'task-3-' + (now - 31 * day))));
  assert.ok(fs.existsSync(path.join(xin, 'backups', 'task-4-' + (now - 2 * day))));
  assert.deepEqual(fs.readdirSync(path.join(xin, 'outbox')).sort(), [ID('d') + '.json', ID('e') + '.json'].sort());
});
