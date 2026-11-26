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

test('小人不再带专给聊天用的部分：说话气泡、提问框、AI 工作状态、命令、学会的动作、好感度、额外背包项、聊天头像', () => {
  const js = read('site/mascot.js');
  const at = js.indexOf('window.LimingXin = {');
  assert.ok(at > 0, '小人的对外接口还在');
  const api = js.slice(at);
  for (const key of ['say', 'ask', 'closeAsk', 'asking', 'ai', 'aiState', 'cmd', 'learn', 'learned', 'bond', 'addBag', 'removeBag', 'home', 'portrait'])
    assert.doesNotMatch(api, new RegExp('(^|[\\s{,])(get )?' + key + '\\s*[:(]', 'm'), key);
  for (const gone of ['xin-say', 'xin-ask', 'xin-portrait', 'LimingXinChat', 'xin move'])
    assert.ok(!js.includes(gone), gone);
  const css = read('site/mascot.css');
  for (const gone of ['.xin-say', '.xin-ask', '.xin-portrait']) assert.ok(!css.includes(gone), gone);
});
