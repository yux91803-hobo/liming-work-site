// 平板 liming-cloud 阶段 4：DSH Go 原生界面——输入框上方的状态条、「云端任务」面板（对话详情和聊天页弹层）、cloud_run 的工具卡。
// 规格照 ccch1mneyyy/dsh-go 的 docs/plugins（slots、components、actions、inputs、design-rules）：
// 清单 ≤ 16 KiB、同一插件 id 不重复、状态条 ≤ 24 字、面板标题 ≤ 16 字；面板视图 ≤ 32 KiB、≤ 120 个组件、≤ 8 层、每个 stack/row ≤ 32 个子组件；
// 工具卡 ≤ 8 KiB、≤ 40 个组件、≤ 6 层、不能有按钮和确认；emit 给完整数据、≤ 4 次每秒、≤ 32 KiB；动作 id、写入路径的格式；handler 3 秒内返回。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '../site/tablet/liming-cloud');
const lib = file => import(pathToFileURL(path.join(root, 'lib', file)).href);
const NOW = Date.parse('2026-11-26T06:00:00Z');
const bytes = v => Buffer.byteLength(JSON.stringify(v), 'utf8');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const ACTION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const BIND_RE = /^data(\.[A-Za-z_][A-Za-z0-9_-]{0,63}){1,16}$/;

function stats(view) {
  let count = 0, depth = 0;
  const actions = [], binds = [], types = new Set();
  (function walk(n, d) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(x => walk(x, d)); return; }
    if (typeof n.type === 'string') {
      count += 1; depth = Math.max(depth, d); types.add(n.type);
      if (Array.isArray(n.children)) assert.ok(n.children.length <= 32, `${n.type} 子组件 ${n.children.length}`);
      for (const k of ['action', 'submit', 'onChange']) {
        const a = n[k];
        if (typeof a === 'string') actions.push(a);
        else if (a && typeof a === 'object' && typeof a.id === 'string') actions.push(a.id);
      }
      if (n.type === 'confirm' || n.type === 'options') actions.push(n.id);
      if (typeof n.bind === 'string') binds.push(n.bind);
      if (Array.isArray(n.items)) n.items.forEach(it => { if (it && typeof it === 'object' && it.action) actions.push(typeof it.action === 'string' ? it.action : it.action.id); });
      for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v, d + 1);
    } else {
      for (const v of Object.values(n)) walk(v, d);
    }
  })(view, 1);
  return { count, depth, actions, binds, types };
}

const task = (o) => ({
  taskId: 't_mwx55n3n_ab12cd34', tabletSessionId: 'tab-A', machine: 'li2', title: '对比 FreeRTOS 和 RT-Thread', project: 'rtos', status: 'running',
  createdAt: NOW - 7 * 60e3, startedAt: NOW - 7 * 60e3, endedAt: null, noticeState: 'none', summary: '', outbox: [{ status: 'acked' }], lastError: null, ...o,
});
const caps2 = { components: ['stack', 'row', 'text', 'callout', 'steps', 'keyValue', 'actions', 'confirm', 'form', 'textField', 'collapsible', 'stepper', 'emptyState', 'list'] };

test('清单：状态条和「云端任务」面板（对话详情、聊天页弹层，弹层打开），id 不重复，文字不超限，整段 ≤ 16 KiB', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const m = pkg.dshGo;
  assert.equal(m.v, 1);
  assert.ok(bytes(m) <= 16 * 1024);
  const strip = m.contributes['composer.strip'];
  const panels = m.contributes.panels;
  assert.equal(strip.length, 1);
  assert.equal(panels.length, 1);
  assert.equal(strip[0].id, 'cloud-status');
  assert.equal(strip[0].panel, 'cloud-tasks');
  assert.equal(panels[0].id, 'cloud-tasks');
  assert.deepEqual(panels[0].placement, ['session.tab', 'chat.panel']);
  assert.equal(panels[0].presentation, 'sheet');
  const ids = [...strip, ...panels].map(x => x.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, ID_RE);
  for (const text of [m.title, panels[0].title]) {
    assert.ok(text.zh && text.en);
    assert.ok([...text.zh].length <= 16 && [...text.en].length <= 24);
  }
  assert.equal(m.icon, 'cloud');
});

