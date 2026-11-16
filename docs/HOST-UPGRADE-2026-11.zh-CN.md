# 阿里云宿主机一次性升级手册（2026-11 · PR #12/#13/#14/#16/#19 与 AI 开启）

GitHub Actions 自动部署仅更新 `/opt/bojin` 应用代码，**不会**更新宿主机上由 `root` 持有的辅助程序、systemd 单元与锁配置。本手册将近期合并的宿主机变更与 AI 启用整合为**单次、严格有序**的操作流程，供管理员以 `admin` 身份 SSH 登录（`ssh admin@47.254.72.103`）后顺序执行（全程约 15–20 分钟）。

## 升级总览与重启影响

| 步骤 | 内容（对应 PR / 决策） | 是否重启 `bojin.service` |
| --- | --- | --- |
| **0** | 拉取经审查的 `main` 提交并校验与线上 `/api/health` 一致 | **否** |
| **1** | 执行只读主机审计（PR #14 `scripts/host-audit.sh`）保存基线 | **否** |
| **2** | 备份旧文件，按 PR #19 顺序升级双锁包装器、接收器（#13）、每日备份（#16）、看门狗与告警（#12） | **否** |
| **3** | 手动跑通首次本地备份并确认旧 `bojin-backup-local.timer` 已停用 | **否**（注：离线一致性快照在锁内自动短暂 `stop`/`start` 约 2–5 秒；前端与 Caddy 自动重试，非配置重启） |
| **4** | 配置 `/etc/bojin-alert.env`（`0600 root:root`）并验证手机推送 | **否** |
| **5** | 配置 OpenRouter Auto Router 环境变量并重启应用生效 | **是（唯一显式 `systemctl restart bojin.service` 步骤）** |
| **6** | （可选）开启阿里云云盘自动快照策略作整机故障兜底 | **否** |
| **7** | 分步回滚说明（从 `sudo cp -a` 保存的原件恢复） | 视回滚项而定 |

> **两条铁律（全程遵守）：**
> 1. **切勿执行 `rm /run/lock/bojin-maintenance.lock`**：删除可能正被持有的 `flock` 锁文件会让后续进程锁在全新 inode 上导致并发冲突；PR #19 的双锁包装器会在 `fs.protected_regular=2` 返回 `EACCES` 时安全打开并锁住现有文件。
> 2. **切勿在聊天、Git、Issue 或命令行参数中粘贴任何密钥/告警 URL**：所有敏感配置一律用 `sudo nano` 直接写入受保护文件，且不要执行 `cat /etc/bojin/environment`。

---

## 步骤 0：获取经审查的 `main` 检出并校验线上版本

- **变更内容**：在 `~/Lean-Ritual` 克隆或更新官方仓库，并分离检出与当前公网 `/api/health` 完全一致的已审阅提交。不动 `/opt/bojin` 与任何系统配置。**不重启应用**。
- **执行命令**：

```bash
LIVE_SHA=$(curl -fsSL https://leanritual.app/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True; print(d["revision"])')
echo "Live revision: $LIVE_SHA"

# 如需锁定特定已审阅提交，可将 TARGET_SHA 设为该 40 位 SHA；默认对齐已自动部署上线的 LIVE_SHA
TARGET_SHA="$LIVE_SHA"
if [[ -d ~/Lean-Ritual/.git ]]; then
  git -C ~/Lean-Ritual fetch --prune origin
else
  git clone https://github.com/hendrixAIDev/Lean-Ritual.git ~/Lean-Ritual
fi
git -C ~/Lean-Ritual checkout --detach "$TARGET_SHA"
cd ~/Lean-Ritual

HEAD_SHA=$(git rev-parse HEAD)
[[ "$HEAD_SHA" == "$LIVE_SHA" ]] && echo "OK: checkout matches live ($HEAD_SHA)" || { echo "MISMATCH: head=$HEAD_SHA live=$LIVE_SHA"; false; }
git status --short
```

- **预期输出**：打印 `Live revision: <40位SHA>` 与 `OK: checkout matches live (<40位SHA>)`（确认该 SHA 与 GitHub `main` 最新合并提交一致），`git status --short` 无任何输出。
- **失败处理**：
  - 若 `MISMATCH` 或 `LIVE_SHA` 落后于 GitHub `main`：先打开 GitHub Actions 检查最新 `release.yml` 是否正在运行或失败，等线上版本对齐后再继续。
  - 若 `git clone/fetch` 网络超时：稍后重试，切勿改用未经校验的第三方镜像或跳过 SHA 比对。

