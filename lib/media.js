"use strict";
// Public marketing media (the landing-page intro videos and their posters).
// Files are looked up in order: the host's MEDIA_DIR first (large MP4s that are
// deliberately kept out of Git and out of each release bundle), then the posters
// bundled in public/media. Supports single byte ranges so browsers can seek and
// stream, plus validators and a long cache so repeat views cost nothing.
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream");

const NAME = /^\/media\/([a-z0-9][a-z0-9-]{0,63}\.(mp4|jpg|webp))$/;
const TYPES = { mp4: "video/mp4", jpg: "image/jpeg", webp: "image/webp" };
const CACHE = "public, max-age=604800";   // 7 days; replacing a file changes its ETag

/** Parse one "bytes=a-b" range. Returns {start,end}, null (serve whole file) or "invalid". */
function parseRange(header, size) {
  if (typeof header !== "string" || !header.trim()) return null;
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return header.includes(",") || !/^bytes=/i.test(header.trim()) ? null : "invalid";
  if (m[1] === "" && m[2] === "") return "invalid";
  let start, end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!suffix) return "invalid";
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

function statFirst(dirs, name) {
  for (const dir of dirs) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) return { file, st };
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") console.error("media lookup failed", error.code || "error");
    }
  }
  return null;
}

function createMedia({ dirs }) {
  const roots = dirs.filter(Boolean).map(d => path.resolve(d));
  function notFound(res) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
    res.end();
  }
  function handle(req, res) {
    const method = req.method;
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
      return res.end();
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return notFound(res); }
    const match = pathname.match(NAME);
    if (!match) return notFound(res);
    const found = statFirst(roots, match[1]);
    if (!found) return notFound(res);
    const { file, st } = found;
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      "Content-Type": TYPES[match[2]],
      "Accept-Ranges": "bytes",
      "Cache-Control": CACHE,
      ETag: etag,
      "Last-Modified": st.mtime.toUTCString()
    };
    const inm = req.headers["if-none-match"];
    if (inm && inm.split(",").map(s => s.trim().replace(/^W\//, "")).includes(etag)) {
      res.writeHead(304, headers);
      return res.end();
    }
    const ifRange = req.headers["if-range"];
    const range = ifRange && ifRange.trim() !== etag ? null : parseRange(req.headers.range, st.size);
    if (range === "invalid") {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${st.size}` });
      return res.end();
    }
    const status = range ? 206 : 200;
    const start = range ? range.start : 0;
    const end = range ? range.end : st.size - 1;
    const out = { ...headers, "Content-Length": st.size ? end - start + 1 : 0 };
    if (range) out["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
    if (method === "HEAD" || st.size === 0) {
      res.writeHead(status, out);
      return res.end();
    }
    const stream = fs.createReadStream(file, { start, end });
    stream.once("error", error => {
      if (res.headersSent) return;
      console.error("media stream failed", error.code || "error");
      notFound(res);
    });
    stream.once("open", () => {
      res.writeHead(status, out);
      pipeline(stream, res, error => {
        if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE") console.error("media stream failed", error.code || "error");
      });
    });
  }
  return { handle };
}

module.exports = { createMedia, parseRange };