test('状态条：一件进行中写机器和用时；几件写件数；剩不到 30 分钟、冷却、完成未读各有说法；没事就不显示；都 ≤ 24 字', async () => {
  const { stripFor } = await lib('ui.js');
  const s = (tasks, statuses = {}) => stripFor({ tasks, sessionId: 'tab-A', statuses, now: NOW });
  const one = s([task()]);
  assert.equal(one.text, 'li2 进行中 · 7 分钟');
  assert.equal(one.icon, 'cloud');
  assert.equal(s([task(), task({ taskId: 't_x2', machine: 'li' })]).text, '2 个云端任务进行中');
  assert.equal(s([task()], { li2: { known: true, awake: true, remainingMin: 25 } }).text, 'li2 剩 25 分钟');
  assert.equal(s([task()], { li2: { known: true, awake: true, remainingMin: 25 } }).tone, 'warn');
  assert.equal(s([task()], { li2: { known: true, awake: false, cooldownUntil: NOW + 20 * 60e3 } }).text, 'li2 冷却到 14:20');
  assert.equal(s([task({ status: 'completed', noticeState: 'pending' })]).text, '1 件云端任务完成（未读）');
  assert.equal(s([task({ status: 'completed', noticeState: 'confirmed' })]), null);
  assert.equal(s([task({ tabletSessionId: 'tab-B' })]), null, '别的对话的任务不在这里显示');
  assert.equal(s([task({ status: 'stopping' })]).text, 'li2 停止中 · 7 分钟');
  for (const v of [one, s([task()], { li2: { known: true, awake: false, cooldownUntil: NOW + 600e3 } })]) assert.ok([...v.text].length <= 24, v.text);
});

test('面板视图：只放结构、数字和步骤用绑定；按状态给「插话」「停止」「接着做」；组件数、层数、大小都在上限内', async () => {
  const { panelView } = await lib('ui.js');
  const tasks = [task(), task({ taskId: 't_done1', status: 'completed', summary: '对比写好了' }), task({ taskId: 't_stop1', status: 'stopping' })];
  const view = panelView({ tasks, sessionId: 'tab-A', caps: caps2 });
  assert.equal(view.v, 2);
  assert.ok(bytes(view) <= 32 * 1024);
  const st = stats(view);
  assert.ok(st.count <= 120, String(st.count));
  assert.ok(st.depth <= 8, String(st.depth));
  for (const a of st.actions) assert.match(a, ACTION_RE);
  for (const b of st.binds) assert.match(b, BIND_RE);
  assert.ok(st.actions.includes('tell:t_mwx55n3n_ab12cd34'), '进行中可以插话');
  assert.ok(st.actions.includes('stop:t_mwx55n3n_ab12cd34'), '进行中可以停止');
  assert.ok(st.actions.includes('tell:t_done1'), '做完的可以接着做');
  assert.ok(!st.actions.includes('stop:t_done1'));
  assert.ok(st.actions.includes('retrystop:t_stop1'), '停止中可以再试一次');
  assert.ok(st.actions.includes('limit'), '每台上限可以在这里调');
  const json = JSON.stringify(view);
  assert.ok(json.includes('{"$":"data.t.t_mwx55n3n_ab12cd34.status"}'), '状态用绑定');
  assert.ok(json.includes('"data.t.t_mwx55n3n_ab12cd34.steps"'), '步骤用绑定');
  assert.ok(!json.includes('对比写好了'), '结果摘要不写死在视图里');
});

test('面板视图：老 App 没有表单时，「插话」退回成把一句话放进输入框；没有任务时是空状态', async () => {
  const { panelView } = await lib('ui.js');
  const v1 = panelView({ tasks: [task()], sessionId: 'tab-A', caps: { components: ['stack', 'text', 'keyValue', 'steps', 'actions', 'confirm', 'callout'] } });
  const st = stats(v1);
  assert.ok(!st.types.has('form') && !st.types.has('textField'));
  assert.ok(st.actions.includes('insert:t_mwx55n3n_ab12cd34'));
  assert.notEqual(v1.v, 2);
  const empty = panelView({ tasks: [], sessionId: 'tab-A', caps: caps2 });
  assert.ok(stats(empty).types.has('emptyState'));
  const emptyV1 = panelView({ tasks: [], sessionId: 'tab-A', caps: { components: ['stack', 'text'] } });
  assert.ok(!stats(emptyV1).types.has('emptyState'));
});

