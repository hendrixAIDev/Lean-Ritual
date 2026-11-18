#!/usr/bin/env node
"use strict";
// Deterministically generate home-screen, PWA manifest, and favicon PNGs from public/icons/icon.svg.
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const iconsDir = path.join(__dirname, "..", "public", "icons");
const svgSource = fs.readFileSync(path.join(iconsDir, "icon.svg"), "utf8");

// Full-bleed variant (no rounded-corner transparency) for iOS apple-touch-icon
// (iOS applies its own squircle mask and fills alpha with black) and W3C maskable icon.
const fullBleedSvg = svgSource.replace(/\brx="112"/, 'rx="0"');
if (fullBleedSvg === svgSource) {
  throw new Error("Expected background rect rx=\"112\" in public/icons/icon.svg");
}

const targets = [
  { file: "apple-touch-icon.png", size: 180, svg: fullBleedSvg },
  { file: "icon-192.png", size: 192, svg: svgSource },
  { file: "icon-512.png", size: 512, svg: svgSource },
  { file: "icon-maskable-512.png", size: 512, svg: fullBleedSvg },
  { file: "favicon-32.png", size: 32, svg: svgSource },
  { file: "favicon-16.png", size: 16, svg: svgSource },
];

(async () => {
  for (const { file, size, svg } of targets) {
    const outPath = path.join(iconsDir, file);
    await sharp(Buffer.from(svg), { density: 384 })
      .resize(size, size, { fit: "contain" })
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toFile(outPath);
    console.log(`Generated public/icons/${file} (${size}x${size})`);
  }
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
