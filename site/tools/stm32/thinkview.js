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
    var wrap = el('div', 'think'); root.appendChild(wrap);
    var head = el('header', 'pg-h tk-hero');
    head.appendChild(el('h1', null, '编程思维'));
    head.appendChild(el('p', null, '这里不再讲一遍知识，而是练一件事：面对一个从没写过的程序，能从最根本的需求出发，一步步想出自己的思路。每一章都假装这个外设还不存在，从一个具体的需求开始，自己把它「发明」出来，最后推到能运行的代码。'));
    wrap.appendChild(head);

    var how = el('section', 'sec tk-how');
    how.appendChild(el('h2', 'sec-h', '每一章都是同一种推法'));
    var ol = el('ol', 'tk-flow');
    [['发现需求', '我们想完成什么？为什么需要它？'], ['最朴素的想法', '如果没有现成的技术，最简单的办法是什么？'], ['问题来了', '这个办法在哪里会出错、冲突？用具体的例子看'],
     ['改进', '加什么机制、改什么规则能解决它？'], ['为什么这样设计', '还有别的办法吗？各有什么取舍？'], ['落到芯片和代码', '寄存器、引脚、每一行代码追溯到哪个理由']].forEach(function (x) {
      var li = el('li'); li.appendChild(el('b', null, x[0])); li.appendChild(el('span', null, x[1])); ol.appendChild(li);
    });
    how.appendChild(ol);
    how.appendChild(el('p', 'sec-note', '每个问题解决以后，往往又冒出下一个问题——一章就是一条这样连起来的推导链。代码里的每一行都能点开，看它是被哪一步推出来的；任选两行交换，模拟器会跑给你看换了以后哪里出错。'));
    wrap.appendChild(how);

    var list = el('section', 'sec'); list.appendChild(el('h2', 'sec-h', '章节'));
    list.appendChild(el('p', 'sec-note', '按课件的顺序排列。每章开头可以选「完整推导」（像听工程师边想边讲）或「自主推导」（每个问题先自己答）。'));
    var grid = el('div', 'tk-chs');
    chapters().forEach(function (ch) {
      var t = M.topicById[ch.topic], pg = STM.derive.progress(ch.id);
      var a = app.link({ v: 'think', t: ch.id }, 'tk-ch tk-ch-d'); a.style.setProperty('--h', app.hue(t));
      var top = el('div', 'tk-ch-h'); top.appendChild(el('b', 'mono', t.code));
      top.appendChild(el('span', null, pg.done ? (pg.done === pg.total ? '推完了' : '推到 ' + pg.done + ' / ' + pg.total) : pg.total + ' 个问题'));
      a.appendChild(top);
      a.appendChild(el('h3', null, ch.title));
      a.appendChild(el('p', null, '任务：' + ch.task));
      if (pg.due) a.appendChild(el('span', 'tk-due', '今天该复习 ' + pg.due + ' 题'));
      var bar = el('div', 'tk-dots'); for (var k = 0; k < 10; k++) bar.appendChild(el('span', k < Math.round(pg.done / pg.total * 10) ? 'on' : null)); a.appendChild(bar);
      grid.appendChild(a);
    });
    list.appendChild(grid);
    var rest = M.topics.filter(function (t) { return !(STM.derive && STM.derive.has(t.id)); }).map(function (t) { return t.code; });
    if (rest.length) list.appendChild(el('p', 'sec-note tk-rest', rest.join('、') + ' 还没有推导章节。'));
    wrap.appendChild(list);
    return { title: function () { return '编程思维'; } };
  }

  STM.views.think = view;
  STM.think = {
    chapter: function (id) { return (STM.derive && STM.derive.chapter(id)) || null; },
    progress: function (id) { return STM.derive ? STM.derive.progress(id) : null; }
  };
})();
