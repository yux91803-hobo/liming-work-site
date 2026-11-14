# 所有权锁和记录（第 1 批的第一块）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给「谁能写状态库」加一把由程序保证的锁和一条记录，并让旧模式的每个写入口先过这一道；正式站的行为不变。

**Architecture:** 新模块 `vm-kernel-owner.mjs` 用一个单独的小库 `~/.xin/owner.sqlite` 的 SQLite 文件锁表示所有权：以后的状态进程拿独占锁并一直不放，旧模式的写者每次写之前拿共享锁。`StateJournal` 的所有写入口先调它；控制器的一次性进程启动时就拿着共享锁直到退出。这一块不起状态进程、不做转发：记录永远是旧模式，所以线上走的还是今天的路，只是多了一次不到一毫秒的检查。

**Tech Stack:** Node 22 `node:sqlite`（`DatabaseSync`），`node:test`。不加依赖。

**Spec:** `docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md` §6.2（所有权锁和记录、判断规则）、§6.3 的「兜底」里和写入口有关的部分、§7 第 1 批。第 1 批拆成三块，这是第一块；后两块（状态进程和两层桥；写者清单测试和持久服务）等这一块上线后另写计划。

## Global Constraints

- 库文件是 `<XIN_HOME>/owner.sqlite`，权限 0600，是软链接就拒绝。**回滚日志模式，不能用 WAL**（WAL 下独占事务挡不住读者）。
- 记录四个键：`mode`（`legacy` 或 `kernel`）、`epoch`（每切一次加一）、`protocol`（桥的协议号，本批是 1）、`since`（毫秒时间戳）。没有记录等于 `mode=legacy, epoch=0`。
- 判断规则照设计 §6.2 的表，**每次都重新判断，不缓存**：共享锁拿不到 → 主人活着；拿到且 `legacy` → 可以写；拿到且 `kernel` → 该内核当主人但它不在，**不写**。
- 本批没有任何代码路径会把记录写成 `kernel`（只有测试会）。不新增操作、不改 Worker、不改网页。状态进程、转发、只读句柄都不在这一块。
- 失败时一律不写（fail closed）：库打不开、判断不了，都当作不能写。
- `vm-agent.mjs` 只减不增是整个第 2 步的目标；本批它最多增加 6 行，写进提交说明。
- 原有测试一个不删、不跳过。提交说明用中文。上线走 `CLAUDE.md` 的流程。

## Review Focus

1. **`owner.sqlite` 打不开**（磁盘满、被建成了目录）。期望：写入口抛错，控制器以非零退出，状态库和投影一个字节都不动；不能当成旧模式照写。
2. **改记录改到一半被 `kill -9`**（留下热日志）。期望：下一个读者读到的是上一次提交的记录，写入口照常工作。
3. **一次性进程拿着共享锁时起了脱离的子进程然后自己退出**（派发执行进程就是这样）。期望：锁随它自己释放，不被子进程带走。
4. **源源不断的旧写者**（每 20 毫秒来一个，各写几毫秒）。期望：等独占锁的主人不会被饿死，3 秒内拿到。这一条是设计 §12 里写明「按文档、没有实测」的那一条。写计划时补了一个探针：4 个写者每 20 毫秒各拿 15 毫秒，主人 10 轮都在约 20 毫秒内拿到。
5. **两个进程同时想当主人。** 期望：只有一个拿到，另一个在 `waitMs` 后以 `owner_busy` 失败。

---

### Task 1: `Ownership`（锁和记录）

**Files:**
- Create: `site/xin/vm-kernel-owner.mjs`
- Test: `test/xin-owner.test.cjs`

**Interfaces:**
- Produces（`site/xin/vm-kernel-owner.mjs`）：

