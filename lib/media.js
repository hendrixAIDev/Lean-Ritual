"use strict";
// Public landing-page media: the four intro videos and their posters, nothing else.
// Off by default. It turns on only while MEDIA_DIR is configured and holds all four
// videos; until then the page omits the video section and every /media URL is 404.
// MP4s come only from MEDIA_DIR (kept out of Git and release bundles). Posters come
// from MEDIA_DIR, then the bundled fallbacks. Both roots are operator-controlled. A file is opened once, without following
// symlinks, and every header and byte comes from that one descriptor.
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const TYPES = { mp4: "video/mp4", jpg: "image/jpeg" };
const ASSETS = new Map(["zh", "en"].flatMap(lang => ["9x16", "16x9"].flatMap(shape =>
  Object.entries(TYPES).map(([ext, type]) => [`intro-${lang}-${shape}.${ext}`, type]))));
const VIDEOS = [...ASSETS.keys()].filter(name => name.endsWith(".mp4"));
const CACHE = "public, max-age=604800";   // 7 days; replacing a file changes its ETag
// O_NONBLOCK: opening a FIFO must fail the regular-file check, not hang the request.
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

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

/** Open the first root's copy of an allowlisted name. Only a missing file falls through. */
async function openAsset(roots, name, open) {
  for (const root of roots) {
    let handle;
    try { handle = await open(path.join(root, name), OPEN_FLAGS); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      console.error("media open failed", error.code || "error");   // ELOOP: a symlink was refused
      return null;
    }
    try {
      const st = await handle.stat();
      if (st.isFile()) return { handle, st };
    } catch (error) { console.error("media stat failed", error.code || "error"); }
    await handle.close();
    return null;
  }
  return null;
}

function notModified(req, etag, st) {
  const inm = req.headers["if-none-match"];
  if (inm !== undefined) return inm.trim() === "*" || inm.split(",").some(v => v.trim().replace(/^W\//, "") === etag);
  const since = Date.parse(req.headers["if-modified-since"] || "");
  return Number.isFinite(since) && Math.floor(st.mtimeMs / 1000) * 1000 <= since;
}

function createMedia({ mediaDir, posterDir, open = fs.promises.open }) {
  const host = mediaDir ? path.resolve(mediaDir) : null;
  const roots = { mp4: [host], jpg: [host, path.resolve(posterDir)] };
  /** True only when every approved video is a readable, non-empty regular file. */
  async function enabled() {
    if (!host) return false;
    for (const name of VIDEOS) {
      const file = path.join(host, name);
      try {
        const st = await fs.promises.lstat(file);
        if (!st.isFile() || st.size === 0) return false;
        await fs.promises.access(file, fs.constants.R_OK);
      } catch { return false; }   // missing, unreadable or a broken folder: keep the video hidden
    }
    return true;
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
    const asset = type && await enabled() ? await openAsset(roots[path.extname(name).slice(1)], name, open) : null;
    if (!asset) return notFound(res);
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

module.exports = { createMedia, parseRange, ASSETS, VIDEOS };
