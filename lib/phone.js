"use strict";
const crypto = require("node:crypto");

const SYNTHETIC_PHONE_EMAIL_DOMAIN = "@phone.leanritual.invalid";
const MAINLAND_MOBILE_RE = /^1[3-9]\d{9}$/;
const MAINLAND_E164_RE = /^\+861[3-9]\d{9}$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;

function toAsciiPhoneChars(raw) {
  return String(raw).replace(/[\uFF10-\uFF19]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\uFF0B/g, "+");
}

/**
 * Normalize a phone number to E.164 format.
 * - Strips spaces, hyphens, parentheses, dots, and converts full-width digits/plus.
 * - Defaults 11-digit mainland China mobile numbers (1[3-9]xxxxxxxxx) to +86.
 * - Converts 00<country><number> international dialing prefix to +<country><number>.
 * - Validates E.164 (+[1-9] followed by 6–14 more digits, 7–15 digits total)
 *   and enforces 11-digit mainland mobile structure for +86 numbers.
 * Returns normalized E.164 string, or null if invalid.
 */
function normalizePhone(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = toAsciiPhoneChars(raw).replace(/[\s\-().\u00A0\u3000]/g, "");
  if (!cleaned) return null;

  let candidate;
  if (MAINLAND_MOBILE_RE.test(cleaned)) {
    candidate = "+86" + cleaned;
  } else if (/^00[1-9]\d{6,14}$/.test(cleaned)) {
    candidate = "+" + cleaned.slice(2);
  } else {
    candidate = cleaned;
  }

  if (!E164_RE.test(candidate)) return null;
  if (candidate.startsWith("+86") && !MAINLAND_E164_RE.test(candidate)) return null;
  return candidate;
}

function isValidE164(value) {
  return typeof value === "string" && normalizePhone(value) === value;
}

function syntheticPhoneEmail(userId) {
  const hash = crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);
  return `phone-${hash}${SYNTHETIC_PHONE_EMAIL_DOMAIN}`;
}

function isSyntheticPhoneEmail(email) {
  return typeof email === "string" && email.trim().toLowerCase().endsWith(SYNTHETIC_PHONE_EMAIL_DOMAIN);
}

module.exports = {
  SYNTHETIC_PHONE_EMAIL_DOMAIN,
  normalizePhone,
  isValidE164,
  syntheticPhoneEmail,
  isSyntheticPhoneEmail,
};
