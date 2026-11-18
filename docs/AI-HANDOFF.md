## 2026-11-18 · 天启独立工具集成（Codex）

- 基线为 #174 的 `9c022c0`。分支 `codex/xin-tianqi-li2-20261118` 保留 Claude Code 第 1–4 步与 Antigravity 第 5 步的原始提交。Codex 实现第 6–7 步和集成修正，并自查整条分支。各步原作者、修正原因及证据见变更记录。 [变更记录](CHANGES.md) · [实施计划](superpowers/plans/2026-11-18-tianqi-li2.md)
- 已移除小芯工作台欢迎页、侧边栏及命令面板的新建天启入口。旧天启沿用 `li` 的会话编号、Harness、模型和插件。直接打开 `/tianqi` 会延后小芯的启动，返回后更新同一个登录再继续。正式站联调只用已登录的浏览器读取 `/api/tq/me` 就能验证天启入口。
- 台账与测试证据包括状态隔离、误配 key 拒绝跑错电脑、`tq-inbox` 闹钟重启、缺省 key、#174 回滚和恢复、入口与多尺寸深浅色。第 5 步的每日任务和 Chromium 异常在正确的 Node 22 和 Chromium 环境复测通过。 [第 5 步交接](https://github.com/yux91803-hobo/liming-work-site/commit/34888f6193e532441a5bdd588f20564b02ea3778)
- 全量 `npm run check` 1,051/1,051，`npm run test:e2e` 14 组通过，其中 STM32 372/372、旧会话与终端 69/69、独立天启 12/12。核对了 4 个屏宽的深浅色、Wrangler 试打包、可选密钥空值和非空值，以及 #174 实际代码的回滚和恢复。
- 第 8 步发布检查跟随合入 PR。开启天启还需第 9 步的 `XIN_TQ_INSTABOX_API_KEY`、`li2` 的 Harness、网关程序与站长新增的网关账号，再用天启发一条验收消息。准备阶段通过只读接口从 `li` 取已核准的程序文件，`li2` 使用独立程序配置。 [上线与准备顺序](superpowers/specs/2026-11-18-tianqi-li2-design.md#6-上线顺序)

## 2026-11-18 17:34（北京时间）· 天启搬到 li2：完成第 5 步并交接第 6–9 步（Antigravity）

- **分工与复核**：第 1–4 步由 Claude Code 实现并自查（见下方上一条）；第 5 步及本交接记录由 **Antigravity** 实现并自查，**尚无独立复核**。未把任何审核者列为作者或共同作者。
- **分支与远端核对**：
  - 开发分支 `antigravity/tianqi-li2-20261118`（已推送远端）：基于 Claude Code 原分支 `claude/friendly-hopper-d7392n`（`dfddaba`，原分支及提交完整保留未动），并在 `0a0b883` 合入了当时 `main`（#173，`969d162`）；第 5 步提交为 `f2b63ef`。
  - **最新 `main` 与 PR**：`git fetch origin main` 与 `gh pr list --state all` 核对显示，#174（Codex 第 3 批 B 默认启用持久收尾）已合入 `origin/main`（`9c022c0`，2026-11-18 07:43 UTC）。#174 与 Codex 工作未碰，也尚未重并进当前开发分支；天启尚未开 PR，线上无变动，li/li2 均未操作。
- **第 5 步已完成内容（`f2b63ef`）**：
  - `site/tools.js` & `site/tools/tianqi/index.html`：首页「工具」类新增 `/tianqi` 入口与独立页（按 `embed` / `lm.theme` 初始化，写 `window.LIMING_CHAT = { role: 'tianqi' }`，版本参数与首页保持一致：`px3`、`xc-r2b-20261116`，不加载 `mascot.js`）。
  - `site/xin/chat.js`、`site/xin/chat.css`、`site/xin/term.js`：天启模式（`TQ`）接入 `/api/tq/`（含 `upload`、`fileUrl`、`backups`、`preview`、`pagehide` 等）；本地存储改 `lm.tq.*`（保留共享 `lm.xin.device`）；禁用主对话/每日任务/设置/额度切换/`greet`/推送/页面上下文（`.xc-ctx`）；启动开全屏工作台并 `ping`，网关未就绪时提示「天启的网关还没配好，暂时发不了消息。」并禁用输入与发送；标题栏、侧边栏、欢迎页、命令面板与终端弹窗（「天启的电脑」）改用星徽；嵌在首页时左上方让出返回键空间并处理 `ready`/`close`/`reset` 消息。
  - `scripts/preview.mjs`：`/api/tq/me` 返回 `{enabled:false, authed:false}`；`/tianqi` 路由回退到 `/index.html`。
  - `test/e2e/xin_tianqi_e2e.py` & `package.json`：新增 6 场景 8 项端到端测试并接入 `npm run test:e2e`。
- **已验证结果与未验证/风险项（实事求是）**：
  - 全站静态脚本与本地资源引用检查（同 `scripts/check.mjs` 前半段）：`301 files, 231 asset references` 通过。
  - 天启后端单元测试（`node --test test/xin-tianqi.test.cjs test/xin-tianqi-worker.test.cjs`）：**14/14** 通过。
  - 本地预览与定向 Playwright E2E（`node scripts/preview.mjs --port 5173`，实测 `/tianqi` 与 `/api/tq/me` 均 `200`；`source ~/env.sh`）：
    - `test/e2e/xin_tianqi_e2e.py`：**8/8** 通过
    - `test/e2e/xin_work_e2e.py`：**42/42** 通过
    - `test/e2e/xin_term_e2e.py`：**71/71** 通过
    - `test/e2e/xin_main_e2e.py`：**19/19** 通过
    - `test/e2e/xin_web_e2e.py`：**7/7** 通过
  - **未完成与异常观察**：
    - `npm run test:e2e` 其余 9 组 E2E 尚未运行；第 8 步要求的 `1280/1024/768/390` 深浅色视觉截图尚未截取。
    - `npm run check` 全量单测中途取消且未全过，本容器内观察到两处失败（均未改后端代码）：`test/xin-batch1.test.cjs` 单独复测 **15/17** 通过，2 条 `daily` 用例（L75、L291）报 `{"error":"no_agent","msg":"电脑里没有 codex，每日任务做不了"}`；`test/xin-browser.test.cjs` 实机浏览器用例多项失败（容器 Chromium / 沙盒环境问题；上述未用 `source ~/env.sh` 切换至 Node v22 亦可能有关，下一步应先排查或对照 CI）。
- **下一步（按 [实现计划](superpowers/plans/2026-11-18-tianqi-li2.md) 第 6–9 步）**：
  1. 核对并合入最新 `origin/main`（`9c022c0` 含 PR #174），同时确认本机跑全量 `npm run check` 时 Node 版本（`~/env.sh`）与上述 `xin-batch1`/`xin-browser` 环境表现。
  2. **第 6 步（TDD）**：先修改 `xin_tianqi_e2e.py`（加深链 `/tianqi`、`visibilitychange`、点 `.panel .back` 后补发 `wake`/`greet`）、`stm32_e2e.py`、`xin_main_e2e.py`、`xin_term_e2e.py`、`xin_learning_e2e.py` 看新断言失败；再改 `site/xin/chat.js` 去掉首页工作台「新建天启对话」入口与 `.xc-as`（保留打开旧 `harness` 对话），加 `tianqiOpen()` + `MutationObserver` 在 `/tianqi` 打开时延后首页 `wakeVm()`/`greet()`。
  3. **第 7 步**：各 HTML 同步新 `?v=` 版本参数；改 `.github/workflows/deploy.yml`（说明 + 条件 `jq` 写 `TQ_INSTABOX_API_KEY` 并在本地测空/非空 `$c`、冒烟加 `/tools/tianqi/` 和 `/api/tq/me`）、`scripts/test-xin-live.py`（校验 `/api/tq/me` 同登录）、`README.md`、`docs/CHANGES.md`、`docs/AI-HANDOFF.md` 及 spec 状态。
  4. **第 8–9 步**：全量 `npm run check` + 全量 `npm run test:e2e`、`1280/1024/768/390` 深浅色截图自查、整条分支复核、开 PR 等 CI/测试站绿、squash 合并带 `expectedHeadSha`、确认正式站绿；随后请站长加 `XIN_TQ_INSTABOX_API_KEY`（用新方式另给，不打印进日志）与网关账号，最后按规矩只写 li2（li 只读、li2 不装 STM32 环境）完成部署与联调。

## 2026-11-18 下午 · 天启搬到 li2：做完第 1–4 步，额度用完交接（Claude Code）

- 站长已确认设计（北京 11-18 13:39「不用装stm32编译环境，开始吧」）：[设计](superpowers/specs/2026-11-18-tianqi-li2-design.md)、[实现计划（9 步）](superpowers/plans/2026-11-18-tianqi-li2.md)。天启改成首页的一个新工具 `/tianqi`，连第二台云电脑 li2；数据和网关账号都不搬，提示词只有「你叫天启。」，只用 Harness。
- 分支 `claude/friendly-hopper-d7392n`，从 `main` 的 `88bec32`（#172）开出，`main` 之后没再动。**还没开 PR，线上没变。**
- 已完成（每步都跑了全量 `npm test`，第 4 步时 1036/1036）：
  - 第 1 步 `1773fe7`：Worker 的天启范围（`/api/tq/*`、`scopeEnv`、li2 的 key、缓存按电脑分开、exec 带 `XIN_ROLE=tianqi`）。
  - 第 2 步 `20fa095`：Durable Object 实例 `tq-inbox` 记住范围（请求头 `x-xin-scope: tq`，闹钟里也用 li2 的 key）。同一个类，**没有迁移**。
  - 第 3 步 `1ecb776`：每天 8:55 也叫醒 li2。
  - 第 4 步 `9474ace`：li2 上的天启身份（控制器）。测试是 `test/xin-tianqi-worker.test.cjs`、`test/xin-tianqi.test.cjs`。
- 我做的决定（原来记在会话的工作区里，不进 Git，抄在这里）：
  - 第 2 步：闹钟测试把 `Date.now` 往后拨 10 分钟再调 `alarm()`。原因是待送达第一次失败后有 5 秒退避。错了只影响测试写法。
  - 第 4 步：计划写的 `createController({allowOp})` 改了放法。`TIANQI_OPS` 放在 `vm-kernel-controller.mjs`，在分派处直接看 `TIANQI`。`tianqiReady`/`tianqiRefuse` 和挪过去的 `dshCmd`/`HARNESS_KEY`/`harnessInstalled` 放在 `vm-base.mjs`。原因有两条：`test/xin-writers.json` 规定 `vm-agent.mjs` 行数只减不增（基线 3049，现在 3044）；冷启动子请求已经是 40，正好是测试上限，**不能再加新的 `vm-*.mjs` 模块**。
  - 第 4 步收尾那次全量，`xin-web.test.cjs`「网页验收用真浏览器点击」挂过一次：并行时 Chromium 冷启动超过 `vm-runtime.mjs:876` 的 15 秒。这一步没改那里，单独跑 22/22，重跑一次全绿。
- 接着做第 5 步（天启页面），再做第 6–9 步，按计划原文来。第 5 步我摸到的坑：
  - `scripts/preview.mjs` 的单页回退只有 `['/map','/stm32']`，要加 `/tianqi`，不然深链接测试 404。本地预览对 `/api/xin/me` 回 `{enabled:false}`、其余 `/api/*` 一律 404，要让 `/api/tq/me` 也回没配好。
  - `site/xin/chat.js` 有几处把 `/api/xin/` 写死了，天启模式要改用 `API`：`upload()`（约 2997 行）、`fileUrl`（约 3042）、备份（约 969/977）、`preview.png`（约 2449）。
  - 本地存储的键都是 `lm.xin.*`，天启用 `lm.tq.*`；`lm.xin.device` 两边共用。
  - 首页外壳的返回键在左上角（left 10px、top 8px、40×40），嵌进去的页面头部要让开约 56px（STM32 页是 `.embed .bar{padding-left:calc(56px + …)}`）。
- 第 9 步（准备 li2）要站长先做两件事：
  1. 在 GitHub Secrets 加 `XIN_TQ_INSTABOX_API_KEY`（li2 那个 InstaBox 账号的 key）。
  2. 网关账号站长自己加（「账号数据不要搬过去，我到时候会新加」）。

  站长传给我的 li2 key 文件只在这个 Claude 会话的容器里，下一位要的话请站长另外给，不打印、不提交。
- 规矩：
  - li 只读，不往 li 写。
  - li2 不装 STM32 编译环境。
  - 不替小芯或天启登录网关面板。
  - 删机器、删快照、删数据先问站长。
- 第 3 批 B 收尾站长交给了 Codex，这条线不碰。

## 2026-11-18 · 第 3 批 B 持久收尾启用（Codex）

- Codex 实现并自查，尚无独立复核。分支 `codex/xin-finalization-enable-20261118` 用单独提交启用新轮次写入和正式回执验证。现有协议与状态文件保持可读。[实施与回滚计划](superpowers/plans/2026-11-16-xin-finalization.md)
- 本地验证及发布证据见本批 PR。后续独立工作包括 AGY 原生 note 的 ACK、插话取件消费和额度报告。真实暂停恢复验证与宿主授权继续各自验收。

## 2026-11-18 · 第 3 批 B 持久收尾读取方（Codex）

- 负责实现与自查的是 Codex，尚无独立复核。分支 `codex/xin-finalization-reader-20261118` 基于 `main` `88bec32`（#172），原分支保留。Claude Code 的同时期变更是天启 li2 的设计与计划，各自按自己的 PR 发布。[#172 正式验证](https://github.com/yux91803-hobo/liming-work-site/actions/runs/44235290061)
- 收尾协议读取、校验、SQLite 回执、崩溃恢复及写入开关已实现。正常的运行元数据继续取同一尝试；停止以状态进程提交顺序为准。项目写回按固定内容核对，预览通过稳定编号复用，批准与删除的行为保证沿用现有校验。[本批实施计划](superpowers/plans/2026-11-16-xin-finalization.md)
- 隔离验证使用真实状态进程、SQLite、套接字和合成模型。故障点覆盖提交前后、回执丢失、准备记录和临时文件、停止竞态、写回到一半重启及外部修改。最新完整检查和正式发布状态以 PR 的证据为准。正式云电脑验收走 Actions 的正常联调。
- 本 PR 默认维持旧写入。下一份 PR 在读取方完成正式验证后将默认值打开；显式关闭开关仍兼容已分配轮次。AGY 原生 note 的 ACK、插话未知交付与额度采样仍按各自协议验收。外部命令已执行而尚未产生检查点时，要结合外部状态判断是否续做。

## 2026-11-18 · 状态进程失联告警（Codex）

- 实际实现与自查由 Codex 负责。接手时 `main` 为 #171 的 `0b54ba1`，Claude 分支在 #170 的 `997a2ad`。独立分支 `codex/xin-outage-push-20261118` 从已验证的 #171 提取。[#171 发布与回滚记录](https://github.com/yux91803-hobo/liming-work-site/pull/171)
- 已修复此前交接中的 `pushq` 健康检查依赖。故障告警使用已有签名密钥和订阅直接发送，状态进程在正常推送中处理过期订阅。真实 CLI 回归先复现 6 秒等待超时，再验证失联期间的加密发送、缺少密钥时退出、以及恢复后的过期订阅清理。定向复测 13/13。
- 隔离演练用实际外壳的退避和真实告警 CLI，在状态进程反复启动失败时只产生一次网络请求，报告进程干净退出。随后用 #171 实际代码执行升级再回滚，仍可读取旧回执和完成在途轮次。工作区证据为 `outage-push-keeper-proof.log`、`outage-push-rollback.log`。
- 本地 Node 22.23.4 完整检查 1,022/1,022，失败和跳过均为 0。13 组端到端浏览器测试全部通过，含学习台 372/372、工作台 42/42。前后源码指纹一致。日志为 `outage-push-check.log`、`outage-push-e2e.log`，发布结果见本批 PR 与 Actions。
- 迁移沿用原本的本地推送文件，回退目标是 #171 的已验证版本。故障测试使用临时目录、本地推送服务和合成密钥。正式机验收依赖发布联调和版本核对。故障告警需要外壳在线和站长已开通的有效浏览器订阅。
- 持久收尾仍按兼容读取方先发布、再启用写入的顺序推进。首先核对终态包、现有回执与恢复入口。[第 3 批 B 收尾计划](superpowers/plans/2026-11-16-xin-finalization.md)

## 2026-11-18 上午 · 删旧模式第 3 步（Codex）

- 实际实现与自查由 Codex 负责。第 1、2 步由 Claude Code 实现。接手时 `main` 为 #170 的 `9482ef1`，`claude/friendly-hopper-d7392n` 为 #170 PR 的 `997a2ad`。独立工作树和分支为 `codex/xin-remove-legacy-c-20261118`，Claude 会话内的本地工作未随 Git 交接。
- #170 正式发布于北京时间 09:44 联调通过。只读核对已有就绪窗口、切换时间及文件摘要，结果写入 CHANGES。[#170 发布记录](https://github.com/yux91803-hobo/liming-work-site/actions/runs/44215441298)
- 已清理仅用于旧状态模式的业务锁、看门狗和逐请求进程。常驻状态进程以独占锁校验、备份和接管；客户端只走套接字，带副作用的报告沿用有界重试和幂等规则。正式联调用状态进程 PID 与接管次数核对接管稳定性。试验最初揭示的两个用例分别是缺少状态进程时 CLI 创建 `owner.sqlite`、错误套接字路径消耗接管次数。
- 最终本地验证为 Node 22.23.4 下 `npm run check` 1,021/1,021，失败和跳过均为 0。`npm run test:e2e` 的 13 组浏览器检查全过，包含学习台 372/372、工作台 42/42。工作区证据为 `legacy-c-final-check.log`、`legacy-c-e2e.log`、`legacy-c-rollback-final.log`。CI、测试站和正式站结果见该分支的 PR 与 Actions。
- 迁移和回滚走 Actions。临时目录用 #170 实际代码升级再回滚，接管次数 1 → 3 → 5，已提交回执与执行中的尝试都可以继续处理，首次备份保留一份。已有数据库和协议继续可读。故障演练使用本地合成数据，正式云电脑通过发布联调与只读记录核对。
- 当前风险在 #170 和第 3 步上均用临时订阅与替身复现。外壳标记 `down` 时会尝试启动一次 `pushq`，它先等状态进程健康，超时就退出。合成试验中无状态进程时推送请求为 0，有健康进程时为 1。后续单独修复告警对状态进程的依赖，用已有订阅和密钥测试推送，并把订阅更新交给恢复后的写者。
- 后续按 [第 3 批 B 收尾实施计划](superpowers/plans/2026-11-16-xin-finalization.md)推进执行结果暂存和重放。宿主授权、凭据代理与工具权限继续按已确认的内核设计分批实施。工作台界面由原负责人维护。

## 2026-11-18 上午 · 删旧模式第 2 步（PR B：状态只由常驻进程写）（Claude Code）

- PR A（#169）已合并上线：正式站运行 44203537127 全绿（北京 08:17 部署完，正式站联调通过，没有回滚）。
- PR B 改了什么、35 条旧模式测试各自怎么处理，见 CHANGES 最新一条。要点：
  - 不是主人的进程一律不写；外壳只走状态进程，没好就等（最多 15 秒），等不到回「主人不在」；Worker 去掉 `XIN_STATE_OWNER`。
  - 外壳不再调 `owner-legacy`，一直起不来就推送一次、标成 `down`、照 60 秒退避一直重试。
  - 代码里 `lockedCall` 的 `flock` 路、看门狗、`owner-legacy`、`Ownership` 的 `hold/leave/set`、`release(mode)`、外壳的 `runAgent` 现在都走不到，第 3 步（PR C）删。
- 上线后要核对：云电脑上内核记录 `kernel.jsonl` 里换版本那一下等了多久（`ready` 事件的 `ms` 是状态进程起来用的时间；那段时间的请求记录看 `via` 和 `ms`，`via: none` 是等不到回了「主人不在」），以及有没有 `down`。读 InstaBox 之前先看 https://instabox.sh/llms.txt ，只做只读调用。
- 回滚：Actions 自动回滚 Worker 时，旧版外壳拿到的期望是 kernel，接得上新版留下的记录；不要再用「改成 legacy 发版」那个办法（开关已经没了）。
- **本机跑全量之前，先确认没有 `~/.xin`**：这台机器上原来留着 11-15 测试写下的旧库，会把「不是主人建不了库」盖住，#170 第一次 CI 因此挂了 4 条（本机全过）。那份旧库已经挪走。新写的测试在测试进程里直接调控制器模块时，文件开头就用自己的临时状态目录。

## 2026-11-18 凌晨 · 删旧模式第 1 步（PR A：测试全部对着主人跑）（Claude Code）

- 站长北京时间 11-18 凌晨确认删旧模式：「这个部署成功了，你就去搞legacy，我要睡觉了」。#168 已上线（正式站运行 44133513259 全绿，01:20 部署、01:33 联调通过）。
- 计划：`docs/superpowers/plans/2026-11-18-xin-remove-legacy.md`，三个 PR：A 只改测试；B 改行为（非主人一律不写、外壳等状态进程好、Worker 固定常驻进程模式）；C 删走不到的代码。
- PR A 做了什么、哪些旧模式测试留给 B，见 CHANGES 最新一条。
- 写测试的新规矩：
  - 起控制器子进程的，接 `test/helpers/state-mode.cjs`（`stateClient`、`stateHomes`）。
  - 在测试进程里直接调控制器模块的，用 `test/helpers/own-state.cjs`（测试进程 `ownState()`；脚本子进程 `OWN_IMPORT`）。
  - 同一个状态目录不能两种都用：有了真的状态进程，别的进程就拿不到所有权。
  - 状态进程按它自己的环境算任务时限这类值；测试要改这些，得在起它之前放进夹具的环境，改命令行进程的环境没用。
- 摸底的办法：在草稿目录另开一个 `git worktree`，把 `vm-kernel-owner.mjs` 的 `enter()` 临时改成一律拒，跑全部测试。别在主工作区改，免得忘了还原。

## 2026-11-17 · 两条偶发失败修掉；删旧模式的设计等站长确认（Claude Code）

- #167（测试默认不碰 systemd）已合并（`dfc8858`）。它的正式站运行 44102291244 挂在 xin-steer「最终结果先到了」：测试自己赌任务 1.5 秒内交结果。部署跳过，线上没变。这次改成任务先做完，再把那句的到点时间拨到现在（参考 Oban `drain_queue(with_scheduled: true)`）。
- 本地全量检查时，常驻内核模式又挂了一条「登录窗口：开着时隔一会儿就存」。代码里查到 `vm-browser.mjs` 的 `loginWindow` 打开网址有先后顺序的漏洞（`watch()` 见到「正在接」就不等），用假浏览器写了稳定复现的测试，已修掉。但真浏览器上没有自然撞上，不能断定那次失败就是它。这条以后再挂，失败信息里有测试服务器收到的请求：一个都没有，就是窗口没打开网址；有，就是别的原因，接着查。
- 删旧模式（legacy）的设计在 `docs/superpowers/specs/2026-11-17-xin-remove-legacy-design.md`，要点已经发给站长，**等站长确认**。确认后再写实现计划，分三个 PR 做；站长回话前不动代码。

## 2026-11-17 · 测试默认不碰执行机器上的 systemd（Claude Code）

- #165（回复不再等后台任务记账）已合并上线（`c427f9f`）。
- 这次：`scripts/test-env.mjs` 的 `hermeticTestEnv()` 让 `npm run check`、`npm run test:kernel` 起的测试都把 `XIN_SYSTEMD_BUS` 指到 `/nonexistent/xin-tests-no-user-session/bus`。测试里的模型运行不再进机器上真的 `xin-run-*.scope`，也不往机器的真实用户目录装清理定时器。要测 systemd 的测试照旧自己设这个变量（xin-kernel、xin-reaper、#166 新加的 xin-agy-report-recovery）。参考 git/git `t/test-lib.sh` 第 2011–2017 行：整套测试默认 `GIT_TEST_MAINT_SCHEDULER="none:exit 1"`，测调度的测试自己另设。
- 新写测试时：直接 `node --test test/xxx.test.cjs` 跑单个文件不经过这两个入口。在有用户总线的机器上（GitHub 托管机器就有）单独跑小芯的测试，要自己带上这个变量（README「本地运行」有写）。
- 「Gemini 后台主动说一句」以后再挂：照规矩重跑一次，先看 #166 加的失败现场。隔离以后还挂，就说明清理器不是（唯一的）原因。

## 2026-11-17 21:19 · #166 已合并；「Gemini 后台主动说一句」偶发失败不再追根因（Claude Code）

- **站长决定**：Codex 和 Claude 都没找到这条偶发失败的根因，不再追。#166（状态进程失联时报告恢复、执行进程不再挂住）最新一次检查 [44083072428](https://github.com/yux91803-hobo/liming-work-site/actions/runs/44083072428) 全绿（含测试站），首轮挂的就是这条和本 PR 无关的偶发失败（main 上 44018154230 也挂过）。经站长同意，Claude Code 按合并提交把它合进 main（`0bea2df`），Codex 的两个提交原样保留；Claude 没有审核它的代码。下面 Codex 那节里「#166 未合并、合并暂停」已经过时。
- **接下来**：#165（回复不再等后台任务记账）合 main 后重新跑检查、上线，再用云电脑上的内核记录核对回程。然后另开一个 PR，让测试默认不碰执行机器上的 systemd：
  - Codex 实测 GitHub 托管机器有用户总线（UID 1001，linger=yes）；测试里自己设了 `XIN_SYSTEMD_BUS` 的只有 `xin-kernel`、`xin-reaper` 和 #166 新加的 `xin-agy-report-recovery`，别的测试的后台运行会真的进 `xin-run-*.scope`，还会把清理定时器装进机器的真实用户目录。
  - 清理器用某个测试的目录去对别的测试的 scope：`vm-reaper.mjs` 的 `decide` 里找不到记录的轮次 `ended()` 返回 0，会被当成「对话删了」停掉。这能解释 `acp` 那种失败（后台 Gemini 做到一半被停 → 换 Codex 提前做完 → 完成交接起前台），但没在正常检查里直接抓到它停进程，算最可能的原因，不算查实。
- **以后再挂**：隔离做完以后它还偶尔挂，就照规矩重跑一次，不再专门追。#166 在这条测试里加了失败现场（`noteDiagnostics`：调用记录、`model-stats` 里的 `fromErr`、SQLite 里的 launches / handoffs、最后一次轮询结果），失败时用 `t.diagnostic` 打进测试输出，挂了先看那份。

## 2026-11-17 · #166 失败取证进度（Codex 接续 Claude，合并暂停）

- **当前代码**：main 仍为 #164 / `21d7bdf`；[#166](https://github.com/yux91803-hobo/liming-work-site/pull/166) 运行代码提交 `bc1d208`，未合并、未部署。分支 `codex/xin-note-kernel-recovery-20261117`、工作树 `/workspace/liming-kernel-note-recovery`。本次后续提交只增强测试失败现场和记录，不改运行代码、原断言、等待预算或模型脚本。
- **真实失败**：CI [44072501817](https://github.com/yux91803-hobo/liming-work-site/actions/runs/44072501817) 完整单元 **1028/1028**、E2E 成功；kernel **187/188**，原 `xin-steer.test.cjs` 主动 note 用例在约 16.5 秒后 `c[1].prompt === 'acp'`。deploy skipped。本地原完整矩阵全绿不解释这条历史偶发失败；不能靠过滤 acp、放宽时限或反复重跑声称修好了。
- **Claude 的新记录**：[评论 6947692016](https://github.com/yux91803-hobo/liming-work-site/pull/166#issuecomment-6947692016)。他在 `bc1d208` 排查，没有提交代码、没有找到根因；单项无负载/4与8空转负载合计 33 遍、整组内核 7 遍均通过。`acp` 来自前台 `openFrontProvider` 的 help/启动；第 3 次 fake 调用写 `at-3` 会使测试继续，但不是预期第 3 个后台动作。证据指向后台提前结束、普通完成交接被启动，仍缺真正提前结束的错误。
- **保留的判断**：note 分支 `noteStart` 不调用模型；临时失败和首次 died 会回队列。`requestBudget` 写本地文件，不经过 owner RPC，这不等于已证明预算内容永不出错。AGY idle 在该用例为 60 秒，16.5 秒不能归为 1.5 秒 idle；SQLite busy_timeout 和死亡判断都是 15 秒，只能作为待证假设。GitHub 托管机默认无用户 bus，systemd 清理跨测试误杀缺少可达条件；真实有 bus 时的 scope 归属隐患单独留待验证。
- **新增第二症状**：Claude [评论 6947791681](https://github.com/yux91803-hobo/liming-work-site/pull/166#issuecomment-6947791681)：#165 第二次 CI 44048354885 单元 1010/1010、kernel 187/188，同一用例前两条 note 回执都过，却在 32.3 秒后等不到原聊天 note。先按独立症状取证，不假定与 acp 同因。
- **新线索实测纠正**：Codex 私有真实 owner trace 显示 13 次 kernel `tasks` 调用全部 `journal.active=false`，紧跟 `pumpHandoffs`，启动 flush 仅 1ms；该 fixture 无 callback/推送订阅。普通 op 没有 RPC 外层事务，因此“内核 tasks 都跳交接、只能等 cycle”这个前提不成立。另用受控 deferred tick 确认长挂 tick 会阻滞定期 reconcile，但尚不能连到这条自然 CI 失败；不据此直接改 tasks 或断言两症状同源。
- **本次诊断**：失败时、清理前只读本合成 fixture 的 calls（保留 acp）、sessions、run 元数据/事件、SQLite documents/launches/handoffs/commands 计数、最后一次原有 tasks 轮询返回值及双时钟、model-stats 的完整 `fromErr`、quota/issue/budgets、owner stderr 和假 Codex 参数；不发额外控制器请求推动调度，不读环境或真实凭据，只另外记录固定用户 bus 路径是否存在的布尔值。输出按 section/数组项分行；诊断自身失败仍抛原测试错误。实现 Codex，根代理自查，独立只读复核 Codex 子代理；Claude 对问题独立排查，不列为本补丁代码作者或已完成的独立代码审核。
- **验证**：增加诊断后的本地完整 kernel **188/188**（`note-diag-full-kernel-runner.log`）；私有强制错误模型副本证明原 acp 断言仍失败、真正 `model-stats.fromErr` 能保留。最终诊断在 legacy/kernel 的原单项各 1/1 通过；私有诊断自身故障也保持原 AssertionError。这是验证诊断，不是自然复现。Codex 私有原用例多次仍绿，不能据此排除 CI 缺陷；原 `bc1d208` 的完整 1028/188/13 组/关闭分配 188+14 证据保留。
- **下一步**：以新提交 CI 的失败快照分流：确认第一调用是否后台、task/run 是否已失败或换 Codex、`modelStats.fromErr` 是模型身份/预算/传输/其他错误；若只有通用 StateUnavailable，再在隔离 owner 副本捕获原始错误 code/errcode，不记录请求正文。若父 runner 先退出，核对 launch、PID/进程组和 15 秒后判死路径。拿到具体路径后做稳定红→绿回归，再改运行代码和完整验证。#165 原分支/head `6c4025c` 保留，Claude 对其失败重跑的说明见该 PR，不能把 #166 当成已经上线。
- **未完成项**：整个 3B 的持久终态包、输入未知交付、原生 note ACK、前台 quota 报告持久恢复、宿主授权 C、凭据代理及正式暂停恢复仍未完成。旧工作树与未提交工作保留；临时排查在 `/workspace/xin-review`，没有在正式电脑注入故障。

<a id="report-recovery-20261117"></a>
## Codex · 2026-11-17 接手 #164 / #165（当前工作）

- 远端 main `21d7bdfa567d06122e6584a6fad956ac590392fa`（#164）；Claude #165 head `6c4025cb7f84858f5f493f3cda97dd2c69147b50` 开放，Worker 回程改后台记账；其原提交/分支保留，不混改 UI。#165 的 CI 44048354885 在原 owner kill9 用例约 60.8 秒不收尾，部署跳过；不能称为记账补丁引入。
- 队列启用 #163 首次正式 44018154230 在原 note 用例 187/188，未部署；随后 #164 携带相同 VM 代码的正式 44038526459 全绿、联调成功、回滚跳过。只读确认实际 `vm-agent-f46e8f743f9a.mjs`、外壳 `vm-kernel-e1a29f7279b5.mjs`、单 owner、尝试/bridge 默认 true。查询时 bridge 文档数为 0，尚无实际新沙盒分配的正向见证，不虚称这条已验收。
- 本次独立工作树 `/workspace/liming-kernel-note-recovery`，分支 `codex/xin-note-kernel-recovery-20261117`；未清除其他工作树或上一位未提交内容。问题发现 Claude；本次实现/回归 Codex；独立复核 Codex 子代理（不是 Claude 审核，也不把审核者列共同代码作者）。
- 已复现：front_immediate 处理前失联被 timer 挂住；front_model 处理前失联在模型调用前失败；agy_conversation 已提交后丢回应误换 Codex。固定请求 ID 的真实 append/write/非幂等 named 在原 client 也稳定失败。视觉专项另外暴露新派发进程的单次 startup health 竞争，增加专用只读健康探测恢复；辅助 timer 的反向验证在仅把临时副本恢复 ref 时稳定失败。当前实现范围与回滚见 [报告恢复计划](superpowers/plans/2026-11-17-xin-report-recovery.md)，默认本地完整 check **1028/1028**、常驻内核 **188/188**、**13 组 E2E 全过**，均退出 0、无跳过，源码指纹 `be66f493248fa36638f48e795975c676fa9103d8e6c71b78f066ee4ca03e5017` 不变。显式 `XIN_RUN_ATTEMPTS=0 XIN_TASK_BRIDGE=0` 的内核回归 **188/188**、已有协议队列 **14/14** 也通过，关闭新分配仍处理已有协议。各项退出 0、无跳过且指纹一致；CI/正式结果以本批 PR 当前记录为准。
- 未完成/下一步：完成本批回归、全量验证及 PR 发布门槛；#165 单独保留，待内核修复进入 main 后核对并接续验证。随后才推进 [持久收尾计划](superpowers/plans/2026-11-16-xin-finalization.md) 的终态包/输入交付，不重复队列隔离工作。真实暂停恢复、宿主授权 C 和凭据代理不冒称完成。

以下保留各轮原始交接及历史判断，当前状态以本段和后续 PR 最终记录为准。

# 小芯 AI 轮流开发与交接

最新内核交接：[2026-11-17 接入 #161/#162 后的队列启用准备](#task-bridge-enable-20261117)；原队列实现见[先前子批](#task-bridge-20261116)。

用户于 2026-11-14 确定：Claude Code 与 Codex 轮流开发，一方达到使用限额后，由另一方接手。额度变化不改变设计约束、工作区归属或验收门槛。

## 每次接手

1. 先核对最新 main、相关分支和提交、最近及未完成的 PR、工作区未提交差异，再读 `docs/CHANGES.md` 和当前实施计划。
2. 区分已经合并、已推送但未合并、仅本地完成、测试仍在运行四种状态。无法访问上一位的工作区或日志时如实记录，不能假定没有未提交工作或测试已经通过。
3. 保留现有有效实现和测试，独立核对关键行为。需要修改时说明发现的问题、复现证据、修改原因和保留的保证。
4. 不覆盖正在使用的分支或工作区，不因切换 AI 丢弃未提交内容。使用独立分支/工作树承接已有提交；已发布历史保留，补充说明写入后续提交、PR 或本文件。

## 责任记录

每个阶段的提交说明或 PR 至少包含：

- 实际实现 AI：按范围列 Claude Code / Codex；两者都有实质实现时分别列出。
- 复核 AI：写明复核范围和发现；自查标为自查，未进行独立 AI 复核就明确注明。
- 发布/验收跟进：如与实现者不同，单独记录。

`Co-authored-by` 只用于实际参与实现的作者。审核者不能仅因提出意见或验证就被标成代码共同作者。不要在每段代码中加 AI 作者注释；必要的协议或设计注释照常保留。

## 阶段交接内容

记录分支、提交和 PR，已完成与未完成内容，实际执行的测试命令、版本、结果及 CI/日志位置，当前风险和下一步。测试要区分未跑、运行中、通过、失败；旧提交的结果不能直接当成新提交的证据。真实凭据只记录名称或用途，不记录值。

## 当前接手记录 · 2026-11-14 北京时间 15:00 后

- 正式 main：`04a88fba5c7c9b418393067b478ce90a6ca828bd`，PR [#140](https://github.com/yux91803-hobo/liming-work-site/pull/140)。常驻状态进程和两层桥已交付，生产状态模式仍是 legacy。
- #140 实际代码实现：Codex。架构和前置基础参考 Claude Code 已确认的第二阶段设计；Codex 自查并执行本地验证，Claude Code 随后独立阅读 #140 全部线上代码、复跑完整检查/内核回归，并接续检查正式发布、排查 CI 报告冲突。后续 CI 修复在下一组提交中，不能归入 #140 的代码作者。
- #140 验证：本地完整检查 817/817、内核模式 171/171、浏览器 E2E 12 组；正式 [Actions 43559539100](https://github.com/yux91803-hobo/liming-work-site/actions/runs/43559539100) 第 2 次运行全绿，真实联调 11 项通过、自动回滚跳过，完成于北京时间 14:48。
- 待交付：Claude Code 分支 `claude/xiaoxin-architecture-review-2dkunv`，已推送至 `b8361e9b15d950ad33bd6a7b6fa3e733ef3a01db`，包含写者清单、扫描测试及浏览器报告命名修复 4 个提交；接手时没有对应的开放 PR。
- 本轮 Codex 在独立工作树接续上述原始提交，复核扫描器和分类，落实用户新增交接规范。上一位工作区中的本地后台测试和未推送内容在本会话不可见，保留原分支，不推断其状态。
- 风险/下一步：写者清单漏报复核与本地验证已完成，待本批 PR 全流程；持久服务按下述只读前提证据继续实施。版本化切换、失联收尾暂存和真实状态所有者切换尚未完成；宿主授权 C 与凭据代理 PoC 安排保持已确认设计。

15:26 只读前提核验已完成：小芯电脑 PID 1 为 systemd，用户 UID 1000，`loginctl show-user 1000 -p Linger` 返回 `Linger=yes`，用户管理器为 `running`；`xin-reaper.timer` 已启用，当前 `xin-kernel.service` 为运行中的 **transient** 单元，尚不是持久服务。只查询状态，没有改 linger、安装/启用服务或切换状态所有者。下一块可按已确认设计实现持久单元并验证启用；真实冷启动恢复仍需后续验收，不能把配置核验当成已经重启验证。

本轮完成后用实际提交、PR 和验证结果更新以上记录，不把计划写成已完成。


本轮阶段成果（Codex，本地验收已完成）：工作分支 `codex/xin-writers-handoff-20261114`，接续并保留 Claude 的 4 个原始提交。Claude Code 实现初版清单/测试/报告修复；Codex 独立复核 Claude 实现、修正漏报、补 5 项测试并落实本交接规范；Codex 的新增补丁经过自查与测试，尚未由 Claude Code 再次复核。本地 `check` 834/834、`test:kernel` 171/171、12 组 E2E 均退出 0，差异检查通过。接下来以本批 PR 的 CI、部署及真实联调记录作为发布证据，再推进持久服务；本阶段没有安装服务或开启状态所有者。


#141 CI 接续：已发布原始接手提交 `f1718de`，check 通过，E2E 首次运行失败、部署跳过。运行 `43572318127` 的后续浏览器执行全部通过，但启动时生成的报告编号被复用，上传仍然 409。Codex 根据实际证据追加报告快照/内容命名修正，新增 3 项行为测试先红后绿，专项 22/22；不把原提交的全量结果当成本补丁证据。未改网站、未安装持久服务、未开启状态所有者。具体发布与最新全量验证以 #141 的当前 head 和 Actions 为准。

报告修正后的完整验证（Codex / Node 22.23.3）：check 837/837、kernel 171/171、浏览器 E2E 12 组退出 0；专项 22/22。先前首次运行的失败与原始编号冲突保留在 PR 记录，新 CI 以追加提交为准。


## 持久服务 · Codex 接续（独立批次）

工作分支 `codex/xin-persistent-kernel-20261114`，接续 #141 当前 `ab6116f`，原 Claude 分支与提交未修改。Codex 实现持久 resident 单元、安装中断记录/恢复、启动门修正与行为回归；自查，尚无 Claude Code 独立复核。选独立单元名是因为 systemd 不回收仍有后台进程的 transient 单元；修改原启动方法的原因、迁移/回退详见本批计划和 CHANGES。前期专项 44/44、后续故障测试追加后重跑中；完整检查曾因新增 shell 写入未同步清单失败，已登记并重新全量验证，不能引用旧通过数冒充最终证据。一次本地 E2E 为切换到正确预览工作树主动中止（退出 130），随后从头复跑；不算产品测试失败或通过证据。

未完成：当前批完整检查/CI/正式联调与真实 FragmentPath/启用核验；真实 VM 冷启动/暂停故障未做，不对生产做故障注入。未打开状态所有者、未安装宿主授权/凭据代理。下一批仍是版本化切换/epoch 和失联收尾暂存，通过门槛再切真正状态所有者；旧模式要保留到正式内核模式稳定 7 天。

持久服务代码本地最终验收：check 854/854、kernel 171/171、E2E 12 组、专项 51/51（35 外壳 + 16 写者）全过；Node 22.23.3。当前 main 为 #141 的保留历史合并 `96488dd`，树与 PR 已测树一致；原 Claude 分支仍 b8361e9。#141 正式流程 43576866694 的首次 check 通过、E2E 因像素小芯两项交互断言失败，部署跳过，未更新正式站；报告成功保留。唤醒测试旧坐标失效已经复现（重新点当前身体正常），拖放截图显示工具实际已打开，测试修正和重新发布要另行记证据。不能把 #141 的测试站成功写成正式成功。本批持久服务仍未合并或真实安装。

持久服务已保存到独立远端提交 `eb1a9b60def8462652df9a129147c366251d1309`；实际实现 Codex，复核为自查，尚无 Claude 独立复核。随后仅追加像素 E2E 定位/观察修正：原延时旧坐标失败先复现，修正后延时唤醒 8/8、原生拖放普通/CPU4 倍 8/8，修正后完整 12 组已从头重跑通过（退出 0，STM32 372/372）。当前新 PR 尚未创建，新服务未在真实电脑安装；#141 正式部署仍未执行。不得直接重跑旧 main 发布覆盖下一批新版本；后续以最新 PR 及其正式运行确认合并成果。

本批本地验收已齐：持久服务本体 check 854/854、kernel 171/171、外壳/写者专项 51/51；随后仅改像素 E2E 的定位与真实事件观察，12 组完整 E2E 已再跑通过。CJS 检查不读取这份 Python 测试，后续当前 head 的 CI 仍完整执行所有检查。PR/正式发布待线上结果，真实电脑服务未安装；状态所有者未开启。

#142 首次 Actions 43579920339：854 项完整检查通过，kernel 为 169/171，E2E 尚未运行。两项失败可用只改测试进程 Date.now 的 5 分钟跳跃精确复现（约 2 秒时提前耗尽等待，两项 0/2）；改用 performance.now 的单调等待预算后同一注入 2/2 通过。原预算、断言和生产墙钟截止时间不变；Codex 实际修改两份原测试等待逻辑，原因/参考已入 CHANGES。新补丁的完整检查和 kernel 正在复跑；像素修正后 12 组 E2E 已通过且此后无网页/E2E 更改。没有合并 #142 或部署新服务，不得引用首次失败 head 的通过部分冒充本补丁全量结果。


## Claude Code 接手 · 2026-11-14 北京时间 20:40 后

接手时按远端核对到的状态（看不到 Codex 的工作区和本地日志，以 Git、PR 和 Actions 为准）：

- 已合并：main 是 `96488dd`（#141，Codex 于 16:39 合并）。它的正式运行 [43576866694](https://github.com/yux91803-hobo/liming-work-site/actions/runs/43576866694) check 通过、E2E 失败、**部署跳过**，所以正式站跑的还是 #140 的代码（#141 本身不含 `site/`、`src/` 的改动）。
- 已推送未合并：Codex 的 [#142](https://github.com/yux91803-hobo/liming-work-site/pull/142)，分支 `codex/xin-persistent-kernel-20261114`，head `7ef4240`，Actions [43581216790](https://github.com/yux91803-hobo/liming-work-site/actions/runs/43581216790) 检查、E2E、测试站全绿；没有独立复核，没有合并。
- Claude 自己的分支当时停在 `b8361e9`，那 4 个提交已随 #141 进 main。上一段会话里对 `b8361e9` 的本地全量验证后来跑完了（check 829/829、kernel 171/171、E2E 退出 0），只作记录，不是任何新提交的证据。

这一轮做的：

- 分支：`claude/xiaoxin-architecture-review-2dkunv` 从 `7ef4240` 接续，Codex 的 3 个提交原样保留（作者不变），后面是 Claude Code 的提交。没有往 Codex 的分支推东西，#142 没有动。
- 责任：持久服务本体、像素 E2E 修正、等待时钟修正的实现是 **Codex**（`eb1a9b6`、`60a219f`、`7ef4240`）。**Claude Code** 独立复核了这三个提交和 #141 里 Codex 的两处补丁，并实现了一处修正（持久单元的重启上限）。发布和验收跟进：Claude Code。
- 复核范围和证据：`vm-kernel.mjs` 全部改动、外壳测试、E2E 和等待时钟的修改逐段读过；`7ef4240` 上本地 check 854/854、kernel 171/171、E2E 12 组退出 0（Node 22.23.4）；加了重启上限的 `a128985` 上再跑一遍，check 855/855、kernel 171/171、E2E 12 组退出 0（北京时间 21:04–21:20），之后的提交只改了这两份记录；在本会话容器里用真的 systemd 255 用户管理器实跑了安装、迁移、失败回退、被杀恢复、管理器重启后自启、旧版 ensure 撞上持久服务这几种情形，结果表在[持久服务计划](superpowers/plans/2026-11-14-xin-persistent-kernel.md)末尾；正式电脑只读预检（北京时间 20:59）的结果在 CHANGES。
- 复核发现：自动回滚到旧版时持久服务会每 2 秒重启一次不停（实测）。修正：单元加 `StartLimitIntervalSec=60`、`StartLimitBurst=10`，测试先红后绿，改后同一场景实测重启 10 次后停下。没改的两条限制（启动门遇到进程号被占用、总线连不上时不另起进程）记在 CHANGES。

还没做 / 风险：

- 正式电脑上还没有安装持久服务；合并后的第一次 ensure 才会装。装完要只读核对：`xin-kernel-resident.service` 的 FragmentPath、is-enabled、MainPID 和健康检查的 pid 一致，没有留下 `kernel-service.pending.json`，状态模式仍是 legacy。
- 真实冷启动、暂停恢复没有在正式电脑上验收过，不能把容器里的实测当成这一条。
- 如果这次发布的正式冒烟失败并自动回滚：电脑上的持久服务会在重启 10 次后停在 failed，旧临时单元继续服务；修好再发新版时 ensure 会自己接回去。要长期留在旧版，按计划里的人工回退步骤停用持久单元。
- #142 的内容由这一轮的 PR 带上线后，#142 本身就没用了，可以关掉。
- 下一批（第 2 批）是把正式站切到内核模式：Worker 的 `XIN_STATE_OWNER` 开关带部署代号和 epoch、失联时的收尾暂存。**合并前要先告诉站长**，其余照常由当前接手的 AI 自己走完流程。

### 同一轮的后续 · 北京时间 15 日 01:55–02:20（Claude Code）

- PR：[#143](https://github.com/yux91803-hobo/liming-work-site/pull/143)，分支 `claude/xiaoxin-architecture-review-2dkunv`。提交顺序：Codex 的 `eb1a9b6`、`60a219f`、`7ef4240` → Claude Code 的 `a128985`（重启上限）、`49976fb`（记录）、`8614737`（测试等待改单调时钟）和这一条记录提交。
- 第一次 CI（43599280771，head `49976fb`）：e2e 通过；check 855 项红 1 项，原因是执行机墙上时钟中途前跳约 56 秒，测试里用 `Date.now()` 算的时限提前到期。这一类第三次出现，整类改掉：守卫测试 `test/wait-clock.test.cjs` + 26 个文件 77 行改 `performance.now()`，运行代码没动。实现：Claude Code；自查，没有别的 AI 复核。
- 第二次 CI（43624013935，head `8614737`）：check 857/857 通过；kernel 步骤 171 项红 5 项，执行机在这一步卡住（平时 43 秒，这次 295 秒，中间 3 分半没有输出）。不是代码问题的依据：同一提交本地 check 857/857、kernel 171/171、E2E 12 组退出 0；CI 日志里墙上时间和 Node 单调计时差 193 秒。那一轮的 e2e 还没跑完就被这条记录提交的新一轮顶掉了。
- 这条记录提交之后只改了记录；CI 会在新 head 上从头全跑。**合并条件不变：check 和 e2e 在最终 head 上都绿、测试站冒烟通过。** 如果又因为执行机卡住而红：看日志确认是同一现象（墙上时间远大于 Node 计时、多个文件同时超时）后，对失败的作业重跑一次；再红就停下来告诉站长，不要反复重跑，也不要放宽或跳过测试。
- 执行机 `li-box-runner`（站长那边的共享虚拟机，会话里进不去）今天已经在 #140、#141、#142、#143 上各出过问题：作业执行两遍、10 分钟没进展、时钟前跳、整机卡住。根因没查到。要站长定：搬回 GitHub 托管的执行机，或排查那台虚拟机。
- 给第 2 批的提醒：内核模式下状态进程是长寿进程，小芯的电脑空闲 30 分钟会被平台暂停、恢复后墙上时钟一次跳很久。切正式站之前，要在临时目录里专门测「状态进程在跑时墙上时钟前跳」会不会让请求卡住或让状态进程退出（设计把完整的暂停恢复处理放在第 3 批，但第 2 批就会遇到）。这一条是按 CI 现象做的推断，还没有实测。

## Claude Code · 北京时间 2026-11-15 02:30 后（#143 合并后的正式运行）

- 已合并：#143 → main `b9955fb`（北京 02:31，squash；Codex 的 3 个提交和 Claude Code 的 4 个提交都在 PR 里保留）。#142 已关闭（没有留评论，分支 `codex/xin-persistent-kernel-20261114` 保留）。
- 正式运行 [43627096116](https://github.com/yux91803-hobo/liming-work-site/actions/runs/43627096116) 第一次：e2e 通过，check 857 项红 1 项（状态进程启动时报 `state_compat`），部署跳过，正式站还是 #140。原因是 `checkControllers` 把正在退出的控制器当成「核对不了」（详见修改清单 2026-11-15）；和 #143 的改动无关，正式站不启动状态进程，不影响线上行为。
- 处理：对这次运行的 check 作业重跑了一次（规矩允许一次，不再重跑）。第二次 check 通过；部署 02:57:31 完成，冒烟、正式站联调（02:57:39–03:00:59）都通过，回滚步骤跳过。**#143 已在正式站上线。**
- 根因修复：`claude/xiaoxin-architecture-review-2dkunv` 上的 `71394d8`，单独开 PR。实现：Claude Code；自查，没有别的 AI 复核。本地验证（Node 22.23.4，北京 02:57–03:12）：check 862/862、kernel 171/171、E2E 12 组退出 0。
- 小芯电脑只读核对（北京 03:03，经 InstaBox exec 跑只读命令；不重启、不暂停、不杀进程），全部符合：
  - `xin-kernel-resident.service` active/running，enabled（`default.target.wants` 里有链接），NRestarts 0，FragmentPath `/data/home/.config/systemd/user/xin-kernel-resident.service`；单元文件 600，带标记行和 `StartLimitIntervalSec=60`、`StartLimitBurst=10`。
  - 主进程跑的是这次部署的 `vm-kernel-2f117dcbcfda.mjs serve --port 8797`，占 8797 端口的就是它。
  - 日志里只有一次启动，在 02:57:45，正是正式站联调时第一次 ensure 装上的；之后没有重启或失败。
  - 旧临时单元 `xin-kernel.service` 已被回收（not-found）；没有 `kernel-service.pending.json`，没有内核启动锁文件，`kernel.env.json` 600。
  - 所有者记录为空（= legacy，epoch 0），没有 `vm-agent serve` 进程：状态模式仍是 legacy。
- 还没验收：真实冷启动（关机再开机后服务自己起来）和暂停恢复后的表现。容器里的实测不能代替。
- 给第 2 批：切内核模式后，正式电脑上的状态进程启动会真的跑这个核对；新内核上读正在退出的进程可能读出空内容，这一支是按源码推断覆盖的，切换前在临时目录里多跑几轮「控制器不停起退时启动状态进程」。


## Claude Code · 北京时间 2026-11-15 07:00 后（#144 正式联调失败、回滚和修复）

- 03:30 Claude Code 额度用完，会话停住。03:33 #144 被仓库账号合并（squash，`d42a6c2`），**不是 Claude Code 合并的**；合并前 PR 的 CI [43631282996](https://github.com/yux91803-hobo/liming-work-site/actions/runs/43631282996) 检查、e2e、测试站全绿。
- 合并后的正式运行 [43632754629](https://github.com/yux91803-hobo/liming-work-site/actions/runs/43632754629)：check、e2e、部署（03:45:49）、冒烟都过；正式站联调第一步 `sessions` 回 `state=error`（03:46:05），自动回滚到 #143 的 Worker 版本 `92d73094`。**正式站在这次修复上线前跑的是 #143。** 内核日志里联调那三个请求之后再没有请求（查到 07:06），这段时间没人用小芯。
- 只读核对（北京 07:06，经 InstaBox exec 跑只读命令；电脑本来空闲暂停，这次核对把它叫醒了；不改文件、不重启服务）：内核日志 19:46:00（UTC）greet、tasks、sessions 都回 409 `agent_missing`；19:46:00–05 依次写了 19 个模块文件，第 20 个起和新控制器入口 `vm-agent-7919079b6906.mjs` 都没有；持久服务 active、NRestarts 0；磁盘 61%。之前只用 `GET /v1/machines/{id}`、`/logs` 看过状态，那两个不会叫醒电脑。
- 原因：Cloudflare Workers 免费套餐一次请求最多 50 个子请求，读静态资源也算。冷启动那次请求读 29 个模块文件 + 查电脑 1 + 内核请求 1，再逐个 PUT，第 20 个超限。详见修改清单 2026-11-15「控制器文件一次装好」。
- 修复：`8d4483e`（控制器文件一次 exec 装好）、`66083b6`（安装出错时标准错误只写一行原因），实现：Claude Code；自查，没有别的 AI 复核。新增 4 个测试先红后绿。`66083b6` 上本地（Node 22.23.4，北京 07:22–07:38）：check 866/866、kernel 171/171、E2E 12 组退出 0。这次修复只改 Worker，不改电脑上的模块，所以上线后的第一次请求一定会走新的安装路径：正式站联调过了就说明在真电脑上装好了。
- 本地跑浏览器测试要先起 `node scripts/preview.mjs --port 5173`（CI 里也是这样起的）；会话重启后原来开着的预览服务器会没掉，浏览器测试就全部连不上。
- 给下一位：
  - 冷启动读模块占 29 个子请求，模块每多一个就多一个；子请求测试在 40 个处报警（`test/xin.test.cjs`「冷启动、电脑醒着…」）。快到了就把模块合成一个资源文件读，或者让站长决定换付费套餐。
  - 联调脚本失败时只打 `state`，Worker 对没有错误码的异常只回「云电脑出错了」，这次只能上电脑看日志才查到原因。
  - 第 2 批（状态切到内核模式）照旧要合并前先告诉站长。
- 08:00 后（Claude Code）：#145 合并（`1e0227d`，Claude Code 合并）。正式运行 [43655809524](https://github.com/yux91803-hobo/liming-work-site/actions/runs/43655809524) 第一次：check、e2e、部署、冒烟都过；联调里控制器一次装好了（00:10:51–52 UTC 三个请求回 `agent_missing`，00:10:53.10 前 29 个文件全部写好，没有临时文件残留，之后的请求都正常），但前台模型那一轮失败：Antigravity 命令行静默登录用了 3.5 秒（以前不到 0.5 秒），还没登录完就被调用方结束，联调要的测试任务没派出去，自动回滚。和 #145 无关（它只改上传路径；前台模型之前一天 40 次只失败这一次）。对 deploy 作业重跑一次（00:22–00:26 UTC）全绿，**#145 北京 08:22 上线**。
- 08:31 只读核对：新控制器 `vm-agent-7919079b6906.mjs` 在，没有临时文件；00:22 以后内核 111 个请求全部 200，模型 12 次全部成功；持久服务进程没变、重启 0 次。
- 给下一位：Antigravity 静默登录偶尔很慢，会让正式联调失败（看 `~/.gemini/antigravity-cli/log/` 里那一轮的日志，`silent auth` 的时间）。`/data/workspace/.xin-live-smoke` 里联调留下的结果目录已有 62 个（脚本有意留着便于排查），以后可以考虑定期清。这段记录先放在 `claude/xiaoxin-architecture-review-2dkunv` 上，随下一批 PR 合并。


## Claude Code · 北京时间 2026-11-15 10:50 后（PR #146 笔记本 CI 上两项测试失败）

- 站长自己开的 PR #146（分支 `ci/run-on-laptop`，Codex 实现）把 Deploy 的三个作业换到站长笔记本上的执行机（WSL2 Ubuntu 24.04，标签 `self-hosted, laptop`），只改了三处 `runs-on`。运行 [43668216733](https://github.com/yux91803-hobo/liming-work-site/actions/runs/43668216733) 的 check 挂了 2 项，e2e 过了。站长让在这个分支上修、不删断言、先不合并、不动 main（本来规矩是接续别人的分支要另开分支；这次站长点名在原分支上修，原有提交没动，只在上面加提交）。
- 结论：预热「刚醒」那项是测试的固定时间窗（1.5 秒）问题，功能没坏；备份恢复那项是慢机器碰出的真问题——恢复后第一次调用只把备份那一刻没做完的几轮标成「停了」、等起进程来收尾，可离开工超过 15 秒时 `runDone` 会先把它当成「中途断了」（后台任务还会被接着做一遍），真实恢复每次都会碰上。详见修改清单 2026-11-15「笔记本 CI 上两项测试失败」。
- 提交（实现：Claude Code；自查，没有别的 AI 复核）：`6001436`（预热测试按事件等）、`103eb17`（`restoreStops` 当场收尾，收尾代码抽成 `endStoppedRun`；恢复测试加「隔了一天才恢复」，新加后台任务恢复一项）、`79a12a1`（修改清单）。本地（Node 22.23.4）：check 867/867、kernel 171/171、E2E 12 组全过（第一次跑到一半容器重启被打断，逐组重跑了一遍）。
- 笔记本 CI：运行 [43673319128](https://github.com/yux91803-hobo/liming-work-site/actions/runs/43673319128)：e2e（03:39–03:50 UTC）和 check（03:50–03:55，含内核模式）都过；测试站部署成功，但冒烟检查时笔记本到 workers.dev 的连接断了（curl 退出码 56，之前每个请求 4–11 秒；box 执行机上整段冒烟约 1 秒，同一时间从会话里访问都是 0.2–0.5 秒），按规矩只重跑一次失败的 deploy 作业（04:01–04:03），**三个作业全绿**。重跑时 7 个地址都 200，单个请求仍要 0.4–7.7 秒。冒烟脚本在 `bash -e` 下遇到 curl 网络错误会直接退出，`--retry` 只重试超时和 HTTP 408、429、500、502、503、504、522、524（curl 仓库 `docs/cmdline-opts/retry.md`），不重试连接断开；要更稳可以加 curl 自带的 `--retry-all-errors`，这次没改，留给站长定。
- 给下一位：
  - PR #146 现在除了换执行机，还带着 `vm-agent.mjs` 的这处修复；合并就会随正式站上线、跑正式联调。站长还没决定合不合。
  - `vm-agent.mjs` 行数正好等于基线 3217（只减不增），再往里加代码要先挪出去别的。
  - 「进程没了、离开工超过 15 秒就算中途断了」这条规则本身没动：站长按了「停」、而那一轮的进程没写完就没了时，前台那一轮也会被说成「中途断了」（按源码推断，没实测）。
  - 慢机器复现办法：`NODE_OPTIONS=--require=<让 vm-agent.mjs run 启动时忙等几秒的小脚本>` 只拖慢后台那一轮的进程；单纯让 CPU 忙在这台容器上复现不出来（调度会优先刚醒的测试进程）。


## Claude Code · 北京时间 2026-11-15 12:20 前后（仓库公开前的准备）

- 站长问要不要把仓库公开（为了不再在笔记本上跑 CI）。核对后建议：可以公开，但要先撤掉自托管执行机、日志不打邮箱、清旧日志、扫一遍全部历史的密钥；提交记录里的 Gmail 改不掉，站长知道。站长随后在设置里**删掉了 box 和笔记本两台执行机**，说「剩下的交给你了」。改仓库可见性没有工具，由站长自己点。
- 公开前实测：gitleaks 8.18.4 扫全部分支和 146 个 PR 的提交（593 个），21 处全是测试数据和存储键名，没有真密钥；11 月 5 日 `claude/xin-screen` 误提交过的 `stream.json` 里是一条早已过期的桌面观看链接（带电脑编号）；现在的代码里没有邮箱、电脑编号、Cloudflare 账号 ID。第一次跑 gitleaks 被权限拦下，站长说「剩下的交给你了」之后才跑。
- 改动（实现：Claude Code；自查）：`deploy.yml` 三个作业 `runs-on: ubuntu-latest`；部署列表经 `scripts/ci-redact.mjs` 隐去账号邮箱；新工作流 `clean-logs.yml`（手动运行，只删 `before` 以前的运行日志）；新测试 `test/ci-public.test.cjs`。#146 里的两处修复（预热测试、备份恢复当场收尾）一起带上，换到笔记本那部分不要了。本地：check 870/870、kernel 171/171、E2E 12 组全过。
- 进度：这个 PR 的 CI 第一次在 GitHub 自带的执行机上跑。私有仓库的免费额度可能已经用完（11 月 8 日搬到自托管执行机大概就是这个原因，推断），跑不起来就先请站长点公开再接着走。合并上线后手动运行「Clean old logs」（`before` 填这个 PR 第一次 CI 之前的时间），再请站长点公开。PR #146 被这个 PR 取代（它要的笔记本执行机已经删了），合并后关掉。
- 给下一位：
  - 仓库公开后 Actions 日志任何人都能看：别在日志里打邮箱、令牌、真实聊天内容；新加打印的地方先想一想，必要时也走 `scripts/ci-redact.mjs`。
  - 不要再给这个仓库注册自托管执行机（`scripts/box-runner/` 只留作参考）。
  - 公开后建议站长在 Settings → Actions → General 里把「fork 来的 PR 运行前要批准」设成对所有外部贡献者都要批准（现在工作流本来就不跑 fork 的 PR，这是多一道保险）。

## Claude Code · 北京时间 2026-11-15 13:10 后（#147 上线、清旧日志）

- 站长已把仓库改成公开（北京 12:54 以前，查询结果 `private:false`）。#147 的 PR 运行 43678494280 第 1 次三个作业都没起来（没分到执行机、约 2 秒结束、没有日志；按现象推断是私有仓库免费额度用完）；公开后重跑失败作业一次，第 2 次在 GitHub 自带的执行机上 check 870/870、kernel 171/171、浏览器测试、测试站全绿。
- 北京 13:08 合并（`92df28a`）。正式运行 43679725633 一次全绿：check 和 e2e 并行（约 6 分钟、10 分钟），北京 13:19 部署，冒烟检查、正式站联调 11 项 PASS，没有回滚，13:24 结束。
- 公开后的日志核对：PR 运行第 2 次的三份作业日志和正式运行的部署日志里都没有邮箱，部署列表的 Author 都是「（邮箱已隐去）」；联调只打 PASS 和一个预览网址（内容要先登录小芯聊天才能看），站长密码显示为 `***`。
- 清旧日志：北京 13:25 在 main 上手动运行「Clean old logs」（运行 43681051294，`before=2026-11-15T04:50:00Z`，即 #147 第一次运行之前），13:36 结束：删了 338 个运行的日志，0 个本来就没有，0 个失败。抽查：#145 正式运行的日志已是 404，这次正式运行的日志还在。运行记录和结果都留着；作业信息里的执行机名字（`li-box-runner`、`laptop-liming-work-site`）删不掉，不敏感。
- #146 已关（没合并；它要的笔记本执行机已删，两处修复随 #147 上线）；`ci/run-on-laptop` 分支留着没删。
- 分支 `claude/xiaoxin-architecture-review-2dkunv` 已按合并后的 main 重开；这条记录跟下一个 PR 一起进 main。
- 给下一位：
  - 「fork 来的 PR 运行前要批准」是站长在 Settings → Actions → General 里的设置，没有工具能改，已建议站长设成对所有外部贡献者都要批准。
  - 执行机提示 `actions/github-script@v7`、`actions/download-artifact@v4`、`actions/upload-artifact@v4` 还是按 Node.js 20 写的，现在被强制用 Node.js 24 跑，照常能用；以后顺手升到新的大版本，升之前先看各自的发布说明。

## Claude Code · 北京时间 2026-11-15 14:00 后（第 2 批：正式站状态切到内核模式）

- 站长说「你继续吧」。计划 [2026-11-15-xin-state-owner-switch.md](superpowers/plans/2026-11-15-xin-state-owner-switch.md) 6 个任务都由 Claude Code 实现和自查（没有另一位审核），分支 `claude/xiaoxin-architecture-review-2dkunv`；改了什么见 [CHANGES](CHANGES.md) 最新一条。
- 和计划不一样的地方（都记在计划执行记录里）：撤回「状态进程正常退出一律交回 legacy」，保留 #140 的断言；`kill -9` 空档测试原先在「不重试」时照样通过（主人 15 秒后会重派），改成要求很快收尾、模型只调一次；顺手修了外壳每次操作留一个 40 秒计时器。
- 上线前后要做的（按计划「上线和验收」）：合并前对小芯电脑做一次只读核对（所有权记录、`workflow.sqlite` 大小、有没有 `serve` 进程）；**合并前先告诉站长**；合并后确认正式运行全绿、联调有 `PASS state owner is the resident process …`；上线后只读核对记录、进程、日志、备份；35 分钟没人用之后看电脑照常自动暂停。
- 风险和没验证的：
  - Durable Object 里能不能读到 `CF_VERSION_METADATA`，官方文档没写明（第三方文章说可以）。读不到时代号一直是 1：改 `legacy` 回滚照样生效，只是换控制器版本不会重起状态进程。**下一次部署后看用量页或健康检查的 `owner.gen` 是不是变成 2。**
  - 待送达遇到 Worker 层的「稍等」时，等待原因显示「InstaBox 忙」，不够准确（换状态进程只要几秒，先没改）。
  - 切换前备份用 `VACUUM INTO`，库大时第一次切换会慢一点；联调最多等 120 秒。

## Claude Code · 北京时间 2026-11-15 18:10 后（第 2 批上线、Antigravity 冷启动修复）

- 站长 18:0x 回「可以的」同意合并。#148 北京 18:13 合并（`1498c45`，squash）。正式运行 43702977504：第 1 次联调失败、18:25 自动回滚到 #147（原因见 [CHANGES](CHANGES.md) 最新一条：电脑暂停约 4 小时后醒来，Antigravity 冷启动约 26 秒，超过额度核对写死的 25 秒；和状态模式无关）；重跑部署作业一次，18:43–18:49 全绿，联调 13 项 PASS，含 `PASS state owner is the resident process …`。
- 上线后只读核对（约 18:55，经 InstaBox exec）全部符合：记录被状态进程锁着；`kernel-owner.json` 0600、`gen 2`（Durable Object 读得到版本号，风险排除）；外壳 `vm-kernel-e1a29f7279b5`、状态进程 `vm-agent-2fd96a609bd5 serve --parent-pipe`（父进程是外壳）；没有看门狗；状态事件一次 start、一次 ready；切换前备份一份。
- 空闲自动暂停（验收完成，北京 16 日 00:50 只读核对）：内核模式下电脑照常自己暂停。21:35（#150 的正式联调结束）到 00:25 没有请求；外壳和状态进程的运行时长都比实际少了约 108 分钟（进程只在电脑醒着时计时），说明电脑约 22:38 自己暂停、00:25 被打开网页叫醒；`cooldownUntil` 没有新值，不是跑满时长的暂停。最后一次使用后约 1 小时才暂停（租约到期再空 30 分钟），和 15 日下午旧方式下的 57 分钟一样。状态进程 20:05 随 #149 换版本（交回、新版接上 0.13 秒，切换次数 3），之后没重启过。
- 冷启动修复在分支 `claude/xiaoxin-architecture-review-2dkunv`：`XIN_AGY_QUOTA_MS` 默认 90 秒，测试先红后绿；跟这条记录一起开 PR。
- 分支处理：#148 是 squash 合并，按规矩要从 main 重开分支，但强推被会话的自动权限拦了；改成在旧分支上合并 main（`a7f0567`，内容和 main 一样），普通推送。
- 站长新定的规矩：小芯的动作不合理可以直接改良（已写进 CLAUDE.md）。
- 给下一位：
  - 第 2 批之后状态由常驻进程管。回滚办法见 README「小芯后台运行方式」第一条。
  - 联调发第一句话之前电脑多半刚醒：Antigravity 冷启动慢是常态，别把这类失败当成新改动的问题，先看 `~/.gemini/antigravity-cli/log/` 里那次的日志（里面有账号邮箱，不要贴出来）。

## Claude Code · 北京时间 2026-11-15 19:20 后（小芯工作台重新设计）

- 站长要求（原话在设计文档开头）：工作台「有点丑，而且还有点简陋」，要从 0 设计，「交互细腻和好看，要让人看着很舒服」，看现有功能可以加新布局、不需要的删掉。第一版还是在旧布局上改，站长说「感觉你还是在基于原有的布局上在改」，于是按 impeccable、frontend-design、ui-ux-pro-max 三个设计 skill 重来：先列现有功能逐条定去留，写设计文档 [2026-11-15-xin-workbench-redesign-design.md](superpowers/specs/2026-11-15-xin-workbench-redesign-design.md)，做设计稿和可点的预览，再实现。之后站长没再提意见，按 CLAUDE.md 全流程自己上线。
- 改了什么见 [CHANGES](CHANGES.md) 最新一条。界面层是 `site/xin/chat.js`（发送、排队、待送达、轮询、SSE 的逻辑没动）和 `site/xin/chat.css`（整个重写）；`site/mascot.js` 只给 `portrait` 加了表情参数；`site/shell.js` 改了快捷键（打字时不认「/」、聊天开着不抢 Ctrl+K、聊天处理过的 Esc 不再关工具）。根目录新加的 `PRODUCT.md` 是 impeccable 读的产品说明（谁用、在哪用、原则），以后做界面先看它。
- 分支 `claude/friendly-hopper-d7392n`，从 #148 的 main 开；中途 main 合进 #149（另一个会话的冷启动修复和文档），我这边还没提交，直接快进上来，三份文档没有冲突。
- 本地验证：见 PR 说明（`npm run check`、`npm run test:e2e` 12 套）。截图 1280 / 1024 / 768 / 390 × 浅色深色看过；impeccable 的检测器只剩「小芯岛用了弹性缓动」的提示，是设计定的（只有小芯岛用）。
- 给下一位：
  - 任务的入口只剩小芯岛（输入框上面的任务条、「任务」列表页、标题栏的方格按钮和「屏幕」按钮都删了）。浏览器测试要找任务：先点 `.xc-isle`，面板是 `.xc-work.in`，任务行是 `.wk-c[data-tsid=…]`，标题 `.wk-t`；全屏 900 以上钉住时面板常驻（`lm.xin.trayPin`）。点任务行正中可能正好点在「停止」上，点标题更稳。
  - 工作台里的圆角都走 `--rad`：`pixel.css` 全局 `border-radius:0 !important`，所以 `.xc *{border-radius:var(--rad) !important}`，要圆角就设 `--rad`，直接写 `border-radius` 不生效。像素头像要 `stroke:none`（`shell.css` 给所有 svg 描了边）。
  - 弹性缓动 `--e-spring` 只给小芯岛（按下和展开），别处用 `--e-out`。

## Claude Code · 北京时间 2026-11-16 00:40 后（工作台第二轮之一）

- 站长看了 #150 上线的工作台，提了六件事（原话见设计文档 [2026-11-16-xin-workbench-round2-design.md](superpowers/specs/2026-11-16-xin-workbench-round2-design.md)）。分两批：这一批是答案直接说在聊天里、小芯岛动画、用量分网关和 Google、状态字；下一批是天启的独立入口（模型和思考强度选择动画）和小芯干活时的实时终端。
- 改了什么见 [CHANGES](CHANGES.md) 最新一条。控制器改了 `vm-handoff.mjs`（交付消息的过滤和提示词）、`vm-models.mjs` / `vm-agent.mjs`（用量多给 `sources`）；网页改了 `chat.js` / `chat.css`。
- 分支 `claude/friendly-hopper-d7392n`：#150 squash 合并后按规矩要从最新 main 重开，但强推被会话的自动权限拦了；改成在旧分支上合并 main（`13f9c4c`，内容和 main 一样），这一批的提交放在上面，普通推送。之后 main 又合进了 #151（只改文档），也是合并进来的，两边的内容都保留。
- 给下一位：
  - 后台做完的结果现在是普通消息（`.xc-tres` 只是个标记，没有卡片样式），下面「详情」打开这件活的详情页（站长定的叫法，别改回「看过程」）。`publicCompletion` 的过滤按「站长问没问到模型 / 配置 / 实现」决定要不要藏模型名，内部编号只认这件活自己的。
  - 小芯岛开合：`setTray` 里的形状（clip-path）和标题那组（`.xc-wk-id` 的 transform）一起动，药丸用 `.under` 藏在面板下面；`S.trayMv` 为真时 `renderTray` / `renderWork` 只记一笔、展开完再画。要改面板标题那一行，药丸里那一行也要一起改（两边必须一模一样，换的那一帧才看不出）。
  - 动画能打断：收起途中 `.xc-work.mv.out` 不接点击（`pointer-events: none`），这时再点小芯岛，点击落到药丸上，从当前的位置展开回去；工作台浏览器测试有一条专门核对，别去掉。展开完去掉 `enter` 的计时器记在 `enterTm` 里，开合时一起清掉。
  - 还没做：触屏上回答下面那一行（复制、详情）按钮只有 28px 高，比 44px 的点按建议小（复制在 #150 就是这样，这一批没变差）。下一批在回答上方加工作记录时一起改这一行。
  - 状态字：`actVerb` 按命令认在干什么，`thinkWord` 轮换；第一句永远是「思考中」（计时那条浏览器测试按「思考中 · 1 秒」核对）。
  - `npm run check` 和浏览器测试同时跑时，`xin-kernel.test.cjs` 的「流：对方断开就停，不再调 poll」偶尔超时（它等固定 150 毫秒）；单独跑稳定通过。别和浏览器测试并行跑它。

## Codex · 北京时间 2026-11-16，第 3 批 A 接续

- 接手核对：实际 main 已到 #152（`0d1823e`），正式 Actions [43779930164](https://github.com/yux91803-hobo/liming-work-site/actions/runs/43779930164) 成功；#148 已接管状态，#149/151 已完成冷启动超时和空闲暂停验证。#142 被 #143 接续，不能再继续合并旧 #142。Claude 原分支与此前六个工作树均保留；另开 `codex/xin-kernel-recovery-20261116`。用户明确工作台界面属于另一条开发线，本批没有修改 UI。
- 实际实现：Codex；复核：Codex 自查，尚无 Claude Code 独立复核。修改 #148 后续恢复路径的原因、旧子进程故障证据和行为保证见 CHANGES 最新条目。基于已确认设计，新增 [恢复实施计划](superpowers/plans/2026-11-16-xin-recovery.md)，3A 兼容版本先上线，再独立启用；3B 收尾暂存随后实施，不混成一次大重构。
- 已实现：派发编号/启动环境/兼容桥/写入口校验，提交锁内读取 SQLite 权威编号，启动器身份和生命周期锁核验，重派前清理旧子进程；状态启动和暂停恢复立即核对，通知异步等待期间仍可核对状态。没有新表、数据删除或真实 VM 故障注入。`vm-agent.mjs` 抽出派发/恢复模块，行数基线随之下调，读改写存量仍为 5。
- 本批默认不分配新协议；隔离测试开启编号。旧在途轮次不升级；已有协议在关闭新分配后仍遵守协议。启用前必须先拿到本兼容版本的正式绿色证据，回滚只能到懂协议的版本。常规 legacy/kernel 切换仍保留。
- 测试：接手基线 check 915/915（Node 22.23.4）。新增专项和完整验证在运行中；以随后本节的完成记录和 PR 当前 head 为准，不引用过期的通过结果。
- 未完成/风险：收尾暂存未实现，不能宣称 owner 长期失联结果不丢；同 UID 的编号不是权限/凭据隔离。下一步在 3A 正式验证后独立启用，然后做 3B 的固定收尾包、持久回执、先重放再重派；宿主授权 C/凭据代理 PoC 仍按已确认设计，不砍掉电脑维护能力。截图里的两项显示问题留给工作台开发线。

第 3 批 A 本地验证补充（尚未发布）：首轮修改后 check 930/930，70 项专项及尝试组 9/9 通过；内核关闭编号的全量 170/174，4 项原重试/每日超时测试发现本批启动即扫之后没从空闲 60 秒提前唤醒。已补 hasWork 和单调时钟定时器，只提前、不随轮询延后；修正后旧重试两项 2/2、状态桥 18/18。没有放宽旧断言。最终完整检查与两种配置的回归从头再跑，旧 930 不能冒充修正后的当前树证明。CI 的内核回归显式开启编号。下一位如遇进行中的脚本，见 /workspace/xin-review/handoff151-progress.md（仅本地状态，无凭据）。

编号全面开启的补充核对：第一次整组 933 项中 932 过、1 项旧 fixture 缺少尝试身份（上传目录拒绝）失败。`xin-cleanup.test.cjs` 和 `xin.test.cjs` 的三项手工任务 CLI 模拟都改为用 `test/helpers/run-context.cjs` 在启动时固定捕获身份，不能临时借新编号。原业务保护不变；专项 5/5 和 3/3 过，整组再次验证中。两种配置内核各 174/174 已通过。远端进度已保存 `ca30b97`（兼容基线，默认关闭；代码实际实现 Codex、自查），当前 fixture 补充和最终验证文档随后另提交；还没有 PR、合并或部署。


<a id="recovery-20261116-local"></a>
## Codex · 2026-11-16 第 3 批 A 兼容版本本地验收完成

- 分支 `codex/xin-kernel-recovery-20261116`，代码进度提交 `ca30b97`；随后的提交补齐测试执行身份和最终验证记录。父基线仍为 main #152（`0d1823e`），原 Claude 分支/提交与旧工作树均未覆盖。实际实现 AI：Codex；复核 AI：Codex 自查，尚无 Claude Code 独立复核。
- 已完成：执行尝试协议、SQLite 提交锁内的权威编号检查、旧报告隔离、启动器/生命周期锁核验、重派前清理旧进程组、启动/暂停恢复检查、从空闲转有活的定时器唤醒。没有工作台 UI 改动、表迁移、数据删除或真实 VM 故障注入。默认只发布兼容能力，尚未启用新编号分配。
- 本地最终验证（Node 22.23.4）：完整编号开启 `check` 933/933；内核关闭/开启编号各 174/174；12 组 E2E 全过，学习台 372/372。日志在 `/workspace/xin-review/recovery-check-enabled-final.log`、`recovery-kernel-off-final.log`、`recovery-kernel-on-final.log`、`recovery-e2e.log`。测试顺序执行，没有让完整检查和浏览器测试同时争用 CPU。
- 首轮定时回归及旧 fixture 身份不完整已修正，原有效测试和所有业务断言保留；不要引用那些失败提交的中间结果当成当前结果。当前没有合并/部署；PR 和 Actions 链接随后记录于 PR 描述，实际状态以当前 head 为准。
- 下一步：先将兼容版走完 PR、CI、测试站和正式联调，拿到已验证回滚目标；再在独立分支启用新轮次编号并重复验证。第 3 批 B 的收尾包/暂存/幂等重放尚未实现，不能宣称 owner 长期失联时结果不丢。同 UID 的编号不是权限凭证；宿主授权 C、凭据代理 PoC 和工具权限层继续按已确认设计推进。旧模式未达到正式稳定 7 天删除门槛，继续保留。


<a id="attempts-enable-20261116"></a>
## Codex · 2026-11-16 第 3 批 A 默认启用版

- #153 已正式成功：合并 `655d325`，CI/测试站 43808292216，正式运行 43809734994；已只读确认持久服务启用/运行、单一状态进程、实际代码摘要与本地相同，分配默认 false。原始实现提交 `ca30b97`、测试/验证提交 `b4855c5` 均保留，没有 squash 或覆盖 Claude 的历史。
- 本版在 `codex/xin-kernel-attempts-enable-20261116`，原启用提交 `4f19129` 基于已正式验证的 #153；发布前正常合入已正式验证的 #154 / `5c65fe7`（正式运行 43812529995 成功），保留双方原提交与交接。实际实现 AI：Codex；复核 AI：Codex 自查，尚无 Claude Code 独立复核。工作台文件逐字沿用 #154。
- 相对最新 main，运行改动仍只有下述默认值；#154 的任务摘要与 Codex 事件输出原样保留，没有覆盖另一位 AI 的控制器增量。
- 运行改动只有 `ATTEMPTS_DEFAULT=true`；测试标题说明关闭分配时依旧校验，不改业务断言。新轮次选协议，旧在途轮次不升级；已有编号不受关闭分配影响。回滚最低已验证版本 #153 / `655d325`，不要直接回 #152，更不能恢复旧备份覆盖新状态。
- 本地最终验证（Node 22.23.4）：check 933/933、kernel 174/174、E2E 12 组全部通过（学习台 372/372）。日志 `/workspace/xin-review/activation-check.log`、`activation-kernel.log`、`activation-e2e.log`。各测试顺序运行，和第一批的远端 CI 并行，没有让本地检查与浏览器争用 CPU。当前本启用版尚未提交 PR/发布，后续状态以 PR/Actions 当前 head 为准。
- 下一步：启用版 PR→全量 CI/测试站→合并→正式联调→只读核对运行代码与编号记录，再交接。第 3 批 B 的固定收尾包/持久回执/先重放再重派尚未实现，长期 owner 失联仍有收尾缺口；它也必须隔离下述旧沙盒文件队列。宿主授权 C、凭据代理 PoC 与工具权限继续分批做。legacy 保留，内核模式尚未连续稳定 7 天；同 UID 编号不是安全凭据。

- 本次保证覆盖带运行身份的控制器状态桥；旧沙盒文件桥仍按工作区复用队列，请求只有 op/text。局部临时目录探针确认残留请求可被下一次 drain 接收（惰性 handler，未调用真实控制器）；入口仅 remember/ask，未证明宿主越权。第 3 批 B 必须分隔 run/attempt 与请求回执，不能把当前编号说成所有工具来源都已隔离。

## Claude Code · 北京时间 2026-11-16 08:40 后（工作台第二轮之二：天启入口、小芯的电脑）

- #152（第二轮之一）北京 08:21 合并（`0d1823e`），正式运行 43779930164 全绿（含正式站登录、真实模型、后台任务联调），线上 `chat.js` 和合并的代码逐字节一致。分支照上次的办法接上 main（`60370bf`，内容和 main 一样）后接着做第二批。
- 第二批做了什么见 [CHANGES](CHANGES.md) 最新一条。站长中途改了终端的方向（第一版常驻在聊天里 → 点小芯的头像弹出、像素风、欢迎框里放小芯、一个字一个字敲），设计文档第 5 节写了最终做法，原来的设想留在后面对照。
- 开 PR #154 之后 main 合进了 Codex 的 #153（第 3 批 A：执行尝试、恢复检查，北京 13:21），#154 因此冲突：照老办法把 main 合进分支（不改写历史），CHANGES 和这份交接两边都留着（CHANGES 新的在上；交接里 Codex 那两节在前、这一节在后）。#153 改的是控制器（`vm-agent.mjs` 等），这批只在 `taskSummary` 里并进了一个 `run`，合并后重新跑了检查和浏览器测试。
- 给下一位：
  - 终端在 `site/xin/term.js`（`LimingXinTerm.win(root)` 一个页面一个窗口：`open({anchor, tabs, active, onTab, onClose})`、`push`、`fill`、`end`、`add`、`close`；`line(ev)` 决定一步怎么写、内部命令返回 null）。类名一律 `tm-` 开头：`xt-` 是小芯岛面板的，`.cmd` 是首页命令栏的，第一版撞过。
  - `chat.js` 里「小芯的电脑」一节：每一轮的事件存在 `S.runEv`、你那句话在 `S.runMeta`（发出去拿到 run 时就记，事件里不一定带 user）；后台的活读到哪在 `S.tf`，只在窗口开着、正看那一页时轮询；头像能不能点看 `data-term`（`live` / `run:…` / `task:…`）。
  - 后台在做时聊天最下面那一行是 `.xc-bgrow`，不要给它加 `.xc-typing`：浏览器测试判断「这一轮回完了」看的是有没有 `.xc-typing`。
  - 天启入口：`setAgent` / `newChat(stay, toMain, agent)`；`lm.xin.agent` 的意思是「现在看的这一页是谁的」，学习台单独打开时还按它判断。天启的颜色 token 是 `--tq*`，只用在天启的东西上。
  - 还没做（上一批记下的）：触屏上回答下面那一行按钮只有 28px 高。这一批没动那一行。


<a id="task-bridge-20261116"></a>
## Codex · 2026-11-16 3B 队列归属与回执子批

- 已核对最新 main #155 / `eb1afaa`、正式 43831290224 全绿；3A 发布与编号只读证据见 #155。已在恢复计划中落账 3A 完成，不再把旧截图 #151 当最新进度。
- 独立工作树 `/workspace/liming-kernel-finalize`，分支 `codex/xin-kernel-finalize-20261116`。实际实现与交叉检查均为 Codex（根代理与子代理），没有 Claude Code 独立复核；旧分支、提交和工作树均保留。
- 本子批：run/attempt 私有文件队列、事务内的 remember/ask 与请求回执、重送/冲突/结束校验、临时错误留队、文件与目录 fsync、Codex 和 Antigravity 的局部工作区副本。工作台界面未改，天启不启用沙盒队列协议。
- 后续继续时重新核对发现 main 已到 #157 / `a50b912`，正式 43868469062 成功；正常合并保留 #156/#157 的 UI、事件输出和 owner_unavailable 修复，仅合并文档冲突。此前 966/174/174 对应旧基线，浏览器进程中断只跑到部分，不能当成完整 E2E；接入后重新验收。
- 修复前移：原子刷新旧工作区 shim、初始化 shell-env 不跟随软链接及固定目录写入已纳入兼容读取方，不能只留在启用版，否则回滚会重新暴露旧写路径。临时红测及触发链见 CHANGES；没有测试真实模型受诱导概率或操作真实用户文件。接入 #157 的976项是加固前中间证据，当前含加固的新验证使用独立 bridge-safe157-* 日志及状态 JSON。
- 发布：兼容读取方 `BRIDGE_DEFAULT=false`，正式验证后再独立 PR 开启新轮次分配；已有协议不受关闭分配影响。开启后的最低回滚目标必须是已正式验证的本子批读取方，不能直接回 #155。测试/CI/正式最终结果以本批 PR 描述为准，未通过不合并。
- 最终本地证据：接入 #157 且包含初始化加固/测试时钟修正后，Node 22.23.4，显式开启 check **989/989**；开启/关闭分配内核各 **176/176**；E2E **13 组全过**（学习台 372、终端 49）。日志 `/workspace/xin-review/bridge-safe157-final-{check,kernel-on,kernel-off,e2e}.log`，状态 JSON 各阶段退出 0 且 sourceChanged=false。旧 966/976/988 的中间证据保留，不替代这次结果。代码/测试提交 `b5c1207`，随后只补验证文档；PR/CI/正式发布以本批 PR 当前描述为准。
- 剩余：[持久收尾计划](superpowers/plans/2026-11-16-xin-finalization.md) 尚未实现，包含固定结果包、阶段回执、受控验收/文件发布与长失联报告；不把队列回执当整个 3B 完成。同 UID 身份不是权限凭据，宿主授权 C 与凭据代理另批；legacy 继续保留。

## Claude Code · 北京时间 2026-11-16 15:00 后（工作台第三轮）

- #154 北京 13:47 合并（`5c65fe7`），正式运行全绿、线上文件和合并的代码一致；分支照老办法接上 main（`966e638`，内容和 main 一样）后做第三轮。
- 站长看了 #154 提的五件事（侧边栏像模板；切回小芯时标题闪一下、文案太口语；终端要像 Claude Code 的欢迎页；思考文字要跟着问题走；派了后台任务也要一直在动），原话、只读查到的事实和做法见设计 [2026-11-16-xin-workbench-round3-design.md](superpowers/specs/2026-11-16-xin-workbench-round3-design.md)，改了什么见 [CHANGES](CHANGES.md) 最新一条。一个 PR 上线。
- 只读查过小芯电脑上的记录（前台 ACP 的思考、Antigravity 后台的步骤）；在电脑上试过的小探针都在临时目录里，跑完删了。没动用户的网关面板、没删机器和快照。
- 给下一位：
  - 状态行写什么，从具体到概括：真实的一步（前台事件在 `chat.js` 的 `stepOf`；任务摘要的 `activity` 在 `vm-events.mjs` 的 `stepActivity`）→ 前台开始时的概括（`vm-status.mjs`，事件 `{t:'think', src:'status'}`）→「思考中」。别再加轮换的字（impeccable：同一个概念同一个词）。
  - `think` 事件：`src:'status'` 是概括（中文，放「正在输入」那一行）；`src:'model'` 是模型自己的思考——Hydrogen 的是英文，只画在终端里；天启（Harness）的是中文，概括没来时也放进「正在输入」。概括来了以后（`S.thinkFixed`）不再被模型的思考换掉。
  - 概括的用量记成 `run_stat`，带 `key: run + '.status'`、`kind: 'status'`：`statAdd` 改成按 `key` 去重（原来按 `run`，状态那条会顶掉这一轮自己的记录），`modelStats` 不把它算一轮，`vm-usage` 不加 `runs`。内核的 RUN_REPORTS 要求 `args.run` 等于调用方自己的 run，不能编一个假的 run。
  - 概括请求的提示词以「你是聊天界面的状态栏」开头，测试的假网关靠这一句认出它（`test/helpers/front-responses.cjs`、`xin-front-agy.test.cjs`）；改提示词的开头要一起改。
  - 后台那一行 `.xc-bgrow` 两行：`.xc-bg-t` 任务名、`.xc-bg-s` 那一步（`swapText` 上下换）、`.xc-bg-sec` 秒数；后台有活、正看着这个对话时 `pollTasks` 2 秒一次。还是不要给它加 `.xc-typing`。
  - 终端：夜景是 `term.js` 的 `SKY`（96×18 格）和 `scene()`。像素图的 SVG 一定要带 `xc-px` 类：全局的 `.xc svg:not(.xc-px)` 会加描边，云和星会糊成一团。改动的高亮 `hlCode` 一行一行认，不跨行。
  - 侧边栏：「对话」小标题找 `.xc-dr-conv`——`.xc-dr-h` 可能有两个（有未发送的消息时上面还有一个）。触屏上侧边栏能点的都是 44px，`xin_main_e2e.py` 核对着。
  - 欢迎页大标题只写名字（「小芯」「天启」）、不换行；`xin_term_e2e.py` 逐帧核对切换时标题一直是一行。点阵字（`scripts/build-font.py` 从 Unifont 取子集）没有「日」这些字，标题要用点阵字先看字库里有没有。
  - 文案按设计文档第 4 节的术语表写；小芯头顶气泡里的话是它的性格，不按这个改。
  - 还没做：回答下面那一行（复制、详情）触屏上只有 28px 高（前两批记下的）；后台任务的思考没翻成中文（Antigravity 不流式给思考，要多一次模型调用），聊天里只写步骤。
  - 不要和浏览器测试同时跑 `npm run check`（内核那几条偶尔会超时）。其中「流：对方断开就停，不再调 poll」的原因已经查清并修了（#157：断开前起的那次 poll 计数晚到，现在等流结束的记录再数）。
  - #156 北京 19:47 合并后，正式联调在部署换状态进程的几秒里收到包在结果里的 `owner_unavailable`，判失败、20:00 自动回滚到 #155（`580cdaae`）。原因和修复见 CHANGES 最新一条：`src/xin.js` 的 `call` 把控制器回来的「没执行」（`{error:'owner_unavailable', executed:false}`）也回成「稍等」。修复另开 PR 合并后，第三轮随正式部署一起再上线一次。查电脑上换状态进程的经过：`~/.xin/logs/kernel.jsonl` 里 `"route":"state"` 的 stop / exit / start / ready 和 `agent_missing`（只读）。
  - 小芯的脸（`.xc-face` 里的 SVG）会被 `paintFace` 整块换掉（表情变了就换），所以脸的 SVG 一律 `pointer-events: none`，点击落在外面那层：按下和松开之间 SVG 被换掉，浏览器就不发 click（#156 的 CI 抓到过，`xin_term_e2e.py` 有一条专门核对）。以后在会被整块重画的东西里放可点的内容，也要这样处理。

## Claude Code · 北京时间 2026-11-16 21:20 后（工作台第四轮）

- #157 北京 20:38 合并（`a50b912`，第三轮随它重新上线），正式运行 43868469062 全绿（联调 12 项全过、没有回滚），线上 `chat.js`、`chat.css`、`term.js` 和合并的代码一致。这次部署控制器和 #156 一样（文件上次已经传上去了），没再换状态进程，所以 #157 的「稍等」这次没用上，有单元测试兜着。分支照老办法接上 main（`e033f1c`）后做第四轮。
- 站长看了第三轮提的：头像上的终端小标不要、点「思考中」那个框开终端；派活的那一轮不要分成两条，话下面一个加载框（不画头像），点开是终端。我复述（加了三点：底部那一行去掉、结果接回上面时顶上提示、只跑过命令的回答下面留一行过程框），站长说「可以开始做」，又提了三个：网页卡片显示不对、终端弹出卡、「打开网页」和「打开预览」重复。做了什么见 [CHANGES](CHANGES.md) 最新一条和设计 [round4](superpowers/specs/2026-11-16-xin-workbench-round4-design.md)。
- 只读查过小芯电脑上那张网页截图（`~/.xin/previews/5217…/preview.png`，390×800）；用的是 `scratchpad/ib_exec.sh`（只读命令），没改电脑上的任何东西。
- 给下一位：
  - 聊天里能点开终端的只有这几块，都用 `termBtn(el, ctx, label)`（`data-term`、`role=button`、`tabindex`）：「思考中」整条（`.xc-typing`，`live`）、派出去的活的框（`.xc-tb[data-tsid]`，`task:sid`）、前台过程那一行（`.xc-tb.xc-proc`，`run:run`）。头像不再是按钮，`.xc-av-t` 和底部的 `.xc-bgrow` 都删了。这几块里面的元素一律 `pointer-events: none`（字和脸一直在换，见第三轮那条）。
  - 框放在那段话所在的那一条里（`inHost`：正文和 `.xc-acts` 之间）；先派活后说话时框先占一条 `.xc-tbh`，`draw` 的 text 分支把话填进它的正文。结果用 `resultAfter(sid)` 找到派活那一轮的最后一条、`contMsg` 接在后面（`.cont`、不画头像、`data-run` 是派活那一轮）；找不到框就照旧 `aiMsg('task-'+sid)` 单独一条。「复制」那一行只在一轮最后一条下面露出来的老规则（CSS `:has(+ .xc-ai.cont)`）不用改。
  - `paintBoxes()` 在任务情况变了（`termSync`）、每秒（有在做的框才开计时器 `boxTk`）重画框；做完的框按 `data-st`（状态 + 用时 + 名字）没变就不重画。
  - 结果接回来以后的提示：`seeResult(e, t)`——在最下面照旧 `toBottom()`，在眼前 `glint`，看不到就顶上的 `.xc-upchip`（`upGo` 滚过去；`jumpCheck` 里滚到了就收起）。
  - 终端收起要等动画（`term.js` 的 `closing`，手机 300 毫秒、电脑 160 毫秒后才 `hidden`），这期间 `isOpen()` 已经是 false。浏览器测试里关了以后要等 `.tm-win` 的 `hidden` 再查。
  - 网页检查的截图（`WEB_BROWSER_CHECK` 最后）现在是 1280×800、重新打开以后截的；工作台卡片对竖图（旧的）用 `tallFig` 整张缩进去。
  - 还没做：回答下面那一行（复制、详情）触屏上只有 28px 高；后台任务的思考没翻成中文（前两批记下的）。
  - #158（Codex）北京 23:00 合并后正式联调失败、自动回滚到 #157（`4391a53d`）：部署换状态进程的空档里 `usage` 拿到 `{error:'owner_unavailable', executed:'unknown'}`（发出去以后连接才断）。这一轮在 `src/xin.js` 的 `call` 里补上：能安全重来的（`retrySafe`）也回「稍等」。以后再看到部署后第一步 `owner_unavailable`，先只读查 `~/.xin/logs/kernel.jsonl` 里 `route:"state"` 的 stop / start / ready 和那一次请求有没有 `via:"state"`。

## Claude Code · 北京时间 2026-11-17 00:40 后（第四轮上线回滚以后）

- #159 合并后正式运行 43904319051 两次没过，正式站一直是 #157（第三轮），经过见 [CHANGES](CHANGES.md) 最新一条。
- 给下一位：
  - **页面类名是正式站联调的约定**：`scripts/test-xin-live.py` 取回答用最后一个 `.xc-ai:not(.xc-typing) .xc-bub`，打开网页成品等 `.xc-preview` 再点。`.xc-bub` 只能用在回答正文上；做完的网页总要有一个 `.xc-preview`（正文里的链接或下面那颗）。改聊天的结构前先 `grep -n "locator(\|wait_for_selector(" scripts/test-xin-live.py` 对一遍。
  - **给 Codex**：`test/xin.test.cjs` 第 1126 行「后台任务：同时最多两个……分身要确认就停在『等你确认』，回复了接着做」在 main 的正式运行上失败过一次（43904319051 第一次，第 1173 行：`front.jsonl` 里没有「任务 4『D』在等用户确认：要删掉旧的 build 目录吗」）。同一份代码在 PR 的 CI、本地都过，本地 6 个并行 × 2 轮也全过，CI 上那次用了 26 秒（本地并行时 30–34 秒），不是机器慢。照代码，D 变成 `waiting` 是在 `taskFinish`（那一轮退出以后），同时 `taskPush` 排一次转达；转达那一轮和「嗯」那一轮组装前台输入时都会带 `taskNotes` 里的「在等用户确认」——两次都没带说明那时 D 已经不是 `waiting`，或者两轮前台都没真的调用（`test/helpers/front-responses.cjs` 每次调用都会先记日志）。#158 改了这一带（`drainTaskReports`、`task_bridge`），请对着它再看一下有没有让 `waiting` 被改回去、或者让前台走了不调用模型的路。

## Claude Code · 北京时间 2026-11-17 01:40 后（后台干活时插话、主动回来说一句）

实现和自查：Claude Code（同一会话，没有另一位审核）。设计 `docs/superpowers/specs/2026-11-17-xin-steer-design.md`，改动清单见 `docs/CHANGES.md` 同日条目。先读这几条：

- **代码在哪**：都在 `site/xin/vm-steer.mjs`（纯函数 + `createSteerOps`，只引 `node:crypto`，控制器的读写由 vm-agent 传入）。别再拆成两个文件：冷启动装控制器每个模块一个子请求，`test/xin.test.cjs` 要求不超过 40 个，现在正好 40。
- **补充怎么接**：`taskTell` 的回执带 `delivery`（now / next / start / reply / resumed / ended），`tellMode(t)` 算同一件事给前台看。能进当前轮的只有这一轮记录里 `transport` 是 `app-server` 或 `antigravity`、还没 `modelDone` 的（`steerable`）。Gemini 后台在 `antigravityWork` 每一步之前调 `options.steers()`（控制器 `steer_take`，在 tasks 锁里把 pending 标成 accepted 并在这一轮显示成兄弟的一句话），final / ask 之前再取一次，有就再走一步（`LATE_STEER_MAX`）。
- **补充不丢**：`taskFinish` 里这一轮没送进去的（pending / next）带进 `t.inbox`；没正常做完时送进去了的也带上（`held: true`，不触发「接着做」，只跟着下一轮走）。`startTask` 把收件箱放进下一轮开头并清空；`taskTell` 的继续路径同样一次取完。同一轮换执行入口时 `steer_handover` 把这一轮的补充交给新模型。`taskStop` 不再清收件箱。去重靠任务里的 `t.tells`（最近 32 个编号和回执）。
- **前台**：`handNotes` 只在 `mentionsWork(text)`（`vm-steer.mjs` 的说法表）为真时附 `<手上的事>`，**不要改成按词重合**——正式联调「只回复 陀螺 茶壶 贝壳……也不要等待后台」和派活原话共用很多词，#117 就是每轮带进行中被 DeepSeek 答成进度。`frontAction` 的 tell：`--continue` 才对已结束的任务开工；`ended` 回执不结束这一轮、不写 `.front.json` 回执（写了会挡住同一轮后面的调用）；`frontHandModes` 和实际 `delivery` 对不上时带 `reword`，`frontTurn` 不用预先写好的话、走 `ownWords`。
- **主动说一句**：`taskNote` 记过程、合并（`journal.appendNote`）、限 3 条；交接队列里 `kind:'note'` 的记录由 `noteStart` 在原对话的锁里处理：任务版本变了就作废，对话忙就等，然后直接写一轮 `kind:'note'`、`ended` 的记录（没有 runner、不调模型、不推送）。网页靠 `tasks` 接口返回的 `notes` 画（`drawNotes`，按 run 去重）。
- **正式站联调**多了 `scripts/xin_live_steer.py` 三段真模型（Gemini 补一句、停下再继续、点名 Kimi），这一步时限改成 45 分钟。夹具标题以「这是发布后的真实联调（插话），」开头，失败残留会在下次联调开头清掉（`SMOKE_TITLES`）。只打印布尔值和计数。
- **真实断电没在线上模拟**：没有加「模拟断电」的线上接口；联调用「停下再继续」，runner 被杀、超时、Gemini 额度用完换模型都在 `test/xin-steer.test.cjs` 里用真进程验证。

## Claude Code · 北京时间 2026-11-17 09:40 后（#161 正式运行单元测试失败：派发竞争）

实现和自查：Claude Code（同一会话，没有另一位审核）。改动清单见 `docs/CHANGES.md` 同日「修：两个进程同时派发同一轮」。

- **根因**：`site/xin/vm-dispatch.mjs` 旧模式下两个进程同时读到同一条待派发，各自 `startRunner`，后一个的新执行编号盖掉前一个的，两个执行进程都起不来，这一轮 15 秒后被当成中途断了。现在 `startRunner(job)` 先 `journal.claimLaunch(job)`（带条件的更新，和写编号同一个事务），没认领到就不起。**以后改派发别再无条件 `dispatched(run)`**：认领要带上读到时的 `state` 和 `attempts`。
- **还没查清的两次偶发失败**（修好派发以后出现，各一次，都是「下一轮没在时限里做完」）：
  - PR #162 的 CI（Actions 43999370576 第一次）：`test/xin-runtime.test.cjs`「系统 SIGTERM 保留后台断点并续接」，续接那一轮也被当成中途断了（状态 failed、2 轮、resumes 1），重跑一次通过。
  - 本地一次整套检查：`test/xin-steer-front.test.cjs`「做完了的事……兄弟明确说继续」等不到接着做完（21 秒）。当时机器另外在跑测试，负载很重，本地时限不放大，只有 15 秒。
  - 两条单独加压（6–8 个并行，加 4 个占满 CPU 的进程）各跑约 100 次，整套检查带着诊断副本跑两遍，都没再出现。对照代码，认领没认领到就不起、认领到的一定起，没找到会让一轮没人起的路径。「探测锁时把刚起的执行进程的锁抢走」做过实验：负载下 400 次都没发生。
  - 再出现就抓现场：在 `startRunner`（认领结果、起进程）、`runner()` 开头、`runDone` 判中途断了的地方按 `XIN_HOME` 往状态目录外写一行日志，看那一轮有没有人认领、执行进程有没有起来、是谁判的中途断了。
- **给 Codex**：上面记的 `test/xin.test.cjs` 第 1126 行那次失败（D 没停在「等你确认」），也可能是这个竞争：D 那一轮如果被两个进程同时派发，就没人做，15 秒后当成中途断了、自动续做，不会是 `waiting`。这次修好以后再看它还出不出现；还出现就照原来的思路查 `taskFinish` 和 #158 那一带。



<a id="task-bridge-enable-20261117"></a>
## Codex · 2026-11-17 接入 #161/#162：兼容基线已验证，启用版独立验收

- **真实进度**：已核对 main `c4211767620c8152a3cf91595a8c9ab1f353685e`、PR #161/#162 和当前计划。#161 加插话与 note，#162 修旧模式重复派发。正式 [44006809632](https://github.com/yux91803-hobo/liming-work-site/actions/runs/44006809632) 首次完整单元 1006 过、kernel 187/188、E2E 成功、部署跳过；第二次 check/e2e/deploy 全绿，真实模型/插话联调于北京时间 11:44 成功，回滚 skipped。重跑由 Claude 发起，Codex 没有操作其发布。期间只读核验实际 note 兼容模块 `vm-agent-56a06227b481.mjs`、外壳摘要、单 owner 和 bridge 默认 false 通过。
- **工作分支**：`codex/xin-kernel-bridge-enable-20261117`，独立工作树 `/workspace/liming-kernel-bridge-next162`。实际实现：Codex（默认值/测试/文档）；交叉复核：Codex 根代理、outcome_review、notice_flake。Claude #161/#162 作者与提交原样保留；没有 Claude Code 对本启用补丁的独立复核。原 `codex/xin-kernel-bridge-enable-20261116` 的未提交工作、旧分支/工作树和补丁保留。
- **已完成验证**：Node 22.23.4，默认开启完整 check **1008/1008**、内核回归 **188/188**、**13 组 E2E 全过**（学习台 372、主流程 19、工作流 42、终端 61）；显式 `XIN_TASK_BRIDGE=0` 的内核回归 **188/188**、已有协议报告专项 **14/14**。各阶段退出 0、无跳过，前后源码指纹一致。note 文件队列报告专项 14/14、组合专项 73/73 也通过。源码/测试提交 `f4a0196`，后续仅更新文档；日志 `/workspace/xin-review/bridge-activation-main162-{check,kernel,e2e,kernel-off,reports-off}.log`，对应状态 JSON 均成功、sourceChanged=false。CI/测试站和正式结果以本次启用 PR 当前 head 描述为准，本地通过不等于已经上线。
- **历史证据**：#160 / `0b185d4` 正式 [43917294330](https://github.com/yux91803-hobo/liming-work-site/actions/runs/43917294330) 全绿、真实联调成功、回滚 skipped；当时只读核验实际模块 `vm-agent-57705127bfa4.mjs`、单 owner、默认 bridge false。其启用工作树后来本地 check 991、kernel 176、13 组 E2E 全过且 sourceChanged=false。日志前缀 `/workspace/xin-review/bridge-activation-main160-`，不是新 #162 的验收。
- **回滚门槛已变化**：#161 在协议 1 增加 note，#160 仅识别 remember/ask，会把 note 当永久错误消费。因此最低回滚目标已更新为正式验证成功的 note 兼容版 #162 / `c421176`，不能沿用 #160。已有协议不得因关新分配降级；旧在途队列不擦除、不升级。
- **#162 失败的交叉审查**：失败在 `xin-steer.test.cjs:153`，期望 note 回执，实际读取到 prompt=acp。fake-agy 把非 usage 调用放同一日志、无 -p 时把 argv[0] 当 prompt，前台 `agy acp --help`/ACP 启动会污染后台脚本序号。noteStart 本身不调模型，但任务若先异常完成，普通失败 handoff 会启动前台并产生 acp；不能只过滤 acp 就认定产品正确，应先保存任务结果/错误、run 事件与 handoff 原因。独立 claimLaunch 审查未发现新漏洞，不解释首次失败根因，也不替代后续完整验收。
- **插话未知交付探针**：`/workspace/xin-review/probe-steer-take-lost-reply.cjs` 在临时目录用真实 CLI/tasks 锁/SQLite 得到 pending1 → take1（丢弃回包、不交模型）→ accepted1 → 再取0 → 正常收尾 done/inbox0，run 仍留 accepted1。未做真实套接字断线，没有模型/网络/VM调用；说明逻辑输入未交付时没有重投递路径，不是物理记录删除。见持久收尾计划新增输入交付边界。
- **下一步与发布门槛**：支持 note 的兼容 main 和本地默认开启/显式关闭路径均已过门槛；最新核对 main 仍为 `c421176`。本次独立 PR 的 CI/测试站通过后再核对 main/head、保留历史合并，正式真实联调成功、回滚 skipped 并只读核对实际新源码/协议后才算上线。最终 PR/Actions 链接和准确提交以本分支启用 PR 当前描述为准；未过不合并，不自行重跑 Claude 的发布。整个持久收尾、凭据代理、宿主授权 C、工具权限和 legacy 清理仍未完成。

## Claude Code · 北京时间 2026-11-17 12:00 后（终端不重放、在做的活跟着最新消息走）

实现和自查：Claude Code（同一会话，没有另一位审核）。设计 `docs/superpowers/specs/2026-11-17-xin-term-follow-design.md`，改动清单见 `docs/CHANGES.md` 同日条目。

- **框的位置**：任务框现在单独一条（`.xc-tbw[data-tsid]`，里面是原来的 `.xc-tb`），在做的带 `dock` 放在 `.xc-msgs` 最后。`put()` 和 `typing()` 都插在第一个 `.xc-tbw.dock` 前面（`liveAnchor`）；`paintBox` 按状态挪（不在做 → `settleBox` 落到这时候的最后，又在做 → `dockBox` 回到最底下）；`resultAfter` 找框、必要时先落下来——结果比任务状态先到时，框上记一个 `data-held`（那时任务摘要里的 `run`）：任务摘要还说在做这一轮，`paintBox` 就不把它拉回最底下，换了新的一轮或者轮询到不在做才清掉（不然每秒刷新会把框拉回最底下，变成「结果在上、框在最底下」）。历史里的 `task` 事件不再画框，`openSession` 读完记录以后：做完的按结束时间 `placeEnded`（框 + 结果），在做的统一 `taskBox` 到最底下。**别再把框塞回派活那条回答里**，也别让历史里的 `task` 事件画框（往前翻会多出一个）。
- **复制那一行**：`.xc-ai:has(+ .xc-ai.cont…) > .xc-acts{display:none}` 是「同一轮后面还有一条就只在最后一条下面露复制」，框那一条要排除在外（`:not(.xc-tbw)`），不然派活那段话的复制被藏掉。
- **终端**：`term.js` 的 `paint` 画完已有事件就 `drain()`；读记录时（`tab.loading`）不画结尾和光标。还在做的活：`termFollow` 打开（或换到）那一页时置 `f.catchup`，`tfFetch` 取回来的用 `TW.push(key, ev, true)` 一次画好，取到不满一页（400 条）才清掉，之后来的才逐字敲——打开前就做过的步骤是打开以后才取回来的，别当成新来的去敲。测试等光标（`.tm-cur`）就表示这一页齐了。
- **#162 正式运行第三次偶发失败**（Actions 44006809632 第一次，常驻进程模式那一步）：`test/xin-steer.test.cjs`「Gemini 后台主动说一句」第 158 行 `c[1].prompt` 是 `'acp'`。假 agy 把前台（完成交接那一轮）的 `agy acp --help` 也当成一步记进 `calls.jsonl`，说明那件任务在第一次调用以后就提前结束了、完成交接起了前台。本地常驻进程模式整组跑了 7 遍（其中 4 遍带两份诊断副本）都没再出现；只抓到过一次正常结束后的交接调了 `acp`（测试末尾，不影响断言）。没找到它提前结束的原因；重跑一次通过（Codex 在上一节的交叉审查也是这个判断：任务先异常结束、普通交接起了前台才调到 `acp`）。再出现就在假 agy 里把 `acp` 调用单独记下来（看父进程是哪一轮），并把那件任务每一轮的事件打出来。


## Claude Code · 北京时间 2026-11-17 16:20 后（发消息先「接收中」再「唤醒中」：回程等后台任务记账）

实现和自查：Claude Code（同一会话，没有另一位审核）。改动清单见 `docs/CHANGES.md` 同日条目。

- **现象**：#164 上线后站长发消息，大部分先「接收中」、再「唤醒中」，要等好几秒；偶尔和以前一样快。用量页显示常驻进程正常（这次运行了 34 分钟，操作一般 3 毫秒），「叫醒电脑」最近 6 次一般 9 秒。
- **怎么查的（以后同类问题照这个来，只读）**：
  - 会话里有 `INSTABOX_API_KEY` 时，先读 https://instabox.sh/llms.txt ，再用 `GET /v1/machines/{id}/files/content?path=/data/home/.xin/logs/kernel.jsonl` 下载常驻内核的请求记录。每条只有时间、路由、操作名、状态、耗时、走哪条路（`via: state` 就是套接字），没有消息内容；`id` 是消息编号，别打印。
  - `send` 那一条的 `at` 是电脑上处理完的时间。紧跟着的那条 `/xin/stream`，用 `at - ms` 算出网页开始拉回话的时间。两者之差就是回程耗时：正常在 1 秒内，6 秒以上网页就会显示「唤醒中」。
- **原因**：`src/xin.js` 的 `call()` 同步 `await recordTasks()`。后台没任务时，监督实例 `/state` 还要同步调 InstaBox `DELETE …/activity-leases/xin-tasks`，`ib()` 没有超时。这次请求慢了好几秒，回复就跟着慢。联调期间后台大多有任务、不撤租约，发的句子都快；15:45 联调停掉后台任务（`task_stop`）以后，紧接着的两句回程就是 38 秒、4 秒。InstaBox 不能列租约，没法证实它为什么慢。
- **用量页「叫醒电脑」不一定是真叫醒**：数字来自待送达的 `inbox:wakes`，送到用时超过 5 秒（`src/xin-inbox.js` 的 `WAKE_MS`）就记一次。上线后慢过 5 秒的正好 6 句（联调那句 38 秒，站长的 5.4、5.7、9.3、9.4、37 秒），和用量页的「最近 6 次，一般 9 秒，最长 38 秒」次数、中间值、最长都一致，电脑其实醒着。用量页一共就这 6 次，说明上线前那些回程超过 5 秒的句子不是待送达慢（多半是网页切到后台、晚了才拉流）。看到这个数突然变多，先按上面的办法查回程，别先怀疑电脑睡着了。
- **算回程时要剔掉的**：网页走轮询（`poll`）拿回话的那几句，后面紧跟的流不是它自己的，算出来的间隔不准（联调 15:39 那句就是）。
- **修法**：记账交给 `ctx.waitUntil`，失败只 `console.warn`。待送达的 `deliver` 传的 ctx 带 `waitUntil`（`this.state.waitUntil`），Worker 入口也带；没有 ctx 时照旧等。**别再把 InstaBox 调用放在回复路径上同步等**；需要的话放 `waitUntil`，或者加超时。
- **还留着的**：每发一句都挂一个 30 分钟的「这一轮在干活」租约（`lease('PUT', run)`）。只有轮询 `poll` 读到 done 时才撤；走流（stream）拿回话时不撤，只能等它过期。电脑因此会多醒一会儿，联调后可能一下子堆很多租约。要改的话，在流结束（done）时也撤一次。
