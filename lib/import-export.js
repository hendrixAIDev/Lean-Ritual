"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { normalizeEmail } = require("./invitations");
const { createDocQuota, docQuotaOptions } = require("./doc-quota");
const { createAccountData } = require("./account-data");
const { normalize, MAX_UPLOAD_BYTES } = require("./uploads");

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const USAGE = "Usage: node server.js import-account --email <email> <dir> [--dry-run]";

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function validateDocRel(rel, uid) {
  if (typeof uid !== "string" || !SEG.test(uid) || uid === "." || uid === "..") {
    throw fail(400, "bad_path", "Invalid user ID for document path");
  }
  if (typeof rel !== "string" || !rel || rel.includes("\\")) {
    throw fail(400, "bad_path", "Invalid document path: " + String(rel || ""));
  }
  const relSegs = rel.split("/");
  if (relSegs.length < 2 || relSegs.length % 2 !== 0 || !relSegs.every(s => SEG.test(s) && s !== "." && s !== "..")) {
    throw fail(400, "bad_path", "Invalid document path: " + rel);
  }
  const target = `data/users/${uid}/app/${relSegs.join("/")}`;
  const fullSegs = target.split("/");
  if (
    fullSegs[0] !== "data" ||
    fullSegs[1] !== "users" ||
    fullSegs[2] !== uid ||
    fullSegs.length % 2 !== 0 ||
    !fullSegs.every(s => SEG.test(s) && s !== "." && s !== "..")
  ) {
    throw fail(400, "bad_path", "Invalid document path: " + rel);
  }
  return {
    rel: relSegs.join("/"),
    target,
    parent: fullSegs.slice(0, -1).join("/"),
    collection: relSegs[0],
  };
}

function parseImportAccountArgs(args) {
  let email = null;
  let dir = null;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--email") {
      if (email !== null || i + 1 >= args.length || !args[i + 1]) throw new Error(USAGE);
      email = args[++i];
    } else if (typeof arg === "string" && arg.startsWith("--email=")) {
      if (email !== null) throw new Error(USAGE);
      email = arg.slice("--email=".length);
      if (!email) throw new Error(USAGE);
    } else if (typeof arg === "string" && arg.startsWith("-")) {
      throw new Error(USAGE);
    } else if (dir === null && typeof arg === "string" && arg) {
      dir = arg;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!email || !dir) throw new Error(USAGE);
  return { email, dir: path.resolve(dir), dryRun };
}

function photoQuotaOptions(env = process.env) {
  const read = (name, fallback) => {
    const raw = env[name];
    const n = raw == null || String(raw).trim() === "" ? fallback : Number(raw);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(name + " must be a positive integer");
    return n;
  };
  return {
    userBytes: read("PHOTO_USER_BYTES", 262144000),
    totalBytes: read("PHOTO_TOTAL_BYTES", 5368709120),
  };
}

function resolveVerifiedUser(dataDir, rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Invalid email address: " + String(rawEmail || ""));
  }
  const authPath = path.join(dataDir, "auth.sqlite");
  if (!fs.existsSync(authPath)) {
    throw new Error("Better Auth user not found (auth.sqlite missing): " + email);
  }
  const authDb = new DatabaseSync(authPath, { readOnly: true, timeout: 5000 });
  try {
    authDb.exec("PRAGMA busy_timeout = 5000");
    const hasTable = authDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user'").get();
    if (!hasTable) throw new Error("Better Auth user not found: " + email);
    const rows = authDb.prepare("SELECT id, email, emailVerified FROM user WHERE lower(trim(email)) = ?").all(email);
    if (rows.length === 0) throw new Error("Better Auth user not found: " + email);
    if (rows.length > 1) throw new Error("Ambiguous Better Auth users for email: " + email);
    const user = rows[0];
    if (user.emailVerified !== 1 && user.emailVerified !== true) {
      throw new Error("Better Auth user email is not verified: " + email);
    }
    if (!user.id || !SEG.test(user.id) || user.id === "." || user.id === "..") {
      throw new Error("Invalid Better Auth user ID");
    }
    return { id: user.id, email };
  } finally {
    authDb.close();
  }
}

