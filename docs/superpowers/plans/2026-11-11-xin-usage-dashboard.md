# 小芯用量看板（PR 2）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 小芯头像外的额度光环、点开的额度卡、工作台里的简版「用量」页。

**Architecture:** 控制器新模块 `vm-usage.mjs` 放纯函数（额度窗口、消耗速率预测、光环等级、按北京日汇总 token）；`vm-agent.mjs` 加 `usage` op、在 `tasks` 返回里带 `glow`、额度读数追加到 `quota-history.jsonl`。网页在 `chat.js` / `chat.css` 里加光环、额度卡和用量页，不加新入口。

**Tech Stack:** Node 22、原生 JS + CSS（内联 SVG 图表）、Python Playwright。

**Spec:** `docs/xin-reliability-usage-design.md` 的 B 部分（站长 2026-11-11 选「光环 + 额度卡 + 简版统计」）。

## Global Constraints

- 新 op `usage` 同时登记在 `src/xin.js` 的 `OPS` 和 `vm-agent.mjs` 的 `ops`。
- 光环阈值照 Agent HUD：已用 < 70% 绿，≥ 70% 黄，≥ 90% 红，用完红并变暗；没有读数不上色。
- 额度窗口：id 以 `-5h` 结尾是「5 小时」，以 `-weekly` 结尾是「每周」；Opus 用 `front-antigravity-quota.json`，Gemini 用 `antigravity-quota.json`。
- 预测：同一窗口（重置时间相同）最近 2 小时的读数算速率；最新读数超过 30 分钟不预测；预计用完晚于重置时间不显示。
- `model-stats.jsonl` 上限改为 2 MB / 8000 条。
- 颜色走现有浅色/深色变量；`prefers-reduced-motion` 时不动画。
- 改页面要截图自查：1280、1024、768、390，浅色和深色。

## Review Focus

1. 重置时间已过的旧读数：按「已重置」显示、已用 0%，光环不能还停在红色（Task 1 测试）。
2. 只有一个模型有读数、另一个文件不存在或坏了：只显示有的那个，不报错（Task 1 测试）。
3. 手机宽度 390：额度卡从底部滑出、不溢出；Esc 和点遮罩都能关（Task 2 浏览器测试）。
4. 首页卡片标题原来整块是按钮：拆出头像按钮后，键盘 Tab 顺序和读屏标签都对（Task 2 浏览器测试）。
5. 30 天里有几天没有数据：柱状图那几天画空柱，不压缩时间轴（Task 3 浏览器测试）。

---

### Task 1: 控制器的用量数据

**Files:**
- Create: `site/xin/vm-usage.mjs`
- Modify: `site/xin/vm-agent.mjs`（`statAdd` 上限；`iops.front_quota`、`iops.agy_quota` 追加读数；`ops.usage`；`bgInfo` 带 `glow`）；`src/xin.js`（`OPS` 加 `usage`）
- Test: 新建 `test/xin-usage.test.cjs`；`test/worker.test.cjs` / 现有 op 登记一致性测试照常通过

**Interfaces:**
- Produces（vm-usage.mjs）：
  - `export function quotaWindows(quota, now): Array<{id, kind:'5h'|'week'|'other', used:number, resetAt:number, reset:boolean}>` —— `used = 1 - remaining`；`resetAt <= now` 时 `used=0, reset=true`。
  - `export function forecast(samples, window, now): number|null` —— `samples: Array<{at, id, remaining, resetAt}>`；返回预计用完的时间戳或 `null`。
  - `export function glowLevel(quotas, now): 'ok'|'warn'|'high'|'out'|null`
  - `export function usageSummary(lines, now): {days: Array<{date, models: {[model]: {input, cached, output, runs}}}>, totals: {today, d7, d30}, since: number|null}` —— 日期按北京时间；`days` 固定 30 个，没数据的日子 `models` 为空对象。
- `ops.usage()` 返回 `{quotas: [{key:'opus'|'gemini', name, checkedAt, windows: [...+ forecastAt]}], ...usageSummary}`。
- `tasks` / `greet` 的 `bgInfo` 多一个 `glow` 字段。
- `quota-history.jsonl`：每行 `{at, model, id, remaining, resetAt}`，留 14 天、最多 2000 行。

