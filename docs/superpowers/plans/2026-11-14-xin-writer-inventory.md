# 写者清单测试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 控制器源码里每一处直接写文件的地方都登记在一份提交进仓库的清单里并标了类别；以后谁新加一处，测试就红。

**Architecture:** 一个只在测试里用的扫描器（正则逐行扫 `site/xin/vm-*.mjs`，把每处写调用归到所在的顶层函数或成员名下），一份 JSON 清单，一个把两边逐条对的测试。不改任何线上代码。顺手把工作流里「保存浏览器报告」的名字改成每次执行都不同（#140 合并后那次正式站运行就是因为同名报告撞车而没有部署）。

**Tech Stack:** Node 22 自带的 `node:test`、`node:assert`；测试文件是 `.cjs`，和仓库现有测试一致。不加依赖。

**Spec:** `docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md` §6.5（写者清单测试）、§6.3（不经过 `lockedCall` 就写库的地方不能再长出新的）、§7 第 1 批和第 5 批的门槛。

基线：main `04a88fb`（#140 之后）。#140 已经做了状态进程、两层桥、只读句柄和具名操作；第 1 批还剩写者清单测试（这一块）和持久服务（下一块，要先在小芯电脑上只读确认 linger）。

## Global Constraints

- 这一块不改 `site/xin/` 和 `src/` 里的任何文件：线上行为不变。
- 不跳过、不删现有测试。`npm run check`、`npm run test:kernel`、`npm run test:e2e` 全过才开 PR。
- 清单里的类别只有这几种（设计 §6.5 的三类，加上「不是控制器进程随手写状态文件」的三种情况）：
  - `rmw` 读了再写（状态目录里的文件，两个写者会互相盖掉）：第 5 批必须清零
  - `run` 执行进程自己的输出（一轮一个进程在写）
  - `mark` 只碰一下的标记、只追加的日志、内容固定重写无害的安装文件
  - `owner` 只由主人写：投影、状态库、所有权库、状态套接字
  - `shell` 内核外壳自己的文件：密钥环、防重放库、启动环境、外壳日志、启动锁
  - `outside` 状态目录以外：任务沙盒、工作目录、临时目录、浏览器资料、模型命令行工具自己的配置
- `vm-agent.mjs` 现在 3217 行，第 2 步的目标是只减不增：以这个数为基线。
- 中文文案用仓库现有的说法（主人、旧模式、内核模式、投影、执行进程）。

## Review Focus

- 扫描器漏报：有人把 `fs.writeFileSync` 赋给别的名字、或者换一种方式引入 `fs`，写调用就扫不到。应当报错而不是悄悄放过。→ 任务 1 的「别的引入方式」测试
- 只读打开被当成写（`fs.openSync(f, 'r')`、`{ readOnly: true }` 的库）：清单里会多出不是写者的条目。→ 任务 1
- 一个大对象里的不同操作（`ops.memory_set` 和 `ops.poll`）被归成同一条，类别就标不准。→ 任务 1 的成员归属测试
- 清单里有、源码里已经没有的条目（删了写调用没更新清单）也要红，不然清单会烂掉。→ 任务 2
- 通过 `cp`、`tar`、`sqlite3` 这类子进程写文件的扫不到。这是这个测试的边界，写在清单的说明和修改清单里，不假装覆盖了。

---

### Task 1: 扫描器

**Files:**
- Create: `test/helpers/xin-writers.cjs`
- Test: `test/xin-writers.test.cjs`

**Interfaces:**
- Produces: `scanWriters(dir: string) → { writers: { [key: string]: { [call: string]: number } }, problems: string[] }`
  - `key` 是 `文件名::顶层名字` 或 `文件名::顶层名字.成员`（顶层声明：行首的 `function` / `const|let|var 名字 =` / `class`，可带 `export`、`async`；成员：两格缩进的方法简写，关键字 `if for while switch catch return function else do try` 不算）
  - `call` 是 `fs.` 后面的方法名，或者 `DatabaseSync`
  - 算写的方法：`writeFileSync appendFileSync renameSync unlinkSync rmSync rmdirSync copyFileSync cpSync truncateSync ftruncateSync symlinkSync linkSync mkdirSync mkdtempSync chmodSync chownSync utimesSync writeSync createWriteStream openSync`，以及它们不带 `Sync` 的写法
  - `openSync` 的参数里第二个是 `'r'`、或者只有 `O_RDONLY` 没有 `O_WRONLY|O_RDWR|O_CREAT|O_APPEND` 时不算；`new DatabaseSync(...)` 同一行带 `readOnly:true` 时不算
  - `problems`：文件里出现 `node:fs/promises`、`fs.promises`、从 `node:fs` 解构引入、或者 `fs` 以外的名字引入 `node:fs` 时各记一条（带文件名和行号）
- Produces: `KINDS = ['rmw','run','mark','owner','shell','outside']`

- [ ] **Step 1: 写失败的测试**（临时目录里放几个小文件，逐条断言）

