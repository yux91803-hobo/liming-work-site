# 小芯后台可靠性第一批（PR 1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每日任务不再堵住后台任务；临时错误自动接着做；等回答有时限；副本放控制器目录并按保留期清理；写回失败自动还原；读操作不抢写锁、轮询按字节位置读。

**Architecture:** 全部在云电脑控制器（`site/xin/vm-*.mjs`）里改，网页只在 `chat.js` 加字节位置和一行卡片小字。新逻辑尽量写成纯函数放进小模块（`vm-retry.mjs`），`vm-agent.mjs` 只接线。状态库不加表；任务记录只加字段（`retryAt`、`transientRetries`、`usage`），旧代码忽略。

**Tech Stack:** Node 22（`node:sqlite`、`node:test`），浏览器测试 Python Playwright。

**Spec:** `docs/xin-reliability-usage-design.md` 的 A 部分（站长 2026-11-11 已确认，A4 保留期：做完的副本 7 天后删，其余留到删对话）。

## Global Constraints

- 新模块文件名匹配 `vm-[a-z0-9-]+.mjs`，用 `from './vm-xxx.mjs'` 引用（Worker 按这个递归上传）。
- 状态库只加表、加列；回滚到上一版 Worker 时旧代码能忽略新字段、新文件。
- 新旧 `chat.js` 和新旧控制器任意搭配都能用（`poll` 的 `pos` 可选）。
- 测试里所有「等到某个条件」的时限都经过 `test/helpers/timeout.cjs` 的 `platformTimeout`。
- 不跳过、不删测试。

## Review Focus

1. 临时错误重试时任务时限已过：应该直接按超时收尾，不再起一轮立刻被杀（Task 3 加测试）。
2. 站长在等待到点的同一时刻回答：答案不能丢（Task 4 加测试：expire 之后 `task_tell` 进收件箱）。
3. 旧任务记录里的副本还在 `/data/tmp`：续做、删对话、清理都要认（Task 5 沿用 `xin-forget` 的旧路径用例，并加新路径用例）。
4. 写回时目标文件被另一个进程改成了和副本一样的内容：不算冲突、不重复写（Task 6 测试覆盖）。
5. `poll` 带的 `pos` 落在半行中间或超出文件长度：返回空并保持 `pos` 不前进，不抛错（Task 7 加测试）。

---

### Task 1: `recover()` 没有要补写的就不拿写锁

**Files:**
- Modify: `site/xin/vm-state.mjs`（`recover()`，第 72 行起）
- Test: `test/xin-state.test.cjs`

**Interfaces:**
- Produces: `StateJournal#recover()` 行为不变，只是空闲时不开写事务。

- [ ] **Step 1: 写失败的测试** `recover 在别的进程占着写锁时不等待`：子进程 A 打开同一个 `workflow.sqlite`，`BEGIN IMMEDIATE` 后睡 3 秒；主进程设 `PRAGMA busy_timeout` 不变，调用 `new StateJournal(dir).recover()`，断言耗时 < 500 ms 且不抛错。再写一个 `有没投影的行时 recover 仍然补写`：直接往 `documents` 插一行 `dirty=1`，`recover()` 后文件存在、`dirty=0`。
- [ ] **Step 2: 跑测试确认第一个失败**（等满 busy_timeout 或报 locked）。`node --test test/xin-state.test.cjs`
- [ ] **Step 3: 实现**：`recover()` 开头在 `this.active` 判断之后，用 `this.db.prepare('SELECT 1 FROM documents WHERE dirty=1 LIMIT 1').get()` 和 `appends WHERE projected=0` 两个查询，都没有就 `return`。
- [ ] **Step 4: 跑 `node --test test/xin-state.test.cjs test/xin-reliability.test.cjs`，全过。**
- [ ] **Step 5: 提交** `git commit -m "状态库：没有要补写的就不拿写锁"`

### Task 2: 每日任务用 `WORK/daily`

**Files:**
- Modify: `site/xin/vm-agent.mjs`（`taskNew` 第 1440–1441 行；`startTask` 第 1497 行的 `cwd`）
- Test: 新建 `test/xin-batch1.test.cjs`（本计划后续任务的集成测试都放这里；环境搭法照 `test/xin-forget.test.cjs` 的 `home()`，加一个假 `codex`：后台轮次在 `$L/hold-<标题>` 文件存在时一直等）

**Interfaces:**
- Produces: `export const DAILY_DIR = () => path.join(WORK, 'daily')`（vm-agent.mjs）。

