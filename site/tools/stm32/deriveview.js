/* deriveview.js — 「编程思维」推导章节的界面
   内容在 derive-*.js（window.STM32_DERIVE），逻辑在 derive-core.js，总线模拟在 i2csim.js。
   路由：v=think&t=i2c（章节首页：推导链地图）· &s=s5（某一环）· &s=review（常卡的地方）
   两种学法（存在本机 lm.stm32.derive.mode）：
     完整推导 full：整段推理连续展开，「先想一想」可答可不答；
     自主推导 self：推理在每个问题前停下，答完才往下走，一次只处理一个小问题。
   进度与「常卡的地方」只存在本机（localStorage lm.stm32.derive）。 */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, M = STM.model, el = ui.el, sv = ui.sv;
  var Sim = window.STM32I2CSim, McuSim = window.STM32McuSim, C = window.STM32DeriveCore;
  var CH = window.STM32_DERIVE || {};
  var KEY = 'lm.stm32.derive';
  var KIND = { need: '想要', idea: '最朴素的想法', test: '做个实验', trouble: '问题来了', fix: '改进', why: '为什么这样设计', alt: '别的办法',
    hw: '落到芯片', hist: '真实情况', mine: '对照你的笔记', say: '' };

  /* ---------- 存储 ---------- */
  function load() { try { var o = JSON.parse(ui.lsGet(KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
  function save(o) { ui.lsSet(KEY, JSON.stringify(o)); }
  function mode() { return load().mode === 'self' ? 'self' : 'full'; }
  function setMode(m) { var o = load(); o.mode = m; save(o); }
  function chState(id) { var o = load(); return (o.ch && o.ch[id]) || {}; }
  function edit(id, fn) { var o = load(); o.ch = o.ch || {}; var s = o.ch[id] = o.ch[id] || {}; fn(s); save(o); return s; }

  /* ---------- 小工具 ---------- */
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function shuffle(list, seed) {
    var a = list.slice(), r = seed || 1;
    function rnd() { r = Math.imul(r ^ (r >>> 15), 2246822507) ^ Math.imul(r ^ (r >>> 13), 3266489909); r ^= r >>> 16; return (r >>> 0) / 4294967296; }
    for (var k = 0; k < 4; k++) {
      for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
      if (a.some(function (x, i) { return x !== list[i]; })) break;
    }
    return a;
  }
  function hx(v) { return '0x' + Sim.hx(v); }
  function focusSoft(n) { if (!n) return; if (!n.hasAttribute('tabindex')) n.tabIndex = -1; try { n.focus({ preventScroll: true }); } catch (e) {} }
  function scrollNear(n) { if (n) n.scrollIntoView({ block: 'nearest', behavior: ui.reduced() ? 'auto' : 'smooth' }); }

  function view(root, route, app) {
    var ch = CH[route.t];
    var wrap = el('div', 'dv'); root.appendChild(wrap);
    var topic = M.topicById[ch.topic];
    wrap.style.setProperty('--h', app.hue(topic));
    var S = C.stepById(ch), ASK = C.allAsks(ch);
    var cur = null, body = null, bar = null;

    /* ---------- 行内文字 ---------- */
    function rich(text, tag, cls) {
      var p = el(tag || 'p', cls);
      C.inline(text).forEach(function (f) {
        if (f.t != null) p.appendChild(document.createTextNode(f.t));
        else if (f.b != null) p.appendChild(el('b', null, f.b));
        else if (f.code != null) p.appendChild(el('code', 'ic-code', f.code));
        else if (f.step) p.appendChild(stepLink(f.step));
        else if (f.fact) p.appendChild(factChip(f.fact));
      });
      return p;
    }
    function paras(t, host, cls) { [].concat(t || []).forEach(function (x) { host.appendChild(rich(x, 'p', cls)); }); }
    function stepNo(id) { return S[id] ? S[id]._i + 1 : '?'; }
    function stepLink(id) {
      var s = S[id]; if (!s) return document.createTextNode(id);
      var a = app.link({ v: 'think', t: ch.id, s: id }, 'dv-sl');
      a.textContent = '问题 ' + (s._i + 1); a.title = s.q;
      return a;
    }
    function factChip(f) {
      var x = ch.facts[f]; if (!x) return document.createTextNode(f);
      var b = el('span', 'dv-fc', f); b.title = x.t; b.setAttribute('aria-label', '结论 ' + f + '：' + x.t);
      return b;
    }
    function linkBtn(l) {
      var label = '', go = null, ic = 'info';
      if (l.reg) { var r = M.R.reg(l.reg); if (r) { var k = r.name.indexOf('_'); label = '寄存器计算器：' + (l.i && k > 0 ? l.i + r.name.slice(k) : r.name) + (l.val ? ' = ' + l.val : ''); ic = 'chip'; go = function () { app.navigate({ reg: l.reg, i: l.i, val: l.val }); }; } }
      else if (l.sch) { var sc = M.schById[l.sch]; if (sc) { label = '原理图：' + sc.title; ic = 'board'; go = function () { app.navigate({ sch: l.sch }); }; } }
      else if (l.fig) { var f = M.figById[l.fig]; if (f) { label = '图：' + f.title; ic = 'image'; go = function () { app.navigate({ fig: l.fig }); }; } }
      else if (l.pin) { var p = M.pinByName[String(l.pin).toUpperCase()]; if (p) { label = '引脚：' + p.name + (p.board.length ? '（' + p.board[0].name + '）' : ''); ic = 'chip'; go = function () { app.navigate({ v: 'home', pin: String(p.n) }); }; } }
      if (!go) return null;
      var b = ui.btn('linkbtn dv-link'); b.appendChild(ui.icon(ic)); b.appendChild(el('span', null, label));
      b.addEventListener('click', go);
      return b;
    }

    /* =================== 题目 =================== */
    // ask(a, o)：o.mode = 'full' | 'self' | 'review'；o.onSolved(firstTry)；返回元素
    function ask(a, o) {
      o = o || {};
      var box = el('div', 'dv-ask dv-ask-' + a.type + (o.mode === 'full' ? ' soft' : ''));
      box.dataset.ask = a.id;
      var tag = el('div', 'dv-ask-tag');
      tag.appendChild(ui.icon(a.predict ? 'idea' : 'idea'));
      tag.appendChild(el('span', null, a.predict ? '先猜猜看' : a.type === 'explain' ? '用自己的话说' : o.mode === 'review' ? '再想一次' : '停下来想一想'));
      box.appendChild(tag);
      var head = rich(a.q, 'p', 'dv-ask-q'); head.tabIndex = -1; box.appendChild(head); box._head = head;
      var bodyB = el('div', 'dv-ask-b'), fb = el('div', 'dv-fb'); fb.setAttribute('aria-live', 'polite');
      box.appendChild(bodyB); box.appendChild(fb);
      var tries = 0, solved = false, reveal = null;
      function miss(back, assume) {
        tries++;
        if (o.mode === 'review') return;
        edit(ch.id, function (s) { C.recordMiss(s.stuck = s.stuck || {}, a.id, back || ASK[a.id] && ASK[a.id].stepId, assume); });
      }
      function say(kind, parts) {
        ui.clear(fb);
        var d = el('div', 'fb fb-' + kind);
        d.appendChild(ui.icon(kind === 'ok' ? 'check' : kind === 'no' ? 'info' : 'idea'));
        var t = el('div', 'fb-t'); parts.forEach(function (p) { if (p) t.appendChild(p.nodeType ? p : rich(p)); }); d.appendChild(t);
        fb.appendChild(d);
      }
      function wrongNote(opt) {
        var parts = [];
        if (opt.assume) { var p1 = el('p'); p1.appendChild(el('b', null, '你默认了：')); p1.appendChild(document.createTextNode(opt.assume + '。')); parts.push(p1); }
        if (opt.counter) { var p2 = rich('**反例：**' + opt.counter); parts.push(p2); }
        if (opt.back && S[opt.back]) {
          var p3 = el('p', 'fb-back'), here = ASK[a.id] && ASK[a.id].stepId === opt.back;
          if (here) p3.appendChild(document.createTextNode('这正是这一环要推的东西：回到上面再读一遍，看看哪一句和你的想法不一样。'));
          else { p3.appendChild(document.createTextNode('推理是在前面这一环出的岔子：')); p3.appendChild(stepLink(opt.back)); p3.appendChild(document.createTextNode('「' + S[opt.back].q + '」')); }
          parts.push(p3);
        }
        return parts;
      }
      function done(revealed) {
        if (solved) return; solved = true; box.classList.add('solved');
        if (reveal) { reveal.remove(); reveal = null; }
        if (a.explain) say('ok', [(revealed ? '答案已经标出来了。' : '') + a.explain]);
        else if (!revealed) say('ok', ['对。']);
        if (o.onSolved) o.onSolved(!revealed && tries === 0);
      }
      function offerReveal(fn) {
        if (reveal || solved) return;
        reveal = ui.btn('textbtn dv-reveal', '看答案');
        reveal.addEventListener('click', fn); box.appendChild(reveal);
      }
      if (o.mode === 'full') offerReveal(function () { revealAll(); });
      var revealAll = function () { done(true); };

      if (a.type === 'choice') {
        var opts = a.opts.map(function (x, i) { return { x: x, i: i }; }), list = el('div', 'dv-opts'); list.setAttribute('role', 'group');
        opts = shuffle(opts, hash(a.id));
        var btns = [];
        opts.forEach(function (it) {
          var b = ui.btn('dv-opt'); b.appendChild(el('i', 'dv-dot')); b.appendChild(rich(it.x.t, 'span'));
          b.addEventListener('click', function () {
            if (solved || b.disabled) return;
            if (it.x.ok) { b.classList.add('right'); btns.forEach(function (y) { y.disabled = true; }); done(false); return; }
            b.classList.add('wrong'); b.disabled = true; b.setAttribute('aria-label', it.x.t + '（不对）');
            miss(it.x.back, it.x.assume);
            say('no', wrongNote(it.x));
            if (tries >= 2) offerReveal(revealAll);
          });
          btns.push(b); list.appendChild(b);
        });
        revealAll = function () { btns.forEach(function (b, k) { b.disabled = true; if (opts[k].x.ok) b.classList.add('right'); }); done(true); };
        bodyB.appendChild(list);
      }

      else if (a.type === 'fill') {
        var row = el('div', 'dv-fill'), inp = el('input', 'mono'), go = ui.btn('pill solid', '检查');
        inp.setAttribute('aria-label', '你的答案'); inp.setAttribute('autocomplete', 'off'); inp.setAttribute('autocapitalize', 'off'); inp.setAttribute('spellcheck', 'false'); inp.setAttribute('enterkeyhint', 'done');
        row.appendChild(inp); row.appendChild(go); bodyB.appendChild(row);
        var acc = a.answers.map(function (x) { return String(x).toLowerCase().replace(/\s+/g, ''); });
        function test() {
          if (solved) return;
          var v = inp.value.toLowerCase().replace(/\s+/g, ''); if (!v) { inp.focus(); return; }
          if (acc.indexOf(v) > -1) { inp.classList.add('right'); inp.readOnly = true; go.hidden = true; done(false); return; }
          miss(ASK[a.id] && ASK[a.id].stepId, null);
          inp.classList.remove('shake'); void inp.offsetWidth; inp.classList.add('shake');
          var h = (a.hints || [])[Math.min(tries, (a.hints || []).length) - 1];
          say('hint', ['还不对。' + (h ? '提示 ' + Math.min(tries, a.hints.length) + '：' + h : '')]);
          if (tries >= (a.hints || []).length) offerReveal(revealAll);
        }
        revealAll = function () { inp.value = a.answers[0]; inp.readOnly = true; go.hidden = true; done(true); };
        go.addEventListener('click', test);
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); test(); } });
        if (a.link) { var lb = linkBtn(a.link); if (lb) box.appendChild(lb); }
      }

      else if (a.type === 'explain') {
        var ta = el('textarea', 'dv-ta'); ta.rows = 4; ta.placeholder = '先别看下面，自己写几句。写得不完整也没关系。';
        ta.setAttribute('aria-label', '你的解释');
        var cmp = ui.btn('pill solid', '写好了，对照要点');
        bodyB.appendChild(ta); var r2 = el('div', 'dv-row'); r2.appendChild(cmp); bodyB.appendChild(r2);
        var res = el('div', 'dv-explain'); bodyB.appendChild(res);
        cmp.addEventListener('click', function () {
          if (solved) return;
          var txt = ta.value.trim();
          if (!txt && o.mode !== 'full') { ta.focus(); ui.toast('先写几句再对照'); return; }
          cmp.hidden = true; ta.readOnly = true; ui.clear(res);
          res.appendChild(el('p', 'dv-explain-h', '你的解释里有没有说到这几点？（自动勾了可能提到的，你可以自己改）'));
          var checks = [];
          a.points.forEach(function (pt) {
            var hit = (pt.kw || []).every(function (k) { return new RegExp(k, 'i').test(txt); });
            var lab = el('label', 'dv-pt'), cb = el('input'); cb.type = 'checkbox'; cb.checked = hit;
            lab.appendChild(cb); lab.appendChild(rich(pt.t, 'span')); res.appendChild(lab); checks.push({ cb: cb, pt: pt });
          });
          var model = el('div', 'dv-model'); model.appendChild(el('b', null, '参考说法')); model.appendChild(rich(a.model)); res.appendChild(model);
          var ok = ui.btn('pill solid', '好了');
          ok.addEventListener('click', function () {
            var missed = checks.filter(function (c) { return !c.cb.checked; });
            checks.forEach(function (c) { c.cb.disabled = true; });
            ok.remove();
            if (missed.length) { missed.forEach(function (c) { miss(ASK[a.id] && ASK[a.id].stepId, '没想到：' + c.pt.t); }); }
            tries = missed.length;
            solved = true; box.classList.add('solved'); if (reveal) { reveal.remove(); reveal = null; }
            say(missed.length ? 'hint' : 'ok', [missed.length ? '漏掉的 ' + missed.length + ' 点记进了「常卡的地方」，之后会再问你。' : '要点都说到了。']);
            if (o.onSolved) o.onSolved(!missed.length);
          });
          var r3 = el('div', 'dv-row'); r3.appendChild(ok); res.appendChild(r3);
        });
        revealAll = function () { if (!cmp.hidden) cmp.click(); };
      }

      else if (a.type === 'order') {
        var it = C.orderItems(ch, a), texts = it.texts, isCode = !!a.fn;
        var pool = shuffle(texts.map(function (_, i) { return i; }), hash(a.id)), placed = [], marks = [];
        var ans = el('ol', 'dv-oans' + (isCode ? ' code' : '')), poolB = el('div', 'dv-opool' + (isCode ? ' code' : ''));
        var meta = el('p', 'dv-ometa'), chk = ui.btn('pill solid', '检查');
        bodyB.appendChild(el('p', 'dv-sub', '点下面的' + (isCode ? '代码行' : '项') + '按顺序放进上面；点已放的可以拿回来。只要符合因果关系就算对，不要求和答案一字不差。'));
        bodyB.appendChild(ans); bodyB.appendChild(poolB);
        var r4 = el('div', 'dv-row'); r4.appendChild(meta); r4.appendChild(chk); bodyB.appendChild(r4);
        var simBox = el('div', 'dv-osim'); bodyB.appendChild(simBox);
        function chip(i, inAns, k) {
          var b = ui.btn('dv-chip' + (isCode ? ' mono' : '') + (marks.indexOf(k) > -1 && inAns ? ' bad' : ''));
          if (inAns) b.appendChild(el('span', 'dv-cn', k + 1));
          if (isCode) { var cs = el('span', 'dv-chipc'); cs.appendChild(ui.hlC(texts[i])); b.appendChild(cs); } else b.appendChild(el('span', null, texts[i]));
          b.addEventListener('click', function () {
            if (solved) return;
            if (inAns) { placed.splice(k, 1); pool.push(i); } else { pool.splice(pool.indexOf(i), 1); placed.push(i); }
            marks = []; draw();
          });
          return b;
        }
        function draw() {
          ui.clear(ans); ui.clear(poolB);
          placed.forEach(function (i, k) { var li = el('li'); li.appendChild(chip(i, true, k)); ans.appendChild(li); });
          if (!placed.length) ans.appendChild(el('li', 'dv-oempty', '按顺序点下面的' + (isCode ? '代码行' : '项')));
          pool.forEach(function (i) { poolB.appendChild(chip(i, false)); });
          meta.textContent = '已放 ' + placed.length + ' / ' + texts.length;
          chk.disabled = solved || placed.length !== texts.length; chk.hidden = solved;
        }
        chk.addEventListener('click', function () {
          var r = C.checkOrder(texts, placed, it.rules);
          ui.clear(simBox);
          if (r.ok) {
            draw(); ans.classList.add('ok');
            if (isCode) simBox.appendChild(orderSim(a, it, placed, null));
            done(false); return;
          }
          var ka = r.mapped.indexOf(r.rule.a), kb = r.mapped.indexOf(r.rule.b);
          marks = [ka, kb]; draw();
          miss(r.rule.back, null);
          var parts = [];
          var p1 = el('p'); p1.appendChild(el('b', null, '第 ' + (kb + 1) + ' 项和第 ' + (ka + 1) + ' 项的先后不对。')); parts.push(p1);
          parts.push(rich(r.rule.why));
          if (r.rule.back && S[r.rule.back]) { var p3 = el('p', 'fb-back'); p3.appendChild(document.createTextNode('回看：')); p3.appendChild(stepLink(r.rule.back)); p3.appendChild(document.createTextNode('「' + S[r.rule.back].q + '」')); parts.push(p3); }
          say('no', parts);
          if (isCode) simBox.appendChild(orderSim(a, it, placed, r.rule));
          if (tries >= 3) offerReveal(revealAll);
        });
        revealAll = function () { placed = texts.map(function (_, i) { return i; }); pool = []; marks = []; draw(); ans.classList.add('ok'); ui.clear(simBox); done(true); };
        draw();
      }
      box.isSolved = function () { return solved; };
      box.revealAll = function () { revealAll(); };
      return box;
    }
    // 排序题（代码）：用学生排出的顺序跑一次，和正确版本对比
    function orderSim(a, it, placed, rule) {
      var fnPatch = {}; fnPatch[a.fn] = C.orderToPatch(it.fn, it.sub, placed);
      var sc = rule && rule.sc ? rule.sc : defaultSc(a.fn);
      var ref = C.runScenario(ch, sc), got = C.runScenario(ch, sc, { patch: fnPatch });
      var d = C.diff(ref, got), box = el('div', 'dv-osim-b');
      var h = el('p', 'dv-osim-h'); h.appendChild(ui.icon('wave'));
      h.appendChild(el('span', null, (rule ? '用你的顺序跑一次「' : '用你的顺序跑了一次「') + ch.scenarios[sc].title + '」' + (rule ? '——这就是反例：' : '：和正确版本在线上完全一样。')));
      box.appendChild(h);
      if (rule) { var ul = el('ul', 'dv-diff'); (d.length ? d : ['这个场景里看不出区别（但规则仍然成立，换个场景就会出问题）。']).forEach(function (x) { ul.appendChild(el('li', null, x)); }); box.appendChild(ul); }
      box.appendChild(simResult(got, { compact: true }));
      return box;
    }
    function defaultSc(fn) { if (ch.engine === 'mcu') return (ch.fns[fn] && ch.fns[fn].sc) || ch.defaultSc; return fn === 'i2c_read_byte' || fn === 'i2c_send_nack' || fn === 'eeprom_read_byte' ? 'read' : fn === 'i2c_wait_ack' ? 'nodev' : 'write'; }

    /* =================== 波形 =================== */
    function waveform(res, opt) {
      opt = opt || {};
      var tr = res.trace, ev = res.ev, PX = 4.2, GAP = 40, GW = 30, H = 26, top = 30;
      // 时间 → x：很长的空档压缩成固定宽度
      var xs = [{ t: tr[0].t, x: 10 }], gaps = [];
      for (var i = 1; i < tr.length; i++) {
        var dt = tr[i].t - tr[i - 1].t, px = xs[xs.length - 1].x;
        if (dt > GAP) { xs.push({ t: tr[i - 1].t + 6, x: px + 6 * PX }); xs.push({ t: tr[i].t - 6, x: px + 6 * PX + GW }); gaps.push({ x: px + 6 * PX, t: dt }); xs.push({ t: tr[i].t, x: px + 12 * PX + GW }); }
        else xs.push({ t: tr[i].t, x: px + dt * PX });
      }
      var endT = tr[tr.length - 1].t, endX = xs[xs.length - 1].x + 24;
      function X(t) {
        if (t <= xs[0].t) return xs[0].x;
        for (var k = 1; k < xs.length; k++) if (t <= xs[k].t) { var a = xs[k - 1], b = xs[k]; return b.t === a.t ? b.x : a.x + (b.x - a.x) * (t - a.t) / (b.t - a.t); }
        return xs[xs.length - 1].x;
      }
      var W = Math.max(endX, 200), rowS = top, rowD = top + H + 22, Hh = rowD + H + 44;
      var s = sv('svg', { 'class': 'dv-wave', viewBox: '0 0 ' + W + ' ' + Hh, width: W, height: Hh, role: 'img', 'aria-label': 'SCL 和 SDA 的波形' });
      function path(d, cls) { s.appendChild(sv('path', { d: d, 'class': cls })); }
      function lvl(y, v) { return v ? y : y + H; }
      // SCL
      var d = 'M' + X(tr[0].t) + ' ' + lvl(rowS, tr[0].scl);
      for (i = 1; i < tr.length; i++) if (tr[i].scl !== tr[i - 1].scl) { var x = X(tr[i].t); d += 'H' + x + 'V' + lvl(rowS, tr[i].scl); }
      d += 'H' + endX; path(d, 'w-scl');
      // SDA：按谁在拉分段上色
      function who(p) { return p.sda ? 'w-hi' : p.ms === 0 && p.ss === 0 ? 'w-both' : p.ss === 0 ? 'w-slave' : 'w-master'; }
      var segStart = 0;
      for (i = 1; i <= tr.length; i++) {
        if (i === tr.length || tr[i].sda !== tr[segStart].sda || who(tr[i]) !== who(tr[segStart])) {
          var x0 = X(tr[segStart].t), x1 = i === tr.length ? endX : X(tr[i].t), y = lvl(rowD, tr[segStart].sda);
          path('M' + x0 + ' ' + y + 'H' + x1, 'w-sda ' + who(tr[segStart]));
          if (i < tr.length && tr[i].sda !== tr[segStart].sda) path('M' + x1 + ' ' + lvl(rowD, tr[segStart].sda) + 'V' + lvl(rowD, tr[i].sda), 'w-sda w-edge');
          segStart = i;
        }
      }
      s.appendChild(sv('text', { x: 2, y: rowS - 6, 'class': 'w-lab' }, 'SCL'));
      s.appendChild(sv('text', { x: 2, y: rowD - 6, 'class': 'w-lab' }, 'SDA'));
      // 压缩的空档
      gaps.forEach(function (g) {
        path('M' + (g.x + 8) + ' ' + (rowS - 4) + 'l6 ' + (H + 8) + 'M' + (g.x + 16) + ' ' + (rowS - 4) + 'l6 ' + (H + 8), 'w-gap');
        path('M' + (g.x + 8) + ' ' + (rowD - 4) + 'l6 ' + (H + 8) + 'M' + (g.x + 16) + ' ' + (rowD - 4) + 'l6 ' + (H + 8), 'w-gap');
        s.appendChild(sv('text', { x: g.x + GW / 2 + 3, y: rowD + H + 16, 'class': 'w-gapt', 'text-anchor': 'middle' }, '≈' + (g.t >= 1000 ? (g.t / 1000).toFixed(1) + ' ms' : Math.round(g.t) + ' µs')));
      });
      // 事件
      var byteDir = 0;
      ev.forEach(function (e) {
        var x = X(e.t);
        if (e.k === 'S' || e.k === 'Sr' || e.k === 'P') {
          path('M' + x + ' ' + (rowS - 6) + 'V' + (rowD + H + 4), 'w-mark ' + (e.k === 'P' ? 'w-p' : 'w-s'));
          var tg = sv('g', { 'class': 'w-tag ' + (e.k === 'P' ? 'w-p' : 'w-s') });
          tg.appendChild(sv('rect', { x: x - 11, y: 2, width: 22, height: 16, rx: 4 }));
          tg.appendChild(sv('text', { x: x, y: 14, 'text-anchor': 'middle' }, e.k));
          s.appendChild(tg);
        } else if (e.k === 'bit') {
          s.appendChild(sv('text', { x: x + 2.5 * PX, y: rowS + H / 2 + 4, 'class': 'w-bit' + (e.n === 9 ? ' w-9' : ''), 'text-anchor': 'middle' }, e.v));
        } else if (e.k === 'byte') {
          var xa = X(e.t) - 6, xb = X(e.t1) + 26;
          if (e.first) byteDir = e.v & 1;
          path('M' + xa + ' ' + (rowD + H + 8) + 'v4H' + xb + 'v-4', 'w-brk');
          s.appendChild(sv('text', { x: (xa + xb) / 2, y: rowD + H + 26, 'class': 'w-byte', 'text-anchor': 'middle' }, hx(e.v) + (e.first ? (e.v & 1 ? ' 地址·读' : ' 地址·写') : byteDir ? ' 读到' : '')));
        } else if (e.k === 'A' || e.k === 'N') {
          var t = sv('text', { x: x + 6, y: rowD + H + 40, 'class': 'w-ack ' + (e.k === 'A' ? (e.by === 'm' && !opt.masterAckOk ? 'w-fake' : 'w-a') : 'w-n'), 'text-anchor': 'middle' }, e.k === 'A' ? (e.by === 's' ? 'A·从机' : 'A·主机') : 'N');
          s.appendChild(t);
        } else if (e.k === 'warn') {
          var wg = sv('g', { 'class': 'w-warn' }); wg.appendChild(sv('circle', { cx: x, cy: rowS + H + 11, r: 7 })); wg.appendChild(sv('text', { x: x, y: rowS + H + 15, 'text-anchor': 'middle' }, '!'));
          wg.appendChild(sv('title', null, e.text)); s.appendChild(wg);
        }
      });
      var sc = el('div', 'dv-wavebox'); sc.appendChild(s);
      sc.tabIndex = 0; sc.setAttribute('aria-label', '波形（可以左右滚动）');
      return sc;
    }
    function legend() {
      var lg = el('div', 'dv-legend');
      [['w-master', '主机拉低'], ['w-slave', 'EEPROM 拉低'], ['w-both', '两边都在拉'], ['w-hi', '都松手（上拉 = 1）']].forEach(function (x) {
        var i = el('span'); i.appendChild(el('i', x[0])); i.appendChild(el('span', null, x[1])); lg.appendChild(i);
      });
      return lg;
    }
    // 解码结果 → 一串小标签；最后没凑够一个字节的位也显示出来
    function eventChips(res) {
      var row = el('ol', 'dv-evs'), dir = 0, bits = [];
      res.ev.forEach(function (e) {
        if (e.k === 'bit') { bits.push(e.v); if (bits.length === 9) bits = []; return; }
        var t = null, cls = '';
        if (e.k === 'S') { t = '起始'; cls = 's'; bits = []; }
        else if (e.k === 'Sr') { t = '重复起始'; cls = 's'; bits = []; }
        else if (e.k === 'P') { t = '停止'; cls = 'p'; bits = []; }
        else if (e.k === 'byte') { if (e.first) dir = e.v & 1; t = e.first ? hx(e.v) + '（' + hx(e.v >> 1) + ' ' + (dir ? '读' : '写') + '）' : (dir ? '读到 ' : '写 ') + hx(e.v); cls = 'b'; }
        else if (e.k === 'A') { t = e.by === 's' ? '应答' : '应答？（主机自己拉的）'; cls = e.by === 's' ? 'a' : 'fake'; }
        else if (e.k === 'N') { t = '非应答'; cls = 'n'; }
        else if (e.k === 'warn') { t = '⚠ ' + e.text; cls = 'w'; }
        if (!t) return;
        var last = row.lastChild;
        if (last && last._t === t) { last._n++; last.textContent = t + ' ×' + last._n; return; }   // 连续相同的事件合并
        var li = el('li', 'ev-' + cls, t); li._t = t; li._n = 1; row.appendChild(li);
      });
      if (bits.length) row.appendChild(el('li', 'ev-bits', '已送出 ' + bits.length + ' 位：' + bits.join('') + (bits.length === 8 ? '（还没有第 9 个时钟）' : '')));
      return row;
    }
    /* ---------- 通用单片机模拟的结果：灯、串口助手、引脚波形、外设日志 ---------- */
    var PINLAB = { PA0: 'PA0 · LED1', PA1: 'PA1 · LED2', PA8: 'PA8 · LED3', PA9: 'PA9 · TX', PA10: 'PA10 · RX', PA5: 'PA5 · SCK', PA6: 'PA6 · MISO', PA7: 'PA7 · MOSI', PC13: 'PC13 · CS', PF8: 'PF8 · KEY1', PF10: 'PF10 · KEY3', PC0: 'PC0' };
    function mcuWave(res, v) {
      var from = v.from || 0, to = v.to || res.t, pins = v.pins, W = Math.max(240, Math.min(900, v.w || 860)), H = 22, gap = 16, top = 8, lab = 92;
      var Hh = top + pins.length * (H + gap) + 26;
      var s = sv('svg', { 'class': 'dv-wave mw', viewBox: '0 0 ' + (W + lab + 10) + ' ' + Hh, width: W + lab + 10, height: Hh, role: 'img', 'aria-label': '引脚波形 ' + pins.join('、') });
      function X(t) { return lab + (Math.max(from, Math.min(to, t)) - from) / (to - from) * W; }
      pins.forEach(function (p, r) {
        var y0 = top + r * (H + gap), tr = res.trace[p] || [], zs = [];
        s.appendChild(sv('text', { x: 0, y: y0 + H / 2 + 4, 'class': 'w-lab' }, PINLAB[p] || p));
        var cur = null, segs = [];
        tr.forEach(function (e) { if (e[0] <= from) cur = e[1]; });
        segs.push([from, cur]);
        tr.forEach(function (e) { if (e[0] > from && e[0] < to) segs.push([e[0], e[1]]); });
        // 分段画：浮空（Z）的地方画成中间的虚线
        var parts = [], cur2 = '';
        segs.forEach(function (sg, k) {
          var x0 = X(sg[0]), x1 = X(k + 1 < segs.length ? segs[k + 1][0] : to), lv = sg[1];
          if (lv === 'Z' || lv == null) { zs.push('M' + x0 + ' ' + (y0 + H / 2) + 'H' + x1); if (cur2) { parts.push(cur2); cur2 = ''; } return; }
          var y = lv ? y0 : y0 + H;
          cur2 += (cur2 ? 'L' : 'M') + x0 + ' ' + y + 'H' + x1;
        });
        if (cur2) parts.push(cur2);
        parts.forEach(function (pd) { s.appendChild(sv('path', { d: pd, 'class': 'w-sig' + (/^PA[018]$/.test(p) ? ' led' : '') })); });
        if (zs.length) s.appendChild(sv('path', { d: zs.join(''), 'class': 'w-z' }));
        if (p === 'PA9' && v.bytes !== false) res.uart.forEach(function (u) {
          if (u.t < from || u.t > to) return;
          var xa = X(u.t), xb = X(u.t + 10 * 1e6 / 115200);
          if (xb - xa < 14) return;
          s.appendChild(sv('text', { x: (xa + xb) / 2, y: y0 + H + 13, 'class': 'w-byte', 'text-anchor': 'middle' }, u.b >= 32 && u.b < 127 ? "'" + String.fromCharCode(u.b) + "'" : '0x' + Sim.hx(u.b)));
        });
      });
      // 时间轴
      var ay = Hh - 14;
      s.appendChild(sv('path', { d: 'M' + lab + ' ' + ay + 'H' + (lab + W), 'class': 'w-brk' }));
      for (var k = 0; k <= 4; k++) {
        var t = from + (to - from) * k / 4, x = X(t);
        s.appendChild(sv('path', { d: 'M' + x + ' ' + (ay - 3) + 'V' + (ay + 3), 'class': 'w-brk' }));
        s.appendChild(sv('text', { x: x, y: ay + 12, 'class': 'w-gapt', 'text-anchor': k === 0 ? 'start' : k === 4 ? 'end' : 'middle' }, McuSim.fmtT(t)));
      }
      if (v.fit) { s.setAttribute('width', '100%'); s.removeAttribute('height'); }
      var box = el('div', 'dv-wavebox'); box.appendChild(s); box.tabIndex = 0; box.setAttribute('aria-label', '波形（可以左右滚动）');
      return box;
    }
    function mcuResult(res, opt) {
      opt = opt || {};
      var box = el('div', 'dv-simres mcu'), sc = res.sc || {};
      if (res.stop.kind !== 'end') {
        var st = el('div', 'dv-stop'); st.appendChild(ui.icon('warn'));
        var tx = el('div'); tx.appendChild(el('b', null, { stuck: '程序卡住了', irq: '程序卡在中断里', nohandler: '进了默认中断处理', error: '模拟出错' }[res.stop.kind] || '程序停了'));
        tx.appendChild(el('span', null, res.stop.text));
        if (res.where && ch.fns[res.where[0]]) { var ln = ch.fns[res.where[0]].lines[res.where[1]]; if (ln) { var c = el('code', 'dv-stop-c'); c.textContent = res.where[0] + '() 第 ' + (res.where[1] + 1) + ' 行：' + ln.c.trim(); tx.appendChild(c); } }
        st.appendChild(tx); box.appendChild(st);
      }
      var leds = el('div', 'dv-leds');
      ['LED1', 'LED2', 'LED3'].forEach(function (n) {
        var L = res.leds[n]; if (!L || !L.summary) return;
        var row = el('div', 'dv-led'), lamp = el('i', 'dv-lamp'), on = L.ev.length ? L.ev[L.ev.length - 1][1] : false;
        var many = L.ev.length > 12, tOn = 0;
        if (many) { for (var i = 0; i < L.ev.length; i++) if (L.ev[i][1]) tOn += (i + 1 < L.ev.length ? L.ev[i + 1][0] : res.t) - L.ev[i][0]; lamp.style.opacity = String(0.25 + 0.75 * tOn / res.t); lamp.classList.add('on'); }
        else if (on) lamp.classList.add('on');
        row.appendChild(lamp); row.appendChild(el('span', null, L.summary));
        leds.appendChild(row);
      });
      if (leds.firstChild) box.appendChild(leds);
      if (res.terminal || res.printf || res.uart.length) {
        var term = el('div', 'dv-term'), th = el('div', 'dv-term-h');
        th.appendChild(el('span', null, res.printf && !res.terminal ? '串口助手（printf 已重定向到 USART1）' : '电脑上的串口助手（115200 8N1）'));
        term.appendChild(th);
        var pre = el('pre'); pre.textContent = (res.terminal || res.printf).replace(/\n$/, '') || ' '; term.appendChild(pre);
        box.appendChild(term);
      }
      var views = sc.view ? [].concat(sc.view) : [{ pins: Object.keys(res.trace).filter(function (p) { return res.trace[p].length > 1; }).slice(0, 5) }];
      views.forEach(function (v) {
        if (!v.pins || !v.pins.length) return;
        if (v.label) box.appendChild(el('p', 'dv-wlab', v.label));
        box.appendChild(mcuWave(res, opt.compact ? Object.assign({ w: 260, fit: true }, v) : v));
      });
      var logs = res.log;
      if (logs.length) {
        var lg = el('details', 'dv-log' + (res.log.some(function (x) { return x.k === 'warn'; }) ? ' warn' : ''));
        var nw = res.log.filter(function (x) { return x.k === 'warn'; }).length;
        lg.appendChild(el('summary', null, '芯片里发生了什么（' + logs.length + ' 条' + (nw ? '，其中 ' + nw + ' 条警告' : '') + '）'));
        if (nw && !opt.compact) lg.open = true;
        var ul = el('ol'); logs.forEach(function (x) { var li = el('li', 'lg-' + x.k); li.appendChild(el('span', 'lg-t', McuSim.fmtT(x.t))); li.appendChild(el('span', null, x.text)); ul.appendChild(li); }); lg.appendChild(ul); box.appendChild(lg);
      }
      return box;
    }
    function simResult(res, opt) {
      if (res.engine === 'mcu') return mcuResult(res, opt);
      opt = opt || {};
      var box = el('div', 'dv-simres');
      box.appendChild(waveform(res));
      if (!opt.compact) box.appendChild(legend());
      box.appendChild(eventChips(res));
      var facts = el('div', 'dv-simfacts');
      res.results.forEach(function (r) {
        if (!r.entry) return;
        var t = r.entry + '() 返回 ' + C.fmtRet(r.ret) + (r.out != null ? '，读到 ' + C.fmtRet(r.out) : '');
        facts.appendChild(el('span', 'dv-pill' + (r.ret ? ' bad' : ''), t));
      });
      res.watch.filter(function (w) { return w.v != null; }).forEach(function (w) { facts.appendChild(el('span', 'dv-pill mem', 'EEPROM[' + hx(w.addr) + '] = ' + hx(w.v))); });
      if (!res.device) facts.appendChild(el('span', 'dv-pill', '板上没有 EEPROM'));
      if (facts.firstChild) box.appendChild(facts);
      if (!opt.compact && res.log.length) {
        var lg = el('details', 'dv-log'); lg.appendChild(el('summary', null, 'EEPROM 听到了什么（' + res.log.length + ' 条）'));
        var ul = el('ol'); res.log.forEach(function (x) { ul.appendChild(el('li', 'lg-' + x.k, x.text)); }); lg.appendChild(ul); box.appendChild(lg);
      }
      var bad = res.timing.filter(function (t) { return !t.ok; });
      var tm = el('details', 'dv-timing' + (bad.length ? ' bad' : ''));
      tm.appendChild(el('summary', null, bad.length ? '时序检查：' + bad.length + ' 项不满足标准模式' : '时序检查：满足标准模式（100 kHz）的最小时间'));
      var tb = el('table'), hr = el('tr'); ['参数', '含义', '规范最小', '实测最小'].forEach(function (h) { hr.appendChild(el('th', null, h)); }); tb.appendChild(hr);
      res.timing.forEach(function (t) { var r = el('tr', t.ok ? null : 'bad'); [t.k, t.name, t.spec + ' µs', t.min == null ? '—' : t.min + ' µs'].forEach(function (c) { r.appendChild(el('td', null, c)); }); tb.appendChild(r); });
      tm.appendChild(tb); box.appendChild(tm);
      if (res.err) box.appendChild(el('p', 'dv-err', '模拟中止：' + res.err));
      return box;
    }
    function simWidget(b) {
      var sc = ch.scenarios[b.sc], box = el('figure', 'dv-w dv-sim');
      if (b.cap) box.appendChild(rich(b.cap, 'figcaption', 'dv-cap'));
      if (sc.compare) {
        var grid = el('div', 'dv-cmp');
        sc.compare.forEach(function (id) { var col = el('div', 'dv-cmpc'); col.appendChild(el('h4', null, ch.scenarios[id].title)); col.appendChild(simResult(C.runScenario(ch, id), { compact: true })); grid.appendChild(col); });
        box.appendChild(grid); if (ch.engine !== 'mcu') box.appendChild(legend());
        return box;
      }
      if (ch.engine === 'mcu') {
        var outM = el('div'), pot = sc.board && sc.board.pot != null ? sc.board.pot : 1.65;
        var runM = function () { ui.clear(outM); outM.appendChild(simResult(C.runScenario(ch, sc, b.edit === 'pot' ? { board: { pot: pot } } : {}))); };
        if (b.edit === 'pot') {
          var pc = el('div', 'dv-simctl'), pl = el('label'), pin = el('input'), pv = el('b', 'mono');
          pin.type = 'range'; pin.min = 0; pin.max = 330; pin.value = Math.round(pot * 100); pv.textContent = pot.toFixed(2) + ' V';
          pl.appendChild(el('span', null, '电位器拧到')); pl.appendChild(pin); pl.appendChild(pv); pc.appendChild(pl); box.appendChild(pc);
          pin.addEventListener('input', function () { pot = Number(pin.value) / 100; pv.textContent = pot.toFixed(2) + ' V'; });
          pin.addEventListener('change', runM);
        }
        box.appendChild(outM); runM();
        return box;
      }
      var out = el('div');
      var state = { mem: 0x12, data: 0x5A, device: sc.device !== false };
      function runIt() {
        ui.clear(out);
        var opt = { device: state.device };
        if (b.edit) opt.params = [{ mem: state.mem, data: state.data }];
        var scx = b.edit ? Object.assign({}, sc, { watch: [state.mem] }) : sc;
        out.appendChild(simResult(C.runScenario(ch, scx, opt)));
      }
      if (b.edit) {
        var ctl = el('div', 'dv-simctl');
        function hexIn(label, key) {
          var l = el('label'); l.appendChild(el('span', null, label));
          var i = el('input', 'mono'); i.value = hx(state[key]); i.setAttribute('inputmode', 'text'); i.setAttribute('autocomplete', 'off'); i.setAttribute('spellcheck', 'false'); i.size = 5;
          i.addEventListener('change', function () { var v = parseInt(i.value.replace(/^0x/i, ''), 16); if (isFinite(v) && v >= 0 && v <= 255) { state[key] = v; i.value = hx(v); runIt(); } else i.value = hx(state[key]); });
          l.appendChild(i); return l;
        }
        ctl.appendChild(hexIn('存储地址', 'mem')); ctl.appendChild(hexIn('数据', 'data'));
        var dl = el('label', 'dv-sw'), cb = el('input'); cb.type = 'checkbox'; cb.checked = state.device; dl.appendChild(cb); dl.appendChild(el('span', null, '板上有 EEPROM'));
        cb.addEventListener('change', function () { state.device = cb.checked; runIt(); });
        ctl.appendChild(dl); box.appendChild(ctl);
      }
      box.appendChild(out); runIt();
      return box;
    }

    /* =================== 共线实验 =================== */
    function busWidget(b) {
      var n = b.n || 2, md = b.mode, names = ['STM32', 'M24C02', '传感器'], st = [], box = el('figure', 'dv-w dv-bus');
      for (var i = 0; i < n; i++) st.push(md === 'pp' ? (i === 0 ? 1 : 0) : 1);
      if (b.cap) box.appendChild(rich(b.cap, 'figcaption', 'dv-cap'));
      var W = 340, Hh = 220, svgHost = el('div', 'dv-busv'), read = el('div', 'dv-busr');
      var ctl = el('div', 'dv-busc');
      box.appendChild(svgHost); box.appendChild(ctl); box.appendChild(read);
      var btns = st.map(function (_, k) {
        var bt = ui.btn('dv-dev'); bt.addEventListener('click', function () { st[k] = st[k] ? 0 : 1; draw(); }); ctl.appendChild(bt); return bt;
      });
      function draw() {
        var R = 50, pulls = st.filter(function (v) { return v === 0; }).length, highs = st.length - pulls, level, I = 0, V, verdict, kind;
        if (md === 'pp') {
          if (!pulls) { level = 1; V = 3.3; verdict = '大家都输出 1，线是 1，没有冲突。'; kind = 'ok'; }
          else if (!highs) { level = 0; V = 0; verdict = '大家都输出 0，线是 0，没有冲突。'; kind = 'ok'; }
          else { var rh = R / highs, rl = R / pulls; I = 3.3 / (rh + rl) * 1000; V = 3.3 * rl / (rh + rl); level = -1; kind = 'bad';
            verdict = '短路！电流从 3.3 V 经输出 1 的上管、这根线、输出 0 的下管流到地，约 ' + Math.round(I) + ' mA 以上（超过引脚 25 mA 的绝对最大值）；线上约 ' + V.toFixed(2) + ' V，落在 0 和 1 之间的不确定区。'; }
        } else if (md === 'od-nopull') {
          if (pulls) { level = 0; V = 0; verdict = '有人拉低，线是 0；两边都接地，不会短路。'; kind = 'ok'; }
          else { level = -2; verdict = '大家都松手：线上谁都没接，电压由漏电和干扰决定，是浮空的——读出来可能是 0 也可能是 1。'; kind = 'warn'; }
        } else if (md === 'vcc') {
          if (pulls) { I = 3.3 / (R / pulls) * 1000; level = 1; V = 3.3; kind = 'bad'; verdict = '短路！线直接接在 3.3 V 上，拉低的管子把 3.3 V 直接接到地：约 ' + Math.round(I) + ' mA 以上，而且线根本拉不下来，还是 3.3 V。'; }
          else { level = 1; V = 3.3; kind = 'ok'; verdict = '大家都松手，线是 1（直接接着 3.3 V）。看起来不错——拉低一下试试。'; }
        } else {
          var Rp = 10000;
          if (pulls) { var ron = R / pulls; I = 3.3 / (Rp + ron) * 1000; V = 3.3 * ron / (Rp + ron); level = 0; kind = 'ok';
            verdict = (pulls > 1 ? pulls + ' 个器件一起拉低' : '有一个器件拉低') + '：线是 0（约 ' + (V * 1000).toFixed(0) + ' mV）。电流被上拉电阻限制在 ' + I.toFixed(2) + ' mA，安全。'; }
          else { level = 1; V = 3.3; kind = 'ok'; verdict = '大家都松手：没有电流流过上拉电阻，电阻上没有压降，线 ≈ 3.3 V = 1。'; }
        }
        st.forEach(function (v, k) {
          ui.clear(btns[k]);
          btns[k].appendChild(el('b', null, names[k]));
          btns[k].appendChild(el('span', null, md === 'pp' ? '输出 ' + v : v ? '松手' : '拉低'));
          btns[k].classList.toggle('pull', v === 0);
          btns[k].setAttribute('aria-pressed', v === 0 ? 'true' : 'false');
        });
        // 画
        ui.clear(svgHost);
        var s = sv('svg', { viewBox: '0 0 ' + W + ' ' + Hh, 'class': 'dv-bussvg', role: 'img', 'aria-label': verdict });
        var lineY = 70, gx = (W - 40) / n;
        s.appendChild(sv('path', { d: 'M20 18H' + (W - 20), 'class': 'b-rail' }));
        s.appendChild(sv('text', { x: W - 20, y: 12, 'class': 'b-t', 'text-anchor': 'end' }, '3.3 V'));
        s.appendChild(sv('path', { d: 'M20 ' + (Hh - 14) + 'H' + (W - 20), 'class': 'b-gnd' }));
        s.appendChild(sv('text', { x: W - 20, y: Hh - 2, 'class': 'b-t', 'text-anchor': 'end' }, '地'));
        var lcls = level === 1 ? 'hi' : level === 0 ? 'lo' : level === -1 ? 'x' : 'fl';
        // 上拉 / 直连
        if (md === 'od' || md === 'vcc') {
          if (md === 'od') { s.appendChild(sv('path', { d: 'M30 18V26l-6 3 12 5-12 5 12 5-12 5 6 3V' + lineY, 'class': 'b-res' + (I ? ' cur-s' : '') })); s.appendChild(sv('text', { x: 40, y: 46, 'class': 'b-t' }, '10 kΩ')); }
          else s.appendChild(sv('path', { d: 'M30 18V' + lineY, 'class': 'b-wire' + (I ? ' cur' : '') }));
        }
        s.appendChild(sv('path', { d: 'M20 ' + lineY + 'H' + (W - 20), 'class': 'b-line ' + lcls }));
        s.appendChild(sv('text', { x: W - 20, y: lineY - 8, 'class': 'b-lt ' + lcls, 'text-anchor': 'end' }, level === 1 ? 'SDA = 1' : level === 0 ? 'SDA = 0' : level === -1 ? 'SDA ≈ ' + V.toFixed(1) + ' V ?' : 'SDA = ?（浮空）'));
        st.forEach(function (v, k) {
          var cx = 20 + gx * k + gx / 2, bx = cx - 40, by = 96, bw = 80, bh = 92;
          s.appendChild(sv('path', { d: 'M' + cx + ' ' + lineY + 'V' + (by + 30), 'class': 'b-wire' }));
          s.appendChild(sv('rect', { x: bx, y: by, width: bw, height: bh, rx: 8, 'class': 'b-dev' }));
          s.appendChild(sv('text', { x: cx, y: by + bh - 8, 'class': 'b-dn', 'text-anchor': 'middle' }, names[k]));
          // 上管（推挽才有）
          var pOn = md === 'pp' && v === 1, nOn = v === 0, hot = I > 0 ? (I > 5 ? ' cur' : ' cur-s') : '';
          if (md === 'pp') {
            s.appendChild(sv('path', { d: 'M' + (cx + 22) + ' ' + (by + 24) + 'V' + (by + 30) + 'H' + cx, 'class': 'b-wire' + (pOn ? hot : '') }));
            s.appendChild(sv('path', { d: 'M' + (cx + 22) + ' 18V' + (by + 4), 'class': 'b-wire' + (pOn ? hot : '') }));
            sw(s, cx + 22, by + 4, pOn, 'P');
          }
          s.appendChild(sv('path', { d: 'M' + cx + ' ' + (by + 30) + 'V' + (by + 52), 'class': 'b-wire' + (nOn ? hot : '') }));
          sw(s, cx, by + 52, nOn, 'N');
          s.appendChild(sv('path', { d: 'M' + cx + ' ' + (by + 72) + 'V' + (Hh - 14), 'class': 'b-wire' + (nOn ? hot : '') }));
        });
        svgHost.appendChild(s);
        ui.clear(read);
        var p = el('p', 'dv-busv-t ' + kind); p.appendChild(ui.icon(kind === 'bad' ? 'warn' : kind === 'warn' ? 'info' : 'check')); p.appendChild(el('span', null, verdict)); read.appendChild(p);
        if (md === 'pp' && level === -1) read.appendChild(el('p', 'dv-note', '估算方法：数据手册给出 8 mA 时输出压降不超过 0.4 V，可推出每个导通的管子电阻不超过约 50 Ω；电阻越小电流越大，所以实际电流只会更大。'));
      }
      function sw(s, x, y, on, label) {
        var g = sv('g', { 'class': 'b-sw' + (on ? ' on' : '') });
        g.appendChild(sv('rect', { x: x - 11, y: y, width: 22, height: 20, rx: 4 }));
        g.appendChild(sv('text', { x: x, y: y + 14, 'text-anchor': 'middle' }, label));
        s.appendChild(g);
      }
      draw();
      return box;
    }

    /* =================== 上拉电阻与上升沿 =================== */
    function rcWidget(b) {
      var box = el('figure', 'dv-w dv-rc'); if (b.cap) box.appendChild(rich(b.cap, 'figcaption', 'dv-cap'));
      var Rs = [470, 680, 1000, 1500, 2200, 3300, 4700, 6800, 10000, 15000, 22000, 33000, 47000, 100000], ri = 8, C_ = 50;
      var ctl = el('div', 'dv-rcc');
      var rl = el('label'), rIn = el('input'); rIn.type = 'range'; rIn.min = 0; rIn.max = Rs.length - 1; rIn.value = ri; var rv = el('b', 'mono');
      rl.appendChild(el('span', null, '上拉电阻')); rl.appendChild(rIn); rl.appendChild(rv);
      var cl = el('label'), cIn = el('input'); cIn.type = 'range'; cIn.min = 10; cIn.max = 400; cIn.step = 10; cIn.value = C_; var cv = el('b', 'mono');
      cl.appendChild(el('span', null, '总线电容')); cl.appendChild(cIn); cl.appendChild(cv);
      ctl.appendChild(rl); ctl.appendChild(cl); box.appendChild(ctl);
      var plot = el('div', 'dv-rcp'), res = el('ul', 'dv-rcr'); box.appendChild(plot); box.appendChild(res);
      function fmtR(r) { return r >= 1000 ? (r / 1000) + ' kΩ' : r + ' Ω'; }
      function draw() {
        var R = Rs[ri], Cb = C_ * 1e-12, tau = R * Cb, tr = 0.8473 * tau * 1e9, I = 3.3 / R * 1000;
        rv.textContent = fmtR(R); cv.textContent = C_ + ' pF';
        rIn.setAttribute('aria-valuetext', fmtR(R)); cIn.setAttribute('aria-valuetext', C_ + ' pF');
        // 10 µs 的一个时钟周期：前 5 µs 被拉低，后 5 µs 松手
        var W = 340, H = 130, x0 = 30, x1 = W - 10, y1 = 20, y0 = H - 22, T = 10e-6;
        function X(t) { return x0 + (x1 - x0) * t / T; } function Y(v) { return y0 - (y0 - y1) * v / 3.3; }
        var s = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, 'class': 'dv-rcsvg', role: 'img', 'aria-label': '松手后线上电压的上升曲线' });
        [0.3, 0.7].forEach(function (f) { s.appendChild(sv('path', { d: 'M' + x0 + ' ' + Y(3.3 * f) + 'H' + x1, 'class': 'rc-th' })); s.appendChild(sv('text', { x: x0 - 4, y: Y(3.3 * f) + 4, 'class': 'rc-t', 'text-anchor': 'end' }, f * 100 + '%')); });
        s.appendChild(sv('path', { d: 'M' + x0 + ' ' + y0 + 'H' + x1 + 'M' + x0 + ' ' + y1 + 'V' + y0, 'class': 'rc-ax' }));
        var d = 'M' + x0 + ' ' + Y(3.3) + 'V' + Y(0) + 'H' + X(5e-6);
        for (var k = 0; k <= 80; k++) { var t = 5e-6 * k / 80; d += 'L' + X(5e-6 + t).toFixed(1) + ' ' + Y(3.3 * (1 - Math.exp(-t / tau))).toFixed(1); }
        s.appendChild(sv('path', { d: d, 'class': 'rc-v' }));
        s.appendChild(sv('text', { x: X(2.5e-6), y: H - 6, 'class': 'rc-t', 'text-anchor': 'middle' }, '拉低 5 µs'));
        s.appendChild(sv('text', { x: X(7.5e-6), y: H - 6, 'class': 'rc-t', 'text-anchor': 'middle' }, '松手 5 µs'));
        ui.clear(plot); plot.appendChild(s);
        ui.clear(res);
        function item(ok, t) { var li = el('li', ok ? 'ok' : 'bad'); li.appendChild(ui.icon(ok ? 'check' : 'warn')); li.appendChild(el('span', null, t)); res.appendChild(li); }
        item(R >= 967, '拉低时电流 ' + I.toFixed(2) + ' mA ' + (R >= 967 ? '≤' : '>') + ' 3 mA（电阻至少约 967 Ω）');
        item(tr <= 1000, '上升时间 tr = 0.8473 × R × C ≈ ' + (tr >= 1000 ? (tr / 1000).toFixed(2) + ' µs' : Math.round(tr) + ' ns') + (tr <= 1000 ? '，满足' : '，超过') + '标准模式 1000 ns');
        item(tr <= 300, (tr <= 300 ? '也满足' : '不满足') + '快速模式（400 kHz）的 300 ns');
        var lim = el('li', 'note'); lim.appendChild(el('span', null, '这个电容下，标准模式电阻上限 ≈ ' + fmtR(Math.round(1000e-9 / (0.8473 * Cb) / 100) * 100) + '，快速模式 ≈ ' + fmtR(Math.round(300e-9 / (0.8473 * Cb) / 100) * 100))); res.appendChild(lim);
      }
      rIn.addEventListener('input', function () { ri = Number(rIn.value); draw(); });
      cIn.addEventListener('input', function () { C_ = Number(cIn.value); draw(); });
      draw();
      return box;
    }

    /* =================== 地址字节 =================== */
    function addrWidget(b) {
      var box = el('figure', 'dv-w dv-addr'); if (b.cap) box.appendChild(rich(b.cap, 'figcaption', 'dv-cap'));
      var eep = b.mode === 'eeprom';
      var bits = eep ? [1, 0, 1, 0, 0, 0, 0, 0] : [1, 0, 1, 0, 0, 0, 0, 0];
      var lab = eep ? ['1', '0', '1', '0', 'E2', 'E1', 'E0', 'R/W'] : ['A6', 'A5', 'A4', 'A3', 'A2', 'A1', 'A0', 'R/W'];
      var row = el('div', 'dv-bits'), out = el('div', 'dv-addro');
      var cells = bits.map(function (v, i) {
        var fixed = eep && i < 4;
        var c = ui.btn('dv-bit' + (fixed ? ' fixed' : '') + (i === 7 ? ' rw' : '') + (eep && i >= 4 && i < 7 ? ' epin' : ''));
        c.addEventListener('click', function () { if (fixed) return; bits[i] ^= 1; draw(); });
        if (fixed) c.disabled = true;
        row.appendChild(c); return c;
      });
      box.appendChild(row); box.appendChild(out);
      function draw() {
        var byte = bits.reduce(function (a, v) { return (a << 1) | v; }, 0), a7 = byte >> 1, rw = byte & 1;
        cells.forEach(function (c, i) {
          ui.clear(c); c.appendChild(el('span', 'dv-bitl', lab[i])); c.appendChild(el('b', null, bits[i]));
          if (eep && i >= 4 && i < 7) c.appendChild(el('span', 'dv-bitp', bits[i] ? '接 VCC' : '接地'));
          if (i === 7) c.appendChild(el('span', 'dv-bitp', rw ? '读' : '写'));
          c.setAttribute('aria-label', lab[i] + ' = ' + bits[i]);
        });
        ui.clear(out);
        var p = el('p'); p.appendChild(document.createTextNode('地址字节 ')); p.appendChild(el('b', 'mono', hx(byte)));
        p.appendChild(document.createTextNode(' = 7 位地址 ' + hx(a7) + ' 左移一位，再放上 R/W = ' + rw + '（' + (rw ? '读' : '写') + '）'));
        out.appendChild(p);
        if (eep) {
          var eBits = (byte >> 1) & 7;
          var q = el('p', 'dv-addrq ' + (eBits === 0 ? 'ok' : 'bad'));
          q.appendChild(ui.icon(eBits === 0 ? 'check' : 'info'));
          q.appendChild(el('span', null, '板上 EEPROM 的 E 引脚都接地（000）。主机发 ' + hx(byte) + '：' + (eBits === 0 ? '地址对上了，第 9 个时钟它会拉低应答。' : '对不上，它不应答——线停在 1，主机读到非应答。')));
          out.appendChild(q);
        }
      }
      draw();
      return box;
    }

    /* =================== 页回卷 =================== */
    function pageWidget(b) {
      var box = el('figure', 'dv-w dv-page'); if (b.cap) box.appendChild(rich(b.cap, 'figcaption', 'dv-cap'));
      var start = 0x0E, cnt = 4;
      var ctl = el('div', 'dv-pagec');
      var sl = el('label'), sIn = el('input'); sIn.type = 'range'; sIn.min = 0; sIn.max = 255; sIn.value = start; var svv = el('b', 'mono');
      sl.appendChild(el('span', null, '起始地址')); sl.appendChild(sIn); sl.appendChild(svv);
      var nl = el('label'), nIn = el('input'); nIn.type = 'range'; nIn.min = 1; nIn.max = 20; nIn.value = cnt; var nv = el('b', 'mono');
      nl.appendChild(el('span', null, '连续写')); nl.appendChild(nIn); nl.appendChild(nv);
      ctl.appendChild(sl); ctl.appendChild(nl); box.appendChild(ctl);
      var grid = el('div', 'dv-grid'), note = el('p', 'dv-pagen');
      var hdr = el('div', 'dv-gh'); hdr.appendChild(el('span'));
      for (var c = 0; c < 16; c++) hdr.appendChild(el('span', null, c.toString(16).toUpperCase()));
      grid.appendChild(hdr);
      var cellEls = [];
      for (var r = 0; r < 16; r++) {
        var rowE = el('div', 'dv-gr'); rowE.appendChild(el('span', 'dv-gl', r.toString(16).toUpperCase() + 'x'));
        for (c = 0; c < 16; c++) { var ce = el('span', 'dv-gc'); rowE.appendChild(ce); cellEls.push(ce); }
        grid.appendChild(rowE);
      }
      box.appendChild(grid); box.appendChild(note);
      function draw() {
        svv.textContent = hx(start); nv.textContent = cnt + ' 个'; sIn.setAttribute('aria-valuetext', hx(start)); nIn.setAttribute('aria-valuetext', cnt + ' 个字节');
        cellEls.forEach(function (ce) { ce.className = 'dv-gc'; ce.textContent = ''; });
        var p = start, hits = {}, wraps = 0, over = 0;
        for (var k = 0; k < cnt; k++) {
          var ce = cellEls[p];
          if (hits[p]) over++;
          hits[p] = k + 1;
          ce.className = 'dv-gc on' + (k > 0 && p < start ? ' wrap' : '') + (k >= 16 ? ' over' : '');
          ce.textContent = k + 1;
          var np = (p & 0xF0) | ((p + 1) & 0x0F); if (np < p) wraps++; p = np;
        }
        for (k = 0; k < 16; k++) cellEls[(start & 0xF0) + k].classList.add('pg');
        var page = start >> 4;
        note.textContent = '第 ' + page + ' 页（' + hx(page << 4) + ' ~ ' + hx((page << 4) | 15) + '）。' +
          (cnt + (start & 15) <= 16 ? '全部落在这一页里，正常。' : '写到 ' + hx((page << 4) | 15) + ' 之后回卷到 ' + hx(page << 4) + '，覆盖了本页开头' + (over ? '；超过 16 个字节，前面写的还会被后面的覆盖' : '') + '。');
      }
      sIn.addEventListener('input', function () { start = Number(sIn.value); draw(); });
      nIn.addEventListener('input', function () { cnt = Number(nIn.value); draw(); });
      draw();
      return box;
    }

    /* =================== 函数卡片：每一行的理由 + 交换两行 =================== */
    function fnCard(name) {
      var fn = ch.fns[name], card = el('section', 'dv-fn');
      var h = el('header', 'dv-fn-h');
      h.appendChild(ui.hlC(fn.sig)); card.appendChild(h);
      if (fn.doc) card.appendChild(el('p', 'dv-fn-doc', fn.doc));
      if (fn.enter || fn.leave) {
        var io = el('div', 'dv-fn-io');
        if (fn.enter) { var a = el('span'); a.appendChild(el('b', null, '进来时')); a.appendChild(el('span', null, fn.enter)); io.appendChild(a); }
        if (fn.leave) { var z = el('span'); z.appendChild(el('b', null, '离开时')); z.appendChild(el('span', null, fn.leave)); io.appendChild(z); }
        card.appendChild(io);
      }
      var tools = el('div', 'dv-fn-tools'), swapB = ui.btn('pill', '选两行交换试试'), copy = ui.copyBtn('复制这个函数', function () { return fnText(fn); });
      tools.appendChild(swapB); tools.appendChild(copy); card.appendChild(tools);
      var hint = el('p', 'dv-fn-hint', '点任意一行，看它为什么写在这里。');
      card.appendChild(hint);
      var list = el('ol', 'dv-lines'), rows = [], picking = false, pick = [];
      var all = (fn.pre || []).map(function (l) { return { l: l, pre: true }; }).concat([{ sig: true }]).concat(fn.lines.map(function (l, i) { return { l: l, i: i }; })).concat([{ close: true }]);
      all.forEach(function (x) {
        var li = el('li', 'dv-line' + (x.pre ? ' pre' : '') + (x.sig || x.close ? ' frame' : ''));
        var code = el('code', 'dv-lc');
        if (x.sig) code.appendChild(ui.hlC(fn.sig + ' {'));
        else if (x.close) code.appendChild(ui.hlC('}'));
        else code.appendChild(ui.hlC((x.pre ? '' : '    ') + x.l.c));
        li.appendChild(code);
        var why = x.l && x.l.why;
        if (x.l && (why || x.l.from)) {
          li.classList.add('has');
          var btnL = ui.btn('dv-lb'); btnL.setAttribute('aria-label', '第 ' + ((x.i != null ? x.i : 0) + 1) + ' 行：' + x.l.c + '。点开看理由'); btnL.appendChild(code);
          li.insertBefore(btnL, li.firstChild);
          var exp = el('div', 'dv-lwhy'); exp.hidden = true;
          if (why) exp.appendChild(rich(why));
          if (x.l.from && x.l.from.length) {
            var fr = el('p', 'dv-lfrom'); fr.appendChild(el('span', null, '来自 '));
            x.l.from.forEach(function (f) { fr.appendChild(ch.facts[f] ? factChip(f) : stepLink(f)); fr.appendChild(document.createTextNode(' ')); });
            exp.appendChild(fr);
          }
          li.appendChild(exp);
          btnL.addEventListener('click', function () {
            if (picking && x.i != null) { choose(x.i, li); return; }
            exp.hidden = !exp.hidden; li.classList.toggle('open', !exp.hidden);
          });
        }
        if (x.i != null) rows[x.i] = li;
        list.appendChild(li);
      });
      card.appendChild(list);
      if (fn.note) card.appendChild(rich(fn.note, 'p', 'dv-note'));
      var out = el('div', 'dv-swap'); card.appendChild(out);
      swapB.addEventListener('click', function () {
        picking = !picking; pick = [];
        rows.forEach(function (r) { if (r) r.classList.remove('pick'); });
        card.classList.toggle('picking', picking);
        swapB.textContent = picking ? '取消' : '选两行交换试试';
        hint.textContent = picking ? '点第一行……' : '点任意一行，看它为什么写在这里。';
        if (picking) ui.clear(out);
      });
      function choose(i, li) {
        var ruled = (fn.rules || []).some(function (r) { return r.a === i || r.b === i; });
        if (!(fn.lines[i].op && fn.lines[i].op.length) && !fn.lines[i].loop && !ruled) { ui.toast('这一行不影响线上的动作，换它没有意义'); return; }
        if (pick.indexOf(i) > -1) return;
        pick.push(i); li.classList.add('pick');
        if (pick.length === 1) { hint.textContent = '再点第二行……'; return; }
        var r = C.swapCheck(ch, name, pick[0], pick[1]);
        picking = false; card.classList.remove('picking'); swapB.textContent = '再选两行'; hint.textContent = '点任意一行，看它为什么写在这里。';
        showSwap(r, pick[0], pick[1]);
        var p0 = pick.slice(); setTimeout(function () { p0.forEach(function (k) { if (rows[k]) rows[k].classList.remove('pick'); }); }, 2400);
        pick = [];
      }
      function showSwap(r, i, j) {
        ui.clear(out);
        var head = el('p', 'dv-swap-h'); head.appendChild(ui.icon('retry'));
        head.appendChild(el('span', null, '交换「' + fn.lines[i].c.trim() + '」和「' + fn.lines[j].c.trim() + '」'));
        out.appendChild(head);
        if (r.same) { out.appendChild(el('p', 'dv-note', r.note || '同一行。')); return; }
        if (r.structural) { out.appendChild(el('p', 'dv-note', 'for 循环的开头和结尾决定了哪些行在循环里，换了以后程序结构就变了。')); return; }
        if (r.nosim) {
          if (r.broken.length) { var ul0 = el('ul', 'dv-why'); r.broken.forEach(function (b) { ul0.appendChild(rich(b.why, 'li')); }); out.appendChild(el('p', 'dv-swap-t', '不能换，因为：')); out.appendChild(ul0); }
          else out.appendChild(el('p', 'dv-swap-t ok', '这两行的先后不影响任何规则，可以交换。'));
          out.appendChild(el('p', 'dv-note', '这几行是寄存器配置，模拟器从配置好的状态开始跑，所以这里只讲道理，不跑波形。'));
          return;
        }
        if (r.broken.length) {
          var ul = el('ul', 'dv-why');
          r.broken.slice(0, 3).forEach(function (b) {
            var li = el('li'); li.appendChild(rich(b.why, 'span'));
            if (b.back && S[b.back]) { li.appendChild(document.createTextNode(' ')); li.appendChild(stepLink(b.back)); }
            ul.appendChild(li);
          });
          out.appendChild(el('p', 'dv-swap-t', '不能换，因为：')); out.appendChild(ul);
        } else out.appendChild(el('p', 'dv-swap-t ok', '这两行的先后不影响任何规则，可以交换。'));
        var sc = ch.scenarios[r.sc];
        var dh = el('p', 'dv-swap-t'); dh.textContent = '在「' + sc.title + '」里跑一次换过的程序：'; out.appendChild(dh);
        if (r.diff.length) { var ul2 = el('ul', 'dv-diff'); r.diff.forEach(function (x) { ul2.appendChild(el('li', null, x)); }); out.appendChild(ul2); }
        else if (r.broken.length && r.broken[0].simNote) out.appendChild(rich(r.broken[0].simNote, 'p', 'dv-note'));
        else out.appendChild(el('p', 'dv-note', r.broken.length ? '这个场景里线上看不出区别——但规则讲的情况换个场景就会出现。' : '线上的波形和原来一样。'));
        out.appendChild(simResult(r.got, { compact: true }));
        scrollNear(out);
      }
      return card;
    }
    function fnText(fn) {
      var lines = [];
      (fn.pre || []).forEach(function (l) { lines.push(l.c); }); if (fn.pre) lines.push('');
      lines.push(fn.sig); lines.push('{');
      fn.lines.forEach(function (l) { lines.push('    ' + l.c); });
      lines.push('}');
      return lines.join('\n');
    }

    /* =================== 一段 =================== */
    function beat(b, ctx) {
      if (b.k === 'ask') return ask(b, ctx);
      if (b.k === 'w') return b.w === 'bus' ? busWidget(b) : b.w === 'rc' ? rcWidget(b) : b.w === 'addr' ? addrWidget(b) : b.w === 'page' ? pageWidget(b) : simWidget(b);
      if (b.k === 'fn') return fnCard(b.fn);
      if (b.k === 'code') return ui.codeBlock(b.c, { title: b.cap || 'C', copyLabel: '复制代码' });
      if (b.k === 'fact') {
        var f = ch.facts[b.f], d = el('div', 'dv-fact');
        d.appendChild(el('span', 'dv-fact-k', b.f)); var t = el('div'); t.appendChild(el('span', 'dv-fact-l', '主干结论 · ' + f.short)); t.appendChild(el('b', null, f.t)); d.appendChild(t);
        return d;
      }
      if (b.k === 'table') {
        var wrapT = el('div', 'dv-tablew'), tb = el('table', 'dv-table'), hr = el('tr');
        b.head.forEach(function (x) { hr.appendChild(el('th', null, x)); }); tb.appendChild(hr);
        b.rows.forEach(function (r) { var tr = el('tr'); r.forEach(function (c) { var td = el('td'); td.appendChild(rich(c, 'span')); tr.appendChild(td); }); tb.appendChild(tr); });
        wrapT.appendChild(tb); return wrapT;
      }
      var d2 = el('div', 'dv-beat k-' + b.k);
      if (KIND[b.k]) d2.appendChild(el('span', 'dv-k', KIND[b.k]));
      var tx = el('div', 'dv-bt'); paras(b.t, tx); d2.appendChild(tx);
      return d2;
    }

    /* =================== 页面：章节首页（推导链） =================== */
    function renderHome() {
      var st = chState(ch.id), m = mode();
      var head = el('header', 'dv-hero');
      var crumb = app.link({ v: 'think' }, 'tk-crumb'); crumb.textContent = '原理'; head.appendChild(crumb);
      head.appendChild(el('h1', null, topic.code));
      var task = el('div', 'dv-task'); task.appendChild(ui.icon('flag'));
      var tt = el('div'); tt.appendChild(el('span', 'dv-task-l', '任务')); tt.appendChild(el('b', null, ch.task)); task.appendChild(tt); head.appendChild(task);
      var hon = el('details', 'dv-honest'); hon.appendChild(el('summary', null, '思路重建，不是真实历史'));
      hon.appendChild(el('p', null, ch.honesty.replace(/^说明：/, ''))); head.appendChild(hon);
      wrap.appendChild(head);

      // 两种学法就是入口：点了直接进推导（有进度从上次那一环接着推）
      var at = st.at && S[st.at] ? st.at : ch.steps[0].id;
      wrap.appendChild(modeSwitch(function () { app.navigate({ v: 'think', t: ch.id, s: at }); }, true));

      var due = C.dueCount(ch, st.stuck || {}), groups = C.stuckList(ch, st.stuck || {});
      if (groups.length) {
        var rv = app.link({ v: 'think', t: ch.id, s: 'review' }, 'dv-revin');
        rv.appendChild(ui.icon('retry'));
        var rt = el('span'); rt.appendChild(el('b', null, '常卡的地方：' + groups.length + ' 处')); if (due) rt.appendChild(el('span', null, '待复习 ' + due));
        rv.appendChild(rt); wrap.appendChild(rv);
      }

      // 推导链
      var map = el('section', 'dv-map'); map.appendChild(el('h2', 'sec-h', '推导链'));
      ch.stages.forEach(function (sg) {
        var sec = el('div', 'dv-stage');
        var sh = el('div', 'dv-stage-h'); sh.appendChild(el('b', null, sg.id)); var stt = el('span'); stt.appendChild(el('span', 'dv-stage-n', sg.name)); sh.appendChild(stt);
        sec.appendChild(sh);
        var ol = el('ol', 'dv-chain');
        ch.steps.filter(function (s) { return s.stage === sg.id; }).forEach(function (s) {
          var li = el('li', 'dv-node' + (st.done && st.done[s.id] ? ' done' : '') + (s.id === at ? ' cur' : '') + (s.transfer ? ' tr' : ''));
          var a = app.link({ v: 'think', t: ch.id, s: s.id }, 'dv-node-a');
          a.appendChild(el('span', 'dv-node-n', s._i + 1));
          var tx = el('span', 'dv-node-t'); tx.appendChild(el('b', null, s.q));
          if (s.from && S[s.from] && S[s.from]._i !== s._i - 1) tx.appendChild(el('span', 'dv-node-f', '← 接着问题 ' + stepNo(s.from)));
          a.appendChild(tx); li.appendChild(a); ol.appendChild(li);
        });
        sec.appendChild(ol); map.appendChild(sec);
      });
      wrap.appendChild(map);

      // 主干结论
      var fx = el('section', 'dv-facts'); fx.appendChild(el('h2', 'sec-h', '主干结论'));
      var ul = el('ul', 'dv-factl');
      Object.keys(ch.facts).forEach(function (k) {
        var f = ch.facts[k], got = m === 'full' || (st.done && st.done[f.from]);
        var li = el('li', got ? null : 'locked'); li.appendChild(el('span', 'dv-fact-k', k));
        var t = el('div'); t.appendChild(el('b', null, got ? f.t : '还没推到'));
        var a = app.link({ v: 'think', t: ch.id, s: f.from }, 'dv-sl'); a.textContent = '问题 ' + stepNo(f.from); t.appendChild(a);
        li.appendChild(t); ul.appendChild(li);
      });
      fx.appendChild(ul); wrap.appendChild(fx);

      var foot = el('div', 'tk-foot');
      var tl = app.link({ v: 'topic', t: ch.topic }, 'textbtn'); tl.textContent = '回到 ' + topic.code + ' 资料页'; foot.appendChild(tl);
      var reset = ui.btn('textbtn', '清空本章进度');
      reset.addEventListener('click', function () {
        if (!reset.classList.contains('arm')) { reset.classList.add('arm'); reset.textContent = '再点一次确认清空'; setTimeout(function () { reset.classList.remove('arm'); reset.textContent = '清空本章进度'; }, 3000); return; }
        var o = load(); if (o.ch) delete o.ch[ch.id]; save(o); ui.toast('本章进度已清空'); ui.clear(wrap); renderHome();
      });
      foot.appendChild(reset); wrap.appendChild(foot);
    }
    function modeSwitch(onChange, enter) {
      var m = mode(), box = el('div', 'dv-mode' + (enter ? ' enter' : '')); box.setAttribute('role', enter ? 'group' : 'radiogroup'); box.setAttribute('aria-label', '学习方式');
      [['full', '完整推导'], ['self', '自主推导']].forEach(function (x) {
        var b = ui.btn('dv-modeb' + (!enter && m === x[0] ? ' on' : ''));
        if (!enter) { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', m === x[0] ? 'true' : 'false'); }
        b.appendChild(el('b', null, x[1])); if (enter) b.appendChild(ui.icon('next'));
        b.addEventListener('click', function () { if (!enter && mode() === x[0]) return; setMode(x[0]); onChange(); });
        box.appendChild(b);
      });
      return box;
    }


    /* =================== 页面：一环 =================== */
    function renderStep(id) {
      var s = S[id], st = chState(ch.id), m = mode(), idx = s._i, n = ch.steps.length;
      edit(ch.id, function (x) { x.at = id; x.seen = x.seen || {}; x.seen[id] = 1; });
      cur = id;
      // 顶条
      bar = el('div', 'dv-bar');
      var back = app.link({ v: 'think', t: ch.id }, 'dv-bar-map'); back.appendChild(ui.icon('map')); back.appendChild(el('span', null, '推导链')); bar.appendChild(back);
      var pr = el('div', 'dv-prog'); pr.setAttribute('aria-label', '第 ' + (idx + 1) + ' / ' + n + ' 个问题');
      ch.steps.forEach(function (x, k) { var d = el('i', (st.done && st.done[x.id] ? 'done' : '') + (k === idx ? ' cur' : '')); pr.appendChild(d); });
      bar.appendChild(pr);
      var mb = ui.btn('dv-bar-mode', m === 'self' ? '自主推导' : '完整推导'); mb.title = '切换学习方式';
      mb.addEventListener('click', function () { setMode(mode() === 'self' ? 'full' : 'self'); rerender(); ui.toast('已切换到' + (mode() === 'self' ? '自主推导：每个问题先自己答' : '完整推导：推理连续展开')); });
      bar.appendChild(mb);
      wrap.appendChild(bar);

      var art = el('article', 'dv-step');
      var sg = ch.stages.filter(function (x) { return x.id === s.stage; })[0];
      var hd = el('header', 'dv-sh');
      hd.appendChild(el('span', 'dv-sh-k', sg.id + ' · ' + sg.name + ' · 问题 ' + (idx + 1) + ' / ' + n));
      var h1 = el('h1', null, s.q); h1.tabIndex = -1; hd.appendChild(h1);
      if (s.from && S[s.from]) {
        var fr = el('p', 'dv-from'); fr.appendChild(document.createTextNode('这个问题是从 ')); fr.appendChild(stepLink(s.from));
        fr.appendChild(document.createTextNode(' 冒出来的：' + (S[s.from].next || S[s.from].q))); hd.appendChild(fr);
      }
      if (s.transfer) hd.appendChild(el('p', 'dv-tr', '迁移练习：用同样的思路推一个新需求。' + (m === 'full' ? '建议切到「自主推导」自己做一遍。' : '')));
      art.appendChild(hd);
      body = el('div', 'dv-beats'); art.appendChild(body);
      var end = el('div', 'dv-end'); art.appendChild(end);
      wrap.appendChild(art);

      var beats = s.beats, asks = []; beats.forEach(function (b, k) { if (b.k === 'ask') asks.push(k); });
      var solvedN = 0;
      if (m === 'self') {
        // 已经答过的题算通过
        var sv0 = st.solved || {};
        while (solvedN < asks.length && sv0[beats[asks[solvedN]].id]) solvedN++;
      }
      var shown = 0;
      function showUntil(limit, focusFirst) {
        var first = null;
        for (; shown < limit && shown < beats.length; shown++) {
          var b = beats[shown], node;
          if (b.k === 'ask') {
            var already = (chState(ch.id).solved || {})[b.id];
            node = ask(b, { mode: m === 'self' && !already ? 'self' : 'full', onSolved: onSolved(b) });
            if (m === 'self' && already) { node.classList.add('was'); node.appendChild(el('p', 'dv-was', '这题你之前答对过，可以再答一次，也可以直接往下读。')); }
          } else node = beat(b);
          node.classList.add('dv-in');
          body.appendChild(node);
          if (!first) first = node;
        }
        if (focusFirst && first) { focusSoft(first._head || first); scrollNear(first); }
      }
      function onSolved(b) {
        return function (firstTry) {
          edit(ch.id, function (x) { x.solved = x.solved || {}; x.solved[b.id] = 1; });
          if (m !== 'self') return;
          var k = beats.indexOf(b);
          if (k !== asks[solvedN]) return;
          solvedN++;
          if (solvedN >= asks.length && shown >= beats.length) { finishStep(); return; }   // 题目是最后一段：直接给结论
          var go = ui.btn('pill solid dv-cont', solvedN < asks.length ? '继续往下推' : '看这一环的结论');
          go.addEventListener('click', function () { go.remove(); revealNext(true); });
          body.appendChild(go);
          try { go.focus({ preventScroll: true }); } catch (e) {}
        };
      }
      function revealNext(focus) {
        var limit = solvedN < asks.length ? asks[solvedN] + 1 : beats.length;
        showUntil(limit, focus);
        if (shown >= beats.length && solvedN >= asks.length) finishStep();
      }
      function finishStep() {
        ui.clear(end);
        var g = el('div', 'dv-gist'); g.appendChild(el('span', 'dv-gist-l', '这一环推出了'));
        g.appendChild(rich(s.gist, 'p'));
        if (s.makes && s.makes.length) { var mk = el('p', 'dv-gist-f'); mk.appendChild(document.createTextNode('新的主干结论：')); s.makes.forEach(function (f) { mk.appendChild(factChip(f)); mk.appendChild(document.createTextNode(' ' + ch.facts[f].t + '　')); }); g.appendChild(mk); }
        end.appendChild(g);
        if (s.deep && s.deep.length) {
          var dp = el('section', 'dv-deep'); dp.appendChild(el('h2', null, '容易被忽略的疑问'));
          s.deep.forEach(function (d) { var det = el('details'); det.appendChild(rich(d.q, 'summary')); var dd = el('div'); paras(d.a, dd); det.appendChild(dd); dp.appendChild(det); });
          end.appendChild(dp);
        }
        if ((s.refs && s.refs.length) || (s.links && s.links.length)) {
          var rf = el('section', 'dv-refs'); rf.appendChild(el('h2', null, '出处'));
          if (s.refs) { var ul = el('ul'); s.refs.forEach(function (r) { ul.appendChild(el('li', null, r.t)); }); rf.appendChild(ul); }
          if (s.links) { var lr = el('div', 'dv-links'); s.links.forEach(function (l) { var b = linkBtn(l); if (b) lr.appendChild(b); }); rf.appendChild(lr); }
          end.appendChild(rf);
        }
        var nx = ch.steps[idx + 1];
        var nav = el('nav', 'dv-next');
        if (nx) {
          var a = app.link({ v: 'think', t: ch.id, s: nx.id }, 'dv-nextb');
          a.appendChild(el('span', 'dv-next-l', '下一个问题'));
          a.appendChild(rich(s.next || nx.q, 'b'));
          a.appendChild(el('span', 'dv-next-q', '问题 ' + (idx + 2) + '：' + nx.q));
          a.addEventListener('click', markDone);
          nav.appendChild(a);
        } else {
          var fin = el('div', 'dv-fin'); fin.appendChild(ui.icon('check')); fin.appendChild(el('b', null, '整条推导链走完了。'));
          var rvl = app.link({ v: 'think', t: ch.id, s: 'review' }, 'pill'); rvl.textContent = '去看常卡的地方';
          fin.appendChild(rvl); nav.appendChild(fin); markDone();
        }
        if (idx > 0) { var pv = app.link({ v: 'think', t: ch.id, s: ch.steps[idx - 1].id }, 'textbtn'); pv.textContent = '← 上一个问题'; nav.appendChild(pv); }
        end.appendChild(nav);
        if (m === 'full') observeEnd(end);
        else markDone();
      }
      function markDone() { edit(ch.id, function (x) { x.done = x.done || {}; x.done[id] = 1; }); }
      function observeEnd(n) {
        if (!('IntersectionObserver' in window)) { markDone(); return; }
        var io = new IntersectionObserver(function (es) { if (es.some(function (e) { return e.isIntersecting; })) { markDone(); io.disconnect(); } });
        io.observe(n); disposers.push(function () { io.disconnect(); });
      }
      if (m === 'full') { showUntil(beats.length); finishStep(); }
      else revealNext(false);
      try { h1.focus({ preventScroll: true }); } catch (e) {}
    }

    /* =================== 页面：常卡的地方 =================== */
    function renderReview() {
      var st = chState(ch.id), groups = C.stuckList(ch, st.stuck || {}), roots = C.rootCauses(ch, st.stuck || {});
      var head = el('header', 'dv-hero');
      var crumb = app.link({ v: 'think', t: ch.id }, 'tk-crumb'); crumb.textContent = '← ' + ch.title.split('：')[0] + ' 推导链'; head.appendChild(crumb);
      head.appendChild(el('h1', null, '常卡的地方'));
      head.appendChild(el('p', 'dv-intro', '你答错过的题按「推理在哪一环出的岔子」归在一起。每题换个顺序再问一次：连续答对两次（隔一天以上）就从这里移走。'));
      wrap.appendChild(head);
      if (!groups.length) { var e = el('p', 'dv-empty', '目前没有卡住的地方。推导时答错的题会自动记到这里。'); wrap.appendChild(e); return; }
      if (roots.length) {
        var rs = el('section', 'dv-roots'); rs.appendChild(el('h2', 'sec-h', '最常出岔子的推理环节'));
        var ol = el('ol');
        roots.slice(0, 5).forEach(function (r) { var li = el('li'); li.appendChild(stepLink(r.step)); li.appendChild(el('span', null, S[r.step].q)); li.appendChild(el('em', null, r.n + ' 次')); ol.appendChild(li); });
        rs.appendChild(ol); wrap.appendChild(rs);
      }
      var now = Date.now();
      groups.forEach(function (g) {
        var s = S[g.step], sec = el('section', 'dv-rv');
        var h = el('header'); h.appendChild(el('span', 'dv-rv-n', '问题 ' + (s._i + 1))); h.appendChild(el('h2', null, s.q)); sec.appendChild(h);
        sec.appendChild(rich(s.gist, 'p', 'dv-rv-g'));
        g.asks.forEach(function (aid) {
          var a = ASK[aid], due = ((st.stuck.due || {})[aid] || 0) <= now, wrong = (st.stuck.wrong || {})[aid] || [];
          var item = el('div', 'dv-rv-i' + (due ? ' due' : ''));
          if (wrong.length) { var w = el('div', 'dv-rv-w'); w.appendChild(el('b', null, '上次的想法：')); var ul = el('ul'); wrong.forEach(function (x) { ul.appendChild(el('li', null, x)); }); w.appendChild(ul); item.appendChild(w); }
          if (due) {
            var q = ask(Object.assign({}, a, { id: a.id + '~' + (st.stuck.miss[aid] || 0) }), { mode: 'review', onSolved: function (first) {
              edit(ch.id, function (x) { C.recordReview(x.stuck = x.stuck || {}, aid, first); });
              ui.toast(first ? '答对了：' + (((chState(ch.id).stuck || {}).miss || {})[aid] ? '隔天再来一次' : '已从清单移走') : '记下了，过一会儿再问你');
            } });
            item.appendChild(q);
          } else item.appendChild(el('p', 'dv-rv-later', '这一题已经复习过，' + new Date((st.stuck.due || {})[aid]).toLocaleDateString('zh-CN') + ' 再来。'));
          sec.appendChild(item);
        });
        var go = app.link({ v: 'think', t: ch.id, s: g.step }, 'textbtn'); go.textContent = '回到这一环重新推一遍 →'; sec.appendChild(go);
        wrap.appendChild(sec);
      });
    }

    var disposers = [];
    function dispose() { disposers.forEach(function (f) { try { f(); } catch (e) {} }); disposers = []; }
    function rerender() { dispose(); ui.clear(wrap); var r = app.route(); if (r.s === 'review') renderReview(); else if (r.s && S[r.s]) renderStep(r.s); else renderHome(); }
    rerender();
    return {
      title: function (r) { return r.s && S[r.s] ? '问题 ' + (S[r.s]._i + 1) + ' · ' + topic.code : r.s === 'review' ? '常卡的地方 · ' + topic.code : topic.code + ' · 原理'; },
      update: function (r) { if (r.t !== ch.id) return; if ((r.s || '') !== (cur || '') || r.s === 'review') { cur = r.s || ''; rerender(); window.scrollTo(0, 0); } },
      destroy: dispose
    };
  }

  STM.derive = {
    has: function (id) { return !!CH[id]; },
    chapter: function (id) { return CH[id] || null; },
    view: view,
    progress: function (id) { var c = CH[id]; if (!c) return null; var st = chState(id); return { done: Object.keys(st.done || {}).filter(function (k) { return c.steps.some(function (s) { return s.id === k; }); }).length, total: c.steps.length, due: C.dueCount(c, st.stuck || {}) }; },
    validStep: function (id, s) { var c = CH[id]; return !!(c && (s === 'review' || c.steps.some(function (x) { return x.id === s; }))); }
  };
})();