---

## 步骤 1：运行只读主机审计（PR #14）

- **变更内容**：以 `root` 运行只读脚本 `scripts/host-audit.sh`（自动脱敏密钥与完整 URL），将升级前状态保存到 `/tmp/host-audit-before.txt`。不修改任何文件或服务。**不重启应用**。
- **执行命令**：

```bash
cd ~/Lean-Ritual
sudo bash scripts/host-audit.sh | tee /tmp/host-audit-before.txt
echo "--- 关注项汇总 ---"
grep -E '^(FAIL|WARN|Summary:)' /tmp/host-audit-before.txt || true
systemctl status bojin-backup-local.timer bojin-backup-local.service --no-pager 2>/dev/null || true
```

- **预期输出与重点核查项**：
  1. **必须为 `PASS` 的硬前提**：`PASS node v24.x`、`PASS architecture x86_64`、`Health ok: True`、`PASS AUTH_SECRET present`、`PASS Caddy validation`。
  2. **升级前属正常、将在步骤 2–5 消除的 `FAIL`/`WARN`**：
     - `FAIL DIFFERENT /usr/local/sbin/lean-ritual-deploy ...` 或 `WARN MISSING /usr/local/libexec/bojin-{backup,watchdog,alert}`（宿主机尚未更新 root 脚本，步骤 2 后会全部变为 `PASS MATCH`）。
     - `bojin-backup-local.service` 报 `FAIL ExecStart missing: /opt/bojin/ops/backup-local.sh`（或 `ExecMainStatus=203`）：记录其当前 timer 状态；步骤 2 的 `install-backup.sh` 会自动停用 `bojin-backup-local.timer`。若此时 `bojin-backup-local.service` 恰处于 `activating`/`active`，等它结束后再进步骤 2。
     - `WARN OPENROUTER_API_KEY empty/missing`、`WARN OPENROUTER_MODEL empty/missing`、`WARN ALERT_URL empty/missing`（步骤 4、5 配置后消除；`OFFSITE_DEST empty/missing` 按当前 7 天本机保留决策属预期 `WARN`）。
     - `WARN maintenance lock not root owned`（若 `/run/lock/bojin-maintenance.lock` 之前由非 root 创建：**切勿删除**，步骤 2 双锁包装器会自动兼容）。
  3. **需要额外留意的异常项**：
     - `FAIL leftover environment file: /opt/.../.env`：说明旧发布目录残留 `.env`。确认上方审计中 `bojin/environment present` 且 `AUTH_SECRET`/`SMTP_*` 均为 `PASS` 后，先用 `sudo mv /opt/.../.env /root/legacy-opt-env.bak && sudo chmod 0600 /root/legacy-opt-env.bak` 移出 `/opt`。
     - 磁盘空间（报告中 `df -h` 与 `du -sh /var/lib/bojin`）：确认 `/var/backups` 与 `/opt` 所在分区剩余可用空间 **大于 `size(/var/lib/bojin) + 1.5 GiB`**（备份与部署预检硬门槛）。
- **失败处理**：若出现 `FAIL node expected v24.x`、`FAIL Caddy validation` 或磁盘空间不足，**立即停止升级**，先排查基础运行环境或清理无关大文件。

---

## 步骤 2：备份旧组件并按 PR #19 顺序升级全部 root 辅助程序

