/* xin/chat.js — 小芯聊天：和 InstaBox 云电脑里的 AI（Claude Code / Codex）聊天、让它干活
   入口：小芯背包里的「聊天」（首页和 STM32 学习台里的小芯都有）：小芯旁边冒一个输入框（打字或语音），回复出现在小芯头上的气泡里，
   点气泡或输入框上的「展开」才打开这个面板看全文和历史。地址后面加 #xin 直接打开面板。没登录时先在面板里输密码。
   接口见 src/xin.js；AI 每一步（说话、执行命令、xin 动作）都整理成事件，这里一边轮询一边画出来，同时让小芯跟着动：
   AI 在思考 → 小芯坐在电脑前挠头；在执行命令 → 敲代码；xin 命令 → 照做；做完 → 开心，失败 → 难过。
   对话列表里还有：小芯的记事本、每日任务、小芯的文件（它电脑里 /data/workspace 的文件，能预览、下载）；每个对话能改名、删除。
   回答里出现的 /data/workspace/… 路径点一下就打开那个文件。
   聊天区像聊天软件：小芯在左边（像素头像）、你在右边；它在电脑上执行的命令不显示，干活时只冒一个「正在输入」的气泡和用时；代码上色。
   标题栏的「屏幕」：全屏看小芯的电脑桌面（桌面上有个终端实时滚动它在干什么），能「观看」也能「接管」。
   设置（对话列表最下面）：新对话用哪个 AI、思考强度、做完提醒（Web Push：网页没在看时做完了发通知，
   推送从小芯的电脑直接发出，见 vm-agent.mjs 的 pushAll；通知由 /sw.js 弹出，点了打开 #xin=<对话>）。
   小芯会自己编新动作（xin move add），打开网页时拿过来教给页面上的小芯（背包「新动作」、闲着时偶尔做）；
   好感度记在它电脑上：聊天、每天来看它、喂它陪它玩会涨，越熟越听话；对话列表上面显示关系和最近的变化。 */
