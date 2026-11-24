"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const loginHtml = fs.readFileSync(path.join(ROOT, "public/login.html"), "utf8");
const loginScript = loginHtml.match(/<script>([\s\S]*?)<\/script>/)[1];

function makeSafeTextElement(initial = {}) {
  let text = initial.textContent ?? "";
  return {
    ...initial,
    get textContent() { return text; },
    set textContent(v) { text = String(v ?? ""); },
    get innerHTML() { throw new Error("innerHTML getter must not be used"); },
    set innerHTML(_v) { throw new Error("innerHTML setter must not be used (use textContent)"); },
    insertAdjacentHTML() { throw new Error("insertAdjacentHTML must not be used"); }
  };
}

function mountLogin({ search = "", pathname = "/login.html", hash = "", fetchImpl } = {}) {
  const replaceStateCalls = [];
  let replacedHref = null;
  const location = {
    pathname,
    search,
    hash,
    replace(url) { replacedHref = url; }
  };
  const history = {
    replaceState(state, title, url) {
      replaceStateCalls.push({ state, title, url });
      if (typeof url === "string") {
        const parsed = new URL(url, "http://localhost");
        location.pathname = parsed.pathname;
        location.search = parsed.search;
        location.hash = parsed.hash;
      }
    }
  };
  const tabLogin = { dataset: { m: "login" }, classList: { toggle() {} }, closest(sel) { return sel === "button" ? tabLogin : null; } };
  const tabRegister = { dataset: { m: "register" }, classList: { toggle() {} }, closest(sel) { return sel === "button" ? tabRegister : null; } };
  const els = {
    "#banner": makeSafeTextElement({ hidden: true }),
    "#n": { value: "" },
    "#e": { value: "user@example.com", required: true },
    "#p": { value: "strong-password-1234", required: true, autocomplete: "" },
    "#i": { value: "" },
    "#nw": { hidden: true },
    "#ew": { hidden: false },
    "#pw": { hidden: false },
    "#iw": { hidden: true },
    "#cw": { hidden: true },
    "#c-terms": { checked: false },
    "#c-sensitive": { checked: false },
    "#err": makeSafeTextElement({ textContent: "" }),
    "#go": { textContent: "登录", disabled: false },
    "#tabs": { onclick: null },
    "#forgot": { onclick: null },
    "#resend": { onclick: null },
    "#f": { onsubmit: null }
  };
  const requests = [];
  const ctx = vm.createContext({
    location,
    history,
    URLSearchParams,
    Object,
    Error,
    fetch: fetchImpl || (async (url, opts) => {
      requests.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({}) };
    }),
    document: {
      querySelector: s => els[s] || null,
      querySelectorAll: s => (s === "#tabs button" ? [tabLogin, tabRegister] : [])
    }
  });
  vm.runInContext(loginScript, ctx);
  return {
    els,
    location,
    requests,
    replaceStateCalls,
    getReplacedHref: () => replacedHref,
    tabLogin,
    tabRegister,
    submit: () => els["#f"].onsubmit({ preventDefault() {} })
  };
}

