'use strict';
// The public pages (landing, login, privacy, terms, guide) share one Nocturne theme:
// /site/theme.css holds every token, each page's own sheet only uses them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const THEME = read('public/site/theme.css');
const OWN = { 'landing.html': '/landing/nocturne.css', 'login.html': '/site/login.css', 'privacy.html': '/site/doc.css', 'terms.html': '/site/doc.css', 'guide.html': '/site/doc.css' };
const SHEETS = ['public/site/login.css', 'public/site/doc.css', 'public/landing/nocturne.css'];
const noComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('every public page loads the shared theme first, then its own sheet, with no inline styles', () => {
  for (const [page, own] of Object.entries(OWN)) {
    const html = read('public/' + page);
    assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]), ['/site/theme.css', own], page);
    assert.doesNotMatch(html, /<style\b/i, page);
    assert.doesNotMatch(html, /\sstyle="/i, page);
    assert.match(html, /<meta name="color-scheme" content="dark">/, page);
    // One browser colour for the whole public site, so moving between pages never flashes.
    const themeColours = [...html.matchAll(/<meta name="theme-color" content="([^"]+)"/g)].map(m => m[1]);
    assert.ok(themeColours.length >= 1, page);
    for (const c of themeColours) assert.equal(c, '#050A08', page);
    assert.match(html, /<link rel="preload" href="\/landing\/fonts\/serif-display\.woff2" as="font" type="font\/woff2" crossorigin>/, page);
  }
});

test('tokens live in theme.css only: page sheets define none, and login and document sheets use no colour literals', () => {
  const defined = new Set([...THEME.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
  for (const token of ['--bg', '--ivory', '--muted', '--text-read', '--emerald', '--emerald-hi', '--on-emerald', '--line', '--field', '--field-line', '--danger', '--warn', '--ok',
    '--f-body', '--f-serif', '--f-num', '--fs-base', '--fs-read', '--measure', '--sp-4', '--r-md', '--r-pill', '--focus', '--focus-w', '--btn-primary', '--print-ink', '--print-paper'])
    assert.ok(defined.has(token), token);
  assert.match(THEME, /--bg:#050A08;/);
  assert.match(THEME, /color-scheme:dark/);
  assert.doesNotMatch(THEME, /prefers-color-scheme/);
  for (const rel of SHEETS) {
    const css = noComments(read(rel));
    assert.doesNotMatch(css, /:root\b|@font-face/, rel + ' defines tokens or fonts of its own');
    const local = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
    for (const [, name] of css.matchAll(/var\((--[a-z0-9-]+)/g)) assert.ok(defined.has(name) || local.has(name), `${rel} uses ${name}, which theme.css does not define`);
  }
  for (const rel of ['public/site/login.css', 'public/site/doc.css']) {
    const css = noComments(read(rel)).replace(/url\("data:[^"]*"\)/g, '');
    assert.deepEqual(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/gi) || [], [], rel + ' takes every colour from theme.css');
  }
});

test('the display serif covers every heading on the login and document pages', () => {
  const chars = new Set([...read('public/landing/fonts/serif-display.chars.txt')]);
  const cjk = c => /[　-〿㐀-鿿＀-￯]/.test(c);
  let text = '';
  for (const page of ['privacy.html', 'terms.html', 'guide.html']) for (const [, , h] of read('public/' + page).matchAll(/<h([123])\b[^>]*>([\s\S]*?)<\/h\1>/g)) text += h.replace(/<[^>]+>/g, '');
  const login = read('public/login.html');
  const titles = [...login.matchAll(/"hero\.title":\s*"([^"]*)"/g)].map(m => m[1]);
  assert.equal(titles.length, 2, 'zh and en login titles');
  text += titles.join('') + login.match(/<h1 id="title-h1">([^<]*)<\/h1>/)[1];
  const missing = [...new Set([...text].filter(c => cjk(c) && !chars.has(c)))];
  assert.deepEqual(missing, [], 'add these to serif-display.chars.txt and rebuild serif-display.woff2');
  // Only the serif display face is used for headings; body text stays in the system face.
  assert.match(THEME, /h1,h2,h3\{font-family:var\(--f-serif\)/);
});

test('forms on dark: field borders, focus, error, disabled, checkbox and autofill states are all styled', () => {
  const css = noComments(read('public/site/login.css'));
  assert.match(css, /input\{[^}]*border:1px solid var\(--field-line\)[^}]*background:var\(--field\)[^}]*color:var\(--ivory\)/);
  assert.match(css, /input:focus-visible\{outline:var\(--focus-w\) solid var\(--focus\)/);
  assert.match(css, /input:user-invalid\{border-color:var\(--danger\)/);
  assert.match(css, /input:disabled\{/);
  assert.match(css, /button\.primary:disabled\{background:var\(--solid-hi\);color:var\(--muted\)/);
  assert.match(css, /input::placeholder\{color:var\(--placeholder\)/);
  assert.match(css, /\.checkline input\[type="checkbox"\]:checked\{/);
  assert.match(css, /\.err\{[^}]*color:var\(--danger\)/);
  // Chrome and Safari paint autofilled fields pale blue or yellow; keep them dark with ivory text.
  assert.match(css, /input:-webkit-autofill,[^{]*\{[^}]*-webkit-text-fill-color:var\(--ivory\)[^}]*-webkit-box-shadow:0 0 0 100px var\(--field-filled\) inset/);
  assert.match(css, /input:autofill\{/);
  assert.match(THEME, /:focus-visible\{outline:var\(--focus-w\) solid var\(--focus\)/);
});

test('long text: 17px at 1.8 line height, about 68 characters a line, underlined links, printed dark on white', () => {
  const css = noComments(read('public/site/doc.css'));
  assert.match(THEME, /--fs-read:17px;/);
  assert.match(THEME, /--lh-read:1\.8;/);
  assert.match(THEME, /--measure:68ch;/);
  assert.match(css, /body\{[^}]*color:var\(--text-read\);font-size:var\(--fs-read\);line-height:var\(--lh-read\)/);
  assert.match(css, /p,li\{max-width:var\(--measure\)\}/);
  assert.match(css, /\ba\{color:var\(--emerald-hi\);text-decoration:underline/);
  assert.match(THEME, /@media print\{[\s\S]*html,body\{background:var\(--print-paper\)!important;color:var\(--print-ink\)!important\}/);
  assert.match(css, /@media print\{[\s\S]*\.top-row\{display:none\}/);
});

test('appearance only: the pages keep their inline scripts, ids and copy (styles moved, nothing else)', () => {
  // The inline scripts stay byte-for-byte; their CSP hashes are rebuilt by npm run build as before.
  for (const page of ['login.html', 'privacy.html', 'terms.html', 'guide.html']) {
    const html = read('public/' + page);
    assert.equal((html.match(/<script>/g) || []).length, 1, page);
    assert.match(html, /<main\b/, page);
  }
  const login = read('public/login.html');
  for (const id of ['title-h1', 'lang-switch', 'subtitle', 'banner', 'f', 'tabs', 'method-tabs', 'nw', 'n', 'ew', 'e', 'phw', 'ph', 'pw', 'p', 'iw', 'i', 'cw', 'c-terms', 'c-sensitive', 'phone-forgot-msg', 'err', 'reload-policy', 'go', 'forgot', 'resend', 'hint-text', 'terms-link', 'privacy-link', 'help-link'])
    assert.match(login, new RegExp(`\\sid="${id}"`), id);
});
