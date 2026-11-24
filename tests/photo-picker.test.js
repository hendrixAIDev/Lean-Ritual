'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const AXE_PATH = path.join(ROOT, 'tests/fixtures/axe-core/axe.min.js');
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8b8AAAAASUVORK5CYII=',
  'base64'
);

function extractInlineScript(html) {
  const matches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const inline = matches.find(m => !/\bsrc\s*=/i.test(m[1]));
  assert.ok(inline, 'expected inline <script> block');
  return inline[2];
}

function mountApp({ lang = 'zh', profile = null, days = {} } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const script = extractInlineScript(html);

  let focusedTarget = null;
  const listeners = {};
  const storeData = new Map();
  if (profile) storeData.set('data/users/u1/app/app/profile', JSON.parse(JSON.stringify(profile)));
  for (const [d, val] of Object.entries(days)) {
    storeData.set(`data/users/u1/app/days/${d}`, JSON.parse(JSON.stringify(val)));
  }

  const storage = new Map([['bj-lang', lang]]);
  const localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: k => { storage.delete(k); },
    get length() { return storage.size; },
    key: i => [...storage.keys()][i] ?? null
  };

  const makeEl = id => ({
    id,
    innerHTML: '',
    textContent: '',
    hidden: id !== 'app',
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    contains: () => false,
    focus() { focusedTarget = `#${id}`; }
  });
  const appEl = makeEl('app');
  const tabsEl = makeEl('tabs');
  const toastEl = makeEl('toast');

  const clickLog = [];
  const fakeInputs = new Map();

  function getOrMakeFakeInput(id) {
    if (!fakeInputs.has(id)) {
      const m = appEl.innerHTML.match(new RegExp(`<input\\b[^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`));
      if (!m) return null;
      const disabled = /\bdisabled\b/.test(m[0]);
      const obj = {
        id,
        disabled,
        value: 'C:\\fakepath\\prev.jpg',
        click() { clickLog.push({ id, valueAtClick: this.value }); },
        focus() { focusedTarget = `#${id}`; }
      };
      fakeInputs.set(id, obj);
    }
    return fakeInputs.get(id);
  }

  function queryRendered(sel) {
    const src = appEl.innerHTML;
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      if (id === 'app') return appEl;
      if (id === 'tabs') return tabsEl;
      if (id === 'toast') return toastEl;
      const inp = getOrMakeFakeInput(id);
      if (inp) return inp;
      if (new RegExp(`\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(src)) {
        return { id, focus() { focusedTarget = sel; } };
      }
      return null;
    }
    const actMatch = sel.match(/^\[data-act="([^"]+)"\]$/);
    if (actMatch && new RegExp(`data-act="${actMatch[1]}"`).test(src)) {
      return { focus() { focusedTarget = sel; } };
    }
    return null;
  }

  const document = {
    documentElement: { lang: lang === 'en' ? 'en' : 'zh-CN' },
    title: '',
    activeElement: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector: sel => queryRendered(sel),
    querySelectorAll: () => [],
    getElementById: id => queryRendered(`#${id}`)
  };

  const db = {
    doc(p) {
      return {
        async get() {
          return storeData.has(p) ? { exists: true, data: () => JSON.parse(JSON.stringify(storeData.get(p))) } : { exists: false };
        },
        async set(d) { storeData.set(p, JSON.parse(JSON.stringify(d))); },
        async delete() { storeData.delete(p); }
      };
    },
    async commit(changes) {
      for (const c of changes) {
        if (c.after !== undefined) storeData.set(c.path, JSON.parse(JSON.stringify(c.after)));
      }
    },
    collection(prefix) {
      return {
        orderBy() { return this; },
        limit() { return this; },
        async get() {
          const docs = [];
          for (const [k, v] of storeData.entries()) {
            if (k.startsWith(prefix + '/')) {
              docs.push({ id: k.slice(prefix.length + 1), data: () => JSON.parse(JSON.stringify(v)) });
            }
          }
          return { docs };
        }
      };
    }
  };

  const window = {
    scrollTo() {},
    ritual: {
      hosted: true,
      async use(name) {
        if (name === 'db') return db;
        if (name === 'user') return { async me() { return { id: 'u1', username: 'tester', created: '2026-11-18T00:00:00Z' }; } };
        return null;
      }
    }
  };

  const revokedUrls = [];
  const TestURL = class extends URL {
    static createObjectURL() { return 'blob:test-photo'; }
    static revokeObjectURL(u) { revokedUrls.push(u); }
  };

  const ctx = vm.createContext({
    window,
    document,
    localStorage,
    navigator: { userAgent: 'node-test', languages: [lang === 'en' ? 'en-US' : 'zh-CN'] },
    location: { href: 'http://127.0.0.1:8080/', hostname: '127.0.0.1', search: `?lang=${lang}` },
    URL: TestURL,
    Date, Math, JSON, Object, Array, Set, Map, Promise, Number, String, Boolean, RegExp, Error,
    AbortController, encodeURIComponent, decodeURIComponent, isNaN, parseFloat, parseInt, console, setTimeout, clearTimeout
  });
  vm.runInContext(script, ctx);

  async function waitBoot() {
    for (let i = 0; i < 60; i++) {
      if (vm.runInContext('S.ready', ctx)) return;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('app did not boot');
  }

  async function dispatchClick(dataset) {
    fakeInputs.clear();
    const btn = {
      dataset,
      disabled: false,
      closest: sel => (sel === '[data-act]' ? btn : null)
    };
    for (const fn of (listeners.click || [])) {
      await fn({ target: btn, preventDefault() {} });
    }
  }

  return {
    ctx,
    appEl,
    clickLog,
    revokedUrls,
    getFocused: () => focusedTarget,
    resetFocus: () => { focusedTarget = null; },
    waitBoot,
    dispatchClick
  };
}

const SAMPLE_PROFILE = {
  sex: 'm', age: 29, height: 176, weight: 72, bf: 15,
  equipment: 'gym', trainDays: [1, 3, 5], slot: 'eve',
  stage: 'cut', exp: 'mid', injuries: [], supps: [], startDate: '2026-11-01'
};

test('all file inputs in app/index.html are hidden behind localized button triggers with accessibility attributes', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const fileInputs = [...html.matchAll(/<input\b[^>]*type="file"[^>]*>/gi)].map(m => m[0]);
  assert.equal(fileInputs.length, 3, `expected 3 file inputs (m-photo, data-more, ufb-file), found ${fileInputs.length}`);
  for (const tag of fileInputs) {
    assert.match(tag, /\bclass="[^"]*\bfile-input\b/, `file input must be hidden with .file-input: ${tag}`);
    assert.match(tag, /\btabindex="-1"/, `hidden file input must not be in tab order: ${tag}`);
    assert.match(tag, /\baria-hidden="true"/, `hidden file input must be aria-hidden: ${tag}`);
    assert.match(tag, /\baccept="image\/\*"/, `file input must preserve accept="image/*": ${tag}`);
  }
  const mPhoto = fileInputs.find(t => t.includes('id="m-photo"'));
  assert.ok(mPhoto, 'expected #m-photo input');
  assert.match(mPhoto, /\bmultiple\b/, '#m-photo must keep multiple attribute');

  const moreInput = fileInputs.find(t => t.includes('data-more='));
  assert.ok(moreInput, 'expected data-more input');
  assert.match(moreInput, /data-tag="其他"/, 'data-more input must keep data-tag="其他"');

  const ufbFile = fileInputs.find(t => t.includes('id="ufb-file"'));
  assert.ok(ufbFile, 'expected #ufb-file input');
  assert.doesNotMatch(ufbFile, /\bmultiple\b/, '#ufb-file stays single-file');
});

