# 平板 AI 主动调用 li、li2 实施计划

**设计依据：** [docs/superpowers/specs/2026-11-26-tablet-cloud-tasks-design.md](../specs/2026-11-26-tablet-cloud-tasks-design.md)（Claude Code 编写，站长北京时间 2026-11-26 批准方案「A 云端对话 + 平板后台任务」完整版）。上一步计划见 [2026-11-25-tablet-dshgo-phase1.md](2026-11-25-tablet-dshgo-phase1.md)。

**归属与分工：** 原设计由 Claude Code 编写；本实施计划由 Antigravity（Gemini 4 Neon）编写并自查，待 Muse 复核后再进入后续代码阶段。

**目标：** 在不 fork DSH Go、不引入小芯式复杂内核与调度器、不改动小芯与天启既有代码和配置的前提下，通过平板插件 `liming-cloud`、云端插件 `liming-lease` 及装机脚本扩展，让平板上的本机 AI 作为日常交互主体按需派发、追踪、插话、停止和恢复运行在 `li` / `li2` 上的云端任务。

**技术栈：** Node 22/24（ESM 插件，零需要编译的外部依赖，直接使用 Node 内置 `http`/`fetch`/`WebSocket`/`child_process`/`fs`/`crypto`；`node:test` CJS 单测），Bash（`setup.sh`），DeepSeek Harness `0.2.2-rc.1`（平板，对应 DSH Go `runtime/locks/dsh-0.2.2-rc.1`）与 `0.2.2-rc.3`（`li`/`li2` 云端）。

---

## 阶段总览与排序说明

采用站长与 Muse 确认的 8 阶段顺序，每一阶段独立提交、独立验收、互不破坏：

| 阶段 | 名称 | 核心交付 | 主要前置依赖 |
|---|---|---|---|
| 阶段 1 | 真实 Harness 契约验证脚本 | `scripts/tablet-harness-contract/`（模拟 Responses 服务、探针插件、E1–E7 + 两项补验） | 无 |
| 阶段 2 | `liming-cloud` 骨架：台账、发件箱与云端传输原语 | `site/tablet/liming-cloud/` 核心存储与通信模块（台账、发件箱、密钥脱敏、DSH 客户端、SSH 隧道、托管启动协议） | 阶段 1 |
| 阶段 3 | 三个工具与选机器规则 | `cloud_run`、`cloud_tell`、`cloud_machines` + 5.3 选机器规则 + InstaBox 只读状态 + 工具卡 + `ctx.jobs` 登记桥接 | 阶段 2 |
| 阶段 4 | 面板与状态条 | `composer.strip` + `panels`（`session.tab` 与 `chat.panel`）+ 步骤摘要投影 + 32 KiB / 4 Hz 推流限额 + 卡片交互 | 阶段 2、3 |
| 阶段 5 | 停止协议 | 5.6 先记停止中、四步可重复执行、残留进程清理、取消原因映射表 + Harness 源码扫描核对 | 阶段 2、3 |
| 阶段 6 | 断线对账、通知闭环与恢复 | 5.7 补齐再跟随、启动只读对账、云端中断判定；5.5 进程内 `session/event` 确认通知与 `agent/created` 补投通知 | 阶段 2、3、4、5 |
| 阶段 7 | 云端 `liming-lease` 插件 | `site/tablet/liming-lease/`（按 `agent/status` 与 `ctx.jobs` 持有/续约/释放 `tablet-cloud` 租约） | 阶段 1（无平板插件代码依赖，可与 4–6 并行） |
| 阶段 8 | 装机脚本扩展与文档更新 | 扩展 `site/tablet/setup.sh`、`docs/tablet.md`、`README.md` | 阶段 2–7 |

**顺序微调说明：** 保持建议的 1 → 8 主顺序不变；仅在阶段 2 内一并落地纯协议层原语（`dsh-client.js`、`ssh-tunnel.js`、`remote-bootstrap.js`、`secrets.js`），理由是阶段 3（派活与插话）、阶段 5（四步停止）、阶段 6（补齐再跟随与断线对账）都要共用同一套 `dsh web` HTTP/Mux 客户端与 DSH Go 托管启动约定，前置到阶段 2 可避免阶段 3–6 重复造轮子或中途大改接口，同时阶段 2 仍保持零业务工具、可离线单测。

---

## 全局约束与实测边界备忘

1. **发布隔离与零侵入：**
   - 所有新增文件仅落在 `site/tablet/`、`scripts/tablet-*`、`test/tablet-*`、`docs/`，完整命中 `scripts/xin-live-scope.cjs` 的跳过前缀，保持平板独立发布、不触发小芯真模型联调。
   - 严禁修改 `src/`、`site/xin/`、`site/tools/tianqi/` 及 `li`/`li2` 上的 `headless` 配置与 `~/.xin/`。
2. **公开仓库密钥底线：**
   - 任何 SSH 令牌（`ibssh_*`）、InstaBox API key（`ibk_*`）、网关 key、Cookie（`dsh-auth-*`）或启动令牌（`?token=*`）不得进入仓库、不得出现在终端输出、工具返回、插件日志、面板数据或测试输出中。
   - 平板 `~/.liming-cloud/secrets.json`、台账 `~/.liming-cloud/tasks.json`、云端 `~/.liming-cloud/lease.key` 均强制权限 `600`（所在目录 `700`）。
3. **无编译依赖与插件规范：**
   - `liming-cloud` 与 `liming-lease` 均使用原生 ESM、零 npm 依赖；`engines.dsh` 为 `">=0.2.1-rc.2 <0.3.0-0"`，`engines.node` 为 `">=22.19"`。
   - 遵守设计 §11 核实的 Harness 约束：不用 `defineTool` 时工具 `output.schema` 必须写标准 JSON Schema（`required` 为字符串数组，不能把 `required: true` 写在属性里）；不依赖 `Current runtime context…` / `<system-reminder>…` 等随版本变化的提醒原文。
   - 遵守 DSH Go 原生插件规范：`ctx.inject(['dshGo'], ...)`（绝不写 `'dshGo?'`，也不放进顶层 `inject`）；`dshGo` 清单 ≤ 16 KiB；状态条 ≤ 24 字、面板标题 ≤ 16 字；工具卡 ≤ 8 KiB / ≤ 40 组件 / ≤ 6 层、不含按钮和绑定；面板视图与每次 `emit` ≤ 32 KiB、推流 ≤ 4 Hz；动作 handler 3 秒内返回（耗时操作返回延后效果）。