- [ ] **Step 1: 写失败的测试** `每日任务在跑时普通任务照样开始`：`daily_set` 写一行清单，`daily` 起每日任务（让它挂住）；用 `locked task_new` 派一个普通任务；`until` 普通任务 `status==='running'`；断言每日任务记录的 `dir === path.join(work,'daily')`，假 codex 记录的每日任务 `cwd` 也是它。
- [ ] **Step 2: 跑测试确认失败**（普通任务一直 `queued`）。
- [ ] **Step 3: 实现**：`taskNew` 里 `a.daily` 时 `mk(DAILY_DIR())`、`d = { dir: DAILY_DIR() }`；`startTask` 的 `cwd` 改为 `t.workspace?.work || t.dir || WORK`。
- [ ] **Step 4: 跑 `node --test test/xin-batch1.test.cjs test/xin.test.cjs test/xin-daily-context.test.cjs`，全过。**
- [ ] **Step 5: 提交** `git commit -m "每日任务用自己的目录，不再和后台任务互相排队"`

### Task 3: 临时错误由控制器等一会儿接着做

**Files:**
- Create: `site/xin/vm-retry.mjs`
- Modify: `site/xin/vm-agent.mjs`（`runner` 的 `finish`、`taskFinish`、`scheduleNow`、`taskNeedsTick`、`taskTell`、`taskSummary`）；`site/xin/chat.js`（卡片小字）
- Test: `test/xin-batch1.test.cjs`（集成）、新建 `test/xin-retry.test.cjs`（纯函数）

**Interfaces:**
- Produces（vm-retry.mjs）：
  - `export function transientFailure(text: string): boolean`
  - `export const RETRY_DELAYS_MS: number[]`，值 `[60000, 240000, 900000]`；环境变量 `XIN_RETRY_DELAYS_MS`（逗号分隔毫秒）覆盖，测试用。
  - `export const RETRY_TEXT: string`，内容：`（刚才连接模型出错，这一轮中断了。先看看现在的文件和进度，已经做过的有副作用的事别重做，接着把任务做完。）`
- 任务记录新字段：`transientRetries: number`、`retryAt: number`（毫秒时间戳，0 或不存在表示可立刻开始）。
- `task_finish` 参数新增 `transient: boolean`。

- [ ] **Step 1: 写纯函数测试** `test/xin-retry.test.cjs` 的 `临时错误和终止错误分得开`：以下为 `true`：`'stream disconnected before completion'`、`'Error: read ECONNRESET'`、`'socket hang up'`、`'fetch failed'`、`'HTTP 502 Bad Gateway'`、`'unexpected status 503 Service Unavailable'`、`'429 Too Many Requests'`、`'The server is overloaded'`、`'rate limit exceeded'`、`'前台连接失败（HTTP 504）'`。以下为 `false`：`'task inference budget exhausted; partial work is retained'`、`'本项工作的推理预算已用完'`、`'context_length_exceeded'`、`'HTTP 401 Unauthorized'`、`'403 forbidden'`、`'超过 60 分钟还没做完，停下了'`、`'独立复核模型与实际作者相同'`、`''`。终止关键字优先于临时关键字（`'503 ... budget exhausted'` 为 `false`）。
- [ ] **Step 2: 跑测试确认失败**（模块不存在）。
- [ ] **Step 3: 实现 `vm-retry.mjs`**：临时关键字参照 Grok Bot `transient-stream-error.ts` 的 `TRANSIENT_ERRNO_CODES`、`TRANSIENT_MESSAGE_TOKENS`，加 HTTP 429/500/502/503/504、`overloaded`、`rate limit`、`stream disconnected`、`fetch failed`；终止关键字：`budget`、`预算`、`context_length`、`context window`、`too large`、`401`、`403`、`unauthorized`、`forbidden`、`未知模型`、`not found`、`超过 .* 分钟`、`复核`。
- [ ] **Step 4: 跑 `node --test test/xin-retry.test.cjs`，全过；提交** `git commit -m "vm-retry：区分临时错误和终止错误"`
- [ ] **Step 5: 写集成测试**（`test/xin-batch1.test.cjs`）：
  - `干活中途断线：等一会儿用同一个会话接着做完`：假 codex 第一次后台轮次先输出 `command_execution` 再输出 `turn.failed` `{"message":"stream disconnected before completion"}`，第二次正常完成；`XIN_RETRY_DELAYS_MS=300`。断言第一次失败后任务 `status==='queued'`、`retryAt>0`、没有交接事件；最终 `done`；第二次参数里有 `resume` 和第一次的线程号，输入含 `RETRY_TEXT`。
  - `预算用完不重试`：`turn.failed` 信息为 `task inference budget exhausted` → 直接 `failed`。
  - `连续 3 次临时错误后失败`：每次都 `stream disconnected` → 第 4 次失败后 `failed`，`transientRetries===3`。
  - `重试时已过任务时限就按超时收尾`：`XIN_TASK_TIMEOUT_MS=1500`、`XIN_RETRY_DELAYS_MS=3000` → 任务 `failed`，`result.err` 含 `超时`，假 codex 只被叫了一次后台轮次。
