# 天启 v4 第 3 个 PR：终端输入和工作区 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 天启的对话有自己的工作区（新对话时选、之后固定，Harness 在那里跑，左栏按工作区分组）；右栏终端里站长能自己输命令（在工作区里跑，最多 60 秒、输出最多 64 KB）。

**Architecture:** 控制器（li2，`XIN_ROLE=tianqi`）给对话记 `work`（`/data/workspace` 下面一层的文件夹名，空串是工作目录本身），Harness 那一轮的 `cwd` 用它；新加 `term_run`、`term_poll` 两个操作，命令放到后台跑、网页轮询输出。网页的工作区选择、标题旁的工作区、终端输入框都放在 `site/tools/tianqi/sky.js`，`chat.js` 只加天启模式的挂载点和左栏分组。

**Tech Stack:** Node 22（控制器 ESM、node:test），bash + coreutils（`timeout`、`head`），浏览器原生 JS，Playwright（Python）。

**Spec:** `docs/superpowers/specs/2026-11-19-tianqi-harness-workbench-design.md`（§2 版面、§3 控件表、§4 第 3 个 PR）

## Global Constraints

- 终端命令：「只给登录了的站长，限时 60 秒，输出最多 64 KB」（§4）。
- 工作区：「新对话时选，之后固定，因为 Harness 的会话按目录存」（§4）；左栏「对话列表（按工作区分组）」（§2）。
- 中栏标题旁显示工作区；新对话时输入框上面是工作区选择（§2）。
- 天启专用逻辑放 `site/tools/tianqi/`；`chat.js` 只加天启模式下的挂载点，小芯的浏览器测试照跑（§6、§7）。
- `vm-agent.mjs` 行数不超过基线 2949（`test/xin-writers.test.cjs`）。
- 「减少动态」时动画全关（§2）。

## Rulings（和设计文字不一样的地方）

- **工作区放在 `/data/workspace`（控制器的 `WORK`）下面，不是设计里写的 `~/work`**：文件栏和路径核对都只认 `WORK`；li2 上没有 `~/work`；旧对话的 Harness 会话按目录存在 `--data-workspace--`。工作区 = `WORK` 本身（叫「工作目录」，旧对话都在这）或它下面一层的文件夹。错了的代价：改一个常量、挪文件夹。
- **命令放后台跑**（`term_run` 马上回编号，`term_poll` 取输出）：外壳转一个操作最多等 40 秒（`opTimeoutMs`），比 60 秒短。
- **站长自己输的命令不受对话权限（只读等）限制**：权限管的是天启（Harness 沙箱）；站长在自己的终端里输命令，和 Claude Code 的 `!` 命令一样直接跑。

## Review Focus

1. 工作区名带路径花样（`../x`、`/etc`、`.ssh`、`a/b`、空格开头）→ 报 `bad_work`，`WORK` 外面什么都不建。（Task 1 测试）
2. 旧对话没有 `work` → 照旧在 `WORK` 跑（Harness 会话按目录存，换目录就续不上），左栏归在「工作目录」。（Task 1、Task 3 测试）
3. 已有对话的后续轮次带了别的 `work` → 不理，工作区不变。（Task 1 测试）
4. 一直输出、一直不退的命令 → 60 秒停掉，输出截到 64 KB，`term_poll` 说清是超时还是截断。（Task 2 测试，用 `XIN_TERM_LIMIT_MS` 缩短）
5. 新对话还没发第一句就在终端里跑命令，选的是还不存在的新文件夹 → 在那个文件夹里跑（先建好）。（Task 2 测试）

---

### Task 1: 控制器：对话的工作区

**Files:**
- Modify: `site/xin/vm-persona.mjs`（`harnessTurn` 附近）
- Modify: `site/xin/vm-agent.mjs`（`send` 的 `refused` 那一行、`summary()` 那一行、import 行；行数不变）
- Modify: `site/xin/vm-kernel-controller.mjs`（send 的去重摘要）
- Test: `test/xin-tianqi.test.cjs`（`fakeDsh` 多记一行 `PWD=`）

