"use strict";
const crypto = require("node:crypto");
const { normalizePhone, isSyntheticPhoneEmail } = require("./phone");
const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const normalizeEmail = email => String(email || "").trim().toLowerCase();

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function hasColumn(db, table, column) {
  if (!hasTable(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

// Uses the SAME connection as Better Auth: claims participate in its signup
// transaction, so failed account creation releases the invite. Better Auth catches
// mail delivery failures; users can resend verification without consuming another invite.
function createInvitations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS launch_invites (
    tokenHash TEXT PRIMARY KEY, email TEXT NOT NULL, phone TEXT, userId TEXT NOT NULL,
    expires INTEGER NOT NULL, consumed INTEGER, revoked INTEGER NOT NULL DEFAULT 0
  );`);
  if (!hasColumn(db, "launch_invites", "phone")) {
    db.exec("ALTER TABLE launch_invites ADD COLUMN phone TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS launch_invites_phone ON launch_invites(phone);");
  return {
    issue(email, { expiresInDays = 7, userId } = {}) {
      email = normalizeEmail(email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || isSyntheticPhoneEmail(email)) throw new Error("A valid invitation email is required");
      if (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > 90) throw new Error("Invitation lifetime must be 1–90 days");
      const token = crypto.randomBytes(32).toString("base64url");
      const uid = userId || "u_" + crypto.randomBytes(16).toString("base64url");
      if (!/^u_[A-Za-z0-9_-]+$/.test(uid)) throw new Error("Invalid user ID");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (db.prepare("SELECT 1 FROM launch_invites WHERE (email = ? OR userId = ?) AND consumed IS NOT NULL").get(email, uid)) throw new Error("Account already registered; use password reset");
        if (hasTable(db, "user")
          && db.prepare("SELECT 1 FROM user WHERE email = ? OR id = ?").get(email, uid)) throw new Error("Account already registered; use password reset");
        // Reissuing also invalidates any older unconsumed link for this identity.
        db.prepare("UPDATE launch_invites SET revoked=1 WHERE (email=? OR userId=?) AND consumed IS NULL").run(email, uid);
        db.prepare("INSERT INTO launch_invites(tokenHash,email,phone,userId,expires) VALUES(?,?,NULL,?,?)")
          .run(digest(token), email, uid, Date.now() + expiresInDays * 864e5);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { token, email, userId: uid };
    },
    issuePhone(rawPhone, { expiresInDays = 7, userId } = {}) {
      const phone = normalizePhone(rawPhone);
      if (!phone) throw new Error("A valid invitation phone number is required (E.164 or 11-digit mainland China number)");
      if (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > 90) throw new Error("Invitation lifetime must be 1–90 days");
      const token = crypto.randomBytes(32).toString("base64url");
      const uid = userId || "u_" + crypto.randomBytes(16).toString("base64url");
      if (!/^u_[A-Za-z0-9_-]+$/.test(uid)) throw new Error("Invalid user ID");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (db.prepare("SELECT 1 FROM launch_invites WHERE (phone = ? OR userId = ?) AND consumed IS NOT NULL").get(phone, uid)) throw new Error("Account already registered; use password reset");
        if (hasTable(db, "user")) {
          const exists = hasColumn(db, "user", "phoneNumber")
            ? db.prepare("SELECT 1 FROM user WHERE phoneNumber = ? OR id = ?").get(phone, uid)
            : db.prepare("SELECT 1 FROM user WHERE id = ?").get(uid);
          if (exists) throw new Error("Account already registered; use password reset");
        }
        // Reissuing also invalidates any older unconsumed link for this identity.
        db.prepare("UPDATE launch_invites SET revoked=1 WHERE (phone=? OR userId=?) AND consumed IS NULL").run(phone, uid);
        db.prepare("INSERT INTO launch_invites(tokenHash,email,phone,userId,expires) VALUES(?,'',?,?,?)")
          .run(digest(token), phone, uid, Date.now() + expiresInDays * 864e5);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { token, phone, userId: uid };
    },
    claim(token, email) {
      const norm = normalizeEmail(email);
      if (!norm) return null;
      const now = Date.now();
      const row = db.prepare(`UPDATE launch_invites SET consumed = ?
        WHERE tokenHash = ? AND email = ? AND phone IS NULL AND consumed IS NULL AND revoked = 0 AND expires > ?
        RETURNING userId`).get(now, digest(token || ""), norm, now);
      return row?.userId || null;
    },
    claimPhone(token, rawPhone) {
      const phone = normalizePhone(rawPhone);
      if (!phone) return null;
      const now = Date.now();
      const row = db.prepare(`UPDATE launch_invites SET consumed = ?
        WHERE tokenHash = ? AND phone = ? AND consumed IS NULL AND revoked = 0 AND expires > ?
        RETURNING userId`).get(now, digest(token || ""), phone, now);
      return row?.userId || null;
    },
    revoke(token) { db.prepare("UPDATE launch_invites SET revoked = 1 WHERE tokenHash = ?").run(digest(token)); },
  };
}
module.exports = { createInvitations, normalizeEmail, normalizePhone };