- [ ] **Step 6: 跑测试确认失败。**
- [ ] **Step 7: 实现接线**：
  - `finish`：`meta.task && !ok && !stopped && !state.timeout` 时，把 `why`、本轮 `err` 事件文字（`tailEvents(run,16384)`）和 `stderr` 末 2000 字拼起来交给 `transientFailure`，结果放进 `task_finish` 参数 `transient`。
  - `taskFinish`：在 `a.died` 分支之后、通用 `else` 之前加一支：`a.transient && (t.transientRetries||0) < RETRY_DELAYS_MS.length` → `transientRetries+1`，`next=RETRY_TEXT`，`nextShow='（连接出错，稍后接着做）'`，`status='queued'`，`queuedAt=now`，`retryAt=now+RETRY_DELAYS_MS[次数-1]`，`finishedRun=a.run`，`saveTask`，返回 `{}`。
  - `scheduleNow`：跳过 `retryAt > Date.now()` 的；开工前 `t.deadline && Date.now() >= t.deadline` 时 `failTask(t, '超过 '+t.minutes+' 分钟还没做完，停下了。')` 并把 `result.err` 设为 `'超时（'+t.minutes+' 分钟）'`。
  - `taskNeedsTick`：排队的只算 `!(t.retryAt > Date.now())` 的。
  - `taskTell` 和任务做完（`status==='done'`）时把 `transientRetries`、`retryAt` 清零。
  - `taskSummary`：带上 `retryAt`（大于现在时）。
  - `chat.js`：卡片和首页列表里，`queued` 且 `retryAt > Date.now()` 时小字写 `连接出错，稍后接着做`（替换「排队中」）。
- [ ] **Step 8: 跑 `node --test test/xin-batch1.test.cjs test/xin.test.cjs test/xin-reliability.test.cjs test/xin-handover.test.cjs`，全过。**
- [ ] **Step 9: 提交** `git commit -m "后台任务遇到临时错误：控制器等一会儿接着做"`

### Task 4: 等站长回答最多挂 10 分钟

**Files:**
- Modify: `site/xin/vm-agent.mjs`（`approvalRequest` 第 1011 行；`iops` 加 `task_approval_expire`）
- Test: `test/xin-batch1.test.cjs`

**Interfaces:**
- Produces（vm-agent.mjs）：
  - `export async function awaitTaskInput({ id, holdMs, read, expire, sleep }): Promise<{ reply?: string, expired?: true, ended?: true }>` —— `read()` 返回本轮 meta；有 `approvalReplies[id]` 返回 `{reply}`；`stopped/ended` 返回 `{ended:true}`；超过 `holdMs` 先调 `expire()` 再返回 `{expired:true}`。
  - `export const APPROVAL_HOLD_MS`，默认 `600000`，`XIN_APPROVAL_HOLD_MS` 覆盖。
  - `export const INPUT_TIMEOUT_TEXT = '（用户 10 分钟内没有回复。问题已经记下，用户回复后会接着叫你。现在结束这一轮：最后一条消息写清楚做到哪了、要用户确认什么。）'`
  - iop `task_approval_expire({sid, run, id}) -> {ok:true} | {}`：`t.approval?.id===id` 时删 `approval`，`pendingQuestion=question`，`status='running'`，`saveTask`。

- [ ] **Step 1: 写失败的测试**：
  - `awaitTaskInput 到点交还`：`read` 永远返回无答复的 meta，`holdMs=50`，断言返回 `{expired:true}` 且 `expire` 被调一次。
  - `awaitTaskInput 有答复就返回答复`、`本轮结束就返回 ended`。
  - `到点后任务不再算后台在忙，回答后接着做`：用 `locked` 调用造一个 `running` 任务 + `task_approval`（`kind:'input'`），再调 `task_approval_expire` → `tasks` 的 `bg` 不再计它，`status==='running'`，`question` 保留；本轮 `run_complete` + `task_finish {ok:true}` 后 `status==='waiting'`；随后 `task_tell` 一句话 → `queued`，`next` 含 `用户回复：` 和原问题。
  - `到点那一刻回答不丢`：`task_approval_expire` 之后、本轮结束前 `task_tell` → 进 `inbox`，本轮结束后 `next` 含这句话。
