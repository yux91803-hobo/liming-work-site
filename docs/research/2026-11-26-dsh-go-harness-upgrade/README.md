# DSH Go 的 DeepSeek Harness 升级研究

2026-11-26 · Codex 调研、隔离验证与归档，未另行安排独立复核

**建议把 `0.2.2-rc.5` 作为 Fork 的第一个引擎升级目标。** 原生 bridge、平板上的两个 Liming 插件以及对现有 rc.3 云端协议的调用已经在 Linux 隔离环境跑通。首个 Android 构建的主要工作是移植或淘汰版本专用补丁，并验证发布安装和数据迁移。`0.2.3-alpha.2` 先留在实验线，它已实测与 DSH Go 1.4.0 bridge 的鉴权接口冲突。

本次对照 DSH Go `v1.4.0`（`5bb72e2`）及其当时的 `main`（`e5be6ee`），两者在所查的 Android 引擎版本上相同。Liming 插件以 `main` 的 `3772190`（#227）为基线。npm 的 `latest`、`next` 都指向 `0.2.2-rc.5`，`alpha` 指向 `0.2.3-alpha.2`。测试只用临时目录与回环服务。未使用现有平板、li、li2 或真实账号，未改动应用代码和发布配置。[DSH Go v1.4.0](https://github.com/ccch1mneyyy/dsh-go/releases/tag/v1.4.0) · [Harness npm](https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions) · [Liming 平板插件](https://github.com/yux91803-hobo/liming-work-site/tree/3772190971df5789e39afe6bc6a053d3e9f92948/site/tablet)

## DSH Go 如何安装和更新引擎

