# 终端打开不重放、在做的活跟着最新消息走 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点开「小芯的电脑」直接停在最新一步（只有新来的才逐字敲）；派出去的活那个框在做时一直在最新消息下面，做完停在那时候的最后、结果接在它后面。

**Architecture:** 只改网页画法。`site/xin/term.js` 的 `paint` 画完已有事件就 `drain`。`site/xin/chat.js` 把任务框从派活那条回答里拿出来，套一条不画头像的消息（`.xc-tbw`），在做的带 `dock` 放在列表最后，`put`/「思考中」插在第一个 `dock` 前面；`paintBox` 按状态挪框；`resultAfter` 找框、把还在最底下的框先落下来；历史按结束时间画框和结果。

**Tech Stack:** 原生 JS（ES5 风格，和现有文件一致）、CSS、Playwright e2e（`test/e2e/xin_term_e2e.py`）。

**Spec:** `docs/superpowers/specs/2026-11-17-xin-term-follow-design.md`

## Global Constraints

- 不改控制器、不改存的记录：只动 `site/xin/term.js`、`site/xin/chat.js`、`site/xin/chat.css` 和测试、文档。
- `.xc-bub` 只给回答正文用：框和框的那条消息里不能有 `.xc-bub`（正式站联调取最后一个 `.xc-ai:not(.xc-typing) .xc-bub` 当回答，#159 因此回滚过）。
- 框不画头像；结果那条不画头像、不写「小芯」（第四轮定的，不变）。
- 前台跑过命令的那一行（`.xc-proc`）留在那条回答下面，不跟着走。
- 文案不变：在做时「任务名 / 此刻那一步 · 秒数」，做完「✓ 任务名 · 用时 …」，终端结尾「已完成 · 用时 …」。

## Review Focus

- 前台这一轮还在回话（「思考中」那一行在）时派出了活：框在「思考中」下面，回话的文字插在「思考中」上面，回完以后框紧跟在那段话下面。→ Task 2 Step 1 断言。
- 结果（转达那一轮的文字）比任务状态先到：框还带 `dock` 时结果来了，要先把框落到最后，结果接在框后面，不能出现「结果在上、框在最底下」。→ Task 2 Step 1 断言。
- 等你确认（`waiting`）以后又接着做：框从落下的位置回到最底下；再做完，落在那时候的最后。→ Task 2 Step 1 断言。
- 「更早的消息」翻出来的老轮次里有这件活的 `task` 事件：不能再画一个框（在做的已经在最底下、做完的已经按时间画过）。→ Task 2 Step 1 断言。
- 终端开着时来了新的一步：照旧逐字敲（打开即画好只管已经有的）；读完历史（`fill`）也是一次画好。→ Task 1 Step 1 断言。

---

### Task 1: 终端打开一次画好，新来的才逐字敲

**Files:**
- Modify: `site/xin/term.js`（`paint`，约 305–323 行）
- Test: `test/e2e/xin_term_e2e.py`（part1 里「一个字一个字敲」那一条改成新行为；加「打开即画好、新来的逐字敲」）

**Interfaces:**
- Produces: 行为——`W.open` / `W.show` / `W.fill` 之后 `.tm-win` 里没有 `.tm-tp`、已有的行都在、滚在最下面；`W.push` 进来的事件有 `.tm-tp`（逐字敲）。

- [ ] **Step 1: 改测试**：part1 打开 `EVENTS` 后（等 560 毫秒的那一下）断言 `early['text'] == r['text']`、`early['cur']` 为真、`.tm-tp` 不存在、`scr.scrollTop + scr.clientHeight >= scr.scrollHeight - 2`；live 那一页 `push` 25 条命令仍然断言「0.25 秒时还在敲、3 秒内敲完」（不改）。新加：一个 live 的页先带 3 条已有事件打开，马上断言 3 行都在、没有 `.tm-tp`，再 `push` 一条，断言出现 `.tm-tp`。
- [ ] **Step 2: 跑 `python3 test/e2e/xin_term_e2e.py`（先起 `node scripts/preview.mjs --port 5173`），确认这几条先红。**
- [ ] **Step 3: `paint(tab)` 末尾在 `ending()` 之后调 `drain()`**（已有事件和结尾一次画完、`follow()` 到底）；`view.replay` 不再用来放慢。
- [ ] **Step 4: 再跑，part1 全绿。**
- [ ] **Step 5: 提交** `site/xin/term.js test/e2e/xin_term_e2e.py`。

### Task 2: 在做的框跟着最新消息走，做完落在那时候的最后

**Files:**
- Modify: `site/xin/chat.js`：`taskBox`、`paintBox`、`resultAfter`、`liveAnchor`/`put`、`typing`、`drawTaskResult`、`openSession`（历史里按结束时间画框和结果）、`earlierBtn`（去重）、`draw` 里 `task` 事件和 `taskResult` 文字。
- Modify: `site/xin/chat.css`：`.xc-tbw`（框那条消息）的间距。
- Test: `test/e2e/xin_term_e2e.py` part2（派活、做完、刷新那几条改成新位置；加接着聊、等你确认再接着做、结果先到）。

