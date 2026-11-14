# 待送达按对话分道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个对话在忙的时候，发给别的对话的话照样马上送到；同一个对话里仍然先来后到。

**Architecture:** 待送达（Durable Object 实例 `xin-inbox`，`src/xin-inbox.js` 的 `Inbox`）现在全局只有一个队首。改成每个对话一道，一句话只要排在自己那一道的最前面就能送。「电脑整体不可用」仍然挡住所有道，「这个对话在忙」只挡这一道。不动存储字段，不动 Worker 和网页。

**Tech Stack:** Cloudflare Worker / Durable Object（纯 JS，`src/xin-inbox.js`），`node:test`（`test/xin-inbox.test.cjs`）。

**Spec:** `docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md` §2.2（第 0 补批）。

> **实施时的修正（2026-11-14，自查发现）：** 下面写的是「只有控制器的临时错误记 `scope: 'lane'`，其余等待不带 `scope`、都算电脑整体不可用」。实际改成每种等待都明确记 `scope`：叫醒中、冷却、InstaBox 限流记 `'machine'`；控制器的临时错误和连不上、不明原因的错误记 `'lane'`。原因：不明原因的错误分不清是电脑坏了还是这一句有毒，按原写法一句怎么都送不进去的会把所有对话堵到 24 小时放弃为止（main 上不会）。旧行没有 `scope` 时按状态认：`waking`、`cooldown` 算电脑不可用，其余只挡自己。对应多了两个测试，「旧行」那个测试改成两种旧行都测。

## Global Constraints

- 基线是 PR #137 的头 `3599c2a`（本分支叠在它上面）。#137 加的保证全部保留：同一个对话不乱序、存储变更串行、旧租约的迟到回应不覆盖新尝试、冷却期间闹钟不空转。
- 不新增、不删除存储键；行里只在 `wait` 对象上多一个可选字段 `scope: 'lane'`。没有 Durable Object 迁移，不删队列。
- `src/xin.js` 的 `inboxReply`、`site/xin/chat.js` 不改。网页认识的等待状态仍是 `waking`、`cooldown`、`retrying`、`busy`。
- 原有测试一个不删。断言因为多了 `scope` 字段而要调整的，在提交说明里逐条写明。
- 回复用中文；提交说明用中文。
- 上线走 `CLAUDE.md` 的流程：`npm run check`、`npm run test:e2e` 全过 → PR → Actions 绿 → 合并 → 确认正式站那次运行是绿的。

## Review Focus

1. **上线那一刻已经存着的旧行。** 正式站现有的行，`wait` 里没有 `scope`。期望：不报错；按「电脑整体不可用」处理到它下一次重试为止（最多 10 分钟），重试之后带上正确的 `scope`。
2. **`args.sid` 不是字符串**（数字、对象、空串）。期望：`laneOf` 不抛错，按没有编号处理。
3. **连发两个新对话**（都没有 `sid`、没有 `main`），第一个临时失败。期望：第二个照样送到，互不相干。
4. **一道的队首 24 小时放弃。** 期望：同一道的下一句在同一轮闹钟里接着送。
5. **一道在长退避、另一道几秒后到期。** 期望：闹钟定在最早的那一道，不是跟着第一道等 10 分钟。

---

### Task 1: 按对话分道

**Files:**
- Modify: `src/xin-inbox.js`（`Inbox.attempt`、`settle`、`schedule`、`alarm`、`view`、`list`、`viewOf`；新增导出 `laneOf`、内部方法 `blocker`）
- Test: `test/xin-inbox.test.cjs`

**Interfaces:**
- Produces:
  - `export function laneOf(row): string`。`row.args.sid` 是非空字符串 → `'c:' + sid`；否则 `row.args.main` 为真 → `'main'`；否则 `'n:' + row.id`。
  - `Inbox.blocker(row, rows, now): row | null`。挡住 `row` 的那一行：先看有没有别的行处在「电脑整体不可用、还没到再试时间」（`state === 'pending' && wait && wait.scope !== 'lane' && nextAt > now`），有就返回其中 `nextAt` 最早的；否则返回同一道里排在它前面的第一句待送达；都没有返回 `null`。
  - `Inbox.viewOf(row, rows, now)`（原来第二个参数是全局队首）。待送达且有 `blocker` 时，`wait` 取 `blocker.wait`；`blocker.wait` 为空时取 `{ state: 'retrying', until: Math.max(blocker.nextAt, blocker.leaseUntil), msg: '前面那句还没送到' }`。
  - 控制器的临时错误（`busy`、`lock_failed`、`internal`）记成 `wait: { state: 'busy', scope: 'lane', until, msg }`。其余等待不带 `scope`。

