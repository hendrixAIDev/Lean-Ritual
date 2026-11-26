'use strict';
// Real-browser checks for the landing page. Needs Playwright with Chromium; skipped
// when Playwright isn't installed (CI installs it in a separate step, outside the
// release's node_modules). Set LANDING_SCREENSHOTS=<dir> to also save screenshots.
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
const BASE = 'http://127.0.0.1:18097';        // no MEDIA_DIR: video hidden, as shipped
const SHOWN = 'http://127.0.0.1:18098';       // all four videos installed

async function startServer(t, base, withVideos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-landing-browser-'));
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir);
  // Not a playable video on purpose: proves the request happens only after play and that errors are handled.
  let poster = null;
  if (withVideos) {
    poster = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 5, g: 10, b: 8 } } }).jpeg().toBuffer();
    for (const baseName of ['intro-zh-9x16', 'intro-zh-16x9', 'intro-en-9x16', 'intro-en-16x9']) {
      fs.writeFileSync(path.join(mediaDir, baseName + '.mp4'), Buffer.alloc(2048));
      fs.writeFileSync(path.join(mediaDir, baseName + '.jpg'), poster);
    }
  }
  const env = { ...process.env, DATA_DIR: path.join(dir, 'data'), MEDIA_DIR: withVideos ? mediaDir : '', PORT: new URL(base).port, HOST: '127.0.0.1', AUTH_BASE_URL: base,
    AUTH_SECRET: 'browser-landing-secret-at-least-32-characters', COOKIE_SECURE: '0', TRUST_PROXY: '0', MAIL_MODE: 'file', OPENROUTER_API_KEY: '', GEMINI_API_KEY: '' };
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
  return { poster };
}

/** A page that records console errors, CSP violations, third-party and media requests. */
async function watchedPage(browser, options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const log = { errors: [], csp: [], external: [], media: [], anyMedia: [] };
  await page.exposeFunction('__recordCSP', v => log.csp.push(v));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => window.__recordCSP(e.violatedDirective + ' ' + e.blockedURI)));
  page.on('console', m => { if (m.type() === 'error') log.errors.push(m.text()); });
  page.on('pageerror', e => log.errors.push(e.message));
  page.on('request', r => {
    const url = r.url();
    if (/^https?:/.test(url) && !url.startsWith(BASE) && !url.startsWith(SHOWN)) log.external.push(url);
    if (/\/media\/.+\.mp4/.test(url)) log.media.push(url);
    if (/\/media\//.test(url)) log.anyMedia.push(url);
  });
  return { context, page, log };
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 500) { await page.evaluate(v => window.scrollTo({ top: v, behavior: 'instant' }), y); await page.waitForTimeout(40); }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(250);
}

/** Resolves once (smooth) scrolling has settled. */
async function stillScroll(page) {
  await page.evaluate(() => new Promise(done => { let last = -1, same = 0; const t = setInterval(() => { same = scrollY === last ? same + 1 : 0; last = scrollY; if (same > 4) { clearInterval(t); done(); } }, 60); }));
}

async function axeViolations(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ['violations'] });
    return result.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  });
}

/**
 * Worst text contrast against the pixels really behind it. Text is made transparent, the
 * page is photographed, and each text box is compared with its brightest background pixel
 * (every colour here is light on dark, or dark on the emerald buttons: then the darkest).
 */
