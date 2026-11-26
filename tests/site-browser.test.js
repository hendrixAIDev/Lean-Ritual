'use strict';
// Real-browser checks for the Nocturne login and document pages: every login state, zh and en,
// phone widths and desktop. Needs Playwright (skipped otherwise, like landing-browser.test.js);
// BROWSER=webkit runs WebKit. Set SITE_SCREENSHOTS=<dir> to also save a picture of every state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');

let playwright = null;
try { playwright = require('playwright'); } catch { playwright = null; }

const ROOT = path.resolve(__dirname, '..');
const AXE = fs.readFileSync(path.join(ROOT, 'tests/fixtures/axe-core/axe.min.js'), 'utf8');
const BASE = 'http://127.0.0.1:18099';
const BG = 'rgb(5, 10, 8)', EMERALD_HI = 'rgb(141, 229, 203)', DANGER = 'rgb(255, 158, 140)';
const PHONES = [320, 375, 390, 430];
const CONSENT_OUTDATED = 'Terms or privacy notice updated; refresh the page to review and accept the latest version';

async function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-site-browser-'));
  const env = { ...process.env, DATA_DIR: path.join(dir, 'data'), MEDIA_DIR: '', PORT: new URL(BASE).port, HOST: '127.0.0.1', AUTH_BASE_URL: BASE,
    AUTH_SECRET: 'browser-site-secret-at-least-32-characters', COOKIE_SECURE: '0', TRUST_PROXY: '0', MAIL_MODE: 'file', OPENROUTER_API_KEY: '', GEMINI_API_KEY: '' };
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
}

/** Answers for the auth API, so error and success states show without real accounts. */
const reply = (status, body) => route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const fillLogin = async page => { await page.fill('#e', 'reader@example.com'); await page.fill('#p', 'correct horse battery'); };
const fillRegister = async (page, tick) => {
  await page.fill('#n', 'Reader'); await fillLogin(page);
  if (tick) { await page.check('#c-terms'); await page.check('#c-sensitive'); }
};
const submit = async page => { await page.click('#go'); await page.waitForFunction(() => document.querySelector('#err').textContent.trim() || !document.querySelector('#reload-policy').hidden); };

// Every state of login.html: [name, path, prepare]. `expectedErrors` marks states whose mocked API reply is an HTTP error.
const LOGIN = [
  ['login-email', '/login.html'],
  ['login-phone', '/login.html?method=phone'],
  ['login-focus', '/login.html', async page => { await page.locator('#e').focus(); }],
  ['login-invalid-field', '/login.html', async page => { await page.fill('#e', 'not-an-email'); await page.locator('#e').press('Tab'); }],
  ['login-error', '/login.html', async page => {
    await page.route('**/api/auth/sign-in/email', reply(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }));
    await fillLogin(page); await submit(page);
  }, true],
  ['login-submitting', '/login.html', async page => {
    await page.route('**/api/auth/sign-in/email', () => {});   // never answers: the button stays disabled
    await fillLogin(page); await page.click('#go'); await page.locator('#go:disabled').waitFor();
  }],
  ['register-email', '/login.html?invite=demo-invite'],
  ['register-phone', '/login.html?invite=demo-invite&method=phone'],
  ['register-consent-required', '/login.html?invite=demo-invite', async page => { await fillRegister(page, false); await submit(page); }],
  ['register-consent-ticked', '/login.html?invite=demo-invite', async page => { await fillRegister(page, true); }],
  ['register-sent', '/login.html?invite=demo-invite', async page => {
    await page.route('**/api/auth/sign-up/email', reply(200, {}));
    await fillRegister(page, true); await submit(page);
  }],
  ['register-consent-outdated', '/login.html?invite=demo-invite', async page => {
    await page.route('**/api/auth/sign-up/email', reply(400, { message: CONSENT_OUTDATED }));
    await fillRegister(page, true); await submit(page);
  }, true],
  ['forgot-email', '/login.html', async page => { await page.click('#forgot'); }],
  ['forgot-phone', '/login.html?method=phone', async page => { await page.click('#forgot'); }],
  ['resend-verification', '/login.html', async page => { await page.click('#resend'); }],
  ['email-verified', '/login.html?verified=1'],
  ['account-deleted', '/login.html?deleted=1'],
  ['reset-password', '/login.html?token=demo-token'],
  ['reset-link-expired', '/login.html?token=demo-token&error=TOKEN_EXPIRED']
];
const DOCS = [['privacy', '/privacy.html'], ['terms', '/terms.html'], ['guide', '/guide.html']];
const ALL = [...LOGIN, ...DOCS];
const withLang = (url, lang) => url + (url.includes('?') ? '&' : '?') + 'lang=' + lang;

