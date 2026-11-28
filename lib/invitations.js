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
    expires INTEGER NOT NULL, consumed INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER, source_request_id TEXT, delivery_state TEXT
  );`);
  if (
    !hasColumn(db, "launch_invites", "phone")
    || !hasColumn(db, "launch_invites", "created_at")
    || !hasColumn(db, "launch_invites", "source_request_id")
    || !hasColumn(db, "launch_invites", "delivery_state")
  ) {
    let inTx = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      inTx = true;
      if (!hasColumn(db, "launch_invites", "phone")) {
        db.exec("ALTER TABLE launch_invites ADD COLUMN phone TEXT");
      }
      if (!hasColumn(db, "launch_invites", "created_at")) {
        db.exec("ALTER TABLE launch_invites ADD COLUMN created_at INTEGER");
      }
      if (!hasColumn(db, "launch_invites", "source_request_id")) {
        db.exec("ALTER TABLE launch_invites ADD COLUMN source_request_id TEXT");
      }
      if (!hasColumn(db, "launch_invites", "delivery_state")) {
        db.exec("ALTER TABLE launch_invites ADD COLUMN delivery_state TEXT");
      }
      db.exec("COMMIT");
      inTx = false;
    } catch (err) {
      if (inTx) {
        try { db.exec("ROLLBACK"); } catch {}
      }
      throw err;
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS launch_invites_phone ON launch_invites(phone);");
  db.exec("CREATE INDEX IF NOT EXISTS launch_invites_email ON launch_invites(email);");
  return {
    issue(email, { expiresInDays = 7, userId } = {}) {
      email = normalizeEmail(email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || isSyntheticPhoneEmail(email)) throw new Error("A valid invitation email is required");
      if (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > 90) throw new Error("Invitation lifetime must be 1–90 days");
      if (userId !== undefined && !/^u_[A-Za-z0-9_-]+$/.test(userId)) throw new Error("Invalid user ID");
      const token = crypto.randomBytes(32).toString("base64url");
      const issuedAt = Date.now();
      let uid = userId || null;
      db.exec("BEGIN IMMEDIATE");
      try {
        // Preserve a stable UID across every reissue for the same email (including
        // explicit --legacy-user calls) so deletion-ledger replay erases pre-reissue snapshots.
        const prior = db.prepare("SELECT userId FROM launch_invites WHERE email = ? AND phone IS NULL AND consumed IS NULL ORDER BY rowid ASC LIMIT 1").get(email);
        if (prior?.userId && /^u_[A-Za-z0-9_-]+$/.test(prior.userId)) {
          if (uid && uid !== prior.userId) {
            throw new Error("Email already has an invitation bound to a different user ID");
          }
          uid = prior.userId;
        } else if (!uid) {
          uid = "u_" + crypto.randomBytes(16).toString("base64url");
        }
        if (db.prepare("SELECT 1 FROM launch_invites WHERE (email = ? OR userId = ?) AND consumed IS NOT NULL").get(email, uid)) throw new Error("Account already registered; use password reset");
        if (hasTable(db, "user")
          && db.prepare("SELECT 1 FROM user WHERE lower(trim(email)) = ? OR id = ?").get(email, uid)) throw new Error("Account already registered; use password reset");
        // Reissuing also invalidates any older unconsumed link for this identity.
        db.prepare("UPDATE launch_invites SET revoked=1 WHERE (email=? OR userId=?) AND consumed IS NULL").run(email, uid);
        db.prepare("INSERT INTO launch_invites(tokenHash,email,phone,userId,expires,created_at,source_request_id,delivery_state) VALUES(?,?,NULL,?,?,?,NULL,'delivered')")
          .run(digest(token), email, uid, issuedAt + expiresInDays * 864e5, issuedAt);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { token, email, userId: uid };
    },
    issuePhone(rawPhone, { expiresInDays = 7, userId } = {}) {
      const phone = normalizePhone(rawPhone);
      if (!phone) throw new Error("A valid invitation phone number is required (E.164 or 11-digit mainland China number)");
      if (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > 90) throw new Error("Invitation lifetime must be 1–90 days");
      if (userId !== undefined && !/^u_[A-Za-z0-9_-]+$/.test(userId)) throw new Error("Invalid user ID");
      const token = crypto.randomBytes(32).toString("base64url");
      const issuedAt = Date.now();
      let uid = userId || null;
      db.exec("BEGIN IMMEDIATE");
      try {
        // Preserve a stable UID across every reissue for the same phone (including
        // explicit --legacy-user calls) so deletion-ledger replay erases pre-reissue snapshots.
        const prior = db.prepare("SELECT userId FROM launch_invites WHERE phone = ? AND consumed IS NULL ORDER BY rowid ASC LIMIT 1").get(phone);
        if (prior?.userId && /^u_[A-Za-z0-9_-]+$/.test(prior.userId)) {
          if (uid && uid !== prior.userId) {
            throw new Error("Phone number already has an invitation bound to a different user ID");
          }
          uid = prior.userId;
        } else if (!uid) {
          uid = "u_" + crypto.randomBytes(16).toString("base64url");
        }
        if (db.prepare("SELECT 1 FROM launch_invites WHERE (phone = ? OR userId = ?) AND consumed IS NOT NULL").get(phone, uid)) throw new Error("Account already registered; use password reset");
        if (hasTable(db, "user")) {
          const exists = hasColumn(db, "user", "phoneNumber")
            ? db.prepare("SELECT 1 FROM user WHERE phoneNumber = ? OR id = ?").get(phone, uid)
            : db.prepare("SELECT 1 FROM user WHERE id = ?").get(uid);
          if (exists) throw new Error("Account already registered; use password reset");
        }
        // Reissuing also invalidates any older unconsumed link for this identity.
        db.prepare("UPDATE launch_invites SET revoked=1 WHERE (phone=? OR userId=?) AND consumed IS NULL").run(phone, uid);
        db.prepare("INSERT INTO launch_invites(tokenHash,email,phone,userId,expires,created_at,source_request_id,delivery_state) VALUES(?,'',?,?,?,?,NULL,'delivered')")
          .run(digest(token), phone, uid, issuedAt + expiresInDays * 864e5, issuedAt);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { token, phone, userId: uid };
    },
    // Atomically checks existing registration, preserves any delivered active invite,
    // prevents competing workers from treating in-flight reservations as delivered,
    // recovers pre-SMTP orphaned reservations for the same requestId without leaking spots,
    // enforces beta spot capacity (user count + active unused invites < maxSpots), and
    // inserts a new email-bound reservation inside a single BEGIN IMMEDIATE transaction.
    reserveEmailForFulfillment(email, { expiresInDays = 7, maxSpots, requestId = null, nowMs = Date.now() } = {}) {
      email = normalizeEmail(email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || isSyntheticPhoneEmail(email)) {
        throw new Error("A valid invitation email is required");
      }
      if (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > 90) {
        throw new Error("Invitation lifetime must be 1–90 days");
      }
      if (!Number.isSafeInteger(maxSpots) || maxSpots < 1) {
        throw new Error("maxSpots must be a positive integer");
      }
      const normalizedRequestId = typeof requestId === "string" && requestId.trim() ? requestId.trim() : null;
      const token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = digest(token);
      let inTx = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        inTx = true;

        const prior = db.prepare(
          "SELECT userId FROM launch_invites WHERE email = ? AND phone IS NULL AND consumed IS NULL ORDER BY rowid ASC LIMIT 1"
        ).get(email);
        const uid = prior?.userId && /^u_[A-Za-z0-9_-]+$/.test(prior.userId)
          ? prior.userId
          : "u_" + crypto.randomBytes(16).toString("base64url");

        const userTableExists = hasTable(db, "user");
        const alreadyConsumed = db.prepare(
          "SELECT 1 FROM launch_invites WHERE (email = ? OR userId = ?) AND consumed IS NOT NULL LIMIT 1"
        ).get(email, uid);
        const alreadyUser = userTableExists
          ? db.prepare("SELECT 1 FROM user WHERE lower(trim(email)) = ? OR id = ? LIMIT 1").get(email, uid)
          : null;
        if (alreadyConsumed || alreadyUser) {
          db.exec("COMMIT");
          inTx = false;
          return { outcome: "already_registered" };
        }

        const existingActives = db.prepare(
          "SELECT tokenHash, userId, expires, source_request_id, delivery_state FROM launch_invites WHERE (email = ? OR userId = ?) AND phone IS NULL AND consumed IS NULL AND revoked = 0 AND expires > ? ORDER BY rowid DESC"
        ).all(email, uid, nowMs);

        if (existingActives.length > 0) {
          // Legacy rows (delivery_state IS NULL) and manually issued/delivered invites are already delivered.
          const delivered = existingActives.find(r => r.delivery_state === null || r.delivery_state === "delivered");
          if (delivered) {
            db.exec("COMMIT");
            inTx = false;
            return {
              outcome: "already_invited",
              userId: delivered.userId,
              tokenHash: delivered.tokenHash,
              expires: delivered.expires
            };
          }

          // Any invite already handed to SMTP (delivery_state === 'sending') must NEVER be rotated/revoked.
          const sendingRow = existingActives.find(r => r.delivery_state === "sending");
          if (sendingRow) {
            db.exec("COMMIT");
            inTx = false;
            if (normalizedRequestId && sendingRow.source_request_id === normalizedRequestId) {
              return {
                outcome: "delivery_uncertain",
                userId: sendingRow.userId,
                tokenHash: sendingRow.tokenHash,
                expires: sendingRow.expires
              };
            }
            return {
              outcome: "in_flight",
              userId: sendingRow.userId,
              tokenHash: sendingRow.tokenHash,
              expires: sendingRow.expires
            };
          }

          // Any pre-SMTP reservation owned by a DIFFERENT request (or unknown owner) is in-flight;
          // never mark a competing request 'invited' before SMTP actually accepts delivery.
          const foreignReserved = existingActives.find(
            r => r.delivery_state === "reserved" && (!normalizedRequestId || r.source_request_id !== normalizedRequestId)
          );
          if (foreignReserved) {
            db.exec("COMMIT");
            inTx = false;
            return {
              outcome: "in_flight",
              userId: foreignReserved.userId,
              tokenHash: foreignReserved.tokenHash,
              expires: foreignReserved.expires
            };
          }

          // Fail closed on any unrecognized delivery_state.
          const unknownState = existingActives.find(r => r.delivery_state !== "reserved");
          if (unknownState) {
            db.exec("COMMIT");
            inTx = false;
            return {
              outcome: "delivery_uncertain",
              userId: unknownState.userId,
              tokenHash: unknownState.tokenHash,
              expires: unknownState.expires
            };
          }

          // Remaining active rows are pre-SMTP orphaned reservations for this exact requestId
          // (e.g., process crashed after auth.sqlite commit and before SMTP handoff).
          // Revoke them inside the same transaction so no beta spot is leaked and issue a fresh token.
          db.prepare(
            "UPDATE launch_invites SET revoked = 1 WHERE (email = ? OR userId = ?) AND phone IS NULL AND consumed IS NULL AND revoked = 0 AND source_request_id = ? AND delivery_state = 'reserved'"
          ).run(email, uid, normalizedRequestId);
        }

        const registeredUsers = userTableExists
          ? Number(db.prepare("SELECT COUNT(*) AS n FROM user").get()?.n || 0)
          : 0;
        const activeUnusedInvites = Number(
          db.prepare("SELECT COUNT(*) AS n FROM launch_invites WHERE consumed IS NULL AND revoked = 0 AND expires > ?")
            .get(nowMs)?.n || 0
        );
        const spotsUsed = registeredUsers + activeUnusedInvites;
        if (spotsUsed >= maxSpots) {
          db.exec("COMMIT");
          inTx = false;
          return { outcome: "cap_reached", spotsUsed };
        }

        const expires = nowMs + expiresInDays * 864e5;
        db.prepare(
          "INSERT INTO launch_invites(tokenHash,email,phone,userId,expires,created_at,source_request_id,delivery_state) VALUES(?,?,NULL,?,?,?,?,?)"
        ).run(tokenHash, email, uid, expires, nowMs, normalizedRequestId, "reserved");
        db.exec("COMMIT");
        inTx = false;
        return {
          outcome: "reserved",
          token,
          tokenHash,
          email,
          userId: uid,
          expires,
          spotsUsed: spotsUsed + 1
        };
      } catch (error) {
        if (inTx) {
          try { db.exec("ROLLBACK"); } catch {}
        }
        throw error;
      }
    },
    markDeliverySending(token) {
      return db.prepare(
        "UPDATE launch_invites SET delivery_state = 'sending' WHERE tokenHash = ? AND consumed IS NULL AND revoked = 0 AND delivery_state = 'reserved'"
      ).run(digest(token));
    },
    markDeliveryDelivered(token) {
      return db.prepare(
        "UPDATE launch_invites SET delivery_state = 'delivered' WHERE tokenHash = ? AND revoked = 0 AND delivery_state IN ('reserved', 'sending')"
      ).run(digest(token));
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
    revoke(token) {
      return db.prepare("UPDATE launch_invites SET revoked = 1 WHERE tokenHash = ? AND consumed IS NULL").run(digest(token));
    },
  };
}
module.exports = { createInvitations, normalizeEmail, normalizePhone };
