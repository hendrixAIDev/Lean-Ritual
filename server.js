#!/usr/bin/env node
// 薄肌日课 · 独立部署服务器
// 只用 Node 22 自带模块（http、crypto、node:sqlite），不需要 npm install。
// 功能：账号密码登录、每人私有的数据存储（与 Claude 页面版同样的路径结构）、照片存储、AI 代理（OpenRouter，密钥只在服务器上）。
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const CFG = {
  port: +(process.env.PORT || 8080),
  host: process.env.HOST || "127.0.0.1",
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, "data")),
  publicDir: path.join(ROOT, "public"),
  allowSignup: (process.env.ALLOW_SIGNUP ?? "1") !== "0",
  inviteCode: process.env.INVITE_CODE || "",              // 设了就必须填邀请码才能注册
  orKey: process.env.OPENROUTER_API_KEY || "",
  orBase: process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1",
  orModel: process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
  aiDaily: +(process.env.AI_DAILY_LIMIT || 60),            // 每人每天 AI 次数上限
  cookieSecure: process.env.COOKIE_SECURE === "1",         // 走 HTTPS 时设为 1
  sessionDays: +(process.env.SESSION_DAYS || 30),
  trustProxy: process.env.TRUST_PROXY === "1",             // 在 Caddy/Nginx 后面时设为 1，按 X-Forwarded-For 限流
};

