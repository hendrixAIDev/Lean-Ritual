#!/usr/bin/env node
// 把 app/index.html（和 Claude 页面版同一份源码）转成独立部署版 public/index.html：
// 1) 在页面脚本前插入 shim.js（登录、存储、照片、AI 改走自己的服务器）
// 2) 去掉 Google Fonts（国内打不开会拖慢首屏；页面字体有系统字体兜底）
// 3) HEIC 转换库改从本站 /vendor 加载
"use strict";
const fs = require("node:fs"), path = require("node:path");
const src = fs.readFileSync(path.join(__dirname, "app", "index.html"), "utf8");
let out = src;
const must = (re, rep, label) => { if (!re.test(out)) throw new Error("build: 找不到 " + label); out = out.replace(re, rep); };
must(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*/, "", "fonts preconnect");
must(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\s*/, "", "fonts css");
must(/https:\/\/cdn\.jsdelivr\.net\/npm\/heic2any@0\.0\.4\/dist\/heic2any\.min\.js/, "/vendor/heic2any.min.js", "heic2any");
must(/<script>/, '<script src="/shim.js"></script>\n<script>', "script");
if (!/^<!doctype html>/i.test(out.trimStart())) out = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n' + out + "\n</body></html>\n";
fs.writeFileSync(path.join(__dirname, "public", "index.html"), out);
console.log("已生成 public/index.html");
