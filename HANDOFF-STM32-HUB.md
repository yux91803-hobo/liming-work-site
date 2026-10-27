# STM32 HUB 交接（2026-10-27 11:55 北京 · EXT1+EXT1b 已上正式站）

## 现状
- 正式站 liming-worldmap（https://liming-work.com/tools/stm32/）：**6b478c95**（EXT1+EXT1b 学习功能：搜索/记录/收藏/分享/Aa、手机 tab 一行、≤359px ⋯ 菜单；= 测试站 cbc3fafe），2026-10-27 11:08 北京部署；报告 `reports/report-prod-EXT1-20261027-1155.md`；冒烟 `project/hub/EXT1-prod-check/`（全过，0 console error）
- 回滚：**8cb7bdac**（T10）：`cd /workspace/worldmap && npx wrangler rollback 8cb7bdac-d4ee-41f2-99cd-8a76d08dd2d6`；备份 `archive/worldmap-backup-preEXT1-20261027-110836/`（含 ROLLBACK.txt）；再早 d88b828b（T9）
- GitHub 私有仓库 yux91803-hobo/liming-work-site 已同步到正式 6b478c95 源码（工作副本 /tmp/stm32repo）
- 正式站 /cdn-cgi/rum（Cloudflare 统计信标）在 webkit 下偶尔 requestfailed，测试脚本需过滤（EXT1-prod-check 已过滤）
- 以下为上线前记录：
- 正式站 liming-worldmap（https://liming-work.com/tools/stm32/）：**8cb7bdac**（T6+T7+T8+T10 新引脚高亮，对齐测试站 229a267a），21:40 部署
- 回滚：**d88b828b**（T9）；`cd /workspace/worldmap && npx wrangler rollback d88b828b-25f5-4b9a-b07c-b2ec203bf938`（更早：8bbd1b7f T6+T7+T8、d6893fbf HUB-T2）
- 备份：`archive/worldmap-backup-preT10-20261026-213958/`（stm32.js d756ec98 / stm32.css 0b1d45f5 + 其它顶层文件 + stm32-tree.md5 + ROLLBACK.txt）；更早 `archive/worldmap-backup-preT9-20261026-211717/`
- 测试站 liming-hub-staging：**cbc3fafe**（EXT1b：手机 tab 一行、≤359px 顶栏收进 ⋯ 菜单、导入恢复阅读设置；2026-10-27 约 10:20 北京部署）；回滚 **0a5ff36b**（EXT1）：`cd /workspace/limhub-staging && npx wrangler rollback 0a5ff36b-9d58-47b4-9015-5820b36d26da`；文件备份 `archive/staging-backup-preEXT1b-20261027-100841/`
- 上一版 测试站 EXT1 **0a5ff36b**（EXT1 外部 AI 学习功能增量，2026-10-27 09:41 北京）；回滚 **229a267a**（T10，=正式站）：`cd /workspace/limhub-staging && npx wrangler rollback 229a267a-7b2e-4ed1-9222-27dd0e31f19f`；备份 `archive/staging-backup-preEXT1-20261027-094020/`
- ⚠ EXT1 的 shell.js 是「staging shell（含 N2/N3 返回修复）+ 包 diff」合并版（存档 archive/merge-EXT1/shell.js，与 staging site/shell.js 相同）；正式站 shell.js 没有 N2/N3，上正式时要传合并版（staging 上这份），不能直接用包里的 shell.js。报告 reports/report-EXT1-staging-20261027-1006.md
- 报告：`reports/report-prod-T10-20261026-2145.md`；部署日志 `project/hub/HUB-prod-T10-deploy.log`；冒烟脚本/结果 `project/hub/HUB-prod-T10-check/`

## 验收摘要（T10 正式站）
- 线上 stm32.js 329b01c2 / stm32.css 8290c3bd 与测试站一致；只上传 2 文件，其余 552 资源未变
- 冒烟：t10 chromium 1280 浅 + webkit 390 浅 各 7/7（0.2s 高亮出现、0.6s 仍在、1.2s 完全恢复、快速切换无残留）；regs/深链/滚轮 3/3；t6zoom c1280rm 82/82（含课件、架构图）；/、/tools/stm32/ 200；0 console error
- 截图：`evidence/HUB-T10-prod-0.2s-chromium-1280-light-normal.png` 等

## HUB-T10（2026-10-26 21:40 北京 · 已上正式站 8cb7bdac）
- 用户嫌 T9 高亮太久、不好看 → 我们自己重做（未派 Hark）：去掉准星环 / 两圈波纹 / 整行色带；改为焊盘填 --clay + 柔光（SVG feGaussianBlur）+ 放大 1.15，信号名/脚号同色加粗，焊盘下方单圈 1.5px 扩散 450ms，其余脚 .35；总时长 1s（0–150 渐入 / 保持到 750 / 750–1000 淡出），JS 只加类 + 1 个 1000ms 计时器；高亮在页面滚到封装图停下后才开始（afterScroll）。减弱动效：无扩散/缩放，静态高亮 1s 后淡出。
- 代码：`project/hub/HUB-T10/`（stm32.js 329b01c2 / stm32.css 8290c3bd / 原件在 orig/）；验收脚本 `project/hub/HUB-T10-verify/`
- 测试站 liming-hub-staging：**229a267a**（T10）；回滚 **25634990**（=T9）：`cd /workspace/limhub-staging && npx wrangler rollback 25634990-2f55-451c-ac1f-36730048631c`；文件备份 `archive/staging-backup-preT10-20261026-212945/`（中间版 45a290a3 仅改时长、092e83cc 新视觉未等滚动，均已被覆盖）
- 用户「上把兄弟」→ 21:40 上正式站 8cb7bdac（只传 stm32.js / stm32.css），回滚 d88b828b
- 验收：t10 chromium1280 浅/深、webkit390 浅、chromium1280+webkit390 减弱动效 全过（7–8/7–8），0 console error；smoke regs/深链/滚轮 3/3；t6zoom c1280rm 82/82、w390 32/32
- 截图：`evidence/HUB-T10-0.2s-*.png`、`HUB-T10-0.6s-*.png`、`HUB-T10-1.2s-*.png`

## 接着做
1. T10 已上线，准星环遮字问题已随之解决；待用户反馈（电脑上滚动约 1s 后才高亮，如嫌慢可调快滚动）
2. 协作中心 hub-c3/c4 仍 pending（与本线无关）
3. 额度紧：勿派新单除非用户要求

## 规则
- 中文；时间北京；任务直接派 Hark；staging 先测；生产需用户 OK
- Hark：hark-2 优先，hark-4 备用，勿用 hark-3；发前确认头像菜单