test('localized photo picker UI, status lines, thumbnails, click delegation, and focus restoration in zh and en', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const sampleDay = {
    date: today,
    meals: [{ id: 'meal-1', type: '午餐', text: 'Chicken rice', time: '12:30', est: { kcal: 620, protein: 46, by: 'manual' } }]
  };

  for (const lang of ['zh', 'en']) {
    const app = mountApp({ lang, profile: SAMPLE_PROFILE, days: { [today]: sampleDay } });
    await app.waitBoot();

    // Food tab: empty state
    vm.runInContext('S.tab = "food"; S.date = todayStr(); S.pendingPhotos = null; render();', app.ctx);
    const emptyFood = app.appEl.innerHTML;
    assert.match(emptyFood, /id="m-photo"[^>]*class="file-input"[^>]*accept="image\/\*"[^>]*multiple/);
    assert.match(emptyFood, /id="m-photo-btn"[^>]*data-act="pick-file"[^>]*data-for="m-photo"/);
    assert.match(emptyFood, lang === 'zh' ? />选择照片<\/span><\/button>/ : />Choose photos<\/span><\/button>/);
    assert.match(emptyFood, lang === 'zh' ? /id="m-photo-status"[^>]*>未选择</ : /id="m-photo-status"[^>]*>No photo selected</);
    assert.match(emptyFood, /id="more-meal-1"[^>]*data-more="meal-1"/);
    assert.match(emptyFood, lang === 'zh'
      ? /data-act="pick-file" data-for="more-meal-1">\+ 照片<span class="sr">，午餐<\/span><\/button>/
      : /data-act="pick-file" data-for="more-meal-1">\+ Photo<span class="sr">, Lunch<\/span><\/button>/);

    // Clicking the styled button clears value and triggers hidden input click
    await app.dispatchClick({ act: 'pick-file', for: 'm-photo' });
    assert.deepEqual(app.clickLog, [{ id: 'm-photo', valueAtClick: '' }]);
    app.clickLog.length = 0;

    // Clicking meal card + Photo triggers hidden data-more input
    await app.dispatchClick({ act: 'pick-file', for: 'more-meal-1' });
    assert.deepEqual(app.clickLog, [{ id: 'more-meal-1', valueAtClick: '' }]);
    app.clickLog.length = 0;

    // Food tab: 2 selected photos -> status + thumbnails + unpick focus restoration
    vm.runInContext(`
      S.pendingPhotos = [
        { file: { name: "a.jpg" }, url: "blob:photo-1" },
        { file: { name: "b.jpg" }, url: "blob:photo-2" }
      ];
      render();
    `, app.ctx);
    const twoFood = app.appEl.innerHTML;
    assert.match(twoFood, lang === 'zh' ? /id="m-photo-status"[^>]*>已选 2 张</ : /id="m-photo-status"[^>]*>2 selected</);
    assert.equal((twoFood.match(/class="preview"/g) || []).length, 2);
    assert.equal((twoFood.match(/data-act="unpick"/g) || []).length, 2);

    // Remove both photos and verify focus restores cleanly
    app.resetFocus();
    await app.dispatchClick({ act: 'unpick', v: '0' });
    assert.equal(app.getFocused(), '[data-act="unpick"]');
    assert.match(app.appEl.innerHTML, lang === 'zh' ? /id="m-photo-status"[^>]*>已选 1 张</ : /id="m-photo-status"[^>]*>1 selected</);

    app.resetFocus();
    await app.dispatchClick({ act: 'unpick', v: '0' });
    assert.equal(app.getFocused(), '#m-photo-btn');
    assert.match(app.appEl.innerHTML, lang === 'zh' ? /id="m-photo-status"[^>]*>未选择</ : /id="m-photo-status"[^>]*>No photo selected</);

    // Food tab: 4 selected photos -> button & hidden input disabled, max message shown
    vm.runInContext(`
      S.pendingPhotos = [1, 2, 3, 4].map(i => ({ file: { name: i + ".jpg" }, url: "blob:p-" + i }));
      render();
    `, app.ctx);
    const maxFood = app.appEl.innerHTML;
    assert.match(maxFood, /id="m-photo-btn"[^>]*\bdisabled\b/);
    assert.match(maxFood, /id="m-photo"[^>]*\bdisabled\b/);
    assert.match(maxFood, lang === 'zh' ? /已选 4 张 · 最多 4 张/ : /4 selected · Max 4 photos/);
    await app.dispatchClick({ act: 'pick-file', for: 'm-photo' });
    assert.deepEqual(app.clickLog, [], 'disabled file input must not be clicked at max photos');

    // Feedback screenshot picker: empty & selected states
    vm.runInContext(`
      S.tab = "me";
      S.ufb = { type: "bug", message: "", includeDeviceInfo: true, file: null, previewUrl: null, busy: false, errKey: null, errObj: null };
      render();
    `, app.ctx);
    const emptyFb = app.appEl.innerHTML;
    assert.match(emptyFb, /id="ufb-file"[^>]*class="file-input"[^>]*accept="image\/\*"/);
    assert.match(emptyFb, /id="ufb-file-btn"[^>]*data-act="pick-file"[^>]*data-for="ufb-file"/);
    assert.match(emptyFb, lang === 'zh' ? />选择照片<\/span><\/button>/ : />Choose photo<\/span><\/button>/);
    assert.match(emptyFb, lang === 'zh' ? /id="ufb-shot-status"[^>]*>未选择</ : /id="ufb-shot-status"[^>]*>No photo selected</);

    await app.dispatchClick({ act: 'pick-file', for: 'ufb-file' });
    assert.deepEqual(app.clickLog, [{ id: 'ufb-file', valueAtClick: '' }]);
    app.clickLog.length = 0;

    vm.runInContext(`
      S.ufb.file = { name: "shot.png" };
      S.ufb.previewUrl = "blob:shot-1";
      render();
    `, app.ctx);
    const pickedFb = app.appEl.innerHTML;
    assert.match(pickedFb, lang === 'zh' ? />换一张截图<\/span><\/button>/ : />Replace screenshot<\/span><\/button>/);
    assert.match(pickedFb, lang === 'zh' ? /id="ufb-shot-status"[^>]*>已选 1 张</ : /id="ufb-shot-status"[^>]*>1 selected</);
    assert.match(pickedFb, /class="preview" src="blob:shot-1"/);

    app.resetFocus();
    await app.dispatchClick({ act: 'ufb-unpick' });
    assert.equal(app.getFocused(), '#ufb-file-btn');
    assert.match(app.appEl.innerHTML, lang === 'zh' ? /id="ufb-shot-status"[^>]*>未选择</ : /id="ufb-shot-status"[^>]*>No photo selected</);
  }
});

