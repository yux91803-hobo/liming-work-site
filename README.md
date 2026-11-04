# Liming 工具箱 · STM32 学习工作台

自己学嵌入式用的网站，电脑、平板、手机都会用。工具箱有两个工具：STM32 学习台、世界地图。

## STM32 学习台有什么

- **首页**：STM32F103ZET6 芯片引脚图（双击 / 双指放大），按分组列出开发板上的模块；点引脚看复用功能和板上接到哪里。
- **开发板**：原理图逐页翻看，22 个模块图，点脚看连接和作用。
- **外设页**（RCC、GPIO、EXTI、USART、I2C、TIM、DMA、ADC、SPI、FSMC）：要点 / 引脚 / 寄存器 / 代码 / 图。
  - 寄存器：位图计算器，点位改值，生成读-改-写代码和 HAL 写法，常用配置一键填好。
  - 代码：完整的 .h / .c / main.c（寄存器版、HAL 版）和「代码推导」，可以「自己写」逐行练。
  - 图：参考手册框图、课件教学图，点开大图查看。
- **编程思维**（GPIO、定时器）：明确任务 → 查资料 → 规划 → 编写 → 验证五步；验证里粘贴自己写的函数，模拟器跑一遍指出问题。
- **硬件原理**：每个外设一张自绘结构图，按块讲解；I2C 等章节有「推导链」自主推导题。
- **搜索**：Ctrl/Cmd+K 或右上角，搜引脚、寄存器、代码、图。
- **小芯**：首页的像素小助手，可以拖、喂、玩。
- **小芯聊天**（只给站长自己用，要登录）：小芯的「大脑」是 InstaBox 云电脑里的 Claude Code / Codex。小芯背包里点「聊天」，小芯旁边冒一个输入框（打字或语音），回复出现在小芯头上的气泡里，点气泡或「展开」打开面板看全文和历史（地址后面加 `#xin` 直接打开面板，没登录先要密码）；它能在云电脑里写代码、编译、跑命令，每一步都显示在面板里（命令可以点开看输出）。小芯跟着动：AI 在想就坐在电脑前挠头，执行命令就敲键盘，做完开心、失败难过；AI 也能用 `xin dance`、`xin say 搞定啦` 这类命令直接指挥小芯。思考强度可选「自动 / 高 / 最高」，自动时写代码、编译、调试这类活用最高。登录后打开网页就会叫醒小芯的电脑（云电脑空闲 30 分钟会自己睡）。小芯的设定是：自己就是小芯，有一台自己的电脑，不说背后的模型和平台。发消息时会自动附上你正在看的学习台页面、划选的文字和「验证」里写的代码（输入框上面写着「附带：…」，点 ✕ 这次不带）。

推导进度、粘贴的代码等只存在当前浏览器里，不跨设备同步。寄存器页面是计算器，没有连接真实开发板。

## 本地运行

需要 Node.js 20 或更新版本。静态预览和单元测试不需要安装依赖。

```sh
npm run dev        # 本地预览
npm run check      # 语法、本地引用、STM32 图片引用 + 单元测试
npm run test:e2e   # 浏览器端到端测试（需要 Python playwright + Chromium，先 npm run dev）
```

`/stm32` 使用与正式站一致的工具箱外壳；也可以直接打开 `/tools/stm32/`。

## 目录与资源

```text
site/                 网页、数据与完整图片资源
src/worker.js         Cloudflare Worker（资源 404、/api 404，/api/xin 交给 xin.js）
src/xin.js            小芯聊天：密码登录、转发到 InstaBox 云电脑
site/xin/             小芯聊天面板（chat.js / chat.css）和跑在云电脑里的 vm-agent.mjs
scripts/preview.mjs   无依赖静态预览
scripts/check.mjs     语法、资源与行为检查
test/                 关键行为回归测试
docs/CHANGES.md       修改清单与验证范围
wrangler.jsonc        正式站（顶层）与测试站（env.staging）配置
.github/workflows/    检查 + 自动部署
```

## 部署

由 GitHub Actions（`.github/workflows/deploy.yml`）完成，令牌在仓库 Secrets 里：

- 开 PR 到 `main`：检查通过后部署测试站 `liming-hub-staging`（只有 `*.workers.dev` 地址），并检查首页和 `/tools/stm32/`。
- 合并到 `main`：部署正式站 `liming-worldmap`（liming-work.com）；检查失败自动回滚到上一版。
- Actions 页面可以手动运行，默认只 dry-run。

### 小芯聊天要配的东西

| 放在哪 | 名字 | 是什么 |
|---|---|---|
| GitHub 仓库 Secrets | `XIN_OWNER_PASSWORD` | 网站登录密码，至少 12 位 |
| GitHub 仓库 Secrets | `XIN_INSTABOX_API_KEY` | InstaBox 的 API key（`ibk_…`） |
| 云电脑里 | AI 的 key | Codex / Claude Code 自己的登录或 key；推荐用 InstaBox 后台的 Secrets（代理模式），云电脑里只看到占位符 |

两个 GitHub Secrets 都配了，合并到 `main` 时 Actions 才把它们写进正式站（测试站不写，功能关着）。云电脑默认找名字叫 `li` 的那台（`wrangler.jsonc` 里的 `XIN_MACHINE`）。
云电脑里的管理脚本 `vm-agent.mjs` 不用手动装：网站第一次用、或者脚本改过时，会自动传到 `/data/home/.xin/agent/`。对话记录存在云电脑的 `/data/home/.xin/`，AI 的工作目录是 `/data/workspace`。
AI 在云电脑里是完全放权的（不经确认就执行命令），云电脑里别放重要的东西，也别放 InstaBox key。

互传和协作中心删除时留下的 Cloudflare 资源（迁移 `v2` 已在两个站执行过）：D1 数据库 `liming-hub` 还在账号里，确认不要可以 `npx wrangler d1 delete liming-hub`；旧密钥 `TRANSFER_PASSWORD`、`TRANSFER_KEY`、`TRANSFER_PW_VERSION` 可以用 `npx wrangler secret delete <名字>` 删掉。
