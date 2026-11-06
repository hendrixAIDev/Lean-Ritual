# 服务稳定性：尽量不宕机

目标：应用崩溃、卡死、更新、Caddy 出问题时，能在几秒到一分钟内自己恢复，用户尽量感觉不到；恢复不了时，你的手机能马上收到通知。

单台服务器做不到 100% 不宕机：整台机器断电、阿里云故障、网络被墙，都只能靠外部监控尽快发现、靠云盘快照和异地备份恢复。下面这些措施覆盖的是单机上能自动处理的问题。

## 1. 这次改了什么

| 问题 | 以前 | 现在 | 生效方式 |
| --- | --- | --- | --- |
| 照片文件丢失 | 打开那张照片会让整个服务进程崩溃，所有人掉线 | 返回 404，服务照常 | 合并后自动部署 |
| 非法网址（如 `/%E0%A4%A`） | 返回 500 | 返回 400 | 自动部署 |
| 未预料的异常 | 进程直接退出，靠 systemd 的 on-failure 重启 | 记录错误，停止接新请求、关好数据库，再以非零码退出让 systemd 重启 | 自动部署 |
| 删除账号的定时重试出错 | 定时器里抛错会让进程崩溃 | 记录后下一分钟再试 | 自动部署 |
| 健康检查 `/api/health` | 进程活着就返回 ok | 还会查一次数据库，数据库卡住或坏了会返回 500 | 自动部署 |
| Caddy 偶发 502 | Node 默认 5 秒关闭空闲连接，Caddy 复用时可能刚好被关 | 空闲连接保持 125 秒，长于 Caddy 的 2 分钟 | 自动部署 |
| SQLite 被占用 | 管理脚本同时写时直接报错 | 最多等 5 秒 | 自动部署 |
| 照片断电丢失 | 写入后没有落盘 | 写完先 fsync 再登记到数据库 | 自动部署 |
| 进程被 kill -9 / 内存不足杀掉后 | 留下的租约文件让之后的每日备份和自动部署一直失败，需要手动清理；崩溃的备份留下的锁还会让应用起不来 | 能证明属于本机已死进程的租约会被自动清掉；无法证明的（别的容器、别的机器、旧格式）照旧拒绝，绝不误删 | 自动部署 |
| 重启或更新的那几秒 | 页面上的保存/读取直接失败 | 读取、整篇保存、合并修改、删除会自动重试约 15 秒；上传照片和 AI 请求不会自动重发 | 自动部署 |
| systemd 重启策略 | `Restart=on-failure`，连续失败 5 次就放弃 | `Restart=always`，永不放弃；内存吃紧时优先不杀这个进程 | **需要你在服务器上执行** |
| 进程活着但不响应 | 没人发现 | 看门狗每 30 秒查一次，连续 3 次失败就重启应用 | **需要你在服务器上执行** |
| Caddy 进程挂了 | 只在异常退出时重启，失败多次就放弃 | 一律重启，永不放弃；看门狗也会查 | **需要你在服务器上执行** |
| 崩溃、备份失败、磁盘快满 | 没人知道 | 发通知到你的手机（30 分钟内同类只发一次） | **需要你在服务器上执行** |
| 应用重启时访问网站 | 浏览器看到空白 502 | Caddy 先等 15 秒；仍连不上时显示“正在更新，你的记录都在”并自动刷新 | **需要你改 Caddyfile** |

数据规则：没有改任何数据结构或字段，旧数据照常读取；租约清理只删锁文件，不碰数据库和照片。

## 2. 你需要在服务器上做的事

用管理员账号（admin）SSH 登录服务器后执行。建议在用户少的时候做，全程大约 10 分钟。以下命令都不会输出密钥。

### 2.1 安装自动重启、看门狗和告警（必做）

先等这个 PR 合并、自动部署成功（`curl -s https://leanritual.app/api/health` 里的 revision 等于 main 最新提交）。然后：

```sh
cd /tmp
curl -fsSL -o lean-ritual.tar.gz https://github.com/hendrixAIDev/Lean-Ritual/archive/refs/heads/main.tar.gz
tar xzf lean-ritual.tar.gz
cd Lean-Ritual-main
less ops/install-reliability.sh        # 先看一眼它要做什么
sudo bash ops/install-reliability.sh
```

脚本会：

