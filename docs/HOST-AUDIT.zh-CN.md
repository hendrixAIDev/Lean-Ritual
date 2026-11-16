# 主机只读审计

将脚本复制到主机后以 root 运行：

```sh
scp scripts/host-audit.sh admin@HOST:/tmp/ && ssh admin@HOST 'sudo bash /tmp/host-audit.sh | tee /tmp/host-audit.txt'
```

报告依次检查运行时、发布版本与健康接口、管理员辅助程序哈希、systemd 与日志、权限与容量、遗留环境文件、租约、配置键和 Caddy。PASS 表示检查通过，WARN 表示需人工核对，FAIL 表示发现问题；末尾给出计数。脚本不会修复问题，发现失败仍返回 0；非 root 会拒绝执行。

日志和命令行中包含 key、secret、pass、token、topic、Authorization 或 HTTP URL 的整行会隐藏；其余诊断信息保留。辅助程序缺少参考副本时，请将输出哈希与仓库文件离线比较。配置只显示键的状态、密钥长度和非敏感布尔值；备份及告警 URL 只显示协议与主机，不显示用户、密码和路径。AUDIT_TEST_MODE=1 仅在设置非根目录 AUDIT_ROOT 时允许非 root 测试，正常操作请勿设置这些变量。输出仍应在分享前人工审阅。
