# 阿里云宿主机一次性升级手册（2026-11 · PR #12/#13/#14/#16/#19 与 AI 开启）

GitHub Actions 自动部署仅更新 `/opt/bojin` 应用代码，**不会**更新宿主机上由 `root` 持有的辅助程序、systemd 单元与锁配置。本手册将近期合并的宿主机变更与 AI 启用整合为**单次、严格有序**的操作流程，供管理员以 `admin` 身份 SSH 登录（`ssh admin@47.254.72.103`）后顺序执行（全程约 15–20 分钟）。

## 升级总览与服务中断影响

| 步骤 | 内容（对应 PR / 决策） | 是否重启或中断 `bojin.service` |
| --- | --- | --- |
| **0** | 获取干净的 `main` 检出并强制校验工作区干净且等于线上 `/api/health` | **否** |
| **1** | 执行只读主机审计（PR #14 `scripts/host-audit.sh`）保存基线 | **否** |
| **2** | 备份旧文件与 timer 状态，按 PR #19 顺序升级双锁包装器、接收器（#13）、备份（#16）、看门狗与告警（#12） | **安装器本身不重启**（注：`install-backup.sh` 启用带 `Persistent=true` 的 `bojin-backup.timer` 后，systemd 可能在 5 分钟随机延迟窗内立即触发一次离线备份并短暂停启应用） |
| **3** | 手动运行首次本地备份并强制核验旧 `bojin-backup-local` 已停用 | **离线快照短暂停启**（`bojin-backup.service` 在维护锁内自动 `stop` → 快照 → `start` `bojin.service`，停机时长取决于 `/var/lib/bojin` 数据库与照片总大小；非配置重启） |
| **4** | 配置 `/etc/bojin-alert.env`（`0600 root:root`）并验证手机推送 | **否** |
| **5** | 配置 OpenRouter Auto Router 环境变量并重启应用生效 | **是（唯一显式配置重启 `systemctl restart bojin.service`）** |
| **6** | （可选）开启阿里云云盘自动快照策略作整机故障兜底 | **否** |
| **7** | 分步回滚说明（从只读备份原件与记录的 timer 状态恢复） | 视回滚项而定（仅 7.5 显式重启应用） |

> [!IMPORTANT]
> **四条铁律（开始前必读，全程严格遵守）：**
> 1. **逐段粘贴、逐段看门控——遇非零立即停手**：每次**只复制粘贴一个代码块**执行。每个代码块末尾都会打印 `STEP ... OK`（或 `ROLLBACK ... OK`）以及 `BLOCK EXIT=<退出码>`（子 shell 不会关闭你的交互式 SSH 会话，但**不会自动阻止你继续手动粘贴下一段**）。**只要未看到 `OK`、`BLOCK EXIT` 非 `0`，或屏幕出现 `STOP:` / `停止`，必须立即停止整个升级流程，严禁继续粘贴下一代码块**——先按该步“失败处理”排查或按**步骤 7** 回滚后再继续。
> 2. **切勿执行 `rm /run/lock/bojin-maintenance.lock`**：删除可能正被持有的 `flock` 锁文件会让新进程锁在全新 inode 上导致并发冲突；PR #19 的双锁包装器会在 `fs.protected_regular=2` 返回 `EACCES` 时安全打开并锁住现有文件。
> 3. **含 `sudo nano` 的步骤分两段执行**：步骤 4 与步骤 5 已拆为“`.1` 打开编辑器保存退出”与“`.2` 权限收敛 + 校验执行”两个独立代码块，切勿把 `.2` 代码块贴进 `nano` 编辑器。
> 4. **切勿在聊天、Git、Issue 或命令行参数中粘贴任何密钥/告警 URL**：所有敏感配置一律用 `sudo nano` 直接写入受保护文件，且不要执行 `cat /etc/bojin/environment`。

---

## 步骤 0：获取干净的 `main` 检出并强制对齐线上版本

- **变更内容**：在 `~/Lean-Ritual` 克隆（或从官方 GitHub URL 拉取）`main` 分支，禁用本地 Git hooks，**强制拒绝任何脏工作区/未跟踪文件，并强制校验远端 `main` 与本地 `HEAD` 均等于公网 `/api/health` 的 40 位 revision**（若已有旧目录来源或配置不可信，先 `rm -rf ~/Lean-Ritual` 让脚本重新克隆）。不动 `/opt/bojin` 与系统配置。**不重启应用**。
- **执行命令**：

