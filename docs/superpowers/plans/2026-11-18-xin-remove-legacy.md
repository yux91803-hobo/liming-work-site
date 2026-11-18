# 删掉旧模式（legacy）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 小芯的状态只由常驻状态进程一个写；旧模式（每次请求起控制器、`flock` 业务锁、看门狗、legacy↔kernel 切换、`XIN_STATE_OWNER`）全部删掉。

**Architecture:** 分三个 PR，每个 PR 单独上线、单独可回滚。A 只改测试：所有测试都有主人（真的状态进程，或测试进程自己当主人），`test:kernel` 并进 `check`。B 改行为：非主人一律不写，外壳等状态进程好、等不到回 `owner_unavailable`，换版本不再交回 legacy，Worker 固定常驻进程模式。C 删掉 B 以后已经走不到的代码，把只测旧手段的测试换成测同一保证的行为测试。

**Tech Stack:** Node 22（`node:sqlite`、`node:test`）、Cloudflare Worker、Python Playwright 浏览器测试。

**Spec:** `docs/superpowers/specs/2026-11-17-xin-remove-legacy-design.md`（站长 2026-11-17 深夜同意：「这个部署成功了，你就去搞legacy，我要睡觉了」）。

**执行：** Native，Claude Code 在同一会话里实现。站长在睡觉，没有逐条审这份计划：按 CLAUDE.md「从写代码到上线全流程交给当前接手的 AI」直接做，每个 PR 单独可回滚，做完向站长汇报。

## Global Constraints

- 不删用户数据、不改数据格式：对话、记忆、任务记录、待送达都不动；`owner.sqlite` 里已有的记录照读（spec §2「不能出现的」）。
- 任何时候只有一个写者：状态进程不在时，别的进程不悄悄自己写（spec §2）。
- 不丢消息：状态进程暂时不在时，网页发的消息留在 Worker 的待送达里重试（spec §2）。
- 等待沿用现有预算，不新开：外壳 `readyWaitMs` 15000 毫秒；报告 `retryReport`/`retryUnsent` 30000 毫秒；`waitForState` 30000 毫秒（spec §4.2、§8）。
- exec 传输（`XIN_TRANSPORT`）、每轮执行进程的 `flock -n` 轮次锁、`memory-idle` 的启动锁不动（spec §2「不做」）。
- 工作台界面只改用量页那一行「状态由谁在管」的文字（旧模式没了，原文案不再对）。
- 每个 PR：`npm run check`、`npm run test:e2e` 全过；CI、测试站、正式站联调全绿才算完；写进 `docs/CHANGES.md` 和 `docs/AI-HANDOFF.md`。
- 不跳过、不删测试来变绿；删掉的旧模式测试在 PR 里逐条写明换成了哪条（spec §5）。

## Review Focus

1. 部署那一刻旧版 Worker 实例还带着旧控制器路径来请求：外壳应当马上回 `owner_unavailable`，不白等 15 秒（Task B2 的 `stale agent` 测试）。
2. 新外壳停旧版状态进程：旧版不认不带模式的 `release`，外壳退回关标准输入，旧进程照样排空、记录留在 kernel（Task B2 的「旧状态进程不认新 release」测试）。
3. 状态进程一直起不来：推送一次「起不来、小芯暂停」，然后按最长退避一直重试，不再停在这一代号（Task B2 的 giveUp 测试）。
4. exec 传输（内核端口不通）且状态进程不在：控制器入口回 `{error:'owner_unavailable', executed:false}`，Worker 回「稍等」，待送达重试（Task B1 的入口测试；Worker 现有 `src/xin.js:414` 处理）。
5. 全新的电脑（`owner.sqlite` 还是空的）：状态进程照常接手、先备份，别的进程一直不写（Task B1 的「新目录」测试）。

---

## PR A · 第 1 步：测试全部对着主人跑（线上不变）

### Task A1: 测试帮手总是起状态进程，`test:kernel` 并进 `check`

**Files:**
- Modify: `test/helpers/state-mode.cjs`（去掉 `XIN_TEST_STATE_MODE` 门槛和 `force` 选项）
- Modify: `test/xin-agy-report-recovery.test.cjs:38`、`test/xin-run-attempt.test.cjs:21`（去掉 `force`）
- Delete: `scripts/test-xin-state-mode.mjs`
- Modify: `package.json`（删 `test:kernel`）、`.github/workflows/deploy.yml:68-72`（删「常驻状态内核复用控制器行为测试」一步）、`README.md:106-110`、`test/test-env.test.cjs:38-`（只查 `scripts/check.mjs`）
- Test: `test/state-mode-helper.test.cjs`（新）

