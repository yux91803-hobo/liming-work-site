// 前台的历史窗口（vm-handoff.mjs 的 foregroundContext）：起点 6 轮一挪、有总字数上限、索引不切半截 JSON。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-handoff.mjs')).href);

// n 轮对话，每轮一问一答；size 决定每条话有多长
function convo(n, size = () => 10) {
  const runs = Array.from({ length: n }, (_, i) => 'r' + String(i).padStart(7, '0'));
  const ev = new Map(runs.map((r, i) => [r, [{ t: 'user', text: 'Q' + i + '-'.repeat(Math.max(0, size(i) - String(i).length - 1)) }, { t: 'tool', detail: 'ls' }, { t: 'text', text: 'A' + i }]]));
  return { s: { runs: runs.concat(['rcurrent']) }, read: r => ev.get(r) || [], runs };
}
const recentRuns = ctx => ctx.checkpoint.recent.map(r => Number(r.slice(1)));

test('原文窗口的起点 6 轮才挪一次：几轮之内历史开头不变（缓存用得上）', async () => {
  const { foregroundContext } = await load();
  const starts = [];
  for (let n = 10; n <= 30; n++) {
    const { s, read } = convo(n);
    const ctx = foregroundContext(s, 'rcurrent', read), rec = recentRuns(ctx);
    starts.push(rec[0]);
    assert.ok(rec.length >= Math.min(n, 12) && rec.length <= 17, n + ': ' + rec.length);
    assert.equal(rec.at(-1), n - 1);
    assert.ok(!ctx.input.some(m => m.content === 'rcurrent'));
  }
  // 起点只在 6 的倍数上，连续多轮相同
  assert.deepEqual([...new Set(starts)], [0, 6, 12, 18]);
  assert.ok(starts.filter(x => x === 6).length === 6);
});

test('原文有总字数上限：超了把最早的整块挪进索引，至少留最近 2 轮；工具调用不进上下文', async () => {
  const { foregroundContext, CONTEXT } = await load();
  const { s, read } = convo(16, () => 9000);    // 每轮约 9000 字，16 轮远超 8 万
  const ctx = foregroundContext(s, 'rcurrent', read), rec = recentRuns(ctx);
  const chars = ctx.input.filter(m => !m.content.startsWith('历史检索索引')).reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars <= CONTEXT.recentChars, String(chars));
  assert.ok(rec.length >= 2 && rec.at(-1) === 15);
  assert.equal((rec[0] - 0) % 6 === 0 || rec.length === 2, true);
  assert.ok(ctx.input[0].content.startsWith('历史检索索引'));
  assert.ok(!ctx.input.some(m => m.content === 'ls'));
  // 8 轮超长的（每条截到 1.2 万字，合计 9.6 万）：整块挪走 6 轮，最近 2 轮照样留着
  const huge = convo(8, () => 50000);
  const h = foregroundContext(huge.s, 'rcurrent', huge.read);
  assert.deepEqual(recentRuns(h), [6, 7]);
  assert.ok(h.input.filter(m => m.role === 'user' && !m.content.startsWith('历史')).every(m => m.content.length === CONTEXT.message));
});

test('索引超长时按条丢最早的，留下的是完整 JSON，最新的摘录还在', async () => {
  const { foregroundContext, CONTEXT } = await load();
  const { s, read } = convo(60, () => 900);      // 48 轮进索引，每条摘 400 字，远超 1.6 万
  const ctx = foregroundContext(s, 'rcurrent', read), index = ctx.input[0].content;
  const json = index.slice(index.indexOf('\n') + 1), items = JSON.parse(json);
  assert.ok(json.length <= CONTEXT.indexChars, String(json.length));
  const firstRecent = ctx.checkpoint.recent[0];
  assert.equal(items.at(-1).run, 'r' + String(Number(firstRecent.slice(1)) - 1).padStart(7, '0'));
  assert.ok(items.every(x => x.excerpt.length <= CONTEXT.excerpt));
});

test('短对话：没有索引，全部原文按顺序', async () => {
  const { foregroundContext } = await load();
  const { s, read } = convo(3);
  const ctx = foregroundContext(s, 'rcurrent', read);
  assert.deepEqual(ctx.input.map(m => m.role + ':' + m.content[0] + m.content[1]), ['user:Q0', 'assistant:A0', 'user:Q1', 'assistant:A1', 'user:Q2', 'assistant:A2']);
});

test('显示用的模型名：Gemini、Opus 有自己的名字，不认识的原样显示，不冒充成 GLM-5.3 Flash', async () => {
  const { modelLabel, codexModel } = await import(pathToFileURL(path.join(__dirname, '../site/xin/vm-models.mjs')).href);
  assert.equal(modelLabel('gemini-3.8-flash-high'), 'Gemini 3.8 Flash');
  assert.equal(modelLabel('claude-opus-4.6'), 'Claude Opus 4.6');
  assert.equal(modelLabel('kimi-k3.1-pro'), 'Kimi K3.1 Pro');
  assert.equal(modelLabel('glm-5.3'), 'GLM-5.3');
  assert.equal(modelLabel('some-new-model'), 'some-new-model');
  // 起 Codex 时不认识的照旧按第一个开工（只改显示，不改执行）
  assert.equal(codexModel('some-new-model').id, 'glm-5.3-flash');
});
