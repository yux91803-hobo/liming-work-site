# 正式站状态切到内核模式（第 2 步第 2 批）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内核模式下由内核外壳拉起并看住唯一的状态进程，网页的每次操作和每次轮询经本机套接字交给它，不再起控制器进程；Worker 用 `XIN_STATE_OWNER` 和 Durable Object 发的部署代号决定模式，正式站切到内核模式。

**Architecture:** 外壳 `vm-kernel.mjs` 新增「状态进程看护」：收到带期望（模式 + 代号）的请求就按期望拉起 `node vm-agent-<hash>.mjs serve --parent-pipe`、停掉或换版本；同版本的请求走 `~/.xin/run/state.sock`，别的照旧起控制器（那一版控制器自己经桥交给主人）。状态进程正常退出一律把记录交回 legacy，被强杀时外壳替它改回 legacy，所以任何空档都由旧路径（`flock`）照常服务，锁保证同一时刻只有一个写者。Worker 把期望放进每次 `/xin/op` 请求，代号由 Durable Object 在看到新部署时加一。

**Tech Stack:** Node 22（`node:net`、`node:sqlite`、`node:test`），Cloudflare Workers（`version_metadata` 绑定、Durable Object 存储），Playwright（Python）浏览器测试。不加依赖。

**Spec:** `docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md` §6.2（「交不过去就稍等再按表重新判断」）、§6.4、§6.6（定时检查的间隔）、§6.7、§6.8、§6.9、§7 第 2 批、§8、§9。站长 2026-11-14 确认设计（「按你的推荐来」），2026-11-15 说「你继续吧」。设计 §7：**这一批合并前先告诉站长。**

## 开工前核对的现状（main `92df28a`，2026-11-15）

- 已有：`serve` 状态进程（`vm-kernel-state.mjs`，定时跑 `maintainState`）、`owner.sqlite` 锁和记录、两层桥（`lockedCall`、`journal.write/append/named`）、内核模式下别的进程不再派发、`test:kernel` 用真状态进程跑 13 组控制器测试、持久外壳服务。
- 缺的：外壳不认识状态进程，`/xin/op` 和流里的 `poll` 每次都起控制器；没人拉起和看住状态进程；Worker 没有 `XIN_STATE_OWNER`、没有部署代号；`serve` 正常退出时记录留在 `kernel`（回滚到第 1 批时第 1 批的 Worker 不发期望，记录留在 `kernel` 又没有主人，旧版就写不进）；桥交不过去时直接报错，没有「稍等再判断」；定时检查固定 5 秒。
- 正式站：`XIN_TRANSPORT=kernel`、`XIN_INBOX=1`，所有权记录为空（legacy，epoch 0），没有 `serve` 进程（2026-11-15 03:03 只读核对）。

## 这一批我定的（和设计文字不同或设计没写到的，站长可以改）

1. **状态进程正常退出（管道断开、SIGTERM、排空）一律把记录交回 legacy。** 设计只在「切回旧模式」时写 legacy。原因：外壳重启、升级、回滚到第 1 批时，记录留在 `kernel` 又没有主人，旧路径写不进；交回 legacy 后空档由旧路径服务，锁保证单写者。代价：外壳每重启一次切换次数加 2。
2. **状态进程被 `kill -9`（记录留在 `kernel`）时，外壳马上跑 `node <agent> owner-legacy` 把记录改回 legacy 再退避重起。** 设计写的是 Worker 3 分钟后经 exec 改。
3. **「连续 3 分钟起不来就切回旧模式」放在外壳里判断**：只认状态进程真的起不来（端口不通的情况外壳自己就不在，自然不算），按代号记住「这一代放弃了」，代号变大（新部署）才再试；放弃时外壳起一次 `pushq` 推送告诉站长；用量页显示。设计写的是 Worker 判断、记在 Durable Object。效果相同（换部署才清掉），少一份跨网络的状态。
4. **部署代号由 Durable Object 发**：`/kernel/config` 时看 `CF_VERSION_METADATA.id`，和存的不一样就把代号加一（回滚也是一次新部署，所以也加一）。外壳只认不比已见代号小的期望，新旧两版 isolate 同时在线时不会来回切。
5. **流仍然调 `poll`，只是改走套接字**；外壳直接读事件文件留给以后。`poll` 在状态进程里实测 0.1–0.25 毫秒，不值得复制一份 `readRunFrom`。目标「一次 poll 不起控制器进程」照样达到。
6. **状态进程启动中，同版本的请求最多等 15 秒再走**（等不到才起控制器），免得切换窗口里起的旧路径进程撞上独占锁等待。
7. **请求里的控制器版本和状态进程的不同（旧 isolate、刚部署），照旧起控制器**，由那一版自己经桥交给主人。
8. **切换前的一致备份**（设计 §6.9 第 2 步）：只在「从 legacy 拿到所有权」时做，一天最多一次，放 `~/.xin/backups/owner-switch/`（目录 0700、文件 0600），留最新两份。
9. **硬上限**：外壳等一个操作 40 秒没回就先回「不确定」（和今天起控制器的上限一样）；60 秒还没回就杀掉状态进程，由看护按第 2 条接着处理。
10. **不在这一批做**：退回 exec / 退回轮询的次数进用量页、拿不到内核配置时的冷却、送到后清掉待送达原文（设计 §6.8「顺手」三条）；状态进程按内存阈值自己重启（§6.4，先在健康检查里报 `rss`，上线后看数据再定）；收尾暂存和按墙上时间判断暂停恢复（第 3 批）。

