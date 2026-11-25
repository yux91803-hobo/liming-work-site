# 平板版 DSH Go 第一步实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 平板装原版 DSH Go 后，在终端粘贴一行，就装好随引擎启停的本机网关，并在 li2、li 上建好给平板用的 `tablet` 配置。

**Architecture:** 一个 DSH（Cordis）插件守护平板上的网关进程（`lib/gateway.js` 管启停、健康、退避、签到钟点，`lib/index.js` 只做挂载）。一个装机脚本经 InstaBox SSH 令牌从 li2（或 li）取原版网关 zip、校验、解压、装插件，并在远端只新建包装脚本、`tablet` 配置补丁和工作目录。所有文件放在 `site/tablet/`，由 Worker 当静态文件提供。

**Tech Stack:** Node 22（ESM 插件，`node:test` 用 CJS 测试），Bash，Python 3（测试里的假网关、`zipfile`），DeepSeek Harness 0.2.2-rc.x。

**Spec:** `docs/superpowers/specs/2026-11-25-tablet-dshgo-design.md`（站长北京时间 11-25 批准：「A 先插件后 fork」）。

**进度与分工：** Claude Code 实现并自查，没有另一位 AI 复核（交接里如实写）。

**执行中的改动：** Task 4 用真 Harness 实测，发现自定义配置名不会自动建（`dsh web` 就是 `dsh --profile web`）。li、li2 改用没人用的内置 `web` 配置，DSH Go 的启动命令只填包装脚本、不加 `web`。下面各任务里的 `tablet` 配置都按这条理解，原因和证据见设计 §4.4、`docs/CHANGES.md` 本条。

## Global Constraints

- 网关程序、账号、key 一律不进仓库（公开仓库）；脚本里只写死 zip 的大小 `22962873` 和 SHA-256 `b322c73b9a18f09c6560bff0e4b748e9acdc26272c339b4f5fce2413bb500cc6`。
- 平板路径：网关 `/root/workbuddy-gateway`（`current -> v2.0.8/wb-proxy`，`accounts/`、`usage/`、`logs/` 权限 700），插件 `/root/liming-gateway`。
- 网关启动：`python3 current/wb_proxy.py --host 127.0.0.1 --port 8788 --accounts-dir <dir>/accounts --usage-dir <dir>/usage`，工作目录 `current`，环境变量加 `TZ=Asia/Shanghai`、`PYTHONUNBUFFERED=1`、`WB_PROXY_DEFAULT_REALM=cn`，umask 077。
- 健康检查 `GET http://127.0.0.1:8788/health`，JSON 里 `ok === true` 才算活着。
- 签到钟点：`accounts/settings.json` 没有 `schedule.checkin` 时写入 `0…23`，保留其他键；已有就不动。
- 退避 5、15、45 秒；10 分钟内最多重启 3 次；停止时 SIGTERM，5 秒后 SIGKILL。
- 远端（li2、li）只新建 `~/.local/bin/dsh-tablet`、`~/.dsh/profiles/tablet/cordis.patch.yml`、`/data/workspace/tablet/`；不读出、不打印 `~/.xin/harness.key`。
- 插件包：`engines.dsh` 为 `">=0.2.1-rc.2 <0.3.0-0"`，`engines.node` 为 `">=22.19"`，没有依赖。
- 文案用中文，按钮和步骤名照 DSH Go 界面上的叫法。

## Review Focus

1. **引擎重启时的交接**：新插件实例启动时旧网关还在答，于是沿用；随后旧网关退出。期望：沿用期间每 30 秒查一次，连续两次不通就自己拉起。（Task 2）
2. **8788 被别的程序占着、又不是网关**：期望不无限重启，按次数上限停下，日志写明端口被占。（Task 2）
3. **下载到的不是文件**：网站对不存在的路径返回首页 HTML，zip 也可能没下完。期望校验失败就停，已装的东西不动。（Task 3）
4. **粘贴的令牌行有多余空格、回车，或少了 `ssh`**：期望照常认出；格式不对就拒绝，提示里不回显令牌。（Task 3）
5. **重复跑装机脚本**：期望已装好的网关不再下载，`accounts/` 永远不碰，插件不重复挂载。（Task 3）

---

### Task 1：li、li2 的 `tablet` 配置和包装脚本