- 把 `ops/bojin-reliability.conf` 装成 `bojin.service` 的附加配置（只改重启策略，不动用户、路径和环境变量）；
- 有 Caddy 时同样给 `caddy.service` 加上永不放弃的重启；
- 安装看门狗 `/usr/local/libexec/bojin-watchdog` 和每 30 秒一次的 `bojin-watchdog.timer`；
- 安装告警脚本 `/usr/local/libexec/bojin-alert`，并给已有的备份任务（`bojin-backup.service`、`bojin-backup-local.service`）加上失败告警；
- 生成空的 `/etc/bojin-alert.env`（权限 0600）。

它不会重启应用，不改数据、不改 Caddyfile、不读也不改 `/etc/bojin/environment`。看门狗在部署、备份持有维护锁时会自动跳过，应用被人手动停掉时也不会去拉起它。

确认：

```sh
systemctl show bojin.service -p Restart -p StartLimitIntervalUSec   # 应为 Restart=always、StartLimitIntervalUSec=0
systemctl list-timers bojin-watchdog.timer --no-pager
journalctl -t bojin-watchdog -n 20 --no-pager                       # 正常时没有输出
```

### 2.2 手机通知（强烈建议）

最省事的是 ntfy（免费、iOS/安卓都有 App，不用注册）：

1. 手机安装 ntfy，订阅一个别人猜不到的主题名，例如 `leanritual-` 加一串随机字母数字（可用 `openssl rand -hex 12` 生成）。主题名相当于密码，不要发到群里。
2. 服务器上：`sudo nano /etc/bojin-alert.env`，填 `ALERT_URL=https://ntfy.sh/你的主题名`。
3. 测试：`sudo /usr/local/libexec/bojin-alert 测试通知`，手机应在几秒内收到。

通知内容只有状态（哪个服务、什么问题），不含任何用户数据。不填 `ALERT_URL` 时只写进系统日志。

### 2.3 Caddy：重启期间自动等待并显示友好提示（建议）

把仓库根目录 `Caddyfile` 里 `reverse_proxy { ... }` 和 `handle_errors { ... }` 两段，合并进服务器上的 `/etc/caddy/Caddyfile` 的 `leanritual.app { }` 里（保留你现有的其他配置，域名不要改成示例的 bojin.example.com）。然后：

```sh
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d)
sudo nano /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile   # 必须显示 Valid configuration
sudo systemctl reload caddy
curl -s https://leanritual.app/api/health
```

validate 不通过就不要 reload，改回备份即可：`sudo cp /etc/caddy/Caddyfile.bak-日期 /etc/caddy/Caddyfile`。

### 2.4 外部监控（强烈建议，管整台机器挂掉的情况）

服务器上的看门狗管不了整台机器断电、断网或证书过期。用一个外部免费服务从外面定时访问：

- UptimeRobot（免费版每 5 分钟一次）或 Better Stack：新建 HTTP(S)/Keyword 监控，地址 `https://leanritual.app/api/health`，关键字 `"ok":true`，通知方式选邮件或它们的手机 App。
- 也可以用阿里云云监控的“站点监控”，同时能看大陆各地的访问情况。

### 2.5 内存保险（2 GiB 机器建议）

处理照片会临时用不少内存。没有交换空间时，内存一满进程会被直接杀掉。先看有没有：`swapon --show`。没有输出就加 2 GiB：

```sh
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 2.6 演练一次（建议，用户少的时候）

```sh
sudo systemctl kill -s SIGKILL bojin.service    # 模拟崩溃
sleep 5; curl -s https://leanritual.app/api/health   # 应已恢复 ok
```

30 秒内手机应收到“app crashed and systemd restarted it”。SQLite 使用 WAL，被强杀不会损坏数据库。

## 3. 出问题时怎么查

```sh
systemctl status bojin caddy --no-pager
journalctl -u bojin -n 100 --no-pager           # 应用日志（崩溃原因在这里）
journalctl -t bojin-watchdog -t bojin-alert -n 50 --no-pager
systemctl list-timers 'bojin-*' --no-pager
df -h /var/lib/bojin
```

停用看门狗：`sudo systemctl disable --now bojin-watchdog.timer`。去掉重启策略改动：`sudo rm /etc/systemd/system/bojin.service.d/reliability.conf && sudo systemctl daemon-reload`。

## 4. 还没解决、需要单独决定的

- 异地备份和恢复演练（见 [总手册](DEPLOYMENT-HANDBOOK.zh-CN.md) 第 5 节）仍是最大风险：整机损坏时只有异地副本能救数据。
- 每次部署要先停应用做快照，期间有一小段时间不可用（Caddy 会让访问者先等 15 秒，再显示“正在更新”）。要做到更新零停机，需要改成不停机的在线备份，这次没有动。
- 真正的高可用（两台服务器、自动切换）对现在的用户量不划算，等用户多了再考虑。
