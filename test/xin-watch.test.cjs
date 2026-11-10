// 方案 B（检测与恢复）：控制器脚本被改过能发现并修复、完全放权的对话碰控制器目录有记录、状态库每天导出；
// 以及没写模式的新对话落在默认模式、Claude 旧模式不再新建。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
const ORIGIN = 'https://liming-work.com';

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-watch-')), xin = path.join(dir, 'xin');
  fs.mkdirSync(path.join(xin, 'sessions'), { recursive: true }); fs.mkdirSync(path.join(xin, 'runs'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Stand-in CLIs first on PATH: a test must never start a real agent that happens to be installed on this machine.
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  for (const cmd of ['claude', 'codex', 'agy']) fs.writeFileSync(path.join(bin, cmd), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, XIN_HOME: xin, XIN_WORK: path.join(dir, 'work'), XIN_DSH: path.join(dir, 'no-dsh'), XIN_FRONT_PROVIDER: 'deepseek',
    XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), PATH: bin + ':' + process.env.PATH };
  const op = (name, args = {}) => {
    const r = spawnSync(process.execPath, [AGENT, name], { env, input: JSON.stringify(args), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const js = code => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as a from ${JSON.stringify(pathToFileURL(AGENT).href)};const out=await (async()=>{${code}})();process.stdout.write(JSON.stringify(out??null));`], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  return { dir, xin, env, op, js };
}

test('没写模式的新对话是默认模式，不是完全放权的天启；Claude 旧模式不再新建，旧对话照常', t => {
  const { op, xin } = home(t);
  const r = op('send', { text: '你好' });
  assert.equal(r.agent, 'codex');
  assert.equal(JSON.parse(fs.readFileSync(path.join(xin, 'sessions', r.sid + '.json'), 'utf8')).agent, 'codex');
  const c = op('send', { agent: 'claude', text: '你好' });
  assert.equal(c.error, 'retired'); assert.match(c.msg, /不再新建/);
  fs.writeFileSync(path.join(xin, 'sessions', 'sclaudeold1.json'), JSON.stringify({ sid: 'sclaudeold1', agent: 'claude', title: 'old', agentSid: crypto.randomUUID(), started: true, runs: [] }));
  const again = op('send', { sid: 'sclaudeold1', text: '接着聊' });
  assert.equal(again.agent, 'claude'); assert.ok(again.run);
});

test('越界记录：天启和 Claude 旧模式碰控制器目录、改记忆的命令记一条；每日任务只记密钥、状态库和脚本；默认模式的后台不记', t => {
  const { js } = home(t);
  const kinds = js(`const B=a.BASE,tool=d=>({t:'tool',detail:d});
    return [
      a.boundaryKind({agent:'harness'},tool('cat '+B+'/sessions/s1.json')),
      a.boundaryKind({agent:'harness'},tool('sqlite3 '+B+'/workflow.sqlite .dump')),
      a.boundaryKind({agent:'harness'},tool('ls ~/.xin')),
      a.boundaryKind({agent:'harness'},tool('env -u XIN_RUN xin remember --basis stated 随便')),
      a.boundaryKind({agent:'claude'},tool('cat /data/home/.xin/harness.key')),
      a.boundaryKind({agent:'harness'},tool('ls /data/workspace && make')),
      a.boundaryKind({agent:'harness'},{t:'text',text:'~/.xin'}),
      a.boundaryKind({agent:'codex',kind:'daily',task:true},tool('cat '+B+'/daily.md')),
      a.boundaryKind({agent:'codex',kind:'daily',task:true},tool('cat '+B+'/codex.key')),
      a.boundaryKind({agent:'codex',task:true},tool('cat '+B+'/codex.key'))];`);
  assert.deepEqual(kinds, ['dir', 'sensitive', 'dir', 'xin', 'sensitive', null, null, null, 'sensitive', null]);
});

test('脚本被改过的记录和越界记录只留时间、对话和命令开头；任务中心报最近 7 天的条数', t => {
  const { op, xin } = home(t);
  assert.deepEqual(op('tasks', { all: true }).watch, { boundary: 0, integrity: 0 });
  assert.deepEqual(op('integrity_event', { files: ['vm-agent-0123456789ab.mjs', '../../etc/passwd', 'x'] }), { ok: true });
  const line = JSON.parse(fs.readFileSync(path.join(xin, 'logs', 'integrity.jsonl'), 'utf8').trim());
  assert.deepEqual(line.files, ['vm-agent-0123456789ab.mjs']); assert.ok(line.at > 0);
  fs.appendFileSync(path.join(xin, 'logs', 'integrity.jsonl'), JSON.stringify({ at: Date.now() - 8 * 86400e3, files: ['vm-base-0123456789ab.mjs'] }) + '\n');
  assert.deepEqual(op('tasks', { all: true }).watch, { boundary: 0, integrity: 1 });
  assert.equal(op('integrity_event', { files: [] }).ok, true);
  assert.equal(fs.readFileSync(path.join(xin, 'logs', 'integrity.jsonl'), 'utf8').trim().split('\n').length, 2, '没有文件名就不记');
});

test('状态库每天导出一份完整副本（含记忆），同一天不重复，只留最近 7 份；记忆可单独导出成可读内容', t => {
  const { js, op, xin } = home(t);
  const dir = path.join(xin, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  for (let d = 1; d <= 8; d++) fs.writeFileSync(path.join(dir, 'workflow-2026010' + d + '.sqlite'), 'old');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
  const r = js(`a.addMemory({content:'回答先给结论',source:'user'});const first=a.exportState();return {first,again:a.exportState()};`);
  assert.equal(r.first.ok, true); assert.equal(r.first.removed, 2); assert.equal(r.again.skipped, 'exists');
  const names = fs.readdirSync(dir).sort();
  assert.equal(names.filter(n => /^workflow-\d{8}\.sqlite$/.test(n)).length, 7); assert.ok(names.includes('notes.txt'), '不是导出文件的不动');
  assert.ok(!names.includes('workflow-20260101.sqlite') && !names.includes('workflow-20260102.sqlite'));
  const { DatabaseSync } = require('node:sqlite'), copy = new DatabaseSync(r.first.file, { readOnly: true });
  assert.equal(copy.prepare("SELECT content FROM memory_items").get().content, '回答先给结论'); copy.close();
  assert.equal(fs.statSync(r.first.file).mode & 0o777, 0o600);
  const exported = op('memory_export');
  assert.deepEqual(exported.items.map(i => [i.content, i.status]), [['回答先给结论', 'active']]); assert.ok(exported.exportedAt > 0);
});

/* ---------- Worker：核对云电脑上的控制器脚本 ---------- */
async function worker() { const m = await import(pathToFileURL(path.join(__dirname, '../src/xin.js')).href + '?watch=' + Math.random()); m._reset(); return m; }
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const SOURCES = { 'vm-agent.mjs': "import './x.mjs';\nimport { a } from './vm-base.mjs';\n// agent\n", 'vm-base.mjs': '// base\n' };
function env() {
  return { OWNER_PASSWORD: 'correct horse battery', INSTABOX_API_KEY: 'ibk_test_key_1234567890', XIN_MACHINE: 'li',
    ASSETS: { fetch: async req => { const f = new URL(req.url).pathname.split('/').pop(); return f in SOURCES ? new Response(SOURCES[f]) : new Response('nope', { status: 404 }); } } };
}
function fakeBox(handle) {
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { const u = new URL(url), c = { method: init.method || 'GET', path: u.pathname, file: u.searchParams.get('path'), body: init.body }; calls.push(c); return handle(c); };
  return { calls, restore() { globalThis.fetch = real; } };
}
const ok = body => new Response(JSON.stringify(body));

test('控制器脚本自检：内容和这一版一致就什么都不做；被改过就整套重传并记一条；十分钟内不重复查；查不了下次再查', async () => {
  const m = await worker(), e = env();
  const baseText = SOURCES['vm-base.mjs'], baseName = 'vm-base-' + sha(baseText).slice(0, 12) + '.mjs';
  const agentText = SOURCES['vm-agent.mjs'].replace("'./vm-base.mjs'", "'./" + baseName + "'"), agentName = 'vm-agent-' + sha(agentText).slice(0, 12) + '.mjs';
  const dir = '/data/home/.xin/agent/', good = sha(baseText) + '  ' + dir + baseName + '\n' + sha(agentText) + '  ' + dir + agentName + '\n';
  let sums = good;
  let box = fakeBox(c => {
    if (c.path.endsWith('/exec')) { const argv = JSON.parse(c.body).argv; return argv[0] === 'sha256sum' ? ok({ stdout: sums, stderr: '', exitCode: 0 }) : ok({ stdout: '{"ok":true}', stderr: '', exitCode: 0 }); }
    return ok({});
  });
  try {
    assert.deepEqual(await m.verifyAgent(e, ORIGIN, 'm_abc', 1e12), { ok: true });
    assert.deepEqual(JSON.parse(box.calls[0].body).argv, ['sha256sum', '--', dir + baseName, dir + agentName]);
    assert.equal(box.calls.length, 1, '一致时不上传、不记录');
    assert.deepEqual(await m.verifyAgent(e, ORIGIN, 'm_abc', 1e12 + 599000), { skipped: true });
    assert.equal(box.calls.length, 1);
    // Someone edited a dependency in place: same name, other content.
    sums = sha('// base\nprocess.exit(0)\n') + '  ' + dir + baseName + '\n' + sha(agentText) + '  ' + dir + agentName + '\n';
    assert.deepEqual(await m.verifyAgent(e, ORIGIN, 'm_abc', 1e12 + 600001), { ok: false, repaired: 1 });
    const puts = box.calls.filter(c => c.method === 'PUT');
    assert.deepEqual(puts.map(c => [c.file, c.body]), [[dir + baseName, baseText], [dir + agentName, agentText]], '整套按这一版的内容重传');
    const note = box.calls.filter(c => c.path.endsWith('/exec')).map(c => JSON.parse(c.body)).find(b => b.argv[2] === 'integrity_event');
    assert.deepEqual(JSON.parse(note.stdin), { files: [baseName] });
    // A file that is simply not there yet is uploaded by the normal path, not treated as tampering.
    sums = sha(agentText) + '  ' + dir + agentName + '\n'; m._reset();
    assert.deepEqual(await m.verifyAgent(e, ORIGIN, 'm_abc', 2e12), { ok: true });
  } finally { box.restore(); }
  m._reset();
  box = fakeBox(() => new Response(JSON.stringify({ error: { code: 'machine_not_running' } }), { status: 409 }));
  try {
    assert.deepEqual(await m.verifyAgent(e, ORIGIN, 'm_abc', 3e12), { skipped: true });
    assert.deepEqual(await m.verifyAgent(e, ORIGIN, 'm_abc', 3e12 + 1000), { skipped: true });
    assert.equal(box.calls.length, 2, '云电脑没醒时不算查过，下次还查');
  } finally { box.restore(); }
});

test('打开网页（greet）时顺手自检，不挡这次请求；别的操作不触发', async () => {
  const m = await worker(), e = env(), waits = [];
  const box = fakeBox(c => {
    if (c.path === '/v1/machines') return ok({ machines: [{ id: 'm_abc', name: 'li', state: 'running' }] });
    if (c.path.endsWith('/exec')) { const argv = JSON.parse(c.body).argv; return ok({ stdout: argv[0] === 'sha256sum' ? '' : '{"warming":false}', stderr: '', exitCode: 0 }); }
    return ok({});
  });
  try {
    const login = await m.handleXin(new Request(ORIGIN + '/api/xin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-xin': '1', origin: ORIGIN }, body: JSON.stringify({ password: e.OWNER_PASSWORD }) }), e, null);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = op => m.handleXin(new Request(ORIGIN + '/api/xin/call', { method: 'POST', headers: { 'content-type': 'application/json', 'x-xin': '1', origin: ORIGIN, cookie }, body: JSON.stringify({ op, args: {} }) }), e, { waitUntil: p => waits.push(p) });
    assert.equal((await (await call('ping')).json()).ok, true);
    assert.equal(waits.length, 0);
    assert.equal((await (await call('greet')).json()).ok, true);
    assert.equal(waits.length, 1); await Promise.all(waits);
    const execs = box.calls.filter(c => c.path.endsWith('/exec')).map(c => JSON.parse(c.body).argv);
    assert.deepEqual(execs.map(a => a[0] === 'sha256sum' ? 'sha256sum' : a[2]), ['ping', 'greet', 'sha256sum']);
  } finally { box.restore(); }
});
