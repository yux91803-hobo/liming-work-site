// 第三轮：状态行跟着真实在做的事（docs/superpowers/specs/2026-11-16-xin-workbench-round3-design.md 第 1 节）。
// 站长：「希望像 grok bot 那样根据用户的输入问题显示相关的文字」「派了后台任务也要动态地在动，这样就知道他在干活」。
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const os = require('node:os'), fs = require('node:fs');
const { pathToFileURL } = require('node:url');
// vm-events 不碰文件；vm-status 只发请求。和别的测试一样先把记录目录指到临时目录，免得误写
process.env.XIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-live-'));
const load = rel => import(pathToFileURL(path.join(__dirname, rel)).href);
const B = c => "/bin/bash -lc '" + c + "'";

test('状态一句话：只留一行、去掉引号句号和「状态：」；太短、太长、像在回答的都丢掉', async () => {
  const { statusText } = await load('../site/xin/vm-status.mjs');
  assert.equal(statusText('「查 Gemini 4 Hydrogen 的评测」。'), '查 Gemini 4 Hydrogen 的评测');
  assert.equal(statusText('计算定时器溢出时间\n（因为要先算计数频率）'), '计算定时器溢出时间');
  assert.equal(statusText('状态：查看今天的签到记录'), '查看今天的签到记录');
  assert.equal(statusText(''), '');
  assert.equal(statusText('好的'), '');
  assert.equal(statusText('我现在跑在 Gemini 4 Hydrogen 上'), '');
  assert.equal(statusText('查'.repeat(30)), '');
});

test('状态一句话：DeepSeek Flash、思考关掉、带上一轮小芯说的；回来给句子和用量，出错、超时、空问题给 null', async () => {
  const { frontStatus, STATUS_MODEL } = await load('../site/xin/vm-status.mjs');
  let req;
  const ok = async (url, init) => {
    req = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: '查 Gemini 4 Hydrogen 的评测' }] }], usage: { input_tokens: 120, output_tokens: 9, input_tokens_details: { cached_tokens: 64 } } }) };
  };
  const history = [{ role: 'user', content: '你现在是什么模型' }, { role: 'assistant', content: [{ type: 'output_text', text: '我现在跑在 Gemini 4 Hydrogen 上。' }] }, { role: 'user', content: '（今天的资料）' }];
  const r = await frontStatus({ baseURL: 'http://gw/v1/', key: 'k', fetch: ok, text: '不要你感觉，要查一下', history });
  assert.deepEqual(r, { text: '查 Gemini 4 Hydrogen 的评测', model: STATUS_MODEL, usage: { input: 120, cached: 64, output: 9 } });
  assert.equal(req.url, 'http://gw/v1/responses');
  assert.equal(req.body.model, 'deepseek-v4.1-flash');
  assert.deepEqual(req.body.reasoning, { effort: 'none' });
  const said = JSON.stringify(req.body.input);
  assert.match(said, /Gemini 4 Hydrogen 上/);
  assert.match(said, /不要你感觉，要查一下/);
  assert.doesNotMatch(said, /今天的资料/);
  assert.equal(await frontStatus({ baseURL: 'http://gw/v1', key: 'k', fetch: async () => ({ ok: false, status: 502 }), text: '你好' }), null);
  assert.equal(await frontStatus({ baseURL: 'http://gw/v1', key: 'k', fetch: async () => { throw new Error('offline'); }, text: '你好' }), null);
  const slow = (url, init) => new Promise((res, rej) => init.signal.addEventListener('abort', () => rej(new Error('abort'))));
  assert.equal(await frontStatus({ baseURL: 'http://gw/v1', key: 'k', fetch: slow, text: '你好', ms: 30 }), null);
  assert.equal(await frontStatus({ baseURL: 'http://gw/v1', key: 'k', fetch: ok, text: '   ' }), null);
});

test('模型的思考：有粗体标题就用标题（Codex 的做法），没有就去掉开头的客套、取第一句', async () => {
  const { thoughtLine } = await load('../site/xin/vm-events.mjs');
  assert.equal(thoughtLine('**Checking benchmark sources**\n\nI am looking for…'), 'Checking benchmark sources');
  assert.equal(thoughtLine("I'm thinking through how to approach this.\n\n\nThe timer overflow period is calculated from the prescaler. Then the reload."), 'The timer overflow period is calculated from the prescaler.');
  assert.equal(thoughtLine("I'm thinking through how to approach this.\n\n"), '');
  assert.equal(thoughtLine('先看一下官方发布说明，再找第三方评测。然后整理。'), '先看一下官方发布说明，再找第三方评测。');
  assert.equal(thoughtLine('ok'), '');
});

