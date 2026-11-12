# 小芯对照 7 个开源项目的研究笔记（讨论稿）

- 日期：北京时间 2026-11-11。只读研究，没有改代码。
- 对照的小芯版本：`main` 49f2470（#120）。行号都对应这个提交。
- 状态：2026-11-11 站长同意第 6 节的方向和第一批顺序，并决定加上用量看板（见第 5 节）。具体设计见 `docs/xin-reliability-usage-design.md`。
- 进度（2026-11-12）：第一批（#121）、用量看板（#122）、第二批（#123）、机外备份（#124）都已上线；3.2 的集合目录限制和第二批留下的三个小问题在「收尾」那一批做完。下一步是第三批浏览器 v1，先做公开网页。

## 0. 结论

1. 小芯的底座（输入去重、事务日志、调度车道、完成交接、记忆的证据核对、后台容器）和参考项目里最成熟的做法是同一类，有几处更严。**不需要换架构，也不需要「多智能体」。**
2. 站长列的 7 个疑虑，核对后：第 1 条（临时目录丢成果）基本不成立，但有个新小坑；第 4 条（写回中途失败）成立；第 3、5 条成立但第 5 条比之前审查说的轻；第 2、6 条影响小；第 7 条没找到确定的 bug。
3. 更该先做的是四件站长没点名的事：每日任务会把所有后台任务堵住；任务中途遇到临时网络/模型错误直接算失败；等站长回答时云电脑一直醒着；云电脑之外没有备份。
4. 反对引入：多 agent 互相通话、统计看板、让模型逐个审查动作、常驻服务改造、加大并发。

## 1. 看了什么

| 项目 | 看的核心代码 |
|---|---|
| Grok Bot 0.18 重建 | `host/extensions/transcript/run-scheduler.ts`、`prompt-acceptance-ledger.ts`、`background-wakes.ts`、`upgrade-recreate-resume.ts`；`host/runner/sand-memory.ts`、`transient-stream-error.ts`、`background-work.ts`、`tools/sand-browser-tools.ts`、`sand-browser-auto-review.ts`；`extensions/box-store-sync/` |
| Open-Grokbot | `packages/core/src/run-scheduler.ts`、`run-lifecycle.ts`、`policies.ts`；`packages/runner/src/agent-runner.ts`；`packages/state/src/memory.ts` |
| OpenMuse | `docs/COMPUTER.md`；`apps/worker/README.md`（浏览器服务）；`apps/server/src/engine/worker.ts`（租约）、`actions.ts`（待审提议） |
| OpenDuet（OpenBot） | `openbot/agent-computer/src/index.ts`、`secret-masking.ts`；`openbot/server/src/approvals/types.ts` |
| OpenAI Codex | `codex-rs/memories/README.md` 和抽取提示词；`codex-rs/network-proxy/README.md`；`core/src/guardian_review.rs`；`app-server-daemon/README.md` |
| opencode | `packages/core/src/session/run-coordinator.ts`、`inbox.ts`、`subagent-completion.ts`、`background.ts`；`packages/core/src/snapshot.ts`、`job.ts` |
| Agent HUD Open | `docs/agent-contract.md`、`session-data.md`、`agent-messages.md`、`performance.md`；`src/crates/core/src/requests.rs` |

另外在正式云电脑上跑了一条只读命令（电脑本来就醒着，只看路径和大小，不读内容）：控制器进程的 `TMPDIR=/data/tmp`，Node 的 `os.tmpdir()` 也是 `/data/tmp`；`/tmp` 是 1.9G 的内存盘，没有任务副本在里面；`~/.xin` 共 82 轮、10 个对话，`workflow.sqlite` 772 KB。

## 2. 已经做得好、不用动的

