# 天启照 Linear 改版：实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 天启工作台换成 Linear 那样克制的样子：实心分层面板、只留金色、系统字体、对齐收紧；插件页重做；Ctrl K 命令面板补全天启的操作和快捷键。

**Architecture:** 只动前端。
- 样式在 `site/tools/tianqi/workbench.css`：先换 `.xc.tq-mode` 上的那组变量，再改面板、弹层和各组件的规则。
- 天启自己的交互在 `site/tools/tianqi/sky.js`：命令面板里的操作、单键快捷键、流星的疏密。
- `site/xin/chat.js` 只加天启的挂载点：命令面板读 `LimingXinChat.tqActions()`，每项可带快捷键。

**Tech Stack:** 原生 JS、CSS；浏览器测试 `test/e2e/xin_tianqi_e2e.py`（Playwright）。

**Spec:** `docs/superpowers/specs/2026-11-20-tianqi-linear-design.md`

## Global Constraints

- 只改天启模式（`.tq-mode`、`html.tianqi`）的样子，小芯的工作台一点不变（`xin_web_e2e.py` 等照样全过）。
- 不加载任何外部字体或样式表（国内打不开 Google Fonts）。
- 配色数值照设计文档第 2 条；圆角 12 / 8 / 6；动效 120～200ms，不回弹。
- 资源版本号：改了 `workbench.css`、`sky.js`、`chat.js`、`chat.css` 就换 `?v=`（天启页和首页两处）。
- 不跳过、不删测试；样式检查跟着新样子改要写明为什么。

## Review Focus

1. 星图（浅色）下的对比度：三级、四级灰字在白底上不低于 4.5:1，金色界面元素不低于 3:1。
2. 手机上的插件页、命令面板：键盘弹出、横屏、很矮的屏幕时不出框，能滚。
3. 单键快捷键在输入框、文字框、可编辑区域里一律不触发；有弹层开着时不触发。
4. 去掉毛玻璃以后，中屏、窄屏浮起来的右栏和抽屉要实心，后面的对话不能透出来。
5. 减少动态：新动效都要在 `prefers-reduced-motion` 下关掉。

---

### Task 1：变量、面板和弹层（深浅两套）

**Files:** `site/tools/tianqi/workbench.css`；测试 `test/e2e/xin_tianqi_e2e.py`

- [ ] 先写失败的检查：三栏版面那项读 `.tq-glass` 的 `backdrop-filter` 应为 `none`，背景不透明（alpha = 1）；输入框 `.tq-box` 和弹层 `.tq-pop` 没有大阴影（box-shadow 里没有 80px）；左栏选中的对话行没有发光。
- [ ] 跑 `python3 test/e2e/xin_tianqi_e2e.py`，看它失败。
- [ ] 改 `.xc.tq-mode` 深浅两套变量（照设计文档第 2 条），`.tq-glass` 实心、去模糊，各弹层的圆角、阴影，焦点环用金色 1.5px。
- [ ] 再跑，通过。

### Task 2：字、左栏、顶栏、对话、输入框、右栏

**Files:** `workbench.css`；`site/tools/tianqi/index.html`（顶栏的工作区改成面包屑）；`sky.js`（`syncWork` 写面包屑）

- [ ] 先写失败的检查：天启根元素的 `font-family` 以 Inter / 系统字体开头，不含 Google Fonts；左栏对话行高 32px；顶栏标题和工作区在同一行（面包屑，中间一道 `/`）；右栏标签下划线没有阴影、过渡不超过 200ms。
- [ ] 跑，看它失败。
- [ ] 改：字体、字号、行高；左栏行、分组标题、底栏；顶栏面包屑；用户气泡和天启的回答；过程那一行；代码块；输入框和里面的按钮、发送键；用量那一行；右栏标签、终端、文件。
- [ ] 再跑，通过；截图 1280 / 390 深浅各看一遍。

### Task 3：插件页

**Files:** `workbench.css`；`site/xin/chat.js`（天启的插件页加说明行，分不出状态时写清楚）

- [ ] 先写失败的检查：手机 390 宽打开插件页，面板贴底（bottom = 视口高）、背景不透明、高度不超过内容加内边距（底下没有大块空白）；电脑上居中、宽 ≤ 440px；开关开着是金色。
- [ ] 跑，看它失败。
- [ ] 改样式和那一行说明。
- [ ] 再跑，通过。

### Task 4：命令面板

**Files:** `site/xin/chat.js`（`palActions` 在天启下合并 `LimingXinChat.tqActions()`；每项可带 `kbd`，画在右边）；`sky.js`（注册天启的操作和单键快捷键）；`workbench.css`

- [ ] 先写失败的检查：
  - 天启里 Ctrl K 打开，「常用」里有换模型、换权限、计划模式、切换工作区、打开终端，右边写着快捷键；
  - 在空白处按 C 开新对话、按 P 弹出权限；
  - 在输入框里打 c、p 只是打字，不触发。
- [ ] 跑，看它失败。
- [ ] 实现。
- [ ] 再跑，通过；小芯那边的命令面板照旧（`xin_web_e2e.py` 全过）。

### Task 5：夜空、流星，文档、截图、全量验证、上线

**Files:** `sky.js`（进了对话以后夜空暗一点、流星间隔拉长）；README、`docs/CHANGES.md`、`docs/AI-HANDOFF.md`

- [ ] 改夜空和流星；减少动态时不放。
- [ ] `npm run check`、`npm run test:e2e` 全过；1280 / 1024 / 768 / 390 × 夜空 / 星图截图自查。
- [ ] PR → CI、测试站 → squash 合并 → 正式站部署（含联调）→ 同步分支。