test('Codex 事件：网页搜索开始时就给一步、读网页记成打开网页；推理摘要给 think', async () => {
  const { fromCodex } = await load('../site/xin/vm-events.mjs');
  assert.deepEqual(fromCodex({ type: 'item.started', item: { id: 'w1', type: 'web_search', query: 'Gemini 4 Hydrogen benchmark' } }, {}),
    [{ t: 'tool', id: 'w1', name: 'WebSearch', detail: 'Gemini 4 Hydrogen benchmark' }]);
  assert.deepEqual(fromCodex({ type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'Gemini 4 Hydrogen benchmark' } }, {}),
    [{ t: 'tool_end', id: 'w1', name: 'WebSearch', detail: 'Gemini 4 Hydrogen benchmark', ok: true, out: '' }]);
  assert.deepEqual(fromCodex({ type: 'item.completed', item: { id: 'w2', type: 'web_search', query: 'https://deepmind.google/a', action: { type: 'open_page', url: 'https://deepmind.google/a' } } }, {}),
    [{ t: 'tool_end', id: 'w2', name: 'WebFetch', detail: 'https://deepmind.google/a', ok: true, out: '' }]);
  assert.deepEqual(fromCodex({ type: 'item.started', item: { id: 'w3', type: 'web_search', query: '' } }, {}), []);
  assert.deepEqual(fromCodex({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: '**Planning the fix**\n\nFirst I will…' } }, {}),
    [{ t: 'think', text: 'Planning the fix', src: 'model' }]);
});

test('天启（Harness）的思考：攒成一句再给 think，太碎的不给；思考从来不变成聊天里的话', async () => {
  const { fromHarness } = await load('../site/xin/vm-events.mjs');
  assert.deepEqual(fromHarness({ type: 'thinking', text: 'x' }, {}), []);
  const st = {};
  assert.deepEqual(fromHarness({ type: 'thinking', text: '站长问定时器多久溢出，' }, st), []);
  assert.deepEqual(fromHarness({ type: 'thinking', text: '先算计数频率。72MHz' }, st), [{ t: 'think', text: '站长问定时器多久溢出，先算计数频率。', src: 'model' }]);
  assert.deepEqual(fromHarness({ type: 'thinking', text: ' 除以 7200。' }, st), [{ t: 'think', text: '72MHz 除以 7200。', src: 'model' }]);
});

test('任务的「在做什么」：最近一个有意义的步骤（搜索、读网页、执行、修改、它自己说的话）；内部命令和英文思考不算', async () => {
  const { stepActivity } = await load('../site/xin/vm-events.mjs');
  assert.equal(stepActivity([{ t: 'tool', id: 'a', name: 'Bash', detail: B('make -j4') }]), '在执行：make -j4');
  assert.equal(stepActivity([{ t: 'tool', id: 'a', name: 'WebSearch', detail: 'Gemini 4 Hydrogen review' }]), '在搜索：Gemini 4 Hydrogen review');
  assert.equal(stepActivity([{ t: 'tool_end', id: 'a', name: 'WebSearch', detail: 'Gemini 4 Hydrogen review', ok: true }]), '在看搜索结果：Gemini 4 Hydrogen review');
  assert.equal(stepActivity([{ t: 'tool_end', id: 'b', name: 'WebFetch', detail: 'https://deepmind.google/models/gemini/', ok: true }]), '在读网页：deepmind.google/models/gemini');
  assert.equal(stepActivity([{ t: 'tool', id: 'c', name: 'Bash', detail: 'xin browser open https://st.com/x' }]), '在打开网页：st.com/x');
  assert.equal(stepActivity([{ t: 'tool', id: 'c', name: 'Bash', detail: 'xin remember 记一下' }, { t: 'text', text: '我先编一遍看看。' }]), '我先编一遍看看。');
  assert.equal(stepActivity([{ t: 'text', text: '先搜。' }, { t: 'tool', id: 'c', name: 'Bash', detail: B('xin remember 记一下') }]), '先搜。');
  assert.equal(stepActivity([{ t: 'tool_end', id: 'e', name: 'Edit', detail: 'update /w/src/tim.c', ok: true }]), '修改了：src/tim.c');
  assert.equal(stepActivity([{ t: 'tool_end', id: 'a', name: 'Bash', detail: 'make', ok: false }]), '上一步失败，正在调整');
  assert.equal(stepActivity([{ t: 'tool_end', id: 'a', name: 'Bash', detail: B('make'), ok: true }]), '执行完：make');
  assert.equal(stepActivity([{ t: 'think', text: '先查官方发布说明', src: 'model' }]), '在想：先查官方发布说明');
  assert.equal(stepActivity([{ t: 'tool', id: 'a', name: 'Bash', detail: 'ls' }, { t: 'think', text: 'Checking the output', src: 'model' }]), '在执行：ls');
  assert.equal(stepActivity([{ t: 'status', text: 'Model metadata for x' }, { t: 'status', text: '电脑刚唤醒，正在连接网络' }]), '电脑刚唤醒，正在连接网络');
  assert.equal(stepActivity([]), '');
});

test('用量：状态那一句的 token 算进模型当天的用量，但不算一轮', async () => {
  const { usageSummary } = await load('../site/xin/vm-usage.mjs');
  const now = Date.parse('2026-11-16T06:00:00Z');
  const s = usageSummary([
    { at: now - 1000, model: 'deepseek-v4.1-flash', usage: { input: 1000, output: 100 } },
    { at: now - 500, model: 'deepseek-v4.1-flash', kind: 'status', usage: { input: 120, output: 9 } }
  ], now);
  assert.equal(s.totals.today.runs, 1);
  assert.equal(s.totals.today.input, 1120);
  assert.equal(s.totals.today.output, 109);
});
