// 用量看板的数据（vm-usage.mjs 和 usage op）：额度窗口、光环等级、消耗速率预测、按北京日汇总 token。
// 阈值和预测规则照 Agent HUD（README 的光环说明、docs/agent-contract.md 的 Forecast）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const load = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-usage.mjs')).href);
const H = 3600e3, NOW = Date.parse('2026-11-11T12:00:00Z');
const quota = (buckets, checkedAt = NOW - 60e3) => ({ checkedAt, buckets: buckets.map(([id, remaining, resetAt]) => ({ id, remaining, resetAt })) });

test('窗口识别：-5h 是 5 小时、-weekly 是每周；重置时间过了按已重置', async () => {
  const { quotaWindows } = await load();
  const w = quotaWindows(quota([['3p-5h', 0.25, NOW + H], ['3p-weekly', 0.6, NOW + 50 * H], ['gemini-5h', 0.1, NOW - 60e3], ['odd', 0.5, NOW + H]]), NOW);
  assert.deepEqual(w.map(x => [x.id, x.kind, x.used, x.reset]), [['3p-5h', '5h', 0.75, false], ['3p-weekly', 'week', 0.4, false], ['gemini-5h', '5h', 0, true], ['odd', 'other', 0.5, false]]);
  assert.deepEqual(quotaWindows(null, NOW), []);
  assert.deepEqual(quotaWindows({ buckets: 'bad' }, NOW), []);
});

test('光环分级照 Agent HUD：不到 70% 绿，70% 起黄，90% 起红，用完单独一级；取最高的那项；没有读数不上色', async () => {
  const { glowLevel } = await load();
  const one = r => glowLevel([quota([['3p-5h', r, NOW + H]])], NOW);
  assert.equal(one(0.31), 'ok'); assert.equal(one(0.3), 'warn'); assert.equal(one(0.1), 'high'); assert.equal(one(0), 'out');
  assert.equal(glowLevel([quota([['3p-5h', 0.9, NOW + H]]), quota([['gemini-weekly', 0.05, NOW + 50 * H]])], NOW), 'high');
  assert.equal(glowLevel([quota([['3p-5h', 0, NOW - 1]])], NOW), 'ok', '用完但已过重置时间');
  assert.equal(glowLevel([null, undefined], NOW), null);
});

test('预测：同一窗口最近 2 小时的读数算速率；读数旧了、只有一次、晚于重置都不预测', async () => {
  const { forecast } = await load();
  const win = { id: '3p-5h', resetAt: NOW + 50 * H };
  const s = (at, remaining, resetAt = win.resetAt, id = '3p-5h') => ({ at, id, remaining, resetAt });
  assert.equal(forecast([s(NOW - 65 * 60e3, 0.8), s(NOW - 5 * 60e3, 0.6)], win, NOW), NOW - 5 * 60e3 + 3 * H);
  assert.equal(forecast([s(NOW - 95 * 60e3, 0.8), s(NOW - 31 * 60e3, 0.6)], win, NOW), null, '最新读数超过 30 分钟');
  assert.equal(forecast([s(NOW - 5 * 60e3, 0.6)], win, NOW), null, '只有一次');
  assert.equal(forecast([s(NOW - 65 * 60e3, 0.8), s(NOW - 5 * 60e3, 0.6)], { ...win, resetAt: NOW + H }, NOW), null, '重置前用不完');
  assert.equal(forecast([s(NOW - 65 * 60e3, 0.6), s(NOW - 5 * 60e3, 0.6)], win, NOW), null, '没在用');
  assert.equal(forecast([s(NOW - 65 * 60e3, 0.8, NOW + 10 * H), s(NOW - 5 * 60e3, 0.6)], win, NOW), null, '不同窗口周期的读数不混');
});

