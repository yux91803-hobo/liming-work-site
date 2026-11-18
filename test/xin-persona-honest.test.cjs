// 站长 2026-11-18 晚上：「小芯的人设不需要搞那么多，只要让他知道自己是小芯就行，然后非常清楚的知道干活的流程，不需要那么多讨好人的话，
// 比如说我派活给他，他就如实说要去派个后台去查」「不能默认我说的都是对的，要根据事实学会反驳和纠正我，不能我说啥就是啥，一味的讨好我」。
// 照 OpenAI Model Spec「Don't be sycophantic」（openai/model_spec）和 Gemini CLI 提示词的「No Chitchat」改（设计 docs/superpowers/specs/2026-11-18-xin-one-message-design.md）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
process.env.XIN_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'xin-persona-honest-'));
test.before(() => require('./helpers/own-state.cjs').ownState());
const persona = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-persona.mjs')).href);
const prompts = async () => { const p = await persona(); return { front: p.systemPrompt('', { tasks: true, materials: false }), own: p.systemPrompt(''), p }; };

test('前台和自己动手的提示词都没有讨好的性格描写，只说你是小芯', async () => {
  const { front, own } = await prompts();
  for (const [name, s] of [['前台', front], ['自己动手', own]]) {
    for (const w of ['温暖', '俏皮', '被理解', '被鼓励', '陪伴', '跟着他的情绪', '先说句人话', '表现出兴趣', '能顺手替他接走'])
      assert.ok(!s.includes(w), name + '还有「' + w + '」');
    assert.ok(s.includes('你是小芯'), name);
  }
});

test('说实话，不讨好：说错就指出依据，坚持不等于对，换个问法事实不变，不夸问题；事是他的，说一次就照做', async () => {
  const { front, own } = await prompts();
  for (const s of [front, own]) {
    for (const w of ['## 说实话，不讨好', '直接指出哪里不对', '只有新的事实或更好的理由才改口', '换个问法', '「你说得对」', '听完还要那样做就照做'])
      assert.ok(s.includes(w), '缺「' + w + '」');
  }
});

test('派活照实说派后台，不说「有结果了告诉你」；转达结果先说结论', async () => {
  const { front } = await prompts();
  assert.ok(front.includes('我派后台去'));
  assert.ok(front.includes('不说「有结果了告诉你」'));
  assert.ok(!front.includes('一句话应下来'));
  assert.ok(front.includes('先说结论'));
  assert.ok(!front.includes('用第一人称告诉他'));
});

test('每轮附的提醒不再让它说「我来做」、不再瞒着派活', async () => {
  const { p } = await prompts();
  for (const w of ['我来做', '只需说好', '委派细节']) assert.ok(!p.REMIND.includes(w), '提醒还有「' + w + '」');
  assert.ok(p.REMIND.includes('不编造'));
});

test('前台自己查（站长 11-18「耗时间的任务交给后台」）：几下就能查到的自己用 search_web / read_url_content 查；耗时间的才派后台', async () => {
  const { front } = await prompts();
  for (const w of ['几下就能查到', 'search_web', 'read_url_content', '耗时间的']) assert.ok(front.includes(w), '缺「' + w + '」');
  assert.ok(!front.includes('你自己不碰电脑：要真动手的事交给后台去做——它在你的电脑上干活'), '旧说法：前台什么都不自己做');
});
