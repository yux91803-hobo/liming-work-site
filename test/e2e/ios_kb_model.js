/* 测试用：在 Chromium 里扮演 iPhone Safari 弹键盘（Chromium 没有软键盘，也不会替输入框挪可见区域）。
   按 WebKit 的行为建模（来源见 docs/CHANGES.md 2026-11-21「整页弹一下」「输入框慢半拍」两条）：
   - 键盘的位置按站长 11-21 11:56 真 iPhone 录屏逐帧量出来的曲线走（OPEN / CLOSE：键盘开始动以后多少毫秒、走了全程的几成）。
     弹起约 250ms 走完 98%、后面还有一段很慢的尾巴；收起约 200ms 滑出屏幕。这里 K = 键盘高 336px（390×844 的手机）。
   - visualViewport 的 height 不是键盘一动就变：录屏里弹起时晚 45~104ms（取 48ms），收起时晚 53~59ms（取 55ms），
     那时键盘已经走了 40%~55%；变的那一刻发一次 resize（React Aria runAfterKeyboard：WebKit 只发一次）。
   - 手指点输入框获得焦点、这次 focus 没带 preventScroll 时，Safari 把整页往上挪（_zoomToFocusRect），让输入框露在键盘上面，
     挪的过程跟着键盘走；带了 preventScroll 就不挪（WebKit bug 236584 修好以后）。offsetTop 直接报挪完的值，scroll 事件等挪完才发（WebKit bug 218465）。
   - 屏幕上看到的位置 = 页面里的位置 − 眼下实际挪了多少（P）。Chromium 自己不会挪，所以 P 由这里按时间算出来，量位置时减掉。
   用法：顶层页面 add_init_script 本文件；iframe 里的 focus 由 window.__iosKbHook(frameWindow) 接上。 */