```js
export const BRIDGE_PROTOCOL = 1;
// code 固定是 'owner_unavailable'；status 是 'alive'（主人活着）或 'missing'（该内核当主人但它不在）
export class OwnerUnavailable extends Error { constructor(status) }
export class Ownership {
  constructor(home, { waitMs = 250 } = {})      // 库文件：<home>/owner.sqlite；waitMs：拿共享锁时最多等多久（只为躲开改记录的那一下）
  get db()        // 内部用的连接，第一次用到才打开
  record()        // → { mode, epoch, protocol, since }（后三个是数字）；主人活着时 → { busy: true }。不留锁
  enter()         // 旧模式的写入口。→ 放锁函数。可重入：本进程已经拿着时返回空操作。拿不到抛 OwnerUnavailable
  hold()          // 同 enter，但一直拿到进程结束（一次性进程用）。之后的 enter 都是空操作
  take({ waitMs = 30000 } = {})   // 当主人：拿独占锁（等旧写者写完），写 mode=kernel、epoch+1，一直不放。
                                  // → { epoch, release(mode) }；release('legacy') 写回旧模式（epoch 再 +1）后放锁，release() 只放锁。
                                  // waitMs 内拿不到抛 Error，code 是 'owner_busy'
  set(mode)       // 没有主人时改记录（epoch+1）→ { epoch }。有主人活着抛 'owner_busy'
  close()
}
```

- 本进程是主人（`take` 之后）时，`enter()` 返回空操作。

测试帮手（写在测试文件里）：

```js
const url = pathToFileURL(path.join(__dirname, '../site/xin/vm-kernel-owner.mjs')).href;
const home = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-owner-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
// 另起一个进程执行一段脚本（脚本里有 o = new Ownership(dir, opts)）；返回 { child, line(), exit() }：line() 等下一行输出，exit() 等退出码
function proc(t, dir, body, opts = {}) { /* spawn(process.execPath, ['--input-type=module', '-e', `import { Ownership } from ${JSON.stringify(url)}; const o = new Ownership(${JSON.stringify(dir)}, ${JSON.stringify(opts)}); ${body}`])，t.after 里 SIGKILL */ }
const OWNER = "const h = o.take(); console.log('held ' + h.epoch); process.stdin.on('end', () => { h.release('legacy'); process.exit(0); }); process.stdin.resume();";
```

- [ ] **Step 1: 写会失败的测试**

```js
test('新目录：没有记录就是旧模式；写入口放行；库文件权限 0600', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir);
  assert.deepEqual(o.record(), { mode: 'legacy', epoch: 0, protocol: 0, since: 0 });
  const release = o.enter(); release();
  assert.equal(fs.statSync(path.join(dir, 'owner.sqlite')).mode & 0o777, 0o600);
});

test('主人活着：写入口被拒（alive），记录读出来是 busy', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir, { waitMs: 50 });
  assert.equal(await proc(t, dir, OWNER).line(), 'held 1');
  assert.throws(() => o.enter(), e => e.code === 'owner_unavailable' && e.status === 'alive');
  assert.deepEqual(o.record(), { busy: true });
});

test('主人被 kill -9：锁放掉，记录仍归内核，写入口照样拒（missing）；set(legacy) 之后放行', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir, { waitMs: 50 });
  const p = proc(t, dir, OWNER); await p.line(); p.child.kill('SIGKILL'); await p.exit();
  assert.throws(() => o.enter(), e => e.code === 'owner_unavailable' && e.status === 'missing');
  const r = o.record(); assert.deepEqual([r.mode, r.epoch, r.protocol], ['kernel', 1, 1]);
  assert.deepEqual(o.set('legacy'), { epoch: 2 });
  o.enter()();
});

test('主人正常交回：release(legacy) 之后写入口放行，切换次数再加一', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir, { waitMs: 50 });
  const p = proc(t, dir, OWNER); await p.line(); p.child.stdin.end(); assert.equal(await p.exit(), 0);
  const r = o.record(); assert.deepEqual([r.mode, r.epoch], ['legacy', 2]);
  o.enter()();
});

test('旧模式的写者还在写：主人等它写完才拿到', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir);
  const release = o.enter();
  const p = proc(t, dir, OWNER); let held = false; p.line().then(() => { held = true; });
  await new Promise(r => setTimeout(r, 400)); assert.equal(held, false);
  release();
  await new Promise(r => setTimeout(r, 400)); assert.equal(held, true);
});

test('可重入：外层还拿着时里层放了不算放', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir);
  const outer = o.enter(), inner = o.enter(); inner();
  assert.equal(await proc(t, dir, "try { o.take({ waitMs: 200 }); console.log('took'); } catch (e) { console.log(e.code); }").line(), 'owner_busy');
  outer();
  assert.equal(await proc(t, dir, "o.take({ waitMs: 200 }); console.log('took');").line(), 'took');
});

test('两个进程同时想当主人：只有一个拿到', async t => {
  const dir = home(t);
  assert.equal(await proc(t, dir, OWNER).line(), 'held 1');
  assert.equal(await proc(t, dir, "try { o.take({ waitMs: 200 }); console.log('took'); } catch (e) { console.log(e.code); }").line(), 'owner_busy');
});

test('八个进程同时第一次用：都拿得到共享锁', async t => {
  const dir = home(t);
  const codes = await Promise.all(Array.from({ length: 8 }, () => proc(t, dir, 'o.enter()(); process.exit(0);').exit()));
  assert.deepEqual(codes, Array(8).fill(0));
});

test('owner.sqlite 是软链接：拒绝', async t => {
  const dir = home(t), { Ownership } = await import(url);
  fs.writeFileSync(path.join(dir, 'elsewhere'), ''); fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'owner.sqlite'));
  assert.throws(() => new Ownership(dir).enter(), /软链接/);
});
```

