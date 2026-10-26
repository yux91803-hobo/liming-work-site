// quota-card.js — Hark 额度卡片（原生 JS，无依赖）
// 用法：window.renderQuotaCard(container, items)，items 为 /api/hub/quota 返回的数组
// 安全：数据只经 textContent / 属性写入
(function (root) {
  'use strict';

  var TZ = 'Asia/Shanghai';
  var dtf = null;
  try {
    dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch (e) { dtf = null; }

  // 北京时间 MM-DD HH:mm
  function fmt(v) {
    if (!v || !dtf) return null;
    var d = new Date(v);
    if (isNaN(d.getTime())) return null;
    var p = {};
    dtf.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    if (p.hour === '24') p.hour = '00';
    return p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
  }

  function pct(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    return Math.min(100, Math.max(0, n));
  }
  function show(n) { return (Math.round(n * 10) / 10) + '%'; }

  // <60 绿，60–85 黄，>85 红
  function level(n) { return n > 85 ? 'qc-bad' : n >= 60 ? 'qc-warn' : 'qc-ok'; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  // 兼容 API 驼峰字段和表的蛇形字段
  function pick(it, part) {
    var p = it[part] || {};
    return {
      used: pct(p.usedPct !== undefined ? p.usedPct : (p.used_pct !== undefined ? p.used_pct : it[part + '_used_pct'])),
      reset: p.resetAt !== undefined ? p.resetAt : (p.reset_at !== undefined ? p.reset_at : it[part + '_reset_at'])
    };
  }

  // 一条额度：名称 · 进度条 · 已用% · 重置时间
  function meter(name, m) {
    var box = el('div', 'qc-meter');
    var bar = el('span', 'qc-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', name);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    var fill = el('i', 'qc-fill');
    bar.appendChild(fill);
    var nums = el('span', 'qc-nums');
    var reset = el('span', 'qc-reset');

    if (m.used === null) {
      box.classList.add('qc-unknown');
      nums.textContent = '—';
      bar.setAttribute('aria-valuetext', '未查询');
    } else {
      box.classList.add(level(m.used));
      nums.textContent = show(m.used);
      nums.title = '剩余 ' + show(100 - m.used);
      bar.setAttribute('aria-valuenow', String(m.used));
      bar.setAttribute('aria-valuetext', '已用 ' + show(m.used) + '，剩余 ' + show(100 - m.used));
      fill.style.width = m.used + '%';
    }
    var r = fmt(m.reset);
    reset.textContent = r ? '↻ ' + r : '';
    box.append(el('span', 'qc-meter-name', name), bar, nums, reset);
    return box;
  }

  function row(it) {
    var li = el('li', 'qc-row');
    if (it.active) li.classList.add('qc-active');

    var top = el('div', 'qc-row-h');
    top.appendChild(el('span', 'qc-dot', it.active ? '●' : '○'));
    top.appendChild(el('span', 'qc-label', it.label || it.accountId || it.account_id || '账号'));
    if (it.active) top.appendChild(el('span', 'qc-badge', '当前使用'));

    var d = pick(it, 'daily'), c = pick(it, 'cycle');
    var checkedRaw = it.checkedAt !== undefined ? it.checkedAt : it.checked_at;
    var checked = fmt(checkedRaw);
    if (checked) li.title = '查询于 ' + checked + (it.source ? ' · ' + it.source : '');

    // 从没查询过的账号收成一行
    if (!checked && d.used === null && c.used === null) {
      li.classList.add('qc-row-unknown');
      top.appendChild(el('span', 'qc-unknown-text', '未查询'));
      li.appendChild(top);
      return li;
    }

    var meters = el('div', 'qc-meters');
    meters.append(meter('日', d), meter('周期', c));
    li.append(top, meters);
    return li;
  }

  function renderQuotaCard(container, items) {
    if (!container) return;
    items = Array.isArray(items) ? items : [];
    if (!items.length) { container.replaceChildren(); return null; }

    var card = el('section', 'qc');
    card.setAttribute('aria-label', 'Hark 额度');
    var head = el('header', 'qc-head');
    head.appendChild(el('span', 'qc-title', '额度'));
    var latest = null;
    items.forEach(function (it) {
      var u = it.updatedAt !== undefined ? it.updatedAt : it.updated_at;
      var t = u ? Date.parse(u) : NaN;
      if (!isNaN(t) && (latest === null || t > latest)) latest = t;
    });
    var upd = latest !== null ? fmt(new Date(latest).toISOString()) : null;
    if (upd) head.appendChild(el('span', 'qc-upd', upd));
    card.appendChild(head);

    var list = el('ul', 'qc-list');
    items.forEach(function (it) { list.appendChild(row(it || {})); });
    card.appendChild(list);
    container.replaceChildren(card);
    return card;
  }

  root.renderQuotaCard = renderQuotaCard;
  if (typeof module !== 'undefined' && module.exports) module.exports = { renderQuotaCard: renderQuotaCard };
})(typeof window !== 'undefined' ? window : globalThis);
