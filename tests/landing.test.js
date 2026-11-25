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
const HTML = read('public/landing.html');
const JS = read('public/landing/landing.js');
const BOOT = read('public/landing/boot.js');
const CSS = read('public/landing/landing.css');

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
  for (const lang of ['zh', 'en']) for (const shape of ['9x16', '16x9'])
    assert.ok(fs.existsSync(path.join(ROOT, 'public/media', `intro-${lang}-${shape}.jpg`)), 'bundled poster ' + lang + shape);
});

test('calls to action: invite sign-up, sign-in and an invite request to the privacy-page contact', () => {
  assert.match(HTML, /<a class="btn primary" href="\/login\.html\?invite="><span data-i="cta\.invite">用邀请码注册<\/span>/);
  assert.match(HTML, /<a class="btn ghost" href="\/login\.html" data-i="cta\.signin">登录<\/a>/);
  const privacyContact = read('public/privacy.html').match(/mailto:([^"?]+)/)[1];
  assert.match(JS, new RegExp('const CONTACT = "' + privacyContact.replace(/\./g, '\\.') + '"'));
  for (const m of HTML.matchAll(/data-ask href="mailto:([^"]+)"/g)) assert.equal(m[1], privacyContact);
  // login.html opens its invite sign-up view whenever the invite parameter is present.
  assert.match(read('public/login.html'), /params\.has\("invite"\) \? "register"/);
});

test('zh and en copy have the same keys and cover every data-i hook', () => {
  const { zh, en } = loadI18N();
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const [, key] of HTML.matchAll(/data-i(?:-aria)?="([^"]+)"/g)) {
    assert.ok(key in zh, 'zh has ' + key);
    assert.ok(key in en, 'en has ' + key);
  }
  for (const [key, value] of Object.entries(en)) if (key !== 'brand2') assert.doesNotMatch(value, /[\u4e00-\u9fff]/, 'en.' + key + ' has no Chinese');
});

test('AI wording stays honest: only meal photos and the coach use AI, never the plan', () => {
  const { zh, en } = loadI18N();
  const all = [...Object.values(zh), ...Object.values(en), HTML].join('\n');
  for (const banned of [/AI\s*为你定制/, /AI\s*定制/, /AI\s*生成.*计划/, /AI[- ]?(builds|creates|generates|designs)/i, /AI[- ]customi[sz]ed/i, /AI[- ]made plan/i])
    assert.doesNotMatch(all, banned);
  assert.equal(zh['ai.t'], 'AI 只用在两个地方');
  assert.equal(en['ai.t'], 'AI does exactly two jobs');
  assert.match(zh['ai.note'], /不构成医疗建议/);
  assert.match(en['ai.note'], /not medical advice/);
  assert.equal(zh['setup.t2'], '为你定制，AI 持续调整');
  assert.equal(en['setup.t2'], 'Made for you, tuned by AI');
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
  const chars = new Set([...read('public/landing/fonts/display-cjk.chars.txt')]);
  const missing = [...new Set([...HTML + JS].filter(c => /[　-〿㐀-鿿＀-￯]/.test(c) && !chars.has(c)))];
  assert.deepEqual(missing, [], 'rebuild public/landing/fonts/display-cjk.woff2 for the new copy');
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
  assert.equal(parseRange('bytes=0-1,5-6', 1000), null);
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
  const video = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
  fs.writeFileSync(path.join(mediaDir, 'intro-zh-9x16.mp4'), video);
  fs.writeFileSync(path.join(mediaDir, 'intro-en-16x9.jpg'), Buffer.from('host poster'));
  const base = 'http://127.0.0.1:18095';
  const env = { ...process.env, DATA_DIR: path.join(dir, 'data'), MEDIA_DIR: mediaDir, PORT: '18095', HOST: '127.0.0.1', AUTH_BASE_URL: base,
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
  assert.equal(homeHtml, HTML);
  const csp = home.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /font-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp.split(';').find(d => d.includes('script-src')), /unsafe-inline|'unsafe-eval'/);
  assert.equal((await get('/index.html')).headers.get('location'), '/login.html');
  for (const route of ['/login.html', '/login.html?invite=abc123', '/privacy.html', '/terms.html', '/landing.html']) assert.equal((await get(route)).status, 200, route);
  for (const [route, type] of [['/landing/landing.js', 'text/javascript; charset=utf-8'], ['/landing/boot.js', 'text/javascript; charset=utf-8'],
    ['/landing/landing.css', 'text/css; charset=utf-8'], ['/landing/fonts/display-cjk.woff2', 'font/woff2'], ['/landing/img/en-meal.webp', 'image/webp']]) {
    const r = await get(route);
    assert.equal(r.status, 200, route);
    assert.equal(r.headers.get('content-type'), type);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
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

  // Media: host MEDIA_DIR first, bundled posters as the fallback, byte ranges, validators, caching.
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
  assert.equal(await hostPoster.text(), 'host poster', 'MEDIA_DIR overrides the bundled poster');
  const bundled = await get('/media/intro-zh-16x9.jpg');
  assert.equal(bundled.status, 200);
  assert.equal(bundled.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await bundled.arrayBuffer()).equals(fs.readFileSync(path.join(ROOT, 'public/media/intro-zh-16x9.jpg'))));
  for (const route of ['/media/intro-en-9x16.mp4', '/media/..%2Fserver.js', '/media/%2e%2e/server.js', '/media/Intro.mp4', '/media/a/b.mp4', '/media/x.html'])
    assert.equal((await get(route)).status, 404, route);
});
