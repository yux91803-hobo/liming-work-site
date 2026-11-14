// 小芯浏览器第二步 2a：用站长的登录（docs/xin-browser-v2-design.md）。
// 不设白名单：任务点名哪个网站就带哪个网站保存的登录；登录由站长在登录窗口里自己输；别的网站的登录一概不装。
// 参考 Nanobrowser gate.ts（密码框、登录是用户的这一步）、Browser Use domains.py（只许在点名网站里跳）、Playwright MCP（--isolated + storage-state）。
const test = require('node:test');
const { lockedSpawn } = require('./helpers/locked.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');

const SITE = path.join(__dirname, '../site/xin');
const imp = f => import(pathToFileURL(path.join(SITE, f)).href);

/* ---------- 网站归属、登录存储（纯函数） ---------- */

test('网站 = 可注册域名：子域名归到主站，多段后缀（com.cn、co.uk）、托管域名（github.io）按下一级；IP、单个词不算网站', async () => {
  const { siteOf, normalizeSite } = await imp('vm-logins.mjs');
  const cases = {
    'passport.bilibili.com': 'bilibili.com', 'www.bilibili.com': 'bilibili.com', 'bilibili.com': 'bilibili.com',
    'www.lcsc.com.cn': 'lcsc.com.cn', 'lcsc.com.cn': 'lcsc.com.cn', 'a.b.example.co.uk': 'example.co.uk',
    'me.github.io': 'me.github.io', 'x.me.github.io': 'me.github.io', 'Shop.Test.': 'shop.test', '.mail.qq.com': 'qq.com',
    '127.0.0.1': null, '[::1]': null, '::1': null, 'localhost': null, '': null, 'com.cn': null, 'github.io': null,
  };
  for (const [host, want] of Object.entries(cases)) assert.equal(siteOf(host), want, host);
  assert.equal(normalizeSite('https://www.bilibili.com/video/BV1?x=1'), 'bilibili.com');
  assert.equal(normalizeSite('bilibili.com'), 'bilibili.com');
  assert.equal(normalizeSite('  WWW.LCSC.COM.CN/order '), 'lcsc.com.cn');
  assert.equal(normalizeSite('http://shop.test:8080/'), 'shop.test');
  for (const bad of ['B站', 'http://127.0.0.1/', 'file:///etc/passwd', 'javascript:alert(1)', '', 'a b.com']) assert.equal(normalizeSite(bad), null, bad);
});

test('登录存储：一个网站一个文件（目录 700、文件 600）；只取点名网站的 cookie；删掉就没了；列表有网站和时间', async () => {
  const { loginStore } = await imp('vm-logins.mjs');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-logins-')), 'browser-logins');
  const s = loginStore(dir);
  assert.deepEqual(s.list(), []);
  const c = (name, domain, extra = {}) => ({ name, value: name + '-v', domain, path: '/', expires: -1, size: 5, httpOnly: true, secure: false, session: true, sameSite: 'Lax', priority: 'Medium', sourceScheme: 'NonSecure', sourcePort: 80, ...extra });
  s.save('shop.test', [c('sess', 'shop.test'), c('pref', '.shop.test', { expires: 4102444800, session: false })]);
  s.save('other.test', [c('other', 'other.test')]);
  assert.equal((fs.statSync(dir).mode & 0o777).toString(8), '700');
  for (const f of fs.readdirSync(dir)) assert.equal((fs.statSync(path.join(dir, f)).mode & 0o777).toString(8), '600', f);
  assert.deepEqual(s.list().map(x => x.site), ['other.test', 'shop.test']);
  assert.ok(s.list().every(x => x.saved > 0 && x.count >= 1));
  assert.ok(s.has('shop.test') && !s.has('nope.test'));
  const got = s.cookies(['shop.test']);
  assert.deepEqual(got.map(x => x.name).sort(), ['pref', 'sess']);
  // 装进浏览器用的参数：会话 cookie 不带 expires，带过期时间的照带；Storage.setCookies 不认的字段去掉
  const sess = got.find(x => x.name === 'sess'), pref = got.find(x => x.name === 'pref');
  assert.equal('expires' in sess, false); assert.equal(pref.expires, 4102444800);
  for (const k of ['size', 'session']) assert.equal(k in sess, false, k);
  assert.deepEqual(s.cookies(['nope.test']), []);
  assert.deepEqual(s.cookies([]), []);
  assert.equal(s.remove('shop.test'), true);
  assert.equal(s.has('shop.test'), false);
  assert.equal(s.remove('shop.test'), false);
  assert.equal(s.remove('../x'), false, '不认的名字不碰文件');
  assert.throws(() => s.save('../evil', [c('x', 'evil')]), /网站/);
});

