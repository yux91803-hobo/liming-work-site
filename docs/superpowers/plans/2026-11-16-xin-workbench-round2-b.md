# 小芯工作台第二轮之二：天启入口、实时终端 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 天启从设置开关变成新对话的另一个入口（带模型和思考强度选择动画）；小芯干活时，聊天里出现 Claude Code 命令行样子的实时终端，代替只写「思考中」。

**Architecture：** 终端是一个独立的小文件 `site/xin/term.js`（`window.LimingXinTerm`），只管把事件画成终端的样子；`chat.js` 决定什么时候建、往哪放、喂哪些事件：后台任务按任务摘要里的轮次编号轮询 `poll`，天启这种前台自己敲命令的回合直接用这一轮已有的事件。控制器只加两样数据：任务摘要带 `run`，Codex 改文件的事件带 `diff`。

**Tech Stack：** 原生 JS（IIFE，无构建）、CSS、Node `node:test` 单元测试、Playwright（Python）浏览器测试。

**Spec：** `docs/superpowers/specs/2026-11-16-xin-workbench-round2-design.md` 第 3、5 节。

## Global Constraints

- 设置里不再有「天启模式」；天启只从新对话的入口进：空白页「小芯 | 天启」切换、侧边栏和命令面板的「新的天启对话」。开始聊以后这个对话就定了是谁。
- 天启的强调色（冷色星光）只用在天启的东西上：标志、强度格、滑块、入口；小芯的琥珀色不混用。
- 思考强度按模型真正支持的档位：DeepSeek V4.1 Flash 是 关 / 低 / 高 / 最高，GLM 是 低 / 高 / 最高；每档一句说明，参考 Codex `codex-rs/models-manager/models.json` 的 `supported_reasoning_levels`（`{effort, description}`）。
- 终端内容只来自真实事件；不显示内部命令（`xin task …` 这类派活、记忆、交付命令），`xin browser …` 画成网页。不搬它电脑的真实画面。
- 打字机效果不能拖慢真实进度：每字 14 毫秒、一行最多 0.45 秒，积压的直接画出来；系统设了减少动态就不打字、不转圈、不闪光。
- 做完收成一行；后台任务：「干完了 · 用时 2 分钟 · 4 条命令」，点开看完整记录，小芯转达的答案接在下面。
- 不加载网络字体；点阵字只用在欢迎页大标题（「天」「启」字库里已有）。
- `site/index.html` 的 `chat.css` / `chat.js` 版本号改成 `xc-r2b-20261116`，新文件 `term.js` 同一个版本号。
- 用量页「状态：常驻进程在管……」那一行文字和位置不动；测试只改结构、行为保留、不删。
- 1280 / 1024 / 768 / 390 × 浅色、深色截图自查，390 不横向滚动。

## Review Focus

1. 内部命令漏进终端：前台派活的 `xin task new --kind code …「要求原文」` 不能出现在终端里（Task 3 的测试）。
2. 很长的输出、很大的改动、重新打开时一次来几百条事件：不打字直接画，输出只留前 3 行、改动只留前 8 行，手机上不横向滚动（Task 2、3 的测试）。
3. 切换对话时后台终端还在轮询：回来的事件不能画进别的对话；离开对话、页面隐藏时停轮询（Task 3 的测试）。
4. 任务中途等你批准、补充要求后开新的一轮：终端收起；新一轮接着画、不重复画旧事件（Task 3 的测试）。
5. 空白页切到天启再发：发的是天启的新对话、不带 main；切回小芯又是主对话（Task 5 的测试）。

---

### Task 1：控制器多给两样数据

**Files：**
- Modify: `site/xin/vm-agent.mjs`（`taskSummary`）
- Modify: `site/xin/vm-events.mjs`（`fromCodex` 的 `file_change`）
- Test: `test/xin.test.cjs`（Codex 事件那条加断言）、新 `test/xin-term-data.test.cjs`

**Interfaces：**
- Produces：任务摘要多 `run: string`（最近一轮的编号，有就给）；Codex 的 `Edit` 事件 `out` 是 `--- <kind> <path>\n<diff>` 按文件拼起来（截到 `OUT_MAX`），没有 diff 时是 `''`（和以前一样）。

