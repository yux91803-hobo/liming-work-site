// 机外加密备份（docs/xin-reliability-usage-design.md 的 C 部分）：每天把云电脑的状态库导出加密后存进 Worker 的 Durable Object，
// 云电脑坏了也能取回。密钥从站长登录密码派生（HKDF），备份旁边不存密钥。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ORIGIN = 'https://liming-work.com';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const ok = body => new Response(JSON.stringify(body));

async function worker() { const m = await import(pathToFileURL(path.join(__dirname, '../src/xin.js')).href + '?backup=' + Math.random()); m._reset(); return m; }
// 内存版的 Durable Object 存储（SQLite 型的 KV 接口：get / put / delete / list）
function fakeStorage() {
  const map = new Map();
  return { map, async get(k) { return map.get(k); }, async put(k, v) { map.set(k, structuredClone(v)); }, async delete(k) { for (const x of [].concat(k)) map.delete(x); },
    async list({ prefix = '' } = {}) { return new Map([...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))); },
    async getAlarm() { return null; }, async setAlarm() {}, async deleteAlarm() {} };
}
function env(m, storages = {}) {
  const ns = { idFromName: n => n, get: n => { const st = storages[n] ||= fakeStorage(), obj = new m.XinTaskSupervisor({ storage: st, waitUntil() {} }, e); return { fetch: (url, init) => obj.fetch(new Request(url, init)) }; } };
  const e = { OWNER_PASSWORD: 'correct horse battery', INSTABOX_API_KEY: 'ibk_test_key_1234567890', XIN_MACHINE: 'li', XIN_LOGIN_LIMIT: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response('// agent\n') }, XIN_TASK_SUPERVISOR: ns };
  return { e, storages };
}
// 假 InstaBox：backup_export 返回导出记录，files/content 返回文件字节
function fakeBox(file, opt = {}) {
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), c = { method: init.method || 'GET', path: u.pathname, file: u.searchParams.get('path'), body: init.body }; calls.push(c);
    if (c.path === '/v1/machines') return ok({ machines: [{ id: 'm_abc', name: 'li', state: 'running' }] });
    if (c.path.endsWith('/exec')) {
      const argv = JSON.parse(c.body).argv;
      if (argv[0] === 'sha256sum') return ok({ stdout: '', stderr: '', exitCode: 0 });
      if (argv[2] === 'backup_export') return ok({ stdout: JSON.stringify(opt.export || { ok: true, file: '/data/home/.xin/exports/state-20261112.tar.gz', size: file.length, sha256: sha(file) }), stderr: '', exitCode: 0 });
      return ok({ stdout: '{"ok":true}', stderr: '', exitCode: 0 });
    }
    if (c.path.endsWith('/files/content')) return new Response(opt.served || file);
    return ok({});
  };
  return { calls, restore() { globalThis.fetch = real; } };
}
const NOW = Date.parse('2026-11-12T01:10:00Z');   // 北京时间 11 月 12 日 9:10
const DB = Buffer.from('SQLite format 3\0' + '小芯的记忆：讲代码先给结论'.repeat(50));
async function login(m, e) {
  const r = await m.handleXin(new Request(ORIGIN + '/api/xin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-xin': '1', origin: ORIGIN }, body: JSON.stringify({ password: e.OWNER_PASSWORD }) }), e, null, NOW);
  return r.headers.get('set-cookie').split(';')[0];
}

test('每天备份：取今天的导出、核对 sha256、加密存进 xin-backups（和任务租约分开存），库里看不到明文；今天已有就跳过', async () => {
  const m = await worker(), { e, storages } = env(m), box = fakeBox(DB);
  try {
    const r = await m.backupNow(e, null, NOW);
    assert.deepEqual(r, { ok: true, date: '2026-11-12', size: DB.length, removed: 0 });
    assert.ok(![...(storages['xin-tasks']?.map.keys() || [])].some(k => k.startsWith('backup')), '不写任务租约那个实例');
    const st = storages['xin-backups'].map, rec = st.get('backup:2026-11-12'), meta = st.get('backup-meta:2026-11-12');
    assert.deepEqual(meta, { v: 1, date: '2026-11-12', at: NOW, size: DB.length, sha256: sha(DB) });
    // 密文按二进制存（不转 base64：免费版每次调用 CPU 只有 10 ms，0.6 MB 转 base64 就要 30 多 ms）；AES-GCM 多 16 字节校验
    assert.ok(rec && rec.data instanceof Uint8Array && rec.data.length === DB.length + 16 && rec.salt && rec.iv, '密文是二进制');
    assert.ok(!Buffer.from(rec.data).includes(Buffer.from('讲代码先给结论')), '存的是密文');
    assert.ok(!JSON.stringify(meta).includes('讲代码先给结论'));
    const before = box.calls.length;
    assert.deepEqual(await m.backupNow(e, null, NOW + 12 * 3600e3), { skipped: 'exists', date: '2026-11-12' });
    assert.equal(box.calls.length, before, '今天已有就不再导出');
  } finally { box.restore(); }
});