```js
test('扫描器：写调用归到所在的顶层函数名下，同一处出现几次数几次', () => {
  const dir = sources({ 'vm-a.mjs': "import fs from 'node:fs';\nexport function save(f) {\n  fs.writeFileSync(f + '.tmp', 'x'); fs.renameSync(f + '.tmp', f);\n  fs.writeFileSync(f + '.bak', 'x');\n}\nconst drop = f => fs.unlinkSync(f);\n" });
  assert.deepEqual(scanWriters(dir), { writers: { 'vm-a.mjs::save': { writeFileSync: 2, renameSync: 1 }, 'vm-a.mjs::drop': { unlinkSync: 1 } }, problems: [] });
});
test('扫描器：对象和类里的成员归到「名字.成员」，控制语句不算成员', () => {
  const dir = sources({ 'vm-b.mjs': "import fs from 'node:fs';\nconst ops = {\n  set(a) {\n    if (a) {\n      fs.writeFileSync(a.f, a.text);\n    }\n  },\n  seen(a) { fs.writeFileSync(a.f, ''); },\n};\nexport class Journal {\n  project(x){fs.renameSync(x.tmp,x.file);}\n}\n" });
  assert.deepEqual(scanWriters(dir).writers, { 'vm-b.mjs::ops.set': { writeFileSync: 1 }, 'vm-b.mjs::ops.seen': { writeFileSync: 1 }, 'vm-b.mjs::Journal.project': { renameSync: 1 } });
});
test('扫描器：只读打开不算写', () => {
  const dir = sources({ 'vm-c.mjs': "import fs from 'node:fs';\nimport { DatabaseSync } from 'node:sqlite';\nfunction read(f) { const fd = fs.openSync(f, 'r'); const g = fs.openSync(f, fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW); return new DatabaseSync(f, { readOnly: true }); }\nfunction write(f) { fs.openSync(f, 'a', 0o600); fs.openSync(f, fs.constants.O_WRONLY|fs.constants.O_CREAT); return new DatabaseSync(f); }\n" });
  assert.deepEqual(scanWriters(dir).writers, { 'vm-c.mjs::write': { openSync: 2, DatabaseSync: 1 } });
});
test('扫描器：换了引入方式就报出来，不悄悄漏掉', () => {
  const dir = sources({ 'vm-d.mjs': "import { writeFileSync } from 'node:fs';\nimport fsp from 'node:fs/promises';\nimport * as files from 'node:fs';\nfunction f() { return fs.promises.writeFile('a', 'b'); }\n", 'other.mjs': "import x from 'node:fs/promises';\n" });
  const { problems } = scanWriters(dir);
  assert.equal(problems.length, 4);
  for (const p of problems) assert.match(p, /^vm-d\.mjs:\d+ /);
});
test('扫描器：把函数赋给别的名字也算一处', () => {
  const dir = sources({ 'vm-e.mjs': "import fs from 'node:fs';\nconst put = fs.writeFileSync;\n" });
  assert.deepEqual(scanWriters(dir).writers, { 'vm-e.mjs::put': { writeFileSync: 1 } });
});
```

`sources(map)` 是测试文件里的小帮手：`fs.mkdtempSync(os.tmpdir()+'/xin-writers-')`，按 map 写文件，`t.after` 里删。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/xin-writers.test.cjs`
Expected: FAIL，`Cannot find module './helpers/xin-writers.cjs'`

- [ ] **Step 3: 实现 `scanWriters` 和 `KINDS`**（按上面 Interfaces 的规则逐行扫；只扫文件名匹配 `^vm-[a-z0-9-]+\.mjs$` 的）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/xin-writers.test.cjs`
Expected: 5 个都 PASS

- [ ] **Step 5: 提交**

```bash
git add test/helpers/xin-writers.cjs test/xin-writers.test.cjs
git commit -m "写者清单：扫描控制器源码里直接写文件的调用"
```

### Task 2: 清单和对照测试

**Files:**
- Create: `test/xin-writers.json`
- Modify: `test/xin-writers.test.cjs`
- Modify: `test/helpers/xin-writers.cjs`（加一个命令行入口：`node test/helpers/xin-writers.cjs` 打印「源码里有、清单里没有」和「清单里有、源码里没有」的条目，方便以后更新清单）

**Interfaces:**
- Consumes: `scanWriters`、`KINDS`
- Produces: `test/xin-writers.json`：

```json
{
  "agentLines": 3217,
  "rmw": 0,
  "atomic": { "vm-agent.mjs": 1, "vm-kernel-controller.mjs": 3 },
  "writers": { "vm-agent.mjs::warm": { "calls": { "appendFileSync": 1 }, "kind": "mark", "what": "warm.log：预热记录，只追加" } }
}
```

`rmw` 是 `kind` 为 `rmw` 的条数（实际数字填完清单后才知道，上面的 0 只是格式）。每条 `what` 用一句话写清楚写的是哪个文件、为什么归这一类；`rmw` 的还要写清楚是哪种进程在写（主人执行的操作里 / 执行进程 / 看门狗 / 谁都可能）。

