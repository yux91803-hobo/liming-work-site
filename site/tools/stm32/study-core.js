/* Shared, DOM-free helpers for routes, search and local learning records. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STM32StudyCore = api;
})(typeof window === 'object' ? window : this, function () {
  'use strict';
  var tabs = ['pins', 'regs', 'code', 'chip', 'arch', 'course'];
  function text(v, n) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, n).trim() : ''; }
  function target(input) {
    var x = input && typeof input === 'object' ? input : {}, o = {};
    o.tab = tabs.indexOf(x.tab) >= 0 ? x.tab : 'pins';
    if (/^[a-zA-Z0-9_-]{1,40}-\d{1,4}$/.test(x.cw || '')) { o.tab = 'course'; o.cw = x.cw; }
    else if (/^[a-zA-Z0-9_-]{1,80}$/.test(x.page || '')) { o.tab = 'chip'; o.page = x.page; }
    else if (/^[a-zA-Z0-9_-]{1,80}$/.test(x.fig || '')) { o.tab = 'arch'; o.fig = x.fig; }
    else if (/^[A-Za-z0-9_]{2,32}(\.[A-Za-z0-9_\/]{1,32})?$/.test(x.reg || '')) {
      o.tab = 'regs'; o.reg = x.reg;
      if (/^[A-Za-z0-9_\/]{1,32}$/.test(x.f || '')) o.f = x.f;
      if (/^[A-Za-z0-9_]{1,16}$/.test(x.i || '')) o.i = x.i;
      if (/^\d{1,2}$/.test(String(x.y)) && Number(x.y) <= 31) o.y = String(Number(x.y));
      if (/^(?:0x)?[0-9a-f]{1,8}$/i.test(x.v || '')) o.v = '0x' + parseInt(String(x.v).replace(/^0x/i, ''), 16).toString(16).toUpperCase().padStart(8, '0');
    }
    if (o.reg && /^(?:0x)?[0-9a-f]{1,8}$/i.test(x.m || '')) o.m = '0x' + parseInt(String(x.m).replace(/^0x/i, ''), 16).toString(16).toUpperCase().padStart(8, '0');
    if (o.tab === 'pins' && text(x.q, 100)) o.q = text(x.q, 100);
    if (o.tab === 'chip' && !o.page && /^\d{1,3}$/.test(String(x.pin)) && Number(x.pin) >= 1 && Number(x.pin) <= 144) o.pin = String(Number(x.pin));
    if (o.tab === 'code') {
      if (text(x.cat, 40)) o.cat = text(x.cat, 40);
      if (text(x.snip, 180)) o.snip = text(x.snip, 180);
    }
    return o;
  }
  function params(input) {
    var clean = target(input), sp = new URLSearchParams();
    Object.keys(clean).forEach(function (k) { sp.set(k, clean[k]); });
    return sp.toString();
  }
  function fromParams(search) {
    var sp = new URLSearchParams(String(search || '').replace(/^\?/, '')), x = {};
    sp.forEach(function (v, k) { x[k] = v; });
    return target(x);
  }
  function key(input) { var x = target(input); delete x.v; delete x.m; return params(x); }
  // 「PA 9」「USART 1」合并成 PA9 / USART1；前后要是词边界（与引脚页 parseQuery 一致），避免把 GPIO_CRL 8 这类粘成 GPIO_CRL8
  function normalized(s) { return String(s == null ? '' : s).toUpperCase().replace(/\u3000/g, ' ').replace(/(^|[^A-Z0-9_])([A-Z]{1,6})\s+(\d{1,3})(?![A-Z0-9_])/g, '$1$2$3'); }
  // 别名按「前缀」展开：UART1 → USART1、IIC2 → I2C2、串口1 → USART1；同一个词的任一写法命中即可
  var aliases = { '串口': ['USART', 'UART'], '按键': ['KEY'], '定时器': ['TIM'], '蜂鸣器': ['BEEP'], '晶振': ['OSC'], '中断': ['EXTI', 'NVIC'],
    'IIC': ['I2C'], 'I2C': ['IIC'], 'UART': ['USART'], 'USART': ['UART'] };
  var aliasKeys = Object.keys(aliases).sort(function (a, b) { return b.length - a.length; });
  function expand(w) {
    var out = [w];
    aliasKeys.forEach(function (k) {
      if (w.indexOf(k) === 0) aliases[k].forEach(function (v) { var x = v + w.slice(k.length); if (out.indexOf(x) < 0) out.push(x); });
    });
    return out;
  }
  // 归一化后的标题 / 全文按条目缓存：索引里寄存器带全部字段说明，每次按键都重算很浪费
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
  // 排序：标题完全相同 > 标题以第一个词开头 > 所有词都在标题里 > 只在说明 / 正文里
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
  function record(input) {
    if (!input || typeof input !== 'object' || !input.target || typeof input.target !== 'object') return null;
    var t = target(input.target), title = text(input.title, 180);
    if (!title) return null;
    return { id: key(t), target: t, title: title, starred: input.starred === true,
      status: ['todo', 'practice', 'done'].indexOf(input.status) >= 0 ? input.status : '',
      note: typeof input.note === 'string' ? input.note.replace(/\u0000/g, '').slice(0, 3000) : '',
      updatedAt: Number.isFinite(Number(input.updatedAt)) && Number(input.updatedAt) > 0 ? Number(input.updatedAt) : 0 };
  }
  function records(input) {
    var seen = Object.create(null), out = [];
    (Array.isArray(input) ? input : []).slice(0, 500).forEach(function (x) { var r = record(x); if (r && !seen[r.id]) { seen[r.id] = true; out.push(r); } });
    return out;
  }
  return Object.freeze({ target: target, params: params, fromParams: fromParams, key: key, search: search, record: record, records: records });
});
