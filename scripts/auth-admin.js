#!/usr/bin/env node
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { createInvitations } = require("../lib/invitations");

// Operators issue an invitation, never set a user's permanent password or mark
// an email verified. A legacy account must prove ownership of its invited email.
function main() {
  const [command, email, legacyFlag, legacyName] = process.argv.slice(2);
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
  if (!["invite", "revoke"].includes(command)) throw new Error("Usage: node scripts/auth-admin.js invite <email> [--legacy-user <username>] | revoke (token on stdin)");
  fs.mkdirSync(dataDir, { recursive: true });
  const releaseDataAccess = require("../lib/data-access").shared(dataDir);
  process.once("exit", releaseDataAccess);
  const db = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const invitations = createInvitations(db);
    if (command === "revoke") { const token = fs.readFileSync(0, "utf8").trim(); if (!token) throw new Error("Provide invitation token on stdin"); invitations.revoke(token); console.log("Invitation revoked"); return; }
    let userId;
    if (legacyFlag) {
      if (legacyFlag !== "--legacy-user" || !legacyName) throw new Error("Expected --legacy-user <username>");
      const legacy = new DatabaseSync(path.join(dataDir, "bojin.db"), { readOnly: true });
      try { userId = legacy.prepare("SELECT id FROM users WHERE username = ?").get(legacyName.trim().toLowerCase())?.id; }
      finally { legacy.close(); }
      if (!userId) throw new Error("Legacy user not found");
    }
    const invite = invitations.issue(email, { userId });
    if (process.env.AUTH_BASE_URL) {
      const url = new URL("/login.html", process.env.AUTH_BASE_URL);
      url.searchParams.set("invite", invite.token);
      url.searchParams.set("email", invite.email);
      invite.url = url.href;
    }
    console.log(JSON.stringify(invite));
  } finally { db.close(); releaseDataAccess(); }
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
