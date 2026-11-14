// 写者清单（设计 docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md §6.5）：
// 控制器源码里每一处直接写文件的调用都要登记在 test/xin-writers.json 里并标类别，新加一处没登记就红。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanWriters, diffWriters, countAtomic, namedOperations, KINDS } = require('./helpers/xin-writers.cjs');
const SRC = path.join(__dirname, '../site/xin'), LIST = require('./xin-writers.json');

function sources(t, map) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-writers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(map)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('扫描器：写调用归到所在的顶层函数名下，同一处出现几次数几次', t => {
  const dir = sources(t, { 'vm-a.mjs': "import fs from 'node:fs';\nexport function save(f) {\n  fs.writeFileSync(f + '.tmp', 'x'); fs.renameSync(f + '.tmp', f);\n  fs.writeFileSync(f + '.bak', 'x');\n}\nconst drop = f => fs.unlinkSync(f);\n" });
  assert.deepEqual(scanWriters(dir), { writers: { 'vm-a.mjs::save': { writeFileSync: 2, renameSync: 1 }, 'vm-a.mjs::drop': { unlinkSync: 1 } }, problems: [] });
});
test('扫描器：对象和类里的成员归到「名字.成员」，控制语句不算成员', t => {
  const dir = sources(t, { 'vm-b.mjs': "import fs from 'node:fs';\nconst ops = {\n  set(a) {\n    if (a) {\n      fs.writeFileSync(a.f, a.text);\n    }\n  },\n  seen(a) { fs.writeFileSync(a.f, ''); },\n};\nexport class Journal {\n  project(x){fs.renameSync(x.tmp,x.file);}\n}\n" });
  assert.deepEqual(scanWriters(dir).writers, { 'vm-b.mjs::ops.set': { writeFileSync: 1 }, 'vm-b.mjs::ops.seen': { writeFileSync: 1 }, 'vm-b.mjs::Journal.project': { renameSync: 1 } });
});
test('扫描器：只读打开不算写', t => {
  const dir = sources(t, { 'vm-c.mjs': "import fs from 'node:fs';\nimport { DatabaseSync } from 'node:sqlite';\nfunction read(f) { const fd = fs.openSync(f, 'r'); const g = fs.openSync(f, fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW); return new DatabaseSync(f, { readOnly: true }); }\nfunction write(f) { fs.openSync(f, 'a', 0o600); fs.openSync(f, fs.constants.O_WRONLY|fs.constants.O_CREAT); return new DatabaseSync(f); }\n" });
  assert.deepEqual(scanWriters(dir).writers, { 'vm-c.mjs::write': { openSync: 2, DatabaseSync: 1 } });
});
test('扫描器：换了引入方式就报出来，不悄悄漏掉', t => {
  const dir = sources(t, { 'vm-d.mjs': "import { writeFileSync } from 'node:fs';\nimport fsp from 'node:fs/promises';\nimport * as files from 'node:fs';\nfunction f() { return fs.promises.writeFile('a', 'b'); }\n", 'other.mjs': "import x from 'node:fs/promises';\n" });
  const { problems } = scanWriters(dir);
  assert.equal(problems.length, 4);
  for (const p of problems) assert.match(p, /^vm-d\.mjs:\d+ /);
});
test('扫描器：把函数赋给别的名字也算一处', t => {
  const dir = sources(t, { 'vm-e.mjs': "import fs from 'node:fs';\nconst put = fs.writeFileSync;\n" });
  assert.deepEqual(scanWriters(dir).writers, { 'vm-e.mjs::put': { writeFileSync: 1 } });
});

test('写者清单：控制器里每一处直接写文件的调用都登记了，清单里也没有多出来的', () => {
  const { writers, problems } = scanWriters(SRC);
  assert.deepEqual(problems, []);
  const listed = Object.fromEntries(Object.entries(LIST.writers).map(([k, v]) => [k, v.calls]));
  assert.deepEqual(diffWriters(writers, listed), { 没登记: [], 多出来: [], 次数不对: [] });
});
test('写者清单：每一条都标了类别、写了说明', () => {
  for (const [k, v] of Object.entries(LIST.writers)) { assert.ok(KINDS.includes(v.kind), k); assert.ok(typeof v.what === 'string' && v.what.length >= 6, k); }
});
test('写者清单：「读了再写」的条数和清单里记的一致（第 5 批要清零，只许往下改）', () => {
  assert.equal(Object.values(LIST.writers).filter(v => v.kind === 'rmw').length, LIST.rmw);
});
test('写者清单：vm-agent.mjs 的行数不超过基线，少了 20 行以上要把基线调小', () => {
  const lines = fs.readFileSync(path.join(SRC, 'vm-agent.mjs'), 'utf8').split('\n').length - 1;
  assert.ok(lines <= LIST.agentLines, `现在 ${lines} 行，基线 ${LIST.agentLines}`);
  assert.ok(LIST.agentLines - lines < 20, `现在 ${lines} 行，把 test/xin-writers.json 的 agentLines 调小`);
});
test('写者清单：直接开事务（journal.atomic）只出现在登记过的文件里，次数一致', () => {
  assert.deepEqual(countAtomic(SRC), LIST.atomic);
});
test('写者清单：具名操作两边对得上（journal.named 用到的名字都在 stateOperations 里，反过来也是）', () => {
  const { used, defined } = namedOperations(SRC);
  assert.ok(used.length > 0);
  assert.deepEqual(used, defined);
});
