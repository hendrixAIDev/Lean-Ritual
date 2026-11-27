#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ALLOWED_STATUSES, sanitizeStatusNote } = require("../lib/invite-requests");

const USAGE = [
  "Usage: node scripts/invite-requests-admin.js",
  "  [list [--status pending|invited|dismissed|all] [--limit N] [--json]]",
  "  | show <id> [--json]",
  "  | mark <id> --status invited|dismissed|pending [--note <short-reason>] [--json]"
].join(" ");

const LIST_STATUSES = new Set(["pending", "invited", "dismissed", "all"]);

function parseArgs(argv) {
  let command = "list";
  let targetId = null;
  let limit = 20;
  let status = null;
  let note = undefined;
  let json = false;
  let i = 0;

  if (argv[0] === "list" || argv[0] === "show" || argv[0] === "mark") {
    command = argv[0];
    i = 1;
    if (command === "show" || command === "mark") {
      if (!argv[1] || argv[1].startsWith("-")) throw new Error(USAGE);
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
      if (command === "show") throw new Error(USAGE);
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
    } else {
      throw new Error(USAGE);
    }
  }

  if (command === "mark" && !status) {
    throw new Error("mark requires --status invited|dismissed|pending");
  }
  if (command === "list" && !status) {
    status = "all";
  }

  return { command, targetId, limit, status, note, json };
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
  const opts = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
  const dbPath = path.join(dataDir, "bojin.db");

  if (!fs.existsSync(dbPath)) {
    if (opts.command === "show" || opts.command === "mark") {
      throw new Error(`Invite request not found: ${opts.targetId}`);
    }
    console.log(opts.json ? "[]" : "No invite requests found.");
    return;
  }

  const releaseDataAccess = require("../lib/data-access").shared(dataDir);
  process.once("exit", releaseDataAccess);
  const db = new DatabaseSync(dbPath, { readOnly: opts.command !== "mark" });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'invite_requests'").get();
    if (!hasTable) {
      if (opts.command === "show" || opts.command === "mark") {
        throw new Error(`Invite request not found: ${opts.targetId}`);
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