Review Focus 对应的测试，同一步写：

```js
test('owner.sqlite 打不开（被建成了目录）：写入口抛错，不当成旧模式', async t => {
  const dir = home(t), { Ownership } = await import(url);
  fs.mkdirSync(path.join(dir, 'owner.sqlite'));
  assert.throws(() => new Ownership(dir).enter(), e => e.code !== 'owner_unavailable');
});

test('改记录改到一半被 kill -9：读到的还是上一次提交的，写入口照常', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir, { waitMs: 2000 });
  o.enter()();
  const p = proc(t, dir, "o.db.exec('BEGIN EXCLUSIVE'); o.db.prepare(\"INSERT OR REPLACE INTO owner VALUES('mode','kernel')\").run(); console.log('dirty'); setInterval(() => {}, 1000);");
  await p.line(); p.child.kill('SIGKILL'); await p.exit();
  assert.equal(o.record().mode, 'legacy');
  o.enter()();
});

test('拿着共享锁时起了脱离的子进程然后自己退出：锁不被子进程带走', async t => {
  const dir = home(t);
  const p = proc(t, dir, "import('node:child_process').then(c => { o.hold(); const k = c.spawn('sleep', ['20'], { detached: true, stdio: 'ignore' }); console.log(k.pid); k.unref(); process.exit(0); });");
  const pid = Number(await p.line()); t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ } });
  await p.exit();
  assert.equal(await proc(t, dir, "o.take({ waitMs: 200 }); console.log('took');").line(), 'took');
});

test('源源不断的旧写者：等独占锁的主人不会被饿死', async t => {
  const dir = home(t);
  const writers = Array.from({ length: 3 }, () => proc(t, dir, 'setInterval(() => { try { const r = o.enter(); const end = Date.now() + 5; while (Date.now() < end); r(); } catch { /* 主人来了 */ } }, 20);'));
  await new Promise(r => setTimeout(r, 300));
  const t0 = Date.now();
  assert.equal(await proc(t, dir, "o.take({ waitMs: 3000 }); console.log('took');").line(), 'took');
  assert.ok(Date.now() - t0 < 3000);
  for (const w of writers) w.child.kill('SIGKILL');
});
```

（`o.db` 是模块内部用的连接，测试里只在「改到一半」那一条用它造现场。）

- [ ] **Step 2: 跑一遍，确认失败**

Run: `node --test test/xin-owner.test.cjs`
Expected: 全部 FAIL，原因是找不到模块 `vm-kernel-owner.mjs`。

- [ ] **Step 3: 实现 `site/xin/vm-kernel-owner.mjs`**

按 Interfaces 的签名写。签名和测试定不下来的几处：