test('按北京日汇总 token：日界线、今天/7 天/30 天、缓存命中、30 天齐全', async () => {
  const { usageSummary } = await load();
  const r = (iso, model, input, cached, output) => ({ at: Date.parse(iso), model, ...(input == null ? {} : { usage: { input, cached, output } }) });
  const u = usageSummary([
    r('2026-11-10T15:59:00Z', 'kimi-k3.1-pro', 100, 50, 10),   // 北京 11-10 23:59
    r('2026-11-10T16:01:00Z', 'kimi-k3.1-pro', 200, 150, 20),  // 北京 11-11 00:01
    r('2026-11-11T03:00:00Z', 'deepseek-v4.1-flash', 300, 0, 30),
    r('2026-11-11T04:00:00Z', 'gemini-4-hydrogen'),           // 没有用量：只算轮数
    r('2026-09-01T00:00:00Z', 'kimi-k3.1-pro', 999, 0, 9)       // 超过 30 天
  ], NOW);
  assert.equal(u.days.length, 30);
  assert.equal(u.days.at(-1).date, '2026-11-11'); assert.equal(u.days[0].date, '2026-10-13');
  assert.deepEqual(u.days.at(-1).models['kimi-k3.1-pro'], { input: 200, cached: 150, output: 20, runs: 1 });
  assert.deepEqual(u.days.at(-2).models['kimi-k3.1-pro'], { input: 100, cached: 50, output: 10, runs: 1 });
  assert.deepEqual(u.days[5].models, {});
  assert.deepEqual(u.totals.today, { input: 500, cached: 150, output: 50, runs: 3, hit: 0.3 });
  assert.deepEqual(u.totals.d7, { input: 600, cached: 200, output: 60, runs: 4, hit: 1 / 3 });
  assert.equal(u.totals.d30.runs, 4);
  assert.equal(u.since, Date.parse('2026-09-01T00:00:00Z'));
  assert.deepEqual(usageSummary([], NOW).totals.today, { input: 0, cached: 0, output: 0, runs: 0, hit: null });
});

