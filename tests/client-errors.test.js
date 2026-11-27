"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const clientScript = fs.readFileSync(path.join(ROOT, "public/client-errors.js"), "utf8");
const serverErrors = require(path.join(ROOT, "lib/client-errors.js"));

function loadClientModule({ fetchImpl = async () => ({ ok: true, json: async () => ({}) }), ua = "", pathname = "/", origin, lang = "zh-CN", storageMap = null } = {}) {
  const listeners = new Map();
  const storage = storageMap ? {
    getItem: k => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v))
  } : null;
  const win = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    }
  };
  const loc = { protocol: "https:", pathname, search: "?invite=SECRET_TOKEN&email=a@b.com", hash: "#frag" };
  if (origin !== undefined) loc.origin = origin;
  const ctx = vm.createContext({
    window: win,
    globalThis: {},
    fetch: fetchImpl,
    sessionStorage: storage,
    navigator: { userAgent: ua },
    location: loc,
    document: { documentElement: { lang } },
    Date,
    Promise,
    Set,
    Number,
    Math,
    String,
    Object,
    Array,
    JSON,
    RegExp
  });
  ctx.globalThis = ctx;
  vm.runInContext(clientScript, ctx);
  return { api: win.ritualErrorReporter, listeners, storageMap };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function loadPlaywright() {
  const candidates = ["playwright"];
  const home = os.homedir();
  for (const rel of [
    ".claude/skills/gstack/node_modules/playwright",
    ".agents/skills/gstack/node_modules/playwright"
  ]) {
    const p = path.join(home, rel);
    if (fs.existsSync(p)) candidates.push(p);
  }
  const npxDir = path.join(home, ".npm", "_npx");
  if (fs.existsSync(npxDir)) {
    for (const entry of fs.readdirSync(npxDir)) {
      const p = path.join(npxDir, entry, "node_modules", "playwright");
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  for (const cand of candidates) {
    try {
      const pw = require(cand);
      const execPath = process.env.CHROMIUM_PATH
        || (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : pw.chromium.executablePath());
      if (execPath && fs.existsSync(execPath)) {
        return { chromium: pw.chromium, executablePath: execPath };
      }
    } catch {}
  }
  return null;
}

test("client and server use fixed diagnostic messages without copying exception text", () => {
  const { api } = loadClientModule();
  for (const scrub of [api.scrubMessage, serverErrors.scrubMessage]) {
    for (const input of [
      "alice@example.com Bearer secret12345678 13812345678 /login.html?invite=demo",
      "record: weight 71.5, chicken breast, user alice, password: red blue",
      "at field (https://example.com/sensitive.js:1:2)\n" + "long ".repeat(500)
    ]) assert.equal(scrub(input), "Error details withheld");
    assert.equal(scrub("Cannot read properties of undefined (reading 'private-form-value')"),
      "Cannot read properties of null or undefined");
    assert.equal(scrub("ERR_HTTP2_PROTOCOL_ERROR"), "ERR_HTTP2_PROTOCOL_ERROR");
  }
});

test("client formatSource and parseUA keep only basename+line:col and browser family+OS major", () => {
  const { api } = loadClientModule();
  const { formatSource, parseUA } = api;

  assert.equal(
    formatSource("https://leanritual.app/shim.js?v=abcdef1234567890&token=SECRET", 42, 9, ""),
    "shim.js:42:9"
  );
  assert.equal(
    formatSource("https://leanritual.app/?lang=en&invite=SECRET", 1895, 12, ""),
    "index.html:1895:12"
  );
  assert.equal(
    formatSource("", 0, 0, "TypeError: boom\n    at loadAll (https://leanritual.app/index.html?token=SECRET:1519:46)\n    at secretFn"),
    "index.html:1519:46"
  );
  assert.equal(
    formatSource("", 0, 0, "render@https://leanritual.app/:1895:12\nboot@https://leanritual.app/:3980:3"),
    "index.html:1895:12"
  );
  assert.equal(formatSource("", 0, 0, ""), "unknown");

  assert.equal(parseUA("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"), "Safari/iOS18");
  assert.equal(parseUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49"), "WeChat/iOS17");
  assert.equal(parseUA("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"), "WebKit/iOS18");
  assert.equal(parseUA("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"), "Chrome/Android14");
  assert.equal(parseUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"), "Edge/Win10");
  assert.equal(parseUA("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"), "Firefox/Linux");
  assert.equal(parseUA(""), "Other/Other");
});

test("client reporter captures errors, dedupes per page-load, caps at 10 per session, and sends only allowlisted fields", async () => {
  const sent = [];
  const storageMap = new Map();
  const revisionSha = "0123456789abcdef0123456789abcdef01234567";
  const fetchImpl = async (url, opts) => {
    if (url === "/api/health") return { ok: true, json: async () => ({ ok: true, revision: revisionSha }) };
    sent.push({ url, opts, body: JSON.parse(opts.body) });
    return { ok: true, status: 204 };
  };
  const { api, listeners } = loadClientModule({
    fetchImpl,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    pathname: "/",
    lang: "zh-CN",
    storageMap
  });
  await new Promise(r => setImmediate(r));
  api.configure({ getPage: () => "food", getLang: () => "zh" });

  // Fire window 'error' twice with identical error -> deduped to 1
  const errListener = listeners.get("error")[0];
  const sampleErr = new TypeError("Bad email alice@example.com on https://leanritual.app/food?secret=12345678");
  errListener({ error: sampleErr, message: sampleErr.message, filename: "https://leanritual.app/index.html?invite=SECRET", lineno: 2450, colno: 11 });
  errListener({ error: sampleErr, message: sampleErr.message, filename: "https://leanritual.app/index.html?invite=SECRET", lineno: 2450, colno: 11 });
  assert.equal(sent.length, 1);

  const req = sent[0];
  assert.equal(req.url, "/api/client-error");
  assert.equal(req.opts.method, "POST");
  assert.equal(req.opts.keepalive, true);
  assert.equal(req.opts.credentials, "same-origin");
  assert.equal(req.opts.referrerPolicy, "no-referrer");
  assert.equal(req.opts.headers["X-Bojin"], "1");
  assert.equal(req.opts.headers["Content-Type"], "application/json");
  assert.deepEqual(Object.keys(req.body).sort(), ["lang", "message", "name", "page", "revision", "source", "ts", "ua"]);
  assert.equal(req.body.name, "TypeError");
  assert.equal(req.body.source, "index.html:2450:11");
  assert.equal(req.body.revision, "0123456789ab");
  assert.equal(req.body.page, "food");
  assert.equal(req.body.lang, "zh");
  assert.equal(req.body.ua, "Safari/iOS18");
  assert.doesNotMatch(req.body.message, /alice@example\.com|secret=|12345678/);

  // Fire unhandledrejection: benign abort/cancelled ignored; real rejection sent
  const rejListener = listeners.get("unhandledrejection")[0];
  rejListener({ reason: { code: "cancelled" } });
  rejListener({ reason: { code: "session_expired" } });
  assert.equal(sent.length, 1);
  const rejErr = new RangeError("Invalid count 13812345678");
  rejErr.stack = "RangeError: Invalid count\n    at save (https://leanritual.app/shim.js?v=abc:99:4)";
  rejListener({ reason: rejErr });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.name, "RangeError");
  assert.equal(sent[1].body.source, "shim.js:99:4");
  assert.doesNotMatch(sent[1].body.message, /13812345678/);

  // Fill up to 10 total unique reports; 11th+ must be dropped
  for (let i = 0; i < 15; i++) {
    api.report({ name: "Error", message: `unique failure #${i}`, source: `index.html:${100 + i}:1` });
  }
  assert.equal(sent.length, 10);
  assert.equal(storageMap.get("bj-err-count"), "10");

  // Reloading the page in the same session (reusing sessionStorage) still enforces the 10-report session cap
  const reload = loadClientModule({ fetchImpl, storageMap });
  assert.equal(reload.api.report({ name: "Error", message: "after reload error", source: "index.html:1:1" }), false);
  assert.equal(sent.length, 10);

  // When sessionStorage throws (Safari private mode), in-memory cap still stops at 10
  const throwingSent = [];
  const priv = api.createReporter({
    fetch: async (_u, o) => { throwingSent.push(o); return { ok: true }; },
    sessionStorage: {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); }
    },
    location: { pathname: "/login.html" },
    navigator: { userAgent: "" },
    document: { documentElement: { lang: "en" } }
  });
  for (let i = 0; i < 12; i++) {
    priv.report({ name: "Error", message: `private err ${i}`, source: `login.html:${i + 1}:1` });
  }
  assert.equal(throwingSent.length, 10);
});

test("server lib/client-errors unit: ignores unknown fields, sanitizes control chars, enforces per-user, per-IP and anon limits", async () => {
  let fakeNow = 1_700_000_000_000;
  const logs = [];
  const handler = serverErrors.createClientErrors({
    expectedOrigin: "https://leanritual.app",
    releaseRevision: "abcdef1234567890abcdef1234567890abcdef12",
    userLimit: 2,
    ipLimit: 3,
    anonIpLimit: 1,
    globalLimit: 4,
    windowMs: 60_000,
    log: line => logs.push(line),
    now: () => fakeNow
  });

  const invoke = async ({ headers = {}, body, user = null, ip = "203.0.113.10", method = "POST" }) => {
    const raw = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    let status = null, resHeaders = null, ended = false;
    const res = {
      writeHead(s, h) { status = s; resHeaders = h; },
      end() { ended = true; }
    };
    const req = {
      method,
      headers: {
        "x-bojin": "1",
        origin: "https://leanritual.app",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json; charset=utf-8",
        ...headers
      }
    };
    await handler.handle(req, res, {
      getUser: async () => user,
      ip,
      readBody: async (_r, max) => {
        if (raw.length > max) throw Object.assign(new Error("too large"), { status: 413, code: "too_large" });
        return raw;
      }
    });
    return { status, resHeaders, ended };
  };

  // Planted secrets in unknown extra fields + raw UA + control chars in message/name
  const res1 = await invoke({
    user: { id: "u_secret_user_id_999" },
    body: {
      name: "TypeError\nINJECTED_LINE",
      message: "Boom\r\nfor secret@example.com with token=PLANTED_MSG_TOKEN_123",
      source: "index.html:10:2",
      revision: "unknown",
      page: "today",
      lang: "zh",
      ua: "Mozilla/5.0 (Full Raw UA Should Be Dropped)",
      ts: "2026-11-19T12:00:00.000Z",
      secretExtra: "PLANTED_EXTRA_SECRET_MARKER",
      userId: "u_secret_user_id_999",
      email: "planted-email@example.com",
      recordData: { weight: 71.5, meal: "chicken breast" },
      stack: "at secretFrame (planted_stack_marker)"
    }
  });
  assert.equal(res1.status, 204);
  assert.equal(logs.length, 1);
  const line = logs[0];
  assert.ok(line.startsWith("client-error "));
  assert.doesNotMatch(line, /[\x00-\x1f\x7f\u2028\u2029]/);
  for (const forbidden of [
    "PLANTED_EXTRA_SECRET_MARKER",
    "u_secret_user_id_999",
    "planted-email@example.com",
    "chicken breast",
    "planted_stack_marker",
    "secret@example.com",
    "PLANTED_MSG_TOKEN_123",
    "Full Raw UA"
  ]) {
    assert.ok(!line.includes(forbidden), `log line leaked forbidden marker ${forbidden}: ${line}`);
  }
  assert.equal(serverErrors.validateReport({
    page: "login", name: "PrivateValue", message: "PrivateValue", source: "index.html\n", ua: "Safari/iOS18\n"
  }, { isAuthenticated: false }).source, "unknown");
  assert.match(line, /auth=user page=today lang=zh rev=abcdef123456 ua=Other\/Other source=index\.html:10:2 name=Error/);

  // Per-user limit (2) -> 2nd accepted, 3rd silently dropped with 204
  assert.equal((await invoke({ user: { id: "u_secret_user_id_999" }, body: { name: "Error", message: "second", page: "today" } })).status, 204);
  assert.equal(logs.length, 2);
  assert.equal((await invoke({ user: { id: "u_secret_user_id_999" }, body: { name: "Error", message: "third", page: "today" } })).status, 204);
  assert.equal(logs.length, 2);

  // Per-IP limit (3 across users on same IP) -> another user gets 1 more (total 3), then 4th silently dropped
  assert.equal((await invoke({ user: { id: "u_other" }, body: { name: "Error", message: "other user", page: "me" } })).status, 204);
  assert.equal(logs.length, 3);
  assert.equal((await invoke({ user: { id: "u_third" }, body: { name: "Error", message: "hits ip cap", page: "me" } })).status, 204);
  assert.equal(logs.length, 3);

  // Anonymous stricter limit (1 on fresh IP) -> 1st logged, 2nd silently dropped
  assert.equal((await invoke({ ip: "203.0.113.55", body: { name: "Error", message: "login boom", page: "login" } })).status, 204);
  assert.equal(logs.length, 4);
  assert.match(logs[3], /^client-error auth=anon page=login /);
  assert.equal((await invoke({ ip: "203.0.113.55", body: { name: "Error", message: "login boom 2", page: "login" } })).status, 204);
  assert.equal(logs.length, 4);

  for (const ip of ["203.0.113.56", "203.0.113.57"]) {
    assert.equal((await invoke({ ip, body: { name: "Error", message: "fresh IP", page: "login" } })).status, 204);
  }
  assert.equal(logs.length, 4, "new IPs share the process-wide log limit");

  // After window expires, limit resets cleanly
  fakeNow += 61_000;
  assert.equal((await invoke({ ip: "203.0.113.55", body: { name: "Error", message: "after window", page: "login" } })).status, 204);
  assert.equal(logs.length, 5);
});

test("HTTP integration: /api/client-error auth, CSRF, size cap, rate limits, sanitized journal log, and no DB writes", { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-cerr-"));
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dir,
    PORT: String(port),
    HOST: "127.0.0.1",
    AUTH_BASE_URL: base,
    AUTH_SECRET: crypto.randomBytes(32).toString("hex"),
    COOKIE_SECURE: "0",
    TRUST_PROXY: "0",
    MAIL_MODE: "file",
    OPENROUTER_API_KEY: ""
  };
  const issue = email => {
    const r = spawnSync(process.execPath, ["scripts/auth-admin.js", "invite", email], { cwd: ROOT, env, encoding: "utf8", timeout: 5000 });
    if (r.error) throw r.error;
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const inv = issue("tester@example.com");
  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d.toString(); });
  child.stderr.on("data", d => { stderr += d.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      const done = new Promise(r => child.once("exit", r));
      child.kill();
      await done;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup timeout " + stderr)), 8000);
    child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
  });

  const postErr = (body, headers = {}) => fetch(base + "/api/client-error", {
    method: "POST",
    headers: {
      origin: base,
      "Content-Type": "application/json",
      "X-Bojin": "1",
      ...headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

  // Method, CSRF, Origin, Sec-Fetch-Site, Referer, Content-Type, Size cap, JSON validation
  assert.equal((await fetch(base + "/api/client-error")).status, 405);
  assert.equal((await fetch(base + "/api/client-error", { method: "POST", headers: { origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Error", message: "no csrf", page: "login" }) })).status, 403);
  assert.equal((await postErr({ name: "Error", message: "bad origin", page: "login" }, { origin: "https://evil.invalid" })).status, 403);
  assert.equal((await postErr({ name: "Error", message: "cross site", page: "login" }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await postErr({ name: "Error", message: "bad ref", page: "login" }, { referer: base + "/privacy.html" })).status, 403);
  assert.equal((await postErr({ name: "Error", message: "bad type", page: "login" }, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await postErr("{not json")).status, 400);
  assert.equal((await postErr({ name: "Error", message: "x".repeat(2100), page: "login" })).status, 413);
  assert.equal((await postErr({ name: 123, message: "bad name type", page: "login" })).status, 400);

  // Anonymous rejected for non-login page (401), accepted for login page (204) up to anon limit (5/hr)
  assert.equal((await postErr({ name: "Error", message: "anon app err", page: "today" })).status, 401);
  for (let i = 0; i < 6; i++) {
    const r = await postErr({
      name: "TypeError",
      message: `login fail ${i}`,
      source: "login.html:12:3",
      page: "login",
      lang: "en",
      ua: "Safari/iOS18",
      ts: "2026-11-19T12:00:00.000Z"
    }, { referer: base + "/login.html" });
    assert.equal(r.status, 204);
  }
  await new Promise(r => setTimeout(r, 50));
  const anonLines = stdout.split("\n").filter(l => l.startsWith("client-error auth=anon "));
  assert.equal(anonLines.length, 5, "anonymous login reports must cap at 5/hr and drop 6th silently");

  // Register + sign in an authenticated user
  const password = "strong test password 123";
  const reg = await fetch(base + "/api/auth/sign-up/email", {
    method: "POST",
    headers: { origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ email: inv.email, name: "Tester", password, invitation: inv.token, callbackURL: "/login.html", consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-25" })
  });
  assert.equal(reg.status, 200);
  const mail = fs.readdirSync(path.join(dir, "mail")).map(f => JSON.parse(fs.readFileSync(path.join(dir, "mail", f), "utf8"))).find(m => m.kind === "verify");
  assert.equal((await fetch(mail.url, { redirect: "manual" })).status, 302);
  const login = await fetch(base + "/api/auth/sign-in/email", {
    method: "POST",
    headers: { origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ email: inv.email, password })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");

  const authDb = new DatabaseSync(path.join(dir, "auth.sqlite"));
  t.after(() => authDb.close());
  const agedUpdate = Date.now() - 2 * 86400_000;
  authDb.prepare('UPDATE session SET updatedAt = ?, expiresAt = ?').run(agedUpdate, Date.now() + 5 * 86400_000);

  // Authenticated report with planted secrets in body extras + newlines
  const authRes = await postErr({
    name: "ReferenceError",
    message: "Cannot render\nfor tester@example.com with sk-or-v1-1234567890abcdef1234567890abcdef",
    source: "index.html:1900:5",
    revision: "a1b2c3d4e5f6",
    page: "today",
    lang: "zh",
    ua: "WeChat/iOS18",
    ts: "2026-11-19T12:01:00.000Z",
    plantedSecret: "DO_NOT_LOG_THIS_SECRET_42",
    formValues: { weight: 68.5, note: "PRIVATE_NOTE_TEXT" }
  }, { cookie });
  assert.equal(authRes.status, 204);

  // Hit per-user limit (20/hr): send 20 more (total 21) -> only 20 logged
  for (let i = 1; i <= 20; i++) {
    const r = await postErr({
      name: "Error",
      message: `auth err ${i}`,
      source: "index.html:100:1",
      page: "food",
      lang: "zh",
      ua: "Safari/iOS18"
    }, { cookie });
    assert.equal(r.status, 204);
  }
  await new Promise(r => setTimeout(r, 50));

  const userLines = stdout.split("\n").filter(l => l.startsWith("client-error auth=user "));
  assert.equal(userLines.length, 20, "authenticated user reports must cap at 20/hr and drop 21st silently");
  const firstUserLine = userLines[0];
  assert.match(firstUserLine, /page=today lang=zh rev=a1b2c3d4e5f6 ua=WeChat\/iOS18 source=index\.html:1900:5 name=ReferenceError/);
  assert.doesNotMatch(firstUserLine, /DO_NOT_LOG_THIS_SECRET_42|PRIVATE_NOTE_TEXT|tester@example\.com|sk-or-v1|[\x00-\x1f\x7f]/);

  assert.equal(authDb.prepare('SELECT updatedAt FROM session').get().updatedAt, agedUpdate,
    "telemetry must not refresh an aging authenticated session");
  authDb.prepare('UPDATE session SET expiresAt = ?').run(Date.now() - 1000);
  assert.equal((await postErr({ name: "Error", message: "expired", page: "today" }, { cookie })).status, 401);
  assert.equal(authDb.prepare('SELECT COUNT(*) n FROM session').get().n, 1,
    "telemetry must not delete an expired session");

  // Confirm no error reports are stored in bojin.db
  const inspect = new DatabaseSync(path.join(dir, "bojin.db"));
  const tables = inspect.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.equal(tables.some(n => /error/i.test(n)), false);
  assert.equal(inspect.prepare("SELECT COUNT(*) n FROM docs").get().n, 0);
  inspect.close();
});

test("privacy.html and docs/OPERATIONS.md document client error reporting accurately", () => {
  const privacy = fs.readFileSync(path.join(ROOT, "public/privacy.html"), "utf8");
  const zh = privacy.match(/<article id="doc-zh">([\s\S]*?)<\/article>/)[1];
  const en = privacy.match(/<article id="doc-en" hidden>([\s\S]*?)<\/article>/)[1];
  assert.match(zh, /最小化的错误报告/);
  assert.match(zh, /错误类型/);
  assert.match(zh, /代码位置/);
  assert.match(zh, /应用版本/);
  assert.match(zh, /浏览器与系统大类/);
  assert.match(zh, /不含个人数据/);
  assert.match(zh, /journald/);

  assert.match(en, /minimal error reports/i);
  assert.match(en, /error type/i);
  assert.match(en, /location in code/i);
  assert.match(en, /app version/i);
  assert.match(en, /browser\/OS family/i);
  assert.match(en, /without personal data/i);
  assert.match(en, /server logs only/i);
  assert.match(en, /journald/i);

  const ops = fs.readFileSync(path.join(ROOT, "docs/OPERATIONS.md"), "utf8");
  assert.ok(ops.includes("journalctl -u bojin.service --since -24h -o cat | grep '^client-error '"));
});

test("headless Chromium: client error reporting on login and app pages with zero CSP violations", { timeout: 60000 }, async t => {
  const pw = loadPlaywright();
  if (!pw) {
    t.skip("Playwright/Chromium not installed locally");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-cerr-pw-"));
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dir,
    PORT: String(port),
    HOST: "127.0.0.1",
    AUTH_BASE_URL: base,
    AUTH_SECRET: crypto.randomBytes(32).toString("hex"),
    COOKIE_SECURE: "0",
    TRUST_PROXY: "0",
    MAIL_MODE: "file",
    OPENROUTER_API_KEY: ""
  };
  const inv = JSON.parse(spawnSync(process.execPath, ["scripts/auth-admin.js", "invite", "pw-err@example.com"], {
    cwd: ROOT, env, encoding: "utf8", timeout: 5000
  }).stdout);
  const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  server.stdout.on("data", d => { stdout += d.toString(); });
  server.stderr.on("data", d => { stderr += d.toString(); });
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      const done = new Promise(r => server.once("exit", r));
      server.kill();
      await done;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup timeout " + stderr)), 8000);
    server.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    server.once("error", reject);
    server.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
  });

  // Verify user account via API so we can sign in cleanly
  const password = "browser test password 123";
  assert.equal((await fetch(base + "/api/auth/sign-up/email", {
    method: "POST",
    headers: { origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ email: inv.email, name: "PW", password, invitation: inv.token, callbackURL: "/login.html", consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-25" })
  })).status, 200);
  const mail = fs.readdirSync(path.join(dir, "mail")).map(f => JSON.parse(fs.readFileSync(path.join(dir, "mail", f), "utf8"))).find(m => m.kind === "verify");
  assert.equal((await fetch(mail.url, { redirect: "manual" })).status, 302);

  browser = await pw.chromium.launch({ executablePath: pw.executablePath, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const page = await context.newPage();
  const cspViolations = [];
  await page.exposeFunction("recordCspViolation", v => cspViolations.push(v));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", e => window.recordCspViolation(e.violatedDirective + ": " + e.blockedURI)));

  // 1. Login page: trigger a runtime error and check the request referrer
  await page.goto(`${base}/login.html?invite=SECRET_URL_INVITE`);
  await page.waitForFunction(() => !!window.ritualErrorReporter);
  const loginPostP = page.waitForResponse(r => new URL(r.url()).pathname === "/api/client-error" && r.status() === 204);
  await page.evaluate(() => { setTimeout(() => { throw new TypeError("Login boom for leak@example.com token=secret12345678"); }, 0); });
  assert.equal((await (await loginPostP).request().allHeaders()).referer, undefined);

  // 2. Sign in and trigger a runtime error on the authenticated app
  await page.locator('#tabs button[data-m="login"]').click();
  await page.locator("#e").fill(inv.email);
  await page.locator("#p").fill(password);
  await page.locator("#go").click();
  await page.locator("#setup").waitFor();
  await page.waitForFunction(() => !!window.ritualErrorReporter);

  const appPostP = page.waitForResponse(r => new URL(r.url()).pathname === "/api/client-error" && r.status() === 204);
  await page.evaluate(() => { setTimeout(() => { throw new RangeError("App boom 13812345678"); }, 0); });
  await appPostP;

  // 3. Dispatch filtered browser noise (Script error. + ResizeObserver loop) and verify separate filtered logging
  const scriptNoiseP = page.waitForResponse(r => new URL(r.url()).pathname === "/api/client-error" && r.status() === 204);
  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error.", filename: "", lineno: 0, colno: 0, error: null }));
  });
  await scriptNoiseP;

  const roNoiseP = page.waitForResponse(r => new URL(r.url()).pathname === "/api/client-error" && r.status() === 204);
  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications.", filename: "", lineno: 0, colno: 0, error: null }));
  });
  await roNoiseP;

  await page.waitForTimeout(100);
  const lines = stdout.split("\n").filter(l => l.startsWith("client-error "));
  const filteredLines = stdout.split("\n").filter(l => l.startsWith("client-error-filtered "));
  assert.equal(lines.length, 2, `filtered noise must not log as client-error: ${lines.join("\n")}`);
  assert.ok(lines.some(l => l.includes("auth=anon page=login ") && l.includes("name=TypeError") && !l.includes("leak@example.com") && !l.includes("secret12345678") && !l.includes("SECRET_URL_INVITE")), `expected scrubbed anon log in: ${lines.join("\n")}`);
  assert.ok(lines.some(l => l.includes("auth=user page=setup ") && l.includes("name=RangeError") && !l.includes("13812345678")), `expected scrubbed auth log in: ${lines.join("\n")}`);
  assert.ok(filteredLines.some(l => l.includes("auth=user page=setup ") && l.includes("reason=script_error")), `expected script_error filtered log in: ${filteredLines.join("\n")}`);
  assert.ok(filteredLines.some(l => l.includes("auth=user page=setup ") && l.includes("reason=resize_observer")), `expected resize_observer filtered log in: ${filteredLines.join("\n")}`);
  assert.deepEqual(cspViolations, [], `expected zero CSP violations, got: ${cspViolations.join("; ")}`);
});

test("every HTML page and script loaded or shipped under public/ is recognised by client-errors SOURCE_RE", () => {
  const { api } = loadClientModule();
  const publicDir = path.join(ROOT, "public");

  function walkFiles(dir) {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...walkFiles(full));
      else out.push(full);
    }
    return out;
  }

  const allPublicFiles = walkFiles(publicDir);
  const htmlFiles = allPublicFiles.filter(f => f.endsWith(".html"));
  // Always check app/index.html too in case public/index.html was not yet built.
  const pageSources = new Set(["index.html"]);
  const loadedScriptBasenames = new Set(["client-errors.js", "shim.js", "heic2any.min.js", "heic2any-worker.js"]);

  for (const file of [...htmlFiles, path.join(ROOT, "app/index.html")]) {
    const base = path.basename(file);
    pageSources.add(base);
    const html = fs.readFileSync(file, "utf8");
    for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      const raw = m[1].replace(/[?#][\s\S]*$/, "");
      if (/^https?:\/\//i.test(raw)) continue;
      loadedScriptBasenames.add(path.basename(raw));
    }
  }

  for (const file of allPublicFiles) {
    if (file.endsWith(".js")) loadedScriptBasenames.add(path.basename(file));
  }

  // PR #57 scripts must be explicitly present in the checked set
  for (const expected of ["login.js", "phone-rules.js", "privacy.js", "terms.js", "guide.js", "boot.js", "nocturne.js"]) {
    assert.ok(loadedScriptBasenames.has(expected), `expected ${expected} to be discovered in public/`);
  }

  for (const name of [...pageSources, ...loadedScriptBasenames]) {
    const formatted = api.formatSource(`https://leanritual.app/site/${name}?v=123`, 42, 7, "");
    assert.equal(formatted, `${name}:42:7`, `client-errors.js SOURCE_RE does not recognise ${name}`);
    const validated = serverErrors.validateReport(
      { name: "Error", message: "boom", source: `${name}:42:7`, page: "today" },
      { isAuthenticated: true }
    );
    assert.equal(validated.source, `${name}:42:7`, `lib/client-errors.js did not accept source ${name}`);
  }
});

test("client reporter filters cross-origin Script error., extension/non-origin URLs, and ResizeObserver loop events into separate filtered tally", async () => {
  const sent = [];
  const storageMap = new Map();
  const fetchImpl = async (url, opts) => {
    if (url === "/api/health") return { ok: true, json: async () => ({ ok: true, revision: "1e51b8e456ad" }) };
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 204 };
  };
  const { api, listeners } = loadClientModule({
    fetchImpl,
    ua: "Mozilla/5.0 (Linux; Android 16; Model) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36",
    pathname: "/login.html",
    origin: "https://leanritual.app",
    lang: "zh-CN",
    storageMap
  });
  await new Promise(r => setImmediate(r));
  const onError = listeners.get("error")[0];

  // 1. Cross-origin muted "Script error." -> filtered as script_error (deduped on repeat)
  onError({ message: "Script error.", filename: "", lineno: 0, colno: 0, error: null });
  onError({ message: "Script error.", filename: "", lineno: 0, colno: 0, error: null });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].filtered, "script_error");
  assert.equal(sent[0].source, "unknown");

  // 2. Extension & non-origin script URLs -> filtered as non_origin (deduped per reason on same page-load)
  onError({ message: "ext boom", filename: "chrome-extension://abcdef/content.js", lineno: 10, colno: 2, error: new Error("ext boom") });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].filtered, "non_origin");
  assert.equal(sent[1].source, "unknown");

  // Additional non-origin variants are classified as non_origin too
  assert.equal(api.classifyWindowError({ message: "x", filename: "safari-web-extension://1234/inject.js", lineno: 1, colno: 1, error: new Error("x") }, "https://leanritual.app"), "non_origin");
  assert.equal(api.classifyWindowError({ message: "x", filename: "webkit-masked-url://hidden/", lineno: 0, colno: 0, error: null }, "https://leanritual.app"), "non_origin");
  assert.equal(api.classifyWindowError({ message: "x", filename: "https://other-host.example/inject.js", lineno: 5, colno: 1, error: new Error("x") }, "https://leanritual.app"), "non_origin");

  // 3. Benign ResizeObserver loop events -> filtered as resize_observer even with same-origin filename
  onError({ message: "ResizeObserver loop completed with undelivered notifications.", filename: "https://leanritual.app/", lineno: 0, colno: 0, error: null });
  assert.equal(sent.length, 3);
  assert.equal(sent[2].filtered, "resize_observer");
  assert.equal(api.classifyWindowError({ message: "ResizeObserver loop limit exceeded", filename: "", lineno: 0, colno: 0, error: null }, "https://leanritual.app"), "resize_observer");
  assert.equal(api.getFilteredCount(), 3);
  assert.equal(storageMap.get("bj-err-filtered-count"), "3");

  // 4. Unhandled rejection purely from an extension/non-origin stack -> filtered, not real error
  const extRej = new Error("ext async fail");
  extRej.stack = "Error: ext async fail\n    at fn (moz-extension://xyz/bg.js:12:3)";
  const freshSent = [];
  const fresh = api.createReporter({
    fetch: async (_u, o) => { freshSent.push(JSON.parse(o.body)); return { ok: true }; },
    location: { protocol: "https:", origin: "https://leanritual.app", pathname: "/" },
    navigator: { userAgent: "" },
    document: { documentElement: { lang: "zh" } },
    sessionStorage: null
  });
  fresh.handleRejection({ reason: extRej });
  assert.equal(freshSent.length, 1);
  assert.equal(freshSent[0].filtered, "non_origin");

  // Mixed stack (app + extension) MUST NOT be filtered
  const mixedRej = new TypeError("Cannot read properties of undefined (reading 'x')");
  mixedRej.stack = "TypeError: ...\n    at appFn (https://leanritual.app/site/login.js:44:9)\n    at extWrap (chrome-extension://xyz/hook.js:1:1)";
  fresh.handleRejection({ reason: mixedRej });
  assert.equal(freshSent.length, 2);
  assert.equal(freshSent[1].filtered, undefined);
  assert.equal(freshSent[1].source, "login.js:44:9");

  // 5. Real same-origin errors (including login.js and phone-rules.js, and same-origin message "Script error.") are NOT filtered
  onError({ message: "Script error.", filename: "https://leanritual.app/site/login.js", lineno: 88, colno: 4, error: new Error("Script error.") });
  onError({ message: "bad phone", filename: "https://leanritual.app/site/phone-rules.js", lineno: 365, colno: 5, error: new TypeError("bad phone") });
  assert.equal(sent.length, 5);
  assert.equal(sent[3].filtered, undefined);
  assert.equal(sent[3].source, "login.js:88:4");
  assert.equal(sent[4].filtered, undefined);
  assert.equal(sent[4].source, "phone-rules.js:365:5");

  // 6. Filtered counter does not consume real error session budget (all 10 real errors can still be sent)
  const capSent = [];
  const capStorage = new Map();
  const capped = api.createReporter({
    fetch: async (_u, o) => { capSent.push(JSON.parse(o.body)); return { ok: true }; },
    location: { protocol: "https:", origin: "https://leanritual.app", pathname: "/" },
    navigator: { userAgent: "" },
    document: { documentElement: { lang: "zh" } },
    sessionStorage: { getItem: k => capStorage.get(k) ?? null, setItem: (k, v) => capStorage.set(k, String(v)) },
    maxPerSession: 2
  });
  capped.reportFiltered("script_error");
  capped.reportFiltered("non_origin");
  capped.reportFiltered("resize_observer"); // hits filtered cap of 2
  assert.equal(capSent.filter(p => p.filtered).length, 2);
  assert.equal(capped.report({ name: "Error", message: "real 1", source: "index.html:1:1" }), true);
  assert.equal(capped.report({ name: "Error", message: "real 2", source: "index.html:2:1" }), true);
  assert.equal(capped.report({ name: "Error", message: "real 3", source: "index.html:3:1" }), false);
  assert.equal(capSent.filter(p => !p.filtered).length, 2);
});

test("server lib/client-errors logs filtered noise separately under client-error-filtered with independent rate limits", async () => {
  const logs = [];
  const handler = serverErrors.createClientErrors({
    expectedOrigin: "https://leanritual.app",
    releaseRevision: "1e51b8e456adad3d3578300507aeac723056f6ae",
    userLimit: 2,
    ipLimit: 2,
    anonIpLimit: 1,
    globalLimit: 2,
    windowMs: 60_000,
    log: line => logs.push(line)
  });

  const invoke = async ({ body, user = { id: "u1" }, ip = "203.0.113.20" }) => {
    const raw = Buffer.from(JSON.stringify(body));
    let status = null;
    const res = { writeHead(s) { status = s; }, end() {} };
    const req = {
      method: "POST",
      headers: {
        "x-bojin": "1",
        origin: "https://leanritual.app",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json"
      }
    };
    await handler.handle(req, res, {
      getUser: async () => user,
      ip,
      readBody: async () => raw
    });
    return status;
  };

  // Invalid filtered reasons are rejected with 400
  await assert.rejects(
    () => invoke({ body: { page: "today", filtered: "arbitrary_secret_reason" } }),
    err => err.status === 400
  );
  await assert.rejects(
    () => invoke({ body: { page: "today", filtered: "script_error\n" } }),
    err => err.status === 400
  );
  await assert.rejects(
    () => invoke({ body: { page: "today", filtered: 123 } }),
    err => err.status === 400
  );

  // Valid filtered noise logs as client-error-filtered with no secrets/source/msg and respects its own limit (2)
  assert.equal(await invoke({
    body: {
      page: "today",
      lang: "zh",
      ua: "Chrome/Android16",
      filtered: "script_error",
      source: "index.html:1:1",
      message: "SECRET_SHOULD_NOT_APPEAR",
      ts: "2026-11-27T01:55:40.335Z"
    }
  }), 204);
  assert.equal(await invoke({
    body: { page: "me", lang: "zh", ua: "Chrome/Android16", filtered: "non_origin", ts: "2026-11-27T01:55:40.386Z" }
  }), 204);
  assert.equal(await invoke({
    body: { page: "login", lang: "zh", ua: "Chrome/Android16", filtered: "resize_observer", ts: "2026-11-27T01:55:40.402Z" }
  }), 204); // dropped silently by filtered cap of 2

  const filteredLogs = logs.filter(l => l.startsWith("client-error-filtered "));
  assert.equal(filteredLogs.length, 2);
  assert.equal(logs.filter(l => l.startsWith("client-error ")).length, 0);
  assert.equal(
    filteredLogs[0],
    "client-error-filtered auth=user page=today lang=zh rev=1e51b8e456ad ua=Chrome/Android16 reason=script_error ts=2026-11-27T01:55:40.335Z"
  );
  assert.ok(!filteredLogs[0].includes("SECRET_SHOULD_NOT_APPEAR"));

  // Exhausting filtered rate limit must NOT starve real app error reports
  assert.equal(await invoke({
    body: { page: "login", lang: "zh", ua: "Chrome/Android16", name: "TypeError", message: "Cannot read properties of null", source: "login.js:42:9" }
  }), 204);
  const realLogs = logs.filter(l => l.startsWith("client-error "));
  assert.equal(realLogs.length, 1);
  assert.match(realLogs[0], /source=login\.js:42:9 name=TypeError/);
});
