// hub.js — LIMING AI 协作中心（原生 JS，无依赖）
// 安全：接口数据只经 textContent / 属性写入，不拼 HTML 字符串
(function () {
  'use strict';

  var API = '/api/hub/';
  var REFRESH_MS = 15000;
  var TZ = 'Asia/Shanghai';
  var MEMBERS = { grokbot: '小黎', muse: 'Muse', hark: 'Hark' };
  // [文案, 分组, 样式, 符号]
  var STATUS = {
    pending: ['待派发', 'run', 's-wait', '○'], dispatching: ['派发中', 'run', 's-run', '✻'], waiting: ['等回复', 'run', 's-wait', '◌'],
    reviewing: ['审核中', 'run', 's-run', '✻'], completed: ['完成', 'done', 's-done', '✓'],
    blocked: ['阻塞', 'bad', 's-bad', '✗'], failed: ['失败', 'bad', 's-bad', '✗'],
    cancelled: ['已取消', 'off', 's-wait', '–'], canceled: ['已取消', 'off', 's-wait', '–']  // [小黎修正] 已取消不再算进行中
  };
  var GROUPS = [['run', '进行中'], ['bad', '异常'], ['done', '完成'], ['off', '已取消']];
  var TABS = ['board', 'chat', 'log'];
  var SUMMARY_MAX = 60;

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    batches: [], batch: null, userPicked: false, tab: 'board',
    tasks: [], detail: null, sig: {}, busy: false, timer: null
  };

  /* ================= 工具 ================= */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function setText(node, v) { var s = v == null ? '' : String(v); if (node.textContent !== s) node.textContent = s; }
  function setClass(node, cls) { if (node.className !== cls) node.className = cls; }
  function emptyState(text, tag) { return el(tag || 'div', 'empty', text); }

  // 北京时间：今天 HH:mm，其它 MM-DD HH:mm
  var dtf = (function () {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch (e) { return null; }
  })();
  function parts(d) {
    var p = {};
    dtf.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    if (p.hour === '24') p.hour = '00';
    return p;
  }
  function validDate(v) { if (!v || !dtf) return null; var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function dayOf(d) { var p = parts(d); return p.year + '-' + p.month + '-' + p.day; }
  function today() { return dtf ? dayOf(new Date()) : ''; }
  function yesterday() { return dtf ? dayOf(new Date(Date.now() - 864e5)) : ''; }
  function fmtTime(v) {
    var d = validDate(v);
    if (!d) return '';
    var p = parts(d), hm = p.hour + ':' + p.minute;
    return dayOf(d) === today() ? hm : p.month + '-' + p.day + ' ' + hm;
  }
  function clock(v) { var d = validDate(v); if (!d) return ''; var p = parts(d); return p.hour + ':' + p.minute; }
  function dayLabel(key) {
    if (key === today()) return '今天';
    if (key === yesterday()) return '昨天';
    var s = key.split('-');
    return s[0] === today().slice(0, 4) ? Number(s[1]) + '月' + Number(s[2]) + '日' : s[0] + '年' + Number(s[1]) + '月' + Number(s[2]) + '日';
  }
  function tsNum(v) { var t = Date.parse(v || ''); return isNaN(t) ? 0 : t; }

  function who(sender) { return MEMBERS[sender] || sender || '未知'; }
  function whoCls(sender) { return MEMBERS[sender] ? 'c-' + sender : 'c-other'; }
  function statusInfo(s) { return STATUS[s] || [s || '未知', 'run', '', '·']; }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // 批次显示名：纯数字批次显示 phase 首词或 R<数字>
  function batchInfo(name) { return state.batches.filter(function (b) { return b.batch === name; })[0] || null; }
  function batchName(name) {
    if (name == null) return '';
    var s = String(name);
    if (!/^\d+$/.test(s)) return s;
    var b = batchInfo(name), ph = b && b.phase ? String(b.phase).trim() : '';
    return ph ? ph.split(/\s+/)[0] : 'R' + s;
  }
  function batchLabel(b) {
    var n = batchName(b.batch), ph = b.phase ? String(b.phase).trim() : '';
    if (/^\d+$/.test(String(b.batch)) && ph.split(/\s+/)[0] === n) ph = ph.slice(n.length).trim();
    return ph ? n + ' · ' + ph : n;
  }
  // 消息里的任务标签：优先显示任务标题
  function taskLabel(m) {
    var t = (!m.batch || m.batch === state.batch) ? state.tasks.filter(function (x) { return x.task_id === m.task_id; })[0] : null;
    if (t && t.title) return clip(t.title, 14);
    return m.batch && m.batch !== state.batch ? batchName(m.batch) + '/' + m.task_id : m.task_id;
  }
  function reduced() { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.toggle('solo', $('app').hidden);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  /* ================= 一句话摘要 ================= */

  var CODE_LINE = /^(\$ |>>>|\/\/|\/\*|#!|import |export |const |let |var |function |return |if \(|for \(|<\/?[a-zA-Z!]|[{}\[\]();]|---|===|\|)/;

  // 去掉 === FILE: 之后的内容和代码块，取第一句人话
  function summarize(text) {
    var s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var cut = s.search(/^\s*=== ?FILE:/m);
    var hadTech = cut >= 0 || /```/.test(s);
    if (cut >= 0) s = s.slice(0, cut);
    s = s.replace(/```[\s\S]*?(```|$)/g, '\n');
    var lines = s.split('\n'), heading = '';
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l || CODE_LINE.test(l)) continue;
      if (/^#{1,6}\s/.test(l)) { if (!heading) heading = l.replace(/^#+\s+/, '').replace(/\*\*|`/g, '').trim(); continue; }
      l = l.replace(/^#{1,6}\s+/, '').replace(/^([-*+]|\d+[.)])\s+/, '').replace(/^>\s*/, '')
        .replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').trim();
      if (!l || !/[\u4e00-\u9fa5A-Za-z]/.test(l)) continue;
      var m = l.match(/^(.{4,}?[。！？!?；;])(\s|$)/) || l.match(/^(.{6,}?[。！？!?；])/);
      if (m) l = m[1];
      return { text: clip(l, SUMMARY_MAX), tech: hadTech };
    }
    return { text: heading ? clip(heading, SUMMARY_MAX) : (hadTech ? '提交了代码' : ''), tech: hadTech };
  }

  // 可折叠的一行：默认显示摘要，点开看全文
  function createFold(cls) {
    var wrap = el('div', 'fold ' + (cls || ''));
    var line = el('button', 'line');
    line.type = 'button';
    line.setAttribute('aria-expanded', 'false');
    line.append(el('span', 'sum'), el('span', 'more', '▸'));
    var full = el('div', 'full');
    full.hidden = true;
    line.addEventListener('click', function () {
      if (!wrap.classList.contains('can-open')) return;
      var open = full.hidden;
      full.hidden = !open;
      wrap.classList.toggle('open', open);
      line.setAttribute('aria-expanded', String(open));
      setText(line.querySelector('.more'), open ? '▾' : '▸');
    });
    wrap.append(line, full);
    return wrap;
  }
  function setFold(wrap, text) {
    var raw = text == null ? '' : String(text);
    if (wrap.dataset.raw === raw) return;
    wrap.dataset.raw = raw;
    var sm = summarize(raw);
    var sum = sm.text || '（空）';
    setText(wrap.querySelector('.sum'), sum);
    var canOpen = raw.trim() !== '' && raw.replace(/\s+/g, ' ').trim() !== sum;
    wrap.classList.toggle('can-open', canOpen);
    wrap.querySelector('.more').hidden = !canOpen;
    setText(wrap.querySelector('.full'), raw);
  }

  /* ================= 主题（lm.theme：light / dark / auto，默认 light） ================= */

  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    var t = 'light';
    try { t = localStorage.getItem('lm.theme') || 'light'; } catch (e) {}
    var dark = t === 'dark' || (t === 'auto' && mq && mq.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#1f1e1d' : '#faf9f5');
  }
  applyTheme();
  if (mq) (mq.addEventListener ? mq.addEventListener('change', applyTheme) : mq.addListener(applyTheme));
  window.addEventListener('storage', function (e) { if (e.key === 'lm.theme') applyTheme(); });

  // 工具箱外壳：主题切换 {type:'theme'}；返回键 {type:'back'} 先关详情
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'theme') applyTheme();
    if (e.data.type === 'back' && e.source === window.parent && state.detail) closeDetail();
  });
  var embedded = document.documentElement.classList.contains('embed');
  // 告诉外壳当前层级：1 = 详情页，0 = 看板
  function notifyDepth(d) { if (!embedded) return; try { parent.postMessage({ type: 'depth', depth: d }, location.origin); } catch (e) {} }
  // 首屏出来后通知外壳撤掉启动页
  var readySent = false;
  function notifyReady() { if (readySent) return; readySent = true; try { if (window.self !== window.top) parent.postMessage({ type: 'ready' }, location.origin); } catch (e) {} }

  /* ================= 布局尺寸 & 顶栏分隔线 ================= */

  function trackHeight(node, varName) {
    var set = function () { $('app').style.setProperty(varName, node.offsetHeight + 'px'); };
    if (window.ResizeObserver) new ResizeObserver(set).observe(node);
    window.addEventListener('resize', set);
    return set;
  }
  var sizers = [trackHeight($('top'), '--top-h'), trackHeight($('tabbar'), '--tab-h'), trackHeight($('dTop'), '--dtop-h')];
  function syncSizes() { sizers.forEach(function (f) { f(); }); }

  function activePane() { return $('pane-' + state.tab); }
  function updateTopLine() { $('top').classList.toggle('scrolled', activePane().scrollTop > 2); }
  TABS.forEach(function (t) {
    $('pane-' + t).addEventListener('scroll', function () { if (state.tab === t) updateTopLine(); }, { passive: true });
  });
  $('dScroll').addEventListener('scroll', function () { $('dTop').classList.toggle('scrolled', $('dScroll').scrollTop > 2); }, { passive: true });

  /* ================= 接口 ================= */

  function AuthError() { this.name = 'AuthError'; }

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    return fetch(API + path, init).then(function (res) {
      if (opts.raw) return res;
      if (res.status === 401) throw new AuthError();
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.status === 204 ? null : res.json();
    });
  }

  function fail(err) {
    if (err instanceof AuthError) { showLogin('登录已过期'); return; }
    toast('网络不稳定');
  }

  /* ================= 加载中 ================= */

  function loading(box, tag) { box.replaceChildren(el(tag || 'div', 'loading skel-wrap', '✻ 加载中')); }
  function skelBoard() {
    $('summary').hidden = false;
    $('summary').classList.add('is-loading');
    loading($('board'));
  }
  function skelChat(box) { loading(box); }
  function skelLog() { loading($('log'), 'li'); }
  function clearSkel(box) {
    if (box.querySelector('.skel-wrap, .empty')) { box.replaceChildren(); return true; }
    return false;
  }
  function appear(box) { box.classList.remove('appear'); void box.offsetWidth; box.classList.add('appear'); }

  /* ================= 登录 ================= */

  var LOGIN_MSG = { 401: '密码不对', 429: '尝试太频繁，稍后再试', 503: '服务未配置', 400: '请输入密码' };

  function shakeCard() {
    var card = $('loginForm');
    card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  }

  function showLogin(msg) {
    notifyReady();
    stopTimer();
    closeDetail(true);
    $('app').hidden = true;
    $('login').hidden = false;
    $('loginMsg').textContent = msg || '';
    state.batches = []; state.batch = null; state.userPicked = false; state.sig = {}; state.tasks = [];
    ['board', 'chat', 'log', 'dChat', 'dMeta', 'quota'].forEach(function (id) { $(id).replaceChildren(); });
    setTimeout(function () { try { $('pw').focus({ preventScroll: true }); } catch (e) {} }, 300);
  }

  function showApp() {
    notifyReady();
    $('login').hidden = true;
    $('app').hidden = false;
    syncSizes();
    skelBoard(); skelChat($('chat')); skelLog();
    updateTopLine();
    refresh();
    startTimer();
  }

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = $('pw').value;
    if (!pw) { $('loginMsg').textContent = LOGIN_MSG[400]; shakeCard(); return; }
    var btn = $('loginBtn');
    btn.disabled = true; btn.classList.add('loading');
    $('loginMsg').textContent = '';
    api('login', { method: 'POST', body: { password: pw }, raw: true }).then(function (res) {
      if (res.status === 204) { $('pw').value = ''; showApp(); return; }
      $('loginMsg').textContent = LOGIN_MSG[res.status] || ('登录失败 ' + res.status);
      shakeCard();
    }).catch(function () {
      $('loginMsg').textContent = '网络异常';
      shakeCard();
    }).then(function () { btn.disabled = false; btn.classList.remove('loading'); });
  });

  $('logout').addEventListener('click', function () {
    api('logout', { method: 'POST', raw: true }).catch(function () {}).then(function () { showLogin(); });
  });

  /* ================= 增量渲染 ================= */

  // 按 key 复用节点：已有的只改内容，新增的带入场动画
  function reconcile(box, items, keyOf, create, update) {
    var old = new Map();
    Array.prototype.forEach.call(box.children, function (c) { if (c.dataset.key) old.set(c.dataset.key, c); });
    var seen = Object.create(null);
    var fresh = box.childElementCount === 0;
    items.forEach(function (item, i) {
      var k = keyOf(item, i);
      while (seen[k]) k += '~';
      seen[k] = true;
      var node = old.get(k);
      if (node) { old.delete(k); update(node, item); }
      else {
        node = create(item); node.dataset.key = k; update(node, item);
        if (!fresh) node.classList.add('enter');
      }
      if (box.children[i] !== node) box.insertBefore(node, box.children[i] || null);
    });
    old.forEach(function (n) { n.remove(); });
  }

  // 以视口中第一个可见元素为锚点，更新后还原滚动位置
  function keepAnchor(pane, selector, fn) {
    var top = pane.scrollTop, anchor = null, offset = 0;
    if (top > 0) {
      var nodes = pane.querySelectorAll(selector);
      for (var i = 0; i < nodes.length; i++) {
        var r = nodes[i].offsetTop - top;
        if (r + nodes[i].offsetHeight > 0) { anchor = nodes[i]; offset = r; break; }
      }
    }
    fn();
    if (anchor && anchor.isConnected) pane.scrollTop = anchor.offsetTop - offset;
  }

  // 聊天：已在底部则跟随新消息，否则保持阅读位置
  function stickBottom(pane, first, fn) {
    var atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 56;
    fn();
    if (first || atBottom) pane.scrollTop = pane.scrollHeight;
  }

  function changed(key, data) {
    var s = today() + '|' + JSON.stringify(data);
    if (state.sig[key] === s) return false;
    state.sig[key] = s;
    return true;
  }

  /* ================= 批次 ================= */

  function setSync() {
    var cur = batchInfo(state.batch);
    setText($('sync'), cur && cur.synced_at ? fmtTime(cur.synced_at) : '');
  }

  function loadBatches() {
    return api('batches').then(function (list) {
      list = Array.isArray(list) ? list : [];
      state.batches = list;
      var names = list.map(function (b) { return b.batch; });
      if (!state.userPicked || names.indexOf(state.batch) < 0) state.batch = names[0] || null;
      if (changed('batches', list)) renderBatchSelect();
      else $('batch').value = state.batch || '';
      setSync();
    });
  }

  function renderBatchSelect() {
    var sel = $('batch');
    sel.replaceChildren();
    if (!state.batches.length) { sel.appendChild(el('option', '', '—')); sel.disabled = true; return; }
    sel.disabled = false;
    state.batches.forEach(function (b) {
      var o = el('option', '', batchLabel(b));
      o.value = b.batch;
      sel.appendChild(o);
    });
    sel.value = state.batch;
  }

  function switchBatch(name) {
    state.batch = name;
    state.userPicked = state.batches.length > 0 && name !== state.batches[0].batch;
    $('batch').value = name;
    delete state.sig.tasks; delete state.sig.log; delete state.sig.chat;
    state.tasks = [];
    skelBoard();
    $('pane-board').scrollTop = 0; $('pane-log').scrollTop = 0;
    updateTopLine();
    setSync();
  }

  $('batch').addEventListener('change', function (e) {
    switchBatch(e.target.value);
    closeDetail();
    loadView().catch(fail);
  });

  /* ================= 看板 ================= */

  function loadBoard() {
    if (!state.batch) { renderBoard([]); return Promise.resolve(); }
    var b = state.batch;
    return api('tasks?batch=' + encodeURIComponent(b)).then(function (list) {
      if (b !== state.batch) return;
      state.tasks = Array.isArray(list) ? list : [];
      if (state.detail) syncDetailHeader();
      if (changed('tasks', state.tasks)) renderBoard(state.tasks);
    });
  }

  // 额度卡片：看板顶部，随刷新更新，数据没变不重绘
  function loadQuota() {
    if (typeof window.renderQuotaCard !== 'function') return Promise.resolve();
    return api('quota').then(function (list) {
      list = Array.isArray(list) ? list : [];
      if (changed('quota', list)) window.renderQuotaCard($('quota'), list);
    });
  }

  function renderSummary(tasks) {
    var c = { run: 0, done: 0, bad: 0, off: 0 };
    tasks.forEach(function (t) { c[statusInfo(t.status)[1]]++; });
    var total = (tasks.length - c.off) || 1;
    setText($('sumDone'), c.done);
    setText($('sumTotal'), tasks.length - c.off);
    setText($('sumDoneL'), c.done);
    setText($('sumRun'), c.run);
    setText($('sumBad'), c.bad);
    $('sumRun').parentNode.hidden = !c.run;
    $('sumBad').parentNode.hidden = !c.bad;
    $('barDone').style.width = (c.done / total * 100) + '%';
    $('barRun').style.width = (c.run / total * 100) + '%';
    $('barBad').style.width = (c.bad / total * 100) + '%';
    var s = $('summary');
    s.hidden = !tasks.length;
    s.classList.remove('is-loading');
  }

  document.querySelectorAll('[data-jump]').forEach(function (b) {
    b.addEventListener('click', function () {
      var sec = $('board').querySelector('[data-key="g:' + b.dataset.jump + '"]');
      if (sec) sec.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
    });
  });

  function renderBoard(tasks) {
    var pane = $('pane-board'), board = $('board');
    keepAnchor(pane, '.row[data-key]', function () {
      renderSummary(tasks);
      if (!tasks.length) {
        board.replaceChildren(emptyState(state.batch ? '暂无任务' : '暂无批次'));
        return;
      }
      var wasSkel = clearSkel(board);
      var groups = GROUPS.map(function (g) {
        return { id: g[0], label: g[1], items: tasks.filter(function (t) { return statusInfo(t.status)[1] === g[0]; }) };
      }).filter(function (g) { return g.items.length; });
      reconcile(board, groups, function (g) { return 'g:' + g.id; }, function () {
        var sec = el('section', 'group');
        var h = el('h2', 'group-h');
        h.append(el('span', 'l'), el('span', 'n'));
        sec.append(h, el('div', 'list'));
        return sec;
      }, function (sec, g) {
        setClass(sec, 'group g-' + g.id + (sec.classList.contains('enter') ? ' enter' : ''));
        setText(sec.querySelector('.l'), g.label);
        setText(sec.querySelector('.n'), g.items.length);
        reconcile(sec.querySelector('.list'), g.items, function (t) { return 't:' + t.task_id; }, createRow, updateRow);
      });
      if (wasSkel) appear(board);
    });
  }

  function createRow() {
    var r = el('button', 'row');
    r.type = 'button';
    var main = el('div', 'row-main');
    var meta = el('div', 'row-meta');
    meta.append(el('span', 'owner'), el('span', 'st'), el('span', 'retry'), el('span', 'time'));
    main.append(el('div', 'row-title'), meta);
    r.append(el('span', 'ring'), main);
    r.addEventListener('click', function () { openDetail(r.dataset.task); });
    return r;
  }

  function updateRow(r, t) {
    var s = statusInfo(t.status);
    r.dataset.task = t.task_id;
    var ring = r.querySelector('.ring');
    setClass(ring, 'ring ' + s[2]);
    setText(ring, s[3]);
    setText(r.querySelector('.row-title'), t.title || t.task_id);
    var o = r.querySelector('.owner');
    setText(o, t.owner ? who(t.owner) : '未分配');
    setClass(o, 'owner ' + (t.owner ? whoCls(t.owner) : 'c-other'));
    var st = r.querySelector('.st');
    setText(st, s[0]);
    setClass(st, 'st ' + s[2]);
    var retries = t.retries || 0;
    setText(r.querySelector('.retry'), retries > 0 ? '↻' + retries : '');
    setText(r.querySelector('.time'), fmtTime(t.updated_at || t.last_check || t.dispatched_at));
    r.setAttribute('aria-label', (t.title || t.task_id) + '，' + (t.owner ? who(t.owner) : '') + '，' + s[0]);
  }

  /* ================= 消息 ================= */

  // [小黎修正] 丢弃正文和时间都为空的残缺记录（上游事件字段不一致时会出现），避免显示一排「（空）」
  function usable(m) { return !!m && (String(m.body == null ? '' : m.body).trim() !== '' || !!validDate(m.ts)); }
  function isSys(m) { return m.kind === 'event' || m.sender === 'system'; }
  function msgKey(m) {
    return m.id != null ? 'm:' + m.id : 'm:' + [m.batch, m.task_id, m.ts, m.kind, m.sender, (m.body || '').length].join('|');
  }

  // 插入日期分隔；同一人连续发言（同方向、同任务、30 分钟内）合并抬头
  function decorate(list, showTask) {
    var out = [], prev = null, lastDay = null;
    list.forEach(function (m) {
      var d = validDate(m.ts), day = d ? dayOf(d) : null;
      if (day && day !== lastDay) { out.push({ day: day }); lastDay = day; prev = null; }
      var cont = !!prev && !isSys(m) && !isSys(prev) &&
        prev.sender === m.sender &&
        (prev.kind === 'dispatch') === (m.kind === 'dispatch') &&
        (!showTask || (prev.task_id === m.task_id && prev.batch === m.batch)) &&
        Math.abs(tsNum(m.ts) - tsNum(prev.ts)) < 30 * 60 * 1000;
      out.push({ m: m, cont: cont, showTask: showTask });
      prev = m;
    });
    return out;
  }
  function itemKey(it) { return it.day ? 'd:' + it.day : (isSys(it.m) ? 's' : 'b') + msgKey(it.m); }

  function createItem(it) {
    if (it.day) return el('div', 'day');
    if (isSys(it.m)) {
      var s = el('div', 'sys');
      var sh = el('div', 'sys-h');
      sh.append(el('span', 'sts'), el('span', 'tag-wrap'));
      s.append(sh, createFold('sb'));
      return s;
    }
    var w = el('div', 'msg');
    var h = el('div', 'msg-h');
    h.append(el('span', 'dot'), el('span', 'who'), el('span', 'tag-wrap'), el('span', 'ts'));
    w.append(h, createFold('body'));
    return w;
  }

  function setTag(wrap, m, show) {
    var label = show && m.task_id ? taskLabel(m) : '';
    if (wrap.textContent === label) return;
    wrap.replaceChildren();
    if (!label) return;
    var t = el('span', 'tag', label);
    t.setAttribute('role', 'button');
    t.setAttribute('tabindex', '0');
    t.addEventListener('click', function () { openFromFeed(m); });
    wrap.appendChild(t);
  }

  function updateItem(node, it) {
    if (it.day) { setText(node, dayLabel(it.day)); return; }
    var m = it.m;
    setTag(node.querySelector('.tag-wrap'), m, it.showTask);
    if (node.classList.contains('sys')) {
      setText(node.querySelector('.sts'), clock(m.ts));
      setFold(node.querySelector('.fold'), m.body);
      return;
    }
    var out = m.kind === 'dispatch';
    node.classList.toggle('out', out);
    node.classList.toggle('cont', it.cont);
    setText(node.querySelector('.dot'), out ? '>' : '⏺');
    var w = node.querySelector('.who');
    setText(w, who(m.sender));
    setClass(w, 'who ' + whoCls(m.sender));
    node.querySelector('.dot').className = 'dot ' + whoCls(m.sender);
    setText(node.querySelector('.ts'), clock(m.ts));
    setFold(node.querySelector('.fold'), m.body);
  }

  function renderMessages(box, pane, list, showTask) {
    var first = !box.querySelector('[data-key]');
    stickBottom(pane, first, function () {
      if (!list.length) { box.replaceChildren(emptyState('暂无消息')); return; }
      clearSkel(box);
      reconcile(box, decorate(list, showTask), itemKey, createItem, updateItem);
      if (first) appear(box);
    });
  }

  /* ================= 群聊 / 日志 ================= */

  // 按当前批次取消息
  function loadFeed() {
    var b = state.batch;
    return api(b ? 'feed?batch=' + encodeURIComponent(b) : 'feed').then(function (list) {
      if (b !== state.batch) return;
      list = (Array.isArray(list) ? list : []).filter(usable);
      if (state.tab === 'chat') {
        var asc = list.slice().sort(function (a, b2) { return tsNum(a.ts) - tsNum(b2.ts) || ((a.id || 0) - (b2.id || 0)); });
        if (changed('chat', asc)) renderMessages($('chat'), $('pane-chat'), asc, true);
      }
      if (state.tab === 'log') {
        var events = list.filter(function (m) { return m.kind === 'event'; })
          .sort(function (a, b2) { return tsNum(b2.ts) - tsNum(a.ts) || ((b2.id || 0) - (a.id || 0)); });
        if (changed('log', events)) renderLog(events);
      }
    });
  }

  // 事件分类：[样式, 符号]
  function evType(body) {
    var s = String(body || '');
    if (/失败|fail|error|错误|异常|阻塞|block|reject|驳回/i.test(s)) return ['t-bad', '✗'];
    if (/重试|retry|超时|timeout|warn|警告/i.test(s)) return ['t-warn', '!'];
    if (/完成|completed|done|通过|pass|success|成功|merged/i.test(s)) return ['t-ok', '✓'];
    if (/同步|sync/i.test(s)) return ['t-sync', '↻'];
    if (/派发|dispatch|开始|start|创建|create|分配|assign/i.test(s)) return ['t-info', '›'];
    return ['', '·'];
  }

  function renderLog(events) {
    var pane = $('pane-log'), box = $('log');
    keepAnchor(pane, '.ev[data-key]', function () {
      if (!events.length) { box.replaceChildren(emptyState('暂无事件', 'li')); return; }
      var wasSkel = clearSkel(box);
      reconcile(box, events, msgKey, function () {
        var li = el('li', 'ev');
        var h = el('div', 'ev-h');
        h.append(el('span', 'ev-g'), el('span', 'ts'), el('span', 'tag-wrap'));
        li.append(h, createFold('ev-b'));
        return li;
      }, function (li, m) {
        var t = evType(m.body);
        setClass(li, 'ev ' + t[0] + (li.classList.contains('enter') ? ' enter' : ''));
        setText(li.querySelector('.ev-g'), t[1]);
        setText(li.querySelector('.ts'), fmtTime(m.ts));
        setTag(li.querySelector('.tag-wrap'), m, true);
        setFold(li.querySelector('.fold'), m.body);
      });
      if (wasSkel) appear(box);
    });
  }

  function openFromFeed(m) {
    if (!m.task_id) return;
    if (m.batch && m.batch !== state.batch) {
      if (!state.batches.some(function (b) { return b.batch === m.batch; })) return;
      switchBatch(m.batch);
      if (state.tab === 'board') loadBoard().catch(fail);
    }
    openDetail(m.task_id);
  }
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('tag')) { e.preventDefault(); e.target.click(); }
  });

  /* ================= 任务详情 ================= */

  function openDetail(taskId) {
    state.detail = { batch: state.batch, task: taskId };
    delete state.sig.detail;
    $('dMeta').replaceChildren();
    $('dMeta').dataset.raw = '';
    skelChat($('dChat'));
    $('dScroll').scrollTop = 0;
    $('dTop').classList.remove('scrolled');
    syncDetailHeader();
    var d = $('detail');
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    notifyDepth(1);
    syncSizes();
    loadDetail().catch(fail);
    if (!state.tasks.some(function (t) { return t.task_id === taskId; })) loadBoard().catch(fail);
  }

  function closeDetail(instant) {
    var d = $('detail');
    state.detail = null;
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    notifyDepth(0);
    if (instant) { d.style.transition = 'none'; void d.offsetWidth; d.style.transition = ''; }
  }

  $('back').addEventListener('click', function () { closeDetail(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.detail) closeDetail(); });

  function syncDetailHeader() {
    if (!state.detail) return;
    var t = state.tasks.filter(function (x) { return x.task_id === state.detail.task; })[0] || { task_id: state.detail.task };
    var s = statusInfo(t.status);
    setText($('dId'), (state.detail.batch ? batchName(state.detail.batch) + ' / ' : '') + t.task_id);
    var pill = $('dBadge');
    pill.hidden = !t.status;
    setText(pill, s[3] + ' ' + s[0]);
    setClass(pill, 'pill ' + s[2]);
    setText($('dTitle'), t.title || '');
    var bits = [];
    if (t.owner) bits.push([who(t.owner), whoCls(t.owner)]);
    if (t.retries > 0) bits.push(['↻' + t.retries + (t.max_retries != null ? '/' + t.max_retries : ''), 'c-warn']);
    var upd = fmtTime(t.updated_at || t.last_check || t.dispatched_at);
    if (upd) bits.push([upd, '']);
    var meta = $('dMeta'), raw = JSON.stringify(bits);
    if (meta.dataset.raw === raw) return;
    meta.dataset.raw = raw;
    meta.replaceChildren();
    bits.forEach(function (b) { meta.appendChild(el('span', b[1], b[0])); });
  }

  function loadDetail() {
    if (!state.detail) return Promise.resolve();
    var d = state.detail;
    return api('messages?batch=' + encodeURIComponent(d.batch) + '&task=' + encodeURIComponent(d.task)).then(function (list) {
      if (state.detail !== d) return;
      list = (Array.isArray(list) ? list : []).filter(usable);
      if (changed('detail', list)) renderMessages($('dChat'), $('dScroll'), list, false);
    });
  }

  /* ================= 底部导航 ================= */

  $('tabbar').addEventListener('click', function (e) {
    var b = e.target.closest('.tab[data-tab]');
    if (!b) return;
    if (b.dataset.tab === state.tab) {   // 再点当前标签：回顶部（群聊回底部）
      var p = activePane();
      var to = state.tab === 'chat' ? p.scrollHeight : 0;
      p.scrollTo({ top: to, behavior: reduced() ? 'auto' : 'smooth' });
      return;
    }
    setTab(b.dataset.tab);
  });

  function setTab(tab) {
    if (TABS.indexOf(tab) < 0 || tab === state.tab) return;
    state.tab = tab;
    document.querySelectorAll('.tab[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
    document.querySelectorAll('.views .pane').forEach(function (p) { p.classList.toggle('active', p.dataset.pane === tab); });
    updateTopLine();
    loadView().catch(fail);
  }

  /* ================= 刷新 ================= */

  function loadView() {
    var jobs = [];
    if (state.detail) jobs.push(loadDetail());
    if (state.tab === 'board') { jobs.push(loadBoard()); jobs.push(loadQuota()); }
    else jobs.push(loadFeed());
    return Promise.all(jobs);
  }

  function refresh() {
    if (state.busy || $('app').hidden) return Promise.resolve();
    state.busy = true;
    return loadBatches().then(loadView).catch(fail).then(function () { state.busy = false; });
  }

  function startTimer() {
    stopTimer();
    state.timer = setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  }
  function stopTimer() { if (state.timer) clearInterval(state.timer); state.timer = null; }

  document.addEventListener('visibilitychange', function () {
    if ($('app').hidden) return;
    if (document.hidden) stopTimer();
    else { refresh(); startTimer(); }
  });

  // 供测试：一句话摘要
  window.__hubSummarize = summarize;

  /* ================= 启动 ================= */

  api('me').then(function (r) {
    if (r && r.authed) showApp(); else showLogin();
  }).catch(function (err) {
    showLogin(err instanceof AuthError ? '' : '网络异常');
  });
})();
