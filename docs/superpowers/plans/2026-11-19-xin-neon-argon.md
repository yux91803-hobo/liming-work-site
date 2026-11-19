# 小芯后台模型：Neon 写代码、Argon 检查和查资料 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后台写代码改用 Gemini 4 Neon（High / 难题 Extra），检查和查资料用 Gemini 4 Argon，杂活、每日任务、电脑维护、看图用 DeepSeek；Antigravity 额度按 Gemini 池、Argon 池分开记录和派任务。

**Architecture:** `vm-runtime.mjs` 加 Antigravity 模型表（名字、额度池、档位），执行时按任务自己的模型拼 CLI 模型编号、查自己那个池。`vm-models.mjs` 改网关路由表和别名，加 `agyPick` 决定先用哪个 Antigravity 模型。`vm-agent.mjs` 派任务时按池的记录选模型、排候选，额度记录按池分文件，用量页两张卡。前台不动（仍是 Hydrogen）。

**Tech Stack:** Node.js ESM（控制器）、node:test、Python（正式站联调脚本）。

**Spec:** `docs/superpowers/specs/2026-11-19-xin-neon-argon-design.md`

## Global Constraints

- 模型编号：`gemini-4-hydrogen`、`gemini-4-neon`、`gemini-4-argon`；CLI 编号 = 模型 + `-` + 档位（`gemini-4-neon-xhigh`）。Argon 只有 `low`、`medium`、`high`。
- 额度池：Hydrogen、Neon → `gemini`（桶 `gemini-5h`、`gemini-weekly`）；Argon → `argon`（桶 `gemini-argon-wtu-weekly`）。
- 额度文件：Gemini 池 `antigravity-quota.json`（原文件，前台另有 `front-antigravity-quota.json`），Argon 池 `antigravity-argon-quota.json`。
- 网关路由表（逐字）：chat、quick、research、vision、daily、system = `['deepseek-v4.1-flash']`；code、hard = `['glm-5.3','kimi-k3.1-pro','deepseek-v4.1-flash']`；review = `['glm-5.3','deepseek-v4.1-flash']`。
- Antigravity 先用：code → Neon high，hard → Neon xhigh，review → Argon high，research → Argon medium；Gemini 池用完时 code、hard 改 Argon high；其余类别不用 Antigravity。
- `AGY_MODEL` 仍是 `gemini-4-hydrogen`（前台用），前台代码不改。
- 提交、PR 和交接记录按实际分工署名。Task 1、2 由 Claude Code 实现，Task 3、4 由 Codex 接续；自查和独立复核分别记录。

## Review Focus

1. 账号的 `/usage` 里没有 Argon 分组（换了套餐）：Argon 任务应转交下一个候选完成，不能卡死或整个失败。（Task 3 测试「没有 Argon 额度信息」）
2. 旧的 `antigravity-quota.json`（记录里 model 是 `gemini-4-hydrogen`、已标用完）：仍应算 Gemini 池用完，写代码改派 Argon。（Task 3 测试「Gemini 池用完」直接写旧格式文件）
3. 检查要独立：写代码的是 Argon（Neon 额度用完退过去的）时，检查不能再派给 Argon。（Task 3 派任务测试）
4. Neon 跑到一半额度用完：换 Argon 时思考强度要用 Argon 的 high，不能用网关的 `max`。（Task 3 额度用完测试）
5. 点名「Gemini 4 Hydrogen」的写代码任务（正式站联调就这么点）：照旧 Hydrogen high。（Task 3 派任务测试）

---

### Task 1: Antigravity 模型表、CLI 编号和按池查额度

**Files:**
- Modify: `site/xin/vm-runtime.mjs:1048-1060`（模型常量、`agyEffort`、`agyProviderModel`），`antigravityWork`、`readAntigravityQuota`（按模型）
- Modify: `site/xin/vm-usage.mjs:41`（`AGY_MODELS`）
- Test: `test/xin-antigravity.test.cjs`、`test/xin-usage.test.cjs`