测试文件里已有的帮手：`inbox({ deliver, budgetMs })` 返回 `{ ib, storage, clock, calls }`；`T0`、`H`、`DAY`、`tick()`。下面的 `A`、`B` 是两个不同的对话：

```js
const A = { text: '给 A', sid: 'sA' }, B = { text: '给 B', sid: 'sB' };
const BUSY = { ok: true, data: { error: 'busy', msg: '上一句还没做完，请稍后再试' } };
```

- [ ] **Step 1: 写会失败的测试（按对话分道）**

```js
test('一个对话在忙：发给别的对话的照样马上送到', async () => {
  const x = await inbox({ deliver: async row => row.args.sid === 'sA' ? BUSY : { ok: true, data: { run: 'rB' } } });
  const a = await x.ib.accept({ id: 'cid-lane-a001', op: 'send', args: A });
  const b = await x.ib.accept({ id: 'cid-lane-b001', op: 'send', args: B });
  assert.deepStrictEqual([a.view.state, a.view.wait.state, a.view.wait.scope], ['pending', 'busy', 'lane']);
  assert.strictEqual(b.view.state, 'delivered');
  assert.deepStrictEqual(x.calls.map(r => r.id), ['cid-lane-a001', 'cid-lane-b001']);
});

test('闹钟那一轮：一个对话的队首还在忙，别的对话到期的照送', async () => {
  let awake = false;
  const x = await inbox({ deliver: async row => !awake ? { ok: false, state: 'waking', retryAfter: 3 } : row.args.sid === 'sA' ? BUSY : { ok: true, data: { run: 'rB' } } });
  await x.ib.accept({ id: 'cid-lane-a002', op: 'send', args: A });
  await x.ib.accept({ id: 'cid-lane-b002', op: 'send', args: B });
  awake = true; x.clock.now = T0 + 3000;
  await x.ib.alarm();
  assert.strictEqual((await x.ib.view('cid-lane-b002')).state, 'delivered');
  assert.strictEqual((await x.ib.view('cid-lane-a002')).wait.state, 'busy');
  assert.strictEqual(x.storage.alarm, T0 + 3000 + 5000, '闹钟定在 A 那一道下次重试的时候');
});

test('连发两个新对话，第一个临时失败：第二个照样送到', async () => {
  const x = await inbox({ deliver: async row => row.args.text === '第一个' ? { ok: true, data: { error: 'internal', msg: '出错了' } } : { ok: true, data: { run: 'r2' } } });
  await x.ib.accept({ id: 'cid-new-00001', op: 'send', args: { text: '第一个' } });
  assert.strictEqual((await x.ib.accept({ id: 'cid-new-00002', op: 'send', args: { text: '第二个' } })).view.state, 'delivered');
});

test('一道在长退避、另一道几秒后到期：闹钟定在最早的那一道', async () => {
  const x = await inbox({ deliver: async row => row.args.sid === 'sA' ? BUSY : { ok: true, data: { error: 'internal', msg: '出错了' } } });
  await x.ib.accept({ id: 'cid-lane-a003', op: 'send', args: A });
  for (const at of [5, 20, 50, 110, 230, 530]) { x.clock.now = T0 + at * 1000; await x.ib.alarm(); }   // A 退避到 10 分钟一次
  const t = x.clock.now;
  await x.ib.accept({ id: 'cid-lane-b003', op: 'send', args: B });
  assert.strictEqual(x.storage.alarm, t + 5000);
});
```

- [ ] **Step 2: 跑一遍，确认是因为「全局队首」而失败**

Run: `node --test --test-name-pattern="一个对话在忙|闹钟那一轮：一个对话|连发两个新对话|一道在长退避" test/xin-inbox.test.cjs`
Expected: 4 个都 FAIL。第一个的失败信息里 `b.view.state` 是 `'pending'`（期望 `'delivered'`）。

- [ ] **Step 3: 写保持住的测试（同一道不乱序、电脑不可用时挡住所有道、Review Focus）**

这几条有的在基线上就能过。它们钉住的是这次改动不能弄坏的东西，先写好，改完再跑一遍。

