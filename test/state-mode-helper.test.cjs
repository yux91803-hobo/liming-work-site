// 测试帮手（test/helpers/state-mode.cjs）：不用再设 XIN_TEST_STATE_MODE，接了帮手的测试总是对着真的状态进程跑。
// docs/superpowers/plans/2026-11-18-xin-remove-legacy.md Task A1：旧模式要删，测试不能再有「不起状态进程」的那一遍。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { stateMode } = require('./helpers/state-mode.cjs');

test('测试帮手：不设 XIN_TEST_STATE_MODE 也起真的状态进程（拿到所有权、开着套接字）', t => {
  delete process.env.XIN_TEST_STATE_MODE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-state-helper-'));
  const owner = stateMode(t, { ...process.env, XIN_HOME: home });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.ok(owner && owner.ready.ready === true, '状态进程起来了：' + JSON.stringify(owner && owner.ready));
  assert.ok(owner.ready.epoch >= 1, '拿到了所有权（切换次数从 1 起）');
  assert.ok(fs.statSync(path.join(home, 'run', 'state.sock')).isSocket(), '状态进程在听套接字');
});