## Global Constraints

- `vm-agent.mjs` 行数不超过 3217（`test/xin-writers.json` 的 `agentLines`，只减不增）。要加的放进 `vm-kernel-*.mjs`，必要时把 `forwardCLI`、`inputArgs` 挪进 `vm-kernel-client.mjs` 腾行。
- `vm-kernel.mjs` 只用 Node 内置模块、不 import 别的 `vm-*.mjs`（Worker 单独按哈希上传它）。它要用的桥协议号写成常量 `BRIDGE_PROTOCOL = 1`，测试核对和 `vm-kernel-owner.mjs` 的一致。
- 冷启动读模块的子请求不超过测试的 40 报警线（现在 29；这一批不新增被 `vm-agent.mjs` 引用的模块）。
- 内核模式下不能出现两个写者；所有权判断每次重来、不缓存（§6.2）。桥只重试「确定没执行」的失败（`executed === false`），「不确定」的不自动重来。
- `/xin/op` 请求体新增可选字段 `owner: { mode: 'kernel' | 'legacy', gen: 非负安全整数 }`；旧外壳忽略它；新外壳收到格式不对的回 400。
- 故障测试只在临时目录、用合成数据；正式电脑只做只读核验和正常的上线联调。
- 仓库公开、Actions 日志任何人都能看：新加的日志只写事件名、代号、退出码、耗时，不写请求内容、令牌、邮箱。
- 原有测试一个不删、不跳过。因为第 1 条改了「正常退出后的记录」，凡是断言旧行为的地方在 `docs/CHANGES.md` 写明原实现、原因和新保证。
- 改了用量页：四个宽度（1280、1024、768、390）、浅色深色截图自查。
- 提交说明和文档用中文；提交结尾带本会话的 `Co-Authored-By` 和 `Claude-Session` 两行。

## Review Focus

1. **电脑暂停后恢复，墙上时钟一下跳了几个小时。** 期望：状态进程不退出，之后的请求照常回答，不卡住。→ Task 3「墙上时钟往前跳」。
2. **刚部署时新旧两版的 isolate 同时在发请求，期望不一样。** 期望：模式只跟代号大的走，不来回切。→ Task 2「代号小的期望不改模式」、Task 4「部署代号」。
3. **切换的那一刻，正在跑的执行进程来报告结果**（主人拿了锁还没开始听）。期望：稍等以后交给主人，或者在记录改回 legacy 后走旧路径，报告只做一次、不报错。→ Task 1「retryUnsent」、Task 3「切换窗口里来写」。
4. **上线失败、自动回滚到第 1 批**（第 1 批的 Worker 不发期望，第 1 批的外壳不认识状态进程）。期望：状态进程排空后记录是 legacy，第 1 批照常写。→ Task 3「外壳关掉」。
5. **没人用的时候，常驻的状态进程不能让电脑一直醒着**（InstaBox 按 CPU 有没有负载判断空闲）。期望：没活时一分钟才检查一次。→ Task 1「空闲时一分钟一检」；上线后再只读核对电脑照常自动暂停。

---

### Task 1: 状态进程这一侧：正常退出交回 legacy、桥稍等再判断、空闲一分钟一检、切换前备份

