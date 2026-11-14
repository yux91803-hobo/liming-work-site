// 写者清单的扫描器（只在测试里用）：逐行扫控制器源码，找出每一处直接写文件的调用，归到它所在的顶层函数或成员名下。
// 设计见 docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md §6.5。
// 边界：只认 `fs.方法` 这种直接调用和 `new DatabaseSync(...)`；通过 cp、tar、sqlite3 这类子进程写的文件扫不到。
const fs = require('node:fs');
const path = require('node:path');

// 类别：rmw 读了再写，写的进程不一定是主人；op 只在操作的处理函数里写；run 执行进程自己的输出；safe 两个进程同时写也不会坏；
// owner 只由主人写；shell 内核外壳自己的文件；outside 状态目录以外
const KINDS = ['rmw', 'op', 'run', 'safe', 'owner', 'shell', 'outside'];

const WRITES = ['writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'cp', 'truncate', 'ftruncate', 'symlink', 'link',
  'mkdir', 'mkdtemp', 'chmod', 'chown', 'utimes', 'write', 'open'];
const CALL = new RegExp('\\bfs\\.((?:' + WRITES.join('|') + ')(?:Sync)?|createWriteStream)\\b|\\bnew\\s+(DatabaseSync)\\b', 'g');
const TOP = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|class\s+([A-Za-z_$][\w$]*))/;
const METHOD = /^ {2}(?:(?:static|async|get|set)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*\(/;
const PROPERTY = /^ {2}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'await', 'yield', 'new', 'typeof', 'throw']);
const MODULE = "['\"](?:node:)?fs['\"]";

// 从 text 的 from 位置（应当是左括号）起，取到配对的右括号为止的参数文字；这一行里没配上就取到行尾
function argsAt(text, from) {
  if (text[from] !== '(') return null;
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return { args: text.slice(from + 1, i), end: i };
  }
  return { args: text.slice(from + 1), end: text.length };
}
function splitArgs(args) {
  const out = []; let depth = 0, start = 0;
  for (let i = 0; i < args.length; i++) {
    if ('([{'.includes(args[i])) depth++;
    else if (')]}'.includes(args[i])) depth--;
    else if (args[i] === ',' && depth === 0) { out.push(args.slice(start, i)); start = i + 1; }
  }
  out.push(args.slice(start));
  return out.map(s => s.trim());
}
function readOnlyOpen(args) {
  const flags = splitArgs(args)[1];
  if (flags === undefined || /^['"]r['"]$/.test(flags)) return true;
  return /\bO_RDONLY\b/.test(flags) && !/\bO_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC)\b/.test(flags);
}
function memberOf(line) {
  const p = PROPERTY.exec(line); if (p) return p[1];
  const m = METHOD.exec(line); if (!m || KEYWORDS.has(m[1])) return null;
  const a = argsAt(line, m[0].length - 1);
  return a && /^\s*\{/.test(line.slice(a.end + 1)) ? m[1] : null;   // 方法简写：参数后面紧跟花括号。普通的调用语句不是
}

function scanWriters(dir) {
  const writers = {}, problems = [];
  for (const file of fs.readdirSync(dir).filter(n => /^vm-[a-z0-9-]+\.mjs$/.test(n)).sort()) {
    let top = '(top)', member = null;
    fs.readFileSync(path.join(dir, file), 'utf8').split('\n').forEach((line, i) => {
      const at = file + ':' + (i + 1) + ' ';
      if (/['"](?:node:)?fs\/promises['"]/.test(line)) problems.push(at + '用了 fs/promises，扫描器只认 fs.方法');
      if (/\bfs\.promises\b/.test(line)) problems.push(at + '用了 fs.promises，扫描器只认 fs.方法');
      if (new RegExp('\\{[^}]*\\}\\s*(?:from\\s*|=\\s*require\\(\\s*)' + MODULE).test(line)) problems.push(at + '从 fs 里解构引入，扫描器只认 fs.方法');
      const named = new RegExp('(?:import\\s+(?:\\*\\s+as\\s+)?([A-Za-z_$][\\w$]*)\\s+from\\s*|([A-Za-z_$][\\w$]*)\\s*=\\s*require\\(\\s*)' + MODULE).exec(line);
      if (named && (named[1] || named[2]) !== 'fs') problems.push(at + 'fs 用了别的名字「' + (named[1] || named[2]) + '」引入，扫描器只认 fs.方法');
      const t = TOP.exec(line);
      if (t) { top = t[1] || t[2] || t[3]; member = null; }
      else if (line.startsWith('}')) member = null;
      else member = memberOf(line) || member;
      for (const c of line.matchAll(CALL)) {
        const call = c[1] || c[2], a = argsAt(line, c.index + c[0].length);
        if (a && /^open(?:Sync)?$/.test(call) && readOnlyOpen(a.args)) continue;
        if (a && call === 'DatabaseSync' && /\breadOnly\s*:\s*true\b/.test(a.args)) continue;
        const key = file + '::' + top + (member ? '.' + member : '');
        (writers[key] = writers[key] || {})[call] = (writers[key][call] || 0) + 1;
      }
    });
  }
  return { writers, problems };
}

// 源码扫出来的和清单逐条对：没登记的、清单里多出来的、调用次数对不上的
function diffWriters(found, listed) {
  const show = calls => Object.entries(calls).map(([k, n]) => k + '×' + n).sort().join(' ');
  return {
    没登记: Object.keys(found).filter(k => !listed[k]).sort().map(k => k + '  ' + show(found[k])),
    多出来: Object.keys(listed).filter(k => !found[k]).sort(),
    次数不对: Object.keys(found).filter(k => listed[k] && show(found[k]) !== show(listed[k])).sort().map(k => k + '  源码 ' + show(found[k]) + '，清单 ' + show(listed[k])),
  };
}
const sourceFiles = dir => fs.readdirSync(dir).filter(n => /^vm-[a-z0-9-]+\.mjs$/.test(n)).sort();
// 直接开事务的地方（journal.atomic），按文件计数。状态库自己内部的 this.atomic 不算
function countAtomic(dir) {
  const out = {};
  for (const file of sourceFiles(dir)) { const n = (fs.readFileSync(path.join(dir, file), 'utf8').match(/\bjournal\.atomic\(/g) || []).length; if (n) out[file] = n; }
  return out;
}
// 具名操作：源码里 journal.named('名字' 用到的，和 vm-kernel-operations.mjs 的 stateOperations 里登记的
function namedOperations(dir) {
  const used = new Set();
  for (const file of sourceFiles(dir)) for (const m of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/\bjournal\.named\(\s*'([^']+)'/g)) used.add(m[1]);
  const table = /stateOperations\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(fs.readFileSync(path.join(dir, 'vm-kernel-operations.mjs'), 'utf8'));
  const defined = table ? [...table[1].matchAll(/^\s*'([^']+)'\s*:/gm)].map(m => m[1]) : [];
  return { used: [...used].sort(), defined: defined.sort() };
}

module.exports = { scanWriters, diffWriters, countAtomic, namedOperations, KINDS };

// 更新清单时用：node test/helpers/xin-writers.cjs 打印源码和清单的出入
if (require.main === module) {
  const list = require('../xin-writers.json'), found = scanWriters(path.join(__dirname, '../../site/xin'));
  console.log(JSON.stringify({ ...diffWriters(found.writers, Object.fromEntries(Object.entries(list.writers).map(([k, v]) => [k, v.calls]))), problems: found.problems }, null, 2));
}
