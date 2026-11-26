'use strict';
// The public pages keep their code in files under public/site/ (no inline scripts, see CSP).
// Tests that used to read a page's inline <script> read the file the page loads instead.
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.resolve(__dirname, '../../public');

/** The page script a public HTML page loads (/site/<page>.js), given the page's HTML. */
function pageScript(html) {
  const m = String(html).match(/<script src="(\/site\/(?:login|privacy|terms|guide)\.js)"/);
  if (!m) throw new Error('page loads no /site/<page>.js script');
  return fs.readFileSync(path.join(PUBLIC, m[1]), 'utf8');
}

/** A public page's HTML followed by the page script it loads: everything its copy can come from. */
function pageWithScript(name) {
  const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
  return html + '\n' + pageScript(html);
}

module.exports = { pageScript, pageWithScript };