**Files:**
- Modify: `site/xin/vm-kernel-client.mjs`（新增 `retryUnsent`、`syncSleep`；可接收从 `vm-agent.mjs` 挪来的 `forwardCLI`、`inputArgs`）
- Modify: `site/xin/vm-state.mjs:25-37`（`writing()` 用 `this.retryUnsent` 包住整段判断）
- Modify: `site/xin/vm-base.mjs:15`（`journal.retryUnsent = retryUnsent`）
- Modify: `site/xin/vm-kernel-state.mjs`（`initialize(before)` 收到拿锁前的记录；控制命令 `health` 加 `nextTickMs`、`rss`；新增 `snapshotBeforeSwitch`）
- Modify: `site/xin/vm-agent.mjs`（`lockedCall` 用 `retryUnsent` 包住判断；抽出并导出 `pendingWork()` 给看门狗和 `maintainState` 共用，`maintainState` 返回 `pendingWork() ? 5000 : 60000`；`serve` 收到 SIGTERM、SIGINT、管道结束时 `service.close({ legacy: true })`；`initialize` 在 `before.mode === 'legacy'` 时调 `snapshotBeforeSwitch`；新命令 `owner-legacy`）
- Modify: `test/xin-writers.json`（登记备份目录和文件的写入）
- Test: `test/xin-kernel-client.test.cjs`、`test/xin-state-bridge.test.cjs`、`test/xin-state-controller.test.cjs`

**Interfaces:**
- Produces: `retryUnsent(fn, { deadlineMs = 30000, clock = () => performance.now(), sleep = syncSleep } = {})`：只在 `fn` 抛 `executed === false`、且 `code` 不是 `state_request`、`state_too_large`、`state_protocol` 时重跑 `fn`，间隔 50、100、200、400、800、1000、1000… 毫秒，过了期限抛最后一次的错。
- Produces: `snapshotBeforeSwitch(db, home, { now = Date.now(), everyMs = 86400000, keep = 2 }) -> string | null`：`VACUUM INTO` 到 `home/backups/owner-switch/workflow-<now>.sqlite`，跳过时返回 `null`。
- Produces: 命令 `node vm-agent.mjs owner-legacy`，标准输出一行 JSON，退出码 0：主人活着 `{"error":"owner_busy"}`；记录是 `kernel` 且没人拿着 `{"ok":true,"mode":"legacy","epoch":n}`；本来就是 legacy `{"ok":true,"unchanged":true,"mode":"legacy","epoch":n}`。
- Produces: `serve` 正常退出的语义：排空 → 投影刷完 → 记录 `legacy`、`epoch + 1` → 退出码 0。
- Produces: 状态进程控制命令 `{kind:'control',op:'health'}` 的结果 `{ pid, epoch, protocol, up, active, draining, nextTickMs, rss }`。

- [ ] **Step 1: 写失败的测试**

`test/xin-kernel-client.test.cjs`：
```js
test('retryUnsent：确定没执行的稍等再判断；不确定的不重来；过了期限照常抛', () => {
  // fn 前两次抛 {code:'owner_unavailable', executed:false}，第三次返回 'ok' → 返回 'ok'，调了 3 次
  // fn 抛 {code:'state_timeout', executed:'unknown'} → 立刻抛，调了 1 次
  // fn 抛 {code:'state_request', executed:false} → 立刻抛，调了 1 次
  // fn 一直抛 executed:false，deadlineMs:300，用假 clock/sleep → 抛 owner_unavailable，假时钟走过 ≥300
});
```
`test/xin-state-bridge.test.cjs`：
```js
test('切换前的一致备份：一天最多一次，留最新两份，目录 0700、文件 0600', () => {
  // 临时库写一行；第一次返回文件路径且能读出那一行；同一天再调返回 null；now+25h 返回新文件；now+50h 再一份后目录里只剩 2 个
});
```
`test/xin-state-controller.test.cjs`（真 `serve`，临时目录）：
```js
for (const how of ['管道结束', 'SIGTERM']) test('状态进程正常退出（' + how + '）：排空后记录交回 legacy，旧路径马上能写', async t => {
  // 起 serve（stateMode 帮手）→ 记录 kernel、epoch 1；按 how 结束 → 退出码 0；Ownership.record() → mode 'legacy'、epoch 2；f.cli('sessions') 没有 error
});
test('owner-legacy：主人活着不改；被 kill -9 后把 kernel 改回 legacy；本来就是 legacy 不动', async t => {
  // 活着 → {error:'owner_busy'}；SIGKILL 后 → {ok:true,mode:'legacy',epoch:2}；再跑 → {ok:true,unchanged:true,...}
});
test('空闲时一分钟一检，有活时五秒：pendingWork 看后台任务、待派发、待发通知、交接和控制器回调', () => {
  // 子进程里 import vm-agent.mjs 的 pendingWork（XIN_HOME 指临时目录）：空目录 false；enqueueLaunch 一轮后 true
});
test('从 legacy 拿到所有权时先备份一份；从 kernel 记录接回不备份', async t => {
  // 第一次 serve → backups/owner-switch 下 1 个文件；kill -9 后再 serve（拿锁前记录是 kernel）→ 还是 1 个
});
test('切换窗口里来写（主人拿了锁还没开始听）：稍等后交给主人，只写一次', async t => {
  // 一个脚本 take() 拿独占锁但不听套接字；后台子进程用 vm-memory 写一条记忆；300 毫秒后杀掉那个脚本、起真的 serve
  // → 子进程退出码 0；记忆里那一条只有 1 份
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/xin-kernel-client.test.cjs test/xin-state-bridge.test.cjs test/xin-state-controller.test.cjs`
Expected: 新加的几项 FAIL（`retryUnsent is not a function`、`owner-legacy` 不认识、正常退出后记录还是 `kernel`、没有备份文件、切换窗口里写的子进程退出码 1）。