4. **真实 Harness 源码核实出的关键边界（阶段 2、5、6 实现必守）：**
   - **`session/create` 对非空会话的语义：** 在真实 `0.2.2-rc.3` 的 `ApiSessionAgentController.claim()` 中，携带 `sessionId` 调 `session/create` 时，同 `cwd` 且**尚未开始任何轮次（blank）**才会复用原 `sessionId`；换 `cwd` 报 `session/conflict`；若该会话**已经开始过轮次**，`session/create` 会新生成另一个 `session-<uuid>`。因此阶段 2 发件箱在崩溃恢复补发时，**不得**对已发过轮次的会话盲调 `session/create`，而应先尝试 `session/prompt`（或先查 `session/list` / `session/state` 确认会话不存在），仅当云端报 `session/not-found` 时才调 `session/create(sessionId, cwd)`，并核对返回的 `sessionId` 与预期一致。
   - **`session/cancel` 对冷态未附着会话的语义：** 云端 Harness 崩溃重启后，磁盘上的历史会话未加载进 `ctx.agents`，直接调 `session/cancel` 会返回 `session/not-found`（`not attached`）而非 `{ accepted: true }`。阶段 5 停止协议第 1 步须将 `session/not-found`（且 `session/list` 或 `session/state` 确认 `running === false`）视为「无活动轮次」，继续执行后续后台命令核对与残留进程清理，不得死循环重试。
   - **流式端点归属 `/api/remote.mux`：** `job/list`、`session/follow`、`session/control` 在 Harness 中为流式端点，需通过带登录 Cookie 的 WebSocket `/api/remote.mux` 发送 `{ type: 'open', streamId, endpoint, payload: { args } }` 打开；`session/create`、`session/prompt`、`session/cancel`、`session/list`、`session/page`、`session/state`、`job/kill` 为一元 RPC（`POST /api/<endpoint>`，信封 `{ type: 'client-request', rpcId, method, payload: { args } }`）。

---

## 设计第 7 节验收条款总映射表

| 设计第 7 节条目 | 归属阶段 | 落地的测试/验证文件 | 运行方式 |
|---|---|---|---|
| 派活重试、崩溃在「派发中」之后，云端只有一份对话；补充要求重发只多一轮 | 阶段 2、3 | `test/tablet-cloud-ledger.test.cjs`、`test/tablet-cloud-tools.test.cjs` | `npm run check`（离线） |
| 完成通知只发一次；引擎重启后「完成未告诉」在下一轮补说一次 | 阶段 6 | `test/tablet-cloud-recovery.test.cjs` | `npm run check`（离线） |
| 停止协议：云端那轮还没结束、或后台命令还在、或残留进程还在时不报「已停止」；取消原因表每一行各一条测试 + Harness 源码释放原因扫描 | 阶段 5 | `test/tablet-cloud-stop.test.cjs` | `npm run check`（离线） |
| 选机器规则（冷却排除、剩余不足 45 分钟靠后、同项目/STM32 亲和、醒着优先、闲的优先）每条一条测试；冷却、剩余不足、两台都满、无 key 降级 | 阶段 3 | `test/tablet-cloud-selector.test.cjs` | `npm run check`（离线） |
| 断线重连从同步位置补齐，不重复、不丢步骤 | 阶段 6 | `test/tablet-cloud-recovery.test.cjs` | `npm run check`（离线） |
| `liming-lease`：忙时持有、每 20 分钟续、空闲 2 分钟后释放、key 失败不影响任务、同名冲突/找不到不拿租约 | 阶段 7 | `test/tablet-lease.test.cjs` | `npm run check`（离线） |
| 面板和状态条推送数据不超过 32 KiB、不超过每秒 4 次；工具卡合规 | 阶段 4 | `test/tablet-cloud-ui.test.cjs` | `npm run check`（离线） |
| 密钥文件权限 600；任何输出、日志里不出现令牌和 key | 阶段 2、7、8 | `test/tablet-cloud-ledger.test.cjs`、`test/tablet-cloud-transport.test.cjs`、`test/tablet-lease.test.cjs`、`test/tablet-setup.test.cjs` | `npm run check`（离线） |
| `~/.dsh-app-remote` 托管启动协议隔离并对照 DSH Go 源码写法 | 阶段 2 | `test/tablet-cloud-transport.test.cjs` | `npm run check`（离线） |
| 真实 Harness 契约检查（E1–E7 + 两项通知补验，0.2.2-rc.3 与 0.2.2-rc.1） | 阶段 1 | `scripts/tablet-harness-contract/run.mjs` | 本地/独立工作流手动运行，不进默认 PR CI |
| 真机 5 项验收（研究项目、插话与停止、锁屏 40 分钟租约与补说、空闲 30 分钟休眠、小芯/天启照常） | 阶段 8 后 | `docs/tablet.md` 验收清单 | 站长平板真机对照 |

---

## 分阶段实施明细

### 阶段 1：真实 Harness 契约验证脚本

**目标：** 将设计 §11 的 E1–E7 实验及 §7 点名的两项通知补验整理成仓库内可重复执行的自动化契约套件，针对真实 `dsh web`（云端 `0.2.2-rc.3`、平板 `0.2.2-rc.1` 照 DSH Go `runtime/locks/dsh-0.2.2-rc.1` 原样安装）运行并逐项输出 `PASS` / `FAIL` 与汇总。

**目录约定：** 统一放在 `scripts/tablet-harness-contract/`（原因：命中 `scripts/xin-live-scope.cjs` 的 `scripts/tablet-` 独立发布白名单；同时不在 `test/` 下，不会被 `npm run check` 的 `test/**/*.test.cjs` 扫描拉进每次 PR 的默认 CI，避免 0.6–1.3 GB 下载拖慢 CI）。

