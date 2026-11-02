/* model.js — 把各个数据文件连成一张图：引脚 ↔ 外设主题 ↔ 开发板资源、寄存器、代码片段、架构图、课件章节、勘误、搜索索引 */
(function () {
  'use strict';
  var W = window, STM = W.STM = W.STM || {};
  var PINS = Array.isArray(W.STM32_PINS) ? W.STM32_PINS : [];
  var SNIPS = Array.isArray(W.STM32_SNIPPETS) ? W.STM32_SNIPPETS : [];
  var BOARD = W.STM32_BOARD && Array.isArray(W.STM32_BOARD.resources) ? W.STM32_BOARD : { resources: [] };
  var ASSETS = W.STM32_ASSETS || { board: '', schematic: [] };
  var CW = W.STM32_COURSEWARE && Array.isArray(W.STM32_COURSEWARE.parts) ? W.STM32_COURSEWARE : { parts: [] };
  var ERR = W.STM32_CW_ERRATA && Array.isArray(W.STM32_CW_ERRATA.items) ? W.STM32_CW_ERRATA : null;
  var R = W.STM32RegCore.create(W.STM32_REGS || { groups: [] });

  // 资源路径只接受 assets/ 下的相对路径
  function asset(p) {
    p = String(p || '');
    if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.charAt(0) === '/' || p.indexOf('..') > -1 || p.indexOf('\\') > -1) return '';
    return /^assets\//.test(p) ? p : 'assets/' + p;
  }
  function nums(r) {
    if (Array.isArray(r.pin)) return r.pin.filter(function (n) { return typeof n === 'number'; });
    return typeof r.pin === 'number' ? [r.pin] : [];
  }

  /* ---------- 开发板资源 ---------- */
  var board = BOARD.resources.filter(function (r) { return r && r.name; }).map(function (r, i) {
    return { i: i, group: String(r.group || '其他'), name: String(r.name), mcu: r.mcu ? String(r.mcu) : '', pins: nums(r), active: r.active || '', note: r.note ? String(r.note) : '', page: r.page ? String(r.page) : '' };
  });
  var BOARD_ORDER = ['LED', 'KEY', 'BEEP', '系统', '调试', '串口', 'USB', '存储', '显示', '通信', '传感', '模拟'];
  var boardGroups = BOARD_ORDER.slice();
  board.forEach(function (r) { if (boardGroups.indexOf(r.group) < 0) boardGroups.push(r.group); });
  boardGroups = boardGroups.filter(function (g) { return board.some(function (r) { return r.group === g; }); });

  /* ---------- 引脚 ---------- */
  function split(s) { return s ? String(s).split(/\s+/).filter(Boolean) : []; }
  var pins = PINS.map(function (p) {
    var o = { n: p[0], name: String(p[1]), type: p[2], main: p[3] ? String(p[3]) : '', af: split(p[4]), rm: [], board: [] };
    split(p[5]).forEach(function (x) {
      var k = x.indexOf('@'), sig = k > 0 ? x.slice(0, k) : x, bit = k > 0 ? x.slice(k + 1) : '';
      o.rm.push({ sig: sig === o.name ? 'GPIO' : sig, bit: bit });
    });
    o.sigs = [];
    function add(s) { if (s && o.sigs.indexOf(s) < 0) o.sigs.push(s); }
    if (o.main && o.main !== o.name) o.main.split(/[\/]/).forEach(function (s) { s.split('-').forEach(add); });
    o.af.forEach(add); o.rm.forEach(function (x) { add(x.sig); });
    return o;
  });
  var pinByN = {}, pinByName = {};
  pins.forEach(function (p) { pinByN[p.n] = p; pinByName[p.name.toUpperCase()] = p; });
  board.forEach(function (r) { r.pins.forEach(function (n) { if (pinByN[n]) pinByN[n].board.push(r); }); });
  var TYPE_NAME = { I: 'I/O', P: '电源', G: '地', S: '系统', N: '空脚' };

  /* ---------- 代码片段 ---------- */
  var snips = SNIPS.map(function (s, i) { return { i: i, cat: String(s.cat || ''), title: String(s.title || ''), code: String(s.code || '') }; });
  function snipBy(cat, title) {
    for (var i = 0; i < snips.length; i++) if (snips[i].title === title && (!cat || snips[i].cat === cat)) return snips[i];
    return null;
  }

  /* ---------- 图 ---------- */
  function figOk(f) { return f && f.id && (f.src || f.fallback || f.hd); }
  var figs = [], figById = {};
  (Array.isArray(W.STM32_MANUAL_FIGS) ? W.STM32_MANUAL_FIGS : []).filter(figOk).forEach(function (f) {
    var o = { id: String(f.id), kind: 'manual', title: String(f.title || f.id), label: f.label ? String(f.label) : '', group: f.group || '其他',
      page: f.page != null ? f.page : null, cands: [asset(f.src), asset(f.fallback), asset(f.hd)].filter(Boolean), w: Number(f.width) || 0, h: Number(f.height) || 0, thumb: asset(f.src) };
    figs.push(o); figById[o.id] = o;
  });
  (Array.isArray(W.STM32_TEACH_FIGS) ? W.STM32_TEACH_FIGS : []).filter(figOk).forEach(function (f) {
    var o = { id: String(f.id), kind: 'teach', title: String(f.title || f.id), label: f.label ? String(f.label) : '', group: f.group || '其他',
      page: null, cands: [asset(f.src), asset(f.fallback)].filter(Boolean), w: Number(f.width) || 0, h: Number(f.height) || 0, thumb: asset(f.fallback || f.src) };
    figs.push(o); figById[o.id] = o;
  });

  /* ---------- 原理图 / 实物图 ---------- */
  function pageId(src) { return String(src || '').replace(/^.*\//, '').replace(/\.svg$/i, ''); }
  var sch = (Array.isArray(ASSETS.schematic) ? ASSETS.schematic : []).filter(function (s) { return s && s.src; }).map(function (s) {
    return { id: pageId(s.src), title: String(s.title || pageId(s.src)), group: String(s.group || ''), cands: [asset(s.src), asset(s.fallback)].filter(Boolean), w: Number(s.width) || 0, h: Number(s.height) || 0 };
  });
  var schById = {}; sch.forEach(function (s) { schById[s.id] = s; });
  var schGroups = []; sch.forEach(function (s) { if (schGroups.indexOf(s.group) < 0) schGroups.push(s.group); });
  var photo = asset(ASSETS.board);

  /* ---------- 课件 ---------- */
  var CW_W = 1191, CW_H = 1684;
  function cwSafe(p) { p = String(p || ''); return /^assets\/courseware\//.test(p) && p.indexOf('..') < 0 ? p : ''; }
  var course = CW.parts.filter(function (pt) { return pt && pt.id != null && Array.isArray(pt.pages) && pt.pages.length; }).map(function (pt, pi) {
    var n = pt.pages.length, t = String(pt.title || '');
    var short = /[（(]上[）)]/.test(t) ? '上册' : /[（(]下[）)]/.test(t) ? '下册' : pi === 0 ? '上册' : '下册';
    var chs = (Array.isArray(pt.chapters) ? pt.chapters : []).filter(function (c) {
      return c && c.title != null && Number.isInteger(c.pageIndex) && c.pageIndex >= 0 && c.pageIndex < n;
    }).map(function (c) {
      return { id: String(c.id || ''), part: String(pt.id), title: String(c.title), level: Number(c.level) === 2 ? 2 : 1, start: c.pageIndex, end: n - 1, c: c, kids: [] };
    });
    var parent = null;
    chs.forEach(function (x, k) {
      for (var m = k + 1; m < chs.length; m++) if (chs[m].level <= x.level) { x.end = Math.max(x.start, chs[m].start - 1); break; }
      if (x.level === 1) parent = x; else if (parent) { x.parent = parent; parent.kids.push(x); }
    });
    var titles = [];
    for (var j = 0; j < n; j++) {
      var best = null;
      chs.forEach(function (x) { if (x.start <= j && j <= x.end && (!best || x.level >= best.level)) best = x; });
      titles.push(best);
    }
    return { id: String(pt.id), short: short, title: t, n: n, pages: pt.pages.map(function (p) { return cwSafe(p && p.src); }), chs: chs, at: titles };
  });
  var partById = {}, chapterById = {};
  course.forEach(function (pt) { partById[pt.id] = pt; pt.chs.forEach(function (x) { if (x.id) chapterById[x.id] = x; }); });

  /* ---------- 勘误：册 → 页（从 1 起）→ 条目，按严重程度排序 ---------- */
  var SEV = { err: 3, warn: 2, fmt: 1 }, SEV_WORD = { err: '错误', warn: '可疑', fmt: '排版' };
  var erIdx = {}, erAll = [];
  if (ERR) ERR.items.forEach(function (it, order) {
    if (!it || typeof it !== 'object') return;
    var rec = { sev: SEV[it.sev] ? String(it.sev) : 'fmt', order: order, pageText: it.pageText != null ? String(it.pageText) : '',
      issue: it.issue != null ? String(it.issue) : '', original: it.original != null ? String(it.original) : '', fix: it.fix != null ? String(it.fix) : '' };
    if (it.all) { erAll.push(rec); return; }
    function hang(part, pgs) {
      if (part == null || !Array.isArray(pgs)) return;
      var m = erIdx[String(part)] || (erIdx[String(part)] = {});
      pgs.forEach(function (n) { n = Number(n); if (Number.isInteger(n) && n >= 1) { var l = m[n] || (m[n] = []); if (l.indexOf(rec) < 0) l.push(rec); } });
    }
    hang(it.part, it.pages);
    if (Array.isArray(it.also)) it.also.forEach(function (a) { if (a) hang(a.part, a.pages); });
  });
  Object.keys(erIdx).forEach(function (pid) { Object.keys(erIdx[pid]).forEach(function (n) { erIdx[pid][n].sort(function (a, b) { return (SEV[b.sev] - SEV[a.sev]) || (a.order - b.order); }); }); });
  function erFor(pid, page1) { var m = erIdx[pid]; return (m && m[page1]) || []; }
  function erCount(pid, from1, to1) {
    var m = erIdx[pid], n = 0, best = 0, seen = [];
    if (!m) return { n: 0, sev: '' };
    for (var p = from1; p <= to1; p++) (m[p] || []).forEach(function (r) { if (seen.indexOf(r) < 0) { seen.push(r); n++; if (SEV[r.sev] > best) best = SEV[r.sev]; } });
    return { n: n, sev: best === 3 ? 'err' : best === 2 ? 'warn' : best === 1 ? 'fmt' : '' };
  }

  /* ---------- 外设主题 ---------- */
  var topics = (Array.isArray(W.STM32_TOPICS) ? W.STM32_TOPICS : []).map(function (d, k) {
    var t = Object.assign({}, d, { order: k + 1 });
    // 寄存器
    t.regGroups = [];
    (d.groups || []).forEach(function (gd) {
      var g = R.group(gd.id); if (!g) return;
      var regs = g.regs.filter(function (r) { return (!gd.only || gd.only.test(r.id)) && (!gd.except || !gd.except.test(r.id)); });
      if (regs.length) t.regGroups.push({ g: g, regs: regs });
    });
    t.regCount = t.regGroups.reduce(function (a, x) { return a + x.regs.length; }, 0);
    // 课件章节（一级 + 下面的二级）
    t.chapters = (d.chapters || []).map(function (id) { return chapterById[id]; }).filter(Boolean);
    // 引脚：信号名匹配 / 引脚类型 / 开发板资源分组
    var hit = {};
    function mark(p, why) { var h = hit[p.n] || (hit[p.n] = { p: p, why: [] }); if (why && h.why.indexOf(why) < 0) h.why.push(why); }
    pins.forEach(function (p) {
      if (d.sig) p.sigs.forEach(function (s) { if (d.sig.test(s)) mark(p, s); });
      if (d.types && d.types.indexOf(p.type) > -1) mark(p, TYPE_NAME[p.type]);
    });
    if (d.board) board.forEach(function (r) { if (d.board.indexOf(r.group) > -1) r.pins.forEach(function (n) { if (pinByN[n]) mark(pinByN[n], r.name); }); });
    t.pins = Object.keys(hit).map(function (n) { return hit[n]; }).sort(function (a, b) {
      return (b.p.board.length ? 1 : 0) - (a.p.board.length ? 1 : 0) || a.p.n - b.p.n;
    });
    t.snips = [];
    t.figs = (d.figs || []).concat(d.teach || []).map(function (id) { return figById[id]; }).filter(Boolean);
    return t;
  });
  var topicById = {}; topics.forEach(function (t) { topicById[t.id] = t; });
  /* 每个代码片段只归一个外设。原来靠课件章节判断归属，课件删掉后固定在这张表里；
     表里没有的再按寄存器组的关联（NVIC 组也挂着串口中断片段，靠关联会落到 EXTI，所以要写表） */
  var SNIP_OWNER = {
    "LED 亮灭 / 翻转": "gpio",
    "蜂鸣器": "gpio",
    "按键输入（消抖）": "gpio",
    "EXTI 外部中断（KEY1 下降沿）": "exti",
    "USART1 中断收发": "usart",
    "printf 重定向到 USART1": "usart",
    "I2C 读写 EEPROM（M24C02 · I2C2）": "i2c",
    "定时器中断（TIM6 1s）": "tim",
    "PWM 呼吸灯（LED1 · TIM2_CH1）": "tim",
    "延时 / SysTick": "tim",
    "ADC 读电位器（ADC1 · IN10 · PC0）": "adc",
    "SPI 读 Flash ID（W25Q32 · SPI1）": "spi"
  };
  snips.forEach(function (s) {
    var owner = topicById[SNIP_OWNER[s.title]] || null;
    if (!owner) topics.forEach(function (t) {
      if (!owner && t.regGroups.some(function (x) { return (x.g.snippets || []).some(function (ref) { return ref.title === s.title; }); })) owner = t;
    });
    if (owner) owner.snips.push(s);
  });
  function topicOfReg(id) {
    for (var i = 0; i < topics.length; i++) for (var j = 0; j < topics[i].regGroups.length; j++) if (topics[i].regGroups[j].regs.some(function (r) { return r.id === id; })) return topics[i];
    return null;
  }
  function topicOfSnip(title) { for (var i = 0; i < topics.length; i++) if (topics[i].snips.some(function (s) { return s.title === title; })) return topics[i]; return null; }
  function topicOfChapter(ch) {
    var top = ch && (ch.parent || ch);
    for (var i = 0; i < topics.length; i++) if (topics[i].chapters.indexOf(top) > -1) return topics[i];
    return null;
  }
  function topicsOfPin(n) { return topics.filter(function (t) { return t.pins.some(function (h) { return h.p.n === n; }); }); }

  /* ---------- 搜索索引（第一次搜索时建） ---------- */
  var index = null;
  function buildIndex() {
    if (index) return index;
    index = [];
    function add(kind, title, detail, words, route) { index.push({ kind: kind, title: String(title), detail: String(detail || ''), words: String(words || ''), route: route }); }
    topics.forEach(function (t) {
      add('topic', t.name, t.summary, t.code + ' ' + t.regGroups.map(function (x) { return x.g.name + ' ' + x.g.title + ' ' + (x.g.instances || []).map(function (i) { return i.name; }).join(' '); }).join(' '), { v: 'topic', t: t.id });
    });
    pins.forEach(function (p) {
      add('pin', p.name, '第 ' + p.n + ' 脚' + (p.board.length ? '，板上：' + p.board.map(function (r) { return r.name; }).join('、') : ''),
        p.sigs.join(' ') + ' ' + p.board.map(function (r) { return r.name + ' ' + r.note; }).join(' '), { v: 'home', pin: String(p.n) });
    });
    topics.forEach(function (t) {
      t.regGroups.forEach(function (x) {
        x.regs.forEach(function (r) {
          var k = r.name.indexOf('_'), mem = k > -1 ? r.name.slice(k + 1) : '';
          var alias = [r.id].concat(mem ? (x.g.instances || []).map(function (i) { return i.name + '_' + mem; }) : []);
          add('reg', r.name, (r.title || '') + '，' + t.name, alias.join(' ') + ' ' + (r.title_en || '') + ' ' + r.fields.map(function (f) { return f.reserved ? '' : f.name + ' ' + (f.cmsis || '') + ' ' + (f.desc || ''); }).join(' '),
            { v: 'topic', t: t.id, reg: r.id });
        });
      });
    });
    snips.forEach(function (s) { var t = topicOfSnip(s.title); if (t) add('code', s.title, t.name + '的代码片段', s.code, { v: 'topic', t: t.id, snip: s.title }); });
    // 寄存器代码：每个驱动的每个文件一条，宏名、函数名、注释都能搜到
    var CDX = (W.STM32_CODEDERIVE || {}).CD || {};
    Object.keys(CDX).forEach(function (id) {
      var cd = CDX[id], t = topicById[cd.topic || id]; if (!t || !Array.isArray(cd.files)) return;
      cd.files.forEach(function (f) {
        var words = f.lines.map(function (l) { return l[0] + ' ' + (l[1] || ''); }).join(' ');
        var r = { v: 'topic', t: t.id, cv: 'reg', cf: f.name }; if (cd.topic) r.cx = id;
        add('code', f.name, t.code + ' · ' + cd.title, cd.title + ' ' + words, r);
      });
    });
    figs.forEach(function (f) { add('fig', f.title, (f.kind === 'teach' ? '教学图' : '手册' + (f.label || '图')) + '，' + f.group, f.id, { fig: f.id }); });
    if (0) course.forEach(function (pt) { pt.chs.forEach(function (x) { add('course', x.title, pt.short + ' 第 ' + (x.start + 1) + ' 页', '', { v: 'course', cw: pt.id + '-' + (x.start + 1) }); }); });
    (W.STM32_MODULES || []).forEach(function (m) { add('board', m.tag, (m.part ? m.part + '，' : '') + '模块图', m.pins.map(function (p) { return p.name + ' ' + (p.mcu || ''); }).join(' '), { v: 'home', m: m.id }); });
    board.forEach(function (r) { add('board', r.name, (r.mcu ? r.mcu + '，' : '') + '开发板' + r.group, r.note, r.pins.length === 1 ? { v: 'home', pin: String(r.pins[0]) } : { v: 'board' }); });
    sch.forEach(function (s) { add('sch', s.title, s.group, s.id, { sch: s.id }); });
    return index;
  }

  STM.model = {
    R: R, asset: asset, TYPE_NAME: TYPE_NAME, meta: (W.STM32_REGS && W.STM32_REGS.meta) || {}, boardInfo: BOARD,
    pins: pins, pinByN: pinByN, pinByName: pinByName,
    board: board, boardGroups: boardGroups, photo: photo,
    snips: snips, snipBy: snipBy,
    figs: figs, figById: figById, sch: sch, schById: schById, schGroups: schGroups,
    course: course, partById: partById, chapterById: chapterById, CW_W: CW_W, CW_H: CW_H,
    erFor: erFor, erCount: erCount, erAll: erAll, SEV_WORD: SEV_WORD, errataNotice: !!(ERR && ERR.notice),
    topics: topics, topicById: topicById, topicOfReg: topicOfReg, topicOfSnip: topicOfSnip, topicOfChapter: topicOfChapter, topicsOfPin: topicsOfPin,
    buildIndex: buildIndex
  };
})();
