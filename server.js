#!/usr/bin/env node
// 薄肌日课 · 独立部署服务器
// Node + Better Auth；运行前 npm ci。
// 功能：账号密码登录、每人私有的数据存储（与 Claude 页面版同样的路径结构）、照片存储、AI 代理（OpenRouter，密钥只在服务器上）。
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
// The deployment bundle records only a public Git revision, never configuration.
let releaseRevision;
try {
  const value = JSON.parse(fs.readFileSync(path.join(ROOT, ".release.json"), "utf8")).revision;
  if (/^[0-9a-f]{40}$/.test(value)) releaseRevision = value;
} catch (error) { if (error.code !== "ENOENT") throw error; }
const CFG = {
  port: +(process.env.PORT || 8080),
  host: process.env.HOST || "127.0.0.1",
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, "data")),
  publicDir: path.join(ROOT, "public"),
  authBaseURL: process.env.AUTH_BASE_URL || "http://127.0.0.1:8080",
  authSecret: process.env.AUTH_SECRET || "",
  orKey: process.env.OPENROUTER_API_KEY || "",
  orBase: process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1",
  orModel: process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
  aiGlobalDaily: +(process.env.AI_GLOBAL_DAILY_LIMIT ?? 300),
  aiMaxTokens: +(process.env.AI_MAX_OUTPUT_TOKENS ?? 2000),
  aiDaily: +(process.env.AI_DAILY_LIMIT ?? 60),            // 每人每天 AI 次数上限
  cookieSecure: process.env.COOKIE_SECURE === "1",         // 走 HTTPS 时设为 1
  trustProxy: process.env.TRUST_PROXY === "1",             // 在 Caddy/Nginx 后面时设为 1，按 X-Forwarded-For 限流
};

const releaseDataAccess = require("./lib/data-access").shared(CFG.dataDir);
process.once("exit", releaseDataAccess);
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

// Authentication lives in auth.sqlite; old users/sessions are retained only for
// explicit migration, never accepted for web login.
let authentication;
const accountData = require("./lib/account-data").createAccountData(db, CFG.dataDir);
const exportingUsers = new Set();
const uploads = require("./lib/uploads").createUploads(db, CFG.dataDir, {
  userBytes: +(process.env.PHOTO_USER_BYTES ?? 262144000), totalBytes: +(process.env.PHOTO_TOTAL_BYTES ?? 5368709120), daily: +(process.env.PHOTO_DAILY_LIMIT ?? 60)
});
const normName = s => String(s || "").trim().toLowerCase();
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
const aiProxy = require("./lib/ai").createAIProxy(db, CFG);

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
  if (p.startsWith("/api/auth/")) return authentication.handle(req, res);
  const user = await authentication.sessionUser(req);
  // 改数据的请求必须带自定义头，挡掉跨站表单提交（CSRF）
  if (m !== "GET" && m !== "HEAD" && req.headers["x-bojin"] !== "1") throw httpErr(403, "csrf", "请求来源不对");

  if (p === "/api/health") return send(res, 200, { ok: true, ...(releaseRevision ? { revision: releaseRevision } : {}) });
  if (p === "/api/config" && m === "GET") return send(res, 200, { allowSignup: true, invite: true, ai: !!CFG.orKey });

  if (["/api/register", "/api/login", "/api/password", "/api/logout"].includes(p)) {
    throw httpErr(410, "auth_endpoint_retired", "请使用新的账号页面");
  }

  if (p.startsWith("/api/")) {
    if (!user) throw httpErr(401, "session_expired", "请先登录");
    accountData.ensureActive(user.id);
    if (p === "/api/account/export" && m === "GET") {
      if (exportingUsers.has(user.id)) throw httpErr(429, "export_busy", "已有导出正在进行");
      exportingUsers.add(user.id);
      try {
        res.writeHead(200, {"Content-Type":"application/x-ndjson", "Content-Disposition":'attachment; filename="lean-ritual-export.ndjson"', "Cache-Control":"no-store"});
        for await (const chunk of accountData.exportChunks(user)) {
          if (res.destroyed) break;
          if (!res.write(chunk)) await new Promise(resolve => {const done=()=>{res.off("drain",done);res.off("close",done);resolve();};res.once("drain",done);res.once("close",done);});
        }
        res.end();
      } finally { exportingUsers.delete(user.id); }
      return;
    }
    if (p === "/api/me" && m === "GET") return send(res, 200, { id: user.id, username: user.username, email: user.email, created: user.created, mustChange: !!user.mustChange, ai: !!CFG.orKey, aiModel: CFG.orModel });
    if (p === "/api/doc") {
      const dp = ownPath(url.searchParams.get("path"), user, true);
      if (m === "GET") { const d = getDoc(dp); return send(res, 200, { exists: !!d, data: d }); }
      if (m === "PUT") { const b = await readJSON(req); accountData.ensureActive(user.id); if (!b || typeof b.data !== "object" || Array.isArray(b.data)) throw httpErr(400, "bad_request"); putDoc(dp, user.id, b.data); return send(res, 200, { ok: true }); }
      if (m === "PATCH") { const b = await readJSON(req); accountData.ensureActive(user.id); const old = getDoc(dp); if (!old) throw httpErr(404, "not_found"); putDoc(dp, user.id, mergeDoc(old, b.data)); return send(res, 200, { ok: true }); }
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
      const release = uploads.begin(user.id);
      try {
        const buf = await readBody(req, 15 * 1024 * 1024);
        const normalized = await uploads.normalize(buf);
        accountData.ensureActive(user.id);
        return send(res, 200, uploads.save(user.id, normalized));
      } finally { release(); }
    }
    const am = p.match(/^\/api\/assets\/([0-9a-f]{32})$/);
    if (am && m === "DELETE") {
      const b = db.prepare("SELECT uid FROM blobs WHERE id = ?").get(am[1]);
      if (!b || b.uid !== user.id) throw httpErr(404, "not_found");
      db.prepare("DELETE FROM blobs WHERE id = ?").run(am[1]); fs.rmSync(path.join(CFG.dataDir, "blobs", am[1]), { force: true });
      return send(res, 200, { ok: true });
    }
    if (p === "/api/ai" && m === "POST") { const b = await readJSON(req, 20e6); accountData.ensureActive(user.id); return send(res, 200, await aiProxy(user, b)); }
    throw httpErr(404, "not_found");
  }

  const bm = p.match(/^\/_blob\/([0-9a-f]{32})$/);
  if (bm) {
    if (user) accountData.ensureActive(user.id);
    const b = user && db.prepare("SELECT uid, type, size FROM blobs WHERE id = ?").get(bm[1]);
    if (!b || b.uid !== user.id) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": b.type, "Content-Length": b.size, "Cache-Control": "private, no-store" });
    return fs.createReadStream(path.join(CFG.dataDir, "blobs", bm[1])).pipe(res);
  }
  if (m !== "GET" && m !== "HEAD") throw httpErr(405, "method");
  return serveStatic(req, res, user);
}