- [ ] **Step 2: 跑测试确认失败。**
- [ ] **Step 3: 实现**：`approvalRequest` 的 `input` 分支改用 `awaitTaskInput`；`expire` 调 `lockedCall('tasks','task_approval_expire',{sid,run,id})`；返回 `{expired}` 时给 app-server `{answers: 每个问题 → {answers:[INPUT_TIMEOUT_TEXT]}}`。
- [ ] **Step 4: 跑 `node --test test/xin-batch1.test.cjs test/xin.test.cjs`，全过。**
- [ ] **Step 5: 提交** `git commit -m "后台中途提问：10 分钟没回就记下问题、结束这一轮"`

### Task 5: 副本放 `~/.xin-tasks`，做完的 7 天后删

**Files:**
- Modify: `site/xin/vm-runtime.mjs`（`prepareWorkspace` 第 34–64 行、`cleanupTaskTemporary` 第 663 行、`dropTaskFiles` 第 681 行；新增 `taskRoots`、`pruneTaskCopies`）；`site/xin/vm-agent.mjs`（`pruneLogs` 调 `pruneTaskCopies`；`taskFinish` 存 `t.usage`；`sessionUsage` 优先用 `t.usage`）
- Test: `test/xin-runtime.test.cjs`、`test/xin-forget.test.cjs`

**Interfaces:**
- Produces（vm-runtime.mjs）：
  - `export function taskRoot(controller: string): string` → `path.join(path.dirname(controller), path.basename(controller) + '-tasks')`
  - `export function taskRoots(controller): string[]` → `[taskRoot(controller), os.tmpdir()]`（后者兼容旧副本）
  - `export function pruneTaskCopies(controller, tasks, now = Date.now(), maxAge = 7*86400e3): {removed:number, bytes:number}` —— 只删 `status==='done'` 且 `endedAt` 早于 `now-maxAge` 的任务副本；核对目录名 `xin-task-<sid>`、不是软链接、真实路径等于自身。
- 任务记录新字段 `usage`（做完时 `sessionUsage(t)` 的快照）。

- [ ] **Step 1: 写失败的测试**：
  - `xin-runtime`：`新副本放在控制器旁边的 -tasks 目录`：`prepareWorkspace` 后 `workspace.work` 以 `taskRoot(control)` 开头，目录权限 0700；`cleanupTaskTemporary` 对它返回 `true`。
  - `xin-runtime`：`保留期只删做完且超过 7 天的副本`：造 4 个任务（done 8 天前、done 1 天前、failed 30 天前、waiting 30 天前），只第一个的副本被删；软链接副本不删。
  - `xin-forget`：原用例（旧路径在 `TMPDIR`）保持不变并通过；新增 `新路径的副本随对话一起删`。
- [ ] **Step 2: 跑测试确认失败。**
- [ ] **Step 3: 实现**：`prepareWorkspace` 用 `taskRoot(controller)`（`mkdir` 后 `chmod 0o700`）；`cleanupTaskTemporary(t)` 改为 `cleanupTaskTemporary(t, controller)`，根目录取 `t.workspace.tmp` 的上一级并要求它属于 `taskRoots(controller)` 之一（调用处传 `BASE`）；`dropTaskFiles` 对 `taskRoots` 逐个尝试；`pruneLogs` 里调用 `pruneTaskCopies(BASE, listTasks())` 并把字节数加进 `res.bytes`；`taskFinish` 在 `cleanupFinishedTask` 前 `t.usage = sessionUsage(t) || t.usage`。
- [ ] **Step 4: 跑 `node --test test/xin-runtime.test.cjs test/xin-forget.test.cjs test/xin.test.cjs test/xin-handover.test.cjs`，全过。**
- [ ] **Step 5: 提交** `git commit -m "任务副本放控制器自己的目录；做完的副本 7 天后清理"`

### Task 6: 写回失败自动还原，已写回的不算冲突

**Files:**
- Modify: `site/xin/vm-runtime.mjs`（`publicationPlan` 第 66–74 行、`publishWorkspace` 第 174–199 行）
- Test: `test/xin-runtime.test.cjs`

**Interfaces:**
- `publicationPlan` 返回值新增 `applied: string[]`（原项目已经等于副本的改动文件和已经不在的删除文件）；`changes`、`deleted` 去掉 `applied` 里的。
- `publishWorkspace` 成功返回值不变；失败抛 `Error('写回中途失败，原项目已还原：' + 原因)`；备份目录里有 `publish.json`：`{state:'writing'|'done'|'rolled_back', changes, deleted, created}`。
- 测试钩子：设了环境变量 `XIN_TEST_PUBLISH_FAIL_AFTER=<n>` 时，写完第 n 个文件后抛错；正式环境不设这个变量，行为不变。

