/* study-core.js — STM32 学习台的路由白名单与搜索（不碰 DOM，可在 Node 里测试）
   外壳 shell.js 也加载本文件：用 params(fromParams(x)) 清洗 iframe 报上来的定位参数。

   路由（URL 查询参数）：
     v    基础视图 home | topic | board | think（旧的 chip 并进了 home；课件 course 已去掉，打开首页）
     t    外设主题 id（v=topic / v=think）；p 编程思维（旧四段式）的第几段 1~4
     s    编程思维推导章节里的某一环 s1~s99，或 review（常卡的地方）
     reg  寄存器 id，i 实例，n 通道 / 序号，val 计算值（0x 8 位）
     pin  芯片引脚号 1~144，q 引脚筛选词（v=home）
     m    板载模块 id（v=home，打开这个模块的模拟图），mp 模块上的某个脚
     snip 代码片段标题（v=topic，定位到该片段）
     fig  架构图 id；sch 原理图页 id —— 叠在当前页上的查看器（课件 cw 已去掉）
   旧版链接（tab=pins / regs / code / chip / arch / course，page=…）在 fromParams 里换算成新路由。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STM32StudyCore = api;
})(typeof window === 'object' ? window : this, function () {
  'use strict';
  var VIEWS = ['home', 'topic', 'board', 'think'];
  function text(v, n) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, n).trim() : ''; }
  function hex8(v) {
    var s = String(v == null ? '' : v).trim();
    if (!/^(?:0x)?[0-9a-f]{1,8}$/i.test(s)) return '';
    return '0x' + parseInt(s.replace(/^0x/i, ''), 16).toString(16).toUpperCase().padStart(8, '0');
  }

  /* 只保留认识的键和合法的值；顺序固定，同一位置得到同一个地址 */
  function target(input) {
    var x = input && typeof input === 'object' ? input : {}, o = {};
    o.v = x.v === 'chip' ? 'home' : VIEWS.indexOf(x.v) >= 0 ? x.v : 'home';
    if (/^[a-z][a-z0-9]{1,7}$/.test(x.t || '')) o.t = x.t;
    if (o.v === 'topic' && !o.t && !x.reg && !x.snip) o.v = 'home';
    if (o.v !== 'topic' && o.v !== 'think') delete o.t;
    if (o.v === 'think' && o.t && /^[1-4]$/.test(String(x.p == null ? '' : x.p))) o.p = String(x.p);   // 编程思维：第几段
    if (o.v === 'think' && o.t && /^(?:s\d{1,2}|review)$/.test(String(x.s == null ? '' : x.s))) o.s = String(x.s);   // 推导章节：哪一环
    if (/^[A-Za-z][A-Za-z0-9_]{1,31}$/.test(x.reg || '')) {
      o.reg = x.reg;
      if (/^[A-Za-z0-9_]{1,16}$/.test(x.i || '')) o.i = x.i;
      if (/^\d{1,2}$/.test(String(x.n == null ? '' : x.n))) o.n = String(Number(x.n));
      var hv = hex8(x.val); if (hv) o.val = hv;
    }
    if (o.v === 'home') {
      if (/^[a-z][a-z0-9]{1,11}$/.test(x.m || '')) {
        o.m = x.m;
        if (/^[a-z0-9]{1,8}$/.test(x.mp || '')) o.mp = x.mp;
      } else {
        if (/^\d{1,3}$/.test(String(x.pin == null ? '' : x.pin)) && Number(x.pin) >= 1 && Number(x.pin) <= 144) o.pin = String(Number(x.pin));
        if (text(x.q, 60)) o.q = text(x.q, 60);
      }
    }
    if (o.v === 'topic' && text(x.snip, 120)) o.snip = text(x.snip, 120);
    // 查看器：同一时间只有一个
    if (/^[a-zA-Z0-9_-]{1,80}$/.test(x.fig || '')) o.fig = x.fig;
    else if (/^[a-zA-Z0-9_-]{1,80}$/.test(x.sch || '')) o.sch = x.sch;
    return o;
  }
  function params(input) {
    var clean = target(input), sp = new URLSearchParams();
    Object.keys(clean).forEach(function (k) { if (!(k === 'v' && clean.v === 'home')) sp.set(k, clean[k]); });
    return sp.toString();
  }
  /* 旧版参数 → 新路由 */
  function legacy(x) {
    if (!x.tab && !x.page && !(x.reg && !x.v)) return x;
    var o = {};
    if (x.page) { o.v = 'board'; o.sch = x.page; return o; }
    if (x.fig) { o.v = 'home'; o.fig = x.fig; return o; }
    if (x.reg) { o.v = 'topic'; o.reg = String(x.reg).split('.')[0]; if (x.i) o.i = x.i; if (x.v && /^(?:0x)?[0-9a-f]{1,8}$/i.test(x.v)) o.val = x.v; return o; }
    if (x.tab === 'code') { o.v = x.snip ? 'topic' : 'home'; if (x.snip) o.snip = x.snip; return o; }
    if (x.tab === 'chip') { o.v = 'home'; if (x.pin) o.pin = x.pin; return o; }
    if (x.tab === 'pins') { o.v = 'home'; if (x.q) o.q = x.q; return o; }
    if (x.tab === 'regs' || x.tab === 'arch') return { v: 'home' };
    return { v: 'home' };
  }
  function fromParams(search) {
    var sp = new URLSearchParams(String(search || '').replace(/^\?/, '')), x = {};
    sp.forEach(function (v, k) { x[k] = v; });
    return target(legacy(x));
  }
  function same(a, b) { return params(a) === params(b); }

  /* ---------- 搜索 ---------- */
  // 「PA 9」「USART 1」合并成 PA9 / USART1；前后要是词边界，避免把 GPIO_CRL 8 粘成 GPIO_CRL8
  function normalized(s) { return String(s == null ? '' : s).toUpperCase().replace(/　/g, ' ').replace(/(^|[^A-Z0-9_])([A-Z]{1,6})\s+(\d{1,3})(?![A-Z0-9_])/g, '$1$2$3'); }
  // 别名按前缀展开：UART1 → USART1、IIC2 → I2C2、串口1 → USART1；任一写法命中即可
  var aliases = { '串口': ['USART', 'UART'], '按键': ['KEY'], '定时器': ['TIM'], '蜂鸣器': ['BEEP'], '晶振': ['OSC'], '中断': ['EXTI', 'NVIC'],
    '模数': ['ADC'], '时钟': ['RCC'], '看门狗': ['WDG'], 'IIC': ['I2C'], 'I2C': ['IIC'], 'UART': ['USART'], 'USART': ['UART'] };
  var aliasKeys = Object.keys(aliases).sort(function (a, b) { return b.length - a.length; });
  function expand(w) {
    var out = [w];
    aliasKeys.forEach(function (k) {
      if (w.indexOf(k) === 0) aliases[k].forEach(function (v) { var x = v + w.slice(k.length); if (out.indexOf(x) < 0) out.push(x); });
    });
    return out;
  }
  var cache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function prepared(item) {
    var p = cache && cache.get(item);
    if (!p) {
      p = { title: normalized(item.title), hay: normalized(item.title + ' ' + (item.detail || '') + ' ' + (item.words || '')) };
      if (cache) cache.set(item, p);
    }
    return p;
  }
  function has(s, alts) { return alts.some(function (a) { return s.indexOf(a) >= 0; }); }
  // 排序：标题完全相同 > 标题以第一个词开头 > 所有词都在标题里 > 只在说明里；同分按索引顺序
  function search(index, query) {
    var whole = normalized(query).trim(), words = whole.split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var alts = words.map(expand);
    return index.map(function (item, order) {
      var p = prepared(item), score = 0;
      if (alts.every(function (a) { return has(p.hay, a); })) {
        score = p.title === whole ? 100
          : alts[0].some(function (a) { return p.title.indexOf(a) === 0; }) ? 60
          : alts.every(function (a) { return has(p.title, a); }) ? 40 : 10;
      }
      return { item: item, order: order, score: score };
    }).filter(function (r) { return r.score > 0; }).sort(function (a, b) { return b.score - a.score || a.order - b.order; }).map(function (r) { return r.item; });
  }
  return Object.freeze({ VIEWS: VIEWS, target: target, params: params, fromParams: fromParams, same: same, search: search, normalized: normalized });
});