/** A page that records console errors, CSP violations and third-party requests. */
async function watchedPage(browser, options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const log = { errors: [], csp: [], external: [] };
  await page.exposeFunction('__recordCSP', v => log.csp.push(v));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => window.__recordCSP(e.violatedDirective + ' ' + e.blockedURI)));
  page.on('console', m => { if (m.type() === 'error') log.errors.push(m.text()); });
  page.on('pageerror', e => log.errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith(BASE)) log.external.push(r.url()); });
  return { context, page, log };
}

async function open(browser, [name, url, prepare, httpError], lang, width, extra = {}) {
  const watched = await watchedPage(browser, { viewport: { width, height: width >= 1000 ? 900 : 844 }, locale: lang === 'en' ? 'en-US' : 'zh-CN', ...extra });
  await watched.page.goto(BASE + withLang(url, lang));
  await watched.page.evaluate(() => document.fonts.ready);
  if (prepare) await prepare(watched.page);
  // A mocked 4xx is logged by the browser as a failed resource; nothing else may be.
  if (httpError) watched.log.errors = watched.log.errors.filter(e => !/status of 40\d/.test(e));
  return { ...watched, label: `${name} ${lang} ${width}px` };
}

async function axeViolations(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ['violations'] });
    return result.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  });
}

/**
 * Text contrast against the pixels really behind it: text is made transparent, the page is
 * photographed, and each text box is compared with its least contrasting background pixel.
 * Reading text on the document pages (paragraphs and list items) must reach AAA (7:1).
 */
async function contrastFailures(page) {
  const boxes = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      const el = node.parentElement;
      if (!node.textContent.trim() || el.closest('script, [hidden]')) continue;
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize), large = size >= 24 || (size >= 18.66 && +style.fontWeight >= 700);
      const reading = !!el.closest('article p, article li') && !el.closest('.notice, .summary');
      const range = document.createRange(); range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 2 && r.height > 2)
        out.push({ text: node.textContent.trim().slice(0, 24), x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, min: reading ? 7 : large ? 3 : 4.5, colour: style.color });
    }
    return out;
  });
  await page.addStyleTag({ content: '*,*::placeholder{color:transparent!important;-webkit-text-fill-color:transparent!important;text-decoration-color:transparent!important;caret-color:transparent!important}' });
  const { data, info } = await sharp(await page.screenshot({ fullPage: true })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lum = (r, g, b) => [r, g, b].map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const bad = [];
  let checked = 0;
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x)), x1 = Math.min(info.width, Math.ceil(b.x + b.w)), y0 = Math.max(0, Math.floor(b.y)), y1 = Math.min(info.height, Math.ceil(b.y + b.h));
    if (x0 >= x1 || y0 >= y1) continue;
    const fg = lum(...b.colour.match(/[\d.]+/g).slice(0, 3).map(Number));
    let worst = Infinity;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * info.width + x) * 3, bg = lum(data[i], data[i + 1], data[i + 2]);
      worst = Math.min(worst, (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05));
    }
    checked++;
    if (worst < b.min) bad.push(`${b.text}: ${worst.toFixed(2)} < ${b.min}`);
  }
  return { bad, checked };
}