- [ ] 写测试：`taskSummary({sid:'stask00001',no:1,title:'t',tkind:'code',model:'glm-5.3',status:'done',runs:['r0000001a'],created:1})` 的 `run === 'r0000001a'`；没有 runs 时没有 `run`。`fromCodex` 的 `file_change`，`changes:[{path:'/w/a.c',kind:{type:'update',movePath:null},diff:'@@ -1 +1 @@\n-a\n+b\n'}]` → `out === '--- update /w/a.c\n@@ -1 +1 @@\n-a\n+b'`；原来那条（`kind:'add'`、没有 diff）仍是 `out:''`。
- [ ] 跑 `node --test test/xin-term-data.test.cjs test/xin.test.cjs`，确认新断言失败。
- [ ] 实现：`taskSummary` 里 `if (r) out.run = r`；`file_change` 按文件拼 diff（kind 取 `kind.type` 或字符串）。
- [ ] 再跑，通过；提交。

### Task 2：终端组件 `site/xin/term.js`

**Files：**
- Create: `site/xin/term.js`
- Modify: `site/xin/chat.css`（`.xc-term` 一组样式）、`site/index.html`（在 chat.js 前引入 term.js）
- Test: 新 `test/e2e/xin_term_e2e.py`（第 1 部分：组件本身，用页面里的 `LimingXinTerm` 直接喂事件）

**Interfaces：**
- Produces：`window.LimingXinTerm = { line(ev) → spec|null, create(opts) → term, summary(counts, state, ms) → string }`
  - `line(ev)`：`{kind:'cmd'|'edit'|'web'|'search'|'tool'|'step'|'say', verb, arg, out, ok}`；内部命令（`xin` 后面不是 `browser` 的）返回 `null`。
  - `create({title, live})` → `{el, feed(ev, animate), status(verb, sec), seal(), finish(state, ms), counts}`；`state` 是 `'done'|'failed'|'stopped'|'waiting'|null`（`null` = 前台这一段，不写结果）。
  - `summary({cmd,edit,web,search,tool}, state, ms)`：`'干完了 · 用时 2 分钟 · 4 条命令 · 改了 2 个文件'`；前台一段（state 为 null）：`'在电脑上做了 18 秒 · 4 条命令'`；没有 ms 就不写用时。
- 结构：`.xc-term` > `.xt-hd`（后台任务才有：标题、用时）、`.xt-ls`（一行一个 `.xt-l.<kind>`：项目符号 `.xt-b`、动作 `.xt-v`、参数 `.xt-a`、输出 `.xt-o`）、`.xt-st`（转圈 `.xt-sp`、动作 `.xt-sv`、秒数 `.xt-ss`）；收起后最上面一颗 `.xt-sum`（`aria-expanded`）。网页那一行有地址栏 `.xt-url`、加载条 `.xt-load`，做完写标题（输出里的「标题：」）。改动画成红绿行 `.xt-diff .add/.del/.hunk`。

- [ ] 写测试（`xin_term_e2e.py` 第 1 部分，页面上 `LimingXinTerm.create` 后喂事件）：`make -j4` 的 `tool` + `tool_end` 画成「运行 make -j4」，输出 20 行只露前 3 行和「… 还有 17 行」；`xin task new --kind code 帮我…` 的 `tool` 不画（`line` 返回 null，行数不变）；`xin browser open https://example.com/a` 画成网页行，`tool_end` 输出里有「标题：示例」就写出来；Edit 的 diff 画出 `.add`、`.del` 行，超过 8 行收成「… 还有 N 行」；`finish('done', 125000)` 以后只剩一颗写着 `干完了 · 用时 2 分钟 · 1 条命令 · 改了 1 个文件 · 看了 1 个网页` 的按钮，点开看到全部行；390 宽不横向滚动；`prefers-reduced-motion` 下 `feed(ev, true)` 也是一次画完。
- [ ] 跑 `python3 test/e2e/xin_term_e2e.py`，确认失败（`LimingXinTerm` 不存在）。
- [ ] 实现 `term.js`：打字机用 rAF，每字 14 毫秒、一行最多 450 毫秒，排队超过 3 行时其余直接画；转圈字符用 Claude Code 的 `· ✢ ✳ ✶ ✻ ✽` 来回，共用一个 120 毫秒的计时器，没有活着的终端或页面隐藏时停；动作词用闪光渐变（减少动态时不闪）。样式：芯片黑底（`--chip`）、等宽字、项目符号运行中是琥珀色闪、成功绿、失败红。
- [ ] 再跑，通过；提交。

