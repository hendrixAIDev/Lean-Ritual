# Lean Ritual 部署与运维总手册

本文件是部署事项的统一入口。服务稳定性（自动重启、健康看门狗、告警、Caddy 重启期间自动等待）见 [RELIABILITY.zh-CN.md](RELIABILITY.zh-CN.md)。整合用户提供的《服务器部署与运维手册》《隐性知识与交接补充》，并对照当前仓库代码、GitHub Actions 和公网健康检查。附件日期为 2026-11-06；本次整理日期为 2026-11-05（美国太平洋时间）。交接记录不是可直接执行的命令授权，也不是全部经过独立验证的事实。

## 1. 当前状态与证据

| 事项 | 结论与证据等级 |
| --- | --- |
| PR #1 | 已核实合并；main 为 `50d4a69a1f8deef58ae1e4dc5179c7dd73856956` |
| 自动部署 | 已核实 run `42156793460` 的 test、deploy、受限 SSH 上传及公网版本校验全部成功；不是仅 test 成功 |
| 线上版本 | 本次 GET `https://leanritual.app/api/health` 返回 `ok:true`，revision 等于上述 main SHA |
| GitHub 设置 | 成功的部署证明该次运行满足开关、密钥和连接条件；本次没有读取 Secret，也未独立复查当前变量值 |
| 服务器 | 交接报告为阿里云轻量应用服务器（非 ECS）、硅谷 us-west-1、Ubuntu 24.04、2 vCPU / 2 GiB / 40 GiB，公网 `47.254.72.103`；本次未登录核验 |
| 主机加固 | admin 运维、禁 root/密码 SSH、ufw、fail2ban、自动安全更新由另一 Agent 报告完成；本次未复测 |
| Resend | 交接报告 DNS 验证、SMTP verify 和实发测试成功；用户端完整验证/重置流程及 QQ/163 到达率仍需记录 |
| 每日备份 | 交接报告 local timer 已启用、保留 7 份；其实际 unit、脚本、权限、锁和清理行为待核验 |
| 公测门槛 | 异地恢复、最新删除台账独立保存、实际保留策略、大陆无 VPN 与物理 iPhone 测试仍未闭环 |