- [ ] **Step 3: 实现**

按 Interfaces 实现。`lockedCall` 和 `writing()` 都是「每次重跑整段判断」：重试时先重新看是不是主人、记录是什么，不能只重发套接字请求。`owner-legacy` 调 `ownership.set('legacy')` 之前先 `record({waitMs:0})`：`busy` 回 `owner_busy`，已经是 legacy 回 `unchanged`。`snapshotBeforeSwitch` 用 `db.prepare('VACUUM INTO ?').run(file)`，先写 `.tmp` 再改名。

- [ ] **Step 4: 跑测试，确认通过，再跑全量**

Run: `node --test test/xin-kernel-client.test.cjs test/xin-state-bridge.test.cjs test/xin-state-controller.test.cjs && npm run check && npm run test:kernel`
Expected: 全部 PASS；`xin-writers` 测试 `agentLines` 不超过 3217。

- [ ] **Step 5: 提交**

```bash
git add site/xin test/xin-kernel-client.test.cjs test/xin-state-bridge.test.cjs test/xin-state-controller.test.cjs test/xin-writers.json
git commit -m "feat(xin): 状态进程正常退出交回旧模式，桥稍等再判断，空闲一分钟一检"
```

### Task 2: 外壳看住状态进程，操作和轮询走本机套接字

**Files:**
- Modify: `site/xin/vm-kernel.mjs`
- Modify: `test/xin-kernel.test.cjs`（假控制器加 `serve`、`owner-legacy`、`pushq`；新测试）
- Modify: `test/xin-writers.json`（如有新写入）

**Interfaces:**
- Consumes: Task 1 的 `serve` 退出语义、`owner-legacy`、状态进程 `health` 控制命令。
- Produces（`vm-kernel.mjs` 导出）：
  - `BRIDGE_PROTOCOL = 1`。
  - `stateCall(home, request, { timeoutMs }) -> Promise<any>`：一行 JSON 发到 `home/run/state.sock`，带 `v`、随机 `id`；失败 reject `{ code, executed }`（没连上 `executed:false`，发出后断开或超时 `'unknown'`），和 `vm-kernel-client.mjs` 的 `requestState` 同一协议。
  - `createStateKeeper({ home, env, clock = () => performance.now(), backoffMs = [1000, 2000, 5000, 10000, 30000, 60000], giveUpMs = 180000, readyMs = 60000, hardMs = 60000, log = () => {}, spawnImpl = spawn })`，返回：
    - `want({ mode, gen, agent }) -> boolean`：`gen` 小于已见代号就不理、返回 false；否则记下期望并开始调整。
    - `route(agent) -> 'socket' | 'wait' | 'spawn'`：在跑且版本相同 `socket`；启动中且版本相同 `wait`；其余 `spawn`。
    - `ready(agent, ms) -> Promise<boolean>`。
    - `call(request, { timeoutMs }) -> Promise<any>`：经 `stateCall`；`hardMs` 到了还没回就 `SIGKILL` 状态进程。
    - `summary() -> { want, mode, epoch, phase, gen, agent, up, restarts, failures, lastError, fallback, spawns }`：`mode` 只有 `phase === 'running'` 时是 `'kernel'`；`agent` 是 12 位哈希或 `null`；`phase` 是 `off | starting | running | stopping | waiting | fallback`。
    - `close() -> Promise<void>`：结束状态进程的标准输入，不等它排空。
  - `createKernel(...)` 新增选项 `keeper`（传给 `createStateKeeper` 的选项）和 `readyWaitMs = 15000`。
  - `/xin/op` 回应都带 `owner: summary`；`op === 'usage'` 时再带 `ops: { all: { n, p50, p95, max }, byOp: { <操作名>: { n, p50, p95, max } } }`（走套接字的操作，每个操作名留最近 200 次的毫秒数）。
  - 主人暂时不在：HTTP 503 `{ ok:false, executed:false, error:'owner_unavailable', retryAfter:3, owner }`。不确定：HTTP 200 `{ ok:false, executed:'unknown', error }`。
  - `/xin/health`：`{ ok, kernel, pid, up, spawns, owner, ops }`。
  - 日志（`kernel.jsonl`）新事件 `{ route:'state', event:'start'|'ready'|'exit'|'reset'|'giveup'|'stop', agent, epoch, code, signal, ms }`，不写请求内容。