**Files:**
- Create: `scripts/tablet-profile.mjs`
- Create: `site/tablet/dsh-tablet-profile.yml`（生成）
- Create: `site/tablet/dsh-tablet.sh`
- Test: `test/tablet-profile.test.cjs`

**Interfaces:**
- Produces: `tabletProfileYaml(): string`（`scripts/tablet-profile.mjs`）。命令行 `node scripts/tablet-profile.mjs` 写出文件，`--check` 不一致时退出码 1。`site/tablet/dsh-tablet-profile.yml` 第一条是 `- id: llm-pi-ai`。`site/tablet/dsh-tablet.sh` 第一行 `#!/bin/sh`。

- [ ] **Step 1：写失败的测试** `test/tablet-profile.test.cjs`
  - `生成的 tablet 配置和提交的文件一致`：`tabletProfileYaml()` 全等于 `site/tablet/dsh-tablet-profile.yml` 的内容。
  - `线路和模型取自天启的模型表`：包含 `apiKeyEnv: XIN_HARNESS_KEY`、`api: openai-responses`、`baseURL: "http://127.0.0.1:8788/v1"`；`HARNESS_MODELS` 的每个 `id` 和 `contextWindow: 1000000` 都在；`input: ["text","image"]`；DeepSeek 有 `off: none`；默认模型是 `deepseek-v4.1-flash`、`reasoningEffort: high`。
  - `不带人设、purge、REA`：不含 `personaPrefix`、`dsh-purge`、`mcp-rea`。
  - `包装脚本只读 key 不打印`：`sh -n` 通过；含 `--profile tablet "$@"` 和 `exec "$HOME/.local/bin/dsh"`；没有把 key 写到 stdout 的 `echo`、`printf`。
  - `包装脚本把参数原样传下去`：在临时 HOME 里放假的 `.local/bin/dsh`（把参数逐行写进文件）和 `.xin/harness.key`；执行 `dsh-tablet web --host 127.0.0.1 --port 0 --no-open`，记下的参数是 `--profile tablet web --host 127.0.0.1 --port 0 --no-open`，环境里的 `XIN_HARNESS_KEY` 等于 key 文件内容。没有 key 文件时退出码 78。
- [ ] **Step 2：运行，确认失败**：`node --test test/tablet-profile.test.cjs`，应报找不到模块。
- [ ] **Step 3：实现** `tabletProfileYaml()`：按 `writeHarnessPatch`（`site/xin/vm-persona.mjs`）的写法生成 `llm-pi-ai` 和 `agent-default-model` 两条，字符串用 `JSON.stringify`，开头一行注释说明「由 scripts/tablet-profile.mjs 生成，别手改」。`dsh-tablet.sh` 用设计 §4.4 的原文。跑一次脚本，写出 yml。
- [ ] **Step 4：运行，确认通过**：`node --test test/tablet-profile.test.cjs`。
- [ ] **Step 5：提交**：`git commit -m "生成平板连 li、li2 用的 tablet 配置和包装脚本"`。

### Task 2：网关守护插件 `liming-gateway`

**Files:**
- Create: `site/tablet/liming-gateway/package.json`、`cordis.patch.yml`、`lib/gateway.js`、`lib/index.js`
- Test: `test/tablet-gateway.test.cjs`

**Interfaces:**
- Produces（`lib/gateway.js`）：
  - `DEFAULTS`：`{ dir: '/root/workbuddy-gateway', host: '127.0.0.1', port: 8788, python: 'python3', healthTimeoutMs: 60000, healthIntervalMs: 1000, backoffMs: [5000, 15000, 45000], restartWindowMs: 600000, restartLimit: 3, stopGraceMs: 5000, watchMs: 30000, logMaxBytes: 5242880, pluginLogMaxBytes: 1048576 }`
  - `CHECKIN_ALL_DAY`：`[0, 1, …, 23]`
  - `gatewayCommand(opts) -> { command, args, cwd, env }`
  - `seedCheckinSchedule(accountsDir) -> 'seeded' | 'kept' | 'invalid'`
  - `probeHealth({ host, port, timeoutMs }) -> Promise<boolean>`
  - `createSupervisor(opts) -> { start(): Promise<'missing'|'adopted'|'started'|'unhealthy'>, stop(): Promise<void>, state(): { mode, pid, restarts, gaveUp } }`