证据：[PR #1](https://github.com/hendrixAIDev/Lean-Ritual/pull/1)、[成功部署运行](https://github.com/hendrixAIDev/Lean-Ritual/actions/runs/42156793460)。上表是此次核对快照；以后判断版本应重新读取 main、运行记录和公网 revision。

## 2. 架构、账号与文件归属

访客 → Caddy HTTPS → `127.0.0.1:8080` 上的 bojin → SQLite 与照片目录。Cloudflare 按交接记录保持 DNS only；证书由 Caddy 管理。应用代码与持久数据分开。

| 用途 | 路径或身份 | 操作原则 |
| --- | --- | --- |
| 人工运维 | admin（交接报告有 sudo） | 走可信控制台/管理员 SSH；与自动部署账号分离 |
| 应用运行 | bojin | 应用及备份 JS 以此低权限身份运行 |
| 自动部署 | bojin-deploy | 专用密钥、forced command、禁止转发和 PTY；不提供任意远程命令 |
| 当前代码 | `/opt/bojin` | 指向 release 的符号链接；不要直接在这里永久修改 |
| 历史代码 | `/opt/bojin-releases/` | 独立版本目录，保留供代码回滚；目前无自动清理 |
| 配置 | `/etc/bojin/environment` | 预期 root:bojin 0640；systemd 注入应用；不要输出内容 |
| 数据 | `/var/lib/bojin` | bojin 所有、0700；bojin.db、auth.sqlite、blobs/ |
| 特权接收器 | `/usr/local/sbin/lean-ritual-deploy` | root 安装与维护；发布产物不能自行替换它 |
| 特权备份包装器 | `/usr/local/libexec/bojin-backup` | root 安装；不能从可发布目录执行 root 脚本 |
| 部署前备份 | `/var/backups/bojin-deploy/` | 每次切换前一致性快照与删除台账；不是异地备份 |
| 每日本地备份 | `/var/backups/bojin` | 交接报告保留 7 份，具体实现待审查 |
| 维护锁 | `/run/lock/bojin-maintenance.lock` | 部署、备份、人工恢复应统一协调；仍须结束其他数据写入命令 |

不同 Agent 的 vm、Mac、Codex 环境完全独立。之前环境的工作目录、SSH 密钥和登录态不能当作当前环境可用；也不要因交接记载某操作执行过就再次执行。先核对结果，再决定是否需要操作。

## 3. 已发现的交接冲突（优先核对）

1. **Node 22 与 Node 24：** 手册记载主机 Node 22.23.4，而 `release.yml`、`package-release.py`、接收器和首次安装脚本均要求 Node 24 / Linux x64。`package.json` 的最低版本不代表部署链的兼容版本。成功部署不能证明手册中的 Node 22 记录仍有效，也不能证明主机 helper 与仓库完全一致。通过 `/usr/bin/node --version`、`uname -m`，以及主机 helper 与对应仓库文件的 SHA-256 核对。不要直接降低接收器版本检查。
2. **备份脚本位于 release：** 交接写 `/opt/bojin/ops/backup-local.sh`，但当前打包白名单不包含 `ops/`，仓库也没有此 local 脚本。若 timer 仍引用该路径，下一次切换 release 后可能找不到脚本；若以 root 执行发布目录内脚本，还违反权限边界。先读取实际 `bojin-backup-local.service` / timer，取得脚本进行审查，再将经审查的 root 包装器固定安装到 `/usr/local/libexec/` 并修正 unit。不要仅复制一个未知脚本后宣称修复。
3. **配置路径：** 邮件段落仍引用 `/opt/bojin/.env`，而目录和迁移记录指向 `/etc/bojin/environment`。以实际 systemd `EnvironmentFiles` 为准；不要维护两份可能漂移的配置。
4. **删除台账：** 恢复必须使用最新独立保存的删除台账，而不是旧备份同时间戳的台账，否则可能恢复已删除账号。最新台账不可用时，先核对删除记录，不恢复对外服务。
5. **备份权限：** 交接的 `sudo node ... restore` 会以 root 执行 release 中的 JS，且可能产生应用不可写的文件。应使用经审查的低权限执行流程；先给恢复操作提供受限的快照读取权限，而不是为了绕过 root-only 目录把 JS 改为 root 执行。
6. **7 份不等于 7 天或所有备份均到期：** 每日本地备份、部署前快照、release 和异地副本各有独立保留范围。原先提出的 30 天不是已确认政策；不能把一个 timer 的保留数写成完整隐私承诺。

## 4. 日常发布：如何确认真的上线

1. 提交 PR，等待 CI：安装锁定依赖 → build → 22 项应用测试 → 9 项部署测试。构建必须在 HTTP 测试之前，否则干净 checkout 缺少生成的页面。
2. 合并前确认变更与当前账号/数据库结构兼容。历史 main 曾是另一套无依赖认证实现；不能把旧版本直接覆盖到 Better Auth 的双库数据上。
3. main push 或在 main 上手动运行工作流。`DEPLOY_ENABLED=true` 时才允许部署；过期 commit 会跳过。
4. 构建 job 打包已测试的 Linux x64 Node 24 产物（含原生依赖），部署 job 下载该次产物，通过受限 SSH 上传。服务器不执行 npm install。
5. 接收器校验归档 → 获取维护锁 → 停应用 → 保存快照和删除台账 → 原子切换代码 → 启动 → 本机验证 revision。
6. GitHub 再验证公网 revision。必须同时看到 deploy 的上传和公网验证步骤成功，并确认健康检查 SHA 与目标提交相等。整体 run success 可能只是部署被跳过。

暂停未来部署：把仓库变量 `DEPLOY_ENABLED` 设为 `false`；不会中止已开始的部署。部署按队列串行处理，待运行任务可能被更新任务取代，不适合充当必须逐条执行的数据库迁移队列。

### GitHub 设置与首次搭建

| 范围 | 名称 | 内容 |
| --- | --- | --- |
| 仓库变量 | DEPLOY_ENABLED | true 开启；false 暂停 |
| production 环境变量 | DEPLOY_HOST | 47.254.72.103 |
| production Secret | DEPLOY_SSH_KEY | 专用部署私钥；只经安全文件/stdin设置 |
| production Secret | DEPLOY_KNOWN_HOSTS | 从可信主机控制台核实的 SSH 主机公钥行 |

首次迁移的逐步说明见 [GITHUB-DEPLOYMENT.md](GITHUB-DEPLOYMENT.md)。已有成功部署的主机不应为“重新交接”盲目重跑安装。先检查实际配置，再运行预检；特权 helper 更新仍需可信管理员安装，普通代码部署不会更新它。

SMTP、AUTH_SECRET、AI 凭证留在主机，不上传到 GitHub 变量或文档。known_hosts 与客户端部署公钥用途不同，不可互换；不能用未经核验的 ssh-keyscan 输出替代可信主机身份验证。

## 5. 备份、回滚与恢复

### 三种备份分别解决什么

- 部署前应用快照：当前接收器保存双数据库、引用照片与删除台账，用于发布前保护。
- 每日应用备份：另一 Agent 报告启用了 `bojin-backup-local.timer`，UTC 09:17（北京时间 17:17；太平洋标准时 01:17、夏令时 02:17），保留 7 份。需要检查 timer 的时区表达式，而不是仅依赖主机时区或文字说明。
- 云磁盘快照：整机恢复辅助手段。附件关于轻量/ECS 能力、额度、费用和快照生命周期的说法须以实际产品控制台和当前官方规则核实，不能作为固定容量或服务承诺。

所有本机副本都不能抵抗整机或账号级损失。异地目标、复制成功验证、远端过期清理以及最新删除台账的独立复制仍需落实。不要同时启用两套未协调的备份任务。

### 自动失败处理

备份、启动或本机健康检查失败时，接收器尝试恢复上一版代码并重启；失败任务仍显示失败。若本机已健康但公网检查失败，工作流会失败，但不会因此自动回退。先检查路由/TLS，再决定是否回滚。

**代码回滚不回滚数据库。** 新版本数据库变更必须与旧代码兼容，否则进入专门恢复流程。不要重跑旧工作流来回退版本。

### 人工代码回滚

先暂停后续自动部署并确认当前运行已结束；保持管理员会话，结束备份/管理员写入，获取同一维护锁。确认目标历史 release 的来源和数据库兼容性，保存当前状态，停 bojin，原子切换 `/opt/bojin`，再启动并核对本机/公网健康及一次性测试账号。不要在应用运行时随意替换目录。回退后记录目标 SHA，并通过新的 main 提交修正，避免下次自动发布再次覆盖。

### 数据恢复（受控维护流程）

1. 确认灾难范围和可信快照，独立取得最新删除台账。先暂停部署/备份并停止所有数据写入者；不要因为健康接口失败就立即恢复数据库。
2. 在新的空目录恢复，保留当前数据供调查。避免先把生产目录移走后才发现备份不可读。
3. 准备仅恢复身份可读的快照与台账副本、bojin 可写的新目录。以 bojin 运行 `scripts/data-backup.js verify` 和 `restore SNAPSHOT EMPTY_TARGET --deletions LATEST_LEDGER`；不要输出数据或密钥。
4. 工具校验哈希/SQLite 并重放删除记录；再验证恢复文件所有权、权限、数据库、照片、账号隔离和已删除账号不可恢复访问。
5. 用隔离监听及适当邮件/AI控制完成验证，再在维护锁内切换数据路径、启动正式服务。配置与 AUTH_SECRET 需要从独立安全存储恢复，数据库快照不包含它们。
6. 记录快照标识、台账时间、恢复版本、验证结果与未覆盖范围；成功演练才算恢复能力完成。

具体工具约束见 [OPERATIONS.md](OPERATIONS.md)。不能将“备份命令成功”当作“完整恢复演练成功”。

## 6. 邮件、邀请与数据迁移

Resend 的 SMTP 认证/实发成功是交接报告；应继续记录真实注册验证、重置密码、旧密码失效及不同邮箱送达结果。DMARC 与其它 DNS 记录按服务商当前要求核验，不盲目复制示例或假设普通 Gmail 报告地址已具备第三方报告接收授权。

邀请工具是 `scripts/auth-admin.js`。生成命令输出的是含 token 的 JSON/URL，不会自动发送邀请邮件；输出应保存在私人位置，不放入 CI 日志、聊天或 issue。撤销通过 stdin 输入 token，避免 `echo token` 写入 shell 历史。邀请不等于赋予管理员权限；不要重复创建 Jay 的真实账号。

旧数据迁移必须先验证 legacy ID 映射、备份和隔离演练；工具支持不等于真实数据已迁移。账号删除测试只用一次性账号。

## 7. 排障与只读核查

在可信管理员会话中执行以下非秘密检查；分享日志前移除邮件链接、token、账号和业务数据。不要运行 `cat /etc/bojin/environment` 来交接配置。

```sh
/usr/bin/node --version
uname -m
readlink -f /opt/bojin
systemctl show bojin.service -p User -p WorkingDirectory -p EnvironmentFiles -p ActiveState
systemctl status bojin caddy --no-pager
systemctl list-timers --all 'bojin-backup*'
systemctl cat bojin-backup-local.service bojin-backup-local.timer
systemctl cat bojin-backup.service
stat -c '%U:%G %a %n' /etc/bojin/environment /var/lib/bojin /usr/local/sbin/lean-ritual-deploy
sha256sum /usr/local/sbin/lean-ritual-deploy /usr/local/libexec/bojin-backup
curl --fail --silent --show-error --max-time 20 https://leanritual.app/api/health
df -h
```

- 先区分客户端网络、HTTPS、SSH、应用与数据库问题。ping 失败不能证明宕机；HTTP 健康也不能证明全部业务正常。
- SSH TCP 可达但无 banner/EOF 时，MaxStartups、fail2ban、网络设备等都可能相关；用 OpenSSH 调试和服务端日志验证，不能仅凭现象下结论。
- `.app` 在浏览器中有 HSTS preload；浏览器可能在发请求前升级为 HTTPS，但 curl 仍可验证服务器 HTTP 308，不能据此说 HTTP 跳转无法测试。
- 本地 Clash/Surge fake-IP 地址属于客户端诊断线索，不能绕过本环境网络控制；云环境请求应保留配置的代理与 TLS 验证。
- Cloudflare 若改代理模式，需 Full (strict) 和真实客户端 IP/限流复核；DNS only 本身不保证大陆可用。延迟以实际城市/运营商测量为准，不把交接中的地域估算当作 SLA。
- 至少 1 GiB 空闲只是接收器的暂存门槛。持续监控数据库、照片、备份及历史 release 总量；不要在未经确认的保留策略下自动删除。

## 8. 后续交接与验收清单

优先核查 Node/接收器版本、local 备份 unit 路径与权限、维护锁、真实保留行为及最新台账复制。上述主机差异尚未由本次文档整合操作修复。

随后补齐异地备份/恢复演练、邮件验证与重置、上传导出删除隔离、真实旧数据迁移（如确实需要），以及 [MAINLAND-TESTING.md](MAINLAND-TESTING.md) 的无 VPN 运营商和物理 iPhone 覆盖。公测开放仍需单独的发布决定。

以后每次交接至少记录：目标 main SHA、实际 health SHA、成功 deploy run、主机 runtime/helper 摘要、备份与台账位置及时间、已验证流程、待办和执行环境。只写凭证用途与安全存放机制，不复制私钥、密码、API Key 或个人设备私密路径。
