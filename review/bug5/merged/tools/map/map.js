import * as mgl from '/vendor/maplibre/maplibre-gl.mjs';

const $ = (s) => document.querySelector(s);
const html = document.documentElement;
const embedded = html.classList.contains('embed');
const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- 主题 ---------- */
const mq = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => { const t = ls('lm.theme') || 'light'; return t === 'dark' || (t === 'auto' && mq.matches); };
function applyTheme() { html.dataset.theme = isDark() ? 'dark' : 'light'; }

/* ---------- WGS-84 → GCJ-02（高德图层偏移修正） ---------- */
const PI = Math.PI, A = 6378245.0, EE = 0.00669342162296594323;
const outOfChina = (lat, lng) => lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
function tLat(x, y) { let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3; r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3; return r; }
function tLng(x, y) { let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3; r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3; return r; }
function wgs2gcj(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  let dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
  const rad = lat / 180 * PI; let m = Math.sin(rad); m = 1 - EE * m * m; const s = Math.sqrt(m);
  dLat = (dLat * 180) / ((A * (1 - EE)) / (m * s) * PI); dLng = (dLng * 180) / (A / s * Math.cos(rad) * PI);
  return [lat + dLat, lng + dLng];
}

/* ---------- 底图 ---------- */
const getJSON = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u); return r.json(); });
const [LIGHT, DARK] = await Promise.all([getJSON('styles/liberty-zh.json'), getJSON('styles/dark-zh.json')]);
const AMAP = (style, host = 'wprd') => [1, 2, 3, 4].map((i) => `https://${host}0${i}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=${style}`);   // scl=1：带注记（省会/城市名）；scl=2 是无注记底图
const AMAP_ATTR = '© 高德地图';
const bg = (c) => ({ id: 'bg', type: 'background', paint: { 'background-color': c } });
const fade = { 'raster-fade-duration': 250 };

// 卫星图上叠加中文矢量注记
function satLabels() {
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
    version: 8, glyphs: LIGHT.glyphs,
    sources: { amap: { type: 'raster', tiles: AMAP(7), tileSize: 256, maxzoom: 18, attribution: AMAP_ATTR } },
    layers: [bg('#f4f3ef'), { id: 'amap', type: 'raster', source: 'amap', paint: { ...fade, ...(isDark() ? { 'raster-brightness-max': 0.82, 'raster-saturation': -0.2 } : {}) } }] }) },
  sat: { gcj: false, style: () => ({
    version: 8, glyphs: LIGHT.glyphs, sprite: LIGHT.sprite,
    sources: {
      esri: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 128, maxzoom: 19, attribution: '© Esri' },
      openmaptiles: LIGHT.sources.openmaptiles
    },
    layers: [bg('#0b1a2a'), { id: 'esri', type: 'raster', source: 'esri', paint: fade }, ...satLabels()] }) },
  amapSat: { gcj: true, style: () => ({
    version: 8, glyphs: LIGHT.glyphs,
    sources: {
      s: { type: 'raster', tiles: [1, 2, 3, 4].map((i) => `https://webst0${i}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}`), tileSize: 128, maxzoom: 18, attribution: AMAP_ATTR },
      l: { type: 'raster', tiles: [1, 2, 3, 4].map((i) => `https://wprd0${i}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=8`), tileSize: 256, maxzoom: 18 }
    },
    layers: [bg('#0b1a2a'), { id: 's', type: 'raster', source: 's', paint: fade }, { id: 'l', type: 'raster', source: 'l', paint: fade }] }) }
};
const NAMES = { vector: '矢量', amap: '高德', sat: '卫星', amapSat: '高德卫星' };

/* 一次性迁移：旧版自动回退会把 wm.layer2 永久存成 amap（当时还是无注记的高德），这里清掉，恢复默认矢量 */
if (!ls('wm.layerMig1')) { if (ls('wm.layer2') === 'amap') ls('wm.layer2', 'vector'); ls('wm.layerMig1', '1'); }
let curKey = LAYERS[ls('wm.layer2')] ? ls('wm.layer2') : 'vector';
let gcj = LAYERS[curKey].gcj;

