(function () {
  'use strict';
  var TOOLS = window.TOOLS || [];
  var home = document.getElementById('home');
  var $ = function (s) { return document.querySelector(s); };
  var html = document.documentElement, body = document.body;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var byId = {}, byPath = {};
  TOOLS.forEach(function (t) { byId[t.id] = t; byPath[t.path.replace(/\/+$/, '')] = t; });
  var standalone = window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  if (standalone) html.classList.add('standalone');
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (isIOS) html.classList.add('ios');
  // iOS / 触屏设备：面板开关完全不用 clip-path（真机 WebKit 对带 clip-path 的合成层在隐藏时不重绘，会留下残影），
  // 改为整块 opacity + transform；桌面端保留从卡片展开/收回的 clip-path 动画
  var lite = isIOS || !!(window.matchMedia && matchMedia('(hover: none) and (pointer: coarse)').matches);
  if (lite) html.classList.add('lite');
  // iOS 主屏幕 App 默认当作有原生左缘返回，一开始就关掉自定义 edgeSwipe，不让第一次滑动叠两层
  if (standalone && (isIOS || ls('lm.nativeBack') === '1')) html.classList.add('native-back');
  // 路由切换时不让浏览器自动恢复滚动位置（会与手势返回的快照错位）
  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) {}
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  /* ---------- SVG：只用 createElementNS + setAttribute 构建 ---------- */
  function svg(spec) {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    (spec || []).forEach(function (n) {
      var el = document.createElementNS(SVGNS, n[0]), at = n[1] || {};
      for (var k in at) if (Object.prototype.hasOwnProperty.call(at, k)) el.setAttribute(k, String(at[k]));
      s.appendChild(el);
    });
    return s;
  }
  var BACK = [['path', { d: 'M14.5 5.5 8 12l6.5 6.5' }]];
  function iconBox(t, cls) {
    var b = document.createElement('span'); b.className = cls || 'ic';
    b.appendChild(svg(t.icon)); return b;
  }

  /* ---------- 按压反馈 ----------
     pointerdown 立即加 .press（CSS 里按下 .1s 快速收缩），松开/取消/移出时去掉（CSS 里 .3s ease-out 平稳回位）。
     极快的轻点也至少保持 90ms 按下态，保证肉眼能看到一次完整的「按下-松开」；滚动开始时浏览器发 pointercancel，按下态随即撤销。 */
  function pressable(root, sel) {
    var cur = null, t0 = 0, tm = 0;
    function release() {
      if (!cur) return;
      var el = cur, left = 90 - (Date.now() - t0); cur = null; clearTimeout(tm);
      if (left > 0) tm = setTimeout(function () { el.classList.remove('press'); }, left); else el.classList.remove('press');
    }
    root.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      var el = sel ? e.target.closest(sel) : root;
      if (!el || !root.contains(el)) return;
      clearTimeout(tm); if (cur && cur !== el) cur.classList.remove('press');
      cur = el; t0 = Date.now(); el.classList.add('press');
    });
    root.addEventListener('pointerup', release);
    root.addEventListener('pointercancel', release);
    root.addEventListener('pointerout', function (e) { if (cur && !cur.contains(e.relatedTarget)) release(); });
    window.addEventListener('blur', release);
  }

  /* ---------- 主题 ---------- */
  var mq = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    var pref = ls('lm.theme') || 'light';
    var dark = pref === 'dark' || (pref === 'auto' && mq.matches);
    html.dataset.theme = dark ? 'dark' : 'light'; html.dataset.pref = pref;
    $('#themeColor').setAttribute('content', dark ? '#1f1e1d' : '#faf9f5');
  }
  applyTheme();
  if (mq.addEventListener) mq.addEventListener('change', applyTheme);
  var themeBtn = $('#themeBtn');
  pressable(themeBtn);
  themeBtn.addEventListener('click', function () {
    var order = ['light', 'dark', 'auto'], cur = ls('lm.theme') || 'light';
    var next = order[(order.indexOf(cur) + 1) % 3]; ls('lm.theme', next); applyTheme();
    toast({ light: '浅色', dark: '深色', auto: '跟随系统' }[next]);
    stage.querySelectorAll('iframe').forEach(function (f) { try { f.contentWindow.postMessage({ type: 'theme' }, location.origin); } catch (e) {} });
  });

  /* ---------- 首页：按分类分区，每类第一个（最近打开的）占一整行 ---------- */
  var CATS = window.TOOL_CATS || [{ id: 'tool', name: '工具' }];
  function recent() { try { var r = JSON.parse(ls('lm.shell.recent') || '[]'); return Array.isArray(r) ? r : []; } catch (e) { return []; } }
  function touchRecent(id) { var r = recent().filter(function (x) { return x !== id && byId[x]; }); r.unshift(id); ls('lm.shell.recent', JSON.stringify(r.slice(0, 20))); }
  function rank(id) { var i = recent().indexOf(id); return i < 0 ? 999 : i; }
  function sv(tag, at) { var e = document.createElementNS(SVGNS, tag); for (var k in at) if (Object.prototype.hasOwnProperty.call(at, k)) e.setAttribute(k, String(at[k])); return e; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  /* STM32 学到哪了：学习台每次换页都会发 route 过来，存一份，首页用它写「继续」那一行、点亮对应外设的引脚 */
  var TOPIC = { gpio: 'GPIO', exti: 'EXTI', usart: 'USART', i2c: 'I2C', tim: 'TIM', dma: 'DMA', adc: 'ADC', spi: 'SPI', sys: 'RCC', fsmc: 'FSMC' };
  var TOPIC_PINS = { gpio: [34, 35, 100], exti: [20, 21, 22, 49], usart: [101, 102], i2c: [69, 70], tim: [35, 136, 100], dma: [101, 102], adc: [26, 28], spi: [41, 42, 43, 7], sys: [23, 24, 25], fsmc: [118, 119, 127, 56, 85, 86, 114, 115, 58, 59, 60, 63] };
  var SEC = { points: '要点', pins: '引脚', regs: '寄存器', code: '代码', figs: '图' }, CV = { reg: '寄存器代码', hal: 'HAL 代码', cd: '代码推导' };
  function stmWhere(route) {
    var sp; try { sp = new URLSearchParams(route || ''); } catch (e) { return null; }
    var v = sp.get('v') || 'home', t = sp.get('t'), name = TOPIC[t];
    if (v === 'topic' && name) { var cv = sp.get('cv'), sec = sp.get('sec'); return { t: t, text: name + ' ' + (cv && CV[cv] ? CV[cv] : sec && SEC[sec] ? SEC[sec] : '') }; }
    if (v === 'think') {
      if (!name) return { text: '设计原理' };
      var st = sp.get('s'), m = /^s(\d+)$/.exec(st || '');
      return { t: t, text: name + ' 设计原理' + (m ? ' 第 ' + m[1] + ' 环' : st === 'review' ? ' 复习' : '') };
    }
    if (v === 'board') return { text: '开发板' };
    return null;
  }

  /* 插画 */
  // LQFP144：每边 36 个脚，1 脚在左上，逆时针编号；on 里的脚号点亮
  function artChip(on) {
    var s = sv('svg', { viewBox: '0 0 260 260', 'class': 'art art-chip', 'aria-hidden': 'true' }), g = sv('g', { 'class': 'pins' });
    var B = 50, W = 160, step = W / 36, L = 15, lit = {};
    (on || []).forEach(function (n, k) { lit[n] = k + 1; });
    for (var n = 1; n <= 144; n++) {
      var side = Math.floor((n - 1) / 36), k = (n - 1) % 36, x, y, w, h, c = B + step * (k + 0.5);
      if (side === 0) { x = B - L; y = c - 1.1; w = L; h = 2.2; }
      else if (side === 1) { x = c - 1.1; y = B + W; w = 2.2; h = L; }
      else if (side === 2) { x = B + W; y = B + W - step * (k + 0.5) - 1.1; w = L; h = 2.2; }
      else { x = B + W - step * (k + 0.5) - 1.1; y = B - L; w = 2.2; h = L; }
      var r = sv('rect', { x: x.toFixed(2), y: y.toFixed(2), width: w, height: h, rx: 0.6 });
      if (lit[n]) { r.setAttribute('class', 'on'); r.style.setProperty('--k', String(lit[n])); }
      g.appendChild(r);
    }
    s.appendChild(g);
    s.appendChild(sv('rect', { x: B, y: B, width: W, height: W, rx: 7, 'class': 'body' }));
    s.appendChild(sv('rect', { x: B + 9, y: B + 9, width: W - 18, height: W - 18, rx: 4, 'class': 'bevel' }));
    s.appendChild(sv('rect', { x: B + 15, y: B + 15, width: 10, height: 10, 'class': 'dimple' }));
    var t1 = sv('text', { x: B + W / 2, y: B + W / 2 - 2, 'class': 'mark' }); t1.textContent = 'STM32F103';
    var t2 = sv('text', { x: B + W / 2, y: B + W / 2 + 16, 'class': 'mark sub' }); t2.textContent = 'ZET6';
    s.appendChild(t1); s.appendChild(t2);
    return s;
  }
  // 点阵世界地图：64 × 28，由 data/countries.json 预先算好（每行 16 位十六进制）
  var WORLD = ["001343f00020f0c0", "081de3f0080ffff0", "ffff9bc83dffffff", "1ffe21006ffffffe", "00ff38016fffff88", "007ffc017fffff80", "003ff200ffffffc0", "003fe003b9fffe00", "003fe00327bffe00", "001fc003e3fffc00", "000e4003fffff800", "000e4007fdeffc00", "00030007ffc66400", "00008007ff046400", "00007803ff804000", "00003e003f004800", "00003f003e001900", "00003fc03e000070", "00003fc03e000000", "00001f803e800340", "00000f803c8007c0", "00001f001c000fe0", "00001e001c000fe0", "00001c00100000e0", "0000180000000000", "0000100000000002", "0000100000000000", "0000100000000000"];
  function artWorld() {
    var s = sv('svg', { viewBox: '0 0 384 168', 'class': 'art art-world', 'aria-hidden': 'true' });
    WORLD.forEach(function (row, r) {
      for (var c = 0; c < 64; c++) {
        if ((parseInt(row[c >> 2], 16) >> (3 - (c & 3))) & 1) s.appendChild(sv('rect', { x: c * 6 + 1, y: r * 6 + 1, width: 4, height: 4 }));
      }
    });
    return s;
  }
  function artIcon(t) { var s = svg(t.icon); s.setAttribute('class', 'art art-icon'); return s; }

  function card(t, wide, hero) {
    var a = el('a', 'card' + (wide ? ' wide' : '') + (hero ? ' hero' : '') + (t.art ? ' art-' + t.art : ''));
    a.href = t.path; a.dataset.id = t.id; a.setAttribute('aria-label', t.name);
    var where = t.id === 'stm32' ? stmWhere(ls('lm.shell.stm32')) : null;
    if (t.art === 'chip') a.appendChild(artChip(where && where.t ? TOPIC_PINS[where.t] : []));
    else if (t.art === 'world') a.appendChild(artWorld());
    else a.appendChild(artIcon(t));
    var tx = el('span', 'tx');
    tx.appendChild(iconBox(t));
    tx.appendChild(el('span', 'nm', t.name));
    if (hero && where && where.text) {
      var go = el('span', 'go');
      go.appendChild(svg([['path', { d: 'M9.5 7.5 14 12l-4.5 4.5' }]]));
      go.appendChild(el('span', null, where.text.trim()));
      tx.appendChild(go);
      a.dataset.route = ls('lm.shell.stm32') || '';
      a.setAttribute('aria-label', t.name + '，继续 ' + where.text.trim());
    }
    a.appendChild(tx);
    return a;
  }

  var grid = $('#grid');
  function renderHome() {
    grid.textContent = '';
    var heroId = recent().filter(function (x) { return byId[x]; })[0];
    CATS.concat(TOOLS.some(function (t) { return !CATS.some(function (c) { return c.id === t.cat; }); }) ? [{ id: '', name: '其他' }] : []).forEach(function (c) {
      var list = TOOLS.filter(function (t) { return c.id ? t.cat === c.id : !CATS.some(function (x) { return x.id === t.cat; }); });
      if (!list.length) return;
      list.sort(function (x, y) { return rank(x.id) - rank(y.id); });
      var sec = el('section', 'cat'); sec.dataset.cat = c.id;
      sec.appendChild(el('h2', 'cat-h', c.name));
      var g = el('div', 'cat-g');
      list.forEach(function (t, i) { g.appendChild(card(t, i === 0, t.id === heroId)); });
      sec.appendChild(g); grid.appendChild(sec);
    });
  }
  renderHome();
  // 关掉工具回到首页后，按最新的「最近打开」和学习位置重画（只在没有收拢动画进行时）
  var homeSig = '';
  function sig() { return recent().join() + '|' + (ls('lm.shell.stm32') || ''); }
  homeSig = sig();
  function refreshHome() { var s2 = sig(); if (s2 === homeSig) return; homeSig = s2; renderHome(); html.classList.add('settled'); }

  pressable(grid, '.card');
  pressable($('#cmd'));
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-id]'); if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault(); open(a.dataset.id, { from: a, push: true, route: a.dataset.route });
  });

  /* 搜索：标题栏的放大镜打开搜索框，找不到的卡片和空了的分类藏起来 */
  var q = $('#q'), searchBtn = $('#searchBtn');
  function match(t, s) { return (t.name + ' ' + (t.keywords || '') + ' ' + t.id).toLowerCase().indexOf(s) > -1; }
  function filter() {
    var s = q.value.trim().toLowerCase(), n = 0;
    grid.querySelectorAll('.card[data-id]').forEach(function (c) { var ok = !s || match(byId[c.dataset.id], s); c.classList.toggle('hide', !ok); if (ok) n++; });
    grid.querySelectorAll('.cat').forEach(function (sec) { sec.hidden = !sec.querySelector('.card:not(.hide)'); });
    $('#empty').hidden = n > 0;
  }
  function searching(on) {
    home.classList.toggle('searching', on);
    searchBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) { q.focus(); return; }
    q.value = ''; filter(); q.blur();
  }
  pressable(searchBtn);
  searchBtn.addEventListener('click', function () { searching(!home.classList.contains('searching')); });
  q.addEventListener('input', filter);
  q.addEventListener('blur', function () { if (!q.value.trim()) setTimeout(function () { if (document.activeElement !== q && !q.value.trim()) home.classList.remove('searching'), searchBtn.setAttribute('aria-expanded', 'false'); }, 120); });
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var c = grid.querySelector('.card[data-id]:not(.hide)'); if (c) { q.blur(); open(c.dataset.id, { from: c, push: true, route: c.dataset.route }); } }
    if (e.key === 'Escape') searching(false);
  });
  document.addEventListener('keydown', function (e) {
    if (current) { if (e.key === 'Escape') back(); return; }
    if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && document.activeElement !== q) { e.preventDefault(); searching(true); }
  });

  /* ---------- 提示 ---------- */
  var tt;
  function toast(m) { var t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { t.classList.remove('show'); }, 1400); }

  /* ---------- 工具面板 & 路由 ---------- */
  var stage = $('#stage'), panels = {}, current = null;
  function clip(r) {
    if (!r) return 'inset(0px 0px 0px 0px round 0px)';
    return 'inset(' + r.top + 'px ' + (innerWidth - r.right) + 'px ' + (innerHeight - r.bottom) + 'px ' + r.left + 'px round 12px)';
  }
  function setClip(p, v) { if (lite) v = ''; p.style.clipPath = v; p.style.webkitClipPath = v; }
  /* iframe 地址：embed=1 放最前；当前地址栏就是这个工具的路由时（深链 /stm32?tab=code），把 location.search 透传进去 */
  function frameSrc(t, route) {
    var extra = route || '';
    if (!extra && location.pathname.replace(/\/+$/, '') === t.path.replace(/\/+$/, '') && location.search.length > 1) {
      try { var sp = new URLSearchParams(location.search); sp.delete('embed'); extra = sp.toString(); } catch (e) { extra = ''; }
    }
    return t.src + (t.src.indexOf('?') > -1 ? '&' : '?') + 'embed=1' + (extra ? '&' + extra : '');
  }
  function post(p, msg) { try { p._frame.contentWindow.postMessage(msg, location.origin); } catch (e) {} }
  // 工具被关掉时：让 iframe 收起所有子视图（查看器等），下次打开从干净状态开始
  function resetFrame(p) { if (!p) return; p._depth = 0; p._pendingBack = false; clearTimeout(p._pbT); post(p, { type: 'reset' }); }
  function getPanel(t, route) {
    if (panels[t.id]) return panels[t.id];
    var p = document.createElement('section');
    p.className = 'panel'; p.setAttribute('aria-label', t.name);
    var f = document.createElement('iframe');
    f.title = t.name; f.allow = 'geolocation; fullscreen; clipboard-write'; f.src = frameSrc(t, route);
    var splash = document.createElement('div'); splash.className = 'splash';
    splash.appendChild(iconBox(t));
    var bk = document.createElement('button'); bk.className = 'back'; bk.type = 'button'; bk.setAttribute('aria-label', '返回');
    bk.appendChild(svg(BACK));
    var edge = document.createElement('div'); edge.className = 'edge';
    p.appendChild(f); p.appendChild(splash); p.appendChild(bk); p.appendChild(edge);
    pressable(bk);
    bk.addEventListener('click', back);
    var readyTimer = setTimeout(function () { p.classList.add('ready'); }, 6000);
    f.addEventListener('load', function () { p._depth = 0; setTimeout(function () { p.classList.add('ready'); clearTimeout(readyTimer); }, 2500); });
    p._frame = f; p._ready = function () { clearTimeout(readyTimer); p.classList.add('ready'); };
    edgeSwipe(p);
    stage.appendChild(p); panels[t.id] = p;
    return p;
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    for (var id in panels) if (panels[id]._frame.contentWindow === e.source) {
      var p = panels[id], ty = e.data.type;
      if (ty === 'ready') p._ready();
      if (ty === 'route' && id === 'stm32' && window.STM32StudyCore && typeof e.data.params === 'string' && e.data.params.length < 1600) {
        p._route = window.STM32StudyCore.params(window.STM32StudyCore.fromParams(e.data.params));
        ls('lm.shell.stm32', p._route);
        if (current === id) try { history.replaceState(history.state, '', byId[id].path + (p._route ? '?' + p._route : '')); } catch (err) {}   // 浏览器限流时只是地址没更新，不影响后面的消息处理
      }
      if (ty === 'back' && current === id) back();
      // 工具要求整体关闭（如查看器未开时在 iframe 内按 Escape）
      if (ty === 'close' && current === id) { p._depth = 0; back(); }
      // 工具内部有下一层页面（查看器、任务详情）时报告 depth>0，返回键先交给工具自己退一层
      if (ty === 'depth') onDepth(id, p, Math.max(0, Number(e.data.depth) || 0));
    }
  });
  /* depth 变化同步到历史：0→N 时压一条 {tool,sub:1}，系统/浏览器返回先落在它上面（popstate 里转发 back 给工具）；
     工具自己关掉子视图（N→0）时，把这条 sub 记录退掉，保证再按一次返回就是关闭工具 */
  /* N2：history.back() 是异步的。同一事件循环里「关子视图 → 立即开新的」时，depth 1 到达时 history.state 仍是 sub，
     不能据此跳过 pushState，更不能让随后落到 {tool} 的 popstate 把 back 转发给工具。
     所以 back() 前记 _pendingBack；popstate 落到 {tool} 时先消费它（不转发 back），若此时又有子视图（_depth>0）就补压一条 sub。
     兜底：约 1s 内 popstate 没来也自动解除，按当前 state 补救。 */
  function clearPending(p) { p._pendingBack = false; clearTimeout(p._pbT); }
  function pendBack(id, p) {
    p._pendingBack = true; clearTimeout(p._pbT);
    p._pbT = setTimeout(function () {
      if (!p._pendingBack) return;
      p._pendingBack = false;
      var st = history.state || {};
      if (current !== id || st.tool !== id) return;
      if (st.sub) return;                             // back 根本没发生：sub 还在，与 depth>0 一致；depth 0 时下次返回会被 popstate 清掉
      stripTop();
      if (p._depth > 0) history.pushState({ tool: id, sub: 1 }, '');
    }, 1000);
    history.back();
  }
  /* N3：子视图关闭后去掉顶层地址里的深链参数 page / cw（保留路径、其他参数、hash 和当前 state 对象），刷新不会自动重开 */
  function stripTop() {
    try {
      var sp = new URLSearchParams(location.search);
      if (!sp.has('page') && !sp.has('cw')) return;
      sp.delete('page'); sp.delete('cw');
      var qs = sp.toString();
      history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (e) {}
  }
  function onDepth(id, p, d) {
    var prev = p._depth || 0; p._depth = d;
    if (current !== id) return;
    var st = history.state || {};
    if (p._pendingBack) return;                       // 返回进行中：等 popstate 落地后统一处理
    if (d > 0 && prev === 0 && st.tool === id && !st.sub) history.pushState({ tool: id, sub: 1 }, '');
    else if (d === 0 && prev > 0) {
      if (st.tool === id && st.sub) pendBack(id, p);  // 地址在 popstate 落到 {tool} 后再清
      else stripTop();
    }
  }

  /* 卡片的「真实」位置：关闭时首页还处在 scale(.94) 的过渡起点，直接量出来的是缩小后的矩形。
     这里读出 #home 当前的实际变换矩阵，反算出复原后（scale 1）的卡片位置，面板收拢到卡片最终所在处。 */
  function unscale(r) {
    var m = getComputedStyle(home).transform;
    if (!m || m === 'none') return r;
    var v = m.match(/matrix\(([^)]+)\)/); if (!v) return r;
    v = v[1].split(',').map(parseFloat);
    var a = v[0], d = v[3]; if (!a || !d) return r;
    // 变换原点 50% 30%（与 CSS 一致），按未变换的盒子计算
    var ox = home.offsetLeft - window.scrollX + home.offsetWidth * 0.5;
    var oy = home.offsetTop - window.scrollY + home.offsetHeight * 0.3;
    var tx = v[4], ty = v[5];
    function X(x) { return ox + (x - ox - tx) / a; }
    function Y(y) { return oy + (y - oy - ty) / d; }
    var L = X(r.left), R = X(r.right), T = Y(r.top), B = Y(r.bottom);
    return { left: L, right: R, top: T, bottom: B, width: R - L, height: B - T };
  }
  function cardFor(id) {
    var el = null;
    grid.querySelectorAll('.card[data-id]:not(.hide)').forEach(function (c) { if (c.dataset.id === id) el = c; });
    if (!el) return null; var r = unscale(el.getBoundingClientRect());
    return (r.bottom > 0 && r.top < innerHeight) ? r : null;
  }

  // 每个面板自己的定时器，快速连续开关时先清掉旧的
  function clearTimers(p) { (p._t || []).forEach(clearTimeout); p._t = []; }
  function later(p, fn, ms) { (p._t = p._t || []).push(setTimeout(fn, ms)); }
  // 系统手势（Safari 右滑返回/前进）后直接落到终态：两帧内禁用过渡，画面与 Safari 的快照一致
  function snap() {
    body.classList.add('snap'); void body.offsetWidth;
    requestAnimationFrame(function () { requestAnimationFrame(function () { body.classList.remove('snap'); }); });
  }

  /* 面板彻底复位（幂等）：去掉所有状态类和内联样式；未 .show 的面板是 display:none，合成层被销毁。 */
  // 首页被面板完全盖住后隐藏首页（只在桌面端）；触屏端首页常驻可见，避免 iOS 重新合成整页
  function coverHome() { if (!lite) body.classList.add('covered'); }
  function park(p) {
    if (!p) return;
    clearTimers(p); p._closing = false;
    if (p._te) { p.removeEventListener('transitionend', p._te); p._te = null; }
    p.classList.remove('show', 'anim', 'opened', 'cover', 'fade', 'l-in', 'l-out', 'closing');
    p.style.transform = ''; p.style.opacity = ''; setClip(p, clip());
  }
  // 首页复位：去掉打开工具时加的类、所有按压残留
  function clearPress() { document.querySelectorAll('.press').forEach(function (c) { c.classList.remove('press'); }); }
  function resetHome() {
    body.classList.remove('tool-open', 'locked', 'covered');
    clearPress();
  }
  // 把所有「非当前、且不在收拢动画中」的面板复位；没有当前工具时同时复位首页
  function settle() {
    for (var k in panels) if (k !== current && !panels[k]._closing) park(panels[k]);
    if (!current) {
      resetHome();
      if (!q.value && !home.classList.contains('searching')) refreshHome();
      // 触屏：所有面板都已收起时，让 #stage 重建一次渲染树，确保 WebKit 丢掉任何旧的合成层
      if (lite && !stage.querySelector('.panel.show')) { stage.style.display = 'none'; void stage.offsetHeight; stage.style.display = ''; }
    }
  }

  // 首页「定格」：去掉所有按压态，并在定格期间禁用首页过渡，让被点击的卡片立即回到终态
  function freezeHome() {
    body.classList.add('freeze');
    clearPress();
    if (document.activeElement && document.activeElement.blur && document.activeElement !== q) document.activeElement.blur();
    void body.offsetWidth;                         // 强制 reflow，终态立即生效
  }

  function open(id, o) {
    var t = byId[id]; if (!t) return;
    o = o || {};
    if (current === id) return;
    if (current) close({ instant: true });
    var fresh = !panels[id], p = getPanel(t, o.route); park(p);   // 先彻底复位（可能还在上一次收拢动画中）
    if (fresh && o.route) p._route = o.route;          // 从「继续」进来：地址栏直接带上上次的位置
    current = id; touchRecent(id);
    document.title = t.name + ' · Liming 工具箱';
    var r = o.from ? o.from.getBoundingClientRect() : null;
    freezeHome();
    if (o.push && lite && !o.instant) {
      /* iOS 系统返回手势用的是 pushState 时「屏幕上最后一帧」的快照。
         先让定格后的首页真正画出来（两帧），再 pushState，然后才开始面板动画：
         快照里的首页 = 返回后的真实首页（无按压缩放），逐像素一致。延迟约 30ms，肉眼不可察觉。 */
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        if (current !== id) { body.classList.remove('freeze'); return; }
        history.pushState({ tool: id }, '', t.path);
        body.classList.remove('freeze');
        run();
      }); });
      return;
    }
    if (o.push) history.pushState({ tool: id }, '', t.path);
    body.classList.remove('freeze');
    run();

    function run() {
      if (id === 'stm32' && p._route) history.replaceState(history.state, '', t.path + '?' + p._route);
      if (o.instant || reduce || !r) {
        if (o.instant) snap();
        body.classList.add('tool-open', 'locked');
        setClip(p, clip());
        p.classList.add('show', 'opened');
        coverHome();
      } else if (lite) {
        // 触屏：面板整块从下方轻微上浮 + 淡入，不用 clip-path，也不加 .cover
        body.classList.add('tool-open', 'locked');
        p.classList.add('show', 'l-in');
        void p.offsetWidth;                         // 以 l-in（透明、下移）作为过渡起点
        requestAnimationFrame(function () { if (current !== id) return; p.classList.add('fade'); p.classList.remove('l-in'); });
        later(p, function () { p.classList.add('opened'); }, 200);
        later(p, function () {
          if (current !== id) return;
          p.classList.remove('fade');
          coverHome();
        }, 460);
      } else {
        body.classList.add('tool-open', 'locked');
        if (isIOS) p.classList.add('cover');        // 动画期间盖住 iframe，只对纯色启动页做 clip-path 动画
        setClip(p, clip(r));
        p.classList.add('show');
        void p.offsetWidth;                         // 以 clip(r) 作为过渡起点
        requestAnimationFrame(function () { if (current !== id) return; p.classList.add('anim'); setClip(p, clip()); });
        later(p, function () { p.classList.add('opened'); }, 300);
        later(p, function () {
          if (current !== id) return;
          p.classList.remove('anim', 'cover');      // 揭开 iframe（启动页 0.5s 淡出），去掉 will-change
          coverHome();                              // 首页完全被盖住：桌面端不再参与合成
        }, 620);
      }
    }
  }

  function close(o) {
    if (!current) return;
    o = o || {};
    var id = current, p = panels[id]; current = null; clearTimers(p);
    resetFrame(p);
    document.title = 'Liming 工具箱';
    if (o.instant || reduce) {
      if (o.instant) snap();
      resetHome(); park(p); return;
    }
    body.classList.remove('covered');
    if (lite) {
      // 触屏：关闭开始前先把启动页 display:none、去掉 .cover；然后整块淡出 + 轻微下移缩小，结束后 park() → display:none
      p._closing = true;
      p.classList.remove('cover', 'anim', 'l-in');
      p.classList.add('closing');
      body.classList.remove('tool-open', 'locked');
      void p.offsetWidth;
      p.classList.add('fade', 'l-out');
      var lfin = function () { if (current === id) return; park(p); settle(); };
      p._te = function (e) { if (e.target === p && e.propertyName === 'opacity') lfin(); };
      p.addEventListener('transitionend', p._te);
      later(p, lfin, 380);                           // 兜底：transitionend 没触发也一定复位
      setTimeout(function () { if (!current) { for (var k in panels) panels[k]._closing = false; settle(); } }, 1000);
      return;
    }
    var r = cardFor(id);                            // 在去掉 tool-open 之前量，再按实际变换反算
    body.classList.remove('tool-open', 'locked');
    p._closing = true;
    if (isIOS) p.classList.add('cover');
    p.classList.add('anim');
    if (r) setClip(p, clip(r)); else { p.style.transform = 'translateX(30%)'; p.style.opacity = '0'; }
    var fin = function () { if (current === id) return; park(p); settle(); };
    p._te = function (e) { if (e.target === p) fin(); };
    p.addEventListener('transitionend', p._te);     // 正常情况：动画结束即复位
    later(p, fin, 650);                             // 兜底：transitionend 没触发（iOS 常见）也一定复位
    setTimeout(function () { if (!current) { for (var k in panels) panels[k]._closing = false; settle(); } }, 1200);
  }

  function back() {
    if (!current) return;
    var cp = panels[current], st = history.state || {};
    if (cp && cp._depth > 0) {
      // 有 sub 记录：走历史返回，popstate 里再把 back 转给工具（历史与界面保持一致）
      if (st.tool === current && st.sub && !cp._pendingBack) { history.back(); return; }
      // 返回进行中（sub 已在退）或没有 sub：直接让工具退一层，popstate 落地时不会再补压
      cp._depth = 0; post(cp, { type: 'back' }); if (!cp._pendingBack) stripTop(); return;
    }
    var viaHistory = st.tool === current;
    var steps = st.sub && !(cp && cp._pendingBack) ? -2 : -1;   // 已在退 sub 时只再退一步
    if (cp) clearPending(cp);
    close();
    if (viaHistory) history.go(steps); else history.replaceState({}, '', '/');
  }

  // 只按历史状态同步；自己调用 history.back() 时 current 已是 null，这里不会打断正在进行的收拢动画
  window.addEventListener('popstate', function (e) {
    if (edgeDrag) { ls('lm.nativeBack', '1'); html.classList.add('native-back'); edgeDrag = null; }
    var st = e.state || {}, id = st.tool;
    if (id && byId[id] && id === current) {
      var cp = panels[id];
      // 自己（onDepth）发出的 back 落地：消费标记、不转发；期间工具又开了子视图就补压一条 sub
      if (!st.sub && cp && cp._pendingBack) {
        clearPending(cp);
        stripTop();
        if (cp._depth > 0) history.pushState({ tool: id, sub: 1 }, '');
        return;
      }
      // 从 {tool,sub} 退回 {tool}：只关工具里的子视图（查看器），不关工具
      if (!st.sub && cp && cp._depth > 0) { cp._depth = 0; post(cp, { type: 'back' }); stripTop(); }
      // 前进到一条已失效的 sub 记录（子视图早已关闭）：退回去，不留空记录
      else if (st.sub && cp && !(cp._depth > 0)) history.back();
      else if (!st.sub) stripTop();
      return;
    }
    for (var pk in panels) clearPending(panels[pk]);
    if (id && byId[id]) open(id, { instant: true });
    else if (current) close({ instant: true });     // Safari 手势已经播过动画：直接到终态
    else settle();
  });

  // bfcache 恢复：按历史状态把一切摆到终态
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    var id = history.state && history.state.tool;
    if (id && id !== current) open(id, { instant: true });
    else if (!id && current) close({ instant: true });
    snap(); for (var k in panels) panels[k]._closing = false; settle();
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) settle(); });

  /* PWA 全屏模式下自己实现左缘滑动返回。
     - 只有面板在动：触屏端首页本来就是终态，面板下方直接露出
     - 先判定方向（横向 > 8px 且大于纵向）才开始拖，避免误触
     - touchcancel = 系统手势接管：立即无动画复位，不自己再做返回
     - 拖动期间如果收到 popstate，说明系统也有原生返回手势：记住，此后不再启用自定义手势 */
  var edgeDrag = null;
  function edgeSwipe(p) {
    var edge = p.querySelector('.edge'), x0 = 0, y0 = 0, dx = 0, on = false, moving = false;
    function rest(animated) {
      on = false; moving = false; if (edgeDrag === p) edgeDrag = null;
      if (!animated) { p.classList.remove('anim'); p.style.transform = ''; return; }
      var cur = current; p.classList.add('anim'); p.style.transform = '';
      later(p, function () { if (current === cur) { p.classList.remove('anim'); coverHome(); } }, 480);
    }
    edge.addEventListener('touchstart', function (e) {
      if (html.classList.contains('native-back') || !current) return;
      on = true; moving = false; dx = 0; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    edge.addEventListener('touchmove', function (e) {
      if (!on) return;
      var mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
      if (!moving) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        if (mx <= 0 || Math.abs(my) > Math.abs(mx)) { on = false; return; }     // 不是向右的横滑：放弃
        moving = true; edgeDrag = p; clearTimers(p);
        p.classList.remove('anim', 'cover', 'fade', 'l-in'); body.classList.remove('covered');
        if (!lite) body.classList.remove('tool-open');                           // 桌面端也让首页直接以终态露出
      }
      if (e.cancelable) e.preventDefault();                                     // 拖动开始后独占这次触摸
      dx = Math.max(0, mx);
      p.style.transform = 'translate3d(' + dx + 'px,0,0)';
    }, { passive: false });
    edge.addEventListener('touchend', function () {
      if (!on) return;
      if (!moving) { on = false; return; }
      on = false; moving = false; if (edgeDrag === p) edgeDrag = null;
      if (dx > innerWidth * 0.3 && current) {
        var id = current, pend = p._pendingBack; current = null; p._closing = true;
        resetFrame(p);
        p.classList.add('anim'); p.style.transform = 'translate3d(100%,0,0)';
        body.classList.remove('tool-open', 'locked', 'covered');
        document.title = 'Liming 工具箱';
        var hs = history.state || {};
        if (hs.tool === id) history.go(hs.sub && !pend ? -2 : -1);                       // 系统手势已经返回过就不再返回一次
        later(p, function () { if (current !== id) { park(p); settle(); } }, 480);
        setTimeout(function () { if (!current) { for (var k in panels) panels[k]._closing = false; settle(); } }, 1200);
      } else {
        if (!lite) body.classList.add('tool-open');
        rest(true);
      }
    });
    edge.addEventListener('touchcancel', function () { if (on || moving) rest(false); });
  }

  /* 初始路由 */
  var path = location.pathname.replace(/\/+$/, '');
  var initial = byPath[path];
  if (initial) {
    // 先记下 search/hash：replaceState('/') 之后 location.search 就没了（深链 ?tab= / ?page= 靠它透传进 iframe）
    var qs0 = location.search, hash0 = location.hash;
    history.replaceState({}, '', '/');
    history.pushState({ tool: initial.id }, '', initial.path + qs0 + hash0);
    open(initial.id, { instant: true });
  } else if (path && path !== '/' && path !== '/index.html') {
    history.replaceState({}, '', '/');
  }
  // 首屏入场动画播完后彻底关掉 card 的 animation，之后任何重新合成、显示切换都不会再补播
  setTimeout(function () { html.classList.add('settled'); }, 1600);
  window.LimingShell = { open: open, back: back, tools: TOOLS };
})();