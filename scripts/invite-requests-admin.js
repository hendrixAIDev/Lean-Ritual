#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { normalizeEmail } = require("../lib/invitations");
const { normalizePhone } = require("../lib/phone");
const {
  ALLOWED_STATUSES,
  DEFAULT_RETENTION_DAYS,
  inviteRequestOptions,
  sanitizeStatusNote,
  pruneInviteRequestData
} = require("../lib/invite-requests");

const USAGE = [
  "Usage: node scripts/invite-requests-admin.js",
  "  [list [--status pending|invited|dismissed|all] [--limit N] [--json]]",
  "  | show <id> [--json]",
  "  | mark <id> --status invited|dismissed|pending [--note <short-reason>] [--json]",
  "  | delete (<id> | --contact <email-or-phone>) [--json]",
  "  | prune [--days N] [--json]"
].join(" ");

const LIST_STATUSES = new Set(["pending", "invited", "dismissed", "all"]);
const COMMANDS = new Set(["list", "show", "mark", "delete", "prune"]);

function parseContactTarget(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("--contact requires an email address or phone number");
  }
  if (raw.includes("@")) {
    const email = normalizeEmail(raw);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Invalid --contact email address");
    }
    return { contactKind: "email", contactValue: email };
  }
  const phone = normalizePhone(raw);
  if (!phone) {
    throw new Error("Invalid --contact phone number (use E.164 or 11-digit mainland China mobile)");
  }
  return { contactKind: "phone", contactValue: phone };
}

function parseArgs(argv, env = process.env) {
  let command = "list";
  let targetId = null;
  let contact = null;
  let limit = 20;
  let days = null;
  let status = null;
  let note = undefined;
  let json = false;
  let i = 0;

  if (argv[0] && COMMANDS.has(argv[0])) {
    command = argv[0];
    i = 1;
    if (command === "show" || command === "mark") {
      if (!argv[1] || argv[1].startsWith("-")) throw new Error(USAGE);
      targetId = argv[1];
      i = 2;
    } else if (command === "delete" && argv[1] && !argv[1].startsWith("-")) {
      targetId = argv[1];
      i = 2;
    }
  }

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      if (command !== "list") throw new Error(USAGE);
      const raw = arg === "--limit" ? argv[++i] : arg.slice("--limit=".length);
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 1 || n > 200) {
        throw new Error("--limit must be an integer between 1 and 200");
      }
      limit = n;
    } else if (arg === "--status" || arg.startsWith("--status=")) {
      if (command !== "list" && command !== "mark") throw new Error(USAGE);
      const raw = (arg === "--status" ? argv[++i] : arg.slice("--status=".length) || "").trim().toLowerCase();
      const allowed = command === "mark" ? ALLOWED_STATUSES : LIST_STATUSES;
      if (!allowed.has(raw)) {
        throw new Error(
          command === "mark"
            ? "--status must be invited, dismissed, or pending"
            : "--status must be pending, invited, dismissed, or all"
        );
      }
      status = raw;
    } else if (arg === "--note" || arg.startsWith("--note=")) {
      if (command !== "mark") throw new Error(USAGE);
      const raw = arg === "--note" ? argv[++i] : arg.slice("--note=".length);
      if (raw === undefined) throw new Error("--note requires a value");
      note = sanitizeStatusNote(raw);
    } else if (arg === "--contact" || arg.startsWith("--contact=")) {
      if (command !== "delete") throw new Error(USAGE);
      const raw = arg === "--contact" ? argv[++i] : arg.slice("--contact=".length);
      contact = parseContactTarget(raw);
    } else if (arg === "--days" || arg.startsWith("--days=")) {
      if (command !== "prune") throw new Error(USAGE);
      const raw = arg === "--days" ? argv[++i] : arg.slice("--days=".length);
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 1 || n > 3650) {
        throw new Error("--days must be an integer between 1 and 3650");
      }
      days = n;
    } else {
      throw new Error(USAGE);
    }
  }

  if (command === "mark" && !status) {
    throw new Error("mark requires --status invited|dismissed|pending");
  }
  if (command === "delete") {
    if ((targetId && contact) || (!targetId && !contact)) {
      throw new Error("delete requires either <id> or --contact <email-or-phone>");
    }
  }
  if (command === "prune" && days === null) {
    days = inviteRequestOptions(env).retentionDays || DEFAULT_RETENTION_DAYS;
  }
  if (command === "list" && !status) {
    status = "all";
  }

  return { command, targetId, contact, limit, days, status, note, json };
}

