/* thinkview.js — 「编程思维」：总览 + 每章四段（为什么 / 思路骨架 / 自己推一遍 / 换个需求）
   内容在 think.js；这里是界面和题目引擎。进度只存在本机（localStorage lm.stm32.think）。
   路由：v=think（总览），v=think&t=gpio&p=1~4（某章第几段）。段内的进度不进路由。 */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, M = STM.model, el = ui.el;
  var T = window.STM32_THINK || { SK: [], chapters: [] };
  var KEY = 'lm.stm32.think';
  var PARTS = [['why', '为什么'], ['skel', '思路骨架'], ['self', '自己推一遍'], ['more', '换个需求']];
  var byId = {}; T.chapters.forEach(function (c) { byId[c.id] = c; });
  var SKI = {}; T.SK.forEach(function (s, i) { SKI[s.id] = i; });

  /* ---------- 进度 ---------- */
  function load() { try { var o = JSON.parse(ui.lsGet(KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
  function save(all) { ui.lsSet(KEY, JSON.stringify(all)); }
  function prog(id) { var all = load(); return all[id] || (all[id] = {}); }
  function setProg(id, fn) { var all = load(), p = all[id] || (all[id] = {}); fn(p); save(all); return p; }
  function taskP(p, tid) { p.tasks = p.tasks || {}; return p.tasks[tid] || (p.tasks[tid] = { i: 0, done: false }); }
  function partsDone(c, p) {
    var tasks = p.tasks || {};
    return [!!p.whyDone, !!p.skelDone,
      c.tasks.filter(function (t) { return t.kind === 'guided'; }).every(function (t) { return tasks[t.id] && tasks[t.id].done; }),
      c.tasks.filter(function (t) { return t.kind === 'transfer'; }).every(function (t) { return tasks[t.id] && tasks[t.id].done; })];
  }

  /* ---------- 小工具 ---------- */
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  // 固定种子的打乱：同一道题每次打乱结果一样，而且不会恰好是正确顺序
  function shuffle(list, seed) {
    var a = list.slice(), r = seed || 1;
    function rnd() { r = Math.imul(r ^ (r >>> 15), 2246822507) ^ Math.imul(r ^ (r >>> 13), 3266489909); r ^= r >>> 16; return (r >>> 0) / 4294967296; }
    for (var k = 0; k < 4; k++) {
      for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
      if (a.some(function (x, i) { return x !== list[i]; })) break;
    }
    return a;
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[\s_]/g, ''); }
  function linkBtn(l, app, topicId) {
    if (!l) return null;
    var label = '', go = null;
    if (l.reg) {
      var r = M.R.reg(l.reg), k = r ? r.name.indexOf('_') : -1;
      label = '打开计算器：' + (r && l.i && k > 0 ? l.i + r.name.slice(k) : r ? r.name : l.reg);   // GPIOx_CRL + GPIOA → GPIOA_CRL
      go = function () { app.navigate({ reg: l.reg, i: l.i, val: l.val }); };
    }
    else if (l.snip) { label = '看代码片段：' + l.snip; go = function () { app.navigate({ v: 'topic', snip: l.snip }); }; }
    else if (l.fig) { var f = M.figById[l.fig]; label = '看图：' + (f ? f.title : l.fig); go = function () { app.navigate({ fig: l.fig }); }; }
    else if (l.pin != null) { var p = typeof l.pin === 'number' ? M.pinByN[l.pin] : M.pinByName[String(l.pin).toUpperCase()]; if (p) { label = '看引脚：' + p.name + (p.board.length ? '（' + p.board[0].name + '）' : ''); go = function () { app.navigate({ v: 'chip', pin: String(p.n) }); }; } }
    if (!go) return null;
    var b = ui.btn('linkbtn tk-link'); b.appendChild(ui.icon(l.reg ? 'chip' : l.snip ? 'code' : l.fig ? 'image' : 'chip')); b.appendChild(el('span', null, label));
    b.addEventListener('click', go);
    return b;
  }

  /* =================== 题目引擎 ===================
     ask(q, opts) → 元素；答对（或看了答案）时调用 opts.onSolved(revealed) */
  function ask(q, o) {
    o = o || {};
    var box = el('div', 'q q-' + q.type), head = el('p', 'q-q', q.q); head.tabIndex = -1;
    box.appendChild(head); box._head = head;
    var lk = linkBtn(q.link, o.app); if (lk) box.appendChild(lk);
    var body = el('div', 'q-b'), fb = el('div', 'q-fb'); fb.setAttribute('aria-live', 'polite');
    box.appendChild(body); box.appendChild(fb);
    var tries = 0, solved = false, revealBtn = null;
    function say(kind, text) {
      ui.clear(fb); if (!text) return;
      var p = el('p', 'fb fb-' + kind); p.appendChild(ui.icon(kind === 'ok' ? 'check' : kind === 'no' ? 'info' : 'idea')); p.appendChild(el('span', null, text));
      fb.appendChild(p);
    }
    function done(revealed) {
      if (solved) return; solved = true; box.classList.add('solved');
      if (revealBtn) revealBtn.remove();
      say('ok', (revealed ? '答案在上面。' : '') + (q.explain || '对。'));
      if (o.onSolved) o.onSolved(revealed);
    }
    function offerReveal(fn) {
      if (revealBtn || solved) return;
      revealBtn = ui.btn('q-reveal', '看答案');
      revealBtn.addEventListener('click', fn);
      box.appendChild(revealBtn);
    }

    if (q.type === 'choice') {
      var list = el('div', 'q-opts'); list.setAttribute('role', 'group');
      q.opts.forEach(function (op) {
        var b = ui.btn('q-opt'); b.appendChild(el('i', 'q-dot')); b.appendChild(el('span', null, op.t));
        b.addEventListener('click', function () {
          if (solved || b.disabled) return;
          if (op.ok) { b.classList.add('right'); Array.prototype.forEach.call(list.children, function (x) { x.disabled = true; }); done(false); return; }
          tries++; b.classList.add('wrong'); b.disabled = true; b.setAttribute('aria-label', op.t + '（不对）');
          say('no', op.why || '再想想。');
          if (tries >= 2) offerReveal(function () { Array.prototype.forEach.call(list.children, function (x, i) { x.disabled = true; if (q.opts[i].ok) x.classList.add('right'); }); done(true); });
        });
        list.appendChild(b);
      });
      body.appendChild(list);
    }

    else if (q.type === 'order' || q.type === 'parsons') {
      var isP = q.type === 'parsons';
      var items = isP ? q.lines.map(function (t, i) { return { t: t, rank: i, ok: true }; }).concat((q.extra || []).map(function (e) { return { t: e.t, why: e.why, ok: false }; }))
                      : q.items.map(function (it) { return { t: it.t, rank: it.rank, hint: it.hint, ok: true }; });
      var need = isP ? q.lines.length : q.items.length;
      var pool = shuffle(items, hash(q.q)), placed = [], locked = 0;
      var answer = el('ol', 'q-ans' + (isP ? ' code-ans' : '')), poolBox = el('div', 'q-pool' + (isP ? ' code-pool' : ''));
      var meta = el('p', 'q-meta'), check = ui.btn('pill solid q-check', '检查');
      body.appendChild(el('p', 'q-sub', isP ? '点下面的代码行，按顺序放进上面；点已放的行可以拿回来。' : '点下面的步骤，按顺序放进上面；点已放的步骤可以拿回来。'));
      body.appendChild(answer); body.appendChild(poolBox);
      var row = el('div', 'q-row'); row.appendChild(meta); row.appendChild(check); body.appendChild(row);
      function chip(it, inAnswer, k) {
        var b = ui.btn('q-chip' + (isP ? ' mono' : '') + (inAnswer && k < locked ? ' lock' : ''));
        if (inAnswer) b.appendChild(el('span', 'q-n', k + 1));
        b.appendChild(el('span', 'q-t', it.t));
        b.addEventListener('click', function () {
          if (solved) return;
          if (inAnswer) { if (k < locked) return; placed.splice(k, 1); pool.push(it); }
          else { pool.splice(pool.indexOf(it), 1); placed.push(it); }
          ui.clear(fb); draw();
        });
        return b;
      }
      function draw() {
        ui.clear(answer); ui.clear(poolBox);
        placed.forEach(function (it, k) { var li = el('li'); li.appendChild(chip(it, true, k)); answer.appendChild(li); });
        if (!placed.length) answer.appendChild(el('li', 'q-empty', isP ? '代码会按你点的顺序出现在这里' : '步骤会按你点的顺序出现在这里'));
        pool.forEach(function (it) { poolBox.appendChild(chip(it, false)); });
        meta.textContent = '已放 ' + placed.length + ' / ' + need + (isP && q.extra && q.extra.length ? '（有 ' + q.extra.length + ' 行是干扰项，不要放）' : '');
        check.disabled = solved || placed.length !== need;
        check.hidden = solved;
      }
      check.addEventListener('click', function () {
        var bad = -1, msg = '';
        for (var k = 0; k < placed.length; k++) {
          var it = placed[k];
          if (!it.ok) { bad = k; msg = '「' + it.t.trim() + '」不该放进来：' + it.why; break; }
          var want = isP ? k : sortedRanks[k];
          if (it.rank !== want) { bad = k; msg = isP ? '第 ' + (k + 1) + ' 行开始顺序不对。按骨架想：开时钟 → 配引脚 → 设参数 → 使能 → 运行；循环和花括号也要配好对。' : '第 ' + (k + 1) + ' 步放得不对。' + (it.hint || ''); break; }
        }
        if (bad < 0) { locked = placed.length; draw(); answer.classList.add('ok'); done(false); return; }
        tries++;
        locked = bad;
        var back = placed.splice(bad); back.forEach(function (x) { pool.push(x); });
        say('no', msg + (bad > 0 ? '（前 ' + bad + ' ' + (isP ? '行' : '步') + '是对的，已经固定）' : ''));
        draw();
        if (tries >= 3) offerReveal(function () {
          placed = isP ? q.lines.map(function (t, i) { return items[i]; }) : items.slice().sort(function (a, b) { return a.rank - b.rank; });
          pool = items.filter(function (x) { return placed.indexOf(x) < 0; }); locked = placed.length; draw(); done(true);
        });
      });
      var sortedRanks = items.filter(function (x) { return x.ok; }).map(function (x) { return x.rank; }).sort(function (a, b) { return a - b; });
      draw();
    }

    else if (q.type === 'fill') {
      var frow = el('div', 'q-fill'), inp = el('input', 'mono'), go = ui.btn('pill solid', '检查');
      inp.setAttribute('aria-label', '你的答案'); inp.setAttribute('autocomplete', 'off'); inp.setAttribute('autocapitalize', 'off'); inp.setAttribute('spellcheck', 'false'); inp.setAttribute('enterkeyhint', 'done');
      frow.appendChild(inp); frow.appendChild(go); body.appendChild(frow);
      var accept = q.answers.map(norm);
      function test() {
        if (solved) return;
        var v = norm(inp.value); if (!v) { inp.focus(); return; }
        if (accept.indexOf(v) > -1) { inp.classList.add('right'); inp.readOnly = true; go.hidden = true; done(false); return; }
        tries++; inp.classList.remove('shake'); void inp.offsetWidth; inp.classList.add('shake');
        var h = q.hints[Math.min(tries, q.hints.length) - 1];
        say('hint', '还不对。' + (h ? '提示 ' + Math.min(tries, q.hints.length) + '：' + h : ''));
        if (tries >= q.hints.length) offerReveal(function () { inp.value = q.answers[0]; inp.readOnly = true; go.hidden = true; done(true); });
      }
      go.addEventListener('click', test);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); test(); } });
    }

    box.isSolved = function () { return solved; };
    return box;
  }

  /* =================== 视图 =================== */
  function view(root, route, app) {
    if (route.t && STM.derive && STM.derive.has(route.t)) return STM.derive.view(root, route, app);   // 新的推导式章节
    var wrap = el('div', 'think');
    root.appendChild(wrap);
    var c = route.t ? byId[route.t] : null;
    var partBox = null, tabs = [], part = -1;      // 先声明再渲染：renderChapter 会用到它们

    /* ---------- 总览 ---------- */
    function renderIndex() {
      var head = el('header', 'pg-h tk-hero');
      head.appendChild(el('h1', null, '编程思维'));
      head.appendChild(el('p', null, '这里不再讲一遍知识，而是练一件事：拿到一个需求，自己想出代码该怎么写。I2C 是新的「推导链」章节：从「两颗芯片想说话」一步步推到每一行代码，每条规则都能说出是被哪个问题逼出来的；GPIO、USART 暂时还是四段式，之后会改成同样的推导方式。'));
      wrap.appendChild(head);
      var sk = el('section', 'sec tk-skbox'); sk.appendChild(el('h2', 'sec-h', '一套骨架，用在所有外设上'));
      sk.appendChild(el('p', 'sec-note', '几乎每个外设的程序都按这五步走。学会在 GPIO 里填满它，USART、I2C 只是往同样的格子里填不同的东西。'));
      sk.appendChild(skStrip(null));
      wrap.appendChild(sk);
      var list = el('section', 'sec'); list.appendChild(el('h2', 'sec-h', '章节'));
      var grid = el('div', 'tk-chs');
      deriveCards(grid);
      T.chapters.forEach(function (ch) {
        var t = M.topicById[ch.topic], p = prog(ch.id), d = partsDone(ch, p), n = d.filter(Boolean).length;
        var a = app.link({ v: 'think', t: ch.id }, 'tk-ch'); a.style.setProperty('--h', app.hue(t));
        var top = el('div', 'tk-ch-h'); top.appendChild(el('b', 'mono', t.code)); top.appendChild(el('span', null, n ? (n === 4 ? '已完成' : '完成 ' + n + ' / 4 步') : '还没开始')); a.appendChild(top);
        a.appendChild(el('h3', null, ch.title));
        a.appendChild(el('p', null, ch.goal));
        var bar = el('div', 'tk-dots'); d.forEach(function (x, i) { var s = el('span', x ? 'on' : null); s.title = PARTS[i][1]; bar.appendChild(s); }); a.appendChild(bar);
        grid.appendChild(a);
      });
      list.appendChild(grid);
      var rest = M.topics.filter(function (t) { return !T.chapters.some(function (ch) { return ch.topic === t.id; }) && !(STM.derive && STM.derive.has(t.id)); }).map(function (t) { return t.code; });
      if (rest.length) list.appendChild(el('p', 'sec-note tk-rest', rest.join('、') + ' 用同一套结构，之后陆续加入。'));
      wrap.appendChild(list);
    }

    // 推导式章节（新格式）的卡片：排在最前，标明「推导链」
    function deriveCards(grid) {
      var D = window.STM32_DERIVE || {};
      Object.keys(D).forEach(function (id) {
        var ch = D[id], t = M.topicById[ch.topic], pg = STM.derive.progress(id);
        var a = app.link({ v: 'think', t: id }, 'tk-ch tk-ch-d'); a.style.setProperty('--h', app.hue(t));
        var top = el('div', 'tk-ch-h'); top.appendChild(el('b', 'mono', t.code)); top.appendChild(el('span', null, pg.done ? (pg.done === pg.total ? '推完了' : '推到第 ' + pg.done + ' / ' + pg.total + ' 个问题') : pg.total + ' 个问题')); a.appendChild(top);
        a.appendChild(el('h3', null, ch.title));
        a.appendChild(el('p', null, '从零推导：' + ch.task));
        var badge = el('span', 'tk-new', '推导链 · 完整推导 / 自主推导'); a.appendChild(badge);
        var bar = el('div', 'tk-dots'); for (var k = 0; k < 10; k++) { var sp = el('span', k < Math.round(pg.done / pg.total * 10) ? 'on' : null); bar.appendChild(sp); } a.appendChild(bar);
        grid.appendChild(a);
      });
    }

    // 五步骨架条：hit 是本章用到的骨架格（null = 总览，全亮）
    function skStrip(ch) {
      var used = {};
      if (ch) ch.skel.steps.forEach(function (s, i) { (used[s.sk] = used[s.sk] || []).push(i); });
      var ol = el('ol', 'skstrip');
      T.SK.forEach(function (s) {
        var li = el('li', 'sk' + (ch && !used[s.id] ? ' off' : ''));
        li.appendChild(el('b', null, s.name));
        li.appendChild(el('span', null, ch && !used[s.id] ? '本章不需要' : ch ? used[s.id].length + ' 步' : s.what));
        ol.appendChild(li);
      });
      return ol;
    }

    /* ---------- 一章 ---------- */
    function renderChapter(r) {
      var t = M.topicById[c.topic];
      wrap.style.setProperty('--h', app.hue(t));
      var head = el('header', 'tk-h');
      var crumbs = app.link({ v: 'think' }, 'tk-crumb', '编程思维总览'); crumbs.textContent = '编程思维'; head.appendChild(crumbs);
      head.appendChild(el('h1', null, c.title));
      var goal = el('p', 'tk-goal'); goal.appendChild(ui.icon('flag')); goal.appendChild(el('span', null, '目标：' + c.goal)); head.appendChild(goal);
      wrap.appendChild(head);
      var nav = el('nav', 'tk-parts'); nav.setAttribute('aria-label', '四个步骤');
      PARTS.forEach(function (pt, i) {
        var b = ui.btn('tk-part'); b.appendChild(el('span', 'tk-pn', i + 1)); b.appendChild(el('span', 'tk-pt', pt[1]));
        b.addEventListener('click', function () { app.update({ p: String(i + 1) }); });
        tabs.push(b); nav.appendChild(b);
      });
      wrap.appendChild(nav);
      partBox = el('div', 'tk-body'); wrap.appendChild(partBox);
      var foot = el('div', 'tk-foot'), reset = ui.btn('textbtn', '清空本章进度');
      reset.addEventListener('click', function () {
        if (!reset.classList.contains('arm')) { reset.classList.add('arm'); reset.textContent = '再点一次确认清空'; setTimeout(function () { reset.classList.remove('arm'); reset.textContent = '清空本章进度'; }, 3000); return; }
        var all = load(); delete all[c.id]; save(all); part = -1; showPart(0, true); ui.toast('本章进度已清空');
      });
      var topicLink = app.link({ v: 'topic', t: t.id }, 'textbtn'); topicLink.textContent = '回到 ' + t.code + ' 资料页';
      foot.appendChild(topicLink); foot.appendChild(reset); wrap.appendChild(foot);
      showPart(r.p ? Number(r.p) - 1 : firstOpen(), true);
    }
    function firstOpen() { var d = partsDone(c, prog(c.id)); for (var i = 0; i < 4; i++) if (!d[i]) return i; return 0; }
    function syncTabs() {
      var d = partsDone(c, prog(c.id));
      tabs.forEach(function (b, i) { b.classList.toggle('on', i === part); b.classList.toggle('done', d[i]); b.setAttribute('aria-current', i === part ? 'step' : 'false'); b.title = PARTS[i][1] + (d[i] ? '（已完成）' : ''); });
    }
    function showPart(i, initial) {
      if (i === part) return;
      part = i; ui.clear(partBox);
      [whyPart, skelPart, selfPart, morePart][i]();
      syncTabs();
      if (!initial) { var top = wrap.querySelector('.tk-parts'); if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start' }); }
    }
    function nextPartBtn(i, label) {
      var b = ui.btn('pill solid tk-next', label || '下一步：' + PARTS[i][1]);
      b.addEventListener('click', function () { app.update({ p: String(i + 1) }); });
      return b;
    }

    /* 第一段：为什么 —— 一次一张卡片 */
    function whyPart() {
      var p = prog(c.id), idx = Math.min(p.why || 0, c.why.length - 1);
      var card = el('article', 'tk-card'), navr = el('div', 'tk-cardnav'), prev = ui.btn('pill', '上一张'), next = ui.btn('pill solid', '下一张'), count = el('span', 'tk-count mono');
      navr.appendChild(prev); navr.appendChild(count); navr.appendChild(next);
      partBox.appendChild(card); partBox.appendChild(navr);
      function draw(k, focus) {
        idx = k; ui.clear(card);
        var w = c.why[k];
        card.appendChild(el('h2', null, w.title));
        w.text.forEach(function (t) { card.appendChild(el('p', null, t)); });
        if (w.note) card.appendChild(el('p', 'tk-note', w.note));
        if (w.fig && M.figById[w.fig]) { var fb = linkBtn({ fig: w.fig }, app); card.appendChild(fb); }
        var answered = !w.q || (p.whyQ && p.whyQ[k]);
        if (w.q) {
          var qbox = el('div', 'tk-think'); qbox.appendChild(el('h3', null, '先想一想'));
          var qq = ask(w.q, { app: app, onSolved: function () { setProg(c.id, function (pp) { pp.whyQ = pp.whyQ || {}; pp.whyQ[k] = true; }); next.disabled = false; } });
          qbox.appendChild(qq); card.appendChild(qbox);
          // 以前答对过：直接显示答对的状态
          if (answered && w.q.type === 'choice') Array.prototype.forEach.call(qq.querySelectorAll('.q-opt'), function (b, i) { if (w.q.opts[i].ok) b.click(); });
        }
        count.textContent = (k + 1) + ' / ' + c.why.length;
        prev.disabled = k === 0;
        var last = k === c.why.length - 1;
        next.textContent = last ? '下一步：思路骨架' : '下一张';
        next.disabled = !!w.q && !answered;
        if (w.q && !answered) { var skip = ui.btn('textbtn tk-skip', '先跳过这题'); skip.addEventListener('click', function () { next.disabled = false; skip.remove(); }); card.appendChild(skip); }
        setProg(c.id, function (pp) { pp.why = Math.max(pp.why || 0, k); if (last) pp.whyDone = true; });
        p = prog(c.id); syncTabs();
        if (focus) { var h = card.querySelector('h2'); h.tabIndex = -1; try { h.focus({ preventScroll: true }); } catch (e) {} card.scrollIntoView({ block: 'nearest' }); }
      }
      prev.addEventListener('click', function () { if (idx > 0) draw(idx - 1, true); });
      next.addEventListener('click', function () { if (idx < c.why.length - 1) draw(idx + 1, true); else app.update({ p: '2' }); });
      draw(idx);
    }

    /* 第二段：思路骨架 —— 步骤卡片 + 完整程序（点步骤，程序里对应的行高亮） */
    function skelPart() {
      var s = c.skel;
      partBox.appendChild(el('p', 'tk-lead', s.intro));
      partBox.appendChild(skStrip(c));
      var grid = el('div', 'tk-skel'), steps = el('ol', 'tk-steps'), prog_ = el('div', 'tk-prog');
      grid.appendChild(steps); grid.appendChild(prog_);
      partBox.appendChild(grid);
      var segs = [];
      var pbox = el('figure', 'code tk-code'), ph = el('figcaption', 'code-h'); ph.appendChild(el('span', 'code-t', '完整程序：点左边的步骤看它在哪几行'));
      var full = s.program.map(function (x) { return x.code; }).join('\n');
      ph.appendChild(ui.copyBtn('复制完整程序', function () { return full; }));
      var pre = el('pre'), code = el('code');
      s.program.forEach(function (x) {
        var seg = el('span', 'seg' + (x.s >= 0 ? ' s' + x.s : '')); seg.dataset.s = x.s;
        seg.appendChild(ui.hlC(x.code + '\n'));
        if (x.s >= 0) seg.addEventListener('click', function () { focusStep(x.s, true); });
        code.appendChild(seg); segs.push(seg);
      });
      pre.appendChild(code); pbox.appendChild(ph); pbox.appendChild(pre); prog_.appendChild(pbox);
      var cards = [];
      s.steps.forEach(function (st, i) {
        var li = el('li', 'tk-step'), det = el('details'), sum = el('summary');
        var tag = el('span', 'sktag sk-' + st.sk, (SKI[st.sk] + 1) + ' ' + T.SK[SKI[st.sk]].name);
        var tt = el('span', 'tk-st'); tt.appendChild(tag); tt.appendChild(el('b', null, st.title)); tt.appendChild(el('span', 'tk-what', st.what));
        sum.appendChild(tt); det.appendChild(sum);
        var inner = el('div', 'tk-stb');
        function row(label, text, cls) { if (!text) return; var d = el('div', 'tk-why ' + (cls || '')); d.appendChild(el('h4', null, label)); d.appendChild(el('p', null, text)); inner.appendChild(d); }
        row('为什么要做', st.why); row('如果跳过', st.skip, 'skip'); row('小心', st.trap, 'trap'); row('说明', st.note);
        if (st.reg) inner.appendChild(ui.codeBlock(st.reg, { title: '寄存器写法', copyLabel: '复制寄存器写法' }));
        if (st.hal) inner.appendChild(ui.codeBlock(st.hal, { title: 'HAL / CubeMX 里对应的写法', copyLabel: '复制 HAL 写法' }));
        var lk = linkBtn(st.link, app); if (lk) inner.appendChild(lk);
        det.appendChild(inner); li.appendChild(det);
        det.addEventListener('toggle', function () {
          if (det.open) { focusStep(i, false); setProg(c.id, function (pp) { pp.skelOpen = pp.skelOpen || {}; pp.skelOpen[i] = true; if (Object.keys(pp.skelOpen).length >= s.steps.length) pp.skelDone = true; }); syncTabs(); }
        });
        steps.appendChild(li); cards.push(det);
      });
      function focusStep(i, fromCode) {
        segs.forEach(function (g) { g.classList.toggle('on', Number(g.dataset.s) === i); });
        cards.forEach(function (d, k) { d.parentNode.classList.toggle('on', k === i); });
        if (fromCode) { cards[i].open = true; cards[i].parentNode.scrollIntoView({ block: 'nearest', behavior: ui.reduced() ? 'auto' : 'smooth' }); }
        else { var g = segs.filter(function (x) { return Number(x.dataset.s) === i; })[0]; if (g && window.innerWidth >= 1100) g.scrollIntoView({ block: 'nearest' }); }
      }
      cards[0].open = true;
      var end = el('div', 'tk-endrow');
      var ok = ui.btn('pill solid tk-next', '我看懂了，自己推一遍');
      ok.addEventListener('click', function () { setProg(c.id, function (pp) { pp.skelDone = true; }); app.update({ p: '3' }); });
      end.appendChild(ok); partBox.appendChild(end);
    }

    /* 第三 / 四段：做题 */
    function selfPart() { c.tasks.filter(function (t) { return t.kind === 'guided'; }).forEach(function (t) { runTask(t, partBox); }); }
    function morePart() {
      var list = c.tasks.filter(function (t) { return t.kind === 'transfer'; });
      partBox.appendChild(el('p', 'tk-lead', '同一套骨架，换一个需求。提示会比上一段少：先自己想，卡住了再看提示。'));
      list.forEach(function (t) { runTask(t, partBox); });
    }
    function runTask(task, host) {
      var sec = el('section', 'tk-task'), saved = prog(c.id).tasks && prog(c.id).tasks[task.id] || { i: 0, done: false };
      var h = el('header', 'tk-task-h'); h.appendChild(el('h2', null, task.title)); h.appendChild(el('p', null, task.goal));
      var bar = el('div', 'tk-bar'), fill = el('i'); bar.appendChild(fill); var bl = el('span', 'tk-barl mono');
      h.appendChild(bar); h.appendChild(bl); sec.appendChild(h);
      var chain = el('ol', 'tk-chain'); chain.setAttribute('aria-label', '已经想清楚的步骤');
      var stage = el('div', 'tk-stage');
      sec.appendChild(chain); sec.appendChild(stage); host.appendChild(sec);
      var n = task.qs.length, i = Math.min(saved.i || 0, n);
      function progress() { fill.style.width = (i / n * 100) + '%'; bl.textContent = i >= n ? '完成' : '第 ' + (i + 1) + ' / ' + n + ' 步'; }
      // 「已经想清楚的步骤」：每道题留下一句结论，连起来就是整条思路
      function gist(q, k) {
        if (task.gists && task.gists[k]) return task.gists[k];
        var e = String(q.explain || '').replace(/^对[。，、！!,]?\s*/, ''), first = e.split(/(?<=[。；])/)[0].trim();
        if (first.length >= 6) return first.replace(/[；]$/, '。');
        if (q.type === 'choice') { var ok = q.opts.filter(function (o) { return o.ok; })[0]; return ok ? ok.t : first; }
        if (q.type === 'fill') return q.q.replace(/[（(][^）)]*[）)]\s*$/, '').replace(/[？?]\s*$/, '') + '：' + q.answers[0];
        if (q.type === 'order') return '顺序：' + q.items.slice().sort(function (a, b) { return a.rank - b.rank; }).map(function (x) { return x.t; }).join(' → ');
        return first || '代码拼好了。';
      }
      function addChain(k) {
        var q = task.qs[k], li = el('li'), b = el('span', 'tk-ci', k + 1);
        li.appendChild(b); li.appendChild(el('span', null, gist(q, k)));
        chain.appendChild(li);
      }
      for (var k = 0; k < i; k++) addChain(k);
      function step(focus) {
        ui.clear(stage); progress();
        if (i >= n) { finish(); return; }
        var q = task.qs[i];
        var qe = ask(q, { app: app, onSolved: function () {
          var go = ui.btn('pill solid tk-go', i + 1 >= n ? '完成，看完整程序' : '下一步');
          go.addEventListener('click', function () { addChain(i); i++; setProg(c.id, function (pp) { taskP(pp, task.id).i = i; }); step(true); });
          stage.appendChild(go);
          try { go.focus({ preventScroll: true }); } catch (e) {}
        } });
        stage.appendChild(qe);
        if (focus) { try { qe._head.focus({ preventScroll: true }); } catch (e) {} qe.scrollIntoView({ block: 'nearest', behavior: ui.reduced() ? 'auto' : 'smooth' }); }
      }
      function finish() {
        setProg(c.id, function (pp) { var x = taskP(pp, task.id); x.i = n; x.done = true; }); syncTabs();
        var f = el('div', 'tk-final');
        var head = el('div', 'tk-final-h'); head.appendChild(ui.icon('check')); head.appendChild(el('b', null, '这一题想通了')); f.appendChild(head);
        var lastP = task.qs.filter(function (q) { return q.type === 'parsons'; }).pop();
        if (lastP) f.appendChild(ui.codeBlock(lastP.lines.join('\n'), { title: '你拼出来的程序', copyLabel: '复制程序' }));
        if (task.final) {
          var ck = el('div', 'tk-check'); ck.appendChild(el('h3', null, task.final.title || '上板验证'));
          var ul = el('ul'); task.final.check.forEach(function (x) { ul.appendChild(el('li', null, x)); }); ck.appendChild(ul); f.appendChild(ck);
        }
        var again = ui.btn('textbtn', '重做这一题');
        again.addEventListener('click', function () { setProg(c.id, function (pp) { pp.tasks[task.id] = { i: 0, done: false }; }); i = 0; ui.clear(chain); step(true); syncTabs(); });
        var row = el('div', 'tk-endrow'); row.appendChild(again);
        if (part === 2) row.appendChild(nextPartBtn(3, '下一步：换个需求'));
        f.appendChild(row);
        stage.appendChild(f);
      }
      step(false);
    }

    if (!c) renderIndex(); else renderChapter(route);
    return {
      title: function () { return c ? c.title.split('：')[0] + ' 编程思维' : '编程思维'; },
      update: function (r) { if (c && r.t === c.id) showPart(r.p ? Number(r.p) - 1 : part); }
    };
  }

  STM.views.think = view;
  STM.think = {
    chapter: function (id) { return byId[id] || (STM.derive && STM.derive.chapter(id)) || null; },
    // 旧四段式：[段1完成, 段2, 段3, 段4]；推导式：{ done, total, due }
    progress: function (id) { var c = byId[id]; return c ? partsDone(c, prog(id)) : STM.derive ? STM.derive.progress(id) : null; }
  };
})();
