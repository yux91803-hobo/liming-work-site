// 小芯浏览器 v1 第一步：公开网页（docs/xin-browser-v1-design.md）。用真的 Chromium 打开本机测试页面。
// 参考 Microsoft Playwright CLI：快照带元素编号、按编号操作、每个命令只回网址标题和快照。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const { platformTimeout } = require('./helpers/timeout.cjs');

function chromium() {
  const pw = '/opt/pw-browsers', found = [process.env.CHROMIUM_PATH, '/usr/lib/chromium/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  try { for (const d of fs.readdirSync(pw).filter(d => /^chromium-\d+$/.test(d))) found.push(pw + '/' + d + '/chrome-linux64/chrome', pw + '/' + d + '/chrome-linux/chrome'); } catch { /* 没有 */ }
  return found.find(p => p && fs.existsSync(p));
}
const load = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-browser.mjs')).href);

const PAGES = {
  '/': `<!doctype html><title>首页</title><h1>小芯测试站</h1>
    <a href="/next">下一页</a> <a href="/popup" target="_blank">新窗口</a>
    <form role="search" action="/search"><input type="search" name="q" aria-label="站内搜索"><button>搜索</button></form>
    <form action="/login" method="post"><label>账号 <input name="user"></label><label>密码 <input type="password" name="pw" value="hunter2-secret"></label><button>登录</button></form>
    <form action="/comment" method="post"><label>留言 <textarea name="c"></textarea></label><button>发送</button></form>
    <button onclick="document.title='删了'">删除账号</button>
    <select aria-label="芯片"><option value="f103">STM32F103</option><option value="f407">STM32F407</option></select>
    <a href="/file.bin">下载手册</a>
    <div style="height:3000px"></div><p id="end">页面底部</p>`,
  '/next': `<!doctype html><title>第二页</title><h1>第二页</h1><a href="/">回首页</a><div id="x"></div>
    <script>setTimeout(()=>{document.getElementById('x').textContent='脚本写的内容'},50)</script>`,
  '/popup': `<!doctype html><title>弹出页</title><h1>新开的窗口</h1>`,
};
function site() {
  const posts = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST') { posts.push(u.pathname); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<title>提交了</title>提交了'); }
    if (u.pathname === '/search') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<title>搜索结果</title><h1>搜索结果：' + u.searchParams.get('q') + '</h1>'); }
    if (u.pathname === '/file.bin') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="manual.pdf"' }); return res.end('PDF-DATA'); }
    const html = PAGES[u.pathname];
    if (!html) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ base: 'http://127.0.0.1:' + server.address().port, posts, close: () => { server.closeAllConnections(); server.close(); } })));
}
async function setup(t, extra = {}) {
  const exe = chromium();
  if (!exe) return t.skip('需要 Chromium：设置 CHROMIUM_PATH');
  const { browserBroker } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-browser-')), work = path.join(root, 'work'), events = [];
  fs.mkdirSync(work);
  const s = await site();
  // 测试页面在本机：只在测试里放行本机地址（正式按公网地址检查，见下面单独一项）
  const b = await browserBroker({ chrome: exe, profileDir: path.join(root, 'profile'), work, headless: true, allowAddress: () => true, ports: () => true, log: e => events.push(e), ...extra });
  t.after(async () => { await b.close(); s.close(); });
  const run = async (cmd, ...args) => b.handle({ cmd, args });
  return { b, s, run, root, work, events };
}
const ref = (snap, re) => { const line = snap.split('\n').find(l => re.test(l)); assert.ok(line, '快照里找不到 ' + re + '\n' + snap); return /\[(e\d+)\]/.exec(line)[1]; };

test('打开网页：回网址、标题和带编号的快照；点链接跳过去；脚本写出来的内容也看得到；后退', { timeout: platformTimeout(60000) }, async t => {
  const { s, run, events } = await setup(t);
  let r = await run('open', s.base + '/');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.text, /标题：首页/);
  assert.match(r.text, /heading "小芯测试站"/);
  r = await run('click', ref(r.text, /link "下一页"/));
  assert.match(r.text, /标题：第二页/);
  r = await run('text');
  assert.match(r.text, /脚本写的内容/);
  r = await run('back');
  assert.match(r.text, /标题：首页/);
  assert.ok(events.some(e => e.cmd === 'open') && events.some(e => e.cmd === 'click'), '每一步都记下来');
});

test('搜索：在搜索框填字、按回车或点「搜索」都照常', { timeout: platformTimeout(60000) }, async t => {
  const { s, run } = await setup(t);
  let r = await run('open', s.base + '/');
  r = await run('fill', ref(r.text, /searchbox "站内搜索"/), 'STM32 定时器');
  assert.equal(r.ok, true, JSON.stringify(r));
  r = await run('press', 'Enter');
  assert.match(r.text, /搜索结果：STM32 定时器/);
  r = await run('back');
  r = await run('fill', ref(r.text, /searchbox "站内搜索"/), 'GPIO');
  r = await run('click', ref(r.text, /button "搜索"/));
  assert.match(r.text, /搜索结果：GPIO/);
});

