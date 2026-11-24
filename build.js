#!/usr/bin/env node
// 把 app/index.html（和 Claude 页面版同一份源码）转成独立部署版 public/index.html：
// 1) 在页面脚本前插入 shim.js（登录、存储、照片、AI 改走自己的服务器）
// 2) 去掉 Google Fonts（国内打不开会拖慢首屏；页面字体有系统字体兜底）
// 3) HEIC 转换库改从本站 /vendor 加载
"use strict";
const fs = require("node:fs"), path = require("node:path");
const src = fs.readFileSync(path.join(__dirname, "app", "index.html"), "utf8");
// Copy pinned dependencies from npm's integrity-checked installation.
const vendorDir = path.join(__dirname, "public/vendor");
fs.mkdirSync(vendorDir, {recursive: true});
for (const [source, target] of [["dist/heic2any.min.js", "heic2any.min.js"], ["LICENSE.md", "heic2any-LICENSE.md"]]) {
  fs.copyFileSync(path.join(__dirname, "node_modules/heic2any", source), path.join(vendorDir, target));
}
// Extract only the pinned bundle's literal worker payload, never execute vendor code.
const heicPath = path.join(vendorDir, "heic2any.min.js");
const heic = fs.readFileSync(heicPath, "utf8");
const workerPattern = /var r=new Blob\(\[('(?:\\.|[^'\\])*')\],\{type:"application\/javascript"\}\);window\.__heic2any__worker=new Worker\(URL\.createObjectURL\(r\)\);/;
const workerMatch = heic.match(workerPattern);
if (!workerMatch) throw new Error("Pinned HEIC worker layout changed");
const workerSource = require("node:vm").runInNewContext(workerMatch[1], {}, {timeout:1000});
fs.writeFileSync(path.join(vendorDir, "heic2any-worker.js"), workerSource);
fs.writeFileSync(heicPath, heic.replace(workerPattern, 'window.__heic2any__worker=new Worker("/vendor/heic2any-worker.js");'));
let out = src;
const must = (re, rep, label) => { if (!re.test(out)) throw new Error("build: 找不到 " + label); out = out.replace(re, rep); };
must(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*/, "", "fonts preconnect");
must(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\s*/, "", "fonts css");
must(/https:\/\/cdn\.jsdelivr\.net\/npm\/heic2any@0\.0\.4\/dist\/heic2any\.min\.js/, "/vendor/heic2any.min.js", "heic2any");
const errVersion = require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(__dirname, "public/client-errors.js"))).digest("hex").slice(0, 16);
const shimVersion = require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(__dirname, "public/shim.js"))).digest("hex").slice(0, 16);
must(/<script>/, `<script src="/client-errors.js?v=${errVersion}"></script>\n<script src="/shim.js?v=${shimVersion}"></script>\n<script>`, "script");
if (!/^<!doctype html>/i.test(out.trimStart())) out = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n' + out + "\n</body></html>\n";
// A successful build must not ship missing runtime libraries.
for (const asset of ["vendor/heic2any-worker.js", "vendor/heic2any.min.js", "ocr/tesseract.min.js", "ocr/worker.min.js",
  "ocr/tesseract-core-lstm.wasm.js", "ocr/tesseract-core-simd-lstm.wasm.js",
  "ocr/tesseract-core-relaxedsimd-lstm.wasm.js", "ocr/eng.traineddata.gz.wasm", "ocr/chi_sim.traineddata.gz.wasm"]) {
  if (!fs.existsSync(path.join(__dirname, "public", asset))) throw new Error("Missing runtime asset: " + asset);
}
fs.writeFileSync(path.join(__dirname, "public", "index.html"), out);
console.log("已生成 public/index.html");

// Bind CSP to the final emitted bytes, including inlined/rewritten assets.
const hashes = new Set();
for (const name of ["index.html", "login.html", "privacy.html", "terms.html", "guide.html"]) {
  const html = fs.readFileSync(path.join(__dirname, "public", name), "utf8");
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\bsrc\s*=/i.test(match[1])) hashes.add("'sha256-" + require("node:crypto").createHash("sha256").update(match[2].replace(/\r\n?/g, "\n")).digest("base64") + "'");
  }
}
fs.writeFileSync(path.join(__dirname, "public", "csp-hashes.json"), JSON.stringify([...hashes]) + "\n");