| 方面 | 小芯 | 参考项目里的对应做法 |
|---|---|---|
| 输入去重 | `commands` 表按 clientId + 内容摘要，同号不同内容拒绝（`vm-state.mjs` 的 `atomic`） | Grok Bot `prompt-acceptance-ledger.ts`：nonce + digest，同号不同内容报 `NONCE_DIGEST_MISMATCH`。同一个做法 |
| 调度车道 | `launches.lane`：用户 0、完成交接 1、每日 2 | Grok Bot `SandRunScheduler`：user / agent / background 三条道。同一个做法 |
| 完成交接 | `handoffs` 表带结果版本号，过期作废；自动续接最多 2 次；失败有兜底 | opencode 插一条 `<subagent state=…>`；Agent HUD 消息链默认最多 10 跳。小芯更严 |
| 记忆 | 依据分明说/观察/推测；「明说」要求引文逐字出现在本轮原话里；忘掉只留哈希并封锁出处；有版本可回退（`vm-memory.mjs`、`vm-agent.mjs` 的 `companionCmd`） | Grok Bot 分 profile/log/note，模型提取后直接写；Codex 两阶段抽取+合并，没有依据之分；OpenDuet 交给托管服务。**小芯是这几家里最严的** |
| 后台容器 | bwrap 独立网络命名空间、一次性推理令牌钉死模型、出网只到公网 80/443 并按解析出的 IP 直连防重绑定（`vm-runtime.mjs:265`、`:308`） | OpenMuse 浏览器服务的网络边界几乎一模一样 |
| 前后台分离 | 前台每句一个进程、只调 `xin` 函数；后台任务各自独立进程和容器 | opencode 的 run-coordinator 按会话串行、不同会话并发。站长第 2 点「一边干活一边聊天」在架构上已经成立 |
| 断点 | 后台进度 = Codex app-server 自己落盘的会话 + 项目副本；重启后 `thread/resume` 加「先查现状、别重复有副作用的事」（`vm-agent.mjs:1270`） | Grok Bot `upgrade-recreate-resume.ts` 用的是几乎同一段提示 |

## 3. 站长 7 个疑虑的核对

### 3.1 工作副本在临时目录，重启丢成果 —— 基本不成立，有个新小坑

- 代码用 `os.tmpdir()`（`vm-runtime.mjs:36`）。实测云电脑上它是 `/data/tmp`，在持久盘上，重启不丢。真正的内存盘 `/tmp` 没被用到。
- 新坑：InstaBox 文档写明 `/data/tmp` 里**10 天没用的文件会被自动删除**（逐个文件删）。「等你确认写回」「没做成、保留进度」的任务放 10 天以上，副本可能缺一部分文件。写回时缺的文件会被当成「任务删了这些文件」，界面显示「将删除 N 个原文件」——这时点允许，原项目里的文件会真的被删（有备份）。
- 用不用 `/data/tmp` 取决于 InstaBox 模板给的环境变量，不是代码自己决定的。
- 建议：副本放到控制器自己管的固定目录（例如 `/data/xin-tasks/<任务>/`），不依赖 `TMPDIR`。

### 3.2 容器只读挂载原项目，能否读或外传不需要的数据 —— 部分成立，影响小

- 容器里能读的：系统目录、这个任务的项目目录（只读）、STM32 模板、这次附带的文件（`containerCommand`，`vm-runtime.mjs:265`）。`~/.xin`、`~/.codex`、整个工作目录都不挂。
- 能外传：出网代理放行任意公网 80/443，被网页带偏的任务可以把项目副本发出去。
- 边角：`--dir` 允许 WORK 下任意子目录（`taskDir`），包括 `uploads`、`tasks` 这种集合目录；指到那里，容器就能读全部上传文件或别的任务目录。前台照站长原话写 `--dir`，概率低。
- 建议：禁止把 `uploads`、`tasks` 等集合目录当项目目录（几行）。出网白名单（Codex `network-proxy` 有域名白名单和「只读」模式，只读要解密 HTTPS）对单人 STM32 项目不值得，现在不做。
- **2026-11-12 已做**：`uploads`（和下面每一天）、`stm32-template` 本身和里面都不行，`tasks`、`daily` 本身不行（里面各自的项目照常），见 `vm-agent.mjs` 的 `collectionDir`。

### 3.3 每日任务等完全放权路径 —— 成立

- 每日任务不进容器、完全放权（`vm-agent.mjs:1497` 的 `sandbox: !t.dailyDate`），工作目录是整个 WORK（`:1441`），电脑自带的云电脑管理插件（instabox）和桌面操作插件都开着，每天自动访问外部网站。
- 小芯的几条路径里只有每日任务带着云电脑管理插件（前台只有推理，后台任务插件全关）。
- 天启是站长确认过的完全放权，不动。
- 建议：每日任务单独目录（同时解决 4.1 的堵塞）；关掉它用不到的云电脑管理插件；进容器要等浏览器方案，因为签到要操作桌面。**2026-11-12**：单独目录已做（第一批），云电脑管理插件已关（第二批，见 `docs/CHANGES.md`）。

