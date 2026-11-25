# 平板（DSH Go）

在自己的安卓平板上装原版 [DSH Go](https://github.com/ccch1mneyyy/dsh-go)（DeepSeek Harness 的安卓 App），再接上自己的网关和 li、li2 两台云电脑。这是第一步，不改 App 本身；第二步 fork 改界面，以后单独设计。设计见 [specs/2026-11-25-tablet-dshgo-design.md](superpowers/specs/2026-11-25-tablet-dshgo-design.md)。

## 用起来是什么样

- **打开就说话**：本机引擎一启动，网关就跟着起来，十几秒内能用。模型是网关里的 DeepSeek V4.1 Flash、GLM-5.4、Kimi K3.1 Pro，都能看图。不经过云电脑，所以不用等它们醒。
- **签到**：网关每次启动 10 秒后巡检一次，当天还没签的账号会签上。所以哪天打开过 App，那天就签了。
- **让它动平板**：「设置 › 手机操控」打开后，它能读屏、点按、输入。任务开始前确认一次，随时能停；密码、验证码、付款交还给你。
- **干重活切云电脑**：在对话列表底部点主机名，选 li2 或 li。第一次切过去约 40 秒叫醒，之后用那台电脑自己的网关。li 上有 STM32 编译环境。

## 第一次装

只有这几步要自己动手：

1. **装 App**：从 [GitHub Releases](https://github.com/ccch1mneyyy/dsh-go/releases/latest) 或 go.dshtui.com 下载 arm64 的 APK 安装。首次启动选「本机」，等运行环境装好。然后到「设置 › 隐私与分享」关掉「发送匿名使用统计」。
2. **建 SSH 令牌**：在 InstaBox 后台分别打开 li2、li，进 Connect → SSH tokens → Create token，选不过期，复制那一行 `ssh ibssh_…@…`。平板丢了，就在同一个地方把令牌吊销。
3. **跑装机脚本**：在 App 里打开一个对话 → 全部功能 → 终端，粘贴

   ```
   curl -fsSL https://liming-work.com/tablet/setup.sh | bash
   ```

   按提示先粘贴 li2 的令牌，再粘贴 li 的；不接 li 就直接回车。令牌只在这一次用，不会存下来。脚本最后会打印 li2、li 的启动命令和工作目录。
4. **加网关账号**：「设置 › 本机引擎」点重启。然后用平板浏览器打开 `http://127.0.0.1:8788`，用 `admin` 登录。
   - **先改密码**：平板上别的 App 也能访问这个地址。
   - 再加网关账号。平板用自己单独的账号，别和 li2 共用一个，两个 IP 同时用容易被风控。
   - 最后在「设置 → API Key」新建一个 key。网关刚装好时不检查 key，建了以后才要求带 key。
5. **加渠道**：「设置 › 模型 › 添加渠道」，按下面两张表填。
6. **加主机**：「切换主机 › 管理远程主机 › 添加 SSH 主机」，按下面的表填。填完关掉「连接上次使用的主机」。
7. **打开手机操控**：「设置 › 手机操控」打开开关，按页面提示开无障碍和通知。侧载的 App 开不了无障碍时，点「无障碍开关点不动？」，按手机品牌的说明「允许受限制的设置」。

### 渠道

| 项 | 填 |
|---|---|
| 兼容协议 | Responses |
| Base URL | `http://127.0.0.1:8788/v1` |
| API Key | 第 4 步在面板里建的 key |
| 模型 | 点「获取模型」，勾 `deepseek-v4.1-flash`、`glm-5.4`、`kimi-k3.1-pro` |

| 模型 | 上下文 | 输入类型 | 思考档位 |
|---|---|---|---|
| DeepSeek V4.1 Flash | 1M | 文本和图片 | 不思考、低、高、最高 |
| GLM-5.4 | 1M | 文本和图片 | 低、高、最高 |
| Kimi K3.1 Pro | 1M | 文本和图片 | 低、高、最高 |

### 远程主机（li2、li 各加一台）

| 项 | 填 |
|---|---|
| 主机 | 令牌行里 `@` 右边那段 |
| 用户名 | 令牌行里 `@` 左边那段（`ibssh_…`） |
| 端口 | 22 |
| 登录 | 选密码，随便填一个（令牌本身就是用户名）。连不上就把报错截图发给 AI |
| 实例管理 | 托管启动 |
| 启动命令 | `/data/home/.local/bin/dsh-tablet`，后面**不要**加 `web` |
| 工作目录 | `/data/workspace/tablet` |

## 别做的事

- **别点「设置 › 本机引擎 › 重置运行环境」**：它会删掉 `/root`，网关和账号一起没了。真要重置，之后重跑装机脚本、重新加账号。
- **连上 li2 时别接着天启的对话**：天启的对话回网站继续。平板上只在 `/data/workspace/tablet` 里开新对话，免得两边同时写同一个对话。
- **用完切回「本机」**：一直连着 li2，它就不睡；到了免费版连续运行的上限（120 到 480 分钟）会被冷却，那段时间天启也用不了。

## 出问题看哪里

- 网关日志在 `/root/workbuddy-gateway/logs/gateway.log`，插件日志在同目录的 `plugin.log`。
- 插件 10 分钟内重启 3 次还起不来，就先停下，等下次重启引擎再试。日志写「8788 被其他程序占用」，说明端口被别的程序占了。
- 重跑装机脚本不会重新下载网关，也不碰账号。插件在 App 里被删了、想重新挂上，先删掉 `/root/liming-gateway/.added` 再跑。
- 只想看看脚本要做什么：`curl -fsSL https://liming-work.com/tablet/setup.sh | bash -s -- --dry-run`。

## 仓库里的文件

| 文件 | 是什么 |
|---|---|
| `site/tablet/setup.sh` | 装机脚本 |
| `site/tablet/liming-gateway/` | DSH 插件：网关跟着本机引擎启停 |
| `site/tablet/dsh-tablet.sh` | 放到 li、li2 上的包装脚本：读本机网关 key，固定用 Harness 内置的 `web` 配置 |
| `site/tablet/dsh-tablet-profile.yml` | li、li2 上 `web` 配置的网关线路，由 `scripts/tablet-profile.mjs` 从天启的模型表生成 |

网关程序（WorkBuddy2API-Hub）和任何账号、key 都不进仓库，因为仓库是公开的。装机脚本只写死原版安装包的大小和 SHA-256。