- **变更内容**：
  1. 用 `sudo cp -a --parents` 将现有宿主机 root 脚本、systemd 单元与环境文件备份至 `/root/bojin-host-pre-202611-*`（权限 `0700`），并记录原本不存在的文件清单供回滚核对；
  2. 安装 `/etc/tmpfiles.d/bojin.conf`（开机自动创建 `root:root 0755` 的 `/run/bojin`）与过渡期双锁包装器 `/usr/local/sbin/bojin-maintenance-lock`（固定按“先 `/run/bojin/maintenance.lock`、后 `/run/lock/bojin-maintenance.lock`”加锁）；
  3. **在 `bojin-maintenance-lock` 保护下依次升级**：
     - SSH 部署接收器 `/usr/local/sbin/lean-ritual-deploy`（PR #13/#16/#19：双锁协调、`size(DATA_DIR)+1.5 GiB` 预检、手动停服防误拉起门控 `/etc/bojin/allow-deploy-when-stopped`、`root:root` 快照归属、下次部署起记录 `/opt/bojin-previous`）；
     - 每日备份与 7 天保留策略 `ops/install-backup.sh`（PR #13/#16/#19：安装 `/usr/local/libexec/bojin-backup`、`bojin-backup.{service,timer}`、初始化 `0600` 的 `/etc/bojin-backup.env` 默认 `BACKUP_RETENTION_DAYS=7`，停用旧 `bojin-backup-local.timer`）；
     - 看门狗、告警与重启策略 `ops/install-reliability.sh`（PR #12/#19：安装 `/usr/local/libexec/bojin-{watchdog,alert}`、每 30 秒日历定时器 `OnCalendar=*:*:0/30`、`TimeoutStartSec=60`、`bojin`/`caddy` `Restart=always` 附加配置，以及 `bojin-backup.service` 失败告警 drop-in）。
  - **不重启应用**（`bojin.service` 全程不断流）。

- **执行命令**：

```bash
cd ~/Lean-Ritual

# 2.0 保存现有 root 辅助程序、单元与环境配置副本（供步骤 7 回滚）
BACKUP_STAGE="/root/bojin-host-pre-202611-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -o root -g root -m 0700 "$BACKUP_STAGE"
echo "$BACKUP_STAGE" | sudo tee /root/bojin-host-pre-latest >/dev/null
sudo touch "$BACKUP_STAGE/absent-before.txt" && sudo chmod 0600 "$BACKUP_STAGE/absent-before.txt"
for f in \
  /etc/tmpfiles.d/bojin.conf \
  /usr/local/sbin/bojin-maintenance-lock \
  /usr/local/sbin/lean-ritual-deploy \
  /usr/local/libexec/bojin-backup \
  /usr/local/libexec/bojin-watchdog \
  /usr/local/libexec/bojin-alert \
  /etc/systemd/system/bojin-backup.service \
  /etc/systemd/system/bojin-backup.timer \
  /etc/systemd/system/bojin-watchdog.service \
  /etc/systemd/system/bojin-watchdog.timer \
  /etc/systemd/system/bojin-alert@.service \
  /etc/systemd/system/bojin.service.d/reliability.conf \
  /etc/systemd/system/caddy.service.d/reliability.conf \
  /etc/systemd/system/bojin-backup.service.d/alert.conf \
  /etc/systemd/system/bojin-backup-local.service.d/alert.conf \
  /etc/bojin-backup.env \
  /etc/bojin-alert.env \
  /etc/bojin/environment; do
  if sudo test -e "$f" || sudo test -L "$f"; then
    sudo cp -a --parents "$f" "$BACKUP_STAGE/"
  else
    echo "$f" | sudo tee -a "$BACKUP_STAGE/absent-before.txt" >/dev/null
  fi
done
echo "Saved pre-upgrade backup to: $BACKUP_STAGE"

# 2.1 预检活跃单元与锁文件状态（若 /run/lock/bojin-maintenance.lock 存在，确认是 regular file，切勿 rm！）
systemctl is-active bojin.service bojin-backup.service bojin-backup-local.service bojin-watchdog.service || true
stat -c '%U:%G %a %F %n' /run/lock/bojin-maintenance.lock /run/bojin 2>/dev/null || true

# 2.2 安装 systemd-tmpfiles 规则、创建 root:root 0755 /run/bojin，并安装双锁包装器
sudo install -d -o root -g root -m 0755 /etc/tmpfiles.d /usr/local/sbin
sudo install -o root -g root -m 0644 ops/bojin-tmpfiles.conf /etc/tmpfiles.d/bojin.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/bojin.conf
sudo install -o root -g root -m 0755 ops/maintenance-lock.sh /usr/local/sbin/bojin-maintenance-lock
stat -c '%U:%G %a %n' /etc/tmpfiles.d/bojin.conf /run/bojin /usr/local/sbin/bojin-maintenance-lock

# 2.3 最先在双锁下升级自动部署接收器，使后续 GitHub 自动部署立即走新旧双锁
sudo /usr/local/sbin/bojin-maintenance-lock -- \
  install -o root -g root -m 0755 ops/deploy-release.py /usr/local/sbin/lean-ritual-deploy

# 2.4 在双锁下安装/升级每日备份与 7 天保留策略（不重启 bojin.service）
sudo /usr/local/sbin/bojin-maintenance-lock -- bash ops/install-backup.sh

# 2.5 在双锁下安装/升级健康看门狗、告警与自动重启策略（不重启 bojin.service）
sudo /usr/local/sbin/bojin-maintenance-lock -- bash ops/install-reliability.sh

# 2.6 核验全部 SHA-256 哈希、文件属主权限、超时设置、定时器与看门狗日志
sha256sum ops/bojin-tmpfiles.conf /etc/tmpfiles.d/bojin.conf \
          ops/maintenance-lock.sh /usr/local/sbin/bojin-maintenance-lock \
          ops/deploy-release.py /usr/local/sbin/lean-ritual-deploy \
          ops/backup-service.sh /usr/local/libexec/bojin-backup \
          ops/health-watchdog.sh /usr/local/libexec/bojin-watchdog \
          ops/alert.sh /usr/local/libexec/bojin-alert
stat -c '%U:%G %a %n' \
  /etc/tmpfiles.d/bojin.conf \
  /run/bojin \
  /run/bojin/maintenance.lock \
  /usr/local/sbin/bojin-maintenance-lock \
  /etc/bojin-backup.env \
  /etc/bojin-alert.env
systemctl show bojin.service -p Restart -p StartLimitIntervalUSec
systemctl show bojin-watchdog.service bojin-alert@test.service bojin-backup.service -p TimeoutStartUSec
systemctl list-timers 'bojin-*' --no-pager
journalctl -t bojin-watchdog -n 20 --no-pager
```

