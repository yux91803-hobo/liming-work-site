# 天启 v4 第 2 个 PR：权限预设和计划模式（实现计划）

> 执行方式：Native（Claude Code 在同一会话里实现）。实现时的取舍：计划卡片、右栏计划和设置的默认权限都做在这个 PR 里；按钮刷新改成「按画的那一刻在不在做」比对（一轮很快做完时定时检查看不到「在做」）。站长的长期规矩是 AI 从写代码到上线全流程完成（CLAUDE.md）。

**目标**：天启每一轮按选的权限跑 Harness（只读 / 工作区内修改 / 完全权限）；计划模式那一轮用只读沙箱只出计划，站长点「按计划执行」再按对话的权限动手。

**做法**：控制器每一轮给 `dsh --profile headless` 带 `--permission-mode <预设> --approval-policy never`，环境变量 `DSH_PERMISSION_MODE` 同步成这个预设；对话记住自己的权限；计划那一轮固定 `read-only`，任务前面加计划要求（照 Harness 自带计划模式的 `section` 改写）。网页在输入框加「权限」「计划」两个按钮、计划卡片、右栏「计划」标签和设置里的「默认权限」。

**规格**：docs/superpowers/specs/2026-11-19-tianqi-harness-workbench-design.md（第 3 节控制表、第 4 节第 2 个 PR）。

## li2 核对结论（11-19，只读核对 + 三轮探测对话）

- Harness 基础配置（`dsh-base/cordis.patch.yml` 的 `permission`）已经有三档：read-only（ask）、workspace-write（ask）、danger-full-access（never），不用再写补丁。规格里「补丁里加 read-only」改掉。
- li2 没装 bwrap；内核 LSM 里有 landlock，Harness 自带 `landlock-run`，Linux 的执行器顺序是 bwrap → Landlock，所以用的是 Landlock。
- 实测：只读下 bash 写工作目录里外都被拒（`[sandbox: file access denied under read-only mode]`），write 工具也被拒；工作区内修改下工作目录里能写、外面被拒。
- `--permission-mode` 覆盖会话保存的选择；续聊时要每一轮重复带（`dsh-headless` README）。`--approval-policy never` 让需要批准的操作直接被拒。

## Global Constraints

- 默认仍是完全权限（`danger-full-access`），和现在一样；旧对话没有记录权限的按完全权限。
- 计划那一轮一律 `read-only`，不管对话权限是什么。
- 不认识的权限值直接报错（`bad_perm`），不悄悄放宽。
- 只对天启（Harness 对话）生效；小芯的 Codex 对话忽略这两个字段。
- 文案：只读 / 工作区内修改 / 完全权限（原型 v4 的叫法；Harness 中文界面把只读叫「仅可查看」）。

## Review Focus

1. 计划那一轮在对话权限是完全权限时仍然是只读（ARGS 和环境变量都是 read-only）。
2. 续聊（`--session-id`）每一轮都重复带权限参数。
3. 只读对话里「按计划执行」不能点，并说明要先换权限。
4. 打开旧对话：按钮显示这个对话记下的权限；新对话用设置里的默认权限。
5. 刷新后旧的计划轮次还能看到计划卡片和「计划」标签，只有最新、后面还没执行过的计划能点「按计划执行」。

---

### Task 1：控制器每一轮带权限，计划那一轮只读

**Files**：`site/xin/vm-agent.mjs`（send、agentArgs、launch 的 env）、`site/xin/vm-persona.mjs`（harnessEnv、计划要求文字）、`site/xin/vm-kernel-controller.mjs`（send 摘要带 perm / plan）、`test/xin.test.cjs`

**Produces**：
- `HARNESS_PERMS = ['read-only','workspace-write','danger-full-access']`（vm-persona.mjs 导出）
- `harnessEnv(perm)` → `{ DSH_PERMISSION_MODE: perm || 'danger-full-access', XIN_HARNESS_KEY }`
- `TIANQI_PLAN`：计划要求文字（vm-persona.mjs 导出）
- 会话 `s.perm`；运行 meta `perm`、`plan`；user 事件 `plan: true`；done 事件 `plan: true`

- [ ] 写失败的测试（xin.test.cjs 的 Harness 用例里加）：
  - 默认一轮：ARGS 含 `[--permission-mode] [danger-full-access] [--approval-policy] [never]`，`MODE=danger-full-access`
  - `perm: 'workspace-write'`：参数和 MODE 都是 workspace-write；`history.session.perm === 'workspace-write'`；下一句不带 perm 仍是 workspace-write
  - `plan: true`（对话是 workspace-write）：参数和 MODE 是 read-only；dsh 收到的任务以计划要求开头；user 事件 `plan === true`；done 事件 `plan === true`；会话权限还是 workspace-write
  - `perm: 'root'` → `{ error: 'bad_perm' }`，没起进程
- [ ] 跑测试看它失败
- [ ] 实现
- [ ] 跑 `node --test test/xin.test.cjs` 和 `npm run check`
- [ ] 提交

### Task 2：输入框的权限和计划按钮、设置里的默认权限

**Files**：`site/tools/tianqi/index.html`、`site/tools/tianqi/sky.js`、`site/tools/tianqi/workbench.css`、`site/xin/chat.js`（只加天启模式的挂载点）、`test/e2e/xin_tianqi_e2e.py`

**Consumes**：Task 1 的 `perm` / `plan` 字段、`history.session.perm`

**Produces**：
- chat.js：发送时 `payload.perm / payload.plan` 取自 `LimingXinChat.tqOpts()`（sky.js 提供）；打开对话后派发 `tq:session {perm}`；`LimingXinChat.say(text, opts)` 让 sky.js 代发「按计划执行」
- sky.js：`#tq-perm` 弹出三档（完全权限要再确认一次），`#tq-plan` 开关（输入框变蓝、绕框的星变蓝、占位字换），设置弹窗「默认权限」（`localStorage lm.tq.perm`）

- [ ] 写失败的 e2e：默认显示「完全」；选「只读」后发送的 payload 带 `perm: 'read-only'`；选「完全权限」要再确认；打开记着 workspace-write 的旧对话按钮显示「工作区」；开计划后 payload 带 `plan: true`、输入框有 `.plan`；设置里改默认权限后新对话用它
- [ ] 实现、跑 e2e、提交

### Task 3：计划卡片和右栏「计划」

**Files**：`site/xin/chat.js`（天启模式：用户消息上的「计划」标签；计划轮次结束派发 `tq:plan {run, text, el, last}`）、`site/tools/tianqi/sky.js`、`workbench.css`、`test/e2e/xin_tianqi_e2e.py`

- [ ] 写失败的 e2e：计划轮次结束后回答下面有计划卡片（标题取第一行 `# 标题`）、右栏出现「计划」标签并打开；点「按计划执行」发出 `plan` 为空、`perm` 是对话权限的一句；只读对话里这个按钮不能点并有说明；「继续改计划」打开计划模式并聚焦输入框；刷新后卡片还在，旧计划没有执行按钮
- [ ] 实现、跑 e2e、提交

### Task 4：文档、截图、全量验证、上线

- [ ] 规格第 3、4、7 节按 li2 核对结论改；docs/CHANGES.md、README 天启段、docs/AI-HANDOFF.md
- [ ] `npm run check`、`npm run test:e2e`；四个宽度深浅截图（权限弹层、计划模式、计划卡片、右栏计划）
- [ ] PR → CI、测试站 → 合并 → 正式站 Deploy 绿 → 正式站联调（li2 上一轮只读、一轮计划）
