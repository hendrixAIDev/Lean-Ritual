"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const addressparser = require("nodemailer/lib/addressparser");

const DEFAULT_REPLY_TO = "hendrix.ai.dev@gmail.com";
const DEFAULT_DOMAIN = "leanritual.app";
const OPERATOR_ZH = "杰瑞智能技术服务部";
const OPERATOR_EN = "Jierui Intelligent Technology Service Department";

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SAFE_MESSAGE_ID_RE = /^<?[A-Za-z0-9._+-]+(?:@[A-Za-z0-9.-]+)?>?$/;
const SAFE_ERROR_CODE_RE = /^[A-Z0-9_]{1,32}$/;

function normalizeMailLang(lang) {
  return typeof lang === "string" && lang.trim().toLowerCase() === "en" ? "en" : "zh";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeHostname(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || /[\s\r\n\0/?#\\:@]/.test(trimmed)) return null;
  try {
    const host = new URL(`http://${trimmed}`).hostname.toLowerCase();
    return DOMAIN_RE.test(host) ? host : null;
  } catch {
    return null;
  }
}

function extractEmailAddress(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return null;
  const parsed = addressparser(trimmed);
  if (!Array.isArray(parsed) || parsed.length !== 1) return null;
  const addr = typeof parsed[0]?.address === "string" ? parsed[0].address.trim() : "";
  const at = addr.lastIndexOf("@");
  if (at <= 0 || at === addr.length - 1) return null;
  const host = normalizeHostname(addr.slice(at + 1));
  if (!host) return null;
  return `${addr.slice(0, at)}@${host}`;
}

function extractDomain(address) {
  const addr = extractEmailAddress(address);
  if (!addr) return "unknown";
  return addr.slice(addr.lastIndexOf("@") + 1);
}

function resolveReplyTo(env = {}) {
  const raw = env?.MAIL_REPLY_TO;
  if (raw === undefined || raw === null) return DEFAULT_REPLY_TO;
  if (typeof raw !== "string") throw new Error("Invalid MAIL_REPLY_TO");
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_REPLY_TO;
  if (/[\r\n\0]/.test(trimmed) || !extractEmailAddress(trimmed)) {
    throw new Error("Invalid MAIL_REPLY_TO");
  }
  return trimmed;
}

function resolveMessageIdDomain(from, baseURL) {
  const fromDomain = extractDomain(from);
  if (fromDomain !== "unknown" && fromDomain !== "localhost") return fromDomain;
  if (typeof baseURL === "string" && baseURL.trim()) {
    try {
      const host = normalizeHostname(new URL(baseURL).hostname);
      if (host && host !== "localhost" && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
    } catch {}
  }
  return DEFAULT_DOMAIN;
}

function generateMessageId(domain) {
  const safeDomain = normalizeHostname(domain) || DEFAULT_DOMAIN;
  return `<${crypto.randomUUID()}@${safeDomain}>`;
}

function extractSmtpResponseCode(value) {
  if (typeof value?.responseCode === "number" && Number.isInteger(value.responseCode) && value.responseCode >= 100 && value.responseCode <= 599) {
    return String(value.responseCode);
  }
  if (typeof value?.response === "string") {
    const m = value.response.match(/^\s*(\d{3})\b/);
    if (m) return m[1];
  }
  return "none";
}

function sanitizeMessageId(rawId, recipientAddress) {
  if (typeof rawId !== "string") return "none";
  const trimmed = rawId.trim();
  if (!trimmed || trimmed.length > 200 || !SAFE_MESSAGE_ID_RE.test(trimmed)) return "redacted";
  const recipient = extractEmailAddress(recipientAddress);
  if (recipient && trimmed.toLowerCase().includes(recipient.toLowerCase())) return "redacted";
  return trimmed;
}

function normalizeMailKind(kind) {
  if (kind === "verify" || kind === "reset") return kind;
  return "unknown";
}

function formatMailLog({ status, kind, to, messageId, responseCode, errorCode }) {
  const parts = [
    "mail",
    `status=${status === "error" ? "error" : "sent"}`,
    `type=${normalizeMailKind(kind)}`,
    `recipient_domain=${extractDomain(to)}`,
    `message_id=${sanitizeMessageId(messageId, to)}`,
    `smtp_code=${typeof responseCode === "string" && /^\d{3}$/.test(responseCode) ? responseCode : "none"}`,
  ];
  if (status === "error") {
    const safeErr = typeof errorCode === "string" && SAFE_ERROR_CODE_RE.test(errorCode) ? errorCode : "UNKNOWN";
    parts.push(`error_code=${safeErr}`);
  }
  return parts.join(" ");
}

function safeActionHref(url) {
  const raw = String(url ?? "").trim();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return escapeHtml(raw);
  } catch {}
  return "#";
}

function buildHtmlEmail({ htmlLang, title, brandHeader, heading, intro, buttonLabel, fallbackLabel, url, reason, footerBrand, footerOperator, contactLabel, contactEmail }) {
  const safeHref = safeActionHref(url);
  const safeUrlText = escapeHtml(String(url ?? ""));
  const safeContact = escapeHtml(contactEmail);
  return [
    "<!doctype html>",
    `<html lang="${htmlLang}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    '<body style="margin:0;padding:0;background-color:#F4F1EA;color:#1F1D1A;font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F1EA;width:100%;">',
    '<tr><td align="center" style="padding:32px 16px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;background-color:#FFFDF8;border:1px solid #DDD6C8;border-radius:10px;text-align:left;">',
    `<tr><td align="left" style="padding:24px 28px 16px;border-bottom:1px solid #DDD6C8;font-size:16px;font-weight:700;color:#1F1D1A;letter-spacing:0.01em;text-align:left;">${escapeHtml(brandHeader)}</td></tr>`,
    '<tr><td align="left" style="padding:24px 28px;text-align:left;">',
    `<h1 style="margin:0 0 12px;font-size:20px;line-height:1.35;font-weight:700;color:#1F1D1A;">${escapeHtml(heading)}</h1>`,
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#1F1D1A;">${escapeHtml(intro)}</p>`,
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;">',
    `<tr><td align="center" bgcolor="#B5462F" style="background-color:#B5462F;border-radius:8px;"><a href="${safeHref}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:8px;">${escapeHtml(buttonLabel)}</a></td></tr>`,
    "</table>",
    `<p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#6B655C;">${escapeHtml(fallbackLabel)}</p>`,
    `<p style="margin:0 0 20px;padding:10px 12px;background-color:#F4F1EA;border:1px solid #DDD6C8;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:#1F1D1A;word-break:break-all;overflow-wrap:anywhere;">${safeUrlText}</p>`,
    `<p style="margin:0;font-size:13px;line-height:1.6;color:#6B655C;">${escapeHtml(reason)}</p>`,
    "</td></tr>",
    '<tr><td align="left" style="padding:16px 28px 22px;border-top:1px solid #DDD6C8;font-size:12px;line-height:1.6;color:#6B655C;text-align:left;">',
    `<p style="margin:0 0 4px;">${escapeHtml(footerBrand)}</p>`,
    `<p style="margin:0;">${escapeHtml(footerOperator)} · ${escapeHtml(contactLabel)}<a href="mailto:${safeContact}" style="color:#6B655C;text-decoration:underline;">${safeContact}</a></p>`,
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("\n");
}

function renderEmail({ kind, url, lang, replyTo } = {}) {
  const resolved = normalizeMailLang(lang);
  const reset = kind === "reset";
  const contactEmail = extractEmailAddress(replyTo) || DEFAULT_REPLY_TO;
  const link = String(url ?? "");

  if (resolved === "en") {
    const subject = reset ? "Lean Ritual · Reset your password" : "Lean Ritual · Verify your email";
    const text = [
      `${reset ? "Click the link below to reset your password" : "Click the link below to verify your email address"}:`,
      "",
      link,
      "",
      reset
        ? "This link expires in 1 hour. Resetting your password will sign out existing sessions."
        : "This link expires in 1 hour. Once verified, you can sign in to Lean Ritual.",
      "",
      reset
        ? "You received this email because a password reset was requested for the Lean Ritual account associated with this address. If you did not request this, you can safely ignore this email and your password will remain unchanged. Do not forward this link."
        : "You received this email because this address was used to sign up for Lean Ritual or to request a verification email. If you did not request this, you can safely ignore this email and do not forward this link.",
      "",
      "--",
      `Lean Ritual · ${DEFAULT_DOMAIN}`,
      `Operated by ${OPERATOR_EN}`,
      `Contact: ${contactEmail}`,
    ].join("\n");

    const html = buildHtmlEmail({
      htmlLang: "en",
      title: subject,
      brandHeader: "Lean Ritual",
      heading: reset ? "Reset your password" : "Verify your email address",
      intro: reset
        ? "Click the button below to set a new password for your Lean Ritual account. This link expires in 1 hour, and resetting your password will sign out existing sessions."
        : "Click the button below to verify your email address and sign in to Lean Ritual. This link expires in 1 hour.",
      buttonLabel: reset ? "Reset password" : "Verify email",
      fallbackLabel: "If the button does not work, copy and paste this link into your browser:",
      url: link,
      reason: reset
        ? "You received this email because a password reset was requested for the Lean Ritual account associated with this address. If you did not request this, you can safely ignore this email and your password will remain unchanged. Do not forward this link."
        : "You received this email because this address was used to sign up for Lean Ritual or to request a verification email. If you did not request this, you can safely ignore this email and do not forward this link.",
      footerBrand: `Lean Ritual · ${DEFAULT_DOMAIN}`,
      footerOperator: `Operated by ${OPERATOR_EN}`,
      contactLabel: "Contact: ",
      contactEmail,
    });

    return { lang: "en", subject, text, html };
  }

  const subject = reset ? "Lean Ritual · 重置密码" : "Lean Ritual · 验证邮箱";
  const text = [
    `${reset ? "请点击链接重置密码" : "请点击链接验证邮箱"}：`,
    "",
    link,
    "",
    reset
      ? "此链接 1 小时内有效。重置密码后，其他设备的登录会话将被退出。"
      : "此链接 1 小时内有效。验证完成后即可登录 Lean Ritual（薄肌日课）。",
    "",
    reset
      ? "你收到这封邮件，是因为有人为关联此邮箱的 Lean Ritual 账号发起了密码重置请求。如果你没有发起此请求，请忽略这封邮件，你的密码不会被修改，也请勿转发此链接。"
      : "你收到这封邮件，是因为有人使用此邮箱注册了 Lean Ritual 账号或请求重发验证邮件。如果你没有发起此请求，请忽略这封邮件，也请勿转发此链接。",
    "",
    "--",
    `Lean Ritual（薄肌日课）· ${DEFAULT_DOMAIN}`,
    `运营者：${OPERATOR_ZH}`,
    `联系邮箱：${contactEmail}`,
  ].join("\n");

  const html = buildHtmlEmail({
    htmlLang: "zh-CN",
    title: subject,
    brandHeader: "Lean Ritual · 薄肌日课",
    heading: reset ? "重置你的密码" : "验证你的邮箱",
    intro: reset
      ? "请点击下方按钮为你的 Lean Ritual（薄肌日课）账号设置新密码。此链接 1 小时内有效；重置后，其他设备的登录会话将被退出。"
      : "请点击下方按钮完成邮箱验证，验证后即可登录 Lean Ritual（薄肌日课）。此链接 1 小时内有效。",
    buttonLabel: reset ? "重置密码" : "验证邮箱",
    fallbackLabel: "如果按钮无法打开，请将以下链接复制到浏览器地址栏打开：",
    url: link,
    reason: reset
      ? "你收到这封邮件，是因为有人为关联此邮箱的 Lean Ritual（薄肌日课）账号发起了密码重置请求。如果你没有发起此请求，请直接忽略这封邮件，你的密码不会被修改，也请勿转发此链接。"
      : "你收到这封邮件，是因为有人使用此邮箱注册了 Lean Ritual（薄肌日课）账号或请求重发验证邮件。如果你没有发起此请求，请直接忽略这封邮件，请勿转发此链接。",
    footerBrand: `Lean Ritual（薄肌日课）· ${DEFAULT_DOMAIN}`,
    footerOperator: `运营者：${OPERATOR_ZH}`,
    contactLabel: "联系邮箱：",
    contactEmail,
  });

  return { lang: "zh", subject, text, html };
}

function createMailer(env = process.env, { dataDir, baseURL, transport: customTransport, log = console.log } = {}) {
  const mode = env.MAIL_MODE;
  if (mode === "file") {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("File mail is only available for localhost development");
    const replyTo = resolveReplyTo(env);
    const dir = path.join(dataDir, "mail");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return async message => {
      const payload = message && message.lang !== undefined
        ? { ...renderEmail({ ...message, replyTo }), ...message, lang: normalizeMailLang(message.lang), replyTo }
        : message;
      fs.writeFileSync(path.join(dir, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.json`), JSON.stringify(payload) + "\n", { mode: 0o600, flag: "wx" });
    };
  }
  if (mode !== "smtp") throw new Error("Set MAIL_MODE=smtp (or file for explicit localhost development)");
  for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"]) if (!env[key]) throw new Error(`${key} is required`);
  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SMTP_PORT");
  const replyTo = resolveReplyTo(env);
  const messageIdDomain = resolveMessageIdDomain(env.MAIL_FROM, baseURL);
  const transport = customTransport || require("nodemailer").createTransport({
    host: env.SMTP_HOST, port, secure: port === 465, requireTLS: true,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  });
  return async ({ to, kind, url, lang }) => {
    const { subject, text, html } = renderEmail({ kind, url, lang, replyTo });
    const messageId = generateMessageId(messageIdDomain);
    // Transactional auth mail (verify/reset) intentionally omits List-Unsubscribe
    // so inbox providers do not classify user-requested security mail as bulk/promotional.
    try {
      const info = await transport.sendMail({
        from: env.MAIL_FROM,
        replyTo,
        to,
        subject,
        text,
        html,
        messageId,
      });
      log(formatMailLog({
        status: "sent",
        kind,
        to,
        messageId: info?.messageId || messageId,
        responseCode: extractSmtpResponseCode(info),
      }));
      return info;
    } catch (err) {
      log(formatMailLog({
        status: "error",
        kind,
        to,
        messageId,
        responseCode: extractSmtpResponseCode(err),
        errorCode: err?.code,
      }));
      throw err;
    }
  };
}

module.exports = {
  createMailer,
  renderEmail,
  normalizeMailLang,
  resolveReplyTo,
  extractDomain,
  generateMessageId,
  formatMailLog,
  DEFAULT_REPLY_TO,
};