**Interfaces:**
- Produces（`vm-runtime.mjs`）：
  - `AGY_CATALOG`：`{ [id]: { name, pool: 'gemini'|'argon', efforts: string[] } }`，键顺序 hydrogen、neon、argon。
  - `AGY_NEON = 'gemini-4-neon'`、`AGY_ARGON = 'gemini-4-argon'`；`AGY_MODEL` 不变。
  - `isAgyModel(id) -> boolean`（表里有就是）；`agyPool(id) -> 'gemini'|'argon'|null`。
  - `agyEffort(kind, model = AGY_MODEL) -> string`：按 `AGY_KIND_EFFORT`（不变）取档，再降到这个模型有的最高档。
  - `agyProviderModel(model, effort) -> string`：`model + '-' + 降档后的 effort`；不认识的 effort 当 `high`。
  - `antigravityWork(t, options)` 新增 `options.model`（缺省 `AGY_MODEL`）；`readAntigravityQuota(binary, cwd, model = AGY_MODEL)`。
- Produces（`vm-usage.mjs`）：`AGY_MODELS = Object.keys(AGY_CATALOG)` 的同样三项（测试核对一致）。

- [x] **Step 1: 写会失败的测试**（`test/xin-antigravity.test.cjs` 新加）

```js
test('Antigravity 模型表：Hydrogen、Neon 在 Gemini 池，Argon 单独一池；没有的档位降到它最高的那档',async()=>{
 const r=await import(pathToFileURL(path.join(__dirname,'../site/xin/vm-runtime.mjs')).href);
 assert.deepEqual(Object.keys(r.AGY_CATALOG),['gemini-4-hydrogen','gemini-4-neon','gemini-4-argon']);
 assert.deepEqual(['gemini-4-hydrogen','gemini-4-neon','gemini-4-argon','glm-5.3'].map(r.agyPool),['gemini','gemini','argon',null]);
 assert.equal(r.isAgyModel('gemini-4-neon'),true);assert.equal(r.isAgyModel('gemini-3.8-flash'),false);
 assert.equal(r.agyProviderModel('gemini-4-neon','xhigh'),'gemini-4-neon-xhigh');
 assert.equal(r.agyProviderModel('gemini-4-argon','xhigh'),'gemini-4-argon-high');
 assert.equal(r.agyProviderModel('gemini-4-argon','max'),'gemini-4-argon-high');
 assert.deepEqual(['code','hard','review','research','quick'].map(k=>r.agyEffort(k,'gemini-4-neon')),['high','xhigh','high','medium','low']);
 assert.deepEqual(['code','hard','review','research'].map(k=>r.agyEffort(k,'gemini-4-argon')),['high','high','high','medium']);
});
```

在 `额度按组算` 那条测试的循环后补：`antigravityQuota(groups(.5,0),Date.now(),'gemini-4-neon').blocked === false`，`antigravityQuota(groups(.5,0),Date.now(),'gemini-4-argon').blocked === true`，`antigravityQuota(groups(0,1),Date.now(),'gemini-4-argon').blocked === false`。

`test/xin-usage.test.cjs` 里核对 `AGY_MODELS` 的断言改成等于 `Object.keys(runtime.AGY_CATALOG)`。

- [x] **Step 2: 跑测试确认失败**

Run: `node --test test/xin-antigravity.test.cjs test/xin-usage.test.cjs 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: 新测试 FAIL（`AGY_CATALOG` 未定义），用量一致性断言 FAIL。

- [x] **Step 3: 实现**：按 Interfaces 加常量和函数；`antigravityWork` 里 `provider = agyProviderModel(model, effort)`，`readAntigravityQuota(binary, clientDir, model)`；`vm-usage.mjs` 的 `AGY_MODELS` 列三项。注释写明站长 11-19 的安排和实测速度。

- [x] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: 0 fail。

- [x] **Step 5: 提交** `git commit -m "Antigravity 模型表：加 Neon、Argon，CLI 编号和额度按模型"`

### Task 2: 网关路由表、别名和名字

**Files:**
- Modify: `site/xin/vm-models.mjs`（`ROUTES`、`MODEL_ALIAS`、`OTHER_NAMES`/`modelLabel`，新增 `agyPick`）
- Test: `test/xin.test.cjs:974-1006`、`test/xin-antigravity.test.cjs`（别名那条）

**Interfaces:**
- Consumes: Task 1 的 `AGY_CATALOG`、`AGY_NEON`、`AGY_ARGON`、`agyPool`。
- Produces: `agyPick({ kind, poolOk = () => true, avoid = [] }) -> string|null`：code、hard → Neon（`poolOk('gemini')` 且不在 avoid），否则 Argon（`poolOk('argon')` 且不在 avoid），否则 null；review、research → Argon（同样条件），否则 null；其他类别 null。`agyNext({ kind, model, poolOk, avoid }) -> string[]`：model 是 Neon 且类别是 code、hard 时，Argon 可用就返回 `['gemini-4-argon']`，否则 `[]`。

- [x] **Step 1: 改测试**（`xin.test.cjs` 路由器那条）

```js
assert.deepStrictEqual(ROUTES,{chat:['deepseek-v4.1-flash'],quick:['deepseek-v4.1-flash'],code:['glm-5.3','kimi-k3.1-pro','deepseek-v4.1-flash'],research:['deepseek-v4.1-flash'],
  hard:['glm-5.3','kimi-k3.1-pro','deepseek-v4.1-flash'],vision:['deepseek-v4.1-flash'],review:['glm-5.3','deepseek-v4.1-flash'],daily:['deepseek-v4.1-flash'],system:['deepseek-v4.1-flash']});