### Task 3：后台任务的终端（在这个对话里派出去的活）

**Files：**
- Modify: `site/xin/chat.js`（任务轮询之后同步终端、`put`/`lastAi` 认终端、重新打开对话时补收起的那一行）
- Test: `test/e2e/xin_term_e2e.py`（第 2 部分：模拟后端，任务摘要带 run，`poll` 一页一页给事件）

**Interfaces：**
- Consumes：Task 1 的 `run`；Task 2 的 `LimingXinTerm`。
- Produces：`S.terms[sid] = {term, run, off, pos, busy, tm, gen}`；`syncTerms()`（任务情况变了、换对话、页面可见时调）；`put(e)` 插在第一个钉在底部的终端（`.xc-term.pin`）前面，没有就插在「正在输入」前面。

- [ ] 写测试：派出任务（前台事件里有 `task`，任务 `queued`）→ 聊天最下面出现带任务标题的终端，状态行「准备中」；任务 `running` 且有 `run` → 按 `poll` 给的事件画行，`off`、`pos` 跟着往前走，不重复画；期间前台说的新话插在终端上面，终端一直在最下面；任务 `waiting` → 终端收成「停下来等你 · …」那一行，下面是「我需要你确认一下」的消息；补充以后开新的一轮（`next`）接着画，旧事件不重画；任务 `done` → 收成「干完了 · 用时 … · N 条命令」，小芯转达的答案在它下面，「详情」还在；切到别的对话再回来：没有画错地方，轮询在别的对话里停了；刷新页面后，做完的任务在答案上面有收起的那一行，点开才去取 `history {sid}`、画出完整记录。
- [ ] 跑，确认失败。
- [ ] 实现：轮询用 `call('poll', {run, off, pos})`，不带 deviceId / tabId（不算在看对话、不影响完成通知）；有新事件 1.2 秒一次，没有 2 秒一次；页面隐藏、聊天没开、不在这个对话时停；第一页一次画完（不打字），之后的新行打字；`next` 换到新的一轮，中间画一行「接着做」。状态行：最近的命令用 `actVerb`，没有就是 `thinkWord` 那套，`queued` 写「准备中」（有 `after` 写「等前面的做完」）。任务结束先收终端，再画结果。
- [ ] 再跑，通过；提交。

### Task 4：前台自己敲命令的回合（天启）

**Files：**
- Modify: `site/xin/chat.js`（`applyTurn` 喂事件、`progress` 更新状态行、`draw` 画历史里的工具事件）
- Test: `test/e2e/xin_term_e2e.py`（第 3 部分）

**Interfaces：**
- Consumes：Task 2。
- Produces：`S.fg`（这一轮当前开着的那一段终端）；`fgFeed(ev, live)`、`fgSeal()`、`fgFinish(doneEv)`。

- [ ] 写测试：天启对话里一轮的事件：`text`「我先看看」→ `tool`/`tool_end`（`ls`、`make`）→ `text`「编好了」→ `done`：第一段终端出现时「正在输入」藏起来，状态行写「找文件」「编译中」和秒数；「编好了」画在终端下面、同一轮不再画头像；`done` 后终端收成「在电脑上做了 … · 2 条命令」；只在想的时候还是原来的「思考中」气泡。重新打开这个对话：历史里同一段工具事件画成收起的一行（点开是静态的完整记录）。
- [ ] 跑，确认失败。
- [ ] 实现：只在活的这一轮（不是历史）里，第一个能显示的 `tool` 事件建一段终端（`put` 进去，`data-run` 是这一轮）；来了 `text` 就封上这一段（停转圈、留着展开），下一次工具事件再开新的一段；`done` 时这一轮所有段收起。历史：`draw` 遇到工具事件攒进一段，遇到别的事件收起。`lastAi` 跳过同一轮的终端。
- [ ] 再跑，通过；提交。

### Task 5：天启的入口

