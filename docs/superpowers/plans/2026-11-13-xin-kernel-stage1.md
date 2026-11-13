# 小芯内核第 1 步：内核外壳、私有端口、待送达和流式传输 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 小芯的请求改走 InstaBox 私有端口上的常驻内核外壳。发消息先存进 Cloudflare 的待送达、立刻确认收到，再异步叫醒电脑送达。回复用 SSE 推给网页。控制器的行为不变，出问题自动退回 exec 和轮询。

**Architecture:**
- 电脑上新加 `vm-kernel.mjs`，是一个 HTTP 外壳：校验第二层签名后，在本机起现有控制器（`node vm-agent-<hash>.mjs <op>`），用法和 InstaBox exec 完全一样。SSE 的做法是：运行记录一有变化，就调一次控制器的 `poll`，把结果推出去。
- Cloudflare 这边扩展现有的 `XinTaskSupervisor`，不新建类。
  - 新实例 `xin-inbox` 管三样：待送达、内核配置（端口令牌、钥匙）、叫醒耗时统计。
  - Worker 的 `call()` 按开关选内核或 exec，按「确定没执行 / 不知道执行没有」决定能不能退回 exec。

**Tech Stack:** Cloudflare Worker 和 Durable Object（KV 存储接口、alarm），Node 22（`node:http`、`node:sqlite`、`node:crypto`），`node:test`，Python Playwright。

**Spec:** `docs/xin-kernel-design.md`，看 §4、§10 第 1 步和 §14（站长 2026-11-13 提的五条边界）。

## Global Constraints

- 控制器 `vm-agent.mjs` 的操作和返回格式不变；第 1 步不改控制器的业务逻辑。
- 内核文件名是 `site/xin/vm-kernel.mjs`，上传到电脑后叫 `vm-kernel-<sha256 前 12 位>.mjs`，和控制器在同一个目录 `/data/home/.xin/agent`。只用 node 内置模块，不 import 别的 `vm-*.mjs`。
- 端口固定 `8797`。InstaBox 端口名 `xin-kernel`，`access: "private"`，换令牌时带 `rotateToken: true`（已实测这个接口格式）。
- 内核只监听 `127.0.0.1`。所有路由都要第二层签名，`/xin/health` 也不例外。
- 签名头 `X-Xin-Auth: XinKernel-HMAC-SHA256 kid=<kid>,ts=<毫秒>,nonce=<base64url 16 字节>,sig=<base64url>`。被签的字符串是：`['xin-kernel-v1', 方法大写, 路径加查询串, ts, nonce, 请求体 sha256 的 hex].join('\n')`。
- 时间窗 ±300000 毫秒；用过的随机数留 600000 毫秒。
- 钥匙文件 `/data/home/.xin/kernel-keys.json`，权限 0600，内容 `{"v":1,"keys":{"<kid>":"<base64url 32 字节>"}}`。最多同时有两把。
- 钥匙和端口令牌都是 30 天轮换一次。
- 内核每个回应都带 `X-Xin-Kernel: <自己文件名里的 12 位哈希>`。出错时的回应体是 `{ok:false, executed:true|false, error, msg}`。
- 控制器子进程的超时是 40000 毫秒（和 exec 一样）。同时最多跑 16 个。对方断开时不杀子进程。
- 开关是 wrangler 变量：`XIN_TRANSPORT`（`kernel` 或 `exec`，不写就是 `exec`），`XIN_INBOX`（`1` 是开）。正式站两个都开；测试站不配（小芯在测试站本来就关着）。
- 待送达各项参数：

  | 参数 | 值 |
  |---|---|
  | 当场尝试的预算 | 6000 毫秒 |
  | 租约 | 120000 毫秒 |
  | 闹钟保底 | 120000 毫秒 |
  | 放弃时间 | 24 小时 |
  | 记录保留 | 7 天 |
  | 已确认的行还列出多久 | 10 分钟 |
  | 退避（秒） | 5、15、30、60、120、300，之后一直 600 |

- 页面上的字照抄这些：
  - 「已收到 · 唤醒中」
  - 「已收到 · 冷却中，约 HH:MM 送到」
  - 「已收到 · 正在重试」
  - 「没送到：…」
  - 「还有 N 句在等小芯醒来」
  - 「消息没存上，请再发一次」
  - 「不确定刚才的操作有没有做完，请刷新看看」
- 不跳过、不删测试。新旧 `chat.js` 和新旧 Worker 任意搭配都要能用：新 Worker 回的 `accepted` 结果对旧网页来说就是「唤醒中，再试」。
- 改了功能就顺手更新 README 的小芯部分和 `docs/CHANGES.md`。

## Review Focus

1. **送达的回应丢了**：Durable Object 已经把消息送进了内核，但没收到回应（超时、实例被回收）。重送同一编号时，必须拿到同一个 `run`，不能多出一轮。Task 2 用真控制器测：同一个 `clientId` 一次走内核、一次直接调控制器，结果只有一轮。Task 7 测：租约过期后重送，结果映射回同一行。
2. **页面刷新或关掉时，消息还在待送达里**：重新打开后要看到这句话和等待状态。不能当成没发过，也不能让用户以为要重发。Task 9 的浏览器测试覆盖。
3. **冷却期很长（60 分钟以上）**：网页不能 90 秒后报「没发出去」，要一直显示「已收到 · 冷却中，约 HH:MM 送到」。Task 9 覆盖。
4. **第一次上线时内核还没起来（502）**：
   - 只读操作、带编号的操作要立刻退回 exec，同时在后台启动内核。
   - 不带编号又会改东西的操作（如 `memory_add`）不退回，报「不确定……」。
   - Task 6 覆盖这两种情况。
5. **整段答案被拆开**：SSE 只是换了传输方式，事件要原样推出去，文字事件不能被切成几段。Task 3 测内核的流，Task 9 测网页上的显示。

---

### Task 1: 第二层认证（内核校验和 Worker 签名，两边对得上）

**Files:**
- Create: `site/xin/vm-kernel.mjs`（这一步只写认证部分）
- Create: `src/xin-kernel.js`（这一步只写签名和脱敏）
- Test: `test/xin-kernel-auth.test.cjs`

