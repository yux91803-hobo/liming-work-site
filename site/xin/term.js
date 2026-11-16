/* xin/term.js — 小芯的终端（站长 2026-11-16：「搞一个实时展示小芯干活的命令行动画，UI 设计可以参考 Claude Code 命令行」）
   只管画：一个事件一行（敲的命令、改的文件和改动、打开的网页、搜索、插件、控制器自己的步骤、中途说的话），
   最底下一行转圈写着在干什么，做完收成一行、点开看全部。什么时候建、放在哪、喂哪些事件由 chat.js 决定
   （docs/superpowers/plans/2026-11-16-xin-workbench-round2-b.md 的 Task 2）。
   - 样子参考 Claude Code 命令行：每一步一个圆点，结果缩进在一道折角线下面，转圈的星 · ✢ ✳ ✶ ✻ ✽ 来回换、动作词上一道闪光。
     圆点、折角线和星都是画出来的（字符在 iPhone 上会变成彩色 emoji）。
   - 打字机参考 termynal（ines/termynal，每字 90 毫秒）。这里是真实进度，不能被动画拖慢：每字 14 毫秒、一行最多 0.45 秒，
     排着的超过 3 行，前面的直接画出来；系统设了减少动态就不打字、不转圈、不闪光。
   - 不显示内部命令：xin 后面不是 browser 的（派活、记忆、交付这些）一律不画；xin browser 画成网页。 */
