// 后台做完以后，小芯在聊天里说的那句（vm-handoff.mjs 的 publicCompletion）。
// 站长 2026-11-16：问电脑上的 agent 配了哪些模型，答案里有模型名，旧的防泄露过滤把整段换成「…可以打开详情查看」。
// 现在：问到模型 / 配置 / 实现时模型名就是答案；内部编号和分身只去掉提到它们的那几句；全去光了才退回。
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-handoff.mjs')).href);
const task = (o = {}) => Object.assign({ sid: 'stask00001', no: 3, title: '整理资料', status: 'done', userRequest: '帮我整理一下资料', result: { text: '后台原文', at: 1 }, after: [] }, o);

test('问的就是模型配置：答案里的模型名照原样说出来，不换成「看详情」', async () => {
  const { publicCompletion } = await load();
  const t = task({ title: '查看本机agent模型配置', userRequest: '你可以翻一下电脑上的 agent 配了哪些模型' });
  const text = '电脑上的 agent 配了这些模型：\n- deepseek-v4.1-flash（默认）\n- glm-5.3、glm-5.3-flash\n- kimi-k3.1-pro';
  const out = publicCompletion(t, text);
  assert.equal(out, text);
  assert.doesNotMatch(out, /详情查看|打开详情/);
});

test('没问模型时：只去掉说「我让哪个模型去做」的那句，答案留着', async () => {
  const { publicCompletion } = await load();
  const out = publicCompletion(task({ title: '写点灯程序' }), '我让 Kimi 写好了。代码在 /data/workspace/blink/main.c，直接编译就行。');
  assert.equal(out, '代码在 /data/workspace/blink/main.c，直接编译就行。');
});

test('内部编号：括号里的整段去掉；只认这件活自己的编号，RTOS 里的「任务 1」不误伤', async () => {
  const { publicCompletion } = await load();
  assert.equal(publicCompletion(task(), '资料整理好了（任务 3）。放在 /data/workspace/notes.md。'), '资料整理好了。放在 /data/workspace/notes.md。');
  assert.equal(publicCompletion(task(), '任务 3 已经做完。FreeRTOS 里任务 1 的优先级要比任务 2 高。'), 'FreeRTOS 里任务 1 的优先级要比任务 2 高。');
});

test('分身：句首「分身查到了」说成「我查到了」，答案留着；讲派活安排的句子才整句去掉', async () => {
  const { publicCompletion } = await load();
  assert.equal(publicCompletion(task(), '分身查到了：TIM2 在 APB1 上。'), '我查到了：TIM2 在 APB1 上。');
  assert.equal(publicCompletion(task(), '我让分身去翻了一遍。电脑上配了 3 个模型。'), '电脑上配了 3 个模型。');
});

test('全是内部安排：退回后台自己的结果原文；原文也不行才说做好了，不叫人去看详情', async () => {
  const { publicCompletion } = await load();
  assert.equal(publicCompletion(task({ result: { text: 'TIM2 挂在 APB1，时钟 72 MHz。', at: 1 } }), '任务 3 交付了。'), 'TIM2 挂在 APB1，时钟 72 MHz。');
  const out = publicCompletion(task({ result: { text: '分身交的。', at: 1 } }), '任务 3 交付了。');
  assert.equal(out, '我做好了：整理资料。');
});

// 链接写「打开网页」：和工作台卡片的按钮同名（站长 2026-11-16 说结果下面「打开网页」和这句的「打开预览」重复了，下面那颗不再放）
test('网页成品、要确认、没做成：说法不变（网页成品的链接写「打开网页」）', async () => {
  const { publicCompletion } = await load();
  assert.equal(publicCompletion(task({ web: true, preview: { ready: true, url: '/xin/preview.html?id=' + 'a'.repeat(32) } }), 'x'), '我画好了。[打开网页](/xin/preview.html?id=' + 'a'.repeat(32) + ')');
  assert.match(publicCompletion(task({ status: 'waiting', question: '要删掉 old 吗？' }), ''), /要删掉 old 吗/);
  assert.match(publicCompletion(task({ status: 'failed', result: { err: '编译失败', at: 1 } }), ''), /还没有完成/);
});

test('交付提示词：问题要把查到的内容完整带上，不能只说已保存、去看详情', async () => {
  const { handoffPrompt } = await load();
  const p = handoffPrompt(task());
  assert.match(p, /完整/);
  assert.match(p, /不要.*(已保存|详情)/);
  assert.doesNotMatch(p, /别把后台的原话整段转贴/);
});