**Interfaces:**
- Produces（`vm-kernel.mjs`）：
  - `KERNEL_PORT = 8797`
  - `canonical({method, target, ts, nonce, bodySha256}) → string`
  - `parseAuth(header) → {kid, ts, nonce, sig} | null`
  - `class KeyRing { constructor(file); keys() → Map<kid, Buffer> }`：文件的修改时间变了才重读；文件是软链接时当成没有钥匙
  - `class NonceStore { constructor(file /* 也可以是 ':memory:' */); seen(nonce, now) → boolean }`：第一次见到返回 false 并记下；顺手删掉超过 600000 毫秒的
  - `verifyRequest({method, target, header, body, keys, nonces, now}) → {ok:true, kid} | {ok:false, reason}`。`reason` 的取值：`missing`、`malformed`、`unknown_kid`、`expired`、`bad_sig`、`replay`。检查顺序：先格式，再 kid，再时间，再签名（用常数时间比较），最后随机数。签名不对的请求不消耗随机数。
  - `redact(text) → string`：把 `ibp_…`、`ibk_…`、`Bearer …`、`sig=…` 换成 `<hidden>`
- Produces（`src/xin-kernel.js`）：
  - `KERNEL_PORT = 8797`
  - `async signKernelRequest({key /* base64url */, kid, method, target, body /* string */, now, nonce /* 可选 */}) → string`（就是 `X-Xin-Auth` 头的值，用 WebCrypto）
  - `redact(text)`：和内核那份规则相同

- [ ] **Step 1: 写失败的测试** `test/xin-kernel-auth.test.cjs`：
  - `Worker 签的请求内核认得`：用 `signKernelRequest` 签 `POST /xin/op` 和请求体 `{"op":"ping"}`，`verifyRequest` 返回 `{ok:true, kid}`。
  - `改了任何一处都不认`：分别改方法、路径（含查询串）、请求体的一个字节、ts，都返回 `bad_sig`；ts 超出 300000 毫秒返回 `expired`；kid 不在 KeyRing 里返回 `unknown_kid`；头是空的返回 `missing`。
  - `同一个签名只认一次`：第二次返回 `replay`。用同一个 nonce 文件新建一个 `NonceStore`（相当于内核重启），还是返回 `replay`。
  - `签名不对不消耗随机数`：先用错签名发，再用对的签名、同一个 nonce 发，返回 `ok`。
  - `钥匙文件换了会重读，新旧两把都认`：把文件写成两把钥匙，用旧 kid 签的、用新 kid 签的都能过；把文件换成软链接后 `keys()` 是空的。
  - `端口号两边一致`：两边的 `KERNEL_PORT` 都是 8797。
  - `脱敏`：输入 `'x ibp_AbC-1 Bearer tok sig=zz, ibk_q'`，两边的 `redact` 结果相同，而且不含 `AbC`、`tok`、`zz`、`ibk_q`。
- [ ] **Step 2: 跑测试，确认失败**：`node --test test/xin-kernel-auth.test.cjs`，应该报找不到模块。
- [ ] **Step 3: 实现上面列的导出**。`NonceStore` 用 `node:sqlite` 的 `DatabaseSync`，表是 `nonces(nonce TEXT PRIMARY KEY, at INTEGER NOT NULL)`。
- [ ] **Step 4: 跑测试，确认通过**：`node --test test/xin-kernel-auth.test.cjs`，全部 PASS。
- [ ] **Step 5: 提交**：`git add site/xin/vm-kernel.mjs src/xin-kernel.js test/xin-kernel-auth.test.cjs && git commit -m "小芯内核：第二层签名（HMAC、防重放、钥匙重读、脱敏），Worker 和内核两边对得上"`

### Task 2: 内核 HTTP 外壳：`/xin/health`、`/xin/op`

**Files:**
- Modify: `site/xin/vm-kernel.mjs`
- Test: `test/xin-kernel.test.cjs`

**Interfaces:**
- Consumes：Task 1 的 `verifyRequest`、`KeyRing`、`NonceStore`、`redact`。
- Produces：`createKernel({home, port = 0, env, now = Date.now, opTimeoutMs = 40000, maxConcurrent = 16, logFile}) → Promise<{port, close()}>`，只监听 127.0.0.1。参数的含义：
  - `home`：内核找东西的根目录。`home/agent` 放控制器；`home/kernel-keys.json` 是钥匙；`home/kernel.sqlite` 存随机数；日志默认写 `home/logs/kernel.jsonl`。
  - `env`：起控制器时用的环境变量。
- 路由（所有回应都带 `X-Xin-Kernel` 头）：
  - `GET /xin/health`：回 `{ok:true, kernel, pid, up}`。
  - `POST /xin/op`：请求体 `{agent, op, args}`。
    - `agent` 必须是 `home/agent/vm-agent-<12 位 hex>.mjs`，否则回 400 `{executed:false, error:'bad_request'}`；文件不在，回 409 `{executed:false, error:'agent_missing'}`。
    - 同时在跑的满了，回 503 `{executed:false, error:'kernel_busy'}`。
    - 签名没过，回 401 `{executed:false, error:'kernel_auth', reason}`。
    - 起子进程 `spawn(process.execPath, [agent, op])`，标准输入写 `JSON.stringify(args)`。退出码是 0 且输出能解析，回 200 `{ok:true, data}`。
    - 其余情况回 200 `{ok:false, executed:true, error}`：退出码不是 0 是 `agent_failed`，超时被杀是 `agent_timeout`，输出看不懂是 `agent_output`。`msg` 取 stderr 最后 3 行，先过 `redact`。
- 日志每行 `{at, method, route, op, status, ms, id}`。`id` 只在 `args.clientId` 合法时写。