(function () {
  'use strict';
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function reduce() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function dur(ms) { var s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + ' 秒' : s < 3600 ? Math.round(s / 60) + ' 分钟' : (s / 3600).toFixed(1).replace(/\.0$/, '') + ' 小时'; }
  function secs(s) { s = Math.max(0, s | 0); return s >= 60 ? Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒' : s + ' 秒'; }
  // 去掉 bash 外壳（/bin/bash -lc '…'）和前面的「cd 某处 &&」
  function bare(d) {
    var s = String(d || '').trim(), m = /^\/(?:usr\/)?bin\/(?:ba)?sh -l?c (['"])([\s\S]*)\1$/.exec(s);
    return (m ? m[2] : s).replace(/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '');
  }
  function short(p) { var a = String(p || '').split('/').filter(Boolean); return a.length > 2 ? a.slice(-2).join('/') : a.join('/') || String(p || ''); }
  function host(u) { return String(u || '').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, ''); }
  var BROWSER = { open: '打开网页', back: '后退', click: '点网页', fill: '填写', press: '按键', select: '选择', scroll: '翻页', snapshot: '读网页', text: '读正文', screenshot: '截图', tabs: '看标签页', tab: '切标签页', close: '关浏览器', login: '请你登录' };

  // 一个事件 → 终端里的一行：{kind, verb, arg, sub}；内部命令返回 null
  function line(ev) {
    var n = String(ev && ev.name || ''), raw = String(ev && ev.detail || ''), d = bare(raw), m;
    if (n === 'Bash') {
      if ((m = /^\s*xin\s+browser\s+([a-z]+)\s*([\s\S]*)$/.exec(d))) return { kind: 'web', verb: BROWSER[m[1]] || '浏览器', arg: m[2].replace(/^['"]|['"]$/g, ''), sub: m[1] };
      if (/^\s*xin(?:\s|$)/.test(d)) return null;
      return { kind: 'cmd', verb: '$', arg: d };
    }
    if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) return { kind: 'edit', verb: '改了', arg: raw.split('\n').map(function (l) { return short(l.replace(/^(?:add|update|delete|create)\s+/, '')); }).filter(Boolean).join('、') };
    if (n === 'WebSearch') return { kind: 'search', verb: '搜索', arg: '「' + raw + '」' };
    if (n === 'WebFetch') return { kind: 'web', verb: '打开网页', arg: raw, sub: 'open' };
    if (n === 'MCP') return { kind: 'tool', verb: '插件', arg: raw };
    if (/[一-龥]/.test(n)) return { kind: 'step', verb: n, arg: raw };   // 控制器自己的步骤：检查网页、生成预览、编译核验
    var p = '';
    try { var o = JSON.parse(raw); p = o && (o.path || o.file_path || o.file || o.url || o.pattern || o.query) || ''; } catch (e) { /* 不是 JSON */ }
    return { kind: 'tool', verb: n || '工具', arg: p ? String(p) : d };
  }
  // 做完那一行：干完了 · 用时 2 分钟 · 4 条命令 · 改了 2 个文件；前台一段：在电脑上做了 18 秒 · 2 条命令
  var LEAD = { done: '干完了', failed: '没做成', stopped: '停了', waiting: '停下来等你' };
  function summary(c, state, ms) {
    c = c || {};
    var parts = state ? [LEAD[state] || '做完了'].concat(ms != null ? ['用时 ' + dur(ms)] : []) : [ms != null ? '在电脑上做了 ' + dur(ms) : '在电脑上做了这些'];
    if (c.cmd) parts.push(c.cmd + ' 条命令');
    if (c.files) parts.push('改了 ' + c.files + ' 个文件');
    if (c.web) parts.push('看了 ' + c.web + ' 个网页');
    if (c.search) parts.push('搜了 ' + c.search + ' 次');
    if (c.tool) parts.push('用了 ' + c.tool + ' 次工具');
    return parts.join(' · ');
  }

  /* ---------- 转圈的星：所有活着的终端共用一个 120 毫秒的计时器；没有活着的、页面藏起来就停 ---------- */
  function star(len, n, rot) {
    var d = '';
    for (var i = 0; i < n; i++) { var a = (rot + i * 360 / n) * Math.PI / 180; d += 'M0 0L' + (Math.cos(a) * len).toFixed(2) + ' ' + (Math.sin(a) * len).toFixed(2); }
    return d;
  }
  var FR = ['M-.5 0a.5 .5 0 1 0 1 0a.5 .5 0 1 0-1 0', star(2.6, 4, 0), star(4.2, 4, 0) + star(2, 4, 45), star(5, 8, 0), star(6, 8, 22.5), star(6.4, 8, 0) + star(3, 8, 22.5)];
  var SEQ = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1], live = [], tickTm = 0, frame = 0;
  function tick() {
    live = live.filter(function (t) { return t.live && t.el.isConnected; });
    if (!live.length || document.hidden) { clearInterval(tickTm); tickTm = 0; return; }
    frame = (frame + 1) % SEQ.length;
    live.forEach(function (t) { if (t.sp) t.sp.setAttribute('d', FR[SEQ[frame]]); });
  }
  function startTick() { if (!tickTm && !reduce() && !document.hidden) tickTm = setInterval(tick, 120); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && live.length) startTick(); });

  /* ---------- 打字机：一个 rAF 循环管所有终端里排着的行 ---------- */
  var Q = [], raf = 0, last = 0;
  function typeLoop(now) {
    raf = 0;
    var dt = last ? Math.min(64, now - last) : 16; last = now;
    while (Q.length > 3) done(Q.shift());   // 积压的直接画出来：动画不能拖慢真实进度
    var job = Q[0];
    if (!job) { last = 0; return; }
    if (!job.t.el.isConnected) { Q.shift(); return next(); }
    var per = Math.max(1, Math.min(14, 450 / Math.max(1, job.text.length)));
    job.i = Math.min(job.text.length, job.i + Math.max(1, Math.round(dt / per)));
    job.el.textContent = job.text.slice(0, job.i);
    if (job.i >= job.text.length) done(Q.shift());
    next();
  }
  function next() { if (Q.length && !raf) raf = requestAnimationFrame(typeLoop); else if (!Q.length) last = 0; }
  function done(job) { job.el.textContent = job.text; job.row.classList.remove('tm-typing'); job.row._typing = false; if (job.row._after) { var f = job.row._after; job.row._after = null; f(); } job.t.stick(); }
  function typeIn(t, row, el, text) {
    row._typing = true; row.classList.add('tm-typing'); el.textContent = '';
    Q.push({ t: t, row: row, el: el, text: text, i: 0 }); next();
  }

  /* ---------- 一行的输出：命令前 3 行（失败的看最后 3 行），改动前 8 行，点「还有 N 行」展开 ---------- */
  function outLines(text) { var a = String(text || '').replace(/\s+$/, '').split('\n'); return a.length === 1 && !a[0] ? [] : a; }
  function moreBtn(box, n, all) {
    var b = h('button', 'tm-more', '… 还有 ' + n + ' 行'); b.type = 'button';
    b.addEventListener('click', function () { all(); b.remove(); });
    box.appendChild(b);
  }
  function cmdOut(row, out, ok) {
    var a = outLines(out); if (!a.length) return;
    var box = h('div', 'tm-o'), pre = h('pre', 'tm-pre'), keep = 3, part = ok === false ? a.slice(-keep) : a.slice(0, keep);
    pre.textContent = part.join('\n'); box.appendChild(pre);
    if (a.length > keep) moreBtn(box, a.length - keep, function () { pre.textContent = a.join('\n'); });
    row.appendChild(box);
  }
  // Codex 的改动：「--- 类型 路径」接着差异；新建的文件内容没有 +，当新增画
  function diffParse(out) {
    var files = [], cur = null;
    outLines(out).forEach(function (l) {
      var m = /^--- (add|update|delete|create) (.+)$/.exec(l);
      if (m) { cur = { kind: m[1], path: m[2], lines: [], add: 0, del: 0 }; files.push(cur); return; }
      if (!cur) return;
      var k = /^@@/.test(l) ? 'hunk' : /^\+/.test(l) ? 'add' : /^-/.test(l) ? 'del' : cur.kind === 'add' || cur.kind === 'create' ? 'add' : 'ctx';
      if (k === 'add') cur.add++; else if (k === 'del') cur.del++;
      cur.lines.push({ k: k, s: k === 'add' && !/^\+/.test(l) ? '+' + l : l });
    });
    return files;
  }
  function editOut(row, out) {
    var files = diffParse(out); if (!files.length) return;
    var box = h('div', 'tm-o'), pre = h('div', 'tm-diff'), all = [], keep = 8;
    files.forEach(function (f) {
      all.push({ k: 'file', s: short(f.path) + (f.add ? '  +' + f.add : '') + (f.del ? '  −' + f.del : '') });
      f.lines.forEach(function (x) { all.push(x); });
    });
    function paint(n) { pre.textContent = ''; all.slice(0, n).forEach(function (x) { pre.appendChild(h('span', 'tm-dl tm-' + x.k, x.s.replace(/^-/, '−'))); }); }
    paint(keep); box.appendChild(pre);
    if (all.length > keep) moreBtn(box, all.length - keep, function () { paint(all.length); });
    row.appendChild(box);
  }
  function webOut(row, out) {
    var m = /(?:^|\n)标题：(.*)/.exec(String(out || '')), t = m && m[1].trim();
    var pg = row.querySelector('.tm-pg'); if (pg && t) pg.textContent = t;
  }

  /* ---------- 终端本身 ---------- */
  function create(o) {
    o = o || {};
    var el = h('div', 'xc-term' + (o.live ? ' tm-live' : ''));
    // 聊天列表是读屏会念的区域：终端里一行一行加的命令不念（太吵），做完以后小芯说的那条结果照常念
    el.setAttribute('role', 'group'); el.setAttribute('aria-live', 'off'); el.setAttribute('aria-label', o.title ? '小芯在做：' + o.title : '小芯在电脑上做的事');
    var hd = null;
    if (o.title) { hd = h('div', 'tm-hd'); hd.appendChild(h('b', 'tm-ttl', o.title)); el.appendChild(hd); }
    var body = h('div', 'tm-body'), inner = h('div', 'tm-in'), ls = h('div', 'tm-ls');
    inner.appendChild(ls); body.appendChild(inner); el.appendChild(body);
    var t = { el: el, live: !!o.live, sp: null, pend: {} };
    var st = null, sv = null, ss = null;
    if (o.live) {
      st = h('div', 'tm-st'); st.setAttribute('aria-hidden', 'true');
      st.innerHTML = '<svg class="tm-sp" viewBox="-8 -8 16 16"><path d="' + FR[3] + '"/></svg>';
      t.sp = st.firstChild.firstChild;
      sv = h('span', 'tm-sv', '准备中'); ss = h('span', 'tm-ss', '');
      st.appendChild(sv); st.appendChild(ss); inner.appendChild(st);
      live.push(t); startTick();
    }
    t.stick = function () {
      if (!t.live) return;
      ls.scrollTop = ls.scrollHeight;
      el.classList.toggle('tm-ovf', ls.scrollHeight > ls.clientHeight + 2);
    };
    function row(spec, running) {
      var r = h('div', 'tm-l tm-k-' + spec.kind + (running ? ' tm-run' : '')), main = h('div', 'tm-m');
      r.dataset.k = spec.kind;
      if (spec.kind !== 'say') r.appendChild(h('i', 'tm-b'));
      if (spec.kind === 'say') { main.appendChild(h('span', 'tm-say', spec.arg)); r.appendChild(main); return r; }
      main.appendChild(h('span', 'tm-v', spec.verb));
      var arg = h(spec.kind === 'cmd' || spec.kind === 'edit' || spec.kind === 'tool' ? 'code' : 'span', 'tm-a', spec.kind === 'web' && spec.sub === 'open' ? '' : spec.arg);
      if (spec.kind === 'cmd' || spec.kind === 'edit') arg.title = spec.arg;
      main.appendChild(arg); r.appendChild(main);
      // 打开网页：自己画的地址栏和加载条（不是它电脑的画面），做完写上标题
      if (spec.kind === 'web' && spec.sub === 'open') {
        var w = h('div', 'tm-web'), bar = h('div', 'tm-url');
        bar.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="5.5" width="7" height="5" rx="1"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5"/></svg>';
        bar.appendChild(h('span', 'tm-host', host(spec.arg))); w.appendChild(bar);
        w.appendChild(h('i', 'tm-load')); w.appendChild(h('span', 'tm-pg', ''));
        r.appendChild(w);
      }
      return r;
    }
    function append(r, spec, animate) {
      ls.appendChild(r);
      var a = r.querySelector('.tm-a');
      if (animate && a && spec.arg && spec.kind !== 'web' && !reduce() && t.live) typeIn(t, r, a, spec.arg);
      t.stick();
    }
    function end(r, ev, spec) {
      var go = function () {
        r.classList.remove('tm-run'); r.classList.add(ev.ok === false ? 'tm-bad' : 'tm-ok');
        if (spec.kind === 'cmd') cmdOut(r, ev.out, ev.ok);
        else if (spec.kind === 'edit') editOut(r, ev.out);
        else if (spec.kind === 'web') webOut(r, ev.out);
        else if (spec.kind === 'step' || spec.kind === 'tool') cmdOut(r, ev.out, ev.ok);
        t.stick();
      };
      if (r._typing) r._after = go; else go();
    }
    t.feed = function (ev, animate) {
      if (!ev) return null;
      var spec, r;
      if (ev.t === 'tool') {
        spec = line(ev); if (!spec) return null;
        r = row(spec, true); r._spec = spec; if (ev.id != null) t.pend[ev.id] = r;
        append(r, spec, animate); return r;
      }
      if (ev.t === 'tool_end') {
        r = ev.id != null ? t.pend[ev.id] : null;
        if (r) { delete t.pend[ev.id]; spec = r._spec; }
        else { spec = line(ev); if (!spec) return null; r = row(spec, false); r._spec = spec; append(r, spec, animate); }
        end(r, ev, spec); return r;
      }
      if (ev.t === 'text' && ev.text) {
        var s = String(ev.text).replace(/[*`#>]/g, '').split('\n').filter(function (x) { return x.trim(); }).slice(0, 2).join(' ').slice(0, 160);
        if (!s) return null;
        r = row({ kind: 'say', arg: s }, false); append(r, { kind: 'say' }, false); return r;
      }
      if (ev.t === 'err' && ev.text) {
        r = row({ kind: 'step', verb: '出错', arg: String(ev.text).slice(0, 200) }, false); r.classList.add('tm-bad'); append(r, { kind: 'step' }, false); return r;
      }
      if (ev.t === 'mark' && ev.text) { r = h('div', 'tm-mark', ev.text); ls.appendChild(r); t.stick(); return r; }
      return null;
    };
    t.status = function (verb, sec) {
      if (!sv) return;
      if (verb && sv.textContent !== verb) sv.textContent = verb;
      var v = sec != null && sec >= 1 ? '· ' + secs(sec) : '';
      if (ss.textContent !== v) ss.textContent = v;
    };
    t.counts = function () {
      var c = { cmd: 0, files: 0, web: 0, search: 0, tool: 0 };
      [].forEach.call(ls.querySelectorAll('.tm-l'), function (r) {
        var k = r.dataset.k;
        if (k === 'cmd') c.cmd++;
        else if (k === 'edit') c.files += Math.max(1, (r._spec && r._spec.arg ? r._spec.arg.split('、').length : 1));
        else if (k === 'web' && r._spec && r._spec.sub === 'open') c.web++;
        else if (k === 'search') c.search++;
        else if (k === 'tool') c.tool++;
      });
      return c;
    };
    // 封上这一段（前台说了话、接下来是新的一段）：不再转圈，内容留着
    t.seal = function () {
      Q.filter(function (j) { return j.t === t; }).forEach(function (j) { Q.splice(Q.indexOf(j), 1); done(j); });
      t.live = false; el.classList.remove('tm-live'); el.classList.add('tm-sealed');
      if (st) st.remove();
      Object.keys(t.pend).forEach(function (id) { t.pend[id].classList.remove('tm-run'); t.pend[id].classList.add('tm-stop'); });
      t.pend = {};
      ls.scrollTop = ls.scrollHeight;
    };
    // 做完：收成一行（点开看全部）。state：done / failed / stopped / waiting；null 是前台的一段
    t.finish = function (state, ms) {
      if (el.classList.contains('tm-done')) return;
      t.seal();
      var c = t.counts(), sum = h('button', 'tm-sum'), id = 'tm' + Math.random().toString(36).slice(2, 9);
      sum.type = 'button'; sum.setAttribute('aria-expanded', 'false'); sum.setAttribute('aria-controls', id); body.id = id;
      sum.innerHTML = '<i class="tm-b"></i><svg class="tm-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
      sum.firstChild.className = 'tm-b ' + (state === 'failed' ? 'tm-bad' : state === 'stopped' || state === 'waiting' ? 'tm-stop' : 'tm-ok');
      var txt = h('span', 'tm-sum-t');
      if (o.title) txt.appendChild(h('b', '', o.title));
      txt.appendChild(h('span', '', summary(c, state || null, ms)));
      sum.insertBefore(txt, sum.lastChild);
      sum.addEventListener('click', function () { t.open(!el.classList.contains('tm-open')); });
      if (hd) hd.remove();
      el.insertBefore(sum, body);
      el.classList.remove('tm-pin', 'tm-sealed'); el.classList.add('tm-done', 'tm-st-' + (state || 'fg'));
      if (!reduce() && el.isConnected) void body.offsetHeight;   // 先按展开的高度排一次，收起才有过渡
      el.classList.add('tm-shut');
      return sum;
    };
    t.open = function (on) {
      el.classList.toggle('tm-open', !!on); el.classList.toggle('tm-shut', !on);
      var b = el.querySelector('.tm-sum'); if (b) b.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) ls.scrollTop = 0;   // 点开从头看（活着的时候一直停在最底下）
      if (on && t.onOpen) t.onOpen();
    };
    t.rows = function () { return ls.querySelectorAll('.tm-l').length; };
    return t;
  }

  window.LimingXinTerm = { line: line, create: create, summary: summary, dur: dur, bare: bare };
})();