**交付物清单：**
- `scripts/tablet-harness-contract/README.md` — 安装与本地运行说明、各用例含义、环境变量说明、为何不进默认 CI。
- `scripts/tablet-harness-contract/install-harness.sh` — 一键在本地缓存目录（默认 `~/.cache/liming-dsh-contract`）安装 `@deepseek-ai/dsh@0.2.2-rc.3` 与照 DSH Go `runtime/locks/dsh-0.2.2-rc.1` 锁定的 `0.2.2-rc.1`。
- `scripts/tablet-harness-contract/mock-responses-server.mjs` — 按 OpenAI Responses SSE 流式协议回复的本地模拟模型服务，支持可编排响应（纯文本、`bash` 前台/后台工具调用、`job_kill` 工具调用、自定义工具调用）与请求日志记录。
- `scripts/tablet-harness-contract/dsh-client.mjs` — 零依赖 `dsh web` 客户端（`GET /?token=` 登录换 Cookie、`POST /api/<端点>` 一元 RPC、`/api/remote.mux` WebSocket 流式订阅）。
- `scripts/tablet-harness-contract/dsh-runner.mjs` — 在临时隔离 `HOME`/`DSH_HOME` 中启停、强杀（`SIGKILL`）与重启真实 `dsh --profile web --host 127.0.0.1 --port 0 --no-open`，支持写入模拟模型线路补丁与 `dsh plugin --profile web add`。
- `scripts/tablet-harness-contract/probe-plugin/`（`package.json`、`cordis.patch.yml`、`lib/index.js`）— 零依赖探针插件：提供标准 JSON Schema 工具输出、可控生命周期的后台任务登记、`cancel(reason)` 记录、`agent/status` 记录、进程内 `session/event` 通知落盘确认、以及重启后 `agent/created` 补投通知与日志去重。
- `scripts/tablet-harness-contract/cases.mjs` — 全部契约用例实现：
  - `E1`：同 `sessionId` 同目录建两次（空白会话返回同一 `sessionId`）、换目录报 `session/conflict`；并记录非空会话调 `session/create` 行为作为阶段 2 护栏证据。
  - `E2`：同一 `requestId` 连发两次、空闲后重发、云端 `SIGKILL` 重启后重发，全过程仅 1 条用户消息、1 轮模型调用。
  - `E3`：前台 `bash` 阻塞期间发 `mode: 'steer'` 插话，进入同一轮下一步（不另起新轮）。
  - `E4`：前台 `bash` 运行中调 `session/cancel`，子进程退出、本轮以 `aborted` / `user` 结束；空闲时重复 `session/cancel` 仍回 `{ accepted: true }`。
  - `E5`：后台 `bash`（`run_in_background: true`）运行中调 `session/cancel`，后台命令仍在跑；经 `job/list` 看到并用 `job/kill` 才停（`requested`），再停回 `already-finished`。
  - `E6`：前台与后台命令运行中 `SIGKILL` 强杀云端 Harness，验证前台命令成为孤儿继续跑（且可按项目目录 cwd 定位并清理）；重启后对话仍在、`running: false`、日志无 `turn/end`、`job/list` 清空、原 `requestId` 重发仍幂等不重开新轮。
  - `E7a`：后台任务在代理空闲时结束，恰好唤醒 1 次、通知正文含 `jobId`、无多余唤醒；同步核对 `agent/status` 的 `running`/`idle` 切换。
  - `E7b`–`E7e`：模型调 `job_kill`（原话）、`POST /api/job/kill`（`cancelled by the user`）、`workspace/archiveSession`（`session archived`）、引擎正常 `SIGTERM` 退出（`owner disposed`），并扫描已安装 Harness 源码核对释放类原因集合（`owner disposed`、`jobs service disposed`、`jobs teardown`、`teardown`）。
  - `E7f`：通知写进日志后重启 Harness，日志保留 `{ kind: 'tool-jobs', form: 'notice' }` 且正文含 `jobId`，重启后探针按日志去重不补发。
  - `C1`（设计 §7 补验 1）：插件进程内仅在 `session/event` 观察到通知写进对话日志后，才把台账状态改为「已告诉」。
  - `C2`（设计 §7 补验 2）：引擎重启前任务已完成但日志无通知；重启后未打开对话时不误记「已告诉」；代理加载触发 `agent/created` 时补投一条 `{ kind: 'liming-cloud', form: 'notice', taskId }` 通知，写进日志后记「已告诉」；再次重启加载不再补投，日志内严格只有 1 条。
- `scripts/tablet-harness-contract/run.mjs` — 命令行入口，支持 `--target rc3|rc1|both`、`--only <用例ID>`，逐项输出 `PASS`/`FAIL`、耗时、关键证据与总汇总；任一项失败退出码非 0。

**依赖：** 本地 Node 22/24、Bash、联网安装 `@deepseek-ai/dsh@0.2.2-rc.3` 与 `0.2.2-rc.1`（或通过环境变量指向已装二进制）。

**验收方式：**
1. `node --check scripts/tablet-harness-contract/*.mjs scripts/tablet-harness-contract/probe-plugin/lib/*.js` 与 `bash -n scripts/tablet-harness-contract/install-harness.sh` 通过。
2. 实跑 `node scripts/tablet-harness-contract/run.mjs --target both`：`0.2.2-rc.3` 上 E1–E6、E7a–E7f、C1、C2 全部 `PASS`；`0.2.2-rc.1` 上 E7a–E7f、C1、C2（及可选 E1–E6）全部 `PASS`。若受环境限制无法实跑，须如实写明原因与缺口。
3. 现有 `npm run check` 保持全绿。

**完成定义：** 脚本、探针插件与运行说明全部入库；真实双版本契约验证全部绿灯（或如实记录环境缺口）；无残留后台进程与临时目录。

---

### 阶段 2：`liming-cloud` 插件骨架、台账、发件箱与云端传输原语

**目标：** 搭建 `site/tablet/liming-cloud/` 插件包骨架，落地持久化台账（`tasks.json` 原子写与版本号）、发件箱（先写台账再发云端、请求编号幂等与崩溃恢复重放）、密钥读写脱敏、`dsh web` JS 客户端、SSH 隧道管理器与 DSH Go 托管启动协议模块。本阶段暂不注册面向模型的工具和 UI 面板。