- [ ] **Step 1: 写失败的测试** `test/xin-kernel.test.cjs`。先写一个辅助函数 `kernelFixture()`：在临时目录里建 `agent/` 和钥匙文件，钥匙用 Task 1 的签名函数签。再写一个假控制器 `agent/vm-agent-000000000000.mjs`，按 op 名做事：`echo` 原样回 args；`slow` 先睡一段再回；`boom` 以退出码 1 结束；`garbage` 输出不是 JSON。测试：
  - `health 要签名`：不签回 401，并且带内核头；签了回 200，`kernel` 字段有值。
  - `op 原样起控制器`：`echo` 回 `{ok:true, data:args}`。
  - `控制器出错都是 executed:true`：`boom` 的 `error` 是 `agent_failed`；`garbage` 是 `agent_output`；超时（把 `opTimeoutMs` 设成 300 再跑 `slow`）是 `agent_timeout`，并且子进程已经被杀掉。
  - `没执行的都是 executed:false`：`agent` 指到别的目录是 400；文件不在是 409 `agent_missing`；把 `maxConcurrent` 设成 1，`slow` 还在跑时再发一个，回 503 `kernel_busy`。
  - `对方断开不杀控制器`：发 `slow`（睡 500 毫秒，结束前在 `home` 下写一个标记文件），100 毫秒后中止请求；1 秒后标记文件存在。
  - `日志不带秘密`：用一个很特别的标记字符串当消息内容，用 `ibp_SECRET` 当 Authorization 头，各发几次请求。之后日志里不能出现标记字符串、`ibp_SECRET`、钥匙、`sig=`；`clientId` 要在日志里。
  - `真控制器只回一轮`：用 `test/xin.test.cjs` 里 `agentEnv` 的做法，把真的 `site/xin/` 复制成 `home/agent/vm-agent-<hash>.mjs` 以及它依赖的模块（就照 `freshAgentUrl` 的复制方式，再把入口文件改名）。同一个 `clientId` 的 `send`，一次走内核 `/xin/op`，一次直接 `execFileSync` 控制器，两次同时发。两次回的 `run` 相同，`runs/` 里这个对话只有一轮。
- [ ] **Step 2: 跑测试，确认失败**：`node --test test/xin-kernel.test.cjs`，报 `createKernel is not a function`。
- [ ] **Step 3: 实现 `createKernel`**。用 `node:http`。请求体最多 65536 字节，超出回 413 `{executed:false}`。验证签名时，`target` 用 `req.url` 原样。
- [ ] **Step 4: 跑测试，确认通过**：`node --test test/xin-kernel.test.cjs`，全部 PASS。
- [ ] **Step 5: 提交**：`git commit -m "小芯内核外壳：/xin/op 原样起控制器，回应分清执行没有；断开不杀；日志脱敏"`

### Task 3: 内核的流：`GET /xin/stream`

**Files:**
- Modify: `site/xin/vm-kernel.mjs`
- Test: `test/xin-kernel.test.cjs`（追加）

**Interfaces:**
- Consumes：Task 2 的 `createKernel` 和起控制器的那段内部函数。
- Produces：`GET /xin/stream?agent=&run=&off=&pos=&deviceId=&tabId=&watching=0|1`（签名覆盖整个查询串）。
  - 回应头是 `content-type: text/event-stream`、`cache-control: no-store`。
  - `run` 要匹配 `^r[0-9a-z]{6,24}$`。
  - 循环逻辑：每 `pollEveryMs`（默认 250）看一次 `home/runs/<run>.jsonl` 的大小和修改时间。变了，或者离上次调用已经超过 `keepWatchMs`（默认 4000，保证控制器的「有人在看」标记不过期），就调一次控制器 `poll`，参数是 `{run, off, pos, deviceId, tabId, watching}`。
  - 结果里有事件、或者 `done`，就推一条 `id: <pos>\ndata: <poll 的结果原样 JSON>\n\n`，再用结果更新 `off` 和 `pos`。
  - 每 `heartbeatMs`（默认 15000）推一行 `: hb\n\n`。
  - 推出 `done:true` 之后就结束。最长 `maxStreamMs`（默认 600000）也结束。
  - 对方断开就停止循环。同一时刻只跑一个 `poll`。
  - `poll` 回 `{error}` 时推一条 `event: error` 加原样数据，然后结束。
- `createKernel` 加这几个参数：`pollEveryMs`、`keepWatchMs`、`heartbeatMs`、`maxStreamMs`。

- [ ] **Step 1: 写失败的测试**（假控制器加一个 `poll` op，它按 `home/runs/<run>.jsonl` 回 `{events, off, pos, done}`）：
  - `有新事件才推，推的是 poll 原样结果`：往 jsonl 里追加一行 `{"t":"text","text":"整段答案 ABC"}`，客户端收到的 `data` 里，`events[0].text === '整段答案 ABC'`，只有一个事件，没被拆开；`id` 等于 `pos`。
  - `done 之后流结束`：追加 `{"t":"done"}`，流在 1 秒内结束。
  - `没变化也定期调 poll`：把 `keepWatchMs` 设成 200，1 秒内假控制器记下的 `poll` 次数不少于 3。
  - `心跳`：把 `heartbeatMs` 设成 100，300 毫秒内收到至少两行 `: hb`。
  - `断开就停`：客户端中止后，再追加一行，假控制器的 `poll` 次数不再增加。
  - `run 不合法回 400`，而且 `executed:false`。
- [ ] **Step 2: 跑测试，确认失败**：`node --test test/xin-kernel.test.cjs`，新加的用例 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试，确认通过**：`node --test test/xin-kernel.test.cjs`，全部 PASS。
- [ ] **Step 5: 提交**：`git commit -m "小芯内核的流：运行记录变了才调 poll，原样推出；心跳、做完就关、断开就停"`

### Task 4: 内核的启动和升级：`ensure` 和 `serve`

**Files:**
- Modify: `site/xin/vm-kernel.mjs`（命令行入口）
- Test: `test/xin-kernel.test.cjs`（追加）