- [ ] **Step 1: 写失败的测试**（`test/xin-usage.test.cjs`）：
  - `窗口识别和已重置`：`gemini-5h` → `5h`，`gemini-weekly` → `week`；重置时间已过 → `used 0, reset true`。
  - `光环分级`：已用 0.69 → `ok`，0.7 → `warn`，0.9 → `high`，1 → `out`，没有读数 → `null`；取所有窗口里最高的。
  - `预测`：2 小时内两次读数 remaining 0.8 → 0.6、相隔 1 小时 → 预计 3 小时后用完；最新读数 31 分钟前 → `null`；预计晚于重置 → `null`；只有一次读数 → `null`。
  - `按北京日汇总`：UTC 15:59 和 16:01 的两条分属两天；今天/7 天/30 天合计；缓存命中只按有 `cached` 的算；30 个日子齐全。
  - `usage op`（起控制器）：只有 Opus 文件时只返回 Opus；文件坏了不报错。
- [ ] **Step 2: 跑测试确认失败。** `node --test test/xin-usage.test.cjs`
- [ ] **Step 3: 实现 `vm-usage.mjs` 和接线**；`front_quota`、`agy_quota` 写完合并后的额度，再把每个窗口追加一行到 `quota-history.jsonl`。
- [ ] **Step 4: 跑 `npm test` 全过。**
- [ ] **Step 5: 提交** `git commit -m "小芯用量：控制器汇总额度、预测和每天的 token"`

### Task 2: 光环和额度卡

**Files:**
- Modify: `site/xin/chat.js`（`avatar` 加光环外圈和等级 class；首页卡片标题拆出头像按钮；聊天标题头像变按钮；额度卡组件）、`site/xin/chat.css`
- Test: 新建 `test/e2e/xin_usage_e2e.py`；`package.json` 的 `test:e2e` 和 `.github/workflows/deploy.yml` 的 e2e 步骤各加一行

**Interfaces:**
- Consumes: `tasks` 返回的 `glow`；`usage` op。
- 光环 class：`.xc-glow` + `g-ok|g-warn|g-high|g-out`，干活时加 `busy`（有进行中的任务或当前轮在回话）。

- [ ] **Step 1: 设计**：先按 CLAUDE.md 加载 `anthropic-skills:impeccable`（或 frontend-design）看现有像素风格（`site/pixel.css`、`site/shell.css`、`chat.css` 的变量），定光环粗细、颜色变量、呼吸节奏、额度卡布局；数据条和时间标注按 `dataviz` 技能的规范。
- [ ] **Step 2: 写失败的浏览器测试**（`xin_usage_e2e.py`，用 `ui.xin_mock` 拦接口）：光环颜色随 `glow` 变；`busy` 时有加快的动画（`prefers-reduced-motion` 下没有）；点首页头像出额度卡、点卡片其余部分仍进工作台；卡片里 Opus 两个窗口、重置时间、预测一行、「x 分钟前读取」；Esc 关闭；390 宽度从底部滑出、不横向溢出；Tab 能到头像按钮、读屏标签是「额度」。
- [ ] **Step 3: 跑测试确认失败。** `npm run dev` 后 `python3 test/e2e/xin_usage_e2e.py`
- [ ] **Step 4: 实现。**
- [ ] **Step 5: 跑 `xin_usage_e2e.py`、`xin_work_e2e.py`、`xin_main_e2e.py` 全过；截图自查四个宽度、浅色深色。**
- [ ] **Step 6: 提交** `git commit -m "小芯头像的额度光环和额度卡"`

### Task 3: 工作台「用量」页

**Files:**
- Modify: `site/xin/chat.js`（`.xc-wk-hd` 加切换按钮；`renderWork` 按 `S.wkView` 渲染用量页）、`site/xin/chat.css`
- Test: `test/e2e/xin_usage_e2e.py`

**Interfaces:**
- Consumes: `usage` op；Task 2 的额度卡组件（复用）。
- `S.wkView: 'tasks'|'usage'`，存 `localStorage` 键 `lm.xin.wkView`。

- [ ] **Step 1: 写失败的浏览器测试**：标题栏按钮在「任务」「用量」间切换；用量页有额度卡、「今天 / 7 天 / 30 天」切换（切换不再发请求）、合计 token、缓存命中率、轮数、30 天柱状图（30 根，没数据的日子是空柱）、按模型列表；打开时只请求一次 `usage`，开着时 60 秒后再请求；四个宽度不溢出。
- [ ] **Step 2: 跑测试确认失败。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑全部浏览器测试；截图自查。**
- [ ] **Step 5: 提交** `git commit -m "工作台的用量页"`

### Task 4: 文档、全量验证、开 PR、上线

- [ ] **Step 1: `docs/CHANGES.md` 加一条（参考 Agent HUD `README`、`docs/agent-contract.md` 的额度阈值和预测规则）；README 补用量看板。**
- [ ] **Step 2: `npm run check`、`npm run test:e2e` 全过。**
- [ ] **Step 3: 推分支、开 PR、订阅动态；检查和测试站绿 → 合并 → 正式站 Deploy 绿 → 向站长汇报。**