- [ ] **Step 1: 写失败的测试**

```js
const SRC = path.join(__dirname, '../site/xin'), LIST = require('./xin-writers.json');
test('写者清单：控制器里每一处直接写文件的调用都登记了，清单里也没有多出来的', () => {
  const { writers, problems } = scanWriters(SRC);
  assert.deepEqual(problems, []);
  const listed = Object.fromEntries(Object.entries(LIST.writers).map(([k, v]) => [k, v.calls]));
  assert.deepEqual(diff(writers, listed), { 没登记: [], 多出来: [], 次数不对: [] });
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
  assert.deepEqual(used, defined);
});
```

`diff`、`countAtomic(dir) → { [file]: n }`（数 `journal.atomic(`）、`namedOperations(dir) → { used: string[], defined: string[] }`（`journal.named('名字'` 和 `vm-kernel-operations.mjs` 里 `stateOperations` 的键，都排序去重）放进 `test/helpers/xin-writers.cjs`。

- [ ] **Step 2: 跑测试确认失败**（清单先只放 `agentLines`、`rmw: 0`、`atomic: {}`、`writers: {}`）

Run: `node --test test/xin-writers.test.cjs`
Expected: 「每一处都登记了」FAIL，`没登记` 里列出全部条目；「直接开事务」FAIL（`{}` 对不上）；其余 PASS

- [ ] **Step 3: 填清单**：逐条读源码定类别、写说明。拿不准是不是「读了再写」的一律标 `rmw`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/xin-writers.test.cjs`
Expected: 11 个都 PASS

- [ ] **Step 5: 确认它真的拦得住**（改完立刻还原，不提交）：在 `site/xin/vm-agent.mjs` 的 `warm` 里临时加一行 `fs.writeFileSync('/tmp/x','')`，跑测试应当 FAIL 并指出 `vm-agent.mjs::warm` 次数不对；还原后再跑应当 PASS。再临时删掉清单里一条，应当 FAIL 并列在「没登记」里。

- [ ] **Step 6: 提交**

```bash
git add test/xin-writers.json test/xin-writers.test.cjs test/helpers/xin-writers.cjs
git commit -m "写者清单：逐条登记并标类别；行数、直接开事务、具名操作各一道对照"
```

### Task 3: 保存浏览器报告不再撞名；文档；全量验证

**Files:**
- Modify: `.github/workflows/deploy.yml`（e2e 作业的「保存浏览器检查报告」）
- Modify: `test/ci-proof.test.cjs`
- Modify: `docs/CHANGES.md`、`README.md`、`docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md`（状态行加这份计划；§7 注明第 1 批还剩持久服务）

**Interfaces:**
- Consumes: 无
- Produces: 报告名 `e2e-report-<run_id>-<run_attempt>-<这次执行自己的编号>`

背景（实测，运行 43559539100）：e2e 作业在执行机上被执行了两遍。一遍在 05:05:52 页面跳转超时，先传了 `e2e-report-43559539100-1`；另一遍 05:12:40 全部通过，传同名报告时得到 409，作业算失败，正式站没有部署。两遍执行为什么会同时出现还没查清（执行机不在这个会话能看到的范围里）。这里只修「报告同名」：两份报告都留下来，谁也不因为撞名失败。

- [ ] **Step 1: 写失败的测试**（加在 `test/ci-proof.test.cjs`）

```js
test('浏览器检查报告的名字每次执行都不同：同一个作业被跑两遍时不会因为同名而失败', () => {
  const yaml = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/deploy.yml'), 'utf8');
  assert.match(yaml, /echo "E2E_REPORT_ID=\$\(date \+%s%N\)-\$\$" >> "\$GITHUB_ENV"/);
  assert.match(yaml, /name: e2e-report-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ env\.E2E_REPORT_ID \}\}/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ci-proof.test.cjs`
Expected: 新加的这条 FAIL（工作流里还没有 `E2E_REPORT_ID`），其余 PASS

- [ ] **Step 3: 改工作流**：在「浏览器端到端测试」那一步的脚本开头加一行 `echo "E2E_REPORT_ID=$(date +%s%N)-$$" >> "$GITHUB_ENV"`，上传那一步的 `name` 改成上面的写法。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ci-proof.test.cjs`
Expected: 全部 PASS

- [ ] **Step 5: 更新文档**：`docs/CHANGES.md` 加最上面一条（做了什么、清单各类多少条、「读了再写」是哪些、边界、参考、正式站那次失败的经过）；`README.md` 测试一节加一句；设计文档状态行加这份计划。

- [ ] **Step 6: 全量验证**

Run: `npm run check`，`npm run test:kernel`，`CHROMIUM_PATH=... npm run test:e2e`
Expected: 全过，0 失败 0 跳过

- [ ] **Step 7: 提交**

```bash
git add .github/workflows/deploy.yml test/ci-proof.test.cjs docs README.md
git commit -m "浏览器检查报告每次执行单独命名；写者清单的文档"
```