**Interfaces:**
- Produces：两个命令行入口。`home` 取 `process.env.XIN_HOME || ~/.xin`。
  - `node vm-kernel-<hash>.mjs serve --port 8797`：读 `home/kernel.env.json` 当子进程的环境变量，然后 `createKernel`。
  - `node vm-kernel-<hash>.mjs ensure --port 8797`，步骤依次是：
    1. 把当前的 `process.env` 写进 `home/kernel.env.json`（0600）。
    2. 拿 `home/locks/kernel.lock` 文件锁（`flock` 不阻塞；拿不到就等最多 10 秒再查健康）。
    3. 用钥匙文件里任意一把钥匙签一个 `GET /xin/health`。如果 `kernel` 和自己文件名里的哈希一样，就输出 `{ok:true, already:true}`。
    4. 否则执行 `systemctl --user stop xin-kernel.service`（失败不管），再执行 `systemd-run --user --unit=xin-kernel --collect -p KillMode=process -p Restart=always -p RestartSec=2 <node> <自己> serve --port <port>`。用户总线不在时，改成 `setsid` 起一个脱离的进程，输出写到 `home/logs/kernel.out`。
    5. 最多等 8 秒健康检查通过，输出 `{ok:true, started:true, pid}` 或 `{ok:false, error:'not_healthy'}`。退出码一律是 0。
  - 判断有没有总线的办法和 `vm-reaper.mjs` 一样：看 `/run/user/<uid>/bus` 在不在（测试用 `XIN_SYSTEMD_BUS` 指过去），总线相关的环境变量也照它那样设。

- [ ] **Step 1: 写失败的测试**。在 PATH 里放假的 `systemd-run` 和 `systemctl`：它们把参数记进文件；假 `systemd-run` 再用 `serve` 真的把内核起在一个空闲端口上。测试：
  - `ensure 会带上 KillMode=process 和 Restart=always`：检查假 `systemd-run` 记下的参数。
  - `已经在跑同一版本就什么都不做`：连着跑两次 `ensure`，第二次输出 `already:true`，`systemd-run` 只被调用了一次。
  - `版本不同会先停再起`：先用一个 12 位哈希不同的副本起内核，再用当前文件 `ensure`，`systemctl` 记下了 `stop xin-kernel.service`。
  - `子进程的环境和 exec 一样`：`ensure` 时带一个特殊变量 `XIN_ENV_PROBE=1`，之后经 `/xin/op` 起的假控制器 `env` op 能读到这个变量。
- [ ] **Step 2: 跑测试，确认失败**：`node --test test/xin-kernel.test.cjs`，新加的用例 FAIL。
- [ ] **Step 3: 实现两个命令行入口**。只在被当成主程序运行时才执行，判断方法和 `vm-agent.mjs` 末尾一样，免得测试 import 时就跑起来。
- [ ] **Step 4: 跑测试，确认通过**：`node --test test/xin-kernel.test.cjs`，全部 PASS。
- [ ] **Step 5: 提交**：`git commit -m "小芯内核：ensure 用 systemd 用户服务常驻（只杀主进程、挂了自动重启），环境和 exec 一致"`

### Task 5: Durable Object 里的内核配置（端口令牌和钥匙）

**Files:**
- Modify: `src/xin-kernel.js`
- Test: `test/xin-kernel-client.test.cjs`

**Interfaces:**
- Produces：`class KernelConfigStore { constructor(storage, {ib, now = Date.now, random = n => crypto.getRandomValues(new Uint8Array(n))}) }`，存储键是 `kernel:config`。
  - `ib(path, init)` 是 InstaBox 请求函数，签名和 `src/xin.js` 里的 `ib(env, …)` 去掉 `env` 一样。
  - `get({machineId}) → {url, token, kid, key, keys:{[kid]:key}, installedKid}`：
    - 没有令牌、令牌超过 30 天、或者被标记作废了：调 `POST /v1/machines/{id}/ports`，带 `{port:8797, name:'xin-kernel', access:'private', rotateToken:true}`，存下 `url`、`token`、`tokenAt`。
    - 没有钥匙、或当前钥匙超过 30 天：新生成一把（kid 是 `k` 加 10 位小写 hex 随机数），最多留最近两把。
  - `markInstalled(kid)`：记下已经装到电脑上的 kid。
  - `invalidateToken()`：标记令牌作废，下次 `get` 时换新的。
  - 机器号变了（`machineId` 和存的不一样）：令牌作废，`installedKid` 清空。

- [ ] **Step 1: 写失败的测试**（假的存储用 Map，`ib` 是一个记录调用的假函数）：
  - `第一次 get 会发布私有端口、生成钥匙`：`ib` 的请求体是 `{port:8797,name:'xin-kernel',access:'private',rotateToken:true}`；返回值里有 `url`、`token`、`kid`、`key`，`installedKid` 是 null。
  - `第二次 get 不再调 InstaBox`。
  - `30 天后换钥匙，留着旧的`：把 `now` 往后拨 31 天。`kid` 变了，`keys` 里新旧两把都有，`installedKid` 还是旧的。再拨 31 天，最老的那把就没了。
  - `作废后换令牌`：`invalidateToken()` 之后再 `get`，又调了一次 `ib`，令牌是新的。
  - `机器换了也换令牌`。
- [ ] **Step 2: 跑测试，确认失败**：`node --test test/xin-kernel-client.test.cjs`，FAIL。
- [ ] **Step 3: 实现 `KernelConfigStore`**。
- [ ] **Step 4: 跑测试，确认通过**：`node --test test/xin-kernel-client.test.cjs`，PASS。
- [ ] **Step 5: 提交**：`git commit -m "小芯内核配置：Durable Object 管端口令牌和钥匙，30 天轮换、留旧钥匙、作废就换"`

### Task 6: Worker 改走内核，按规则退回 exec

**Files:**
- Modify: `src/xin-kernel.js`（请求和结果分类）、`src/xin.js`（`agentScript` 加上内核文件，`call()` 选通道，`verifyAgent` 也核对内核文件，`XinTaskSupervisor.fetch` 加 `/kernel/*` 路由）
- Test: `test/xin-kernel-client.test.cjs`（追加）、`test/xin.test.cjs`（`fakeIB` 改成按主机名区分）