**Interfaces:**
- Produces: `export const WORK_NAME = /^(?!\.)[\w.一-龥-]{1,64}$/`（不以点开头，不能是 `.`、`..`）；`export function workPath(name: string) -> string | null`（`''` → `WORK`，合法名 → `path.join(WORK, name)`，其余 `null`）；`export function workError(w) -> null | {error:'bad_work', msg:'工作区只能是 /data/workspace 下面一层的文件夹'}`（`null`/`undefined`/`''` 不报错）；`harnessTurn` 的 `meta` 多一个 `cwd`（`workPath(s.work || '')`），对话第一轮（`!(s.runs||[]).length`）且带了 `a.work` 时记 `s.work = a.work`；`summary()` 的天启对话多 `work: s.work || ''`。

- [ ] **Step 1: 写失败的测试** `天启的工作区：新对话选了工作区就在那个文件夹里跑；续聊固定；旧对话在工作目录；不认识的名字报错`：
  - `fakeDsh` 加 `echo "PWD=$PWD"`。
  - `op('send', {text:'看看', work:'blink'})` → 跑完后日志最后一行 `PWD=` 是 `<XIN_WORK>/blink`，这个文件夹存在；`op('sessions')` 里这一条 `work === 'blink'`。
  - 同一个 `sid` 再发 `{text:'再看', work:'other'}` → `PWD` 还是 `blink`；`<XIN_WORK>/other` 不存在。
  - 不带 `work` 的新对话 → `PWD=<XIN_WORK>`，`work === ''`。
  - `work` 是 `'../x'`、`'/etc'`、`'.ssh'`、`'a/b'` → 每个都回 `{error:'bad_work'}`，没起 Harness（日志行数不变），`<XIN_WORK>/../x` 不存在。
  - 同一个 `clientId` 换了 `work` → `message_conflict`（照「天启的权限」那条的写法）。
- [ ] **Step 2: 跑它，看它失败**：`node --test --test-name-pattern="天启的工作区" test/xin-tianqi.test.cjs` → FAIL（`PWD` 是工作目录、没有 `work` 字段）。
- [ ] **Step 3: 实现**：上面 Interfaces 里的三个导出放 `vm-persona.mjs`；`vm-agent.mjs` 的 `refused` 加 `|| workError(a.work)`，`summary()` 的天启部分加 `work`；`vm-kernel-controller.mjs` 的摘要加 `...(args.work!=null?{work:args.work}:{})`。轮次起进程处已有 `mk(cwd)`，文件夹会建好。
- [ ] **Step 4: 跑这条和整个文件**：`node --test test/xin-tianqi.test.cjs` → 全过；`node --test test/xin-writers.test.cjs` → 行数没超。
- [ ] **Step 5: 提交** `天启的对话有工作区：新对话时选、之后固定，Harness 在那个文件夹里跑`。

### Task 2: 控制器：终端里自己输命令

**Files:**
- Create: `site/xin/vm-term.mjs`
- Modify: `site/xin/vm-agent.mjs`（`const ops = {` 那一行加 `...termOps,`，import 行；行数不变）
- Modify: `site/xin/vm-kernel-controller.mjs`（`TIANQI_OPS` 加 `term_run`、`term_poll`）
- Modify: `src/xin.js`（`TQ_OPS` 加这两个；`OPS` 不加）
- Test: `test/xin-tianqi.test.cjs`、`test/xin-tianqi-worker.test.cjs`

**Interfaces:**
- Consumes: Task 1 的 `workPath`、`workError`。
- Produces: `export const TERM_OUT_MAX = 65536`；`termLimitMs()`（默认 60000，测试可用环境变量 `XIN_TERM_LIMIT_MS` 调短）；`export const termOps = { term_run(a) -> {id} | {error, msg}, term_poll(a) -> {out, off, done, code, timedOut, truncated, ms} | {error, msg} }`。`term_run({work, cmd})`：不是天启回 `{error:'tianqi_only'}`；`cmd` 是 1～4000 字、没有 NUL 的字符串，否则 `bad_cmd`；`work` 照 `workError`；`id` 形如 `t` + 随机串，文件放 `BASE/term/<id>.out|.json|.code`，起之前删掉一天前的。`term_poll({id, off})`：`id` 不合格式回 `bad_id`，从字节 `off` 起最多读 64 KB。

