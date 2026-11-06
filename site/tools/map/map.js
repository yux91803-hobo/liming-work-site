import * as mgl from '/vendor/maplibre/maplibre-gl.mjs';
import { wgs2gcj, gcj2wgs, outOfChina, bboxOf, searchItems } from './geo.mjs';

const $ = (s) => document.querySelector(s);
const html = document.documentElement;
const embedded = html.classList.contains('embed');
const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- 主题 ---------- */
const mq = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => { const t = ls('lm.theme') || 'light'; return t === 'dark' || (t === 'auto' && mq.matches); };
function applyTheme() {
  html.dataset.theme = isDark() ? 'dark' : 'light';
  $('meta[name="theme-color"]').content = isDark() ? '#0d1117' : '#f5f6f8';
}
applyTheme();

/* ---------- 底图 ---------- */
const getJSON = (u) => fetch(u, { signal: AbortSignal.timeout(8000) }).then((r) => { if (!r.ok) throw new Error(u); return r.json(); });
const getStyle = async (u) => {
  const s = await getJSON(u);
  if (!s || s.version !== 8 || !Array.isArray(s.layers) || !s.sources) throw new Error('invalid map style');
  return s;
};
const styles = await Promise.allSettled([getStyle('styles/liberty-zh.json'), getStyle('styles/dark-zh.json?v=20261106')]);
const LIGHT = styles[0].value || styles[1].value, DARK = styles[1].value || LIGHT;
const AMAP = (style, host = 'wprd') => [1, 2, 3, 4].map((i) => `https://${host}0${i}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=${style}`);   // scl=1：带注记（省会/城市名）；scl=2 是无注记底图
const AMAP_ATTR = '© 高德地图';
const bg = (c) => ({ id: 'bg', type: 'background', paint: { 'background-color': c } });
const fade = { 'raster-fade-duration': 250 };

// 卫星图上叠加中文矢量注记
function satLabels() {
  if (!LIGHT) return [];
  const keep = /^(label_|water_name|highway-name-major|airport)/;
  return LIGHT.layers.filter((l) => l.type === 'symbol' && keep.test(l.id)).map((l) => {
    const c = structuredClone(l);
    c.paint = Object.assign({}, c.paint, { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,.65)', 'text-halo-width': 1.4 });
    return c;
  });
}

const LAYERS = {
  vector: { gcj: false, style: () => (isDark() ? DARK : LIGHT) },
  amap: { gcj: true, style: () => ({
    version: 8,
    sources: { amap: { type: 'raster', tiles: AMAP(7), tileSize: 256, maxzoom: 18, attribution: AMAP_ATTR } },
    layers: [bg('#f4f3ef'), { id: 'amap', type: 'raster', source: 'amap', paint: { ...fade, ...(isDark() ? { 'raster-brightness-max': 0.82, 'raster-saturation': -0.2 } : {}) } }] }) },
  sat: { gcj: false, style: () => ({
    version: 8, ...(LIGHT && LIGHT.glyphs ? { glyphs: LIGHT.glyphs } : {}), ...(LIGHT && LIGHT.sprite ? { sprite: LIGHT.sprite } : {}),
    sources: {
      esri: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 128, maxzoom: 19, attribution: '© Esri' },
      ...(LIGHT && LIGHT.sources.openmaptiles ? { openmaptiles: LIGHT.sources.openmaptiles } : {})
    },
    layers: [bg('#0b1a2a'), { id: 'esri', type: 'raster', source: 'esri', paint: fade }, ...satLabels()] }) },
  amapSat: { gcj: true, style: () => ({
    version: 8,
    sources: {
      s: { type: 'raster', tiles: [1, 2, 3, 4].map((i) => `https://webst0${i}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}`), tileSize: 128, maxzoom: 18, attribution: AMAP_ATTR },
      l: { type: 'raster', tiles: [1, 2, 3, 4].map((i) => `https://wprd0${i}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=8`), tileSize: 256, maxzoom: 18 }
    },
    layers: [bg('#0b1a2a'), { id: 's', type: 'raster', source: 's', paint: fade }, { id: 'l', type: 'raster', source: 'l', paint: fade }] }) }
};
const NAMES = { vector: '矢量', amap: '高德', sat: '卫星', amapSat: '高德卫星' };

