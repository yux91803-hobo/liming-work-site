/* 测试用：在 Chromium 里扮演 iPhone Safari 弹键盘（Chromium 没有软键盘，也不会替输入框挪可见区域）。
   按 WebKit 的行为建模（来源见 docs/CHANGES.md 2026-11-21「整页弹一下」一条）：
   - 手指点输入框获得焦点、这次 focus 没带 preventScroll 时，Safari 把整页往上挪（_zoomToFocusRect），让输入框露在键盘上面，
     挪的过程跟着键盘动画走（这里 K = 键盘高 336px，300ms）；带了 preventScroll 就不挪（WebKit bug 236584 修好以后）。
   - visualViewport：键盘一开始动 height 就变小（React Aria runAfterKeyboard：WebKit 只在开头发一次 resize），
     offsetTop 直接报挪完以后的值；scroll 事件要等挪完才发（WebKit bug 218465）。
   - 屏幕上看到的位置 = 页面里的位置 − 眼下实际挪了多少（P）。Chromium 自己不会挪，所以 P 由这里按时间算出来，量位置时减掉。
   用法：顶层页面 add_init_script 本文件；iframe 里的 focus 由 window.__iosKbHook(frameWindow) 接上。 */
(function () {
  if (window.top !== window) return;
  var K = 336, MS = 300, H0 = 0;
  var st = { open: false, pan: false, t0: -1, from: 0, to: 0, log: [] };
  function ease(x) { x = Math.max(0, Math.min(1, x)); return 1 - Math.pow(1 - x, 3); }
  function P() {   // 眼下页面实际被挪了多少（屏幕坐标 = 页面坐标 − P）
    if (st.t0 < 0) return 0;
    return st.from + (st.to - st.from) * ease((performance.now() - st.t0) / MS);
  }
  var vv = window.visualViewport;
  function install() {
    H0 = innerHeight;
    Object.defineProperty(vv, 'height', { configurable: true, get: function () { return st.open ? H0 - K : H0; } });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: function () { return st.open && st.pan ? K : 0; } });
  }
  function start(open, pan) {
    var p = P();
    st.open = open; st.t0 = performance.now(); st.from = p; st.to = open && pan ? K : 0; st.pan = open ? pan : st.pan;
    if (!open) st.pan = false;
    vv.dispatchEvent(new Event('resize'));                       // 开头就发一次 resize
    setTimeout(function () { vv.dispatchEvent(new Event('scroll')); }, MS + 20);   // scroll 等挪完才发
  }
  window.__iosKb = { st: st, P: P, K: K, MS: MS, install: install,
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
    w.document.addEventListener('focusout', function (e) {
      var t = e.target; if (!t || !/^(TEXTAREA|INPUT)$/.test(t.tagName)) return;
      if (st.open) start(false, false);
    }, true);
  };
  // 每帧记屏幕上看到的位置
  window.__iosKbTrace = function (frameEl, ms) {
    return new Promise(function (done) {
      var out = [], t0 = performance.now();
      // 在 requestAnimationFrame 里排一个 setTimeout(0)：它在这一帧排版、ResizeObserver、绘制之后才跑，量到的是这一帧画出来的样子
      requestAnimationFrame(function () { setTimeout(tick, 0); });
      function tick() {
        var d = frameEl.contentDocument, fr = frameEl.getBoundingClientRect(), p = P();
        var head = d.querySelector('.tq-mid-head'), dock = d.querySelector('.tq-dock');
        var ms_ = d.querySelectorAll('.tq-mid > .xc-body .xc-msgs > .xc-m'), last = ms_.length ? ms_[ms_.length - 1] : null;
        var stage = document.getElementById('stage').getBoundingClientRect();
        out.push({ t: Math.round(performance.now() - t0), P: Math.round(p),
          stage: Math.round(stage.top - p),
          head: Math.round(fr.top + head.getBoundingClientRect().top - p),
          dock: Math.round(fr.top + dock.getBoundingClientRect().top - p),
          last: last ? Math.round(fr.top + last.getBoundingClientRect().bottom - p) : null,
          kb: Math.round(H0 - (st.open ? K : 0) * 1) });
        if (performance.now() - t0 < ms) requestAnimationFrame(function () { setTimeout(tick, 0); }); else done(out);
      }
    });
  };
})();
