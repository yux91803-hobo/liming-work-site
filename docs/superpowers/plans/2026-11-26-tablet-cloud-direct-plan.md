# 平板 AI 直接操控 li、li2 实施计划

**设计：** [2026-11-26-tablet-cloud-direct-design.md](../specs/2026-11-26-tablet-cloud-direct-design.md)（站长已批准方向）

**目标：** 删掉 #227 上线的云端任务插件，改成平板 AI 自己用 InstaBox 命令行和一份技能操控两台云电脑。

**全局约束：**
- 平板 Harness 保持 rc.1，DSH Go 不 fork。
- 云电脑不重建。网关和现有 key 照用；小芯、天启的文件和常驻服务这次不动。
- InstaBox key 只要 `machines:read` 和 `machines:write`；任何输出、日志、测试快照里都不出现 key。
- 装机脚本可以重复运行，有 `--dry-run`。
- 测试照规矩：新行为先写测试看到红；删掉的只有被删代码自己的测试；改断言只为反映有意的行为变化。

## 任务 1：删掉旧方案

- 删除：
  - `site/tablet/liming-cloud/`、`site/tablet/liming-lease/`
  - `scripts/tablet-harness-contract/`
  - `test/tablet-cloud-*.test.cjs`、`test/tablet-cloud-fake-dsh.cjs`、`test/tablet-lease.test.cjs`
- 旧设计 `2026-11-26-tablet-cloud-tasks-design.md` 和旧计划开头标「已作废」，链到新设计。
- 验证：`node --test test/tablet-*.test.cjs` 只剩网关、配置、装机三组。装机测试这时会红，在任务 3 里改。

## 任务 2：`ib` 包装脚本和技能

- `site/tablet/ib.sh` 装成 `/usr/local/bin/ib`。
  - key 放在 `${LIMING_IB_DIR:-$HOME/.config/liming/instabox}`；命令行可以用 `LIMING_INSTABOX` 换掉，测试靠这个。
  - 按参数里第一个 `li`、`li2`（或以 `li:`、`li2:` 开头）选 key。
  - 没写机器名：两个账号各跑一次，前面标「== li2 ==」「== li ==」。
  - key 缺了报错，退出码 2。
- `site/tablet/skills/liming-cloud-computers/SKILL.md`：front matter 写 `name`、`description`；正文讲两台机器、`ib` 的用法、长任务、浏览器、交给 Codex 再自己检查，以及规矩。
- 测试 `test/tablet-ib.test.cjs`（用假的 instabox 记录环境变量和参数）：
  - li、li2 各用自己的 key，参数原样转给命令行。
  - `li2:` 形式的路径参数也能认出机器。
  - 不写机器名时两个账号各跑一次。
  - 缺 key 时退出码 2。
  - 输出里从不出现 key。
  - 技能文件格式正确，提到 `ib`，不含任何 key 形状的字符串。

## 任务 3：装机脚本改用 InstaBox 命令行

`site/tablet/setup.sh`，测试 `test/tablet-setup.test.cjs` 改成用假的 `instabox`：
- 依赖：python3、curl、sha256sum；不再要 openssh-client。没有 `instabox` 就 `npm i -g instabox@0.8.407`。
- 问两把 key（li2、li；回车表示保留原来的）。用 `get <机器> --json` 核对 key 是对的、看得到这台机器，存 600。
- 网关：没装才用 `pull li2 <安装包>` 取，取不到再从 li 取，大小和 SHA-256 照旧核对。`liming-gateway` 插件照旧。
- 平板上清掉旧东西：有 `/root/liming-cloud` 就先 `dsh plugin --profile web remove liming-cloud`，再删插件目录和 `~/.liming-cloud`。
- 装 `ib` 和技能。
- 每台云电脑经 `exec --stdin <机器> -- bash -s` 跑云端准备脚本：
  - 旧租约插件卸掉，删 `~/.liming-lease` 和 `~/.liming-cloud`。
  - 网关 key 复制到 `~/.config/liming/gateway.key`。
  - `~/.profile` 导出 `LIMING_GATEWAY_KEY`。
  - Codex 的 `workbuddy` 线路补上 `env_key`；没有这条线路就补一整段。
  - 装 `playwright-cli` 和 Chromium。
  - 第一步的 `dsh-tablet` 和 web 配置照旧写。
  - 每一项结果打成一行状态。
- 测试要点：
  - key 文件 600，输出里没有 key；key 错了会提示，不会存下。
  - 网关安装包核对失败就不装。
  - 旧插件清理。
  - 云端准备脚本在假 HOME 里实跑：重复运行结果不变；没有 Codex 线路时会补上；不碰 `~/.codex` 之外小芯的文件；没有网关 key 时报出来，不中断。
  - `--dry-run` 什么都不改。

## 任务 4：关掉正式站的定时任务，更新文档

- `wrangler.jsonc` 正式站的 `crons` 置空；`test/xin.test.cjs` 那一项改成「正式站和测试站都没有定时任务」。`runCron` 的代码和测试保留，网站上小芯的去留以后定。
- 改 `docs/tablet.md`、README 的平板一节、`CLAUDE.md` 里讲定时任务的那句，以及 CHANGES、交接。

## 任务 5：验证与上线

- `npm run check`、`npm run test:e2e` 全过 → PR → CI 和测试站绿了合并 → 确认正式站那次运行是绿的，`/tablet/` 下的文件和仓库逐字节一致，旧插件路径不再能下载（会回首页 HTML）。
- 站长随后要求删掉小芯真模型联调：`deploy.yml` 冒烟检查之后的联调步骤、联调脚本和判断脚本一起删，`test/ci-public.test.cjs` 加守护测试。正式发布只剩冒烟检查和失败回滚。

## 重点检查

1. 平板上 npm 全局装的命令在 PATH 里吗？装完用 `command -v instabox` 核对，找不到就给出明确提示。
2. 两个账号的 key 填反了：`get` 核对机器名对不上就拒绝保存。
3. 云端准备脚本出错要说清是哪一项，不能把半截配置留在 `~/.profile` 或 Codex 配置里：改之前备份，改动用一次性替换。
4. 机器正在冷却、`exec` 拒绝时：装机脚本说明是哪台、可以稍后重跑，平板上的部分照样装好。
5. key 只能经环境变量交给 `instabox`，不能进命令行参数（参数在 `ps` 里能看到）。