test("login.html maps all locked Better Auth and lib/auth.js error codes/messages to Chinese", async () => {
  const { BASE_ERROR_CODES } = await import("@better-auth/core/error");

  const relevantBaseCodes = [
    "INVALID_EMAIL_OR_PASSWORD",
    "INVALID_PASSWORD",
    "INVALID_EMAIL",
    "EMAIL_NOT_VERIFIED",
    "EMAIL_ALREADY_VERIFIED",
    "EMAIL_MISMATCH",
    "PASSWORD_TOO_SHORT",
    "PASSWORD_TOO_LONG",
    "USER_ALREADY_EXISTS",
    "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
    "INVALID_TOKEN",
    "TOKEN_EXPIRED",
    "USER_NOT_FOUND",
    "ACCOUNT_NOT_FOUND",
    "CREDENTIAL_ACCOUNT_NOT_FOUND",
    "USER_EMAIL_NOT_FOUND",
    "INVALID_USER",
    "SESSION_EXPIRED",
    "SESSION_NOT_FRESH",
    "FAILED_TO_CREATE_USER",
    "FAILED_TO_CREATE_SESSION",
    "FAILED_TO_GET_SESSION",
    "FAILED_TO_UPDATE_USER",
    "FAILED_TO_CREATE_VERIFICATION",
    "VERIFICATION_EMAIL_NOT_ENABLED",
    "EMAIL_CAN_NOT_BE_UPDATED",
    "CHANGE_EMAIL_DISABLED",
    "PASSWORD_ALREADY_SET",
    "USER_ALREADY_HAS_PASSWORD",
    "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
    "INVALID_ORIGIN",
    "MISSING_OR_NULL_ORIGIN",
    "INVALID_CALLBACK_URL",
    "INVALID_REDIRECT_URL",
    "INVALID_ERROR_CALLBACK_URL",
    "INVALID_NEW_USER_CALLBACK_URL",
    "CALLBACK_URL_REQUIRED",
    "VALIDATION_ERROR",
    "MISSING_FIELD",
    "FIELD_NOT_ALLOWED",
    "BODY_MUST_BE_AN_OBJECT"
  ];

  for (const key of relevantBaseCodes) {
    assert.ok(BASE_ERROR_CODES[key], `Expected ${key} in locked @better-auth/core BASE_ERROR_CODES`);
    const { code, message } = BASE_ERROR_CODES[key];
    const ui = mountLogin({
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ code, message }) })
    });
    await ui.submit();
    const shown = ui.els["#err"].textContent;
    assert.match(shown, /[\u4e00-\u9fff]/, `${code} must produce Chinese message, got: ${shown}`);
    assert.notEqual(shown, "请求失败，请稍后再试。", `${code} should have a specific Chinese mapping, not generic fallback`);
    assert.doesNotMatch(shown, /[A-Za-z]{3,}/, `${code} must not leak English text: ${shown}`);
    assert.equal(ui.els["#go"].disabled, false);
  }

  // Cover all 5 flows explicitly with realistic payloads from Better Auth & lib/auth.js
  const flowCases = [
    {
      name: "login: invalid email or password",
      setup: () => {},
      route: "/api/auth/sign-in/email",
      status: 401,
      body: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
      expect: "邮箱或密码错误。"
    },
    {
      name: "login: email not verified",
      setup: () => {},
      route: "/api/auth/sign-in/email",
      status: 403,
      body: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
      expect: "邮箱尚未验证，请查收验证邮件后再登录。"
    },
    {
      name: "login: rate limit 429 without code (Better Auth rateLimitResponse)",
      setup: () => {},
      route: "/api/auth/sign-in/email",
      status: 429,
      body: { message: "Too many requests. Please try again later." },
      expect: "操作过于频繁，请稍后再试。"
    },
    {
      name: "register: missing invitation (lib/auth.js custom APIError without code)",
      setup: ui => { ui.els["#tabs"].onclick({ target: ui.tabRegister }); ui.els["#c-terms"].checked = true; ui.els["#c-sensitive"].checked = true; },
      route: "/api/auth/sign-up/email",
      status: 400,
      body: { message: "Invitation required" },
      expect: "需要有效邀请码才能注册。"
    },
    {
      name: "register: invalid/expired/used/mismatched invitation (lib/auth.js custom APIError without code)",
      setup: ui => { ui.els["#tabs"].onclick({ target: ui.tabRegister }); ui.els["#c-terms"].checked = true; ui.els["#c-sensitive"].checked = true; },
      route: "/api/auth/sign-up/email",
      status: 400,
      body: { message: "Invitation is invalid, expired, used, or belongs to another email" },
      expect: "邀请码无效、已过期、已使用，或与填写的邮箱不匹配。"
    },
    {
      name: "register: user already exists",
      setup: ui => { ui.els["#tabs"].onclick({ target: ui.tabRegister }); ui.els["#c-terms"].checked = true; ui.els["#c-sensitive"].checked = true; },
      route: "/api/auth/sign-up/email",
      status: 422,
      body: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", message: "User already exists. Use another email." },
      expect: "该邮箱已注册，请直接登录或重置密码。"
    },
    {
      name: "register: password too short",
      setup: ui => { ui.els["#tabs"].onclick({ target: ui.tabRegister }); ui.els["#c-terms"].checked = true; ui.els["#c-sensitive"].checked = true; },
      route: "/api/auth/sign-up/email",
      status: 400,
      body: { code: "PASSWORD_TOO_SHORT", message: "Password too short" },
      expect: "密码太短，至少需要 8 位。"
    },
    {
      name: "register: missing consent (lib/auth.js custom APIError without code)",
      setup: ui => { ui.els["#tabs"].onclick({ target: ui.tabRegister }); ui.els["#c-terms"].checked = true; ui.els["#c-sensitive"].checked = true; },
      route: "/api/auth/sign-up/email",
      status: 400,
      body: { message: "Consent to terms, privacy notice, sensitive data processing, and cross-border transfer is required" },
      expect: "请先勾选同意使用条款、隐私说明，以及敏感个人信息处理与跨境传输的单独同意。"
    },
    {
      name: "resend: email validation error from better-call",
      setup: ui => ui.els["#resend"].onclick(),
      route: "/api/auth/send-verification-email",
      status: 400,
      body: { code: "VALIDATION_ERROR", message: "[body.email] Invalid email address" },
      expect: "请输入有效的邮箱地址。"
    },
    {
      name: "resend: email already verified",
      setup: ui => ui.els["#resend"].onclick(),
      route: "/api/auth/send-verification-email",
      status: 400,
      body: { code: "EMAIL_ALREADY_VERIFIED", message: "Email is already verified" },
      expect: "该邮箱已完成验证，请直接登录。"
    },
    {
      name: "forgot: rate limit with TOO_MANY_REQUESTS code",
      setup: ui => ui.els["#forgot"].onclick(),
      route: "/api/auth/request-password-reset",
      status: 429,
      body: { code: "TOO_MANY_REQUESTS", message: "Too many requests" },
      expect: "操作过于频繁，请稍后再试。"
    },
    {
      name: "reset: invalid or expired reset token",
      search: "?token=expired-reset-token",
      setup: () => {},
      route: "/api/auth/reset-password",
      status: 400,
      body: { code: "INVALID_TOKEN", message: "Invalid token" },
      expect: "链接无效或已过期，请重新发送邮件。"
    },
    {
      name: "reset: password too long",
      search: "?token=valid-reset-token",
      setup: () => {},
      route: "/api/auth/reset-password",
      status: 400,
      body: { code: "PASSWORD_TOO_LONG", message: "Password too long" },
      expect: "密码太长，最多 200 位。"
    }
  ];

  for (const tc of flowCases) {
    let calledUrl = null;
    const ui = mountLogin({
      search: tc.search || "",
      fetchImpl: async url => {
        calledUrl = url;
        return { ok: false, status: tc.status, json: async () => tc.body };
      }
    });
    tc.setup(ui);
    await ui.submit();
    assert.equal(calledUrl, tc.route, tc.name);
    assert.equal(ui.els["#err"].textContent, tc.expect, tc.name);
  }
});