for(const [k,ids] of Object.entries(ROUTES)){if(ids.includes('kimi-k3.1-pro'))assert.ok(['code','hard'].includes(k),'Kimi 只写代码：'+k);if(ids.includes('glm-5.3'))assert.ok(['code','hard','review'].includes(k),'GLM 只写代码和检查：'+k);}
assert.strictEqual(route({ kind: 'quick' }).model, 'deepseek-v4.1-flash');
assert.deepStrictEqual(route({ kind: 'quick', images: true }).fallbacks, []);
```

删掉 `route({kind:'quick'}).model === 'glm-5.3-flash'` 和 `quick+images` 的 `['glm-5.3']` 两条旧断言；其余旧断言不变（它们在新表下照样成立）。

`xin-antigravity.test.cjs` 别名那条改成：`['你让 Gemini 3.8 Flash 去画个奶龙','交给 Hydrogen 做','让 Gemini 4 Hydrogen 查一下']` → `gemini-4-hydrogen`；`['用 Gemini 写','用 antigravity 做','用 Neon 写','让 Gemini 4 Neon 来做']` → `gemini-4-neon`；`['让 Argon 查一下','交给 Gemini 4 Argon 检查']` → `gemini-4-argon`。并断言 `modelLabel('gemini-4-neon')==='Gemini 4 Neon'`、`modelLabel('gemini-4-argon')==='Gemini 4 Argon'`。

`agyPick`、`agyNext` 的纯函数测试（`xin-antigravity.test.cjs` 新加）：

```js
const ok=()=>true,noGemini=p=>p!=='gemini',none=()=>false;
assert.deepEqual(['code','hard','review','research','quick','daily','system','vision'].map(kind=>agyPick({kind,poolOk:ok})),
 ['gemini-4-neon','gemini-4-neon','gemini-4-argon','gemini-4-argon',null,null,null,null]);