- [ ] **Step 1: 写失败的测试**：
  - `写到一半失败：原项目逐字节还原`：原项目 `a.c`、`b.c`、`old.txt`；副本改 `a.c`、`b.c`，新增 `new.c`，删 `old.txt`；`XIN_TEST_PUBLISH_FAIL_AFTER=1` → 抛错含 `已还原`；原项目四个路径和开工前一样（`new.c` 不存在、`old.txt` 在）；`publish.json.state==='rolled_back'`。
  - `写回一半后被杀：再收尾时不算冲突、补齐剩下的`：手动把 `a.c` 写成副本内容后调 `publishWorkspace` → 不是 `pending`，`applied` 含 `a.c`，最终 `b.c`、`new.c` 是副本内容。
  - `别人改过的文件仍然算冲突`：原用例保持通过。
- [ ] **Step 2: 跑测试确认失败。**
- [ ] **Step 3: 实现**：冲突判断照设计稿 A5；写回前写 `publish.json`；逐个写入并记录完成列表；`catch` 里按完成列表还原（有备份的拷回、新建的删除、已删的拷回），写 `rolled_back` 后抛错；成功写 `done`。
- [ ] **Step 4: 跑 `node --test test/xin-runtime.test.cjs test/xin.test.cjs`，全过。**
- [ ] **Step 5: 提交** `git commit -m "写回失败自动还原原项目；已写回的文件不再算冲突"`

### Task 7: 轮询按字节位置读

**Files:**
- Modify: `site/xin/vm-agent.mjs`（`poll` 第 2255 行、`history` 第 2285 行）；`site/xin/chat.js`（`poll` 调用处约第 2241 行，`S.pos` 的保存和重置）
- Test: `test/xin-batch1.test.cjs`；`test/e2e/xin_runtime_e2e.py` 现有轮询用例照常通过

**Interfaces:**
- `poll({run, off, pos?})` 返回值新增 `pos: number`（读到的最后一个完整行之后的字节位置）；`history` 的 `active` 新增 `pos`。
- `chat.js`：`S.pos` 和 `S.off` 一起保存、一起在换对话/换轮时清零；请求里有 `S.pos` 就带上；返回没有 `pos`（旧控制器）就只用 `off`。

- [ ] **Step 1: 写失败的测试**：
  - `按字节位置读和按条数读结果一致`：一轮写 5 条事件，`poll {off:0}` 和 `poll {pos:0}` 拿到同样的 5 条；再追加 2 条，用上次的 `pos` 只拿到这 2 条，`done` 判断一致。
  - `pos 落在半行或超出长度时返回空且不前进`：文件末尾写半行，`pos` 不越过它；`pos` 大于文件长度时返回 `{events:[], pos: 原值}`。
  - `不带 pos 的旧请求照常`。
- [ ] **Step 2: 跑测试确认失败。**
- [ ] **Step 3: 实现**：`pos` 是非负安全整数时，打开文件、`fstat` 取长度，从 `pos` 读到末尾（最多 2 MB），只解析到最后一个 `\n`；`done` = 读到文件末尾且最后一条是 `done`（`pos` 等于长度时看 `readTail` 是否以 `done` 结尾）；`off` 同时累加。
- [ ] **Step 4: 跑 `node --test test/xin-batch1.test.cjs test/xin.test.cjs`；`npm run dev` 后跑 `python3 test/e2e/xin_runtime_e2e.py` 和 `xin_main_e2e.py`，全过。**
- [ ] **Step 5: 提交** `git commit -m "轮询从上次读到的位置接着读"`

### Task 8: 文档、全量验证、开 PR、上线

**Files:**
- Modify: `docs/CHANGES.md`（最上面加一条，写清每项参考的项目和文件）、`docs/xin-architecture-review.md`（问题 4、6、15、16 的现状）、`docs/xin-research-2026-11-11.md`（第 6 节标已做）、`README.md`（如有涉及的行为描述）

- [ ] **Step 1: `npm run check` 全过。**
- [ ] **Step 2: `npm run dev` 起预览，`CHROMIUM_PATH=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux64/chrome | head -1) npm run test:e2e` 全过；改了卡片小字，截图自查 1280/1024/768/390、浅色深色。**
- [ ] **Step 3: 提交文档，推分支，开 PR（标题写清「后台可靠性第一批」），订阅 PR 动态。**
- [ ] **Step 4: 检查和测试站绿 → 合并（squash）→ 看 `main` 上 Deploy 运行：冒烟和真机联调绿、回滚 skipped → 向站长汇报。**