/* 一次性迁移：旧版自动回退会把 wm.layer2 永久存成 amap（当时还是无注记的高德），这里清掉，恢复默认矢量 */
if (!ls('wm.layerMig1')) { if (ls('wm.layer2') === 'amap') ls('wm.layer2', 'vector'); ls('wm.layerMig1', '1'); }
let curKey = Object.hasOwn(LAYERS, ls('wm.layer2')) ? ls('wm.layer2') : 'vector';
const styleFallback = curKey === 'vector' && !LIGHT;
if (styleFallback) curKey = 'amap';
let gcj = LAYERS[curKey].gcj;

const map = new mgl.Map({
  container: 'map', style: LAYERS[curKey].style(), center: [105, 33], zoom: 1.6, minZoom: 0.8, maxZoom: 19,
  attributionControl: false, pitchWithRotate: false, touchPitch: false, dragRotate: true, fadeDuration: 250,
  localIdeographFontFamily: '"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei",sans-serif',
  maxPitch: 0, cooperativeGestures: false
});
window.__map = map;
let viewTouched = document.activeElement === $('#q') || !!$('#q').value, introTimer = 0, introRunning = false;
function useMap() {
  viewTouched = true; clearTimeout(introTimer);
  if (introRunning) { introRunning = false; map.stop(); }
}
document.addEventListener('pointerdown', useMap, { capture: true, passive: true });
document.addEventListener('keydown', useMap, true);
map.on('movestart', (e) => { if (e.originalEvent) useMap(); });
map.addControl(new mgl.AttributionControl({ compact: true }), 'bottom-right');
map.addControl(new mgl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');

/* ---------- 国家点选 ---------- */
let selected = null, popup = null;
function firstSymbol() { const l = map.getStyle().layers.find((x) => x.type === 'symbol'); return l && l.id; }
function addOverlays() {
  if (!map.getSource('countries')) map.addSource('countries', { type: 'geojson', data: '/data/countries.json' });
  const before = firstSymbol();
  const f = ['==', ['get', 'en'], selected || ''];
  map.addLayer({ id: 'country-hit', type: 'fill', source: 'countries', maxzoom: 6, paint: { 'fill-color': '#000', 'fill-opacity': 0 } }, before);
  map.addLayer({ id: 'country-hl', type: 'fill', source: 'countries', filter: f, paint: { 'fill-color': '#2f6bff', 'fill-opacity': 0.14 } }, before);
  map.addLayer({ id: 'country-hl-line', type: 'line', source: 'countries', filter: f, paint: { 'line-color': '#2f6bff', 'line-width': 1.6, 'line-opacity': 0.85 } }, before);
}
function setSel(en) {
  selected = en; const f = ['==', ['get', 'en'], en || ''];
  if (map.getLayer('country-hl')) { map.setFilter('country-hl', f); map.setFilter('country-hl-line', f); }
}
map.on('style.load', () => { addOverlays(); });
map.on('click', (e) => {
  $('#q').blur(); hideRes();
  if (popup) { popup.remove(); popup = null; }
  if (map.getZoom() >= 6 || !map.getLayer('country-hit')) return setSel(null);
  const f = map.queryRenderedFeatures(e.point, { layers: ['country-hit'] })[0];
  if (!f) return setSel(null);
  setSel(f.properties.en);
  popup = new mgl.Popup({ closeButton: false, className: 'cpop', offset: 10, maxWidth: '240px' })
    .setLngLat(e.lngLat).setHTML(`<b>${esc(f.properties.zh)}</b><small>${esc(f.properties.en)}</small>`).addTo(map);
  popup.on('close', () => setSel(null));
});

/* ---------- 标记 ---------- */
const points = [];
const disp = (lat, lng) => (gcj ? wgs2gcj(lat, lng) : [lat, lng]);
function place(p) { const [la, ln] = disp(p.lat, p.lng); p.m.setLngLat([ln, la]); return [ln, la]; }
function markerEl(cls) { const el = document.createElement('div'); el.className = cls; el.innerHTML = '<i></i>'; return el; }

/* ---------- 切换底图（截图交叉淡化，避免闪白） ---------- */
// 截图：缩到 ≤1.5x 再编码，并在显示前 decode()，否则 iPhone 上 3x 大图来不及解码，切换时会露出半张/空白（撕裂感）
function snapshot() {
  return new Promise((res) => {
    let done = false;
    const finish = (img) => {
      if (done) return;
      done = true; clearTimeout(timer); map.off('render', capture); res(img);
    };
    const capture = () => {
      try {
        const src = map.getCanvas(), k = Math.min(1, 1.5 / (window.devicePixelRatio || 1));
        const c = document.createElement('canvas'); c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        const img = new Image(); img.src = c.toDataURL('image/jpeg', 0.75);
        (img.decode ? img.decode() : Promise.resolve()).then(() => finish(img), () => finish(null));
      } catch (e) { finish(null); }
    };
    const timer = setTimeout(() => finish(null), 300);
    map.once('render', capture); map.triggerRepaint();
  });
}
let layerChange = 0, revealTimer = 0, revealHandler = null, requestedKey = curKey, renderedTheme = html.dataset.theme;
async function setLayer(key, quiet, persist = true) {   // persist=false：临时切换（自动回退、主题重绘），不写入用户选择
  if (!Object.hasOwn(LAYERS, key)) return;
  if (key === 'vector' && !LIGHT) { toast('矢量样式暂不可用，请稍后重试'); return; }
  requestedKey = key;
  if (persist) ls('wm.layer2', key);
  const change = ++layerChange;
  const snap = $('#snap');
  clearTimeout(revealTimer);
  if (revealHandler) { map.off('idle', revealHandler); revealHandler = null; }
  const themeChanged = (key === 'vector' || key === 'amap') && renderedTheme !== html.dataset.theme;
  if (key === curKey && !quiet && !themeChanged) {
    snap.classList.remove('on'); if (vecFallback) watchVector(); return;
  }
  if (!reduce) {
    const img = await snapshot();
    if (change !== layerChange) return;
    if (img) { snap.replaceChildren(img); snap.classList.add('on'); }
  }
  const center = map.getCenter(), nextGCJ = LAYERS[key].gcj;
  if (gcj !== nextGCJ) {
    const baseLng = ((center.lng + 180) % 360 + 360) % 360 - 180;
    const [lat, lng] = gcj ? gcj2wgs(center.lat, baseLng) : wgs2gcj(center.lat, baseLng);
    map.jumpTo({ center: [lng + center.lng - baseLng, lat] });
  }
  curKey = key; gcj = LAYERS[key].gcj;
  map.setStyle(LAYERS[key].style(), { diff: false });
  renderedTheme = html.dataset.theme;
  points.forEach(place);
  document.querySelectorAll('.opt').forEach((b) => b.classList.toggle('on', b.dataset.layer === key));
  const reveal = () => {
    if (change !== layerChange) return;
    snap.classList.remove('on'); clearTimeout(revealTimer);
    map.off('idle', reveal); revealHandler = null;
  };
  revealHandler = reveal; map.on('idle', reveal); revealTimer = setTimeout(reveal, 1800);
  if (!quiet) toast(NAMES[key]);
  watchVector();
}
document.querySelectorAll('.opt').forEach((b) => {
  b.classList.toggle('on', b.dataset.layer === curKey);
  b.addEventListener('click', () => { closeSheet(); setLayer(b.dataset.layer); });
});

/* 矢量底图在国内若完全加载不到，临时切到高德（不保存选择，图层面板仍可切回矢量）：
   只要有任意一块 openmaptiles 瓦片加载到，就取消回退；10 秒内一块都没有才切；
   出错只在尚未加载到任何瓦片时计数，约 8 次才切 */
const VEC_WAIT = 10000, VEC_MAX_ERR = 8;
let vecErr = 0, vecTimer = null, vecGotTile = false, vecFallback = false;
function watchVector() {
  clearTimeout(vecTimer); vecErr = 0; vecGotTile = false; vecFallback = false;
  if (curKey !== 'vector') return;
  vecTimer = setTimeout(() => { if (curKey === 'vector' && !vecGotTile) fallback(); }, VEC_WAIT);
}
function fallback() {
  clearTimeout(vecTimer);
  if (curKey !== 'vector' || vecGotTile || vecFallback) return;
  vecFallback = true;
  setLayer('amap', true, false);
  toast('矢量图加载失败，已临时切换到高德');
}
map.on('error', (e) => {
  if (curKey !== 'vector' || vecGotTile) return;
  const src = e.sourceId || (e.source && e.source.id);
  if (src === 'openmaptiles' || /openfreemap/.test(String(e.error && e.error.message))) { if (++vecErr >= VEC_MAX_ERR) fallback(); }
});
map.on('sourcedata', (e) => {
  if (curKey === 'vector' && e.sourceId === 'openmaptiles' && e.tile && e.tile.state === 'loaded') {
    vecGotTile = true; clearTimeout(vecTimer);
  }
});
watchVector();

/* 主题变化（工具箱切换或系统切换） */
function onTheme() { const was = html.dataset.theme; applyTheme(); if (was !== html.dataset.theme && (requestedKey === 'vector' || requestedKey === 'amap')) setLayer(requestedKey, true, false); }
window.addEventListener('storage', (e) => { if (e.key === 'lm.theme') onTheme(); });
window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.type === 'theme') onTheme(); });
mq.addEventListener && mq.addEventListener('change', onTheme);