- 打开连接：先查是不是软链接（`lstatSync`，是就 `throw Error('所有权库不能是软链接')`），`new DatabaseSync(file)`，`chmodSync(file, 0o600)`，`PRAGMA busy_timeout=<waitMs>`。只在 `sqlite_master` 里没有 `owner` 表时才建表（`CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, v TEXT NOT NULL)`），这样平时不会为了建表去拿写锁。
- `enter()`：`BEGIN` 之后马上 `SELECT k, v FROM owner`（这一下才真的拿到共享锁）。SQLite 报忙（`errcode` 5 或 6）→ `OwnerUnavailable('alive')`。读到 `mode === 'kernel'` → 先 `COMMIT` 再抛 `OwnerUnavailable('missing')`。否则返回的放锁函数做 `COMMIT`。用一个计数器做重入。
- `take()`：`PRAGMA busy_timeout=<waitMs>; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE`，写四个键，`COMMIT`。`locking_mode=EXCLUSIVE` 让提交之后锁仍然在手里（设计 §6.2 实测过）。报忙 → `code: 'owner_busy'`。
- `release(mode)`：有 `mode` 就先写记录（`epoch+1`），然后 `close()`。关连接就是放锁。
- `set(mode)`：`BEGIN EXCLUSIVE`（等 `waitMs`）→ 写 → `COMMIT`。报忙 → `owner_busy`。

- [ ] **Step 4: 跑一遍，确认通过**

Run: `node --test test/xin-owner.test.cjs`
Expected: 全部 PASS。「不会被饿死」那一条如果失败，不要调大时限：先确认 SQLite 在等独占锁时是否挡住了新的共享锁，把看到的现象记进台账再决定。

- [ ] **Step 5: 提交**

```bash
git add site/xin/vm-kernel-owner.mjs test/xin-owner.test.cjs
git commit -m "所有权锁和记录：owner.sqlite 的文件锁表示谁能写状态库"
```

### Task 2: `StateJournal` 的写入口先过所有权检查

**Files:**
- Modify: `site/xin/vm-state.mjs`（`StateJournal`）
- Modify: `site/xin/vm-base.mjs`（给 `journal` 装上 `Ownership`）
- Modify: `site/xin/vm-memory.mjs`（第 16 行附近，记忆表的初始化）
- Test: `test/xin-state.test.cjs`

**Interfaces:**
- Consumes: Task 1 的 `Ownership.enter()`、`OwnerUnavailable`。
- Produces:
  - `StateJournal.owner`：默认 `null`（单独用 `StateJournal` 的测试不受影响）。有值时要求它有 `enter(): () => void`。
  - `StateJournal.writing(fn)`：在所有权检查之内执行 `fn` 并返回它的结果。可重入（靠 `owner.enter()` 自己的重入）。`owner` 为 `null` 时直接执行。
  - 下面这些方法都在 `writing` 之内执行：`atomic`（只包最外层那一次，连同提交之后的 `recover` 和延后执行的函数）、`recover`（只包「确实有东西要投影」之后的部分，前面那次只读的检查不包）、`enqueueLaunch`、`dispatched`、`finishLaunch`、`enqueueHandoff`、`startHandoff`、`settleHandoff`、`retryHandoff`。`dropConversation` 已经走 `atomic`。
  - `vm-base.mjs`：`journal.owner = new Ownership(BASE)`，并 `export const ownership = journal.owner`。
  - `vm-memory.mjs`：建表、导入、建索引那一段放进 `journal.writing(...)`。

- [ ] **Step 1: 写会失败的测试**（加在 `test/xin-state.test.cjs`）