test('面板数据：每个任务的状态、用时、最近 3 步、结果摘要；两台机器一句话；20 个大任务也不超过 32 KiB', async () => {
  const { panelData } = await lib('ui.js');
  const steps = () => [1, 2, 3, 4, 5].map(n => ({ seq: n, kind: 'tool', text: `bash · 第${n}步` }));
  const data = panelData({ tasks: [task()], sessionId: 'tab-A', steps, statuses: { li: { known: true, awake: false, cooldownUntil: null }, li2: { known: true, awake: true, remainingMin: 95 } }, limit: 2, now: NOW });
  const d = data.t.t_mwx55n3n_ab12cd34;
  assert.equal(d.status, '进行中');
  assert.equal(d.elapsed, '7 分钟');
  assert.deepEqual(d.steps.map(s => s.label), ['bash · 第3步', 'bash · 第4步', 'bash · 第5步']);
  assert.deepEqual(d.steps.map(s => s.status), ['done', 'done', 'current']);
  assert.match(data.machines, /li：睡着/);
  assert.match(data.machines, /li2：醒着，本轮还能跑约 95 分钟/);
  assert.equal(data.limit, 2);
  const many = Array.from({ length: 20 }, (_, i) => task({ taskId: `t_big${i}`, status: 'completed', summary: '长'.repeat(5000) }));
  const big = panelData({ tasks: many, sessionId: 'tab-A', steps: () => Array.from({ length: 50 }, (_, n) => ({ seq: n, kind: 'say', text: 'x'.repeat(120) })), statuses: {}, limit: 2, now: NOW });
  assert.ok(bytes(big) <= 32 * 1024, String(bytes(big)));
  const labels = panelData({ tasks: [task({ status: 'completed', noticeState: 'pending', summary: 'ok' }), task({ taskId: 't_f', status: 'failed', lastError: 'HTTP 400' }), task({ taskId: 't_i', status: 'interrupted' }), task({ taskId: 't_d', status: 'dispatching', outbox: [{ status: 'pending' }] })], sessionId: 'tab-A', steps: () => [], statuses: {}, limit: 2, now: NOW });
  assert.equal(labels.t.t_mwx55n3n_ab12cd34.status, '完成（未读）');
  assert.match(labels.t.t_f.status, /没做成：HTTP 400/);
  assert.equal(labels.t.t_i.status, '云端中断');
  assert.equal(labels.t.t_d.status, '正在送达');
});

test('推送限流：100 毫秒里变 50 次，最多每 250 毫秒推一次，最后一次的数据一定推出去；关掉以后不再推', async () => {
  const { createThrottledEmitter } = await lib('throttle.js');
  const sent = [];
  const e = createThrottledEmitter(d => sent.push({ d, at: performance.now() }), { intervalMs: 250 });
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) { e.push({ n: i }); await new Promise(r => setTimeout(r, 2)); }
  await new Promise(r => setTimeout(r, 400));
  const span = performance.now() - t0;
  assert.ok(sent.length <= Math.ceil(span / 250) + 1, `${sent.length} 次 / ${span}ms`);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - sent[i - 1].at >= 240, '两次之间至少 250ms');
  assert.deepEqual(sent.at(-1).d, { n: 49 });
  e.close();
  e.push({ n: 50 });
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(sent.at(-1).d, { n: 49 });
  const fat = createThrottledEmitter(d => sent.push({ d }), { maxBytes: 1000, fit: d => ({ ...d, s: d.s.slice(0, 100) }) });
  fat.push({ s: 'x'.repeat(5000) });
  assert.ok(bytes(sent.at(-1).d) <= 1000);
});

test('面板动作：插话、接着做走 cloud_tell，停止要确认、停完给提示，调上限写设置；都在 3 秒内回（慢的用延后效果）', async () => {
  const { createPanelActions } = await lib('ui.js');
  const calls = [];
  const runner = {
    tell: async (id, text) => { calls.push(['tell', id, text]); return { ok: true, taskId: id, mode: 'steer', delivered: true }; },
    stopFromPanel: async (id) => { calls.push(['stop', id]); return { status: 'stopped', detail: '' }; },
    stop: async (id) => { calls.push(['retrystop', id]); return { status: 'stopping', detail: '还在跑' }; },
  };
  let limit = 2;
  const settings = { get: () => ({ maxConcurrentPerMachine: limit }), set: p => { limit = p.maxConcurrentPerMachine; return { maxConcurrentPerMachine: limit }; } };
  const on = createPanelActions({ runner, settings, notify: () => {} });
  const t0 = performance.now();
  const tell = on({ sessionId: 'tab-A' }, { action: 'tell:t_a1', value: { values: { 'data.drafts.t_a1': '  加上 DMA  ' } } });
  assert.ok(performance.now() - t0 < 100, '马上回');
  assert.ok(tell.pending && typeof tell.result === 'function');
  const r = await tell.result(new AbortController().signal);
  assert.deepEqual(calls[0], ['tell', 't_a1', '加上 DMA']);
  assert.match(r.toast, /插进/);
  assert.deepEqual(r.patch, { drafts: { t_a1: '' } });
  assert.equal(on({}, { action: 'tell:t_a1', value: { values: { 'data.drafts.t_a1': '   ' } } }).toast, '先写点什么');
  assert.equal(on({}, { action: 'stop:t_a1', value: { confirmed: false } }), undefined);
  const stop = on({}, { action: 'stop:t_a1', value: { confirmed: true } });
  assert.match((await stop.result(new AbortController().signal)).toast, /已停止/);
  const retry = on({}, { action: 'retrystop:t_a1', value: {} });
  assert.match((await retry.result(new AbortController().signal)).toast, /还没停干净/);
  assert.match(on({}, { action: 'limit', value: { bind: 'data.limit', value: 3 } }).toast, /3/);
  assert.equal(limit, 3);
  assert.match(on({}, { action: 'insert:t_a1', value: {} }).insert, /cloud_tell.*t_a1/);
  assert.equal(on({}, { action: 'nope', value: {} }), undefined);
});