规则（实现时照做）：
- 拉起：`spawnImpl(process.execPath, [agent, 'serve', '--parent-pipe'], { env: { ...env, XIN_HOME: home }, stdio: ['pipe','pipe','pipe'] })`；标准输出第一行 `{"ready":true,...}` 算起来了；`readyMs` 内没起来就杀掉、算一次失败。
- 起来以前退出：算失败，`lastError` 取标准错误里第一个 `state_*` / `owner_*`，没有就写 `exit <code>`，按 `backoffMs` 重起。
- 起来以后意外退出：先跑 `node <agent> owner-legacy`（10 秒上限），记 `reset`，再按退避重起。连续跑满 60 秒，失败次数清零。
- 想要 `kernel` 却从第一次失败起 `giveUpMs` 内一次都没跑起来：`phase = 'fallback'`，记下这一代号，起一次 `node <agent> pushq '{"title":"小芯","body":"常驻状态进程起不来，已自动改回旧方式：<lastError>","tag":"xin-owner","url":"/#xin"}'`，不再重起；`want` 来了更大的代号才重新开始。
- 期望变成 `legacy`、或代号更大且版本不同：结束标准输入让它排空，60 秒没退就 `SIGKILL` 再 `owner-legacy`；版本不同的接着按新期望拉起。
- `/xin/op`：先 `want`（有 `owner` 字段时），再 `route`；`wait` 时 `await ready(agent, readyWaitMs)` 后重新 `route`。流里每次 `poll` 也按 `route` 走。`spawns` 在 `runAgent` 里加一。

- [ ] **Step 1: 写失败的测试**（`test/xin-kernel.test.cjs`，假控制器的 `serve` 在 `XIN_HOME/run/state.sock` 上按同一协议回 `{via:'state',op,args}`，用 `XIN_HOME` 下的标记文件控制「起不来」「延迟就绪」「不回答」并计数 `owner-legacy`、`pushq`）
```js
test('期望 kernel：拉起状态进程，之后同版本的操作和轮询走套接字，不再起控制器', ...);
  // health.owner.phase === 'running'；记下 spawns；再 10 次 op + 一次流（含 poll）后 spawns 不变；op 回 data.via === 'state'
test('代号小的期望不改模式；同代号要 legacy 就排空停下；代号更大再拉起', ...);
  // want gen 2 kernel → running；gen 1 legacy → 不理（还是 running）；gen 2 legacy → 状态进程退出、phase 'off'；gen 3 kernel → 又 running
test('状态进程被 kill -9：先改回 legacy 再按退避重起', ...);
  // owner-legacy 计数 1；回到 running；summary.restarts >= 1；日志里有 reset
test('一直起不来：超过期限放弃这一代号并推送一次；代号更大再试', ...);
  // keeper: { giveUpMs: 800, backoffMs: [50, 100] }；serve 退出 1 并在标准错误写 state_compat → phase 'fallback'、fallback true、lastError 'state_compat'、pushq 计数 1；再等 500 毫秒没有新的 serve；gen+1 后又开始拉起
test('启动中的同版本请求等它准备好；等不到就照旧起控制器', ...);
  // 就绪延迟 300 毫秒、readyWaitMs 2000 → via 'state'；就绪延迟 3 秒、readyWaitMs 200 → 走起进程
test('请求的控制器版本和状态进程的不同：照旧起控制器', ...);
test('操作超过上限：先回「不确定」，到硬上限杀掉状态进程并重起', ...);
  // opTimeoutMs 200、hardMs 400、状态进程收到 hang 不回答 → executed 'unknown'；之后 restarts 加一
test('状态进程回「排空中」：503 owner_unavailable，不起控制器', ...);
test('外壳关掉：状态进程收到管道结束自己退出', ...);
test('健康检查和 usage 的回应带上主人状态和各操作耗时', ...);
test('owner 字段格式不对：400', ...);
test('桥协议号和 vm-kernel-owner.mjs 的一致', ...);
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/xin-kernel.test.cjs`
Expected: 新加的各项 FAIL（`createStateKeeper` 不存在、回应里没有 `owner`、操作照旧起控制器）。