```js
const refuse = { enter() { throw Object.assign(new Error('owner_alive'), { code: 'owner_unavailable', status: 'alive' }); } };
const counting = () => { const c = { entered: 0, released: 0, enter() { c.entered++; return () => { c.released++; }; } }; return c; };

test('主人活着时状态库的写入口都不执行、不落任何行；读不受影响', async t => {
  const { root, j } = await fixture(t);
  j.atomic(() => { j.write(root + '/a.json', '{"v":1}'); j.enqueueLaunch('r1', 's1'); j.enqueueHandoff({ id: 'h1', parent: 'sp', task: 'st', version: 'v1', payload: {} }); });
  j.db.prepare('UPDATE documents SET dirty=1').run();
  j.owner = refuse;
  const denied = f => assert.throws(f, e => e.code === 'owner_unavailable');
  denied(() => j.atomic(() => j.write(root + '/b.json', '{}')));
  denied(() => j.write(root + '/b.json', '{}'));
  denied(() => j.append(root + '/e.jsonl', { t: 'x' }));
  denied(() => j.recover());
  for (const f of [() => j.enqueueLaunch('r2', 's1'), () => j.dispatched('r1'), () => j.finishLaunch('r1'), () => j.enqueueHandoff({ id: 'h2', parent: 'sp', task: 'st', version: 'v1', payload: {} }),
    () => j.startHandoff('h1', 'r1'), () => j.settleHandoff('h1', 'delivered'), () => j.retryHandoff('h1')]) denied(f);
  assert.equal(j.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 1);
  assert.equal(j.launchRecord('r1').state, 'pending');
  assert.equal(j.handoff('h1').state, 'pending');
  assert.equal(j.pendingLaunches().length, 1);
});

test('一次最外层事务只过一次所有权检查；提交、回滚、抛错之后都放掉；没有要投影的就不去检查', async t => {
  const { root, j } = await fixture(t), c = counting(); j.owner = c;
  j.recover(); assert.deepEqual([c.entered, c.released], [0, 0]);
  j.atomic(() => { j.write(root + '/a.json', '{}'); j.atomic(() => j.enqueueLaunch('r1', 's1')); });
  assert.equal(c.entered, c.released);
  const base = c.entered;
  assert.deepEqual(j.atomic(() => ({ error: 'no' })), { error: 'no' });
  assert.throws(() => j.atomic(() => { throw new Error('boom'); }), /boom/);
  assert.equal(c.entered, c.released); assert.equal(c.entered, base + 2);
});
```

- [ ] **Step 2: 跑一遍，确认失败**

Run: `node --test --test-name-pattern="主人活着时状态库|一次最外层事务" test/xin-state.test.cjs`
Expected: 第一个 FAIL（`j.atomic` 没有抛错）；第二个 FAIL（`entered` 是 0）。

- [ ] **Step 3: 实现**

`counting` 那个测试对「最外层事务算几次」的要求：一次最外层 `atomic`（连同它里面嵌套的 `atomic`、它提交后的 `recover`）进出各一次，所以 `writing` 要自己记深度，深度大于 0 时不再调 `owner.enter()`。

- [ ] **Step 4: 跑状态库和记忆的测试**

Run: `node --test test/xin-state.test.cjs test/xin-memory.test.cjs test/xin-memory-idle.test.cjs`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add site/xin/vm-state.mjs site/xin/vm-base.mjs site/xin/vm-memory.mjs test/xin-state.test.cjs
git commit -m "状态库的写入口先过所有权检查（旧模式下拿共享锁，主人活着或该内核当主人时不写）"
```

### Task 3: 控制器的一次性进程从头到尾拿着共享锁；文档；上线

**Files:**
- Modify: `site/xin/vm-agent.mjs`（`main()` 开头；`SENSITIVE_PATH`）
- Test: `test/xin-owner.test.cjs`
- Modify: `docs/CHANGES.md`、`docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md`（§6.6）

**Interfaces:**
- Consumes: Task 2 的 `ownership`（从 `vm-base.mjs` 导出）。
- Produces:
  - `main()` 里，第一件事：`process.argv[2]` 不在长时间运行的那几种（`run`、`agy-run`、`warm`、`memory-idle`、`callback`、`watchdog`、`login-window`、`pushq`）之内时，调 `ownership.hold()`。抛 `OwnerUnavailable` 时：`xin` 往标准错误写「小芯的状态正在切换，请稍后再试」并把退出码设成 1；`reap` 直接返回；其余往标准输出写 `{"error":"owner_unavailable","msg":"小芯的状态正在切换，请稍后再试"}` 后返回。都发生在 `journal.recover()` 之前。
  - 长时间运行的那几种不调 `hold()`，靠 Task 2 的逐次检查。
  - `SENSITIVE_PATH` 加上 `owner\.sqlite`。

- [ ] **Step 1: 写会失败的测试**（加在 `test/xin-owner.test.cjs`）

```js
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
const cli = (dir, op, args = {}) => spawnSync(process.execPath, [AGENT, op], { env: { ...process.env, XIN_HOME: dir }, input: JSON.stringify(args), encoding: 'utf8' });

