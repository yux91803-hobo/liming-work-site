# 平板版 DSH Go 第一步：原版 App + 网关插件 + 接上 li、li2：设计

站长于北京时间 11-25 在会话里批准方案（选「A 先插件后 fork」）。本设计由 Claude Code 写，实现也由 Claude Code 完成。第二步（fork 改界面）以后单独设计。

## 1. 为什么、要什么

站长 11-25 的原话：「我在 GitHub 上看到了 DSH Go 这个开源项目……刚好也想操控我的安卓平板，感觉我的小芯没有什么意思了……想把我的两台 instabox 还有网关也能结合进来，这样就可以用我网关的模型了，界面 UI 也改一改，他的功能感觉太多了，用的不顺手」。只给自己的平板用，不发布，iOS 以后再说。

追问后定下：

- 小芯「没意思」的四条原因都占一点：碰不到自己的设备、太慢老在等、太复杂老出问题、角色看腻了。所以新东西要能动平板、要快、零件要少、要新鲜，不把小芯那套后台搬进来。
- **网关搬到平板上**。站长原话：「网关可不可以弄到我平板上？我打开软件的时候网关自动打开，不就是可以随便用了吗？」
- 走法 A：第一步装**原版** DSH Go，加插件，接上 li、li2；用一阵后，第二步再 fork 改界面。
- 界面上嫌的是入口太多、用不上的功能占地方。具体砍哪些到第二步再定，样子不改。

## 2. 目标、不做、不能出现的

目标（第一步）：
1. 平板上打开 DSH Go，网关跟着本机引擎自动起来；关掉引擎，网关也跟着停。
2. 平板上的 AI 用网关里的模型回话，并能操控平板（DSH Go 自带的手机操控）。
3. 在 App 里能切到 li2、li 上干重活，用的是那台电脑自己的网关。
4. 站长只需要在第一次装时动手，步骤尽量少，写清楚。

不做：fork 和界面改动、小芯宠物和人设、iOS、网站页面改动、Worker 上的网关转发。

不能出现的：
- 网关程序或任何账号、key 进仓库。liming-work-site 是**公开仓库**。
- 改动天启的 `headless` 配置、`~/.xin` 或小芯的任何东西。
- 平板日常聊天要等云电脑醒。
- 把小芯的前台、派活、路由、记忆那一套搬进来。

## 3. 现状核对（11-25 只读）

DSH Go（`ccch1mneyyy/dsh-go`，HEAD `f2d589c`）：
- 平板本机跑的是 DeepSeek Harness：App 内的 PRoot Ubuntu 24.04 + Node，`dsh web` 监听 127.0.0.1:3080，约 1 GB，家目录 `/root`。运行时锁定 `dsh` 0.2.1-rc.4 / 0.2.2-rc.1（`runtime/locks/`）；li、li2 上是 0.2.2-rc.3。
- 手机操控只在本机引擎可用（无障碍；不打扰模式要 Android 14 + Shizuku/ADB）。`docs/guide/zh/04-phone-control.md`
- 自定义渠道支持 OpenAI / Anthropic / Responses 协议，填 Base URL + API Key，每个模型可设上下文、识图、思考档位。`docs/guide/zh/02-models.md`
- 插件是一个 npm 包目录，本机用 `dsh plugin --profile web add /绝对路径` 安装；入口 `apply(ctx)`，用 `ctx.effect(() => () => 清理)` 收尾。`docs/plugins/hosts.md`、`from-zero.md`、`examples/plugins/dsh-go-example-usage`
- SSH 主机的「托管启动」在远端执行 `<启动命令> --host 127.0.0.1 --port 0 --no-open`，等日志里出现带 `token=` 的地址。启动命令原样拼进脚本，所以包装脚本要把参数传下去，路径不能有空格。`app/lib/remote/ssh/remote_bootstrap.dart` `startScript`

