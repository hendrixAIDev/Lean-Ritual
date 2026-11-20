#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const USAGE = "Usage: node scripts/feedback-admin.js [list [--limit N] [--type bug|idea|other] [--json]] | show <id> [--json]";
const ALLOWED_TYPES = new Set(["bug", "idea", "other"]);

function parseArgs(argv) {
  let command = "list";
  let targetId = null;
  let limit = 20;
  let type = null;
  let json = false;
  let i = 0;

  if (argv[0] === "list" || argv[0] === "show") {
    command = argv[0];
    i = 1;
    if (command === "show") {
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
      const raw = arg === "--limit" ? argv[++i] : arg.slice("--limit=".length);
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 1 || n > 200) throw new Error("--limit must be an integer between 1 and 200");
      limit = n;
    } else if (arg === "--type" || arg.startsWith("--type=")) {
      const raw = (arg === "--type" ? argv[++i] : arg.slice("--type=".length) || "").trim().toLowerCase();
      if (!ALLOWED_TYPES.has(raw)) throw new Error("--type must be bug, idea, or other");
      type = raw;
    } else {
      throw new Error(USAGE);
    }
  }

  return { command, targetId, limit, type, json };
}

function hydrateRow(row, dataDir) {
  let deviceInfo = null;
  if (row.device_info) {
    try { deviceInfo = JSON.parse(row.device_info); } catch { deviceInfo = null; }
  }
  const blobId = row.screenshot_blob_id && /^[0-9a-f]{32}$/.test(row.screenshot_blob_id)
    ? row.screenshot_blob_id
    : null;
  return {
    id: row.id,
    uid: row.uid,
    type: row.type,
    message: row.message,
    screenshotBlobId: blobId,
    screenshotPath: blobId ? path.join(dataDir, "blobs", blobId) : null,
    deviceInfo,
    created: row.created
  };
}

function formatListText(items) {
  if (!items.length) return "No feedback entries found.";
  return items.map(item => {
    const meta = [item.created, item.id, `[${item.type}]`, `uid=${item.uid}`];
    if (item.screenshotBlobId) meta.push(`img=${item.screenshotBlobId}`);
    if (item.deviceInfo) {
      const d = item.deviceInfo;
      meta.push(`env=${d.revision || "?"}/${d.page || "?"}/${d.lang || "?"}/${d.screen || "?"}`);
    }
    const msg = String(item.message || "").replace(/\r?\n/g, "\n  ");
    return `${meta.join("  ")}\n  ${msg}`;
  }).join("\n\n");
}

function formatShowText(item) {
  const lines = [
    `ID:         ${item.id}`,
    `Created:    ${item.created}`,
    `Type:       ${item.type}`,
    `User ID:    ${item.uid}`,
    `Screenshot: ${item.screenshotPath || "(none)"}`,
    `Device:     ${item.deviceInfo ? JSON.stringify(item.deviceInfo) : "(not included)"}`,
    "",
    item.message
  ];
  return lines.join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
  const dbPath = path.join(dataDir, "bojin.db");

  if (!fs.existsSync(dbPath)) {
    if (opts.command === "show") {
      throw new Error(`Feedback not found: ${opts.targetId}`);
    }
    console.log(opts.json ? "[]" : "No feedback entries found.");
    return;
  }

  const releaseDataAccess = require("../lib/data-access").shared(dataDir);
  process.once("exit", releaseDataAccess);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feedback'").get();
    if (!hasTable) {
      if (opts.command === "show") throw new Error(`Feedback not found: ${opts.targetId}`);
      console.log(opts.json ? "[]" : "No feedback entries found.");
      return;
    }

    if (opts.command === "show") {
      const row = db.prepare(
        "SELECT id, uid, type, message, screenshot_blob_id, device_info, created FROM feedback WHERE id = ?"
      ).get(opts.targetId);
      if (!row) throw new Error(`Feedback not found: ${opts.targetId}`);
      const item = hydrateRow(row, dataDir);
      console.log(opts.json ? JSON.stringify(item, null, 2) : formatShowText(item));
      return;
    }

    const rows = opts.type
      ? db.prepare(
          "SELECT id, uid, type, message, screenshot_blob_id, device_info, created FROM feedback WHERE type = ? ORDER BY created DESC, id DESC LIMIT ?"
        ).all(opts.type, opts.limit)
      : db.prepare(
          "SELECT id, uid, type, message, screenshot_blob_id, device_info, created FROM feedback ORDER BY created DESC, id DESC LIMIT ?"
        ).all(opts.limit);
    const items = rows.map(r => hydrateRow(r, dataDir));
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
