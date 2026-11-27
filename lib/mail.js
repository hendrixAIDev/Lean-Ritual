"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const addressparser = require("nodemailer/lib/addressparser");

const DEFAULT_REPLY_TO = "hendrix.ai.dev@gmail.com";
const DEFAULT_DOMAIN = "leanritual.app";
const DEFAULT_ORIGIN = `https://${DEFAULT_DOMAIN}`;
const OPERATOR_ZH = "杰瑞智能技术服务部";
const OPERATOR_EN = "Jierui Intelligent Technology Service Department";

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LOCAL_PART_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const SAFE_DISPLAY_ATOM_RE = /^[A-Za-z0-9 ._-]+$/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const GENERATED_MESSAGE_ID_RE = /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*>$/i;
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
  if (!trimmed || trimmed.length > 253 || /[\s\x00-\x1f\x7f/?#\\:@]/.test(trimmed)) return null;
  try {
    const host = new URL(`http://${trimmed}`).hostname.toLowerCase();
    return host.length <= 253 && DOMAIN_RE.test(host) ? host : null;
  } catch {
    return null;
  }
}

function validateAddrSpec(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 254 || CONTROL_CHAR_RE.test(trimmed) || /\s/.test(trimmed)) return null;
  const parts = trimmed.split("@");
  if (parts.length !== 2) return null;
  const [local, rawDomain] = parts;
  if (!local || local.length > 64 || !LOCAL_PART_RE.test(local)) return null;
  const host = normalizeHostname(rawDomain);
  if (!host || !host.includes(".") || IPV4_RE.test(host)) return null;
  return `${local}@${host}`;
}

function parseDisplayName(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let unquoted = trimmed;
  if (trimmed.startsWith('"') || trimmed.endsWith('"')) {
    if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return null;
    const inner = trimmed.slice(1, -1);
    let out = "";
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === "\\") {
        if (i + 1 >= inner.length) return null;
        out += inner[++i];
      } else if (ch === '"') {
        return null;
      } else {
        out += ch;
      }
    }
    unquoted = out.trim();
  } else {
    // Reject unquoted RFC 5322 specials, comments, multiple addresses, and group syntax.
    if (/[,;<>()@"\\:]/.test(trimmed)) return null;
  }
  if (!unquoted || unquoted.length > 100 || CONTROL_CHAR_RE.test(unquoted) || /[<>@]/.test(unquoted)) return null;
  return unquoted;
}

function serializeMailbox(name, address) {
  if (!name) return address;
  if (SAFE_DISPLAY_ATOM_RE.test(name)) return `${name} <${address}>`;
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}" <${address}>`;
}

function parseSingleMailbox(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 320 || CONTROL_CHAR_RE.test(trimmed)) return null;

  if (!trimmed.includes("<") && !trimmed.includes(">")) {
    const address = validateAddrSpec(trimmed);
    if (!address) return null;
    return { name: "", address, header: address };
  }

  const angleMatch = trimmed.match(/^(.*?)\s*<([^<>]+)>$/);
  if (!angleMatch) return null;
  const [, rawName, rawAddr] = angleMatch;
  const address = validateAddrSpec(rawAddr);
  if (!address) return null;
  const name = parseDisplayName(rawName);
  if (name === null) return null;
  return { name, address, header: serializeMailbox(name, address) };
}

function extractRecipientAddress(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || CONTROL_CHAR_RE.test(trimmed)) return null;
  const parsed = addressparser(trimmed);
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.group) return null;
  const addr = typeof parsed[0]?.address === "string" ? parsed[0].address.trim() : "";
  const at = addr.lastIndexOf("@");
  if (at <= 0 || at === addr.length - 1) return null;
  const host = normalizeHostname(addr.slice(at + 1));
  if (!host) return null;
  return `${addr.slice(0, at)}@${host}`;
}

function extractDomain(address) {
  const addr = extractRecipientAddress(address);
  if (!addr) return "unknown";
  return addr.slice(addr.lastIndexOf("@") + 1);
}

