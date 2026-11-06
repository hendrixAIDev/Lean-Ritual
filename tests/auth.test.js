"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAuth } = require("../lib/auth");

test("invitation signup, verified access, password reset and revocation", { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-auth-"));
  const mails = [];
  const service = await createAuth({ dataDir, baseURL: "http://localhost:8080", secret: "test-secret-that-is-long-enough-123456789", cookieSecure: false, sendEmail: async mail => mails.push(mail) });
  t.after(() => { service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const request = async (route, body, cookie) => service.auth.handler(new Request("http://localhost:8080/api/auth/" + route, {
    method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-ritual-client-ip": "192.0.2.1", origin: "http://localhost:8080", ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  const password = "correct horse battery staple";
  const signup = invitation => ({ email: "person@example.com", name: "Person", password, invitation });
  assert.equal((await request("sign-up/email", signup())).status, 400);
  const invite = service.invites.issue("person@example.com", { userId: "u_existing_data_owner" });
  assert.equal((await request("sign-up/email", { ...signup(invite.token), email: "other@example.com" })).status, 400);
  const result = await request("sign-up/email", signup(invite.token));
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal((await result.json()).user.id, "u_existing_data_owner");
  assert.equal((await request("sign-in/email", { email: invite.email, password })).status, 403);
  const verify = mails.find(m => m.kind === "verify");
  assert.ok(verify);
  const {signJWT} = await import("better-auth/crypto");
  const expiredVerification = await signJWT({email:invite.email}, "test-secret-that-is-long-enough-123456789", -60);
  await service.auth.handler(new Request("http://localhost:8080/api/auth/verify-email?token="+expiredVerification));
  assert.equal((await request("sign-in/email", { email: invite.email, password })).status, 403);
  assert.equal((await service.auth.handler(new Request(verify.url))).status, 302);
  const login = await request("sign-in/email", { email: invite.email, password });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  assert.equal((await service.sessionUser({ headers: { cookie } })).id, invite.userId);
  await request("request-password-reset", { email: invite.email, redirectTo: "/login.html" });
  const reset = mails.find(m => m.kind === "reset");
  assert.ok(reset);
  const token = new URL(reset.url).pathname.split("/").pop();
  const newPassword = "a different strong password";
  const changed = await request("reset-password", { token, newPassword });
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal(await service.sessionUser({ headers: { cookie } }), null);
  assert.notEqual((await request("reset-password", { token, newPassword })).status, 200);
  assert.equal((await request("sign-in/email", { email: invite.email, password })).status, 401);
  assert.equal((await request("sign-in/email", { email: invite.email, password: newPassword })).status, 200);
  // Expired reset tokens cannot change a password.
  await request("request-password-reset", { email: invite.email, redirectTo: "/login.html" });
  const expiredReset = mails.filter(m => m.kind === "reset").at(-1);
  const expiredToken = new URL(expiredReset.url).pathname.split("/").pop();
  const { DatabaseSync } = require("node:sqlite");
  const inspector = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  inspector.prepare("UPDATE verification SET expiresAt=0 WHERE identifier=?").run("reset-password:"+expiredToken);
  inspector.close();
  assert.notEqual((await request("reset-password", { token: expiredToken, newPassword: "must not become valid" })).status, 200);
  // Reusing a consumed invitation cannot create any other account.
  assert.equal((await request("sign-up/email", { ...signup(invite.token), email: "different@example.com" })).status, 400);
  const logout = await request("sign-out", {}, (await request("sign-in/email", { email: invite.email, password: newPassword })).headers.getSetCookie().map(c => c.split(";")[0]).join("; "));
  assert.equal(logout.status, 200);
});

test("concurrent signup creates one account; expired/revoked invitations and internal bypass fail", { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-auth-"));
  const service = await createAuth({ dataDir, baseURL: "http://localhost:8080", secret: "concurrent-test-secret-long-enough-12345", cookieSecure: false, sendEmail: async () => {} });
  t.after(() => { service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const { DatabaseSync } = require("node:sqlite");
  const inspector = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  t.after(() => inspector.close());
  const register = (email, invitation) => service.auth.handler(new Request("http://localhost:8080/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", "x-ritual-client-ip": "192.0.2.3", origin: "http://localhost:8080" }, body: JSON.stringify({ email, invitation, name: "Concurrent", password: "strong concurrent password" }) }));
  const invite = service.invites.issue("concurrent@example.com");
  const responses = await Promise.all([register(invite.email, invite.token), register(invite.email, invite.token)]);
  assert.ok(responses.every(r => r.status === 200)); // Duplicate response deliberately hides account existence.
  assert.equal(inspector.prepare("SELECT COUNT(*) n FROM user").get().n, 1);
  assert.equal(inspector.prepare("SELECT COUNT(*) n FROM account").get().n, 1);
  const expired = service.invites.issue("expired@example.com");
  inspector.prepare("UPDATE launch_invites SET expires = 0 WHERE email = ?").run(expired.email);
  assert.equal((await register(expired.email, expired.token)).status, 400);
  const revoked = service.invites.issue("revoked@example.com");
  service.invites.revoke(revoked.token);
  assert.equal((await register(revoked.email, revoked.token)).status, 400);
  const active = service.invites.issue("rotate@example.com");
  service.invites.issue(active.email, { userId: active.userId });
  assert.equal((await register(active.email, active.token)).status, 400);
  const renewed = service.invites.issue(expired.email, { userId: expired.userId });
  assert.equal(renewed.userId, expired.userId);
  assert.notEqual(renewed.token, expired.token);
  const renewedRevoked = service.invites.issue(revoked.email, { userId: revoked.userId });
  assert.notEqual(renewedRevoked.token, revoked.token);
  assert.throws(() => service.invites.issue(invite.email, { userId: invite.userId }), /already registered/);
  const ctx = await service.auth.$context;
  await assert.rejects(() => ctx.internalAdapter.createUser({ email: "bypass@example.com", name: "Bypass", emailVerified: true }));
  assert.throws(() => inspector.exec(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('u_bypass','Bypass','bypass@example.com',1,0,0)`), /Invitation required/);
});

test("failed account creation rolls back invitation and user creation", { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-auth-"));
  const service = await createAuth({ dataDir, baseURL: "http://localhost:8080", secret: "another-test-secret-long-enough-123456", cookieSecure: false, sendEmail: async () => {} });
  t.after(() => { service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const invitation = service.invites.issue("retry@example.com");
  const signup = () => service.auth.handler(new Request("http://localhost:8080/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", "x-ritual-client-ip": "192.0.2.2", origin: "http://localhost:8080" }, body: JSON.stringify({ name: "Retry", email: invitation.email, password: "strong password for retry", invitation: invitation.token }) }));
  const { DatabaseSync } = require("node:sqlite");
  const inspector = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  inspector.exec("CREATE TRIGGER fail_account BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'test account failure'); END;");
  assert.equal((await signup()).status, 500);
  assert.equal(inspector.prepare("SELECT COUNT(*) n FROM user").get().n, 0);
  assert.equal(inspector.prepare("SELECT consumed FROM launch_invites").get().consumed, null);
  inspector.exec("DROP TRIGGER fail_account");
  inspector.close();
  const response = await signup();
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).user.id, invitation.userId);
});
