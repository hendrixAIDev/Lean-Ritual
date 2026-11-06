# Lean Ritual · 薄肌日课

GitHub 自动部署（测试通过后部署到现有阿里云主机）：见 [GITHUB-DEPLOYMENT.md](docs/GITHUB-DEPLOYMENT.md)。默认关闭部署，完成服务器一次性设置和 GitHub Secrets 后再启用。当前部署验收证据见 [STAGING-STATUS.md](docs/STAGING-STATUS.md)。

独立部署的训练、饮食、体重记录应用。受邀用户通过邮箱和密码登录；不需要 Claude 账号、订阅或个人 API 密钥。AI 由服务器上的付费 API 提供，未配置 AI 时仍可手动记录。

当前已部署供受邀测试，尚未开放公测。任务及验证记录见 [上线计划](docs/LAUNCH-PLAN.md)，账号细节见 [authentication](docs/authentication.md)。

## 技术与目录

- Node.js 24 推荐（最低版本见 package.json）、Better Auth、SQLite。
- `server.js`：应用 API、私有记录和照片；`lib/auth.js`：标准账号系统。
- `app/index.html`：应用页面；`build.js` 生成 `public/index.html`。
- `public/shim.js`：浏览器只调用同源后台，不保存供应商 API 密钥。
- `DATA_DIR/bojin.db`：原有记录和照片索引；`auth.sqlite`：账号、会话、邀请；`blobs/`：照片。

## 本地开发

```bash
npm ci
npm run build
npm test
```

创建本地 `.env`（不要提交）：

```dotenv
HOST=127.0.0.1
PORT=8080
DATA_DIR=./data
AUTH_BASE_URL=http://127.0.0.1:8080
AUTH_SECRET=replace-with-a-unique-random-secret-at-least-32-characters
COOKIE_SECURE=0
TRUST_PROXY=0
MAIL_MODE=file
```

将示例 secret 替换为随机值后启动：

```bash
node --env-file=.env server.js
node --env-file=.env scripts/auth-admin.js invite you@example.com
```

管理员命令输出私密邀请链接。只交给对应受邀者，不要贴到公开日志或工单。打开链接、设置至少 12 位密码，再完成邮箱验证。开发模式的邮件在 `DATA_DIR/mail/`，仅供本机调试，不向外发送。`MAIL_MODE=file` 不允许公共域名；正式环境必须配置 SMTP。

## 原账号迁移

先备份整个数据目录，在副本上演练。管理员确认原账号归属及邮箱后执行：

```bash
node --env-file=.env scripts/auth-admin.js invite you@example.com --legacy-user old_username
```

新账号沿用旧用户 ID，因此记录路径和照片归属保持不变。用户重新设置密码并验证邮箱；旧密码和旧会话不再可登录。不能根据相同昵称自动认领旧数据。过期或撤销且未使用的邀请可重新发出；已注册账号使用密码恢复。

原 Claude 导出目录仍可按原用户名导入：

```bash
node --env-file=.env server.js import old_username /path/to/export
```

迁移不会自动接管旧浏览器共享草稿（无法确认属于谁）；新的草稿、饮食输入、训练备份按账号隔离。旧版尚未完成的 Claude 看图请求需要重新估算。

## 部署准备

当前已选择阿里云美国西部（硅谷）主机，配合自己的域名与 Caddy HTTPS；大陆可用性仍需实测。域名计划通过 Cloudflare 注册，初期使用 DNS-only。操作步骤见 [阿里云部署交接](docs/ALIYUN-DEPLOYMENT.md)。参考 `.env.example` 配置 AUTH_BASE_URL、随机 AUTH_SECRET、SMTP 发送账号；密钥不要进入镜像或 Git。Dockerfile 安装锁定依赖并生成页面，`.dockerignore` 排除数据与密钥。挂载持久数据卷；Node 端口仅让可信反向代理访问。

构建需要 OCR 和 HEIC 本地文件。仓库中的 OCR 资源已有许可文件；构建会从锁定的 heic2any 0.0.4 npm 依赖复制脚本及许可文件到 public/vendor，无需用户连接外部 CDN。

备份必须包含两个数据库及照片；不能直接复制运行中的 SQLite 主文件而忽略 WAL。现已提供一致备份、校验和恢复工具及本地演练，操作见 [运维手册](docs/OPERATIONS.md)。恢复必须提供最新删除记录，防止旧备份恢复已删除账号。正式主机仍需配置异地副本、保留期限与清理，并完成恢复演练。

## AI 与费用

设置 OPENROUTER_API_KEY、OPENROUTER_MODEL 和可选 OPENROUTER_BASE。管理员需确认供应商条款支持预期用户地区。所有人共用服务器配置，费用由运营者承担。

AI_DAILY_LIMIT 是每用户每日请求上限，AI_GLOBAL_DAILY_LIMIT 是全站上限（UTC 日期）。请求先原子计数，超时/失败也计数，避免已产生费用的请求反复重试。AI_MAX_OUTPUT_TOKENS 限制每次输出长度。这些不是美元金额上限；还需在供应商处配置支出控制。

## 尚未完成的上线门槛

正式主机部署与异地备份恢复、备份保留及清理策略、隐私说明中的实际供应商与地区、真实 SMTP 投递和 AI 验证、实体手机测试，以及中国大陆多运营商无 VPN 测试。迁移回滚、导出与删除账号、上传内容验证及真实 HEIC 文件转换已完成本地验证。详见 Linear 中各任务及 [当前检查点](docs/CHECKPOINT.md)；本地浏览器、OCR 和模拟 AI 测试通过不能替代这些验证。
