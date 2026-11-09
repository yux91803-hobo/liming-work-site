/* app.js — 布局、路由、返回栈、外壳通信、全局搜索、启动
   返回栈：stack 里每一项是一个路由（study-core.target 的结果），idx 指向当前。
   - 独立打开：每次前进 pushState，浏览器返回触发 popstate 落到对应项；
   - 嵌在工具箱里：不动顶层历史，把 idx 当作 depth 报给外壳，外壳的返回键发 {type:'back'} 回来，这里退一项。
   - 去的页面已经在返回路径上（GPIO → USART → GPIO）：退回到那一项，不再叠一层，返回时不会在同几页之间来回；
     同一页只是换了分页 / 参数：原地替换；回首页：返回栈清空。「哪一页」见 study-core 的 pageKey / backTo。
   页面层级由路由决定：基础视图（v/t）→ 寄存器面板（reg）→ 查看器（cw / fig / sch）。 */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, M = STM.model, core = window.STM32StudyCore;
  var el = ui.el, html = document.documentElement;
  var embedded = html.classList.contains('embed');
  var LAYER_VIEW = ['cw', 'fig', 'sch'], LAYER_REG = ['reg', 'i', 'n', 'val'];

  /* ---------- 主题 ---------- */
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    var t = ui.lsGet('lm.theme') || 'light', dark = t === 'dark' || (t === 'auto' && mq && mq.matches);
    html.setAttribute('data-theme', dark ? 'dark' : 'light');
    M.topics.forEach(function (t) { html.style.setProperty('--stm-' + t.id, t.hue[dark ? 1 : 0]); });
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', dark ? '#1f1e1d' : '#faf9f5');
  }
  applyTheme();
  if (mq) (mq.addEventListener ? mq.addEventListener('change', applyTheme) : mq.addListener(applyTheme));
  window.addEventListener('storage', function (e) { if (e.key === 'lm.theme') applyTheme(); });

  /* ---------- 外壳通信 ---------- */
  function toShell(msg) { if (!embedded) return; try { parent.postMessage(msg, location.origin); } catch (e) {} }
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'theme') applyTheme();
    if (e.source !== window.parent) return;
    if (e.data.type === 'back') back();
    if (e.data.type === 'reset') { search.close(); stack = [{ v: 'home' }]; scrolls = [0]; idx = 0; render(); }
  });

  /* ---------- 路由 ---------- */
  var stack = [], scrolls = [], idx = 0, shown = null, view = null, viewKey = '';
  function notifyDepth() {
    var overlays = (html.classList.contains('drawer') ? 1 : 0) + (search && search.isOpen() ? 1 : 0);
    toShell({ type: 'depth', depth: idx + overlays });
  }
  function cur() { return stack[idx] || { v: 'home' }; }
  function strip(r, keys) { var o = Object.assign({}, r); keys.forEach(function (k) { delete o[k]; }); return o; }
  // 只给了一层（{reg} 或 {fig}）时叠在当前页上；给了 v 就是完整路由
  function resolve(to) {
    to = to || {};
    var base = cur(), out;
    if (to.v) out = to;
    else if (to.cw || to.fig || to.sch) out = Object.assign(strip(base, LAYER_VIEW), to);
    else if (to.reg) out = Object.assign(strip(base, LAYER_VIEW.concat(LAYER_REG)), to);
    else out = Object.assign({}, base, to);
    var t = core.target(out);
    // 寄存器 / 片段没给主题时，补上它所属的主题
    if (t.v === 'topic' && !t.t) { var tp = (t.reg && M.topicOfReg(t.reg)) || (t.snip && M.topicOfSnip(t.snip)); if (tp) t.t = tp.id; else t = strip(t, ['snip']); }
    if (t.v === 'topic' && !M.topicById[t.t]) { t.v = 'home'; delete t.t; delete t.snip; }
    // 代码推导挪到了外设页「代码」里：旧的 think&s=code、没有推导链的 think&t=… 都转过去
    if (t.v === 'think' && t.t && (t.s === 'code' || !(STM.think && STM.think.chapter(t.t))) && STM.codederive && STM.codederive.has(t.t) && M.topicById[t.t]) t = { v: 'topic', t: t.t, sec: 'code', cv: 'cd' };
    if (t.v === 'think' && t.t && !(STM.think && STM.think.chapter(t.t))) { delete t.t; delete t.p; delete t.s; }
    if (t.v === 'lab' && t.t && !(window.STM32Lab && STM32Lab.chapter(t.t))) { delete t.t; delete t.st; delete t.fn; }
    if (t.v === 'lab' && t.st && STM.labprog && STM.labprog.OLD[t.st]) t.st = STM.labprog.OLD[t.st];   // 旧地址：需求 / 硬件 / .c … → 新的五步
    if (t.s && !(STM.derive && STM.derive.validStep(t.t, t.s))) delete t.s;
    if (t.reg && !M.R.reg(t.reg)) t = strip(t, LAYER_REG);
    return t;
  }
  function urlOf(r) { var qs = core.params(r); if (embedded) qs = 'embed=1' + (qs ? '&' + qs : ''); return location.pathname + (qs ? '?' + qs : ''); }
  function saveScroll() { scrolls[idx] = window.scrollY || 0; }

  var popping = null;   // 独立打开时退回到返回栈里已有的一项：等 popstate 落地，再换成这次要的参数
  function popTo(j, r) {
    if (embedded) { stack = stack.slice(0, j + 1); scrolls = scrolls.slice(0, j + 1); idx = j; stack[j] = r; scrolls[j] = 0; render(); return; }
    popping = { j: j, r: r };
    history.go(j - idx);
  }
  function navigate(to, o) {
    o = o || {};
    var r = resolve(to);
    if (core.same(r, cur()) && !o.force) return;
    saveScroll();
    // 离开前提交节流中的分页 / 文件参数，浏览器返回才能拿到最新的来源位置。
    if (!embedded) try { if (location.pathname + location.search !== urlOf(cur())) history.replaceState({ stm: idx, r: cur() }, '', urlOf(cur())); } catch (e) {}
    if (!o.replace) {
      var j = core.backTo(stack, idx, r);   // 哪些算「同一页」见 study-core 的 pageKey
      if (j === idx) o = Object.assign({}, o, { replace: true });   // 同一页，只是换了分页 / 参数
      else if (j >= 0) { popTo(j, r); return; }                      // 这一页在返回路径上（或回首页）：退回去
    }
    if (o.replace) { stack[idx] = r; scrolls[idx] = 0; if (!embedded) try { history.replaceState({ stm: idx, r: r }, '', urlOf(r)); } catch (e) {} }
    else {
      stack = stack.slice(0, idx + 1); scrolls = scrolls.slice(0, idx + 1);
      stack.push(r); scrolls.push(0); idx++;
      if (!embedded) try { history.pushState({ stm: idx, r: r }, '', urlOf(r)); } catch (e) {}
    }
    render();
  }
  // 原地更新（输入筛选词、改计算值、选引脚）：不新增返回记录
  function update(patch) {
    var r = Object.assign({}, cur(), patch);
    Object.keys(patch).forEach(function (k) { if (patch[k] == null) delete r[k]; });
    r = core.target(r);
    if (core.same(r, cur())) return;
    stack[idx] = r;
    if (!embedded) syncUrlSoon();
    render({ soft: true });
  }
  function back() {
    if (search && search.isOpen()) { search.close(); return; }
    if (html.classList.contains('drawer')) { drawer(false); return; }
    if (idx > 0) {
      if (!embedded) { history.back(); return; }
      saveScroll(); idx--; render({ restore: true }); return;
    }
    if (cur().v !== 'home' || core.params(cur())) { navigate({ v: 'home' }, { replace: true }); return; }
    if (embedded) toShell({ type: 'close' });
  }
  window.addEventListener('popstate', function (e) {
    var st = e.state;
    saveScroll();
    if (st && typeof st.stm === 'number') { idx = st.stm; stack[idx] = core.target(st.r); }
    else { idx = 0; stack[0] = core.fromParams(location.search); }
    if (popping && popping.j === idx) {
      stack[idx] = popping.r; stack.length = idx + 1; scrolls.length = idx + 1; scrolls[idx] = 0;
      try { history.replaceState({ stm: idx, r: popping.r }, '', urlOf(popping.r)); } catch (err) {}
    }
    popping = null;
    render({ restore: true });
  });

  /* 地址同步节流：单次操作下一帧，连续操作最多每 300ms 一次（浏览器对 replaceState 有频率上限） */
  var urlT = 0, urlLast = 0;
  function syncUrlNow() {
    if (urlT) clearTimeout(urlT);
    urlT = 0; urlLast = Date.now();
    var r = cur();
    try { if (location.pathname + location.search !== urlOf(r)) history.replaceState(embedded ? history.state : { stm: idx, r: r }, '', urlOf(r)); } catch (e) {}
    toShell({ type: 'route', params: core.params(r) });
  }
  function syncUrlSoon() {
    if (urlT) return;
    var wait = Math.max(0, 300 - (Date.now() - urlLast));
    urlT = setTimeout(syncUrlNow, wait);
  }

  /* ---------- 布局：侧栏（宽屏）/ 顶栏（窄屏） ---------- */
  var side = document.getElementById('side'), bar = document.getElementById('bar'), main = document.getElementById('main');
  var NAV = [['home', '首页', 'chip'], ['board', '开发板', 'board'], ['lab', '编程思维', 'idea'], ['think', '硬件原理', 'bolt']];
  function hue(t) { return t ? 'var(--stm-' + t.id + ')' : ''; }
  function link(route, cls, label) {
    var a = el('a', cls); a.href = urlOf(resolve(route));
    a.addEventListener('click', function (e) { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return; e.preventDefault(); navigate(route); });
    if (label) a.setAttribute('aria-label', label);
    return a;
  }
  function buildSide() {
    var brand = el(embedded ? 'div' : 'a', 'brand');
    if (!embedded) { brand.href = '/'; brand.title = '回到工具箱'; brand.setAttribute('aria-label', '回到工具箱首页'); }   // 直接打开学习台时也能回工具箱
    var sp = el('span', 'brand-spark', '✻'); sp.setAttribute('aria-hidden', 'true'); brand.appendChild(sp);   // 与工具箱首页同一个符号
    var bt = el('div', 'brand-t'); bt.appendChild(el('b', null, 'STM32F103')); bt.appendChild(el('span', null, '学习台')); brand.appendChild(bt);
    side.appendChild(brand);
    var sb = ui.btn('side-search', null, '搜索'); sb.appendChild(ui.icon('search')); sb.appendChild(el('span', null, '搜索')); sb.appendChild(el('kbd', null, '/'));
    sb.addEventListener('click', function () { search.open(); });
    side.appendChild(sb);
    var nav = el('nav', 'side-nav'); nav.setAttribute('aria-label', '资料');
    NAV.forEach(function (n) { var a = link({ v: n[0] }, 'nav-i'); a.dataset.v = n[0]; a.appendChild(ui.icon(n[2])); a.appendChild(el('span', null, n[1])); nav.appendChild(a); });
    side.appendChild(nav);
    // 「外设」标题：点一下把下面的外设列表收起来 / 展开，记住上次的状态
    var hh = el('h2', 'side-h'), tg = ui.btn('side-tg', null);
    tg.appendChild(el('span', null, '外设')); tg.appendChild(ui.icon('next', 'ic side-tg-i'));
    tg.setAttribute('aria-controls', 'side-topics'); hh.appendChild(tg); side.appendChild(hh);
    var tl = el('nav', 'side-topics'); tl.id = 'side-topics'; tl.setAttribute('aria-label', '外设');
    var fold = function (on) { tl.hidden = on; tg.setAttribute('aria-expanded', String(!on)); hh.classList.toggle('folded', on); };
    fold(ui.lsGet('lm.stm.topicsFold') === '1');
    tg.addEventListener('click', function () { var on = !tl.hidden; fold(on); ui.lsSet('lm.stm.topicsFold', on ? '1' : '0'); });
    M.topics.forEach(function (t) {
      var a = link({ v: 'topic', t: t.id }, 'nav-t'); a.dataset.t = t.id; a.style.setProperty('--h', hue(t));
      a.appendChild(el('span', 'nav-code', t.code));
      tl.appendChild(a);
    });
    side.appendChild(tl);
  }
  /* 手机：侧栏做成从左边滑出的抽屉 */
  var scrim = el('div', 'scrim'), menuBtn;
  function drawer(open) {
    var on = open == null ? !html.classList.contains('drawer') : !!open;
    if (on === html.classList.contains('drawer')) return;
    html.classList.toggle('drawer', on);
    if (menuBtn) menuBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) { var f = side.querySelector('.nav-i.on, .nav-t.on') || side.querySelector('a'); if (f) try { f.focus({ preventScroll: true }); } catch (e) {} }
    else if (menuBtn && side.contains(document.activeElement)) try { menuBtn.focus({ preventScroll: true }); } catch (e) {}
    notifyDepth();
  }
  scrim.addEventListener('click', function () { drawer(false); });
  var barBack, barTitle;
  function buildBar() {
    menuBtn = ui.btn('bar-btn bar-menu', null, '目录'); menuBtn.appendChild(ui.icon('menu'));
    menuBtn.setAttribute('aria-expanded', 'false'); menuBtn.setAttribute('aria-controls', 'side');
    menuBtn.addEventListener('click', function () { drawer(); });
    bar.appendChild(menuBtn);
    barBack = ui.btn('bar-btn bar-back', null, '返回'); barBack.appendChild(ui.icon('back'));
    barBack.addEventListener('click', back);
    barTitle = el('div', 'bar-title');
    var s = ui.btn('bar-btn', null, '搜索'); s.appendChild(ui.icon('search')); s.addEventListener('click', function () { search.open(); });
    bar.appendChild(barBack); bar.appendChild(barTitle); bar.appendChild(s);
  }
  function syncChrome(r, title) {
    Array.prototype.forEach.call(side.querySelectorAll('.nav-i'), function (a) { var on = a.dataset.v === r.v && r.v !== 'topic'; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    Array.prototype.forEach.call(side.querySelectorAll('.nav-t'), function (a) { var on = r.v === 'topic' && a.dataset.t === r.t; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    barBack.hidden = embedded || r.v === 'home';
    barTitle.textContent = title;
    document.title = (r.v === 'home' ? '' : title + ' · ') + 'STM32 学习台';
    var t = (r.v === 'topic' || r.v === 'think') && r.t ? M.topicById[r.t] : r.v === 'lab' && r.t && window.STM32Lab && STM32Lab.chapter(r.t) ? M.topicById[STM32Lab.chapter(r.t).topic] : null;
    html.style.setProperty('--h', t ? hue(t) : '');
    html.classList.toggle('in-topic', !!t);
  }

  /* ---------- 渲染 ---------- */
  function keyOf(r) { return r.v + '|' + (r.t || ''); }
  function render(o) {
    o = o || {};
    drawer(false);
    var r = cur(), k = keyOf(r), fresh = k !== viewKey;
    if(STM.learning)STM.learning.view(r);
    if (fresh) {
      if (view && view.destroy) view.destroy();
      ui.clear(main);
      view = STM.views[r.v](main, r, api);
      viewKey = k;
      var y = scrolls[idx] || 0;
      window.scrollTo(0, y);
      if (!o.soft && !y && shown) try { main.focus({ preventScroll: true }); } catch (e) {}
    } else if (view && view.update) view.update(r);
    syncChrome(r, view && view.title ? view.title(r) : 'STM32 学习台');
    STM.regview.sync(r);
    STM.viewer.sync(r);
    shown = r;
    if (o.restore) window.scrollTo(0, scrolls[idx] || 0);
    // Structural navigation must reach the shell before a refresh can restore an old overlay.
    if (o.soft) syncUrlSoon(); else syncUrlNow();
    notifyDepth();
  }

  /* ---------- 全局搜索 ---------- */
  var KINDS = [['topic', '外设'], ['reg', '寄存器'], ['pin', '引脚'], ['code', '代码'], ['fig', '架构图'], ['board', '开发板'], ['sch', '原理图']];
  var search = (function () {
    var box = el('div', 'search'), panel = el('div', 'search-p'), row = el('div', 'search-row'), input = el('input', 'search-in'), list = el('div', 'search-list');
    var hint = el('p', 'search-hint');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', '搜索');
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'true');
    input.type = 'text'; input.placeholder = '引脚、寄存器、外设、模块…'; input.setAttribute('aria-label', '搜索');
    input.setAttribute('autocomplete', 'off'); input.setAttribute('autocapitalize', 'characters'); input.setAttribute('spellcheck', 'false'); input.setAttribute('enterkeyhint', 'search');
    list.id = 'search-list'; list.setAttribute('role', 'listbox'); input.setAttribute('aria-controls', list.id);
    row.appendChild(ui.icon('search')); row.appendChild(input);
    var x = ui.btn('search-x', '取消'); x.addEventListener('click', close); row.appendChild(x);
    panel.appendChild(row); panel.appendChild(hint); panel.appendChild(list); box.appendChild(panel);
    box.addEventListener('mousedown', function (e) { if (e.target === box) close(); });
    var open_ = false, lastFocus = null, sel = 0, items = [], query = '', dirty = false;
    function open() {
      if (open_) { input.focus(); input.select(); return; }
      open_ = true; lastFocus = document.activeElement;
      document.getElementById('layers').appendChild(box);
      ui.modal(box, true);
      requestAnimationFrame(function () { if (open_) box.classList.add('on'); });
      input.value = ''; run(); input.focus();
      notifyDepth();
    }
    function close() {
      if (!open_) return;
      open_ = false; box.classList.remove('on'); ui.modal(box, false); box.remove();
      if (lastFocus && lastFocus.isConnected) try { lastFocus.focus({ preventScroll: true }); } catch (e) {}
      notifyDepth();
    }
    function pick(it) { close(); navigate(it.kind === 'reg' && cur().v === 'topic' ? { reg: it.route.reg } : it.route); }
    function run() {
      if (!open_) return;
      ui.clear(list); items = []; sel = 0;
      input.removeAttribute('aria-activedescendant');
      var q = input.value.trim(); query = q; dirty = false;
      if (!q) { hint.textContent = '试试：PA9、BRR、串口、定时器 PWM、GPIOA_CRL'; return; }
      var found = core.search(M.buildIndex(), q);
      hint.textContent = found.length ? '' : '没找到「' + q + '」。换个写法试试，比如引脚名 PA9、寄存器名 USART_BRR 或外设名。';
      KINDS.forEach(function (k) {
        var hits = found.filter(function (it) { return it.kind === k[0]; });
        if (!hits.length) return;
        var g = el('section', 'search-g'), h = el('h3', null, k[1]);
        if (hits.length > 8) h.appendChild(el('span', null, '前 8 / ' + hits.length));
        g.appendChild(h);
        hits.slice(0, 8).forEach(function (it) {
          var b = el('button', 'search-it'); b.type = 'button'; b.setAttribute('role', 'option');
          b.tabIndex = -1; b.id = 'search-option-' + items.length;
          b.appendChild(el('b', it.kind === 'reg' || it.kind === 'pin' ? 'mono' : null, it.title));
          if (it.detail) b.appendChild(el('span', null, it.detail));
          b.addEventListener('click', function () { pick(it); });
          b.addEventListener('mousemove', function () { focusItem(items.indexOf(b), true); });
          items.push(b); g.appendChild(b);
        });
        list.appendChild(g);
      });
      focusItem(0, true);
    }
    function focusItem(i, quiet) {
      if (!items.length) return;
      sel = Math.max(0, Math.min(items.length - 1, i));
      input.setAttribute('aria-activedescendant', items[sel].id);
      items.forEach(function (b, j) { b.classList.toggle('on', j === sel); b.setAttribute('aria-selected', j === sel ? 'true' : 'false'); });
      if (!quiet) items[sel].scrollIntoView({ block: 'nearest' });
    }
    var runSoon = ui.debounce(function () { if (dirty) run(); }, 60);
    input.addEventListener('input', function () { dirty = true; ui.clear(list); items = []; input.removeAttribute('aria-activedescendant'); runSoon(); });
    input.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (/^(ArrowDown|ArrowUp|Enter)$/.test(e.key) && (dirty || query !== input.value.trim())) run();
      if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(sel + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(sel - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) items[sel].click(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    box.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === input ? x : input).focus(); }
    });
    return { open: open, close: close, isOpen: function () { return open_; } };
  })();

  /* ---------- 键盘 ---------- */
  function typing(n) { return !!n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName || '')); }
  document.addEventListener('keydown', function (e) {
    if (search.isOpen()) return;
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); search.open(); return; }
    if (e.key === '/' && !typing(e.target) && !e.metaKey && !e.ctrlKey) { e.preventDefault(); search.open(); return; }
    if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) {
      if (html.classList.contains('drawer')) { e.preventDefault(); drawer(false); return; }
      if (typing(e.target) && e.target.value) return;   // 输入框里先清空自己的内容
      e.preventDefault(); back();
    }
  });

  /* ---------- 启动 ---------- */
  var api = { navigate: navigate, update: update, back: back, link: link, route: cur, hue: hue, urlOf: urlOf, embedded: embedded, openSearch: function () { search.open(); } };
  STM.app = api;
  buildSide(); buildBar(); document.getElementById('app').appendChild(scrim);
  STM.regview.init(api); STM.viewer.init(api);
  var first = resolve(core.fromParams(location.search));
  stack = [{ v: 'home' }]; scrolls = [0]; idx = 0;
  if (!embedded) try { history.replaceState({ stm: 0, r: stack[0] }, '', urlOf(stack[0])); } catch (e) {}
  if (core.params(first)) navigate(first); else render();
  window.addEventListener('pageshow', function (e) { if (e.persisted) render({ soft: true }); });
  requestAnimationFrame(function () { html.classList.add('ready'); try { if (window.self !== window.top) parent.postMessage({ type: 'ready' }, location.origin); } catch (e) {} });
})();