// 站长 2026-11-13：前台、后台都用 Gemini 4 Hydrogen，Claude 不再用：额度卡只显示一项 Gemini，旧的 Claude、Flash 记录不算
test('usage op：额度卡只显示一项 Gemini（前台、后台同一组）；旧的 Claude 记录不算；文件坏了不报错；tasks 带光环等级', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-usage-')), xin = path.join(dir, 'xin');
  fs.mkdirSync(xin, { recursive: true });
  try {
    const now = Date.now();
    fs.writeFileSync(path.join(xin, 'front-antigravity-quota.json'), JSON.stringify({ model: 'gemini-4-hydrogen', checkedAt: now, buckets: [{ id: 'gemini-5h', remaining: 0.2, resetAt: now + H }, { id: 'gemini-weekly', remaining: 0.7, resetAt: now + 80 * H }] }));
    fs.writeFileSync(path.join(xin, 'antigravity-quota.json'), '{坏了');
    fs.writeFileSync(path.join(xin, 'model-stats.jsonl'), JSON.stringify({ at: now, agent: 'codex', model: 'kimi-k3.1-pro', usage: { input: 10, cached: 5, output: 2 } }) + '\n');
    const env = { ...process.env, XIN_HOME: xin, XIN_WORK: path.join(dir, 'work') }, ensureState = require('./helpers/state-mode.cjs').stateClient(t, env);
    const op = (name, args) => { ensureState(); const r = spawnSync(process.execPath, [path.join(__dirname, '../site/xin/vm-agent.mjs'), name], { env, input: JSON.stringify(args || {}), encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
    const u = op('usage');
    assert.deepEqual(u.quotas.map(q => q.key), ['gemini']);
    assert.deepEqual(u.quotas[0].windows.map(w => [w.kind, Math.round(w.used * 100)]), [['5h', 80], ['week', 30]]);
    assert.equal(u.quotas[0].name, 'Gemini');
    assert.equal(u.totals.today.input, 10);
    assert.equal(typeof u.names['kimi-k3.1-pro'], 'string');
    assert.equal(op('tasks').glow, 'warn');
    fs.writeFileSync(path.join(xin, 'antigravity-argon-quota.json'), JSON.stringify({model:'gemini-4-argon',checkedAt:now,
      buckets:[{id:'gemini-argon-wtu-weekly',remaining:0.5,resetAt:now+80*H}]}));
    const pools = op('usage').quotas;
    assert.deepEqual(pools.map(q=>q.key), ['gemini','argon']);
    assert.deepEqual(pools.map(q=>q.name), ['Gemini','Argon']);
    assert.deepEqual(pools[1].windows.map(w=>[w.kind,w.used]), [['week',0.5]]);
    fs.unlinkSync(path.join(xin, 'antigravity-argon-quota.json'));
    // 旧账号留下的 Claude 记录（还标着用完）不算：额度卡不显示，光环也不因它变红
    fs.writeFileSync(path.join(xin, 'front-antigravity-quota.json'), JSON.stringify({ model: 'claude-opus-4.6', checkedAt: now, blocked: true, retryAt: now + H, buckets: [{ id: '3p-weekly', remaining: 0, resetAt: now + H }] }));
    assert.deepEqual(op('usage').quotas, []);
  } finally { t.after(() => fs.rmSync(dir, { recursive: true, force: true })); }   // 状态进程停下以后再删
});

test('前台每次读到额度都记一条读数，用量页据此给出预计用完的时间', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-usage-')), xin = path.join(dir, 'xin');
  fs.mkdirSync(xin, { recursive: true });
  try {
    const now = Date.now(), env = { ...process.env, XIN_HOME: xin, XIN_WORK: path.join(dir, 'work') }, agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
    const ensureState = require('./helpers/state-mode.cjs').stateClient(t, env);
    const run = (argv, args) => { ensureState(); const r = spawnSync(process.execPath, [agent, ...argv], { env, input: JSON.stringify(args || {}), encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
    const read = (at, r5) => ({ model: 'gemini-4-hydrogen', checkedAt: at, blocked: false, retryAt: 0, buckets: [{ id: 'gemini-5h', remaining: r5, resetAt: now + 4 * H }, { id: 'gemini-weekly', remaining: 0.9, resetAt: now + 80 * H }] });
    assert.ok(run(['locked', 'front_quota'], { quota: read(now - 40 * 60e3, 0.8) }).quota);
    assert.ok(run(['locked', 'front_quota'], { quota: read(now - 5 * 60e3, 0.6) }).quota);
    assert.equal(fs.readFileSync(path.join(xin, 'quota-history.jsonl'), 'utf8').trim().split('\n').length, 4);
    const w = run(['usage']).quotas[0].windows;
    const five = w.find(x => x.kind === '5h'), week = w.find(x => x.kind === 'week');
    assert.ok(five.forecastAt > now && five.forecastAt < now + 4 * H, JSON.stringify(five));
    assert.equal(week.forecastAt, null, '每周额度没在动');
    const later = {...read(now - 60e3, 0.5), model:'gemini-4-neon'};
    assert.ok(run(['locked','agy_quota'], {quota:later}).ok);
    const shared = run(['usage']).quotas;
    assert.equal(shared.length, 1, '前台 Hydrogen 和后台 Neon 合并成同一张额度卡');
    assert.ok(shared[0].windows.find(w=>w.kind==='5h').forecastAt > now, '预测包含同池不同模型的采样');
  } finally { t.after(() => fs.rmSync(dir, { recursive: true, force: true })); }   // 状态进程停下以后再删
});

test('Antigravity 的输入不含缓存读取（total = 输入 + 输出）：记账时换算成「输入含缓存」，旧记录读的时候补上，不重复加', async () => {
  const { usageSummary, agyUsage, AGY_MODELS } = await load();
  const runtime = await import(pathToFileURL(path.join(__dirname, '../site/xin/vm-runtime.mjs')).href);
  assert.ok(AGY_MODELS.includes(runtime.AGY_MODEL), '和 vm-runtime 的 AGY_MODEL 保持一致');
  assert.deepStrictEqual(AGY_MODELS, Object.keys(runtime.AGY_CATALOG), '和 vm-runtime 的 Antigravity 模型表保持一致（Neon、Argon 的用量也按输入含缓存换算）');
  const mixed = agyUsage({input:120,cached:75,output:8,providerUsage:{'antigravity:neon':{cache_read_tokens:25}}});
  assert.deepEqual([mixed.input,mixed.cached,mixed.total], [145,75,153], '换到网关后只补 Antigravity 没算进输入的缓存');
  // 正式机上真实的累计值：input 54735、cache 149606、output 39807、total 94542（= input + output）
  assert.deepEqual(agyUsage({ input: 54735, cached: 149606, output: 39807, total: 94542 }, 1200),
    { input: 204341, cached: 149606, output: 39807, total: 244148, ctx: 1200, win: 1000000, incl: true });
  const at = Date.parse('2026-11-11T03:00:00Z');
  const u = usageSummary([
    { at, model: 'gemini-4-hydrogen', usage: { input: 100, cached: 300, output: 10 } },              // 旧记录：没换算
    { at, model: 'gemini-4-hydrogen', usage: { input: 400, cached: 300, output: 10, incl: true } },  // 新记录：已换算
    { at, model: 'deepseek-v4.1-flash', usage: { input: 100, cached: 50, output: 5 } }                   // Codex 本来就含缓存
  ], NOW);
  assert.deepEqual(u.days.at(-1).models['gemini-4-hydrogen'], { input: 800, cached: 600, output: 20, runs: 2 });
  assert.deepEqual(u.days.at(-1).models['deepseek-v4.1-flash'], { input: 100, cached: 50, output: 5, runs: 1 });
  assert.ok(u.totals.today.hit <= 1, '缓存命中不会超过 100%');
});