/* ---------- 命令行：旧数据导入 ---------- */
// node server.js import <用户名> <导出目录>        （导入 Claude 页面版导出的记录和照片）
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
  if (["create-user", "set-password", "invite", "revoke-invite"].includes(cmd)) throw new Error("Use scripts/auth-admin.js for invitations; use email recovery to reset passwords.");
  if (cmd === "import") { importDir(a, path.resolve(b)); return true; }
  return false;
}

(async () => {
  const { createAuth } = require("./lib/auth");
  const { createMailer } = require("./lib/mail");
  authentication = await createAuth({dataDir: CFG.dataDir, baseURL: CFG.authBaseURL, secret: CFG.authSecret,
    cookieSecure: CFG.cookieSecure, clientIP,
    onDeleteRequested: user => accountData.requestDeletion(user),
    onDeleteCompleted: user => { authentication.purgeDeletedArtifacts(user.id); accountData.completeDeletion(user.id); },
    sendEmail: createMailer(process.env, {dataDir: CFG.dataDir, baseURL: CFG.authBaseURL})});
  // Retry interrupted deletion cleanup only after auth confirms the account is gone.
  const retryDeletes = () => { for (const {uid} of accountData.pending()) {
    if (!authentication.isUserPresent(uid)) { try {authentication.purgeDeletedArtifacts(uid);accountData.completeDeletion(uid);} catch {console.error("Account deletion cleanup needs attention");} }
  }};
  retryDeletes();setInterval(retryDeletes,60000).unref();
  const args = process.argv.slice(2);
  if (args.length) { try { if (await cli(args)) process.exit(0); } catch (e) { console.error(e.message); process.exit(1); } console.error("不认识的命令：" + args[0]); process.exit(1); }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      const status = e.status || 500; if (status >= 500) console.error("request failed", e.code || "server_error");
      if (!res.headersSent) send(res, status, { error: e.code || "server_error", message: status >= 500 && !e.code ? "服务器出错" : e.message });
      else res.destroy();
    });
  }).listen(CFG.port, CFG.host, () => console.log(`薄肌日课已启动：http://${CFG.host}:${CFG.port}  （AI ${CFG.orKey ? "已配置 " + CFG.orModel : "未配置"}）`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
    server.close(() => { authentication.close(); db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
  });
})().catch(e => { console.error("Startup failed:", e.message); process.exitCode = 1; });
