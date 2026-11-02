# liming-work-site

Liming 工具箱 / STM32 学习工作台，正式站 https://liming-work.com （Cloudflare Worker `liming-worldmap`）。

## 沟通

- 用中文；时间用北京时间。
- 用户不看测试站，也不逐个审 PR：**从写代码到上线全流程交给 Claude 独立完成**，做完告诉用户改了什么、线上是否已更新。

## 上线流程

1. 从 `main` 开 `claude/...` 分支改代码。
2. 本地验证：`npm run check`（语法、资源引用、单元测试）必须全过；改了页面就 `npm run dev` 起本地预览，用 Chromium 截图自查电脑宽度（1280）和手机宽度（390）、浅色和深色。
3. 开 PR → GitHub Actions 自动部署测试站 `liming-hub-staging`（只有 `*.workers.dev` 地址，不绑正式域名）并做冒烟检查。
4. 检查和测试站都绿了，Claude 自己合并 PR → Actions 自动部署正式站，冒烟检查失败会自动回滚到上一版。
5. 合并后确认正式站那次 Actions 运行是绿的，再向用户汇报。

部署配置：`wrangler.jsonc`（顶层 = 正式站，`env.staging` = 测试站），`.github/workflows/deploy.yml`（`DEPLOY_ENABLED` 是总开关）。令牌在 GitHub Secrets（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`），会话里读不到，部署只走 Actions。

## 底线

- 测试不过不合并；不跳过、不删测试来变绿。
- 会删数据的改动（Durable Object 迁移、删存储等）先停下问用户。
- 手动回滚：Actions 里正式站失败会自动回滚；也可以 `wrangler rollback --name liming-worldmap`。
