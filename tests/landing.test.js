'use strict';
// Landing page at "/": routing for visitors vs signed-in users, CSP-safe markup,
// honest AI copy, i18n parity, font coverage, and the Range-capable media route.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { parseRange } = require('../lib/media');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { renderLanding, MARKER } = require('../lib/landing');

const PAGE = read('public/landing.html');          // as shipped: video hidden
const FILM = read('lib/landing-film.html');
const HTML = PAGE.replace(MARKER, () => FILM);      // with the video section

const JS = read('public/landing/nocturne.js');
const BOOT = read('public/landing/boot.js');
// The landing page loads the shared site theme (tokens, fonts, base) before its own sheet.
const THEME = read('public/site/theme.css');
const CSS = THEME + read('public/landing/nocturne.css');

function loadI18N() {
  const start = JS.indexOf('const I18N = ');
  const end = JS.indexOf('\n  };\n', start);
  assert.ok(start > 0 && end > start, 'I18N block not found');
  return vm.runInNewContext('(' + JS.slice(start + 'const I18N = '.length, end + 4) + ')');
}

test('landing markup is CSP-safe: no inline script, handlers, style attributes or third-party URLs', () => {
  for (const m of HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    assert.match(m[1], /\bsrc\s*=\s*"\/landing\/[a-z]+\.js"/, 'every script is an external same-origin file');
    assert.equal(m[2].trim(), '');
  }
  assert.doesNotMatch(HTML, /<[^>]+\son\w+\s*=/i);
  assert.doesNotMatch(HTML, /\sstyle\s*=/i);
  assert.doesNotMatch(HTML, /<style\b/i);
  for (const [name, text] of [['html', HTML], ['css', CSS], ['js', JS], ['boot', BOOT]]) {
    const external = text.match(/(?:https?:)?\/\/(?!www\.w3\.org\/2000\/svg)[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
    assert.deepEqual(external, [], name + ' must not reference third-party hosts');
  }
  for (const [, url] of CSS.matchAll(/url\(([^)]+)\)/g)) {
    assert.match(url, /^\/landing\/fonts\/[a-z-]+\.woff2$/);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', url)), url + ' exists');
  }
  for (const [, attr, url] of HTML.matchAll(/\s(src|href)="([^"]+)"/g)) {
    assert.match(url, /^(\/|#|mailto:)/, attr + ' ' + url + ' stays same-origin');
    const file = url.split('?')[0];
    if (/^\/(landing|icons|media)\//.test(file) || file === '/manifest.webmanifest') assert.ok(fs.existsSync(path.join(ROOT, 'public', file)), file + ' exists');
  }
  for (const lang of ['zh', 'en']) for (const shot of ['workout', 'checkin', 'meal', 'coach', 'charts'])
    assert.ok(fs.existsSync(path.join(ROOT, 'public/landing/img', `${lang}-${shot}.webp`)));
  assert.equal(fs.existsSync(path.join(ROOT, 'public/media')), false, 'outdated v10 posters are not bundled');
});

test('calls to action: invite sign-up, sign-in and an invite request to the privacy-page contact', () => {
  assert.match(HTML, /<a class="btn primary" href="\/login\.html\?invite="><span data-i="cta\.invite">用邀请码注册<\/span>/);
  assert.match(HTML, /<a class="btn ghost" href="\/login\.html" data-i="cta\.signin">登录<\/a>/);
  const privacyContact = read('public/privacy.html').match(/mailto:([^"?]+)/)[1];
  assert.match(JS, new RegExp('const CONTACT = "' + privacyContact.replace(/\./g, '\\.') + '"'));
  for (const m of HTML.matchAll(/data-ask href="mailto:([^"]+)"/g)) assert.equal(m[1], privacyContact);
  // login.html opens its invite sign-up view whenever the invite parameter is present.
  assert.match(read('public/site/login.js'), /params\.has\("invite"\) \? "register"/);
});

test('zh and en copy have the same keys and cover every data-i hook', () => {
  const { zh, en } = loadI18N();
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const [, key] of HTML.matchAll(/data-i(?:-aria)?="([^"]+)"/g)) {
    assert.ok(key in zh, 'zh has ' + key);
    assert.ok(key in en, 'en has ' + key);
  }
  for (const [key, value] of Object.entries(en)) assert.doesNotMatch(value, /[\u4e00-\u9fff]/, 'en.' + key + ' has no Chinese');
});

test('the video section is absent by default and inserted only when the videos are available', async () => {
  const hidden = await renderLanding(path.join(ROOT, 'public'), false);
  const shown = await renderLanding(path.join(ROOT, 'public'), true);
  assert.equal(shown, HTML);
  assert.equal(hidden, PAGE.replace(MARKER, ''));
  for (const page of [PAGE.replace(MARKER, ''), hidden]) assert.doesNotMatch(page, /film|<video|\/media\/|data-i="video\.|播放|视频/i);
  for (const part of ['id="film"', 'id="play"', 'data-i="video.t"']) assert.equal(shown.split(part).length, 2, part);
  // Section numbers come from a counter, so hiding the video leaves no gap in the sequence.
  assert.doesNotMatch(HTML, /No\.\s*0\d/);
  assert.match(CSS, /counter-increment:sec;content:"No\. " counter\(sec,decimal-leading-zero\)/);
});

test('every number on the page is backed by the app or is sample data', () => {
  const { zh, en } = loadI18N();
  const app = read('app/index.html');
  // [pattern in the copy, evidence]. Anything left over after removing these fails.
  assert.match(app, /"setup\.newTitle":"先花一分钟建档"/);
  assert.match(app, /"setup\.newTitle":"1-Minute Setup"/);
  assert.match(app, /有照片时一般 1 分钟左右/);
  assert.match(app, /Photo estimates take ~1 minute/);
  assert.match(app, /AI 会结合最近 14 天的记录/);
  assert.match(app, /\.slice\(0,3\)\.map\(a => \(\{name:String/);             // up to 3 swaps
  for (const fn of ['chart', 'balanceChart', 'liftChart']) assert.match(app, new RegExp('function ' + fn + '\\('));   // 3 charts
  const allowed = [/1 分钟/g, /1 minute\b/g, /(最近 )?14 (天|days)/g, /7[- ](天平均|day average|day avg)/g, /最多推荐 3 个/g, /up to 3 options/g, /© 2026/g,
    /60 kg/g, /72\.7 kg/g, /540 kcal/g, /46\.5 g/g];
  for (const [lang, copy] of Object.entries({ zh, en })) for (const [key, value] of Object.entries(copy)) {
    const rest = allowed.reduce((text, re) => text.replace(re, ''), value);
    assert.doesNotMatch(rest, /[0-9]/, `${lang}.${key}: ${value}`);
    assert.doesNotMatch(value, /秒|second|sec\b|一键|one[- ]tap|in one tap|随时撤销/i, `${lang}.${key}: ${value}`);
  }
  // Big animated figures: sample kcal/kg, 7-day average, 14-day review, 3 charts.
  assert.deepEqual([...HTML.matchAll(/data-count="(\d+)"/g)].map(m => +m[1]), [7, 60, 540, 14, 3]);
  assert.match(zh['f1.t'], /快速打卡/);
  assert.match(en['f1.t'], /Quick daily check-in/);
  // A first-time lift has no suggestion, so the page must not promise one for every lift.
  assert.match(app, /if \(!h\.length\) return \{w:null/);
  assert.match(zh['f2.d'], /练过的动作/);
  assert.match(en['f2.d'], /lifts you've logged/);
  assert.match(zh['board.note'], /示例/);
  assert.match(en['board.note'], /examples/);
  assert.match(HTML, /data-i="board\.note"/);
});

test('AI copy matches the AI features the app actually ships', () => {
  const { zh, en } = loadI18N();
  // Every model call in the app, by enclosing function. A new one must be described on the page too.
  const app = read('app/index.html');
  const callers = [...app.matchAll(/S\.sample\.json\(/g)].map(m => [...app.slice(0, m.index).matchAll(/\nasync function (\w+)\(/g)].at(-1)[1]);
  assert.deepEqual(callers.sort(), ['aiSuggest', 'estimateMeal', 'runAI']);
  assert.equal((HTML.match(/data-i="ai\.\dt"/g) || []).length, callers.length, 'one card per AI feature');
  assert.match(zh['ai.1d'], /照片或文字.*热量和蛋白质.*可以改/);
  assert.match(en['ai.1d'], /photo or a few words.*edit/);
  assert.match(zh['ai.2d'], /最多推荐 3 个/);
  assert.match(en['ai.2d'], /up to 3/);
  assert.match(zh['ai.3d'], /你提出时.*最近 14 天.*可采纳，也可撤销/);
  assert.match(en['ai.3t'] + ' ' + en['ai.3d'], /last 14 days.*When you ask.*apply or undo/);
  assert.match(zh['ai.note'], /公式计算，不用 AI.*不构成医疗建议/);
  assert.match(en['ai.note'], /formulas, not AI.*not medical advice/);
  // The app tells users photo estimates take about a minute; the page must not promise seconds.
  assert.match(app, /有照片时一般 1 分钟左右/);
  assert.match(zh['f3.d'], /1 分钟左右/);
  assert.match(en['f3.d'], /about a minute/);
  const all = [...Object.values(zh), ...Object.values(en), HTML].join('\n');
  for (const banned of [/AI\s*为你定制/, /AI\s*定制/, /AI\s*生成.*计划/, /AI[- ]?(builds|creates|generates|designs)/i, /AI[- ]customi[sz]ed/i, /AI[- ]made plan/i,
    /持续调整|不断调整|自动调整/, /tuned by AI|keeps adjusting|automatically adjust/i, /只用在两个|两件事/, /exactly two|two jobs/i, /几秒/, /in seconds/i, /coach checks in/i, /随时撤销|一键撤销/, /undo anytime/i])
    assert.doesNotMatch(all, banned);
});

test('Nocturne is dark only, and leaves every link to the browser', () => {
  assert.deepEqual([...PAGE.matchAll(/<meta name="(color-scheme|theme-color)" content="([^"]+)"([^>]*)>/g)].map(m => [m[1], m[2], m[3]]), [['color-scheme', 'dark', ''], ['theme-color', '#050A08', '']]);
  assert.match(CSS, /--bg:#050A08;/);
  assert.match(CSS, /html\{[^}]*background:var\(--bg\)/);
  assert.match(CSS, /color-scheme:dark/);
  assert.doesNotMatch(CSS, /prefers-color-scheme/);
  // Sign-in must start at once: no script may cancel, delay or replace a navigation.
  assert.doesNotMatch(JS, /preventDefault|stopPropagation|setTimeout|setInterval|location\.|\.href\s*=\s*["'`]\/|window\.open/);
  assert.doesNotMatch(JS, /addEventListener\("(pointerdown|mousedown|touchstart|submit|beforeunload|pagehide)"/);
  assert.equal((JS.match(/addEventListener\("click"/g) || []).length, 2, 'clicks are handled on the play and language buttons only');
});

/** Copyright strings (name ID 0) embedded in a woff2 file, read with Node's own Brotli. */
function embeddedCopyright(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('latin1', 0, 4), 'wOF2');
  const numTables = buf.readUInt16BE(12), compressed = buf.readUInt32BE(20);
  const TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca'];
  let at = 48;
  const base128 = () => { let v = 0, byte; do { byte = buf[at++]; v = v * 128 + (byte & 127); } while (byte & 128); return v; };
  let offset = 0, name = null;
  for (let i = 0; i < numTables; i++) {
    const flags = buf[at++], index = flags & 63, version = flags >> 6;
    let tag = TAGS[index];
    if (index === 63) { tag = buf.toString('latin1', at, at + 4); at += 4; }
    const original = base128();
    const transformed = (tag === 'glyf' || tag === 'loca') ? version !== 3 : version !== 0;
    const length = transformed ? base128() : original;
    if (tag === 'name') name = [offset, length];
    offset += length;
  }
  const table = require('node:zlib').brotliDecompressSync(buf.subarray(at, at + compressed)).subarray(name[0], name[0] + name[1]);
  const strings = table.readUInt16BE(4), found = new Set();
  for (let i = 0; i < table.readUInt16BE(2); i++) {
    const r = 6 + i * 12;
    if (table.readUInt16BE(r + 6) !== 0) continue;
    const raw = Buffer.from(table.subarray(strings + table.readUInt16BE(r + 10), strings + table.readUInt16BE(r + 10) + table.readUInt16BE(r + 8)));
    found.add(table.readUInt16BE(r) === 1 ? raw.toString('latin1') : raw.swap16().toString('utf16le'));
  }
  return [...found];
}

test('each shipped font travels with the OFL and the copyright notice embedded in it', () => {
  const dir = path.join(ROOT, 'public/landing/fonts');
  for (const [font, licence] of [['serif-display.woff2', 'OFL-NotoSerifSC.txt'], ['num-medium.woff2', 'OFL-BarlowCondensed.txt']]) {
    const text = fs.readFileSync(path.join(dir, licence), 'utf8'), notices = embeddedCopyright(path.join(dir, font));
    assert.ok(notices.length >= 1, font + ' embeds a copyright');
    for (const notice of notices) assert.ok(text.includes(notice), `${licence} records "${notice}"`);
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/);
  }
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.woff2')).sort(), ['num-medium.woff2', 'serif-display.woff2']);
});

test('public/landing ships only files the page uses, under names Scoreboard never cached', () => {
  const used = new Set(['fonts/serif-display.chars.txt', 'fonts/OFL-BarlowCondensed.txt', 'fonts/OFL-NotoSerifSC.txt']);
  for (const [, file] of (HTML + CSS).matchAll(/\/landing\/([\w./-]+)/g)) used.add(file);
  for (const [, shot] of HTML.matchAll(/data-shot="(\w+)"/g)) for (const lang of ['zh', 'en']) used.add(`img/${lang}-${shot}.webp`);
  const shipped = fs.readdirSync(path.join(ROOT, 'public/landing'), { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => path.relative(path.join(ROOT, 'public/landing'), path.join(e.parentPath, e.name)));
  assert.deepEqual(shipped.sort(), [...used].sort());
  // Those URLs were served with a day-long cache, so reusing them would mix old code with the new page.
  for (const old of ['landing.css', 'landing.js', 'fonts/display-cjk.woff2', 'fonts/cond-semibold.woff2', 'fonts/cond-black-italic.woff2']) assert.ok(!shipped.includes(old), old);
});

test('content never depends on script: CSS hides things only under .live, which nocturne.js sets last', () => {
  for (const [, selector] of CSS.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*\s*\}/g, '').matchAll(/([^{}]+)\{[^}]*opacity:0/g))
    assert.match(selector, /\.live|\.top\.clear::before|\.pin /, selector.trim());
  assert.ok(JS.indexOf('classList.add("live")') > JS.indexOf('apply(lang);'));
  assert.equal((JS.match(/addEventListener\("(scroll|wheel|touchmove|keydown)"/g) || []).length, 0, 'scrolling and keys are never taken over');
});

test('the no-JS fallback copy in landing.html is the zh copy', () => {
  const { zh } = loadI18N();
  for (const [, key, text] of HTML.matchAll(/data-i="([^"]+)"[^>]*>([^<]*)</g)) assert.equal(text, zh[key], key);
});

test('language choice follows login.html: ?lang, then saved bj-lang, then browser language, then zh', () => {
  const run = ({ search = '', saved = null, languages, language }) => {
    const store = new Map(saved ? [['bj-lang', saved]] : []);
    const attrs = {};
    const root = { className: '', lang: 'zh-CN', setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; } };
    const ctx = {
      document: { documentElement: root },
      location: { search, replace() { throw new Error('unexpected redirect'); } },
      localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
      navigator: { languages, language },
      URLSearchParams, setTimeout: () => 0,
      matchMedia: () => ({ matches: false })
    };
    ctx.window = ctx;
    vm.runInNewContext(BOOT, ctx);
    return { lang: attrs['data-lang'], store, pending: 'data-i18n-pending' in attrs, js: root.className.includes('js') };
  };
  assert.equal(run({ languages: ['en-US'] }).lang, 'en');
  assert.equal(run({ languages: ['en-US'] }).pending, true);
  assert.equal(run({ languages: ['fr-FR', 'zh-TW'] }).lang, 'zh');
  assert.equal(run({ languages: [] }).lang, 'zh');
  assert.equal(run({ languages: ['zh-CN'], saved: 'en' }).lang, 'en');
  const explicit = run({ search: '?lang=zh', saved: 'en', languages: ['en-US'] });
  assert.equal(explicit.lang, 'zh');
  assert.equal(explicit.store.get('bj-lang'), 'zh');
  assert.equal(explicit.store.get('bj-lang-pending'), 'zh');
  assert.equal(run({ search: '?lang=xx', languages: ['zh-CN'] }).lang, 'zh');
  assert.equal(run({ languages: ['zh-CN'] }).js, true);
  // The toggle writes the same keys login.html reads, so the choice carries into sign-in.
  for (const key of ['bj-lang', 'bj-lang-set-at', 'bj-lang-pending']) assert.match(JS, new RegExp('write\\("' + key + '"'));
});

test('the display font subset covers every Chinese character on the page', () => {
  const chars = new Set([...read('public/landing/fonts/serif-display.chars.txt')]);
  const missing = [...new Set([...HTML + JS].filter(c => /[　-〿㐀-鿿＀-￯]/.test(c) && !chars.has(c)))];
  assert.deepEqual(missing, [], 'rebuild public/landing/fonts/serif-display.woff2 for the new copy');
});

test('the video is attached only on play and points at the stable /media paths', () => {
  assert.match(HTML, /<video id="film" playsinline preload="none"><\/video>/);
  assert.match(JS, /const MEDIA = "\/media\/intro-";/);
  assert.match(JS, /\(wide\.matches \? "-16x9" : "-9x16"\)/);
  assert.match(JS, /film\.src = filmBase\(\) \+ "\.mp4";/);
  assert.equal((JS.match(/\.mp4"/g) || []).length, 1, 'the MP4 URL is set in exactly one place, inside startFilm');
});

test('parseRange handles the single-range forms browsers send', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
  assert.equal(parseRange(undefined, 1000), null);
  assert.deepEqual(parseRange('BYTES=0-9', 1000), { start: 0, end: 9 });
  assert.equal(parseRange('bytes=0-1,5-6', 1000), null);
  assert.equal(parseRange('bytes=x', 1000), 'invalid');
  assert.equal(parseRange('items=0-1', 1000), null);
  assert.equal(parseRange('bytes=1000-', 1000), 'invalid');
  assert.equal(parseRange('bytes=5-1', 1000), 'invalid');
  assert.equal(parseRange('bytes=-', 1000), 'invalid');
  assert.equal(parseRange('bytes=-0', 1000), 'invalid');
});

test('HTTP: visitors get the landing page, signed-in users the app; media streams with ranges', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-landing-'));
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir);
  const staged = path.join(dir, 'staged.mp4');
  const video = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
  fs.writeFileSync(path.join(mediaDir, 'intro-zh-9x16.mp4'), video);
  fs.writeFileSync(path.join(mediaDir, 'intro-en-16x9.jpg'), Buffer.from('host poster'));
  fs.writeFileSync(path.join(mediaDir, 'private.mp4'), 'must stay private');
  for (const name of ['intro-zh-16x9.mp4', 'intro-en-9x16.mp4']) fs.writeFileSync(path.join(mediaDir, name), video);
  fs.writeFileSync(staged, video);   // the fourth video is installed later, while the server runs
  const base = 'http://127.0.0.1:18095';
  const env = { ...process.env, DATA_DIR: path.join(dir, 'data'), MEDIA_DIR: mediaDir, MEDIA_CHECK_TTL_MS: '60', PORT: '18095', HOST: '127.0.0.1', AUTH_BASE_URL: base,
    AUTH_SECRET: 'disposable-test-secret-at-least-32-characters', COOKIE_SECURE: '0', TRUST_PROXY: '0', MAIL_MODE: 'file', OPENROUTER_API_KEY: '', GEMINI_API_KEY: '' };
  const issued = spawnSync(process.execPath, ['scripts/auth-admin.js', 'invite', 'landing@example.com'], { cwd: ROOT, env, encoding: 'utf8', timeout: 5000 });
  assert.equal(issued.status, 0, issued.stderr);
  const invitation = JSON.parse(issued.stdout);
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', d => { errors += d; });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = new Promise(r => child.once('exit', r)); child.kill(); await stopped; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('startup timeout ' + errors)), 8000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(errors)); });
  });
  const get = (route, headers = {}) => fetch(base + route, { redirect: 'manual', headers });
  const request = (route, body, cookie) => fetch(base + route, { method: 'POST', redirect: 'manual',
    headers: { origin: base, 'Content-Type': 'application/json', 'X-Bojin': '1', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

  // Visitors: the landing page at "/", everything else exactly as before.
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(home.headers.get('vary'), 'Cookie');
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  const homeHtml = await home.text();
  const HIDDEN = PAGE.replace(MARKER, '');
  assert.equal(homeHtml, HIDDEN, 'three of four videos: the section stays hidden');
  assert.equal(home.headers.get('content-length'), String(Buffer.byteLength(HIDDEN)));
  assert.equal(await (await get('/landing.html')).text(), HIDDEN);
  for (const route of ['/media/intro-zh-9x16.mp4', '/media/intro-zh-9x16.jpg', '/media/intro-en-16x9.jpg', '/x/..%2fmedia/intro-zh-9x16.jpg', '/%2fmedia/intro-zh-9x16.jpg', '/x/..%2fMEDIA/intro-zh-9x16.jpg'])
    assert.equal((await get(route)).status, 404, 'hidden: ' + route);
  const csp = home.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /font-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp.split(';').find(d => d.includes('script-src')), /unsafe-inline|'unsafe-eval'/);
  assert.equal((await get('/index.html')).headers.get('location'), '/login.html');
  // The gate follows the file that would be served, however the path is spelled.
  for (const spelling of ['/x/..%2findex.html', '/%2findex.html', '/.%2findex.html', '/%69ndex.html', '/x%2f..%2f%2findex.html']) {
    const r = await get(spelling);
    assert.equal(r.status, 302, spelling);
    assert.equal(r.headers.get('location'), '/login.html', spelling);
  }
  for (const route of ['/login.html', '/login.html?invite=abc123', '/privacy.html', '/terms.html', '/landing.html']) assert.equal((await get(route)).status, 200, route);
  for (const [route, type] of [['/landing/nocturne.js', 'text/javascript; charset=utf-8'], ['/landing/boot.js', 'text/javascript; charset=utf-8'],
    ['/landing/nocturne.css', 'text/css; charset=utf-8'], ['/site/theme.css', 'text/css; charset=utf-8'], ['/site/login.css', 'text/css; charset=utf-8'], ['/site/doc.css', 'text/css; charset=utf-8'],
    ['/landing/fonts/serif-display.woff2', 'font/woff2'], ['/landing/img/en-meal.webp', 'image/webp']]) {
    const r = await get(route);
    assert.equal(r.status, 200, route);
    assert.equal(r.headers.get('content-type'), type);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    // Page code is revalidated with the page; fonts and images keep their day-long cache.
    assert.equal(r.headers.get('cache-control'), /\.(js|css)$/.test(route) ? 'no-cache' : 'public, max-age=86400', route);
  }

  // Signed-in users go straight to the app, as before.
  const password = 'landing test strong password';
  const signup = await request('/api/auth/sign-up/email', { email: invitation.email, name: 'Landing', password, invitation: invitation.token, callbackURL: '/login.html',
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: '2026-11-25' });
  assert.equal(signup.status, 200, await signup.clone().text());
  const mail = fs.readdirSync(path.join(dir, 'data', 'mail')).map(f => JSON.parse(fs.readFileSync(path.join(dir, 'data', 'mail', f), 'utf8'))).find(m => m.kind === 'verify');
  assert.equal((await fetch(mail.url, { redirect: 'manual' })).status, 302);
  const login = await request('/api/auth/sign-in/email', { email: invitation.email, password });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const app = await get('/', { cookie });
  assert.equal(app.status, 200);
  assert.equal(app.headers.get('vary'), 'Cookie');
  const appHtml = await app.text();
  assert.equal(appHtml, read('public/index.html'));
  assert.notEqual(appHtml, HTML);
  assert.equal((await get('/index.html', { cookie })).status, 200);
  assert.equal((await get('/x/..%2findex.html', { cookie })).status, 200, 'signed-in users are not gated');

  // A revoked session is a visitor again: landing page at "/", no app shell.
  assert.equal((await request('/api/auth/sign-out', {}, cookie)).status, 200);
  const revoked = await get('/', { cookie });
  assert.equal(revoked.status, 200);
  assert.equal(await revoked.text(), HIDDEN);
  assert.equal((await get('/index.html', { cookie })).headers.get('location'), '/login.html');

  // Media: host MEDIA_DIR only (no bundled posters), cached availability, byte ranges, validators, caching.
  fs.renameSync(staged, path.join(mediaDir, 'intro-en-16x9.mp4'));
  await new Promise(r => setTimeout(r, 80));
  assert.equal(await (await get('/')).text(), HTML, 'the fourth video turns the section on without a restart');
  assert.equal(await (await get('/landing.html')).text(), HTML);
  assert.equal((await get('/x/..%2fmedia/intro-zh-9x16.jpg')).status, 404, 'posters only through the media route');
  const full = await get('/media/intro-zh-9x16.mp4');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('cache-control'), 'public, max-age=604800');
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(video));
  const part = await get('/media/intro-zh-9x16.mp4', { Range: 'bytes=100-199' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/4096');
  assert.equal(part.headers.get('content-length'), '100');
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(video.subarray(100, 200)));
  const tail = await get('/media/intro-zh-9x16.mp4', { Range: 'bytes=-96' });
  assert.equal(tail.headers.get('content-range'), 'bytes 4000-4095/4096');
  await tail.arrayBuffer();
  const bad = await get('/media/intro-zh-9x16.mp4', { Range: 'bytes=5000-' });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), 'bytes */4096');
  const etag = full.headers.get('etag');
  assert.equal((await get('/media/intro-zh-9x16.mp4', { 'If-None-Match': etag })).status, 304);
  const stale = await get('/media/intro-zh-9x16.mp4', { Range: 'bytes=0-9', 'If-Range': '"old"' });
  assert.equal(stale.status, 200, 'a stale If-Range gets the whole file');
  await stale.arrayBuffer();
  const head = await fetch(base + '/media/intro-zh-9x16.mp4', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '4096');
  assert.equal((await fetch(base + '/media/intro-zh-9x16.mp4', { method: 'POST' })).status, 405);
  const hostPoster = await get('/media/intro-en-16x9.jpg');
  assert.equal(hostPoster.status, 200);
  assert.equal(hostPoster.headers.get('content-type'), 'image/jpeg');
  assert.equal(await hostPoster.text(), 'host poster', 'posters are served from MEDIA_DIR');
  const missingPoster = await get('/media/intro-zh-16x9.jpg');
  assert.equal(missingPoster.status, 404, 'missing host poster returns 404 with no bundled fallback');
  assert.equal(missingPoster.headers.get('cache-control'), 'no-cache');
  for (const route of ['/media/private.mp4', '/media/intro-zh-9x16.webp', '/media/..%2Fserver.js', '/media/%2e%2e/server.js', '/media/Intro.mp4', '/media/a/b.mp4', '/media/x.html'])
    assert.equal((await get(route)).status, 404, route);
  fs.unlinkSync(path.join(mediaDir, 'intro-en-9x16.mp4'));
  assert.equal((await get('/media/intro-en-9x16.mp4')).status, 404, 'missing video fails and invalidates availability cache');
  assert.equal(await (await get('/')).text(), HIDDEN, 'withdrawing one video hides it immediately after miss');
  assert.equal((await get('/media/intro-zh-9x16.mp4')).status, 404);
});