- Android 构建默认锁定 Harness `0.2.2-rc.1`、Node `24.22.1`、pnpm `11.28.5`、Ubuntu Base `24.04.5`。构建脚本用 npm 锁文件按 ABI 安装，再选 Android 专用补丁，检查 `pins.json` 中每个文件变更前后的散列。APK 携带归档和 manifest，manifest 记录版本、ABI、归档摘要和 bridge 版本。启动脚本直接调用 `/opt/node` 和 `/opt/dsh`。`dsh plugin` 装的是 profile 依赖。[构建脚本](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/runtime/build-runtime.sh) · [版本锁](https://github.com/ccch1mneyyy/dsh-go/tree/v1.4.0/runtime/locks) · [补丁锁](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/runtime/patches/pins.json)
- 客户端的普通聊天走 Harness 的 `/api`，DSH Go 原生插件用随包加载的 `dsh-go-bridge` 0.4.0，通过 `/dsh-go/v1` 提供清单、面板、交互和流，并向后端插件提供 `dshGo`。Android 手机操控另有 `PhoneGuest.kt` 中的 MCP overlay 和本机 relay，原生侧持有审批和停止状态。引擎上的调用归属和轮结束补丁负责把工具调用、会话和运行轮次绑在一起。[bridge 源码](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/runtime/bridge/dsh-go-bridge/lib/index.js) · [原生插件协议](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/docs/design/native-plugins-protocol.md) · [手机操控停止设计](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/docs/design/phone-screen-stop.md)
- 更新仍通过 APK 发布。安装器校验随包归档并检查基础系统兼容性，然后用 `EngineUpgrade` 的事务替换 15 个 App 管理路径。`/root`、包数据库和用户工具目录留在原环境。中断可按日志继续升级，提交完成后会清理旧引擎；`LastKnownGood` 可恢复上次能启动的插件配置。上游的 `RUNTIME_LAYERS=1` 已能把基础层和引擎层拆开，仍随 APK 交付，默认构建使用单包。[引擎事务](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/EngineUpgrade.kt) · [运行时分层](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/docs/design/runtime-layers.md) · [官方升级说明](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/docs/guide/zh/03-engine-hosts.md)

## 版本差异与隔离测试

`rc.5` 接受原来锁定的 Node。上游对会话控制器的改动包含从日志推导请求回执和续写资格，常用的 `session/prompt`、`session/page`、`session/cancel`、`job/list` 和 `job/kill` 仍能按目前协议使用。rc.5 相比 rc.4 的发布说明主要是 DeepSeek 服务端搜索；其原生计费和授权说明不能直接套用到 WorkBuddy 网关。rc.1 到 rc.5 还跨过工作区、工具结果和 PTC 默认模式等兼容变化，移植时应沿用上游逐版升级指南。[rc.1 到 rc.5 源码差异](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.2-rc.1...dsh-v0.2.2-rc.5) · [rc.5 发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5) · [升级指南](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5/docs/upgrade-guide)

`alpha.2` 的 Node 支持范围是 `^24.22.3 || >=26.13.1`，本次用 `24.22.3` 验证。它继承 alpha.1 的远程配对认证、MCP OAuth、会话未读和实验性 SQLite 存储。默认会话存储仍为 JSONL。Cordis 的 Loader、Include、YAML 和校验规则也有变化，实际安装的 `@deepseek-ai/cordis` 从 `4.1.0` 变为 `4.2.0-alpha.1`。源码确认旧 bridge 依赖的 `connection.requestRejection()` 已被替换为新版 WebServer 鉴权和 Connection 的 `admit` 接口。旧 bridge 会把兼容用的鉴权包装应用到现有路由，故本次登录后，`/dsh-go/v1/contributions` 和普通 `/api/session/list` 均返回空 HTTP 400。后续适配应使用新版的已认证路由，同时保留本机和来源校验。[alpha.1 发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.3-alpha.1) · [alpha.2 发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.3-alpha.2) · [新版鉴权源码](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.3-alpha.2/packages/client/connection/src) · [失败日志](evidence/tablet-alpha2-details.txt)

| 检查 | rc.5 | alpha.2 |
| --- | --- | --- |
| Harness 云任务协议 | 14/14，通过请求幂等、插话、停止、强杀恢复和回执去重 | 14/14，使用原版 Harness |
| Android 补丁静态检查 | 229 项中 168 项可按原序应用、55 项上下文不匹配、6 项目标不存在 | 142 项可按原序应用、78 项不匹配、8 项目标不存在、1 项已是精确补丁后内容 |
| DSH Go bridge 和 `liming-cloud` 原生面板 | 已测登录、插件贡献、面板与 WebSocket 数据订阅 | 旧 bridge 随引擎加载后，原生与普通 RPC 返回 400 |
| `liming-cloud` 后端 | 真实插件通过 `cloud_run` 派给本地模拟的 rc.3 云端，执行一次，回执写入一次，重启未重发 | 单独运行原版 alpha.2、未加载旧 bridge 的对照通过同样的派发与回执流程 |
| `liming-gateway` | 真实监督插件能启动、重启及停止模拟 WorkBuddy，账号／设置／用量文件逐字节保留 | 监督插件可运行，同样保留模拟数据 |
| `liming-lease` | 挂到本地候选云端后，模拟任务获租约，后台运行续租，停止后释放一次 | 同样通过；升级平板时可保留实际云端现有版本 |
| Android `PhoneGuest` MCP relay | native / PTC × 模拟批准 / 拒绝共 4/4；旧版基线也通过 | 4/4；原生审批 UI、会话归属与运行结束仍待移植、验收 |
| 旧会话与配置 | 综合 9/9。同一 ID 续聊，旧上下文进入模拟模型请求，旧图像附件返回相同字节，恢复冷备可重新启动 rc.1 | 原版引擎对照 8/8，旧会话、图片附件和快照恢复通过。带旧 bridge 的应用组合仍不可用 |

补丁检查用 v1.4.0 工具逐个匹配 Android 原始顺序，rc.1 基线的 229 项均匹配且散列一致。61 个 rc.5 阻塞包含同一改动导致的后续连带不匹配。正式构建器实测在缺少 rc.5 pin 时拒绝继续。rc.5 的 `route-guard` 和 profile 版本检查还能匹配。direct 启动、会话删除、手机调用归属、结束与重试补丁需要逐项核对。也应复核插件更新与崩溃恢复、Companion 和自定义 provider。隔离 MCP 测试沿用上游夹具的显式 `per-call` 模式，验证工具调用以及拒绝回传。保留补丁后仍需验收原生审批和真实停止。[补丁检查](evidence/android-patches-summary.txt) · [构建拒绝](evidence/android-rc5-guard.txt) · [DSH Go 打包夹具 23/23](evidence/upstream-packaging.txt)

## 如何保全历史、账号和配置

| 数据 | 同包同签名的引擎升级 | 原版迁入新 Fork |
| --- | --- | --- |
| Harness 会话和附件、工作区、模型配置、插件 | 升级事务保留 `/root/.dsh` 和用户目录。保留会话 ID、附件存储、profile 包清单、补丁和必要的本地插件路径 | 新 APK 私有目录独立。先在隔离副本验证完整冷备恢复，再核对会话 ID、附件、工作区和模型配置；以实际路径为准 |
| WorkBuddy 账号、签到设置和用量 | 保留 `/root/workbuddy-gateway`，尤其 `accounts` 和 `usage`，不要重新初始化 | 使用受保护的离线迁移路径，或在新实例重新授权。真实登录与刷新需要独立设备验收 |
| 云端任务关联及凭据 | 保留平板 `~/.liming-cloud` 的 `tasks.json`、`settings.json` 和权限 0600 的 `secrets.json`。会话 ID 对应台账关联 | 迁移前等派发与停止确认结清。若导入分配新会话 ID，先核对关联再恢复派活。租约写 key 继续只在云端 |
| App 设置、配对与 Android 权限 | 同包名、同签名更新通常保留应用数据，仍须真机验收 | App 私有数据、配对和系统授权要单独处理。无障碍、Shizuku、屏幕录制等用新包名重新授权 |

上游 APK 的包名是 `io.github.ccch1mneyyy.dsh_app`，支持 `.test` 并装构建，Android manifest 关闭系统自动备份。普通 Fork 使用自己的签名，不能覆盖原版并接管私有数据。官方配置分享会清理密钥，普通会话分享生成阅读／回放资料。另有加密的远程会话备份依赖 `RemoteTunnelCarrier` 与 Host 的 transfer 能力，覆盖会话快照，仍需验证本机两 App 之间的可用性与会话 ID。官方也明确说明没有一键完整 Linux 环境备份与恢复。首次迁移应保留原版，等新应用用假数据验证后再安排受控数据迁移。[Android 包配置](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/app/android/app/build.gradle.kts) · [Android manifest](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/app/android/app/src/main/AndroidManifest.xml) · [配置清理](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/app/lib/share_code/settings_sanitizer.dart) · [会话备份入口](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/app/lib/state/session_backup_state.dart) · [Liming 安装文档](https://github.com/yux91803-hobo/liming-work-site/blob/3772190971df5789e39afe6bc6a053d3e9f92948/docs/tablet.md)

## Fork 实施顺序

1. 保留 rc.1 为对照，在 Fork 更新 `DSH_VERSION` 与 npm 锁。把不匹配的补丁逐项对应到现有行为保证，已被上游覆盖的用相同回归测试验收后删去，仍需要的重录 Android 前后散列。优先处理 Android 启动、权限和手机操控、旧数据三条链路。Node 24.22.1 可用于 rc.5 对照；正式候选把含上游修复的 24.22.3 单独验证，避免把引擎和 Node 的变化混为一次故障。
2. 复用现有 Runtime CI、`runtime/test-host.sh`、上游 profile 和会话迁移夹具、`EngineUpgradeTest` 与原生插件测试。让引擎版本、Node、桥版本、ABI、补丁与 `baseId` 随每个签名 APK 一起留档。发布沿用 APK 校验和安装流程。先交付单包，分层优化有独立的安装和中断恢复验证之后再启用。[Runtime CI](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/.github/workflows/runtime.yml) · [上游迁移夹具](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/runtime/tests/runtime-upgrade-sessions-schedule-live.mjs) · [安装事务测试](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/app/android/app/src/test/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/EngineUpgradeTest.kt)
3. 首个签名测试包与原版并装。用安卓测试设备分别验收首装、升级中断和重启、真实手机审批与停止、会话和附件、云端派发与停止确认、网关登录与刷新。从此 Fork 自己维持同一包名和发布签名，后续沿用原地引擎事务。保留可重建的上一版引擎以及停止运行后的可恢复快照。回退时核对版本号和签名，确需回发上一引擎时沿用同签名的高版本号恢复包，必要时恢复升级前数据快照，提前备份测试期间产生的新数据。
4. 把 alpha 继续放在独立测试线。先适配新版鉴权和官方运行时版本，再评估会话和插件接口。保持 JSONL 默认和现有网关、云端版本，逐个验证实验功能的实际收益。

本报告的通过项来自 x86_64 Linux 的真实 npm 引擎和模拟外部接口。Android APK 构建、系统签名更新、Android 原生审批、完整真实用户数据转移、真实 WorkBuddy 登录与两台 InstaBox 的联调均未执行。

## 验证记录

- [rc.5 综合升级](evidence/tablet-rc5-final.txt) · [rc.5 原生 bridge 与快照回滚](evidence/tablet-rc5-pinned-runtime.txt) · [alpha.2 带旧 bridge 诊断](evidence/tablet-alpha2-details.txt) · [alpha.2 原版引擎对照](evidence/tablet-alpha2-stock.txt)
- [rc.5 14 项云端契约](evidence/rc5-contract.txt) · [alpha.2 14 项云端契约](evidence/alpha2-contract.txt) · [租约 rc.5](evidence/lease-rc5.txt) · [租约 alpha.2](evidence/lease-alpha2.txt)。原云端契约和租约夹具使用 `rc3` 参数名，实际运行的 npm 引擎是对应列版本。
- [手机 relay rc.1](evidence/phone-rc1.txt) · [手机 relay rc.5](evidence/phone-rc5.txt) · [手机 relay alpha.2](evidence/phone-alpha2.txt)

- [rc.5 的逐项补丁匹配结果](evidence/android-patch-match-rc5.json) · [alpha.2 的逐项补丁匹配结果](evidence/android-patch-match-alpha2.json)

云任务协议测试复用了仓库的 Harness 契约夹具，通过它的测试二进制覆盖参数运行候选 npm 包。手机 relay 对照复用了 DSH Go 的上游夹具，综合升级测试使用真实插件配合模拟模型和外部服务。随附输出保留通过和失败记录，临时工作区路径已替换。[云任务协议夹具](../../../scripts/tablet-harness-contract/run.mjs) · [上游手机 relay 夹具](https://github.com/ccch1mneyyy/dsh-go/blob/v1.4.0/runtime/tests/phone-dsh022-live.mjs)