fs.mkdirSync(path.join(CFG.dataDir, "blobs"), { recursive: true });
const db = new DatabaseSync(path.join(CFG.dataDir, "bojin.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, created TEXT NOT NULL, mustChange INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, uid TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, uid TEXT NOT NULL, parent TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent);
  CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ai_usage (uid TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(uid, day));
`);

/* ---------- 密码与会话 ---------- */
const scrypt = (pw, salt) => crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
const hashPass = pw => { const salt = crypto.randomBytes(16).toString("hex"); return `s1$${salt}$${scrypt(pw, salt)}`; };
const checkPass = (pw, stored) => {
  const [v, salt, h] = String(stored).split("$"); if (v !== "s1" || !salt || !h) return false;
  const a = Buffer.from(scrypt(pw, salt), "hex"), b = Buffer.from(h, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const normName = s => String(s || "").trim().toLowerCase();
function validPassword(pw){ pw = String(pw || ""); return pw.length >= 8 && pw.length <= 200; }

function createUser(username, password, { mustChange = false } = {}){
  const name = normName(username);
  if (!USERNAME_RE.test(name)) throw httpErr(400, "bad_username", "用户名要 3–32 个字母、数字、下划线、点或减号");
  if (!validPassword(password)) throw httpErr(400, "weak_password", "密码至少 8 位");
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(name)) throw httpErr(409, "taken", "这个用户名已被注册");
  const id = "u_" + crypto.randomBytes(16).toString("base64url");
  db.prepare("INSERT INTO users (id, username, pass, created, mustChange) VALUES (?, ?, ?, ?, ?)").run(id, name, hashPass(password), new Date().toISOString(), mustChange ? 1 : 0);
  return { id, username: name };
}
function newSession(uid){
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token, uid, expires) VALUES (?, ?, ?)").run(sha(token), uid, Date.now() + CFG.sessionDays * 864e5);
  return token;
}
function sessionUser(req){
  const tok = parseCookies(req.headers.cookie || "").bj_s; if (!tok) return null;
  const s = db.prepare("SELECT uid, expires FROM sessions WHERE token = ?").get(sha(tok));
  if (!s || s.expires < Date.now()) return null;
  return db.prepare("SELECT id, username, created, mustChange FROM users WHERE id = ?").get(s.uid) || null;
}
const cookie = (tok, maxAge) => `bj_s=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${CFG.cookieSecure ? "; Secure" : ""}`;
function parseCookies(h){ const o = {}; for (const p of h.split(";")) { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }

/* ---------- 限流（登录防暴力破解） ---------- */
const hits = new Map();
function limited(key, max, windowMs){
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr); return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 36e5)) hits.delete(k); db.prepare("DELETE FROM sessions WHERE expires < ?").run(now); }, 6e5).unref();
const clientIP = req => (CFG.trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";

/* ---------- 工具 ---------- */
function httpErr(status, code, message){ const e = new Error(message || code); e.status = status; e.code = code; return e; }
function send(res, status, obj, headers = {}){
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }); res.end(body);
}
function readBody(req, max){
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > max) { reject(httpErr(413, "too_large", "内容太大")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject);
  });
}
async function readJSON(req, max = 2e6){ const b = await readBody(req, max); try { return JSON.parse(b.toString("utf8") || "{}"); } catch { throw httpErr(400, "bad_json"); } }

// 文档路径：只允许读写自己的 data/users/<uid>/...（和 Claude 页面版一样的结构）
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function ownPath(p, user, wantDoc){
  const segs = String(p || "").split("/");
  if (!segs.every(s => SEG.test(s) && s !== "." && s !== "..")) throw httpErr(400, "bad_path");
  if (segs[0] !== "data" || segs[1] !== "users" || segs[2] !== user.id) throw httpErr(403, "forbidden", "只能访问自己的数据");
  if (wantDoc ? segs.length % 2 !== 0 : segs.length % 2 !== 1) throw httpErr(400, "bad_path");
  return segs.join("/");
}
const parentOf = p => p.split("/").slice(0, -1).join("/");
function getDoc(p){ const r = db.prepare("SELECT data FROM docs WHERE path = ?").get(p); return r ? JSON.parse(r.data) : null; }
function putDoc(p, uid, data){
  db.prepare("INSERT INTO docs (path, uid, parent, data, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated = excluded.updated")
    .run(p, uid, parentOf(p), JSON.stringify(data), new Date().toISOString());
}
// 和 Firestore 一样的 update：顶层字段合并，值为 {"__delete__":true} 时删掉
function mergeDoc(old, patch){ const o = { ...(old || {}) }; for (const [k, v] of Object.entries(patch || {})) { if (v && typeof v === "object" && v.__delete__ === true) delete o[k]; else o[k] = v; } return o; }

/* ---------- AI 代理 ---------- */
async function aiProxy(user, body){
  if (!CFG.orKey) throw httpErr(503, "sampling_disabled", "服务器没有配置 AI");
  const day = new Date().toISOString().slice(0, 10);
  const used = db.prepare("SELECT n FROM ai_usage WHERE uid = ? AND day = ?").get(user.id, day)?.n || 0;
  if (used >= CFG.aiDaily) throw httpErr(429, "rate_limited", "今天的 AI 次数用完了");
  db.prepare("INSERT INTO ai_usage (uid, day, n) VALUES (?, ?, 1) ON CONFLICT(uid, day) DO UPDATE SET n = n + 1").run(user.id, day);
  const turns = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const imgs = (Array.isArray(body.images) ? body.images : []).slice(0, 4).filter(u => typeof u === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(u));
  const messages = turns.map(t => ({ role: t.role === "assistant" ? "assistant" : "user", content: String(t.content ?? "").slice(0, 60000) }));
  if (!messages.length) throw httpErr(400, "bad_request");
  if (imgs.length) { const last = messages[messages.length - 1]; last.content = [{ type: "text", text: last.content }, ...imgs.map(url => ({ type: "image_url", image_url: { url } }))]; }
  const r = await fetch(CFG.orBase + "/chat/completions", {
    method: "POST", headers: { "Authorization": "Bearer " + CFG.orKey, "Content-Type": "application/json", "X-Title": "Bojin Rike" },
    body: JSON.stringify({ model: CFG.orModel, messages, user: user.id }), signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.error) {
    console.warn("openrouter", r.status, j?.error?.message);
    throw httpErr(r.status === 429 ? 429 : 502, r.status === 429 ? "rate_limited" : (r.status === 400 && imgs.length ? "image_rejected" : "ai_failed"), "AI 服务出错");
  }
  return { text: String(j?.choices?.[0]?.message?.content ?? ""), truncated: j?.choices?.[0]?.finish_reason === "length" };
}

/* ---------- 静态文件 ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };
function serveStatic(req, res, user){
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") { if (!user) { res.writeHead(302, { Location: "/login.html" }); return res.end(); } p = "/index.html"; }
  if (p === "/index.html" && !user) { res.writeHead(302, { Location: "/login.html" }); return res.end(); }
  const f = path.join(CFG.publicDir, path.normalize(p).replace(/^([/\\])+/, ""));
  if (!f.startsWith(CFG.publicDir + path.sep)) { res.writeHead(404); return res.end(); }
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("没有这个页面"); }
    const ext = path.extname(f);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": st.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400" });
    fs.createReadStream(f).pipe(res);
  });
}

/* ---------- 路由 ---------- */
const SEC_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY" };
async function handle(req, res){
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, "http://x"), p = url.pathname, m = req.method;
  const user = sessionUser(req);
  // 改数据的请求必须带自定义头，挡掉跨站表单提交（CSRF）
  if (m !== "GET" && m !== "HEAD" && req.headers["x-bojin"] !== "1") throw httpErr(403, "csrf", "请求来源不对");

  if (p === "/api/health") return send(res, 200, { ok: true });
  if (p === "/api/config" && m === "GET") return send(res, 200, { allowSignup: CFG.allowSignup, invite: !!CFG.inviteCode, ai: !!CFG.orKey });

  if (p === "/api/register" && m === "POST") {
    if (!CFG.allowSignup) throw httpErr(403, "signup_closed", "暂时不开放注册");
    if (limited("reg:" + clientIP(req), 5, 36e5)) throw httpErr(429, "rate_limited", "注册太频繁，稍后再试");
    const b = await readJSON(req, 1e4);
    if (CFG.inviteCode && b.invite !== CFG.inviteCode) throw httpErr(403, "bad_invite", "邀请码不对");
    const u = createUser(b.username, b.password);
    return send(res, 200, { ok: true, user: u }, { "Set-Cookie": cookie(newSession(u.id), CFG.sessionDays * 86400) });
  }
  if (p === "/api/login" && m === "POST") {
    const b = await readJSON(req, 1e4), name = normName(b.username);
    if (limited("ip:" + clientIP(req), 20, 9e5) || limited("user:" + name, 8, 9e5)) throw httpErr(429, "rate_limited", "尝试次数太多，15 分钟后再试");
    const row = db.prepare("SELECT id, username, pass, mustChange FROM users WHERE username = ?").get(name);
    if (!row || !checkPass(String(b.password || ""), row.pass)) throw httpErr(401, "bad_login", "用户名或密码不对");
    return send(res, 200, { ok: true, user: { id: row.id, username: row.username, mustChange: !!row.mustChange } }, { "Set-Cookie": cookie(newSession(row.id), CFG.sessionDays * 86400) });
  }
  if (p === "/api/logout" && m === "POST") {
    const tok = parseCookies(req.headers.cookie || "").bj_s; if (tok) db.prepare("DELETE FROM sessions WHERE token = ?").run(sha(tok));
    return send(res, 200, { ok: true }, { "Set-Cookie": cookie("", 0) });
  }

  if (p.startsWith("/api/")) {
    if (!user) throw httpErr(401, "session_expired", "请先登录");
    if (p === "/api/me" && m === "GET") return send(res, 200, { id: user.id, username: user.username, created: user.created, mustChange: !!user.mustChange, ai: !!CFG.orKey, aiModel: CFG.orModel });
    if (p === "/api/password" && m === "POST") {
      const b = await readJSON(req, 1e4);
      if (limited("pw:" + user.id, 8, 9e5)) throw httpErr(429, "rate_limited", "尝试次数太多，稍后再试");
      const row = db.prepare("SELECT pass FROM users WHERE id = ?").get(user.id);
      if (!checkPass(String(b.old || ""), row.pass)) throw httpErr(401, "bad_login", "原密码不对");
      if (!validPassword(b.new)) throw httpErr(400, "weak_password", "新密码至少 8 位");
      if (normName(b.new) === user.username) throw httpErr(400, "weak_password", "密码不能和用户名一样");
      db.prepare("UPDATE users SET pass = ?, mustChange = 0 WHERE id = ?").run(hashPass(String(b.new)), user.id);
      // 改密码后其他设备全部退出，只留当前这次
      const tok = parseCookies(req.headers.cookie || "").bj_s;
      db.prepare("DELETE FROM sessions WHERE uid = ? AND token != ?").run(user.id, sha(tok));
      return send(res, 200, { ok: true });
    }
    if (p === "/api/doc") {
      const dp = ownPath(url.searchParams.get("path"), user, true);
      if (m === "GET") { const d = getDoc(dp); return send(res, 200, { exists: !!d, data: d }); }
      if (m === "PUT") { const b = await readJSON(req); if (!b || typeof b.data !== "object" || Array.isArray(b.data)) throw httpErr(400, "bad_request"); putDoc(dp, user.id, b.data); return send(res, 200, { ok: true }); }
      if (m === "PATCH") { const b = await readJSON(req); const old = getDoc(dp); if (!old) throw httpErr(404, "not_found"); putDoc(dp, user.id, mergeDoc(old, b.data)); return send(res, 200, { ok: true }); }
      if (m === "DELETE") { db.prepare("DELETE FROM docs WHERE path = ?").run(dp); return send(res, 200, { ok: true }); }
    }
    if (p === "/api/list" && m === "GET") {
      const col = ownPath(url.searchParams.get("col"), user, false);
      const order = url.searchParams.get("order"), dir = url.searchParams.get("dir") === "asc" ? "ASC" : "DESC";
      const limit = Math.min(1000, Math.max(1, +url.searchParams.get("limit") || 1000));
      let rows;
      if (order && /^[A-Za-z0-9_]{1,64}$/.test(order)) rows = db.prepare(`SELECT path, data FROM docs WHERE parent = ? ORDER BY json_extract(data, '$.' || ?) ${dir} LIMIT ?`).all(col, order, limit);
      else rows = db.prepare("SELECT path, data FROM docs WHERE parent = ? ORDER BY path LIMIT ?").all(col, limit);
      return send(res, 200, { docs: rows.map(r => ({ id: r.path.split("/").pop(), data: JSON.parse(r.data) })) });
    }
    if (p === "/api/assets" && m === "POST") {
      const type = String(req.headers["content-type"] || "").split(";")[0].trim();
      if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/.test(type)) throw httpErr(415, "bad_type", "只能传图片");
      const buf = await readBody(req, 15 * 1024 * 1024);
      if (!buf.length) throw httpErr(400, "empty");
      const id = crypto.randomBytes(16).toString("hex");
      fs.writeFileSync(path.join(CFG.dataDir, "blobs", id), buf);
      db.prepare("INSERT INTO blobs (id, uid, type, size, created) VALUES (?, ?, ?, ?, ?)").run(id, user.id, type, buf.length, new Date().toISOString());
      return send(res, 200, { id, url: "/_blob/" + id, sizeBytes: buf.length, contentType: type });
    }
    const am = p.match(/^\/api\/assets\/([0-9a-f]{32})$/);
    if (am && m === "DELETE") {
      const b = db.prepare("SELECT uid FROM blobs WHERE id = ?").get(am[1]);
      if (!b || b.uid !== user.id) throw httpErr(404, "not_found");
      db.prepare("DELETE FROM blobs WHERE id = ?").run(am[1]); fs.rmSync(path.join(CFG.dataDir, "blobs", am[1]), { force: true });
      return send(res, 200, { ok: true });
    }
    if (p === "/api/ai" && m === "POST") { const b = await readJSON(req, 20e6); return send(res, 200, await aiProxy(user, b)); }
    throw httpErr(404, "not_found");
  }

  const bm = p.match(/^\/_blob\/([0-9a-f]{32})$/);
  if (bm) {
    const b = user && db.prepare("SELECT uid, type, size FROM blobs WHERE id = ?").get(bm[1]);
    if (!b || b.uid !== user.id) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": b.type, "Content-Length": b.size, "Cache-Control": "private, max-age=31536000, immutable" });
    return fs.createReadStream(path.join(CFG.dataDir, "blobs", bm[1])).pipe(res);
  }
  if (m !== "GET" && m !== "HEAD") throw httpErr(405, "method");
  return serveStatic(req, res, user);
}

/* ---------- 命令行：建账号、导入、改密码 ---------- */
// node server.js create-user <用户名>             （密码从标准输入读，避免留在 shell 历史里）
// node server.js set-password <用户名>
// node server.js import <用户名> <导出目录>        （导入 Claude 页面版导出的记录和照片）
async function readSecret(prompt){
  if (!process.stdin.isTTY) { const b = fs.readFileSync(0, "utf8"); return b.split(/\r?\n/)[0]; }
  process.stdout.write(prompt);
  return new Promise(res => { let s = ""; process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", ch => {
    ch = String(ch); if (ch === "\r" || ch === "\n") { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); res(s); }
    else if (ch === "\u0003") process.exit(1); else if (ch === "\u007f") s = s.slice(0, -1); else s += ch; }); });
}
function importDir(username, dir){
  const u = db.prepare("SELECT id FROM users WHERE username = ?").get(normName(username));
  if (!u) throw new Error("没有这个用户：" + username);
  const docsDir = path.join(dir, "docs"), blobsDir = path.join(dir, "blobs");
  let nd = 0, nb = 0, skipped = 0;
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const fp = path.join(d, f.name); if (f.isDirectory()) walk(fp); else if (f.name.endsWith(".json")) {
    const rel = path.relative(docsDir, fp).replace(/\\/g, "/").replace(/\.json$/, "");   // 例如 app/profile、days/2026-10-12
    const target = `data/users/${u.id}/app/${rel}`;
    if (getDoc(target)) { skipped++; continue; }                                         // 只补缺，不覆盖已有数据
    const raw = JSON.parse(fs.readFileSync(fp, "utf8")); putDoc(target, u.id, raw); nd++;
  } } };
  if (fs.existsSync(docsDir)) walk(docsDir);
  if (fs.existsSync(blobsDir)) for (const f of fs.readdirSync(blobsDir)) {
    const id = f.replace(/\.[a-z0-9]+$/i, ""); if (!/^[0-9a-f]{32}$/.test(id)) continue;
    if (db.prepare("SELECT 1 FROM blobs WHERE id = ?").get(id)) continue;
    const buf = fs.readFileSync(path.join(blobsDir, f)), ext = path.extname(f).slice(1).toLowerCase();
    const type = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic" }[ext] || "image/jpeg";
    fs.writeFileSync(path.join(CFG.dataDir, "blobs", id), buf);
    db.prepare("INSERT INTO blobs (id, uid, type, size, created) VALUES (?, ?, ?, ?, ?)").run(id, u.id, type, buf.length, new Date().toISOString()); nb++;
  }
  console.log(`导入完成：文档 ${nd} 条（已存在跳过 ${skipped} 条），照片 ${nb} 张`);
}

async function cli(args){
  const [cmd, a, b] = args;
  if (cmd === "create-user") { const pw = await readSecret("设置密码："); const u = createUser(a, pw, { mustChange: process.env.MUST_CHANGE === "1" }); console.log("已创建", u.username, u.id); return true; }
  if (cmd === "set-password") { const row = db.prepare("SELECT id FROM users WHERE username = ?").get(normName(a)); if (!row) throw new Error("没有这个用户"); const pw = await readSecret("新密码："); if (!validPassword(pw)) throw new Error("密码至少 8 位"); db.prepare("UPDATE users SET pass = ? WHERE id = ?").run(hashPass(pw), row.id); db.prepare("DELETE FROM sessions WHERE uid = ?").run(row.id); console.log("密码已更新"); return true; }
  if (cmd === "import") { importDir(a, path.resolve(b)); return true; }
  return false;
}

(async () => {
  const args = process.argv.slice(2);
  if (args.length) { try { if (await cli(args)) process.exit(0); } catch (e) { console.error(e.message); process.exit(1); } console.error("不认识的命令：" + args[0]); process.exit(1); }
  http.createServer((req, res) => {
    handle(req, res).catch(e => {
      const status = e.status || 500; if (status >= 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: e.code || "server_error", message: status >= 500 && !e.code ? "服务器出错" : e.message });
      else res.end();
    });
  }).listen(CFG.port, CFG.host, () => console.log(`薄肌日课已启动：http://${CFG.host}:${CFG.port}  （AI ${CFG.orKey ? "已配置 " + CFG.orModel : "未配置"}）`));
})();