test("unknown errors, prototype keys, stack traces, and HTML payloads fall back to generic Chinese without raw English", async () => {
  const hostileResponses = [
    { status: 500, body: { code: "UNKNOWN_SERVER_CODE", message: "Unexpected internal database failure" } },
    { status: 500, body: { message: "Error: SQLITE_BUSY: database is locked\n    at DatabaseSync.prepare (/opt/bojin/server.js:40:12)" } },
    { status: 400, body: { code: "constructor", message: "Object.prototype.constructor" } },
    { status: 400, body: { code: "toString", message: "function toString() { [native code] }" } },
    { status: 400, body: { code: "__proto__", message: "prototype pollution test" } },
    { status: 400, body: { code: "<img src=x onerror=alert(1)>", message: "<script>alert('xss')</script>" } },
    { status: 502, nonJson: true }
  ];

  for (const item of hostileResponses) {
    const ui = mountLogin({
      fetchImpl: async () => ({
        ok: false,
        status: item.status,
        json: async () => {
          if (item.nonJson) throw new SyntaxError("Unexpected token < in JSON at position 0");
          return item.body;
        }
      })
    });
    await ui.submit();
    assert.equal(ui.els["#err"].textContent, "请求失败，请稍后再试。");
    assert.doesNotMatch(ui.els["#err"].textContent, /[A-Za-z<>]/);
  }

  // Query-param error never echoes untrusted English/HTML
  const errRedirect = mountLogin({ search: "?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E" });
  assert.equal(errRedirect.els["#err"].textContent, "链接无效或已过期，请重新发送邮件。");

  const expiredRedirect = mountLogin({ search: "?error=TOKEN_EXPIRED" });
  assert.equal(expiredRedirect.els["#err"].textContent, "链接已过期，请重新发送邮件。");
});