### 3.4 多文件写回中途失败 —— 成立，概率低但后果别扭

- `publishWorkspace`（`vm-runtime.mjs:174`）先备份、再逐个文件「写临时文件 + 改名」。单个文件是原子的，整批不是。
- 中途抛错（磁盘满、权限）：已写的文件留在原项目，没有自动回滚，任务记为没做成。
- 中途进程被杀：状态库事务回滚，下一次收尾重新算计划时，已写回的文件「原项目 = 副本 ≠ 开工时」，被 `publicationPlan`（`:66`）当成冲突，弹出「任务期间被改过」的确认。
- 建议：写回前记一条「写回进行中」（文件清单 + 备份目录）；失败用备份自动还原；收尾时「原项目已经等于副本」的文件算已写回，不算冲突。参考 opencode `snapshot.ts`（内容寻址记录、按文件还原）。

### 3.5 重活占用全局锁或数据库事务 —— 成立，但比之前审查说的轻

- 开工复制项目（`prepareWorkspace`）、收尾校验/哈希/写回/发布预览都在 `tasks` 锁和 SQLite 写事务里。
- 另外每个请求（包括网页轮询）进程一启动就调 `journal.recover()`（`vm-agent.mjs:2682`），它不管有没有要补的都 `BEGIN IMMEDIATE`（`vm-state.mjs:72`），所以读操作也要等写锁。
- 前台每句话开头也要拿一次 `tasks` 锁（`vm-agent.mjs:740` 的 `front_immediate`），所以任务收尾的耗时会体现在聊天上。
- 实测（本机，60 MB、3000 个文件，类似带 HAL 库的工程）：全量哈希 0.54 秒，复制 0.15 秒，收尾的 3–4 次哈希约 2 秒。云电脑磁盘慢几倍，就是**几秒级卡顿，不会报错**（等锁上限 15–20 秒）。
- 建议：先给 `recover()` 加「没有要补的就不拿写锁」的快路径（几行，所有读操作受益）；重活挪出锁外等以后改 `task_finish` 时一起做。

### 3.6 轮询、历史、任务记录重复读取 —— 成立但现在不是问题

- `poll` 每次读整份事件文件再切片（`vm-agent.mjs:2255`）；`history` 读 30 轮全部事件；`sessions` 读全部会话文件；`xin recall` 每次 stat 所有对话的所有轮次。
- 现在一共 82 轮、10 个对话，状态库 772 KB。
- 建议：只做轮询按字节偏移读（Agent HUD「从上次读到的位置接着读」），因为后台任务的过程记录会越来越长，工作台开着时每 3–4 秒读一次。其余等数据量上来再说。

### 3.7 交接、重试、补充、恢复之间的竞态 —— 没找到确定的 bug

- 前台插话（`steer`）和本轮结束（`run_complete`）在同一把对话锁里串行；任务补充（`task_tell`）和收尾（`task_finish`）在 `tasks` 锁里串行；交接带结果版本号，过期的作废；回执防重放。比 Open-Grokbot、OpenMuse 都严。
- 真正的风险是正确性依赖「哪个操作在哪把锁里跑」这类约定，散在 2752 行的 `vm-agent.mjs` 里（见 4.5）。

## 4. 站长没点名、但更该先做的

### 4.1 每日任务会把所有后台任务堵住

- 每日任务的目录是整个 WORK（`vm-agent.mjs:1441`），调度规则是「目录有包含关系就不同时跑」（`:1413`、`:1515`）。
- 结果：9:10 每日任务跑的时候（时限 180 分钟）新任务都排队；有任务在跑时每日任务也开不了。直接违背站长第 2 点。
- 修法：每日任务用自己的目录。改动小。

### 4.2 任务中途遇到临时错误就算没做成