**交付物清单：**
- `site/tablet/liming-cloud/package.json` — 插件元信息（`type: module`、`engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`、零外部依赖，预留 `dshGo` 清单位置）。
- `site/tablet/liming-cloud/cordis.patch.yml` — 将 `liming-cloud` 挂入平板 `web` 配置。
- `site/tablet/liming-cloud/lib/redact.js` — 统一脱敏器：屏蔽 `ibssh_*`、`ibk_*`、`sk-*`、`dsh-auth-*`、`token=*`，供日志、报错与工具返回共用。
- `site/tablet/liming-cloud/lib/secrets.js` — 读写 `~/.liming-cloud/secrets.json`（强制目录 `700`、文件 `600`，原子写；拒绝写入含 `machines:delete` 标记或非法结构；按机器返回 SSH 目标与只读 key）。
- `site/tablet/liming-cloud/lib/ledger.js` — 台账存储 `~/.liming-cloud/tasks.json`（目录 `700`、文件 `600`、临时文件 + `fsync` + `rename` 原子写、`schemaVersion: 1` 及迁移钩子；任务主键、所属平板对话、机器、确定性云端对话编号 `tablet-<taskId>`、项目目录、标题、状态枚举 `dispatching|running|stopping|completed|failed|interrupted|stopped`、开始/结束时间、最近同步 `lastSeq`、发件箱数组、停止请求记录、通知状态 `none|pending|confirmed`、结果摘要）。
- `site/tablet/liming-cloud/lib/outbox.js` — 发件箱引擎：
  - 先写台账（`status: 'pending'`，含 `requestId`、`sessionId`、`cwd`、`text`、`mode: 'queue'|'steer'`、`createdAt`），再发云端；云端回 `{ accepted: true }` 后原子更新为 `'acked'`。
  - 发送策略严格遵守阶段 1 核实边界：对已有轮次或恢复中的任务先调 `session/prompt(sessionId, requestId)`，仅在云端返回 `session/not-found` 时才调 `session/create({ sessionId, cwd })`（若返回不同 `sessionId` 直接判异常拒绝重复派发，若返回 `session/conflict` 记清晰错误），随后再发 `session/prompt`。
  - 支持幂等重放：重复调用 `flushOutbox(taskId)` 跳过已 `acked` 条目，按顺序补发未确认条目。
- `site/tablet/liming-cloud/lib/dsh-client.js` — 最小零依赖 `dsh web` HTTP + WebSocket Mux 客户端（照 `dsh_client`：`GET /?token=` 换 `dsh-auth-*` Cookie、`POST /api/<端点>`、`/api/remote.mux` 订阅 `session/follow`/`job/list`/`session/control`、401 自动重新登录、超时与取消信号）。
- `site/tablet/liming-cloud/lib/remote-bootstrap.js` — 独立隔离 DSH Go `~/.dsh-app-remote/` 托管启动约定（严格对照 `app/lib/remote/ssh/remote_bootstrap.dart`：`web.pid`、`web.st` 进程启动时间防 PID 复用、`web.cmd` 命令一致性检查、`web.log` 解析 `token=`、不同命令不杀直接报 `shared` 错误、启动命令固定 `/data/home/.local/bin/dsh-tablet`）。
- `site/tablet/liming-cloud/lib/ssh-tunnel.js` — 基于系统 `ssh`（ControlMaster + `-L 127.0.0.1:<localPort>:127.0.0.1:<remotePort>`）的每机单隧道复用器：按需建立、无进行中任务自动关闭、掉线指数退避重连、进程组干净退出、日志绝不打印令牌。
- `site/tablet/liming-cloud/lib/index.js` — 插件最小入口，挂载台账/配置/生命周期清理（`ctx.effect`）。

**依赖：** 阶段 1 确认的真实 `dsh web` 协议与边界。

**验收方式（全部进入 `npm run check`，离线执行）：**
- `test/tablet-cloud-ledger.test.cjs`：
  - 台账初始化、目录 `700` / 文件 `600` 权限检查、原子写中断不损坏原文件、`schemaVersion` 读写与未知高版本保护。
  - 确定性云端对话编号生成与项目目录名生成（纯 ASCII + 短编号，拒绝路径穿越）。
  - 发件箱「先写台账再发云端」：模拟在 `session/create` 前崩、建完对话发消息前崩、云端接受后丢回执崩，重启重放后假 `dsh web` 中只有 1 份对话、1 条消息、1 轮；`cloud_tell` 补充要求重发只多 1 轮。
  - 模拟已有轮次会话在恢复时不误调 `session/create` 导致多开 `session-<uuid>`。
  - `secrets.json` 权限 `600`、`redact` 对令牌/key/cookie/launch token 100% 屏蔽。
- `test/tablet-cloud-transport.test.cjs`：
  - 用本机 Node 假 `dsh web`（HTTP + WebSocket）测登录换 Cookie、401 重登、一元 RPC、Mux 流式读取与断线报错。
  - 用本机 `/bin/sh` 实跑 `remote-bootstrap.js` 生成的 probe/start 脚本（临时 `HOME` + 假 `dsh-tablet`）：覆盖首次启动、复用运行中实例、PID 死亡重拉、`web.st` 防 PID 复用、不同 `web.cmd` 不杀且返回共享实例错误（对照 `remote_bootstrap.dart`）。
  - 用假 `ssh` 脚本测 `ssh-tunnel.js` 按需建隧道、复用、无活跃任务自动断开、日志与异常不泄露 `ibssh_` 令牌。

**完成定义：** 上述模块与两份单测文件完成，`npm run check` 全绿，零外部依赖，无真实网络或云机调用。

---

### 阶段 3：`cloud_run` / `cloud_tell` / `cloud_machines` 工具与选机器规则

**目标：** 实现平板 AI 可调用的三个极简工具、设计 §5.3 的选机器规则（含 InstaBox 只读客户端与无 key 降级精简版）、插件配置项（单机并发上限初始 2）、工具返回只读工具卡（`presentationMeta`），以及 `ctx.jobs` 后台任务把手登记。

**交付物清单：**
- `site/tablet/liming-cloud/lib/instabox-read.js` — InstaBox 只读状态客户端（仅调 `GET /v1/machines`、`GET /v1/machines/{id}/metrics`，绝不调任何会唤醒机器的写接口；解析 `status`、`runStartedAt`、`maxRunMinutes`、`cooldownUntil`、`autoSuspendedAt` 与 CPU 利用率；计算本轮剩余分钟数与冷却截止北京时间 `HH:MM`；某台缺少只读 key 或请求失败时平滑降级为 `{ unknown: true }`）。
- `site/tablet/liming-cloud/lib/selector.js` — 设计 §5.3 选机器纯函数：
  1. 排除冷却中机器（`cooldownUntil > now`）；两台都冷却时返回不可派与最早可用北京时间。
  2. 每台平板任务数达到可配上限（默认 `maxConcurrentPerMachine = 2`）时优先另一台；两台都满时拒绝派活并返回两台现状。
  3. 本轮剩余时间 `< 45` 分钟的排在后面；仅剩它可用时照派，并附带冻结预警文案（「这台大约 N 分钟后会暂停，到时任务冻结，冷却结束后接着跑」）。
  4. 续做已有项目（`continue_of` 或台账同名项目）回原机器；命中 STM32 工具链特征（如 `stm32`、`arm-none-eabi`、`openocd`、`cube`、`hal`）去 `li`。
  5. 醒着（`running`）优先于暂停（省约 40 秒唤醒且不新开计时）。
  6. 闲的优先：先比平板在该机进行中的任务数，再比 CPU，仍平手选最久未用的一台。
  7. 某台只读状态未知时按精简版规则（跳过规则 1 与 CPU 比较，仅看台账最近联系与任务数，标记「状态未知」）。
  8. 返回清晰中文挑选理由字符串。
