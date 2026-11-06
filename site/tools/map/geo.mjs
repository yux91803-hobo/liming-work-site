/* 地图使用 [纬度, 经度]，MapLibre 的接口使用 [经度, 纬度]。 */
const PI = Math.PI, A = 6378245.0, EE = 0.00669342162296594323;
export const MAX_LAT = 85.05112878;
const clampLat = lat => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
export const outOfChina = (lat, lng) => lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
function tLat(x, y) { let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3; r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3; return r; }
function tLng(x, y) { let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3; r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3; return r; }
export function wgs2gcj(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  let dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
  const rad = lat / 180 * PI; let m = Math.sin(rad); m = 1 - EE * m * m; const s = Math.sqrt(m);
  dLat = (dLat * 180) / ((A * (1 - EE)) / (m * s) * PI); dLng = (dLng * 180) / (A / s * Math.cos(rad) * PI);
  return [lat + dLat, lng + dLng];
}
export function gcj2wgs(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  let a = lat, b = lng;
  for (let i = 0; i < 5; i++) { const p = wgs2gcj(a, b); a -= p[0] - lat; b -= p[1] - lng; }
  return [a, b];
}

// 找经度的最短覆盖弧：跨日界线的斐济、俄罗斯不能用 [-180, 180] 把镜头拉到全球。
export function bboxOf(geom) {
  const lngs = []; let s = 90, n = -90;
  const walk = c => {
    if (typeof c[0] === 'number') { lngs.push(c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); }
    else c.forEach(walk);
  };
  walk(geom.coordinates); lngs.sort((a, b) => a - b);
  if (s <= -90 || n >= 90) return [-180, clampLat(s), 180, clampLat(n)];
  let gap = -1, start = 0;
  for (let i = 0; i < lngs.length; i++) {
    const d = (i + 1 < lngs.length ? lngs[i + 1] : lngs[0] + 360) - lngs[i];
    if (d > gap) { gap = d; start = (i + 1) % lngs.length; }
  }
  const w = lngs[start], e = w + 360 - gap;
  return [w, clampLat(s), e, clampLat(n)];
}

// 搜索服务偶发返回无效坐标或错误的边界，不能传给 MapLibre 导致整个交互报错。
export function searchItems(data) {
  if (!Array.isArray(data)) return [];
  return data.flatMap(d => {
    if (!d || d.lat == null || d.lon == null || d.lat === '' || d.lon === '') return [];
    const lat = Number(d.lat), lng = Number(d.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return [];
    const parts = String(d.display_name || '').split(/,\s*/), name = String(d.name || parts[0] || '地点');
    const b = d.boundingbox;
    let bbox = Array.isArray(b) && b.length === 4 ? [Number(b[2]), Number(b[0]), Number(b[3]), Number(b[1])] : null;
    if (bbox && (!bbox.every(Number.isFinite) || bbox[0] < -180 || bbox[2] > 180 || bbox[0] > bbox[2] ||
      bbox[1] < -90 || bbox[3] > 90 || bbox[1] > bbox[3])) bbox = null;
    if (bbox) { bbox[1] = clampLat(bbox[1]); bbox[3] = clampLat(bbox[3]); }
    return [{ name, sub: parts.slice(1).join(', '), lat: clampLat(lat), lng, bbox }];
  }).slice(0, 6);
}