```js
test('laneOf：有编号按编号，主对话的第一句一道，其余新对话各自一道；编号不是字符串也不抛错', async () => {
  const { laneOf } = await load('../src/xin-inbox.js');
  assert.strictEqual(laneOf({ id: 'i1', args: { sid: 'sA' } }), 'c:sA');
  assert.strictEqual(laneOf({ id: 'i1', args: { main: true } }), 'main');
  assert.strictEqual(laneOf({ id: 'i1', args: { sid: 'sA', main: true } }), 'c:sA');
  assert.strictEqual(laneOf({ id: 'i1', args: {} }), 'n:i1');
  for (const sid of [42, {}, '', null]) assert.strictEqual(laneOf({ id: 'i2', args: { sid } }), 'n:i2');
  assert.strictEqual(laneOf({ id: 'i3' }), 'n:i3');
});

test('同一个对话里：前面那句还在路上，后面那句不越过去，显示「前面那句还没送到」', async () => {
  let release;
  const x = await inbox({ budgetMs: 1, deliver: () => new Promise(r => { release = r; }) });
  await x.ib.accept({ id: 'cid-same-0001', op: 'send', args: A });
  const second = await x.ib.accept({ id: 'cid-same-0002', op: 'send', args: { ...A, text: '第二句' } });
  assert.deepStrictEqual([second.view.state, second.view.wait.state, second.view.wait.msg], ['pending', 'retrying', '前面那句还没送到']);
  assert.strictEqual(x.calls.length, 1);
  release({ ok: true, data: { run: 'r1' } });
  for (let i = 0; i < 5; i++) await tick();
});

test('电脑在冷却：别的对话的新消息也不去试，显示冷却，闹钟定在冷却结束；结束后按先后都送到', async () => {
  let ready = false;
  const x = await inbox({ deliver: async () => ready ? { ok: true, data: { run: 'r' } } : { ok: false, state: 'cooldown', retryAfter: 3600 } });
  await x.ib.accept({ id: 'cid-cool-a001', op: 'send', args: A });
  const b = await x.ib.accept({ id: 'cid-cool-b001', op: 'send', args: B });
  assert.deepStrictEqual([b.view.state, b.view.wait.state], ['pending', 'cooldown']);
  assert.deepStrictEqual(x.calls.map(r => r.id), ['cid-cool-a001']);
  assert.strictEqual(x.storage.alarm, T0 + H);
  ready = true; x.clock.now = T0 + H;
  await x.ib.alarm();
  assert.deepStrictEqual(x.calls.map(r => r.id), ['cid-cool-a001', 'cid-cool-a001', 'cid-cool-b001']);
  assert.strictEqual((await x.ib.view('cid-cool-b001')).state, 'delivered');
});

test('叫不醒：这一轮只试最前面那一句，不挨个对话去撞', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'waking', retryAfter: 3 }) });
  await x.ib.accept({ id: 'cid-wake-a001', op: 'send', args: A });
  await x.ib.accept({ id: 'cid-wake-b001', op: 'send', args: B });
  x.clock.now = T0 + 3000; await x.ib.alarm();
  assert.deepStrictEqual(x.calls.map(r => r.id), ['cid-wake-a001', 'cid-wake-a001']);
});

test('上线前存着的旧行（wait 里没有 scope）：不报错，等到它下一次重试，之后带上 scope', async () => {
  const x = await inbox({ deliver: async row => row.args.sid === 'sA' ? BUSY : { ok: true, data: { run: 'rB' } } });
  await x.storage.put('inbox:meta', { v: 1 }); await x.storage.put('inbox:seq', 1);
  await x.storage.put('inbox:row:cid-old-00001', { id: 'cid-old-00001', op: 'send', args: A, digest: 'd', seq: 1, state: 'pending', attempts: 1, backoff: 1, nextAt: T0 + 5000, leaseUntil: 0, createdAt: T0 - 1000,
    firstAttemptAt: T0 - 1000, deliveredAt: 0, finishedAt: 0, result: null, wait: { state: 'busy', until: T0 + 5000, msg: '上一句还没做完' }, error: null, acked: false, woke: false });
  assert.strictEqual((await x.ib.accept({ id: 'cid-old-b0001', op: 'send', args: B })).view.state, 'pending');
  x.clock.now = T0 + 5000; await x.ib.alarm();
  assert.strictEqual((await x.storage.get('inbox:row:cid-old-00001')).wait.scope, 'lane');
  assert.strictEqual((await x.ib.view('cid-old-b0001')).state, 'delivered');
});

test('一道的队首 24 小时放弃：同一道的下一句在同一轮接着送', async () => {
  let ok = false;
  const x = await inbox({ deliver: async () => ok ? { ok: true, data: { run: 'r' } } : BUSY });
  await x.ib.accept({ id: 'cid-give-0001', op: 'send', args: A });
  x.clock.now = T0 + DAY - 1000;
  await x.ib.accept({ id: 'cid-give-0002', op: 'send', args: { ...A, text: '第二句' } });
  ok = true; x.clock.now = T0 + DAY + 1;
  await x.ib.alarm();
  assert.strictEqual((await x.ib.view('cid-give-0001')).error.code, 'gave_up');
  assert.strictEqual((await x.ib.view('cid-give-0002')).state, 'delivered');
});
```