test('login and document pages in a real browser', { skip: playwright ? false : 'Playwright is not installed', timeout: 1800000 }, async t => {
  await startServer(t);
  const webkit = process.env.BROWSER === 'webkit';
  const browser = webkit ? await playwright.webkit.launch() : await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const shots = process.env.SITE_SCREENSHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });

  await t.test('every page and login state: axe-clean, no sideways scroll, no errors, CSP violations or third-party requests (zh/en, 320-430 and 1440 px)', async () => {
    for (const lang of ['zh', 'en']) for (const width of [...PHONES, 1440]) for (const state of ALL) {
      const { context, page, log, label } = await open(browser, state, lang, width);
      assert.equal(await page.evaluate(() => document.documentElement.lang), lang === 'en' ? 'en' : 'zh-CN', label);
      assert.deepEqual(await axeViolations(page), [], label);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label + ': sideways scroll');
      assert.deepEqual([log.errors, log.csp, log.external], [[], [], []], label);
      await context.close();
    }
  });

  await t.test('text contrast on the real pixels: AA everywhere, AAA for the legal and guide body text', async () => {
    for (const lang of ['zh', 'en']) for (const width of [390, 1440]) for (const state of ALL) {
      const { context, page, label } = await open(browser, state, lang, width, { reducedMotion: 'reduce' });
      const { bad, checked } = await contrastFailures(page);
      assert.ok(checked > 5, label + ': text found');
      assert.deepEqual(bad, [], label);
      await context.close();
    }
  });

  await t.test('the pages are Nocturne: dark background and browser colour, serif headings in the shipped font', async () => {
    for (const state of [LOGIN[0], ...DOCS]) for (const lang of ['zh', 'en']) {
      const { context, page, label } = await open(browser, state, lang, 390);
      const look = await page.evaluate(() => ({
        html: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor,
        scheme: getComputedStyle(document.documentElement).colorScheme,
        theme: [...document.querySelectorAll('meta[name="theme-color"]')].map(m => m.content),
        h1: getComputedStyle(document.querySelector('h1')).fontFamily,
        serif: document.fonts.check('700 24px "LR Serif"', document.querySelector('h1').textContent)
      }));
      assert.deepEqual([look.html, look.body, look.scheme], [BG, BG, 'dark'], label);
      assert.deepEqual([...new Set(look.theme)], ['#050A08'], label);
      assert.match(look.h1, /^"LR Serif"/, label);
      assert.ok(look.serif, label + ': every heading character is in the serif subset');
      await context.close();
    }
  });

  await t.test('forms on dark: focus ring, invalid field, server error, disabled button and ticked consent are visible', async () => {
    const style = (page, sel, props) => page.locator(sel).evaluate((el, p) => Object.fromEntries(p.map(k => [k, getComputedStyle(el)[k]])), props);
    const still = { reducedMotion: 'reduce' };   // read colours after, not during, their transitions
    let s = await open(browser, LOGIN[2], 'zh', 390, still);
    assert.deepEqual(await style(s.page, '#e', ['outlineStyle', 'outlineColor', 'outlineWidth', 'borderTopColor']), { outlineStyle: 'solid', outlineColor: EMERALD_HI, outlineWidth: '2px', borderTopColor: EMERALD_HI });
    await s.page.keyboard.press('Tab');
    assert.equal(await s.page.evaluate(() => document.activeElement.id), 'p');
    assert.equal((await style(s.page, '#p', ['outlineStyle'])).outlineStyle, 'solid');
    await s.context.close();
    s = await open(browser, LOGIN[3], 'zh', 390, still);
    assert.equal((await style(s.page, '#e', ['borderTopColor'])).borderTopColor, DANGER, 'invalid email field');
    await s.context.close();
    s = await open(browser, LOGIN[4], 'en', 390, still);
    assert.equal(await s.page.textContent('#err'), 'Incorrect email or password.');
    assert.equal((await style(s.page, '#err', ['color'])).color, DANGER);
    await s.context.close();
    s = await open(browser, LOGIN[5], 'zh', 390, still);
    assert.deepEqual(await style(s.page, '#go', ['backgroundImage', 'color', 'opacity']), { backgroundImage: 'none', color: 'rgb(180, 192, 186)', opacity: '1' }, 'submitting: the main button is visibly disabled and still readable');
    await s.context.close();
    s = await open(browser, LOGIN[9], 'zh', 390, still);
    assert.equal((await style(s.page, '#c-terms', ['backgroundColor'])).backgroundColor, EMERALD_HI, 'ticked consent box');
    assert.equal(await s.page.isChecked('#c-sensitive'), true);
    await s.context.close();
    s = await open(browser, LOGIN[10], 'en', 390, still);
    assert.equal(await s.page.textContent('#err'), 'Check your email and verify your address before signing in.');
    assert.equal((await style(s.page, '#err', ['color'])).color, EMERALD_HI, 'a done message is not shown as an error');
    await s.context.close();
    s = await open(browser, LOGIN[11], 'zh', 390, still);
    assert.equal(await s.page.isVisible('#reload-policy'), true, 'consent version changed: the reload button shows');
    assert.equal((await style(s.page, '#err', ['color'])).color, DANGER);
    await s.context.close();
  });

  await t.test('printing gives dark text on white paper', async () => {
    for (const state of [LOGIN[0], ...DOCS]) {
      const { context, page, label } = await open(browser, state, 'zh', 1440, { reducedMotion: 'reduce' });
      await page.emulateMedia({ media: 'print' });
      const printed = await page.evaluate(() => {
        const text = document.querySelector('article p, #subtitle'), link = document.querySelector('article a, .hint a');
        return { paper: getComputedStyle(document.body).backgroundColor, page: getComputedStyle(document.documentElement).backgroundColor,
          text: getComputedStyle(text).color, link: link ? getComputedStyle(link).color : 'no link', h1: getComputedStyle(document.querySelector('h1')).color };
      });
      assert.deepEqual(printed, { paper: 'rgb(255, 255, 255)', page: 'rgb(255, 255, 255)', text: 'rgb(0, 0, 0)', link: state[0] === 'guide' ? 'no link' : 'rgb(0, 0, 0)', h1: 'rgb(0, 0, 0)' }, label);   // the guide's body has no links
      await context.close();
    }
  });

  await t.test('from the landing page to sign-in: every frame stays dark, with no cream or white flash', { skip: webkit ? 'frame capture needs Chromium' : false }, async () => {
    for (const colorScheme of ['light', 'dark']) for (const link of ['header a[href="/login.html"]', '.hero a[href="/login.html?invite="]']) {
      const { context, page } = await watchedPage(browser, { viewport: { width: 390, height: 844 }, colorScheme, locale: 'zh-CN' });
      await page.goto(BASE + '/');
      await page.route('**/login.html*', async r => { await new Promise(done => setTimeout(done, 300)); await r.continue(); });
      await page.route('**/site/*.css', async r => { await new Promise(done => setTimeout(done, 300)); await r.continue(); });   // slow styles: the page must still open dark
      const cdp = await context.newCDPSession(page), frames = [];
      cdp.on('Page.screencastFrame', e => { frames.push(Buffer.from(e.data, 'base64')); cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {}); });
      await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      await page.locator(link).click();
      await page.waitForURL('**/login.html*');
      await page.locator('#go').waitFor();
      await page.waitForTimeout(400);
      await cdp.send('Page.stopScreencast');
      assert.ok(frames.length >= 3, 'frames: ' + frames.length);
      for (const [n, frame] of frames.entries()) {
        // The top strip is page background on both pages (the landing header, the login aurora), never cream or white.
        const { data, info } = await sharp(frame).extract({ left: 0, top: 0, width: 40, height: 12 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        for (let i = 0; i < info.width * info.height * 3; i += 3) assert.ok(data[i] + data[i + 1] + data[i + 2] < 120, `${colorScheme} ${link}: frame ${n} has a light pixel ${[...data.subarray(i, i + 3)]}`);
      }
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map(m => m.content)), ['#050A08', '#050A08']);
      await context.close();
    }
  });

  if (shots) await t.test('screenshots', async () => {
    for (const lang of ['zh', 'en']) for (const width of [390, 1440]) for (const state of ALL) {
      const { context, page } = await open(browser, state, lang, width, { deviceScaleFactor: width === 390 ? 2 : 1, reducedMotion: 'reduce' });
      await page.screenshot({ path: path.join(shots, `${state[0]}-${lang}-${width}.png`), fullPage: true });
      await context.close();
    }
  });
});
