// 小芯（聊天、工作台、终端、学习记录上报、推送）和天启 2026-11-26 删了（站长：「小人留，其他删」）。
// 页面上的小人（mascot.js、标题栏里的 #xinTrack）留着。这组测试防止删掉的东西被加回来。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('首页：不再加载小芯聊天、终端和工作台；页面上的小人还在', () => {
  const html = read('site/index.html');
  for (const gone of ['/xin/', 'xinWork', 'xin-work']) assert.ok(!html.includes(gone), gone);
  assert.match(html, /id="xinTrack"/);
  assert.match(html, /<script src="\/mascot\.js\?v=[^"]+"><\/script>/);
});

test('工具列表里没有天启，也没有「天启」那一类', () => {
  const tools = read('site/tools.js');
  assert.ok(!tools.includes('tianqi'));
  assert.doesNotMatch(tools, /id: 'ai'/);
});

test('小芯、天启的代码目录和 Worker 代码都删了；学习台不再加载学习记录上报', () => {
  for (const gone of ['site/xin', 'site/tools/tianqi', 'src/xin.js', 'src/xin-kernel.js', 'src/xin-inbox.js', 'site/tools/stm32/learning.js'])
    assert.ok(!fs.existsSync(path.join(root, gone)), gone);
  assert.ok(!read('site/tools/stm32/index.html').includes('learning.js'));
});

test('发布流程不再写小芯的密钥，冒烟检查不再查小芯和天启的地址', () => {
  const wf = read('.github/workflows/deploy.yml');
  for (const gone of ['XIN_', 'secret bulk', '/api/xin', '/api/tq', '/tools/tianqi', 'xin_'])
    assert.ok(!wf.includes(gone), gone);
});
