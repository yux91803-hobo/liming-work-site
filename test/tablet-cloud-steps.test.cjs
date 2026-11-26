// 平板 liming-cloud：云端对话事件 → 步骤的投影（面板、后台任务输出、状态条共用）。事件样子取自真实 dsh web 0.2.2-rc.3 的 session/follow。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const lib = () => import(pathToFileURL(path.join(__dirname, '../site/tablet/liming-cloud/lib/steps.js')).href);
const ev = (seq, type, data) => ({ seq, type, data });

test('只取工具调用、AI 回话、本轮结束三类；工具输出和系统消息不进步骤', async () => {
  const { stepOf } = await lib();
  assert.deepEqual(stepOf(ev(17, 'tool/call', { name: 'bash', arguments: '{"command":"sleep 2; echo slept-2","description":"sleep"}' })), { seq: 17, kind: 'tool', text: 'bash · sleep' });
  assert.deepEqual(stepOf(ev(17, 'tool/call', { name: 'bash', arguments: '{"command":"npm test"}' })).text, 'bash · npm test');
  assert.equal(stepOf(ev(18, 'tool/call', { name: 'read', arguments: { path: '/data/workspace/tablet/p/a.c' } })).text, 'read · /data/workspace/tablet/p/a.c');
  assert.deepEqual(stepOf(ev(24, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'TOOL-DONE slept-2 ' }] } })), { seq: 24, kind: 'say', text: 'TOOL-DONE slept-2' });
  assert.equal(stepOf(ev(16, 'assistant/message', { message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash' }] } })), null, '只有工具调用的回话不算一步');
  // 真实 Harness 里前台 bash 也会登记 job/registered（实测 0.2.2-rc.3），和 tool/call 重复，不算一步
  assert.equal(stepOf(ev(19, 'job/registered', { jobId: 'bash-1', label: 'npm run dev' })), null);
  assert.deepEqual(stepOf(ev(26, 'turn/end', { turn: 1, reason: { kind: 'completed' } })), { seq: 26, kind: 'end', text: '完成' });
  for (const type of ['tool/result', 'system/message', 'user/message', 'step/start', 'request/header', 'session/title', 'job/settled'])
    assert.equal(stepOf(ev(1, type, { message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } })), null, type);
});

test('每条步骤都截短，大段输出不会进来', async () => {
  const { stepOf, clip } = await lib();
  const long = stepOf(ev(3, 'assistant/message', { message: { content: [{ type: 'text', text: '很长的回答\n' + '字'.repeat(4000) }] } }));
  assert.ok(long.text.length <= 120, String(long.text.length));
  assert.ok(long.text.endsWith('…'));
  assert.ok(!long.text.includes('\n'));
  assert.equal(clip('  a \n b  '), 'a b');
  assert.ok(stepOf(ev(4, 'tool/call', { name: 'bash', arguments: JSON.stringify({ command: 'x'.repeat(3000) }) })).text.length <= 120);
  assert.equal(stepOf(ev(5, 'tool/call', { name: 'bash', arguments: 'not json' })).text, 'bash · not json');
});

test('一轮结束的原因对应台账状态和后台任务结果', async () => {
  const { turnOutcome } = await lib();
  const pick = r => { const o = turnOutcome(r); return [o.status, o.job]; };
  assert.deepEqual(pick({ kind: 'completed' }), ['completed', 'completed']);
  assert.deepEqual(pick({ kind: 'max-tokens' }), ['completed', 'completed']);
  assert.deepEqual(pick({ kind: 'aborted', reason: { kind: 'user' } }), ['stopped', 'killed']);
  assert.deepEqual(pick({ kind: 'interrupted' }), ['interrupted', 'failed'], '云端崩溃后补的中断记录');
  assert.deepEqual(pick({ kind: 'error', error: { message: 'HTTP 400 key not allowed', code: 'UNKNOWN' } }), ['failed', 'failed']);
  assert.match(turnOutcome({ kind: 'error', error: { message: 'HTTP 400 key not allowed' } }).label, /HTTP 400 key not allowed/);
  assert.equal(turnOutcome({ kind: 'interrupted' }).label, '云端中断');
  assert.deepEqual(pick({ kind: 'blocked' }), ['failed', 'failed']);
  assert.deepEqual(pick(undefined), ['failed', 'failed']);
});

test('结果摘要取这一轮 AI 最后说的话，不往前越过起点', async () => {
  const { lastAssistantText } = await lib();
  const events = [
    ev(5, 'assistant/message', { message: { content: [{ type: 'text', text: '上一轮的话' }] } }),
    ev(9, 'user/message', { content: [{ type: 'text', text: '新任务' }] }),
    ev(12, 'assistant/message', { message: { content: [{ type: 'text', text: '先看看' }] } }),
    ev(15, 'assistant/message', { message: { content: [{ type: 'text', text: '做完了：改了 3 个文件' }] } }),
    ev(16, 'turn/end', { reason: { kind: 'completed' } }),
  ];
  assert.equal(lastAssistantText(events, { fromSeq: 9 }), '做完了：改了 3 个文件');
  assert.equal(lastAssistantText(events.slice(0, 2), { fromSeq: 9 }), '', '这一轮还没说话，不拿上一轮的');
  assert.equal(lastAssistantText(events.slice(0, 3), { fromSeq: 9 }), '先看看');
  assert.ok(lastAssistantText([ev(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'x'.repeat(3000) }] } })], { max: 800 }).length <= 800);
});