test('旧模式：控制器照常工作，并建好 owner.sqlite', async t => {
  const dir = home(t), r = cli(dir, 'sessions');
  assert.deepEqual(JSON.parse(r.stdout), { sessions: [] });
  assert.equal(fs.statSync(path.join(dir, 'owner.sqlite')).mode & 0o777, 0o600);
});

test('主人活着：控制器回 owner_unavailable，状态库没有被建出来', async t => {
  const dir = home(t);
  await proc(t, dir, OWNER).line();
  assert.equal(JSON.parse(cli(dir, 'sessions').stdout).error, 'owner_unavailable');
  assert.equal(fs.existsSync(path.join(dir, 'workflow.sqlite')), false);
});

test('该内核当主人但它不在：控制器同样不写，不悄悄退回旧模式', async t => {
  const dir = home(t);
  const p = proc(t, dir, OWNER); await p.line(); p.child.kill('SIGKILL'); await p.exit();
  assert.equal(JSON.parse(cli(dir, 'sessions').stdout).error, 'owner_unavailable');
  assert.equal(fs.existsSync(path.join(dir, 'workflow.sqlite')), false);
});

test('owner.sqlite 打不开：控制器非零退出，状态库没有被建出来', async t => {
  const dir = home(t); fs.mkdirSync(path.join(dir, 'owner.sqlite'));
  const r = cli(dir, 'sessions');
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'workflow.sqlite')), false);
});
```

- [ ] **Step 2: 跑一遍，确认失败**

Run: `node --test --test-name-pattern="旧模式：控制器照常|主人活着：控制器|该内核当主人但它不在：控制器|打不开：控制器" test/xin-owner.test.cjs`
Expected: 第一个可能已经 PASS（Task 2 之后第一次写就会建出 `owner.sqlite`）；后三个 FAIL。

- [ ] **Step 3: 实现**（见 Interfaces）

- [ ] **Step 4: 跑所有权和控制器的主要测试**

Run: `node --test test/xin-owner.test.cjs test/xin.test.cjs test/xin-reliability.test.cjs test/xin-watch.test.cjs`
Expected: 全部 PASS。

- [ ] **Step 5: 量一下多出来的开销**

Run（改之前在 `git stash` 或上一个提交上跑一遍，改之后再跑一遍；`$D` 是一个空的临时目录）：

```bash
node -e "const {execFileSync}=require('child_process');const xs=[];for(let i=0;i<15;i++){const a=process.hrtime.bigint();execFileSync(process.execPath,['site/xin/vm-agent.mjs','sessions'],{input:'{}',env:{...process.env,XIN_HOME:process.argv[1]},stdio:['pipe','pipe','ignore']});xs.push(Number(process.hrtime.bigint()-a)/1e6);}xs.sort((a,b)=>a-b);console.log(xs[7].toFixed(0)+' ms')" "$D"
```

Expected: 中位数相差在 5 毫秒以内。把两个数写进修改清单。

- [ ] **Step 6: 文档**

`docs/CHANGES.md` 最上面加一条：做了什么、为什么线上行为不变、怎么验证的、参考（tmux `client.c` 的 `client_get_lock`；SQLite 文件锁文档）。设计文档 §6.6 改一处：执行进程的身份里已经带开机编号（`vm-base.mjs` 的 `processIdentity`），第 3 批不用再加。

- [ ] **Step 7: 全量验证，然后走上线流程**

Run: `npm run check`，再 `npm run test:e2e`
Expected: 都全过。然后提交、推送、开 PR、等 Actions 全绿、合并、确认正式站那次运行是绿的。