- `site/tablet/liming-cloud/lib/job-bridge.js` — 将台账中的云端任务登记为平板本地 `ctx.jobs` 后台任务（`kind: 'cloud'`，传入所属平板 `sessionId` 作为 `owner`），桥接进度行（`updateProgress`）与摘要输出（`append`），预留取消回调钩子（阶段 5 接满）。
- `site/tablet/liming-cloud/lib/tool-card.js` — 零依赖 `toolCard()` 包装（保证无损 JSON、捕获异常、严守 8 KiB 上限、仅只读展示组件不含按钮和绑定），生成 `cloud_run` 派活回执卡（「已交给 li2 · 研究 XX · 任务 3」）。
- `site/tablet/liming-cloud/lib/tools.js` — 注册三个工具（标准 JSON Schema `output.schema`，`required` 写数组）及 `ctx.systemPrompt.section` 简短使用指引：
  - `cloud_run(task, machine?, project?, continue_of?, model?)`：选机器 → 确保云端常驻实例在跑 → 写台账与发件箱 → 投递云端（指定 `model` 时先调 `session/selectModel`，不填用默认）→ 登记本机后台任务 → 立即返回 `{ taskId, machine, project, reason, warning?, jobId }` + 只读工具卡。
  - `cloud_tell(task_id, text)`：若任务进行中则写入发件箱（`mode: 'steer'`）并插话进当前轮；若任务已完成/已停止/已中断则在原云端对话里以 `mode: 'queue'` 开新一轮、重新登记后台任务并立即返回。
  - `cloud_machines()`：汇总两台机器醒睡状态、本轮剩余时间、冷却到几点、CPU、平板在该机的任务、做过的项目。
- 更新 `site/tablet/liming-cloud/lib/index.js` — 暴露插件配置 schema（`maxConcurrentPerMachine`，默认 2）并挂载三个工具与指引。

**依赖：** 阶段 2 全部交付物。

**验收方式（全部进入 `npm run check`，离线执行）：**
- `test/tablet-cloud-selector.test.cjs`：
  - 冷却排除（单台冷却选另一台、两台都冷却拒绝派活并给出最早可用 `HH:MM`）。
  - 剩余时间 `< 45` 分钟靠后（有别机选别机；仅它可用时照派且返回冻结预警）。
  - 同项目续做回原机器、STM32 特征去 `li`。
  - 醒着优先于暂停。
  - 闲的优先：先比平板任务数，再比 CPU，平手比最久未用。
  - 并发上限默认 2、配置改上限生效、两台都满拒绝派活并返回现状。
  - 某台缺只读 key 或 API 报错时退回精简版且标记「状态未知」，另一台正常判断。
- `test/tablet-cloud-tools.test.cjs`：
  - 用假 `dsh web` + 假 InstaBox API + 假 `ctx.jobs` 测 `cloud_run` 立即返回（不等云端任务完成）、工具卡合法且 ≤ 8 KiB 无按钮、参数与输出严格符合标准 JSON Schema（`required` 为数组）。
  - `cloud_run` 带 `model` 时调用 `session/selectModel`，不带时走默认。
  - `cloud_tell` 在进行中发 `steer`、在已完成/已停止后发 `queue` 并登记新后台任务；相同请求编号重发幂等只多一轮。
  - `cloud_machines` 不调任何唤醒写接口、返回信息完整且脱敏。

**完成定义：** 三个工具与选机器逻辑完整落地；`test/tablet-cloud-selector.test.cjs` 与 `test/tablet-cloud-tools.test.cjs` 及全仓 `npm run check` 全绿。

---

### 阶段 4：面板与状态条（原生 UI 集成）

**目标：** 在不改 DSH Go 源码的前提下，通过 `package.json` 的 `dshGo` 清单与 `ctx.dshGo` 注册「输入框上方状态条」和「云端任务」面板（同时挂到对话详情侧栏 `session.tab` 与聊天页弹层 `chat.panel`），实现实时步骤投影、32 KiB / 4 Hz 推流限流，以及卡片上的插话、停止（带确认）、接着做操作。

**交付物清单：**
- 更新 `site/tablet/liming-cloud/package.json` — 增加 `dshGo` 清单（`v: 1`、`composer.strip` 1 条指向面板 `cloud-tasks`、`panels` 1 个 `id: "cloud-tasks"` 放 `["session.tab", "chat.panel"]`、`presentation: "sheet"`，中英文文案全部校验字数上限，整段 ≤ 16 KiB）。
- `site/tablet/liming-cloud/lib/steps.js` — 云端 `SessionWireEvent` 到「步骤」的纯投影器：仅提取三类（工具调用名 + 一句话参数、AI 简短回复截短、轮次结束原因），单条长度受控，不搬运完整输出；支持摘要模式（最近 3 步）与展开模式（本次时间线）。
- `site/tablet/liming-cloud/lib/throttle.js` — 推流限额器：合并高频变更，确保发往 `emit` 的频率严格 `≤ 4 次/秒`（间隔 ≥ 250ms，保留尾帧）；推送前序列化测量 UTF-8 字节数，超过 `32 KiB` 自动按优先级裁剪非展开任务的旧步骤与长摘要，保底永不超 32 KiB。
- `site/tablet/liming-cloud/lib/ui.js` — `ctx.inject(['dshGo'], ...)` 桥接层：
  - 状态条 `strip('cloud-status')`：展示运行中任务（如「☁ li2 研究中 · 7 分钟」）、完成未读（「☁ 1 件完成」）、剩余时长不足 30 分钟提醒（「☁ li2 剩 25 分钟」）、冷却提示（「☁ 冷却到 HH:MM」），严格 ≤ 24 字。
  - 面板 `panel('cloud-tasks')`：使用 DSH Go v2 受限组件（每任务一卡：标题、机器、状态、已用时间、本轮剩余时间、最近 3 步 + 展开时间线、结果摘要；发件箱待确认时显示「正在送达」；停止中显示「停止中（正在确认）」；卡片操作：「插话」表单提交、「停止」带 `confirm` 确认、终态/中断态「接着做」）。
  - 所有动作 handler 3 秒内返回（耗时操作走延后/异步更新 + `toast` / `patch`），面板取消订阅时清理监听器不再 `emit`。

