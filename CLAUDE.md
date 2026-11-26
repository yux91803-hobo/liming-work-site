# liming-work-site

Liming 工具箱 / STM32 学习工作台，正式站 https://liming-work.com （Cloudflare Worker `liming-worldmap`）。
用户自己学嵌入式用，不给别人用；电脑、平板、手机都用，主要看知识点和代码。

## 沟通

- 用中文；时间用北京时间。
- 用户不看测试站，也不逐个审 PR：**从写代码到上线全流程交给当前接手的 AI 完成**，做完告诉用户改了什么、线上是否已更新。
- Claude Code 与 Codex 按额度轮流接手。开始工作先读 [AGENTS.md](AGENTS.md) 和 [交接记录](docs/AI-HANDOFF.md)，核对远端与工作区实际进度。提交或 PR 分别记录实际实现与复核责任；审核者不冒充代码作者，修改前一位实现要记录原因。

## 遇到问题先去 GitHub 找办法

站长定的规矩（2026-11-11）：**只要出现问题——bug、测试或联调失败、模型不听话、设计和交互怎么做——先去 GitHub 看成熟开源项目是怎么解决的，不要自己闭门造轮子。**

- 先找做同类事情的项目（AI 代理 / 聊天：opencode、openai/codex、cline 等；前端设计：impeccable、anthropics 的 frontend-design、ui-ux-pro-max 等），读它们的源码、提示词和 issue，弄清楚它们的结构和做法。
- 照着成熟做法改，按本项目的情况做必要的取舍；PR 说明和 docs/CHANGES.md 里写清参考了哪个项目、哪个文件或做法。
- 找不到可参考的再自己设计，并在说明里写明「没找到现成做法」。
- 例子：#115 前台把后台任务情况当成要回的话。参考 opencode 的 `<subagent>`、Codex 的 `<subagent_notification>`，改成单独一条、带标签，用户原话放最后。

## 页面上的小人（小芯）的动作

站长定的规矩（2026-11-15）：发现小芯的动作有不合理的地方，可以直接改掉或改良，不必为了保留原来的动作把代码或测试弄得很繁琐。改了照常测试、截图自查，写进 docs/CHANGES.md。

## 上线流程

1. 从最新 `main` 开 `claude/...` 或 `codex/...` 独立分支；接续未合并工作时从已核对的提交另开分支，保留原分支与作者。
2. 本地验证：`npm run check`（语法、资源引用、单元测试）和 `npm run test:e2e`（浏览器测试，本机用 `CHROMIUM_PATH` 指向 /opt/pw-browsers 里的 chrome）必须全过；改了页面就 `npm run dev` 起本地预览，用 Chromium 截图自查电脑（1280）、平板竖屏（768）和横屏（1024）、手机（390），浅色和深色。
3. 开 PR → GitHub Actions 跑单元测试和浏览器测试，通过后自动部署测试站 `liming-hub-staging`（只有 `*.workers.dev` 地址，不绑正式域名）并做冒烟检查。
4. 检查和测试站都绿了，Claude 自己合并 PR → Actions 自动部署正式站，冒烟检查失败会自动回滚到发布前记录的版本。
5. 合并后确认正式站那次 Actions 运行是绿的，再向用户汇报。

部署配置：`wrangler.jsonc`（顶层 = 正式站，`env.staging` = 测试站），`.github/workflows/deploy.yml`（`DEPLOY_ENABLED` 是总开关）。令牌在 GitHub Secrets（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`），会话里读不到，部署只走 Actions。

小芯聊天和天启 2026-11-26 删了（站长：「小人留，其他删」）：只留页面上的小人（`site/mascot.js`、`site/mascot.css`），Worker 只剩静态资源和 404。li、li2 现在归平板上的 AI 用，平板的东西在 [tablet-setup](https://github.com/yux91803-hobo/tablet-setup) 仓库（改平板去那边，不走这里的发布）。会话里可能有 `INSTABOX_API_KEY` 环境变量：调 InstaBox API 前先读 https://instabox.sh/llms.txt ，删机器或快照前必须先问用户。不要用会话里的凭据去登录用户的网关面板。

## 底线

- README、docs/CHANGES.md 可能落后于代码；功能以代码和 docs/CHANGES.md 最新条目为准，改了功能顺手更新 README。
- 测试不过不合并；不跳过、不删测试来变绿。
- 会删数据的改动（Durable Object 迁移、删存储等）先停下问用户。
- 手动回滚：Actions 里正式站失败会自动回滚；也可以先从 deployments list 选取已验证的版本 UUID，再用 `wrangler rollback <版本UUID> --name liming-worldmap`（不要假定上一份上传版本就是稳定版本）。2026-11-26 的 v4 迁移删了 Durable Object 类，Cloudflare 不允许回滚到那次以前的版本。