- [ ] **Step 1: 写失败的测试** `天启的终端：在工作区里跑命令，有输出和退出码；超时停掉；输出最多 64 KB；新文件夹先建好；小芯不能用`：
  - `term_run({work:'blink', cmd:'pwd; echo 你好; exit 3'})` → 轮询到 `done`：`out` 是 `<XIN_WORK>/blink\n你好\n`，`code === 3`，`timedOut === false`。
  - `XIN_TERM_LIMIT_MS=1500` 下 `cmd:'sleep 30'` → 3 秒内 `done`，`timedOut === true`。
  - `cmd:'yes | head -c 200000'` → `out` 总长 65536，`truncated === true`，`code === 0`。
  - `work:'new-folder'`（还不存在）→ 跑 `pwd` 得到 `<XIN_WORK>/new-folder`。
  - `work:'../x'` → `bad_work`；`cmd:''` → `bad_cmd`；`term_poll({id:'../../etc/passwd'})` → `bad_id`。
  - 不设 `XIN_ROLE=tianqi` 的控制器 → `term_run` 回 `tianqi_only`。
  - `xin-tianqi-worker.test.cjs`：`TQ_OPS` 有 `term_run`、`term_poll`，`OPS` 没有。
- [ ] **Step 2: 跑它，看它失败**：`node --test --test-name-pattern="天启的终端" test/xin-tianqi.test.cjs` → FAIL（`not_in_tianqi` / 没有这个操作）。
- [ ] **Step 3: 实现 `vm-term.mjs`**：`spawn('bash', ['-c', WRAP, 'term', cmd, out, code], { cwd, detached: true, stdio: 'ignore' }).unref()`，起之前 `mk(cwd)`。包装：

```sh
timeout -k 5 "$4" bash -lc "$1" 2>&1 | { head -c 65536; cat >/dev/null; } > "$2"
echo "${PIPESTATUS[0]}" > "$3.tmp" && mv "$3.tmp" "$3"
```

  （`$4` 是秒数，`timeout` 收小数；退出码 124 是超时；读满 64 KB 以后接着吞掉，命令不会因为管道断了被杀。）
- [ ] **Step 4: 跑这两个文件和行数检查** → 全过。
- [ ] **Step 5: 提交** `天启的终端能自己输命令：在工作区里跑，最多 60 秒、输出最多 64 KB`。

### Task 3: 网页：选工作区、标题旁显示、左栏分组

**Files:**
- Modify: `site/xin/chat.js`（天启模式：发消息带 `work`；`tq:session` 带 `work`；`renderSess` 按工作区分组）
- Modify: `site/tools/tianqi/sky.js`、`site/tools/tianqi/index.html`、`site/tools/tianqi/workbench.css`
- Test: `test/e2e/xin_tianqi_e2e.py`

**Interfaces:**
- Consumes: Task 1 的 `work`（发消息参数、`sessions`/`history` 里的 `work`）。
- Produces: `LimingXinChat.tqOpts()` 多回 `work`（只在新对话时）；`tq:session` 的 `detail.work`；`#tq-work`（中栏标题旁的工作区）、`#tq-work-pick`（新对话时输入框上面的选择）。