test('从浏览器里拿到的 cookie 分网站存：只存点名（或主页面去过）的网站，广告、统计这些只在子请求里出现的不存；空的不存（不把好好的登录冲掉）', async () => {
  const { loginStore, saveSites } = await imp('vm-logins.mjs');
  const s = loginStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-logins-')), 'l'));
  s.save('sso.test', [{ name: 'old', value: '1', domain: 'sso.test', path: '/' }]);
  const jar = [
    { name: 'sess', value: 'new', domain: 'shop.test', path: '/' }, { name: 'p', value: '1', domain: '.www.shop.test', path: '/' },
    { name: 'track', value: 'x', domain: '.ads.test', path: '/' },
  ];
  const saved = saveSites(s, jar, ['shop.test', 'sso.test', 'ads-none.test']);
  assert.deepEqual(saved, ['shop.test']);
  assert.deepEqual(s.cookies(['shop.test']).map(x => x.name).sort(), ['p', 'sess']);
  assert.deepEqual(s.cookies(['sso.test']).map(x => x.name), ['old'], '这次没拿到 sso.test 的 cookie：原来存的不动');
  assert.equal(s.has('ads.test'), false);
});

/* ---------- 真的 Chromium：几个「网站」用不同主机名指到本机测试服务器 ---------- */

