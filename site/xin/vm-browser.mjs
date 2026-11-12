/* 小芯浏览器 v1 第一步：公开网页（设计见 docs/xin-browser-v1-design.md）。
   每一轮后台任务一个「浏览器代理」：控制器这边持有真的 Chromium（CDP 走管道，不开调试端口；干净资料，用完连目录一起删），
   容器里的模型只能用 `xin browser 命令` 经转发端口发 {cmd, args} 过来，拿不到 CDP。
   参考 Microsoft Playwright CLI：无障碍树快照、元素编号、按编号操作、每个命令只回网址标题和快照；
   Grok Bot sand-browser-tools.ts：有后果的操作先检查；OpenDuet secret-masking.ts：快照里不出密码框的值。
   两个 Playwright 项目都写明「不是安全边界」，所以网络（只走出网代理、只放行公网 80/443）、网址协议、
   有后果的操作都在这里判，不信模型说的意图。 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
// 不 import vm-runtime.mjs：它要 import 这个文件，Worker 装脚本时不允许模块循环引用。出网代理和地址检查由 taskNetwork 传进来

export const BROWSER_LIMITS = { commands: 300, tabs: 5, timeoutMs: 30000, snapshotChars: 12000, textChars: 20000, downloadBytes: 100 * 1024 * 1024 };
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
const fail = (error, msg) => ({ error, msg });

/* ---------- CDP（--remote-debugging-pipe：消息是以 \0 结尾的 JSON） ---------- */
class Cdp {
  constructor(write, read) {
    this.write = write; this.id = 0; this.pending = new Map(); this.listeners = new Set(); this.closed = false;
    let buf = '';
    read.setEncoding('utf8');
    read.on('data', d => {
      buf += d;
      for (let i; (i = buf.indexOf('\0')) >= 0;) {
        let m; try { m = JSON.parse(buf.slice(0, i)); } catch { m = null; }
        buf = buf.slice(i + 1);
        if (m) this.dispatch(m);
      }
    });
    read.on('close', () => { this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('浏览器已经关了')); } this.pending.clear(); });
  }
  dispatch(m) {
    if (m.id) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result || {}); return; }
    for (const f of this.listeners) f(m);
  }
  send(method, params = {}, sessionId, timeout = 15000) {
    if (this.closed) return Promise.reject(Error('浏览器已经关了'));
    return new Promise((resolve, reject) => {
      const id = ++this.id, timer = setTimeout(() => { this.pending.delete(id); reject(Error('浏览器没有回应：' + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write.write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + '\0');
    });
  }
}

/* ---------- 快照：无障碍树 → 一行一个元素，能操作的带编号 ---------- */
const REF_ROLES = new Set(['link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'switch', 'slider', 'spinbutton', 'listbox', 'treeitem']);
const LEAF_ROLES = new Set([...REF_ROLES, 'heading', 'image', 'img']);   // 名字里已经有内容，不再往下展开
const BLOCK_ROLES = new Set(['dialog', 'alertdialog', 'form', 'search', 'navigation', 'main', 'list', 'listitem', 'table', 'row', 'cell', 'columnheader', 'rowheader', 'article', 'region', 'banner', 'contentinfo', 'complementary']);
const prop = (n, name) => (n.properties || []).find(p => p.name === name)?.value?.value;
const q = s => JSON.stringify(String(s).replace(/\s+/g, ' ').trim().slice(0, 160));
export function renderSnapshot(nodes, { secret = () => false, nextRef }) {
  const byId = new Map(nodes.map(n => [n.nodeId, n])), refs = new Map(), out = [];
  const root = nodes.find(n => !n.parentId) || nodes[0];
  const walk = (n, depth) => {
    if (!n) return;
    const kids = () => { for (const c of n.childIds || []) walk(byId.get(c), depth); };
    const role = n.role?.value || '', name = String(n.name?.value || '').trim();
    if (n.ignored || role === 'RootWebArea' || role === 'InlineTextBox' || role === 'LineBreak') return kids();
    if (role === 'StaticText') { if (name) out.push('  '.repeat(depth) + '- text: ' + name.replace(/\s+/g, ' ').slice(0, 300)); return; }
    if (LEAF_ROLES.has(role)) {
      let line = '  '.repeat(depth) + '- ' + role + (name ? ' ' + q(name) : '');
      const isSecret = n.backendDOMNodeId && secret(n.backendDOMNodeId);
      if (role === 'heading' && prop(n, 'level')) line += ' [level=' + prop(n, 'level') + ']';
      if (isSecret) line += ' (密码框，内容不显示)';
      else if (['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'].includes(role) && n.value?.value) line += ' 值=' + q(n.value.value);
      if (prop(n, 'checked') === 'true' || prop(n, 'checked') === true) line += ' [已选]';
      if (prop(n, 'disabled')) line += ' [不可用]';
      if (REF_ROLES.has(role) && n.backendDOMNodeId) { const r = nextRef(); refs.set(r, { node: n.backendDOMNodeId, role, name }); line += ' [' + r + ']'; }
      out.push(line);
      return;
    }
    if (BLOCK_ROLES.has(role) && (name || role !== 'cell')) { out.push('  '.repeat(depth) + '- ' + role + (name ? ' ' + q(name) : '')); for (const c of n.childIds || []) walk(byId.get(c), depth + 1); return; }
    kids();
  };
  walk(root, 0);
  return { text: out.join('\n'), refs };
}

/* ---------- 有后果的操作：按页面元素判，不信模型说的意图（docs/xin-next-stage.md 5.3） ---------- */
const RISKY = /(付款|支付|购买|下单|结算|结账|删除|移除|清空|发送|发布|评论|回复|留言|提交|登录|登入|注册|授权|允许|订阅|关注|\bpay\b|\bbuy\b|purchase|checkout|place order|delete|remove|\bsend\b|\bpost\b|publish|comment|reply|submit|sign ?in|log ?in|sign ?up|register|authori[sz]e|\ballow\b|subscribe|follow)/i;
const RISKY_LINK = /(付款|支付|购买|下单|结算|结账|删除|注销|\bpay\b|\bbuy\b|purchase|checkout|delete|log ?out|sign ?out)/i;
const SEARCHY = /(搜索|搜\s*索|查找|检索|查询|search|\bfind\b|\bgo\b)/i;
const OWNER = why => fail('needs_owner', '这一步要站长自己来：' + why + '。现在只浏览公开网页，不登录、不付款、不发东西、不删东西；把需要站长做的事写进结果。');
const ELEMENT_INFO = `function(){const el=this,tag=(el.tagName||'').toLowerCase(),type=String(el.type||'').toLowerCase(),ac=String(el.autocomplete||'').toLowerCase();
 const form=el.form||(el.closest&&el.closest('form'))||null,fields=form?[...form.elements]:[],lab=f=>String(f.innerText||f.value||f.getAttribute&&f.getAttribute('aria-label')||f.title||'').trim().slice(0,80);
 return {tag,type,label:lab(el),secret:type==='password'||/^cc-|one-time-code/.test(ac),inForm:!!form,
  formSecret:fields.some(f=>f.type==='password'),
  formSearch:!!form&&(form.getAttribute('role')==='search'||!!form.closest('[role=search]')||fields.some(f=>f.type==='search')),
  formButtons:fields.filter(f=>f.tagName==='BUTTON'||['submit','image'].includes(f.type)).map(lab).slice(0,8),
  isButton:tag==='button'||['submit','button','image','reset'].includes(type)||(el.getAttribute&&el.getAttribute('role')==='button'),isLink:tag==='a'};}`;
export function clickRisk(name, info) {
  const words = [name, info.label].filter(Boolean).join(' ');
  if (info.isLink && !info.isButton) return RISKY_LINK.test(words) ? OWNER('「' + (name || info.label) + '」会产生外部后果') : null;
  if (info.inForm && info.formSecret && (info.isButton || info.tag === 'input')) return OWNER('这是登录表单');
  if (RISKY.test(words) && !SEARCHY.test(words)) return OWNER('「' + (name || info.label) + '」会产生外部后果');
  return null;
}
export function enterRisk(info) {
  if (!info || !info.inForm || info.tag === 'textarea') return null;
  if (info.formSecret) return OWNER('在登录表单里按回车就是提交');
  if (info.formSearch) return null;
  const bad = (info.formButtons || []).find(b => RISKY.test(b) && !SEARCHY.test(b));
  return bad ? OWNER('在这个表单里按回车会提交「' + bad + '」') : null;
}

const KEYS = { Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], PageUp: [33], PageDown: [34], Home: [36], End: [35], Space: [32, ' '] };
// 出网代理拒绝时回的那几句（vm-runtime.mjs 的 egressProxy）：http 网址被拒时浏览器里看到的就是这一句
const DENIED = /^(后台任务只能访问公网(的 80\/443 端口|地址)|代理请求需要完整网址|连接失败)$/;
const BLOCKED = fail('blocked', '打不开：只能访问公网网址（本机、内网地址和 80/443 以外的端口都不行）');
const okUrl = u => { try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol) ? x.href : null; } catch { return null; } };

/* ---------- 代理本体 ---------- */
export async function browserBroker({ chrome, profileDir, work, headless = true, display = '', socketPath = '', egress, allowAddress, ports = [80, 443], log = () => {}, limits = {} }) {
  if (typeof egress !== 'function' || typeof allowAddress !== 'function') throw Error('浏览器代理缺少出网代理或地址检查');
  const L = { ...BROWSER_LIMITS, ...limits };
  let child = null, cdp = null, pages = [], current = null, refs = new Map(), refNo = 0, used = 0, queue = Promise.resolve(), proxy = null, server = null, closed = false;
  const downloads = path.join(work, 'downloads');

  async function start() {
    proxy = await egress({ allowAddress, ports });
    fs.rmSync(profileDir, { recursive: true, force: true }); fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const attempt = async (noSandbox, headless) => {
      const args = ['--remote-debugging-pipe', '--user-data-dir=' + profileDir, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-default-apps', '--disable-features=Translate,MediaRouter,OptimizationHints',
        '--password-store=basic', '--use-mock-keychain', '--disable-dev-shm-usage', '--window-size=1280,860', '--lang=zh-CN', '--disable-quic', '--dns-prefetch-disable',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--proxy-server=http://127.0.0.1:' + proxy.port, '--proxy-bypass-list=<-loopback>'];
      if (headless) args.push('--headless=new');
      if (noSandbox) args.push('--no-sandbox');
      args.push('about:blank');
      const env = { ...process.env }; if (!headless && display) env.DISPLAY = display;
      const c = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env });
      let err = ''; c.stderr.setEncoding('utf8'); c.stderr.on('data', s => { err = (err + s).slice(-2000); });
      const conn = new Cdp(c.stdio[3], c.stdio[4]);
      const exited = new Promise(ok => c.once('exit', () => ok(null)));
      const ready = await Promise.race([conn.send('Browser.getVersion', {}, null, 20000).then(() => true, () => null), exited]);
      if (!ready) { try { c.kill('SIGKILL'); } catch { /* 已经退了 */ } return { error: err }; }
      return { c, conn };
    };
    // 先开 Chromium 自己的沙盒；root 或者这台机器开不了沙盒就退回 --no-sandbox（小芯电脑上网页成品检查一直是这样）。
    // 桌面上开不出来（没有权限连桌面）就退回无头
    const tries = [];
    for (const hl of headless ? [true] : [false, true]) { if (process.getuid?.() !== 0) tries.push([false, hl]); tries.push([true, hl]); }
    let r = { error: '' };
    for (const [ns, hl] of tries) { r = await attempt(ns, hl); if (!r.error) break; }
    if (r.error) throw Error('浏览器启动失败：' + String(r.error).trim().split('\n').slice(-3).join(' '));
    child = r.c; cdp = r.conn;
    // runner 收尾时不一定等得到 close()：进程退出时同步杀掉浏览器、删资料
    process.once('exit', () => { try { child?.kill('SIGKILL'); } catch { /* 没了 */ } try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* 删不掉下一轮开始时再删 */ } });
    cdp.listeners.add(onEvent);
    fs.mkdirSync(downloads, { recursive: true });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const t of targetInfos.filter(t => t.type === 'page')) pages.push({ id: t.targetId, url: t.url, title: t.title, opener: t.openerId || null });
    current = await attach(pages[0]);
  }
  function onEvent(m) {
    const p = m.params || {};
    if (m.method === 'Target.targetCreated' && p.targetInfo.type === 'page' && !pages.some(x => x.id === p.targetInfo.targetId)) pages.push({ id: p.targetInfo.targetId, url: p.targetInfo.url, title: p.targetInfo.title, opener: p.targetInfo.openerId || null, born: Date.now() });
    if (m.method === 'Target.targetInfoChanged') { const x = pages.find(x => x.id === p.targetInfo.targetId); if (x) Object.assign(x, { url: p.targetInfo.url, title: p.targetInfo.title }); }
    if (m.method === 'Target.targetDestroyed') { pages = pages.filter(x => x.id !== p.targetId); if (current?.id === p.targetId) current = null; }
    if (m.method === 'Browser.downloadProgress' && p.receivedBytes > L.downloadBytes) cdp.send('Browser.cancelDownload', { guid: p.guid }).catch(() => {});
    const page = pages.find(x => x.session && x.session === m.sessionId);
    if (!page) return;
    if (m.method === 'Page.frameStartedLoading' && p.frameId === page.frame) page.loading = true;
    if ((m.method === 'Page.loadEventFired' || m.method === 'Page.frameStoppedLoading' && p.frameId === page.frame)) page.loading = false;
    if (m.method === 'Page.frameNavigated' && !p.frame.parentId) { page.frame = p.frame.id; page.nav = (page.nav || 0) + 1; }
  }
  async function attach(page) {
    if (!page.session) {
      page.session = (await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })).sessionId;
      for (const m of ['Page.enable', 'DOM.enable', 'Accessibility.enable']) await cdp.send(m, {}, page.session);
      page.frame = (await cdp.send('Page.getFrameTree', {}, page.session)).frameTree.frame.id;
      page.nav = page.nav || 0;
    }
    await cdp.send('Target.activateTarget', { targetId: page.id }).catch(() => {});
    return page;
  }
  const S = (method, params, timeout) => cdp.send(method, params, current.session, timeout);
  async function evaluate(expression) {
    const r = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error('页面脚本出错');
    return r.result.value;
  }
  // 等页面稳定：先给导航一点时间开始，再等加载完、readyState 和网址不再变
  async function settle(max = 10000) {
    const end = Date.now() + max; let last = '';
    await sleep(250);
    while (Date.now() < end) {
      if (current?.loading) { await sleep(100); continue; }
      let st = ''; try { st = await evaluate('document.readyState+"|"+location.href'); } catch { await sleep(100); continue; }
      if (st.startsWith('complete|') && st === last) return;
      last = st; await sleep(150);
    }
  }
  async function popups(before) {
    await sleep(200);
    const fresh = pages.filter(p => !before.has(p.id) && p.opener);
    if (fresh.length) {
      current = await attach(fresh.at(-1));
      while (pages.length > L.tabs) { const old = pages.find(p => p !== current); await cdp.send('Target.closeTarget', { targetId: old.id }).catch(() => {}); pages = pages.filter(p => p !== old); }
    }
  }
  async function secretNodes() {
    // 密码框、银行卡号框：快照里不出值（OpenDuet secret-masking.ts）
    const ids = new Set();
    try {
      const { root } = await S('DOM.getDocument', { depth: -1, pierce: false });
      const walk = n => { const a = n.attributes || []; const at = k => { const i = a.indexOf(k); return i >= 0 && i % 2 === 0 ? String(a[i + 1]).toLowerCase() : ''; };
        if (n.nodeName === 'INPUT' && (at('type') === 'password' || /^cc-|one-time-code/.test(at('autocomplete')))) ids.add(n.backendNodeId);
        for (const c of n.children || []) walk(c); for (const c of n.contentDocument ? [n.contentDocument] : []) walk(c); };
      walk(root);
    } catch { /* 拿不到就当没有 */ }
    return ids;
  }
  async function denied() { try { return DENIED.test(String(await evaluate('document.body ? document.body.innerText.trim() : ""'))); } catch { return false; } }
  async function state(note = '') {
    if (!note && await denied()) note = '（这一页打不开：只能访问公网网址）';
    let url = '', title = '';
    try { [url, title] = await evaluate('[location.href, document.title]'); } catch { /* 正在跳转 */ }
    const secrets = await secretNodes();
    const { nodes } = await S('Accessibility.getFullAXTree', {});
    const snap = renderSnapshot(nodes, { secret: id => secrets.has(id), nextRef: () => 'e' + (++refNo) });
    refs = new Map([...snap.refs].map(([k, v]) => [k, { ...v, page: current.id, nav: current.nav }]));
    let text = snap.text;
    if (text.length > L.snapshotChars) text = text.slice(0, L.snapshotChars) + '\n…（快照太长，后面省略了；读正文用 xin browser text，或者 scroll 以后再 snapshot）';
    return { ok: true, text: (note ? note + '\n' : '') + '网址：' + url + '\n标题：' + title + '\n' + text };
  }
  function element(ref) {
    const r = refs.get(String(ref || ''));
    if (!r || r.page !== current?.id || r.nav !== current.nav) return null;
    return r;
  }
  async function resolve(r) {
    const { object } = await S('DOM.resolveNode', { backendNodeId: r.node });
    return object.objectId;
  }
  async function info(objectId) {
    return (await S('Runtime.callFunctionOn', { objectId, functionDeclaration: ELEMENT_INFO, returnByValue: true })).result.value || {};
  }
  const stale = () => fail('stale_ref', '这个编号不是最近一次快照里的（页面变了）：先 xin browser snapshot，用新的编号');

  const CMDS = {
    async open(url) {
      const u = okUrl(url);
      if (!u) return fail('bad_url', '只能打开 http:// 或 https:// 网址');
      const r = await S('Page.navigate', { url: u }, L.timeoutMs);
      if (/TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED/.test(r.errorText || '')) return BLOCKED;
      if (r.errorText) return fail('nav_failed', '打不开 ' + u + '（' + r.errorText + '）');
      await settle();
      if (await denied()) return BLOCKED;
      return state();
    },
    snapshot: () => state(),
    async click(ref) {
      const r = element(ref); if (!r) return stale();
      const objectId = await resolve(r), i = await info(objectId);
      const risk = clickRisk(r.name, i); if (risk) return risk;
      await S('DOM.scrollIntoViewIfNeeded', { backendNodeId: r.node }).catch(() => {});
      const { quads } = await S('DOM.getContentQuads', { backendNodeId: r.node });
      if (!quads?.length) return fail('not_visible', '这个元素现在看不到，点不了；换一个或者先 scroll');
      const qd = quads[0], x = (qd[0] + qd[2] + qd[4] + qd[6]) / 4, y = (qd[1] + qd[3] + qd[5] + qd[7]) / 4, before = new Set(pages.map(p => p.id));
      await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await popups(before); await settle();
      return state();
    },
    async fill(ref, ...words) {
      const r = element(ref); if (!r) return stale();
      const objectId = await resolve(r), i = await info(objectId);
      if (i.secret) return OWNER('这是密码框（或银行卡号、验证码）');
      await S('DOM.focus', { backendNodeId: r.node });
      await S('Runtime.callFunctionOn', { objectId, functionDeclaration: "function(){if('value' in this){this.value='';this.dispatchEvent(new Event('input',{bubbles:true}));}else if(this.isContentEditable)this.textContent='';}" });
      await S('Input.insertText', { text: words.join(' ').slice(0, 2000) });
      return state();
    },
    async press(key) {
      const k = KEYS[key] || (String(key || '').length === 1 ? [String(key).toUpperCase().charCodeAt(0), key] : null);
      if (!k) return fail('bad_key', '不认识的按键：' + key + '（可以用 ' + Object.keys(KEYS).join('、') + ' 或单个字符）');
      if (key === 'Enter') {
        let i = null;
        try { const { result } = await S('Runtime.evaluate', { expression: 'document.activeElement' }); if (result.objectId) i = await info(result.objectId); } catch { /* 没有焦点 */ }
        const risk = enterRisk(i); if (risk) return risk;
      }
      const before = new Set(pages.map(p => p.id)), base = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: k[0] };
      await S('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k[1] ? { text: k[1] } : {}) });
      await S('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await popups(before); await settle();
      return state();
    },
    async select(ref, ...words) {
      const r = element(ref); if (!r) return stale();
      const want = words.join(' '), objectId = await resolve(r);
      const { result } = await S('Runtime.callFunctionOn', { objectId, arguments: [{ value: want }], returnByValue: true,
        functionDeclaration: "function(w){if(!this.options)return false;const o=[...this.options].find(o=>o.value===w||o.text.trim()===w)||[...this.options].find(o=>o.text.includes(w));if(!o)return false;this.value=o.value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true;}" });
      if (!result.value) return fail('no_option', '下拉框里没有「' + want + '」');
      await settle(3000);
      return state();
    },
    async scroll(dir = 'down') {
      await S('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: dir === 'up' ? -700 : 700 });
      await sleep(300);
      return state();
    },
    async back() {
      const h = await S('Page.getNavigationHistory');
      if (h.currentIndex < 1) return fail('no_history', '没有上一页了');
      await S('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
      await settle();
      return state();
    },
    async text(ref) {
      let t;
      if (ref) {
        const r = element(ref); if (!r) return stale();
        t = (await S('Runtime.callFunctionOn', { objectId: await resolve(r), functionDeclaration: 'function(){return String(this.innerText||this.textContent||"")}', returnByValue: true })).result.value;
      } else t = await evaluate('document.body ? document.body.innerText : ""');
      t = String(t || '').replace(/\n{3,}/g, '\n\n').trim();
      return { ok: true, text: t.length > L.textChars ? t.slice(0, L.textChars) + '\n…（正文太长，后面省略了）' : t || '（没有文字）' };
    },
    async screenshot(name = 'screenshot.png') {
      if (!/^[\w一-龥.-]{1,80}\.png$/.test(name) || name.includes('..')) return fail('bad_path', '截图文件名只能是 名字.png（存在任务副本根目录下）');
      const { data } = await S('Page.captureScreenshot', { format: 'png' }, L.timeoutMs);
      const file = path.join(work, name);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return { ok: true, text: '截图存到 ' + file };
    },
    async tabs() {
      return { ok: true, text: pages.map((p, i) => i + ' ' + (p.title || '（无标题）') + ' ' + p.url + (p === current ? '（当前）' : '')).join('\n') };
    },
    async tab(n) {
      const p = pages[Number(n)];
      if (!p) return fail('no_tab', '没有第 ' + n + ' 个标签页（xin browser tabs 看有哪些）');
      current = await attach(p);
      return state();
    },
    async close() { await shutdown(); return { ok: true, text: '浏览器关了' }; },
  };

  async function run(cmd, args) {
    if (!Object.hasOwn(CMDS, cmd)) return fail('bad_cmd', '没有这个命令：' + cmd + '（可以用 ' + Object.keys(CMDS).join('、') + '）');
    if (used >= L.commands) return fail('budget', '这一轮浏览器命令已经用了 ' + L.commands + ' 个，不能再用；把已经查到的写进结果');
    used++;
    if (cmd === 'close' && !child) return { ok: true, text: '浏览器没开' };
    if (!child) await start();
    if (!current) current = await attach(pages.find(p => p) || (await (async () => { const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }); await sleep(100); return pages.find(p => p.id === targetId); })()));
    return CMDS[cmd](...args);
  }
  function handle({ cmd, args = [] } = {}) {
    const t0 = Date.now(), go = queue.then(() => Promise.race([run(String(cmd || ''), (Array.isArray(args) ? args : []).map(String)),
      sleep(L.timeoutMs + 15000).then(() => fail('timeout', '浏览器这一步超时了'))]))
      .catch(e => fail('browser', e.message));
    queue = go.then(() => {}, () => {});
    return go.then(r => {
      const a = cmd === 'fill' ? [args[0], String(args.slice(1).join(' ')).slice(0, 60)] : (args || []).slice(0, 2).map(x => String(x).slice(0, 200));
      log({ cmd: String(cmd), args: a, ok: !!r.ok, error: r.error || null, ms: Date.now() - t0, url: current?.url || '' });
      return r;
    });
  }
  async function shutdown() {
    const c = child; child = null; cdp?.listeners.clear();
    if (c) {
      const gone = new Promise(ok => { if (c.exitCode !== null || c.signalCode) ok(); else c.once('exit', ok); });
      try { await Promise.race([cdp.send('Browser.close', {}, null, 3000), sleep(3000)]); } catch { /* 关不掉就杀 */ }
      await Promise.race([gone, sleep(3000)]);
      try { c.kill('SIGKILL'); } catch { /* 已经退了 */ }
      await Promise.race([gone, sleep(2000)]);
    }
    cdp = null; pages = []; current = null; refs = new Map();
    proxy?.close(); proxy = null;
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
  if (socketPath) {
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8'); req.on('data', d => { body += d; if (body.length > 65536) req.destroy(); });
      req.on('end', async () => {
        let msg = {}; try { msg = JSON.parse(body || '{}'); } catch { /* 坏的 */ }
        const r = await handle(msg);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r));
      });
    });
    try { fs.unlinkSync(socketPath); } catch { /* 没有旧的 */ }
    await new Promise((ok, no) => { server.once('error', no); server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); ok(); }); });
  }
  return {
    socket: socketPath || null, handle, pid: () => child?.pid || 0,
    async close() { if (closed) return; closed = true; await queue; await shutdown(); if (server) { server.closeAllConnections(); server.close(); } },
    // 一轮结束时 runner 同步收尾（等不到异步关）：撤掉套接字、杀掉浏览器、删资料
    closeNow() {
      if (closed) return; closed = true;
      if (server) { server.closeAllConnections(); server.close(); }
      if (socketPath) try { fs.unlinkSync(socketPath); } catch { /* 已经没了 */ }
      cdp?.listeners.clear(); try { child?.kill('SIGKILL'); } catch { /* 已经退了 */ } child = null;
      proxy?.close(); proxy = null;
      fs.rmSync(profileDir, { recursive: true, force: true });
    },
  };
}
