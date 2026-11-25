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

test('landing page in a real browser', { skip: playwright ? false : 'Playwright is not installed', timeout: 480000 }, async t => {
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
    // Keys scroll the page natively, and the story follows.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    const visited = new Set();
    for (let i = 0; i < 80; i++) {
      for (let k = 0; k < 4; k++) await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(260);
      visited.add(await page.evaluate(() => document.querySelector('.step.active').dataset.step));
      if (await page.evaluate(() => scrollY + innerHeight >= document.documentElement.scrollHeight - 4)) break;
    }
    assert.deepEqual([...visited].sort(), ['0', '1', '2', '3', '4']);
    // Tab reaches every control once, in order, always visible and clear of the fixed header.
    await page.goto(BASE + '/?lang=en');
    const stops = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      await page.evaluate(() => new Promise(done => { let last = -1, same = 0; const t = setInterval(() => { same = scrollY === last ? same + 1 : 0; last = scrollY; if (same > 4) { clearInterval(t); done(); } }, 60); }));   // smooth scroll has settled
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

  await t.test('hand-off to sign-in: login\'s own colour opens first, the browser UI follows, and Back restores the page', async () => {
    for (const colorScheme of ['light', 'dark']) {
      const { context, page, log } = await watchedPage(browser, { viewport: { width: 390, height: 844 }, colorScheme, locale: 'zh-CN' });
      await page.goto(BASE + '/login.html');
      const loginBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.goto(BASE + '/');
      const themeColour = () => page.evaluate(() => { const c = document.createElement('i'); c.style.color = document.querySelector('meta[name="theme-color"]').content; document.body.append(c); const v = getComputedStyle(c).color; c.remove(); return v; });
      assert.equal(await themeColour(), 'rgb(5, 10, 8)');
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(5, 10, 8)');
      // 204 keeps the browser on this page, as it is while login.html is still loading.
      await page.route('**/login.html', r => r.fulfill({ status: 204 }));
      await page.locator('header a[href="/login.html"]').click();
      await page.waitForFunction(() => document.querySelector('.handoff'));
      await page.waitForTimeout(700);   // the wipe is done and login is still loading
      const { data } = await sharp(await page.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const want = loginBg.match(/\d+/g).map(Number);
      for (let i = 0; i < data.length; i += 3) if (Math.abs(data[i] - want[0]) + Math.abs(data[i + 1] - want[1]) + Math.abs(data[i + 2] - want[2]) > 3) assert.fail(`pixel ${i / 3} is ${[...data.subarray(i, i + 3)]}, not login's ${want}`);
      assert.equal(await themeColour(), loginBg);
      await page.waitForFunction(() => !document.querySelector('.handoff'), null, { timeout: 8000 });   // a navigation that never lands gives the page back
      assert.equal(await themeColour(), 'rgb(5, 10, 8)');
      await page.unroute('**/login.html');
      await page.locator('header a[href="/login.html"]').click();
      await page.waitForURL('**/login.html');
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), loginBg);
      await page.goBack();
      await page.locator('#hero-h').waitFor();
      assert.equal(await page.locator('.handoff').count(), 0);
      assert.equal(await themeColour(), 'rgb(5, 10, 8)');
      // Opening in a new tab is left to the browser; a restored page is usable again.
      await page.evaluate(() => { window.__taken = []; window.__watch = e => { window.__taken.push(e.defaultPrevented); e.preventDefault(); }; addEventListener('click', window.__watch); });
      for (const modifiers of [['Meta'], ['Control'], ['Shift'], ['Alt']]) await page.locator('.hero a[href="/login.html?invite="]').click({ modifiers });
      // Control-click is a context-menu gesture on macOS and fires no click there.
      const taken = await page.evaluate(() => { removeEventListener('click', window.__watch); return window.__taken; });
      assert.ok(taken.length >= 3 && taken.every(v => v === false), 'modified clicks stay with the browser: ' + taken);
      assert.equal(await page.locator('.handoff').count(), 0);
      await page.locator('.hero a[href="/login.html?invite="]').focus();
      await page.keyboard.press('Enter');
      await page.waitForURL('**/login.html?invite=');
      assert.deepEqual(log.csp, []);
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
    await page.locator('header a[href="/login.html"]').click();
    assert.equal(await page.locator('.handoff').count(), 0, 'no wipe before sign-in');
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
