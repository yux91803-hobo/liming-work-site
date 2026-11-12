// 站长 2026-11-12 发来 Muse（Meta 的个人助理）的内置系统提示，「看看有什么参考的，刚好可以改进我们遇到的问题」。
// 对照小芯现有提示词缺的几条，照它的做法补上（转述，不照抄原文）：
// - 做不了先把能走的路走完，说清试过什么、还剩什么办法（查网关积分那次只会说「请启动面板」）；
// - 不估计还要多久、几点做完，只说最后看到的情况；
// - 后台问到的事不替站长回答，批准只管问到的那一件；
// - 接着做（断线、换模型）前先确认有后果的操作上次是不是已经做成，报错不等于没做；
// - 出错说人话，不贴报错原文；不答应没有人会去做的跟进；
// - 浏览器遇到限流、账号锁定、人机验证就停，不绕；往外填表、搜索只带需要的信息；
// - 常驻服务装好要确认真的在跑、重启后也会起来；
// - 星期几不靠猜：控制器把星期写进当前时间。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
process.env.XIN_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'xin-muse-rules-'));
const imp = f => import(pathToFileURL(path.join(__dirname, '../site/xin', f)).href);
const boxedTask = { no: 1, title: '查资料', tkind: 'research', dir: '/data/workspace/p', workspace: { work: '/w/work', home: '/w/home', tmp: '/w/tmp' }, goal: 'x' };

test('前台：不估计还要多久；后台问到的事不替站长回答、批准只管那一件；不答应没人去做的跟进；出错说人话', async () => {
  const p = await imp('vm-persona.mjs');
  const f = p.systemPrompt('', { tasks: true });
  assert.match(f, /不估计还要多久/);
  assert.match(f, /最后看到的情况/);
  assert.match(f, /不替他回答/);
  assert.match(f, /只是问到的那一件/);
  assert.match(f, /别答应没有人会去做的事/);
  assert.match(f, /大白话/);
  // 真实模型试跑发现的两处：没做成时另派了一个只有「好了没」的新任务；答应「明早提醒你」
  assert.match(f, /xin task tell 原编号 让原来那件事接着改/); assert.match(f, /不为同一件事另派新任务/);
  assert.match(f, /你没有闹钟，不会到点主动来找他/);
});

test('后台：做不了说清试过什么、还剩什么办法；接着做前先确认有后果的操作上次成没成；出错说人话（容器任务、电脑维护、每日任务都一样）', async () => {
  const p = await imp('vm-persona.mjs');
  for (const t of [boxedTask, { no: 2, title: '修电脑', tkind: 'system', dir: '/data/workspace/system', goal: 'x' }, { no: 3, title: '每日任务', dailyDate: '2026-11-12', dir: '/data/workspace/daily', goal: 'x' }]) {
    const s = p.taskSystemPrompt(t);
    assert.match(s, /试过什么、还剩什么办法/, t.title);
    assert.match(s, /先确认上次是不是已经做成/, t.title);
    assert.match(s, /报错不等于没做/, t.title);
    assert.match(s, /大白话/, t.title);
  }
});

test('浏览器：限流、账号锁定、人机验证就停，不换路子绕；往外填表、搜索只带这件事需要的信息', async () => {
  const p = await imp('vm-persona.mjs');
  assert.match(p.BROWSER_TASK_GUIDE, /限流、账号锁定、人机验证/);
  assert.match(p.BROWSER_TASK_GUIDE, /不换路子绕/);
  assert.match(p.BROWSER_TASK_GUIDE, /只带这件事需要的信息/);
});

test('常驻服务：装好以后确认真的在跑、重启后也会起来（电脑维护和桌面说明）', async () => {
  const p = await imp('vm-persona.mjs');
  assert.match(p.SYSTEM_TASK_GUIDE('/d/system'), /确认它真的在跑/);
  assert.match(p.systemPrompt(''), /确认它真的在跑/);
  assert.match(p.tianqiPrompt(), /确认它真的在跑/);
});

test('星期几：控制器算好写进当前时间（前台资料、每日任务），不让模型猜', async () => {
  const b = await imp('vm-base.mjs');
  // 北京时间 2026-11-12 是星期四；UTC 2026-11-12 18:00 在北京已经是 11-13 星期五
  assert.equal(b.bjWeek(Date.UTC(2026, 10, 12, 4, 0)), '星期四');
  assert.equal(b.bjWeek(Date.UTC(2026, 10, 12, 18, 0)), '星期五');
  const d = await imp('vm-daily.mjs');
  assert.match(d.dailyContext(), /当前北京时间：\d{4}-\d\d-\d\d \d\d:\d\d（星期[一二三四五六日]）/);
  const p = await imp('vm-persona.mjs');
  assert.match(p.dailyPrompt('- 签到'), /北京时间 \d{4}-\d\d-\d\d \d\d:\d\d（星期[一二三四五六日]）/);
});
