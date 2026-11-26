# 删掉网站上的小芯和天启（页面上的小人保留）

站长 2026-11-26：「小人留，其他删」，同意删 Durable Object 里的数据。小芯、天启当天已停用（定时任务撤了、联调删了、云电脑上的服务停了）。

## 设计（Claude Code 定的，站长批准了要删的清单）

- **整块删，不留兼容层。** 只有两处必须做的收尾：
  - Durable Object 用迁移 `deleted_classes` 删掉。
  - `sw.js` 换成自注销脚本。它原来只给小芯推送通知用；直接删掉的话，已经注册过它的浏览器会一直留着旧的。
- **保留**：页面上的小人（`mascot.js`、`mascot.css`、标题栏里的 `#xinTrack`，类名不改）；STM32 学习台（完整推导、自主推导都是学习台自己的）；世界地图；首页。
- **删掉**：
  - 小芯：聊天、工作台、终端、用量、备份、登录。
  - 天启：工具卡片、「天启」分类、首页星盘卡和面板样式、`/tools/tianqi/`。
  - Worker 里的 `/api/xin`、`/api/tq` 和 `src/xin*.js`，以及 Durable Object、登录限流、`XIN_*` 变量。
  - 发布流程里写小芯密钥的一步、冒烟检查里小芯和天启的 4 个地址。
  - 学习台的 `learning.js`（只把学习记录报给小芯），以及各处 `if (STM.learning)` 的调用。
- **小人和聊天的连线**：`mascot.js` 里读 `window.LimingXinChat` 的几处（学会的动作、好感度、「陪它玩」上报）删掉，小人只用自带的动作。
- **云电脑**：不动。小芯、天启的文件留着，`~/.xin` 里的网关 key 平板还在用。
- **删完站长要做的**：
  - InstaBox 后台吊销网站用的两把 key（li 账号、li2 账号各一把）；
  - GitHub Secrets 删 `XIN_OWNER_PASSWORD`、`XIN_INSTABOX_API_KEY`、`XIN_TQ_INSTABOX_API_KEY`；
  - 可选：Cloudflare 后台 liming-worldmap 的「变量和机密」删 `OWNER_PASSWORD`、`INSTABOX_API_KEY`、`TQ_INSTABOX_API_KEY`。

## 任务（每项先改测试看到红，或删掉被删代码自己的测试；改完跑 `npm run check`）

1. **Worker 和配置**：
   - `src/worker.js` 只留工具 assets 的 404、`/api/*` 404、静态资源；去掉 `scheduled` 和 DO 导出。
   - 删 `src/xin.js`、`src/xin-kernel.js`、`src/xin-inbox.js`。
   - `wrangler.jsonc`：正式站和测试站去掉 DO 绑定、`ratelimits`、`XIN_*` 变量；加迁移 `{ "tag": "v4", "deleted_classes": ["XinTaskSupervisor"] }`；`crons` 照旧是空数组。
   - `test/worker.test.cjs` 改成：`/api/xin/*`、`/api/tq/*` 回 404，没有 DO 导出，配置里有 v4 删除迁移。
2. **删小芯和天启的代码和测试**：
   - `site/xin/`、`site/tools/tianqi/`；
   - `test/xin*`、`test/tq*`（以及只给它们用的 helpers）；
   - `scripts/xin-backup-decrypt.mjs`；
   - `scripts/test-env.mjs`（如果只有小芯的测试在用）。
3. **首页和外壳**：
   - `index.html` 去掉 `chat.css`、`term.js`、`chat.js`、`#xinWork` 和开头那段 `#xin-work` 脚本；
   - `tools.js` 去掉天启和「天启」分类；
   - `shell.js`、`shell.css` 去掉天启星盘、`panel[data-id=tianqi]`、`current === 'tianqi'`、`.xc-*`、`.tq-*` 相关的分支；
   - 加一项静态测试：首页不引用 `/xin/`，`tools.js` 里没有天启。
4. **小人**：
   - 做法改了（执行时的决定）：这次只解绑。删掉 `mascot.js` 里读 `window.LimingXinChat` 的地方、给聊天报「陪它玩」的调用和背包里的「聊天」。
   - 小人里专给聊天用的接口（提问框、AI 工作状态、命令、学会的动作、好感度、聊天头像）牵连 `stm32_e2e.py` 里的一大段测试，单独开后续 PR 清理，免得这个 PR 太大、把小人改坏。
   - `test/mascot-eyes.test.cjs` 删掉和电脑端名单对照的那项。
   - `xin_motion_e2e.py` 里首页本身的检查（主题扩散换色、卡片插画、追光和火花）挪到新的 `home_e2e.py`，其余随聊天删掉。
   - `stm32_e2e.py` 删掉小芯聊天的部分；小人的检查留下，去掉对「聊天」的依赖。
5. **学习台**：
   - 删 `learning.js` 和它的 `<script>`；
   - 去掉 `deriveview.js`、`labprog.js`、`app.js` 里的 `STM.learning` 调用和 `_xinTyped`；
   - `xin_learning_e2e.py` 里测学习台本身的检查（推导、练习）挪进 `stm32_e2e.py`，测上报的删掉。
6. **`sw.js`**：换成安装后立刻注销自己的脚本，加测试。
7. **流程和工具**：
   - `deploy.yml`：去掉密钥那一步、开头的说明、浏览器测试里的小芯脚本、冒烟检查里的 4 个地址；
   - `package.json` 的 `test:e2e`；
   - `scripts/preview.mjs`；
   - `scripts/ci-e2e-report.mjs`；
   - `scripts/build-font.py` 的说明；
   - 相关测试（`ci-public`、`ci-proof`、`test-env`、`locked-helper`、`state-mode-helper`、`chromium-probe`）。
8. **文档**：README 删小芯、天启各节；`CLAUDE.md`、`AGENTS.md` 去掉小芯聊天那段（InstaBox 的规矩留着），「小芯的动作」改成「页面上的小人」；CHANGES、交接。以前的设计文档是历史，不动。
9. **验证和上线**：
   - `npm run check`、`npm run test:e2e`；
   - 截图自查首页和学习台：1280、768、1024、390，浅色和深色；
   - PR → CI、测试站 → 合并 → 正式站冒烟。核对 `/api/xin/me` 回 404、`/tools/tianqi/` 回首页、小人还在。