- [ ] **Step 3: 按 Interfaces 和规则实现 `vm-kernel.mjs`**

- [ ] **Step 4: 跑测试，确认通过，再跑全量**

Run: `node --test test/xin-kernel.test.cjs && npm run check`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add site/xin/vm-kernel.mjs test/xin-kernel.test.cjs test/xin-writers.json
git commit -m "feat(xin): 内核外壳看住状态进程，操作和轮询走本机套接字"
```

### Task 3: 外壳加真状态进程：切换、故障、时钟跳变

**Files:**
- Create: `test/xin-kernel-owner.test.cjs`
- Create: `test/helpers/clock-jump.cjs`（`--require` 预载：`XIN_HOME/clock-jump` 文件出现后 `Date.now()` 加上文件里的毫秒数）

**Interfaces:**
- Consumes: Task 1、Task 2 的全部。外壳用 `createKernel({ home, env, keeper, readyWaitMs })`；控制器目录 `home/agent/` 里放软链接 `vm-agent-0123456789ab.mjs → site/xin/vm-agent.mjs`（第二个版本用 `vm-agent-0123456789ac.mjs`）；假的 `codex` 等命令照 `test/xin-state-controller.test.cjs` 的 `fixture`；结束时 `stopOwned`。

- [ ] **Step 1: 写测试**
```js
test('内核模式：send、poll、sessions、tasks 都不起控制器；结果和旧模式一样', ...);
  // 同一串操作分别在不带期望（legacy）和带 kernel 期望的外壳上跑：回答的形状一样；kernel 那边 spawns 在 ready 之后不变
test('带编号的 send：执行前被杀重送只成一轮；执行后被杀重送拿到同一回执；同编号不同内容报冲突', ...);
  // 执行前：SIGSTOP 状态进程 → 发 send → SIGKILL → 回「不确定」或主人不在 → 重起后重送 → 只有 1 轮
  // 执行后：send 回了以后 SIGKILL → 重起后重送 → 同一 run；不同内容 → message_conflict
test('状态进程被 kill -9 的空档里，旧路径照常写；重起后回到内核，切换次数变大', ...);
test('外壳关掉：状态进程排空、记录回 legacy；不发期望的旧外壳照常起控制器写（模拟回滚到第 1 批）', ...);
test('墙上时钟在状态进程里往前跳 2 小时：之后的请求照常回答，状态进程不退出', ...);
  // keeper 的 env 加 NODE_OPTIONS=--require=test/helpers/clock-jump.cjs；写入 7200000 后 20 次 sessions 都在 2 秒内回答；pid 不变
test('控制器不停起退时拉起状态进程：20 轮都能起来，没有 state_compat', ...);
  // 后台不停起 node vm-agent sessions；20 次 want legacy / want kernel 交替，每次 kernel 都 running
test('反复调用 2000 次：状态进程的内存和打开的文件不一直涨', ...);
  // 设计 §9：前 200 次后记下 health 的 rss 和 /proc/<pid>/fd 个数；2000 次后 rss 多出不到 30 MB、fd 个数不多于原来 + 2
```

- [ ] **Step 2: 跑测试**

Run: `node --test test/xin-kernel-owner.test.cjs`
Expected: 全部 PASS。如有失败，按 superpowers:systematic-debugging 找原因、改实现（不改测试的期望），改动记进 `docs/CHANGES.md`。

- [ ] **Step 3: 全量**

Run: `npm run check && npm run test:kernel`
Expected: 全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add test/xin-kernel-owner.test.cjs test/helpers/clock-jump.cjs
git commit -m "test(xin): 外壳和真状态进程的切换、故障与时钟跳变"
```

### Task 4: Worker 和 Durable Object：期望、部署代号、主人暂时不在

