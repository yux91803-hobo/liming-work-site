# 常驻内核持久服务实施计划

基于已确认的第二阶段设计 §6.7 / §7 第 1 批；实际实现 AI：Codex。接续 #140 和写者清单 #141，保留 Claude 原始实现；本批尚无独立 AI 复核。生产仍为 legacy，不开启状态所有者，不动用户数据库。

## 已验证前提

北京时间 2026-11-14 15:26 只读核对：小芯电脑 PID 1=systemd，UID=1000，Linger=yes，用户管理器 running；xin-reaper.timer enabled；xin-kernel.service active/transient，来自 /run/user/1000/systemd/transient。没有更改 linger 或重启电脑。此证据说明具备用户服务启动条件，不代表真实冷启动/暂停恢复已经验收。

## 实施与保证

1. `ensure` 在现有启动门内写私有启动环境、安装持久 `xin-kernel-resident.service`，`WantedBy=default.target` 并 enable；健康的同版本临时服务也要迁移，不能提前 already 返回而漏过安装。
2. 文件按内容更新并原子替换及 fsync；写入/启用前保存 0600 的 `kernel-service.pending.json`（prepared / activation），进程被杀后下一次先恢复旧配置再确认健康。恢复失败保留记录，不启动另一个实例。只维护本程序标记的同名单元，不覆盖站长手写单元。ExecStart 用绝对 Node/模块路径，正确处理空格、引号、反斜杠、百分号和美元符号，不写入真实凭据。serve 继续从 0600 的 kernel.env.json 取环境。
3. 保留 `KillMode=process` / `Restart=always` / `RestartSec=2`，避免换 HTTP 外壳时误杀现有执行进程。这个单元不是权限隔离边界；工具/宿主授权仍遵循已确认的 C 路线。
4. 安装/enable/start/健康失败恢复原单元与启用状态，不让半成品成为下一次开机配置。沿用临时服务/脱离进程回退以保证原有传输可用，结果如实报告 persistent=false；有总线不能冒充已成功持久化。
5. 同版本持久服务不重复重启；新版本更新服务并重启外壳；无总线保留原脱离启动。启动门继续兼容原 PID 文件，但不再因活进程超过 30 秒就夺走门；真实死进程可以接续。启动锁仍只管外壳引导，业务状态一致性由已有 owner.sqlite/桥负责，本批不换调度或写者协议。

## 验证

- 用临时 XIN_HOME、XDG_CONFIG_HOME、假 systemctl/systemd-run 驱动真实 Node HTTP 内核。原有健康、单次启动、升级、环境保留、无总线保证保留。
- 新回归：健康临时服务迁移；两个 ensure 争用；enable/start/健康失败恢复；单元不含环境秘密；引用特殊路径；外壳重启不杀执行进程；模拟用户管理器重新启动按持久文件启动、环境可用。
- 配置与进程模拟明确标注为模拟，不能替代真实 systemd/VM 冷启动。CI 正常发布后只读核对真实 FragmentPath、is-enabled、健康/模式；不对真实电脑做故障注入。
- 更新写者清单中的 shell 条目，不放宽 rmw/事务/行数约束。完整 check、kernel、12 组浏览器测试和 Actions/测试站通过后才合并，再核对正式站联调。

## 迁移与回滚

没有数据库/消息迁移。临时服务在 ensure 时转为持久服务。安装失败恢复原单元后保留旧启动途径。回到本批或以后的版本由 ensure 原位更新单元；回到不懂持久单元的 #140 及更早版本，先停用 `xin-kernel-resident.service` 并把本程序的 `xin-kernel-resident.service` 文件移到备份路径，再 daemon-reload，再由旧 ensure 起临时服务。保留 kernel.env.json、SQLite、runs、登录/记忆等全部数据；不能只回滚 Worker 就宣称开机单元也已回退。正常 Worker 自动回滚不删除电脑上的服务，需按此额外核验。

默认配置目录的回退示例（在小芯电脑上由可信维护入口执行；先核对实际 FragmentPath，使用自定义 XDG_CONFIG_HOME 时调整配置路径；最后一行换成已验证的旧哈希）：

```bash
set -e
test ! -e "$HOME/.xin/kernel-service.pending.json"
systemctl --user disable --now xin-kernel-resident.service
xin_backup="$HOME/.config/systemd/user/xin-kernel-resident.service.rollback-$(date +%Y%m%d-%H%M%S)"
test ! -e "$xin_backup"
mv "$HOME/.config/systemd/user/xin-kernel-resident.service" "$xin_backup"
systemctl --user daemon-reload
node "$HOME/.xin/agent/vm-kernel-<已验证旧哈希>.mjs" ensure --port 8797
```

若第一行前提检查失败，先用懂安装记录的新版本 ensure 完成恢复，保留记录供诊断，不能直接删除它。`disable --now` 沿用 KillMode=process，后台执行进程继续存在；不要用 kill 整个 cgroup 代替这些步骤。旧启动方式的模拟回归验证了备份和用户数据保留。

参考 [OpenClaw systemd-install.ts](https://github.com/openclaw/openclaw/blob/main/src/daemon/systemd-install.ts)、[systemd-unit.ts](https://github.com/openclaw/openclaw/blob/main/src/daemon/systemd-unit.ts) 的持久文件、daemon-reload/enable/启动和参数转义；[systemd.kill](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml) 的 KillMode。OpenClaw 的 mixed 杀组策略不适合当前执行器独立存活要求，因此保留本项目既有 process 策略。暂未找到与小芯临时单元、哈希模块和兼容回退完全相同的实现，事务/回退按本项目需求验证。


## 临时单元残留的实现调整

systemd [unit.c / unit_may_gc](https://github.com/systemd/systemd/blob/main/src/core/unit.c) 与 [service.c / service_may_gc](https://github.com/systemd/systemd/blob/main/src/core/service.c) 不回收仍有进程的单元。`KillMode=process` 下旧 `xin-kernel.service` 可能因后台任务保留 transient 定义。因此持久服务改用独立名字 `xin-kernel-resident.service`，旧临时服务只停主进程，不等后台任务退出；新服务校验实际 FragmentPath、MainPID 与健康 PID 一致且 is-enabled=enabled，不能只凭 HTTP 健康声称持久化成功。回退时恢复旧持久单元，或恢复仍存留的旧 transient 单元；它已回收时用已保存的旧哈希模块按原方法重建。

这不改变传输或状态所有者协议，也不新增权限。模拟覆盖后台工作继续完成、旧 transient 不回收时迁移和恢复；真正宿主上的启动条件仍由发布后只读核验确认。模块路径受 Node ESM 限制（反斜杠路径本来就不能作为模块入口）；环境/参数转义保留，实际启动与 systemd-analyze --user verify 覆盖空格、百分号、美元符号、引号。