function resolveReplyTo(env = {}, { warn = console.warn } = {}) {
  const raw = env?.MAIL_REPLY_TO;
  if (raw === undefined || raw === null) return DEFAULT_REPLY_TO;
  if (typeof raw === "string" && !raw.trim()) return DEFAULT_REPLY_TO;
  const parsed = parseSingleMailbox(raw);
  if (!parsed) {
    warn("mail: invalid MAIL_REPLY_TO; falling back to default Reply-To");
    return DEFAULT_REPLY_TO;
  }
  return parsed.header;
}

function resolveAllowedOrigin(baseURL, mode) {
  if (mode === "file") {
    let parsed;
    try {
      parsed = new URL(baseURL);
    } catch {
      throw new Error("Invalid baseURL");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("Invalid baseURL");
    }
    if (!LOCALHOST_HOSTS.has(parsed.hostname)) {
      throw new Error("File mail is only available for localhost development");
    }
    return parsed.origin;
  }

  if (baseURL === undefined || baseURL === null || (typeof baseURL === "string" && !baseURL.trim())) {
    return DEFAULT_ORIGIN;
  }
  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error("Invalid baseURL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Invalid baseURL");
  }
  if (parsed.protocol !== "https:" && !LOCALHOST_HOSTS.has(parsed.hostname)) {
    throw new Error("Public mail links require an HTTPS origin");
  }
  return parsed.origin;
}

function validateActionUrl(url, allowedOrigin) {
  if (typeof url !== "string") {
    throw Object.assign(new Error("Invalid email action URL"), { code: "INVALID_ACTION_URL" });
  }
  const trimmed = url.trim();
  if (!trimmed || CONTROL_CHAR_RE.test(trimmed) || /\s/.test(trimmed)) {
    throw Object.assign(new Error("Invalid email action URL"), { code: "INVALID_ACTION_URL" });
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw Object.assign(new Error("Invalid email action URL"), { code: "INVALID_ACTION_URL" });
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    throw Object.assign(new Error("Invalid email action URL"), { code: "INVALID_ACTION_URL" });
  }

  if (allowedOrigin !== undefined && allowedOrigin !== null) {
    let expected;
    try {
      expected = new URL(allowedOrigin);
    } catch {
      throw Object.assign(new Error("Invalid email action URL"), { code: "INVALID_ACTION_URL" });
    }
    if (expected.protocol !== "https:" && !LOCALHOST_HOSTS.has(expected.hostname)) {
      throw Object.assign(new Error("Invalid email action URL"), { code: "INVALID_ACTION_URL" });
    }
    if (parsed.origin !== expected.origin) {
      throw Object.assign(new Error("Invalid email action URL"), { code: "INVALID_ACTION_URL" });
    }
    return parsed.href;
  }

  if (LOCALHOST_HOSTS.has(parsed.hostname)) {
    return parsed.href;
  }
  if (parsed.origin !== DEFAULT_ORIGIN) {
    throw Object.assign(new Error("Invalid email action URL"), { code: "INVALID_ACTION_URL" });
  }
  return parsed.href;
}

