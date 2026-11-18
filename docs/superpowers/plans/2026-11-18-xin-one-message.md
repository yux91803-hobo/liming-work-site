# 小芯：派活算一条消息、人设不讨好、前台思考强度高、终端等待动画 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 派活那一轮在页面上只算一条消息：话说出来之前框一直在动，框放最下面，没有「详情」。前台提示词去掉讨好、加上按事实纠正；前台用高思考强度；后台终端没输出时有等待动画。

**Architecture：** 后台流程不动。页面用任务记录里已有的 `delivery.state` 判断「整理结果」，消息分组用 `data-grp`。提示词在 `vm-persona.mjs` 原来的段落上删改。前台模型只改选哪一档。等待动画只在 `term.js` 和 CSS 里。

**Tech Stack：** 原生 JS（`site/xin/chat.js`、`term.js`）、CSS、Node 控制器模块（`vm-*.mjs`）、`node --test`、Playwright（Python）浏览器测试。

**Spec：** `docs/superpowers/specs/2026-11-18-xin-one-message-design.md`

## Global Constraints

- `site/xin/vm-agent.mjs` 行数只减不增（`test/xin-writers.json` 的 `agentLines`），只能原行改。
- 不新建 `site/xin/vm-*.mjs` 模块：冷启动子请求已经到 `xin.test` 的上限。
- 天启（`TQ`、`TIANQI`）的行为一律不变。
- 文案用中文，时间用北京时间。
- 不跳过、不删测试。旧断言如果是在守被站长改掉的行为，就换成守新行为的断言，并在 CHANGES 里写清楚。
- 浏览器测试用 `CHROMIUM_PATH=/opt/pw-browsers/...`，先 `npm run dev`。
- 平时不讲背后是什么模型、不编进度，这些站长以前定的规矩照旧。

## Review Focus

- 前台决定不说（`delivery.state === 'silent'`）时，框要停在完成，不能一直转。
- `delivery` 一直是 `pending`（转达卡住了）时，结束 10 分钟后框停下，不永远转。
- 一次派两件活、先后做完时，只在两件都说完以后、整条最后露一行操作。
- 等你确认的任务被回复后接着做时，框回到最底下；上面那条结果露出自己的复制键。
- 找不到派活那一轮的（历史没读到那么早、别处派的）任务，结果照样画，带头像和框。

---

### Task 1: 前台用高思考强度

**Files:**
- Modify: `site/xin/vm-front-agy.mjs`（`AGY_FRONT_PROVIDER` 和选模型那一行）
- Test: `test/xin-front-agy.test.cjs`

- [ ] 改测试：
  - 原来断言 `set_model` 是 `gemini-4-hydrogen-medium`（「思考强度默认中」），改成 `gemini-4-hydrogen-high`（「思考强度默认高」）。
  - 夹具加一种模式 `nohigh`，只列中档。新测试「账号里没有高档就用中档」断言 `set_model` 是 `gemini-4-hydrogen-medium`。
  - `alias` 模式（编号是别名）按名字认出 High。
- [ ] 跑 `node --test test/xin-front-agy.test.cjs`，看到失败。
- [ ] 实现：`AGY_FRONT_PROVIDER = AGY_MODEL + '-high'`。选模型的顺序：
  1. 编号等于 high；
  2. 名字是 Hydrogen 加 high；
  3. 编号等于 medium；
  4. 名字是 Hydrogen 加 medium；
  5. 都没有，照旧改用 DeepSeek。

  文件头注释写 high。
- [ ] 再跑，全过；然后 `npm test` 全过。提交。

### Task 2: 人设不讨好

**Files:**
- Modify: `site/xin/vm-persona.mjs`（`REMIND`、`XIN_WHO`、`VALUES`、`VOICE`、`FRONT_WORK`、`FRONT_TRACK` 和两个 `systemPrompt` 组合）
- Create: `test/xin-persona-honest.test.cjs`
- 可能修改：`test/xin.test.cjs:476-485`，只在它守的是被改掉的原话时改。

