// 写者清单的扫描器（只在测试里用）：逐行扫控制器源码，找出每一处直接写文件的调用，归到它所在的顶层函数或成员名下。
// 设计见 docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md §6.5。
// 边界：盘点直接 fs.方法 / new DatabaseSync；常见间接写法要求显式核对，未知打开按可能写登记。
// 这是文本回归门槛，不是完整 JS 数据流分析；cp、tar、sqlite3 等子进程写入仍需人工审查。
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

// 只对完整、可确认的字面量排除只读打开；这一行没闭合的参数按可能写入登记。
function argsAt(text, from) {
  while (/\s/.test(text[from] || '') && from < text.length) from++;
  if (text[from] !== '(') return null;
  let depth = 0, quote = null;
  for (let i = from; i < text.length; i++) {
    if (quote) { if (text[i] === '\\') i++; else if (text[i] === quote) quote = null; continue; }
    if ("'\"`".includes(text[i])) { quote = text[i]; continue; }
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return { args: text.slice(from + 1, i), end: i, closed: true };
  }
  return { args: text.slice(from + 1), end: text.length, closed: false };
}
function splitArgs(args) {
  const out = []; let depth = 0, start = 0, quote = null;
  for (let i = 0; i < args.length; i++) {
    if (quote) { if (args[i] === '\\') i++; else if (args[i] === quote) quote = null; continue; }
    if ("'\"`".includes(args[i])) { quote = args[i]; continue; }
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
  const terms = flags.split('|').map(s => s.trim());
  return terms.includes('fs.constants.O_RDONLY') && terms.every(s => /^fs\.constants\.O_(?:RDONLY|NOFOLLOW|CLOEXEC|NONBLOCK)$/.test(s));
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
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const problem = (offset, text) => problems.push(file + ':' + (source.slice(0, offset).split('\n').length) + ' ' + text);
    const imports = [...source.matchAll(new RegExp('(?:^|;)\\s*import\\s+([\\w$*{},\\s]+?)\\s+from\\s*' + MODULE, 'gm'))];
    for (const m of imports) if (!/^(?:fs|\*\s+as\s+fs)$/.test(m[1].trim())) problem(m.index, 'fs 必须以 fs 名称整模块引入，不能解构或换别名');
    for (const m of source.matchAll(new RegExp('\\bfrom\\s*' + MODULE, 'g')))
      if (!imports.some(x => m.index >= x.index && m.index < x.index + x[0].length)) problem(m.index, '无法确认 fs 引入方式，需要更新扫描器');
    for (const m of source.matchAll(new RegExp('\\bimport\\s*\\(\\s*' + MODULE, 'g'))) problem(m.index, 'fs 不能动态引入，扫描器只认 fs.方法');
    for(const m of source.matchAll(/\bfrom\s*['"]node:sqlite['"]/g)) {
      const prefix=source.slice(0,m.index),start=Math.max(prefix.lastIndexOf(';')+1,prefix.lastIndexOf('\nimport ')+1);
      if(!/^\s*import\s*\{\s*DatabaseSync\s*\}\s*$/.test(prefix.slice(start)))problem(m.index,'SQLite 必须以 DatabaseSync 原名静态引入，不能通过别名或命名空间绕过盘点');
    }
    for(const m of source.matchAll(/\bimport\s*\(\s*['"]node:sqlite['"]|(?<![=!<>])=\s*DatabaseSync\b/g))problem(m.index,'SQLite 构造器不能动态引入或保存为别名');
    source.split('\n').forEach((line, i) => {
      const at = file + ':' + (i + 1) + ' ';
      if (/['"](?:node:)?fs\/promises['"]/.test(line)) problems.push(at + '用了 fs/promises，扫描器只认 fs.方法');
      if (/\bfs\.promises\b/.test(line)) problems.push(at + '用了 fs.promises，扫描器只认 fs.方法');
      if (new RegExp('\\{[^}]*\\}\\s*=\\s*require\\(\\s*' + MODULE).test(line)) problems.push(at + '从 fs 里解构引入，扫描器只认 fs.方法');
      const named = new RegExp('([A-Za-z_$][\\w$]*)\\s*=\\s*require\\(\\s*' + MODULE).exec(line);
      if (named && named[1] !== 'fs') problems.push(at + 'fs 用了别的名字引入，扫描器只认 fs.方法');
      if (/\bfs\s*(?:\[|\?\.)/.test(line) || /(?<![=!<>])=\s*fs\b(?!\s*\.)/.test(line)) problems.push(at + 'fs 不能使用计算属性、解构或模块别名');
      const t = TOP.exec(line);
      if (t) { top = t[1] || t[2] || t[3]; member = null; }
      else if (line.startsWith('}')) member = null;
      else member = memberOf(line) || member;
      for (const c of line.matchAll(CALL)) {
        const call = c[1] || c[2], a = argsAt(line, c.index + c[0].length);
        if (!a && c[1]) problems.push(at + '写方法必须直接调用，不能保存别名后间接写入');
        if (a?.closed && /^open(?:Sync)?$/.test(call) && readOnlyOpen(a.args)) continue;
        if (a?.closed && call === 'DatabaseSync' && /^\{\s*readOnly\s*:\s*true\s*,?\s*\}$/.test(splitArgs(a.args)[1] || '')) continue;
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
  for (const file of sourceFiles(dir)) { const n = (fs.readFileSync(path.join(dir, file), 'utf8').match(/\bjournal\s*\.\s*atomic\s*\(/g) || []).length; if (n) out[file] = n; }
  return out;
}
// 具名操作：源码里 journal.named('名字' 用到的，和 vm-kernel-operations.mjs 的 stateOperations 里登记的
function namedOperations(dir) {
  const used = new Set(), problems = [];
  for (const file of sourceFiles(dir)) {
    const text=fs.readFileSync(path.join(dir,file),'utf8'), calls=[...text.matchAll(/\bjournal\s*\.\s*named\s*\(/g)];
    const literal=[...text.matchAll(/\bjournal\s*\.\s*named\s*\(\s*(['"])([^'"]+)\1/g)];
    for(const m of literal)used.add(m[2]);
    if(calls.length!==literal.length)problems.push(file+'：具名操作必须使用可核对的字面量名字');
  }
  const table = /stateOperations\s*=\s*Object\.freeze\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(fs.readFileSync(path.join(dir, 'vm-kernel-operations.mjs'), 'utf8'));
  const defined = table ? [...table[1].matchAll(/(['"])([^'"]+)\1\s*:/g)].map(m => m[2]) : [];
  return { used: [...used].sort(), defined: defined.sort(), problems };
}

module.exports = { scanWriters, diffWriters, countAtomic, namedOperations, KINDS };

// 更新清单时用：node test/helpers/xin-writers.cjs 打印源码和清单的出入
if (require.main === module) {
  const list = require('../xin-writers.json'), found = scanWriters(path.join(__dirname, '../../site/xin'));
  console.log(JSON.stringify({ ...diffWriters(found.writers, Object.fromEntries(Object.entries(list.writers).map(([k, v]) => [k, v.calls]))), problems: found.problems }, null, 2));
}