- [ ] **Step 1: 写失败的浏览器测试**（mock 的 `sessions` 带 `work`、`files` 根目录多一个 `uploads` 文件夹）：新对话时 `#tq-work-pick` 列出 `stm32-blink`、「工作目录」、「新建文件夹…」，不列 `uploads`；选 `stm32-blink` 发出去的 `send` 带 `work:'stm32-blink'`；标题旁 `#tq-work` 是 `stm32-blink`；新建文件夹输 `a/b` 提示不行、输 `led-fast` 发出去带 `work:'led-fast'`；左栏按工作区分组，没 `work` 的旧对话在「工作目录」组；打开旧对话时选择框不出现，标题旁是它的工作区；手机 390 宽选择框和输入框都在屏幕里。
- [ ] **Step 2: 跑 `python3 test/e2e/xin_tianqi_e2e.py`，看新检查失败。**
- [ ] **Step 3: 实现**：选择框照权限弹层（`#tq-perm-pop`）的写法：`role=menu`、Esc 收起、焦点回按钮；文件夹列表用已有的 `files` 操作读 `/data/workspace`；文件夹名在网页上先按 `WORK_NAME` 同样的规则核对；记住上次选的（`lm.tq.work`）。左栏分组：组标题是按钮（`aria-expanded`），组内照旧按时间排，最近有动静的组在前。
- [ ] **Step 4: 跑天启浏览器测试和小芯浏览器测试** → 全过。
- [ ] **Step 5: 提交** `天启新对话时选工作区，标题旁显示，左栏按工作区分组`。

### Task 4: 网页：终端里输命令

**Files:**
- Modify: `site/xin/chat.js`（`LimingXinChat.tqCall(op, args, ms)`，天启模式的挂载点）
- Modify: `site/tools/tianqi/sky.js`、`index.html`（`#tq-p-term` 底部 `#tq-term-form`）、`workbench.css`
- Test: `test/e2e/xin_tianqi_e2e.py`

**Interfaces:**
- Consumes: Task 2 的 `term_run`、`term_poll`；Task 3 的当前工作区。
- Produces: `.tq-term-run`（一条命令一块：`$ 命令`、输出、结尾一行「退出码 N · 用时 X 秒」，超时写「超过 60 秒，停了」，截断写「输出超过 64 KB，后面的没显示」）。

- [ ] **Step 1: 写失败的浏览器测试**（mock 的 `term_run` 回编号、`term_poll` 分两次给输出再 `done`）：右栏「终端」底部有输入框；输 `ls` 回车 → `term_run` 带当前工作区和 `ls`；输出两段拼起来显示，结尾「退出码 0」；跑的时候输入框不能再发；超时、截断各有一句话；手机上输入框在屏幕里、键盘弹出时不被挡（`visualViewport` 模拟）。
- [ ] **Step 2: 跑它，看它失败。**
- [ ] **Step 3: 实现**：每 400 毫秒 `term_poll` 一次，网页隐藏时停；输出用 `textContent` 画（不当 HTML）；输入框 `aria-label="在工作区里运行命令"`。
- [ ] **Step 4: 跑天启和小芯浏览器测试** → 全过。
- [ ] **Step 5: 提交** `天启右栏终端里能自己输命令`。

### Task 5: 文档、截图、全量验证、上线

- [ ] README 天启那段、`docs/CHANGES.md` 新条目、`docs/AI-HANDOFF.md`、设计 §3 表里这两行标「第 3 个 PR 做了」并写上 Rulings。
- [ ] `npm run check`、`npm run test:e2e` 全过；1280/1024/768/390 深浅色截图（新对话选择框、标题旁工作区、左栏分组、终端跑完一条命令），自己看一遍。
- [x] 在 li2 的临时目录里用同一个包装跑三条（11-20 写计划时已跑，跑完删了）：li2 有 `/usr/bin/timeout`（GNU coreutils 9.7）、`head`、`bash`；`pwd; echo 你好; exit 3` → 退出码 3、输出对、在工作区文件夹里；`sleep 30` 限 1.5 秒 → 1515 毫秒停、退出码 124；`yes | head -c 200000` → 截到 65536 字节、退出码 0。实现改了包装的话合并前再跑一遍。
- [ ] PR → CI、测试站 → squash 合并（`expectedHeadSha`）→ 正式站 Deploy（含联调）绿 → 同步分支。