(function () {
  'use strict';
  var API = '/api/xin/';
  var LS_SID = 'lm.xin.sid', LS_AGENT = 'lm.xin.agent', LS_DRAFT = 'lm.xin.draft', LS_EFF = 'lm.xin.effort', LS_CTX = 'lm.xin.ctx';
  var AGENTS = { codex: 'Codex', claude: 'Claude' };
  // 思考强度：自动 = 写代码的活用最高（max），聊天用 AI 自己的默认（规则在 vm-agent.mjs 的 resolveEffort）
  var EFFORTS = { auto: '自动', high: '高', max: '最高' };
  var touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  var WORK = '/data/workspace';

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  // 现在看得见的那个小芯：打开了 STM32 学习台、小芯又被扔进去了，就是学习台里的那个
  function xin() {
    if (document.body.classList.contains('tool-open')) {
      var fs = document.querySelectorAll('iframe');
      for (var i = 0; i < fs.length; i++) {
        try { var X = fs[i].contentWindow && fs[i].contentWindow.LimingXin; if (X && X.mode !== 'away') return X; } catch (e) { /* 别的源 */ }
      }
    }
    return window.LimingXin || null;
  }
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function sleepMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var S = { enabled: false, authed: false, open: false, sid: ls(LS_SID) || '', moves: [], bond: null, agent: AGENTS[ls(LS_AGENT)] ? ls(LS_AGENT) : 'codex', sessAgent: '', effort: EFFORTS[ls(LS_EFF)] ? ls(LS_EFF) : 'auto',
    run: '', off: 0, polling: false, mine: {}, errRuns: {}, lastAct: 0, view: 'chat', machine: '', mstate: '', loadSeq: 0, drawer: false, drawerSeq: 0 };

  /* ---------- 和页面上的小芯共用机身、眼睛和引脚，避免头像仍然显示旧方眼 ---------- */
  function avatar(cls) {
    var e = h('span', 'xc-av' + (cls ? ' ' + cls : '')), x = xin();
    if (x && x.portrait) e.innerHTML = x.portrait();
    return e;
  }

  /* ---------- 请求 ---------- */
  function req(path, body) {
    var opt = body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Xin': '1' }, body: JSON.stringify(body) };
    return fetch(API + path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { d = d || {}; d._status = r.status; return d; });
    });
  }
  // 调云电脑：正在唤醒 / InstaBox 忙就等一会儿再试（最多 maxWait 毫秒），状态写在面板上
  function call(op, args, maxWait, onWait) {
    var t0 = Date.now();
    function once() {
      return req('call', { op: op, args: args || {} }).then(function (d) {
        if (d._status === 401) { S.authed = false; syncBag(); render(); throw new Error('要先登录'); }
        if (d._status !== 200) throw new Error(d.msg || d.error || ('出错了（' + d._status + '）'));
        if (d.ok) { if (op !== 'status') setStatus(''); return d.data; }
        if ((d.state === 'waking' || d.state === 'busy') && Date.now() - t0 < (maxWait || 0)) {
          if (onWait) onWait(d); else setStatus(d.msg || '唤醒中…', 'wait');   // 发消息时写在「正在输入」旁边，不再另外冒状态栏
          var x = xin(); if (x && op === 'send') x.ai('think');
          return sleepMs((d.retryAfter || 3) * 1000).then(once);
        }
        var err = new Error(d.state === 'cooldown' ? '云电脑连续跑满了时长，在冷却，大约 ' + Math.ceil((d.retryAfter || 60) / 60) + ' 分钟后再试' : (d.msg || '云电脑出错了'));
        err.state = d.state; err.retryAfter = d.retryAfter;
        throw err;
      });
    }
    return once();
  }

  /* ---------- 面板 ---------- */
  var root, list, statusEl, input, sendBtn, titleEl, sessEl, loginEl, foot, drawerEl, useEl, sheetEl, menuEl, fileEl, attsEl;
  function build() {
    root = h('section', 'xc'); root.id = 'xinChat'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', '和小芯聊天'); root.hidden = true;
    root.innerHTML =
      '<header class="xc-hd">' +
        '<button class="xc-ib xc-list-b" type="button" aria-label="对话列表"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h9"/></svg></button>' +
        '<div class="xc-ttl"><span class="xc-ttl-t"><b>小芯</b><span class="xc-sub"></span></span></div>' +
        '<button class="xc-ib xc-scr-b" type="button" aria-label="小芯的屏幕" title="看小芯的电脑屏幕"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/></svg></button>' +
        '<button class="xc-ib xc-new-b" type="button" aria-label="新对话"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>' +
        '<button class="xc-ib xc-x" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' +
      '</header>' +
      '<div class="xc-st" role="status" aria-live="polite" hidden></div>' +
      '<div class="xc-body"><div class="xc-msgs" aria-live="polite"></div></div>' +
      '<div class="xc-sess" hidden></div>' +
      // 侧边栏：对话列表、记事本 / 每日任务 / 文件、好感度、设置。从左边滑出来，盖在聊天上面
      '<div class="xc-scrim" aria-hidden="true"></div>' +
      '<aside class="xc-drawer" aria-label="对话列表"><div class="xc-dr"></div></aside>' +
      '<form class="xc-login" hidden>' +
        '<p class="xc-hint">这是站长自己用的：小芯有一台能执行命令的电脑，所以要先登录。</p>' +
        '<input type="password" name="pw" autocomplete="current-password" placeholder="密码" aria-label="密码" required>' +
        '<button type="submit" class="xc-btn">登录</button>' +
        '<p class="xc-err" role="alert"></p>' +
      '</form>' +
      // 插件：从「＋」打开，从底下升起来的一页，盖在聊天上面
      '<section class="xc-sheet" aria-label="插件" hidden></section>' +
      '<form class="xc-ft">' +
        // 「＋」点开的小菜单：发图片或文件、开关插件
        '<div class="xc-menu" role="menu" hidden>' +
          '<button type="button" class="xc-mi xc-mi-file" role="menuitem"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 7.5 9 14a2 2 0 0 0 2.8 2.8l7-7a4 4 0 0 0-5.6-5.6l-7 7a6 6 0 0 0 8.5 8.5l6-6"/></svg><span><b>图片或文件</b><i>拍照、相册、文件都行，发给小芯看</i></span></button>' +
          '<button type="button" class="xc-mi xc-mi-plug" role="menuitem"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/></svg><span><b>插件</b><i class="xc-mi-n">开关小芯的插件，关掉的不占 token</i></span></button>' +
        '</div>' +
        '<input type="file" class="xc-file" multiple hidden>' +
        '<div class="xc-atts" hidden></div>' +
        '<div class="xc-ctx" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 7.5 9 14a2 2 0 0 0 2.8 2.8l7-7a4 4 0 0 0-5.6-5.6l-7 7a6 6 0 0 0 8.5 8.5l6-6"/></svg><span></span><button type="button" aria-label="这次不带">✕</button></div>' +
        '<div class="xc-row">' +
          '<button type="button" class="xc-plus" aria-label="发图片、文件或开关插件" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>' +
          '<textarea rows="1" placeholder="和小芯说点什么…" aria-label="消息" enterkeyhint="' + (touch ? 'enter' : 'send') + '"></textarea>' +
          '<button type="submit" class="xc-send" aria-label="发送"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6 11l6-6 6 6"/></svg></button>' +
        '</div>' +
        // 这个对话的用量：上下文、消耗的 token、缓存命中率（点一下看明细）
        '<div class="xc-use" hidden></div>' +
      '</form>';
    document.body.appendChild(root);
    list = root.querySelector('.xc-msgs'); statusEl = root.querySelector('.xc-st'); input = root.querySelector('textarea');
    sendBtn = root.querySelector('.xc-send'); titleEl = root.querySelector('.xc-sub');
    root.querySelector('.xc-ttl').insertBefore(avatar(), root.querySelector('.xc-ttl-t'));
    sessEl = root.querySelector('.xc-sess'); loginEl = root.querySelector('.xc-login'); foot = root.querySelector('.xc-ft'); drawerEl = root.querySelector('.xc-dr');
    useEl = root.querySelector('.xc-use');
    sheetEl = root.querySelector('.xc-sheet'); menuEl = root.querySelector('.xc-menu'); fileEl = root.querySelector('.xc-file'); attsEl = root.querySelector('.xc-atts');
    root.querySelector('.xc-plus').addEventListener('click', function () { setMenu(menuEl.hidden); });
    root.querySelector('.xc-mi-file').addEventListener('click', function () { setMenu(false); fileEl.value = ''; fileEl.click(); });
    root.querySelector('.xc-mi-plug').addEventListener('click', function () { setMenu(false); openPlugins(); });
    fileEl.addEventListener('change', function () { addFiles(fileEl.files); fileEl.value = ''; });
    // 粘贴图片、把文件拖进面板：也当附件
    root.addEventListener('dragover', function (e) { if (e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') >= 0 && S.view === 'chat' && S.authed) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    root.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length && S.view === 'chat' && S.authed) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
    document.addEventListener('pointerdown', function (e) { if (menuEl && !menuEl.hidden && !e.target.closest('.xc-menu, .xc-plus')) setMenu(false); }, true);
    useEl.addEventListener('click', function () { S.useMore = !S.useMore; renderUsage(); });
    root.querySelector('.xc-scrim').addEventListener('click', function () { if (S.sheet) setSheet(false); else setDrawer(false); });
    root.querySelector('.xc-list-b').setAttribute('aria-expanded', 'false');
    root.querySelector('.xc-x').addEventListener('click', close);
    root.querySelector('.xc-scr-b').addEventListener('click', function () { openScreen(false); });
    root.querySelector('.xc-new-b').addEventListener('click', function () { newChat(); if (!touch) input.focus(); });
    root.querySelector('.xc-list-b').addEventListener('click', function () { setDrawer(!S.drawer); });
    loginEl.addEventListener('submit', function (e) { e.preventDefault(); login(loginEl.pw.value); });
    foot.addEventListener('submit', function (e) { e.preventDefault(); if (S.run) stop(); else send(); });
    input.value = ls(LS_DRAFT) || '';
    input.addEventListener('input', function () { grow(); ls(LS_DRAFT, input.value || null); });
    root.querySelector('.xc-row').addEventListener('click', function (e) { if (e.target === this) input.focus(); });
    input.addEventListener('focus', refreshCtx);
    input.addEventListener('paste', function (e) {
      var fs = e.clipboardData && e.clipboardData.files;
      if (fs && fs.length) { e.preventDefault(); addFiles(fs); }
    });
    root.querySelector('.xc-ctx button').addEventListener('click', function () { skipCtx(); refreshCtx(); input.focus(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); if (!S.run) send(); }
    });
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || (scrEl && !scrEl.hidden)) return;
      if (menuEl && !menuEl.hidden) { setMenu(false); return; }
      if (S.sheet) setSheet(false); else if (S.drawer) setDrawer(false); else close();
    });
    list.addEventListener('click', function (e) {
      var fp = e.target.closest('.xc-path'); if (fp) { e.preventDefault(); loadFiles(fp.getAttribute('data-path'), 'chat'); return; }
      var c = e.target.closest('.xc-copy');
      if (c) { var code = c.closest('.xc-code').querySelector('code'); copy(code ? code.textContent : '', c); }
    });
  }
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 150) + 'px'; }
  function copy(text, btn) {
    var ok = function () { btn.lastChild.textContent = '已复制'; setTimeout(function () { btn.lastChild.textContent = '复制'; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, function () {});
  }
  // 标题栏「小芯」下面那行：在忙就说在干什么，闲着就说电脑醒没醒
  function renderHead() {
    if (!titleEl) return;
    var t = '', cls = '';
    if (S.sending) { t = sendingText() + '…'; cls = 'busy'; }
    else if (S.run) { t = S.doing === 'work' ? '正在电脑上忙…' : '思考中…'; cls = 'busy'; }
    else if (S.mstate === 'running') { t = '在线'; cls = 'on'; }
    else if (S.mstate === 'suspended') t = '唤醒中…';
    else if (S.mstate === 'stopped') t = '开机中…';
    else if (S.mstate) t = S.mstate;
    titleEl.textContent = t; titleEl.className = 'xc-sub' + (cls ? ' ' + cls : '');
    var ds = drawerEl && drawerEl.querySelector('.xc-dr-st'); if (ds) { ds.textContent = t; ds.className = 'xc-dr-st' + (cls ? ' ' + cls : ''); }
  }
  function render() {
    if (!root) return;
    var login = S.enabled && !S.authed, off = !S.enabled;
    loginEl.hidden = !login;
    foot.hidden = login || off || S.view !== 'chat';
    sessEl.hidden = login || off || S.view === 'chat';
    root.querySelector('.xc-body').hidden = login || S.view !== 'chat';
    root.querySelector('.xc-list-b').hidden = root.querySelector('.xc-new-b').hidden = root.querySelector('.xc-scr-b').hidden = login || off;
    if ((login || off) && S.drawer) setDrawer(false);
    root.classList.toggle('running', !!S.run);
    sendBtn.setAttribute('aria-label', S.run ? '停止' : '发送');
    sendBtn.disabled = !S.run && attsBusy();
    sendBtn.innerHTML = S.run ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" class="fill"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';
    if (off) { list.innerHTML = ''; list.appendChild(h('p', 'xc-hint', '小芯聊天还没开（网站没配密码或 InstaBox key）。')); }
    renderHead();
  }
  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.hidden = !text; statusEl.textContent = text || ''; statusEl.className = 'xc-st' + (kind ? ' ' + kind : '');
  }

  /* ---------- 打开 / 关上 ---------- */
  function open() {
    if (!root) build();
    S.open = true; root.hidden = false; S.view = 'chat'; setDrawer(false);
    requestAnimationFrame(function () { root.classList.add('show'); });
    document.body.classList.add('xc-open');
    var x = xin(); if (x && x.home && window.innerWidth < 900) x.home();
    render(); grow(); refreshCtx();
    if (!S.enabled) return;
    if (!S.authed) { if (!touch) loginEl.pw.focus(); return; }
    if (S.histFor !== (S.sid || '') || !list.childNodes.length) loadCurrent();
    if (!touch) input.focus();
  }
  function close() {
    if (!root) return;
    S.open = false; root.classList.remove('show'); document.body.classList.remove('xc-open');
    setTimeout(function () { if (!S.open) root.hidden = true; }, 220);
    if (XIN_HASH.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  }

  /* ---------- 登录 ---------- */
  function login(pw) {
    var err = loginEl.querySelector('.xc-err'); err.textContent = '';
    req('login', { password: pw }).then(function (d) {
      if (d._status === 200) { S.authed = true; loginEl.pw.value = ''; syncBag(); render(); loadCurrent(); wakeVm(); greet(); var x = xin(); if (x) { x.cmd('happy'); x.say('你来啦！'); } return; }
      err.textContent = d.msg || (d._status === 429 ? '试太多次了，过一分钟再试' : '登录失败');
    }, function () { err.textContent = '网络不通'; });
  }
  function logout() {
    req('logout', {}).then(function () { S.authed = false; syncBag(); render(); });
  }
  function syncBag() {
    // 功能开着就放进背包：点了小芯旁边冒输入框（没登录先开面板输密码）。学习台里的小芯在 mascot.js 里调 ask
    var x = window.LimingXin; if (!x || !x.addBag) return;
    if (S.enabled) x.addBag('chat', '聊天', function () { quick(x); }); else x.removeBag('chat');
  }

  /* ---------- 对话 ---------- */
  function clearList() { list.innerHTML = ''; typingEl = null; S.lastAt = 0; S.errRuns = {}; setUsage(null); }
  /* 聊天框底下那一行：这个对话的上下文用了多少（最近一次请求 / 模型上限）、累计消耗的 token、缓存命中率（输入里有多少是缓存命中的）。
     打开对话时从 history 拿，每轮做完从 done 事件里拿；新对话还没有，不显示。点一下展开明细 */
  function setUsage(u) { S.usage = u && typeof u === 'object' && u.total ? u : null; renderUsage(); }
  function tok(n) {
    n = Math.max(0, Math.round(+n || 0));
    if (n < 1e4) return String(n);
    if (n < 1e8) { var v = n / 1e4; return (v < 100 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)) + '万'; }
    var y = n / 1e8; return (y < 100 ? y.toFixed(2).replace(/\.?0+$/, '') : Math.round(y)) + '亿';
  }
  function renderUsage() {
    if (!useEl) return;
    var u = S.usage;
    useEl.hidden = !u;
    if (!u) { useEl.innerHTML = ''; return; }
    var pct = u.win > 0 ? Math.min(100, Math.max(u.ctx > 0 ? 1 : 0, Math.round(u.ctx / u.win * 100))) : -1;
    var hit = u.input > 0 ? Math.round(u.cached / u.input * 100) : -1;
    var b = h('button', 'xc-use-b'), ctx = h('span', 'xc-use-i xc-use-ctx', '上下文 ');
    b.type = 'button'; b.setAttribute('aria-expanded', S.useMore ? 'true' : 'false'); b.title = S.useMore ? '收起明细' : '看明细';
    if (pct >= 0) {
      var bar = h('i', 'xc-use-bar' + (pct >= 90 ? ' hot' : pct >= 70 ? ' warm' : '')), fill = h('i');
      fill.style.width = pct + '%'; bar.appendChild(fill); ctx.appendChild(bar); ctx.appendChild(document.createTextNode(pct + '%'));
    } else ctx.appendChild(document.createTextNode(tok(u.ctx)));
    b.appendChild(ctx);
    b.appendChild(h('span', 'xc-use-i', '消耗 ' + tok(u.total) + ' token'));
    if (hit >= 0) b.appendChild(h('span', 'xc-use-i', '缓存命中 ' + hit + '%'));
    useEl.innerHTML = ''; useEl.appendChild(b);
    if (S.useMore) useEl.appendChild(h('div', 'xc-use-more', '上下文 ' + tok(u.ctx) + (u.win > 0 ? ' / ' + tok(u.win) : '') + ' · 输入 ' + tok(u.input) + '（缓存命中 ' + tok(u.cached) + '）· 输出 ' + tok(u.output)));
  }
  function newChat(stay) {
    stopPolling(); S.sid = ''; S.sessAgent = ''; S.run = ''; S.off = 0; ls(LS_SID, null);
    if (!stay) { S.view = 'chat'; setDrawer(false); }
    clearList(); S.histFor = ''; welcome(); render();
  }
  // 空对话：大一点的小芯和一句介绍
  function welcome() {
    var p = h('div', 'xc-hello');
    p.appendChild(avatar('big'));
    p.appendChild(h('b', 'xc-hello-t', '嗨，我是小芯'));
    p.appendChild(h('p', '', '我有一台自己的电脑，能帮你写代码、编译、跑命令。'));
    list.appendChild(p);
  }
  function loadCurrent() {
    status();
    if (S.sid) openSession(S.sid); else { clearList(); S.histFor = ''; welcome(); render(); }
  }
  function status() {
    call('status').then(function (d) {
      S.machine = d.name || ''; S.mstate = d.state || '';
      if (d.state === 'suspended' || d.state === 'stopped') { wakeVm(); setTimeout(status, 8000); }
      renderHead();
    }, function (e) { setStatus(e.message, 'bad'); });
  }
  function openSession(sid) {
    var my = ++S.loadSeq;
    // 先清掉「这一轮还在跑」：重读期间那一轮可能已经做完了，以历史里说的为准（还在跑就从那里接着取）
    stopPolling(); S.run = ''; S.off = 0; S.view = 'chat'; setDrawer(false); clearList(); render();
    list.appendChild(h('p', 'xc-hint xc-loading', '正在读取对话…'));
    call('history', { sid: sid }, 60000).then(function (d) {
      if (my !== S.loadSeq) return;
      clearList();
      S.sid = sid; S.sessAgent = d.session.agent; ls(LS_SID, sid); S.histFor = sid;
      d.runs.forEach(function (r) { r.events.forEach(function (ev) { draw(ev, true, r.run); }); });
      setUsage(d.usage);
      if (d.active) { S.run = d.active.run; S.off = d.active.off; S.t0 = Math.min(Date.now(), d.active.started || Date.now()); S.doing = 'think'; startPolling(); typing(true); var x = xin(); if (x) x.ai('think'); }
      render(); toBottom(true);
    }, function (e) {
      if (my !== S.loadSeq) return;
      clearList();
      if (/找不到/.test(e.message)) { newChat(); return; }
      list.appendChild(h('p', 'xc-hint', '读不出来：' + e.message));
    });
  }
  /* ---------- 侧边栏 ----------
     上面：小芯和好感度、「新对话」；中间：记事本 / 每日任务 / 小芯的文件三个入口，下面是最近的对话；最下面：设置（点开）、退出登录。
     点了对话或入口，侧边栏收起来；入口打开的页面左上角「← 返回」回到聊天并重新拉开侧边栏。 */
  var ICON = {
    mem: '<path d="M6 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6zM6 3v18M9 8h6M9 12h6"/>',
    daily: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9 3h6"/>',
    files: '<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>'
  };
  function svgIcon(k) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[k] + '</svg>'; }
  function setDrawer(on) {
    on = !!on;
    if (!root || S.drawer === on) { S.drawer = on; return; }
    S.drawer = on;
    root.classList.toggle('dr-open', on);
    root.querySelector('.xc-list-b').setAttribute('aria-expanded', on ? 'true' : 'false');
    root.querySelector('.xc-drawer').setAttribute('aria-hidden', on ? 'false' : 'true');
    if (on) { loadSessions(); var f = drawerEl.querySelector('.xc-dr-new'); if (f && !touch) setTimeout(function () { f.focus(); }, 60); }
  }
  // 从侧边栏打开一个页面（记事本 / 每日任务 / 文件）
  function fromDrawer(fn) { return function () { setDrawer(false); fn(); }; }
  // 页面左上角的「← 返回」：回到聊天，拉开侧边栏（从侧边栏进来的）
  function backBtn(toDrawer) {
    var b = h('button', 'xc-link xc-back', toDrawer ? '← 返回' : '← 回到对话'); b.type = 'button';
    b.addEventListener('click', function () { S.view = 'chat'; render(); if (toDrawer) setDrawer(true); });
    return b;
  }
  function loadSessions() {
    drawerEl.innerHTML = '';
    // 头：小芯 + 名字 + 好感度，右边收起
    var hd = h('div', 'xc-dr-hd'), who = h('div', 'xc-dr-who'), x = h('button', 'xc-ib xc-dr-x');
    x.type = 'button'; x.setAttribute('aria-label', '收起侧边栏'); x.innerHTML = svgIcon('x');
    x.addEventListener('click', function () { setDrawer(false); });
    who.appendChild(h('b', 'xc-dr-name', '小芯'));
    who.appendChild(h('span', 'xc-dr-st', titleEl.textContent || ''));
    hd.appendChild(avatar('dr')); hd.appendChild(who); hd.appendChild(x);
    drawerEl.appendChild(hd);
    var sc = h('div', 'xc-dr-sc');
    sc.appendChild(bondLine());
    var nb = h('button', 'xc-dr-new'); nb.type = 'button'; nb.innerHTML = svgIcon('plus') + '<span>新对话</span>';
    nb.addEventListener('click', function () { newChat(); if (!touch) input.focus(); });
    sc.appendChild(nb);
    var nav = h('nav', 'xc-nav'); nav.setAttribute('aria-label', '小芯的东西');
    var item = function (cls, icon, label, fn) {
      var b = h('button', 'xc-memb' + (cls ? ' ' + cls : '')); b.type = 'button';
      b.innerHTML = svgIcon(icon) + '<span></span>' + svgIcon('chev');
      b.querySelector('span').textContent = label; b.addEventListener('click', fromDrawer(fn)); nav.appendChild(b);
    };
    item('', 'mem', '小芯的记事本', loadMemory);
    item('xc-dailyb', 'daily', '每日任务', loadDaily);
    item('xc-filesb', 'files', '小芯的文件', function () { loadFiles(WORK, 'sess'); });
    sc.appendChild(nav);
    var dh = h('p', 'xc-dr-h', '最近的对话');
    sc.appendChild(dh);
    var ul = h('ul', 'xc-sl xc-sl-main');
    ul.appendChild(h('li', 'xc-hint xc-sl-wait', '正在读取…'));
    sc.appendChild(ul);
    // 对话多了只露最近几个，其余收在「更多对话」里，侧边栏不会越拉越长
    var fold = h('button', 'xc-dr-fold xc-more-b'); fold.type = 'button'; fold.hidden = true;
    fold.addEventListener('click', function () { S.sessAll = !S.sessAll; foldSess(); if (!S.sessAll) dh.scrollIntoView({ block: 'nearest' }); });
    sc.appendChild(fold);
    // 归档的对话：收在「已归档（N）」里，默认收着
    var ab = h('button', 'xc-dr-fold xc-arch-b'); ab.type = 'button'; ab.hidden = true;
    var aul = h('ul', 'xc-sl xc-sl-arch'); aul.hidden = true;
    ab.addEventListener('click', function () { S.archOpen = !S.archOpen; renderSess(); if (S.archOpen) ab.scrollIntoView({ block: 'nearest' }); });
    sc.appendChild(ab); sc.appendChild(aul);
    // 设置：默认收着，点开
    var setB = h('button', 'xc-dr-row xc-set-b'); setB.type = 'button'; setB.setAttribute('aria-expanded', 'false');
    setB.innerHTML = svgIcon('gear') + '<span>设置</span>' + svgIcon('chev');
    var set = settings(); set.hidden = true;
    setB.addEventListener('click', function () { set.hidden = !set.hidden; setB.setAttribute('aria-expanded', set.hidden ? 'false' : 'true'); if (!set.hidden) set.scrollIntoView({ block: 'nearest' }); });
    var ft = h('div', 'xc-dr-ft');
    ft.appendChild(setB); ft.appendChild(set);
    var out = h('button', 'xc-link xc-dr-out', '退出登录'); out.type = 'button'; out.addEventListener('click', logout);
    ft.appendChild(out);
    sc.appendChild(ft);
    drawerEl.appendChild(sc);
    var my = ++S.drawerSeq;
    call('sessions', {}, 60000).then(function (d) {
      if (my !== S.drawerSeq) return;
      S.sessList = d.sessions || [];
      renderSess();
    }, function (e) { if (my !== S.drawerSeq) return; ul.innerHTML = ''; ul.appendChild(h('li', 'xc-hint', '读不出来：' + e.message)); });
  }
  // 画对话列表：没归档的放「最近的对话」，归档的放「已归档（N）」里（默认收着）。归档 / 取消归档 / 删除以后重画
  function sessItem(s) {
    var li = h('li', 'xc-sli'), b = h('button', 'xc-si'); b.type = 'button';
    b.appendChild(h('span', 'xc-si-t', s.title || '（无标题）'));
    b.appendChild(h('span', 'xc-si-m', (AGENTS[s.agent] || s.agent) + ' · ' + s.turns + ' 轮 · ' + when(s.updated) + (s.active ? ' · 进行中' : '')));
    if (s.sid === S.sid) { b.classList.add('cur'); b.setAttribute('aria-current', 'true'); }
    b.addEventListener('click', function () { openSession(s.sid); });
    var more = h('button', 'xc-si-more'); more.type = 'button'; more.setAttribute('aria-label', '改名、归档或删除'); more.setAttribute('aria-expanded', 'false');
    more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="fill" cx="5.5" cy="12" r="1.6"/><circle class="fill" cx="12" cy="12" r="1.6"/><circle class="fill" cx="18.5" cy="12" r="1.6"/></svg>';
    more.addEventListener('click', function () { sessActions(li, s, more); });
    li.appendChild(b); li.appendChild(more);
    return li;
  }
  function renderSess() {
    var ul = drawerEl && drawerEl.querySelector('.xc-sl-main'), aul = drawerEl && drawerEl.querySelector('.xc-sl-arch'), ab = drawerEl && drawerEl.querySelector('.xc-arch-b');
    var dh = drawerEl && drawerEl.querySelector('.xc-dr-h');
    if (!ul || !aul || !ab) return;
    var list = S.sessList || [], main = list.filter(function (s) { return !s.archived; }), arch = list.filter(function (s) { return s.archived; });
    ul.innerHTML = ''; aul.innerHTML = '';
    if (!main.length) ul.appendChild(h('li', 'xc-hint', arch.length ? '没有别的对话了（归档的在下面）' : '还没有对话'));
    if (dh) dh.textContent = '最近的对话' + (main.length > SESS_SHOW ? ' · ' + main.length : '');
    main.forEach(function (s) { ul.appendChild(sessItem(s)); });
    arch.forEach(function (s) { aul.appendChild(sessItem(s)); });
    ab.hidden = !arch.length; aul.hidden = !arch.length || !S.archOpen;
    ab.setAttribute('aria-expanded', S.archOpen ? 'true' : 'false');
    ab.innerHTML = '<span></span>' + svgIcon('chev');
    ab.querySelector('span').textContent = '已归档（' + arch.length + '）';
    foldSess();
  }
  // 对话列表折起来：只露最近 SESS_SHOW 个（正在看的那个不管排第几都露着），其余点「更多对话」展开；删了一个以后重新算
  var SESS_SHOW = 5;
  function foldSess() {
    var ul = drawerEl && drawerEl.querySelector('.xc-sl-main'), fold = drawerEl && drawerEl.querySelector('.xc-more-b');
    if (!ul || !fold) return;
    var items = ul.querySelectorAll('.xc-sli'), extra = 0;
    for (var i = 0; i < items.length; i++) {
      var keep = i < SESS_SHOW || !!items[i].querySelector('.xc-si.cur');
      if (!keep) extra++;
      items[i].hidden = !keep && !S.sessAll;
    }
    fold.hidden = !extra;
    fold.setAttribute('aria-expanded', S.sessAll ? 'true' : 'false');
    fold.innerHTML = '<span></span>' + svgIcon('chev');
    fold.querySelector('span').textContent = S.sessAll ? '收起' : '更多对话（' + extra + '）';
  }
  /* ---------- 新动作、好感度 ----------
     都存在小芯的电脑上（vm-agent.mjs 的 moves / bond），打开网页时跟着 greet 一起拿过来；
     页面上可能有两个小芯（工具箱首页一个、学习台 iframe 里一个），两个都教。 */
  function allXin() {
    var out = [];
    if (window.LimingXin) out.push(window.LimingXin);
    [].forEach.call(document.querySelectorAll('iframe'), function (f) { try { var X = f.contentWindow && f.contentWindow.LimingXin; if (X) out.push(X); } catch (e) { /* 别的源 */ } });
    return out;
  }
  function setMoves(list) { S.moves = Array.isArray(list) ? list : []; allXin().forEach(function (X) { if (X.learn) X.learn(S.moves); }); }
  function setBond(b) { if (!b || typeof b.score !== 'number') return; S.bond = b; allXin().forEach(function (X) { if (X.bond) X.bond(b.level); }); refreshBond(); }
  function bondText(b) { return b.name + ' · 好感度 ' + b.score + (b.next != null ? '（再 ' + (b.next - b.score) + ' 升一级）' : ''); }
  var bondEl = null;
  function bondLine() {
    var box = h('div', 'xc-bond'), b = h('button', 'xc-bond-b'), log = h('ul', 'xc-bond-log');
    b.type = 'button'; b.setAttribute('aria-expanded', 'false'); log.hidden = true;
    b.addEventListener('click', function () { log.hidden = !log.hidden; b.setAttribute('aria-expanded', !log.hidden); });
    box.appendChild(b); box.appendChild(log); bondEl = box;
    refreshBond();
    call('bond', {}, 60000).then(setBond, function () {});
    return box;
  }
  function refreshBond() {
    if (!bondEl) return;
    var b = S.bond, btn = bondEl.firstChild, log = bondEl.lastChild;
    bondEl.hidden = !b;
    if (!b) return;
    var lv = Math.max(0, Math.min(3, b.level | 0));
    btn.textContent = '';
    btn.appendChild(h('span', 'xc-hearts', '♥♥♥♥'.slice(0, lv + 1)));
    btn.appendChild(h('span', 'xc-hearts-e', '♡♡♡'.slice(0, 3 - lv)));
    btn.appendChild(document.createTextNode(' ' + bondText(b)));
    log.innerHTML = '';
    (b.log || []).forEach(function (it) {
      var li = h('li', it.d < 0 ? 'down' : '');
      li.appendChild(h('span', 'xc-bond-d', (it.d > 0 ? '+' : '') + it.d));
      li.appendChild(h('span', '', it.why || ''));
      li.appendChild(h('span', 'xc-bond-w', when(it.at)));
      log.appendChild(li);
    });
    if (!(b.log || []).length) log.appendChild(h('li', 'xc-hint', '还没有变化。多陪它聊聊、喂喂它，每天来看看它～'));
  }
  // 你在网页上喂它、陪它玩（mascot.js 告诉这里）：一分钟最多报一次，小芯电脑那边一天最多 +3
  var playedAt = 0;
  function played(kind) {
    if (!S.enabled || !S.authed || Date.now() - playedAt < 60000) return;
    playedAt = Date.now();
    call('bond_play', { kind: kind }, 0).then(function (r) { if (r && r.info) setBond(r.info); }, function () {});
  }

  /* ---------- 小芯的屏幕：全屏看它的电脑桌面，也能接管 ----------
     Worker 的 screen：开桌面、在桌面上开一个终端实时滚动它在干什么、要一个短时链接（InstaBox 的桌面查看页），嵌在 iframe 里。
     「观看」时服务器丢掉你的键盘鼠标；「接管」换一个能操作的链接；关掉时接管过的话把链接全部作废（screen_off）。 */
  var scrEl = null, scrUsedCtl = false, scrSeq = 0;
  function buildScreen() {
    scrEl = h('div', 'xs'); scrEl.setAttribute('role', 'dialog'); scrEl.setAttribute('aria-label', '小芯的屏幕'); scrEl.hidden = true;
    scrEl.innerHTML =
      '<header class="xs-hd">' +
        '<button class="xc-ib xs-x" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' +
        '<b class="xs-t">小芯的屏幕</b>' +
        '<div class="xc-segs xs-mode" role="radiogroup" aria-label="模式">' +
          '<button class="xc-ag" type="button" role="radio" data-mode="view">观看</button>' +
          '<button class="xc-ag" type="button" role="radio" data-mode="ctl">接管</button>' +
        '</div>' +
      '</header>' +
      '<p class="xs-tip"></p>' +
      '<div class="xs-body"><p class="xs-msg"></p><iframe class="xs-fr" title="小芯的电脑桌面" allow="clipboard-read; clipboard-write; fullscreen" referrerpolicy="no-referrer" hidden></iframe></div>';
    document.body.appendChild(scrEl);
    scrEl.querySelector('.xs-x').addEventListener('click', closeScreen);
    [].forEach.call(scrEl.querySelectorAll('.xs-mode .xc-ag'), function (b) {
      b.addEventListener('click', function () { var ctl = b.getAttribute('data-mode') === 'ctl'; if (ctl !== scrEl._ctl) loadScreen(ctl); });
    });
    scrEl.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeScreen(); });
  }
  function openScreen(control) {
    if (!S.enabled || !S.authed) return;
    if (!scrEl) buildScreen();
    scrEl.hidden = false; document.body.classList.add('xs-open');
    loadScreen(!!control);
    try { scrEl.querySelector('.xs-x').focus({ preventScroll: true }); } catch (e) { /* 老浏览器 */ }
  }
  function loadScreen(control) {
    var my = ++scrSeq, fr = scrEl.querySelector('.xs-fr'), msg = scrEl.querySelector('.xs-msg');
    scrEl._ctl = control; if (control) scrUsedCtl = true;
    scrEl.classList.toggle('ctl', control);
    [].forEach.call(scrEl.querySelectorAll('.xs-mode .xc-ag'), function (b) { b.setAttribute('aria-checked', (b.getAttribute('data-mode') === 'ctl') === control ? 'true' : 'false'); });
    scrEl.querySelector('.xs-tip').textContent = control ? '接管中：你的鼠标、键盘会直接操作小芯的电脑。用完点「观看」或关掉。' : '只看不动：中间那个终端实时显示小芯在干什么。想自己动手，点「接管」。';
    fr.hidden = true; fr.src = 'about:blank';
    msg.hidden = false; msg.textContent = '正在打开小芯的屏幕…（电脑在睡觉的话要等一会儿）';
    call('screen', { control: control }, 90000).then(function (d) {
      if (my !== scrSeq || scrEl.hidden) return;
      fr.src = d.url; fr.hidden = false; msg.hidden = true;
    }, function (e) { if (my === scrSeq) msg.textContent = '打不开：' + e.message; });
  }
  function closeScreen() {
    if (!scrEl || scrEl.hidden) return;
    scrSeq++;
    scrEl.hidden = true; document.body.classList.remove('xs-open');
    var fr = scrEl.querySelector('.xs-fr'); fr.src = 'about:blank'; fr.hidden = true;
    if (scrUsedCtl) { scrUsedCtl = false; call('screen_off', {}, 20000).catch(function () {}); }   // 接管过：能操作的链接全部作废
    if (root && S.open && !touch) root.querySelector('.xc-scr-b').focus();
  }

  /* ---------- 设置：新对话用哪个 AI、思考强度、做完提醒 ---------- */
  function toggleRow(cls, title, desc) {
    var row = h('div', 'xc-tg ' + cls), txt = h('div', 'xc-tg-t'), b = h('button', 'xc-sw'), note = h('p', 'xc-tg-n');
    txt.appendChild(h('b', '', title)); txt.appendChild(h('span', '', desc));
    b.type = 'button'; b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', 'false'); b.setAttribute('aria-label', title);
    row.appendChild(txt); row.appendChild(b); row.appendChild(note);
    return { row: row, btn: b, set: function (on) { b.setAttribute('aria-checked', on ? 'true' : 'false'); }, note: function (t) { note.textContent = t || ''; } };
  }
  // 一排选项（单选）：新对话用哪个 AI、思考强度
  function segRow(cls, title, desc, opts, cur, key, onPick) {
    var row = h('div', 'xc-tg ' + cls), txt = h('div', 'xc-tg-t'), seg = h('div', 'xc-segs');
    txt.appendChild(h('b', '', title)); txt.appendChild(h('span', '', desc));
    seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', title);
    Object.keys(opts).forEach(function (k) {
      var b = h('button', 'xc-ag', opts[k]); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset[key] = k;
      b.setAttribute('aria-checked', k === cur ? 'true' : 'false');
      b.addEventListener('click', function () {
        [].forEach.call(seg.children, function (x) { x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
        onPick(k);
      });
      seg.appendChild(b);
    });
    row.appendChild(txt); row.appendChild(seg);
    return row;
  }
  function settings() {
    var box = h('div', 'xc-set');
    box.appendChild(h('p', 'xc-set-h', '设置'));
    box.appendChild(segRow('xc-agent', '新对话用', '已经开始的对话不会换', AGENTS, S.agent, 'agent', function (k) { S.agent = k; ls(LS_AGENT, k); }));
    box.appendChild(segRow('xc-effort', '思考强度', '自动：写代码、编译、调试时用最高', EFFORTS, S.effort, 'effort', function (k) { S.effort = k; ls(LS_EFF, k); }));
    // 附带：发消息时带上学习台里正在看的页面、选中的文字、写的代码。关掉就都不带（记在这个浏览器里）
    var ctx = toggleRow('xc-ctxauto', '附带正在看的页面', '发消息时带上学习台里正在看的页面、选中的文字和你写的代码；关掉就都不带');
    ctx.set(ls(LS_CTX) !== '0');
    ctx.btn.addEventListener('click', function () { var on = ls(LS_CTX) === '0'; ls(LS_CTX, on ? null : '0'); ctx.set(on); S.ctxSkip = null; refreshCtx(); });
    box.appendChild(ctx.row);
    var push = toggleRow('xc-push', '做完提醒', '关掉网页或切到别的应用时，小芯做完了发一条通知');
    box.appendChild(push.row);
    pushSetup(push);
    return box;
  }

  /* ---------- 做完提醒：Web Push ----------
     开关在设置里。打开时浏览器订阅推送（公钥来自小芯的电脑），订阅交给小芯的电脑保存；之后它做完一轮、而网页没在看时，直接从它的电脑发推送。
     iPhone / iPad 要先把网站「添加到主屏幕」，从主屏幕打开才能开（Safari 的规定）。打开以后发一条试试。 */
  function pushNoSupport() {
    if ('serviceWorker' in navigator && window.PushManager && window.Notification) return '';
    var ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var app = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    return ios && !app ? 'iPhone / iPad 上要先在 Safari 里点「分享 → 添加到主屏幕」，从主屏幕打开工具箱，再来这里打开。' : '这个浏览器收不了通知。';
  }
  function u8(b64) {
    var s = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(b64).length + 3) % 4)), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function b64of(buf) { var s = '', a = new Uint8Array(buf || []); for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function swReady() { return navigator.serviceWorker.register('/sw.js').then(function () { return navigator.serviceWorker.ready; }); }
  function pushSetup(t) {
    var no = pushNoSupport();
    if (no) { t.btn.disabled = true; t.note(no); return; }
    if (Notification.permission === 'denied') t.note('通知被拒绝了：到浏览器（或系统）设置里允许这个网站发通知，再回来打开。');
    var reg = null, key = '', busy = false;
    // 先把 Service Worker 和公钥准备好：iPhone 要求点开关那一下直接订阅，中间不能再等别的
    swReady().then(function (r) { reg = r; return call('push_key', {}, 60000); }).then(function (d) {
      key = d.key;
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      // 公钥换过了（小芯电脑上的钥匙重新生成）：旧订阅作废
      if (sub && sub.options && sub.options.applicationServerKey && b64of(sub.options.applicationServerKey) !== key) return sub.unsubscribe().then(function () { return null; });
      return sub;
    }).then(function (sub) {
      t.set(!!sub);
      if (sub) call('push_sub', { sub: sub.toJSON(), ua: navigator.userAgent.slice(0, 160) }, 60000).catch(function () {});   // 让小芯那边也记着（它可能删过）
    }).catch(function (e) { t.note('做完提醒准备不好：' + e.message); });
    t.btn.addEventListener('click', function () {
      if (busy) return;
      if (!reg || !key) { t.note('还在准备，过一两秒再点'); return; }
      busy = true; t.note('');
      var on = t.btn.getAttribute('aria-checked') !== 'true';
      var p = on ? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(key) }).then(function (sub) {
        return call('push_sub', { sub: sub.toJSON(), ua: navigator.userAgent.slice(0, 160) }, 60000);
      }).then(function () {
        t.set(true); t.note('开好了，发了一条试试');
        return call('push_test', {}, 60000).then(function (r) { if (!r.ok) t.note('开好了，但试的那条没发出去：' + JSON.stringify(r.results || []).slice(0, 120)); });
      }) : reg.pushManager.getSubscription().then(function (sub) {
        if (!sub) return null;
        var ep = sub.endpoint;
        return sub.unsubscribe().then(function () { return call('push_unsub', { endpoint: ep }, 60000).catch(function () {}); });
      }).then(function () { t.set(false); t.note('关了'); });
      p.catch(function (e) {
        var denied = e && (e.name === 'NotAllowedError' || Notification.permission === 'denied');
        t.note(denied ? '没有允许通知：到浏览器（或系统）设置里允许这个网站发通知，再回来打开。' : '没弄好：' + e.message);
      }).then(function () { busy = false; });
    });
  }
  // 点通知：sw.js 让已经开着的网页打开那段对话
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type !== 'xin-open' || !S.enabled) return;
    if (d.sid && /^s[0-9a-z]{6,24}$/.test(d.sid) && d.sid !== S.sid) { S.sid = d.sid; ls(LS_SID, d.sid); S.histFor = ''; }
    open();
  });

  /* ---------- 对话改名 / 删除：点对话后面的 ⋯ ---------- */
  function sessActions(li, s, more) {
    var old = li.querySelector('.xc-sa');
    [].forEach.call(drawerEl.querySelectorAll('.xc-sa'), function (x) { x.remove(); });
    [].forEach.call(drawerEl.querySelectorAll('.xc-si-more'), function (x) { x.setAttribute('aria-expanded', 'false'); });
    if (old) return;                       // 再点一次 ⋯ 就收起
    more.setAttribute('aria-expanded', 'true');
    var row = h('div', 'xc-sa'), inp = h('input'), ren = h('button', 'xc-sa-b', '改名'), del = h('button', 'xc-sa-b xc-sa-del', '删除'), msg = h('p', 'xc-sa-m');
    var arc = h('button', 'xc-sa-b xc-sa-arc', s.archived ? '取消归档' : '归档');
    inp.type = 'text'; inp.value = s.title || ''; inp.maxLength = 60; inp.setAttribute('aria-label', '对话的名字'); inp.setAttribute('enterkeyhint', 'done');
    ren.type = del.type = arc.type = 'button';
    // 归档：收进「已归档」，记录都留着；取消归档放回「最近的对话」
    arc.addEventListener('click', function () {
      arc.disabled = true; msg.textContent = '';
      call('archive', { sid: s.sid, on: !s.archived }, 60000).then(function (r) {
        if (r && r.error) throw new Error(r.msg || r.error);
        s.archived = !s.archived; renderSess();
      }).catch(function (e) { arc.disabled = false; msg.textContent = '没归档成：' + e.message; });
    });
    var rename = function () {
      var t = inp.value.replace(/\s+/g, ' ').trim();
      if (!t) { inp.focus(); return; }
      ren.disabled = true; msg.textContent = '';
      call('rename', { sid: s.sid, title: t }, 60000).then(function (r) {
        if (r && r.error) throw new Error(r.msg || r.error);
        s.title = t; li.querySelector('.xc-si-t').textContent = t;
        row.remove(); more.setAttribute('aria-expanded', 'false');
      }).catch(function (e) { ren.disabled = false; msg.textContent = '没改成：' + e.message; });
    };
    ren.addEventListener('click', rename);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); rename(); } });
    // 删除要点两下：第一下变成「确定删除？」，4 秒内再点才删
    var armed = 0;
    del.addEventListener('click', function () {
      if (Date.now() - armed > 4000) {
        armed = Date.now(); del.textContent = '确定删除？'; del.classList.add('armed');
        setTimeout(function () { if (Date.now() - armed >= 4000) { del.textContent = '删除'; del.classList.remove('armed'); } }, 4100);
        return;
      }
      del.disabled = true; msg.textContent = '';
      call('forget', { sid: s.sid }, 60000).then(function (r) {
        if (r && r.error) throw new Error(r.msg || r.error);
        S.sessList = (S.sessList || []).filter(function (x) { return x !== s; });
        if (s.sid === S.sid) newChat(true);
        renderSess();
      }).catch(function (e) { del.disabled = false; armed = 0; del.textContent = '删除'; del.classList.remove('armed'); msg.textContent = '没删掉：' + e.message; });
    });
    row.appendChild(inp); row.appendChild(ren); row.appendChild(arc); row.appendChild(del); row.appendChild(msg);
    li.appendChild(row);
    if (!touch) inp.focus();
  }

  /* ---------- 小芯的文件：它电脑里工作目录（/data/workspace）的文件，能预览、能下载 ---------- */
  var FILE_ICON = {
    dir: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>'
  };
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function loadFiles(p, from) {
    if (from) S.filesFrom = from;
    S.view = 'files'; render();
    var my = ++S.loadSeq;
    sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '正在读取…'));
    call('files', { path: p || WORK }, 60000).then(function (d) {
      if (my !== S.loadSeq) return;
      sessEl.innerHTML = '';
      sessEl.appendChild(backBtn(S.filesFrom !== 'chat'));
      if (d.error) {
        sessEl.appendChild(h('p', 'xc-hint', d.msg || d.error));
        var home = h('button', 'xc-link xc-inl', '去工作目录'); home.type = 'button';
        home.addEventListener('click', function () { loadFiles(WORK); });
        sessEl.appendChild(home);
        return;
      }
      sessEl.appendChild(crumbs(d.path, d.work || WORK));
      if (d.dir) drawDir(d); else drawFile(d);
    }, function (e) {
      if (my !== S.loadSeq) return;
      sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '读不出来：' + e.message));
    });
  }
  // 面包屑：工作目录 › blink › build（每一段都能点）
  function crumbs(p, work) {
    var nav = h('nav', 'xc-crumbs'); nav.setAttribute('aria-label', '位置');
    var segs = p.length > work.length ? p.slice(work.length + 1).split('/') : [];
    var add = function (label, target, last) {
      if (last) { nav.appendChild(h('b', '', label)); return; }
      var b = h('button', 'xc-crumb', label); b.type = 'button';
      b.addEventListener('click', function () { loadFiles(target); });
      nav.appendChild(b); nav.appendChild(h('span', 'xc-crumb-s', '›'));
    };
    add('工作目录', work, !segs.length);
    segs.forEach(function (seg, i) { add(seg, work + '/' + segs.slice(0, i + 1).join('/'), i === segs.length - 1); });
    return nav;
  }
  function drawDir(d) {
    if (d.path === (d.work || WORK)) sessEl.appendChild(h('p', 'xc-hint', '小芯电脑里的工作目录：它写的代码、编译出来的 .hex 都放在这里。点文件能预览、下载。'));
    var ul = h('ul', 'xc-fl');
    if (!d.entries.length) ul.appendChild(h('li', 'xc-hint', d.path === (d.work || WORK) ? '还没有文件。让小芯写个程序编译一下，做好的东西会放在这里。' : '这个文件夹是空的'));
    d.entries.forEach(function (it) {
      var li = h('li'), b = h('button', 'xc-fi' + (it.dir ? ' dir' : '')); b.type = 'button';
      b.innerHTML = it.dir ? FILE_ICON.dir : FILE_ICON.file;
      b.appendChild(h('span', 'xc-fi-n', it.name));
      b.appendChild(h('span', 'xc-fi-m', it.dir ? when(it.mtime) : fmtSize(it.size) + ' · ' + when(it.mtime)));
      b.addEventListener('click', function () { loadFiles(d.path + '/' + it.name); });
      li.appendChild(b); ul.appendChild(li);
    });
    sessEl.appendChild(ul);
    if (d.more) sessEl.appendChild(h('p', 'xc-hint', '还有 ' + d.more + ' 个没列出来'));
  }
  function drawFile(d) {
    var name = d.path.split('/').pop();
    sessEl.appendChild(h('p', 'xc-fmeta', fmtSize(d.size) + ' · ' + when(d.mtime)));
    var row = h('div', 'xc-memrow'), dl = h('button', 'xc-btn', '下载'), cp = h('button', 'xc-btn xc-btn2', '复制路径'), msg = h('span', 'xc-hint', '');
    dl.type = cp.type = 'button';
    dl.addEventListener('click', function () { download(d.path, name, dl, msg); });
    cp.addEventListener('click', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(d.path).then(function () { msg.textContent = '复制好了'; }, function () { msg.textContent = d.path; });
      else msg.textContent = d.path;
    });
    row.appendChild(dl); row.appendChild(cp); row.appendChild(msg); sessEl.appendChild(row);
    if (typeof d.text === 'string') {
      var pre = h('pre', 'xc-pre'), c = h('code');
      // 按扩展名上色（Makefile 没有扩展名）；太长的就不上色了
      var ext = /^makefile$/i.test(name) ? 'make' : (name.indexOf('.') > 0 ? name.split('.').pop() : '');
      if (d.text.length < 150000) c.innerHTML = hl(d.text, ext); else c.textContent = d.text;
      pre.appendChild(c); sessEl.appendChild(pre);
    } else sessEl.appendChild(h('p', 'xc-hint', d.big ? '文件太大，这里不预览，可以下载下来看。' : '这不是文字文件（比如 .bin、.elf），不能预览，可以下载。'));
  }
  // 下载：先取成 Blob 再存（出错时能在这里说清楚，而不是下载一个报错的网页）；电脑在睡就等它醒
  function download(p, name, btn, msg) {
    var t0 = Date.now();
    btn.disabled = true; msg.textContent = '正在下载…';
    (function once() {
      fetch(API + 'file?path=' + encodeURIComponent(p), { credentials: 'same-origin' }).then(function (r) {
        if (r.ok && (r.headers.get('content-type') || '').indexOf('application/json') < 0) {
          return r.blob().then(function (b) {
            var u = URL.createObjectURL(b), a = document.createElement('a');
            a.href = u; a.download = name; a.hidden = true; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
            btn.disabled = false; msg.textContent = '下载好了（' + fmtSize(b.size) + '）';
          });
        }
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.status === 401) { S.authed = false; syncBag(); render(); throw new Error('要先登录'); }
          if (r.status === 503 && (d.state === 'waking' || d.state === 'busy') && Date.now() - t0 < 60000) {
            msg.textContent = d.msg || '唤醒中…'; setTimeout(once, (d.retryAfter || 3) * 1000); return;
          }
          throw new Error(d.msg || ('出错了（' + r.status + '）'));
        });
      }).catch(function (e) { btn.disabled = false; msg.textContent = '没下载下来：' + e.message; });
    })();
  }

  /* ---------- 小芯的记事本：它的长期记忆，能看能改 ---------- */
  /* ---------- 每日任务：网站后台每天定时叫醒小芯的电脑，让它按这份清单做一遍 ---------- */
  function loadDaily() {
    S.view = 'daily'; render();
    sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '正在读取…'));
    call('daily_get', {}, 60000).then(function (d) {
      sessEl.innerHTML = '';
      sessEl.appendChild(backBtn(true));
      sessEl.appendChild(h('p', 'xc-hint', '每天北京时间 9:10 小芯会按这份清单做一遍（8:55 先叫醒它的电脑，网关 9:00 会自己签到）；没做成的话 21:10 再来一次。做完的结果，下次你打开网页时它会告诉你。一条一行，写清楚要做什么、怎么算做成了；也可以在聊天里跟它说「每天帮我……」，它会自己写进来。'));
      if (d.last && d.last.date) {
        var st = h('p', 'xc-dailyst'), lk = h('button', 'xc-link xc-inl', '看看'); lk.type = 'button';
        st.appendChild(document.createTextNode('最近一次：' + d.last.date.slice(5) + ' ' + (d.last.ok === null ? '正在做…' : d.last.ok ? '做完了' : '没做成') + '　'));
        lk.addEventListener('click', function () { openSession(d.last.sid); });
        st.appendChild(lk); sessEl.appendChild(st);
      }
      var ta = h('textarea', 'xc-memt'); ta.value = d.text || ''; ta.placeholder = '比如：\n- 看看网关今天签到成没成，没成就补签，记下积分和连签天数'; ta.setAttribute('aria-label', '每日任务清单');
      sessEl.appendChild(ta);
      var row = h('div', 'xc-memrow'), save = h('button', 'xc-btn', '保存'), now = h('button', 'xc-btn xc-btn2', '现在就做一遍'), msg = h('span', 'xc-hint', '');
      save.type = now.type = 'button';
      var saveIt = function () { return call('daily_set', { text: ta.value }, 60000); };
      save.addEventListener('click', function () {
        save.disabled = true; msg.textContent = '正在保存…';
        saveIt().then(function () { msg.textContent = '存好了'; save.disabled = false; }, function (e) { msg.textContent = '没存上：' + e.message; save.disabled = false; });
      });
      now.addEventListener('click', function () {
        if (!ta.value.trim()) { msg.textContent = '清单是空的'; return; }
        now.disabled = true; msg.textContent = '正在开始…';
        saveIt().then(function () { return call('daily', { force: true }, 90000); }).then(function (r) {
          now.disabled = false;
          if (r.sid) { openSession(r.sid); var x = xin(); if (x) x.ai('think'); } else msg.textContent = r.skipped === 'running' ? '正在做着呢' : '没开始：' + (r.msg || r.skipped || '');
        }, function (e) { now.disabled = false; msg.textContent = '没开始：' + e.message; });
      });
      row.appendChild(save); row.appendChild(now); row.appendChild(msg); sessEl.appendChild(row);
    }, function (e) { sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '读不出来：' + e.message)); });
  }
  function loadMemory() {
    S.view = 'mem'; render();
    sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '正在读取…'));
    call('memory', {}, 60000).then(function (d) {
      sessEl.innerHTML = '';
      sessEl.appendChild(backBtn(true));
      sessEl.appendChild(h('p', 'xc-hint', '小芯每次聊天都会看这本记事本，聊天时了解到值得记住的事会自己记一笔，乱了也会自己整理。你可以直接改，或者在聊天里说「记住……」「忘掉……」。'));
      var ta = h('textarea', 'xc-memt'); ta.value = d.text || ''; ta.placeholder = '还是空的'; ta.setAttribute('aria-label', '小芯的记事本');
      sessEl.appendChild(ta);
      var row = h('div', 'xc-memrow'), save = h('button', 'xc-btn', '保存'), msg = h('span', 'xc-hint', '');
      save.type = 'button';
      save.addEventListener('click', function () {
        save.disabled = true; msg.textContent = '正在保存…';
        call('memory_set', { text: ta.value }, 60000).then(function () { msg.textContent = '存好了'; save.disabled = false; var x = xin(); if (x) x.say('记事本改好啦', 2500); },
          function (e) { msg.textContent = '没存上：' + e.message; save.disabled = false; });
      });
      row.appendChild(save); row.appendChild(msg); sessEl.appendChild(row);
    }, function (e) { sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '读不出来：' + e.message)); });
  }
  function when(t) {
    var d = new Date(t), now = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    var hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  /* ---------- 「＋」菜单、插件 ---------- */
  function setMenu(on) {
    if (!menuEl) return;
    menuEl.hidden = !on;
    root.querySelector('.xc-plus').setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) { var n = menuEl.querySelector('.xc-mi-n'), p = S.plugins; if (p && p.length) n.textContent = p.filter(function (x) { return x.on; }).length + ' / ' + p.length + ' 个开着 · 关掉的不占 token'; }
  }
  function setSheet(on) {
    S.sheet = !!on; sheetEl.hidden = !on;
    root.classList.toggle('sheet-open', !!on);
  }
  // 插件：Codex 的 MCP 服务器。开关记在小芯电脑上，从下一句开始生效（每一句都重新起一次 AI）
  var PLUG_NAME = { rea: 'REA 逆向', instabox: 'InstaBox', 'open-computer-use': '操作桌面' };
  function openPlugins() {
    sheetEl.innerHTML = '';
    var hd = h('div', 'xc-sh-hd'), x = h('button', 'xc-ib xc-sh-x');
    x.type = 'button'; x.setAttribute('aria-label', '关掉'); x.innerHTML = svgIcon('x');
    x.addEventListener('click', function () { setSheet(false); });
    hd.appendChild(h('b', '', '插件')); hd.appendChild(x);
    sheetEl.appendChild(hd);
    var note = h('p', 'xc-sh-note', '插件是小芯的额外工具。开着的每说一句都要把它的说明书带上，很费 token；用不上就关掉，要用的时候再打开。改了从下一句开始生效。');
    if (S.sessAgent === 'claude') note.textContent += '（插件只管 Codex 的对话，现在这个对话用的是 Claude。）';
    sheetEl.appendChild(note);
    var box = h('div', 'xc-sh-list'); box.appendChild(h('p', 'xc-hint', '正在读取…'));
    sheetEl.appendChild(box);
    setSheet(true);
    call('plugins', {}, 60000).then(function (d) {
      if (d && d.error) throw new Error(d.msg || d.error);
      S.plugins = d.plugins || [];
      box.innerHTML = '';
      if (!S.plugins.length) { box.appendChild(h('p', 'xc-hint', '还没有装插件。')); return; }
      S.plugins.forEach(function (p) {
        var t = toggleRow('xc-plug-' + p.name, PLUG_NAME[p.name] || p.name, (p.desc ? p.desc + ' · ' : '') + p.name);
        t.set(p.on); t.row.dataset.name = p.name;
        t.btn.addEventListener('click', function () {
          var want = !p.on; t.btn.disabled = true; t.note('');
          call('plugin_set', { name: p.name, on: want }, 60000).then(function (r) {
            if (r && r.error) throw new Error(r.msg || r.error);
            p.on = r.on; t.set(p.on); t.btn.disabled = false;
            t.note(p.on ? '开了，下一句开始带上它' : '关了，下一句开始不带');
          }).catch(function (e) { t.btn.disabled = false; t.note('没改成：' + e.message); });
        });
        box.appendChild(t.row);
      });
    }).catch(function (e) { box.innerHTML = ''; box.appendChild(h('p', 'xc-hint', '读不出来：' + e.message)); });
  }

  /* ---------- 发图片和文件 ----------
     选好马上传到小芯的电脑（/api/xin/upload → 它工作目录的 uploads/日期/），输入框上面一排显示，能去掉；
     传完了才能发。图片太大先在手机上压一下（长边 2048、JPEG），省流量也省 token。一次最多 10 个、每个 30 MB 以内。 */
  var ATT_MAX = 10, ATT_SIZE = 30 * 1024 * 1024, attSeq = 0;
  function attsBusy() { return (S.atts || []).some(function (a) { return a.state === 'up'; }); }
  function addFiles(fl) {
    S.atts = S.atts || [];
    var arr = [].slice.call(fl || []);
    if (!arr.length) return;
    setMenu(false);
    var room = ATT_MAX - S.atts.length;
    if (arr.length > room) { setStatus('一次最多发 ' + ATT_MAX + ' 个文件', 'bad'); setTimeout(function () { setStatus(''); }, 3000); arr = arr.slice(0, Math.max(0, room)); }
    arr.forEach(function (f) {
      var img = /^image\/(png|jpeg|gif|webp|heic|heif)$/i.test(f.type || '');
      var a = { id: ++attSeq, name: f.name || (img ? 'image.jpg' : 'file'), size: f.size, image: img, blob: f, state: 'up', pct: 0 };
      if (img) { try { a.url = URL.createObjectURL(f); } catch (e) { /* 没有预览也能传 */ } }
      S.atts.push(a);
      if (f.size > ATT_SIZE) { a.state = 'err'; a.err = '太大了（最大 30 MB）'; return; }
      (img ? shrink(f) : Promise.resolve(null)).then(function (b) {
        if (b) { a.blob = b; a.size = b.size; a.name = a.name.replace(/\.[^.]*$/, '') + '.jpg'; }
        if (S.atts.indexOf(a) >= 0) upload(a, 0);
      });
    });
    renderAtts(); render();
    if (!touch) input.focus();
  }
  function shrink(f) {
    return new Promise(function (ok) {
      if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type) || !window.createImageBitmap) { ok(null); return; }
      createImageBitmap(f).then(function (bm) {
        var k = Math.min(1, 2048 / Math.max(bm.width, bm.height));
        if (k === 1 && f.size < 1.5e6 && /jpeg|png|webp/i.test(f.type)) { ok(null); return; }
        var c = document.createElement('canvas'); c.width = Math.round(bm.width * k); c.height = Math.round(bm.height * k);
        var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bm, 0, 0, c.width, c.height);
        c.toBlob(function (b) { ok(b && (b.size < f.size || /heic|heif/i.test(f.type)) ? b : null); }, 'image/jpeg', 0.86);
      }).catch(function () { ok(null); });
    });
  }
  function upload(a, tries) {
    var x = new XMLHttpRequest(); a.xhr = x;
    x.open('POST', '/api/xin/upload?name=' + encodeURIComponent(a.name));
    x.setRequestHeader('x-xin', '1'); x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = function (e) { if (e.lengthComputable) { a.pct = Math.round(e.loaded / e.total * 100); renderAtt(a); } };
    x.onload = function () {
      var d = null; try { d = JSON.parse(x.responseText); } catch (e) { /* 不是 JSON */ }
      if (S.atts.indexOf(a) < 0) return;
      if (x.status === 200 && d && d.ok && d.data) { a.state = 'ok'; a.path = d.data.path; a.name = d.data.name; a.image = !!d.data.image; a.note = ''; }
      else if (d && d.state === 'waking' && tries < 30) { a.note = '唤醒中'; renderAtt(a); setTimeout(function () { if (S.atts.indexOf(a) >= 0) upload(a, tries + 1); }, 3000); return; }
      else { a.state = 'err'; a.err = (d && (d.msg || d.error)) || ('没传上去（' + x.status + '）'); }
      renderAtts(); render();
    };
    x.onerror = function () { if (S.atts.indexOf(a) < 0) return; a.state = 'err'; a.err = '网络断了'; renderAtts(); render(); };
    x.send(a.blob);
  }
  function removeAtt(a) {
    if (a.xhr && a.state === 'up') { try { a.xhr.abort(); } catch (e) { /* 已经完了 */ } }
    S.atts = (S.atts || []).filter(function (b) { return b !== a; });
    renderAtts(); render();
  }
  function attLine(a) { return a.state === 'err' ? a.err : a.state === 'up' ? (a.note || ('上传中 ' + (a.pct || 0) + '%')) : fmtSize(a.size); }
  function renderAtt(a) {
    var e = attsEl && attsEl.querySelector('[data-att="' + a.id + '"]');
    if (!e) return;
    e.className = 'xc-att' + (a.image ? ' img' : '') + ' ' + a.state;
    var m = e.querySelector('.xc-att-m'); if (m) m.textContent = attLine(a);
    var bar = e.querySelector('.xc-att-bar i'); if (bar) bar.style.width = (a.state === 'up' ? a.pct || 0 : 100) + '%';
  }
  function renderAtts() {
    if (!attsEl) return;
    var l = S.atts || [];
    attsEl.hidden = !l.length; attsEl.innerHTML = '';
    l.forEach(function (a) {
      var e = h('div', ''); e.dataset.att = a.id;
      if (a.image && a.url) { var im = h('img', 'xc-att-p'); im.src = a.url; im.alt = ''; e.appendChild(im); }
      else e.appendChild(h('span', 'xc-att-ic', ''));
      if (!(a.image && a.url)) e.querySelector('.xc-att-ic').innerHTML = FILE_ICON.file;
      var t = h('span', 'xc-att-t'); t.appendChild(h('b', '', a.name)); t.appendChild(h('i', 'xc-att-m', '')); e.appendChild(t);
      var bar = h('span', 'xc-att-bar'); bar.appendChild(h('i')); e.appendChild(bar);
      var x = h('button', 'xc-att-x'); x.type = 'button'; x.setAttribute('aria-label', '去掉 ' + a.name); x.innerHTML = svgIcon('x');
      x.addEventListener('click', function () { removeAtt(a); });
      e.appendChild(x);
      attsEl.appendChild(e); renderAtt(a);
    });
  }
  // 消息里的附件：图片显示缩略图（点开看大图），别的文件一个小卡片（点开在「小芯的文件」里预览、下载）
  function fileUrl(p, img) { return '/api/xin/file?' + (img ? 'img=1&' : '') + 'path=' + encodeURIComponent(p); }
  function msgFiles(files) {
    var box = h('div', 'xc-mfiles');
    files.forEach(function (f) {
      if (f.image) {
        var a = h('a', 'xc-mimg'); a.href = fileUrl(f.path, true); a.target = '_blank'; a.rel = 'noopener';
        var im = h('img'); im.src = f.url || fileUrl(f.path, true); im.alt = f.name; im.loading = 'lazy';
        a.appendChild(im); box.appendChild(a);
      } else {
        var b = h('button', 'xc-mfile'); b.type = 'button';
        b.innerHTML = FILE_ICON.file; b.appendChild(h('span', '', f.name)); if (f.size != null) b.appendChild(h('i', '', fmtSize(f.size)));
        b.addEventListener('click', function () { loadFiles(f.path, 'chat'); });
        box.appendChild(b);
      }
    });
    return box;
  }

  /* ---------- 发消息 ---------- */
  function send(given) {
    var text = given != null ? String(given).trim() : input.value.trim();
    var atts = given != null ? [] : (S.atts || []).filter(function (a) { return a.state === 'ok'; });
    if ((!text && !atts.length) || S.run || S.sending) return false;
    if (given == null && attsBusy()) { setStatus('文件还没传完，传完再发', 'wait'); setTimeout(function () { setStatus(''); }, 2500); return false; }
    S.sending = true;
    if (list.querySelector('.xc-hello')) clearList();
    var c = curCtx();
    var files = atts.map(function (a) { return { name: a.name, path: a.path, size: a.size, image: a.image, url: a.url }; });
    if (atts.length) { S.atts = []; renderAtts(); }
    var pending = draw({ t: 'user', text: text, ctx: c ? ctxLabel(c) : '', files: files });
    pending.classList.add('pending');
    if (given == null) { input.value = ''; ls(LS_DRAFT, null); grow(); }
    // 还没送到小芯的电脑：「正在输入」旁边写「接收中」（电脑在睡写「唤醒中」），送到了才「思考中」并开始计时
    S.lastText = ''; S.doing = 'think'; S.note = null; S.waitSend = '';
    typing(true); renderHead(); toBottom(true);
    var x = xin(); if (x) x.ai('think');
    call('send', { sid: S.sid || undefined, agent: S.sid ? undefined : S.agent, text: text, effort: S.effort, context: c ? ctxText(c) : undefined, ctxLabel: c ? ctxLabel(c) : undefined,
      files: files.length ? files.map(function (f) { return { path: f.path, name: f.name }; }) : undefined }, 90000, function (w) { S.waitSend = w.state; progress(); }).then(function (d) {
      if (c && c.sel) S.sel = null;      // 选中的内容用过一次就不再带
      refreshCtx();
      // 送到了：小芯的电脑收到这句、AI 开始干活，从这一刻开始算「思考中」的时间
      S.sending = false; S.waitSend = ''; pending.classList.remove('pending');
      S.sid = d.sid; S.sessAgent = d.agent || S.sessAgent || S.agent; ls(LS_SID, d.sid);
      S.mine[d.run] = true; S.run = d.run; S.off = 0; S.t0 = Date.now(); render(); typing(true); startPolling();
    }, function (e) {
      S.sending = false; S.waitSend = ''; pending.remove(); typing(false); renderHead();
      if (!input.value) { input.value = text; ls(LS_DRAFT, text); grow(); }
      if (atts.length && !(S.atts || []).length) { S.atts = atts; renderAtts(); render(); }   // 没发出去：附件放回去
      var x2 = xin(); if (x2) { x2.ai(''); x2.cmd('confused'); if (!S.open) x2.say('没发出去：' + e.message + '（点我看看）', 9000, open); }
      if (/还没做完/.test(e.message)) { openSession(S.sid); return; }
      draw({ t: 'err', text: '没发出去：' + e.message }); toBottom(true);
    });
  }
  /* ---------- 附带页面信息：发消息时告诉小芯你正在看什么 ----------
     在哪一页（学习台的标题 + 亮着的小标签）、最近 3 分钟里在网站上选中的文字、「验证」里写的代码。
     不是一直盯着：只在发消息那一下读一次；只发到你自己的云电脑。 */
  var SEL_MAX = 4000, CODE_MAX = 6000, SEL_AGE = 180000, watched = [];
  function watchDoc(d) {
    if (!d || watched.indexOf(d) >= 0) return;
    watched.push(d);
    // 记下最近一次选中的文字：点开输入框时选区会被清掉，所以选的那一刻就记。
    // 选区没了的时候分两种：是你点小芯、背包、输入框、面板（打开聊天）弄没的 → 留着；是你点了页面别处、自己取消的 → 马上忘掉
    var UI = '.xin, .xin-bag, .xin-ask, .xin-say, .xc';
    var lastDown = { ui: false, at: 0 };
    d.addEventListener('pointerdown', function (e) {
      var t = e.target;
      lastDown = { ui: !!(t && t.closest && t.closest(UI)), at: Date.now() };
    }, true);
    d.addEventListener('selectionchange', function () {
      var sel = d.getSelection && d.getSelection();
      if (!sel) return;
      if (sel.isCollapsed || !String(sel).trim()) {
        var a = d.activeElement, byChat = (a && a.closest && a.closest(UI)) || (lastDown.ui && Date.now() - lastDown.at < 2500);
        if (!byChat && S.sel && S.sel.doc === d) S.sel = null;
        return;
      }
      if (!sel.anchorNode) return;
      var n = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
      if (n && n.closest && n.closest(UI + ', textarea, input')) return;
      var t = String(sel).replace(/\u00a0/g, ' ').trim();
      if (t) S.sel = { text: t.slice(0, SEL_MAX), at: Date.now(), doc: d };
    });
  }
  function toolDoc() {
    if (!document.body.classList.contains('tool-open')) return null;
    var f = document.querySelector('.panel.show iframe');
    try { return f && f.contentDocument; } catch (e) { return null; }
  }
  function pageContext() {
    var d = toolDoc(), c = { label: '', sel: '', code: '' };
    if (d && d.getElementById('main')) {
      watchDoc(d);
      var title = String(d.title || '').replace(/\s*·\s*STM32 学习台\s*$/, '').trim();
      var parts = title ? title.split(/\s*·\s*/) : ['首页'];
      [].forEach.call(d.querySelectorAll('#main .snav-i.on, #main .cseg-b.on, #main .lm-tab.on'), function (e) {
        var t = e.textContent.replace(/\s+/g, ' ').trim();
        if (t && parts.indexOf(t) < 0 && title.indexOf(t) < 0) parts.push(t);
      });
      c.place = parts.join(' · '); c.label = 'STM32 学习台 · ' + c.place;   // 给 AI 的写全，框上面那行短一点
      var ta = d.querySelector('#main .lab-ta');
      if (ta && ta.offsetParent && ta.value.trim()) c.code = ta.value.slice(0, CODE_MAX);
    }
    // 只带「现在这一页」上选中的：关掉学习台以后，学习台里选过的就不算了
    if (S.sel && Date.now() - S.sel.at < SEL_AGE && (S.sel.doc === d || S.sel.doc === document)) { c.sel = S.sel.text; c.selAt = S.sel.at; }
    return c.label || c.sel || c.code ? c : null;
  }
  /* 这次发消息带不带「附带」：设置里关了就都不带；点过 ✕ 的，在这一页上一直不带（发完也不再冒出来），
     换到别的页面、或者又选中了新的文字（你主动要它看的），之前的「不带」才作废 */
  function curCtx() {
    if (ls(LS_CTX) === '0') return null;
    var c = pageContext(), k = S.ctxSkip;
    if (!c) return null;
    if (k && ((c.place || '') !== k.place || (c.sel && c.selAt !== k.selAt))) S.ctxSkip = k = null;
    return k ? null : c;
  }
  function skipCtx() {
    var c = pageContext();
    S.ctxSkip = c ? { place: c.place || '', selAt: c.sel ? c.selAt : 0 } : null;
  }
  function ctxLabel(c) {
    var out = [c.place || c.label || '网页'];
    if (c.sel) { var n = c.sel.split('\n').length, one = c.sel.replace(/\s+/g, ' '); out.push(n > 1 ? '选中 ' + n + ' 行' : '选中「' + (one.length > 14 ? one.slice(0, 13) + '…' : one) + '」'); }
    if (c.code) out.push('你写的代码');
    return out.join(' · ');
  }
  function ctxText(c) {
    var t = [];
    if (c.label) t.push('【用户正在看】' + c.label);
    if (c.sel) t.push('【用户选中的内容】\n' + c.sel);
    if (c.code) t.push('【用户在「验证」里写的代码】\n```c\n' + c.code + '\n```');
    return t.join('\n');
  }
  function refreshCtx() {
    if (!root) return;
    var box = root.querySelector('.xc-ctx'), c = curCtx();
    box.hidden = !c; if (c) box.querySelector('span').textContent = '附带：' + ctxLabel(c);
  }

  /* ---------- 不开面板，直接和小芯说：小芯旁边冒输入框，回复在它头上的气泡里 ---------- */
  function quick(X) {
    X = X || xin();
    if (!S.enabled || !X || !X.ask) return;
    if (!S.authed) { open(); return; }
    if (!root) build();
    var c = curCtx();
    X.ask({
      placeholder: S.run ? '小芯还在忙上一件事…' : '和小芯说点什么…',
      chip: c ? '附带：' + ctxLabel(c) : '',
      onChipOff: function () { skipCtx(); },
      onExpand: open,
      onSend: function (t) {
        if (S.run || S.sending) { X.say('我还在忙上一件事，等我做完～', 4000); return; }
        send(t);
      }
    });
  }
  function stop() {
    if (!S.run) return;
    // 停完（或者其实早就做完了）再取一次进度：拿到「做完」，停止键才会变回发送
    call('stop', { run: S.run }, 20000).then(function () { if (S.run && !S.polling) startPolling(); }, function (e) { setStatus('停不下来：' + e.message, 'bad'); });
  }

  /* ---------- 轮询这一轮的新事件 ---------- */
  var pollTm = 0;
  function startPolling() { if (S.polling) return; S.polling = true; poll(); }
  function stopPolling() { S.polling = false; clearTimeout(pollTm); }
  function poll() {
    clearTimeout(pollTm);
    if (!S.polling || !S.run) return;
    if (document.hidden) { pollTm = setTimeout(poll, 1500); return; }
    var run = S.run;
    call('poll', { run: run, off: S.off }, 0).then(function (d) {
      if (run !== S.run) return;
      d.events.forEach(function (ev) { if (!(ev.t === 'user' && S.mine[run])) draw(ev, false, run); react(ev); if (ev.t === 'done' && ev.usage) setUsage(ev.usage); });
      S.off = d.off;
      if (d.events.length) toBottom();
      if (d.done) { S.run = ''; stopPolling(); setStatus(''); typing(false); render(); if (!touch && S.open) input.focus(); return; }
      progress();
      pollTm = setTimeout(poll, d.events.length ? 700 : 1300);
    }, function (e) {
      if (e.state === 'cooldown') { setStatus(e.message, 'bad'); pollTm = setTimeout(poll, Math.max(30, e.retryAfter || 60) * 1000); return; }
      if (/要先登录/.test(e.message)) { stopPolling(); return; }
      setStatus(e.state === 'waking' ? '唤醒中…' : '连不上云电脑，正在重试：' + e.message, 'wait');
      pollTm = setTimeout(poll, 3000);
    });
  }
  /* 「正在输入」气泡旁边那行字：思考中还是在电脑上忙、从消息送到小芯电脑那一刻起过了多久（分得清是慢还是卡住了），每秒走一下；
     偶尔的状态（比如卡住了重连）闪几秒。「思考中」= AI 已经收到这句、还没出声也没在执行命令：主要是模型在想、在写回答
     （回答是整段到的，看不到一个字一个字地写），也包括 AI 程序启动、请求发给模型的那一两秒 */
  var NOISE = /^Model metadata for .* not found/i;   // Codex 每轮都报的无关警告
  function progress() {
    if (!S.run && !S.sending) return;
    renderHead();
    if (!typingEl) return;
    var sec = Math.round((Date.now() - (S.t0 || Date.now())) / 1000), lab = typingEl.querySelector('.xc-typing-l');
    if (S.sending) { lab.textContent = sendingText(); return; }
    if (S.note && Date.now() - S.note.at < 6000) { lab.textContent = S.note.text; return; }
    lab.textContent = (S.doing === 'work' ? '在电脑上忙' : '思考中') + (sec >= 1 ? ' · ' + (sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒' : sec + ' 秒') : '');
  }
  // 还没送到小芯的电脑时那行字：接收中；电脑在睡：唤醒中；InstaBox 忙：排队中
  function sendingText() { return S.waitSend === 'waking' ? '唤醒中' : S.waitSend === 'busy' ? '排队中' : '接收中'; }
  function react(ev) {
    if (ev.t === 'status') { if (!NOISE.test(ev.text || '')) S.note = { text: ev.text, at: Date.now() }; return; }
    if (ev.t === 'tool') S.doing = 'work'; else if (ev.t === 'tool_end' || ev.t === 'text') S.doing = 'think';
    var x = xin(); if (!x) return;
    if (ev.t === 'text') { S.lastText = ev.text; x.ai('think'); var line = firstLine(ev.text); if (line) x.say(line, 0, open); }
    else if (ev.t === 'tool') x.ai('work');
    else if (ev.t === 'xin') { S.lastAct = Date.now(); if (ev.act === 'move' && ev.frames) x.learn([{ name: ev.arg, frames: ev.frames }]); x.cmd(ev.act, ev.arg); }
    else if (ev.t === 'mem') x.say('记住啦～', 2500);
    else if (ev.t === 'move') { setMoves(S.moves.filter(function (m) { return m.name !== ev.name; }).concat([{ name: ev.name, frames: ev.frames }])); S.lastAct = Date.now(); x.cmd('move', ev.name); x.say('学会新动作啦：' + ev.name, 3000); }
    else if (ev.t === 'bond') { setBond(ev); S.lastAct = Date.now(); x.say(ev.d > 0 ? '好感度 +' + ev.d + ' ♥' : '哼，好感度 ' + ev.d, 3000); x.cmd(ev.d > 0 ? 'love' : 'sad'); }
    else if (ev.t === 'done') {
      x.ai('');
      if (ev.stopped) return;
      if (ev.ok && S.lastText) x.say(summary(S.lastText), 16000, open);
      else if (!ev.ok) x.say('没做成，点我看看怎么回事', 10000, open);
      if (Date.now() - S.lastAct < 4000) return;          // AI 刚让它做了动作，就不抢戏了
      x.cmd(ev.ok ? 'happy' : 'sad');
    }
  }
  // 气泡里放纯文字：去掉 Markdown 记号。# 和 > 只去行首的（标题、引用），RCC->APB2ENR 里的 > 要留着
  function mdPlain(t) { return t.replace(/^[ \t]*(#{1,6}|>+)[ \t]*/gm, '').replace(/\*\*|`/g, ''); }
  // 做完时气泡里的话：最后那段回答的开头；有代码或太长就提示点开看全文
  function summary(t) {
    t = String(t || '');
    var code = /```/.test(t), plain = mdPlain(t.replace(/```[\s\S]*?(```|$)/g, ' ')).replace(/\s+/g, ' ').trim();
    var cut = plain.length > 80 ? plain.slice(0, 78) + '…' : plain;
    return (cut || '写好了') + (code || plain.length > 80 ? ' （点我看全文）' : '');
  }
  function firstLine(t) {
    t = mdPlain(String(t || '').replace(/```[\s\S]*?(```|$)/g, ' ')).trim();
    var m = /^[^\n。！？!?]{1,60}[。！？!?]?/.exec(t);
    if (!m) return '';
    var s = m[0].trim();
    return s.length > 36 ? s.slice(0, 34) + '…' : s;
  }

  /* ---------- 画消息 ---------- */
  function toBottom(force) {
    var b = root.querySelector('.xc-body');
    if (force || b.scrollHeight - b.scrollTop - b.clientHeight < 160) b.scrollTop = b.scrollHeight;
  }
  // 新的一条加在「正在输入」前面（它永远在最后）
  function put(e) { if (typingEl && typingEl.parentNode === list) list.insertBefore(e, typingEl); else list.appendChild(e); return e; }
  // 上一条（不算「正在输入」）是不是同一轮里小芯说的：是的话这条不再画头像，和上一条挨着
  function lastAi(run) {
    var e = typingEl && typingEl.parentNode === list ? typingEl.previousElementSibling : list.lastElementChild;
    return !!e && e.classList.contains('xc-ai') && !e.classList.contains('xc-typing') && e.dataset.run === (run || '');
  }
  function aiMsg(run, cls) {
    var e = h('div', 'xc-m xc-ai' + (cls ? ' ' + cls : '')), b = h('div', 'xc-bub');
    e.dataset.run = run || '';
    if (lastAi(run)) e.classList.add('cont');
    e.appendChild(avatar()); e.appendChild(b);
    return { e: e, b: b };
  }
  function sysChip(text, cls) { return h('div', 'xc-sys' + (cls ? ' ' + cls : ''), text); }
  // 两句之间隔了 10 分钟以上，中间写一下时间
  function timeSep(at) {
    at = at || Date.now();
    if (!S.lastAt || at - S.lastAt > 600000) put(h('div', 'xc-time', when(at)));
    S.lastAt = at;
  }
  // run：这一条属于哪一轮。工具调用（执行的命令）、xin 动作、临时状态都不画
  function draw(ev, old, run) {
    var e = null, m;
    run = run || S.run || '';
    if (ev.t === 'user') {
      timeSep(ev.at);
      e = h('div', 'xc-m xc-me');
      if (ev.files && ev.files.length) e.appendChild(msgFiles(ev.files));
      if (ev.text) e.appendChild(h('div', 'xc-bub', ev.text));
      if (ev.ctx) e.appendChild(h('div', 'xc-ctxm', '附带：' + ev.ctx));
    } else if (ev.t === 'text') {
      m = aiMsg(run); var body = md(ev.text); m.b.appendChild(body);
      if (body.querySelector('.xc-code, .xc-tbl')) m.e.classList.add('wide');
      e = m.e;
    } else if (ev.t === 'err') {
      S.errRuns[run] = true;
      m = aiMsg(run, 'bad'); m.b.textContent = ev.text; e = m.e;
    } else if (ev.t === 'done') {
      if (ev.stopped) e = sysChip('已停止');
      else if (!ev.ok && !S.errRuns[run]) { m = aiMsg(run, 'bad'); m.b.textContent = '这次没做成'; e = m.e; }
    } else if (ev.t === 'mem') e = sysChip('记住了：' + ev.text, 'mem');
    else if (ev.t === 'move') e = sysChip('学会了新动作：' + ev.name, 'move');
    else if (ev.t === 'bond') e = sysChip('好感度 ' + (ev.d > 0 ? '+' : '') + ev.d + (ev.why ? ' · ' + ev.why : ''), 'bond');
    if (e) put(e);
    return e;
  }
  // 小芯在干活时，最后面冒一个「正在输入」的气泡（三个点在跳）和一行字：思考中 / 在电脑上忙，用了多久（每秒走）
  var typingEl = null, typingTick = 0;
  function typing(on) {
    if (!on) { clearInterval(typingTick); typingTick = 0; if (typingEl) typingEl.remove(); typingEl = null; return; }
    if (!typingTick) typingTick = setInterval(progress, 1000);
    if (!typingEl) {
      typingEl = h('div', 'xc-m xc-ai xc-typing'); typingEl.setAttribute('aria-label', '小芯正在回复');
      typingEl.appendChild(avatar());
      var b = h('div', 'xc-bub'); b.innerHTML = '<i></i><i></i><i></i>';
      typingEl.appendChild(b); typingEl.appendChild(h('span', 'xc-typing-l', '思考中'));
    }
    list.appendChild(typingEl);
    var prev = typingEl.previousElementSibling;
    typingEl.classList.toggle('cont', !!prev && prev.classList.contains('xc-ai'));
    progress();
  }
  // Markdown：代码块、标题、列表（可以套一层）、引用、分隔线、表格、段落；行内：代码、粗体、链接、小芯电脑里的路径。全部先转义
  function md(text) {
    var box = h('div', 'xc-md'), parts = String(text).split(/```/);
    parts.forEach(function (part, i) {
      if (i % 2) {
        var nl = part.indexOf('\n'), lang = nl >= 0 ? part.slice(0, nl).trim() : '', code = nl >= 0 ? part.slice(nl + 1) : part;
        var wrap = h('div', 'xc-code'), hd = h('div', 'xc-code-h'), pre = h('pre'), c = h('code'), src = code.replace(/\n$/, '');
        c.innerHTML = hl(src, lang);
        hd.appendChild(h('span', 'xc-lang', lang || '代码'));
        var cp = h('button', 'xc-copy'); cp.type = 'button';
        cp.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg><span>复制</span>';
        hd.appendChild(cp); pre.appendChild(c); wrap.appendChild(hd); wrap.appendChild(pre); box.appendChild(wrap);
        return;
      }
      blocks(part, box);
    });
    return box;
  }
  function blocks(text, box) {
    var lines = text.replace(/\r/g, '').split('\n'), i = 0, para = [];
    var flush = function () { if (para.length) { var p = h('p'); p.innerHTML = para.map(inline).join('<br>'); box.appendChild(p); para = []; } };
    var LI = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
    while (i < lines.length) {
      var ln = lines[i], m;
      if (!ln.trim()) { flush(); i++; continue; }
      if ((m = /^\s*(#{1,6})\s+(.*)$/.exec(ln))) { flush(); var hh = h('h4'); hh.innerHTML = inline(m[2]); box.appendChild(hh); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) { flush(); box.appendChild(h('hr')); i++; continue; }
      if (/^\s*>/.test(ln)) {
        flush(); var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        var bq = h('blockquote'); blocks(q.join('\n'), bq); box.appendChild(bq); continue;
      }
      if (/\|/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush(); var rows = [ln]; i += 2;
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(lines[i++]);
        box.appendChild(table(rows)); continue;
      }
      if (LI.test(ln)) {
        flush(); i = list_(lines, i, box, LI); continue;
      }
      para.push(ln.trim()); i++;
    }
    flush();
  }
  // 列表：同一缩进的一串；缩进更深的接在上一项里当子列表
  function list_(lines, i, box, LI) {
    var m = LI.exec(lines[i]), ind = m[1].length, ordered = /\d/.test(m[2]), el = h(ordered ? 'ol' : 'ul'), li = null;
    if (ordered && parseInt(m[2], 10) > 1) el.setAttribute('start', parseInt(m[2], 10));
    while (i < lines.length) {
      var ln = lines[i];
      if (!ln.trim()) { if (i + 1 < lines.length && LI.test(lines[i + 1]) && LI.exec(lines[i + 1])[1].length >= ind) { i++; continue; } break; }
      m = LI.exec(ln);
      if (m && m[1].length > ind && li) { i = list_(lines, i, li, LI); continue; }
      if (m && m[1].length === ind && /\d/.test(m[2]) === ordered) { li = h('li'); li.innerHTML = inline(m[3]); el.appendChild(li); i++; continue; }
      if (!m && li && /^\s{2,}\S/.test(ln)) { li.innerHTML += '<br>' + inline(ln.trim()); i++; continue; }
      break;
    }
    box.appendChild(el);
    return i;
  }
  function table(rows) {
    var cells = function (r) { return r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); };
    var wrap = h('div', 'xc-tbl'), t = h('table'), head = cells(rows[0]);
    var tr = h('tr'); head.forEach(function (c) { var th = h('th'); th.innerHTML = inline(c); tr.appendChild(th); });
    var th_ = h('thead'); th_.appendChild(tr); t.appendChild(th_);
    var tb = h('tbody');
    rows.slice(1).forEach(function (r) {
      var row = h('tr'); cells(r).forEach(function (c) { var td = h('td'); td.innerHTML = inline(c); row.appendChild(td); }); tb.appendChild(row);
    });
    t.appendChild(tb); wrap.appendChild(t);
    return wrap;
  }
  /* ---------- 代码上色：C（含 STM32 的寄存器宏）、shell、Python、JS / JSON、Makefile、汇编 ----------
     一个大正则从头扫到尾：注释、字符串、预处理（#include）、变量（$x）、数字、标识符；标识符再分关键字、类型、函数（后面跟括号）、
     全大写的宏 / 寄存器名，shell 里每条命令的第一个词也算「函数」。没认出语言就按内容猜，猜不出就不上色。全部先转义。 */
  var HL_ALIAS = { c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cxx: 'c', ino: 'c', arduino: 'c', java: 'c', ld: 'c',
    js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', json: 'js', jsonc: 'js',
    sh: 'sh', bash: 'sh', shell: 'sh', console: 'sh', zsh: 'sh', terminal: 'sh', shellsession: 'sh',
    py: 'py', python: 'py', python3: 'py', make: 'make', makefile: 'make', mk: 'make', s: 'asm', asm: 'asm', armasm: 'asm' };
  var HL_KW = {}, HL_RE = {};
  (function () {
    var w = {
      c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL nullptr class public private protected namespace template typename new delete this virtual override using __IO __I __O __attribute__ __asm __NOP __WFI',
      js: 'await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async true false null undefined',
      py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self',
      sh: 'if then else elif fi for while until do done case esac function in return export local readonly unset set source alias',
      make: 'ifeq ifneq ifdef ifndef else endif include define endef export override',
      asm: ''
    };
    Object.keys(w).forEach(function (l) { HL_KW[l] = {}; w[l].split(' ').forEach(function (k) { if (k) HL_KW[l][k] = 1; }); });
  })();
  var HL_TYPE = /^(u?int(8|16|32|64)_t|u?int_(least|fast)(8|16|32|64)_t|size_t|ssize_t|ptrdiff_t|u?intptr_t|[us](8|16|32|64)|uint(8|16|32)|\w+_TypeDef|\w+_t|FILE)$/;
  function hlLang(lang, code) {
    var l = HL_ALIAS[String(lang || '').toLowerCase()];
    if (l) return l;
    if (lang) return '';
    if (/#\s*include|->|\b(void|uint32_t|int)\b[^\n]*[;{]/.test(code)) return 'c';
    if (/^\s*(\$ |sudo |cd |make\b|ls\b|cp\b|mkdir\b|arm-none-eabi-)/m.test(code)) return 'sh';
    if (/^\s*(def |import |from \S+ import )/m.test(code)) return 'py';
    return '';
  }
  function hlRe(l) {
    if (HL_RE[l]) return HL_RE[l];
    var NO = '(?!)';
    var com = l === 'c' || l === 'js' ? '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)' : l === 'asm' ? '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)|[;@][^\\n]*' : '#[^\\n]*';
    var str = '"(?:[^"\\\\\\n]|\\\\.)*"?|\'(?:[^\'\\\\\\n]|\\\\.)*\'?' + (l === 'js' || l === 'sh' ? '|`(?:[^`\\\\]|\\\\.)*`?' : '');
    var pre = l === 'c' ? '^[ \\t]*#[ \\t]*\\w+(?:[ \\t]*<[^>\\n]*>)?' : l === 'asm' ? '\\.\\w+' : NO;
    var vr = l === 'sh' ? '\\$\\{[^}\\n]*\\}|\\$\\w+|\\$[@#?$!*-]' : l === 'make' ? '\\$\\([^)\\n]*\\)|\\$[@<^\\w]' : NO;
    var num = '\\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)[uUlLfF]*\\b';
    var parts = l === 'c' ? [pre, com, str, vr, num] : [com, str, pre, vr, num];
    // shell 的命令名、文件名里常有 - 和 .（arm-none-eabi-gcc）
    HL_RE[l] = new RegExp(parts.map(function (x) { return '(' + x + ')'; }).join('|') + (l === 'sh' ? '|([A-Za-z_][\\w.-]*)' : '|([A-Za-z_]\\w*)'), 'gm');
    HL_RE[l].order = l === 'c' ? ['pre', 'com', 'str', 'var', 'num'] : ['com', 'str', 'pre', 'var', 'num'];
    return HL_RE[l];
  }
  function hlId(l, word, src, i) {
    if (HL_KW[l][word]) return 'kw';
    var j = i + word.length; while (src.charAt(j) === ' ' || src.charAt(j) === '\t') j++;
    var k = i - 1; while (k >= 0 && (src.charAt(k) === ' ' || src.charAt(k) === '\t')) k--;
    var prev = k < 0 ? '\n' : src.charAt(k);
    if (l === 'asm') { if (/^(r\d{1,2}|sp|lr|pc|apsr|primask)$/i.test(word)) return 'mc'; if (prev === '\n' || prev === ':') return src.charAt(j) === ':' ? 'fn' : 'kw'; }
    if (l === 'sh') {
      if (prev === '\n' || prev === '|' || prev === ';' || prev === '&' || prev === '(' || (prev === '$' && (k === 0 || src.charAt(k - 1) === '\n'))) return 'fn';
      if (prev === '-' || src.charAt(i - 1) === '-') return '';
    }
    if (l === 'make' && prev === '\n' && src.charAt(j) === ':') return 'fn';
    if (l === 'c' || l === 'js' || l === 'py') { if (HL_TYPE.test(word) && l === 'c') return 'ty'; if (src.charAt(j) === '(') return 'fn'; }
    if (/^[A-Z][A-Z0-9_]+$/.test(word) && /[A-Z]/.test(word)) return 'mc';
    return '';
  }
  function hl(src, lang) {
    var l = hlLang(lang, src);
    if (!l) return esc(src);
    var re = hlRe(l), out = '', last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      if (!m[0]) { re.lastIndex++; continue; }
      out += esc(src.slice(last, m.index));
      var cls = '';
      for (var g = 1; g <= 5; g++) if (m[g] !== undefined) { cls = re.order[g - 1]; break; }
      if (!cls) cls = hlId(l, m[6], src, m.index);
      out += cls ? '<span class="hl-' + cls + '">' + esc(m[0]) + '</span>' : esc(m[0]);
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }
  function esc(s) { return s.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // 小芯电脑里的路径（/data/workspace/…）：点了打开「小芯的文件」
  var PATH_RE = /(^|[^\w\/:.~-])(\/data\/workspace(?:\/[\w.+@%~=-]+)*\/?)(?!\w)/g;
  function pathLink(p, inner) { p = p.replace(/[.\/]+$/, '') || WORK; return '<a href="#" class="xc-path" data-path="' + esc(p) + '">' + inner + '</a>'; }
  function inline(line) {
    return line.split(/(`[^`]+`)/).map(function (seg, i) {
      if (i % 2) {
        var inner = seg.slice(1, -1).trim();
        return /^\/data\/workspace(\/[\w.+@%~=-]+)*\/?$/.test(inner) ? pathLink(inner, '<code>' + esc(inner) + '</code>') : '<code>' + esc(seg.slice(1, -1)) + '</code>';
      }
      return esc(seg)
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(https?:\/\/[^\s<>()（）]+[^\s<>()（）.,;:!?。，；：！？'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(PATH_RE, function (m, pre, p) { var t = p.replace(/[.]+$/, ''); return pre + pathLink(t, t) + p.slice(t.length); });
    }).join('');
  }

  /* ---------- 启动 ---------- */
  /* ---------- 打开网页就叫醒云电脑：等你发第一句话时它已经醒了 ----------
     登录了才叫；已经醒着什么都不做；离开页面超过 10 分钟再回来时再叫一次（它空闲 30 分钟会自己睡）。失败不提示，发消息时还会再叫。 */
  var wokeAt = 0;
  function wakeVm() {
    if (!S.enabled || !S.authed) return;
    wokeAt = Date.now();
    call('wake', {}, 0).catch(function () {});
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - wokeAt > 600000) { wakeVm(); greet(); } });

  /* ---------- 见面打招呼：小芯用 xin next 留的那句话（比如每日任务的结果），打开网页时在气泡里说 ----------
     同一句只说一次（记在本机）；小芯不在屏幕上（收起来了、在别处）就等它出来再说。点气泡回它一句。
     取这句话时云电脑顺便预热模型网关（刚睡醒的第一个请求常常卡很久）。 */
  var GREETED = 'lm.xin.greeted';
  function greet() {
    if (!S.enabled || !S.authed) return;
    call('greet', {}, 60000).then(function (g) {
      if (g && g.moves) setMoves(g.moves);
      if (g && g.bond) setBond(g.bond);
      if (!g || !g.id || !g.text || ls(GREETED) === g.id) return;
      var tries = 0;
      (function show() {
        var x = xin();
        if (!x || !x.say || x.mode === 'away' || x.asking) { if (tries++ < 30) setTimeout(show, 2000); return; }
        ls(GREETED, g.id);
        x.say(g.text, 14000, function () { quick(x); });
        if (x.cmd) x.cmd('happy');
      })();
    }, function () {});
  }

  // #xin 打开面板；#xin=<对话编号>（点「做完提醒」的通知进来的）打开那段对话
  var XIN_HASH = /^#xin(=s[0-9a-z]{6,24})?$/;
  function openFromHash() {
    var m = XIN_HASH.exec(location.hash);
    if (!m) return;
    if (m[1] && m[1].slice(1) !== S.sid) { S.sid = m[1].slice(1); ls(LS_SID, S.sid); S.histFor = ''; }
    open();
  }
  function boot() {
    watchDoc(document);
    // 学习台在 iframe 里：它加载好就开始记选中的文字
    document.addEventListener('load', function (e) { if (e.target && e.target.tagName === 'IFRAME') try { watchDoc(e.target.contentDocument); } catch (er) {} }, true);
    [].forEach.call(document.querySelectorAll('iframe'), function (f) { try { watchDoc(f.contentDocument); } catch (er) {} });
    req('me').then(function (d) {
      S.enabled = !!d.enabled; S.authed = !!d.authed;
      syncBag(); wakeVm(); greet();
      openFromHash();
      // 刷新页面时上一轮还在跑：小芯接着陪着（打开面板时会接上）
    }, function () { if (XIN_HASH.test(location.hash)) { S.enabled = false; open(); } });
    window.addEventListener('hashchange', openFromHash);
  }
  window.LimingXinChat = { open: open, close: close, ask: quick, played: played, get state() { return S; } };
  boot();
})();
