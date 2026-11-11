// 普通任务做出的页面也给预览入口（站长 2026-11-11：查资料时做的看板打不开）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = () => import('../site/xin/vm-runtime.mjs');
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function workspace(t, files, before = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-page-')), work = path.join(dir, 'work'), tmp = path.join(dir, 'tmp');
  fs.mkdirSync(work); fs.mkdirSync(tmp);
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true }); fs.writeFileSync(path.join(work, name), text); }
  const manifest = path.join(dir, 'manifest.json'); fs.writeFileSync(manifest, JSON.stringify({ original: work, before }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, task: { sid: 'spagetask001', parent: 'sparent00001', title: '收集情报', runs: ['rpage0000001'], workspace: { work, tmp, manifest } } };
}
const page = (title, body = '<p>hi</p>') => '<!doctype html><html><head><title>' + title + '</title></head><body>' + body + '</body></html>';

test('只挑这次新做或改过的页面：层级最浅的，同层先 index.html；原项目里没动过的不算', async t => {
  const { findPage } = await load();
  const { task } = workspace(t, { 'report.md': '# 报告', 'board/index.html': page('看板'), 'board/a.html': page('a'), 'z.html': page('z') });
  assert.equal(findPage(task), 'z.html');
  const { task: deeper } = workspace(t, { 'report.md': '#', 'board/a.html': page('a'), 'board/index.html': page('看板') });
  assert.equal(findPage(deeper), 'board/index.html');
  const { inventory } = await load();
  const { task: old } = workspace(t, { 'site/index.html': page('旧页面') });
  fs.writeFileSync(old.workspace.manifest, JSON.stringify({ before: inventory(old.workspace.work) }));
  assert.equal(findPage(old), null, '没改过的页面不算这次做的');
  assert.equal(findPage({ title: 'x' }), null);
});

test('自包含的页面发布成预览：标题取 <title>；引用外部文件或改过内容就不发布', async t => {
  const { publishPagePreview } = await load();
  const { dir, task } = workspace(t, { 'board.html': page('模型发布看板', '<div id=x>表</div>') });
  const shot = path.join(task.workspace.tmp, 'xin-web-preview.png'); fs.writeFileSync(shot, PNG);
  const crypto = require('node:crypto'), digest = crypto.createHash('sha256').update(page('模型发布看板', '<div id=x>表</div>')).digest('hex');
  const controller = path.join(dir, 'xin');
  const p = publishPagePreview(task, controller, { ok: true, entry: 'board.html', digest, screenshot: shot, viewports: [] });
  assert.equal(p.ready, true); assert.equal(p.title, '模型发布看板'); assert.match(p.url, /^\/xin\/preview\.html\?id=[a-f0-9]{32}$/);
  assert.ok(fs.existsSync(path.join(controller, 'previews', p.id, 'index.html')) && fs.existsSync(path.join(controller, 'previews', p.id, 'preview.png')));
  fs.writeFileSync(path.join(task.workspace.work, 'board.html'), page('模型发布看板', '<div>改过</div>'));
  assert.throws(() => publishPagePreview(task, controller, { ok: true, entry: 'board.html', digest, screenshot: shot }), /又改过/);
  fs.writeFileSync(path.join(task.workspace.work, 'cdn.html'), page('cdn', '<script src="https://cdn.example/x.js"></script>'));
  assert.throws(() => publishPagePreview(task, controller, { ok: true, entry: 'cdn.html', digest, screenshot: shot }), /外部文件/);
  assert.throws(() => publishPagePreview(task, controller, { ok: false, entry: 'board.html', digest, screenshot: shot }));
});