- Produces（`lib/index.js`）：`name = 'liming-gateway'`，`apply(ctx, config)` 里调用 `ctx.effect(() => { supervisor.start(); return () => supervisor.stop() })`。

测试里的假网关：在临时目录写 `current/wb_proxy.py`（Python 标准库 `http.server`）。它解析 `--port`，`/health` 回 `{"ok": true}`，每次启动往 `spawns.txt` 追加一行，并把收到的参数和 `TZ` 写进 `last-run.json`。用环境开关切换模式：立刻退出、忽略 SIGTERM、`/health` 永不回 ok。测试里的时间参数都调到几十毫秒。

- [ ] **Step 1：写失败的测试** `test/tablet-gateway.test.cjs`
  - `启动参数和环境照 li 的服务`：`gatewayCommand` 的参数正好是 Global Constraints 里那一串，`env.TZ === 'Asia/Shanghai'`、`WB_PROXY_DEFAULT_REALM === 'cn'`、`PYTHONUNBUFFERED === '1'`。
  - `没装网关不启动`：`start()` 得 `'missing'`，`spawns.txt` 不存在，`logs/plugin.log` 有一行说明。
  - `正常启动并写入签到钟点`：预置 `settings.json` 为 `{"api_keys":[{"k":"x"}],"schedule":{"travel":[9,21]}}`；`start()` 得 `'started'`，`probeHealth` 为真；之后 `schedule.checkin` 是 0…23，`travel` 和 `api_keys` 不变；`last-run.json` 里的 `TZ` 是 `Asia/Shanghai`。
  - `已有签到钟点不覆盖`：`schedule.checkin` 为 `[9]` 时，返回 `'kept'`，内容不变；文件不是合法 JSON 时返回 `'invalid'`，文件不动。
  - `已有网关在答就沿用`：先在端口上起一个 Node 假网关；`start()` 得 `'adopted'`，不写 `settings.json`；`stop()` 后外面那个仍在答。
  - `沿用的网关没了就接手`（Review Focus 1）：沿用后关掉外面那个；在 `watchMs` 乘 3 以内自己的假网关起来，`spawns.txt` 一行。
  - `意外退出按退避重启，有次数上限`：立刻退出模式下 `spawns.txt` 共 4 行（1 次加 3 次重启），`state().gaveUp === true`，之后不再增加。
  - `端口被别的程序占着`（Review Focus 2）：端口上一个 `/health` 回 404 的服务；最后 `gaveUp === true`，`spawns.txt` 不超过 4 行，`plugin.log` 里有「8788」和「占用」。
  - `健康检查超时`：永不回 ok 模式下 `start()` 得 `'unhealthy'`，进程还在（`state().pid` 存活）。
  - `停止先 SIGTERM，超时再 SIGKILL，停后不重启`：忽略 SIGTERM 模式下 `stop()` 在 `stopGraceMs` 加 1 秒内完成，进程已不在，再等一个退避周期 `spawns.txt` 不增加。
  - `日志超过上限就轮换`：预置 6 MB 的 `logs/gateway.log`，启动后有 `gateway.log.1`，新的 `gateway.log` 小于 1 KB。
  - `插件挂载`：用假 `ctx`（记录 `effect` 回调）调用 `apply`；`name === 'liming-gateway'`；执行 effect 会启动，执行它返回的清理函数会停止。
- [ ] **Step 2：运行，确认失败**：`node --test test/tablet-gateway.test.cjs`。
- [ ] **Step 3：实现** `lib/gateway.js`：
  - 子进程用 `spawn`，不 `detached`，stdout、stderr 都追加到 `logs/gateway.log`，跟引擎一起退出。
  - `settings.json` 先写临时文件再 `rename`。
  - 沿用模式下连续两次 `/health` 不通，就按「正常启动」的路径接手。
  - 启动后 3 秒内就退出时，再查一次端口；端口通但 `/health` 不 ok，日志写「8788 被其他程序占用」。
  - 再写 `lib/index.js`、`package.json`（照 `from-zero.md`：`type`、`main`、`exports`、`files`、`engines`、`dsh.bundle.patch`）和 `cordis.patch.yml`（`- insert: - id: liming-gateway  name: liming-gateway`）。