**Files：**
- Modify: `site/xin/chat.js`（`welcome`、`newChat`、`settings`、侧边栏、命令面板、头像）、`site/xin/chat.css`、`site/tools/stm32/learning.js`（不再把旧的「天启模式」记录当成全局开关）
- Test: `test/e2e/stm32_e2e.py`（设置那几条、`set_tianqi`）、`test/e2e/xin_main_e2e.py`（第 6 条改成点切换）、`test/e2e/xin_term_e2e.py`（第 4 部分：入口）

**Interfaces：**
- Produces：`setAgent(a)`（`'codex'|'harness'`，记进 `lm.xin.agent`，意思改成「现在看的对话或空白页是谁的」，学习台单独打开时据此判断）；`newChat(stay, toMain, agent)`（不给 agent 就是小芯；`toMain` 一定是小芯）；`tqMark(big)` 返回天启的像素星。

- [ ] 写测试：设置里没有天启那一行；空白页上方「小芯 | 天启」，读屏是单选组；点天启：标志换成像素星、大标题「天启」、输入框底下出现模型按钮；发出去是天启的新对话（`agent: 'harness'`、不带 `main`）；天启对话里小芯的回答头像是星；侧边栏「新的天启对话」、命令面板搜「天启」都能直接开天启的空白页；「新对话」回到小芯。学习记录：在天启对话里做题不记（原测试的行为），单独打开学习台时按 `lm.xin.agent` 判断（原测试不变）。
- [ ] 跑，确认失败。
- [ ] 实现：切换是两颗按钮加一块滑动的底（弹簧曲线 `--e-isle`），切的时候标志淡出缩小、新标志从 0.9 放大淡入（cult-ui 的进场参数），标题用 `swapText`；打开对话时按这个对话是谁写 `lm.xin.agent`。
- [ ] 再跑，通过；提交。

### Task 6：模型和思考强度

**Files：**
- Modify: `site/xin/chat.js`（`renderPick`、`buildPick`、`paintEff`）、`site/xin/chat.css`（天启色、强度格、滑块）
- Test: `test/e2e/stm32_e2e.py`（`PK` 那一组读法跟着改，核对的行为不变）、`test/e2e/xin_term_e2e.py`（第 5 部分）

**Interfaces：**
- Produces：输入框按钮 `.xc-mdl` = 模型名 + 强度格 `i.xc-em[data-lv]`（每格一个 `b`，亮到当前档）；面板里 `.xc-eff` 仍是单选组（`.xc-eff-d[data-v]` 不变），上面一排强度格 `.xc-eff-m`，滑块 `.xc-eff-th`（`aria-hidden`）；`EFF_DESC` 每档一句。

- [ ] 写测试：按钮写模型名、强度格亮的格数等于档位序号（关 0、低 1、高 2、最高 3）；点、拖、方向键换档时滑块的位置跟着到那一格中间、说明换成那一档的一句；GLM 只有三档；Esc 关、焦点回按钮（原有）。
- [ ] 跑，确认失败。
- [ ] 实现：说明文字——关「不额外思考，直接回答」、低「回得快，想得浅一点」、中「速度和深度兼顾，日常够用」、高「想得更深，适合复杂的问题」、超高「想得很深，适合很复杂的问题」、最高「想到最深，留给最难的问题」。滑块 `transform` 用弹簧曲线；强度格逐格亮（每格错开 30 毫秒），减少动态时直接到位。
- [ ] 再跑，通过；提交。

### Task 7：文档、截图、全量验证、上线

**Files：**
- Modify: `README.md`、`docs/CHANGES.md`（新的一条：做了什么、参考了哪些项目）、`docs/AI-HANDOFF.md`、设计文档第 3、5 节补实际的取舍、`package.json` 和 `.github/workflows/deploy.yml`（加 `xin_term_e2e.py`）

- [ ] `npm run check`、`npm run test:e2e` 全过（不和单元测试并行跑）。
- [ ] 截图 1280 / 1024 / 768 / 390 × 浅色、深色：天启空白页、模型面板、后台终端（进行中、收起、点开）、前台终端、手机上终端不横向滚动。
- [ ] 开 PR → 检查和测试站绿 → 没有正在跑的正式部署 → 合并 → 正式站那次运行绿 → 核对线上文件 → 汇报。
