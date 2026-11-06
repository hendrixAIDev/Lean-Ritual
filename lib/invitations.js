"use strict";
const crypto = require("node:crypto");
const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const normalizeEmail = email => String(email || "").trim().toLowerCase();

// Uses the SAME connection as Better Auth: claims participate in its signup
// transaction, so failed account creation releases the invite. Better Auth catches
// mail delivery failures; users can resend verification without consuming another invite.
function createInvitations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS launch_invites (
    tokenHash TEXT PRIMARY KEY, email TEXT NOT NULL, userId TEXT NOT NULL,
    expires INTEGER NOT NULL, consumed INTEGER, revoked INTEGER NOT NULL DEFAULT 0
  );`);
  return {
    issue(email, { expiresInDays = 7, userId } = {}) {
      email = normalizeEmail(email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid invitation email is required");
      if (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > 90) throw new Error("Invitation lifetime must be 1–90 days");
      const token = crypto.randomBytes(32).toString("base64url");
      const uid = userId || "u_" + crypto.randomBytes(16).toString("base64url");
      if (!/^u_[A-Za-z0-9_-]+$/.test(uid)) throw new Error("Invalid user ID");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (db.prepare("SELECT 1 FROM launch_invites WHERE (email = ? OR userId = ?) AND consumed IS NOT NULL").get(email, uid)) throw new Error("Account already registered; use password reset");
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user'").get()
          && db.prepare("SELECT 1 FROM user WHERE email = ? OR id = ?").get(email, uid)) throw new Error("Account already registered; use password reset");
        // Reissuing also invalidates any older unconsumed link for this identity.
        db.prepare("UPDATE launch_invites SET revoked=1 WHERE (email=? OR userId=?) AND consumed IS NULL").run(email, uid);
        db.prepare("INSERT INTO launch_invites(tokenHash,email,userId,expires) VALUES(?,?,?,?)")
          .run(digest(token), email, uid, Date.now() + expiresInDays * 864e5);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { token, email, userId: uid };
    },
    claim(token, email) {
      const row = db.prepare(`UPDATE launch_invites SET consumed = ?
        WHERE tokenHash = ? AND email = ? AND consumed IS NULL AND revoked = 0 AND expires > ?
        RETURNING userId`).get(Date.now(), digest(token || ""), normalizeEmail(email), Date.now());
      return row?.userId || null;
    },
    revoke(token) { db.prepare("UPDATE launch_invites SET revoked = 1 WHERE tokenHash = ?").run(digest(token)); },
  };
}
module.exports = { createInvitations, normalizeEmail };
