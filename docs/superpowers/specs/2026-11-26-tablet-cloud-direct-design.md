# 平板 AI 直接操控 li、li2（设计）

2026-11-26 · Claude Code 设计，站长批准方向。取代同日的[云端任务设计](2026-11-26-tablet-cloud-tasks-design.md)（#227 已上线的 `liming-cloud`、`liming-lease` 整体删除）。

## 站长要的

- 平板上的 AI 是唯一的「你」，li、li2 是它的两台普通云电脑，不再围绕小芯、天启设计。小芯、天启停用；每日清单（签到、积分、机外备份）不要了。
- 平板 AI 要能自己动手：看文件、改文件、跑命令，打开网页并操作；遇到复杂编程，可以自己决定交给云上的 Codex 等代理，并亲自检查结果。
- 不为兼容旧实现叠加，该删就删；不走小芯那样越来越大的自建架构。尽量用成熟的原生能力。
- 不重建机器，网关和各种 key 用现在的；不升级 DSH Go 的 Harness。

## 选的做法：命令行优先

平板 AI 用自己本来就有的终端，经 InstaBox 官方命令行操作两台云电脑，再用一份技能说明教它用法。

- 平板现在的 Harness（rc.1）已具备需要的能力，实测过：终端命令可以放后台（`run_in_background`），结束后 AI 会被通知叫醒；放在 `~/.dsh/skills` 的技能会进模型的技能目录。
- InstaBox 命令行（纯 Node 程序）：`exec`（最长 10 分钟，另有后台任务 `exec --background` 和 `jobs`）、`files`、`pull`、`push`、`get`、`ls`，以及 `agent prompt|events|steer|interrupt|ls`，可以驱动云上的 Codex。用到云电脑时会自动叫醒，最多等 45 秒。
- 浏览器：云上装 Playwright 官方的 `playwright-cli`。多次调用共用一个浏览器会话，加 `--headed` 就显示在桌面上，站长可以在 InstaBox 网页的 Computer 页签里看，需要时接手。Playwright 官方也推荐编码代理用「命令行 + 技能」，而不是 MCP。

没选的做法：
- **全部接成 MCP 工具**：InstaBox 的 MCP 没有后台任务和驱动 Codex 的功能；浏览器 MCP 很占上下文，还要常驻连接。
- **看截图点鼠标**：慢、费，也更容易出错。
- **整段对话切到云电脑**：AI 会离开平板，手机操控只在本机引擎可用。只留作调试。

## 各部分

**平板**（装机脚本）：
- 用 npm 装 InstaBox 命令行；已有就不动。
- 问两把 key（li2 所在账号一把、li 所在账号一把，权限只勾 `machines:read` 和 `machines:write`，不勾删除）。用 `instabox get <机器> --json` 核对（不会叫醒机器），存到 `~/.config/liming/instabox/<机器>.key`，目录 700、文件 600。
- 装 `ib` 包装脚本：用法和 `instabox` 一样，按参数里的机器名选 key；没写机器名就两个账号各跑一次。
- 装技能 `~/.dsh/skills/liming-cloud-computers/SKILL.md`。DSH Go「重置运行环境」默认会保留这个目录。
- 清掉旧东西：卸载 `liming-cloud` 插件，删 `/root/liming-cloud` 和 `~/.liming-cloud`（里面是旧的 SSH 令牌、只读 key 和台账）。
- 网关和 `liming-gateway` 照旧。网关安装包改用 `instabox pull` 从 li2 取（取不到再从 li 取）。装机脚本不再需要 SSH 令牌。

**云电脑**（装机脚本经 `instabox exec --stdin` 在每台跑一段脚本，可以重复运行）：
- 删掉旧的租约插件 `liming-lease`、`~/.liming-lease`、`~/.liming-cloud`（里面有写 key）。
- 给 Codex 接上本机网关：
  - 把现有的网关 key 复制一份到 `~/.config/liming/gateway.key`（600）。先找 `~/.xin/codex.key`，没有就用 `~/.xin/harness.key`。
  - `~/.profile` 导出 `LIMING_GATEWAY_KEY`。
  - Codex 的 `workbuddy` 线路加上 `env_key`。没有这条线路就补上。
  - 不改 `CODEX_HOME`：网站触发小芯也走登录 shell，改了会把小芯的 Codex 也带走。
- 装 `playwright-cli` 和它的 Chromium。
- 第一步的手动切主机配置（`dsh-tablet`、web 配置补丁）照旧写，方便调试。

**网站**：关掉正式站的定时任务（北京 8:55 叫醒，9:10、21:10 小芯每日清单和机外备份）。小芯聊天页、天启工具，以及云电脑上小芯的常驻服务，这次先不动：
- 这些服务不妨碍机器休眠（li 今天照常自动休眠过）。
- 正式发布时的小芯联调还靠它们。

等站长决定网站上的小芯、天启时再一起处理。

**删除**：
- `site/tablet/liming-cloud/`、`site/tablet/liming-lease/`。
- `scripts/tablet-harness-contract/`。
- 对应的测试。
- 装机脚本里的旧部分。

## 已核对（li，2026-11-26）

- `instabox exec` 能叫醒 li 并执行命令。
- Codex 0.169 原来缺网关 key，返回 401；补上 `env_key` 以后，`instabox agent prompt li --provider codex` 建好了文件，对话状态为空闲，可以接着做。
- `playwright-cli` 0.1.25 加 Chromium：能打开网页、在下一次调用时读到同一页面，`--headed` 的窗口出现在桌面上（DISPLAY=:1）。
- 小芯的清理器只清它自己那一轮起的进程和开太久的浏览器，不会误杀平板 AI 跑的 Codex。
- Claude Code 没配模型来源（要站长登录才能用）。云上 Harness 没给平板 AI 接线，这次不用。

## 留给以后

- 网站上的小芯、天启要不要下掉。小芯联调和常驻服务跟着一起处理。
- 云上的 Claude Code 登录、云上的 Harness 接线。
- DSH Go fork 和升级 Harness。Codex 的调研结论在 `codex/dsh-go-harness-upgrade-research-20261126` 分支。
