const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const geo = import('../site/tools/map/geo.mjs');
const countries = JSON.parse(fs.readFileSync(path.join(__dirname, '../site/data/countries.json'))).features;
const country = name => countries.find(f => f.properties.en === name).geometry;

test('深色地图地名、路名和水域名对底色保持可读的对比度', () => {
  const style = JSON.parse(fs.readFileSync(path.join(__dirname, '../site/tools/map/styles/dark-zh.json')));
  const luminance = hex => {
    const rgb = hex.slice(1).match(/../g).map(n => parseInt(n, 16) / 255);
    return rgb.map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
      .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
  };
  for (const l of style.layers.filter(l => l.type === 'symbol' && l.layout['text-field'])) {
    const color = l.paint['text-color']; assert.match(color, /^#[0-9a-f]{6}$/i, l.id);
    for (const bg of ['#0c0c0c', '#1b1b1d']) assert.ok((luminance(color) + 0.05) / (luminance(bg) + 0.05) >= 4.5, l.id);
  }
  assert.ok(style.layers.find(l => l.id === 'place_state').minzoom >= 5);
  assert.ok(style.layers.find(l => l.id === 'place_town').minzoom >= 6);
});

test('高德转换：上海的已知坐标，反向切换后回到原位置', async () => {
  const { wgs2gcj, gcj2wgs } = await geo;
  const p = wgs2gcj(31.2304, 121.4737);
  assert.ok(Math.abs(p[0] - 31.22845774) < 1e-7);
  assert.ok(Math.abs(p[1] - 121.47822306) < 1e-7);
  const back = gcj2wgs(...p);
  assert.ok(Math.abs(back[0] - 31.2304) < 1e-9);
  assert.ok(Math.abs(back[1] - 121.4737) < 1e-9);
});

test('北京、广州、成都反复切换 20 次，不累积坐标漂移', async () => {
  const { wgs2gcj, gcj2wgs } = await geo;
  for (const p of [[39.9042, 116.4074], [23.1291, 113.2644], [30.5728, 104.0668]]) {
    let next = p;
    for (let i = 0; i < 20; i++) next = gcj2wgs(...wgs2gcj(...next));
    assert.ok(Math.abs(next[0] - p[0]) < 1e-8);
    assert.ok(Math.abs(next[1] - p[1]) < 1e-8);
  }
});

test('海外坐标保持原值', async () => {
  const { wgs2gcj, gcj2wgs } = await geo;
  for (const p of [[51.5074, -0.1278], [-17.7, 178.1], [35.68, 139.69]]) {
    assert.deepEqual(wgs2gcj(...p), p); assert.deepEqual(gcj2wgs(...p), p);
  }
});

test('斐济和俄罗斯跨日界线时使用短边界，不误缩到全球', async () => {
  const { bboxOf } = await geo;
  const f = bboxOf(country('Fiji')), r = bboxOf(country('Russia'));
  assert.ok(f[0] > 177 && f[2] > 180 && f[2] - f[0] < 4);
  assert.ok(r[0] > 19 && r[2] > 180 && r[2] - r[0] < 172);
});

test('177 个国家的边界覆盖所有顶点，极地不超出墨卡托范围', async () => {
  const { bboxOf, MAX_LAT } = await geo;
  for (const f of countries) {
    const b = bboxOf(f.geometry);
    assert.ok(b.every(Number.isFinite), f.properties.en);
    assert.ok(b[0] <= b[2] && b[2] - b[0] <= 360.000001, f.properties.en);
    assert.ok(b[1] >= -MAX_LAT && b[3] <= MAX_LAT && b[1] <= b[3], f.properties.en);
    const visit = c => {
      if (typeof c[0] !== 'number') return c.forEach(visit);
      const lng = c[0] < b[0] - 1e-7 ? c[0] + 360 : c[0];
      assert.ok(lng >= b[0] - 1e-7 && lng <= b[2] + 1e-7, f.properties.en);
    };
    visit(f.geometry.coordinates);
  }
  assert.deepEqual(bboxOf(country('Antarctica')).filter((_, i) => i % 2 === 0), [-180, 180]);
});

test('搜索坐标损坏时丢掉坏项，保留有效地点；坏边界不阻止定位', async () => {
  const { searchItems } = await geo;
  assert.deepEqual(searchItems({ error: 'unavailable' }), []);
  const items = searchItems([null, {}, { lat: 'NaN', lon: '121' }, { lat: '', lon: '' },
    { lat: '91', lon: '0' }, { lat: '0', lon: '181' },
    { name: '上海', display_name: '上海, 中国', lat: '31.23', lon: '121.47', boundingbox: ['40', '20', '120', '123'] }]);
  assert.deepEqual(items, [{ name: '上海', sub: '中国', lat: 31.23, lng: 121.47, bbox: null }]);
});

test('搜索北极地点与退化边界可以安全传给地图', async () => {
  const { searchItems, MAX_LAT } = await geo;
  const [p] = searchItems([{ lat: '89', lon: '20', boundingbox: ['88', '90', '19', '21'] }]);
  assert.equal(p.lat, MAX_LAT); assert.deepEqual(p.bbox, [19, MAX_LAT, 21, MAX_LAT]);
  const [zero] = searchItems([{ lat: '0', lon: '0', boundingbox: ['0', '0', '0', '0'] }]);
  assert.equal(zero.lat, 0); assert.deepEqual(zero.bbox, [0, 0, 0, 0]);
});