test("?verified=1 and ?deleted=1 banners render Chinese text once via textContent and strip query params", async () => {
  // 1. ?verified=1 -> Chinese banner shown, param removed via replaceState, gone on reload
  const verified = mountLogin({ search: "?verified=1" });
  assert.equal(verified.els["#banner"].hidden, false);
  assert.equal(verified.els["#banner"].textContent, "邮箱已验证，请登录。");
  assert.equal(verified.replaceStateCalls.length, 1);
  assert.equal(verified.replaceStateCalls[0].url, "/login.html");

  const afterVerifiedReload = mountLogin({ search: verified.location.search, pathname: verified.location.pathname });
  assert.equal(afterVerifiedReload.els["#banner"].hidden, true);
  assert.equal(afterVerifiedReload.els["#banner"].textContent, "");
  assert.equal(afterVerifiedReload.replaceStateCalls.length, 0);

  // 2. ?deleted=1 -> Chinese banner shown, param removed via replaceState, gone on reload
  const deleted = mountLogin({ search: "?deleted=1" });
  assert.equal(deleted.els["#banner"].hidden, false);
  assert.equal(deleted.els["#banner"].textContent, "账号已删除。");
  assert.equal(deleted.replaceStateCalls.length, 1);
  assert.equal(deleted.replaceStateCalls[0].url, "/login.html");

  const afterDeletedReload = mountLogin({ search: deleted.location.search, pathname: deleted.location.pathname });
  assert.equal(afterDeletedReload.els["#banner"].hidden, true);
  assert.equal(afterDeletedReload.els["#banner"].textContent, "");
  assert.equal(afterDeletedReload.replaceStateCalls.length, 0);

  // 3. Unrelated query params (e.g. email) are preserved when stripping verified=1
  const withEmail = mountLogin({ search: "?verified=1&email=member%40example.com" });
  assert.equal(withEmail.els["#banner"].hidden, false);
  assert.equal(withEmail.els["#e"].value, "member@example.com");
  assert.equal(withEmail.replaceStateCalls[0].url, "/login.html?email=member%40example.com");

  // 4. Expired verification redirect (/login.html?verified=1&error=TOKEN_EXPIRED) must NOT show success banner
  const expiredVerify = mountLogin({ search: "?verified=1&error=TOKEN_EXPIRED" });
  assert.equal(expiredVerify.els["#banner"].hidden, true);
  assert.equal(expiredVerify.els["#banner"].textContent, "");
  assert.equal(expiredVerify.els["#err"].textContent, "链接已过期，请重新发送邮件。");
  assert.equal(expiredVerify.replaceStateCalls.length, 1);
  assert.ok(!expiredVerify.replaceStateCalls[0].url.includes("verified="));

  // 5. Hostile HTML in query params never injects HTML (makeSafeTextElement throws on innerHTML)
  const hostileVerified = mountLogin({ search: "?verified=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E" });
  assert.equal(hostileVerified.els["#banner"].hidden, true);
  assert.equal(hostileVerified.els["#banner"].textContent, "");
  assert.equal(hostileVerified.replaceStateCalls[0].url, "/login.html");

  // 6. Submitting the form or switching mode clears the banner
  await verified.submit();
  assert.equal(verified.els["#banner"].hidden, true);
});

test("HOST-UPGRADE-2026-11.zh-CN.md bash blocks pass bash -n and preserve rollback precision & gates", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs/HOST-UPGRADE-2026-11.zh-CN.md"), "utf8");
  const blocks = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1]);
  assert.equal(blocks.length, 13, "Expected all 13 bash blocks in HOST-UPGRADE-2026-11.zh-CN.md");

  for (let i = 0; i < blocks.length; i++) {
    const res = spawnSync("bash", ["-n"], { input: blocks[i], encoding: "utf8" });
    assert.equal(res.status, 0, `bash -n failed on block #${i + 1}: ${res.stderr}`);
    assert.match(blocks[i], /echo "(STEP|ROLLBACK) [^\n]*OK/, `Block #${i + 1} missing STEP/ROLLBACK OK gate`);
    assert.match(blocks[i], /BLOCK EXIT=%s/, `Block #${i + 1} missing BLOCK EXIT gate`);
  }

  assert.match(doc, /enabled-runtime\)\s+systemctl disable "\$unit"; systemctl enable --runtime "\$unit"\s*;;/);
  assert.match(doc, /enabled-runtime\)\s+systemctl disable bojin-backup-local\.timer; systemctl enable --runtime bojin-backup-local\.timer\s*;;/);
});