- [ ] 先写测试（读 `vm-persona.mjs`，`systemPrompt(mem, { tasks: true, materials: false })` 和 `systemPrompt(mem)`）：
  - 「前台提示词没有讨好的性格描写」：两个提示词都不含 `温暖`、`俏皮`、`被理解`、`被鼓励`、`陪伴`、`跟着他的情绪`、`先说句人话`、`表现出兴趣`、`能顺手替他接走`，都含 `你是小芯`。
  - 「说实话，不讨好」：两个都含 `## 说实话，不讨好`、`直接指出哪里不对`、`只有新的事实或更好的理由才改口`、`换个问法`、`「你说得对」`，以及「听完还要那样做就照做」。
  - 「派活照实说派后台」：前台提示词含 `我派后台去`、`不说「有结果了告诉你」`，不含 `一句话应下来`。
  - 「转达结果先说结论」：前台提示词含 `先说结论`，不含 `用第一人称告诉他`。
  - 「REMIND 不再让它说我来做」：`REMIND` 不含 `我来做`、`只需说好`、`委派细节`，含 `不编造`。
- [ ] 跑 `node --test test/xin-persona-honest.test.cjs`，看到失败。
- [ ] 按设计「二、人设」改 `vm-persona.mjs`：
  - 新段 `HONEST`（`## 说实话，不讨好`，五条，参数 `u`），放在两个 `systemPrompt` 组合里原来 `VALUES` 的位置。
  - `XIN_WHO` 只留身份、第一人称、只替兄弟做事。
  - `VOICE` 删掉讨好的几条，把「称呼他「兄弟」」改成「可以叫他「兄弟」，不用每条开头都叫」。
  - `FRONT_WORK` 第 2 条照实说派后台。
  - `FRONT_TRACK` 的转达改成「先说结论再说要点」。
- [ ] 跑新测试、`test/xin-muse-rules.test.cjs`、`test/xin.test.cjs`、`test/xin-front.test.cjs`，全过；然后 `npm test` 全过。提交。

### Task 3: 派活算一条消息

**Files:**
- Modify: `site/xin/chat.js`：
  - `tLive` 旁边加 `tBusy(t)`；
  - `taskVerb`；
  - `paintBox` 改成看 `tBusy`、用 `endAt(t)` 算用时；
  - `taskBox` / `dockBox` / `settleBox` 记分组；
  - `drawTaskResult` 和 `draw()` 里 `ev.taskResult` 那段合成一个放结果的办法：结果放在框前面，框后面接操作行；
  - `taskActs` 去掉「详情」，挂到框那条上；
  - `draw()` 的 `ev.t === 'task'` 记 `S.tdisp[sid] = run`；
  - 一个 `syncGrp()`，给「下一条和自己同一分组」的元素打 `.held`，同一分组里在做的框不露操作行。
- Modify: `site/xin/chat.css`：第 191 行那条改成看 `.held`；框那条的 `.xc-acts`。
- Modify: `site/xin/vm-agent.mjs`：`handoffFinish` 里 `emit(... taskResult:{...})` 那一行原地加 `deliveredAt:t.delivery.at`。
- Test: `test/e2e/xin_term_e2e.py`（11-17 那几段框的位置断言换成新排法）、`test/e2e/stm32_e2e.py`（`TASK_RES_JS`，以及点「详情」那一步改成从任务列表打开详情）、`test/e2e/xin_work_e2e.py:323`；转达事件带 `deliveredAt` 的单元测试加在已有的转达测试里。