test('接进 DSH Go：只用 ctx.inject([\'dshGo\'], …) 挂；注册状态条和面板，数据函数返回取消函数，取消后不再推', async () => {
  const { attachUi } = await lib('ui.js');
  const reg = { strips: {}, panels: {}, ons: {}, refresh: 0 };
  const dshGo = {
    strip: (id, fn) => { reg.strips[id] = fn; },
    panel: (id, def) => { reg.panels[id] = def; },
    on: (id, fn) => { reg.ons[id] = fn; },
    refresh: () => { reg.refresh += 1; },
  };
  const listeners = new Set();
  let tasks = [task()];
  const ledger = { listTasks: () => tasks };
  const sweeps = [];
  attachUi({ dshGo }, {
    runner: { steps: () => [] }, ledger, settings: { get: () => ({ maxConcurrentPerMachine: 2 }) },
    readStatus: async () => ({ known: false }), subscribe: l => { listeners.add(l); return () => listeners.delete(l); },
    recovery: { sweep: (o) => { sweeps.push(o); return Promise.resolve({}); } }, machines: () => ['li', 'li2'], now: () => NOW,
  });
  assert.equal(typeof reg.strips['cloud-status'], 'function');
  assert.equal(typeof reg.panels['cloud-tasks'].view, 'function');
  assert.equal(typeof reg.panels['cloud-tasks'].data, 'function');
  assert.equal(typeof reg.ons['cloud-tasks'], 'function', '面板里的点按落到 on(面板 id)');
  const got = [];
  const cancel = reg.panels['cloud-tasks'].data({ sessionId: 'tab-A' }, d => got.push(d), {});
  assert.equal(typeof cancel, 'function');
  assert.ok(sweeps.some(o => o.sessionId === 'tab-A' && o.userPresent), '站长打开面板算在场，接上没在跟的任务');
  await new Promise(r => setTimeout(r, 30));
  assert.ok(got.length >= 1);
  tasks = [task(), task({ taskId: 't_new1' })];
  for (const l of listeners) l('t_new1');
  await new Promise(r => setTimeout(r, 300));
  assert.ok(reg.refresh >= 1, '任务多了一件，视图结构变了要刷新');
  const n = got.length;
  cancel();
  for (const l of listeners) l('t_new1');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(got.length, n, '取消后不再推');
  const stripGot = [];
  const cancelStrip = reg.strips['cloud-status']({ sessionId: 'tab-A' }, d => stripGot.push(d), {});
  await new Promise(r => setTimeout(r, 30));
  assert.equal(stripGot.at(-1).text, '2 个云端任务进行中');
  cancelStrip();
});

test('cloud_run 的工具卡：只读、≤ 8 KiB、≤ 40 个组件、≤ 6 层；出错时返回空对象，不让工具调用失败', async () => {
  const { toolCard, receiptView } = await lib('tool-card.js');
  const card = toolCard((args, value) => receiptView(value))({}, { ok: true, taskId: 't_a1', jobId: 'cloud-1', machine: 'li2', project: 'rtos', reason: 'li2：醒着，平板在这台没有任务', warning: 'li2 大约 30 分钟后会暂停' });
  const view = card['dsh-go/view'];
  assert.ok(view && bytes(card) <= 8 * 1024);
  const st = stats(view);
  assert.ok(st.count <= 40 && st.depth <= 6);
  for (const banned of ['actions', 'confirm', 'form', 'textField', 'options']) assert.ok(!st.types.has(banned), banned);
  assert.match(view.title, /已交给 li2/);
  assert.deepEqual(toolCard(() => { throw new Error('x'); })({}, {}), {});
  assert.deepEqual(toolCard(() => ({ type: 'text', text: 'x'.repeat(9000) }))({}, {}), {});
  assert.equal(JSON.stringify(toolCard(() => ({ type: 'text', text: 'a', n: NaN, u: undefined }))({}, {})), '{"dsh-go/view":{"type":"text","text":"a","n":null}}');
  const fail = toolCard((args, value) => receiptView(value))({}, { ok: false, reason: '两台都在冷却' });
  assert.match(fail['dsh-go/view'].title, /没派出去/);
});

