#!/usr/bin/env node
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { createInvitations } = require("../lib/invitations");
const { normalizePhone } = require("../lib/phone");

const USAGE = [
  "Usage:",
  "  node scripts/auth-admin.js invite <email> [--legacy-user <username>]",
  "  node scripts/auth-admin.js invite --phone <E.164 or 11-digit mainland number> [--legacy-user <username>]",
  "  node scripts/auth-admin.js reset-password --phone <E.164 or 11-digit mainland number>",
  "  node scripts/auth-admin.js revoke   (invitation token on stdin)"
].join("\n");

function readFlagValue(args, idx, flag) {
  const arg = args[idx];
  if (arg === flag) {
    if (idx + 1 >= args.length || !args[idx + 1]) throw new Error(`Expected value for ${flag}`);
    return { value: args[idx + 1], nextIdx: idx + 1 };
  }
  const value = arg.slice(flag.length + 1);
  if (!value) throw new Error(`Expected value for ${flag}`);
  return { value, nextIdx: idx };
}

function parseInviteArgs(args) {
  let email = null;
  let phone = null;
  let legacyName = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--phone" || arg.startsWith("--phone=")) {
      if (phone !== null || email !== null) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--phone");
      phone = res.value;
      i = res.nextIdx;
    } else if (arg === "--email" || arg.startsWith("--email=")) {
      if (phone !== null || email !== null) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--email");
      email = res.value;
      i = res.nextIdx;
    } else if (arg === "--legacy-user" || arg.startsWith("--legacy-user=")) {
      if (legacyName !== null) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--legacy-user");
      legacyName = res.value;
      i = res.nextIdx;
    } else if (arg.startsWith("-")) {
      throw new Error(USAGE);
    } else if (email === null && phone === null) {
      email = arg;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!email && !phone) throw new Error(USAGE);
  return { email, phone, legacyName };
}

function parseResetArgs(args) {
  let phone = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--phone" || arg.startsWith("--phone=")) {
      if (phone !== null) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--phone");
      phone = res.value;
      i = res.nextIdx;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!phone) throw new Error(USAGE);
  return { phone };
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function hasColumn(db, table, column) {
  if (!hasTable(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

// Operators issue an invitation or a one-time password reset link, never set a
// user's permanent password or mark an email verified.
function main() {
  const [command, ...rest] = process.argv.slice(2);
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
  if (!["invite", "revoke", "reset-password"].includes(command)) throw new Error(USAGE);
  fs.mkdirSync(dataDir, { recursive: true });
  const releaseDataAccess = require("../lib/data-access").shared(dataDir);
  process.once("exit", releaseDataAccess);
  const db = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    if (command === "revoke") {
      if (rest.length) throw new Error(USAGE);
      const invitations = createInvitations(db);
      const token = fs.readFileSync(0, "utf8").trim();
      if (!token) throw new Error("Provide invitation token on stdin");
      invitations.revoke(token);
      console.log("Invitation revoked");
      return;
    }
    if (command === "reset-password") {
      const { phone: rawPhone } = parseResetArgs(rest);
      const phone = normalizePhone(rawPhone);
      if (!phone) throw new Error("A valid phone number is required (E.164 or 11-digit mainland China number)");
      if (!hasTable(db, "user") || !hasColumn(db, "user", "phoneNumber") || !hasTable(db, "verification")) {
        throw new Error("Phone account not found");
      }
      const user = db.prepare("SELECT id, phoneNumber FROM user WHERE phoneNumber = ?").get(phone);
      if (!user) throw new Error("Phone account not found");
      const token = crypto.randomBytes(32).toString("base64url");
      const verificationId = crypto.randomBytes(16).toString("base64url");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      db.exec("BEGIN IMMEDIATE");
      try {
        // Re-verify account still exists inside the write transaction and invalidate older reset links.
        if (!db.prepare("SELECT 1 FROM user WHERE id = ? AND phoneNumber = ?").get(user.id, phone)) {
          throw new Error("Phone account not found");
        }
        db.prepare("DELETE FROM verification WHERE value = ? AND identifier LIKE 'reset-password:%'").run(user.id);
        db.prepare("INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
          .run(verificationId, `reset-password:${token}`, user.id, expiresAt.toISOString(), now.toISOString(), now.toISOString());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const out = { phone: user.phoneNumber, userId: user.id, token, expiresAt: expiresAt.toISOString() };
      if (process.env.AUTH_BASE_URL) {
        const url = new URL("/login.html", process.env.AUTH_BASE_URL);
        url.searchParams.set("token", token);
        url.searchParams.set("method", "phone");
        out.url = url.href;
      }
      console.error(
        "OPERATOR REMINDER: Confirm the requester's identity out-of-band before sharing this reset link " +
        "(call back the registered phone number or confirm directly with the original inviter). " +
        "Send the link only via a previously established private channel—never to an unverified account or group chat. " +
        "Deny recovery if identity cannot be verified."
      );
      console.log(JSON.stringify(out));
      return;
    }

    const { email, phone, legacyName } = parseInviteArgs(rest);
    const invitations = createInvitations(db);
    let userId;
    if (legacyName) {
      const legacy = new DatabaseSync(path.join(dataDir, "bojin.db"), { readOnly: true });
      try { userId = legacy.prepare("SELECT id FROM users WHERE username = ?").get(legacyName.trim().toLowerCase())?.id; }
      finally { legacy.close(); }
      if (!userId) throw new Error("Legacy user not found");
    }
    const invite = phone
      ? invitations.issuePhone(phone, { userId })
      : invitations.issue(email, { userId });
    if (process.env.AUTH_BASE_URL) {
      const url = new URL("/login.html", process.env.AUTH_BASE_URL);
      url.searchParams.set("invite", invite.token);
      if (invite.phone) url.searchParams.set("phone", invite.phone);
      else url.searchParams.set("email", invite.email);
      invite.url = url.href;
    }
    console.log(JSON.stringify(invite));
  } finally { db.close(); releaseDataAccess(); }
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
