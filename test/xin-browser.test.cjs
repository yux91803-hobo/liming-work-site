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
const load = async () => {
  const b = await import(pathToFileURL(path.join(__dirname, '../site/xin/vm-browser.mjs')).href), rt = await import(pathToFileURL(path.join(__dirname, '../site/xin/vm-runtime.mjs')).href);
  return { browserBroker: o => b.browserBroker({ egress: rt.egressProxy, allowAddress: rt.publicAddress, ...o }) };
};

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

/* ---------- 接进后台任务：taskNetwork 起代理、容器里的 xin browser 经转发端口用它 ---------- */
const rtLoad = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-runtime.mjs')).href);
const freePort = () => new Promise(ok => { const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
// 和容器里一样：转发器把本机端口接到这一轮的 browser.sock，再跑任务目录里的 xin
function inTask(rt, ws, forward, port, ...args) {
  const child = require('node:child_process').spawn(process.execPath, ['-e', rt.TASK_FORWARDER, '--', JSON.stringify(forward), process.execPath, path.join(ws.home, 'bin', 'xin'), 'browser', ...args],
    { env: { PATH: process.env.PATH, XIN_TASK_IO: ws.io, XIN_BROWSER_PORT: String(port) } });
  let out = '', err = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
  return new Promise(ok => child.on('close', code => ok({ code, out, err })));
}

test('后台任务：容器里的 xin browser 经转发端口用这一轮的浏览器；这一轮结束套接字撤掉、浏览器关掉', { timeout: platformTimeout(60000) }, async t => {
  const exe = chromium();
  if (!exe) return t.skip('需要 Chromium');
  const rt = await rtLoad(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-browser-task-'));
  fs.mkdirSync(path.join(root, 'project')); fs.mkdirSync(path.join(root, 'control'));
  const task = { sid: 'sbrowse00001', dir: path.join(root, 'project') };
  task.workspace = rt.prepareWorkspace(task, path.join(root, 'control'));
  const s = await site(), logs = [];
  const n = await rt.taskNetwork(task.workspace, null, { chrome: exe, headless: true, log: e => logs.push(e), testNet: { allowAddress: () => true, ports: () => true } });
  t.after(() => { n.close(); s.close(); });
  const sock = n.network.forward.find(([p]) => p === rt.TASK_PORTS.browser)?.[1];
  assert.ok(sock, '转发里有浏览器端口');
  assert.ok(!sock.startsWith(task.workspace.work) && !sock.startsWith(task.workspace.home), '套接字不在容器能写的地方');
  const port = await freePort(), fwd = [[port, sock]];
  let r = await inTask(rt, task.workspace, fwd, port, 'open', s.base + '/');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /标题：首页/);
  r = await inTask(rt, task.workspace, fwd, port, 'nope');
  assert.equal(r.code, 1); assert.match(r.err, /没有这个命令/);
  assert.ok(logs.some(e => e.cmd === 'open'), '控制器这边记下了');
  n.close();
  assert.ok(!fs.existsSync(sock), '套接字撤掉了');
  assert.ok(!fs.existsSync(path.join(path.dirname(task.workspace.io), 'browser-profile')), '资料目录删了');
});

test('后台任务：这一轮没有浏览器（电脑上没装）时 xin browser 说清楚，不卡住', { timeout: platformTimeout(30000) }, async t => {
  const rt = await rtLoad(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-browser-none-'));
  fs.mkdirSync(path.join(root, 'project')); fs.mkdirSync(path.join(root, 'control'));
  const task = { sid: 'sbrowse00002', dir: path.join(root, 'project') };
  task.workspace = rt.prepareWorkspace(task, path.join(root, 'control'));
  const n = await rt.taskNetwork(task.workspace, null, { chrome: path.join(root, 'no-chromium') });
  t.after(() => n.close());
  assert.ok(!n.network.forward.some(([p]) => p === rt.TASK_PORTS.browser), '没有浏览器就不转发');
  const port = await freePort();
  const r = await inTask(rt, task.workspace, [], port, 'open', 'https://example.com/');
  assert.equal(r.code, 1); assert.match(r.err, /没有可用的浏览器/);
});

test('后台任务的提示词：普通任务讲清楚 xin browser 怎么用、哪些会被拒；网页成品任务不让它找浏览器', async () => {
  process.env.XIN_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'xin-browser-prompt-'));
  const { taskSystemPrompt } = await import(pathToFileURL(path.join(__dirname, '../site/xin/vm-persona.mjs')).href);
  const ws = { work: '/w/work', home: '/w/home', tmp: '/w/tmp' };
  const p = taskSystemPrompt({ no: 1, title: '查手册', dir: '/data/workspace/x', workspace: ws, goal: '找 STM32F103 的参考手册' });
  assert.match(p, /xin browser open/);
  assert.match(p, /click e12/);
  assert.match(p, /curl/);
  assert.match(p, /不登录、不付款/);
  assert.match(p, /downloads/);
  const web = taskSystemPrompt({ no: 2, title: '奶龙', dir: '/data/workspace/y', workspace: ws, web: true, goal: '做个网页' });
  assert.ok(!/xin browser open/.test(web), '网页成品由控制器验收，不让它开浏览器');
});