**Interfaces:**
- Produces: `stateMode(t, env, { agent }?) -> { child, exited, ready }`，总是起；`stateClient(t, env, options?) -> () => void`（第一次调用时起）。

- [ ] **Step 1: 写失败的测试** `test/state-mode-helper.test.cjs`：不设 `XIN_TEST_STATE_MODE`，`stateMode(t, env)` 返回的 `ready.ready === true`、`ready.epoch >= 1`，`<XIN_HOME>/run/state.sock` 存在。
- [ ] **Step 2: 跑它，确认失败**：`node --test test/state-mode-helper.test.cjs` → 失败（现在返回 `null`）。
- [ ] **Step 3: 改帮手**：删门槛和 `force`；调用方去掉 `force`。删 `scripts/test-xin-state-mode.mjs`、`test:kernel`、CI 那一步（`XIN_RUN_ATTEMPTS`/`XIN_TASK_BRIDGE` 两个变量随这一步删：两者默认已经是开，见 `vm-run-attempt.mjs:5`、`vm-task-bridge.mjs:5`）。README、`test-env.test.cjs` 跟着改。
- [ ] **Step 4: 跑**：新测试通过；`npm run check` 全过（原来 `test:kernel` 的 14 组现在在 `check` 里对着状态进程跑）。
- [ ] **Step 5: 提交**。

### Task A2: 暗中靠旧模式写库的测试全部接上主人

**Files:**
- Create: `test/helpers/own-state.cjs`
- Modify: 摸底找出的测试文件（见 Step 1）

**Interfaces:**
- Produces: `ownState() -> Promise<Ownership>`：测试进程自己拿独占锁当主人（`ownership.take({ waitMs: 5000 })`，已经是主人就直接返回）。用在只在测试进程里调模块、不起控制器子进程的测试。

- [ ] **Step 1: 摸底（临时改动，不提交）**：`vm-kernel-owner.mjs` 的 `enter()` 里把 `if (r.mode !== 'legacy')` 临时改成一律拒；`XIN_TEST_STATE_MODE=kernel npm run check`；记下失败的测试和文件，分成三类：
  - 只测旧模式手段的（`flock` 包装、legacy↔kernel 切换、看门狗、`owner-legacy`）：留到 PR C 换，列进 PR A 的说明；
  - 起控制器子进程的：接 `stateClient(t, env)`，每次调控制器前 `ensureState()`；
  - 只在测试进程里调模块的：开头 `await ownState()`。一个文件两种都有就起真的状态进程（测试进程里的写会经套接字交给它，`vm-state.mjs:32`）。
- [ ] **Step 2: 写 `ownState`**，按 Step 1 的分类逐个文件接上。
- [ ] **Step 3: 带着临时改动再跑** `npm run check`：除了列明留到 PR C 的旧模式测试，全部通过。
- [ ] **Step 4: 还原临时改动**，`npm run check`、`npm run test:e2e` 全过。
- [ ] **Step 5: 提交**；PR A 说明里列出：哪些文件接了状态进程、哪些自己当主人、哪些旧模式测试留到 PR C。

---

## PR B · 第 2 步：状态进程不在时等它好；换版本不再交回 legacy（线上变）

### Task B1: 非主人一律不写

**Files:**
- Modify: `site/xin/vm-kernel-owner.mjs`（`enter()`）
- Test: `test/xin-owner.test.cjs`、`test/xin-state-controller.test.cjs`

**Interfaces:**
- Produces: `Ownership.enter()`：不是主人时一律抛 `OwnerUnavailable`（主人活着 `alive`，没有主人 `missing`），记录是空的、`legacy` 还是 `kernel` 都一样。主人自己调用照旧返回空操作。

做法：只改 `enter()` 这一行（PR A 摸底用的就是它），所有调用方的旧路（`lockedCall` 的 `flock`、`vm-state.mjs` 写入口、`main()` 的 `hold()`、`ensureWatchdog`）随之走不到，留到 PR C 删。没选「逐个改调用方」：那样等于把 PR C 的删代码提前到这一步，行为改动分散在五处，不好审、不好回滚。

代价：`xin-owner.test.cjs` 里测「旧写者拿共享锁」机制的几条（旧写者还在写时主人等它、可重入、八个进程同时拿共享锁、脱离的子进程不带走锁、源源不断的旧写者不饿死主人；以 PR A 摸底清单为准）在这一步就没有旧写者可测了。它们在这一步删掉，不留到 PR C；PR B 说明里逐条写明，「只有一个写者」由本任务新加的行为测试覆盖。