**依赖：** 阶段 2（台账）、阶段 3（`cloud_tell` / `cloud_run` 入口与机器状态）。

**验收方式（全部进入 `npm run check`，离线执行）：**
- `test/tablet-cloud-ui.test.cjs`：
  - `dshGo` 清单合法性校验：id 唯一性、状态条 ≤ 24 字、面板标题 ≤ 16 字、清单 ≤ 16 KiB、`ctx.inject(['dshGo'], ...)` 挂载方式（不进顶层 `inject`、不用 `'dshGo?'`）。
  - 推流限额测试：在 100ms 内连续触发 50 次状态变化，断言实际 `emit` 次数满足 `≤ 4 次/秒` 且最终状态不丢失（尾帧送达）。
  - 大小上限测试：构造 20 个带超长输出的任务，断言任意一次 `emit` 的 JSON UTF-8 字节数严格 `≤ 32768` 字节，且组件数 ≤ 120、嵌套深度 ≤ 8。
  - 步骤投影测试：验证只映射三类事件，截短生效，大输出不进推送载荷。
  - 交互动作测试：模拟卡片「插话」、「停止确认（confirmed true/false）」、「接着做」调用对应业务函数且在 3 秒内返回合法效果，取消订阅后不再 `emit`。

**完成定义：** 面板、状态条与限流器全部落地并通过 `test/tablet-cloud-ui.test.cjs` 及全仓 `npm run check`。

---

### 阶段 5：停止协议（设计 §5.6）

**目标：** 实现可中断、可重入、先落盘后执行的四步停止协议，以及精确的取消原因映射表与 Harness 源码防漂移单测，保证「说已停止时云端确实停了，引擎退出时不误停云端」。

**交付物清单：**
- `site/tablet/liming-cloud/lib/cancel-reasons.js` — 取消原因分类器与释放类白名单：
  - `DETACH_ONLY_REASONS = new Set(['owner disposed', 'jobs service disposed', 'jobs teardown', 'teardown'])` → 仅解除平板后台任务关联，台账保持 `running`，绝不停云端。
  - 其余来源（模型调 `job_kill` 填的任意原因、`cancelled by the user`、`session archived`）→ 触发云端停止协议。
- `site/tablet/liming-cloud/lib/stop.js` — 可重复执行的四步停止状态机：
  - **第 0 步（先记下）：** 先原子写台账 `status = 'stopping'`，记录 `{ source, reason, requestedAt }`；面板显示「停止中（正在确认）」。
  - **第 1 步（停当前轮）：** 调云端 `session/cancel`；`{ accepted: true }` 或冷态未附着（`session/not-found` 且 `running === false`）均视为本步完成。
  - **第 2 步（停后台命令）：** 经 Mux 打开 `job/list` 读取该对话所有运行中/停止中的后台命令，逐个调 `job/kill`（`requested` 或 `already-finished` 均通过），等待它们进入终态。
  - **第 3 步（清项目目录残留进程）：** 经现有 SSH 连接在云端扫描工作目录（`/proc/<pid>/cwd`）位于该任务 `/data/workspace/tablet/<项目>` 下的残留进程，先 `SIGTERM`，等宽限期后仍存活再 `SIGKILL`，记录实际清理的 PID 与命令；不越界碰项目目录以外进程（若有脱离目录的外部进程如实记入说明、不虚报已停）。
  - **第 4 步（复核落终态）：** 重新核对云端 `session/state` / `session/list`（`running === false`）、`job/list` 无活跃后台命令、项目目录无残留进程，四项全过才把台账改为 `stopped`；中途断线则保持 `stopping`，留待阶段 6 重连/重启后接着跑完。
- 接入 `job-bridge.js` 的 `cancel(reason)` 回调与 `ui.js` 面板「停止」确认动作。

**依赖：** 阶段 2（台账、DSH 客户端、SSH 连接）、阶段 3（`job-bridge.js`）。

**验收方式（全部进入 `npm run check`，离线执行）：**
- `test/tablet-cloud-stop.test.cjs`：
  - 四步停止完整流程：仅在轮次结束 + 后台命令清空 + 残留进程清零三者全部复核通过后才变 `stopped`。
  - 负例守卫：云端轮次仍在跑时**不报** `stopped`；后台命令还在跑时**不报** `stopped`；项目目录残留进程杀不掉时**不报** `stopped`；中途断线停留在 `stopping`，重连重跑幂等收尾。
  - 云端重启后冷态会话 `session/cancel` 报 `session/not-found` 时，仍正确推进到残留进程清理与复核。
  - 取消原因表**逐行覆盖测试**：
    1. 模型 `job_kill` 自定义原因（如 `"no longer needed"`）→ 停云端；
    2. `'cancelled by the user'` → 停云端；
    3. `'session archived'` → 停云端；
    4. `'owner disposed'` → 不停云端，台账保持 `running`；
    5. `'jobs service disposed'` → 不停云端；
    6. `'jobs teardown'` → 不停云端；
    7. `'teardown'` → 不停云端；
    8. 面板点「停止」直接走停止协议（不经过取消原因）。
  - Harness 源码释放原因扫描测试：如果环境变量或本地安装路径存在 `@deepseek-ai/dsh-jobs-local` / `@deepseek-ai/dsh-jobs`，扫描其 `cancelForTeardown` / `disposeOwned` / `disposeAll` 原因字面量并断言全部在 `DETACH_ONLY_REASONS` 中；离线 CI 环境无 Harness 安装时同时对内置契约快照做守卫断言（不跳过测试）。

**完成定义：** 四步停止协议与取消原因表落地，`test/tablet-cloud-stop.test.cjs` 与全仓 `npm run check` 全绿。

---

### 阶段 6：断线对账、通知闭环与恢复（设计 §5.5 & §5.7）

**目标：** 完成断线重连「从 `lastSeq` 补齐再跟随」、插件启动只读对账、云端中断判定与清理，以及设计 §5.5 的「通知不丢也不重复」闭环（进程内 `session/event` 确认后才记已告诉 + 引擎重启后 `agent/created` 补投通知并按日志去重）。

