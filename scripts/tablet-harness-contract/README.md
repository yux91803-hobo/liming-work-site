# 平板调用云电脑：真实 Harness 契约验证脚本

将 [设计文档](../../docs/superpowers/specs/2026-11-26-tablet-cloud-tasks-design.md) 第 11 节（E1–E7）与第 7 节补充的两项通知契约（C1、C2）整理为可重复执行的自动化验证套件。

- **为什么不进默认 PR CI**：安装两个版本的真实 DeepSeek Harness 需要下载约 0.6–1.3 GB 依赖，会明显拖慢每次 PR 的检查；因此放在 `scripts/tablet-harness-contract/`（同时命中 `scripts/xin-live-scope.cjs` 的 `scripts/tablet-` 跳过名单，不触发小芯真模型联调），在本地或每次升级 DSH Go / 云端 Harness / 发布前单独运行，并将结果写入 PR。
- **零外部依赖**：脚本与探针插件仅依赖 Node 22/24 内置模块（`http`、`fetch`、`WebSocket`、`child_process`、`fs`、`crypto`）。

## 文件清单

| 文件 | 作用 |
|---|---|
| `install-harness.sh` | 在仓库外缓存目录（默认 `~/.cache/liming-dsh-contract`）安装云端 `0.2.2-rc.3` 与照 DSH Go `runtime/locks/dsh-0.2.2-rc.1` 锁定的平板 `0.2.2-rc.1` |
| `mock-responses-server.mjs` | 按 OpenAI Responses SSE 流式协议回复的本地模拟模型服务 |
| `dsh-client.mjs` | 零依赖 `dsh web` 客户端（`/?token=` 登录换 Cookie、`POST /api/<端点>`、`/api/remote.mux` WebSocket 流） |
| `dsh-runner.mjs` | 在临时隔离 `HOME`/`DSH_HOME` 启停、强杀、重启真实 `dsh web` |
| `probe-plugin/` | 探针插件：登记可控后台任务、标准 JSON Schema 工具输出、记录 `cancel(reason)` 与 `agent/status`、验证 `session/event` 确认与 `agent/created` 补投去重 |
| `cases.mjs` | E1–E6、E7a–E7f、C1、C2 全部契约用例定义 |
| `run.mjs` | 命令行入口，逐项输出 `PASS` / `FAIL`、关键证据与总汇总 |

## 覆盖的契约项

| 编号 | 目标版本 | 验证内容 |
|---|---|---|
| `E1` | `rc3` | 同 `sessionId` 同目录建两次（空白会话幂等返回原编号）、换目录报 `session/conflict`；并核实非空会话再调 `session/create` 会新分配编号（发件箱恢复护栏依据） |
| `E2` | `rc3` | 同一 `requestId` 连发两次、空闲重发、云端 `SIGKILL` 重启后重发：仅 1 条用户消息、1 轮、1 次模型请求 |
| `E3` | `rc3` | 前台 `bash` 运行中发 `mode: 'steer'` 插话，进入同一轮下一步，不另起新轮 |
| `E4` | `rc3` | 前台 `bash` 运行中调 `session/cancel`：进程被杀、本轮以 `aborted/user` 结束；空闲重复停仍回 `accepted: true` |
| `E5` | `rc3` | 后台 `bash`（`run_in_background: true`）运行中调 `session/cancel`：后台命令仍在跑；`job/list` 可见；`job/kill` 才停（`requested`），再停回 `already-finished` |
| `E6` | `rc3` | 强杀云端 Harness（以 `DSH_PERMISSION_MODE=danger-full-access` 模拟无 `bwrap --die-with-parent` 的云端环境）：前台与后台命令成孤儿继续跑（可按项目目录 `cwd` 定位清理）；重启后对话存在、`running: false`、磁盘原始日志无 `turn/end` 且 `session/page` 冷读合成 `turn/end(reason.kind="interrupted")`、`job/list` 清空、原 `requestId` 重发仍幂等 |
| `E7a` | `rc3`、`rc1` | 后台任务在代理空闲时结束：恰好唤醒 1 次、通知含 `jobId`、无多余唤醒，并核对 `agent/status` 切换 |
| `E7b` | `rc3`、`rc1` | 模型调 `job_kill` 时 `cancel(reason)` 原样收到模型填写的原因 |
| `E7c` | `rc3`、`rc1` | 调 `POST /api/job/kill` 时收到 `'cancelled by the user'` |
| `E7d` | `rc3`、`rc1` | 调 `POST /api/workspace/archiveSession`（`stopActivity: true`）时收到 `'session archived'` |
| `E7e` | `rc3`、`rc1` | 引擎正常 `SIGTERM` 退出时收到 `'owner disposed'`，并扫描已安装 `dsh-jobs-local` 源码核对全部释放类原因清单 |
| `E7f` | `rc3`、`rc1` | 完成通知写进日志后重启：日志保留 `{ kind: 'tool-jobs', form: 'notice' }` 且含 `jobId`，代理加载后按日志去重不补发 |
| `C1` | `rc3`、`rc1` | 设计 §7 补验 1：插件进程内确认 `session/event` 通知写进日志后才把台账记为「已告诉」 |
| `C2` | `rc3`、`rc1` | 设计 §7 补验 2：引擎重启后代理出现（`agent/created`）时补投通知 `{ kind: 'liming-cloud', form: 'notice', taskId }`，写进日志后记「已告诉」，二次重启按日志去重，日志内严格只有 1 条 |

## 本地运行方式

1. 安装两个版本的真实 Harness（只需装一次，产物保存在 `~/.cache/liming-dsh-contract`，可用 `CONTRACT_CACHE_DIR` 指定其他位置）：

   ```bash
   bash scripts/tablet-harness-contract/install-harness.sh
   ```

2. 运行全套契约检查（默认同时跑 `rc3` 全量 + `rc1` 关键项）：

   ```bash
   node scripts/tablet-harness-contract/run.mjs
   ```

3. 可选参数：

   ```bash
   # 只跑云端版本（0.2.2-rc.3）或平板版本（0.2.2-rc.1）
   node scripts/tablet-harness-contract/run.mjs --target rc3
   node scripts/tablet-harness-contract/run.mjs --target rc1

   # 在平板版本上也跑 E1–E6 全套
   node scripts/tablet-harness-contract/run.mjs --target rc1 --full-rc1

   # 只跑指定用例
   node scripts/tablet-harness-contract/run.mjs --only E1,E6,C1,C2

   # 指定自定义 dsh 二进制路径
   DSH_RC3_BIN=/path/to/rc3/dsh DSH_RC1_BIN=/path/to/rc1/dsh node scripts/tablet-harness-contract/run.mjs
   ```