function resolveMessageIdDomain(from, baseURL) {
  const fromDomain = extractDomain(from);
  if (fromDomain !== "unknown" && fromDomain !== "localhost") return fromDomain;
  if (typeof baseURL === "string" && baseURL.trim()) {
    try {
      const host = normalizeHostname(new URL(baseURL).hostname);
      if (host && host !== "localhost" && !IPV4_RE.test(host)) return host;
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

function normalizeErrorCode(code) {
  return typeof code === "string" && SAFE_ERROR_CODE_RE.test(code) ? code : "MAIL_SEND_FAILED";
}

function sanitizeMessageId(rawId) {
  if (typeof rawId !== "string") return "none";
  const trimmed = rawId.trim();
  if (!trimmed) return "none";
  return GENERATED_MESSAGE_ID_RE.test(trimmed) ? trimmed : "redacted";
}

function normalizeMailKind(kind) {
  if (kind === "verify" || kind === "reset" || kind === "invite") return kind;
  return "unknown";
}

function formatMailLog({ status, kind, to, messageId, responseCode, errorCode }) {
  const parts = [
    "mail",
    `status=${status === "error" ? "error" : "sent"}`,
    `type=${normalizeMailKind(kind)}`,
    `recipient_domain=${extractDomain(to)}`,
    `message_id=${sanitizeMessageId(messageId)}`,
    `smtp_code=${typeof responseCode === "string" && /^\d{3}$/.test(responseCode) ? responseCode : "none"}`,
  ];
  if (status === "error") {
    parts.push(`error_code=${normalizeErrorCode(errorCode)}`);
  }
  return parts.join(" ");
}

function createSanitizedSendError(errorCode, smtpCode) {
  const safeCode = normalizeErrorCode(errorCode);
  const hasSmtp = typeof smtpCode === "string" && /^\d{3}$/.test(smtpCode);
  const err = new Error(
    hasSmtp
      ? `Mail delivery failed (${safeCode}, smtp=${smtpCode})`
      : `Mail delivery failed (${safeCode})`
  );
  err.code = safeCode;
  if (hasSmtp) err.responseCode = Number(smtpCode);
  return err;
}

function buildHtmlEmail({
  htmlLang,
  title,
  brandHeader,
  heading,
  intro,
  buttonLabel,
  fallbackLabel,
  url,
  quickstartHeading,
  quickstartSteps,
  reason,
  footerBrand,
  footerOperator,
  contactLabel,
  contactEmail
}) {
  const safeUrl = escapeHtml(url);
  const safeContact = escapeHtml(contactEmail);
  const quickstartBlock = Array.isArray(quickstartSteps) && quickstartSteps.length > 0
    ? [
        '<div style="margin:0 0 20px;padding:16px 18px;background-color:#F4F1EA;border:1px solid #DDD6C8;border-radius:8px;">',
        `<h2 style="margin:0 0 10px;font-size:14px;line-height:1.4;font-weight:700;color:#1F1D1A;">${escapeHtml(quickstartHeading || "")}</h2>`,
        '<ol style="margin:0;padding:0 0 0 18px;font-size:13px;line-height:1.65;color:#1F1D1A;">',
        ...quickstartSteps.map((step, idx) => {
          const margin = idx === quickstartSteps.length - 1 ? "0" : "0 0 6px";
          const titlePart = step.title ? `<strong>${escapeHtml(step.title)}</strong> ` : "";
          return `<li style="margin:${margin};">${titlePart}${escapeHtml(step.body)}</li>`;
        }),
        "</ol>",
        "</div>",
      ]
    : [];
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
    `<tr><td align="center" bgcolor="#B5462F" style="background-color:#B5462F;border-radius:8px;"><a href="${safeUrl}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:8px;">${escapeHtml(buttonLabel)}</a></td></tr>`,
    "</table>",
    `<p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#6B655C;">${escapeHtml(fallbackLabel)}</p>`,
    `<p style="margin:0 0 20px;padding:10px 12px;background-color:#F4F1EA;border:1px solid #DDD6C8;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:#1F1D1A;word-break:break-all;overflow-wrap:anywhere;">${safeUrl}</p>`,
    ...quickstartBlock,
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

function normalizeExpiresInDays(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 90) return 7;
  return n;
}

function renderEmail({ kind, url, lang, replyTo, allowedOrigin, expiresInDays = 7 } = {}) {
  const resolved = normalizeMailLang(lang);
  const validatedUrl = validateActionUrl(url, allowedOrigin);
  const contactEmail = parseSingleMailbox(replyTo)?.address || DEFAULT_REPLY_TO;

  if (kind === "invite") {
    const days = normalizeExpiresInDays(expiresInDays);
    if (resolved === "en") {
      const subject = "Lean Ritual · Your beta invitation";
      const quickstartHeading = "2-minute quick-start";
      const quickstartSteps = [
        {
          title: "Open without VPN (Mainland China):",
          body: "Open your personal invite link directly in your browser (turn off VPN if testing from Mainland China).",
        },
        {
          title: "Set password & verify email:",
          body: "Under Sign up with invite, use your invited email and an 8+ character password, verify your email (check spam/junk), then sign in and tap Build my plan.",
        },
        {
          title: "Add to Home Screen:",
          body: "iPhone Safari: Share → Add to Home Screen. Android browser menu (⋮) → Add to Home screen or Install app.",
        },
        {
          title: "Log your daily ritual:",
          body: "Record daily check-ins (weight, steps, sleep), workouts, and meals (with optional AI meal photo estimation and coach feedback).",
        },
        {
          title: "Send feedback anytime:",
          body: "Tap Me → Send feedback inside the app (never share passwords or link tokens).",
        },
      ];
      const intro = `Click the link below to activate your personal Lean Ritual beta invite. This single-use link is bound to your email address and expires in ${days} ${days === 1 ? "day" : "days"}.`;
      const reason = "You received this email because you requested a Lean Ritual beta invite with this address. If you did not request this, you can safely ignore this email and do not forward this personal invite link.";
      const text = [
        intro,
        "",
        validatedUrl,
        "",
        `${quickstartHeading}:`,
        ...quickstartSteps.map((s, idx) => `${idx + 1}. ${s.title} ${s.body}`),
        "",
        reason,
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
        heading: "You're invited to the Lean Ritual beta",
        intro: `Click the button below to activate your personal Lean Ritual beta invite. This single-use link is bound to your email address and expires in ${days} ${days === 1 ? "day" : "days"}.`,
        buttonLabel: "Accept invite & sign up",
        fallbackLabel: "If the button does not work, copy and paste this link into your browser:",
        url: validatedUrl,
        quickstartHeading,
        quickstartSteps,
        reason,
        footerBrand: `Lean Ritual · ${DEFAULT_DOMAIN}`,
        footerOperator: `Operated by ${OPERATOR_EN}`,
        contactLabel: "Contact: ",
        contactEmail,
      });

      return { lang: "en", subject, text, html };
    }

    const subject = "Lean Ritual · 你的薄肌日课内测邀请";
    const quickstartHeading = "2 分钟快速上手";
    const quickstartSteps = [
      {
        title: "直接打开链接：",
        body: "点击上方专属邀请链接在浏览器打开（中国大陆测试请先关闭 VPN）。",
      },
      {
        title: "设密码并验证邮箱：",
        body: "在「凭邀请注册」使用受邀邮箱设置 8 位以上密码，完成邮箱验证（若未收到请留意垃圾箱）后登录并点「生成我的计划」。",
      },
      {
        title: "添加到主屏幕：",
        body: "iPhone Safari 点「分享」→「添加到主屏幕」；Android 浏览器菜单「⋮」→「添加到主屏幕」或「安装应用」。",
      },
      {
        title: "开始每日记录：",
        body: "记录体重、睡眠或步数打卡、训练与饮食（支持拍照 AI 估算与反馈建议）。",
      },
      {
        title: "随时提交反馈：",
        body: "遇到问题或有建议，直接在应用内点「我的 → 意见反馈」（请勿发送密码或链接参数）。",
      },
    ];
    const intro = `请点击下方链接打开你的薄肌日课（Lean Ritual）专属内测邀请。此链接 ${days} 天内有效，仅限本邮箱单次使用。`;
    const reason = "你收到这封邮件，是因为你在 Lean Ritual（薄肌日课）提交了内测申请。如果你没有申请过，请直接忽略此邮件，也请勿转发此专属邀请链接。";
    const text = [
      intro,
      "",
      validatedUrl,
      "",
      `${quickstartHeading}：`,
      ...quickstartSteps.map((s, idx) => `${idx + 1}. ${s.title}${s.body}`),
      "",
      reason,
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
      heading: "欢迎加入 Lean Ritual（薄肌日课）内测",
      intro: `请点击下方按钮打开你的专属内测邀请链接。此链接 ${days} 天内有效，仅限本邮箱单次使用。`,
      buttonLabel: "打开专属邀请链接",
      fallbackLabel: "如果按钮无法打开，请将以下链接复制到浏览器地址栏打开：",
      url: validatedUrl,
      quickstartHeading,
      quickstartSteps,
      reason,
      footerBrand: `Lean Ritual（薄肌日课）· ${DEFAULT_DOMAIN}`,
      footerOperator: `运营者：${OPERATOR_ZH}`,
      contactLabel: "联系邮箱：",
      contactEmail,
    });

    return { lang: "zh", subject, text, html };
  }

  const reset = kind === "reset";

  if (resolved === "en") {
    const subject = reset ? "Lean Ritual · Reset your password" : "Lean Ritual · Verify your email";
    const text = [
      `${reset ? "Click the link below to reset your password" : "Click the link below to verify your email address"}:`,
      "",
      validatedUrl,
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
      url: validatedUrl,
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
    validatedUrl,
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
    url: validatedUrl,
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

function createMailer(env = process.env, { dataDir, baseURL, transport: customTransport, log = console.log, warn = console.warn } = {}) {
  const mode = env.MAIL_MODE;
  if (mode === "file") {
    const allowedOrigin = resolveAllowedOrigin(baseURL, "file");
    const replyTo = resolveReplyTo(env, { warn });
    const dir = path.join(dataDir, "mail");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const send = async message => {
      const validatedUrl = validateActionUrl(message?.url, allowedOrigin);
      const payload = message && message.lang !== undefined
        ? { ...renderEmail({ ...message, url: validatedUrl, replyTo, allowedOrigin }), ...message, url: validatedUrl, lang: normalizeMailLang(message.lang), replyTo }
        : { ...message, url: validatedUrl };
      fs.writeFileSync(path.join(dir, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.json`), JSON.stringify(payload) + "\n", { mode: 0o600, flag: "wx" });
    };
    send.sendInvitationEmail = async ({ to, url, lang, expiresInDays = 7 } = {}) => {
      if (!extractRecipientAddress(to)) {
        throw createSanitizedSendError("INVALID_RECIPIENT", "none");
      }
      return send({ to, kind: "invite", url, lang: normalizeMailLang(lang), expiresInDays });
    };
    return send;
  }
  if (mode !== "smtp") throw new Error("Set MAIL_MODE=smtp (or file for explicit localhost development)");
  for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"]) if (!env[key]) throw new Error(`${key} is required`);
  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SMTP_PORT");
  const allowedOrigin = resolveAllowedOrigin(baseURL, "smtp");
  const replyTo = resolveReplyTo(env, { warn });
  const messageIdDomain = resolveMessageIdDomain(env.MAIL_FROM, baseURL);
  const transport = customTransport || require("nodemailer").createTransport({
    host: env.SMTP_HOST, port, secure: port === 465, requireTLS: true,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  });
  const send = async ({ to, kind, url, lang, expiresInDays } = {}) => {
    const messageId = generateMessageId(messageIdDomain);
    let validatedUrl;
    try {
      validatedUrl = validateActionUrl(url, allowedOrigin);
    } catch {
      log(formatMailLog({
        status: "error",
        kind,
        to,
        messageId,
        responseCode: "none",
        errorCode: "INVALID_ACTION_URL",
      }));
      throw createSanitizedSendError("INVALID_ACTION_URL", "none");
    }
    const { subject, text, html } = renderEmail({ kind, url: validatedUrl, lang, replyTo, allowedOrigin, expiresInDays });
    // Transactional mail (verify/reset/invite) intentionally omits List-Unsubscribe
    // so inbox providers do not classify user-requested transactional mail as bulk/promotional.
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
        messageId,
        responseCode: extractSmtpResponseCode(info),
      }));
      return info;
    } catch (err) {
      const smtpCode = extractSmtpResponseCode(err);
      const errorCode = normalizeErrorCode(err?.code);
      log(formatMailLog({
        status: "error",
        kind,
        to,
        messageId,
        responseCode: smtpCode,
        errorCode,
      }));
      // Throw a sanitized error without cause so Better Auth's background-task logger
      // can never emit raw SMTP errors containing recipient addresses or server replies.
      throw createSanitizedSendError(errorCode, smtpCode);
    }
  };
  send.sendInvitationEmail = async ({ to, url, lang, expiresInDays = 7 } = {}) => {
    if (!extractRecipientAddress(to)) {
      const messageId = generateMessageId(messageIdDomain);
      log(formatMailLog({
        status: "error",
        kind: "invite",
        to,
        messageId,
        responseCode: "none",
        errorCode: "INVALID_RECIPIENT",
      }));
      throw createSanitizedSendError("INVALID_RECIPIENT", "none");
    }
    return send({ to, kind: "invite", url, lang: normalizeMailLang(lang), expiresInDays });
  };
  return send;
}

module.exports = {
  createMailer,
  renderEmail,
  normalizeMailLang,
  parseSingleMailbox,
  resolveReplyTo,
  resolveAllowedOrigin,
  validateActionUrl,
  extractDomain,
  generateMessageId,
  formatMailLog,
  DEFAULT_REPLY_TO,
  DEFAULT_ORIGIN,
};
