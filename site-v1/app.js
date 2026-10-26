(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };

  /* ---------- WGS-84 -> GCJ-02 (高德图层坐标偏移修正) ---------- */
  var PI = Math.PI, A = 6378245.0, EE = 0.00669342162296594323;
  function outOfChina(lat, lng) { return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271; }
  function tLat(x, y) { var r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3; r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
    r += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3; return r; }
  function tLng(x, y) { var r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3; r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
    r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3; return r; }
  function wgs2gcj(lat, lng) {
    if (outOfChina(lat, lng)) return [lat, lng];
    var dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35), rad = lat / 180 * PI, m = Math.sin(rad);
    m = 1 - EE * m * m; var s = Math.sqrt(m);
    dLat = (dLat * 180) / ((A * (1 - EE)) / (m * s) * PI); dLng = (dLng * 180) / (A / s * Math.cos(rad) * PI);
    return [lat + dLat, lng + dLng];
  }

  /* ---------- 图层 ---------- */
  var AMAP_ATTR = '&copy; 高德地图', OSM_ATTR = '&copy; OpenStreetMap';
  var LAYERS = {
    amap: { gcj: true, thumb: 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=6&y=3&z=3',
      make: function () { return L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
        { subdomains: '1234', maxZoom: 18, attribution: AMAP_ATTR }); } },
    sat: { gcj: true, thumb: 'https://webst01.is.autonavi.com/appmaptile?style=6&x=6&y=3&z=3',
      make: function () { return L.layerGroup([
        L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', { subdomains: '1234', maxZoom: 18, attribution: AMAP_ATTR }),
        L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}', { subdomains: '1234', maxZoom: 18 })
      ]); } },
    light: { gcj: false, thumb: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/3/3/6',
      make: function () { var u = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_'; return L.layerGroup([
        L.tileLayer(u + 'Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, maxNativeZoom: 16, attribution: '&copy; Esri' }),
        L.tileLayer(u + 'Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, maxNativeZoom: 16 })
      ]); } },
    osm: { gcj: false, thumb: 'https://tile.openstreetmap.org/3/6/3.png',
      make: function () { return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: OSM_ATTR }); } }
  };

  var map = L.map('map', {
    zoomControl: false, attributionControl: true, worldCopyJump: true, minZoom: 2, maxZoom: 18,
    zoomSnap: 1, zoomDelta: 1, wheelPxPerZoomLevel: 90, tap: false,
    maxBounds: [[-85, -Infinity], [85, Infinity]], maxBoundsViscosity: 0.8
  }).setView([30, 105], 3);
  map.attributionControl.setPrefix(false);
  L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 110 }).addTo(map);

  var cur = null, curKey = null, gcj = false;
  var points = []; // {marker, lat, lng}
  function place(p) { var c = gcj ? wgs2gcj(p.lat, p.lng) : [p.lat, p.lng]; p.marker.setLatLng(c); return c; }
  function disp(lat, lng) { return gcj ? wgs2gcj(lat, lng) : [lat, lng]; }

  function setLayer(key, quiet) {
    if (key === curKey) return;
    var next = LAYERS[key].make();
    next.addTo(map);
    if (next.bringToBack) next.bringToBack(); else next.eachLayer(function (l) { l.bringToBack && l.bringToBack(); });
    var old = cur; cur = next; curKey = key; gcj = LAYERS[key].gcj;
    if (old) setTimeout(function () { map.removeLayer(old); }, 450);
    points.forEach(place);
    document.querySelectorAll('.opt').forEach(function (b) { b.classList.toggle('on', b.dataset.layer === key); });
    try { localStorage.setItem('wm.layer', key); } catch (e) {}
    if (!quiet) toast(document.querySelector('.opt[data-layer="' + key + '"] span:last-child').textContent);
  }
  document.querySelectorAll('.opt').forEach(function (b) {
    var t = LAYERS[b.dataset.layer].thumb; b.querySelector('.thumb').style.backgroundImage = 'url("' + t + '")';
    b.addEventListener('click', function () { setLayer(b.dataset.layer); setTimeout(closeSheet, 220); });
  });
  var saved = null; try { saved = localStorage.getItem('wm.layer'); } catch (e) {}
  setLayer(LAYERS[saved] ? saved : 'amap', true);

  /* ---------- 面板 ---------- */
  function openSheet() { document.body.classList.add('sheet'); $('#sheet').setAttribute('aria-hidden', 'false'); }
  function closeSheet() { document.body.classList.remove('sheet'); $('#sheet').setAttribute('aria-hidden', 'true'); }
  $('#layersBtn').addEventListener('click', openSheet);
  $('#scrim').addEventListener('click', closeSheet);
  (function () { // 下滑关闭
    var y0 = null, s = $('#sheet');
    s.addEventListener('touchstart', function (e) { y0 = e.touches[0].clientY; }, { passive: true });
    s.addEventListener('touchmove', function (e) { if (y0 === null) return; var d = e.touches[0].clientY - y0;
      if (d > 0) { s.style.transition = 'none'; s.style.transform = 'translateY(' + d + 'px)'; } }, { passive: true });
    s.addEventListener('touchend', function (e) { if (y0 === null) return; var d = e.changedTouches[0].clientY - y0; y0 = null;
      s.style.transition = ''; s.style.transform = ''; if (d > 60) closeSheet(); });
  })();

  /* ---------- 提示 ---------- */
  var tt;
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt);
    tt = setTimeout(function () { t.classList.remove('show'); }, 1600); }

  /* ---------- 缩放 ---------- */
  $('#zin').addEventListener('click', function () { map.zoomIn(); });
  $('#zout').addEventListener('click', function () { map.zoomOut(); });

  /* ---------- 定位 ---------- */
  var me = null;
  $('#locate').addEventListener('click', function () {
    var btn = this;
    if (!navigator.geolocation) return toast('设备不支持定位');
    btn.classList.add('wait');
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.classList.remove('wait'); btn.classList.add('on');
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      if (!me) { me = { marker: L.marker([lat, lng], { icon: L.divIcon({ className: 'me', html: '<i></i>', iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(map), lat: lat, lng: lng }; points.push(me); }
      me.lat = lat; me.lng = lng;
      map.flyTo(place(me), Math.max(map.getZoom(), 15), { duration: 1.6 });
    }, function (err) {
      btn.classList.remove('wait');
      toast(err.code === 1 ? '未获得定位权限' : '定位失败');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
  map.on('dragstart', function () { $('#locate').classList.remove('on'); });

  /* ---------- 国家边界 ---------- */
  var countries = null, countryList = [], hi = null;
  var base = { color: '#2f6bff', weight: 0.8, opacity: 0.35, fillColor: '#2f6bff', fillOpacity: 0, className: 'country' };
  fetch('data/countries.json').then(function (r) { return r.json(); }).then(function (gj) {
    countries = L.geoJSON(gj, {
      style: function () { return base; },
      onEachFeature: function (f, layer) {
        countryList.push({ f: f, layer: layer });
        layer.on('click', function (e) {
          if (map.getZoom() >= 7) return; // 放大后不打扰
          if (hi) hi.setStyle(base);
          hi = layer; layer.setStyle({ fillOpacity: 0.12, opacity: 0.9, weight: 1.6 });
          L.popup({ className: 'cpop', closeButton: false, autoPan: false, offset: [0, -4] })
            .setLatLng(e.latlng).setContent('<b>' + esc(f.properties.zh) + '</b><small>' + esc(f.properties.en) + '</small>').openOn(map);
        });
      }
    });
    if ($('#borders').checked) countries.addTo(map);
  }).catch(function () {});
  map.on('popupclose', function () { if (hi) { hi.setStyle(base); hi = null; } });
  $('#borders').addEventListener('change', function () { if (!countries) return; this.checked ? countries.addTo(map) : map.removeLayer(countries); });

  /* ---------- 搜索 ---------- */
  var q = $('#q'), res = $('#results'), form = $('#search'), pin = null, ctl = null;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  q.addEventListener('input', function () { $('#clear').hidden = !q.value; if (!q.value) hideRes(); });
  $('#clear').addEventListener('click', function () { q.value = ''; this.hidden = true; hideRes(); q.focus(); });
  function hideRes() { res.hidden = true; res.innerHTML = ''; }
  function localMatch(s) {
    s = s.toLowerCase();
    return countryList.filter(function (c) { return c.f.properties.zh.indexOf(s) > -1 || c.f.properties.en.toLowerCase().indexOf(s) > -1; })
      .slice(0, 6).map(function (c) { var b = c.layer.getBounds(), ce = b.getCenter();
        return { name: c.f.properties.zh, sub: c.f.properties.en, lat: ce.lat, lng: ce.lng, bounds: b, country: true }; });
  }
  function show(items, note) {
    res.innerHTML = ''; res.hidden = false;
    if (!items.length) { res.innerHTML = '<li class="empty">' + (note || '没有找到') + '</li>'; return; }
    items.forEach(function (it, i) {
      var li = document.createElement('li'); li.style.animationDelay = (i * 0.035) + 's';
      li.innerHTML = '<b>' + esc(it.name) + '</b><small>' + esc(it.sub) + '</small>';
      li.addEventListener('click', function () { go(it); });
      res.appendChild(li);
    });
  }
  function go(it) {
    hideRes(); q.blur(); q.value = it.name; $('#clear').hidden = false;
    if (!pin) { pin = { marker: L.marker([0, 0], { icon: L.divIcon({ className: 'pin', html: '<i></i>', iconSize: [0, 0] }), keyboard: false }).addTo(map) }; points.push(pin); }
    pin.lat = it.lat; pin.lng = it.lng;
    // 重新触发落针动画
    var el = pin.marker.getElement(); if (el) { el.innerHTML = ''; void el.offsetWidth; el.innerHTML = '<i></i>'; }
    var c = place(pin);
    var abroad = gcj && outOfChina(it.lat, it.lng), mz = abroad ? 10 : 16;
    if (abroad) setTimeout(function () { toast('海外详情可切换「简洁」图层'); }, 1900);
    var big = false; // 例如东京都含远洋小岛，边界框过大且偏离中心
    if (it.bounds && it.bounds.isValid() && !it.country) { var bc = it.bounds.getCenter(), h = it.bounds.getNorth() - it.bounds.getSouth(), w = it.bounds.getEast() - it.bounds.getWest();
      big = (h > 4 || w > 4) && (Math.abs(bc.lat - it.lat) > h / 4 || Math.abs(bc.lng - it.lng) > w / 4); }
    if (!it.bounds || !it.bounds.isValid() || big) map.flyTo(c, Math.min(big ? 8 : 12, mz), { duration: 1.8 });
    else {
      var sw = it.bounds.getSouthWest(), ne = it.bounds.getNorthEast();
      var b = L.latLngBounds(disp(sw.lat, sw.lng), disp(ne.lat, ne.lng));
      map.flyToBounds(b, { padding: [60, 60], maxZoom: mz, duration: 1.8 });
    }
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var s = q.value.trim(); if (!s) return;
    if (ctl) ctl.abort(); ctl = window.AbortController ? new AbortController() : null;
    form.classList.add('busy');
    var timer = setTimeout(function () { ctl && ctl.abort(); }, 8000);
    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=zh-CN,zh,en&q=' + encodeURIComponent(s);
    fetch(url, { signal: ctl ? ctl.signal : undefined, headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (data) {
        var items = data.map(function (d) {
          var parts = (d.display_name || '').split(/,\s*/);
          var bb = d.boundingbox ? L.latLngBounds([+d.boundingbox[0], +d.boundingbox[2]], [+d.boundingbox[1], +d.boundingbox[3]]) : null;
          return { name: d.name || parts[0], sub: parts.slice(1).join(', '), lat: +d.lat, lng: +d.lon, bounds: bb };
        });
        if (!items.length) items = localMatch(s);
        show(items);
      })
      .catch(function () { var m = localMatch(s); show(m, '搜索服务暂不可用'); })
      .then(function () { clearTimeout(timer); form.classList.remove('busy'); });
  });
  map.on('click', function () { q.blur(); if (!res.hidden) hideRes(); });

  /* ---------- 启动 ---------- */
  function ready() { $('#splash').classList.add('out'); }
  cur.once ? cur.once('load', ready) : null;
  setTimeout(ready, 1800);
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: no-preference)').matches) {
    setTimeout(function () { map.flyTo([33, 108], 4, { duration: 2.2 }); }, 900);
  }
})();