test('两段对话都开着面板：各自比较视图结构，没有变化就不刷新', async () => {
  const { attachUi } = await lib('ui.js');
  let refresh = 0;
  const panels = {};
  const dshGo = { strip: () => {}, panel: (id, def) => { panels[id] = def; }, on: () => {}, refresh: () => { refresh += 1; } };
  const listeners = new Set();
  const tasks = [task(), task({ taskId: 't_b1', tabletSessionId: 'tab-B' })];
  attachUi({ dshGo }, {
    runner: { steps: () => [] }, ledger: { listTasks: () => tasks }, settings: { get: () => ({ maxConcurrentPerMachine: 2 }) },
    readStatus: async () => ({ known: false }), subscribe: l => { listeners.add(l); return () => listeners.delete(l); },
    recovery: null, machines: () => ['li', 'li2'], now: () => NOW,
  });
  panels['cloud-tasks'].view({ sessionId: 'tab-A' }, caps2);
  panels['cloud-tasks'].view({ sessionId: 'tab-B' }, caps2);
  const a = panels['cloud-tasks'].data({ sessionId: 'tab-A' }, () => {}, {});
  const b = panels['cloud-tasks'].data({ sessionId: 'tab-B' }, () => {}, {});
  for (let i = 0; i < 6; i++) { for (const l of listeners) l(null); await new Promise(r => setTimeout(r, 300)); }
  assert.equal(refresh, 0);
  a(); b();
});

test('1 秒里视图结构连变两次（AI 一轮派两件、停止很快确认）：第二次不丢，过了 1 秒补刷新一次，App 取到的视图两件都有', async () => {
  const { attachUi } = await lib('ui.js');
  const panels = {};
  let refresh = 0;
  let shown = null;
  // 假 App：一叫刷新就立刻重取视图（最容易漏掉第二次变化的时机）
  const dshGo = { strip: () => {}, panel: (id, def) => { panels[id] = def; }, on: () => {}, refresh: () => { refresh += 1; shown = JSON.stringify(panels['cloud-tasks'].view({ sessionId: 'tab-A' }, caps2)); } };
  const listeners = new Set();
  let tasks = [task()];
  attachUi({ dshGo }, {
    runner: { steps: () => [] }, ledger: { listTasks: () => tasks }, settings: { get: () => ({ maxConcurrentPerMachine: 2 }) },
    readStatus: async () => ({ known: false }), subscribe: l => { listeners.add(l); return () => listeners.delete(l); },
    recovery: null, machines: () => ['li', 'li2'], now: () => NOW,
  });
  shown = JSON.stringify(panels['cloud-tasks'].view({ sessionId: 'tab-A' }, caps2));
  const cancel = panels['cloud-tasks'].data({ sessionId: 'tab-A' }, () => {}, {});
  await new Promise(r => setTimeout(r, 30));
  tasks = [task({ taskId: 't_new1', createdAt: NOW - 60e3 }), ...tasks];
  for (const l of listeners) l('t_new1');
  assert.equal(refresh, 1);
  assert.ok(shown.includes('t_new1'));
  await new Promise(r => setTimeout(r, 100));
  tasks = [task({ taskId: 't_new2', createdAt: NOW - 30e3 }), ...tasks];
  for (const l of listeners) l('t_new2');
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(refresh, 2, '节流过后补刷新一次');
  assert.ok(shown.includes('t_new2'), 'App 最后取到的视图里有第二件');
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(refresh, 2, '结构没再变就不再刷新');
  cancel();
});

test('推送限流用单调时钟：平板校时、墙上时钟往回跳一小时，下一次变化照样马上推出去', async (t) => {
  const { createThrottledEmitter } = await lib('throttle.js');
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;   // 模拟墙上时钟：先装好，再建推送器
  t.after(() => { Date.now = realNow; });
  const sent = [];
  const e = createThrottledEmitter(d => sent.push(d), { intervalMs: 250 });
  e.push({ n: 1 });
  offset = -3600e3;
  await new Promise(r => setTimeout(r, 300));
  e.push({ n: 2 });
  await new Promise(r => setTimeout(r, 300));
  e.close();
  assert.deepEqual(sent.at(-1), { n: 2 });
});
