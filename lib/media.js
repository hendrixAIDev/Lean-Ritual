"use strict";
// Public landing-page media: the four intro videos and their posters, nothing else.
// Off by default. It turns on only while MEDIA_DIR is configured and holds all four
// videos; until then the page omits the video section and every /media URL is 404.
// Both MP4s and posters come exclusively from MEDIA_DIR (kept out of Git and release
// bundles — no bundled poster fallback). Availability checks are cached with
// single-flight coalescing and re-checked on cache miss or when a required video
// fails to open. A file is opened once, without following symlinks, and every header
// and byte comes from that one descriptor.
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const TYPES = { mp4: "video/mp4", jpg: "image/jpeg" };
const ASSETS = new Map(["zh", "en"].flatMap(lang => ["9x16", "16x9"].flatMap(shape =>
  Object.entries(TYPES).map(([ext, type]) => [`intro-${lang}-${shape}.${ext}`, type]))));
const VIDEOS = [...ASSETS.keys()].filter(name => name.endsWith(".mp4"));
const VIDEO_SET = new Set(VIDEOS);
const CACHE = "public, max-age=604800";   // 7 days; replacing a file changes its ETag
const DEFAULT_CHECK_TTL_MS = 30_000;
// O_NONBLOCK: opening a FIFO must fail the regular-file check, not hang the request.
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const INVALID_OPEN_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EACCES", "EPERM"]);

function mediaOptions(env = process.env) {
  const raw = env.MEDIA_CHECK_TTL_MS;
  const checkTtlMs = raw == null || String(raw).trim() === "" ? DEFAULT_CHECK_TTL_MS : Number(raw);
  if (!Number.isSafeInteger(checkTtlMs) || checkTtlMs < 1 || checkTtlMs > 300_000)
    throw new Error("MEDIA_CHECK_TTL_MS must be an integer between 1 and 300000");
  return { checkTtlMs };
}

/** Parse one "bytes=a-b" range. Returns {start,end}, null (serve whole file) or "invalid". */
function parseRange(header, size) {
  if (typeof header !== "string") return null;
  const value = header.trim();
  // Other units and multi-range requests get the full representation.
  if (!/^bytes=/i.test(value) || value.includes(",")) return null;
  const m = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start, end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!suffix) return "invalid";
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start > end || start >= size) return "invalid";
  return { start, end };
}

/** Open an allowlisted file directly from MEDIA_DIR without following symlinks. */
async function openAsset(root, name, open, requireNonEmpty) {
  let handle;
  try { handle = await open(path.join(root, name), OPEN_FLAGS); }
  catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR")
      console.error("media open failed", error.code || "error");   // ELOOP: a symlink was refused
    return { asset: null, invalid: INVALID_OPEN_CODES.has(error.code) };
  }
  try {
    const st = await handle.stat();
    if (st.isFile() && (!requireNonEmpty || st.size > 0)) return { asset: { handle, st }, invalid: false };
    await handle.close();
    return { asset: null, invalid: true };
  } catch (error) {
    console.error("media stat failed", error.code || "error");
    await handle.close();
    return { asset: null, invalid: false };
  }
}

function notModified(req, etag, st) {
  const inm = req.headers["if-none-match"];
  if (inm !== undefined) return inm.trim() === "*" || inm.split(",").some(v => v.trim().replace(/^W\//, "") === etag);
  const since = Date.parse(req.headers["if-modified-since"] || "");
  return Number.isFinite(since) && Math.floor(st.mtimeMs / 1000) * 1000 <= since;
}

function createMedia({
  mediaDir,
  open = fs.promises.open,
  lstat = fs.promises.lstat,
  access = fs.promises.access,
  checkTtlMs = DEFAULT_CHECK_TTL_MS,
  now = () => performance.now()
}) {
  if (!Number.isFinite(checkTtlMs) || checkTtlMs < 0) throw new Error("checkTtlMs must be a non-negative number");
  const host = mediaDir ? path.resolve(mediaDir) : null;
  let cached = null;     // { value: boolean, expiresAt: number } | null
  let inflight = null;   // Promise<{ value: boolean, expiresAt: number }> | null

  async function probe() {
    for (const name of VIDEOS) {
      const file = path.join(host, name);
      try {
        const st = await lstat(file);
        if (!st.isFile() || st.size === 0) return false;
        await access(file, fs.constants.R_OK);
      } catch { return false; }   // missing, unreadable or a broken folder: keep the video hidden
    }
    return true;
  }

  function availability() {
    if (!host) return Promise.resolve({ value: false, expiresAt: Infinity });
    if (cached !== null && now() < cached.expiresAt) return Promise.resolve(cached);
    if (inflight) return inflight;
    const run = probe().then(value => {
      const entry = { value, expiresAt: now() + checkTtlMs };
      cached = entry;
      return entry;
    }).finally(() => {
      if (inflight === run) inflight = null;
    });
    inflight = run;
    return run;
  }

  /** True only when every approved video is a readable, non-empty regular file. */
  async function enabled() {
    return (await availability()).value;
  }

  function finish(res, status, headers) { res.writeHead(status, headers); res.end(); }
  const notFound = res => finish(res, 404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });

  async function respond(req, res, type, { handle, st }) {
    const size = st.size;
    const etag = `"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const validators = { "Accept-Ranges": "bytes", "Cache-Control": CACHE, ETag: etag, "Last-Modified": st.mtime.toUTCString() };
    if (notModified(req, etag, st)) return finish(res, 304, validators);
    const ifRange = req.headers["if-range"];
    // Range is defined for GET only; a stale If-Range means "send the whole file".
    const range = req.method !== "GET" || (ifRange !== undefined && ifRange.trim() !== etag) ? null : parseRange(req.headers.range, size);
    if (range === "invalid") return finish(res, 416, { "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Content-Range": `bytes */${size}` });
    const { start, end } = range || { start: 0, end: size - 1 };
    const length = end - start + 1;
    const headers = { ...validators, "Content-Type": type, "Content-Length": length };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    if (req.method === "HEAD" || length === 0) return finish(res, range ? 206 : 200, headers);
    res.writeHead(range ? 206 : 200, headers);
    const stream = handle.createReadStream({ start, end, autoClose: false });
    await pipeline(stream, res, { end: false });
    // A file truncated mid-stream must not leave the client waiting for promised bytes.
    if (stream.bytesRead === length) res.end(); else res.destroy();
  }

  async function handle(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") return finish(res, 405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
    let name = "";
    try { name = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/media\//, ""); } catch { /* malformed escape: not an asset */ }
    const type = ASSETS.get(name);
    if (!type) return notFound(res);
    const state = await availability();
    if (!state.value) return notFound(res);
    const isVideo = VIDEO_SET.has(name);
    const { asset, invalid } = await openAsset(host, name, open, isVideo);
    if (!asset) {
      if (isVideo && invalid && cached === state) cached = null;
      return notFound(res);
    }
    try { await respond(req, res, type, asset); }
    catch (error) {
      if (error.code !== "ERR_STREAM_PREMATURE_CLOSE" && error.code !== "ERR_STREAM_UNABLE_TO_PIPE") console.error("media stream failed", error.code || "error");
      if (res.headersSent) res.destroy(); else notFound(res);
    } finally {
      await asset.handle.close();   // every path: 200, 206, 304, 416, HEAD, errors and disconnects
    }
  }
  return { handle, enabled };
}

module.exports = { createMedia, mediaOptions, parseRange, ASSETS, VIDEOS, DEFAULT_CHECK_TTL_MS };