/* ---------- 面板 ---------- */
const sheet = $('#sheet'), layersBtn = $('#layersBtn');
const sheetBackground = ['#map', '#tools', '#top', '#home'].map($);
const openSheet = () => {
  hideRes(); document.body.classList.add('sheet'); sheet.inert = false; sheet.setAttribute('aria-hidden', 'false');
  layersBtn.setAttribute('aria-expanded', 'true'); sheetBackground.forEach(el => { el.inert = true; });
  (sheet.querySelector('.opt.on') || sheet.querySelector('.opt')).focus({ preventScroll: true });
};
const closeSheet = () => {
  if (!document.body.classList.contains('sheet')) return;
  document.body.classList.remove('sheet'); sheetBackground.forEach(el => { el.inert = false; });
  layersBtn.setAttribute('aria-expanded', 'false'); layersBtn.focus({ preventScroll: true });
  sheet.inert = true; sheet.setAttribute('aria-hidden', 'true');
};
$('#layersBtn').addEventListener('click', openSheet);
$('#scrim').addEventListener('click', closeSheet);
sheet.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet(); }
  if (e.key === 'Tab') {
    const opts = [...sheet.querySelectorAll('.opt')], i = opts.indexOf(document.activeElement);
    e.preventDefault(); opts[(i + (e.shiftKey ? -1 : 1) + opts.length) % opts.length].focus();
  }
});
(() => {
  let y0 = null; const s = $('#sheet');
  s.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  s.addEventListener('touchmove', (e) => { if (y0 === null) return; const d = e.touches[0].clientY - y0; if (d > 0) { s.style.transition = 'none'; s.style.transform = `translateY(${d}px)`; } }, { passive: true });
  s.addEventListener('touchend', (e) => { if (y0 === null) return; const d = e.changedTouches[0].clientY - y0; y0 = null; s.style.transition = ''; s.style.transform = ''; if (d > 60) closeSheet(); });
  s.addEventListener('touchcancel', () => { y0 = null; s.style.transition = ''; s.style.transform = ''; });
})();