**Interfaces:**
- Produces（`src/xin-kernel.js`）：
  - `READ_OPS`：`status`、`ping`、`poll`、`sessions`、`history`、`memory`、`memory_list`、`memory_export`、`memory_preferences`、`learning_report`、`daily_get`、`files`、`plugins`、`moves`、`bond`、`tasks`、`usage`、`logins`、`preview_asset`、`greet`。
  - `KEYED_OPS = new Set(['send','steer','task_tell','task_stop'])`
  - `retrySafe(op, args) → boolean`：只读的，或者带编号且 `args.clientId` 匹配 `^[A-Za-z0-9_-]{8,80}$` 的。
  - `async kernelRequest({config, agentPath, op, args, timeoutMs = 90000, fetchImpl = fetch, now = Date.now}) → {kind:'ok', data} | {kind:'executed_error', error, msg} | {kind:'not_sent', reason, retryAfter} | {kind:'unknown', reason}`。分类按设计文档 §14.2 那张表：
    - 回应带内核头：看 `ok` 和 `executed` 分到对应的结果。
    - 没有内核头：401/403 是 `not_sent:'gate_auth'`；503 是 `not_sent:'waking'`，`retryAfter` 从 `Retry-After` 头取；409 而且错误码是 `machine_cooldown` 的，是 `not_sent:'cooldown'`。
    - 其余，以及 fetch 抛出的错误（含超时），都是 `unknown`。
- Produces（`src/xin.js`）：
  - `agentScript()` 的返回值多一个 `kernel: {text, path, sha256}`。
  - `call(env, origin, op, args, ctx, now, opts = {})`，其中 `opts.kernel` 是 `{get(), markInstalled(kid), invalidateToken()}`。Worker 默认通过 `xin-inbox` 实例的 `/kernel/config`、`/kernel/installed`、`/kernel/invalid` 来实现，每个 isolate 缓存 5 分钟。
  - `XinTaskSupervisor.fetch` 加上这三条 `/kernel/*` 路由，背后是 Task 5 的 `KernelConfigStore`，用本实例自己的存储。Durable Object 自己调 `call()` 时，直接传这个对象，不再经过 stub 请求自己。
  - 当 `env.XIN_TRANSPORT === 'kernel'` 时，原来调 `exec()` 的地方改成 `runOp()`，规则依次是：
    1. `get()` 之后，如果 `installedKid !== kid`，先用 `putAgentFile` 的同一个文件接口写钥匙文件（权限 0600），再调 `markInstalled`。
    2. 结果是 `ok`，就当 exec 的结果用。
    3. 结果是 `executed_error`，就抛出 `{status:500, code:'agent_failed', msg: redact(msg)}`，不退回 exec。
    4. 结果是 `not_sent`：
       - `gate_auth`：调 `invalidateToken`，重拿配置再试一次内核。
       - `kernel_auth` 而且原因是 `unknown_kid`：重装钥匙再试一次。
       - `agent_missing`：照 `exec()` 现在的做法上传所有模块，再试一次。
       - `waking`、`cooldown`：抛出原来 `explain()` 认得的错误（`operation_conflict` / `machine_cooldown`）。
       - 其余：退回 exec。
    5. 结果是 `unknown`：`retrySafe` 成立就退回 exec（参数原样，`clientId` 不变）；不成立就抛 `{code:'unknown_outcome', msg:'不确定刚才的操作有没有做完，请刷新看看'}`。
    6. 碰到 502、503、`kernel_busy`、`agent_missing`：用 `ctx.waitUntil` 起 `ensureKernel`。每个 isolate 60 秒内最多一次。它先上传内核文件（如果缺），再 exec 执行 `['node', kernel.path, 'ensure', '--port', '8797']`。

- [ ] **Step 1: 写失败的测试**：
  - `test/xin-kernel-client.test.cjs`：直接测 `kernelRequest` 的分类，每种回应各一条，要覆盖：
    - 有内核头的 ok、`executed:true`、`executed:false`；
    - 没有内核头的 401、503（带 Retry-After）、409 `machine_cooldown`、502、504；
    - fetch 抛错。
  - `test/xin.test.cjs`：先改 `fakeIB`，键改成「方法 主机名路径」，主机名是 `api.instabox.sh` 的照旧只写路径，现有用例不用改。再加：
    - `内核通道：只读操作走内核，不调 exec`（`XIN_TRANSPORT:'kernel'`，配一个假的 xin-inbox stub）。
    - `第一次用会装钥匙`：files PUT 的路径是 `/data/home/.xin/kernel-keys.json`，带 `mode=0600`，之后签名用的是新 kid。
    - `内核 502：history 退回 exec，并在后台起 ensure`：exec 的 argv 里有 `ensure`。
    - `内核 502：memory_add 不退回 exec，报不确定`：exec 一次都没调。
    - `send 超时：带 clientId 退回 exec，参数原样`：exec 的 stdin 和发给内核的 args 一样。
    - `内核报 agent_failed 不退回 exec`。
    - `端口 401：换令牌再试一次就通`。
    - `unknown_kid：重装钥匙再试`。
    - `给网页的错误信息脱敏`：内核 msg 里带 `ibp_XYZ`，返回值里没有 `XYZ`。
    - `XIN_TRANSPORT 不设就和以前一样走 exec`：现有用例全部照旧通过。
    - `verifyAgent 也核对内核文件`。
- [ ] **Step 2: 跑测试，确认失败**：`node --test test/xin-kernel-client.test.cjs test/xin.test.cjs`，新加的用例 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试，确认通过**：`npm test`，全部 PASS（原有 658 条加上新加的）。
- [ ] **Step 5: 提交**：`git commit -m "Worker 改走小芯内核：确定没执行才换通道，不知道执行没有的只给能安全重来的操作退回 exec"`

### Task 7: 待送达（Durable Object 里的 `xin-inbox`）

**Files:**
- Create: `src/xin-inbox.js`
- Modify: `src/xin.js`（`XinTaskSupervisor`：`fetch` 加 `/inbox/*` 路由；`alarm()` 开头加上：如果是 inbox 实例，就交给 inbox）
- Test: `test/xin-inbox.test.cjs`