- [ ] 先改、加浏览器断言（`xin_term_e2e.py`，模拟接口照原来的写法）：
  1. 「派活那条在做时不露操作行」：派活那条的 `.xc-acts` 是 `display: none`。
  2. 「做完、前台还没说：框还在动，写『整理结果』，秒数接着走」：任务记录 `status: 'done'`、`delivery: {state: 'pending'}` 时，框有 `.live`，`.xc-tb-s` 是 `整理结果`。
  3. 「话出来以后：结果接在派活那句下面，框在结果下面，最后一行只有复制」：`.xc-tres` 后面紧接着那件活的 `.xc-tbw`，`.xc-tbw` 是列表最后一条；能看见的操作按钮只有 `['复制']`；整个列表没有「详情」。
  4. 「用时算到话说出来」：框写 `用时 <deliveredAt - startedAt>`。
  5. 「插话时：结果另起一条带头像，派活那条露出复制键」。
  6. 「刷新以后同样的排法」。
  7. 「复制整条：派活那句加结果」：点复制，剪贴板里两段都有。
- [ ] 起 `npm run dev`，跑 `python3 test/e2e/xin_term_e2e.py`，看到上面这些失败。
- [ ] 实现 `chat.js`、`chat.css`、`vm-agent.mjs` 那一行。
  - `tBusy(t) = tLive(t) || (t.delivery && t.delivery.state === 'pending' && Date.now() - (t.endedAt || 0) < 600000)`。
  - `endAt(t)`：`delivery` 是 `delivered` 或 `silent` 时取 `delivery.at`，否则取 `endedAt`。
  - 结果文字先到、任务记录还说 `pending` 时，本地把 `S.tinfo[sid].delivery` 记成 `delivered`，`at` 取事件的 `deliveredAt`，没有就取 `Date.now()`。
- [ ] 跑 `xin_term_e2e.py`、`stm32_e2e.py`、`xin_work_e2e.py`、`xin_web_e2e.py`、`xin_main_e2e.py`，全过；`npm test` 全过。提交。

### Task 4: 终端等待动画

**Files:**
- Modify: `site/xin/term.js`：
  - `paint()`：在做、记录里还没有一行时，在 `view.log` 前面放 `.tm-wait`，里面 14 个 `<i style="--i:n">`；
  - `put()`：放第一行前淡出拿掉 `.tm-wait`；
  - `ending()`：不在做了就拿掉；
  - `scene()`：天上加一颗流星 `.tm-meteor`。
- Modify: `site/xin/chat.css`：
  - `.tm-wait`：琥珀色光扫过一排方块；
  - `.tm-live` 时云来回飘、流星隔一会儿划过；
  - 「减少动态」时都不动。
- Test: `test/e2e/xin_term_e2e.py`

- [ ] 先写断言：
  1. 「后台还没输出：提示行下面一排方块在扫」：打开在做、没有事件的任务终端，`.tm-wait i` 有 14 个，动画名是 `tmscan`；`.tm-live .tm-cl1` 有动画。
  2. 「来了第一行，方块拿掉」：推一条事件后 `.tm-wait` 没了。
  3. 「做完的终端没有方块，夜景不动」。
  4. 「减少动态：方块不动」。
- [ ] 跑，看到失败。
- [ ] 实现。截 390、1280 的图看效果，调方块大小、速度和流星的间隔。
- [ ] 跑 `xin_term_e2e.py`，全过。提交。

### Task 5: 文档、全量验证、截图、上线

- [ ] 写文档：
  - `docs/CHANGES.md` 加新条目：四件事、参考的项目和文件、改掉的旧断言及原因；
  - `README.md` 里讲小芯聊天的那段如果写到「详情」或性格描写，就跟着改；
  - `docs/AI-HANDOFF.md` 加新条目；
  - 设计文档的状态改成「已上线」，等合并后再改。
- [ ] `npm run check` 和 `CHROMIUM_PATH=… npm run test:e2e` 全过。
- [ ] 截图：派活那条（在做、整理结果、说完）和终端等待，1280、1024、768、390，浅色、深色。
- [ ] 按 `code-reviewer.md` 自查整条分支，Review Focus 那几条逐条过一遍。
- [ ] 开 PR，等 CI 和测试站都绿，用 `expectedHeadSha` 压成一个提交合并，确认正式站那次 Actions 运行是绿的，用中文向站长汇报。
