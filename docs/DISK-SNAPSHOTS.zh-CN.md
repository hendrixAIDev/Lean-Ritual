# 每日云盘快照（阿里云轻量应用服务器）

阿里云轻量应用服务器（Simple Application Server，硅谷 `us-west-1`）不支持 ECS 的自动快照策略（`CreateAutoSnapshotPolicy`），且单台服务器最多只能保留 **3 份快照**。仓库通过 GitHub Actions 调用 `swas-open` 接口每日自动给生产机系统盘打快照。

## 1. 运行时间与执行内容

- **定时运行**：[disk-snapshot.yml](../.github/workflows/disk-snapshot.yml) 每天 **UTC 05:00**（美西冬令时 PST 21:00 / 夏令时 PDT 22:00；北京时间 13:00）自动触发，排在每日 **UTC 04:00** 应用层备份之后；也支持手动触发（`workflow_dispatch`）。
- **执行脚本**：[ops/disk-snapshot.sh](../ops/disk-snapshot.sh)
  1. 校验目标磁盘属于生产实例且为系统盘（`System`）；
  2. 创建当日系统盘快照 `lr-auto-YYYYMMDD`（若当日同名快照已处于 `Accomplished` 状态则自动跳过重复创建）；
  3. 轮询等待新快照变为 `Accomplished`（默认最长等待 20 分钟）；
  4. 清理旧自动快照，仅删除名称以 `lr-auto-` 开头的快照。
- **失败告警**：任何接口报错、配额不足或轮询超时都会使 GitHub Actions 任务失败（标红），由 GitHub 自动发邮件通知仓库所有者。日志不输出任何密钥。

## 2. 保留策略与 3 份额度保护

- **只管自动快照**：脚本严格只删除名称前缀为 `lr-auto-` 的快照，**绝不触碰任何手动创建的快照**。
- **稳态保留**：始终保留**最新 2 份** `Accomplished` 的 `lr-auto-*` 快照，加上业主保留的 **1 份手动快照**，正好用满单实例 **3 份快照上限**。
- **满额前安全腾退**：若创建前实例已满 3 份快照，只有当删除最旧 1 份 `lr-auto-*` 后**仍至少剩余 1 份已完成的 `lr-auto-*` 快照**时，脚本才会先删最旧自动快照再建当日快照；若手动快照占用了 2 份或以上（删掉自动快照后会无自动快照兜底），任务会直接报错停止，需人工在控制台清理多余手动快照。

## 3. 专用子账号 `lr-snapshot-bot` 与最小权限策略

自动任务使用仅开启编程访问（禁止控制台登录）的阿里云 RAM 用户 `lr-snapshot-bot`，附加自定义最小权限策略（账号 `1661373457883447`，地域 `us-west-1`）。其中实例与磁盘限定到具体资源 ID；快照因每日动态生成新 `SnapshotId` 且 `ListSnapshots` / `CreateSnapshot` 按地域级快照资源鉴权，限定在 `us-west-1` 的 `snapshot/*`：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "swas-open:ListInstances"
      ],
      "Resource": [
        "acs:swas-open:us-west-1:1661373457883447:instance/<InstanceId>"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "swas-open:ListDisks"
      ],
      "Resource": [
        "acs:swas-open:us-west-1:1661373457883447:disk/<DiskId>",
        "acs:swas-open:us-west-1:1661373457883447:instance/<InstanceId>"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "swas-open:ListSnapshots",
        "swas-open:CreateSnapshot",
        "swas-open:DeleteSnapshot"
      ],
      "Resource": [
        "acs:swas-open:us-west-1:1661373457883447:snapshot/*",
        "acs:swas-open:us-west-1:1661373457883447:disk/<DiskId>",
        "acs:swas-open:us-west-1:1661373457883447:instance/<InstanceId>"
      ]
    }
  ]
}
```

GitHub 仓库配置项：
- **Secrets**：`ALIYUN_SNAPSHOT_AK_ID`、`ALIYUN_SNAPSHOT_AK_SECRET`
- **Variables**：`LR_REGION`（`us-west-1`）、`LR_INSTANCE_ID`、`LR_DISK_ID`

## 4. 如何从快照恢复（控制台回滚磁盘）

> **严重警告：回滚磁盘（Rollback Disk）会用所选快照整盘覆盖整块系统盘！** 快照时间点之后产生的所有新记录、照片、系统配置、日志以及账号删除变更都会被抹掉，且回滚期间服务器必须停机。若只是代码问题或应用数据回退，优先按 [部署与运维总手册](DEPLOYMENT-HANDBOOK.zh-CN.md) 使用本机应用快照恢复，不要直接回滚整块云盘。

确需整机回滚磁盘时：

1. 先暂停 GitHub 自动部署，避免回滚途中触发发布：`gh variable set DEPLOY_ENABLED --body false`；
2. 提前保存好**最新的独立删除台账**（`deletions.json`），防止已注销用户的数据因整盘回退被重新放出；
3. 登录阿里云 **轻量应用服务器控制台**（切换左上角地域到 **美国（硅谷）**）→ 点进 `Lean Ritual` 服务器 → **快照（Snapshots）**；
4. 找到目标快照（如最新的 `lr-auto-YYYYMMDD`），点击 **回滚磁盘**，勾选确认整盘覆盖并允许停机重启；
5. 机器启动后，用管理员 SSH 登录，按 [OPERATIONS.md](OPERATIONS.md) 在维护锁内重放最新删除台账、核对服务状态与 `curl -fsS https://leanritual.app/api/health`，确认无误后再开启 `DEPLOY_ENABLED=true`。

## 5. 如何轮换 `lr-snapshot-bot` 密钥

1. 登录阿里云 **RAM 访问控制控制台** → **身份管理 → 用户** → 点进 `lr-snapshot-bot` → **创建 AccessKey**（每个用户最多同时存在 2 个 Key）。
2. 在本机用权限 `0600` 的临时文件通过标准输入更新 GitHub Secrets（切勿把密钥直接写在命令行参数里），更新后立即删除临时文件：
   ```sh
   umask 077
   tmp_dir=$(mktemp -d)
   # 将新 AccessKey ID 写入 "$tmp_dir/id"，Secret 写入 "$tmp_dir/secret"
   gh secret set ALIYUN_SNAPSHOT_AK_ID < "$tmp_dir/id"
   gh secret set ALIYUN_SNAPSHOT_AK_SECRET < "$tmp_dir/secret"
   rm -rf "$tmp_dir"
   ```
3. 手动触发一次工作流验证新密钥可用：`gh workflow run disk-snapshot.yml && gh run list --workflow=disk-snapshot.yml --limit 1`。
4. 确认运行绿色成功后，回到阿里云 RAM 控制台将旧 AccessKey **禁用**并**删除**（若本机 `~/.aliyun/config.json` 配有 `lr-snapshot-bot` profile，同步更新并保持文件权限 `0600`）。

## 6. 如何停用与重新启用自动快照

```sh
gh workflow disable disk-snapshot.yml   # 暂停每日自动快照
gh workflow enable disk-snapshot.yml    # 重新启用每日自动快照
gh workflow run disk-snapshot.yml       # 立即手动执行一次
```