**Interfaces:**
- Produces：`class Inbox { constructor(storage, {deliver, now = Date.now, budgetMs = 6000}) }`，存储键：行是 `inbox:row:<id>`，序号是 `inbox:seq`，标记是 `inbox:meta`，叫醒统计是 `inbox:wakes`。
  - `accept({id, op, args}) → {view} | {error:'bad_id'|'conflict'}`：
    - `id` 要匹配 `^[A-Za-z0-9_-]{8,80}$`。`digest` 是 `args` 按键排序后的 JSON 再做 sha256。
    - 新的一行：先 `await put`，再尝试送一次（最多等 `budgetMs`）。
    - 已经有这一行而且 `digest` 相同：如果状态是 `pending`、到期了、租约也过了，就再尝试一次；然后回当前的状态。
  - `view(id) → view | null`。读到 `delivered` 时顺手记下 `acked`。
  - `list() → {rows: view[], wakes}`：列出 `pending` 和 `failed` 的，加上送到后还没确认、送到不满 10 分钟的。
  - `ack(id)`、`kick()`（有没送完的就把闹钟提前到 1 秒后）、`alarm()`、`stats() → {count, p50, max, over45}`。
  - `view` 的形状：`{id, state:'pending'|'delivered'|'failed', attempts, createdAt, deliveredAt, wait:{state:'waking'|'cooldown'|'busy'|'retrying', until, msg}|null, result, error:{code,msg}|null, sid, text, files}`。其中 `sid`、`text`、`files` 来自 `args`，给网页刷新后重画这句话用。
  - `deliver(row) → Promise<call() 的返回值>`，由 Durable Object 注入。注入的是 `call(this.env, CRON_ORIGIN, row.op, {...row.args, clientId: row.id}, ctx, now, {kernel: 本实例的 KernelConfigStore 适配器})`。
  - 送完之后怎么定状态，按设计文档 §14.4 和 Global Constraints 里的退避：
    - `{ok:true, data}` 且没有 `data.error`：`delivered`，`result = data`。
    - `data.error` 是 `busy`、`lock_failed`、`internal`：继续 `pending`，按退避再试，等待原因是 `busy`。
    - `data.error` 是别的：`failed`，`result = data`。
    - `state` 是 `waking`：下次时间是现在加 `max(3, retryAfter)` 秒。
    - `state` 是 `cooldown`：下次时间是现在加 `retryAfter` 秒，`until` 记成同一个时间。
    - `state` 是 `busy`、`error`，或者抛错：按退避再试，等待原因是 `retrying`，`error.msg` 先脱敏。
    - 从建立起超过 24 小时还是 `pending`：`failed`，`{code:'gave_up', msg:'24 小时都没送到'}`。
  - 尝试一次的流程：先写租约（`leaseUntil = now + 120000`）、尝试次数加 1、`put`，再把闹钟定到不晚于租约到期。await 送达之后先重新读一遍这一行，合并结果再写回。
  - `alarm()` 的流程：
    1. 先 `setAlarm(now + 120000)`。
    2. 删掉终态超过 7 天的行。
    3. 按序号依次送到期的行。只要有一行因为 `waking`、`cooldown`、`busy` 还是 `pending`，这一轮就停。
    4. 最后把闹钟定到最早的下次时间（不早于 1 秒后）；一行没送完的都没有，就删掉闹钟。
  - 送到时，如果从第一次尝试到送到超过 5000 毫秒，或者中途等过 `waking`，就记一笔叫醒耗时。只留最近 50 笔。

- [ ] **Step 1: 写失败的测试** `test/xin-inbox.test.cjs`。假的存储用 Map，记下 `setAlarm` 和 `deleteAlarm`；`put` 可以设成抛错；`deliver` 可以换成各种假结果。测试：
  - `存好了才回收到`：`put` 抛错时 `accept` 也抛错，`deliver` 一次都没调。
  - `醒着当场送到`：`deliver` 回 `{ok:true, data:{sid:'s1',run:'r1'}}`。`view.state === 'delivered'`，`result.run === 'r1'`，`id` 和 `clientId` 一样。
  - `同一编号再发不重复送`：送到之后再 `accept` 同样的内容，`deliver` 调用次数不变，回同一个 `run`。
  - `内容不同算冲突`：同一个 `id`、不同的 `args`，回 `{error:'conflict'}`。
  - `电脑在睡：先回等待，闹钟接着送`：`deliver` 一直不结束（用一个不 resolve 的 promise），`accept` 在预算到了时回 `pending`，而且闹钟不晚于租约到期。之后把 `deliver` 换成成功，把时间拨过租约，跑 `alarm()`，状态变成 `delivered`。
  - `冷却：等到冷却结束`：`deliver` 回 `{ok:false, state:'cooldown', retryAfter:3600}`，`wait.state === 'cooldown'`，`nextAt` 和 `until` 都是现在加 3600000。
  - `闹钟先给自己续上`：`alarm()` 里，在第一次调 `deliver` 之前，`setAlarm` 就已经被调过了，而且时间是现在加 120000。
  - `控制器的长久错误不重试`：`data.error = 'no_session'` 时状态是 `failed`，`alarm()` 不会再送。
  - `临时错误按退避`：连着回 `busy`，`nextAt` 依次是现在加 5、15、30、60 秒。
  - `24 小时放弃`：时间拨过 24 小时后跑 `alarm()`，`failed`，`error.code === 'gave_up'`。
  - `前面卡住就不送后面的`：两行都到期，第一行回 `waking`，那么第二行这一轮没被送。
  - `送达和确认竞争不丢标记`：送达还在进行时调 `ack`，送达写回之后 `acked` 还在。
  - `清理`：终态超过 7 天的行被删掉；还在 `pending` 的不删。
  - `叫醒统计`：送达用了 40700 毫秒，`stats()` 回 `count:1`、`max:40700`、`over45:0`。