- [ ] **Step 4：运行，确认通过**：`node --test test/tablet-gateway.test.cjs`；再跑 `node --check site/tablet/liming-gateway/lib/*.js`。
- [ ] **Step 5：提交**：`git commit -m "平板网关随 DSH 本机引擎启停的插件"`。

### Task 3：装机脚本 `setup.sh`

**Files:**
- Create: `site/tablet/setup.sh`
- Test: `test/tablet-setup.test.cjs`

**Interfaces:**
- Consumes：Task 1 的 `dsh-tablet.sh`、`dsh-tablet-profile.yml`，Task 2 的插件四个文件，都从 `$LIMING_BASE/…` 下载。
- Produces：`site/tablet/setup.sh [--dry-run] [--skip-li]`。测试用的环境变量：`LIMING_BASE`（默认 `https://liming-work.com/tablet`）、`LIMING_GW_DIR`、`LIMING_PLUGIN_DIR`、`LIMING_SSH`、`LIMING_DSH`、`LIMING_APT`、`LIMING_TTY`（默认 `/dev/tty`）、`LIMING_ZIP_SIZE`、`LIMING_ZIP_SHA256`。设 `LIMING_SETUP_LIB=1` 时只定义函数、不执行 `main`。函数有 `parse_token_line`、`fetch_file <url> <dest> <marker>`、`verify_zip <file>`、`install_gateway`、`install_plugin`、`remote_script`、`remote_setup <user@host>`。

测试搭法：`LIMING_BASE=file://<仓库>/site/tablet`（curl 支持 `file://`）。假 `ssh` 是一个 bash 脚本：收到 `cat …zip` 就输出测试 zip；收到 `bash -s` 就在临时 HOME（里面放好假的 `.local/bin/dsh` 和 `.xin/harness.key`）里执行标准输入。假 `dsh`、`apt-get` 只记下收到的参数。令牌从 `LIMING_TTY` 指向的文件读。测试 zip 用 Python `zipfile` 现做，内容是 `wb-proxy/wb_proxy.py`、`wb-proxy/bin/wb-tls-bridge-linux-arm64`、`wb-proxy/start-wb-proxy.sh`，大小和哈希经 `LIMING_ZIP_*` 传入。

- [ ] **Step 1：写失败的测试** `test/tablet-setup.test.cjs`
  - `语法和不带密钥`：`bash -n` 通过；`site/tablet/` 下任何文件都不匹配 `ibssh_[A-Za-z0-9]{8,}`、`ibk_[A-Za-z0-9]{8,}`、`sk-[A-Za-z0-9]{16,}`；脚本里写着真实的大小和哈希。
  - `令牌行各种粘法`（Review Focus 4）：`"ssh ibssh_ab12@x.instabox.sh"`、`"  ibssh_ab12@x.instabox.sh\r"`、`"ssh  ibssh_ab12@x.instabox.sh  "` 都解析成 `ibssh_ab12@x.instabox.sh`；`"ssh root@x"`、`"ibssh_ab12"`、`"ssh ibssh_ab12@x; rm -rf /"` 退出码非 0，输出里不出现 `ab12`。
  - `下载到首页或内容不对就停`（Review Focus 3）：`LIMING_BASE` 指向一个所有文件都是 `<!doctype html>` 的目录，`fetch_file` 失败，目标文件不存在。zip 少一个字节或哈希不对时 `verify_zip` 失败；`install_gateway` 不建 `current`，原有的 `current` 不动。
  - `整套装一遍`：跑 `main` 后，`current/wb_proxy.py` 存在；`bin/wb-tls-bridge-linux-arm64` 和 `start-wb-proxy.sh` 可执行；`accounts`、`usage`、`logs` 权限 700；插件四个文件在 `LIMING_PLUGIN_DIR`；假 `dsh` 收到 `plugin --profile web add <插件目录>`；临时 HOME 里有 `dsh-tablet`（700）和 `profiles/tablet/cordis.patch.yml`，内容等于仓库里的文件；`harness.key` 未变，也没有出现在输出里；输出里有 `/…/.local/bin/dsh-tablet web`。
  - `重复跑`（Review Focus 5）：第二次跑，假 `ssh` 没收到 `cat …zip`；预先放进 `accounts/` 的文件原样还在；假 `dsh` 没再收到 `plugin add`。
  - `li2 没有 zip 就从 li 取`：假 `ssh` 对第一个主机的 `cat` 返回退出码 1；脚本再要第二个令牌，从第二个主机取到 zip。
  - `--dry-run 什么都不改`：输出里列出步骤，临时目录里什么都没多，假命令都没被调用。
  - `--skip-li 不问 li`：只读一次令牌。