function scanExportDir(exportDir, uid) {
  let rootStat;
  try {
    rootStat = fs.statSync(exportDir);
  } catch {
    throw new Error("Export directory not found: " + exportDir);
  }
  if (!rootStat.isDirectory()) throw new Error("Export path is not a directory: " + exportDir);

  const docEntries = [];
  const docsDir = path.join(exportDir, "docs");
  if (fs.existsSync(docsDir)) {
    const docsLstat = fs.lstatSync(docsDir);
    if (docsLstat.isSymbolicLink() || !docsLstat.isDirectory()) {
      throw new Error("Unsafe symlink or non-directory docs path in export");
    }
    const realDocsDir = fs.realpathSync(docsDir);
    const walk = (dir, segs) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const fp = path.join(dir, entry.name);
        const lstat = fs.lstatSync(fp);
        if (lstat.isSymbolicLink()) {
          throw new Error("Unsafe symlink in export docs: " + path.relative(exportDir, fp));
        }
        const realFp = fs.realpathSync(fp);
        if (!realFp.startsWith(realDocsDir + path.sep)) {
          throw new Error("Path traversal in export docs: " + path.relative(exportDir, fp));
        }
        if (lstat.isDirectory()) {
          if (!SEG.test(entry.name) || entry.name === "." || entry.name === "..") {
            throw new Error("Invalid document path segment: " + entry.name);
          }
          walk(fp, [...segs, entry.name]);
        } else if (lstat.isFile()) {
          if (entry.name.startsWith(".") && !entry.name.endsWith(".json")) continue;
          if (!entry.name.endsWith(".json")) continue;
          const stem = entry.name.slice(0, -5);
          const validated = validateDocRel([...segs, stem].join("/"), uid);
          let data;
          try {
            data = JSON.parse(fs.readFileSync(fp, "utf8"));
          } catch (e) {
            throw new Error(`Invalid JSON in docs/${validated.rel}.json: ${e.message}`);
          }
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error(`Invalid JSON document in docs/${validated.rel}.json: expected object`);
          }
          const serialized = JSON.stringify(data);
          docEntries.push({
            ...validated,
            data,
            serialized,
            bytes: Buffer.byteLength(serialized),
          });
        } else {
          throw new Error("Unsupported file type in export docs: " + path.relative(exportDir, fp));
        }
      }
    };
    walk(docsDir, []);
  }

  const blobEntries = [];
  const blobsDir = path.join(exportDir, "blobs");
  if (fs.existsSync(blobsDir)) {
    const blobsLstat = fs.lstatSync(blobsDir);
    if (blobsLstat.isSymbolicLink() || !blobsLstat.isDirectory()) {
      throw new Error("Unsafe symlink or non-directory blobs path in export");
    }
    const realBlobsDir = fs.realpathSync(blobsDir);
    const entries = fs.readdirSync(blobsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const fp = path.join(blobsDir, entry.name);
      const lstat = fs.lstatSync(fp);
      if (lstat.isSymbolicLink()) {
        throw new Error("Unsafe symlink in export blobs: " + entry.name);
      }
      const realFp = fs.realpathSync(fp);
      if (!realFp.startsWith(realBlobsDir + path.sep)) {
        throw new Error("Path traversal in export blobs: " + entry.name);
      }
      if (!lstat.isFile()) {
        throw new Error("Unexpected non-regular entry in export blobs: " + entry.name);
      }
      if (entry.name.startsWith(".")) continue;
      const id = entry.name.replace(/\.[a-z0-9]+$/i, "");
      if (!/^[0-9a-f]{32}$/.test(id)) continue;
      blobEntries.push({ id, fileName: entry.name, filePath: fp, rawSize: lstat.size });
    }
  }

  return { docEntries, blobEntries };
}