- [ ] **Step 2: 跑测试，确认失败**：`node --test test/xin-inbox.test.cjs`，FAIL。
- [ ] **Step 3: 实现 `Inbox`**，并在 `XinTaskSupervisor` 上接好路由：`/inbox/accept`、`/inbox/view`、`/inbox/list`、`/inbox/ack`、`/inbox/kick`。`/kernel/*` 那几条在 Task 6 已经接好，这里不动。`alarm()` 的第一句是：`if (await this.state.storage.get('inbox:meta')) return this.inbox().alarm();`。
- [ ] **Step 4: 跑测试，确认通过**：`node --test test/xin-inbox.test.cjs test/xin-supervisor.test.cjs`，全部 PASS（原有的租约监督测试不能受影响）。
- [ ] **Step 5: 提交**：`git commit -m "待送达：存好才确认、按编号去重、租约加自续闹钟加退避、24 小时不丢、按顺序送"`

### Task 8: Worker 接线：发消息走待送达、新操作、流的路由

**Files:**
- Modify: `src/xin.js`
- Test: `test/xin.test.cjs`（追加）

**Interfaces:**
- Consumes：Task 6 的 `call` 和 `runOp`、Task 7 的 `/inbox/*`、Task 1 的 `signKernelRequest`。
- Produces：
  - `env.XIN_INBOX === '1'` 时，`op === 'send'` 改走 `/inbox/accept`。没带合法的 `clientId` 时，Worker 补一个 `crypto.randomUUID()`。按 view 的状态回给网页：
    - `delivered`：`{ok:true, data: view.result}`。
    - `failed` 而且有 `result`（控制器回的错误）：`{ok:true, data: view.result}`，和现在一样。
    - `failed` 但没有 `result`：`{ok:false, state:'error', accepted:true, delivery: view, msg:'没送到：' + view.error.msg}`。
    - `pending`：`{ok:false, state: view.wait.state === 'cooldown' ? 'cooldown' : 'waking', accepted:true, delivery: view, retryAfter, msg}`。
    - 接收失败：`{ok:false, state:'error', msg:'消息没存上，请再发一次'}`。
  - 新加两个操作（放进 `OPS`），只找 Durable Object，不碰电脑：
    - `delivery {id}`：回 `{ok:true, data: view}`，或者 `{ok:true, data:{error:'not_found'}}`。
    - `deliveries {}`：回 `{ok:true, data: list}`。
  - `greet` 和 `wake` 成功后，以及 `runCron` 每次运行，都用 `ctx.waitUntil` 调 `/inbox/kick`。
  - `usage` 成功后，`data.wake = stats`。
  - `GET /api/xin/me` 多回一个 `stream: env.XIN_TRANSPORT === 'kernel' && enabled(env)`。
  - `GET /api/xin/stream?run=&off=&pos=&deviceId=&tabId=&watching=`：
    - 要求：已登录、带 `x-xin: 1` 头、`XIN_TRANSPORT === 'kernel'`。
    - 签好名，向内核要 `/xin/stream`，查询串里带上 `agent` 路径。
    - 内核回 200 而且是 `text/event-stream`：`return new Response(upstream.body, {headers: {'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}})`。
    - 其余情况回 503 `{state:'unavailable'}`，网页据此退回轮询。

- [ ] **Step 1: 写失败的测试**（`test/xin.test.cjs`，用一个假的 Durable Object 命名空间，把请求转给真的 `XinTaskSupervisor` 实例，实例的存储用 Map）：
  - `send 走待送达：醒着时和以前一样回 run`。
  - `send 走待送达：电脑在睡时回 accepted 加 waking，再发同一个 clientId 就拿到 run`，而且 exec 一共只调了一次 `send`。
  - `send：存不上时回「消息没存上，请再发一次」，也不叫醒电脑`（假存储的 put 抛错）。
  - `delivery 和 deliveries 不碰 InstaBox`（`fakeIB` 里没有路由，一碰就会抛错）。
  - `greet 之后踢了待送达`。
  - `/api/xin/me 有 stream 字段`。
  - `stream 路由原样透传内核的流`：读回应体，能读到假内核推出的两条 `data:`。
  - `stream：没登录 401；内核不在 503`。
  - `XIN_INBOX 不设：send 和以前一模一样`（现有的 send 用例照旧通过）。
- [ ] **Step 2: 跑测试，确认失败**：`node --test test/xin.test.cjs`，新加的用例 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试，确认通过**：`npm test`，全部 PASS。
- [ ] **Step 5: 提交**：`git commit -m "Worker：发消息先进待送达再送，delivery、deliveries 两个操作，/api/xin/stream 透传内核的流"`

### Task 9: 网页：「已收到」的等待状态、刷新后接着等、SSE 加轮询兜底

**Files:**
- Modify: `site/xin/chat.js`
- Create: `test/e2e/xin_kernel_e2e.py`
- Modify: `package.json`（`test:e2e` 加上新文件）、`.github/workflows/deploy.yml`（浏览器测试那一步加一行，照其它小芯 e2e 的写法）

**Interfaces:**
- Consumes：Task 8 的回应形状、`delivery`、`deliveries`、`/api/xin/me` 的 `stream`、`/api/xin/stream`。
- Produces（`chat.js` 里的函数）：
  - `call()`：回应里有 `accepted` 时，直接返回 `{_accepted:true, delivery, state, retryAfter, msg}`，不在 `call` 里面重试。
  - `waitDelivery(view, generation) → Promise<data>`：
    - 每隔 `max(2, retryAfter)` 秒调一次 `delivery`；冷却时每 30 秒一次。
    - 每次都把 `S.waitSend` 设成 `accepted-waking`、`accepted-cooldown` 或 `accepted-retrying`，同时记下 `S.waitUntil`。
    - 状态是 `delivered` 时，resolve 成 `view.result`。是 `failed` 时，reject，错误信息是「没送到：…」，`e.delivered = false`。
    - 不设总时限。
  - `sendingText()` 加上三种文案（见 Global Constraints），冷却的那种用北京时间显示 `HH:MM`。
  - `send()`：拿到 `_accepted` 就进 `waitDelivery`，结果交给原来的「送到了」那段处理（先把那段抽成 `sent(d)` 函数）。等待期间输入框照旧可以打字，打的话进队列。
  - 打开聊天时，`greet` 之后调一次 `deliveries`：
    - 属于当前对话的待送达（`sid` 一样；新对话就是没有 `sid` 且 `main` 和当前一致的），画出那句话加 pending 状态，并进 `waitDelivery`。
    - 别的有 N 句的，状态栏写「还有 N 句在等小芯醒来」。
  - `S.streamOn` 取 `/api/xin/me` 的 `stream`。`startPolling()` 在 `streamOn` 时改调 `openStream()`。
    - `openStream()` 用 `fetch`，带 `X-Xin: 1` 头，逐块读、按 SSE 格式拆。每条 `data` 交给从 `poll()` 成功分支抽出来的 `onTurn(d, run, generation)`。
    - 流结束了还没看到 `done`：1 秒后带着最新的 `off`、`pos` 重新连。连续失败 2 次，这一轮就改回 `poll()`。
    - 页面可见性或焦点变了：中止当前的流，带新的 `watching` 重新连。
  - 用量面板：`usage` 结果里有 `wake.count > 0` 时，多显示一行「叫醒：最近 N 次，一般 X 秒，最长 Y 秒」。

