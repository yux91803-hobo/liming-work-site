# 小芯后台模型：写代码用 Neon，检查和查资料用 Argon，杂活回 DeepSeek（设计）

站长 11-19 在聊天里逐条定下；实现和自查：Claude Code（同一会话，没有另一位审核）。

## 1. 为什么

- Google 11-18 发布 Gemini 4 Neon，Antigravity 的 AI Pro 能用（li 上 `agy models` 实测有 `gemini-4-neon-{low,medium,high,xhigh}`）。站长：后台写代码换 Neon，默认 High，复杂的用 Extra（CLI 里叫 `xhigh`）。
- Antigravity 的额度分池（li 上 `agy -p /usage` 实测）：
  - Gemini 池：Neon、Hydrogen、Orchestrator (Neon)、Gemini 3.8 Flash 共用，`gemini-5h` + `gemini-weekly`。
  - Argon 池：只有 Gemini 4 Argon，`gemini-argon-wtu-weekly`（只有每周）。
  - Claude/GPT 池：不用。
- 站长：Hydrogen 和 Neon 同池，Argon 单独一池，要把 Argon 也用上；杂活用 DeepSeek，不用 Hydrogen；Kimi 只写前端和代码；GLM 只写代码和检查；每日任务、电脑维护也用 DeepSeek。

## 2. 实测（li，按小芯的单步调用方式，两轮）

| 配置 | 每一步 |
|---|---|
| Hydrogen High | 6～8 秒 |
| Argon Medium | ≈7.5 秒 |
| Argon High | ≈13 秒 |
| Neon High | 16～25 秒 |
| Neon Extra | ≈45 秒 |

## 3. 安排（站长 11-19 确认）

| 后台任务 | 先用 | 用不了时依次换 |
|---|---|---|
| 写代码（code） | Neon High | Argon High → GLM-5.3 → Kimi K3.1 Pro → DeepSeek |
| 难题（hard） | Neon Extra | Argon High → GLM-5.3 → Kimi K3.1 Pro → DeepSeek |
| 检查（review） | Argon High | GLM-5.3 → DeepSeek |
| 查资料（research） | Argon Medium | DeepSeek |
| 杂活（quick） | DeepSeek | — |
| 带图片的写代码 / 难题（Antigravity 不收图片） | GLM-5.3 | Kimi → DeepSeek |
| 带图片的检查 | GLM-5.3 | DeepSeek |
| 看图（vision） | DeepSeek | — |
| 每日任务（daily）、电脑维护（system） | DeepSeek | — |

- 「先用」的额度池已经用完（派任务时看各池记录）：直接从下一个开始，不白试。
- 检查要独立：写代码的是 Argon（Neon 额度用完退过去的）时，检查不用 Argon，从 GLM 开始。
- Hydrogen 后台不再默认用；点名还可以用。
- 点名照点名的用；点名 Neon 时带「Extra / xhigh / 超高」就用 Extra。
- 前台聊天不动（Hydrogen High，额度用完换 DeepSeek）；它和 Neon 同池，后台写代码多时前台可能更早换到 DeepSeek。

## 4. 不做

- Orchestrator (Neon)：小芯把 Antigravity 的原生文件、终端工具全关了，每次只让模型回一个动作、命令在小芯自己的沙箱里跑。Orchestrator 的「Neon 规划、Hydrogen 用原生工具动手」在这里用不上，而且思考强度固定。
- 不动前台、天启、Claude/GPT 池。

## 5. 给实现的人

1. `vm-runtime.mjs`：Antigravity 模型表（Hydrogen、Neon、Argon：名字、额度池、支持的档位）；`agyProviderModel(model, effort)`（这个模型没有的档位就降到它最高的那档，Argon 没有 xhigh）；按任务类别给（模型、档位）；`antigravityWork` 用任务自己的模型。`AGY_MODEL` 仍是 Hydrogen（前台用）。
2. 额度按池记：Gemini 池仍写 `antigravity-quota.json`，Argon 池写 `antigravity-argon-quota.json`；`agy-run` 按任务模型读对应池；用量页两张额度卡（Gemini、Argon）；`tasks` 接口把两个池都带上，联调按任务模型判断退路原因。
3. 派任务：按上表选 Antigravity 模型（池可用、没在卡住冷却期、不带图片插件、不是点名），否则走网关路由表。Neon 的候选里排上 Argon（Argon 池可用时）。
4. 运行中额度用完（退出码 75）或卡住（76）照旧只换一次，换到 Antigravity 模型时用这个模型在这个类别的档位（不是网关的 max）。
5. 网关路由表 `ROUTES` 改成上表；Kimi 只出现在 code、hard，GLM 只出现在 code、hard、review。
6. 名字、别名（neon、argon，hydrogen 排在泛指的 gemini 前面）、用量口径（`vm-usage.mjs` 的 `AGY_MODELS`）、图表系列、未知模型校验都认 Neon、Argon。
7. 正式站联调（`scripts/test-xin-live.py`）：默认的查资料任务现在应在 Argon Medium 上；点名 Hydrogen 的那步不变。

## 6. 风险

- Neon 每一步慢（16～45 秒），写代码任务会比 Hydrogen 时慢；换来的是更强的模型。
- 运行中两个池先后都用完：照旧只换一次，第二次失败就停（以前也是一次）。派任务时会先看池的记录，这种情况少见。