**交付物清单：**
- `site/tablet/liming-cloud/lib/sync.js` — 云端对话事件同步器：
  - 正常时订阅 `/api/remote.mux` 的 `session/follow`；掉线后按指数退避重连，先用 `session/page` 从台账 `lastSeq` 补齐缺失事件，按 `seq` 去重推进 `lastSeq`，再接回实时跟随。
  - 监听每轮终态（`turn/end`）更新台账状态（`completed` / `failed` / `stopped`）与结果摘要；监测机器剩余时长 `< 30` 分钟时触发状态条/面板提醒，并在下一轮对话向平板 AI 追加一条带来源的读数提示（参考 `dsh-time-context`）。
  - 没有活跃任务时关闭该机 SSH 隧道与跟随流，不拖住云电脑。
- `site/tablet/liming-cloud/lib/notifier.js` — 设计 §5.5 完成通知闭环：
  - 正常路径：云端轮次结束 → 台账先写 `status: 'completed', noticeState: 'pending'` → 结算本机 `ctx.jobs` 后台任务（由上游 `tool-jobs` 写日志并唤醒空闲代理）→ 订阅本机 `ctx.on('session/event', ...)` 监听 `user/message`，识别 `source.kind === 'tool-jobs' && source.form === 'notice'` 且正文包含对应 `jobId`（或 `taskId`），**确认写进日志后**才把台账改为 `noticeState: 'confirmed'`。
  - 重启补投路径：监听 `ctx.on('agent/created', ({ agent }) => ...)`；当某平板对话存在 `noticeState === 'pending'` 的任务且该对话代理加载出现时，先检查 `agent.session` 日志里是否已有对应 `jobId`/`taskId` 的 `tool-jobs` 或 `liming-cloud` 通知——已有则直接补记 `confirmed` 不重发；没有则构造 `UserMessage`（`source: { kind: 'liming-cloud', form: 'notice', summary, taskId }`），代理 `idle` 调 `agent.followup(msg)`、`running` 调 `agent.inject(msg)`，同样在 `session/event` 看到写进日志后才记 `confirmed`。
  - 未确认前，面板与状态条持续显示「完成（未读）」。
- `site/tablet/liming-cloud/lib/reconcile.js` — 启动与重连对账器：
  - 启动读台账：对 `running` / `dispatching` / `stopping` 任务先用只读 key 查机器状态（绝不唤醒）；机器醒着才建隧道对账，睡着且无冷却时等站长打开面板或开口再连，冷却中则等 `cooldownUntil` 后再连一次。
  - 对账分类处理：
    - `stopping` → 继续执行阶段 5 四步停止直到复核完成；
    - 发件箱有 `pending` → 按阶段 2 幂等补发；
    - 云端 `session/list` 找不到该对话 → 标 `failed`（「云端对话不见了」），不重派；
    - 云端仍在跑（`running: true`）→ 补齐步骤、重建平板 `ctx.jobs` 把手并恢复跟随；
    - 云端已停且最后一轮有 `turn/end` → 补齐结果、走 `notifier.js` 补说；
    - 云端已停（`running: false`）且最后一轮有 `turn/start` 却**无 `turn/end`** → 标 `interrupted`（「云端中断」），按阶段 5 第 3 步清理该项目目录残留进程，面板展示「接着做」按钮，不自动重派。
- 更新 `site/tablet/liming-cloud/lib/index.js` 串联全部生命周期。

**依赖：** 阶段 2、3、4、5。

**验收方式（全部进入 `npm run check`，离线执行）：**
- `test/tablet-cloud-recovery.test.cjs`：
  - 断线重连补齐：运行中切断 Mux 并在云端新增 5 条事件，重连后从 `lastSeq` 补齐再切回跟随，最终步骤序列严格连续、不重复、不丢步。
  - 正常完成通知：云端完成后先记 `noticeState: 'pending'`；只有触发 `session/event` 日志写入才变为 `confirmed`，且只发一次。
  - 引擎重启补投：任务在「完成、未确认」时重启，未触发 `agent/created` 前保持「完成（未读）」；代理出现后若日志已有 `tool-jobs` 通知则补记 `confirmed` 不重发；若日志无通知则补投一次 `{ kind: 'liming-cloud', form: 'notice', taskId }`（测 `idle` 走 `followup`、`running` 走 `inject`），日志落盘后记 `confirmed`，再次重启不再重复。
  - 启动对账不唤醒睡眠机器：机器 `suspended` 时启动插件不发起 SSH/唤醒请求；机器在冷却中不反复重试，仅在 `cooldownUntil` 之后连一次。
  - 云端中断判定：`running === false` 且日志最后一轮只有 `turn/start` 无 `turn/end` → 标 `interrupted`、触发残留进程清理、不自动重派。
  - 云端对话消失 → 标 `failed` 不重派；`stopping` 未完成 → 重连后自动续停；无任务时自动关闭 SSH 隧道。
  - 剩余时长 `< 30` 分钟提醒：触发状态条/面板提醒与 AI 读数注入。

**完成定义：** 断线恢复、对账与通知闭环完成，`test/tablet-cloud-recovery.test.cjs` 与全仓 `npm run check` 全绿；并可用真实 Harness 契约脚本复验无回归。

---

### 阶段 7：云端 `liming-lease` 插件（设计 §5.8）

**目标：** 在 `site/tablet/liming-lease/` 实现装在 `li`、`li2` 的 Harness `web` 配置里的轻量化租约守护插件：有平板对话在忙或有后台命令在跑就自动持有与续约 InstaBox 活动租约 `tablet-cloud`，全部空闲 2 分钟后释放，绝不影响任务执行本身。