- [ ] **Step 1: 写失败的浏览器测试** `test/e2e/xin_kernel_e2e.py`（照 `xin_main_e2e.py`，用 `ui.xin_mock` 再加一层路由）：
  1. `send` 先回 `accepted` 加 `waking`，`delivery` 前两次回 `pending`，第三次回 `delivered`（带 `run`）；之后 `poll` 回一段答案加 `done`。检查：
     - 打字气泡旁出现过「已收到 · 唤醒中」；
     - 页面上从没出现「没发出去」；
     - 答案画出来了。
  2. `delivery` 一直回 `cooldown`，`until` 是现在加 2 小时。检查：等过 95 秒（`call` 原来的 90 秒上限）以后，还在显示「已收到 · 冷却中，约」，没有「没发出去」。这条测试把页面的时钟拨快来测，不真等，用 `page.clock`。
  3. `deliveries` 回一条属于主对话的 `pending`，`text` 是「刷新前那句」。刷新页面后，这句话带 pending 样式画出来，状态是「已收到 · 唤醒中」。
  4. `/api/xin/me` 回 `stream:true`，`/api/xin/stream` 回一段 SSE，里面两条 `data`：第一条一个事件 `{t:'text', text:'整段答案'}`，第二条 `done:true`。检查：
     - 答案气泡的文字正好是「整段答案」；
     - 这一轮没调过 `poll` 操作。
  5. `/api/xin/stream` 回 503，检查改用了 `poll`，答案照样画出来。
  6. 在 390 手机和 1280 电脑两个宽度上，「已收到 · 冷却中，约 HH:MM 送到」这行字都能完整看到。
- [ ] **Step 2: 跑测试，确认失败**：先在另一个终端 `npm run dev`，再 `CHROMIUM_PATH=/opt/pw-browsers/chromium python3 test/e2e/xin_kernel_e2e.py`，FAIL。
- [ ] **Step 3: 实现 `chat.js` 的改动**。
- [ ] **Step 4: 跑测试，确认通过**：`python3 test/e2e/xin_kernel_e2e.py` 通过，`npm run test:e2e` 全部通过（现有的小芯浏览器测试不受影响）。截图自查四个宽度：390、768、1024、1280，浅色和深色各一套。
- [ ] **Step 5: 提交**：`git commit -m "网页：发消息「已收到」后显示等待状态，刷新后接着等；回复改用 SSE，失败退回轮询"`

### Task 10: 上线开关、正式站联调加项、文档，然后发布

**Files:**
- Modify: `wrangler.jsonc`（正式站的 `vars` 加 `"XIN_TRANSPORT": "kernel", "XIN_INBOX": "1"`；测试站不加）
- Modify: `scripts/test-xin-live.py`
- Modify: `docs/CHANGES.md`、`README.md`（小芯部分）、`docs/xin-handoff.md`（当前进行中）、`docs/xin-kernel-design.md`（§9 补上正式环境的结果）

**Interfaces:**
- Consumes：所有前面的任务。
- Produces：`test-xin-live.py` 里新加两项检查，只在 `/api/xin/me` 回 `stream:true` 时做：
  1. 第一轮聊天发完后，`call('delivery', {id: 那句的 clientId})` 回 `state === 'delivered'`，而且 `result.run` 和 `send` 拿到的 `run` 一样。
  2. 用 `context.request.get(BASE + '/api/xin/stream?run=…&off=0', headers={'X-Xin':'1'})` 读到底：`content-type` 是 `text/event-stream`，至少有一条 `data:`，最后一条的 `done` 为真。

  只打印检查结果，不打印任何回应体。

- [ ] **Step 1: 改 `wrangler.jsonc` 和 `test-xin-live.py`**，写好文档。
- [ ] **Step 2: 本地全量验证**：
  - `npm run check` 全过。
  - `npm run test:e2e` 全过（`CHROMIUM_PATH` 指向 `/opt/pw-browsers` 里的 chrome）。
  - `npx wrangler deploy --dry-run` 打包成功，不报缺绑定。
- [ ] **Step 3: 提交并推到会话分支**：`git push -u origin claude/xiaoxin-architecture-review-2dkunv`。然后开 PR，说明里写清：
  - 参考了哪些项目：OpenMuse 的任务租约、Hermes 的「大脑常驻、执行环境可休眠」、OpenClaw 的设备配对思路（第 6 步才用到），以及 ACP / MCP 的接口形状（后面几步才用到）；
  - 两个开关和怎么回滚；
  - 手动回滚整个版本前要先看待送达是不是空的。
- [ ] **Step 4: 等 Actions 的检查和测试站部署都变绿**，自己合并 PR。
- [ ] **Step 5: 确认正式站那次 Actions 运行是绿的**，包括正式站联调和新加的两项。失败时 Actions 会自动回滚；之后读日志、修好，回到 Step 2。
- [ ] **Step 6: 在正式站上看一眼**：只读地查 InstaBox 端口列表，`xin-kernel` 端口在、是 private，小芯原来的 3 个端口没动。把正式环境里送达和流式的结果补进设计文档 §9，提交。
