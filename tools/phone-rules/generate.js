#!/usr/bin/env node
// Rebuilds the region table in public/site/phone-rules.js and the test fixtures in
// tests/fixtures/phone-examples.json from libphonenumber's metadata. libphonenumber-js is a
// tool here, not a dependency: install it anywhere outside the repo and pass its folder.
//
//   npm install --prefix /tmp/lpn libphonenumber-js@1.12.31
//   node tools/phone-rules/generate.js /tmp/lpn/node_modules/libphonenumber-js
//
// Per region it keeps the calling code, the national-prefix rule (with its transform), the
// national number pattern, the possible lengths and the leading digits: what parsing a domestic
// number needs, without the formatting and number-type data (about 18 KB in all).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const lib = process.argv[2];
if (!lib || !fs.existsSync(path.join(lib, "package.json"))) {
  console.error("usage: node tools/phone-rules/generate.js <path to libphonenumber-js>");
  process.exit(2);
}
const ROOT = path.resolve(__dirname, "../..");
const version = require(path.join(lib, "package.json")).version;
const meta = require(path.join(lib, "metadata.max.json"));
const { Metadata } = require(path.join(lib, "core"));
const max = require(path.join(lib, "max"));
const examples = require(path.join(lib, "examples.mobile.json"));

const m = new Metadata(meta);
const regions = {}, fixtures = [], exampleText = {};
for (const iso of Object.keys(meta.countries).sort()) {
  m.selectNumberingPlan(iso);
  const p = m.numberingPlan;
  regions[iso] = [p.callingCode(), p.nationalPrefixForParsing() || null, p.nationalPrefixTransformRule() || null, p.nationalNumberPattern(), p.possibleLengths(), p.leadingDigits() || null];
  const example = max.getExampleNumber(iso, examples);
  if (!example) continue;
  exampleText[iso] = example.formatNational();
  fixtures.push({ iso, national: example.formatNational(), e164: example.number });
}
const codes = {};
for (const [cc, isos] of Object.entries(meta.country_calling_codes)) if (isos.some(iso => regions[iso])) codes[cc] = isos.filter(iso => regions[iso]);

const json = v => JSON.stringify(v);
const block = [
  "  /* BEGIN GENERATED */",
  `  var SOURCE = ${json("libphonenumber-js " + version + " metadata")};`,
  "  var REGIONS = {",
  Object.entries(regions).map(([iso, row]) => `    ${iso}: ${json(row)}`).join(",\n"),
  "  };",
  `  var CODES = ${json(codes)};`,
  `  var EXAMPLES = ${json(exampleText)};`,
  "  /* END GENERATED */"
].join("\n");

const file = path.join(ROOT, "public/site/phone-rules.js");
const src = fs.readFileSync(file, "utf8");
const next = src.replace(/  \/\* BEGIN GENERATED \*\/[\s\S]*?  \/\* END GENERATED \*\//, () => block);
if (next === src && !src.includes(block)) throw new Error("GENERATED markers not found in " + file);
fs.writeFileSync(file, next);
fs.writeFileSync(path.join(ROOT, "tests/fixtures/phone-examples.json"),
  JSON.stringify({ source: "libphonenumber-js " + version + " mobile examples, national format", examples: fixtures }, null, 1) + "\n");
console.log(`phone-rules.js: ${Object.keys(regions).length} regions from libphonenumber-js ${version}; ${fixtures.length} fixtures`);
