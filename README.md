# Liming 工具箱 · STM32 学习工作台

工具箱现在有两个工具：世界地图、STM32 学习台。互传和协作中心已经整个删掉（页面、接口和存储）。

## 本地运行

需要 Node.js 20 或更新版本。静态预览和测试不需要安装依赖。

```sh
npm run dev
```

打开终端显示的地址。`/stm32` 使用与正式站一致的工具箱外壳；也可以直接打开 `/tools/stm32/`。正式站的 Worker 只给缺失的工具图片回 404、给 `/api/*` 回 404，静态预览里 `/api/*` 同样不可用。

```sh
npm run check
```

检查所有 JavaScript 语法、HTML 本地依赖、STM32 图片引用，并执行行为测试。测试覆盖局部配置保留其他引脚、无隐式复位、只写/清标志语义、定位参数校验、笔记数据和搜索。

## 使用改进

- **寄存器代码**：默认复制项只修改选中的字段。“完整寄存器值”单独折叠、单独复制，明确会覆盖其他字段。只写/写 1 生效、写 0 清除的代码只生成一次写入。
- **常用配置**：PF8、PB10/PB11 等跨端口配置会切换对应 GPIO 实例；GPIO HAL 配置补充结构体声明和该端口时钟使能。
- **准确定位**：引脚查询、寄存器/位段/实例/计算器值、代码标题、原理图、架构图、课件页都可分享。内嵌页同步外层地址；原有返回层级保留。
- **统一搜索**：工具栏“搜索”或 Ctrl/Cmd+K；涵盖引脚、寄存器、代码内容、课件章节、架构图及原理图标题。课件图片正文未做 OCR。
- **收藏与笔记**：在工具栏或图片查看器点“收藏”“记录/笔记”。可标记“还没弄懂 / 待练习 / 已掌握”，按内容筛选，导出、合并导入 JSON 备份。
- **阅读**：14 / 16 / 18 px 字号、代码自动换行、较深的辅助文字、对齐的桌面导航、窄屏横向标签栏。正文保留原生双指放大；图像区域继续独立处理缩放。

学习记录只保存在当前浏览器的本地存储里，不会自动跨设备同步。清理网站数据、使用隐私浏览或更换设备前，请导出备份。导入会合并，不清空已有记录；相同位置保留时间较新的内容。

寄存器页面是配置/解码计算器，没有连接真实开发板。局部片段需合入完成时钟与外设初始化的 STM32 工程。未做实板编译和运行验证。

## 目录与资源

```text
site/                 网页、数据与完整图片资源
src/worker.js         Cloudflare Worker（资源 404、/api 404）
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

互传和协作中心删除时留下的 Cloudflare 资源（迁移 `v2` 已在两个站执行过）：D1 数据库 `liming-hub` 还在账号里，确认不要可以 `npx wrangler d1 delete liming-hub`；旧密钥 `TRANSFER_PASSWORD`、`TRANSFER_KEY`、`TRANSFER_PW_VERSION` 可以用 `npx wrangler secret delete <名字>` 删掉。
