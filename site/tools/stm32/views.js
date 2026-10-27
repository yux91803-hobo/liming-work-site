/* views.js — 五个基础视图：学习地图 / 外设主题 / 芯片引脚 / 开发板 / 课件
   每个视图 = function (root, route, app) → { title(route), update(route), destroy() } */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, M = STM.model, el = ui.el;
  var CW_KEY = 'lm.stm32.cw';

  function h2(text, id) { var h = el('h2', 'sec-h', text); if (id) h.id = id; return h; }
  function sec(id, title, cls) { var s = el('section', 'sec' + (cls ? ' ' + cls : '')); s.id = 's-' + id; s.appendChild(h2(title)); return s; }
  function pagesText(x) { return x.end > x.start ? '第 ' + (x.start + 1) + '–' + (x.end + 1) + ' 页' : '第 ' + (x.start + 1) + ' 页'; }
  function readPos() { try { var o = JSON.parse(ui.lsGet(CW_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
  function erBadge(pid, from1, to1) {
    var c = M.erCount(pid, from1, to1);
    if (!c.n) return null;
    var b = el('span', 'er-tag sev-' + c.sev, '勘误 ' + c.n);
    b.title = '这一段有 ' + c.n + ' 条勘误（课件里的错误或可疑之处），翻到对应页时会提示';
    return b;
  }
  function topicTag(t, app) {
    var a = app.link({ v: 'topic', t: t.id }, 'ttag'); a.style.setProperty('--h', app.hue(t)); a.textContent = t.code;
    a.setAttribute('aria-label', '外设：' + t.name);
    return a;
  }
  function thumb(src) {
    var f = el('span', 'thumb'), img = el('img');
    img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = src;
    img.addEventListener('error', function () { f.classList.add('missing'); img.remove(); f.appendChild(ui.icon('image')); });
    f.appendChild(img); return f;
  }
  function figGrid(list, app) {
    var grid = el('div', 'fgrid');
    list.forEach(function (f) {
      var b = ui.btn('fcard'); b.appendChild(thumb(f.thumb));
      var t = el('span', 'fcard-t'); t.appendChild(el('b', null, f.title));
      t.appendChild(el('span', null, f.kind === 'teach' ? '教学图' : (f.label || '手册') + (f.page != null ? '，手册第 ' + f.page + ' 页' : '')));
      b.appendChild(t);
      b.addEventListener('click', function () { app.navigate({ fig: f.id }); });
      grid.appendChild(b);
    });
    return grid;
  }

  /* ====================== 学习地图 ====================== */
  function home(root, route, app) {
    var wrap = el('div', 'home');
    var chipCol = el('div', 'home-chip'), chip = STM.chip.create({ labels: false });
    var cap = el('p', 'home-cap');
    chipCol.appendChild(chip.svg); chipCol.appendChild(cap);
    var ioCount = M.pins.filter(function (p) { return p.type === 'I'; }).length;
    function idle() { chip.light(null); cap.textContent = '144 个引脚，其中 ' + ioCount + ' 个可作 I/O。指到下面的外设，看它用到哪些脚。'; }
    idle();

    var col = el('div', 'home-main');
    var head = el('header', 'home-h');
    head.appendChild(el('h1', 'home-t', 'STM32F103ZET6'));
    var spec = el('dl', 'spec');
    [['内核', 'Cortex-M3'], ['主频', '72 MHz'], ['Flash', '512 KB'], ['SRAM', '64 KB'], ['封装', 'LQFP144']].forEach(function (s) {
      var d = el('div'); d.appendChild(el('dt', null, s[0])); d.appendChild(el('dd', null, s[1])); spec.appendChild(d);
    });
    head.appendChild(spec);
    head.appendChild(el('p', 'home-lead', '按外设学：每个外设一页，用到的引脚、寄存器、代码、架构图和课件章节都放在一起。'));
    var fake = ui.btn('home-search'); fake.appendChild(ui.icon('search')); fake.appendChild(el('span', null, '搜引脚、寄存器、外设或课件章节'));
    fake.appendChild(el('kbd', null, '/')); fake.addEventListener('click', app.openSearch);
    head.appendChild(fake);
    col.appendChild(head);

    var path = el('section', 'path');
    var ph = el('div', 'path-h'); ph.appendChild(h2('学习路径')); ph.appendChild(el('p', null, '顺序和课件一致，从系统时钟到 FSMC。')); path.appendChild(ph);
    var ol = el('ol', 'path-list');
    M.topics.forEach(function (t) {
      var li = el('li'), a = app.link({ v: 'topic', t: t.id }, 'trow');
      a.style.setProperty('--h', app.hue(t));
      a.appendChild(el('span', 'trow-n', t.order));
      var ic = el('span', 'trow-ic'); ic.appendChild(ui.icon(t.icon)); a.appendChild(ic);
      var tx = el('span', 'trow-tx');
      var tt = el('span', 'trow-t'); tt.appendChild(el('b', 'trow-code', t.code)); tt.appendChild(el('span', null, t.name.replace(t.code, '').trim() || t.name)); tx.appendChild(tt);
      tx.appendChild(el('span', 'trow-s', t.summary));
      a.appendChild(tx);
      var meta = el('span', 'trow-m');
      if (t.chapters.length) { var c0 = t.chapters[0], pt = M.partById[c0.part]; meta.appendChild(el('span', null, pt.short + ' 第 ' + (c0.start + 1) + ' 页起')); }
      meta.appendChild(el('span', null, t.regCount + ' 个寄存器'));
      a.appendChild(meta);
      var pins = t.pins.map(function (h) { return h.p.n; });
      function on() { chip.light(pins, app.hue(t)); cap.textContent = t.code + (pins.length ? ' 用到 ' + pins.length + ' 个引脚' + (t.board ? '（开发板上接的）' : '') + '。' : ' 不直接占用引脚。'); }
      a.addEventListener('mouseenter', on); a.addEventListener('focus', on);
      a.addEventListener('mouseleave', idle); a.addEventListener('blur', idle);
      li.appendChild(a); ol.appendChild(li);
    });
    path.appendChild(ol);
    col.appendChild(path);

    var more = el('section', 'more');
    more.appendChild(h2('资料'));
    var pos = readPos();
    [[{ v: 'chip' }, 'chip', '芯片引脚', '144 个脚逐个看：复用功能、重映射、开发板上接了什么。'],
     [{ v: 'board' }, 'board', '开发板', M.board.length + ' 个板载资源和对应引脚，' + M.sch.length + ' 页原理图。'],
     [{ v: 'course' }, 'book', '课件', M.course.map(function (p) { return p.short + ' ' + p.n + ' 页' + (pos[p.id] ? '，读到第 ' + pos[p.id] + ' 页' : ''); }).join('；') + '。']
    ].forEach(function (x) {
      var a = app.link(x[0], 'mrow'); a.appendChild(ui.icon(x[1]));
      var t = el('span'); t.appendChild(el('b', null, x[2])); t.appendChild(el('span', null, x[3])); a.appendChild(t);
      more.appendChild(a);
    });
    col.appendChild(more);
    wrap.appendChild(chipCol); wrap.appendChild(col);
    root.appendChild(wrap);
    return { title: function () { return 'STM32 学习台'; } };
  }

  /* ====================== 外设主题 ====================== */
  function topic(root, route, app) {
    var t = M.topicById[route.t], art = el('article', 'topic');
    art.style.setProperty('--h', app.hue(t));
    var head = el('header', 'th'), tx = el('div', 'th-tx');
    tx.appendChild(el('p', 'th-step', '学习路径第 ' + t.order + ' 站，共 ' + M.topics.length + ' 站'));
    var h1 = el('h1', 'th-code', t.code); tx.appendChild(h1);
    tx.appendChild(el('p', 'th-name', t.name));
    tx.appendChild(el('p', 'th-sum', t.summary));
    head.appendChild(tx);
    var mini = STM.chip.create({ labels: false }), mc = el('div', 'th-chip');
    mini.light(t.pins.map(function (h) { return h.p.n; }), app.hue(t));
    mc.appendChild(mini.svg);
    mc.appendChild(el('span', null, t.pins.length ? t.pins.length + ' 个相关引脚' : '不直接占用引脚'));
    head.appendChild(mc);
    art.appendChild(head);

    var parts = [];
    var snav = el('nav', 'snav'); snav.setAttribute('aria-label', '本页内容');
    art.appendChild(snav);

    // 要点
    var s1 = sec('points', '要点'), ul = el('ul', 'points');
    t.points.forEach(function (p) { ul.appendChild(el('li', null, p)); });
    s1.appendChild(ul); parts.push([s1, '要点']);

    // 课件
    if (t.chapters.length) {
      var s2 = sec('course', '课件章节'), cl = el('div', 'chaps');
      t.chapters.forEach(function (ch) {
        [ch].concat(ch.kids).forEach(function (x) {
          var pt = M.partById[x.part], b = ui.btn('chap lv' + x.level);
          var tt = el('span', 'chap-t', x.title); b.appendChild(tt);
          b.appendChild(el('span', 'chap-p', pt.short + ' ' + pagesText(x)));
          var er = erBadge(pt.id, x.start + 1, x.end + 1); if (er) b.appendChild(er);
          b.addEventListener('click', function () { app.navigate({ cw: pt.id + '-' + (x.start + 1) }); });
          cl.appendChild(b);
        });
      });
      s2.appendChild(cl); parts.push([s2, '课件']);
    }

    // 引脚
    if (t.pins.length) {
      var s3 = sec('pins', '引脚'), LIMIT = 18;
      s3.appendChild(el('p', 'sec-note', t.board ? '开发板上接到这些脚，点一个看它的全部功能。' : '能作 ' + t.code + ' 用的脚（含重映射）；板上已经接了东西的排在前面。'));
      var grid = el('div', 'pgrid');
      t.pins.forEach(function (h, k) {
        var p = h.p, a = app.link({ v: 'chip', pin: String(p.n) }, 'ptile' + (k >= LIMIT ? ' extra' : ''));
        var top = el('span', 'ptile-h'); top.appendChild(el('b', null, p.name)); top.appendChild(el('span', null, p.n + ' 脚')); a.appendChild(top);
        a.appendChild(el('span', 'ptile-sig', h.why.join('  ')));
        if (p.board.length) a.appendChild(el('span', 'ptile-b', p.board.map(function (r) { return r.name; }).join('、')));
        grid.appendChild(a);
      });
      s3.appendChild(grid);
      if (t.pins.length > LIMIT) {
        var mb = ui.btn('more-btn', '再显示 ' + (t.pins.length - LIMIT) + ' 个');
        mb.addEventListener('click', function () { grid.classList.add('all'); mb.remove(); });
        s3.appendChild(mb);
      }
      parts.push([s3, '引脚']);
    }

    // 寄存器
    if (t.regCount) {
      var s4 = sec('regs', '寄存器');
      s4.appendChild(el('p', 'sec-note', '点一个寄存器打开计算器：逐位改值，直接得到 C 代码。'));
      t.regGroups.forEach(function (x) {
        var gb = el('div', 'rgroup'), gh = el('div', 'rgroup-h');
        gh.appendChild(el('b', null, x.g.name)); gh.appendChild(el('span', null, x.g.title));
        var inst = (x.g.instances || []).map(function (i) { return i.name; });
        if (inst.length > 1) gh.appendChild(el('span', 'rgroup-i', inst.join(' ')));
        gb.appendChild(gh);
        if (x.g.note) gb.appendChild(el('p', 'sec-note', x.g.note));
        x.regs.forEach(function (r) {
          var b = ui.btn('rrow'); b.dataset.reg = r.id;
          b.appendChild(el('b', 'rrow-n', r.name));
          b.appendChild(el('span', 'rrow-t', r.title || ''));
          b.appendChild(el('span', 'rrow-o', r.offsetText ? '' : '+' + String(r.offset || '').replace(/^0x/i, '0x')));
          b.addEventListener('click', function () { app.navigate({ reg: r.id }); });
          gb.appendChild(b);
        });
        if (Array.isArray(x.g.modeTable) && x.g.modeTable.length) gb.appendChild(modeTable(x.g));
        s4.appendChild(gb);
      });
      parts.push([s4, '寄存器']);
    }

    // 代码
    var snipEls = {};
    if (t.snips.length) {
      var s5 = sec('code', '代码');
      s5.appendChild(el('p', 'sec-note', 'HAL 写法，按片段开头的注释在 CubeMX 里配好外设和引脚，再把代码合进生成的工程。'));
      t.snips.forEach(function (s) {
        var card = el('div', 'snip'); card.id = 'snip-' + s.i;
        var hh = el('div', 'snip-h'); hh.appendChild(el('h3', null, s.title)); card.appendChild(hh);
        var cb = ui.codeBlock(s.code, { title: s.cat, copyLabel: '复制「' + s.title + '」' });
        var lines = s.code.split('\n').length;
        if (lines > 22) {
          cb.classList.add('folded');
          var ex = ui.btn('unfold', '展开全部 ' + lines + ' 行');
          ex.addEventListener('click', function () { cb.classList.remove('folded'); ex.remove(); });
          cb.appendChild(ex);
        }
        card.appendChild(cb);
        snipEls[s.title] = card;
        s5.appendChild(card);
      });
      parts.push([s5, '代码']);
    }

    // 图
    if (t.figs.length) {
      var s6 = sec('figs', '架构图');
      s6.appendChild(el('p', 'sec-note', '手册里的框图和课件里的教学图，点开可以放大。'));
      s6.appendChild(figGrid(t.figs, app));
      parts.push([s6, '图']);
    }

    parts.forEach(function (x) {
      art.appendChild(x[0]);
      var a = el('a', 'snav-i', x[1]); a.href = '#' + x[0].id;
      a.addEventListener('click', function (e) { e.preventDefault(); x[0].scrollIntoView({ behavior: ui.reduced() ? 'auto' : 'smooth', block: 'start' }); });
      snav.appendChild(a);
    });

    // 上一站 / 下一站
    var foot = el('nav', 'tnext'); foot.setAttribute('aria-label', '学习路径');
    var prev = M.topics[t.order - 2], next = M.topics[t.order];
    [[prev, '上一站'], [next, '下一站']].forEach(function (x) {
      if (!x[0]) { foot.appendChild(el('span')); return; }
      var a = app.link({ v: 'topic', t: x[0].id }, 'tnext-i'); a.style.setProperty('--h', app.hue(x[0]));
      a.appendChild(el('span', null, x[1])); a.appendChild(el('b', null, x[0].code + '  ' + (x[0].name.replace(x[0].code, '').trim() || x[0].name)));
      foot.appendChild(a);
    });
    art.appendChild(foot);
    root.appendChild(art);

    // 分节导航：滚动时标出当前所在的节
    var io = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (!e.isIntersecting) return;
          Array.prototype.forEach.call(snav.children, function (a) { a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id); });
        });
      }, { rootMargin: '-20% 0px -70% 0px' });
      parts.forEach(function (x) { io.observe(x[0]); });
    }
    var lastSnip = null;
    function focusSnip(r) {
      if (!r.snip || r.snip === lastSnip) return;
      lastSnip = r.snip;
      var c = snipEls[r.snip]; if (!c) return;
      requestAnimationFrame(function () {
        c.scrollIntoView({ block: 'start', behavior: ui.reduced() ? 'auto' : 'smooth' });
        c.classList.remove('hit'); void c.offsetWidth; c.classList.add('hit');
      });
    }
    focusSnip(route);
    return {
      title: function () { return t.name; },
      update: function (r) { focusSnip(r); },
      destroy: function () { if (io) io.disconnect(); }
    };
  }
  // GPIO 8 种模式速查表（CNF / MODE / 半字节 / HAL 写法）
  function modeTable(g) {
    var box = el('div', 'mtable'), cap = el('h3', null, '8 种模式速查');
    box.appendChild(cap);
    var tb = el('table'), thead = el('thead'), tr = el('tr');
    ['模式', 'CNF', 'MODE', '4 位', 'ODR'].forEach(function (c) { tr.appendChild(el('th', null, c)); });
    thead.appendChild(tr); tb.appendChild(thead);
    var body = el('tbody');
    g.modeTable.forEach(function (m) {
      var r = el('tr');
      r.appendChild(el('td', null, m.title));
      r.appendChild(el('td', 'mono', m.cnf)); r.appendChild(el('td', 'mono', m.mode));
      r.appendChild(el('td', 'mono', m.nibble + ' (' + m.bits + ')'));
      r.appendChild(el('td', 'mono', m.odr == null ? '' : String(m.odr)));
      body.appendChild(r);
    });
    tb.appendChild(body);
    var scroller = el('div', 'tscroll'); scroller.appendChild(tb); box.appendChild(scroller);
    if (g.modeTableNote) box.appendChild(el('p', 'sec-note', g.modeTableNote));
    return box;
  }

  /* ====================== 芯片引脚 ====================== */
  function sigTopic(sig) {
    for (var i = 0; i < M.topics.length; i++) if (M.topics[i].sig && M.topics[i].sig.test(sig)) return M.topics[i];
    return null;
  }
  function chipView(root, route, app) {
    var wrap = el('div', 'chipv');
    var head = el('header', 'pg-h'); head.appendChild(el('h1', null, '芯片引脚'));
    head.appendChild(el('p', null, 'LQFP144 封装，1 脚在左上角，逆时针编号。点一个脚，或者在下面按名字、功能筛选。'));
    wrap.appendChild(head);
    var fl = el('label', 'filter'); fl.appendChild(ui.icon('search'));
    var fin = el('input'); fin.type = 'search'; fin.placeholder = 'PA9、USART1、TIM2_CH1、LED…'; fin.setAttribute('aria-label', '筛选引脚');
    fin.setAttribute('autocomplete', 'off'); fin.setAttribute('autocapitalize', 'characters'); fin.setAttribute('spellcheck', 'false');
    fl.appendChild(fin); var fcount = el('span', 'filter-n'); fl.appendChild(fcount);
    wrap.appendChild(fl);

    var grid = el('div', 'chipv-g');
    var stage = el('div', 'chipv-stage zoom-view'), content = el('div', 'zoom-content');
    var chip = STM.chip.create({ labels: true, interactive: true, onPick: function (n) { app.update({ pin: String(n) }); } });
    content.appendChild(chip.svg); stage.appendChild(content);
    var zoomHint = el('p', 'chipv-hint', '双击或双指放大；按 Tab 进入引脚后可用方向键逐脚移动。');
    var left = el('div', 'chipv-l'); left.appendChild(stage); left.appendChild(zoomHint);
    var legend = el('div', 'legend');
    [['t-I', 'I/O'], ['t-P', '电源'], ['t-G', '地'], ['t-S', '系统'], ['used', '开发板上已接']].forEach(function (x) { var s = el('span', 'lg ' + x[0]); s.appendChild(el('i')); s.appendChild(el('span', null, x[1])); legend.appendChild(s); });
    left.appendChild(legend);
    var detail = el('div', 'pdetail'); detail.setAttribute('aria-live', 'polite');
    grid.appendChild(left); grid.appendChild(detail);
    wrap.appendChild(grid);
    root.appendChild(wrap);
    var zoom = ui.Zoomer(stage, content, {
      max: 8, dbl: 3, wheelNeedsCtrl: true, wheelPans: true, scrollAtFit: true,
      onTap: function (target) { var g = target && target.closest ? target.closest('[data-pin]') : null; if (!g) return false; app.update({ pin: g.getAttribute('data-pin') }); return true; }
    });
    var S = chip.S, lastW = 0;
    function fit() { var w = stage.clientWidth; if (w && w !== lastW) { lastW = w; zoom.fit(S, S); } }
    var ro = window.ResizeObserver ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(stage); else window.addEventListener('resize', fit);
    requestAnimationFrame(fit);

    function matches(q) {
      var Q = String(q || '').toUpperCase().replace(/\s+/g, ''), out = [];
      if (!Q) return out;
      M.pins.forEach(function (p) {
        var hay = [p.name].concat(p.sigs, p.board.map(function (r) { return r.name.toUpperCase(); }));
        if (String(p.n) === Q || hay.some(function (s) { return String(s).toUpperCase().replace(/\s+/g, '').indexOf(Q) > -1; })) out.push(p.n);
      });
      return out;
    }
    function renderDetail(n) {
      ui.clear(detail);
      var p = M.pinByN[n];
      if (!p) {
        detail.appendChild(el('h2', 'pd-empty-h', '选一个引脚'));
        detail.appendChild(el('p', 'sec-note', '这里会列出它的主功能、全部复用功能、重映射条件，以及开发板上接了什么。'));
        var quick = el('div', 'pd-quick');
        ['PA9', 'PA0', 'PB10', 'PC13', 'PA13'].forEach(function (nm) { var q = M.pinByName[nm]; if (!q) return; var b = ui.btn('chipbtn', nm); b.addEventListener('click', function () { app.update({ pin: String(q.n) }); }); quick.appendChild(b); });
        detail.appendChild(quick);
        return;
      }
      var hh = el('div', 'pd-h'); hh.appendChild(el('h2', 'mono', p.name)); hh.appendChild(el('span', null, p.n + ' 脚，' + M.TYPE_NAME[p.type])); detail.appendChild(hh);
      function sigRow(label, list, fmt) {
        if (!list.length) return;
        var r = el('div', 'pd-row'); r.appendChild(el('h3', null, label));
        var w = el('div', 'pd-sigs');
        list.forEach(function (x) {
          var name = fmt ? fmt(x).sig : x, extra = fmt ? fmt(x).extra : '', tp = sigTopic(name);
          var s = tp ? app.link({ v: 'topic', t: tp.id }, 'sig') : el('span', 'sig');
          if (tp) { s.style.setProperty('--h', app.hue(tp)); s.title = '打开 ' + tp.name; }
          s.appendChild(el('b', null, name)); if (extra) s.appendChild(el('span', null, extra));
          w.appendChild(s);
        });
        r.appendChild(w); detail.appendChild(r);
      }
      if (p.main && p.main !== p.name) sigRow('复位后的功能', [p.main]);
      sigRow('复用功能', p.af);
      sigRow('重映射后可用', p.rm.filter(function (x) { return x.sig !== 'GPIO'; }), function (x) { return { sig: x.sig, extra: x.bit ? '需 ' + x.bit : '' }; });
      if (p.board.length) {
        var br = el('div', 'pd-row'); br.appendChild(el('h3', null, '开发板上'));
        p.board.forEach(function (r) {
          var b = el('div', 'pd-board'); b.appendChild(el('b', null, r.name));
          if (r.note) b.appendChild(el('span', null, r.note));
          if (r.page && M.schById[r.page]) { var a = ui.btn('linkbtn', '看原理图：' + M.schById[r.page].title); a.addEventListener('click', function () { app.navigate({ sch: r.page }); }); b.appendChild(a); }
          br.appendChild(b);
        });
        detail.appendChild(br);
      }
      var tps = M.topicsOfPin(p.n);
      if (tps.length) {
        var tr = el('div', 'pd-row'); tr.appendChild(el('h3', null, '相关外设'));
        var tw = el('div', 'pd-sigs'); tps.forEach(function (t) { tw.appendChild(topicTag(t, app)); }); tr.appendChild(tw); detail.appendChild(tr);
      }
      if (p.type === 'I' && /^P[A-G]\d+$/.test(p.name)) {
        var y = Number(p.name.slice(2)), port = 'GPIO' + p.name.charAt(1);
        var rb = ui.btn('linkbtn', '配置这个脚：' + port + (y < 8 ? '_CRL' : '_CRH'));
        rb.addEventListener('click', function () { app.navigate({ v: 'topic', t: 'gpio', reg: y < 8 ? 'GPIO_CRL' : 'GPIO_CRH', i: port }); });
        var rr = el('div', 'pd-row'); rr.appendChild(rb); detail.appendChild(rr);
      }
    }
    var lastPin = null, lastQ = null;
    function apply(r) {
      var q = r.q || '';
      if (q !== lastQ) {
        lastQ = q; if (fin.value.trim() !== q) fin.value = q;
        var hits = matches(q);
        chip.light(hits, null);
        fcount.textContent = q ? hits.length + ' 个' : '';
      }
      var n = r.pin ? Number(r.pin) : null;
      if (n !== lastPin) {
        lastPin = n; chip.select(n); renderDetail(n);
        if (n) requestAnimationFrame(function () { var pos = chip.pos(n); zoom.focus(pos.x, pos.y, Math.max(2.2, 1)); });
      }
    }
    fin.addEventListener('input', ui.debounce(function () { app.update({ q: fin.value.trim() || null }); }, 120));
    fin.addEventListener('keydown', function (e) { if (e.key === 'Escape' && fin.value) { e.preventDefault(); fin.value = ''; app.update({ q: null }); } });
    apply(route);
    return { title: function () { return '芯片引脚'; }, update: apply, destroy: function () { if (ro) ro.disconnect(); } };
  }

  /* ====================== 开发板 ====================== */
  var ACT = { low: '低电平有效', high: '高电平有效', data: '数据线' };
  function boardView(root, route, app) {
    var wrap = el('div', 'boardv');
    var head = el('header', 'pg-h'); head.appendChild(el('h1', null, '开发板'));
    head.appendChild(el('p', null, (M.boardInfo.board || '尚硅谷 STM32F103ZET6 开发板') + '：板上每个资源接在哪个脚、高电平还是低电平有效。'));
    wrap.appendChild(head);
    if (M.photo) {
      var ph = ui.btn('photo'); ph.appendChild(thumb(M.photo)); ph.appendChild(el('span', null, '实物图，点开放大'));
      ph.addEventListener('click', function () { app.navigate({ sch: 'photo' }); });
      wrap.appendChild(ph);
    }
    var res = el('section', 'sec'); res.appendChild(h2('板载资源'));
    M.boardGroups.forEach(function (gname) {
      var g = el('div', 'bgroup'); g.appendChild(el('h3', null, gname));
      M.board.filter(function (r) { return r.group === gname; }).forEach(function (r) {
        var row = el('div', 'brow');
        var nm = el('div', 'brow-n'); nm.appendChild(el('b', null, r.name)); if (r.note) nm.appendChild(el('span', null, r.note)); row.appendChild(nm);
        var pin = el('div', 'brow-p');
        if (r.pins.length === 1) { var a = app.link({ v: 'chip', pin: String(r.pins[0]) }, 'mono'); a.textContent = r.mcu || String(r.pins[0]); pin.appendChild(a); }
        else pin.appendChild(el('span', 'mono', r.mcu || ''));
        if (ACT[r.active]) pin.appendChild(el('span', 'act a-' + r.active, ACT[r.active]));
        row.appendChild(pin);
        if (r.page && M.schById[r.page]) { var b = ui.btn('linkbtn', '原理图'); b.setAttribute('aria-label', r.name + ' 的原理图'); b.addEventListener('click', function () { app.navigate({ sch: r.page }); }); row.appendChild(b); }
        else row.appendChild(el('span'));
        g.appendChild(row);
      });
      res.appendChild(g);
    });
    wrap.appendChild(res);
    var sc = el('section', 'sec'); sc.appendChild(h2('原理图'));
    M.schGroups.forEach(function (gname) {
      var g = el('div', 'bgroup'); g.appendChild(el('h3', null, gname || '原理图'));
      var list = el('div', 'schlist');
      M.sch.filter(function (s) { return s.group === gname; }).forEach(function (s) {
        var b = ui.btn('schrow'); b.appendChild(el('span', null, s.title)); b.appendChild(ui.icon('next'));
        b.addEventListener('click', function () { app.navigate({ sch: s.id }); });
        list.appendChild(b);
      });
      g.appendChild(list); sc.appendChild(g);
    });
    wrap.appendChild(sc);
    root.appendChild(wrap);
    return { title: function () { return '开发板'; } };
  }

  /* ====================== 课件 ====================== */
  function courseView(root, route, app) {
    var wrap = el('div', 'coursev');
    var head = el('header', 'pg-h'); head.appendChild(el('h1', null, '课件'));
    head.appendChild(el('p', null, '尚硅谷 STM32 课件，上下两册。章节右边是它所属的外设；标了勘误的章节，翻到那页时会提示具体问题。'));
    wrap.appendChild(head);
    var conts = [];
    // 「接着读」按钮：读过的页记在本机；从查看器回来时刷新
    function syncCont() {
      var pos = readPos();
      conts.forEach(function (x) {
        var p = Number(pos[x.pt.id]), ok = Number.isInteger(p) && p >= 1 && p <= x.pt.n;
        x.b.hidden = !ok; x.p = p; if (ok) x.b.textContent = '接着读第 ' + p + ' 页';
      });
    }
    M.course.forEach(function (pt) {
      var s = el('section', 'vol'), vh = el('div', 'vol-h');
      vh.appendChild(el('h2', null, pt.short)); vh.appendChild(el('span', null, pt.n + ' 页'));
      var x = { pt: pt, b: ui.btn('cont'), p: 0 };
      x.b.addEventListener('click', function () { app.navigate({ cw: pt.id + '-' + x.p }); });
      vh.appendChild(x.b); conts.push(x);
      s.appendChild(vh);
      var list = el('div', 'chaps');
      pt.chs.forEach(function (x) {
        var row = el('div', 'chap-row lv' + x.level), b = ui.btn('chap lv' + x.level);
        b.appendChild(el('span', 'chap-t', x.title)); b.appendChild(el('span', 'chap-p', pagesText(x)));
        var er = erBadge(pt.id, x.start + 1, x.end + 1); if (er) b.appendChild(er);
        b.addEventListener('click', function () { app.navigate({ cw: pt.id + '-' + (x.start + 1) }); });
        row.appendChild(b);
        var tp = x.level === 1 ? M.topicOfChapter(x) : null;
        if (tp) row.appendChild(topicTag(tp, app));
        list.appendChild(row);
      });
      s.appendChild(list); wrap.appendChild(s);
    });
    root.appendChild(wrap);
    syncCont();
    return { title: function () { return '课件'; }, update: syncCont };
  }

  STM.views = { home: home, topic: topic, chip: chipView, board: boardView, course: courseView };
  STM.viewsUtil = { figGrid: figGrid, thumb: thumb, CW_KEY: CW_KEY };
})();