function chromium() {
  const pw = '/opt/pw-browsers', found = [process.env.CHROMIUM_PATH, '/usr/lib/chromium/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  try { for (const d of fs.readdirSync(pw).filter(d => /^chromium-\d+$/.test(d))) found.push(pw + '/' + d + '/chrome-linux64/chrome', pw + '/' + d + '/chrome-linux/chrome'); } catch { /* 没有 */ }
  return found.find(p => p && fs.existsSync(p));
}
// 测试机开不了沙盒时测试里才用 --no-sandbox（同 xin-browser.test.cjs）；正式开不了就不浏览
const ROOT = (() => {
  const exe = chromium(); if (!exe) return false;
  if (process.getuid?.() === 0) return true;
  return !require('./helpers/chromium-probe.cjs').sandboxAvailable(exe);
})();
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
async function until(fn, ms = 15000, what = '') {
  const end = performance.now() + platformTimeout(ms); let v;
  while (performance.now() < end) { v = await fn(); if (v) return v; await sleep(120); }
  throw new Error('等不到：' + what + ' ' + JSON.stringify(v));
}
function sites() {
  const hits = [], seen = {};
  let port = 0;
  const u = (host, p = '/') => 'http://' + host + ':' + port + p;
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '').split(':')[0], url = new URL(req.url, 'http://x'), cookie = String(req.headers.cookie || '');
    hits.push(host + url.pathname);
    const html = (body, headers = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(body); };
    if (req.method === 'POST') return html('<title>提交了</title>提交了');
    if (host === 'shop.test') {
      if (url.pathname === '/') return html(`<!doctype html><title>商店</title><h1>商店首页</h1>
        <a href="/me">我的</a> <a href="${u('other.test')}">别的网站</a> <a href="${u('other.test', '/pop')}" target="_blank">别的网站新窗口</a>
        <form role="search" action="${u('other.test', '/search')}"><input type="search" name="q" aria-label="站外搜索"><button>搜索</button></form>
        <form action="/login" method="post"><label>账号 <input name="user"></label><label>密码 <input type="password" name="pw"></label><button>登录</button></form>
        <form action="/comment" method="post"><label>留言 <textarea name="c"></textarea></label><button>发送</button></form>
        <img src="${u('ads.test', '/pixel')}" alt="">`);
      if (url.pathname === '/me') return html('<title>我的</title><h1>收到的 cookie：' + (cookie || '（没有）') + '</h1>');
      if (url.pathname === '/set') return html('<title>设好了</title>设好了', { 'set-cookie': 'fresh=1; Path=/; Max-Age=3600' });
      if (url.pathname === '/auto-login') {
        seen.autoLoginCookie = cookie;
        res.writeHead(302, { location: u('sso.test', '/sso'), 'set-cookie': 'sess=new; Path=/; HttpOnly' }); return res.end();
      }
    }
    if (host === 'sso.test' && url.pathname === '/sso') { res.writeHead(302, { location: u('shop.test', '/'), 'set-cookie': 'sso=1; Path=/' }); return res.end(); }
    if (host === 'ads.test') { res.writeHead(200, { 'content-type': 'image/gif', 'set-cookie': 'track=1; Path=/' }); return res.end(); }
    if (host === 'other.test') return html('<title>别的网站</title><h1>别的网站</h1>');
    res.writeHead(404); res.end('no');
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => { port = server.address().port; ok({ u, hits, seen, close: () => { server.closeAllConnections(); server.close(); } }); }));
}
let last = null;
const ref = (snap, re) => { assert.equal(typeof snap, 'string', '上一个命令没有快照：' + JSON.stringify(last)); const line = snap.split('\n').find(l => re.test(l)); assert.ok(line, '快照里找不到 ' + re + '\n' + snap); return /\[(e\d+)\]/.exec(line)[1]; };
// 出网代理照正式的走，只是测试里把这些主机名都解析到本机、放行本机地址
async function testNet() {
  const rt = await imp('vm-runtime.mjs');
  return { egress: o => rt.egressProxy({ ...o, lookup: async () => [{ address: '127.0.0.1', family: 4 }] }), allowAddress: () => true, ports: () => true };
}
async function broker(t, o = {}) {
  const exe = chromium();
  if (!exe) { t.skip('需要 Chromium：设置 CHROMIUM_PATH'); return null; }
  const { browserBroker } = await imp('vm-browser.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-blogin-')), work = path.join(root, 'work'), steps = [];
  fs.mkdirSync(work);
  const s = await sites(), { loginStore } = await imp('vm-logins.mjs'), store = o.store || loginStore(path.join(root, 'logins'));
  const b = await browserBroker({ chrome: exe, profileDir: path.join(root, 'profile'), work, headless: true, noSandbox: ROOT, ...(await testNet()),
    logins: store, limits: { cookieSaveMs: 0 }, step: async x => { steps.push(x); return { ok: true }; }, ...o.opts });
  t.after(async () => { await b.close(); s.close(); });
  const run = async (cmd, ...args) => (last = await b.handle({ cmd, args }));
  return { b, s, run, root, work, store, steps };
}
const cookie = (name, value, domain) => ({ name, value, domain, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' });

test('带登录的一轮：只装点名网站保存的 cookie（别的网站的登录不装）；主页面跳不出点名网站（打开、点链接、表单、新窗口都拦）；网站续的 cookie 写回', { timeout: platformTimeout(90000) }, async t => {
  const { loginStore } = await imp('vm-logins.mjs');
  const store = loginStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-blogin-st-')), 'logins'));
  store.save('shop.test', [cookie('sess', 'abc', 'shop.test')]);
  store.save('other.test', [cookie('other', 'zzz', 'other.test')]);
  const h = await broker(t, { store, opts: { sites: ['shop.test'] } }); if (!h) return;
  const { s, run } = h;
  let r = await run('open', s.u('shop.test', '/me'));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.text, /sess=abc/, '点名网站的登录装上了');
  assert.ok(!/other=zzz/.test(r.text), '别的网站的登录没装');
  r = await run('open', s.u('other.test'));
  assert.equal(r.error, 'offsite', JSON.stringify(r)); assert.match(r.msg, /shop\.test/); assert.match(r.msg, /curl/);
  r = await run('open', s.u('shop.test'));
  assert.equal(r.ok, true, JSON.stringify(r));
  const before = s.hits.length;
  let x = await run('click', ref(r.text, /link "别的网站" \[/));
  assert.equal(x.error, 'offsite', '点链接去别的网站被拦：' + JSON.stringify(x));
  const back = await run('snapshot');   // 被拦以后退回了商店首页：页面重新加载过，用新的编号
  x = await run('fill', ref(back.text, /searchbox "站外搜索"/), 'stm32');
  assert.equal(x.ok, true, JSON.stringify(x));
  x = await run('press', 'Enter');
  assert.equal(x.error, 'offsite', '表单提交到别的网站被拦：' + JSON.stringify(x));
  assert.deepEqual(s.hits.slice(before).filter(h => h.startsWith('other.test')), [], '主页面去别的网站的请求没发出去');
  x = await run('snapshot');
  assert.match(x.text, new RegExp('网址：' + s.u('shop.test').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '还在商店首页：' + x.text.slice(0, 200));
  x = await run('click', ref(x.text, /link "别的网站新窗口"/));
  assert.equal(x.error, 'offsite', '新窗口去别的网站被拦：' + JSON.stringify(x));
  assert.equal((await run('tabs')).text.split('\n').length, 1, '新窗口关掉了');
  r = await run('open', s.u('shop.test', '/set'));
  assert.equal(r.ok, true, JSON.stringify(r));
  await until(() => store.cookies(['shop.test']).some(c => c.name === 'fresh'), 5000, '网站新设的 cookie 写回');
  assert.ok(store.cookies(['shop.test']).some(c => c.name === 'sess' && c.value === 'abc'));
  assert.deepEqual(store.cookies(['other.test']).map(c => c.value), ['zzz'], '别的网站的不动');
});

test('没点名网站的一轮（公开网页）：和第一步一样，一个登录都不装，也不限网站', { timeout: platformTimeout(60000) }, async t => {
  const { loginStore } = await imp('vm-logins.mjs');
  const store = loginStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-blogin-st-')), 'logins'));
  store.save('shop.test', [cookie('sess', 'abc', 'shop.test')]);
  const h = await broker(t, { store }); if (!h) return;
  let r = await h.run('open', h.s.u('shop.test', '/me'));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.text, /没有/, '没装登录：' + r.text.slice(0, 300));
  r = await h.run('open', h.s.u('other.test'));
  assert.equal(r.ok, true, '公开网页哪儿都能去：' + JSON.stringify(r));
  r = await h.run('open', h.s.u('shop.test', '/set'));
  await sleep(300);
  assert.deepEqual(store.cookies(['shop.test']).map(c => c.name), ['sess'], '公开的一轮不往登录里写');
});

test('登录交给站长：填密码框、点「登录」、在登录表单里回车、xin browser login，都不发到页面；回调拿到网站和网址；同一个网站这一轮只问一次；「发送」照旧拒绝', { timeout: platformTimeout(60000) }, async t => {
  const h = await broker(t, { opts: { sites: ['shop.test'] } }); if (!h) return;
  const { s, run, steps } = h;
  const r = await run('open', s.u('shop.test'));
  assert.equal(r.ok, true, JSON.stringify(r));
  let x = await run('fill', ref(r.text, /textbox "密码"/), 'hunter2');
  assert.equal(x.error, 'needs_login', JSON.stringify(x));
  assert.match(x.msg, /shop\.test/); assert.match(x.msg, /结束这一轮/); assert.match(x.msg, /站长/);
  assert.deepEqual(steps, [{ kind: 'login', site: 'shop.test', url: s.u('shop.test'), saved: false }]);
  x = await run('click', ref(r.text, /button "登录"/));
  assert.equal(x.error, 'needs_login', JSON.stringify(x));
  x = await run('fill', ref(r.text, /textbox "账号"/), 'me');
  assert.equal(x.ok, true, '普通输入框照常');
  const snap = x.text;
  x = await run('press', 'Enter');
  assert.equal(x.error, 'needs_login', '登录表单里回车：' + JSON.stringify(x));
  x = await run('login');
  assert.equal(x.error, 'needs_login');
  assert.equal(steps.length, 1, '同一个网站这一轮只问一次');
  x = await run('click', ref(snap, /button "发送"/));
  assert.equal(x.error, 'needs_owner', '发送这类有后果的操作照旧拒绝（确认卡在下一步）');
  x = await run('login', 'https://www.other.test/x');
  assert.equal(x.error, 'needs_login');
  assert.deepEqual(steps[1], { kind: 'login', site: 'other.test', url: 'https://www.other.test/x', saved: false });
  x = await run('login', '127.0.0.1');
  assert.equal(x.error, 'bad_site', JSON.stringify(x));
  await sleep(300);
  assert.deepEqual(s.hits.filter(h => /\/(login|comment)$/.test(h)), [], '没有表单被提交出去');
});

test('公开网页的一轮碰到登录：一样交给站长（站长同意后下一轮才带这个网站的登录）', { timeout: platformTimeout(60000) }, async t => {
  const h = await broker(t); if (!h) return;
  const r = await h.run('open', h.s.u('shop.test'));
  const x = await h.run('fill', ref(r.text, /textbox "密码"/), 'hunter2');
  assert.equal(x.error, 'needs_login', JSON.stringify(x));
  assert.deepEqual(h.steps.map(s => s.site), ['shop.test']);
});

/* ---------- 登录窗口：没有模型，只有站长在屏幕上操作 ---------- */

async function loginWin(t, store, o = {}) {
  const exe = chromium();
  if (!exe) { t.skip('需要 Chromium'); return null; }
  const { loginWindow } = await imp('vm-browser.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-lwin-')), s = await sites();
  let w = null;
  t.after(() => { w?.closeNow(); s.close(); });
  w = await loginWindow({ chrome: exe, profileDir: path.join(root, 'profile'), headless: true, noSandbox: ROOT, ...(await testNet()), logins: store,
    site: 'shop.test', url: s.u('shop.test', '/auto-login'), saveMs: 200, ...o });
  return { w, s, root };
}

test('登录窗口：装上这个网站已有的 cookie；站长登好后点「好了」，主页面去过的网站分别存好（广告这类子请求的不存）；浏览器和资料目录都清掉', { timeout: platformTimeout(60000) }, async t => {
  const { loginStore } = await imp('vm-logins.mjs');
  const store = loginStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-lwin-st-')), 'logins'));
  store.save('shop.test', [cookie('old', '1', 'shop.test')]);
  const h = await loginWin(t, store); if (!h) return;
  const { w, s, root } = h;
  await until(() => s.hits.includes('shop.test/'), 15000, '经 sso.test 回到商店首页');
  assert.match(s.seen.autoLoginCookie, /old=1/, '已有的 cookie 装上了');
  const pid = w.pid();
  const r = await w.finish();
  assert.deepEqual(r.saved, ['shop.test', 'sso.test']);
  assert.deepEqual(store.cookies(['shop.test']).map(c => c.name).sort(), ['old', 'sess']);
  assert.deepEqual(store.cookies(['sso.test']).map(c => c.name), ['sso']);
  assert.equal(store.has('ads.test'), false);
  assert.equal(fs.existsSync(path.join(root, 'profile')), false, '资料目录删了');
  assert.throws(() => process.kill(pid, 0), '浏览器进程没了');
});

test('登录窗口：开着时隔一会儿就存（站长直接关窗口也不丢）；开太久自己关', { timeout: platformTimeout(60000) }, async t => {
  const { loginStore } = await imp('vm-logins.mjs');
  const store = loginStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-lwin-st-')), 'logins'));
  const h = await loginWin(t, store, { maxMs: 3000 }); if (!h) return;
  await until(() => store.has('shop.test') && store.has('sso.test'), 15000, '开着时就存了');
  const end = await h.w.ended;
  assert.equal(end.reason, 'timeout');
  assert.equal(fs.existsSync(path.join(h.root, 'profile')), false);
});

/* ---------- 控制器：任务点名网站、停成「等你登录」、站长点按钮后接着做 ---------- */

const AGENT = path.join(SITE, 'vm-agent.mjs');
// 假 codex（同 xin-batch1.test.cjs）：后台任务在 $L/hold-bg 存在时一直等，然后回「做好了」；每次调用的参数记下来
function fakeCodex(dir) {
  const bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(log, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), [
    '#!/bin/sh',
    'case "$*" in *--ephemeral*) exit 0;; esac',
    'L="' + log + '"',
    'exec 9>"$L/seq.lock"; flock 9',
    'n=$(cat "$L/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$L/n"',
    // 先写临时名再改名：测试看到 args.N 时内容是完整的
    'for a in "$@"; do printf "%s\\n" "$a"; done > "$L/.args.$n" && mv "$L/.args.$n" "$L/args.$n"',
    'flock -u 9; exec 9>&-',
    'printf \'{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-%012d"}\\n\' $n',
    'echo \'{"type":"turn.started"}\'',
    'case "$*" in *【你现在在后台】*) while [ -f "$L/hold-bg" ]; do sleep 0.1; done;; esac',
    'echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"做好了"}}\'',
    'echo \'{"type":"turn.completed","usage":{}}\''
  ].join('\n'), { mode: 0o755 });
  const calls = () => fs.readdirSync(log).filter(f => /^args\.\d+$/.test(f)).sort((a, b) => a.split('.')[1] - b.split('.')[1]).map(f => fs.readFileSync(path.join(log, f), 'utf8'));
  return { bin, log, calls };
}
function home(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-blogin-agent-')), xin = path.join(dir, 'xin'), work = path.join(dir, 'work');
  fs.mkdirSync(xin, { recursive: true }); fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(path.join(dir, 'tmp'));
  const fc = fakeCodex(dir);
  const env = { ...process.env, TMPDIR: path.join(dir, 'tmp'), XIN_HOME: xin, XIN_WORK: work, XIN_CODEX_TRANSPORT: 'exec', XIN_FRONT_PROVIDER: 'deepseek',
    XIN_DSH: path.join(dir, 'no-dsh'), XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', CODEX_HOME: path.join(dir, 'codex'), PATH: fc.bin + ':' + process.env.PATH, ...extra };
  const ensureState=require('./helpers/state-mode.cjs').stateClient(t,env);
  const run = (argv, args) => { ensureState(); const r = spawnSync(process.execPath, [AGENT, ...argv], { env, input: JSON.stringify(args || {}), encoding: 'utf8', timeout: platformTimeout(30000) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const op = (name, args) => run([name], args), locked = (name, args) => { ensureState(); const r = lockedSpawn(AGENT, name, args, { env, encoding: 'utf8', timeout: platformTimeout(30000) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const hold = on => { const f = path.join(fc.log, 'hold-bg'); if (on) fs.writeFileSync(f, ''); else fs.rmSync(f, { force: true }); };
  const task = sid => JSON.parse(fs.readFileSync(path.join(xin, 'sessions', sid + '.json'), 'utf8'));
  t.after(() => stopOwned(xin, dir));
  return { dir, xin, work, env, op, locked, hold, task, fc };
}
async function agentModule(env) {
  const old = { ...process.env };
  Object.assign(process.env, env);
  try { return await import(pathToFileURL(AGENT).href + '?bl=' + Math.random()); } finally { for (const k of Object.keys(env)) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
}
async function waitingForLogin(h, step = { kind: 'login', site: 'shop.test', url: 'http://shop.test/', saved: false }) {
  h.hold(true);
  const n = h.locked('task_new', { kind: 'code', title: '看订单', goal: '看看我在商店的订单' });
  const t = await until(() => { const x = h.task(n.task.sid); return x.status === 'running' && x.runs.length && x; }, 15000, '开工');
  const run = t.runs.at(-1);
  const r = h.locked('task_browser_step', { sid: t.sid, run, step });
  assert.equal(r.ok, true, JSON.stringify(r));
  h.hold(false);
  const w = await until(() => { const x = h.task(t.sid); return x.status === 'waiting' && x.finishedRun && x; }, 15000, '停成等你登录');
  return { sid: t.sid, run, task: w };
}

test('xin task new --site：可以写多个，写域名或网址都行，认成网站；认不出、超过 5 个说清楚', async () => {
  const m = await agentModule({ XIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'xin-bl-args-')) });
  const o = m.parseTaskArgs(['--title', '看订单', '--site', 'bilibili.com', '--site=https://www.lcsc.com.cn/order', '--', '看看订单']);
  assert.deepEqual(o.sites, ['bilibili.com', 'lcsc.com.cn']);
  assert.equal(o.goal, '看看订单');
  assert.match(m.parseTaskArgs(['--site', '127.0.0.1', '--', 'x']).error, /网站/);
  assert.match(m.parseTaskArgs(['--site', 'a.com', '--site', 'b.com', '--site', 'c.com', '--site', 'd.com', '--site', 'e.com', '--site', 'f.com', '--', 'x']).error, /5/);
  assert.equal(m.parseTaskArgs(['--', '不点名']).sites, undefined, '没点名网站就不带这一项');
});

test('派任务时点名的网站记在任务上（重复的合并），任务列表里看得到；这一轮浏览器带上这些网站的登录、能请站长登录', async t => {
  const h = home(t);
  h.hold(true);
  const n = h.locked('task_new', { kind: 'code', title: '看订单', goal: '看看订单', sites: ['https://passport.bilibili.com/login', 'bilibili.com', 'lcsc.com.cn'] });
  assert.ok(n.task, JSON.stringify(n));
  assert.deepEqual(h.task(n.task.sid).sites, ['bilibili.com', 'lcsc.com.cn']);
  assert.deepEqual(h.op('tasks', {}).active.find(x => x.sid === n.task.sid).sites, ['bilibili.com', 'lcsc.com.cn']);
  assert.match(JSON.stringify(h.locked('task_new', { kind: 'code', title: 'x', goal: 'x', sites: ['127.0.0.1'] })), /网站/);
  // 另开一个进程看（数据目录在模块第一次加载时定下来）
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', 'import { browserOpts } from ' + JSON.stringify(pathToFileURL(AGENT).href) +
    '; const o = browserOpts(' + JSON.stringify(n.task.sid) + ', "r1"); console.log(JSON.stringify({ sites: o.sites, dir: o.logins.dir, step: typeof o.step }));'], { env: h.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { sites: ['bilibili.com', 'lcsc.com.cn'], dir: path.join(h.xin, 'browser-logins'), step: 'function' });
  h.hold(false);
});

test('登录交给站长：任务停成「等你登录」（问题、推送都说要登录哪个网站）；站长点「好了，接着做」→ 网站加进任务，下一轮带上登录接着做', async t => {
  const h = home(t);
  const { sid, task } = await waitingForLogin(h);
  assert.match(task.question, /登录/); assert.match(task.question, /shop\.test/);
  const card = h.op('tasks', {}).tasks.concat(h.op('tasks', {}).recent, h.op('tasks', {}).active).find(x => x.sid === sid) || h.op('tasks', { all: true }).tasks.find(x => x.sid === sid);
  assert.deepEqual(card.browserStep, { kind: 'login', site: 'shop.test', saved: false });
  const told = h.op('task_tell', { sid, decision: 'approve' });
  assert.equal(told.ok, true, JSON.stringify(told));
  const x = h.task(sid);
  assert.deepEqual(x.sites, ['shop.test']);
  assert.equal(x.browserStep, undefined);
  await until(() => h.task(sid).status === 'done', 15000, '接着做完');
  const last = h.fc.calls().at(-1);
  assert.match(last, /站长同意用 shop\.test 的登录/);
});

test('站长点「不用了」：网站不加进任务，告诉模型别换办法登录；直接回一句话就当普通回复', async t => {
  let h = home(t);
  let { sid } = await waitingForLogin(h);
  assert.equal(h.op('task_tell', { sid, decision: 'deny' }).ok, true);
  assert.equal(h.task(sid).sites, undefined);
  await until(() => h.task(sid).status === 'done', 15000, '接着做完');
  assert.match(h.fc.calls().at(-1), /站长不用 shop\.test 的登录/);
  h = home(t);
  ({ sid } = await waitingForLogin(h));
  assert.equal(h.op('task_tell', { sid, text: '我自己在电脑上登好了' }).ok, true);
  assert.equal(h.task(sid).browserStep, undefined);
  await until(() => h.task(sid).status === 'done', 15000, '接着做完');
  assert.match(h.fc.calls().at(-1), /用户回复：我自己在电脑上登好了/);
});

test('task_browser_step 只认这个任务当前这一轮、只认登录这一种、网站要认得出', async t => {
  const h = home(t);
  h.hold(true);
  const n = h.locked('task_new', { kind: 'code', title: 'x', goal: 'x' });
  const tk = await until(() => { const x = h.task(n.task.sid); return x.status === 'running' && x.runs.length && x; }, 15000, '开工');
  const run = tk.runs.at(-1);
  assert.ok(h.locked('task_browser_step', { sid: tk.sid, run: 'rnotthis0001', step: { kind: 'login', site: 'shop.test', url: 'http://shop.test/' } }).error);
  assert.ok(h.locked('task_browser_step', { sid: tk.sid, run, step: { kind: 'pay', site: 'shop.test', url: 'http://shop.test/' } }).error);
  assert.ok(h.locked('task_browser_step', { sid: tk.sid, run, step: { kind: 'login', site: '127.0.0.1', url: 'http://127.0.0.1/' } }).error);
  assert.equal(h.task(tk.sid).browserStep, undefined);
  h.hold(false);
});

test('网站登录：列表、删掉；登录窗口：网址认不出、电脑上没装浏览器、浏览器起不来都说清楚，不留下半截；没开窗口时「登好了」也不出错', async t => {
  const h = home(t, { XIN_CHROMIUM: '/nonexistent/chromium' });
  const { loginStore } = await imp('vm-logins.mjs');
  const store = loginStore(path.join(h.xin, 'browser-logins'));
  store.save('shop.test', [cookie('sess', 'abc', 'shop.test')]);
  store.save('bilibili.com', [cookie('SESSDATA', 'x', '.bilibili.com')]);
  let r = h.op('logins');
  assert.deepEqual(r.sites.map(x => x.site), ['bilibili.com', 'shop.test']);
  assert.ok(r.sites.every(x => x.saved > 0));
  assert.ok(!JSON.stringify(r).includes('abc'), 'cookie 的值不出控制器');
  assert.equal(h.op('login_remove', { site: 'https://www.bilibili.com/' }).ok, true);
  assert.deepEqual(h.op('logins').sites.map(x => x.site), ['shop.test']);
  assert.match(h.op('login_remove', { site: '../x' }).msg || '', /网站/);
  assert.match(h.op('login_open', { url: 'B站' }).msg, /网站/);
  assert.match(h.op('login_open', { url: 'bilibili.com' }).msg, /没装浏览器/);
  r = h.op('login_done');
  assert.equal(r.ok, true); assert.deepEqual(r.saved, []);
  // 浏览器一启动就退出：说清楚登录窗口没开起来，不留着窗口记录
  const fake = path.join(h.dir, 'fake-chrome');
  fs.writeFileSync(fake, '#!/bin/sh\necho "boom" >&2\nexit 1\n', { mode: 0o755 });
  const h2 = home(t, { XIN_CHROMIUM: fake, XIN_BROWSER_HEADLESS: '1' });
  r = h2.op('login_open', { url: 'https://www.bilibili.com/' });
  assert.equal(r.error, 'failed', JSON.stringify(r)); assert.match(r.msg, /登录窗口/);
  assert.equal(fs.existsSync(path.join(h2.xin, 'login-window.json')), false);
  assert.equal(h2.op('logins').window, null);
});

test('提示词：前台知道 --site 只写用户说到的网站；后台知道要登录就 xin browser login 然后结束这一轮、密码由用户自己输；带登录的任务写明是哪些网站、只能在这些网站里浏览', async () => {
  process.env.XIN_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'xin-bl-prompt-'));
  const { taskSystemPrompt, systemPrompt } = await imp('vm-persona.mjs');
  const ws = { work: '/w/work', home: '/w/home', tmp: '/w/tmp' };
  const plain = taskSystemPrompt({ no: 1, title: '查手册', dir: '/data/workspace/x', workspace: ws, goal: '找手册' });
  assert.match(plain, /xin browser login/); assert.match(plain, /结束这一轮/); assert.match(plain, /密码、验证码永远由用户自己输入/);
  assert.ok(!/带着用户在/.test(plain), '没点名网站就不说带登录');
  const scoped = taskSystemPrompt({ no: 2, title: '看订单', dir: '/data/workspace/y', workspace: ws, goal: '看订单', sites: ['lcsc.com.cn', 'bilibili.com'] });
  assert.match(scoped, /带着用户在 lcsc\.com\.cn、bilibili\.com 的登录/); assert.match(scoped, /只能在这些网站里浏览/);
  const front = systemPrompt('', { tasks: true });
  assert.match(front, /--site 网站/); assert.match(front, /只写用户说到的网站/);
});