网关（li 上只读查看，li2 是从 li 拷的同一份）：
- WorkBuddy2API-Hub v2.0.8，`/data/workbuddy-gateway/current -> v2.0.8/wb-proxy`。systemd 服务以用户 `box` 运行 `/usr/bin/python3 current/wb_proxy.py --host 127.0.0.1 --port 8788 --accounts-dir /data/workbuddy-gateway/accounts --usage-dir /data/workbuddy-gateway/usage`，环境变量 `TZ=Asia/Shanghai`、`PYTHONUNBUFFERED=1`、`WB_PROXY_DEFAULT_REALM=cn`。
- 要求 Python 3.9+，**只用标准库**（`yaml` 只在可选的 `wb_subbridge.py` 里用）；不需要 pip。自带 TLS 组件 `bin/wb-tls-bridge-linux-arm64`，是静态链接的 aarch64 程序，按 `platform.machine()` 选（`aarch64 → arm64`）。
- 原版发布包在 `/data/workbuddy-gateway/releases/workbuddy2api-hub-v2.0.8.zip`：22,962,873 字节，SHA-256 `b322c73b9a18f09c6560bff0e4b748e9acdc26272c339b4f5fce2413bb500cc6`（与同目录 `SHA256SUMS.v2.0.8` 一致）。顶层是 `wb-proxy/`，605 项，不含账号数据。
- 签到：调度器的签到钟点来自 `accounts/settings.json` 的 `schedule.checkin`，默认 `[9, 21]`。网关启动 10 秒后跑一次巡检，但只在当前钟点属于签到钟点时才签；国内号当天签过的会跳过（`can_checkin()`）。可设的键有 `checkin`、`travel`、`keepalive`、`cat`，缺了或写错会各自回到默认值。
- `GET /health` 不用认证，返回 JSON：`ok`、账号数这类计数，不含 key。
- 面板在 `http://127.0.0.1:8788/`，**默认密码 `admin`**；客户端 key 在面板「设置 → API Key」里新建。

InstaBox（`instabox.sh/llms.txt`、`docs/ssh.md`、`docs/idle-suspend.md`）：
- SSH 令牌是一行 `ssh ibssh_…@<host>`，任何终端粘贴即可登录，不要 key；默认 7 天，可设为永久，可一次吊销整台机器的令牌。
- SSH 连接、exec、访问公开地址都会把暂停的机器叫醒。免费版闲 30 分钟自动暂停；一次连续运行 120 分钟，用得多会放宽到 480 分钟，到点后冷却。
- li、li2 的用户是 `box`，家目录 `/data/home`。`~/.local/bin/dsh` 是包装脚本：第一个参数不是 `--profile` 时自动加 `--profile headless`。li 的这个脚本里多了 purge 的几行。各配置的插件装在各自的 `~/.dsh/profiles/<名字>/node_modules`，配置补丁是同目录的 `cordis.patch.yml`（2026-11-06 起 `headless` 就是这么配的）。

## 4. 设计

### 4.1 平板上的网关

```
/root/workbuddy-gateway/
  v2.0.8/wb-proxy/        原版发布包解出来的程序
  current -> v2.0.8/wb-proxy
  accounts/   (700)       settings.json、账号；只在平板上
  usage/      (700)
  logs/       (700)       gateway.log、plugin.log
```

- 程序来源：装机脚本经 SSH 从 li2 取原版 zip（li2 没有就从 li 取），按**写死在脚本里**的大小和 SHA-256 校验，再用 `python3 -m zipfile -e` 解压。zip 不保留可执行位，解完给 `bin/wb-tls-bridge-linux-arm64` 和 `*.sh` 加上 `+x`。
- 启动方式照 li 的 systemd 服务：`python3 current/wb_proxy.py --host 127.0.0.1 --port 8788 --accounts-dir <dir>/accounts --usage-dir <dir>/usage`，工作目录 `current`，环境变量相同，umask 077。
- 签到：插件第一次拉起网关前，如果 `accounts/settings.json` 里还没有 `schedule.checkin`，就写入 `0…23` 全部钟点（原子写，保留其他键）。这样平板上任何时候打开 App，10 秒后的巡检都会签到，当天签过的账号跳过。以后站长在面板里改了签到钟点，插件不再覆盖。`travel`、`keepalive` 保持默认。
- 账号：平板单独加一个，站长自己在平板浏览器里打开面板加，我们不碰账号。不和 li2 同时共用一个账号，因为两个 IP 同时用容易被风控。
- 面板密码：安卓上所有 App 都能访问 `127.0.0.1`，所以第一次登录后马上把默认的 `admin` 改掉。

### 4.2 自启插件 `liming-gateway`

文件放在 `site/tablet/liming-gateway/`，从 liming-work.com 下载（GitHub 在国内不稳）。包的写法照 `from-zero.md`：

- `package.json`：`type: module`，`main: ./lib/index.js`，`engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`，`dsh.bundle.patch: ./cordis.patch.yml`，不依赖任何包。
- `cordis.patch.yml`：`- insert: - id: liming-gateway  name: liming-gateway`。
- `lib/index.js`：只用 Node 自带模块。