- [ ] **Step 2：运行，确认失败**：`node --test test/tablet-setup.test.cjs`。
- [ ] **Step 3：实现** `setup.sh`：
  - 开头 `set -euo pipefail`。
  - 令牌用 `read -rs < "$LIMING_TTY"` 读，因为 `curl | bash` 时标准输入是脚本本身。
  - `ssh` 带 `-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15`。
  - 先解压到临时目录、核对，再 `mv` 成 `v2.0.8`。
  - 远端脚本用带引号的 heredoc 嵌进包装脚本和配置，写临时文件再 `mv`，最后打印 `OK <绝对路径>`。
  - 结尾的说明照设计 §4.5、§4.6 写。
- [ ] **Step 4：运行，确认通过**：`node --test test/tablet-setup.test.cjs`。
- [ ] **Step 5：提交**：`git commit -m "平板装机脚本：取网关、装插件、在 li2 和 li 上建 tablet 配置"`。

### Task 4：本地集成试验（不改仓库代码，只留证据）

- [ ] **Step 1**：经 InstaBox API 从 li **只读**取原版 zip，放到草稿目录，核对大小和 SHA-256，不提交。
- [ ] **Step 2**：在草稿目录模拟平板：用 `setup.sh` 的 `install_gateway` 解压，再用插件把网关拉在测试端口（如 18788）。核对 `/health` 为 ok、`settings.json` 写入签到钟点、`stop()` 后端口释放。网关没有账号，只验证起停。
- [ ] **Step 3**：`npm i --prefix <草稿>/dsh @deepseek-ai/dsh@0.2.2-rc.3`。用临时 HOME 放入 `tablet` 配置和包装脚本（假 key），确认 `dsh --profile tablet --dump-config` 里有 `xin-gateway` 线路和三个模型；`dsh-tablet web --host 127.0.0.1 --port 0 --no-open` 打出带 `token=` 的地址后停掉。如果新配置需要先装插件或 `--patch`，按实际改 Task 1、Task 3 并补测试。
- [ ] **Step 4**：结果写进 `docs/CHANGES.md` 的本条（Task 5）；li、li2 上不起任何进程。

### Task 5：文档

**Files:**
- Create: `docs/tablet.md`
- Modify: `README.md`（加「平板（DSH Go）」一节）、`docs/CHANGES.md`（新条目放最前）、`docs/AI-HANDOFF.md`（新条目放最前）

- [ ] **Step 1**：`docs/tablet.md` 写给站长看，内容照设计 §4.5 的六步、§4.6 的两张表，再加「别做的事」：别「重置运行环境」；别在平板上接着天启的对话；用完切回本机。
- [ ] **Step 2**：README 加一小节，说明能做什么、入口和链接，以代码为准。CHANGES 写改了什么、参考了哪些项目和文件（设计 §7）、Task 4 的实测结果、没验证的部分（真平板、真 SSH 令牌）。交接写分支、作者（Claude Code 实现并自查，无独立复核）、测试结果、下一步。
- [ ] **Step 3**：提交：`git commit -m "平板版 DSH Go 第一步的说明、README、修改记录和交接"`。

### Task 6：全量验证与上线

- [ ] **Step 1**：`npm run check` 全过。
- [ ] **Step 2**：`CHROMIUM_PATH=<pw-browsers 里的 chrome> npm run test:e2e` 全过（没改页面，用来确认没碰坏）。
- [ ] **Step 3**：推送分支 `claude/dsh-go-customization-discussion-d5wt84`，开 PR，正文写实现和复核责任、参考项目、测试结果。
- [ ] **Step 4**：等 Actions 的检查和测试站部署都绿，自己合并；再等正式站那次运行变绿。
- [ ] **Step 5**：`curl -fsSL https://liming-work.com/tablet/setup.sh | head -3` 拿到脚本开头，插件文件同样能下载。
- [ ] **Step 6**：向站长汇报：改了什么、线上已更新，附上 `docs/tablet.md` 的六步。
