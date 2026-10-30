/* labprog.js — 侧栏「编程思维」：一道题从需求走到代码
   路由：v=lab（章节列表）；v=lab&t=gpio&st=task|look|plan|code|check；fn= 编写里的第几版（v1 / v2）、验证里的哪一级（fill / init / onoff / key）
   页面：顶上一条框架（明确任务 → 查资料 → 规划 → 编写 → 验证），左边讲思路和代码，右边一次只放一份最相关的资料
   （开发板原理图 / 参考手册框图 / 寄存器位图），点一行代码右边就换成这一行用到的寄存器。
   手机：「讲解 | 资料」切换。动画不在这里：每行寄存器代码后面有「看硬件」，跳到「硬件原理」里同一行。 */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, el = ui.el, L = window.STM32Lab;
  var STAGES = [['task', '明确任务'], ['look', '查资料'], ['plan', '规划'], ['code', '编写'], ['check', '验证']];
  var OLD = { need: 'task', hw: 'look', fn: 'plan', h: 'plan', c: 'code', self: 'check' };   // 旧地址
  var SKEY = 'lm.stm.lab.';
  // 资料的章节号（参考手册中文版 2009 / 英文版 Rev21）；页码来自 manual.js / registers.js
  var FIGSEC = { 'sys-arch': ['2.1', '3.1'], 'gpio-bit': ['8.1', '9.1'], 'gpio-in': ['8.1.7', '9.1.7'], 'gpio-out': ['8.1.8', '9.1.8'] };
  var REGSEC = { RCC_APB2ENR: ['6.3.7', '7.3.7'], GPIO_CRL: ['8.2.1', '9.2.1'], GPIO_CRH: ['8.2.2', '9.2.2'], GPIO_IDR: ['8.2.3', '9.2.3'], GPIO_ODR: ['8.2.4', '9.2.4'], GPIO_BSRR: ['8.2.5', '9.2.5'], GPIO_BRR: ['8.2.6', '9.2.6'] };
  var SCH = { 'board-08': { w: 848.16, h: 599.76, n: 8, name: '小电路' } };
  function html(tag, cls, h) { var e = el(tag, cls); e.innerHTML = h; return e; }
  function seen(ch) { var o = {}; try { o = JSON.parse(ui.lsGet(SKEY + ch + '.seen2') || '{}') || {}; } catch (e) {} return o; }
  function markSeen(ch, st) { var o = seen(ch); if (o[st]) return; o[st] = 1; ui.lsSet(SKEY + ch + '.seen2', JSON.stringify(o)); }
  function stageOf(r) { var s = OLD[r.st] || r.st; return STAGES.some(function (x) { return x[0] === s; }) ? s : 'task'; }
  function hex(v) { var s = (v >>> 0).toString(16).toUpperCase(); while (s.length < 8) s = '0' + s; return '0x' + s.slice(0, 4) + ' ' + s.slice(4); }

  /* =====================================================================
     右边的资料：一次一份
     ===================================================================== */
  function DocPane(host, app, ch) {
    var box = el('div', 'lp-doc'), head = el('div', 'lp-doc-h'), body = el('div', 'lp-doc-b'), src = el('p', 'lp-src'), acts = el('div', 'lp-acts');
    box.appendChild(head); box.appendChild(body); box.appendChild(src); box.appendChild(acts);
    host.appendChild(box);
    var cur = null, whole = false, onChange = null;
    function figOf(id) { return (window.STM32_MANUAL_FIGS || []).filter(function (f) { return f.id === id; })[0]; }
    function regOf(id) { return STM.model.R.reg(id); }
    function picture(srcUrl, W, Hh, crop, hl) {
      var c = !whole && crop ? crop : [0, 0, 1, 1];
      var frame = el('div', 'lp-pic'); frame.style.aspectRatio = (c[2] * W) + ' / ' + (c[3] * Hh);
      var inner = el('div', 'lp-pic-i');
      inner.style.width = (100 / c[2]) + '%'; inner.style.height = (100 / c[3]) + '%';
      inner.style.left = (-c[0] / c[2] * 100) + '%'; inner.style.top = (-c[1] / c[3] * 100) + '%';
      var img = el('img'); img.src = srcUrl; img.alt = ''; img.decoding = 'async'; inner.appendChild(img);
      (hl || []).forEach(function (h) {
        var b = el('span', 'lp-hl'); b.style.left = h[0] * 100 + '%'; b.style.top = h[1] * 100 + '%'; b.style.width = h[2] * 100 + '%'; b.style.height = h[3] * 100 + '%';
        inner.appendChild(b);
      });
      frame.appendChild(inner); return frame;
    }
    function bitsOf(v, f) { var w = f.bits[0] - f.bits[1] + 1, x = (v >>> f.bits[1]) & (w === 32 ? 0xFFFFFFFF : (1 << w) - 1), s = x.toString(2); while (s.length < w) s = '0' + s; return s; }
    function meaning(r, f, b, v) {
      var vals = f.values;
      if (!vals && f.cases) {
        var hit = f.cases.filter(function (cs) {
          if (!cs.if) return false;
          var g = r.fields.filter(function (x) { return x.name === cs.if.field; })[0]; if (!g || v == null) return false;
          var gb = bitsOf(v, g); return cs.if.eq != null ? gb === cs.if.eq : cs.if.ne != null ? gb !== cs.if.ne : false;
        })[0];
        vals = hit ? hit.values : null;
      }
      var m = (vals || []).filter(function (x) { return String(x.v) === b; })[0];
      return m ? m.t : '';
    }
    function regView(d) {
      var r = regOf(d.id); if (!r) return el('p', null, d.id);
      var wrap = el('div', 'lp-reg'), w = Number(r.width) === 16 ? 16 : 32, v = d.val, hlf = d.f || [];
      var top = el('div', 'lp-reg-h'); top.appendChild(el('b', 'mono', r.name)); top.appendChild(el('span', null, r.title));
      if (v != null) top.appendChild(el('span', 'lp-reg-v mono', (d.write ? '写入 ' : '值 ') + hex(v)));
      wrap.appendChild(top);
      var fieldAt = function (b) { for (var i = 0; i < r.fields.length; i++) { var f = r.fields[i]; if (b <= f.bits[0] && b >= f.bits[1]) return f; } return null; };
      (w === 32 ? [[31, 16], [15, 0]] : [[15, 0]]).forEach(function (rr) {
        var row = el('div', 'lp-bits'), names = el('div', 'lp-bn'), cells = el('div', 'lp-bc'), idx = el('div', 'lp-bi'), seenF = {};
        for (var b = rr[0]; b >= rr[1]; b--) {
          var f = fieldAt(b), on = hlf.indexOf(f && f.name) >= 0;
          var cell = el('span', 'lp-bit' + (on ? ' on' : '') + (!f || f.reserved ? ' res' : '') + (f && b === f.bits[1] ? ' fe' : ''));
          cell.textContent = v == null ? '' : (v >>> b) & 1;
          cells.appendChild(cell);
          idx.appendChild(el('span', null, b % 4 === 0 || b === rr[0] ? String(b) : ''));
          if (f && !seenF[f.name]) {
            seenF[f.name] = 1;
            var hi = Math.min(f.bits[0], rr[0]), lo = Math.max(f.bits[1], rr[1]);
            var nm = el('span', 'lp-fn' + (on ? ' on' : '') + (f.reserved ? ' res' : ''), f.reserved ? '' : f.name);
            nm.style.gridColumn = (rr[0] - hi + 1) + ' / span ' + (hi - lo + 1); names.appendChild(nm);
          }
        }
        row.appendChild(names); row.appendChild(cells); row.appendChild(idx); wrap.appendChild(row);
      });
      if (hlf.length) {
        var ul = el('ul', 'lp-fl');
        hlf.forEach(function (n) {
          var f = r.fields.filter(function (x) { return x.name === n; })[0]; if (!f) return;
          var li = el('li'), bb = v != null ? bitsOf(v, f) : null, mt = bb != null ? meaning(r, f, bb, v) : '';
          li.appendChild(el('b', 'mono', f.name)); li.appendChild(el('span', 'mono lp-fb', '[' + f.bits[0] + (f.bits[0] !== f.bits[1] ? ':' + f.bits[1] : '') + ']' + (bb != null ? ' = ' + bb : '')));
          li.appendChild(el('span', null, mt || f.desc || ''));
          ul.appendChild(li);
        });
        wrap.appendChild(ul);
      }
      if (d.note) wrap.appendChild(el('p', 'lp-reg-n', d.note));
      return wrap;
    }
    function act(label, fn) { var b = ui.btn('lab-b', label); b.addEventListener('click', fn); acts.appendChild(b); return b; }
    function show(d, opt) {
      if (typeof d === 'string') d = ch.docs[d];
      if (!d) return;
      opt = opt || {};
      if (!opt.keepWhole && cur !== d) whole = false;
      cur = d; ui.clear(head); ui.clear(body); ui.clear(acts); src.textContent = ''; box.dataset.kind = d.kind;
      if (opt.back) { var bk = ui.btn('lp-back'); bk.appendChild(ui.icon('back')); bk.appendChild(el('span', null, opt.back[0])); bk.addEventListener('click', opt.back[1]); head.appendChild(bk); }
      if (d.kind === 'sch') {
        var pg = SCH[d.page] || { w: 848, h: 600, n: '', name: '' };
        head.appendChild(el('span', 'lp-kind', '开发板原理图')); head.appendChild(el('b', null, d.title || pg.name));
        body.appendChild(picture('assets/' + d.page + '.svg', pg.w, pg.h, d.crop, d.hl));
        src.textContent = '尚硅谷 STM32F103ZET6 开发板原理图 V1.0 · 第 ' + pg.n + ' 页「' + pg.name + '」';
        if (d.crop) act(whole ? '只看这一块' : '看整页', function () { whole = !whole; show(d, { keepWhole: true }); });
        act('放大', function () { app.navigate({ sch: d.page }); });
      } else if (d.kind === 'fig') {
        var f = figOf(d.fig); if (!f) return;
        head.appendChild(el('span', 'lp-kind', '参考手册')); head.appendChild(el('b', null, f.label + ' ' + f.title));
        body.appendChild(picture('assets/' + f.src, f.width, f.height, d.crop, d.hl));
        var sec = FIGSEC[d.fig] || [];
        src.textContent = 'RM0008 参考手册 · 中文版' + (sec[0] ? ' ' + sec[0] : '') + (f.page ? ' 第 ' + f.page + ' 页' : '') + ' · 英文版 Rev21' + (sec[1] ? ' ' + sec[1] : '') + (f.page_en ? ' 第 ' + f.page_en + ' 页' : '') + '。矢量图取自英文版，中文标注按中文版术语转译。';
        if (d.crop) act(whole ? '只看这一块' : '看整张', function () { whole = !whole; show(d, { keepWhole: true }); });
        act('放大', function () { app.navigate({ fig: d.fig }); });
      } else if (d.kind === 'reg') {
        var r = regOf(d.id); if (!r) return;
        head.appendChild(el('span', 'lp-kind', '参考手册 · 寄存器')); head.appendChild(el('b', 'mono', r.name));
        body.appendChild(regView(d));
        var pgs = r.page || {}, rs = REGSEC[d.id] || [];
        src.textContent = 'RM0008 参考手册 · 中文版' + (rs[0] ? ' ' + rs[0] : '') + (pgs.cn ? ' 第 ' + pgs.cn + ' 页' : '') + ' · 英文版 Rev21' + (rs[1] ? ' ' + rs[1] : '') + (pgs.en ? ' 第 ' + pgs.en + ' 页' : '') + '「' + r.title_en + '」';
        act('打开寄存器面板', function () { var o = { reg: d.id }; if (/^GPIO_/.test(d.id)) o.i = 'GPIO' + (d.port || ch.port); if (d.val != null && !d.write) o.val = '0x' + (d.val >>> 0).toString(16); app.navigate(o); });
      }
      if (onChange) onChange(d);
    }
    return { show: show, el: box, cur: function () { return cur; }, onChange: function (f) { onChange = f; }, regView: regView };
  }

  /* 资料卡：查资料那一步查到的结论，规划和验证时拿来用 */
  function cards(host, ch, pane, back) {
    var box = el('div', 'lp-cards'); box.appendChild(el('h3', 'lp-cards-h', '资料卡'));
    var ol = el('ol');
    ch.look.forEach(function (x) {
      var li = el('li'), b = ui.btn('lp-card'); b.innerHTML = x.card;
      b.addEventListener('click', function () { pane.show(x.doc, { back: ['资料卡', back] }); });
      li.appendChild(b); ol.appendChild(li);
    });
    box.appendChild(ol); host.appendChild(box); return box;
  }

  /* =====================================================================
     页面
     ===================================================================== */
  function home(root, app) {
    var wrap = el('div', 'labp'); root.appendChild(wrap);
    var head = el('header', 'pg-h lab-hero');
    head.appendChild(el('h1', null, '编程思维'));
    var ol = el('ol', 'lab-flow'); STAGES.forEach(function (s) { ol.appendChild(el('li', null, s[1])); }); head.appendChild(ol);
    wrap.appendChild(head);
    var grid = el('div', 'lab-chs');
    L.ORDER.forEach(function (id) {
      var ch = L.chapter(id), t = STM.model.topicById[ch.topic], sn = seen(id), n = STAGES.filter(function (s) { return sn[s[0]]; }).length;
      var a = app.link({ v: 'lab', t: id }, 'lab-ch'); a.style.setProperty('--h', app.hue(t));
      var top = el('div', 'lab-ch-h'); top.appendChild(el('b', 'mono', t ? t.code : id.toUpperCase())); top.appendChild(el('span', 'lab-ch-n', n + ' / ' + STAGES.length)); a.appendChild(top);
      a.appendChild(el('h2', null, ch.title));
      a.appendChild(el('p', null, ch.task));
      var bar = el('span', 'lab-ch-bar'); bar.style.setProperty('--k', String(n / STAGES.length)); a.appendChild(bar);
      grid.appendChild(a);
    });
    wrap.appendChild(grid);
    return { title: function () { return '编程思维'; } };
  }

  function chapterView(root, route, app) {
    var ch = L.chapter(route.t), wrap = el('div', 'labp lp'), cur = null, page = null;
    root.appendChild(wrap);
    var head = el('header', 'lab-head'), h1 = el('h1', null, ch.title);
    var tabs = el('nav', 'lab-tabs lp-frame'); tabs.setAttribute('aria-label', '解题框架');
    STAGES.forEach(function (s, i) {
      var a = app.link({ v: 'lab', t: ch.id, st: s[0] }, 'lab-tab'); a.dataset.st = s[0];
      a.appendChild(el('span', 'lab-tab-i', String(i + 1))); a.appendChild(el('span', null, s[1]));
      tabs.appendChild(a);
    });
    head.appendChild(h1); head.appendChild(tabs); wrap.appendChild(head);
    // 手机：讲解 / 资料 切换
    var mt = el('div', 'lp-mt lb-seg'); mt.setAttribute('role', 'tablist');
    var mA = ui.btn('', '讲解'), mB = ui.btn('', '资料'); mB.appendChild(el('i', 'lp-dot'));
    mt.appendChild(mA); mt.appendChild(mB); wrap.appendChild(mt);
    var grid = el('div', 'lp-grid'), mainCol = el('div', 'lp-main'), side = el('aside', 'lp-side');
    side.setAttribute('aria-label', '资料');
    grid.appendChild(mainCol); grid.appendChild(side); wrap.appendChild(grid);
    var foot = el('nav', 'lab-foot'); foot.setAttribute('aria-label', '上一步 / 下一步'); wrap.appendChild(foot);
    var pane = DocPane(side, app, ch), mode = 'a';
    function setMode(m) { mode = m; wrap.classList.toggle('lp-show-doc', m === 'b'); mA.setAttribute('aria-selected', String(m === 'a')); mB.setAttribute('aria-selected', String(m === 'b')); if (m === 'b') mB.classList.remove('new'); }
    mA.addEventListener('click', function () { setMode('a'); }); mB.addEventListener('click', function () { setMode('b'); window.scrollTo(0, Math.min(window.scrollY, wrap.offsetTop)); });
    pane.onChange(function () { if (mode === 'a') mB.classList.add('new'); });
    setMode('a');

    function paint(r) {
      var s = stageOf(r);
      if (s === cur && page && page.update) { page.update(r); return; }
      if (page && page.destroy) page.destroy();
      page = null; ui.clear(mainCol); cur = s; setMode('a'); mB.classList.remove('new');
      Array.prototype.forEach.call(tabs.children, function (a) { var on = a.dataset.st === s; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current'); });
      page = (STAGE[s])(mainCol, ch, r, app, pane) || {};
      markSeen(ch.id, s);
      ui.clear(foot);
      var i = STAGES.map(function (x) { return x[0]; }).indexOf(s);
      if (i > 0) { var p = app.link({ v: 'lab', t: ch.id, st: STAGES[i - 1][0] }, 'lab-nav lab-prev'); p.appendChild(ui.icon('back')); p.appendChild(el('span', null, STAGES[i - 1][1])); foot.appendChild(p); }
      else foot.appendChild(el('span'));
      if (i < STAGES.length - 1) { var nx = app.link({ v: 'lab', t: ch.id, st: STAGES[i + 1][0] }, 'lab-nav lab-next'); nx.appendChild(el('span', null, '下一步：' + STAGES[i + 1][1])); nx.appendChild(ui.icon('next')); foot.appendChild(nx); }
      else { var hw = app.link({ v: 'think', t: ch.id }, 'lab-nav lab-next'); hw.appendChild(el('span', null, '去「硬件原理」看它在芯片里怎么动')); hw.appendChild(ui.icon('next')); foot.appendChild(hw); }
    }
    paint(route);
    return {
      title: function (r) { var s = STAGES.filter(function (x) { return x[0] === stageOf(r); })[0]; return ch.title + (s ? ' · ' + s[1] : ''); },
      update: function (r) { var was = cur; paint(r); if (was !== cur) window.scrollTo(0, 0); },
      destroy: function () { if (page && page.destroy) page.destroy(); }
    };
  }

  /* ---------- 小部件 ---------- */
  function reveal(q, a, cls) {
    var box = el('div', 'lab-q' + (cls ? ' ' + cls : '')), b = ui.btn('lab-q-h'), ans = html('div', 'lab-q-a', a);
    b.appendChild(el('span', 'lab-q-t', q)); b.appendChild(ui.icon('next', 'ic lab-q-i'));
    b.setAttribute('aria-expanded', 'false'); ans.hidden = true;
    b.addEventListener('click', function () { var on = ans.hidden; ans.hidden = !on; b.setAttribute('aria-expanded', String(on)); box.classList.toggle('open', on); });
    box.appendChild(b); box.appendChild(ans); return box;
  }
  function sec(host, title) { var s = el('section', 'lab-sec'); if (title) s.appendChild(el('h2', 'sec-h', title)); host.appendChild(s); return s; }
  // 一份代码：子目标小标题 + 每行（注释 / 代码 / 点开看原因）+ 寄存器行后面「看硬件」
  function codeFile(name, lines, groups, onPick, hwLink) {
    var R = STM.codederive.rows, fig = el('figure', 'code rc-code cd-file lp-file'), h = el('figcaption', 'code-h');
    h.appendChild(el('span', 'code-t mono', name)); fig.appendChild(h);
    var body = el('div', 'rc-fn');
    lines.forEach(function (x, i) {
      if (groups && groups[i]) body.appendChild(el('div', 'lp-goal', groups[i]));
      var l = R.norm(x), row = R.line(l);
      row.dataset.i = i;
      var go = hwLink && hwLink(i, l.c);
      if (go) { go.classList.add('lp-hw'); row.querySelector('.rc-lb').appendChild(go); }
      if (onPick && l.c.trim()) row.querySelector('.rc-lb').addEventListener('click', function () { onPick(i, l.c, row); });
      body.appendChild(row);
    });
    fig.appendChild(body); return fig;
  }
  function hwChipFor(ch, file, i) {   // 这一行在「硬件原理」里是哪个函数的第几行
    if (file === 'single') return 'single';
    if (file === 'main.c') return 'main';
    if (file !== 'led.c') return null;
    var fns = L.parseFile(L.file(ch, 'led.c')).fns, hit = null;
    [['LED_Init', 'init'], ['LED_On', 'on'], ['LED_Off', 'off'], ['LED_Toggle', 'toggle']].forEach(function (p) { var F = fns[p[0]]; if (F && F.src.indexOf(i) >= 0) hit = p[1]; });
    return hit;
  }
  var traceCache = {};
  function stateAfter(ch, chipId, ln) {   // 这一行执行完以后的芯片状态（右边的寄存器值用）
    var k = ch.id + '|' + chipId;
    if (!traceCache[k]) { var chip = ch.chips.filter(function (c) { return c.id === chipId; })[0]; traceCache[k] = chip ? L.trace(ch, chip) : null; }
    var t = traceCache[k]; if (!t) return null;
    for (var j = 0; j < t.evs.length; j++) if (t.evs[j].ln === ln) return t.states[j + 1];
    return null;
  }

  var STAGE = {};
  /* ① 明确任务 */
  STAGE.task = function (body, ch, route, app, pane) {
    body.appendChild(html('p', 'lab-task', ch.task));
    var s = sec(body, '先把要求拆开');
    var list = el('div', 'lab-qs'); ch.ask.forEach(function (n) { list.appendChild(reveal(n.q, n.a)); }); s.appendChild(list);
    pane.show('sch-led');
  };
  /* ② 查资料：一问一份资料 */
  STAGE.look = function (body, ch, route, app, pane) {
    body.appendChild(html('p', 'lp-lead', '带着问题去查。每一问右边放一份资料，看完再展开「查到了什么」对一下。'));
    var list = el('ol', 'lp-looks'), at = 0, open = {};
    body.appendChild(list);
    var cardBox = el('div'); body.appendChild(cardBox);
    function draw() {
      ui.clear(list);
      ch.look.forEach(function (x, i) {
        var li = el('li', 'lp-look' + (i === at ? ' on' : '') + (open[i] ? ' done' : ''));
        var hb = ui.btn('lp-look-q'); hb.appendChild(el('span', 'lp-look-n', String(i + 1))); hb.appendChild(el('span', null, x.q));
        hb.addEventListener('click', function () { at = i; draw(); pane.show(x.doc); });
        li.appendChild(hb);
        if (i === at) {
          var r = reveal('查到了什么', x.find, 'lp-find'); li.appendChild(r);
          if (open[i]) { r.querySelector('.lab-q-a').hidden = false; r.classList.add('open'); }
          r.querySelector('.lab-q-h').addEventListener('click', function () { open[i] = true; li.classList.add('done'); });
          if (i < ch.look.length - 1) { var nb = ui.btn('lab-b', '下一问'); nb.addEventListener('click', function () { open[i] = true; at = i + 1; draw(); pane.show(ch.look[at].doc); }); li.appendChild(nb); }
        } else if (open[i]) li.appendChild(html('p', 'lp-look-c', x.card));
        list.appendChild(li);
      });
    }
    draw(); pane.show(ch.look[0].doc);
  };
  /* ③ 规划：同一套框架填一遍；要不要拆模块；拆成哪些函数；.h / .c 各管什么 */
  STAGE.plan = function (body, ch, route, app, pane) {
    function backToCards() { showCards(); }
    function showCards() {
      ui.clear(pane.el.querySelector('.lp-doc-b')); pane.el.querySelector('.lp-doc-h').innerHTML = ''; pane.el.querySelector('.lp-src').textContent = ''; ui.clear(pane.el.querySelector('.lp-acts'));
      pane.el.dataset.kind = 'cards';
      cards(pane.el.querySelector('.lp-doc-b'), ch, pane, backToCards);
    }
    var s1 = sec(body, '按框架填一遍');
    s1.appendChild(html('p', 'lp-lead', '每个外设的初始化都是这几格，只是填的内容不同。先自己想每一格填什么，再展开对答案；忘了就翻资料卡。'));
    var fr = el('div', 'lp-frame-t');
    ch.frame.forEach(function (x) { var row = el('div', 'lp-fr'); row.appendChild(el('b', 'lp-fr-k', x.k)); row.appendChild(reveal(x.q, x.a, 'lp-fr-q')); fr.appendChild(row); });
    s1.appendChild(fr);
    var s2 = sec(body, '要不要拆成模块'); s2.appendChild(reveal(ch.split.q, ch.split.a));
    var s3 = sec(body, '拆的话：对外给哪几个函数');
    var g = el('div', 'lab-fns');
    ch.fns.forEach(function (f) {
      var c = el('article', 'lab-fn'), sig = el('code', 'lab-fn-sig'); sig.appendChild(ui.hlC(f.sig)); c.appendChild(sig);
      c.appendChild(el('p', 'lab-fn-job', f.job));
      var dl = el('dl', 'lab-fn-io'); dl.appendChild(el('dt', null, '参数')); dl.appendChild(el('dd', null, f.args)); dl.appendChild(el('dt', null, '返回')); dl.appendChild(el('dd', null, f.ret));
      c.appendChild(dl); g.appendChild(c);
    });
    s3.appendChild(g);
    function tr(n) { var ul = el('ul', 'lab-tree'); n.forEach(function (x, i) { if (Array.isArray(x)) return; var li = el('li'), cd = el('code'); cd.appendChild(ui.hlC(x)); li.appendChild(cd); if (Array.isArray(n[i + 1])) li.appendChild(tr(n[i + 1])); ul.appendChild(li); }); return ul; }
    s3.appendChild(el('h3', 'lp-h3', '谁先谁后')); s3.appendChild(tr(ch.calls));
    var s4 = sec(body, '.h 和 .c 各管什么');
    ch.place.forEach(function (it) {
      var row = el('div', 'lab-pl'), t = el('span', 'lab-pl-t'), bs = el('span', 'lab-pl-b'), fb = html('p', 'lab-pl-f', '');
      t.appendChild(ui.hlC(it.t)); fb.hidden = true;
      [['.h', true], ['只在 .c', false]].forEach(function (o) {
        var b = ui.btn('lab-pill', o[0]);
        b.addEventListener('click', function () {
          var ok = o[1] === it.h;
          Array.prototype.forEach.call(bs.children, function (x) { x.classList.remove('ok', 'no'); x.setAttribute('aria-pressed', 'false'); });
          b.classList.add(ok ? 'ok' : 'no'); b.setAttribute('aria-pressed', 'true');
          fb.hidden = false; fb.innerHTML = (ok ? '<b>对。</b>' : '<b>应该' + (it.h ? '放进 .h' : '只留在 .c') + '。</b>') + it.why;
        });
        bs.appendChild(b);
      });
      row.appendChild(t); row.appendChild(bs); row.appendChild(fb); s4.appendChild(row);
    });
    showCards();
  };
  /* ④ 编写：第一版只写 main.c；第二版拆成 led 模块 */
  STAGE.code = function (body, ch, route, app, pane) {
    var v = route.fn === 'v2' ? 'v2' : 'v1';
    var sw = el('div', 'lb-chips');
    [['v1', '第一版：全写在 main.c'], ['v2', '第二版：拆成 led 模块']].forEach(function (x) {
      var b = ui.btn('lb-chip', x[1]); b.setAttribute('aria-pressed', String(x[0] === v));
      b.addEventListener('click', function () { app.navigate({ fn: x[0] }, { replace: true }); });
      sw.appendChild(b);
    });
    body.appendChild(sw);
    var picked = null;
    function pick(file, i, code, row) {
      if (picked) picked.classList.remove('lp-picked'); picked = row; row.classList.add('lp-picked');
      var chip = hwChipFor(ch, file, i), st = chip ? stateAfter(ch, chip, i) : null, d = L.docFor(ch, code, st);
      if (d) pane.show(d);
    }
    function hwLink(file) {
      return function (i, code) {
        var chip = hwChipFor(ch, file, i); if (!chip || !/->|LED_(Init|On|Off|Toggle)\(|Delay_ms/.test(code)) return null;
        if (!stateAfter(ch, chip, i)) return null;
        var a = app.link({ v: 'think', t: ch.id, hv: 'run', fn: chip, ln: String(i) }, 'lp-hwl'); a.textContent = '看硬件'; a.title = '在「硬件原理」里看这一行';
        a.addEventListener('click', function (e) { e.stopPropagation(); });
        return a;
      };
    }
    if (v === 'v1') {
      body.appendChild(html('p', 'lp-lead', '只点一个灯（LED1），先不拆文件：把规划里的那几格照顺序写下来，就是一个能跑的程序。点一行，右边换成这一行写的寄存器。'));
      body.appendChild(codeFile('main.c', ch.single, ch.groups.single, function (i, c, row) { pick('single', i, c, row); }, hwLink('single')));
      body.appendChild(reveal('这样写有什么不方便？', '三个灯就要把这几行抄三遍；按键、串口那几章也要点灯，又得再抄；换一块板子，灯换了脚，得把所有地方都找出来改。<b>把「怎么点灯」收进一个模块</b>，main 里只说「点哪个灯」——这就是第二版。'));
      pane.show('reg-apb2');
    } else {
      body.appendChild(html('p', 'lp-lead', '同样的几格，收进 led.c；led.h 只对外说「有哪些函数、灯怎么编号」；main.c 里看不到任何寄存器。'));
      ['led.h', 'led.c', 'main.c'].forEach(function (name) {
        body.appendChild(codeFile(name, L.file(ch, name), ch.groups[name], function (i, c, row) { pick(name, i, c, row); }, hwLink(name)));
      });
      pane.show('reg-crl');
    }
  };
  /* ⑤ 验证：挖空 → 自己写 → 换题 */
  var TOKENS = {
    init: ['RCC->APB2ENR', 'RCC_APB2ENR_IOPAEN', 'LED_PORT->', 'BSRR', 'CRL', 'CRH', '|=', '&= ~(', ' | ', ');', ';', 'GPIO_BSRR_BS', 'GPIO_CRL_CNF', 'GPIO_CRL_MODE', 'GPIO_CRH_CNF', 'GPIO_CRH_MODE'],
    onoff: ['LED_PORT->', 'BSRR', 'ODR', '=', 'led_pin[n]', '(uint32_t)', '<< 16', ';', 'if (', ')', 'return;', '||', '<', '>'],
    key: ['RCC->APB2ENR', 'RCC_APB2ENR_IOPFEN', 'GPIOF->', 'CRH', 'BSRR', 'IDR', '|=', '&= ~(', ' | ', ');', ';', 'GPIO_CRH_CNF8', 'GPIO_CRH_MODE8', '_1', 'GPIO_BSRR_BS8', 'GPIO_IDR_IDR8', 'if (', ') == 0)', 'else', 'LED_On(LED1);', 'LED_Off(LED1);']
  };
  var DOC_OF = { clk: 'reg-apb2', mode: 'reg-crl', others: 'reg-crl', lit: 'reg-bsrr', flash: 'fig-out', on: 'reg-bsrr', onOthers: 'reg-bsrr', onN: 'reg-odr', off: 'reg-bsrr', offOthers: 'reg-bsrr', range: 'reg-odr' };
  function editor(host, key, sig, rows, onFocus) {
    var box = el('figure', 'code lab-ed'), hh = el('figcaption', 'code-h'); hh.appendChild(el('span', 'code-t', sig.file)); box.appendChild(hh);
    var top = el('pre', 'lab-ed-sig'); top.appendChild(ui.hlC(sig.head)); box.appendChild(top);
    var ta = el('textarea', 'lab-ta'); ta.spellcheck = false;
    ['autocapitalize', 'autocomplete', 'autocorrect'].forEach(function (k) { ta.setAttribute(k, 'off'); });
    ta.setAttribute('aria-label', sig.label); ta.rows = rows;
    ta.value = ui.lsGet(key) || sig.init || '    ';
    ta.addEventListener('input', function () { ui.lsSet(key, ta.value); });
    ta.addEventListener('focus', function () { if (onFocus) onFocus(ta); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); ins(ta, '    '); }
      if (e.key === 'Enter') { var s = ta.value.slice(0, ta.selectionStart), ind = /(^|\n)([ \t]*)[^\n]*$/.exec(s)[2]; e.preventDefault(); ins(ta, '\n' + ind); }
    });
    box.appendChild(ta);
    var end = el('pre', 'lab-ed-sig'); end.appendChild(ui.hlC(sig.tail)); box.appendChild(end);
    host.appendChild(box); return ta;
  }
  function ins(ta, s) { var a = ta.selectionStart, b = ta.selectionEnd; if (ta.setRangeText) ta.setRangeText(s, a, b, 'end'); else ta.value = ta.value.slice(0, a) + s + ta.value.slice(b); ta.dispatchEvent(new Event('input')); }
  function tokens(host, list, target) {
    var tk = el('div', 'lab-tokens'); tk.setAttribute('aria-label', '常用写法');
    list.forEach(function (t) {
      var b = ui.btn('lab-tk', t.trim() || t); b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { var ta = target(); ta.focus(); ins(ta, t); });
      tk.appendChild(b);
    });
    host.appendChild(tk);
  }
  function results(host, res, pane) {
    ui.clear(host);
    res.forEach(function (r, k) {
      var it = el('div', 'lab-r lab-r-' + r.k);
      it.appendChild(html('p', 'lab-r-m', r.msg));
      if (r.hints) {
        var lv = 0, hs = el('div', 'lab-hints'), hb = ui.btn('lab-b', '提示');
        hb.addEventListener('click', function () {
          var h = r.hints[lv];
          if (lv === r.hints.length - 1) hs.appendChild(ui.codeBlock(h, { title: '写法' }));
          else hs.appendChild(html('p', null, h));
          if (lv === 1 && (r.doc || DOC_OF[r.id])) pane.show(r.doc || DOC_OF[r.id]);   // 第二级提示：右边换成该查的那份资料
          lv++; if (lv >= r.hints.length) hb.remove(); else hb.textContent = lv === r.hints.length - 1 ? '直接看写法' : '再提示一点';
        });
        it.appendChild(hs); it.appendChild(hb);
      }
      host.appendChild(it);
      void k;
    });
  }
  STAGE.check = function (body, ch, route, app, pane) {
    var lv = ['fill', 'init', 'onoff', 'key'].indexOf(route.fn) >= 0 ? route.fn : 'fill';
    var pickBar = el('div', 'lb-chips');
    [['fill', '① 挖空'], ['init', '② 自己写 LED_Init'], ['onoff', '② 自己写 LED_On / Off'], ['key', '③ 换题：按键']].forEach(function (x) {
      var b = ui.btn('lb-chip', x[1]); b.setAttribute('aria-pressed', String(x[0] === lv));
      b.addEventListener('click', function () { app.navigate({ fn: x[0] }, { replace: true }); });
      pickBar.appendChild(b);
    });
    body.appendChild(pickBar);
    var src = L.file(ch, 'led.c'), fns = L.parseFile(src).fns;
    function hideCards() {   // 自己写的时候资料卡先收起来：先自己回想，想不起来再看
      var b = pane.el.querySelector('.lp-doc-b'); ui.clear(b); pane.el.querySelector('.lp-doc-h').innerHTML = ''; pane.el.querySelector('.lp-src').textContent = ''; ui.clear(pane.el.querySelector('.lp-acts'));
      pane.el.dataset.kind = 'cards';
      var p = el('div', 'lp-recall'); p.appendChild(el('p', null, '先别看资料，自己回想：① 开时钟 → ② 配引脚 → 用。想不起来再打开资料卡。'));
      var ob = ui.btn('lab-b', '打开资料卡'); ob.addEventListener('click', function () { ui.clear(b); cards(b, ch, pane, hideCards); }); p.appendChild(ob);
      b.appendChild(p);
    }
    if (lv === 'fill') {
      body.appendChild(html('p', 'lab-task', '课件的 led.c，挖掉了写寄存器的几行。看着注释写出来；点一个空，右边换成那一行要写的寄存器。'));
      var R = STM.codederive.rows, st = (R.loadSelf().gpio || {}), box = el('div', 'cd-steps lp-fill');
      var fig = el('figure', 'code rc-code cd-file'), hd = el('figcaption', 'code-h'); hd.appendChild(el('span', 'code-t mono', 'led.c')); fig.appendChild(hd);
      var rows = el('div', 'rc-fn'), n = 0, okN = 0;
      var prog = el('span', 'cd-prog'); hd.appendChild(prog);
      function count() { var s = R.loadSelf().gpio || {}, k = 0; Object.keys(s).forEach(function (x) { if (/^led\.c:/.test(x) && s[x]) k++; }); return k; }
      function done(key, how, rowEl, viaKey) {
        var o = R.loadSelf(); o.gpio = o.gpio || {}; o.gpio[key] = how; R.saveSelf(o); prog.textContent = count() + ' / ' + n;
        if (viaKey) { var all = Array.prototype.slice.call(rows.querySelectorAll('.cd-inp')), nx = null; for (var i = 0; i < all.length; i++) if (rowEl.compareDocumentPosition(all[i]) & Node.DOCUMENT_POSITION_FOLLOWING) { nx = all[i]; break; } if (nx) nx.focus(); }
      }
      var groups = ch.groups['led.c'];
      for (var i = 5; i <= 25; i++) {
        var x = src[i], l = R.norm(x), key = 'led.c:' + i;
        if (groups[i]) rows.appendChild(el('div', 'lp-goal', groups[i]));
        var blank = STM.codederive.data.blankable(l.c) && !st[key], row;
        if (STM.codederive.data.blankable(l.c)) n++;
        if (blank) row = R.blank(l, key, done); else { row = R.line(l); if (st[key]) row.classList.add(st[key] === 1 ? 'cd-ok' : 'cd-shown'); }
        row.dataset.code = l.c; rows.appendChild(row);
      }
      okN = count(); prog.textContent = okN + ' / ' + n;
      rows.addEventListener('focusin', function (e) { var r = e.target.closest('[data-code]'); if (r) { var d = L.docFor(ch, r.dataset.code, null); if (d) pane.show(d); } });
      fig.appendChild(rows); box.appendChild(fig); body.appendChild(box);
      var again = ui.btn('lab-b', '重来'); again.addEventListener('click', function () { var o = R.loadSelf(); if (o.gpio) Object.keys(o.gpio).forEach(function (k) { if (/^led\.c:([5-9]|1\d|2[0-5])$/.test(k)) delete o.gpio[k]; }); R.saveSelf(o); app.navigate({ fn: 'fill' }, { replace: true, force: true }); });
      body.appendChild(again);
      pane.show('reg-apb2');
      return;
    }
    if (lv === 'init' || lv === 'onoff') {
      var ex = ch.exercises.filter(function (x) { return x.id === lv; })[0], names = [].concat(ex.fn), ed = {}, last = null;
      body.appendChild(html('p', 'lab-task', ex.ask));
      var ctx = el('figure', 'code lab-ctx'), ch_ = el('figcaption', 'code-h'); ch_.appendChild(el('span', 'code-t', 'led.c 里已经有的')); ctx.appendChild(ch_);
      var pre = el('pre'); pre.appendChild(ui.hlC(src.slice(0, 4).map(function (l) { return l[0]; }).join('\n'))); ctx.appendChild(pre); body.appendChild(ctx);
      var eds = el('div', 'lab-eds'); body.appendChild(eds);
      names.forEach(function (name) { ed[name] = editor(eds, SKEY + ch.id + '.' + name, { file: 'led.c', head: fns[name].sig + '\n{', tail: '}', label: name + ' 的函数体' }, name === 'LED_Init' ? 8 : 3, function (ta) { last = ta; }); });
      tokens(body, TOKENS[lv], function () { return last || ed[names[0]]; });
      var acts = el('div', 'lab-acts'), bC = ui.btn('lab-b lab-p', '检查'), bR = ui.btn('lab-b', '课件写法'), bX = ui.btn('lab-b', '清空');
      var mine = app.link({ v: 'think', t: ch.id, hv: 'run', fn: lv === 'init' ? 'mine-init' : 'mine-on' }, 'lab-b lp-mine'); mine.textContent = '放进「硬件原理」看';
      [bC, bR, bX, mine].forEach(function (b) { acts.appendChild(b); }); body.appendChild(acts);
      var out = el('div', 'lab-res'); out.setAttribute('aria-live', 'polite'); body.appendChild(out);
      var ref = el('div', 'lab-ref'); ref.hidden = true; body.appendChild(ref);
      bR.addEventListener('click', function () { ref.hidden = !ref.hidden; ui.clear(ref); if (!ref.hidden) names.forEach(function (n) { ref.appendChild(ui.codeBlock(fns[n].sig + '\n{\n' + L.body(ch, n) + '\n}', { title: 'led.c' })); }); });
      bX.addEventListener('click', function () { names.forEach(function (n) { ed[n].value = '    '; ui.lsSet(SKEY + ch.id + '.' + n, ed[n].value); }); ui.clear(out); });
      bC.addEventListener('click', function () {
        var res = lv === 'init' ? L.checkInit(ch, ed.LED_Init.value) : L.checkOnOff(ch, ed.LED_On.value, ed.LED_Off.value);
        results(out, res, pane);
      });
      hideCards();
      return;
    }
    // ③ 换题
    var T = ch.transfer;
    body.appendChild(html('p', 'lab-task', T.ask));
    var sl = sec(body, '同一套框架，先查资料');
    var ol = el('ol', 'lp-looks');
    T.look.forEach(function (x, i) {
      var li = el('li', 'lp-look on'), hb = ui.btn('lp-look-q'); hb.appendChild(el('span', 'lp-look-n', String(i + 1))); hb.appendChild(el('span', null, x.q));
      hb.addEventListener('click', function () { pane.show(x.doc); });
      li.appendChild(hb); li.appendChild(reveal('查到了什么', x.a, 'lp-find')); ol.appendChild(li);
    });
    sl.appendChild(ol);
    var sw = sec(body, '再写代码');
    var e1 = el('div', 'lab-eds'); sw.appendChild(e1);
    var lastK = null;
    var kInit = editor(e1, SKEY + ch.id + '.KEY_Init', { file: 'key.c', head: 'void KEY_Init(void)\n{', tail: '}', label: 'KEY_Init 的函数体' }, 6, function (ta) { lastK = ta; });
    var kLoop = editor(e1, SKEY + ch.id + '.KEY_loop', { file: 'main.c', head: 'int main(void)\n{\n    LED_Init();\n    KEY_Init();\n    while (1) {', tail: '    }\n}', label: '主循环里的代码', init: '        ' }, 4, function (ta) { lastK = ta; });
    tokens(sw, TOKENS.key, function () { return lastK || kInit; });
    var ka = el('div', 'lab-acts'), kc = ui.btn('lab-b lab-p', '检查'), kr = ui.btn('lab-b', '参考写法');
    ka.appendChild(kc); ka.appendChild(kr); sw.appendChild(ka);
    var kout = el('div', 'lab-res'); kout.setAttribute('aria-live', 'polite'); sw.appendChild(kout);
    var kref = el('div', 'lab-ref'); kref.hidden = true; sw.appendChild(kref);
    kr.addEventListener('click', function () {
      kref.hidden = !kref.hidden; ui.clear(kref);
      if (!kref.hidden) kref.appendChild(ui.codeBlock('void KEY_Init(void)\n{\n    RCC->APB2ENR |= RCC_APB2ENR_IOPFEN;                  // ① 开 GPIOF 的时钟\n    GPIOF->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);     // ② PF8：先清掉\n    GPIOF->CRH |= GPIO_CRH_CNF8_1;                       //    CNF8 = 10 上拉/下拉输入\n    GPIOF->BSRR = GPIO_BSRR_BS8;                         //    ODR8 = 1 选上拉\n}\n\n// main 的 while (1) 里：\nif ((GPIOF->IDR & GPIO_IDR_IDR8) == 0) LED_On(LED1);   // 按下读到 0\nelse LED_Off(LED1);', { title: '参考写法' }));
    });
    kc.addEventListener('click', function () { results(kout, L.checkKey(ch, kInit.value, kLoop.value), pane); });
    pane.show('sch-key');
  };

  /* ---------- 入口 ---------- */
  STM.views.lab = function (root, route, app) {
    if (route.t && L.chapter(route.t)) return chapterView(root, route, app);
    return home(root, app);
  };
  STM.labprog = { STAGES: STAGES, OLD: OLD, DocPane: DocPane };
})();