- **预期输出**：
  - `sha256sum` 输出共 12 行，**每相邻两行（仓库源文件 vs 系统安装文件）哈希值完全一致**；
  - `stat` 显示 `/etc/tmpfiles.d/bojin.conf` 为 `root:root 644`，`/run/bojin` 与 `/usr/local/sbin/bojin-maintenance-lock` 为 `root:root 755`，`/run/bojin/maintenance.lock`、`/etc/bojin-backup.env`、`/etc/bojin-alert.env` 均为 `root:root 600`；
  - `bojin.service` 显示 `Restart=always`、`StartLimitIntervalUSec=0`；`bojin-watchdog.service` 与 `bojin-alert@test.service` 显示 `TimeoutStartUSec=1min`，`bojin-backup.service` 显示 `TimeoutStartUSec=30min`；
  - `systemctl list-timers 'bojin-*'` 同时列出 `bojin-watchdog.timer`（每 30 秒）与 `bojin-backup.timer`（每日 `04:00:00 UTC`）；
  - `journalctl -t bojin-watchdog` 无报错（若旧锁曾属非 root，标准错误或日志中出现一行 `Warning: ... opened existing file without O_CREAT for flock` 属预期兼容提示）。
- **失败处理**：
  - 若 `install-backup.sh` 提示 `Wait for active bojin-backup-local.service to finish first`：等待几十秒确认 `systemctl is-active bojin-backup-local.service` 变为 `inactive`/`failed` 后重跑 2.4–2.6。
  - 若报 `Refusing symlink ...` 或 `Refusing non-root ...`：立即停止，用 `ls -ld /run/bojin /run/lock/bojin-maintenance.lock /etc/tmpfiles.d/bojin.conf` 排查异常路径，切勿强行绕过；需回退时按**步骤 7** 恢复。
  - *运维备忘*：升级接收器后，如未来因维护人为 `systemctl stop bojin.service`，自动部署会默认拒绝以免误拉起服务；如需在停服状态下允许**单次**自动部署，执行 `sudo install -m 0600 -o root -g root /dev/null /etc/bojin/allow-deploy-when-stopped`（部署消费后自动删除）。

---

## 步骤 3：首次手动备份与旧定时器停用核验

