/* derive-core.js — 「编程思维」推导章节的纯逻辑（不碰 DOM，可在 Node 里测试）
   · 把章节里 fns 的代码行编译成模拟器（i2csim.js）能执行的程序，支持「换顺序 / 替换某一行」
   · 跑场景、和正确版本比较差异
   · 排序题判定：只要满足所有「a 在 b 前」的因果规则就算对；相同文本的行（比如几个 I2C_DELAY）可以互换
   · 交换两行：找出被破坏的规则，在规则指定的场景里跑出反例
   · 常卡的地方：答错按「推理出错的那一环」归类，复习间隔逐次加长
   · 行内标记：**粗体**、`代码`、[[s5]] 跳到某一环、{F1} 主干结论 */
(function (root, factory) {
  var api = factory(root.STM32I2CSim || (typeof require === 'function' ? require('./i2csim.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STM32DeriveCore = api;
})(typeof window === 'object' ? window : this, function (Sim) {
  'use strict';

  /* ===================== 程序 ===================== */
  // patch：{ order: [原行号…], set: { 行号: { c, op } } }
  function patchLines(fn, patch) {
    var lines = fn.lines.slice();
    if (patch && patch.set) Object.keys(patch.set).forEach(function (k) { lines[k] = Object.assign({}, lines[k], patch.set[k]); });
    if (patch && patch.order) lines = patch.order.map(function (i) { return lines[i]; });
    return lines;
  }
  // 代码行 → 模拟器函数体（for 循环行展开成 { loop, body }）
  function compile(lines) {
    var body = [], stack = [body];
    lines.forEach(function (ln) {
      if (!ln) return;
      var top = stack[stack.length - 1];
      if (ln.loop) { var blk = { loop: ln.loop, body: [] }; top.push(blk); stack.push(blk.body); return; }
      if (ln.end) { if (stack.length > 1) stack.pop(); return; }
      if (ln.op && ln.op.length) top.push({ op: ln.op });
    });
    return { body: body };
  }
  function mergePatch(a, b) {
    var out = {};
    [a, b].forEach(function (p) { if (p) Object.keys(p).forEach(function (k) { out[k] = Object.assign({}, out[k] || {}, p[k]); }); });
    return out;
  }
  function program(ch, patch) {
    var fns = {};
    Object.keys(ch.fns).forEach(function (name) { fns[name] = compile(patchLines(ch.fns[name], patch && patch[name])); });
    return fns;
  }

  /* ===================== 场景 ===================== */
  function runScenario(ch, id, opt) {
    opt = opt || {};
    var sc = typeof id === 'string' ? ch.scenarios[id] : id;
    if (!sc || !sc.runs) throw new Error('no scenario ' + id);
    var bus = new Sim.Bus(), dev = null;
    var device = opt.device != null ? opt.device : sc.device !== false;
    if (device) {
      dev = bus.attach(new Sim.M24C02(opt.eeprom || sc.eeprom));
      var pre = Object.assign({}, sc.preset || {}, opt.preset || {});
      Object.keys(pre).forEach(function (a) { dev.mem[Number(a)] = pre[a]; });
    }
    var basePatch = mergePatch(sc.patch, opt.patch), results = [], err = null;
    try {
      sc.runs.forEach(function (r, k) {
        var fns = program(ch, mergePatch(basePatch, r.patch));
        var entry = r.entry;
        if (r.body) { fns.__run = { body: r.body }; entry = '__run'; }
        var params = Object.assign({}, r.params || {}, (opt.params && opt.params[k]) || {});
        var res = Sim.run(fns, entry, { bus: bus, params: params, delayUs: opt.delayUs });
        results.push({ entry: entry === '__run' ? null : entry, params: params, ret: res.ret, out: res.out, calls: res.calls });
        if (r.gapUs) bus.wait(r.gapUs);
      });
    } catch (e) { err = String(e && e.message || e); }
    var ev = Sim.decode(bus.trace);
    var watch = (sc.watch || []).map(function (a) { return { addr: a, v: dev ? dev.mem[a] : null }; });
    return {
      sc: sc, trace: bus.trace, ev: ev, desc: Sim.describe(ev), results: results, err: err,
      log: dev ? dev.log.slice() : [], watch: watch, timing: Sim.timing(bus.trace), device: device
    };
  }
  // 两次运行的差别，用人话说出来
  function diff(ref, got) {
    var out = [];
    if (got.err) out.push('程序没能跑完：' + got.err);
    var a = ref.desc.join(' | '), b = got.desc.join(' | ');
    if (a !== b) {
      var i = 0; while (i < ref.desc.length && i < got.desc.length && ref.desc[i] === got.desc[i]) i++;
      out.push('线上从第 ' + (i + 1) + ' 个事件开始不一样：应该是「' + (ref.desc[i] || '（结束）') + '」，实际是「' + (got.desc[i] || '（结束）') + '」');
    }
    ref.watch.forEach(function (w, k) {
      var g = got.watch[k];
      if (g && g.v !== w.v) out.push('EEPROM 0x' + Sim.hx(w.addr) + ' 应该是 0x' + Sim.hx(w.v) + '，实际是 0x' + Sim.hx(g.v) + (g.v === 0xFF ? '（没有写进去）' : ''));
    });
    ref.results.forEach(function (r, k) {
      var g = got.results[k]; if (!g) return;
      if (r.ret !== g.ret) out.push((r.entry || '程序') + ' 的返回值应该是 ' + fmtRet(r.ret) + '，实际是 ' + fmtRet(g.ret));
      if (r.out !== g.out) out.push('读到的数据应该是 ' + fmtRet(r.out) + '，实际是 ' + fmtRet(g.out));
    });
    var bad = got.timing.filter(function (t) { return !t.ok; }), rbad = ref.timing.filter(function (t) { return !t.ok; }).map(function (t) { return t.k; });
    bad.forEach(function (t) { if (rbad.indexOf(t.k) < 0) out.push('时序不满足：' + t.name + '（' + t.k + '）只有 ' + t.min + ' µs，规范要求至少 ' + t.spec + ' µs'); });
    return out;
  }
  function fmtRet(v) { return v == null ? '—' : typeof v === 'number' ? (v > 1 ? '0x' + Sim.hx(v) : String(v)) : String(v); }

  /* ===================== 排序题 =====================
     texts：每一项的文字（按正确顺序）；order：学生排出来的、原始下标的序列。
     相同文字的项可以互换：按出现先后，把学生序列里第 k 个「某文字」对应到原始的第 k 个「某文字」。 */
  function canon(texts, order) {
    var seen = {}, pos = {};
    var byText = {};
    texts.forEach(function (t, i) { (byText[norm(t)] = byText[norm(t)] || []).push(i); });
    var mapped = order.map(function (i) { var t = norm(texts[i]), n = seen[t] || 0; seen[t] = n + 1; return byText[t][n]; });
    mapped.forEach(function (i, p) { pos[i] = p; });
    return { mapped: mapped, pos: pos };
  }
  function norm(t) { return String(t).replace(/\s+/g, ' ').trim(); }
  // 返回 { ok, rule, at }：第一条被违反的规则（按学生序列里最早出问题的位置）
  function checkOrder(texts, order, rules) {
    var c = canon(texts, order), worst = null;
    (rules || []).forEach(function (r) {
      if (c.pos[r.a] == null || c.pos[r.b] == null) return;
      if (c.pos[r.a] > c.pos[r.b]) {
        var at = c.pos[r.b];
        if (!worst || at < worst.at) worst = { rule: r, at: at };
      }
    });
    return worst ? { ok: false, rule: worst.rule, at: worst.at, mapped: c.mapped } : { ok: true, mapped: c.mapped };
  }
  // 函数里取一部分行出来排：sub = 行号列表；返回规则（换成子序列里的下标）
  function subRules(fn, sub) {
    var idx = {}; sub.forEach(function (n, k) { idx[n] = k; });
    return (fn.rules || []).filter(function (r) { return idx[r.a] != null && idx[r.b] != null; })
      .map(function (r) { return Object.assign({}, r, { a: idx[r.a], b: idx[r.b], la: r.a, lb: r.b }); });
  }
  function orderToPatch(fn, sub, order) {
    // 学生给出的是 sub 中的下标顺序；放回整个函数
    var full = fn.lines.map(function (_, i) { return i; }), slots = sub.slice().sort(function (a, b) { return a - b; });
    var chosen = order.map(function (k) { return sub[k]; });
    slots.forEach(function (slot, k) { full[slot] = chosen[k]; });
    return { order: full };
  }

  /* ===================== 交换两行 ===================== */
  function swapOrder(fn, i, j) { var o = fn.lines.map(function (_, k) { return k; }); o[i] = j; o[j] = i; return o; }
  function swapCheck(ch, name, i, j) {
    var fn = ch.fns[name];
    if (i === j) return { same: true };
    if (norm(fn.lines[i].c) === norm(fn.lines[j].c)) return { same: true, note: '这两行一模一样，交换没有任何区别。' };
    var lo = Math.min(i, j), hi = Math.max(i, j);
    var broken = (fn.rules || []).filter(function (r) {
      // 交换后，规则两端的相对位置变了 → 被破坏（a 在 b 前的规则，交换后 a 跑到了 b 后面）
      var pa = r.a === i ? j : r.a === j ? i : r.a, pb = r.b === i ? j : r.b === j ? i : r.b;
      return pa > pb;
    });
    var structural = fn.lines[i].loop || fn.lines[j].loop || fn.lines[i].end || fn.lines[j].end;
    function acts(l) { return !!(l.op && l.op.length); }
    if (!acts(fn.lines[i]) && !acts(fn.lines[j])) return { broken: broken, nosim: true, diff: [], range: [lo, hi] };   // 寄存器配置这类行：只讲道理，不跑波形
    var sc = broken.length && broken[0].sc ? broken[0].sc : 'write';
    var patch = {}; patch[name] = { order: swapOrder(fn, i, j) };
    var ref = runScenario(ch, sc), got = structural ? null : runScenario(ch, sc, { patch: patch });
    return { broken: broken, sc: sc, ref: ref, got: got, structural: !!structural, diff: got ? diff(ref, got) : [], range: [lo, hi] };
  }

  /* ===================== 常卡的地方 =====================
     state = { miss: { askId: n }, wrong: { askId: [assume…] }, step: { stepId: n }, due: { askId: 时间 }, streak: { askId: n } } */
  var DAY = 864e5;
  function recordMiss(st, askId, back, assume, now) {
    st.miss = st.miss || {}; st.step = st.step || {}; st.wrong = st.wrong || {}; st.due = st.due || {}; st.streak = st.streak || {};
    st.miss[askId] = (st.miss[askId] || 0) + 1;
    if (back) st.step[back] = (st.step[back] || 0) + 1;
    if (assume) { var w = st.wrong[askId] = st.wrong[askId] || []; if (w.indexOf(assume) < 0) w.push(assume); if (w.length > 4) w.shift(); }
    st.due[askId] = now || Date.now(); st.streak[askId] = 0;
    return st;
  }
  // 复习时答对：间隔 1、2、4 天……答对两次就从清单里移走
  function recordReview(st, askId, right, now) {
    now = now || Date.now();
    st.miss = st.miss || {}; st.due = st.due || {}; st.streak = st.streak || {};
    if (!st.miss[askId]) return st;
    if (right) {
      var s = st.streak[askId] = (st.streak[askId] || 0) + 1;
      if (s >= 2) { delete st.miss[askId]; delete st.due[askId]; delete st.streak[askId]; if (st.wrong) delete st.wrong[askId]; }
      else st.due[askId] = now + DAY * Math.pow(2, s - 1);
    } else { st.miss[askId]++; st.streak[askId] = 0; st.due[askId] = now; }
    return st;
  }
  // 清单：按「卡住的那一环」聚合，卡得多的排前面；due 到期的标出来
  function stuckList(ch, st, now) {
    now = now || Date.now();
    var asks = allAsks(ch), byStep = {};
    Object.keys((st && st.miss) || {}).forEach(function (id) {
      var a = asks[id]; if (!a) return;
      var home = a.stepId;
      var g = byStep[home] = byStep[home] || { step: home, n: 0, asks: [], due: 0 };
      g.n += st.miss[id]; g.asks.push(id);
      if ((st.due && st.due[id] || 0) <= now) g.due++;
    });
    // 被指回最多的那一环（推理出错的根）也计入
    Object.keys((st && st.step) || {}).forEach(function (s) { if (byStep[s]) byStep[s].root = st.step[s]; });
    return Object.keys(byStep).map(function (k) { return byStep[k]; }).sort(function (a, b) { return b.due - a.due || b.n - a.n; });
  }
  function dueCount(ch, st, now) { return stuckList(ch, st, now).reduce(function (s, g) { return s + g.due; }, 0); }
  function rootCauses(ch, st) {
    return Object.keys((st && st.step) || {}).map(function (s) { return { step: s, n: st.step[s] }; })
      .filter(function (x) { return stepById(ch)[x.step]; }).sort(function (a, b) { return b.n - a.n; });
  }

  /* ===================== 索引与校验 ===================== */
  var cacheS = typeof WeakMap === 'function' ? new WeakMap() : null, cacheA = typeof WeakMap === 'function' ? new WeakMap() : null;
  function stepById(ch) {
    var m = cacheS && cacheS.get(ch);
    if (!m) { m = {}; ch.steps.forEach(function (s, i) { m[s.id] = s; s._i = i; }); if (cacheS) cacheS.set(ch, m); }
    return m;
  }
  function allAsks(ch) {
    var m = cacheA && cacheA.get(ch);
    if (!m) {
      m = {};
      ch.steps.forEach(function (s) { s.beats.forEach(function (b, k) { if (b.k === 'ask') m[b.id] = Object.assign({ stepId: s.id, beat: k }, b); }); });
      if (cacheA) cacheA.set(ch, m);
    }
    return m;
  }
  // 排序题的「项」：普通题用 items；函数题从函数里取行
  function orderItems(ch, ask) {
    if (ask.fn) {
      var fn = ch.fns[ask.fn], sub = ask.lines || fn.lines.map(function (_, i) { return i; }).filter(function (i) { return fn.lines[i].op && fn.lines[i].op.length; });
      return { texts: sub.map(function (i) { return fn.lines[i].c.trim(); }), rules: subRules(fn, sub), sub: sub, fn: fn };
    }
    return { texts: ask.items.map(function (x) { return x.t; }), rules: ask.rules || [] };
  }

  // 行内标记 → 片段
  function inline(s) {
    var out = [], re = /\*\*([^*]+)\*\*|`([^`]+)`|\[\[(s\d+)\]\]|\{(F\d+)\}/g, last = 0, m;
    s = String(s == null ? '' : s);
    while ((m = re.exec(s))) {
      if (m.index > last) out.push({ t: s.slice(last, m.index) });
      if (m[1] != null) out.push({ b: m[1] });
      else if (m[2] != null) out.push({ code: m[2] });
      else if (m[3] != null) out.push({ step: m[3] });
      else out.push({ fact: m[4] });
      last = re.lastIndex;
    }
    if (last < s.length) out.push({ t: s.slice(last) });
    return out;
  }

  // 内容自检：引用都存在、规则下标合法、场景能跑、题目 id 唯一。返回问题列表（空 = 通过）
  function validate(ch) {
    var errs = [], S = stepById(ch), ids = {};
    function refStep(x, where) { if (x && !S[x] && !ch.facts[x]) errs.push(where + ' 引用了不存在的 ' + x); }
    function scanText(t, where) {
      [].concat(t || []).forEach(function (p) {
        inline(p).forEach(function (f) { if (f.step && !S[f.step]) errs.push(where + ' [[' + f.step + ']] 不存在'); if (f.fact && !ch.facts[f.fact]) errs.push(where + ' {' + f.fact + '} 不存在'); });
      });
    }
    ch.steps.forEach(function (s) {
      var w = s.id;
      if (s.from) refStep(s.from, w + '.from');
      (s.makes || []).concat(s.uses || []).forEach(function (f) { if (!ch.facts[f]) errs.push(w + ' 结论 ' + f + ' 不存在'); });
      scanText(s.gist, w + '.gist'); scanText(s.next, w + '.next');
      (s.deep || []).forEach(function (d, k) { scanText(d.a, w + '.deep' + k); });
      s.beats.forEach(function (b, k) {
        var bw = w + '.beat' + k;
        if (b.t) scanText(b.t, bw);
        if (b.k === 'fact' && !ch.facts[b.f]) errs.push(bw + ' 结论 ' + b.f + ' 不存在');
        if (b.k === 'fn' && !ch.fns[b.fn]) errs.push(bw + ' 函数 ' + b.fn + ' 不存在');
        if (b.k === 'w' && b.w === 'sim' && !ch.scenarios[b.sc]) errs.push(bw + ' 场景 ' + b.sc + ' 不存在');
        if (b.k === 'table') b.rows.forEach(function (r) { r.forEach(function (c) { scanText(c, bw + '.table'); }); });
        if (b.k === 'ask') {
          if (!b.id) errs.push(bw + ' 题目没有 id');
          else if (ids[b.id]) errs.push('题目 id 重复：' + b.id); else ids[b.id] = 1;
          scanText(b.q, bw); scanText(b.explain, bw);
          (b.opts || []).forEach(function (o) { if (o.back) refStep(o.back, bw + ' 选项'); scanText(o.counter, bw); });
          if (b.type === 'choice' && !(b.opts || []).some(function (o) { return o.ok; })) errs.push(bw + ' 选择题没有正确答案');
          if (b.type === 'choice') (b.opts || []).forEach(function (o) { if (!o.ok && !(o.assume && o.counter && o.back)) errs.push(bw + ' 错误选项缺 assume / counter / back：' + o.t.slice(0, 16)); });
          if (b.type === 'order') {
            if (b.fn && !ch.fns[b.fn]) errs.push(bw + ' 函数 ' + b.fn + ' 不存在');
            var it = orderItems(ch, b);
            it.rules.forEach(function (r) { if (r.a >= it.texts.length || r.b >= it.texts.length) errs.push(bw + ' 规则下标越界'); if (r.back) refStep(r.back, bw + ' 规则'); });
            if (!checkOrder(it.texts, it.texts.map(function (_, i) { return i; }), it.rules).ok) errs.push(bw + ' 标准顺序违反了自己的规则');
          }
          if (b.type === 'explain' && !(b.points && b.points.length && b.model)) errs.push(bw + ' 解释题缺要点或参考说法');
          if (b.type === 'fill' && !(b.answers && b.answers.length)) errs.push(bw + ' 填空题没有答案');
        }
      });
    });
    Object.keys(ch.fns).forEach(function (name) {
      var fn = ch.fns[name];
      fn.lines.concat(fn.pre || []).forEach(function (ln, k) { (ln.from || []).forEach(function (x) { refStep(x, name + ':' + k); }); if (ln.why) scanText(ln.why, name + ':' + k); });
      (fn.rules || []).forEach(function (r) {
        if (r.a >= fn.lines.length || r.b >= fn.lines.length || r.a >= r.b) errs.push(name + ' 规则 ' + r.a + '<' + r.b + ' 不合法');
        if (r.sc && !ch.scenarios[r.sc]) errs.push(name + ' 规则场景 ' + r.sc + ' 不存在');
        if (r.back) refStep(r.back, name + ' 规则');
      });
    });
    Object.keys(ch.facts).forEach(function (f) { if (!S[ch.facts[f].from]) errs.push('结论 ' + f + ' 的出处 ' + ch.facts[f].from + ' 不存在'); });
    Object.keys(ch.scenarios).forEach(function (k) {
      var sc = ch.scenarios[k];
      if (sc.compare) { sc.compare.forEach(function (x) { if (!ch.scenarios[x]) errs.push('场景 ' + k + ' 比较的 ' + x + ' 不存在'); }); return; }
      var r = runScenario(ch, k); if (r.err) errs.push('场景 ' + k + ' 运行出错：' + r.err);
    });
    return errs;
  }

  return {
    program: program, compile: compile, patchLines: patchLines, runScenario: runScenario, diff: diff,
    checkOrder: checkOrder, subRules: subRules, orderItems: orderItems, orderToPatch: orderToPatch,
    swapCheck: swapCheck, swapOrder: swapOrder,
    recordMiss: recordMiss, recordReview: recordReview, stuckList: stuckList, dueCount: dueCount, rootCauses: rootCauses,
    stepById: stepById, allAsks: allAsks, inline: inline, validate: validate, fmtRet: fmtRet
  };
});