- 现在只有「模型还没开始干活就失败」才换模型重试（`vm-agent.mjs:708` 的 `canSwitch`，`state.worked` 见 `vm-events.mjs:91`）。开始干活后，网关 5xx、断线、超时 → 这一轮失败 → 任务「没做成」→ 交给前台模型判断要不要续接（最多 2 次、没有等待间隔）。网关还没恢复时两次很快用完，最后要站长说「接着做」。每日任务没有交接，直接等 21:10。
- Grok Bot `transient-stream-error.ts` 先分类：断线、限流、服务暂时不可用算「临时」，控制器自己重试；上下文溢出、预算用完等算「终止」。
- 建议：控制器识别临时错误后，等一会儿（退避）用同一个副本、同一个 Codex 会话自动接着做，有次数上限，不经过前台模型。这是「长时间自主工作可靠性」最直接的一项。

### 4.3 等站长回答时云电脑一直醒着

- 后台模型中途问问题（`item/tool/requestUserInput`）时，`approvalRequest`（`vm-agent.mjs:1011`）每 0.35 秒查一次回答，没有时限；这期间任务算「后台在忙」（`:1272`），Worker 的 Durable Object 每分钟续一次「有活在干」的租约（`src/xin.js:478`），直到任务时限（默认 60 分钟、最长 180 分钟）。
- InstaBox 免费机连续运行满 480 分钟强制冷却，期间叫不醒，连续冷却会从 5 分钟加到 2 小时。没人回的问题白白消耗运行时长。
- Agent HUD `requests.rs`：等待用户的请求最多挂 10 分钟（`hold_ms: 600_000`），没人处理就交还给 agent。
- 建议：挂 10 分钟没回，就把问题存成「等你确认」、结束这一轮、释放租约；站长回答后接着做（和现有 `xin task ask` 同一流程）。这个入口测试没覆盖，实际多常触发不确定；改动小。

### 4.4 云电脑之外没有备份

- 记忆、对话、学习画像都在云电脑一个 SQLite 文件里；每日导出（`exportState`，`vm-agent.mjs:482`）也在同一台机器。机器被删、磁盘坏、账号出问题就全没了；正式站回滚也不回滚这些。之前审查的问题 8 一直卡在「放哪里」。
- Grok Bot `box-store-sync/`：云电脑里的状态按内容哈希打包同步到云端对象存储，云电脑坏了能整体恢复。
- 建议：每天把导出加密后放到 Cloudflare R2（站长已经在用 Cloudflare），只有 Worker 能读写，密钥放 Worker 的 Secrets。**需要站长同意。**
- **2026-11-12 已做（#124）**：没用 R2，放在 Worker 已有的 Durable Object 类的另一个实例 `xin-backups`（R2 的开通、令牌权限、新密钥在会话里查不到也加不了）。备份是整包（状态库快照 + 对话过程等文件），密钥从登录密码派生。设计见 `docs/xin-reliability-usage-design.md` 的 C 部分。

### 4.5 结构（不急）

判断「这一轮还活着吗、这个任务占不占名额、算不算后台在忙」各有一套写法：`runDone`、`occupiesTask`、`isBackground`、`taskNeedsTick`、`summary().active`。Agent HUD 所有会话共用一个状态机（running / waiting / idle / unverified）。不专门重构；改到这几处时顺手收拢成一处。

## 5. 参考项目：成熟 / 只是不同 / 不适合

### 更成熟、值得借（落到小芯上就是上面几条）

- **Grok Bot**：错误分类（4.2）；云端状态同步（4.4）；浏览器工具在快照里给元素编号、写操作前检查、禁止读写 cookie 的 CDP 命令。
- **OpenMuse**：有外部后果的动作先存「待审提议」（内容哈希 + 过期时间），批准后用比较交换从「待审」改成「执行中」，只执行一次；浏览器是独立 Playwright 服务，每个会话一份持久登录资料，接管就是同一个会话换人操作。
- **OpenDuet（OpenBot）**：密码走「人工填密」接口，模型看不到；Playwright 的无障碍快照会把密码框的值**明文**报给模型（`secret-masking.ts` 注释），快照、截图、实时画面三处都要打码；授权四档：直接做 / 只在这一轮明确要求过才做 / 先问 / 交给人做，付款、凭据、安全设置一律交给人。
- **Agent HUD**：等待请求的持有时限（4.3）；日志按偏移增量读、变化当事件（3.6）；回执只存指纹不存原话；「字节可能已经发出」就标「不确定」，不盲目重发。
- **Codex**：网络代理的域名白名单（以后需要时）；记忆按「多久没被用到」淡出。
- **opencode**：持久收件箱在步骤边界吸收插话（小芯已有等价做法）；文件快照还原（3.4）。