(function () {
  if (window.top !== window) return;
  var K = 336, H0 = 0;
  // 录屏量出来的（ms, 走了几成）。OPEN：弹起第 2 次（3.102s 起）；CLOSE：收起第 2 次（4.314s 起），1.0 = 滑出屏幕
  var OPEN = [[0, 0], [15, .116], [32, .244], [48, .391], [65, .513], [82, .619], [98, .712], [115, .783], [132, .842], [148, .882], [165, .914],
    [182, .937], [198, .954], [215, .967], [232, .977], [248, .983], [265, .988], [282, .992], [298, .994], [332, .997], [382, 1]];
  var CLOSE = [[0, 0], [3, .017], [20, .115], [36, .265], [53, .404], [70, .534], [86, .637], [103, .722], [120, .793], [136, .847], [153, .889],
    [170, .916], [186, .94], [210, 1]];
  var LATE_OPEN = 48, LATE_CLOSE = 55, MS = 400;
  var st = { open: false, vvOpen: false, pan: false, t0: -1, from: 0, log: [], resizeAt: [], resizeHeights: [] };
  function curve(tab, ms) {
    if (ms <= 0) return 0;
    for (var i = 1; i < tab.length; i++) if (ms <= tab[i][0]) { var a = tab[i - 1], b = tab[i]; return a[1] + (b[1] - a[1]) * (ms - a[0]) / (b[0] - a[0]); }
    return 1;
  }
  function kbUp() {   // 键盘眼下升起了多高（px）
    if (st.t0 < 0) return 0;
    var ms = performance.now() - st.t0;
    return st.open ? st.from + (K - st.from) * curve(OPEN, ms) : st.from * (1 - curve(CLOSE, ms));
  }
  function P() { return st.pan ? kbUp() : 0; }   // 眼下页面实际被挪了多少（屏幕坐标 = 页面坐标 − P）；挪动跟着键盘走，收起时跟着键盘落回 0
  var vv = window.visualViewport;
  function install() {
    H0 = innerHeight;
    Object.defineProperty(vv, 'height', { configurable: true, get: function () { return st.vvOpen ? H0 - K : H0; } });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: function () { return st.vvOpen && st.pan ? K : 0; } });
  }
  var timer = 0;
  function start(open, pan) {
    st.from = kbUp(); st.open = open; st.t0 = performance.now();
    if (open) st.pan = pan;
    clearTimeout(timer);
    // visualViewport 晚一会儿才变，变的时候发一次 resize
    timer = setTimeout(function () {
      st.vvOpen = open;
      st.resizeAt.push(Math.round(performance.now() - st.t0));
      var stage = document.getElementById('stage'), before = stage.getBoundingClientRect().height;
      vv.dispatchEvent(new Event('resize'));
      st.resizeHeights.push([before, stage.getBoundingClientRect().height]);
      setTimeout(function () { vv.dispatchEvent(new Event('scroll')); }, MS);   // scroll 等挪完才发
    }, open ? LATE_OPEN : LATE_CLOSE);
  }
  window.__iosKb = { st: st, P: P, get K() { return K; }, setK: function (v) { K = v; }, setLateClose: function (v) { LATE_CLOSE = v; }, kbUp: kbUp, install: install,
    open: function (pan) { start(true, pan); }, close: function () { start(false, false); } };
  window.__iosKbHook = function (w) {
    if (w.__iosKbHooked) return; w.__iosKbHooked = true;
    var orig = w.HTMLElement.prototype.focus, ps = false;
    w.HTMLElement.prototype.focus = function (o) { var was = ps; ps = !!(o && o.preventScroll); try { return orig.call(this, o); } finally { ps = was; } };
    w.document.addEventListener('focusin', function (e) {
      var t = e.target; if (!t || !/^(TEXTAREA|INPUT)$/.test(t.tagName)) return;
      st.log.push({ preventScroll: ps });
      if (!st.open) start(true, !ps);
    }, true);
    w.document.addEventListener('touchend', function (e) {
      // 系统收起键盘可以保留焦点；再点原输入框不会收到新的 focusin。
      if (!e.defaultPrevented && !st.open && e.target === w.document.activeElement && e.target.tagName === 'TEXTAREA') start(true, false);
    });
    w.document.addEventListener('focusout', function (e) {
      var t = e.target; if (!t || !/^(TEXTAREA|INPUT)$/.test(t.tagName)) return;
      if (st.open) start(false, false);
    }, true);
  };
  // 每帧记屏幕上看到的位置（kb = 键盘顶边在屏幕上的位置；stageH = 外壳面板的高度，变了就是 resize 落到画面上了）
  window.__iosKbTrace = function (frameEl, ms) {
    return new Promise(function (done) {
      var out = [], t0 = performance.now();
      // 在 requestAnimationFrame 里排一个 setTimeout(0)：它在这一帧排版、ResizeObserver、绘制之后才跑，量到的是这一帧画出来的样子
      requestAnimationFrame(function () { setTimeout(tick, 0); });
      function tick() {
        var d = frameEl.contentDocument, fr = frameEl.getBoundingClientRect(), p = P();
        var head = d.querySelector('.tq-mid-head'), dock = d.querySelector('.tq-dock').getBoundingClientRect();
        var ms_ = d.querySelectorAll('.tq-mid > .xc-body .xc-msgs > .xc-m'), last = ms_.length ? ms_[ms_.length - 1] : null;
        var stage = document.getElementById('stage').getBoundingClientRect();
        out.push({ t: Math.round(performance.now() - t0), P: Math.round(p),
          stage: Math.round(stage.top - p), stageH: Math.round(stage.height),
          head: Math.round(fr.top + head.getBoundingClientRect().top - p),
          dock: Math.round(fr.top + dock.top - p), dockB: Math.round(fr.top + dock.bottom - p),
          last: last ? Math.round(fr.top + last.getBoundingClientRect().bottom - p) : null,
          kb: Math.round(H0 - kbUp()) });
        if (performance.now() - t0 < ms) requestAnimationFrame(function () { setTimeout(tick, 0); }); else done(out);
      }
    });
  };
})();