function readExistingStateReadOnly(dataDir, uid) {
  const state = {
    existingDocs: new Set(),
    existingBlobs: new Set(),
    usedDocCount: 0,
    usedDocBytes: 0,
    usedUserPhotoBytes: 0,
    usedTotalPhotoBytes: 0,
  };
  const bojinPath = path.join(dataDir, "bojin.db");
  if (!fs.existsSync(bojinPath)) return state;
  const roDb = new DatabaseSync(bojinPath, { readOnly: true, timeout: 5000 });
  try {
    roDb.exec("PRAGMA busy_timeout = 5000");
    const hasTable = name => !!roDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (hasTable("deletion_jobs") && roDb.prepare("SELECT 1 FROM deletion_jobs WHERE uid = ?").get(uid)) {
      throw fail(423, "account_deleting", "账号删除处理中，不能再写入或读取记录");
    }
    if (hasTable("docs")) {
      const used = roDb.prepare("SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) bytes, COUNT(*) n FROM docs WHERE uid = ?").get(uid);
      state.usedDocBytes = used.bytes;
      state.usedDocCount = used.n;
      for (const row of roDb.prepare("SELECT path FROM docs WHERE uid = ?").all(uid)) {
        state.existingDocs.add(row.path);
      }
      // Also check any colliding global path just in case
      for (const row of roDb.prepare("SELECT path FROM docs WHERE path LIKE ?").all(`data/users/${uid}/%`)) {
        state.existingDocs.add(row.path);
      }
    }
    if (hasTable("blobs")) {
      state.usedUserPhotoBytes = roDb.prepare("SELECT COALESCE(SUM(size), 0) n FROM blobs WHERE uid = ?").get(uid).n;
      state.usedTotalPhotoBytes = roDb.prepare("SELECT COALESCE(SUM(size), 0) n FROM blobs").get().n;
      for (const row of roDb.prepare("SELECT id FROM blobs").all()) {
        state.existingBlobs.add(row.id);
      }
    }
    return state;
  } finally {
    roDb.close();
  }
}

function formatCollections(collections) {
  const entries = Object.entries(collections).sort((a, b) => a[0].localeCompare(b[0]));
  return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join(", ") : "无";
}