- [ ] **Step 4: 跑一遍，记下哪些已经过、哪些还没过**

Run: `node --test test/xin-inbox.test.cjs`
Expected: Step 1 的 4 个 FAIL；`laneOf` 那个 FAIL（还没有这个导出）；`旧行` 那个 FAIL（没有 `scope`）；`同一个对话里` 那个 FAIL（文案是「前面还有消息等待送达」）。其余新加的和全部原有的 PASS。

- [ ] **Step 5: 实现**

在 `src/xin-inbox.js` 里：

1. 新增 `export function laneOf(row)`（见 Interfaces）。
2. 新增 `Inbox.blocker(row, rows, now)`（见 Interfaces）。
3. `settle`：`TRANSIENT` 那一支的等待加 `scope: 'lane'`。
4. `attempt`：认领条件从「是全局队首」改成「`due` 且 `blocker(...) === null`」；两处取视图改成 `viewOf(row, rows, now)`。
5. `schedule`：没有待送达就删闹钟。否则，`block` = 处在「电脑整体不可用」的行里最早的 `nextAt`（没有就是 0）；每一道的队首给一个时间：租约没到期用 `leaseUntil`，否则 `Math.max(nextAt, block)`；闹钟定在这些时间和各队首 `createdAt + GIVE_UP_MS + 1` 里最早的，且不早于 `now + 1000`。
6. `alarm` 的第二个循环：按 `seq` 走每一行。放弃检查照旧，对每一行都做。用一个集合记「这一轮已经卡住的道」，用一个标记记「电脑整体不可用，这一轮不再试」（循环开始前，只要有行处在「电脑整体不可用、还没到再试时间」就先置上）。一行所在的道没卡住、标记没置上时：没到期就把这一道记成卡住；到期就 `attempt(row.id, 0)`，送完还是待送达就把这一道记成卡住，它的 `wait.scope !== 'lane'` 时把标记置上。循环里用 `continue`，不用 `break`，这样后面的行还能做放弃检查。
7. `view`、`list`：改用 `viewOf(row, rows, now)`。

- [ ] **Step 6: 跑待送达的全部测试**

Run: `node --test test/xin-inbox.test.cjs`
Expected: 全部 PASS。原有断言里对 `wait` 做整对象比较、因为多了 `scope` 而不过的，把期望值补上 `scope: 'lane'`，不改别的。

- [ ] **Step 7: 用设计里的探针再量一次**

Run: `node /tmp/claude-0/-home-user-liming-work-site/5ec1646c-24b0-5ff4-9220-6b9bb57c5c9c/scratchpad/pr137/probe-hol.mjs /home/user/liming-work-site`
Expected: `刚发完：A pending "busy" ｜B delivered null`，`B 送到用了 0 分钟`。

- [ ] **Step 8: 提交**

```bash
git add src/xin-inbox.js test/xin-inbox.test.cjs
git commit -m "待送达按对话分道：一个对话在忙不再堵住别的对话，同一个对话仍然先来后到"
```

### Task 2: 文档、全量验证、上线

**Files:**
- Modify: `docs/CHANGES.md`（最上面那一条 2026-11-14 里加一段）、`README.md`（「小芯后台运行方式」2026-11-14 那一行里把「统一按队首顺序」改准确）、`docs/xin-kernel-design.md` §16 最后一条

- [ ] **Step 1: 改文档**

`docs/CHANGES.md` 最上面那一条的「待送达」一段后面加一条，写明：实测到的退步（main 立刻送到、#137 的头要等 49 分钟）、改法（按对话分道，电脑整体不可用仍然挡住所有道）、参考（OpenClaw 命令队列：每个会话一次一轮）、上线时已存着的旧行怎么处理。`README.md` 那一行把「统一按队首顺序」改成「按对话分道：同一个对话先来后到，一个对话在忙不堵别的对话」。

- [ ] **Step 2: 全量检查**

Run: `npm run check`
Expected: 全过，0 失败，0 跳过。

- [ ] **Step 3: 浏览器测试**

Run: `CHROMIUM_PATH=<本机 /opt/pw-browsers 里的 chrome> npm run test:e2e`
Expected: 12 组全过，退出码 0。

- [ ] **Step 4: 提交、推送、开 PR**

PR 的基线是 `main`，内容是 #137 的两个提交、第 2 步设计、这次的修复。说明里写清：包含 #137 的全部内容（它合并后 #137 可以关掉）、实测数字、没有删测试、没有存储迁移。

- [ ] **Step 5: 等 Actions（check、e2e、测试站部署和冒烟）全绿后合并，确认正式站那次运行是绿的，再汇报**
