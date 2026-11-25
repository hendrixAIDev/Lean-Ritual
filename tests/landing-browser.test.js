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
  if (withVideos) for (const name of ['intro-zh-9x16.mp4', 'intro-zh-16x9.mp4', 'intro-en-9x16.mp4', 'intro-en-16x9.mp4']) fs.writeFileSync(path.join(mediaDir, name), Buffer.alloc(2048));
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

async function axeViolations(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ['violations'] });
    return result.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  });
}

test('landing page in a real browser', { skip: playwright ? false : 'Playwright is not installed', timeout: 240000 }, async t => {
  await startServer(t, BASE, false);
  await startServer(t, SHOWN, true);
  const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
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
      // The ticker runs straight into the setup band, and section numbers stay consecutive.
      assert.equal(await page.evaluate(() => Math.round(document.querySelector('.band').getBoundingClientRect().top - document.querySelector('.ticker').getBoundingClientRect().bottom)), 0);
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
    await page.goto(SHOWN + '/');
    await settle(page);
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    assert.equal(await page.locator('h1 .sr').textContent(), '一个 App，助你更瘦、更强、更好');
    assert.deepEqual(log.media, [], 'no MP4 request before play');
    assert.equal(await page.locator('#film').getAttribute('src'), null);
    assert.equal(await page.locator('#film').getAttribute('poster'), '/media/intro-zh-9x16.jpg');
    await page.locator('#play').click();
    await page.waitForFunction(() => document.getElementById('film-note').textContent.length > 0);
    assert.deepEqual(log.media.map(u => new URL(u).pathname), ['/media/intro-zh-9x16.mp4']);
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

  await t.test('reduced motion shows every section without animation', async () => {
    const { context, page } = await watchedPage(browser, { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await page.goto(BASE + '/?lang=zh');
    const hidden = await page.evaluate(() => [...document.querySelectorAll('.reveal')].filter(e => getComputedStyle(e).opacity !== '1').length);
    assert.equal(hidden, 0);
    await context.close();
  });

  if (shots) await t.test('screenshots', async () => {
    for (const lang of ['zh', 'en']) for (const colorScheme of ['light', 'dark']) for (const width of [390, 1440]) {
      const { context, page } = await watchedPage(browser, { viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: width === 390 ? 2 : 1, colorScheme });
      await page.goto(BASE + '/?lang=' + lang);
      await settle(page);
      await page.waitForTimeout(1200);
      const name = `${width}-${lang}-${colorScheme}`;
      await page.screenshot({ path: path.join(shots, name + '-fold.png') });
      await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: true });
      await context.close();
    }
  });
});