test('取回的文件和导出记录对不上（大小或 sha256 不同）：不存', async () => {
  const m = await worker(), { e, storages } = env(m), box = fakeBox(DB, { served: Buffer.concat([DB, Buffer.from('x')]) });
  try {
    const r = await m.backupNow(e, null, NOW);
    assert.equal(r.error, 'mismatch');
    assert.equal([...(storages['xin-backups']?.map.keys() || [])].length, 0);
  } finally { box.restore(); }
});

test('导出记录不完整或太大：不存；测试站没配密码：不做', async () => {
  const m = await worker(), { e } = env(m);
  let box = fakeBox(DB, { export: { ok: true, file: '/x', size: 6 * 1024 * 1024, sha256: sha(DB) } });
  try { assert.equal((await m.backupNow(e, null, NOW)).error, 'bad_export'); } finally { box.restore(); }
  box = fakeBox(DB, { export: { error: 'no_export', msg: '导不出来' } });
  try { assert.equal((await m.backupNow(e, null, NOW)).error, 'bad_export'); } finally { box.restore(); }
  assert.deepEqual(await m.backupNow({ ...e, OWNER_PASSWORD: '' }, null, NOW), { state: 'disabled' });
});

test('只留 30 天：存新的时删掉 30 天前的（密文和摘要一起删）', async () => {
  const m = await worker(), { e, storages } = env(m), box = fakeBox(DB);
  try {
    const st = storages['xin-backups'] = fakeStorage();
    for (const d of ['2026-10-12', '2026-10-13', '2026-11-01']) { st.map.set('backup:' + d, { date: d, data: new Uint8Array(4) }); st.map.set('backup-meta:' + d, { date: d }); }
    const r = await m.backupNow(e, null, NOW);
    assert.equal(r.removed, 1);
    assert.deepEqual([...st.map.keys()].filter(k => k.startsWith('backup-meta:')).sort(), ['backup-meta:2026-10-13', 'backup-meta:2026-11-01', 'backup-meta:2026-11-12']);
    assert.ok(!st.map.has('backup:2026-10-12'));
  } finally { box.restore(); }
});

test('取回：登录后列出、按日期解密下载（和原文件一模一样）；没登录拿不到；改过密码解不开时提示下载加密原件；加密原件能用当时的密码离线解开', async () => {
  const m = await worker(), { e, storages } = env(m), box = fakeBox(DB);
  try {
    await m.backupNow(e, null, NOW);
    const cookie = await login(m, e), get = (q, c = cookie) => m.handleXin(new Request(ORIGIN + '/api/xin/' + q, { headers: c ? { cookie: c } : {} }), e, null, NOW);
    assert.equal((await get('backups', null)).status, 401);
    assert.equal((await get('backup?date=2026-11-12', null)).status, 401);
    const list = await (await get('backups')).json();
    assert.deepEqual(list.backups.map(b => [b.date, b.size, b.sha256]), [['2026-11-12', DB.length, sha(DB)]]);
    assert.ok(!('data' in list.backups[0]) && !('salt' in list.backups[0]));
    const dl = await get('backup?date=2026-11-12');
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="xin-state-20261112\.tar\.gz"/);
    assert.equal(dl.headers.get('cache-control'), 'no-store');
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(DB));
    assert.equal((await get('backup?date=2026-11-11')).status, 404);
    assert.equal((await get('backup?date=../x')).status, 400);
    // 站长改了密码：新密码解不开以前的备份，提示下载加密原件
    const e2 = { ...e, OWNER_PASSWORD: 'a brand new password' }, cookie2 = await login(m, e2);
    const old = await m.handleXin(new Request(ORIGIN + '/api/xin/backup?date=2026-11-12', { headers: { cookie: cookie2 } }), e2, null, NOW);
    assert.equal(old.status, 409);
    assert.equal((await old.json()).error, 'old_password');
    const raw = await m.handleXin(new Request(ORIGIN + '/api/xin/backup?date=2026-11-12&raw=1', { headers: { cookie: cookie2 } }), e2, null, NOW);
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get('content-disposition'), /attachment; filename="xin-state-20261112\.backup"/);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-backup-')), rec = path.join(tmp, 'rec.backup'), out = path.join(tmp, 'out.tar.gz');
    fs.writeFileSync(rec, Buffer.from(await raw.arrayBuffer()));
    const script = path.join(__dirname, '../scripts/xin-backup-decrypt.mjs');
    const bad = spawnSync(process.execPath, [script, rec, out], { env: { ...process.env, XIN_BACKUP_PASSWORD: 'wrong password!!' }, encoding: 'utf8' });
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /密码不对/);
    const good = spawnSync(process.execPath, [script, rec, out], { env: { ...process.env, XIN_BACKUP_PASSWORD: e.OWNER_PASSWORD }, encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    assert.ok(fs.readFileSync(out).equals(DB));
  } finally { box.restore(); }
});

