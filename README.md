# 薄肌日课 · 独立部署版

和 Claude 里的"薄肌日课"是同一个应用，换成了自己的服务器：用户名 + 密码登录，每个人的记录只存在自己账号下，照片存在服务器上，AI 估算通过服务器上的 OpenRouter 密钥调用。

只依赖 Node 22（22.13 或更新），不需要 `npm install`，数据库是 Node 自带的 SQLite。

## 目录

| 路径 | 作用 |
| --- | --- |
| `server.js` | 服务器：登录、数据、照片、AI 代理，以及建账号、导入数据的命令 |
| `app/index.html` | 应用源码，和 Claude 页面版是同一份 |
| `build.js` | 把 `app/index.html` 生成 `public/index.html`（接上服务器、去掉 Google 字体） |
| `public/` | 网站文件：登录页、纲领页、文字识别（OCR）文件 |
| `.env.example` | 配置模板 |
| `Caddyfile`、`bojin.service`、`Dockerfile` | 上线用的配置 |

## 本机先试一下

```bash
node build.js
DATA_DIR=./data node --disable-warning=ExperimentalWarning server.js create-user <你的用户名>   # 按提示输密码
DATA_DIR=./data node --disable-warning=ExperimentalWarning server.js import <你的用户名> ../bojin-server-import
DATA_DIR=./data OPENROUTER_API_KEY=sk-or-... node --disable-warning=ExperimentalWarning server.js
```

打开 http://127.0.0.1:8080 登录。

## 上线（Ubuntu + Caddy，推荐）

1. 买一台海外服务器（香港、新加坡、日本都行，原因见下面"上线前要知道的事"），再买一个域名，把域名的 A 记录指向服务器 IP。
2. 装 Node 22 和 Caddy，然后把这个文件夹放到 `/opt/bojin`：
   ```bash
   sudo useradd -r -s /usr/sbin/nologin bojin
   sudo mkdir -p /var/lib/bojin && sudo chown bojin /var/lib/bojin
   cd /opt/bojin && sudo cp .env.example .env && sudo nano .env   # 填 OPENROUTER_API_KEY、INVITE_CODE
   sudo chmod 600 .env
   ```
3. 下载 iPhone 照片（HEIC）转换库，再生成网页：
   ```bash
   curl -o public/vendor/heic2any.min.js https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js
   node build.js
   ```
4. 建你的账号并导入原来的记录和照片（密码在提示后输入，不会留在命令历史里）：
   ```bash
   sudo -u bojin env DATA_DIR=/var/lib/bojin node --disable-warning=ExperimentalWarning server.js create-user <你的用户名>
   sudo -u bojin env DATA_DIR=/var/lib/bojin node --disable-warning=ExperimentalWarning server.js import <你的用户名> /path/to/bojin-server-import
   ```
   导入只补缺、不覆盖，重复运行是安全的。
5. 启动并设为开机自启：
   ```bash
   sudo cp bojin.service /etc/systemd/system/ && sudo systemctl enable --now bojin
   ```
6. 把 `Caddyfile` 里的域名改成你的，放到 `/etc/caddy/Caddyfile`，`sudo systemctl reload caddy`。Caddy 会自动申请 HTTPS 证书。
7. 打开 `https://你的域名` 登录。

用 Docker 也可以：`docker build -t bojin . && docker run -d --name bojin -p 127.0.0.1:8080:8080 -v bojin-data:/data --env-file .env bojin`，建账号用 `docker exec -it bojin node server.js create-user <你的用户名>`。

## 日常维护

- **忘记密码**：没有邮箱找回，由你在服务器上重置：`server.js set-password 用户名`。
- **备份**：所有数据在 `DATA_DIR` 里（`bojin.db` 和 `blobs/` 照片）。每天备份一次：`sqlite3 /var/lib/bojin/bojin.db ".backup /backup/bojin-$(date +%F).db"`，再同步 `blobs/`。
- **改应用**：改 `app/index.html` 后运行 `node build.js`，刷新页面即可，不用重启。
- **关注册**：`.env` 里 `ALLOW_SIGNUP=0`，之后只能用命令行建账号。

## 上线前要知道的事

1. **只用 http 不安全。** 密码和记录会明文传输，同一个 Wi‑Fi 下的人能截到，浏览器也会标"不安全"。必须上 HTTPS：有域名后 Caddy 自动搞定。`.env` 里 `COOKIE_SECURE=1` 时，用 http 打开会登录不上，这是故意的。只在本机试用时设成 0。
2. **服务器放在中国大陆要备案，而且连不上 OpenRouter。** 大陆服务器开放 80/443 端口需要 ICP 备案（几周时间），并且大陆网络访问不了 OpenRouter。放在香港、新加坡、日本可以免备案，也能连 OpenRouter；国内用户访问会慢一点。
3. **你的 Claude 订阅在自己的服务器上用不了。** 订阅只能在 claude.ai 里用，服务器只能按量付费调 API（OpenRouter 或 Anthropic API）。所以服务器版里 <你的用户名> 也走 OpenRouter。你想继续用订阅，就继续用 Claude 里的版本；两边数据不互通，导入后在 Claude 版新记的内容不会自动过来（可以再导入一次，只补缺）。
4. **AI 费用会被别人用掉。** 开放注册后任何人都能用你的 OpenRouter 额度。建议设 `INVITE_CODE`，并用 `AI_DAILY_LIMIT` 限制每人每天次数，在 OpenRouter 后台再设一个月度上限。
5. **国内打不开的外部资源。** 已去掉 Google 字体、HEIC 库改成自己服务器提供、纲领改成站内页面。动作讲解里的 YouTube 搜索链接国内打不开，B 站链接可以。
6. **隐私。** 体重、伤病、饮食照片属于健康类敏感信息。面向全球用户需要一份隐私政策，并提供导出和删除账号（现在还没有这两个功能）。欧盟用户适用 GDPR，中国用户适用个人信息保护法。
7. **Claude 专属功能没有了。** 服务器版没有"发给 Claude 看图排队"和每小时的看图检查，拍照估算直接由服务器的 AI 当场完成。
