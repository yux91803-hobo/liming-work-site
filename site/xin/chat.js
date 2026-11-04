/* xin/chat.js — 小芯聊天：和 InstaBox 云电脑里的 AI（Claude Code / Codex）聊天、让它干活
   入口：小芯背包里的「聊天」（首页和 STM32 学习台里的小芯都有）：小芯旁边冒一个输入框（打字或语音），回复出现在小芯头上的气泡里，
   点气泡或输入框上的「展开」才打开这个面板看全文和历史。地址后面加 #xin 直接打开面板。没登录时先在面板里输密码。
   接口见 src/xin.js；AI 每一步（说话、执行命令、xin 动作）都整理成事件，这里一边轮询一边画出来，同时让小芯跟着动：
   AI 在想 → 小芯坐在电脑前挠头；在执行命令 → 敲代码；xin 命令 → 照做；做完 → 开心，失败 → 难过。 */
(function () {
  'use strict';
  var API = '/api/xin/';
  var LS_SID = 'lm.xin.sid', LS_AGENT = 'lm.xin.agent', LS_DRAFT = 'lm.xin.draft', LS_EFF = 'lm.xin.effort';
  var AGENTS = { codex: 'Codex', claude: 'Claude' };
  // 思考强度：自动 = 写代码的活用最高（max），聊天用 AI 自己的默认（规则在 vm-agent.mjs 的 resolveEffort）
  var EFFORTS = { auto: '自动', high: '高', max: '最高' }, EFF_DONE = { max: '最高思考', high: '高思考', low: '低思考' };
  var ACT_NAME = { say: '说', happy: '开心', sad: '难过', angry: '生气', wow: '惊讶', confused: '疑惑', dance: '跳舞', jump: '跳一下', cookie: '吃饼干', battery: '吸电池', ball: '抛小球', led: '玩 LED', sleep: '睡觉', wake: '醒来', music: '听歌', swing: '荡秋千', sit: '坐下', code: '敲代码', rage: '发脾气', tongue: '吐舌头' };
  var touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;

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

  var S = { enabled: false, authed: false, open: false, sid: ls(LS_SID) || '', agent: AGENTS[ls(LS_AGENT)] ? ls(LS_AGENT) : 'codex', sessAgent: '', effort: EFFORTS[ls(LS_EFF)] ? ls(LS_EFF) : 'auto',
    run: '', off: 0, polling: false, mine: {}, tools: {}, lastAct: 0, view: 'chat', machine: '', loadSeq: 0 };

  /* ---------- 请求 ---------- */
  function req(path, body) {
    var opt = body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Xin': '1' }, body: JSON.stringify(body) };
    return fetch(API + path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { d = d || {}; d._status = r.status; return d; });
    });
  }
  // 调云电脑：正在唤醒 / InstaBox 忙就等一会儿再试（最多 maxWait 毫秒），状态写在面板上
  function call(op, args, maxWait) {
    var t0 = Date.now();
    function once() {
      return req('call', { op: op, args: args || {} }).then(function (d) {
        if (d._status === 401) { S.authed = false; syncBag(); render(); throw new Error('要先登录'); }
        if (d._status !== 200) throw new Error(d.msg || d.error || ('出错了（' + d._status + '）'));
        if (d.ok) { if (op !== 'status') setStatus(''); return d.data; }
        if ((d.state === 'waking' || d.state === 'busy') && Date.now() - t0 < (maxWait || 0)) {
          setStatus(d.msg || '正在唤醒云电脑…', 'wait');
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
  var root, list, statusEl, input, sendBtn, agentSeg, titleEl, sessEl, loginEl, foot;
  function build() {
    root = h('section', 'xc'); root.id = 'xinChat'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', '和小芯聊天'); root.hidden = true;
    root.innerHTML =
      '<header class="xc-hd">' +
        '<button class="xc-ib xc-list-b" type="button" aria-label="对话列表"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h9"/></svg></button>' +
        '<div class="xc-ttl"><b>小芯</b><span class="xc-sub"></span></div>' +
        '<button class="xc-ib xc-new-b" type="button" aria-label="新对话"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>' +
        '<button class="xc-ib xc-x" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' +
      '</header>' +
      '<div class="xc-st" role="status" aria-live="polite" hidden></div>' +
      '<div class="xc-body"><div class="xc-msgs" aria-live="polite"></div></div>' +
      '<div class="xc-sess" hidden></div>' +
      '<form class="xc-login" hidden>' +
        '<p class="xc-hint">这是站长自己用的：小芯的大脑在 InstaBox 云电脑里，能执行命令，所以要先登录。</p>' +
        '<input type="password" name="pw" autocomplete="current-password" placeholder="密码" aria-label="密码" required>' +
        '<button type="submit" class="xc-btn">登录</button>' +
        '<p class="xc-err" role="alert"></p>' +
      '</form>' +
      '<form class="xc-ft">' +
        '<div class="xc-opts"><div class="xc-seg" role="radiogroup" aria-label="用哪个 AI"></div>' +
        '<div class="xc-eff" role="radiogroup" aria-label="思考强度"><span class="xc-eff-l">思考</span></div></div>' +
        '<div class="xc-ctx" hidden><span></span><button type="button" aria-label="这次不带">✕</button></div>' +
        '<div class="xc-row">' +
          '<textarea rows="1" placeholder="让小芯做点什么…" aria-label="消息" enterkeyhint="' + (touch ? 'enter' : 'send') + '"></textarea>' +
          '<button type="submit" class="xc-send" aria-label="发送"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg></button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(root);
    list = root.querySelector('.xc-msgs'); statusEl = root.querySelector('.xc-st'); input = root.querySelector('textarea');
    sendBtn = root.querySelector('.xc-send'); agentSeg = root.querySelector('.xc-seg'); titleEl = root.querySelector('.xc-sub');
    var effEl = root.querySelector('.xc-eff');
    Object.keys(EFFORTS).forEach(function (k) {
      var b = h('button', 'xc-ag', EFFORTS[k]); b.type = 'button'; b.dataset.effort = k; b.setAttribute('role', 'radio');
      b.title = k === 'auto' ? '写代码、编译、调试时自动用最高，聊天用默认' : k === 'max' ? '每一句都用最高强度思考（慢一些）' : '每一句都用高强度';
      b.addEventListener('click', function () { S.effort = k; ls(LS_EFF, k); renderSeg(); });
      effEl.appendChild(b);
    });
    sessEl = root.querySelector('.xc-sess'); loginEl = root.querySelector('.xc-login'); foot = root.querySelector('.xc-ft');
    Object.keys(AGENTS).forEach(function (k) {
      var b = h('button', 'xc-ag', AGENTS[k]); b.type = 'button'; b.dataset.agent = k; b.setAttribute('role', 'radio');
      b.addEventListener('click', function () { S.agent = k; ls(LS_AGENT, k); renderSeg(); });
      agentSeg.appendChild(b);
    });
    root.querySelector('.xc-x').addEventListener('click', close);
    root.querySelector('.xc-new-b').addEventListener('click', function () { newChat(); if (!touch) input.focus(); });
    root.querySelector('.xc-list-b').addEventListener('click', function () { S.view = S.view === 'sess' ? 'chat' : 'sess'; render(); if (S.view === 'sess') loadSessions(); });
    loginEl.addEventListener('submit', function (e) { e.preventDefault(); login(loginEl.pw.value); });
    foot.addEventListener('submit', function (e) { e.preventDefault(); if (S.run) stop(); else send(); });
    input.value = ls(LS_DRAFT) || '';
    input.addEventListener('input', function () { grow(); ls(LS_DRAFT, input.value || null); });
    input.addEventListener('focus', refreshCtx);
    root.querySelector('.xc-ctx button').addEventListener('click', function () { S.ctxOff = true; refreshCtx(); input.focus(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); if (!S.run) send(); }
    });
    root.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    list.addEventListener('click', function (e) {
      var t = e.target.closest('.xc-tool-h'); if (t) { t.parentNode.classList.toggle('open'); t.setAttribute('aria-expanded', t.parentNode.classList.contains('open')); return; }
      var c = e.target.closest('.xc-copy');
      if (c) { var code = c.parentNode.querySelector('code'); copy(code ? code.textContent : '', c); }
    });
  }
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 150) + 'px'; }
  function copy(text, btn) {
    var ok = function () { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, function () {});
  }
  function renderSeg() {
    var locked = !!S.sid && !!S.sessAgent;
    agentSeg.classList.toggle('locked', locked);
    [].forEach.call(agentSeg.children, function (b) {
      var on = (locked ? S.sessAgent : S.agent) === b.dataset.agent;
      b.setAttribute('aria-checked', on); b.disabled = locked && !on; b.hidden = locked && !on;
    });
    titleEl.textContent = AGENTS[locked ? S.sessAgent : S.agent] + (S.machine ? ' · ' + S.machine : '');
    [].forEach.call(root.querySelectorAll('.xc-eff button'), function (b) { b.setAttribute('aria-checked', S.effort === b.dataset.effort); });
  }
  function render() {
    if (!root) return;
    var login = S.enabled && !S.authed, off = !S.enabled;
    loginEl.hidden = !login;
    foot.hidden = login || off || S.view === 'sess';
    sessEl.hidden = login || off || S.view !== 'sess';
    root.querySelector('.xc-body').hidden = login || S.view === 'sess';
    root.querySelector('.xc-list-b').hidden = root.querySelector('.xc-new-b').hidden = login || off;
    root.classList.toggle('running', !!S.run);
    sendBtn.setAttribute('aria-label', S.run ? '停止' : '发送');
    sendBtn.innerHTML = S.run ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" class="fill"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';
    if (off) { list.innerHTML = ''; list.appendChild(h('p', 'xc-hint', '小芯聊天还没开（网站没配密码或 InstaBox key）。')); }
    renderSeg();
  }
  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.hidden = !text; statusEl.textContent = text || ''; statusEl.className = 'xc-st' + (kind ? ' ' + kind : '');
  }

  /* ---------- 打开 / 关上 ---------- */
  function open() {
    S.ctxOff = false;
    if (!root) build();
    S.open = true; root.hidden = false; S.view = 'chat';
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
    if (location.hash === '#xin') history.replaceState(null, '', location.pathname + location.search);
  }

  /* ---------- 登录 ---------- */
  function login(pw) {
    var err = loginEl.querySelector('.xc-err'); err.textContent = '';
    req('login', { password: pw }).then(function (d) {
      if (d._status === 200) { S.authed = true; loginEl.pw.value = ''; syncBag(); render(); loadCurrent(); var x = xin(); if (x) { x.cmd('happy'); x.say('你来啦！'); } return; }
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
  function newChat() {
    stopPolling(); S.sid = ''; S.sessAgent = ''; S.run = ''; S.off = 0; S.tools = {}; ls(LS_SID, null);
    S.view = 'chat'; list.innerHTML = ''; S.histFor = ''; welcome(); render();
  }
  function welcome() {
    var p = h('div', 'xc-hello');
    p.appendChild(h('p', '', '我的大脑在你的 InstaBox 云电脑里，能在里面写代码、编译、跑命令。'));
    p.appendChild(h('p', 'xc-hint', '比如：「在云电脑里装 arm-none-eabi-gcc，写一个 STM32F103 点灯的 main.c 并编译」'));
    list.appendChild(p);
  }
  function loadCurrent() {
    status();
    if (S.sid) openSession(S.sid); else { list.innerHTML = ''; S.histFor = ''; welcome(); render(); }
  }
  function status() {
    call('status').then(function (d) {
      S.machine = d.name || '';
      var st = { running: '', suspended: '云电脑在睡觉，发消息会叫醒它（要等几秒）', stopped: '云电脑关机了，发消息会替它开机（要等一会儿）' }[d.state];
      setStatus(st === undefined ? '云电脑：' + d.state : st, 'info');
      renderSeg();
    }, function (e) { setStatus(e.message, 'bad'); });
  }
  function openSession(sid) {
    var my = ++S.loadSeq;
    // 先清掉「这一轮还在跑」：重读期间那一轮可能已经做完了，以历史里说的为准（还在跑就从那里接着取）
    stopPolling(); S.run = ''; S.off = 0; S.view = 'chat'; S.tools = {}; list.innerHTML = ''; render();
    list.appendChild(h('p', 'xc-hint xc-loading', '正在读取对话…'));
    call('history', { sid: sid }, 60000).then(function (d) {
      if (my !== S.loadSeq) return;
      list.innerHTML = '';
      S.sid = sid; S.sessAgent = d.session.agent; ls(LS_SID, sid); S.histFor = sid;
      d.runs.forEach(function (r) { r.events.forEach(function (ev) { draw(ev, true, r.run); }); });
      if (d.active) { S.run = d.active.run; S.off = d.active.off; S.t0 = Date.now(); S.doing = 'think'; startPolling(); var x = xin(); if (x) x.ai('think'); }
      render(); toBottom(true);
    }, function (e) {
      if (my !== S.loadSeq) return;
      list.innerHTML = '';
      if (/找不到/.test(e.message)) { newChat(); return; }
      list.appendChild(h('p', 'xc-hint', '读不出来：' + e.message));
    });
  }
  function loadSessions() {
    sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '正在读取…'));
    call('sessions', {}, 60000).then(function (d) {
      sessEl.innerHTML = '';
      var ul = h('ul', 'xc-sl');
      if (!d.sessions.length) ul.appendChild(h('li', 'xc-hint', '还没有对话'));
      d.sessions.forEach(function (s) {
        var li = h('li'), b = h('button', 'xc-si'); b.type = 'button';
        b.appendChild(h('span', 'xc-si-t', s.title || '（无标题）'));
        b.appendChild(h('span', 'xc-si-m', (AGENTS[s.agent] || s.agent) + ' · ' + s.turns + ' 轮 · ' + when(s.updated) + (s.active ? ' · 进行中' : '')));
        if (s.sid === S.sid) b.classList.add('cur');
        b.addEventListener('click', function () { openSession(s.sid); });
        li.appendChild(b); ul.appendChild(li);
      });
      sessEl.appendChild(ul);
      var out = h('button', 'xc-link', '退出登录'); out.type = 'button'; out.addEventListener('click', logout);
      sessEl.appendChild(out);
    }, function (e) { sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '读不出来：' + e.message)); });
  }
  function when(t) {
    var d = new Date(t), now = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    var hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  /* ---------- 发消息 ---------- */
  function send(given) {
    var text = given != null ? String(given).trim() : input.value.trim();
    if (!text || S.run || S.sending) return false;
    S.sending = true;
    if (list.querySelector('.xc-hello')) list.innerHTML = '';
    var c = S.ctxOff ? null : pageContext();
    var pending = draw({ t: 'user', text: text, ctx: c ? ctxLabel(c) : '' });
    pending.classList.add('pending');
    if (given == null) { input.value = ''; ls(LS_DRAFT, null); grow(); }
    toBottom(true); S.lastText = '';
    var x = xin(); if (x) x.ai('think');
    call('send', { sid: S.sid || undefined, agent: S.sid ? undefined : S.agent, text: text, effort: S.effort, context: c ? ctxText(c) : undefined, ctxLabel: c ? ctxLabel(c) : undefined }, 90000).then(function (d) {
      if (c && c.sel) S.sel = null;      // 选中的内容用过一次就不再带
      S.ctxOff = false; refreshCtx();
      S.sending = false; pending.classList.remove('pending');
      S.sid = d.sid; S.sessAgent = d.agent || S.sessAgent || S.agent; ls(LS_SID, d.sid);
      S.mine[d.run] = true; S.run = d.run; S.off = 0; S.t0 = Date.now(); S.doing = 'think'; render(); startPolling();
    }, function (e) {
      S.sending = false; pending.remove();
      if (!input.value) { input.value = text; ls(LS_DRAFT, text); grow(); }
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
    if (S.sel && Date.now() - S.sel.at < SEL_AGE && (S.sel.doc === d || S.sel.doc === document)) c.sel = S.sel.text;
    return c.label || c.sel || c.code ? c : null;
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
    var box = root.querySelector('.xc-ctx'), c = S.ctxOff ? null : pageContext();
    box.hidden = !c; if (c) box.firstChild.textContent = '附带：' + ctxLabel(c);
  }

  /* ---------- 不开面板，直接和小芯说：小芯旁边冒输入框，回复在它头上的气泡里 ---------- */
  function quick(X) {
    X = X || xin();
    if (!S.enabled || !X || !X.ask) return;
    if (!S.authed) { open(); return; }
    if (!root) build();
    S.ctxOff = false;
    var c = pageContext();
    X.ask({
      placeholder: S.run ? '小芯还在忙上一件事…' : '和小芯说点什么…',
      chip: c ? '附带：' + ctxLabel(c) : '',
      onChipOff: function () { S.ctxOff = true; },
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
      d.events.forEach(function (ev) { if (!(ev.t === 'user' && S.mine[run])) draw(ev, false, run); react(ev); });
      S.off = d.off;
      if (d.events.length) toBottom();
      if (d.done) { S.run = ''; stopPolling(); setStatus(''); render(); if (!touch && S.open) input.focus(); return; }
      progress();
      pollTm = setTimeout(poll, d.events.length ? 700 : 1300);
    }, function (e) {
      if (e.state === 'cooldown') { setStatus(e.message, 'bad'); pollTm = setTimeout(poll, Math.max(30, e.retryAfter || 60) * 1000); return; }
      if (/要先登录/.test(e.message)) { stopPolling(); return; }
      setStatus(e.state === 'waking' ? '正在唤醒云电脑…' : '连不上云电脑，正在重试：' + e.message, 'wait');
      pollTm = setTimeout(poll, 3000);
    });
  }
  // 小芯跟着动
  // 状态栏：AI 还没出声时显示在干什么、等了多久，分得清是慢还是卡住了
  var NOISE = /^Model metadata for .* not found/i;   // Codex 每轮都报的无关警告
  function progress() {
    if (!S.run) return;
    var sec = Math.round((Date.now() - (S.t0 || Date.now())) / 1000);
    if (S.note && Date.now() - S.note.at < 6000) { setStatus(S.note.text, 'wait'); return; }
    setStatus((S.doing === 'work' ? '小芯在执行命令…' : '小芯在想…') + (sec >= 3 ? ' 已 ' + (sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒' : sec + ' 秒') : ''), 'wait');
  }
  function react(ev) {
    if (ev.t === 'status') { if (!NOISE.test(ev.text || '')) S.note = { text: ev.text, at: Date.now() }; return; }
    if (ev.t === 'tool') S.doing = 'work'; else if (ev.t === 'tool_end' || ev.t === 'text') S.doing = 'think';
    var x = xin(); if (!x) return;
    if (ev.t === 'text') { S.lastText = ev.text; x.ai('think'); var line = firstLine(ev.text); if (line) x.say(line, 0, open); }
    else if (ev.t === 'tool') x.ai('work');
    else if (ev.t === 'xin') { S.lastAct = Date.now(); x.cmd(ev.act, ev.arg); }
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
  var TOOL_NAME = { Bash: '$', Read: '读', Write: '写', Edit: '改', Grep: '搜', Glob: '找', WebFetch: '网页', WebSearch: '搜网', Task: '分派', TodoWrite: '计划', MCP: 'MCP' };
  // run：这一条属于哪一轮（Codex 每轮的工具编号都从 item_0 开始，要按轮分开）
  function draw(ev, old, run) {
    var e = null;
    if (ev.t === 'tool' || ev.t === 'tool_end') return drawTool(ev, run || S.run);
    if (ev.t === 'user') { e = h('div', 'xc-m xc-me'); e.appendChild(h('div', 'xc-bub', ev.text)); if (ev.ctx) e.appendChild(h('div', 'xc-ctxm', '附带：' + ev.ctx)); }
    else if (ev.t === 'text') { e = h('div', 'xc-m xc-ai'); e.appendChild(md(ev.text)); }
    else if (ev.t === 'xin') e = h('div', 'xc-note', '✻ 小芯' + (ACT_NAME[ev.act] || ev.act) + (ev.arg && ev.act !== 'music' ? '：' + ev.arg : ''));
    else if (ev.t === 'status') return null;   // 临时状态只在状态栏里闪一下（见 react），不进对话
    else if (ev.t === 'err') e = h('div', 'xc-errm', ev.text);
    else if (ev.t === 'done') {
      var sec = Math.round((ev.ms || 0) / 1000);
      e = h('div', 'xc-done' + (ev.ok || ev.stopped ? '' : ' bad'), ev.stopped ? '已停止' : (ev.ok ? '完成' : '没做成') + (sec ? ' · ' + (sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒' : sec + ' 秒') : '') + (EFF_DONE[ev.effort] ? ' · ' + EFF_DONE[ev.effort] : ''));
    }
    if (e) list.appendChild(e);
    return e;
  }
  function drawTool(ev, run) {
    var key = run + ':' + ev.id, e = S.tools[key];
    if (!e) {
      e = h('div', 'xc-tool run'); S.tools[key] = e;
      var hd = h('button', 'xc-tool-h'); hd.type = 'button'; hd.setAttribute('aria-expanded', 'false');
      hd.appendChild(h('span', 'xc-tool-i', '…'));
      hd.appendChild(h('span', 'xc-tool-n', TOOL_NAME[ev.name] || ev.name || '工具'));
      hd.appendChild(h('span', 'xc-tool-d', ev.detail || ''));
      e.appendChild(hd); list.appendChild(e);
    }
    if (ev.detail) e.querySelector('.xc-tool-d').textContent = ev.detail;
    if (ev.t === 'tool_end') {
      e.classList.remove('run'); e.classList.add(ev.ok ? 'ok' : 'bad');
      e.querySelector('.xc-tool-i').textContent = ev.ok ? '✓' : '✗';
      if (ev.out && !e.querySelector('.xc-tool-o')) { e.appendChild(h('pre', 'xc-tool-o', ev.out)); e.classList.add('has-o'); }
    }
    return e;
  }
  // 简单的 Markdown：代码块、行内代码、粗体、链接、标题；其余原样（全部先转义）
  function md(text) {
    var box = h('div', 'xc-md'), parts = String(text).split(/```/);
    parts.forEach(function (part, i) {
      if (i % 2) {
        var nl = part.indexOf('\n'), lang = nl >= 0 ? part.slice(0, nl).trim() : '', code = nl >= 0 ? part.slice(nl + 1) : part;
        var wrap = h('div', 'xc-code'), pre = h('pre'), c = h('code', '', code.replace(/\n$/, ''));
        if (lang) wrap.appendChild(h('span', 'xc-lang', lang));
        var cp = h('button', 'xc-copy', '复制'); cp.type = 'button';
        pre.appendChild(c); wrap.appendChild(cp); wrap.appendChild(pre); box.appendChild(wrap);
        return;
      }
      part.split(/\n{2,}/).forEach(function (para) {
        if (!para.trim()) return;
        var p = h('p');
        p.innerHTML = para.split('\n').map(inline).join('<br>');
        box.appendChild(p);
      });
    });
    return box;
  }
  function esc(s) { return s.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function inline(line) {
    var hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) return '<b>' + inline(hm[2]) + '</b>';
    return line.split(/(`[^`]+`)/).map(function (seg, i) {
      if (i % 2) return '<code>' + esc(seg.slice(1, -1)) + '</code>';
      return esc(seg)
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(https?:\/\/[^\s<>()（）]+[^\s<>()（）.,;:!?。，；：！？'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    }).join('');
  }

  /* ---------- 启动 ---------- */
  function boot() {
    watchDoc(document);
    // 学习台在 iframe 里：它加载好就开始记选中的文字
    document.addEventListener('load', function (e) { if (e.target && e.target.tagName === 'IFRAME') try { watchDoc(e.target.contentDocument); } catch (er) {} }, true);
    [].forEach.call(document.querySelectorAll('iframe'), function (f) { try { watchDoc(f.contentDocument); } catch (er) {} });
    req('me').then(function (d) {
      S.enabled = !!d.enabled; S.authed = !!d.authed;
      syncBag();
      if (location.hash === '#xin') open();
      // 刷新页面时上一轮还在跑：小芯接着陪着（打开面板时会接上）
    }, function () { if (location.hash === '#xin') { S.enabled = false; open(); } });
    window.addEventListener('hashchange', function () { if (location.hash === '#xin') open(); });
  }
  window.LimingXinChat = { open: open, close: close, ask: quick, get state() { return S; } };
  boot();
})();