### 只是选择不同，不用改

- 常驻服务 + SSE（opencode、Agent HUD、OpenMuse）对比小芯每次请求起一个进程。常驻省约 0.1 秒启动，但多一个会挂的进程，还要开端口或隧道。小芯每次请求先自我修复（`recover`），加上 watchdog 和 Durable Object 闹钟，可靠性不差。
- 记忆存文件让模型 grep（Grok Bot、Codex）对比 SQLite + FTS5。小芯要逐字核对引文，SQLite 更合适。
- Effect / Rust 那套类型化框架（opencode、Agent HUD）：单人项目用不上。

### 不适合小芯（反对）

- **多 agent 群聊、跨用户房间、agent 互发消息**（Open-Grokbot、Grok Bot、Agent HUD）：和「只有一个小芯」冲突。小芯内部唯一需要的交接（后台 → 前台）已经有了。
- **让模型逐个审查动作**（Grok Bot auto-review、Codex Guardian）：每个动作多一次模型调用，慢且不稳定。后台现在没有对外有后果的动作；做浏览器时按页面元素（密码框、支付/删除/发送按钮）用规则判等级就够，和 2026-11-07 定稿 §5.3 一致。
- ~~**统计看板、额度光环、用量热力图**（Agent HUD 的主体）~~：我原来反对；**2026-11-11 站长决定要**，范围是「光环 + 额度卡 + 简版统计」（不做费用估算、热力图、一年视图）。设计见 `docs/xin-reliability-usage-design.md` 的 B 部分。**2026-11-12 已实现**（见 `docs/CHANGES.md`「小芯用量看板」一条）。
- **一个任务一台电脑**（OpenMuse、OpenDuet 的一 Bot 一电脑 / E2B 桌面）：已有 InstaBox，一台够用。
- **加大并发**（2 → 更多）：瓶颈是免费机 480 分钟和 4 核 8G，不是调度。

### 浏览器（站长第 3 点）

OpenMuse 最贴近小芯：Playwright 驱动云电脑上已有的 Chromium，每个网站一份持久登录资料放控制器目录，接管就是站长在 InstaBox 桌面上直接操作同一个浏览器（已有「屏幕 / 接管」）。再加 OpenDuet 的人工填密和打码、OpenMuse 的待审提议账本。这正是 `docs/xin-next-stage.md` §5 的方案，参考项目印证方向是对的，不用重新设计。它是最大的一块，建议排在可靠性几项之后。

## 6. 建议的顺序（待站长确认）

第一批：后台改动，网页不变，直接对应站长第 1、2 点。**2026-11-11 已实现**（见 `docs/CHANGES.md` 同日「后台可靠性第一批」一条）。

1. 每日任务单独目录（4.1）。
2. 临时错误自动接着做（4.2）。
3. 等站长回答的请求有时限（4.3）。
4. 副本放固定目录（3.1）+ 写回失败自动还原、已写回不算冲突（3.4）。
5. `recover()` 快路径 + 轮询按偏移读（3.5、3.6 的小部分）。

第二批：需要站长同意。**2026-11-12 站长说「按你觉得对的来」**。

6. 机外加密备份（4.4）。**2026-11-12 已做（#124）**，放在 Durable Object，不是 R2。
7. 每日任务关掉云电脑管理插件（3.3）。**2026-11-12 已做**。

第三批：浏览器 v1。

不做：多 agent、统计看板、动作审查模型、常驻服务改造、出网白名单、加大并发。

## 7. 等站长决定（都已答复）

1. 顺序和「不做」的清单是否同意。**同意（2026-11-11）。**
2. 机外备份放 Cloudflare R2 可以吗（加密，密钥放 Worker 的 Secrets）？**站长说按我觉得对的来；改放 Durable Object（见 4.4）。**
3. 每日任务清单里有没有要管理云电脑（开机、快照）的步骤？没有的话就关掉它的 instabox 插件。**没有，已关（#123）。**