test('现在备份（POST /api/xin/backup）：要登录、要本站页面发的 JSON；做今天的备份，已有就跳过（正式站发布后的联调用它）', async () => {
  const m = await worker(), { e, storages } = env(m), box = fakeBox(DB);
  try {
    const post = (headers) => m.handleXin(new Request(ORIGIN + '/api/xin/backup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-xin': '1', origin: ORIGIN, ...headers }, body: '{}' }), e, null, NOW);
    assert.equal((await post({})).status, 401);
    const cookie = await login(m, e);
    assert.equal((await post({ cookie, origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ cookie, 'x-xin': '' })).status, 403);
    assert.equal([...(storages['xin-backups']?.map.keys() || [])].length, 0, '没登录、跨站都不做');
    const r = await post({ cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, date: '2026-11-12', size: DB.length, removed: 0 });
    assert.ok(storages['xin-backups'].map.has('backup:2026-11-12'));
    assert.deepEqual(await (await post({ cookie })).json(), { skipped: 'exists', date: '2026-11-12' });
  } finally { box.restore(); }
});

test('每日定时任务做完顺手备份；备份失败不影响定时任务的结果', async () => {
  const m = await worker(), { e, storages } = env(m), box = fakeBox(DB);
  try {
    const r = await m.runCron(m.CRON_DAILY, e, { waitUntil() {} }, { wait: async () => {}, now: NOW });
    assert.equal(r.ok, true);
    assert.ok(storages['xin-backups'].map.has('backup:2026-11-12'));
  } finally { box.restore(); }
  const m2 = await worker(), { e: e2 } = env(m2), box2 = fakeBox(DB, { served: Buffer.from('broken') });
  try {
    const r = await m2.runCron(m2.CRON_DAILY, e2, { waitUntil() {} }, { wait: async () => {}, now: NOW });
    assert.equal(r.ok, true, '备份没成不算定时任务失败');
  } finally { box2.restore(); }
});

/* ---------- 云电脑这边：导出给备份用、在新电脑上从备份重建 ---------- */
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
// 起控制器之前先起这个目录的常驻状态进程（test/helpers/state-mode.cjs）
function vm(t, xin) {
  const env = { ...process.env, XIN_HOME: xin, XIN_WORK: path.join(path.dirname(xin), 'work'), XIN_FRONT_PROVIDER: 'deepseek' };
  const ensureState = require('./helpers/state-mode.cjs').stateClient(t, env);
  return (name, args = {}) => { ensureState(); const r = spawnSync(process.execPath, [AGENT, name], { env, input: JSON.stringify(args), encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
}

test('backup_export：打一个包（状态库快照 + 对话过程、消息、清单），返回的大小和 sha256 和文件一致；同一天再叫复用同一份；密钥和推送私钥不进包', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-bk-vm-')), xin = path.join(dir, 'xin'), op = vm(t, xin);
  assert.ok(op('memory_add', { content: '讲代码先给结论', type: 'profile' }).ok);
  fs.mkdirSync(path.join(xin, 'runs'), { recursive: true }); fs.mkdirSync(path.join(xin, 'push'), { recursive: true });
  fs.writeFileSync(path.join(xin, 'runs', 'r1.jsonl'), '{"t":"user","text":"早上好"}\n');
  fs.writeFileSync(path.join(xin, 'daily.md'), '- 网关签到\n');
  fs.writeFileSync(path.join(xin, 'codex.key'), 'sk-secret'); fs.writeFileSync(path.join(xin, 'push', 'vapid.json'), '{"private":"x"}');
  const a = op('backup_export');
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.match(a.file, /\/exports\/state-\d{8}\.tar\.gz$/);
  const bytes = fs.readFileSync(a.file);
  assert.equal(a.size, bytes.length); assert.equal(a.sha256, sha(bytes));
  const b = op('backup_export');
  assert.deepEqual([b.file, b.sha256], [a.file, a.sha256]);
  // 解进空目录：记忆（在状态库里）、对话过程、清单都在；密钥、推送私钥不在
  const out = path.join(dir, 'restore'); fs.mkdirSync(out);
  assert.equal(spawnSync('tar', ['-xzf', a.file, '-C', out]).status, 0);
  assert.equal(fs.readFileSync(path.join(out, 'runs', 'r1.jsonl'), 'utf8'), '{"t":"user","text":"早上好"}\n');
  assert.equal(fs.readFileSync(path.join(out, 'daily.md'), 'utf8'), '- 网关签到\n');
  assert.ok(!fs.existsSync(path.join(out, 'codex.key')) && !fs.existsSync(path.join(out, 'push')));
  const op2 = vm(t, out);
  assert.deepEqual(op2('memory_export').items.map(i => i.content), ['讲代码先给结论'], '恢复后记忆照样读得出');
});
