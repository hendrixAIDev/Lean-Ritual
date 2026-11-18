# 从 Claude Artifact 导出目录迁移到线上账号

本文说明如何将原 Claude 页面版（Artifact）导出的 `bojin-server-import` 目录导入到线上已注册且**已完成邮箱验证**的 Better Auth 账号。

## 导入规则概览

- **账号解析**：只读查询 `auth.sqlite` 的 `user` 表，按归一化邮箱（去首尾空格 + 小写）精确匹配，要求 `emailVerified` 已验证；找不到或存在歧义时拒绝执行。
- **只补缺、不覆盖**：目标路径为 `data/users/<uid>/app/<rel>`；已存在的文档与已存在的同 ID 照片一律跳过，重复运行完全幂等。
- **照片重编码与去隐私元数据**：每张 `blobs/<32位hex>.<ext>` 都会经过与网页上传一致的解码、方向修正、尺寸/像素上限校验与 WebP 重编码，**剥离 EXIF 等原始元数据**，并继续使用原 `<32位hex>` ID 存储，确保已有记录中的照片引用不断链；无法解码的文件会列出并跳过，不中断其余导入。
- **额度与并发安全**：文档写入经过 `lib/doc-quota.js` 额度检查，照片写入检查单用户与全站照片空间上限；全程持有 `DATA_DIR` 共享租约并按单条文档/单张照片独立事务提交，可在 `bojin.service` 正常运行期间在线执行。

## 导出目录格式

```text
<export-dir>/
├── docs/
│   ├── app/profile.json          → data/users/<uid>/app/app/profile
│   ├── app/library.json          → data/users/<uid>/app/app/library
│   ├── days/2026-10-12.json      → data/users/<uid>/app/days/2026-10-12
│   ├── workoutLog/<id>.json      → data/users/<uid>/app/workoutLog/<id>
│   ├── profileHistory/<id>.json  → data/users/<uid>/app/profileHistory/<id>
│   ├── feedback/<id>.json        → data/users/<uid>/app/feedback/<id>
│   └── meta/...
└── blobs/
    └── <32位小写十六进制id>.<ext> → 重编码为 WebP 后存入 DATA_DIR/blobs/<id>
```

## 操作步骤

### 1. 复制导出目录到服务器临时路径

先确认目标邮箱已在 `https://leanritual.app` 完成受邀注册并通过邮箱验证。在本机将导出目录上传至服务器 `/tmp/lr-import`（可使用 SSH 别名 `leanritual`）：

```sh
scp -r /path/to/bojin-server-import leanritual:/tmp/lr-import
```

登录服务器后，将临时目录设为仅 `bojin` 可读（既保护隐私数据，又确保稍后以 `bojin` 身份运行时有读取权限）：

```sh
ssh leanritual
sudo chown -R bojin:bojin /tmp/lr-import
sudo chmod -R u=rwX,go= /tmp/lr-import
```

### 2. 导入前先执行一次备份并核对日志

```sh
sudo systemctl start bojin-backup.service
sudo journalctl -u bojin-backup.service -n 30 --no-pager
```

确认 `bojin-backup.service` 成功完成（无报错、`status=0/SUCCESS`）后再执行导入。

### 3. 运行 `--dry-run` 预览（不写入任何数据）

> [!IMPORTANT]
> `/etc/bojin/environment` 是 systemd `EnvironmentFile` 格式（例如 `MAIL_FROM` 含 `<>` 与空格），**不能**用 `bash` 的 `set -a; source /etc/bojin/environment` 加载。请通过 `systemd-run -p EnvironmentFile=/etc/bojin/environment` 由 systemd 原生解析配置，并以 `bojin` 用户在当前发布目录 `/opt/bojin` 下执行。

```sh
sudo systemd-run --uid=bojin --gid=bojin \
  -p WorkingDirectory=/opt/bojin \
  -p EnvironmentFile=/etc/bojin/environment \
  -p Environment=DATA_DIR=/var/lib/bojin \
  --wait --pipe --collect \
  /usr/bin/node --disable-warning=ExperimentalWarning /opt/bojin/server.js \
  import-account --email "你的已验证注册邮箱" /tmp/lr-import --dry-run
```

> [!WARNING]
> **切勿将 `-p Environment=DATA_DIR=...` 写法复制到恢复演练或临时实例：** 在 systemd 中，`-p EnvironmentFile=/etc/bojin/environment` 会在 `-p Environment=...` **之后**应用并覆盖文件内已定义的同名变量（包括 `DATA_DIR=/var/lib/bojin`、`PORT=8080`、`MAIL_MODE=smtp`、`AUTH_BASE_URL` 等）。此处导入目标本来就是线上生产目录 `/var/lib/bojin`，因此不受影响；但若在恢复演练或隔离验证实例中需要改指其它 `DATA_DIR`，`-p Environment=DATA_DIR=/var/tmp/...` 会被静默重置回**线上生产库** `/var/lib/bojin`。任何需要覆盖 `/etc/bojin/environment` 内键值的命令，必须在 `ExecStart` 中通过 `/usr/bin/env DATA_DIR=... PORT=... /usr/bin/node ...` 传入（完整命令见 [OPERATIONS.md](OPERATIONS.md) 与 [DEPLOYMENT-HANDBOOK.zh-CN.md](DEPLOYMENT-HANDBOOK.zh-CN.md)）。

核对预览输出中的：
- 目标账号邮箱与 `uid`（`u_...`）
- 各顶层集合（`app`、`days`、`workoutLog`、`profileHistory`、`feedback` 等）待导入条数与跳过条数
- 待导入照片张数、重编码后字节数、已存在跳过张数及无法解码的文件列表
- 文档与照片额度预估（确认未超限）

### 4. 执行正式导入

确认预览结果符合预期后，去掉 `--dry-run` 执行正式导入（同上，`-p Environment=DATA_DIR=...` 仅因与 `/etc/bojin/environment` 内生产路径一致而有效；恢复演练或临时实例必须改用 `/usr/bin/env` 覆盖）：

```sh
sudo systemd-run --uid=bojin --gid=bojin \
  -p WorkingDirectory=/opt/bojin \
  -p EnvironmentFile=/etc/bojin/environment \
  -p Environment=DATA_DIR=/var/lib/bojin \
  --wait --pipe --collect \
  /usr/bin/node --disable-warning=ExperimentalWarning /opt/bojin/server.js \
  import-account --email "你的已验证注册邮箱" /tmp/lr-import
```

命令末尾会打印汇总行（导入文档条数、跳过条数、导入照片张数与字节数、解码失败张数）。如需二次确认幂等性，可再运行一次 `--dry-run`，待导入文档和照片均应为 `0`。

### 5. 应用内验证与清理临时文件

1. 登录 `https://leanritual.app`，核对个人档案、历史打卡日历与体重记录、餐食照片展示、训练日志与周期反馈是否完整正常。
2. 验证无误后，立即删除服务器上的临时目录（并按需清理本机临时副本）：

```sh
sudo rm -rf /tmp/lr-import
```