async function importAccount({
  dataDir,
  email,
  dir,
  dryRun = false,
  db = null,
  docQuota = null,
  accountData = null,
  env = process.env,
  log = console.log,
}) {
  const user = resolveVerifiedUser(dataDir, email);
  const uid = user.id;
  const docOpts = docQuotaOptions(env);
  const photoOpts = photoQuotaOptions(env);
  const { docEntries, blobEntries } = scanExportDir(dir, uid);

  if (dryRun) {
    const state = readExistingStateReadOnly(dataDir, uid);
    const collections = {};
    let newDocs = 0, newDocBytes = 0, skippedDocs = 0;
    for (const doc of docEntries) {
      if (state.existingDocs.has(doc.target)) {
        skippedDocs++;
      } else {
        newDocs++;
        newDocBytes += doc.bytes;
        collections[doc.collection] = (collections[doc.collection] || 0) + 1;
      }
    }

    let newPhotos = 0, newPhotoBytes = 0, skippedPhotos = 0;
    const failedPhotos = [];
    const seenBlobIds = new Set();
    for (const blob of blobEntries) {
      if (state.existingBlobs.has(blob.id) || seenBlobIds.has(blob.id)) {
        skippedPhotos++;
        continue;
      }
      if (blob.rawSize === 0 || blob.rawSize > MAX_UPLOAD_BYTES) {
        failedPhotos.push(blob.fileName);
        continue;
      }
      try {
        const normalized = await normalize(fs.readFileSync(blob.filePath));
        seenBlobIds.add(blob.id);
        newPhotos++;
        newPhotoBytes += normalized.length;
      } catch {
        failedPhotos.push(blob.fileName);
      }
    }

    const projDocCount = state.usedDocCount + newDocs;
    const projDocBytes = state.usedDocBytes + newDocBytes;
    const projUserPhotoBytes = state.usedUserPhotoBytes + newPhotoBytes;
    const projTotalPhotoBytes = state.usedTotalPhotoBytes + newPhotoBytes;

    log(`[dry-run] 目标账号：${user.email} (${uid})`);
    log(`[dry-run] 文档分类统计：${formatCollections(collections)}`);
    log(`[dry-run] 文档合计：待导入 ${newDocs} 条（${newDocBytes} 字节），已存在跳过 ${skippedDocs} 条`);
    log(`[dry-run] 照片合计：待导入 ${newPhotos} 张（重编码后 ${newPhotoBytes} 字节），已存在跳过 ${skippedPhotos} 张，解码失败 ${failedPhotos.length} 张`);
    if (failedPhotos.length) {
      log(`[dry-run] 无法解码的照片：${failedPhotos.map(f => "blobs/" + f).join(", ")}`);
    }
    log(
      `[dry-run] 额度预估 (quota estimate)：文档 ${projDocCount}/${docOpts.userCount} 条、${projDocBytes}/${docOpts.userBytes} 字节；` +
      `照片个人 ${projUserPhotoBytes}/${photoOpts.userBytes} 字节、全站 ${projTotalPhotoBytes}/${photoOpts.totalBytes} 字节`
    );

    if (projDocCount > docOpts.userCount || projDocBytes > docOpts.userBytes) {
      throw fail(
        413,
        "doc_quota",
        `文档存储已达上限 (doc_quota)：预计 ${projDocCount}/${docOpts.userCount} 条、${projDocBytes}/${docOpts.userBytes} 字节`
      );
    }
    if (projUserPhotoBytes > photoOpts.userBytes || projTotalPhotoBytes > photoOpts.totalBytes) {
      throw fail(
        413,
        "storage_quota",
        `照片存储空间已达上限 (storage_quota)：预计个人 ${projUserPhotoBytes}/${photoOpts.userBytes} 字节、全站 ${projTotalPhotoBytes}/${photoOpts.totalBytes} 字节`
      );
    }

    log(`[dry-run] 预览完成（未写入任何数据）：文档 ${newDocs} 条（已存在跳过 ${skippedDocs} 条），照片 ${newPhotos} 张（${newPhotoBytes} 字节，已存在跳过 ${skippedPhotos} 张，解码失败 ${failedPhotos.length} 张）`);
    return {
      uid,
      email: user.email,
      dryRun: true,
      importedDocs: newDocs,
      skippedDocs,
      collections,
      importedPhotos: newPhotos,
      importedPhotoBytes: newPhotoBytes,
      skippedPhotos,
      failedPhotos,
    };
  }

  let ownDb = false;
  if (!db) {
    fs.mkdirSync(path.join(dataDir, "blobs"), { recursive: true });
    db = new DatabaseSync(path.join(dataDir, "bojin.db"));
    ownDb = true;
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, uid TEXT NOT NULL, parent TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent);
      CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
    `);
  }
  try {
    const acct = accountData || createAccountData(db, dataDir);
    const quota = docQuota || createDocQuota(db, docQuotaOptions(env));
    acct.ensureActive(uid);

    // Pre-check aggregate document quota before writing so an over-quota batch leaves zero partial docs.
    const usedDoc = db.prepare("SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) bytes, COUNT(*) n FROM docs WHERE uid = ?").get(uid);
    let plannedDocs = 0, plannedDocBytes = 0;
    for (const doc of docEntries) {
      if (!db.prepare("SELECT 1 FROM docs WHERE path = ?").get(doc.target)) {
        plannedDocs++;
        plannedDocBytes += doc.bytes;
      }
    }
    if (usedDoc.n + plannedDocs > docOpts.userCount || usedDoc.bytes + plannedDocBytes > docOpts.userBytes) {
      throw fail(
        413,
        "doc_quota",
        `文档存储已达上限 (doc_quota)：预计 ${usedDoc.n + plannedDocs}/${docOpts.userCount} 条、${usedDoc.bytes + plannedDocBytes}/${docOpts.userBytes} 字节`
      );
    }

    const collections = {};
    let importedDocs = 0, skippedDocs = 0;
    const selectDocExists = db.prepare("SELECT 1 FROM docs WHERE path = ?");
    const insertDocMissing = db.prepare(
      "INSERT INTO docs (path, uid, parent, data, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO NOTHING"
    );

    for (const doc of docEntries) {
      if (selectDocExists.get(doc.target)) {
        skippedDocs++;
        continue;
      }
      acct.ensureActive(uid);
      let inserted = false;
      try {
        quota.write(uid, doc.target, doc.data, serialized => {
          const info = insertDocMissing.run(doc.target, uid, doc.parent, serialized, new Date().toISOString());
          inserted = info.changes > 0;
        });
      } catch (e) {
        if (e && e.code === "doc_quota") {
          const cur = db.prepare("SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) bytes, COUNT(*) n FROM docs WHERE uid = ?").get(uid);
          throw fail(
            413,
            "doc_quota",
            `文档存储已达上限 (doc_quota)：写入 ${doc.rel}（${doc.bytes} 字节）时超限（${e.message}，当前已存 ${cur.n} 条、${cur.bytes} 字节）`
          );
        }
        throw e;
      }
      if (inserted) {
        importedDocs++;
        collections[doc.collection] = (collections[doc.collection] || 0) + 1;
      } else {
        skippedDocs++;
      }
    }

    let importedPhotos = 0, importedPhotoBytes = 0, skippedPhotos = 0;
    const failedPhotos = [];
    const selectBlobExists = db.prepare("SELECT 1 FROM blobs WHERE id = ?");
    const insertBlob = db.prepare("INSERT INTO blobs (id, uid, type, size, created) VALUES (?, ?, ?, ?, ?)");

    for (const blob of blobEntries) {
      if (selectBlobExists.get(blob.id)) {
        skippedPhotos++;
        continue;
      }
      if (blob.rawSize === 0 || blob.rawSize > MAX_UPLOAD_BYTES) {
        failedPhotos.push(blob.fileName);
        log(`照片解码失败（已跳过）：blobs/${blob.fileName}`);
        continue;
      }
      let normalized;
      try {
        normalized = await normalize(fs.readFileSync(blob.filePath));
      } catch {
        failedPhotos.push(blob.fileName);
        log(`照片解码失败（已跳过）：blobs/${blob.fileName}`);
        continue;
      }

      const destFile = path.join(dataDir, "blobs", blob.id);
      let wrote = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        acct.ensureActive(uid);
        if (selectBlobExists.get(blob.id)) {
          db.exec("COMMIT");
          skippedPhotos++;
          continue;
        }
        const own = db.prepare("SELECT COALESCE(SUM(size), 0) n FROM blobs WHERE uid = ?").get(uid).n;
        const total = db.prepare("SELECT COALESCE(SUM(size), 0) n FROM blobs").get().n;
        if (own + normalized.length > photoOpts.userBytes || total + normalized.length > photoOpts.totalBytes) {
          throw fail(
            413,
            "storage_quota",
            `照片存储空间已达上限 (storage_quota)：预计个人 ${own + normalized.length}/${photoOpts.userBytes} 字节、全站 ${total + normalized.length}/${photoOpts.totalBytes} 字节`
          );
        }
        const fd = fs.openSync(destFile, "wx", 0o600);
        wrote = true;
        try {
          fs.writeFileSync(fd, normalized);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        insertBlob.run(blob.id, uid, "image/webp", normalized.length, new Date().toISOString());
        db.exec("COMMIT");
        importedPhotos++;
        importedPhotoBytes += normalized.length;
      } catch (e) {
        try { db.exec("ROLLBACK"); } finally { if (wrote) fs.rmSync(destFile, { force: true }); }
        throw e;
      }
    }

    if (failedPhotos.length) {
      log(`无法解码的照片（共 ${failedPhotos.length} 张）：${failedPhotos.map(f => "blobs/" + f).join(", ")}`);
    }
    log(`导入完成（${uid}）：文档 ${importedDocs} 条（已存在跳过 ${skippedDocs} 条），照片 ${importedPhotos} 张（${importedPhotoBytes} 字节，已存在跳过 ${skippedPhotos} 张，解码失败 ${failedPhotos.length} 张）`);

    return {
      uid,
      email: user.email,
      dryRun: false,
      importedDocs,
      skippedDocs,
      collections,
      importedPhotos,
      importedPhotoBytes,
      skippedPhotos,
      failedPhotos,
    };
  } finally {
    if (ownDb) db.close();
  }
}

async function runImportAccountCli(args, options) {
  const parsed = parseImportAccountArgs(args);
  return importAccount({ ...options, ...parsed });
}

module.exports = {
  SEG,
  USAGE,
  validateDocRel,
  parseImportAccountArgs,
  photoQuotaOptions,
  resolveVerifiedUser,
  importAccount,
  runImportAccountCli,
};
