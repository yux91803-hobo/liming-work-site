// 实时终端要的两样数据（docs/superpowers/plans/2026-11-16-xin-workbench-round2-b.md 的 Task 1）：
// 任务摘要带最近一轮的编号，网页按它跟这一轮；Codex 改文件的事件带上改动差异，终端里画红绿行。
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const os = require('node:os'), fs = require('node:fs');
const { pathToFileURL } = require('node:url');
// vm-agent 的记录写到临时目录（要在第一次 import 之前设好），和 xin.test.cjs 一样
process.env.XIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-term-'));
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-term-codex-'));
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-term-claude-'));
process.env.XIN_DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-term-dsh-'));
process.env.XIN_DSH = path.join(process.env.XIN_DSH_HOME, 'no-dsh');
const load = rel => import(pathToFileURL(path.join(__dirname, rel)).href);

test('任务摘要带最近一轮的编号；还没跑过的任务没有', async () => {
  const { taskSummary } = await load('../site/xin/vm-agent.mjs');
  const base = { sid: 'stask00001', no: 1, title: '点灯', tkind: 'code', model: 'glm-5.3', status: 'done', created: 1 };
  assert.equal(taskSummary({ ...base, runs: ['r0000001a', 'r0000002b'] }).run, 'r0000002b');
  assert.equal('run' in taskSummary({ ...base, status: 'queued', runs: [] }), false);
});

test('Codex 改文件：按文件拼上改动差异（--- 类型 路径），没有差异时和以前一样是空的', async () => {
  const { fromCodex } = await load('../site/xin/vm-events.mjs');
  const out = fromCodex({ type: 'item.completed', item: { id: 'i9', type: 'file_change', status: 'completed', changes: [
    { path: '/w/a.c', kind: { type: 'update', movePath: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
    { path: '/w/b.h', kind: { type: 'add' }, diff: '#define X 1\n' }] } }, {});
  assert.deepEqual(out, [{ t: 'tool_end', id: 'i9', name: 'Edit', detail: 'update /w/a.c\nadd /w/b.h', ok: true,
    out: '--- update /w/a.c\n@@ -1 +1 @@\n-a\n+b\n--- add /w/b.h\n#define X 1' }]);
  assert.deepEqual(fromCodex({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: '/w/a.c', kind: 'add' }], status: 'completed' } }, {}),
    [{ t: 'tool_end', id: 'i2', name: 'Edit', detail: 'add /w/a.c', ok: true, out: '' }]);
});