- **变更内容**：手动运行一次 `bojin-backup.service` 生成首份 `root:root` 本地一致性快照（`/var/backups/bojin/snapshot-*`）与删除台账（`deletions-*.json`），并确认旧版 `bojin-backup-local.timer` 已彻底停用。
  - *关于服务中断说明*：无配置重启；`bojin-backup.service` 内部自带双维护锁（**切勿**在命令外再包一层 `bojin-maintenance-lock`，否则会等锁自锁），执行离线一致性快照时会自动 `stop` 再 `start` `bojin.service` 约 2–5 秒，前端与 Caddy 重试可平滑过渡。
- **执行命令**：

```bash
sudo systemctl start bojin-backup.service

systemctl list-timers --all 'bojin-backup*' --no-pager
sudo journalctl -u bojin-backup.service -n 30 --no-pager
sudo stat -c '%U:%G %a %n' /var/backups/bojin /var/backups/bojin/snapshot-* /var/backups/bojin/deletions-*.json
curl -fsSL https://leanritual.app/api/health && echo ""

# 确认遗留的 bojin-backup-local 已不再启用或运行
systemctl is-active bojin-backup-local.service || true
systemctl is-active bojin-backup-local.timer || true
systemctl is-enabled bojin-backup-local.timer 2>/dev/null || echo "not-found"
```

- **预期输出**：
  - `sudo systemctl start bojin-backup.service` 以退出码 `0` 返回；
  - `journalctl -u bojin-backup.service` 末尾显示 `Succeeded` / `Finished Lean Ritual verified local backup and retention` 与 `offsite disabled`（首次运行还会打印 `release pruning disabled: previous pointer missing or not a symlink`——这是**正常现象**，切勿手工创建 `/opt/bojin-previous`，待下一次 PR 自动部署成功后接收器会自动写入该回滚指针）；
  - `/var/backups/bojin` 为 `root:bojin 710`，其下新生成的 `snapshot-YYYYMMDDTHHMMSSZ` 为 `root:root 700`、`deletions-YYYYMMDDTHHMMSSZ.json` 为 `root:root 600`；
  - `/api/health` 返回 `{"ok":true,...}`；
  - `bojin-backup-local.service` 与 `.timer` 均为 `inactive`，`is-enabled` 输出 `disabled` 或 `not-found`。
- **失败处理**：
  - 若 `bojin-backup-local.timer` 仍显示 `enabled` 或 `active`：执行 `sudo systemctl disable --now bojin-backup-local.timer` 后复查。
  - 若 `bojin-backup.service` 报错失败：查看 `sudo journalctl -u bojin-backup.service -n 50 --no-pager`（常见原因：磁盘剩余空间不足 `size(DATA_DIR) + 1.5 GiB`，或存在残留数据库写锁）；备份脚本的 `EXIT` trap 会自动拉起 `bojin.service` 并清理临时目录，用 `systemctl is-active bojin.service` 确认应用已恢复在线。

---

## 步骤 4：配置告警通知（`/etc/bojin-alert.env`）并发送测试推送

- **变更内容**：在 `/etc/bojin-alert.env`（`0600 root:root`）中填入 HTTPS 告警推送地址（推荐手机安装免费 App **ntfy** 并订阅随机私有主题），验证服务器告警能直达手机。**不重启应用**。
- **执行命令**：

```bash
# 生成随机主题名参考（在手机 ntfy App 中点击 "+" 订阅该主题名；主题名等同密码，切勿外传）
echo "建议订阅主题名: leanritual-$(openssl rand -hex 12)"

sudo chown root:root /etc/bojin-alert.env
sudo chmod 0600 /etc/bojin-alert.env
sudo nano /etc/bojin-alert.env
# 将文件内 ALERT_URL= 改为（必须使用 https://，http:// 会被安全策略拒绝）：
# ALERT_URL=https://ntfy.sh/你的随机主题名

sudo stat -c '%U:%G %a %n' /etc/bojin-alert.env
sudo /usr/local/libexec/bojin-alert "主机升级告警联通性测试"
echo "alert_exit=$?"
```

- **预期输出**：`stat` 输出 `root:root 600 /etc/bojin-alert.env`，`alert_exit=0`，手机 ntfy 在数秒内收到标题为 `Lean Ritual`、正文为 `Lean Ritual: 主机升级告警联通性测试` 的推送通知（不含任何用户隐私数据）。
- **失败处理**：若命令返回非零退出码或手机未收到，执行 `sudo journalctl -t bojin-alert -n 10 --no-pager` 查看原因（注意该日志不含 URL 路径）：若提示 `Refusing invalid or non-HTTPS ALERT_URL`，检查是否误写成 `http://` 或混入空格；若提示 `curl` 超时/非 `2xx`，检查主机访问目标 HTTPS 端点的出站连通性。

