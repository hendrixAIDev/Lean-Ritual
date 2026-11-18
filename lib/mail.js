"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function normalizeMailLang(lang) {
  return typeof lang === "string" && lang.trim().toLowerCase() === "en" ? "en" : "zh";
}

function renderEmail({ kind, url, lang } = {}) {
  const resolved = normalizeMailLang(lang);
  const reset = kind === "reset";
  if (resolved === "en") {
    return {
      lang: "en",
      subject: reset ? "Lean Ritual · Reset your password" : "Lean Ritual · Verify your email",
      text: `${reset ? "Click the link below to reset your password" : "Click the link below to verify your email address"}:\n\n${url}\n\nIf you did not request this, you can safely ignore this email.`,
    };
  }
  return {
    lang: "zh",
    subject: reset ? "Lean Ritual · 重置密码" : "Lean Ritual · 验证邮箱",
    text: `${reset ? "请点击链接重置密码" : "请点击链接验证邮箱"}：\n\n${url}\n\n如果你没有发起此请求，请忽略这封邮件。`,
  };
}

function createMailer(env = process.env, { dataDir, baseURL } = {}) {
  const mode = env.MAIL_MODE;
  if (mode === "file") {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error("File mail is only available for localhost development");
    const dir = path.join(dataDir, "mail");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return async message => {
      const payload = message && message.lang !== undefined
        ? { ...renderEmail(message), ...message, lang: normalizeMailLang(message.lang) }
        : message;
      fs.writeFileSync(path.join(dir, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.json`), JSON.stringify(payload) + "\n", { mode: 0o600, flag: "wx" });
    };
  }
  if (mode !== "smtp") throw new Error("Set MAIL_MODE=smtp (or file for explicit localhost development)");
  for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"]) if (!env[key]) throw new Error(`${key} is required`);
  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SMTP_PORT");
  const transport = require("nodemailer").createTransport({
    host: env.SMTP_HOST, port, secure: port === 465, requireTLS: true,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  });
  return async ({ to, kind, url, lang }) => {
    const { subject, text } = renderEmail({ kind, url, lang });
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text });
  };
}
module.exports = { createMailer, renderEmail, normalizeMailLang };