function resolvePlaywright() {
  const home = os.homedir();
  const candidates = ['playwright', 'playwright-core'];
  for (const rel of [
    '.npm/_npx',
    'node_modules/playwright',
    'node_modules/playwright-core'
  ]) {
    const p = path.join(home, rel);
    if (rel === '.npm/_npx' && fs.existsSync(p)) {
      for (const entry of fs.readdirSync(p)) {
        candidates.push(path.join(p, entry, 'node_modules', 'playwright'));
      }
    } else {
      candidates.push(p);
    }
  }
  for (const spec of candidates) {
    try {
      const pw = require(spec);
      const execPath = process.env.CHROMIUM_PATH
        || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium'
          : fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome'
            : pw.chromium.executablePath());
      if (execPath && fs.existsSync(execPath)) return { chromium: pw.chromium, executablePath: execPath };
    } catch {}
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startTestServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-picker-test-'));
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dir,
    PORT: String(port),
    HOST: '127.0.0.1',
    AUTH_BASE_URL: base,
    AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
    COOKIE_SECURE: '0',
    TRUST_PROXY: '0',
    MAIL_MODE: 'file',
    OPENROUTER_API_KEY: ''
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = new Promise(r => child.once('exit', r));
      child.kill();
      await stopped;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout: ' + stderr)), 8000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('server exited early: ' + stderr)); });
  });
  return { dir, base, env };
}