---

## 步骤 5：开启 AI（OpenRouter Auto Router）并重启应用

- **前置控制台设置（必做，写入密钥前先在 OpenRouter 网页端完成）**：
  1. **限制允许路由的模型（Allowed Models）**：进入 OpenRouter **Settings → Routing**，将允许模型限定为支持视觉看图（Vision）、成本可控且合规的模型，防止 `openrouter/auto-beta` 自动路由至高价推理模型或纯文本模型；
  2. **设置硬性月度消费上限（Monthly Spend Cap / Credit Limit）**：在 OpenRouter **Keys** 页面创建专用 Key 并绑定每月美元硬上限（应用端仅限制请求次数：单账号 60 次/天、全局 300 次/天、单次最多输出 2000 tokens，不直接计算美元账单）；
  3. **保密原则**：绝不在聊天记录、Git 仓库、Issue 或 shell 命令行参数中粘贴 `OPENROUTER_API_KEY`。

- **变更内容**：在 `/etc/bojin/environment` 中写入 `OPENROUTER_API_KEY` 与 `OPENROUTER_MODEL=openrouter/auto-beta`，通过 `/usr/local/sbin/bojin-maintenance-lock` 重启 `bojin.service`，验证公网 `/api/config` 返回 `"ai":true`，并复跑一次完整只读审计确认 `FAIL=0`。**本步骤是全程唯一显式重启 `bojin.service` 的步骤**。
- **执行命令**：

```bash
# 先刷新一份 /etc/bojin/environment 备份到 root 回滚目录
BACKUP_STAGE=$(sudo cat /root/bojin-host-pre-latest)
sudo cp -a --parents /etc/bojin/environment "$BACKUP_STAGE/"

# 编辑 /etc/bojin/environment，新增或修改以下两行（保留原有 AUTH_SECRET、SMTP_* 等全部配置，切勿 cat 文件）：
# OPENROUTER_API_KEY=sk-or-v1-你的专用密钥
# OPENROUTER_MODEL=openrouter/auto-beta
sudo nano /etc/bojin/environment

# 核对文件属主权限（预期 root:bojin 640）并脱敏检查键是否非空
sudo stat -c '%U:%G %a %n' /etc/bojin/environment
sudo python3 - <<'PY'
d = {}
for line in open('/etc/bojin/environment'):
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1)
        d[k.strip()] = v.strip().strip('"\'')
key = d.get('OPENROUTER_API_KEY', '')
print('OPENROUTER_API_KEY:', f'present (len={len(key)})' if key else 'MISSING')
print('OPENROUTER_MODEL:', d.get('OPENROUTER_MODEL', 'MISSING'))
PY

# 在维护锁包装器内重启 bojin.service（避免与备份/部署重叠或触发看门狗误报）
sudo /usr/local/sbin/bojin-maintenance-lock -- systemctl restart bojin.service

# 验证公网健康状态、AI 开关及启动日志，并复跑主机只读审计确认 FAIL=0
curl -fsSL https://leanritual.app/api/health && echo ""
curl -fsSL https://leanritual.app/api/config && echo ""
sudo journalctl -u bojin.service -n 10 --no-pager | grep '薄肌日课已启动' || true

cd ~/Lean-Ritual
sudo bash scripts/host-audit.sh | tee /tmp/host-audit-after.txt
grep -E '^(FAIL|WARN|Summary:)' /tmp/host-audit-after.txt
```

- **预期输出**：
  - 脱敏检查输出 `OPENROUTER_API_KEY: present (len=...)` 与 `OPENROUTER_MODEL: openrouter/auto-beta`，权限保持 `root:bojin 640`；
  - `curl -fsSL https://leanritual.app/api/health` 返回 `{"ok":true,"revision":"..."}`；
  - `curl -fsSL https://leanritual.app/api/config` 返回 `{"allowSignup":true,"invite":true,"ai":true}`；
  - `journalctl` 输出 `薄肌日课已启动：http://127.0.0.1:8080  （AI 已配置 openrouter/auto-beta）`；
  - `host-audit-after.txt` 末尾显示 **`Summary: FAIL=0 WARN=...`**，且 4 个 root 辅助程序均为 `PASS MATCH`。