**Files:**
- Modify: `src/xin-kernel.js`（`KernelConfigStore` 发期望和代号；`kernelRequest` 带 `owner`；`classifyKernelResponse` 认 `owner_unavailable`、带出 `owner`、`executed:'unknown'` 带原因）
- Modify: `src/xin.js`（`runOp` 带上期望；主人暂时不在不退 exec，抛可重试的错；`usage` 结果挂上 `owner` 和 `ops`；`explain` 认 `owner_unavailable`；Durable Object 构造 `KernelConfigStore` 时传 `deploy`、`mode`）
- Modify: `src/xin-inbox.js:9`（`TRANSIENT` 加 `owner_unavailable`）
- Modify: `wrangler.jsonc`（正式站 `vars` 加 `"XIN_STATE_OWNER": "kernel"`；顶层和 `env.staging` 都加 `"version_metadata": { "binding": "CF_VERSION_METADATA" }`）
- Test: `test/xin-kernel-client.test.cjs`、`test/xin.test.cjs`、`test/xin-inbox.test.cjs`

**Interfaces:**
- Consumes: Task 2 的 `/xin/op` 请求和回应格式。
- Produces:
  - `new KernelConfigStore(storage, { ib, ibErr, now, random, deploy = 'dev', mode = 'legacy' })`；`get()` 的结果多一个 `owner: { mode, gen }`。存储键 `kernel-owner` 存 `{ deploy, gen }`：`deploy` 和这次的不一样就 `gen + 1` 并存下。
  - `kernelRequest({ config, agentPath, op, args, owner, timeoutMs, fetchImpl, now })`：有 `owner` 就放进请求体。
  - `classifyKernelResponse`：成功 `{ kind:'ok', data, version, owner }`；`executed:false` 且 `error === 'owner_unavailable'` → `{ kind:'not_sent', reason:'owner_unavailable', retryAfter, version }`；`executed:'unknown'` → `{ kind:'unknown', reason: d.error || 'bad_kernel_reply', version }`。
  - `runOp` 遇到 `owner_unavailable`：抛 `{ status:503, code:'owner_unavailable', retryAfter, msg:'小芯正在换状态进程，稍等' }`，不走 exec；`explain` 把它变成 `{ ok:false, state:'busy', msg:'小芯正在换状态进程，稍等', retryAfter }`。
  - `op === 'usage'` 成功时 `data.owner = { ...owner, ops }`（外壳给了才挂）。

- [ ] **Step 1: 写失败的测试**
```js
test('部署代号：同一部署不变；换了部署（包括回滚到旧版本号）加一；期望跟 XIN_STATE_OWNER', ...);
  // 同一 storage：deploy 'v1' 两次 get → gen 1、1；换 'v2' → 2；换回 'v1' → 3；mode 'kernel' / 默认 'legacy'
test('每次操作把期望放进请求体；usage 的结果带上主人状态和耗时', ...);
test('主人暂时不在：不退 exec，回可重试的「稍等」；待送达当作临时错误重送', ...);
test('wrangler：正式站 XIN_STATE_OWNER=kernel，正式站和测试站都有 version_metadata 绑定', ...);
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/xin-kernel-client.test.cjs test/xin.test.cjs test/xin-inbox.test.cjs`
Expected: 新加的各项 FAIL。

- [ ] **Step 3: 实现**

- [ ] **Step 4: 跑测试，确认通过；再跑全量和 dry-run**

Run: `npm run check && npx -y wrangler@4.151.1 deploy --dry-run --env=`
Expected: 全部 PASS；dry-run 列出 `CF_VERSION_METADATA` 绑定和 `XIN_STATE_OWNER`；冷启动子请求测试仍不超过 50。

- [ ] **Step 5: 提交**

```bash
git add src wrangler.jsonc test/xin-kernel-client.test.cjs test/xin.test.cjs test/xin-inbox.test.cjs
git commit -m "feat(xin): Worker 用 XIN_STATE_OWNER 和部署代号决定状态模式"
```

### Task 5: 用量页显示状态由谁在管

**Files:**
- Modify: `site/xin/chat.js`（`usageBody` 里 `wake` 那一行旁边加一行 `xu-owner`）
- Test: `test/e2e/xin_usage_e2e.py`

**Interfaces:**
- Consumes: Task 4 的 `usage.owner`。
- 文字（定稿）：
  - `phase === 'running'`：`状态：常驻进程在管（已切换 {epoch} 次，这次运行了 {时长}{，操作一般 {ops.all.p50} 毫秒}）`，时长按 `up` 算，不到 1 小时写 `{分} 分钟`，否则 `{时} 小时`；没有 `ops` 就不写最后一段。
  - `phase === 'fallback'`：`状态：常驻进程起不来，已改回旧方式（{lastError}）。下次上线会再试`
  - `phase === 'starting'` 或 `'waiting'`：`状态：正在换到常驻进程`
  - 其他：`状态：旧方式（每次操作起一个进程）`
  - 没有 `owner` 就不显示这一行。

