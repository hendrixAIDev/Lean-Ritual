"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMailer } = require("../lib/mail");

test("mail fails closed and development messages stay in private files", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-mail-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const local = { dataDir, baseURL: "http://localhost:8080" };
  assert.throws(() => createMailer({}, local), /MAIL_MODE/);
  assert.throws(() => createMailer({ MAIL_MODE: "smtp" }, local), /SMTP_HOST/);
  assert.throws(() => createMailer({ MAIL_MODE: "file" }, { dataDir, baseURL: "https://ritual.example" }), /localhost/);
  const send = createMailer({ MAIL_MODE: "file" }, local);
  const message = { to: "private@example.com", kind: "verify", url: "http://localhost:8080/secret" };
  await send(message);
  const file = path.join(dataDir, "mail", fs.readdirSync(path.join(dataDir, "mail"))[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), message);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("nodemailer envelope parsing preserves CFWS domains and UTS-46 IDN mapping", async () => {
  const nodemailer = require("nodemailer");
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const cfws = await transport.sendMail({
    from: "noreply@leanritual.app",
    to: "user@sub.(comment)example.com",
    subject: "Verify",
    text: "body",
  });
  assert.deepEqual(cfws.envelope.to, ["user@sub.example.com"]);

  const idn = await transport.sendMail({
    from: "noreply@leanritual.app",
    to: "user@fa\u1e9e.de",
    subject: "Verify",
    text: "body",
  });
  assert.deepEqual(idn.envelope.to, ["user@xn--fa-hia.de"]);
});