**交付物清单：**
- `site/tablet/liming-lease/package.json` — 插件元信息（`type: module`、零外部依赖、`engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`）。
- `site/tablet/liming-lease/cordis.patch.yml` — 将 `liming-lease` 挂入云端 `web` 配置（不影响 `headless`）。
- `site/tablet/liming-lease/lib/lease.js` — 租约状态机：
  - 读取 `~/.liming-cloud/lease.key`（检查文件权限为 `600`，读不到只记警告日志，不抛异常影响引擎与任务）和装机写入的机器名 `~/.liming-cloud/machine-name`（`li` 或 `li2`）。
  - 调用 `GET https://api.instabox.sh/v1/machines` 按名字精确匹配机器 ID；找不到或同名不止一台时记警告日志、不拿租约。
  - 活跃判定：任一代理处于 `running`（`agent/status`）**或**任一后台命令在跑（`ctx.jobs.events` 跟踪 `registered` / `settled` / `removed`）。
  - 持有与续约：变为活跃时立即 `PUT /v1/machines/{id}/activity-leases/tablet-cloud`（`{ ttlSeconds: 3600 }`），之后每 `20 分钟`续约一次；期间所有网络/HTTP 错误只记脱敏日志、按退避重试，绝不抛出或中断任务。
  - 释放：全部变为空闲后启动 `2 分钟`释放定时器，期间若再次变忙则取消定时器；满 2 分钟仍空闲则调 `DELETE /v1/machines/{id}/activity-leases/tablet-cloud`（InstaBox 保证 DELETE 不唤醒机器）。
  - 插件卸载（`ctx.effect` 清理函数）时清掉所有定时器并尽力释放租约。
- `site/tablet/liming-lease/lib/index.js` — 插件挂载入口，订阅 `agent/status` 与 `ctx.jobs.events`。

**依赖：** 阶段 1 已核实 `agent/status` 给出 `running`/`idle` 及 `ctx.jobs.events` 生命周期。

**验收方式（全部进入 `npm run check`，离线执行）：**
- `test/tablet-lease.test.cjs`（用本机假 InstaBox HTTP 服务 + 加速时钟参数）：
  - 忙时立即 `PUT` `tablet-cloud`（`ttlSeconds: 3600`），持续忙时每 20 分钟续约一次。
  - 代理变 `idle` 但仍有后台命令在跑时保持租约不释放；全部空闲后等满 2 分钟调 `DELETE` 释放；2 分钟内再次变忙取消释放。
  - 按机器名解析 ID：正常唯一匹配拿租约；找不到同名或存在两台同名时不拿租约、只记日志。
  - 缺 `lease.key`、权限过宽告警、或 API 返回 401/403/500/超时时只记日志、不抛错、不影响代理运行；任何日志里绝不出现 key 原文。
  - 卸载插件时清理所有定时器与句柄（无事件循环泄漏）。

**完成定义：** `liming-lease` 插件与 `test/tablet-lease.test.cjs` 完成，`npm run check` 全绿。

---

### 阶段 8：装机脚本扩展与 `docs/tablet.md` 更新（设计 §5.11）

**目标：** 扩展 `site/tablet/setup.sh` 支持一键部署 `liming-cloud`（平板）与 `liming-lease`（`li`/`li2`）、无回显安全录入并保存两台 SSH 令牌与四把受限 InstaBox key、可幂等重复执行；同步更新 `docs/tablet.md` 与 `README.md`，最后完成全量验证、契约回归与站长真机核对清单。

**交付物清单：**
- 修改 `site/tablet/setup.sh`：
  - 新增从 `$BASE/liming-cloud/...` 与 `$BASE/liming-lease/...` 下载校验文件清单（继续用 `fetch_file` 防首页 HTML）。
  - 交互录入（`read -rs <&3`，不回显、不打印、可跳过某台或直接回车沿用已有）：
    - `li2`、`li` 的 SSH 令牌 → 写入平板 `~/.liming-cloud/secrets.json`（目录 `700`、文件 `600`）；
    - `li2`、`li` 各自账号的**只读** key（`machines:read`）→ 写入平板 `~/.liming-cloud/secrets.json`；
    - `li2`、`li` 各自账号的**写** key（仅 `machines:write`，不含删除）→ 经 SSH 管道直接写入对应远端 `~/.liming-cloud/lease.key`（`600`，**不落平板磁盘**）与 `~/.liming-cloud/machine-name`（`li2` 或 `li`）。
  - 安装 `liming-cloud` 到 `/root/liming-cloud` 并首次执行 `dsh plugin --profile web add /root/liming-cloud`。
  - 经 SSH 将 `liming-lease` 部署到远端 `~/.liming-lease` 并首次执行 `dsh plugin --profile web add "$HOME/.liming-lease"`；保留已有 `dsh-tablet` 与 `cordis.patch.yml` 安装逻辑，不碰 `headless` 配置。
  - 保持 `--dry-run`、`--skip-li` 及可重复运行幂等性（已装插件跳过 `add` 但更新源码文件；已有密钥未重填时不覆盖）。
- 更新 `docs/tablet.md` — 更新为「日常都在本机聊，AI 主动调 li / li2；远程主机仅作调试」的操作步骤，写清四把受限 key 的 InstaBox 后台创建步骤与权限勾选项（明确禁止勾 `machines:delete`）、丢机吊销步骤、以及真机 5 项验收对照表。
- 更新 `README.md` — 同步「平板（DSH Go）」一节简介与链接。

**依赖：** 阶段 2–7 全部合并或就绪。

**验收方式：**
- 扩展 `test/tablet-setup.test.cjs`（纳入 `npm run check`）：
  - `bash -n` 与 `shellcheck` 无告警；全仓 `site/tablet/` 无任何真实/测试密钥泄漏。
  - 完整模拟装机：核对平板 `~/.liming-cloud/secrets.json` 权限 `600` 且**绝不含**云端写 key；远端 `~/.liming-cloud/lease.key` 权限 `600` 且 `machine-name` 正确；两插件文件到位且 `dsh plugin --profile web add` 准确调用；标准输出与日志中零令牌、零 key。
  - 重复运行幂等：跳过重复下载与重复 `plugin add`，已有 `accounts/` 与已有密钥不被误删。
  - `--dry-run` 不改任何文件；`--skip-li` 只配置 `li2`。
- 全量验证：
  - `npm run check`（全仓语法、资源引用与全部单测）全绿。
  - `npm run test:e2e`（浏览器全套 E2E，确认未波及网站/小芯/天启）全绿。
  - 发布前重跑阶段 1 的真实 Harness 契约脚本（`0.2.2-rc.3` 与 `0.2.2-rc.1`）全绿，结果写入 PR 说明。
- 真机对照（上线后由站长按设计 §7 真机 5 项逐条验收，并含 `liming-lease` 真实持租与释放验证）。

**完成定义：** 装机脚本与文档全部更新，全套单测、shellcheck、浏览器 E2E、真实 Harness 契约脚本全部绿灯；按 `CLAUDE.md` 与 `AGENTS.md` 规范经复核后合并上线。