function hydrateRow(row) {
  return {
    id: row.id,
    name: row.name,
    contactKind: row.contact_kind,
    contactValue: row.contact_value,
    goal: row.goal,
    note: row.note || "",
    lang: row.lang || "zh",
    status: row.status,
    statusNote: row.status_note || "",
    created: row.created,
    updated: row.updated
  };
}

const TERMINAL_UNSAFE_INLINE_RE = /[\x00-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;
const TERMINAL_UNSAFE_MULTILINE_RE = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;

function escapeTerminalChar(ch) {
  const code = ch.charCodeAt(0);
  return code < 0x100
    ? `\\x${code.toString(16).padStart(2, "0")}`
    : `\\u${code.toString(16).padStart(4, "0")}`;
}

function escapeTerminalText(value, { allowNewlines = false } = {}) {
  const str = String(value ?? "").replace(/\r\n?/g, "\n");
  const re = allowNewlines ? TERMINAL_UNSAFE_MULTILINE_RE : TERMINAL_UNSAFE_INLINE_RE;
  return str.replace(re, escapeTerminalChar);
}

function formatListText(items) {
  if (!items.length) return "No invite requests found.";
  return items.map(item => {
    const meta = [
      escapeTerminalText(item.created),
      escapeTerminalText(item.id),
      `[${escapeTerminalText(item.status)}]`,
      `${escapeTerminalText(item.contactKind)}=${escapeTerminalText(item.contactValue)}`,
      `name=${escapeTerminalText(item.name)}`,
      `lang=${escapeTerminalText(item.lang)}`
    ];
    if (item.statusNote) meta.push(`statusNote=${escapeTerminalText(item.statusNote)}`);
    const goal = escapeTerminalText(item.goal || "", { allowNewlines: true }).replace(/\n/g, "\n  ");
    const lines = [`${meta.join("  ")}\n  ${goal}`];
    if (item.note) {
      const extra = escapeTerminalText(item.note, { allowNewlines: true }).replace(/\n/g, "\n  ");
      lines.push(`  note: ${extra}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

function formatShowText(item) {
  const lines = [
    `ID:          ${escapeTerminalText(item.id)}`,
    `Status:      ${escapeTerminalText(item.status)}`,
    `Created:     ${escapeTerminalText(item.created)}`,
    `Updated:     ${escapeTerminalText(item.updated)}`,
    `Name:        ${escapeTerminalText(item.name)}`,
    `Contact:     ${escapeTerminalText(item.contactKind)}:${escapeTerminalText(item.contactValue)}`,
    `Language:    ${escapeTerminalText(item.lang)}`,
    `Status Note: ${item.statusNote ? escapeTerminalText(item.statusNote) : "(none)"}`,
    "",
    "Goal:",
    escapeTerminalText(item.goal || "", { allowNewlines: true })
  ];
  if (item.note) {
    lines.push("", "Note:", escapeTerminalText(item.note, { allowNewlines: true }));
  }
  return lines.join("\n");
}

const SELECT_COLS = "id, name, contact_kind, contact_value, goal, note, lang, status, status_note, created, updated";

function main() {
  const opts = parseArgs(process.argv.slice(2), process.env);
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
  const dbPath = path.join(dataDir, "bojin.db");

  if (!fs.existsSync(dbPath)) {
    if (opts.command === "show" || opts.command === "mark" || opts.command === "delete") {
      throw new Error(`Invite request not found: ${opts.targetId || "(matching contact)"}`);
    }
    if (opts.command === "prune") {
      const out = { ok: true, deletedRequests: 0, deletedRateLimits: 0 };
      console.log(opts.json ? JSON.stringify(out, null, 2) : "Pruned 0 expired invite requests and 0 rate-limit buckets.");
      return;
    }
    console.log(opts.json ? "[]" : "No invite requests found.");
    return;
  }

  const releaseDataAccess = require("../lib/data-access").shared(dataDir);
  process.once("exit", releaseDataAccess);
  const isMutating = opts.command === "mark" || opts.command === "delete" || opts.command === "prune";
  const db = new DatabaseSync(dbPath, { readOnly: !isMutating });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (opts.command === "prune") {
      const result = pruneInviteRequestData(db, { retentionDays: opts.days });
      const out = { ok: true, ...result };
      console.log(
        opts.json
          ? JSON.stringify(out, null, 2)
          : `Pruned ${result.deletedRequests} expired invite request(s) and ${result.deletedRateLimits} expired rate-limit bucket(s) (cutoff ${result.cutoffIso}).`
      );
      return;
    }

    const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'invite_requests'").get();
    if (!hasTable) {
      if (opts.command === "show" || opts.command === "mark" || opts.command === "delete") {
        throw new Error(`Invite request not found: ${opts.targetId || "(matching contact)"}`);
      }
      console.log(opts.json ? "[]" : "No invite requests found.");
      return;
    }

    if (opts.command === "show") {
      const row = db.prepare(`SELECT ${SELECT_COLS} FROM invite_requests WHERE id = ?`).get(opts.targetId);
      if (!row) throw new Error(`Invite request not found: ${opts.targetId}`);
      const item = hydrateRow(row);
      console.log(opts.json ? JSON.stringify(item, null, 2) : formatShowText(item));
      return;
    }

    if (opts.command === "delete") {
      const deletedAt = new Date().toISOString();
      let deletedIds = [];
      let inTx = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        inTx = true;
        const rows = opts.targetId
          ? db.prepare("SELECT id FROM invite_requests WHERE id = ?").all(opts.targetId)
          : db.prepare("SELECT id FROM invite_requests WHERE contact_kind = ? AND contact_value = ? ORDER BY created DESC, id DESC")
              .all(opts.contact.contactKind, opts.contact.contactValue);
        if (!rows.length) {
          throw new Error(`Invite request not found: ${opts.targetId || "(matching contact)"}`);
        }
        db.exec("CREATE TABLE IF NOT EXISTS invite_request_deletions (id TEXT PRIMARY KEY, deleted TEXT NOT NULL)");
        const delStmt = db.prepare("DELETE FROM invite_requests WHERE id = ?");
        const tombStmt = db.prepare("INSERT OR REPLACE INTO invite_request_deletions (id, deleted) VALUES (?, ?)");
        for (const r of rows) {
          delStmt.run(r.id);
          tombStmt.run(r.id, deletedAt);
          deletedIds.push(r.id);
        }
        db.exec("COMMIT");
        inTx = false;
      } catch (err) {
        if (inTx) {
          try { db.exec("ROLLBACK"); } catch {}
        }
        throw err;
      }
      const out = { ok: true, count: deletedIds.length, deletedIds, deletedAt };
      console.log(
        opts.json
          ? JSON.stringify(out, null, 2)
          : `Deleted ${deletedIds.length} invite request(s) and recorded deletion ledger tombstone(s): ${deletedIds.join(", ")}`
      );
      return;
    }

    if (opts.command === "mark") {
      let updatedRow;
      let inTx = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        inTx = true;
        const existing = db.prepare(`SELECT ${SELECT_COLS} FROM invite_requests WHERE id = ?`).get(opts.targetId);
        if (!existing) throw new Error(`Invite request not found: ${opts.targetId}`);
        const nowIso = new Date().toISOString();
        const nextNote = opts.note !== undefined ? opts.note : (existing.status_note || "");
        db.prepare(
          "UPDATE invite_requests SET status = ?, status_note = ?, updated = ? WHERE id = ?"
        ).run(opts.status, nextNote, nowIso, opts.targetId);
        updatedRow = db.prepare(`SELECT ${SELECT_COLS} FROM invite_requests WHERE id = ?`).get(opts.targetId);
        db.exec("COMMIT");
        inTx = false;
      } catch (err) {
        if (inTx) {
          try { db.exec("ROLLBACK"); } catch {}
        }
        if (err && /UNIQUE constraint failed/i.test(String(err.message))) {
          throw new Error("Another pending invite request already exists for this contact");
        }
        throw err;
      }
      const item = hydrateRow(updatedRow);
      console.log(opts.json ? JSON.stringify(item, null, 2) : formatShowText(item));
      return;
    }

    const rows = opts.status === "all"
      ? db.prepare(`SELECT ${SELECT_COLS} FROM invite_requests ORDER BY created DESC, id DESC LIMIT ?`).all(opts.limit)
      : db.prepare(`SELECT ${SELECT_COLS} FROM invite_requests WHERE status = ? ORDER BY created DESC, id DESC LIMIT ?`).all(opts.status, opts.limit);
    const items = rows.map(hydrateRow);
    console.log(opts.json ? JSON.stringify(items, null, 2) : formatListText(items));
  } finally {
    db.close();
    releaseDataAccess();
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
