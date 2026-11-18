# 小芯前台自己查简单的资料、查的时候能插话 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal：** 前台遇到几下就能查到的事，自己用 Antigravity 的 `search_web` 和 `read_url_content` 查完再答；查的时候站长说的话，在下一步就送进这一轮。

**Architecture：**
- 前台的 Antigravity 代理只多两个工具：`search_web`、`read_url_content`。
- 权限请求只批这两个，其余照旧 `cancelled`。
- 网页工具的调用记成这一轮的 `tool` / `tool_end` 事件，「思考中」那一条和终端里就能看到在搜什么、读哪个网页。
- 插话：前台这一轮里出现过网页工具时，每秒取一次补充（`steer_take`）。手上没有在跑的工具调用时，`session/cancel` 当前这次 prompt，接着在同一个会话里发「兄弟中途补充：……」，会话里已经查到的东西还在。
- 时限：查资料的一轮最多 3 分钟。到了就取消，再要一句「按已经查到的回答，查不完的派后台」。

**li 上实测（11-18 晚，站长同意做试验，试验代理和临时目录都已删）：**
- `search_web` 的工具调用：`kind: "search"`，`title` 是「"搜索词" on Web」，`rawInput` 是 `{query}`。按全局设置不来要权限，直接跑；一次搜索约 30 秒。
- 取消后接着问：等这次工具调用完成，`session/cancel`，这次 prompt 返回 `stopReason: cancelled`。等 3 秒，在同一个会话里发补充，约 13 秒答完，而且直接用了刚才的搜索结果，没有重搜（实测 A）。
- 不要在上一次 prompt 还没结束时发新的 prompt，会一直卡住（实测 B，以及第一次试验取消后马上发的那次也卡住了）。所以插话一律是「等工具完成，取消，等返回，隔 3 秒，同一个会话里接着发」。
- 这个版本的 Antigravity（1.5.11）没有 `--settings` 参数，ACP 方法里也没有插话接口。

**Spec：** `docs/superpowers/specs/2026-11-18-xin-front-lookup-design.md`

## Global Constraints

- `site/xin/vm-agent.mjs` 行数只减不增，只能原行改；不新建 `site/xin/vm-*.mjs`。
- 前台不能读写文件、跑命令、登录、下载；白名单之外的工具一律 `cancelled`。
- 没跑过 li 的实际探测（li 只读），白名单按工具名认（标题、`rawInput`、`toolCallId` 里出现 `search_web` / `read_url_content`）。正式站联调加一步「前台自己查」来验证。
- 天启不变；DeepSeek 兜底时没有网页工具，照旧派后台。

## Review Focus

- 权限请求里认不出工具名时，一律拒，不靠 `kind` 猜。
- 插话正好赶上工具调用在跑：等它结束再取消，不丢已经查到的结果。
- 一轮里多次插话：每次都只取还没送的，补充按顺序送进去。
- 3 分钟时限到了：取消后只再要一句收尾，不再查。
- 没用到网页工具的普通聊天：不轮询补充，时限照旧 65 秒。

---

### Task 1: 只放开两样网页工具，网页步骤记进这一轮

**Files:**
- `site/xin/vm-front-agy.mjs`：代理定义的 `tools` 加两个；`INSTRUCTION` 写清能用这两个查公开网页、别的原生工具都不能用；`session/request_permission` 按白名单选 `allow_once`；把 `tool_call` / `tool_call_update` 翻成 `tool` / `tool_end`，`name` 写 `WebSearch` / `WebFetch`，`detail` 写搜索词或网址。
- `test/xin-front-agy.test.cjs`：假 ACP 加 `web` 模式。

测试：
- 先发 `search_web` 的权限请求，回应是 `selected` 加上 allow 选项；
- 再发 `run_command`，回应是 `cancelled`；
- 这一轮的事件里有 `WebSearch` 的 `tool` 和 `tool_end`；
- 最后的回答照常交付。

### Task 2: 查资料的一轮 3 分钟时限

用到网页工具以后，这次 prompt 的时限从 65 秒放宽到 180 秒。到时间就 `session/cancel`，再发一句收尾 prompt（30 秒）。

测试：假 ACP 加 `slowweb` 模式。

### Task 3: 查的时候插话

**Files:**
- `vm-agent.mjs`：前台的调用参数原行加 `steers`，用 `lockedCall('tasks','steer_take',{run})`。
- `vm-front-agy.mjs`：出现过网页工具以后每秒取一次补充；有补充、又没有在跑的工具调用时，先 `session/cancel`，再在同一个会话里发补充。

测试：假 ACP 加 `steer` 模式。
- 补充送进同一个 `sessionId`；
- 新 prompt 里有补充原话；
- 最后的回答照常交付；
- `steer_take` 把补充标成已送。

### Task 4: 提示词

`vm-persona.mjs` 的 `FRONT_WORK`：
- 第 1 条：几下就能查到的（搜索、读公开网页）自己查了再答。
- 第 2 条：耗时间的（要登录、下载、写代码改文件、操作设备、翻很多来源整理）照旧派后台。

`test/xin-persona-honest.test.cjs` 加对应断言。

### Task 5: 正式站联调和文档

- `scripts/test-xin-live.py`：加一步问一个简单的事实。
  - 这一轮不派活；
  - 事件里有网页步骤；
  - 回答不空。
- 逻辑放进 `scripts/xin_live_policy.py`，测试加在 `test/xin_live_policy_test.py`。
- 更新 CHANGES、README、交接记录。
- 跑全量 check 和 e2e，开 PR，合并，确认正式站绿。
