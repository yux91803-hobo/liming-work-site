/* thinkview.js — 「编程思维」总览页；每一章（推导链）的界面在 deriveview.js
   路由：v=think（总览）；v=think&t=gpio（某一章）→ 交给 STM.derive.view */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, M = STM.model, el = ui.el;
  var ORDER = ['gpio', 'usart', 'i2c', 'tim', 'adc', 'spi'];

  function chapters() {
    var D = window.STM32_DERIVE || {}, ids = ORDER.filter(function (id) { return D[id]; });
    Object.keys(D).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
    return ids.map(function (id) { return D[id]; });
  }

  function view(root, route, app) {
    if (route.t && STM.derive && STM.derive.has(route.t)) return STM.derive.view(root, route, app);
    if (route.t && STM.codederive && STM.codederive.has(route.t)) {   // 没有推导链的外设：进来就是代码推导
      var t0 = M.topicById[route.t], w0 = el('div', 'derive'); root.appendChild(w0);
      STM.codederive.render(w0, route.t, app, { crumb: { v: 'topic', t: route.t }, crumbText: t0.code + ' · Code reasoning' });
      return { title: function () { return t0.code + ' 代码推导'; } };
    }
    var wrap = el('div', 'think'); root.appendChild(wrap);
    var head = el('header', 'pg-h tk-hero');
    head.appendChild(el('h1', null, 'Code reasoning'));
    wrap.appendChild(head);

    var ol = el('ol', 'tk-flow');
    ['需求', '朴素想法', '出问题', '改进', '取舍', '代码'].forEach(function (x) { ol.appendChild(el('li', null, x)); });
    head.appendChild(ol);

    var list = el('section', 'sec'); list.appendChild(el('h2', 'sec-h', '章节'));
    var grid = el('div', 'tk-chs');
    chapters().forEach(function (ch) {
      var t = M.topicById[ch.topic], pg = STM.derive.progress(ch.id);
      var a = app.link({ v: 'think', t: ch.id }, 'tk-ch tk-ch-d'); a.style.setProperty('--h', app.hue(t));
      var top = el('div', 'tk-ch-h'); top.appendChild(el('b', 'mono', t.code));
      top.appendChild(el('span', null, pg.done ? (pg.done === pg.total ? '推完了' : pg.done + ' / ' + pg.total) : pg.total + ' 问'));
      a.appendChild(top);
      if (pg.due) a.appendChild(el('span', 'tk-due', '待复习 ' + pg.due));
      var bar = el('div', 'tk-dots'); for (var k = 0; k < 10; k++) bar.appendChild(el('span', k < Math.round(pg.done / pg.total * 10) ? 'on' : null)); a.appendChild(bar);
      grid.appendChild(a);
    });
    // 没有推导链的外设：卡片直接进代码推导
    M.topics.forEach(function (t) {
      if ((STM.derive && STM.derive.has(t.id)) || !(STM.codederive && STM.codederive.has(t.id))) return;
      var a = app.link({ v: 'think', t: t.id }, 'tk-ch tk-ch-d'); a.style.setProperty('--h', app.hue(t));
      var top = el('div', 'tk-ch-h'); top.appendChild(el('b', 'mono', t.code)); top.appendChild(el('span', null, '代码推导')); a.appendChild(top);
      grid.appendChild(a);
    });
    list.appendChild(grid);
    wrap.appendChild(list);
    return { title: function () { return 'Code reasoning'; } };
  }

  STM.views.think = view;
  STM.think = {
    chapter: function (id) { return (STM.derive && STM.derive.chapter(id)) || null; },
    progress: function (id) { return STM.derive ? STM.derive.progress(id) : null; }
  };
})();