**Interfaces:**
- Produces（chat.js 内部）：
  - `boxWrap(sid) -> Element|null`：这件活的框那条消息（`.xc-m.xc-ai.cont.xc-tbw[data-tsid]`，`data-run` 为 `'tb-' + sid`，里面一个隐藏头像 + `.xc-tb`）。
  - `dockBox(w)`：挪到列表最后（所有消息和「思考中」之后），加 `dock`。
  - `settleBox(w)`：去掉 `dock`，用 `put` 挪到这时候的最后（第一个 `dock` 前面）。
  - `liveAnchor()`：返回「思考中」那一行，没有就返回第一个 `.xc-tbw.dock`；`put` 插在它前面。
  - `endedBox(t)`：历史里给做完的活在当前位置画一个落下的框（已有就不画）。
- Consumes: `tLive(t)`、`paintBox(b)`、`contMsg(run, cls)`、`putAfter(e, ref)`（都已有）。

- [ ] **Step 1: 改/加测试**（part2，mock 已有的 `st['tasks']`、`st['conv_hist']`）：
  - 派活以后：`b.closest('.xc-tbw')` 存在、带 `dock`、是 `.xc-msgs` 的最后一个元素，前一个兄弟是「好，我去编一下。」那条回答；框不在任何有 `.xc-bub` 的消息里；`.xc-msgs .xc-who` 只有 1 个。
  - 接着发一句（mock 回一句）：新回答在框上面，框仍是 `.xc-msgs` 最后一个元素。
  - 做完（`status='done'`、`delivery='delivered'`）：框不带 `dock`、收成一行「用时 2 分钟」，它后面紧跟结果（`.xc-tres`，`cont`、没有 `.xc-who`），结果是最后一个元素；不再冒顶上的提示。
  - `waiting` → `running`：框回到最后并带 `dock`；再 `done`：框和结果落在最后。
  - 结果文字先到（`conv` 里来一轮 `taskResult`，任务状态还没轮询到）：框先落下、结果在框后面。
  - 刷新：历史里派活那一轮的回答里没有框；框和结果在转达那一轮（按结束时间）的位置，框的下一个兄弟是结果；在做的活刷新后在最后带 `dock`。
  - 「更早的消息」翻出含这件活 `task` 事件的老轮次：`.xc-tb[data-tsid]` 仍只有 1 个。
- [ ] **Step 2: 跑 part2，确认这些先红。**
- [ ] **Step 3: 实现 Interfaces 里的几个函数**：`taskBox(sid, run, fresh)` 在做的建 `.xc-tbw` 并 `dockBox`，不在做的不画（历史里由 `endedBox` 画）；`paintBox` 在做且不带 `dock` → `dockBox`，不在做且带 `dock` → `settleBox`；`typing(true)` 插在第一个 `dock` 前面；`resultAfter(sid)` 遇到带 `dock` 的先 `settleBox`，返回框后面最后一条同 `tsid` 的结果（没有就返回框）；`openSession` 里结束时间到了先 `endedBox(t)` 再 `drawTaskResult(t)`；`earlierBtn` 去掉临时列表里和现有列表重复的 `.xc-tbw`。`boxHost`/`.xc-tbh` 只留给 `procLine`。
- [ ] **Step 4: CSS**：`.xc-tbw` 用 `.xc-ai.cont` 的排法（头像那一栏隐藏），手机上框占满整行（沿用 `.xc-ai > .xc-tb` 那两条）。
- [ ] **Step 5: 跑 part2、`stm32_e2e.py`（`TASK_RES_JS` 要求结果是最后一个元素）、`xin_work_e2e.py`，全绿。**
- [ ] **Step 6: 提交** `site/xin/chat.js site/xin/chat.css test/e2e/xin_term_e2e.py`。

### Task 3: 全量验证、截图、文档、上线

**Files:**
- Modify: `docs/CHANGES.md`（新条目）、`README.md`（任务框那一段）、`docs/AI-HANDOFF.md`（这一轮，加 #162 正式运行第三次偶发失败：常驻进程模式「Gemini 后台主动说一句」c[1] 是 `acp`）。

- [ ] **Step 1: `npm run check`、`XIN_RUN_ATTEMPTS=1 npm run test:kernel`、`npm run test:e2e`（起本地预览）全过。**
- [ ] **Step 2: 截图自查**：1280、1024、768、390，浅色和深色——派活后接着聊（框在最底下）、做完（框和结果在最后）、终端打开（直接停在最新一步）。
- [ ] **Step 3: 写文档**（参考写进 CHANGES 和 PR：Claude Code 命令行的后台任务、tmux attach、impeccable / frontend-design / ui-ux-pro-max）。
- [ ] **Step 4: 提交、推送、开 PR → CI 和测试站全绿 → squash 合并 → 正式运行全绿、线上 chat.js/chat.css/term.js 和 main 一致 → 向站长汇报。**