const map = new mgl.Map({
  container: 'map', style: LAYERS[curKey].style(), center: [105, 33], zoom: 1.6, minZoom: 0.8, maxZoom: 19,
  attributionControl: false, pitchWithRotate: false, touchPitch: false, dragRotate: true, fadeDuration: 250,
  localIdeographFontFamily: '"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei",sans-serif',
  maxPitch: 0, cooperativeGestures: false
});
window.__map = map;
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
  if (map.getZoom() >= 6) return setSel(null);
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
    map.once('render', () => {
      done = true;
      try {
        const src = map.getCanvas(), k = Math.min(1, 1.5 / (window.devicePixelRatio || 1));
        const c = document.createElement('canvas'); c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        const img = new Image(); img.src = c.toDataURL('image/jpeg', 0.75);
        (img.decode ? img.decode() : Promise.resolve()).then(() => res(img), () => res(null));
      } catch (e) { res(null); }
    });
    map.triggerRepaint(); setTimeout(() => { if (!done) res(null); }, 300);
  });
}
async function setLayer(key, quiet, persist = true) {   // persist=false：临时切换（自动回退、主题重绘），不写入用户选择
  if (key === curKey && !quiet) return;
  const snap = $('#snap');
  if (!reduce) { const img = await snapshot(); if (img) { snap.replaceChildren(img); snap.classList.add('on'); } }
  curKey = key; gcj = LAYERS[key].gcj;
  map.setStyle(LAYERS[key].style(), { diff: false });
  points.forEach(place);
  document.querySelectorAll('.opt').forEach((b) => b.classList.toggle('on', b.dataset.layer === key));
  if (persist) ls('wm.layer2', key);
  const reveal = () => { snap.classList.remove('on'); };
  map.once('idle', reveal); setTimeout(reveal, 1800);
  if (!quiet) toast(NAMES[key]);
  watchVector();
}
document.querySelectorAll('.opt').forEach((b) => {
  b.classList.toggle('on', b.dataset.layer === curKey);
  b.addEventListener('click', () => { setTimeout(closeSheet, 200); setLayer(b.dataset.layer); });
});

/* 矢量底图在国内若完全加载不到，临时切到高德（不保存选择，图层面板仍可切回矢量）：
   只要有任意一块 openmaptiles 瓦片加载到，就取消回退；10 秒内一块都没有才切；
   出错只在尚未加载到任何瓦片时计数，约 8 次才切 */
const VEC_WAIT = 10000, VEC_MAX_ERR = 8;
let vecErr = 0, vecTimer = null, vecGotTile = false;
function watchVector() {
  clearTimeout(vecTimer); vecErr = 0; vecGotTile = false;
  if (curKey !== 'vector') return;
  vecTimer = setTimeout(() => { if (curKey === 'vector' && !vecGotTile) fallback(); }, VEC_WAIT);
}
function fallback() {
  clearTimeout(vecTimer);
  if (curKey !== 'vector' || vecGotTile) return;
  setLayer('amap', true, false);
  toast('矢量图加载失败，已临时切换到高德');
}
map.on('error', (e) => {
  if (curKey !== 'vector' || vecGotTile) return;
  const src = e.sourceId || (e.source && e.source.id);
  if (src === 'openmaptiles' || /openfreemap/.test(String(e.error && e.error.message))) { if (++vecErr >= VEC_MAX_ERR) fallback(); }
});
map.on('sourcedata', (e) => {
  if (e.sourceId === 'openmaptiles' && e.tile) { vecGotTile = true; clearTimeout(vecTimer); }
});
watchVector();

/* 主题变化（工具箱切换或系统切换） */
function onTheme() { const was = html.dataset.theme; applyTheme(); if (was !== html.dataset.theme && (curKey === 'vector' || curKey === 'amap')) setLayer(curKey, true, false); }
window.addEventListener('storage', (e) => { if (e.key === 'lm.theme') onTheme(); });
window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.type === 'theme') onTheme(); });
mq.addEventListener && mq.addEventListener('change', onTheme);