/* ---------- 提示 ---------- */
let tt;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 1700); }

/* ---------- 缩放 / 指北 ---------- */
$('#zin').addEventListener('click', () => map.zoomIn({ duration: 350 }));
$('#zout').addEventListener('click', () => map.zoomOut({ duration: 350 }));
const compass = $('#compass'), needle = $('#needle');
map.on('rotate', () => { const b = map.getBearing(); compass.hidden = Math.abs(b) < 0.5; needle.style.transform = `rotate(${-b}deg)`; });
compass.addEventListener('click', () => map.easeTo({ bearing: 0, duration: 500 }));

/* ---------- 定位 ---------- */
let me = null;
$('#locate').addEventListener('click', function () {
  const btn = this;
  if (!navigator.geolocation) return toast('设备不支持定位');
  if (btn.classList.contains('wait')) return;
  hideRes(); q.blur(); btn.classList.add('wait'); btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  const stopWaiting = () => { btn.classList.remove('wait'); btn.disabled = false; btn.removeAttribute('aria-busy'); };
  navigator.geolocation.getCurrentPosition((pos) => {
    stopWaiting(); btn.classList.add('on');
    const { latitude: lat, longitude: lng } = pos.coords;
    if (!me) { me = { m: new mgl.Marker({ element: markerEl('me') }).setLngLat([lng, lat]).addTo(map) }; points.push(me); }
    me.lat = lat; me.lng = lng;
    map.flyTo({ center: place(me), zoom: Math.max(map.getZoom(), 15), duration: reduce ? 0 : 1800, essential: true });
  }, (err) => { stopWaiting(); toast(err.code === 1 ? '未获得定位权限' : err.code === 3 ? '定位超时，请重试' : '定位失败'); },
  { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
});
map.on('dragstart', () => $('#locate').classList.remove('on'));

/* ---------- 搜索 ---------- */
const q = $('#q'), res = $('#results'), form = $('#search');
let pin = null, ctl = null, countryData = null, searchId = 0;
const countriesReady = getJSON('/data/countries.json').then((d) => { countryData = d.features; }).catch(() => {});
q.addEventListener('input', () => { $('#clear').hidden = !q.value; hideRes(); });
$('#clear').addEventListener('click', () => { q.value = ''; $('#clear').hidden = true; hideRes(); q.focus(); });
function hideRes() {
  ++searchId;
  if (ctl) { ctl.abort(); ctl = null; }
  form.classList.remove('busy'); form.removeAttribute('aria-busy');
  res.hidden = true; res.replaceChildren(); q.setAttribute('aria-expanded', 'false');
}
document.addEventListener('pointerdown', (e) => { if (!$('#top').contains(e.target)) hideRes(); });
function localMatch(str) {
  if (!countryData) return [];
  const s = str.toLowerCase();
  return countryData.filter((f) => f.properties.zh.includes(s) || f.properties.en.toLowerCase().includes(s)).slice(0, 6).map((f) => {
    const b = bboxOf(f.geometry); return { name: f.properties.zh, sub: f.properties.en, lat: (b[1] + b[3]) / 2, lng: (b[0] + b[2]) / 2, bbox: b, country: true };
  });
}
function show(items, note) {
  res.replaceChildren(); res.hidden = false; q.setAttribute('aria-expanded', 'true');
  if (!items.length) { res.innerHTML = `<li class="empty">${note || '没有找到'}</li>`; return; }
  items.forEach((it, i) => {
    const li = document.createElement('li'), button = document.createElement('button');
    li.style.animationDelay = i * 35 + 'ms'; button.type = 'button';
    button.innerHTML = `<b>${esc(it.name)}</b><small>${esc(it.sub)}</small>`;
    button.addEventListener('click', () => go(it)); li.appendChild(button); res.appendChild(li);
  });
}
$('#top').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideRes(); q.focus(); }
  if (!res.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    const buttons = [...res.querySelectorAll('button')]; if (!buttons.length) return;
    const i = buttons.indexOf(document.activeElement);
    const next = i < 0 ? (e.key === 'ArrowDown' ? 0 : buttons.length - 1) : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    e.preventDefault(); buttons[next].focus();
  }
});
function go(it) {
  useMap(); hideRes(); q.blur(); q.value = it.name; $('#clear').hidden = false; setSel(null);
  if (popup) { popup.remove(); popup = null; }
  if (pin) pin.m.remove(); else { pin = {}; points.push(pin); }
  pin.m = new mgl.Marker({ element: markerEl('pin'), anchor: 'bottom' });
  pin.lat = it.lat; pin.lng = it.lng;
  const c = place(pin); pin.m.addTo(map);
  const abroad = gcj && outOfChina(it.lat, it.lng), mz = abroad ? 10 : 17;
  if (abroad) setTimeout(() => toast('海外详情可切换「矢量」图层'), 1900);
  const dur = reduce ? 0 : 1800, pad = { top: 110, bottom: 70, left: 40, right: 80 };
  let big = false;
  if (it.bbox && !it.country) {
    const [w, s, e, n] = it.bbox, h = n - s, wd = e - w;
    big = (h > 4 || wd > 4) && (Math.abs((s + n) / 2 - it.lat) > h / 4 || Math.abs((w + e) / 2 - it.lng) > wd / 4);
  }
  if (!it.bbox || big) return map.flyTo({ center: c, zoom: Math.min(big ? 8 : 13, mz), duration: dur, essential: true });
  const [w, s, e, n] = it.bbox, sw = disp(s, w), ne = disp(n, e);
  map.fitBounds([[sw[1], sw[0]], [ne[1], ne[0]]], { padding: pad, maxZoom: mz, duration: dur, essential: true });
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideRes();
  const s = q.value.trim(); if (!s) return;
  const id = searchId, controller = new AbortController(); ctl = controller;
  const current = () => id === searchId && q.value.trim() === s;
  form.classList.add('busy'); form.setAttribute('aria-busy', 'true');
  const timer = setTimeout(() => controller.abort(), 8000);
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=zh-CN,zh,en&q=' + encodeURIComponent(s);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('search unavailable');
    let items = searchItems(await response.json());
    if (!items.length) { await countriesReady; items = localMatch(s); }
    if (current()) show(items);
  } catch {
    if (current()) { await countriesReady; if (current()) show(localMatch(s), '搜索服务暂不可用'); }
  } finally {
    clearTimeout(timer);
    if (current()) { ctl = null; form.classList.remove('busy'); form.removeAttribute('aria-busy'); }
  }
});

/* ---------- 返回（独立打开时） ---------- */
$('#home').addEventListener('click', (e) => { if (history.length > 1 && document.referrer.startsWith(location.origin)) { e.preventDefault(); history.back(); } });

/* ---------- 就绪 ---------- */
let readySent = false;
function ready() {
  if (readySent) return; readySent = true;
  if (embedded) try { parent.postMessage({ type: 'ready' }, location.origin); } catch (e) {}
  if (!reduce && !viewTouched) introTimer = setTimeout(() => {
    if (viewTouched) return;
    introRunning = true; map.once('moveend', () => { introRunning = false; });
    map.flyTo({ center: [108, 33], zoom: 3, duration: 2200 });
  }, 250);
}
map.once('idle', ready); setTimeout(ready, 4000);
if (styleFallback) toast('矢量样式加载失败，已临时切换到高德');