- [ ] **Step 1: 改测试（先红）**，行为变了的几条照新规矩写：
  - `xin-owner`「新目录：没有记录」→ 写入口拒（`owner_missing`），库文件权限仍 0600；
  - `xin-owner`「主人正常交回」「被 kill -9 后 set(legacy)」→ 交回以后、改成 legacy 以后写入口仍然拒；
  - `xin-owner`「旧模式：控制器照常工作」→ 没有主人时控制器回 `{error:'owner_unavailable', executed:false}`，状态库没被建出来；
  - `xin-state-controller`「socket 只是线索：记录归 legacy 时走受控旧路径」→ 没有主人时不写、回 `owner_unavailable`。
  - 新加：没有主人时控制器回 `owner_unavailable`；起状态进程以后同一个带 `clientId` 的请求重试成功、只执行一次（spec §5「只有一个写者」）。
- [ ] **Step 2: 跑，确认这些失败**：`node --test test/xin-owner.test.cjs test/xin-state-controller.test.cjs`。
- [ ] **Step 3: 改 `enter()`**：去掉「归旧模式就放行」那一支。
- [ ] **Step 4: 跑这两个文件通过**；`npm run check` 全过（PR A 已经让别的测试都有主人）。
- [ ] **Step 5: 提交**。

### Task B2: 外壳只走状态进程

**Files:**
- Modify: `site/xin/vm-kernel.mjs`（看护的 `ready`、`stop`、`giveUp`、`summary`；`op()`；`stream()`）
- Modify: `site/xin/vm-kernel-state.mjs:51-53`（`release` 不带模式也认，从不写 legacy）
- Test: `test/xin-kernel.test.cjs`、`test/xin-kernel-owner.test.cjs`

**Interfaces:**
- Produces: 看护 `ready(agent, ms) -> Promise<boolean>`：`agent` 不是现在要的版本、或看护已关，马上 `false`；否则一直等到这一版走套接字（`true`）或超时（`false`），中途旧进程退出、新进程起来都不提前结束。
- Produces: `/xin/op` 等不到时回 `503 {ok:false, executed:false, error:'owner_unavailable', retryAfter:3}`（和 `viaState` 交不过去时一样）；`/xin/stream` 状态进程不在时发 `event: error`、`{error:'owner_unavailable'}`。
- Produces: 看护的阶段 `down` 取代 `fallback`：连续 `giveUpMs` 起不来时推送一次「常驻状态进程起不来：<原因>。小芯先停一下，会接着重试」，之后按最长退避（60 秒）一直重试。

- [ ] **Step 1: 写失败的测试**：
  - 换版本：旧状态进程排空退出、新状态进程起来之间来的 `/xin/op` 等到新进程回答，不起控制器（`spawns` 不变），只执行一次；
  - 状态进程被 `kill -9` 后重起之间来的 `/xin/op` 等到新主人回答；
  - `readyWaitMs` 内等不到：`503`、`owner_unavailable`、`executed:false`，没起控制器；
  - 请求带的控制器不是现在要的版本：马上 `503 owner_unavailable`（不等 `readyWaitMs`）；
  - `/xin/stream` 状态进程不在：`event: error`，`owner_unavailable`；
  - 外壳正常停止（`close({release:true})`）：状态进程排空退出，记录仍是 `kernel`，没有调 `owner-legacy`（改写 `xin-kernel-owner.test.cjs:125`）；
  - 旧状态进程不认不带模式的 `release`：外壳关标准输入，它照样排空退出、记录留 `kernel`；
  - 一直起不来（改写 `xin-kernel.test.cjs:704`）：推送一次，阶段 `down`，不调 `owner-legacy`，之后还在按 60 秒重试。
- [ ] **Step 2: 跑，确认失败**：`node --test test/xin-kernel.test.cjs test/xin-kernel-owner.test.cjs`。
- [ ] **Step 3: 改外壳和状态进程的 `release`**：`op()` 不再 `runAgent`；`stream()` 不再 `runAgent`；`stop()` 发 `{kind:'control', op:'release'}`、退出后不调 `owner-legacy`；`giveUp()` 不调 `owner-legacy`；状态进程的 `release` 不管带不带 `mode` 都只排空、不改记录。
- [ ] **Step 4: 跑这两个文件通过**；`npm run check` 全过。
- [ ] **Step 5: 提交**。

### Task B3: Worker 固定常驻进程模式，用量页文字