行为（`apply(ctx, config)`）：
1. 没装网关（缺 `current/wb_proxy.py`）时什么都不做，只记日志。
2. 先查 `GET /health`。如果已经是一个答 `ok` 的网关（比如上一次引擎留下的），就沿用，不起第二个，也不写 `settings.json`。沿用期间每 30 秒查一次，连续两次不通，就按第 3 步自己拉起。这是为了引擎重启时新旧两个插件实例交接：新的刚沿用旧网关，旧的随后就把它停了。
3. 否则按 §4.1 写入签到钟点、拉起网关，日志追加到 `logs/gateway.log`（启动时超过 5 MB 就轮换成 `.1`）。
4. 每秒查一次 `/health`，最多等 60 秒。没起来就记日志，进程留着，下一次退出时按第 5 步处理。
5. 意外退出就按 5、15、45 秒退避重启，10 分钟内最多 3 次；超过就停下记日志，等下次引擎重启。这个次数上限照 systemd 的 `StartLimitIntervalSec` / `StartLimitBurst`。
6. 引擎卸载插件时（`ctx.effect` 的清理函数）先 SIGTERM，5 秒后还在就 SIGKILL。沿用的网关不是自己起的，不去停。
7. 自己的日志写 `logs/plugin.log`（限 1 MB），也走 `ctx.logger`（如果有的话）。

`config` 可以覆盖目录、端口、Python 命令、退避时间，供测试用。默认值就是平板上的路径。

### 4.3 装机脚本 `site/tablet/setup.sh`

站长在 App 的终端里粘贴：`curl -fsSL https://liming-work.com/tablet/setup.sh | bash`。脚本里不含任何密钥，可以重复运行；`--dry-run` 只打印要做的事，`--skip-li` 跳过 li。

1. 检查环境：`HOME=/root`、有 `dsh`。不是 `aarch64` 就提示，但不拦（便于在 x86 上试）。
2. `apt-get install -y python3 openssh-client ca-certificates`，已经装了的跳过。
3. 提示粘贴 li2 的 SSH 令牌行（`read -rs`，只认 `ssh ibssh_…@host` 的格式；用完不存）。
4. `ssh <令牌>@<host> 'cat /data/workbuddy-gateway/releases/workbuddy2api-hub-v2.0.8.zip'` 取 zip，核对大小和哈希。li2 上没有就提示粘贴 li 的令牌再取。
5. 按 §4.1 解压、建目录、加可执行位。已有 `current` 就跳过解压，`accounts/` 永远不动。
6. 下载插件三个文件到 `/root/liming-gateway/`，然后 `dsh plugin --profile web add /root/liming-gateway`。
7. 经 SSH 在 li2 上建 §4.4 的三样东西。远端只新建这几个文件，再查一下 `~/.xin/harness.key` 和 `~/.local/bin/dsh` 在不在，不打印内容。
8. 问要不要也接 li（粘贴 li 的令牌；直接回车就跳过），接的话照第 7 步做。
9. 打印接下来要点的几步（§4.5）和填法（§4.6），包括 li2、li 包装脚本的绝对路径。

### 4.4 li2、li 上给平板用的 `tablet` 配置

每台只新建：

- `~/.local/bin/dsh-tablet`（权限 700）：

  ```sh
  #!/bin/sh
  # 平板（DSH Go）连这台电脑时用：独立的 tablet 配置；网关 key 只在这台电脑上读
  XIN_HARNESS_KEY=$(cat "$HOME/.xin/harness.key") || exit 78
  export XIN_HARNESS_KEY
  exec "$HOME/.local/bin/dsh" --profile tablet "$@"
  ```

  因为第一个参数是 `--profile`，li 的包装脚本不会再加 `headless`。`tablet` 配置有自己的 `node_modules`，不会装 purge。
- `~/.dsh/profiles/tablet/cordis.patch.yml` ← `site/tablet/dsh-tablet-profile.yml`。由 `scripts/tablet-profile.mjs` 导入 `site/xin/vm-models.mjs` 的 `HARNESS_ROUTE`、`HARNESS_MODELS` 生成，形状照 `writeHarnessPatch`（`site/xin/vm-persona.mjs`），只留线路和默认模型，不要人设、purge、REA。单元测试核对提交的文件和生成结果一致，天启换了模型表这里也会跟着红。
- `/data/workspace/tablet/`：平板新对话的工作目录。

DSH Go 里的设置：「添加 SSH 主机」。主机和用户名取自令牌行，端口 22；实例管理选托管启动，启动命令填 `/data/home/.local/bin/dsh-tablet web`，工作目录填 `/data/workspace/tablet`。

注意：DSH 的对话按工作目录存在 `~/.dsh/sessions/` 下，所以平板连上 li2 时可能看得到天启的工作区。说明里写：要接着天启的对话就回网站，平板上只在 `tablet` 工作区里开新对话，免得两边同时写同一个对话。

### 4.5 站长要做的事（第一次装）