test('headless Chromium 375px: localized photo pickers, keyboard activation, thumbnails, status lines, and axe-core in zh & en', async t => {
  const pw = resolvePlaywright();
  if (!pw) {
    t.skip('Playwright/Chromium not installed in this environment');
    return;
  }

  const axeSource = fs.readFileSync(AXE_PATH, 'utf8');
  const srv = await startTestServer(t);
  const issued = spawnSync(process.execPath, ['scripts/auth-admin.js', 'invite', 'picker@example.com'], {
    cwd: ROOT, env: srv.env, encoding: 'utf8', timeout: 5000
  });
  assert.equal(issued.status, 0, issued.stderr);
  const invite = JSON.parse(issued.stdout);
  const pwStr = 'picker-strong-password-123';

  const browser = await pw.chromium.launch({
    executablePath: pw.executablePath,
    headless: true,
    args: ['--no-sandbox']
  });
  t.after(async () => { await browser.close(); });

  // Register, verify, and seed one meal
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'en-US' });
    const page = await ctx.newPage();
    await page.goto(`${srv.base}/login.html?invite=${encodeURIComponent(invite.token)}&email=${encodeURIComponent(invite.email)}&lang=zh`);
    await page.locator('#n').fill('Picker Tester');
    await page.locator('#p').fill(pwStr);
    await page.locator('#go').click();
    await page.getByText('请查收验证邮件，验证后再登录。', { exact: true }).waitFor();
    const mail = fs.readdirSync(path.join(srv.dir, 'mail'))
      .map(f => JSON.parse(fs.readFileSync(path.join(srv.dir, 'mail', f), 'utf8')))
      .find(m => m.kind === 'verify');
    const u = new URL(mail.url);
    await page.goto(`${srv.base}${u.pathname}${u.search}`);
    await page.getByText('邮箱已验证，请登录。', { exact: true }).waitFor();
    await page.locator('#e').fill(invite.email);
    await page.locator('#p').fill(pwStr);
    await page.locator('#go').click();
    await page.locator('#setup').waitFor({ state: 'visible' });
    await page.locator('#f-age').fill('29');
    await page.locator('#f-height').fill('176');
    await page.locator('#f-weight').fill('72');
    await page.locator('button[type="submit"]').click();
    await page.locator('nav#tabs').waitFor({ state: 'visible' });
    await page.evaluate(async () => {
      await updateDay(todayStr(), day => {
        day.meals = [{
          id: 'td-m1', type: '午餐', text: 'Chicken rice bowl', time: '12:30',
          est: { kcal: 640, protein: 46, carbs: 68, fat: 18, by: 'manual' }
        }];
      }, { quiet: true });
      render();
    });
    await ctx.close();
  }

  async function assertAxeClean(context, page, label) {
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send('Runtime.evaluate', { expression: axeSource, awaitPromise: false });
      const res = await cdp.send('Runtime.evaluate', {
        expression: `window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
          rules: { 'target-size': { enabled: true } }
        }).then(r => JSON.stringify(r.violations.map(v => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.map(n => ({ target: n.target, html: n.html.slice(0, 120), summary: n.failureSummary }))
        }))))`,
        awaitPromise: true,
        returnByValue: true
      });
      const violations = JSON.parse(res.result.value);
      assert.deepEqual(violations, [], `Axe violations on ${label}: ${JSON.stringify(violations, null, 2)}`);
    } finally {
      await cdp.detach();
    }
  }

  async function assertNoVisibleNativeFileInput(page, label) {
    const visibleNative = await page.evaluate(() => {
      return [...document.querySelectorAll('input[type="file"]')].map(el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { id: el.id, w: r.width, h: r.height, clip: cs.clip, clipPath: cs.clipPath, ariaHidden: el.getAttribute('aria-hidden'), tabIndex: el.tabIndex };
      });
    });
    assert.ok(visibleNative.length > 0, `expected at least one hidden file input on ${label}`);
    for (const item of visibleNative) {
      assert.ok(item.w <= 1 && item.h <= 1, `native file input must not be visibly rendered on ${label}: ${JSON.stringify(item)}`);
      assert.equal(item.ariaHidden, 'true', `native file input must be aria-hidden on ${label}`);
      assert.equal(item.tabIndex, -1, `native file input must have tabIndex -1 on ${label}`);
    }
  }

  // Test zh (with en-US browser locale!) and en across light & dark schemes at 375px
  for (const [lang, colorScheme] of [['zh', 'light'], ['en', 'light'], ['zh', 'dark'], ['en', 'dark']]) {
    const labelPrefix = `${lang}-${colorScheme}`;
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      locale: 'en-US', // intentionally en-US even for zh app to prove browser locale cannot leak
      colorScheme
    });
    const page = await context.newPage();
    const cspViolations = [];
    const pageErrors = [];
    await page.exposeFunction('recordPickerCSP', v => cspViolations.push(v));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', e => {
        window.recordPickerCSP(`${e.violatedDirective}: ${e.blockedURI}`);
      });
    });
    page.on('pageerror', e => pageErrors.push(e.message));

    try {
      await page.goto(`${srv.base}/login.html?lang=${lang}`);
      await page.locator('#e').fill(invite.email);
      await page.locator('#p').fill(pwStr);
      await page.locator('#go').click();
      await page.locator('nav#tabs').waitFor({ state: 'visible' });
      await page.evaluate(async l => { await setLang(l, { persistProfile: false }); }, lang);

      // Food view: empty meal photo picker
      await page.locator('nav#tabs [data-act="tab"][data-v="food"]').click();
      await page.locator('#m-photo-btn').waitFor({ state: 'visible' });
      await assertNoVisibleNativeFileInput(page, `${labelPrefix}/food-empty`);

      assert.equal((await page.locator('#m-photo-btn').innerText()).trim(), lang === 'zh' ? '选择照片' : 'Choose photos');
      assert.equal((await page.locator('#m-photo-status').innerText()).trim(), lang === 'zh' ? '未选择' : 'No photo selected');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal overflow on ${labelPrefix}/food-empty`);
      await assertAxeClean(context, page, `${labelPrefix}/food-empty`);

      // Keyboard focus & Enter/Space activation opens native file chooser via hidden input
      await page.locator('#m-photo-btn').focus();
      const [fcEnter] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.keyboard.press('Enter')
      ]);
      assert.equal(fcEnter.isMultiple(), true, 'meal photo picker must preserve multiple');

      const [fcSpace] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.keyboard.press('Space')
      ]);
      assert.equal(fcSpace.isMultiple(), true, 'Space must also trigger meal photo file chooser');

      // Select 2 photos via the file chooser
      await fcSpace.setFiles([
        { name: 'before.png', mimeType: 'image/png', buffer: PNG_1X1 },
        { name: 'after.png', mimeType: 'image/png', buffer: PNG_1X1 }
      ]);
      assert.equal((await page.locator('#m-photo-status').innerText()).trim(), lang === 'zh' ? '已选 2 张' : '2 selected');
      assert.equal(await page.locator('.previews figure').count(), 2);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal overflow on ${labelPrefix}/food-2photos`);
      await assertAxeClean(context, page, `${labelPrefix}/food-2photos`);

      // Remove one photo -> status updates to 1 selected
      await page.locator('[data-act="unpick"]').first().click();
      assert.equal((await page.locator('#m-photo-status').innerText()).trim(), lang === 'zh' ? '已选 1 张' : '1 selected');
      assert.equal(await page.locator('.previews figure').count(), 1);

      // Meal card "+ Photo" button triggers hidden data-more filechooser
      const moreBtn = page.locator('[data-act="pick-file"][data-for="more-td-m1"]');
      const [fcMore] = await Promise.all([
        page.waitForEvent('filechooser'),
        moreBtn.click()
      ]);
      assert.equal(fcMore.isMultiple(), false, 'meal card add-photo input stays single-file');

      // Feedback screenshot picker on Me tab
      await page.locator('nav#tabs [data-act="tab"][data-v="me"]').click();
      await page.locator('[data-act="ufb-open"]').click();
      await page.locator('#ufb-file-btn').waitFor({ state: 'visible' });
      await assertNoVisibleNativeFileInput(page, `${labelPrefix}/ufb-empty`);

      assert.equal((await page.locator('#ufb-file-btn').innerText()).trim(), lang === 'zh' ? '选择照片' : 'Choose photo');
      assert.equal((await page.locator('#ufb-shot-status').innerText()).trim(), lang === 'zh' ? '未选择' : 'No photo selected');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal overflow on ${labelPrefix}/ufb-empty`);
      await assertAxeClean(context, page, `${labelPrefix}/ufb-empty`);

      // Keyboard Enter opens feedback screenshot filechooser
      await page.locator('#ufb-file-btn').focus();
      const [fcUfb] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.keyboard.press('Enter')
      ]);
      assert.equal(fcUfb.isMultiple(), false, 'feedback screenshot input stays single-file');
      await fcUfb.setFiles({ name: 'bug.png', mimeType: 'image/png', buffer: PNG_1X1 });

      assert.equal((await page.locator('#ufb-file-btn').innerText()).trim(), lang === 'zh' ? '换一张截图' : 'Replace screenshot');
      assert.equal((await page.locator('#ufb-shot-status').innerText()).trim(), lang === 'zh' ? '已选 1 张' : '1 selected');
      assert.equal(await page.locator('#tester-fb-card .previews img.preview').count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal overflow on ${labelPrefix}/ufb-selected`);
      await assertAxeClean(context, page, `${labelPrefix}/ufb-selected`);

      // Remove feedback screenshot -> status returns to unselected and focus restores to button
      await page.locator('[data-act="ufb-unpick"]').click();
      assert.equal((await page.locator('#ufb-shot-status').innerText()).trim(), lang === 'zh' ? '未选择' : 'No photo selected');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'ufb-file-btn');

      assert.deepEqual(cspViolations, [], `CSP violations in ${labelPrefix}`);
      assert.deepEqual(pageErrors, [], `Page errors in ${labelPrefix}`);
    } finally {
      await context.close();
    }
  }
});
