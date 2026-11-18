# 小芯工作台动画 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal：** 修掉动画体检里发现的 4 个问题，按站长确认的 7 条做出新的像素风动画。

**Spec：** `docs/superpowers/specs/2026-11-19-xin-motion-design.md`

## Global Constraints

- 只用 CSS 和原生 Web Animations，不加库。
- 每个新动画都要在 `@media (prefers-reduced-motion: reduce)` 下关掉。现有的总开关规则在 `chat.css` 末尾，把新的类名加进去。
- 不改行为和排法：已有的 e2e 断言只在动画名或时长变了的地方跟着改，改的地方写进 CHANGES。
- 每个任务都在 `test/e2e/xin_term_e2e.py`（或相关文件）加断言：查动画名、类名，「减少动态」下没有动画。

## Review Focus

- 刷新、翻历史时不重放进场动画（只给新来的元素加）。
- 动画进行中又来了新状态（框在搭的时候任务就做完了）：最后的样子要对。
- 手机和电脑都要看，浅色、深色都要看。

---

### Task 1: 首页不闪；从首页进工作台用像素溶解过渡

- **`site/index.html` 头部的内联脚本**：网址带 `#xin-work` 时给 `<html>` 加 `xc-boot-work`，3 秒后无论如何都去掉。
- **CSS**：`.xc-boot-work #home{visibility:hidden}`。
- **`chat.js`**：工作台显示出来时（`work()` 里加 `.show` 之后）去掉 `xc-boot-work`。
- **从首页点进工作台**：浏览器支持 `document.startViewTransition` 时，打开工作台包在里面，用像素格溶解的 `::view-transition-*` 动画（`xcdissolve`）。
- **测试**：
  - 带 `#xin-work` 打开时，首页一帧都没露出来（`requestAnimationFrame` 采样 `#home` 的 visibility）；
  - 「减少动态」时不做 view transition。

### Task 2: 发消息飞上去；回答一段段淡入

- **用户气泡**：`draw()` 画新的一条 user 消息（`!old`）时，从输入框的位置做 FLIP，动画名 `xcfly`，约 0.32 秒。
- **小芯的回答**：新来的 AI 消息（`.enter`）里 `.xc-bub` 的直接子元素依次淡入（`xcline`，每段间隔 45ms，最多算到第 8 段），整条有一道微光扫过（`xcshine`，`::after`）。
- **测试**：
  - 新发的气泡动画名是 `xcfly`；
  - 回答的段落动画名是 `xcline`，延迟依次变大；
  - 历史里的消息没有这些动画。

### Task 3: 任务框搭起来、彗星绕边、✓ 盖章和火花、结果滑进来

- **出现**：`.xc-tb.enter` 用 `xcbuild`，`clip-path` 一格格从左到右。
- **在做**：`.xc-tb.live::before` 是 `conic-gradient` 加遮罩只留边框，`@property --xc-ang` 动画 `xcorbit`。
- **做完**：
  - `paintBox` 从在做变成 done 时加 `.stamp`：✓ 用 `xcstamp`，并在框里加 6 个 `.xc-spark`（`xcspark`，0.6 秒后删掉）；
  - 只在亲眼看到它从在做变成做完时才盖章，刷新以后不盖。
- **结果进来**（`placeResult`）：新结果加 `.enter`；框先记下原来的位置，挪完以后做 FLIP 平滑滑下去（`transform` 动画）。
- **测试**：
  - 新派的框动画名是 `xcbuild`；
  - 在做时 `::before` 的动画名是 `xcorbit`；
  - 做完那一下有 `.stamp`、出现 6 颗火花、过一会儿火花没了；
  - 结果动画名是 `xcin`。

### Task 4: 终端像老显示器开机、关机

- **电脑**：`.tm-win.tm-in` 用 `tmcrt`（约 0.34 秒，横线展开），`.tm-win.tm-out` 用 `tmcrtoff`（约 0.26 秒，缩成线再缩成点）。`term.js` 关窗口的等待时间从 160ms 改成 280ms。
- **手机**：底板照旧用 `tmup`，内容加 `tmscanline`（扫描线闪一下）。
- **测试**：电脑上打开的动画名是 `tmcrt`，关上是 `tmcrtoff`；原来断言 `tmpop` / `tmpopx` 的地方改掉。

### Task 5: 小芯岛鼓一下、亮一圈光

派出新活（`taskBox` 的 fresh）和活做完（`setTasks` 的 changed）时，给 `.xc-isle` 加 `.pulse`（`xcbump` 加 `::after` 光环 `xcring2`），动画结束就去掉。

测试：派活后小芯岛出现 `.pulse`，动画名对；「减少动态」时不加。

### Task 6: 小方点呼吸、错开节拍

把 `xcpix`、`xwblink` 的硬闪改成呼吸（`xcbreathe`：亮度和发光柔和地起落）。节拍用 `animation-delay` 按 `--n` 错开：JS 给这些点挂 `--n`，或者用 `:nth-child` 规则。

测试：同一页上两个点的 `animation-delay` 不一样。

### Task 7: 深浅色切换从按钮扩散开

`chat.js` 命令面板里的「换成深色 / 浅色」和 `shell.js` 首页的主题按钮都包进 `document.startViewTransition`，点的位置写进 `--vt-x`、`--vt-y`，`::view-transition-new(root)` 用分步的圆形 `clip-path` 揭开（`xcreveal`）。浏览器不支持或开了「减少动态」时直接换。

测试：在支持 View Transitions 的 Chromium 里切换主题时调用了 `startViewTransition`（在测试里包一层记次数）。

### Task 8: 验证和上线

- `npm run check`、`npm run test:e2e` 全过。
- 用截屏流逐帧拼图看手机和电脑上的效果，再截 1280、1024、768、390 的浅色和深色。
- 更新 CHANGES、README、交接记录。
- 开 PR，合并，确认正式站是绿的。
