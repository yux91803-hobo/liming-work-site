import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site'), failures = [];
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
const all = files(site);
for (const f of all.filter(f => /\.(js|mjs)$/.test(f))) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status) failures.push(path.relative(root, f) + ': ' + r.stderr);
}
for (const f of all.filter(f => /\.html$/.test(f))) {
  const body = fs.readFileSync(f, 'utf8');
  for (const m of body.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const url = m[1].split(/[?#]/)[0];
    if (!url || /^(?:https?:|data:|#)/.test(url) || !/\.[a-z0-9]+$/i.test(url)) continue;
    const local = url.startsWith('/') ? path.join(site, url) : path.resolve(path.dirname(f), url);
    if (!fs.existsSync(local)) failures.push(path.relative(root, f) + ' missing ' + url);
  }
}
const ctx = { window: {} }; vm.createContext(ctx);
for (const rel of ['assets/assets.js', 'assets/manual.js', 'assets/teach-arch/teach-arch.js']) vm.runInContext(fs.readFileSync(path.join(site, 'tools/stm32', rel), 'utf8'), ctx);
let resources = 0;
function visit(x) {
  if (typeof x === 'string' && /\.(svg|webp|png|jpe?g|pdf)$/i.test(x) && !/^https?:/.test(x)) {
    const rel = x.startsWith('assets/') ? x : 'assets/' + x;
    if (!fs.existsSync(path.join(site, 'tools/stm32', rel))) failures.push('missing STM32 asset: ' + rel);
    resources++;
  } else if (x && typeof x === 'object') Object.values(x).forEach(visit);
}
visit(ctx.window);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`Syntax and local references passed: ${all.length} files, ${resources} asset references.`);
const tests = files(path.join(root, 'test')).filter(f => f.endsWith('.test.cjs'));
const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' }); process.exit(result.status === null ? 1 : result.status);