- **失败处理**：
  - 若 `/api/config` 仍显示 `"ai":false`：检查 `/etc/bojin/environment` 中拼写是否为 `OPENROUTER_API_KEY`、行首是否误留 `#`，并确认 `bojin.service` 的 `EnvironmentFiles` 指向 `/etc/bojin/environment`。
  - 若重启后 `bojin.service` 未正常启动：先查 `sudo journalctl -u bojin.service -n 30 --no-pager`（注意脱敏），或立即按**步骤 7.5** 恢复升级前的 `/etc/bojin/environment` 并重启。

---

## 步骤 6：（可选）配置阿里云云盘自动快照策略

- **变更内容**：本机 `/var/backups/bojin` 与应用位于同一块云盘，无法抵御整机磁盘损坏或误释放。在未启用独立异地 SSH（`OFFSITE_DEST`）期间，可在阿里云控制台开启云盘每日自动快照作为同账号整机级兜底。**不修改主机文件、不重启应用**。
- **操作方式（阿里云控制台）**：
  1. 登录阿里云控制台（美西硅谷 `us-west-1`），进入对应轻量应用服务器 / ECS 实例的 **快照 / 自动快照策略**；
  2. 先手动创建 **1 份升级后基线快照**（命名如 `bojin-post-upgrade-202611`）；
  3. 开启或绑定每日自动快照策略：执行时间建议错开 UTC `04:00` 应用备份窗口（例如设为 **UTC `05:00` / 北京时间 `13:00`**），保留天数设为 **7 天**（先核对当前套餐免费快照配额与超额计费规则）；
  4. 顺手确认阿里云主账号已开启 MFA，且 Cloudflare 中 `leanritual.app` 自动续费已开启。
- **预期结果**：手动快照进度达 `100%`，自动快照策略状态显示“已启用 / 已绑定磁盘”。（注：云盘块快照为崩溃一致性兜底；日常精确数据恢复与已删除账号台账重放仍以 `/var/backups/bojin` 应用快照为准，见 `docs/OPERATIONS.md`。）
- **失败处理**：若轻量应用服务器套餐限制自动快照策略数量，至少保留手动基线快照并在重大变更前手动打快照。

---

## 步骤 7：分步回滚说明（基于 `sudo cp -a` 备份件）

所有升级前原件均保存在 `BACKUP_STAGE=$(sudo cat /root/bojin-host-pre-latest)`（默认 `/root/bojin-host-pre-202611-*`）下，不存在于升级前的文件列在 `$BACKUP_STAGE/absent-before.txt`。回滚任何宿主机组件时**仍须通过双锁包装器加锁，且切勿删除 `/run/lock/bojin-maintenance.lock`**。

### 7.0 / 7.1 步骤 0 与步骤 1 回滚
只读操作无需回滚；审计完成后可清理临时报告：`sudo rm -f /tmp/host-audit-before.txt /tmp/host-audit-after.txt`（建议保留 `~/Lean-Ritual` 供日后升级复用）。

### 7.2 步骤 2 回滚（恢复旧版部署接收器、备份脚本、看门狗或 systemd 单元）

- **回滚单个辅助程序**（例如仅回滚部署接收器，其余保持新版）：

```bash
BACKUP_STAGE=$(sudo cat /root/bojin-host-pre-latest)
sudo /usr/local/sbin/bojin-maintenance-lock -- \
  cp -a "$BACKUP_STAGE/usr/local/sbin/lean-ritual-deploy" /usr/local/sbin/lean-ritual-deploy
sha256sum "$BACKUP_STAGE/usr/local/sbin/lean-ritual-deploy" /usr/local/sbin/lean-ritual-deploy
```

- **整套回滚步骤 2 全部宿主机文件**（恢复升级前存在的文件，停用并移除升级前不存在的新增单元，保留 `/etc/tmpfiles.d/bojin.conf` 与 `/usr/local/sbin/bojin-maintenance-lock` 以免破坏锁目录）：