- [ ] **Step 1: 写失败的 e2e**：假 `usage` 分别带 running（epoch 3、up 2 小时、p50 2）和 fallback（lastError `state_compat`），在 390 和 1280 宽度断言这一行的文字和上面完全一致、整行可见。
- [ ] **Step 2: 跑，确认失败**：先起 `node scripts/preview.mjs --port 5173`，再 `python3 test/e2e/xin_usage_e2e.py`。Expected: 找不到 `.xu-owner`。
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑通过；截图自查**：1280、1024、768、390，浅色和深色，用量页带 running 那一行。Expected: e2e 退出 0；截图里这一行不溢出、不和别的行挤在一起。
- [ ] **Step 5: 提交**

```bash
git add site/xin/chat.js test/e2e/xin_usage_e2e.py
git commit -m "feat(xin): 用量页显示状态由谁在管"
```

### Task 6: 正式联调断言、文档、全量验证

**Files:**
- Modify: `scripts/test-xin-live.py`
- Modify: `README.md`、`docs/CHANGES.md`、`docs/AI-HANDOFF.md`、本计划（进度一行）

- [ ] **Step 1: 联调断言**：登录后，用脚本里的 `call('usage', {})` 每 3 秒问一次、最多 120 秒，等到 `owner.phase == 'running'`，记下 `epoch` 和 `spawns`；其余检查都做完后再问一次，断言 `phase` 还是 `running`、`epoch` 没变（中途没重启）、`spawns` 没变（这一路操作都没起控制器），打印 `PASS state owner is the resident process (kernel mode, no controller process per request)`。等不到 `running` 就失败（会触发自动回滚）。
- [ ] **Step 2: 文档**：README 的小芯部分写内核模式和回滚办法（见下面「回滚」）；CHANGES 新条目写改了什么、参考了什么（tmux `client.c` 的连接和服务端锁、SQLite 锁、`un-ts/synckit` 的同步等待；状态进程看护「没找到现成做法」）、上面「我定的」十条、第 1 条改变了哪条旧断言；交接记录写进度和风险。
- [ ] **Step 3: 全量验证**

Run: `npm run check && npm run test:kernel`，再起预览后 `CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:e2e`
Expected: 全部通过，记下各自的通过数。

- [ ] **Step 4: 提交**

```bash
git add scripts/test-xin-live.py README.md docs
git commit -m "docs(xin): 第 2 批：状态切到内核模式的说明、联调断言和交接"
```

## 上线和验收

1. 开 PR，写清实现和复核（Claude Code 实现、自查）、上面十条、第 1 条改的旧断言；等 check、e2e、测试站全绿。测试站没配小芯，期望和状态进程在那里不会真的跑，真切换只发生在正式站。
2. 合并前对小芯电脑做一次只读核对（经 InstaBox exec 跑只读命令，先读 https://instabox.sh/llms.txt）：所有权记录、`workflow.sqlite` 大小（估切换前备份要多久）、有没有 `serve` 进程、有没有不带桥标记的控制器进程。
3. **告诉站长**：合并后第一次请求就会切到内核模式；会出什么变化、风险、怎么回滚；站长同意再合并。
4. 合并后确认正式运行全绿，联调里有上面那条 PASS。
5. 上线后只读核对：记录 `kernel`、epoch；`serve` 进程跑的是这次的控制器、父进程是外壳；没有 `watchdog` 进程；`kernel.jsonl` 里 `state` 事件只有一次 `start`、一次 `ready`；备份目录里一个文件。
6. 至少 35 分钟没人用之后，用 `GET /v1/machines/{id}`（不会叫醒电脑）看电脑是不是照常自动暂停了（`autoSuspendedAt`）。
7. 更新交接记录。

## 回滚

| 情况 | 做什么 |
|---|---|
| 内核模式有问题、代码没问题 | `wrangler.jsonc` 的 `XIN_STATE_OWNER` 改成 `legacy` 发版：新部署代号更大，外壳排空、记录回 legacy |
| 新版本有问题 | Actions 自动回滚 Worker；回到第 1 批时它的外壳重新装上，状态进程收到管道结束、交回 legacy（我定的第 1 条） |
| 状态进程起不来 | 外壳 3 分钟后自己放弃这一代号、改回旧方式并推送（第 3 条）；修好再发版 |
| 要退到 #136、#137 那样不懂桥的版本 | 不支持直接退。先用懂桥的版本切回旧模式（上面第一行），确认健康检查 `owner.mode` 是 `legacy`，再退 |