1. 平板装原版 DSH Go（GitHub Releases 或 go.dshtui.com，选 arm64），首次启动选「本机」，在「设置 › 隐私与分享」关掉匿名统计。
2. 在 InstaBox 后台给 li2、li 各建一个 SSH 令牌（Connect → SSH tokens → Create token，选永久）。平板丢了就在这里吊销。
3. 打开一个对话 → 全部功能 → 终端，粘贴装机命令，按提示粘贴令牌。
4. 平板浏览器打开 `http://127.0.0.1:8788`，用 `admin` 登录，先改密码，再加网关账号，最后在「设置 → API Key」新建一个 key。
5. 「设置 › 本机引擎」重启引擎；「设置 › 模型 › 添加渠道」按 §4.6 填；「切换主机 › 管理远程主机」按 §4.4 加 li2、li。关掉「连接上次使用的主机」。
6. 「设置 › 手机操控」打开开关，开无障碍和通知。侧载的 App 打不开无障碍时，先按页面提示「允许受限制的设置」。

### 4.6 平板上的渠道怎么填

| 项 | 填 |
|---|---|
| 兼容协议 | Responses |
| Base URL | `http://127.0.0.1:8788/v1` |
| API Key | 面板里新建的 key |
| 模型 | 「获取模型」后勾 `deepseek-v4.1-flash`、`glm-5.4`、`kimi-k3.1-pro` |

| 模型 | 上下文 | 输入类型 | 思考档位 |
|---|---|---|---|
| DeepSeek V4.1 Flash | 1M | 文本和图片 | 不思考、低、高、最高 |
| GLM-5.4 | 1M | 文本和图片 | 低、高、最高 |
| Kimi K3.1 Pro | 1M | 文本和图片 | 低、高、最高 |

取自 `HARNESS_MODELS`，和天启一致。

## 5. 风险与退路

| 风险 | 对策 |
|---|---|
| DSH Go 的 SSH 不认令牌登录（表单要求选密码或私钥） | 先选密码、随便填。不行就先报告站长：第二步在 fork 里修，或改用 DSH Remote 中继 |
| li2 上没有原版 zip | 脚本改从 li 取；两台都没有就停下说明 |
| 网关在平板的 PRoot 里起不来（Python 版本、TLS 组件） | 看 `logs/gateway.log`；退路是网关留在 li2、经 Worker 转发，那是另一份设计，先问站长 |
| 「重置运行环境」会删掉 `/root`，网关和账号一起没了 | 说明里写清楚：重置后重跑脚本、重新加账号 |
| 平板长时间不开，账号登录可能过期 | 在面板里重新登录；第一步不做自动处理 |
| 平板一直连着 li2，li2 不睡，到上限会冷却，天启也会受影响 | 用完切回本机，关掉「连接上次使用的主机」 |
| 网关上游在收紧，账号有被风控的风险 | 站长自己的选择；平板单独一个账号，降低连带风险 |

## 6. 验收

- 本地：`npm run check`、`npm run test:e2e` 全过；新单元测试先失败、后通过。
- 本地集成：在会话容器里用原版 zip（从 li 只读取，不提交）和插件，在测试端口拉起网关，核对启动、`/health`、签到钟点写入、停止。装 `@deepseek-ai/dsh@0.2.2-rc.3` 试 `tablet` 配置和包装脚本：`--dump-config` 里有网关线路，`web` 能打印带 token 的地址。li、li2 上不起任何进程。
- 上线：按 CLAUDE.md 的流程；合并后 `https://liming-work.com/tablet/setup.sh` 能下载。
- 平板（站长做完 §4.5 以后对照）：打开 App 十几秒内网关起来，DeepSeek V4.1 Flash 能回话；「打开设置看看系统版本」能跑完；切到 li2，第一次约 40 秒叫醒，之后能对话、天启照常；切到 li 同样；当天开过 App，面板里能看到签到成功。

## 7. 参考的成熟做法

- 插件包结构、本地安装、`ctx.effect` 收尾：DSH Go 的 `docs/plugins/from-zero.md`、`docs/plugins/hosts.md`、`examples/plugins/dsh-go-example-usage`。
- 包装脚本要把参数传下去：DSH Go 的 `app/lib/remote/ssh/remote_bootstrap.dart`（`startScript` 在启动命令后加 `--host 127.0.0.1 --port 0 --no-open`）。
- 网关启动参数和环境变量：照 li 上的 `workbuddy-gateway.service`。
- 重启的次数上限：systemd 的 `StartLimitIntervalSec` / `StartLimitBurst`。
- SSH 令牌和叫醒：InstaBox 的 `docs/ssh.md`、`docs/idle-suspend.md`。
- 线路补丁的形状：本仓库的 `writeHarnessPatch`（`site/xin/vm-persona.mjs`）。

## 8. 第二步（以后单独设计）

在站长的 GitHub 上建 fork（要站长操作），只动外壳：用开关按清单藏入口，常用的提到主屏，关掉自动更新和匿名统计，换名字、图标和包名，网关自启改进启动流程。APK 由 GitHub Actions 出，签名 key 放进 Secrets。可选用 InstaBox 的 `android` 模板做云上真机测试（要占一台机器，先问站长）。小芯宠物包到时候再议。