```bash
(
set -euo pipefail
LIVE_SHA=$(curl -fsSL https://leanritual.app/api/health | python3 -c 'import json,re,sys; d=json.load(sys.stdin); assert d.get("ok") is True; s=d["revision"]; assert re.fullmatch("[0-9a-f]{40}", s); print(s)')
echo "Live revision: $LIVE_SHA"

if [[ ! -d ~/Lean-Ritual/.git ]]; then
  git clone https://github.com/hendrixAIDev/Lean-Ritual.git ~/Lean-Ritual
fi
if [[ -n "$(git -C ~/Lean-Ritual status --porcelain)" ]]; then
  echo "STOP: ~/Lean-Ritual has local modifications or untracked files" >&2
  exit 1
fi
git -C ~/Lean-Ritual -c core.hooksPath=/dev/null fetch https://github.com/hendrixAIDev/Lean-Ritual.git main
if [[ "$(git -C ~/Lean-Ritual rev-parse FETCH_HEAD)" != "$LIVE_SHA" ]]; then
  echo "STOP: origin/main FETCH_HEAD does not match live revision ($LIVE_SHA)" >&2
  exit 1
fi
git -C ~/Lean-Ritual -c core.hooksPath=/dev/null checkout --detach "$LIVE_SHA"
if [[ "$(git -C ~/Lean-Ritual rev-parse HEAD)" != "$LIVE_SHA" ]] || [[ -n "$(git -C ~/Lean-Ritual status --porcelain)" ]]; then
  echo "STOP: checkout verification failed" >&2
  exit 1
fi
echo "STEP 0 OK (revision=$LIVE_SHA)"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：必须看到 `STEP 0 OK` 且 `BLOCK EXIT=0` 方可继续；若 `BLOCK EXIT` 非 `0` 或输出 `STOP:` / `停止`，**立即停止，不得粘贴步骤 1**，先按下方排查。

- **预期输出**：打印 `Live revision: <40位SHA>`、`STEP 0 OK (revision=<40位SHA>)` 与 `BLOCK EXIT=0`。
- **失败处理**：
  - 若报 `STOP: ~/Lean-Ritual has local modifications or untracked files`：执行 `rm -rf ~/Lean-Ritual` 后重跑步骤 0 获取全新克隆。
  - 若报 `STOP: origin/main FETCH_HEAD does not match live revision`：先打开 GitHub Actions 检查最新 `release.yml` 是否仍在部署或失败，等线上 revision 与 `main` 完全一致后再继续。

---

## 步骤 1：运行只读主机审计（PR #14）

- **变更内容**：以 `root` 运行只读脚本 `scripts/host-audit.sh`（自动脱敏密钥与完整 URL），将升级前基线保存到 `/tmp/host-audit-before.txt`，并强制确认旧版 `bojin-backup-local.service` 当前未在运行。不修改任何系统文件或服务。**不重启应用**。
- **执行命令**：

```bash
(
set -euo pipefail
cd ~/Lean-Ritual
sudo bash scripts/host-audit.sh | tee /tmp/host-audit-before.txt
echo "--- 关注项汇总 ---"
grep -E '^(FAIL|WARN|Summary:)' /tmp/host-audit-before.txt || true
systemctl status bojin-backup-local.timer bojin-backup-local.service --no-pager 2>/dev/null || true
if systemctl is-active --quiet bojin-backup-local.service; then
  echo "STOP: legacy backup is active" >&2
  exit 1
fi
echo "STEP 1 OK"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：必须看到 `STEP 1 OK`、`BLOCK EXIT=0`，且人工核对下方第 1、3 项无阻塞性问题后方可继续；若 `BLOCK EXIT` 非 `0` 或发现硬前提 `FAIL`，**立即停止，不得粘贴步骤 2**。

- **预期输出与重点核查项**：
  1. **必须为 `PASS` 的硬前提**：`PASS node v24.x`、`PASS architecture x86_64`、`Health ok: True`、`PASS AUTH_SECRET present`、`PASS Caddy validation`。
  2. **升级前属正常、将在步骤 2–5 消除的 `FAIL`/`WARN`**：
     - `FAIL DIFFERENT /usr/local/sbin/lean-ritual-deploy ...` 或 `WARN MISSING /usr/local/libexec/bojin-{backup,watchdog,alert}`（宿主机尚未更新 root 脚本，步骤 2 后会全部变为 `PASS MATCH`）。
     - `bojin-backup-local.service` 报 `FAIL ExecStart missing: /opt/bojin/ops/backup-local.sh`（或 `ExecMainStatus=203`）：步骤 2 的 `install-backup.sh` 会自动停用 `bojin-backup-local.timer`。
     - `WARN OPENROUTER_API_KEY empty/missing`、`WARN OPENROUTER_MODEL empty/missing`、`WARN ALERT_URL empty/missing`（步骤 4、5 配置后消除；`OFFSITE_DEST empty/missing` 按当前 7 天本机保留决策属预期 `WARN`）。
     - `WARN maintenance lock not root owned`（若 `/run/lock/bojin-maintenance.lock` 曾由非 root 创建：**切勿删除**，步骤 2 双锁包装器会自动兼容）。
  3. **需要额外留意的异常项**：
     - `FAIL leftover environment file: <路径>`：说明 `/opt` 下残留旧 `.env`。确认审计中 `bojin/environment present` 且 `AUTH_SECRET`/`SMTP_*` 均为 `PASS` 后，用审计报告给出的完整路径移入 `/root` 保存：`sudo bash -c 'set -euo pipefail; dst="/root/legacy-opt-env-$(date -u +%Y%m%dT%H%M%SZ)-$$.bak"; if [[ -e "$dst" || -L "$dst" ]]; then echo "STOP: backup file exists" >&2; exit 1; fi; mv "<审计输出的完整.env路径>" "$dst"; chmod 0600 "$dst"'`。
     - 磁盘空间（报告中 `df -h` 与 `du -sh /var/lib/bojin`）：确认 `/var/backups` 与 `/opt` 所在分区剩余可用空间 **大于 `size(/var/lib/bojin) + 1.5 GiB`**（备份与部署预检硬门槛）。
- **失败处理**：
  - 若报 `STOP: legacy backup is active`：等该次旧备份任务跑完变为 `inactive`/`failed` 后再重跑步骤 1。
  - 若出现 `FAIL node expected v24.x`、`FAIL Caddy validation` 或磁盘空间不足：**立即停止升级**，先排查基础环境或释放空间。

---

## 步骤 2：备份旧组件与 timer 状态，并按 PR #19 顺序升级全部 root 辅助程序

- **变更内容**：
  1. 再次校验 `~/Lean-Ritual` 干净且等于当前线上 `/api/health` revision（防止步骤 0 后恰有新部署落地）；
  2. 用 `sudo cp -a --parents` 将现有宿主机 root 脚本、systemd 单元、环境配置及三个 timer 的 `is-enabled`/`is-active` 原状态完整保存至唯一目录 `/root/bojin-host-pre-202611-<UTC时间戳>-<PID>`（`0700`），仅在整套备份循环成功后才写入只读指针 `/root/bojin-host-pre-initial`（重跑步骤 2 也不会覆盖首次基线指针）；
  3. 安装 `/etc/tmpfiles.d/bojin.conf`（开机自动创建 `root:root 0755` 的 `/run/bojin`）与双锁包装器 `/usr/local/sbin/bojin-maintenance-lock`（固定按“先 `/run/bojin/maintenance.lock`、后 `/run/lock/bojin-maintenance.lock`”加锁）；
  4. **在 `bojin-maintenance-lock` 保护下按序升级**：
     - SSH 部署接收器 `/usr/local/sbin/lean-ritual-deploy`（PR #13/#16/#19：双锁协调、`size(DATA_DIR)+1.5 GiB` 预检、手动停服防误拉起门控 `/etc/bojin/allow-deploy-when-stopped`、`root:root` 快照归属、下次部署起记录 `/opt/bojin-previous`）；
     - 每日备份与 7 天保留策略 `ops/install-backup.sh`（PR #13/#16/#19：安装 `/usr/local/libexec/bojin-backup`、`bojin-backup.{service,timer}` 每日 `04:00:00 UTC` + `RandomizedDelaySec=300`、`/etc/bojin-backup.env` `0600` 默认 `BACKUP_RETENTION_DAYS=7`，停用旧 `bojin-backup-local.timer`）；
     - 看门狗、告警与重启策略 `ops/install-reliability.sh`（PR #12/#19：安装 `/usr/local/libexec/bojin-{watchdog,alert}`、每 30 秒日历定时器 `OnCalendar=*:*:0/30`、`TimeoutStartSec=60`、`bojin`/`caddy` `Restart=always` 附加配置，以及备份失败告警 drop-in）；
  5. 逐对强制校验 6 组源文件与目标文件的字节一致性（`cmp -s`）。
  - *关于服务中断说明*：安装脚本本身**不重启** `bojin.service`；但因 `bojin-backup.timer` 含 `Persistent=true`，启用后 systemd 可能在 5 分钟随机延迟内立即触发一次后台备份并短暂停启应用。

- **执行命令**：

```bash
(
set -euo pipefail
cd ~/Lean-Ritual

# 2.0 复核检出版本仍与线上一致且工作区干净，防止期间发生过新部署
LIVE_SHA=$(curl -fsSL https://leanritual.app/api/health | python3 -c 'import json,re,sys; d=json.load(sys.stdin); assert d.get("ok") is True; s=d["revision"]; assert re.fullmatch("[0-9a-f]{40}", s); print(s)')
if [[ "$(git rev-parse HEAD)" != "$LIVE_SHA" ]] || [[ -n "$(git status --porcelain)" ]]; then
  echo "STOP: ~/Lean-Ritual no longer matches live revision ($LIVE_SHA) or is dirty" >&2
  exit 1
fi

# 2.1 预检活跃单元与锁文件状态（若 /run/lock/bojin-maintenance.lock 存在，强制校验为普通文件，切勿 rm！）
systemctl is-active bojin.service bojin-backup.service bojin-backup-local.service bojin-watchdog.service || true
if systemctl is-active --quiet bojin-backup-local.service; then
  echo "STOP: legacy backup is active" >&2
  exit 1
fi
sudo stat -c '%U:%G %a %F %n' /run/lock/bojin-maintenance.lock /run/bojin 2>/dev/null || true
sudo bash -c '
  set -euo pipefail
  if [[ -L /run/lock/bojin-maintenance.lock ]] || { [[ -e /run/lock/bojin-maintenance.lock ]] && [[ ! -f /run/lock/bojin-maintenance.lock ]]; }; then
    echo "STOP: non-regular /run/lock/bojin-maintenance.lock" >&2
    exit 1
  fi
'

# 2.2 备份现有 root 文件与 timer 启停状态到唯一目录；全部成功后才记录初始回滚指针
BACKUP_STAGE="/root/bojin-host-pre-202611-$(date -u +%Y%m%dT%H%M%SZ)-$$"
sudo bash -c '
  set -euo pipefail
  stage=$1
  if [[ -e "$stage" || -L "$stage" ]]; then
    echo "STOP: backup stage already exists: $stage" >&2
    exit 1
  fi
  install -d -o root -g root -m 0700 "$stage"
  : > "$stage/absent-before.txt"
  chmod 0600 "$stage/absent-before.txt"
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
    if [[ -e "$f" || -L "$f" ]]; then
      cp -a --parents "$f" "$stage/"
    else
      printf "%s\n" "$f" >> "$stage/absent-before.txt"
    fi
  done

  : > "$stage/timer-states.tsv"
  chmod 0600 "$stage/timer-states.tsv"
  for t in bojin-backup.timer bojin-watchdog.timer bojin-backup-local.timer; do
    en=$(systemctl is-enabled "$t" 2>/dev/null || true); en=${en%%[[:space:]]*}
    ac=$(systemctl is-active "$t" 2>/dev/null || true); ac=${ac%%[[:space:]]*}
    printf "%s\t%s\t%s\n" "$t" "${en:-not-found}" "${ac:-inactive}" >> "$stage/timer-states.tsv"
  done

  printf "%s\n" "$stage" > /root/bojin-host-pre-latest
  chmod 0600 /root/bojin-host-pre-latest
  if [[ ! -e /root/bojin-host-pre-initial ]]; then
    printf "%s\n" "$stage" > /root/bojin-host-pre-initial
    chmod 0600 /root/bojin-host-pre-initial
  fi
' _ "$BACKUP_STAGE"
echo "Saved pre-upgrade backup to: $BACKUP_STAGE (initial baseline preserved in /root/bojin-host-pre-initial)"

# 2.3 安装 systemd-tmpfiles 规则、创建 root:root 0755 /run/bojin，并安装双锁包装器
sudo install -d -o root -g root -m 0755 /etc/tmpfiles.d /usr/local/sbin
sudo install -o root -g root -m 0644 ops/bojin-tmpfiles.conf /etc/tmpfiles.d/bojin.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/bojin.conf
sudo install -o root -g root -m 0755 ops/maintenance-lock.sh /usr/local/sbin/bojin-maintenance-lock
sudo stat -c '%U:%G %a %n' /etc/tmpfiles.d/bojin.conf /run/bojin /usr/local/sbin/bojin-maintenance-lock

# 2.4 最先在双锁下升级自动部署接收器，使后续 GitHub 自动部署立即走新旧双锁
sudo /usr/local/sbin/bojin-maintenance-lock -- \
  install -o root -g root -m 0755 ops/deploy-release.py /usr/local/sbin/lean-ritual-deploy

# 2.5 在双锁下安装/升级每日备份与 7 天保留策略
sudo /usr/local/sbin/bojin-maintenance-lock -- bash ops/install-backup.sh

# 2.6 在双锁下安装/升级健康看门狗、告警与自动重启策略
sudo /usr/local/sbin/bojin-maintenance-lock -- bash ops/install-reliability.sh

# 2.7 打印并逐对强制校验全部已安装文件字节一致、权限、超时、定时器与看门狗日志
sudo sha256sum \
  ops/bojin-tmpfiles.conf /etc/tmpfiles.d/bojin.conf \
  ops/maintenance-lock.sh /usr/local/sbin/bojin-maintenance-lock \
  ops/deploy-release.py /usr/local/sbin/lean-ritual-deploy \
  ops/backup-service.sh /usr/local/libexec/bojin-backup \
  ops/health-watchdog.sh /usr/local/libexec/bojin-watchdog \
  ops/alert.sh /usr/local/libexec/bojin-alert
for pair in \
  "ops/bojin-tmpfiles.conf:/etc/tmpfiles.d/bojin.conf" \
  "ops/maintenance-lock.sh:/usr/local/sbin/bojin-maintenance-lock" \
  "ops/deploy-release.py:/usr/local/sbin/lean-ritual-deploy" \
  "ops/backup-service.sh:/usr/local/libexec/bojin-backup" \
  "ops/health-watchdog.sh:/usr/local/libexec/bojin-watchdog" \
  "ops/alert.sh:/usr/local/libexec/bojin-alert"; do
  sudo cmp -s "${pair%%:*}" "${pair#*:}"
done
sudo stat -c '%U:%G %a %n' \
  /etc/tmpfiles.d/bojin.conf \
  /run/bojin \
  /run/bojin/maintenance.lock \
  /usr/local/sbin/bojin-maintenance-lock \
  /etc/bojin-backup.env \
  /etc/bojin-alert.env
systemctl show bojin.service -p Restart -p StartLimitIntervalUSec
systemctl show bojin-watchdog.service bojin-alert@test.service bojin-backup.service -p TimeoutStartUSec
systemctl list-timers 'bojin-*' --no-pager
sudo journalctl -t bojin-watchdog -n 20 --no-pager
echo "STEP 2 OK"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：必须看到 `STEP 2 OK` 且 `BLOCK EXIT=0` 方可继续；若 `BLOCK EXIT` 非 `0` 或输出 `STOP:` / `停止`，**立即停止整个升级流程，不得粘贴步骤 3**——先按下方排查或执行**步骤 7.2** 回滚。

- **预期输出**：
  - 打印 `STEP 2 OK` 与 `BLOCK EXIT=0`，6 组文件 `sha256sum` 成对相等且 `cmp -s` 全部通过；
  - `stat` 显示 `/etc/tmpfiles.d/bojin.conf` 为 `root:root 644`，`/run/bojin` 与 `/usr/local/sbin/bojin-maintenance-lock` 为 `root:root 755`，`/run/bojin/maintenance.lock` 与 `/etc/bojin-backup.env` 为 `root:root 600`（首次生成的 `/etc/bojin-alert.env` 也为 `root:root 600`；若原先已存在，步骤 4 会统一收敛为 `0600`）；
  - `bojin.service` 显示 `Restart=always`、`StartLimitIntervalUSec=0`；`bojin-watchdog.service` 与 `bojin-alert@test.service` 显示 `TimeoutStartUSec=1min`，`bojin-backup.service` 显示 `TimeoutStartUSec=30min`；
  - `systemctl list-timers 'bojin-*'` 同时列出 `bojin-watchdog.timer`（每 30 秒）与 `bojin-backup.timer`（每日 `04:00:00 UTC` + 最多 5 分钟随机延迟）；
  - `journalctl -t bojin-watchdog` 无报错（若旧锁曾属非 root，输出一行 `Warning: ... opened existing file without O_CREAT for flock` 属预期兼容提示）。
- **失败处理**：
  - 若 2.0 校验失败：说明期间有新提交自动部署上线，回到**步骤 0** 重新对齐后再跑。
  - 若报 `Refusing symlink ...`、`Refusing non-root ...` 或 `STOP:`：立即用 `sudo ls -ld /run/bojin /run/lock/bojin-maintenance.lock /etc/tmpfiles.d/bojin.conf` 排查异常路径，切勿强行绕过；需要回退时按**步骤 7.2** 恢复。
  - *运维备忘*：升级接收器后，如未来因维护人为停止 `bojin.service`，自动部署默认会拒绝；若确需在停服状态下放行**单次**自动部署，执行 `sudo install -m 0600 -o root -g root /dev/null /etc/bojin/allow-deploy-when-stopped`（部署消费后自动删除）。

---

## 步骤 3：首次手动备份与旧定时器停用核验

- **变更内容**：手动运行一次 `bojin-backup.service` 生成本地一致性快照（`/var/backups/bojin/snapshot-*`）与删除台账（`deletions-*.json`），并以 `root` 核验产物属主权限及强制确认遗留 `bojin-backup-local` 已停用。
  - *关于服务中断说明*：`bojin-backup.service` 内部自带双维护锁（**切勿**在命令外再包一层 `bojin-maintenance-lock`，否则会自锁等待），并在锁保护下自动 `stop` → 快照 → `start` `bojin.service`（停机时长随 `/var/lib/bojin` 数据与照片量增长）。
- **执行命令**：

```bash
(
set -euo pipefail
sudo systemctl start bojin-backup.service

systemctl list-timers --all 'bojin-backup*' --no-pager
sudo journalctl -u bojin-backup.service -n 30 --no-pager
sudo bash -c '
  set -euo pipefail
  shopt -s nullglob
  snaps=(/var/backups/bojin/snapshot-*)
  ledgers=(/var/backups/bojin/deletions-*.json)
  if (( ${#snaps[@]} < 1 || ${#ledgers[@]} < 1 )); then
    echo "STOP: backup snapshot or deletion ledger missing in /var/backups/bojin" >&2
    exit 1
  fi
  stat -c "%U:%G %a %n" /var/backups/bojin "${snaps[${#snaps[@]}-1]}" "${ledgers[${#ledgers[@]}-1]}"
'
curl -fsSL https://leanritual.app/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True; print("Health OK:", d.get("revision"))'

if systemctl is-active --quiet bojin-backup-local.service; then echo "STOP: legacy backup service active" >&2; exit 1; fi
if systemctl is-active --quiet bojin-backup-local.timer; then echo "STOP: legacy backup timer active" >&2; exit 1; fi
if systemctl is-enabled --quiet bojin-backup-local.timer 2>/dev/null; then echo "STOP: legacy backup timer enabled" >&2; exit 1; fi
echo "STEP 3 OK"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：必须看到 `STEP 3 OK` 且 `BLOCK EXIT=0` 方可继续；若 `BLOCK EXIT` 非 `0` 或输出 `STOP:` / `停止`，**立即停止，不得粘贴步骤 4**，先按下方排查。

- **预期输出**：
  - `journalctl -u bojin-backup.service` 末尾显示 `Finished Lean Ritual verified local backup and retention` 与 `offsite disabled`（首次运行还会打印 `release pruning disabled: previous pointer missing or not a symlink`——这是**正常现象**，切勿手工创建 `/opt/bojin-previous`，待下一次 PR 自动部署成功后接收器会自动记录）；
  - `stat`（在 `sudo bash -c` 内展开受限目录通配符）显示 `/var/backups/bojin` 为 `root:bojin 710`，最新 `snapshot-*` 为 `root:root 700`、最新 `deletions-*.json` 为 `root:root 600`；
  - 打印 `Health OK: <40位SHA>`、`STEP 3 OK` 与 `BLOCK EXIT=0`。
- **失败处理**：
  - 若报 `STOP: legacy backup timer active/enabled`：执行 `sudo systemctl disable --now bojin-backup-local.timer` 后重跑步骤 3。
  - 若 `bojin-backup.service` 失败：查 `sudo journalctl -u bojin-backup.service -n 50 --no-pager`（常见原因：可用磁盘不足 `size(DATA_DIR) + 1.5 GiB` 或残留租约）；脚本 `EXIT` trap 会自动拉起 `bojin.service`，用 `systemctl is-active bojin.service` 确认服务在线。

---

## 步骤 4：配置告警通知（`/etc/bojin-alert.env`）并发送测试推送

- **变更内容**：将 `/etc/bojin-alert.env` 收敛为 `0600 root:root`，写入 `https://` 告警推送地址（推荐手机安装免费 App **ntfy** 订阅随机私有主题），校验非空后实发一条测试推送。**不重启应用**。
- **执行命令（分 4.1 编辑 与 4.2 校验推送两段执行）**：

```bash
# 4.1 生成随机主题名参考并收敛权限，成功后打开 nano 编辑（在手机 ntfy App 订阅同一主题名，切勿外传）
(
set -euo pipefail
echo "建议订阅主题名: leanritual-$(openssl rand -hex 12)"
sudo touch /etc/bojin-alert.env
sudo chown root:root /etc/bojin-alert.env
sudo chmod 0600 /etc/bojin-alert.env
sudo nano /etc/bojin-alert.env
# 将文件内 ALERT_URL= 改为（必须使用 https://，http:// 会被安全策略拒绝）：
# ALERT_URL=https://ntfy.sh/你的随机主题名
echo "STEP 4.1 OK"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：保存退出 `nano` 后必须看到 `STEP 4.1 OK` 且 `BLOCK EXIT=0`，再粘贴下方 4.2；若 `BLOCK EXIT` 非 `0`，**立即停止，不得粘贴 4.2**。

```bash
# 4.2 强制核验权限与非空 https:// 配置（不输出真实 URL），并发送测试告警
(
set -euo pipefail
if [[ "$(sudo stat -c '%U:%G:%a' /etc/bojin-alert.env)" != "root:root:600" ]]; then
  echo "STOP: /etc/bojin-alert.env permissions are not root:root:600" >&2
  exit 1
fi
sudo python3 - <<'PY'
url = ""
for line in open("/etc/bojin-alert.env", encoding="utf-8"):
    s = line.strip()
    if not s or s.startswith("#"):
        continue
    if s.startswith("export "):
        s = s[7:].lstrip()
    if s.startswith("ALERT_URL="):
        url = s.split("=", 1)[1].strip().strip("\"'")
assert url.startswith("https://") and " " not in url, "ALERT_URL must be a non-empty https:// URL"
print("ALERT_URL verified: https://<redacted>")
PY
sudo /usr/local/libexec/bojin-alert "主机升级告警联通性测试"
echo "STEP 4.2 OK — 请确认手机已实际收到推送通知"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：必须看到 `STEP 4.2 OK`、`BLOCK EXIT=0` **且手机实际收到通知**方可继续；若 `BLOCK EXIT` 非 `0` 或手机未收到，**立即停止，不得粘贴步骤 5**，先排查修复告警或按**步骤 7.4** 处理。

- **预期输出**：打印 `ALERT_URL verified: https://<redacted>`、`STEP 4.2 OK` 与 `BLOCK EXIT=0`，**且手机 ntfy App 在数秒内实际收到 `Lean Ritual: 主机升级告警联通性测试`**。
- **失败处理**：若报错退出或手机未收到，查 `sudo journalctl -t bojin-alert -n 10 --no-pager`：若报 `ALERT_URL must be a non-empty https:// URL` 或 `Refusing invalid or non-HTTPS ALERT_URL`，重新运行 4.1 修正协议或多余空格；若报 `curl` 超时/非 `2xx`，检查主机出站 HTTPS 连通性。

---

## 步骤 5：开启 AI（OpenRouter Auto Router）并重启应用

- **前置控制台设置（必做，写入密钥前先在 OpenRouter 网页端完成）**：
  1. **限制允许路由的模型（Allowed Models）**：进入 OpenRouter **Settings → Routing**，将允许模型限定为支持视觉看图（Vision）、单价可控且合规的模型，防止 `openrouter/auto-beta` 路由至昂贵推理模型或纯文本模型；
  2. **设置硬性月度消费上限（Monthly Spend Cap / Credit Limit）**：在 OpenRouter **Keys** 页面为该专用 Key 设定每月美元硬上限（应用仅限制请求次数：单账号 60 次/天、全局 300 次/天、单次输出上限 2000 tokens，不统计美元账单）；
  3. **保密原则**：绝不在聊天记录、Git 仓库、Issue 或命令行参数中粘贴 `OPENROUTER_API_KEY`。

- **变更内容**：确认步骤 2 初始环境备份完好且**绝不覆盖已有备份**（同时另存一份带唯一时间戳的独立 AI 前备份），在 `/etc/bojin/environment` 中填入 `OPENROUTER_API_KEY` 与 `OPENROUTER_MODEL=openrouter/auto-beta`，强制收敛权限为 `root:bojin 0640`，在 `bojin-maintenance-lock` 保护下重启 `bojin.service`，验证 `/api/config` 返回 `"ai":true` 且最终只读主机审计 `FAIL=0`。**本步骤是全程唯一显式重启 `bojin.service` 的步骤**。
- **执行命令（分 5.1 备份编辑 与 5.2 重启核验两段执行）**：

```bash
# 5.1 确认步骤 2 初始备份存在，另存唯一不重名的 AI 前备份（绝不覆盖已有备份），全部成功后才打开编辑器
(
set -euo pipefail
BACKUP_STAGE=$(sudo cat /root/bojin-host-pre-initial)
sudo test -f "$BACKUP_STAGE/etc/bojin/environment"

PRE_AI_BAK="/root/bojin-env-pre-ai-$(date -u +%Y%m%dT%H%M%SZ)-$$"
sudo bash -c '
  set -euo pipefail
  if [[ -e "$1" || -L "$1" ]]; then
    echo "STOP: pre-AI backup path already exists: $1" >&2
    exit 1
  fi
  cp -a /etc/bojin/environment "$1"
  chmod 0600 "$1"
  if [[ ! -e /root/bojin-env-pre-ai-initial ]]; then
    printf "%s\n" "$1" > /root/bojin-env-pre-ai-initial
    chmod 0600 /root/bojin-env-pre-ai-initial
  fi
' _ "$PRE_AI_BAK"
echo "Saved immutable pre-AI backup: $PRE_AI_BAK"
sudo nano /etc/bojin/environment
# 新增或修改以下两行（保留原有 AUTH_SECRET、SMTP_* 等全部配置，切勿 cat 文件）：
# OPENROUTER_API_KEY=sk-or-v1-你的专用密钥
# OPENROUTER_MODEL=openrouter/auto-beta
echo "STEP 5.1 OK"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：保存退出 `nano` 后必须看到 `STEP 5.1 OK` 且 `BLOCK EXIT=0`，再粘贴下方 5.2；若 `BLOCK EXIT` 非 `0` 或输出 `STOP:`，**立即停止，不得粘贴 5.2**。

```bash
# 5.2 强制收敛 root:bojin 0640、校验键非空、在双锁包装器内重启应用，并显式拦截任何 FAIL 审计项
(
set -euo pipefail
sudo chown root:bojin /etc/bojin/environment
sudo chmod 0640 /etc/bojin/environment
if [[ "$(sudo stat -c '%U:%G:%a' /etc/bojin/environment)" != "root:bojin:640" ]]; then
  echo "STOP: /etc/bojin/environment permissions are not root:bojin:640" >&2
  exit 1
fi

sudo python3 - <<'PY'
d = {}
for line in open('/etc/bojin/environment', encoding='utf-8'):
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1)
        d[k.strip()] = v.strip().strip('"\'')
key = d.get('OPENROUTER_API_KEY', '')
model = d.get('OPENROUTER_MODEL', '')
assert len(key) > 0, 'OPENROUTER_API_KEY is missing or empty'
assert model == 'openrouter/auto-beta', f'Expected openrouter/auto-beta, got {model!r}'
print(f'OPENROUTER_API_KEY: present (len={len(key)})')
print(f'OPENROUTER_MODEL: {model}')
PY

sudo /usr/local/sbin/bojin-maintenance-lock -- systemctl restart bojin.service

curl -fsSL https://leanritual.app/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True; print("Health:", d)'
curl -fsSL https://leanritual.app/api/config | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ai") is True, d; print("Config:", d)'
sudo journalctl -u bojin.service -n 25 --no-pager | grep 'AI 已配置 openrouter/auto-beta'

cd ~/Lean-Ritual
sudo bash scripts/host-audit.sh | tee /tmp/host-audit-after.txt
grep -E '^(FAIL|WARN|Summary:)' /tmp/host-audit-after.txt || true
if grep -q '^FAIL ' /tmp/host-audit-after.txt; then
  echo "STOP: host audit has FAIL findings" >&2
  exit 1
fi
echo "STEP 5.2 OK"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：必须看到 `STEP 5.2 OK` 且 `BLOCK EXIT=0` 才代表宿主机升级与 AI 启用全部通过；若 `BLOCK EXIT` 非 `0` 或输出 `STOP:` / `停止`，**立即停止**，按下方排查或执行**步骤 7.5** 回滚。

- **预期输出**：
  - 脱敏检查输出 `OPENROUTER_API_KEY: present (len=...)` 与 `OPENROUTER_MODEL: openrouter/auto-beta`；
  - `Health:` 输出 `{'ok': True, 'revision': '...'}`，`Config:` 输出 `{'allowSignup': True, 'invite': True, 'ai': True}`（注：`/api/config` 的 `ai:true` 仅证明应用读到了非空密钥；上游模型路由与视觉识图可用性仍需登录测试账号拍一张餐食照实测）；
  - `journalctl` 匹配到 `AI 已配置 openrouter/auto-beta`；
  - `host-audit-after.txt` 通过显式 `if grep -q '^FAIL '` 门控，末尾显示 **`Summary: FAIL=0 WARN=...`**（4 个 root 辅助程序均为 `PASS MATCH`），并打印 `STEP 5.2 OK` 与 `BLOCK EXIT=0`。
- **失败处理**：
  - 若 Python 校验失败：重新 `sudo nano /etc/bojin/environment` 检查 `OPENROUTER_API_KEY` 与 `OPENROUTER_MODEL=openrouter/auto-beta` 是否拼写正确且未加 `#` 注释，再重跑 5.2。
  - 若重启后健康检查失败或报 `STOP: host audit has FAIL findings`：先查 `sudo journalctl -u bojin.service -n 30 --no-pager` 与 `/tmp/host-audit-after.txt` 中的 `FAIL` 行，或立即执行**步骤 7.5** 恢复未开启 AI 前的环境文件并重启。

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

## 步骤 7：分步回滚说明（恢复原件与 timer 原启停状态）

升级前初始基线固定记录在 `/root/bojin-host-pre-initial`（对应目录内含原件副本、`absent-before.txt` 及 `timer-states.tsv`），步骤 5 首次编辑前的环境配置另存在 `/root/bojin-env-pre-ai-initial`。回滚任何宿主机组件时**仍须通过双锁包装器加锁，切勿删除 `/run/lock/bojin-maintenance.lock`，且每段执行后同样必须确认 `ROLLBACK ... OK` 与 `BLOCK EXIT=0`**。由于 `/root` 为 `0700`，所有读取与哈希比对均须带 `sudo`。

### 7.0 / 7.1 步骤 0 与步骤 1 回滚
只读操作无需回滚；审计完成后可清理临时报告：`sudo rm -f /tmp/host-audit-before.txt /tmp/host-audit-after.txt`。

### 7.2 步骤 2 回滚（恢复旧版辅助程序、systemd 单元及 timer 常规启停状态）

- **仅回滚单个辅助程序**（例如仅回滚部署接收器，其余保持新版；不重启应用）：

```bash
(
set -euo pipefail
BACKUP_STAGE=$(sudo cat /root/bojin-host-pre-initial)
sudo test -f "$BACKUP_STAGE/usr/local/sbin/lean-ritual-deploy"
sudo /usr/local/sbin/bojin-maintenance-lock -- \
  cp -a "$BACKUP_STAGE/usr/local/sbin/lean-ritual-deploy" /usr/local/sbin/lean-ritual-deploy
sudo sha256sum "$BACKUP_STAGE/usr/local/sbin/lean-ritual-deploy" /usr/local/sbin/lean-ritual-deploy
sudo cmp -s "$BACKUP_STAGE/usr/local/sbin/lean-ritual-deploy" /usr/local/sbin/lean-ritual-deploy
echo "ROLLBACK 7.2a OK"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：确认输出 `ROLLBACK 7.2a OK` 且 `BLOCK EXIT=0`；若非 `0`，立即停止并检查 `/root/bojin-host-pre-initial` 备份目录完整性。

- **整套回滚步骤 2 全部宿主机文件与 timer 状态**（恢复升级前存在的文件，停用并移除升级前不存在的新增单元，按 `timer-states.tsv` 还原 `bojin-backup.timer` 与 `bojin-watchdog.timer` 原本的 `enabled`/`enabled-runtime`/`disabled` 与 `active`/`inactive` 状态——注：若某单元升级前处于 `masked` 将保持 `masked`；保留 `/etc/tmpfiles.d/bojin.conf` 与 `/usr/local/sbin/bojin-maintenance-lock`；不重启应用）：

```bash
(
set -euo pipefail
BACKUP_STAGE=$(sudo cat /root/bojin-host-pre-initial)
sudo /usr/local/sbin/bojin-maintenance-lock -- bash -c '
  set -euo pipefail
  stage=$1
  test -d "$stage"
  test -f "$stage/absent-before.txt"
  test -f "$stage/timer-states.tsv"

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
      if [[ "$f" == *.timer ]]; then
        systemctl disable --now "$(basename "$f")" 2>/dev/null || true
      fi
      rm -f "$f"
    fi
  done

  systemctl daemon-reload

  while read -r unit prev_en prev_ac; do
    if [[ -z "$unit" || "$unit" == "bojin-backup-local.timer" ]]; then
      continue
    fi
    if ! systemctl cat "$unit" >/dev/null 2>&1; then
      continue
    fi
    case "$prev_en" in
      enabled) systemctl enable "$unit" ;;
      enabled-runtime) systemctl enable --runtime "$unit" ;;
      *) systemctl disable "$unit" 2>/dev/null || true ;;
    esac
    case "$prev_ac" in
      active|activating|reloading) systemctl restart "$unit" ;;
      *) systemctl stop "$unit" 2>/dev/null || true ;;
    esac
  done < "$stage/timer-states.tsv"
' _ "$BACKUP_STAGE"
systemctl list-timers --all 'bojin-*' --no-pager
echo "ROLLBACK 7.2b OK"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：确认输出 `ROLLBACK 7.2b OK` 且 `BLOCK EXIT=0`；若非 `0`，立即停止并检查 `systemctl status bojin-watchdog.timer bojin-backup.timer`。

### 7.3 步骤 3 回滚（首次备份与旧 `bojin-backup-local.timer` 状态恢复）
`/var/backups/bojin/` 下新生成的快照不影响运行，无需删除。仅当已执行 7.2 回退了备份单元，且需按 `timer-states.tsv` 还原旧 `bojin-backup-local.timer` 原状态（若原状态为 `enabled`/`enabled-runtime`/`active`，请先确认其 `ExecStart` 脚本真实存在，避免重现 `203/EXEC` 报错）时执行：

```bash
(
set -euo pipefail
BACKUP_STAGE=$(sudo cat /root/bojin-host-pre-initial)
sudo bash -c '
  set -euo pipefail
  stage=$1
  read -r _ prev_en prev_ac < <(grep "^bojin-backup-local\.timer" "$stage/timer-states.tsv" || printf "bojin-backup-local.timer\tnot-found\tinactive\n")
  echo "Recorded pre-upgrade bojin-backup-local.timer: enabled=$prev_en active=$prev_ac"
  systemctl cat bojin-backup-local.timer >/dev/null 2>&1
  systemctl disable --now bojin-backup.timer 2>/dev/null || true
  case "$prev_en" in
    enabled) systemctl enable bojin-backup-local.timer ;;
    enabled-runtime) systemctl enable --runtime bojin-backup-local.timer ;;
    *) systemctl disable bojin-backup-local.timer 2>/dev/null || true ;;
  esac
  case "$prev_ac" in
    active|activating|reloading) systemctl restart bojin-backup-local.timer ;;
    *) systemctl stop bojin-backup-local.timer 2>/dev/null || true ;;
  esac
' _ "$BACKUP_STAGE"
echo "ROLLBACK 7.3 OK"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：确认输出 `ROLLBACK 7.3 OK` 且 `BLOCK EXIT=0`；若非 `0`，立即停止并检查 `systemctl cat bojin-backup-local.timer`。

### 7.4 步骤 4 回滚（停用外部手机告警推送）
恢复初始备份的 `/etc/bojin-alert.env`（若升级前不存在则置空 `ALERT_URL=`），立即退回“仅写系统日志、不发网络请求”，**不重启应用**：

```bash
(
set -euo pipefail
BACKUP_STAGE=$(sudo cat /root/bojin-host-pre-initial)
if sudo test -f "$BACKUP_STAGE/etc/bojin-alert.env"; then
  sudo cp -a "$BACKUP_STAGE/etc/bojin-alert.env" /etc/bojin-alert.env
else
  printf 'ALERT_URL=\n' | sudo tee /etc/bojin-alert.env >/dev/null
  sudo chown root:root /etc/bojin-alert.env
  sudo chmod 0600 /etc/bojin-alert.env
fi
echo "ROLLBACK 7.4 OK"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：确认输出 `ROLLBACK 7.4 OK` 且 `BLOCK EXIT=0`；若非 `0`，立即停止并检查 `/etc/bojin-alert.env` 权限。

### 7.5 步骤 5 回滚（关闭 AI 并恢复未开启 AI 前的原环境配置）
优先从不可覆盖的 `/root/bojin-env-pre-ai-initial`（或步骤 2 的 `/root/bojin-host-pre-initial`）恢复 `/etc/bojin/environment`，强制核对权限并在维护锁下重启 `bojin.service`（**会重启应用**）：

```bash
(
set -euo pipefail
if sudo test -f /root/bojin-env-pre-ai-initial; then
  ENV_RESTORE=$(sudo cat /root/bojin-env-pre-ai-initial)
else
  BACKUP_STAGE=$(sudo cat /root/bojin-host-pre-initial)
  ENV_RESTORE="$BACKUP_STAGE/etc/bojin/environment"
fi
sudo test -f "$ENV_RESTORE"
sudo cp -a "$ENV_RESTORE" /etc/bojin/environment
sudo chown root:bojin /etc/bojin/environment
sudo chmod 0640 /etc/bojin/environment
sudo /usr/local/sbin/bojin-maintenance-lock -- systemctl restart bojin.service
curl -fsSL https://leanritual.app/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True; print("Health:", d)'
curl -fsSL https://leanritual.app/api/config | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ai") is False, d; print("Config:", d)'
echo "ROLLBACK 7.5 OK"
); block_rc=$?; printf 'BLOCK EXIT=%s\n' "$block_rc"
```

> **门控检查**：确认输出 `ROLLBACK 7.5 OK`、`Config:` 中 `'ai': False` 且 `BLOCK EXIT=0`；若非 `0`，立即停止并查看 `sudo journalctl -u bojin.service -n 30 --no-pager`。

### 7.6 步骤 6 回滚
在阿里云控制台解绑云盘自动快照策略并按需删除快照，不影响线上服务。

---

## 附：本次升级后的衔接检查（参考文档）

- 若步骤 1/5 审计中提示 `swapon --show` 为空或 `WARN Caddy lb_try_duration absent` / `WARN Caddy handle_errors absent`，可按 [RELIABILITY.zh-CN.md](RELIABILITY.zh-CN.md) 第 2.3、2.5 节补充 2 GiB Swap 与 Caddy 15 秒优雅等待配置。
- 公测开放前还需在宿主机上基于步骤 3 生成的新快照执行一次隔离目录恢复演练（验证 `data-backup.js verify` 与 `restore --deletions`），命令见 [OPERATIONS.md](OPERATIONS.md)（"Restore and rollback"）与 [RELEASE-GATES.md](RELEASE-GATES.md) Gate 9。