**Files:**
- Modify: `wrangler.jsonc:24-26`（删 `XIN_STATE_OWNER`，测试站那份如有也删）、`src/xin.js:328,792`、`src/xin-kernel.js:27,32-34`
- Modify: `site/xin/chat.js:2745-2756`（`ownerLine`）
- Test: Worker 的 `KernelConfigStore` 测试（`test/xin-kernel-*.test.cjs` 里找）、`test/e2e/xin_usage_e2e.py:214-222`

**Interfaces:**
- Produces: `KernelConfigStore` 不再收 `mode`，发给外壳的期望固定 `{mode:'kernel', gen}`。
- Produces: `ownerLine(o)`：`running` 照旧；`down` →「状态：常驻进程起不来（原因），小芯先停一下，正在重试」；`starting`/`waiting`/`stopping` →「状态：正在换常驻进程」；其余 →「状态：常驻进程没在运行」。

- [ ] **Step 1: 写失败的测试**：没配 `XIN_STATE_OWNER` 时期望是 `kernel`；用量页 4 种阶段的文字（e2e）。
- [ ] **Step 2: 跑，确认失败**。
- [ ] **Step 3: 改**。
- [ ] **Step 4: 跑通过**；`npm run check`、`npm run test:e2e` 全过；用量页电脑 1280、手机 390，浅色、深色各截一张自查。
- [ ] **Step 5: 提交**；写 CHANGES、AI-HANDOFF；开 PR B。上线后用只读下载的 `kernel.jsonl` 核对换版本那一下的等待时间（spec §6）。

---

## PR C · 第 3 步：删掉走不到的代码

Codex 从 #170 实现本批。C1–C3 合成一个可整体测试、独立回滚的提交。SQLite 在提交接管记录前完成启动校验及首次迁移备份。联调采用状态进程 PID 和接管次数，假控制器夹具直接观测逐请求启动。发布证据与回退目标记在 [交接记录](../../AI-HANDOFF.md)。

### Task C1: 控制器入口和写库只剩转交

**Files:**
- Modify: `site/xin/vm-agent.mjs`（`lockedCall:268-285` 删 `flock` 那条路；删 `ensureWatchdog:1909-`、`watchdog` 命令和函数、`journal.defer(ensureWatchdog)` 各处、换版本时 `flock … watchdog` 重启 `:1992`、`LONG_LIVED` 里的 `watchdog`、`owner-legacy` 命令；`main()` 一次性命令一律转交，长进程一律 `waitForState`）
- Modify: `site/xin/vm-kernel-owner.mjs`（删 `enter/leave/hold/set` 和 `ownerLegacy`；`take().release()` 不再收模式）
- Modify: `site/xin/vm-state.mjs:23-45`（`writing()`：不是主人就转交，不再试 `enter()`）、`site/xin/vm-base.mjs:30-34`（`stateOwned`）
- Modify: `test/helpers/locked.cjs`（不再包 `flock`）
- Test: 现有全量 + Task C3 的替换测试

- [x] **Step 1**: 移除 `vm-state` 和 `lockedCall` 的旧写入路径、看门狗、`owner-legacy` 和旧所有权接口。
- [x] **Step 2**: 与 C2–C3 合并验收。最终 `npm run check` 1,021/1,021，旧机制对应的行为测试一并通过。
- [x] **Step 3**: 随本批提交。

### Task C2: 外壳删 `runAgent`

**Files:**
- Modify: `site/xin/vm-kernel.mjs`（删 `runAgent`、`running`、`maxConcurrent`、`spawns` 计数和 `runOnce` 里的 `owner-legacy`；健康检查和 `owner` 视图不再带 `spawns`；`mode` 字段固定 `kernel`）
- Modify: 读 `spawns` 的地方（正式联调、测试）

- [x] **Step 1**: 移除逐请求进程和计数。套接字路由与状态进程就绪检查共用同一判定。
- [x] **Step 2**: `npm run check` 与 13 组 `npm run test:e2e` 全过。
- [x] **Step 3**: 随本批提交。

### Task C3: 旧模式测试换成行为测试

**Files:**
- Modify/Delete: PR A 列出的旧模式测试（`xin-owner`、`xin-state-controller`、`xin-kernel-owner:224` 兼容回滚、`xin-run-attempt` 的 legacy 分支、`locked-helper` 等）

- [x] **Step 1**: 对应行为测试覆盖唯一写者、换版重放和重启后派发与交接。保留旧记录和旧消息格式的兼容测试。
- [x] **Step 2**: 完整检查通过。临时目录用 #170 实际代码演练升级与回滚，保留回执和在途执行尝试。
- [x] **Step 3**: 随本批提交。CHANGES、AI-HANDOFF、README、两份设计及 PR 记录行为验证与回滚路径。