/* ---------- 面板 ---------- */
const openSheet = () => { document.body.classList.add('sheet'); $('#sheet').setAttribute('aria-hidden', 'false'); };
const closeSheet = () => { document.body.classList.remove('sheet'); $('#sheet').setAttribute('aria-hidden', 'true'); };
$('#layersBtn').addEventListener('click', openSheet);
$('#scrim').addEventListener('click', closeSheet);
(() => {
  let y0 = null; const s = $('#sheet');
  s.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  s.addEventListener('touchmove', (e) => { if (y0 === null) return; const d = e.touches[0].clientY - y0; if (d > 0) { s.style.transition = 'none'; s.style.transform = `translateY(${d}px)`; } }, { passive: true });
  s.addEventListener('touchend', (e) => { if (y0 === null) return; const d = e.changedTouches[0].clientY - y0; y0 = null; s.style.transition = ''; s.style.transform = ''; if (d > 60) closeSheet(); });
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
  btn.classList.add('wait');
  navigator.geolocation.getCurrentPosition((pos) => {
    btn.classList.remove('wait'); btn.classList.add('on');
    const { latitude: lat, longitude: lng } = pos.coords;
    if (!me) { me = { m: new mgl.Marker({ element: markerEl('me') }).setLngLat([lng, lat]).addTo(map) }; points.push(me); }
    me.lat = lat; me.lng = lng;
    map.flyTo({ center: place(me), zoom: Math.max(map.getZoom(), 15), duration: reduce ? 0 : 1800, essential: true });
  }, (err) => { btn.classList.remove('wait'); toast(err.code === 1 ? '未获得定位权限' : '定位失败'); },
  { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
});
map.on('dragstart', () => $('#locate').classList.remove('on'));

/* ---------- 搜索 ---------- */
const q = $('#q'), res = $('#results'), form = $('#search');
let pin = null, ctl = null, countryData = null;
fetch('/data/countries.json').then((r) => r.json()).then((d) => { countryData = d.features; }).catch(() => {});
q.addEventListener('input', () => { $('#clear').hidden = !q.value; if (!q.value) hideRes(); });
$('#clear').addEventListener('click', () => { q.value = ''; $('#clear').hidden = true; hideRes(); q.focus(); });
function hideRes() { res.hidden = true; res.innerHTML = ''; }
function bboxOf(geom) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c) => { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
  walk(geom.coordinates); return [w, s, e, n];
}
function localMatch(str) {
  if (!countryData) return [];
  const s = str.toLowerCase();
  return countryData.filter((f) => f.properties.zh.includes(s) || f.properties.en.toLowerCase().includes(s)).slice(0, 6).map((f) => {
    const b = bboxOf(f.geometry); return { name: f.properties.zh, sub: f.properties.en, lat: (b[1] + b[3]) / 2, lng: (b[0] + b[2]) / 2, bbox: b, country: true };
  });
}
function show(items, note) {
  res.innerHTML = ''; res.hidden = false;
  if (!items.length) { res.innerHTML = `<li class="empty">${note || '没有找到'}</li>`; return; }
  items.forEach((it, i) => {
    const li = document.createElement('li'); li.style.animationDelay = i * 35 + 'ms';
    li.innerHTML = `<b>${esc(it.name)}</b><small>${esc(it.sub)}</small>`;
    li.addEventListener('click', () => go(it)); res.appendChild(li);
  });
}
function go(it) {
  hideRes(); q.blur(); q.value = it.name; $('#clear').hidden = false;
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
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const s = q.value.trim(); if (!s) return;
  if (ctl) ctl.abort(); ctl = new AbortController();
  form.classList.add('busy');
  const timer = setTimeout(() => ctl.abort(), 8000);
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=zh-CN,zh,en&q=' + encodeURIComponent(s);
  fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } })
    .then((r) => { if (!r.ok) throw 0; return r.json(); })
    .then((data) => {
      let items = data.map((d) => {
        const parts = (d.display_name || '').split(/,\s*/), b = d.boundingbox;
        return { name: d.name || parts[0], sub: parts.slice(1).join(', '), lat: +d.lat, lng: +d.lon, bbox: b ? [+b[2], +b[0], +b[3], +b[1]] : null };
      });
      if (!items.length) items = localMatch(s);
      show(items);
    })
    .catch(() => show(localMatch(s), '搜索服务暂不可用'))
    .finally(() => { clearTimeout(timer); form.classList.remove('busy'); });
});

/* ---------- 返回（独立打开时） ---------- */
$('#home').addEventListener('click', (e) => { if (history.length > 1 && document.referrer.startsWith(location.origin)) { e.preventDefault(); history.back(); } });

/* ---------- 就绪 ---------- */
let readySent = false;
function ready() {
  if (readySent) return; readySent = true;
  if (embedded) try { parent.postMessage({ type: 'ready' }, location.origin); } catch (e) {}
  if (!reduce) setTimeout(() => map.flyTo({ center: [108, 33], zoom: 3, duration: 2200, essential: true }), 250);
}
map.once('idle', ready); setTimeout(ready, 4000);