assert.equal(agyPick({kind:'code',poolOk:noGemini}),'gemini-4-argon');assert.equal(agyPick({kind:'code',poolOk:none}),null);
assert.equal(agyPick({kind:'review',poolOk:ok,avoid:['gemini-4-argon']}),null);
assert.deepEqual(agyNext({kind:'code',model:'gemini-4-neon',poolOk:ok}),['gemini-4-argon']);
assert.deepEqual(agyNext({kind:'code',model:'gemini-4-neon',poolOk:p=>p!=='argon'}),[]);
assert.deepEqual(agyNext({kind:'research',model:'gemini-4-argon',poolOk:ok}),[]);
```

- [x] **Step 2: 跑测试确认失败**：`node --test test/xin.test.cjs test/xin-antigravity.test.cjs 2>&1 | grep -E "^not ok|^# (pass|fail)"` → 路由、别名、`agyPick` 测试 FAIL。
- [x] **Step 3: 实现**：`ROUTES` 照 Global Constraints；`MODEL_ALIAS` 里 Antigravity 部分按顺序 Neon（`(?:gemini[\s-]*4[\s-]*)?neon`）、Argon（`(?:gemini[\s-]*4[\s-]*)?argon`）、Hydrogen（`(?:gemini[\s-]*4[\s-]*)?hydrogen|gemini(?:[\s-]*[\d.]+)?[\s-]*flash(?:[\s-]*high)?`）、泛指的 Gemini/antigravity/agy → Neon；`OTHER_NAMES` 从 `AGY_CATALOG` 取名字；按 Interfaces 加 `agyPick`、`agyNext`。路由表上方注释写站长 11-19 的规则。
- [x] **Step 4: 跑测试确认通过**：同 Step 2 → 0 fail。
- [x] **Step 5: 提交** `git commit -m "网关路由：杂活、查资料、每日、电脑维护、看图用 DeepSeek；Kimi 只写代码，GLM 写代码和检查"`

### Task 3: 派任务、按池记额度、退路和用量卡

**Files:**
- Modify: `site/xin/vm-agent.mjs`（派任务 ~1575-1592、启动档位 ~1642、换模型 ~826-845、`agy-run` ~2925、`agy_quota` ~2513、`tasks` 输出 ~2465、用量 ~2047-2066、名字 ~2667、未知模型提示 ~1943 和 ~2683）
- Test: `test/xin-antigravity.test.cjs`（夹具和派任务相关的测试）、`test/xin-usage.test.cjs`

**Interfaces:**
- Consumes: Task 1 的 `isAgyModel`、`agyPool`、`agyEffort`、`AGY_CATALOG`；Task 2 的 `agyPick`、`agyNext`。
- Produces（`vm-agent.mjs` 内部）：`AGY_QUOTA_FILE = { gemini: 'antigravity-quota.json', argon: 'antigravity-argon-quota.json' }`；`agyPoolOk(pool) -> boolean`（该池文件没标用完，或已过 `retryAt`）；`tasks` 输出新增 `antigravityArgon`（Argon 池记录或 null）；用量 `quotas` 依次是 `{key:'gemini',name:'Gemini'}`、`{key:'argon',name:'Argon'}`（有读数才出现）。

- [x] **Step 1: 夹具和测试**
  - 夹具里假 `agy` 的 `/usage` 加 Argon 分组：`{id:'gemini-argon-wtu-weekly',remaining_fraction:mode==='argonquota'&&count>1?0:1,reset_time:七天后}`；`mode==='noargon'` 时不带这一组。
  - 把「后台优先派 Hydrogen，按类别定思考强度」那条改成：code → `gemini-4-neon` 且 agy 调用参数 `['gemini-4-neon-high','high']`；hard → `['gemini-4-neon-xhigh','xhigh']`；research → `['gemini-4-argon-medium','medium']`；quick 的 `task.model === 'deepseek-v4.1-flash'`；检查网关模型写的任务 → `gemini-4-argon` 且 `['gemini-4-argon-high','high']`；检查 Argon 写的任务 → `glm-5.3`；点名 `gemini-4-hydrogen` 的 code 任务 → `['gemini-4-hydrogen-high','high']`。
  - 新测试「Gemini 池用完：写代码改派 Argon High；Argon 池也用完交给网关」：写旧格式 `antigravity-quota.json`（`{model:'gemini-4-hydrogen',blocked:true,retryAt:一小时后,buckets:[…]}`）→ code 任务 `model==='gemini-4-argon'`、`fallbacks[0]==='glm-5.3'`；再写 `antigravity-argon-quota.json` 标用完 → code `glm-5.3`、research `deepseek-v4.1-flash`、review `glm-5.3`；Neon 正常时 code 任务 `fallbacks` 以 `['gemini-4-argon','glm-5.3']` 开头。
  - 「额度耗尽可在查过资料后转交其它入口」那条改用 code 任务（Neon）：额度用完后换到 `gemini-4-argon`，换过去那一轮的 agy 参数是 `['gemini-4-argon-high','high']`；Argon 跑完后 `antigravity-argon-quota.json` 存在、桶只有 `gemini-argon-wtu-weekly`；`f.call('tasks',{all:true}).antigravityArgon` 不为 null。
  - 新测试「没有 Argon 额度信息」：`mode='noargon'` 下 research 任务派给 Argon，最后由 `deepseek-v4.1-flash` 做完，`status==='done'`。
  - 卡住、没做完、命令没跑起来那几条（都用 research）：把断言里的 `gemini-4-hydrogen` 换成 `gemini-4-argon`（开工模型、`from`、15 分钟内不派、过后照常派）。
  - 「不交给 Hydrogen 的」那条改名为「不交给 Antigravity 的：带图片、电脑维护、看图、杂活」，并加：带图片的 code 任务 `model==='glm-5.3'`。
  - 点名 Extra：`task_new({kind:'code',goal:'x',userRequest:'用 Neon Extra 写个脚本'})` 的 agy 参数是 `['gemini-4-neon-xhigh','xhigh']`；`userRequest:'加一个 extra 按钮'`（没提 Neon）仍是 `['gemini-4-neon-high','high']`。
  - `xin-usage.test.cjs`：同时有两个池的文件时，`usage` 的 `quotas.map(q=>q.key)` 是 `['gemini','argon']`，名字 `['Gemini','Argon']`。
- [x] **Step 2: 跑测试确认失败**：`node --test test/xin-antigravity.test.cjs test/xin-usage.test.cjs 2>&1 | grep -E "^not ok|^# (pass|fail)"` → 上面这些 FAIL。
- [x] **Step 3: 实现**
  - 派任务：原 `preferAgy` 的前置条件保留（不是点名、不是每日、不带图片和插件、有 agy、不在卡住冷却期），模型改由 `agyPick({kind, poolOk: agyPoolOk, avoid})` 给；`fallbacks = [...agyNext(...), ...rt.fallbacks]`（去重）。
  - 带图片：`route` 的 kind 只有不是 review、code、hard 时才换成 vision。
  - 启动档位：Antigravity 模型用 `agyEffort(t.tkind, t.model)`；模型是 Neon 且用户原话（`t.userRequest`）匹配 `/neon[\s-]*(?:extra|xhigh)|neon\s*超高/i` 时用 `xhigh`。换模型时同样按新模型取档，不再一律 `AUTO_EFFORT`。
  - `agy-run`：传 `model: m.model`，`quotaState` 读这个模型所在池的文件。
  - `agy_quota`：按 `agyPool(a.quota.model)` 写对应文件；`quotaSample(a.quota.model, …)`。
  - 用量：`QUOTA_FILES` 加 Argon 卡（`pool: 'argon'`），筛选和预测都按池（`agyPool(x.model) === q.pool`），旧记录（model 是 hydrogen）照样算 Gemini 池。
  - `tasks` 输出加 `antigravityArgon`；任务模型名字用 `AGY_CATALOG[id].name`；未知模型提示列出三个 Antigravity 模型。
- [x] **Step 4: 跑测试确认通过**：同 Step 2 → 0 fail；再跑 `node --test test/xin.test.cjs test/xin-front-agy.test.cjs test/xin-agy-report-recovery.test.cjs` → 0 fail。
- [x] **Step 5: 提交** `git commit -m "后台派任务：写代码 Neon、检查和查资料 Argon，额度按池记，用量页两张卡"`

### Task 4: 网页图表、正式站联调、文档，全量验证

**Files:**
- Modify: `site/xin/chat.js:2769`（`SERIES` 加 `gemini-4-neon`、`gemini-4-argon`）；`site/index.html`、`site/tools/tianqi/index.html` 的 `chat.js?v=`（改成 `models-20261119`）
- Modify: `scripts/test-xin-live.py`（查资料默认应在 Argon Medium；退路原因用 `antigravityArgon`）
- Modify: `README.md`（第 17、40 行一带的默认安排）、`docs/CHANGES.md`、`docs/AI-HANDOFF.md`（含「下次核对 li2 内核 = 44620ed417e4」）
- Test: `test/e2e/xin_usage_e2e.py`（若断言了 `SERIES` 或卡片数量就跟着改）

- [x] **Step 1: 改联调脚本**：`AGY_RESEARCH = 'gemini-4-argon'`；研究任务的判断改成 `actual == AGY_RESEARCH`、档位 `medium`，打印 `PASS real default Antigravity Gemini 4 Argon (medium for research) and confined file output`；退路时 `explain_background_fallback(center.get('antigravityArgon'), …)`。点名 Hydrogen 那段不改。
- [x] **Step 2: 验证脚本语法**：`python3 -m py_compile scripts/test-xin-live.py && python3 -m pytest -q test/xin_live_policy_test.py` → 无报错、全过。
- [x] **Step 3: 网页**：`SERIES` 加两项（颜色照现有写法补齐），改 `?v=`。
- [x] **Step 4: 文档**：CHANGES（站长原话、实测速度、表格、不用 Orchestrator 的原因、参考 Antigravity 官方模型文档）、README 默认安排、交接记录。
- [ ] **Step 5: 全量验证**：`npm run check`（全过、测试数不少于改前的 1067）；起 `npm run dev` 后 `CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:e2e`（15 组全过）；用量页 1280 和 390、浅色和深色截图自查两张额度卡。
- [ ] **Step 6: 提交并开 PR**，CI 和测试站绿了合并；正式站联调绿了以后在 li 上只读核对：`antigravity-argon-quota.json` 已生成，最近的查资料任务实际模型是 `gemini-4-argon`。