async function contrastFailures(page, fullPage) {
  const boxes = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      const el = node.parentElement;
      if (!node.textContent.trim() || el.closest('.sr, script, [hidden]')) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize), large = size >= 24 || (size >= 18.66 && +style.fontWeight >= 700);
      const gradient = style.webkitTextFillColor === 'rgba(0, 0, 0, 0)';
      for (const r of range.getClientRects()) if (r.width > 2 && r.height > 2)
        out.push({ text: node.textContent.trim().slice(0, 24), x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, large, colour: gradient ? style.color : style.webkitTextFillColor });
    }
    return out;
  });
  await page.addStyleTag({ content: '*{color:transparent!important;-webkit-text-fill-color:transparent!important;text-decoration-color:transparent!important}.l2{background:none!important}.hero .card,.hero .device{z-index:0}' });
  const { data, info } = await sharp(await page.screenshot({ fullPage })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lum = (r, g, b) => [r, g, b].map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const bad = [];
  let checked = 0;
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x)), x1 = Math.min(info.width, Math.ceil(b.x + b.w)), y0 = Math.max(0, Math.floor(b.y)), y1 = Math.min(info.height, Math.ceil(b.y + b.h));
    if (x0 >= x1 || y0 >= y1) continue;
    const fg = lum(...b.colour.match(/[\d.]+/g).map(Number));
    let worst = Infinity;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * info.width + x) * 3, bg = lum(data[i], data[i + 1], data[i + 2]);
      worst = Math.min(worst, (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05));
    }
    checked++;
    if (worst < (b.large ? 3 : 4.5)) bad.push(`${b.text}: ${worst.toFixed(2)}`);
  }
  return { bad, checked };
}