test('第一步不做的：密码框的值不进快照、往里填被拒；登录、发送、删除被拒，表单没提交出去', { timeout: platformTimeout(60000) }, async t => {
  const { s, run } = await setup(t);
  const r = await run('open', s.base + '/');
  assert.ok(!r.text.includes('hunter2-secret'), '密码不出现在快照里');
  let x = await run('fill', ref(r.text, /textbox "密码"/), 'abc');
  assert.equal(x.error, 'needs_owner'); assert.match(x.msg, /密码/);
  for (const name of ['登录', '发送', '删除账号']) {
    x = await run('click', ref(r.text, new RegExp('button "' + name + '"')));
    assert.equal(x.error, 'needs_owner', name); assert.match(x.msg, /站长/);
  }
  x = await run('fill', ref(r.text, /textbox "账号"/), 'me');
  assert.equal(x.ok, true, '普通输入框能填');
  x = await run('press', 'Enter');
  assert.equal(x.error, 'needs_owner', '登录表单里按回车也算提交');
  await new Promise(ok => setTimeout(ok, 300));
  assert.deepEqual(s.posts, [], '没有表单被提交出去');
  assert.equal((await run('text')).text.includes('删了'), false);
});

test('下拉框、翻页、截图、新窗口自动切过去、下载进 downloads', { timeout: platformTimeout(60000) }, async t => {
  const { s, run, work } = await setup(t);
  let r = await run('open', s.base + '/');
  const x = await run('select', ref(r.text, /combobox "芯片"/), 'STM32F407');
  assert.equal(x.ok, true, JSON.stringify(x));
  assert.match((await run('snapshot')).text, /combobox "芯片".*STM32F407/);
  assert.equal((await run('scroll', 'down')).ok, true);
  const shot = await run('screenshot', 'home.png');
  assert.equal(shot.ok, true, JSON.stringify(shot));
  assert.ok(fs.statSync(path.join(work, 'home.png')).size > 1000);
  assert.equal((await run('screenshot', '../escape.png')).error, 'bad_path');
  r = await run('snapshot');
  r = await run('click', ref(r.text, /link "新窗口"/));
  assert.match(r.text, /标题：弹出页/);
  assert.match((await run('tabs')).text, /弹出页/);
  r = await run('tab', '0');
  assert.match(r.text, /标题：首页/);
  r = await run('click', ref(r.text, /link "下载手册"/));
  for (const end = Date.now() + platformTimeout(10000); Date.now() < end && !fs.existsSync(path.join(work, 'downloads', 'manual.pdf'));) await new Promise(ok => setTimeout(ok, 100));
  assert.equal(fs.readFileSync(path.join(work, 'downloads', 'manual.pdf'), 'utf8'), 'PDF-DATA');
});

test('编号只在最近一次快照里有效：页面变了还用旧编号被拒；不认识的命令、file: 网址被拒', { timeout: platformTimeout(60000) }, async t => {
  const { s, run } = await setup(t);
  const home = await run('open', s.base + '/');
  const old = ref(home.text, /link "下一页"/);
  await run('click', old);
  const x = await run('click', old);
  assert.equal(x.error, 'stale_ref'); assert.match(x.msg, /snapshot/);
  assert.equal((await run('eval', '1')).error, 'bad_cmd');
  for (const u of ['file:///etc/passwd', 'chrome://settings', 'data:text/html,hi', 'javascript:alert(1)']) assert.equal((await run('open', u)).error, 'bad_url', u);
});

test('正式的地址检查：本机和内网地址打不开（Chromium 的请求都经出网代理）', { timeout: platformTimeout(60000) }, async t => {
  const exe = chromium();
  if (!exe) return t.skip('需要 Chromium');
  const { browserBroker } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-browser-net-')), s = await site();
  const b = await browserBroker({ chrome: exe, profileDir: path.join(root, 'profile'), work: root, headless: true });
  t.after(async () => { await b.close(); s.close(); });
  const r = await b.handle({ cmd: 'open', args: [s.base + '/'] });
  assert.equal(r.error, 'blocked', '本机页面不该打开：' + JSON.stringify(r).slice(0, 300));
  assert.match(r.msg, /公网/);
});

test('预算：命令数用完被拒；关掉以后浏览器进程和资料目录都没了', { timeout: platformTimeout(60000) }, async t => {
  const { b, s, run, root } = await setup(t, { limits: { commands: 3 } });
  await run('open', s.base + '/');
  await run('snapshot');
  await run('snapshot');
  const x = await run('snapshot');
  assert.equal(x.error, 'budget'); assert.match(x.msg, /3/);
  const pid = b.pid();
  assert.ok(pid > 0);
  await b.close();
  assert.throws(() => process.kill(pid, 0), '浏览器进程退出了');
  assert.ok(!fs.existsSync(path.join(root, 'profile')), '资料目录删了');
});

test('不浏览就不启动浏览器', { timeout: platformTimeout(20000) }, async t => {
  const { b } = await setup(t);
  assert.equal(b.pid(), 0);
});
