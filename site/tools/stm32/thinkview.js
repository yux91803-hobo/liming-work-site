/* thinkview.js — 「设计原理」总览页；每一章（推导链）的界面在 deriveview.js
   路由：v=think（总览）；v=think&t=gpio（某一章）→ 交给 STM.derive.view */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, M = STM.model, el = ui.el;
  var ORDER = ['gpio', 'exti', 'usart', 'i2c', 'tim', 'dma', 'adc', 'spi'];

  function chapters() {
    var D = window.STM32_DERIVE || {}, ids = ORDER.filter(function (id) { return D[id]; });
    Object.keys(D).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
    return ids.map(function (id) { return D[id]; });
  }

  function view(root, route, app) {
    if (route.t && STM.derive && STM.derive.has(route.t)) return STM.derive.view(root, route, app);
    var wrap = el('div', 'think'); root.appendChild(wrap);
    var head = el('header', 'pg-h tk-hero');
    head.appendChild(el('h1', null, '设计原理'));
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
    list.appendChild(grid);
    wrap.appendChild(list);
    return { title: function () { return '设计原理'; } };
  }

  STM.views.think = view;
  STM.think = {
    chapter: function (id) { return (STM.derive && STM.derive.chapter(id)) || null; },
    progress: function (id) { return STM.derive ? STM.derive.progress(id) : null; }
  };
})();