test('landing page in a real browser', { skip: playwright ? false : 'Playwright is not installed', timeout: 900000 }, async t => {
  await startServer(t, BASE, false);
  const shown = await startServer(t, SHOWN, true);
  const webkit = process.env.BROWSER === 'webkit';
  const browser = webkit ? await playwright.webkit.launch() : await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const shots = process.env.LANDING_SCREENSHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });

  await t.test('video hidden (default): finished page, no player, no gap, no media request, in both languages and sizes', async () => {
    for (const lang of ['zh', 'en']) for (const width of [390, 1440]) {
      const { context, page, log } = await watchedPage(browser, { viewport: { width, height: 900 } });
      await page.goto(BASE + '/?lang=' + lang);
      await settle(page);
      for (const selector of ['#film', '#play', '#film-note', '#film-h', 'video', '.film-grid', '[data-i^="video."]', 'a[href*="/media/"]'])
        assert.equal(await page.locator(selector).count(), 0, selector);
      assert.doesNotMatch(await page.locator('body').innerText(), /视频|播放|video|can't play/i);
      // The hero runs straight into the scroll story, and section numbers stay consecutive.
      assert.equal(await page.evaluate(() => Math.round(document.querySelector('#story').getBoundingClientRect().top - document.querySelector('.hero').getBoundingClientRect().bottom)), 0);
      assert.equal(await page.locator('.sec-head .no').count(), 2);
      // The toggle still works without the player.
      await page.getByRole('button', { name: lang === 'zh' ? 'EN' : '中' }).click();
      assert.equal(await page.locator('html').getAttribute('lang'), lang === 'zh' ? 'en' : 'zh-CN');
      assert.deepEqual([log.anyMedia, log.errors, log.csp, log.external], [[], [], [], []]);
      await context.close();
    }
  });

  await t.test('video shown: no console errors, CSP violations or third-party requests; no media until play', async () => {
    const { context, page, log } = await watchedPage(browser, { viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    const posterResponses = [];
    page.on('response', r => { if (r.url().endsWith('/media/intro-zh-9x16.jpg')) posterResponses.push(r.status()); });
    await page.goto(SHOWN + '/');
    await settle(page);
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    assert.equal(await page.locator('h1 .sr').textContent(), '一个 App，助你更瘦、更强、更好');
    assert.deepEqual(log.media, [], 'no MP4 request before play');
    assert.equal(await page.locator('#film').getAttribute('src'), null);
    assert.equal(await page.locator('#film').getAttribute('poster'), '/media/intro-zh-9x16.jpg');
    assert.ok(posterResponses.length >= 1 && posterResponses.every(s => s === 200), 'poster served from MEDIA_DIR: ' + posterResponses);
    const posterRes = await fetch(SHOWN + '/media/intro-zh-9x16.jpg');
    assert.equal(posterRes.status, 200);
    assert.ok(Buffer.from(await posterRes.arrayBuffer()).equals(shown.poster), 'poster bytes come from MEDIA_DIR');
    await page.locator('#play').click();
    await page.waitForFunction(() => document.getElementById('film-note').textContent.length > 0);
    // Engines differ in how often they probe a file they cannot decode; only this one file may be asked for.
    assert.deepEqual([...new Set(log.media.map(u => new URL(u).pathname))], ['/media/intro-zh-9x16.mp4']);
    assert.equal(await page.locator('#film-note').textContent(), '视频暂时无法播放，请稍后再试。');
    assert.equal(await page.locator('#play').isVisible(), true, 'play button returns after a failed load');
    assert.equal(await page.getByRole('link', { name: '用邀请码注册' }).first().getAttribute('href'), '/login.html?invite=');
    assert.equal(await page.getByRole('link', { name: '登录', exact: true }).first().getAttribute('href'), '/login.html');
    assert.match(await page.locator('a[data-ask]').first().getAttribute('href'), /^mailto:hendrix\.ai\.dev@gmail\.com\?subject=/);
    assert.deepEqual(log.errors.filter(e => !/Failed to load resource|MEDIA_ERR|NotSupportedError|no supported source/i.test(e)), []);
    assert.deepEqual(log.csp, []);
    assert.deepEqual(log.external, []);
    await context.close();
  });

  await t.test('language: browser language first, toggle without reload, choice carried to login', async () => {
    const { context, page, log } = await watchedPage(browser, { viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    await page.goto(SHOWN + '/');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.locator('h1 .sr').textContent(), 'One app to get leaner, stronger, better');
    assert.equal(await page.locator('#film').getAttribute('poster'), '/media/intro-en-16x9.jpg');
    const marker = await page.evaluate(() => { window.__noReload = 1; return 1; });
    await page.getByRole('button', { name: '中' }).click();
    assert.equal(await page.evaluate(() => window.__noReload), marker, 'no reload');
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    assert.equal(await page.locator('h1 .sr').textContent(), '一个 App，助你更瘦、更强、更好');
    assert.equal(await page.locator('#film').getAttribute('poster'), '/media/intro-zh-16x9.jpg');
    assert.equal(await page.evaluate(() => localStorage.getItem('bj-lang')), 'zh');
    await page.goto(SHOWN + '/login.html');
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN', 'login.html honours the choice');
    await page.goto(SHOWN + '/');
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN', 'the saved choice beats the browser language');
    assert.deepEqual(log.errors, []);
    await context.close();
  });

  await t.test('no horizontal scroll from 320 to 430 px', async () => {
    for (const base of [BASE, SHOWN]) for (const lang of ['zh', 'en']) for (const width of [320, 360, 375, 390, 414, 430]) {
      const { context, page } = await watchedPage(browser, { viewport: { width, height: 800 } });
      await page.goto(base + '/?lang=' + lang);
      await settle(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(overflow, 0, `${lang} @ ${width}px overflows by ${overflow}px`);
      await context.close();
    }
  });

  await t.test('axe finds no violations (zh/en, light/dark, phone/desktop)', async () => {
    for (const base of [BASE, SHOWN]) for (const lang of ['zh', 'en']) for (const colorScheme of ['light', 'dark']) for (const width of [390, 1440]) {
      const { context, page } = await watchedPage(browser, { viewport: { width, height: 900 }, colorScheme, reducedMotion: 'reduce' });
      await page.goto(base + '/?lang=' + lang);
      await settle(page);
      assert.deepEqual(await axeViolations(page), [], `${lang} ${colorScheme} ${width}px`);
      await context.close();
    }
  });

  await t.test('the Chinese headline keeps 更瘦、更强、更好 on one line from 320 to 1920 px', async () => {
    for (const width of [320, 360, 390, 430, 768, 999, 1000, 1024, 1280, 1440, 1920]) {
      const { context, page } = await watchedPage(browser, { viewport: { width, height: 900 } });
      await page.goto(BASE + '/?lang=zh');
      await page.evaluate(() => document.fonts.ready);
      const r = await page.evaluate(() => {
        const l2 = document.querySelector('.l2'), box = l2.getBoundingClientRect(), range = document.createRange();
        range.selectNodeContents(l2);
        return { lines: new Set([...range.getClientRects()].map(c => Math.round(c.top))).size, right: range.getBoundingClientRect().right, limit: document.querySelector('.hero .copy').getBoundingClientRect().right, text: l2.textContent, h: box.height };
      });
      assert.equal(r.text, '更瘦、更强、更好');
      assert.equal(r.lines, 1, width + 'px');
      assert.ok(r.right <= r.limit + 1, `${width}px: headline ${r.right} stays in its column ${r.limit}`);
      await context.close();
    }
  });

  await t.test('contrast holds on the dark background, wherever the aurora has drifted', async () => {
    for (const lang of ['zh', 'en']) for (const width of [390, 1440]) {
      const still = await watchedPage(browser, { viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      await still.page.goto(SHOWN + '/?lang=' + lang);
      await settle(still.page);
      const whole = await contrastFailures(still.page, true);
      assert.ok(whole.checked > 60, 'text boxes checked: ' + whole.checked);
      assert.deepEqual(whole.bad, [], `${lang} ${width}px full page`);
      await still.context.close();
      for (const at of [0, 11000, 22000]) {
        const { context, page } = await watchedPage(browser, { viewport: { width, height: 900 } });
        await page.goto(BASE + '/?lang=' + lang);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(ms => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; } }, at);
        const fold = await contrastFailures(page, false);
        assert.ok(fold.checked >= 8);
        assert.deepEqual(fold.bad, [], `${lang} ${width}px, aurora at ${at} ms`);
        await context.close();
      }
    }
  });

  await t.test('content is complete without JavaScript, or if nocturne.js fails to load', async () => {
    for (const width of [390, 1440]) for (const mode of ['off', 'blocked']) {
      const { context, page } = await watchedPage(browser, { viewport: { width, height: 900 }, javaScriptEnabled: mode !== 'off', locale: 'zh-CN' });
      if (mode === 'blocked') await page.route('**/nocturne.js', r => r.abort());
      await page.goto(BASE + '/');
      await page.waitForTimeout(1300);
      for (const sel of ['h1', '.lede', '#board-h', '.step h3', '.step p', '#setup-h', '#ai-h', '.ai h3', '#end-h', 'footer a']) for (const el of await page.locator(sel).all()) {
        assert.equal(await el.isVisible(), true, `${mode} ${width}: ${sel}`);
        assert.ok((await el.innerText()).trim(), `${mode} ${width}: ${sel} has text`);
      }
      if (mode === 'blocked') assert.equal(await page.evaluate(() => [...document.querySelectorAll('.reveal')].filter(e => getComputedStyle(e).opacity !== '1').length), 0);
      assert.equal(await page.locator('.inline-shot:visible').count(), 5, 'every step still shows its screen');
      await page.locator('.hero a[href="/login.html?invite="]').click();
      await page.waitForURL('**/login.html?invite=');
      await context.close();
    }
  });

  await t.test('the scroll story follows the reader, works from the keyboard and reads as a plain list', async () => {
    const { context, page, log } = await watchedPage(browser, { viewport: { width: 1440, height: 900 } });
    await page.goto(BASE + '/?lang=en');
    await settle(page);
    for (const [i, shot] of ['checkin', 'workout', 'meal', 'coach', 'charts'].entries()) {
      await page.evaluate(n => document.querySelector(`.step[data-step="${n}"]`).scrollIntoView({ block: 'center', behavior: 'instant' }), i);
      await page.waitForFunction(n => document.querySelector('.step.active')?.dataset.step === String(n), i);
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#pin img.on')].map(e => [e.dataset.shot, e.getAttribute('src')])), [[shot, `/landing/img/en-${shot}.webp`]]);
      assert.equal(await page.evaluate(() => { const r = document.querySelector('#pin').getBoundingClientRect(); return r.top >= 68 && r.bottom <= innerHeight; }), true, 'the pinned phone stays fully visible');
    }
    // Keys scroll the page natively, always forward, and at every stop the story shows the step at mid-screen.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    const seen = [];
    let last = -1;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('PageDown');
      await stillScroll(page);
      const now = await page.evaluate(() => {
        const mid = innerHeight / 2, at = [...document.querySelectorAll('.step')].find(e => { const r = e.getBoundingClientRect(); return r.top < mid - 30 && r.bottom > mid + 30; });
        return { y: scrollY, mid: at ? at.dataset.step : null, active: document.querySelector('.step.active').dataset.step, shown: document.querySelector('#pin img.on').dataset.step, end: scrollY + innerHeight >= document.documentElement.scrollHeight - 4 };
      });
      assert.ok(now.y > last, 'PageDown moves forward: ' + now.y);
      last = now.y;
      if (now.mid !== null) { assert.equal(now.active, now.mid); assert.equal(now.shown, now.mid); seen.push(+now.mid); }
      if (now.end) break;
    }
    assert.ok(seen.length >= 3, 'stops inside the story: ' + seen);
    assert.deepEqual(seen, [...new Set(seen)].sort((x, y) => x - y), 'steps appear in order');
    assert.equal(await page.evaluate(() => scrollY + innerHeight >= document.documentElement.scrollHeight - 4), true, 'keys reach the end of the page');
    // Tab reaches every control once, in order, always visible and clear of the fixed header.
    await page.goto(BASE + '/?lang=en');
    const stops = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press(webkit ? 'Alt+Tab' : 'Tab');   // WebKit on a Mac tabs to links with Option held
      await stillScroll(page);
      const at = await page.evaluate(() => { const e = document.activeElement, r = e.getBoundingClientRect(), s = getComputedStyle(e); return e === document.body ? null : { name: e.textContent.trim(), inHeader: !!e.closest('header'), top: r.top, bottom: r.bottom, outline: s.outlineStyle + s.outlineWidth, vh: innerHeight }; });
      if (!at) break;
      assert.equal(at.outline, 'solid2px', at.name + ' shows its focus ring');
      assert.ok(at.bottom <= at.vh && (at.inHeader || at.top >= 68), `${at.name} is visible: ${at.top}-${at.bottom}`);
      stops.push(at.name.replace(/\s*→$/, ''));
    }
    assert.deepEqual(stops, ['Lean Ritual', '中', 'EN', 'Sign in', 'Use your invite', 'Sign in', 'No invite yet? Ask for one', 'Use your invite', 'Sign in', 'No invite yet? Ask for one', 'Privacy', 'Terms', 'Training guide', 'Contact']);
    // What a screen reader gets: one ordered list of five, each a heading and its text; the pinned phone is silent.
    const tree = await page.locator('#story').ariaSnapshot();
    assert.equal((tree.match(/- listitem/g) || []).length, 5);
    assert.equal((tree.match(/- heading "[^"]+" \[level=3\]/g) || []).length, 5);
    assert.doesNotMatch(tree, /- img/);
    assert.match(await page.locator('.hero').ariaSnapshot(), /heading "One app to get leaner, stronger, better" \[level=1\]/);
    assert.deepEqual([log.errors, log.csp], [[], []]);
    await context.close();
  });

  await t.test('sign-in and invite links are plain navigations: at once, by any input, with a clean way back', async () => {
    const LINKS = ['header a[href="/login.html"]', '.hero a[href="/login.html?invite="]', '.finale a[href="/login.html"]', '.finale a[href="/login.html?invite="]'];
    for (const how of ['click', 'Enter']) for (const selector of LINKS) {
      const { context, page, log } = await watchedPage(browser, { viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
      await page.goto(BASE + '/');
      const link = page.locator(selector);
      await link.scrollIntoViewIfNeeded();
      await stillScroll(page);
      // 204 leaves the browser on this page, as a stalled request would: nothing may cover it and a second press must work.
      const asked = [];
      await page.route('**/login.html*', r => { asked.push(r.request().url().replace(BASE, '')); return r.fulfill({ status: 204 }); });
      await page.evaluate(() => { window.__events = []; addEventListener('click', e => window.__events.push([e.defaultPrevented, performance.now()])); });
      const before = await page.evaluate(() => document.body.childElementCount);
      await page.waitForTimeout(1500);   // the entrance has finished, so the pointer hits a still target
      const spot = await link.boundingBox();
      if (how === 'Enter') await link.focus();
      const press = () => (how === 'click' ? page.mouse.click(spot.x + spot.width / 2, spot.y + spot.height / 2) : page.keyboard.press('Enter'));
      const request = page.waitForRequest('**/login.html*', { timeout: 2500 });
      const started = Date.now();
      await press();
      await request;
      const took = Date.now() - started;
      assert.ok(took < 250, `${how} ${selector}: request after ${took} ms`);
      await press();
      await page.waitForTimeout(150);
      const href = await link.getAttribute('href');
      assert.deepEqual(asked, [href, href], 'a second press is not swallowed');
      assert.deepEqual((await page.evaluate(() => window.__events)).map(e => e[0]), [false, false]);
      assert.equal(await page.evaluate(() => document.body.childElementCount), before, 'nothing is laid over the page');
      assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#050A08');
      assert.equal(await link.evaluate(e => { const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e === hit || e.contains(hit); }), true, 'the link stays uncovered');
      await page.unroute('**/login.html*');
      await press();
      await page.waitForURL('**' + href);
      assert.deepEqual(log.csp, []);
      await context.close();
    }
    // Middle and modified clicks belong to the browser: whatever it delivers, the page never cancels it or navigates itself.
    const { context, page } = await watchedPage(browser, { viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    await page.goto(BASE + '/');
    await page.evaluate(() => { window.__clicks = []; for (const type of ['click', 'auxclick']) addEventListener(type, e => { window.__clicks.push(e.defaultPrevented); e.preventDefault(); }); });
    const invite = page.locator(LINKS[1]);
    await invite.click({ button: 'middle' });
    for (const modifier of ['Meta', 'Control', 'Shift', 'Alt']) await invite.click({ modifiers: [modifier] });
    const clicks = await page.evaluate(() => window.__clicks);
    assert.ok(clicks.length >= 1 && clicks.every(prevented => prevented === false), 'never cancelled by the page: ' + clicks);
    assert.equal(new URL(page.url()).pathname, '/');
    await context.close();
    // Back and Forward, with or without the back/forward cache.
    const back = await watchedPage(browser, { viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    await back.page.addInitScript(() => addEventListener('pageshow', e => { window.__persisted = e.persisted; }));
    await back.page.goto(BASE + '/');
    await back.page.locator(LINKS[0]).click();
    await back.page.waitForURL('**/login.html');
    await back.page.goBack();
    await back.page.locator('#hero-h').waitFor();
    assert.equal(typeof await back.page.evaluate(() => window.__persisted), 'boolean');
    assert.equal(await back.page.locator('meta[name="theme-color"]').getAttribute('content'), '#050A08');
    assert.equal(await back.page.locator(LINKS[1]).isVisible(), true);
    await back.page.goForward();
    await back.page.waitForURL('**/login.html');
    await back.page.locator('#f').waitFor();
    await back.context.close();
  });

  await t.test('dark to sign-in and back shows no white frame', { skip: webkit ? 'frame capture needs Chromium' : false }, async () => {
    for (const colorScheme of ['light', 'dark']) {
      const { context, page } = await watchedPage(browser, { viewport: { width: 390, height: 844 }, colorScheme, locale: 'zh-CN' });
      await page.goto(BASE + '/');
      await page.route('**/login.html', async r => { await new Promise(done => setTimeout(done, 400)); await r.continue(); });
      const cdp = await context.newCDPSession(page), frames = [];
      cdp.on('Page.screencastFrame', e => { frames.push(Buffer.from(e.data, 'base64')); cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {}); });
      await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      await page.locator('header a[href="/login.html"]').click();
      await page.waitForURL('**/login.html');
      await page.waitForTimeout(500);
      await page.goBack();
      await page.locator('#hero-h').waitFor();
      await page.waitForTimeout(500);
      await cdp.send('Page.stopScreencast');
      assert.ok(frames.length >= 5, 'frames: ' + frames.length);
      for (const frame of frames) {
        const { data } = await sharp(frame).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        let white = 0;
        for (let i = 0; i < data.length; i += 3) if (data[i] > 252 && data[i + 1] > 252 && data[i + 2] > 252) white++;
        assert.ok(white / (data.length / 3) < 0.5, colorScheme + ': a mostly white frame');
      }
      await context.close();
    }
  });

  await t.test('the pinned phone is whole on short windows, and the five screens return when it cannot be pinned', async () => {
    for (const lang of ['zh', 'en']) for (const [width, height, pinned] of [[1280, 600, true], [1440, 700, true], [1000, 600, true], [1440, 900, true], [1920, 1080, true], [1440, 599, false], [1280, 480, false], [999, 900, false]]) {
      const { context, page } = await watchedPage(browser, { viewport: { width, height }, reducedMotion: 'reduce' });
      await page.goto(BASE + '/?lang=' + lang);
      for (const step of [0, 2, 4]) {
        await page.evaluate(n => document.querySelector(`.step[data-step="${n}"]`).scrollIntoView({ block: 'center', behavior: 'instant' }), step);
        await page.waitForFunction(n => document.querySelector('.step.active')?.dataset.step === String(n), step);
        const at = await page.evaluate(n => {
          const box = e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width }; };
          return { phone: box(document.querySelector('.pin .device')), header: document.querySelector('.top').getBoundingClientRect().bottom, vh: innerHeight, inline: [...document.querySelectorAll('.inline-shot')].filter(e => e.offsetParent).length, text: box(document.querySelector(`.step[data-step="${n}"] h3`)), shot: box(document.querySelector(`.step[data-step="${n}"] .inline-shot`)) };
        }, step);
        const label = `${lang} ${width}x${height} step ${step}`;
        assert.equal(at.inline, pinned ? 0 : 5, label);
        if (pinned) {
          assert.ok(at.phone.top >= at.header && at.phone.bottom <= at.vh, `${label}: phone ${at.phone.top}-${at.phone.bottom} in ${at.header}-${at.vh}`);
          assert.ok(at.phone.width >= 190, label + ': phone stays large enough');
          assert.ok(at.phone.right <= at.text.left, label + ': clear of the text');
        } else {
          assert.equal(at.phone.width, 0, label + ': no pin');
          assert.ok(at.shot.width > 200 && at.shot.right <= width, label);
        }
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, true);
      await context.close();
    }
    const old = await watchedPage(browser, { viewport: { width: 1440, height: 900 } });
    await old.page.addInitScript(() => { delete window.IntersectionObserver; });
    await old.page.goto(BASE + '/?lang=zh');
    assert.equal(await old.page.locator('.inline-shot:visible').count(), 5, 'no IntersectionObserver: every screen inline');
    assert.equal(await old.page.locator('.pin').isVisible(), false);
    assert.equal(await old.page.evaluate(() => [...document.querySelectorAll('.reveal')].every(e => e.classList.contains('in'))), true);
    assert.deepEqual(old.log.errors, []);
    await old.context.close();
  });

  await t.test('body text never shows through the fixed header, with or without JavaScript', async () => {
    for (const javaScriptEnabled of [true, false]) for (const [width, height] of [[390, 700], [1440, 900]]) {
      const { context, page } = await watchedPage(browser, { viewport: { width, height }, javaScriptEnabled, locale: 'zh-CN', reducedMotion: 'reduce' });
      await page.goto(BASE + '/');
      const opacity = () => page.evaluate(() => getComputedStyle(document.querySelector('.top'), '::before').opacity);
      if (javaScriptEnabled) await page.waitForFunction(() => getComputedStyle(document.querySelector('.top'), '::before').opacity === '0');   // observers report a frame later
      assert.equal(await opacity(), javaScriptEnabled ? '0' : '1', 'see-through only at the top, and only once observed');
      const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.top'), '::before').backgroundColor);
      assert.equal(bg, 'rgb(5, 10, 8)');
      // Put a heading right under the header and photograph the gap between brand and controls: it must be plain background.
      await page.evaluate(() => { const r = document.querySelector('.step h3').getBoundingClientRect(); window.scrollTo({ top: scrollY + r.top - 28, behavior: 'instant' }); });
      await page.waitForTimeout(300);
      assert.equal(await opacity(), '1');
      assert.ok(await page.evaluate(() => { const r = document.querySelector('.step h3').getBoundingClientRect(); return r.top < 60 && r.bottom > 10; }), 'a heading really is behind the header');
      const header = await page.evaluate(() => { const b = document.querySelector('.brand').getBoundingClientRect(), l = document.querySelector('.lang').getBoundingClientRect(); return { x: 0, y: 0, width: innerWidth, height: 66, gap: [b.right + 40, l.left - 2], edge: b.left - 2 }; });
      const { data, info } = await sharp(await page.screenshot({ clip: { x: 0, y: 0, width: header.width, height: header.height } })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
        if (!(x < header.edge - 30 || (x > header.gap[0] && x < header.gap[1]))) continue;
        const i = (y * info.width + x) * 3;
        assert.ok(data[i] < 14 && data[i + 1] < 22 && data[i + 2] < 20, `pixel ${x},${y} shows ${[...data.subarray(i, i + 3)]} (js ${javaScriptEnabled})`);
      }
      await context.close();
    }
  });

  await t.test('on desktop the floating cards stay off the app\'s own text, wherever the phone floats or leans', async () => {
    for (const lang of ['zh', 'en']) for (const [width, height] of [[1000, 700], [1024, 768], [1280, 800], [1440, 900], [1920, 1080]]) {
      const { context, page } = await watchedPage(browser, { viewport: { width, height } });
      await page.goto(BASE + '/?lang=' + lang);
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => { document.querySelector('#rig').style.transition = 'none'; });
      for (const at of [0, 2250, 4500]) for (const lean of ['none', 'rotateY(5deg) rotateX(4deg)', 'rotateY(-5deg) rotateX(-4deg)']) {
        const cards = await page.evaluate(([ms, transform]) => {
          for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; }
          document.querySelector('#rig').style.transform = transform;
          const s = document.querySelector('.hero .device img').getBoundingClientRect();
          return [...document.querySelectorAll('.card')].map(c => { const r = c.getBoundingClientRect(); return { name: c.className, over: (Math.min(r.right, s.right) - Math.max(r.left, s.left)) / s.width, left: r.left, right: r.right, vw: innerWidth, copy: document.querySelector('.hero .copy').getBoundingClientRect().right }; });
        }, [at, lean]);
        // The app's text starts about a tenth of the way in from either edge of its screen.
        for (const c of cards) {
          assert.ok(c.over <= 0.1, `${lang} ${width}px ${c.name} covers ${(c.over * 100).toFixed(1)}% (${lean}, ${at} ms)`);
          assert.ok(c.right <= c.vw && c.left >= c.copy - 8, `${lang} ${width}px ${c.name} stays in its column: ${c.left}-${c.right}`);
        }
      }
      await context.close();
    }
  });

  await t.test('reduced motion shows every section without animation', async () => {
    const { context, page } = await watchedPage(browser, { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await page.goto(BASE + '/?lang=zh');
    const hidden = await page.evaluate(() => [...document.querySelectorAll('.reveal')].filter(e => getComputedStyle(e).opacity !== '1').length);
    assert.equal(hidden, 0);
    assert.ok(await page.locator('.reveal').count() >= 12);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0, 'nothing animates');
    // In-page jumps are instant (Codex review of #57: the shared theme had let smooth scrolling win).
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
    const moving = await watchedPage(browser, { viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
    await moving.page.goto(BASE + '/?lang=zh');
    assert.equal(await moving.page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'smooth', 'smooth scrolling otherwise');
    await moving.context.close();
    await page.locator('header a[href="/login.html"]').click();
    await page.waitForURL('**/login.html');
    await context.close();
  });

  if (shots) await t.test('screenshots', async () => {
    for (const lang of ['zh', 'en']) for (const width of [390, 1440]) {
      const { context, page } = await watchedPage(browser, { viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: width === 390 ? 2 : 1 });
      await page.goto(BASE + '/?lang=' + lang);
      await settle(page);
      await page.waitForTimeout(1200);
      const name = `${width}-${lang}`;
      await page.screenshot({ path: path.join(shots, name + '-fold.png') });
      await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: true });
      // A full-page picture shows the pinned phone in one place only, so also show the story as readers see it.
      if (width === 1440) for (const step of [0, 2, 3]) {
        await page.evaluate(n => document.querySelector(`.step[data-step="${n}"]`).scrollIntoView({ block: 'center', behavior: 'instant' }), step);
        await page.waitForTimeout(1200);
        await page.screenshot({ path: path.join(shots, `${name}-story-${step + 1}.png`) });
      }
      await context.close();
    }
  });
});