```bash
BACKUP_STAGE=$(sudo cat /root/bojin-host-pre-latest)
sudo /usr/local/sbin/bojin-maintenance-lock -- bash -c '
  set -euo pipefail
  stage=$1
  for f in \
    /usr/local/sbin/lean-ritual-deploy \
    /usr/local/libexec/bojin-backup \
    /usr/local/libexec/bojin-watchdog \
    /usr/local/libexec/bojin-alert \
    /etc/systemd/system/bojin-backup.service \
    /etc/systemd/system/bojin-backup.timer \
    /etc/systemd/system/bojin-watchdog.service \
    /etc/systemd/system/bojin-watchdog.timer \
    /etc/systemd/system/bojin-alert@.service \
    /etc/systemd/system/bojin.service.d/reliability.conf \
    /etc/systemd/system/caddy.service.d/reliability.conf \
    /etc/systemd/system/bojin-backup.service.d/alert.conf \
    /etc/systemd/system/bojin-backup-local.service.d/alert.conf \
    /etc/bojin-backup.env; do
    if [[ -e "$stage$f" || -L "$stage$f" ]]; then
      cp -a "$stage$f" "$f"
    elif grep -qxF "$f" "$stage/absent-before.txt"; then
      [[ "$f" == *.timer ]] && systemctl disable --now "$(basename "$f")" 2>/dev/null || true
      rm -f "$f"
    fi
  done
  systemctl daemon-reload
' _ "$BACKUP_STAGE"
systemctl list-timers 'bojin-*' --no-pager
```

### 7.3 步骤 3 回滚（首次备份与旧定时器）
`/var/backups/bojin/` 下新生成的快照仅占磁盘空间、不影响运行，无需删除。仅当已按 7.2 回退了备份脚本且确需重新启用旧定时器（前提：确认旧 `ExecStart` 脚本真实存在）时执行：

```bash
sudo systemctl disable --now bojin-backup.timer
sudo systemctl enable --now bojin-backup-local.timer
```

### 7.4 步骤 4 回滚（停用外部手机告警推送）
恢复备份的 `/etc/bojin-alert.env`（或将 `ALERT_URL=` 置空），立即退回“仅写系统日志、不发网络请求”，**不重启应用**：

```bash
BACKUP_STAGE=$(sudo cat /root/bojin-host-pre-latest)
if sudo test -f "$BACKUP_STAGE/etc/bojin-alert.env"; then
  sudo cp -a "$BACKUP_STAGE/etc/bojin-alert.env" /etc/bojin-alert.env
else
  printf 'ALERT_URL=\n' | sudo tee /etc/bojin-alert.env >/dev/null
  sudo chown root:root /etc/bojin-alert.env && sudo chmod 0600 /etc/bojin-alert.env
fi
```

### 7.5 步骤 5 回滚（关闭 AI 并恢复原环境配置）
恢复步骤 5 修改前的 `/etc/bojin/environment` 并在维护锁下重启 `bojin.service`（**会重启应用**）：

```bash
BACKUP_STAGE=$(sudo cat /root/bojin-host-pre-latest)
sudo cp -a "$BACKUP_STAGE/etc/bojin/environment" /etc/bojin/environment
sudo /usr/local/sbin/bojin-maintenance-lock -- systemctl restart bojin.service
curl -fsSL https://leanritual.app/api/health && echo ""
curl -fsSL https://leanritual.app/api/config && echo ""   # 预期返回 "ai":false
```

### 7.6 步骤 6 回滚
在阿里云控制台解绑云盘自动快照策略并按需删除快照，不影响线上服务。

---

## 附：本次升级后的衔接检查（参考文档）

- 若步骤 1/5 审计中提示 `swapon --show` 为空或 `WARN Caddy lb_try_duration absent` / `WARN Caddy handle_errors absent`，可按 [RELIABILITY.zh-CN.md](RELIABILITY.zh-CN.md) 第 2.3、2.5 节补充 2 GiB Swap 与 Caddy 15 秒优雅等待配置。
- 公测开放前还需在宿主机上基于步骤 3 生成的新快照执行一次隔离目录恢复演练（验证 `data-backup.js verify` 与 `restore --deletions`），命令见 [OPERATIONS.md](OPERATIONS.md)（"Restore and rollback"）与 [RELEASE-GATES.md](RELEASE-GATES.md) Gate 9。
