"use strict";
const crypto = require("node:crypto");

const SYNTHETIC_PHONE_EMAIL_DOMAIN = "@phone.leanritual.invalid";
// One rule for the server and the sign-in page: normalizePhone lives in public/site/phone-rules.js,
// which login.html also loads. It is unchanged from the version that used to live here.
const { normalizePhone } = require("../public/site/phone-rules.js");

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
