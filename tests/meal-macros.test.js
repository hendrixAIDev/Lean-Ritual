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

function extractInlineScript(html) {
  const matches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const inline = matches.find(m => !/\bsrc\s*=/i.test(m[1]));
  assert.ok(inline, 'expected inline <script> block');
  return inline[2];
}

function mountApp({ lang = 'zh', profile = null, days = {} } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const script = extractInlineScript(html);

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
    contains: () => false
  });
  const appEl = makeEl('app');
  const tabsEl = makeEl('tabs');
  const toastEl = makeEl('toast');

  const document = {
    documentElement: { lang: lang === 'en' ? 'en' : 'zh-CN' },
    title: '',
    activeElement: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector(sel) {
      if (sel === '#app') return appEl;
      if (sel === '#tabs') return tabsEl;
      if (sel === '#toast') return toastEl;
      return null;
    },
    querySelectorAll: () => [],
    getElementById: id => ({ app: appEl, tabs: tabsEl, toast: toastEl }[id] || null)
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

  const ctx = vm.createContext({
    window,
    document,
    localStorage,
    navigator: { userAgent: 'node-test', languages: [lang === 'en' ? 'en-US' : 'zh-CN'] },
    location: { href: 'http://127.0.0.1:8080/', hostname: '127.0.0.1', search: `?lang=${lang}` },
    URL, Date, Math, JSON, Object, Array, Set, Map, Promise, Number, String, Boolean, RegExp, Error,
    AbortController, encodeURIComponent, decodeURIComponent, isNaN, parseFloat, parseInt, console, setTimeout, clearTimeout
  });

  vm.runInContext(script, ctx);

  return {
    ctx,
    appEl,
    storeData,
    async waitReady() {
      for (let i = 0; i < 30; i++) {
        if (vm.runInContext('S.ready', ctx)) return;
        await new Promise(r => setTimeout(r, 5));
      }
      throw new Error('App did not become ready');
    },
    async triggerChange(target) {
      for (const fn of listeners.change || []) await fn({ target });
      await new Promise(r => setTimeout(r, 15));
    }
  };
}

test('roundMacro / fmtMacro format kcal as integers and macros to max 1 decimal without trailing .0', async () => {
  const profile = {
    sex: 'm', age: 29, height: 176, weight: 72, bf: 15, steps: 9500,
    exp: 'mid', stage: 'cut', trainDays: [1, 3, 5], slot: 'eve', equipment: 'gym',
    injuries: [], supps: [], startDate: '2026-11-01'
  };
  const app = mountApp({ lang: 'en', profile });
  await app.waitReady();

  const results = vm.runInContext(`({
    kcalInt: fmtMacro("kcal", 540),
    kcalRoundDown: fmtMacro("kcal", 1480.4),
    kcalRoundUp: fmtMacro("kcal", 1480.6),
    kcalZero: fmtMacro("kcal", 0),
    kcalNeg: fmtMacro("kcal", -50),
    kcalEmpty: fmtMacro("kcal", ""),
    kcalNull: fmtMacro("kcal", null),
    kcalBad: fmtMacro("kcal", "oops"),
    pDec: fmtMacro("protein", 46.5),
    pRound: fmtMacro("protein", 46.54),
    pRoundUp: fmtMacro("protein", 46.56),
    cDropZero: fmtMacro("carbs", 54.0),
    cDropStrZero: fmtMacro("carbs", "54.00"),
    fDec: fmtMacro("fat", 14.23),
    fZero: fmtMacro("fat", 0)
  })`, app.ctx);

  assert.deepEqual({ ...results }, {
    kcalInt: '540',
    kcalRoundDown: '1480',
    kcalRoundUp: '1481',
    kcalZero: '0',
    kcalNeg: '0',
    kcalEmpty: '',
    kcalNull: '',
    kcalBad: '',
    pDec: '46.5',
    pRound: '46.5',
    pRoundUp: '46.6',
    cDropZero: '54',
    cDropStrZero: '54',
    fDec: '14.2',
    fZero: '0'
  });
});

test('mealCard, manual entry, editing decimals, and display-only rounding on dayMacros/macroBars/dayRow', async () => {
  const profile = {
    sex: 'm', age: 29, height: 176, weight: 72, bf: 15, steps: 9500,
    exp: 'mid', stage: 'cut', trainDays: [1, 3, 5], slot: 'eve', equipment: 'gym',
    injuries: [], supps: [], startDate: '2026-11-01'
  };
  const app = mountApp({ lang: 'en', profile });
  await app.waitReady();
  const td = vm.runInContext('todayStr()', app.ctx);

  // Seed two meals with stored precision (including 52.52 + 52.52 = 105.04 > 105% of 100g target,
  // and 14.1 + 42.2 = 56.300000000000004 in IEEE 754)
  await vm.runInContext(`updateDay(${JSON.stringify(td)}, day => {
    day.meals = [
      { id: "m1", type: "午餐", time: "12:30", text: "Chicken bowl", est: { kcal: 540.4, protein: 52.52, carbs: 54.0, fat: 14.1, by: "server" } },
      { id: "m2", type: "晚餐", time: "19:00", text: "Beef bowl", est: { kcal: 1480.4, protein: 52.52, carbs: 158.0, fat: 42.2, by: "manual" } }
    ];
  }, { quiet: true })`, app.ctx);
  vm.runInContext('S.tab = "food"; S.mealMode = "manual"; render();', app.ctx);

  const html = app.appEl.innerHTML;
  // Both manual entry and meal cards use .macro-grid with explicit kcal / g units
  assert.ok((html.match(/class="macro-grid"/g) || []).length === 3, 'expected 3 macro grids (manual + 2 logged meals)');
  assert.match(html, /id="me-m1-kcal"[^>]*step="1"[^>]*value="540"/);
  assert.match(html, /id="me-m1-protein"[^>]*step="0\.1"[^>]*value="52\.5"/);
  assert.match(html, /id="me-m1-carbs"[^>]*step="0\.1"[^>]*value="54"/);
  assert.match(html, /id="me-m1-fat"[^>]*step="0\.1"[^>]*value="14\.1"/);
  assert.match(html, /id="me-m2-kcal"[^>]*value="1480"/);
  assert.match(html, /id="mf-kcal"[^>]*data-mf="kcal"[^>]*step="1"/);
  assert.match(html, /id="mf-protein"[^>]*data-mf="protein"[^>]*step="0\.1"/);
  assert.match(html, /<span class="mf-unit">kcal<\/span>/);
  assert.match(html, /<span class="mf-unit">g<\/span>/);

  // Stored meal values retain original precision until edited
  assert.equal(vm.runInContext(`S.days[${JSON.stringify(td)}].meals[0].est.kcal`, app.ctx), 540.4);
  assert.equal(vm.runInContext(`S.days[${JSON.stringify(td)}].meals[0].est.protein`, app.ctx), 52.52);

  // dayMacros keeps unrounded sums for calculations, insights, warnings, and AI digest
  const totals = vm.runInContext(`dayMacros(${JSON.stringify(td)})`, app.ctx);
  assert.ok(Math.abs(totals.kcal - 2020.8) < 1e-9, `expected unrounded kcal 2020.8, got ${totals.kcal}`);
  assert.ok(Math.abs(totals.protein - 105.04) < 1e-9, `expected unrounded protein 105.04, got ${totals.protein}`);
  assert.equal(totals.carbs, 212);
  assert.ok(Math.abs(totals.fat - 56.3) < 1e-9, `expected unrounded fat ~56.3, got ${totals.fat}`);

  // macroBars evaluates the 105% over-target warning on unrounded 105.04 > 105 while displaying 105 / 100 g
  const barsHtml = vm.runInContext(`macroBars({ kcal: 2000, protein: 100, carbs: 200, fat: 50 }, dayMacros(${JSON.stringify(td)}))`, app.ctx);
  assert.match(barsHtml, /<span class="macro-lbl">Protein<\/span><div class="bar"><i class="over"/);
  assert.match(barsHtml, /class="num macro-val">2021 \/ 2000 kcal<\/span>/);
  assert.match(barsHtml, /class="num macro-val">105 \/ 100 g<\/span>/);
  assert.match(barsHtml, /class="num macro-val">56\.3 \/ 50 g<\/span>/);
  assert.doesNotMatch(barsHtml, /56\.3000/);

  // dayRow also formats at the display boundary without floating-point noise
  const rowHtml = vm.runInContext(`dayRow(S.days[${JSON.stringify(td)}])`, app.ctx);
  assert.match(rowHtml, /2021 kcal/);
  assert.match(rowHtml, /P 105 g/);
  assert.doesNotMatch(rowHtml, /105\.04|2020\.8/);

  // Editing logged meal macros preserves 1 decimal for protein/carbs/fat and rounds kcal to integer
  const pInput = { dataset: { meal: 'm1', k: 'protein' }, value: '48.74' };
  await app.triggerChange(pInput);
  assert.equal(pInput.value, '48.7');
  assert.equal(vm.runInContext(`S.days[${JSON.stringify(td)}].meals[0].est.protein`, app.ctx), 48.7);

  const cInput = { dataset: { meal: 'm1', k: 'carbs' }, value: '60.0' };
  await app.triggerChange(cInput);
  assert.equal(cInput.value, '60');
  assert.equal(vm.runInContext(`S.days[${JSON.stringify(td)}].meals[0].est.carbs`, app.ctx), 60);

  const kInput = { dataset: { meal: 'm1', k: 'kcal' }, value: '1250.6' };
  await app.triggerChange(kInput);
  assert.equal(kInput.value, '1251');
  assert.equal(vm.runInContext(`S.days[${JSON.stringify(td)}].meals[0].est.kcal`, app.ctx), 1251);

  const fInput = { dataset: { meal: 'm1', k: 'fat' }, value: '' };
  await app.triggerChange(fInput);
  assert.equal(fInput.value, '');
  assert.equal(vm.runInContext(`S.days[${JSON.stringify(td)}].meals[0].est.fat`, app.ctx), null);
});

function resolvePlaywright() {
  const candidates = ['playwright'];
  const home = os.homedir();
  for (const rel of [
    '.claude/skills/gstack/node_modules/playwright',
    '.agents/skills/gstack/node_modules/playwright'
  ]) {
    candidates.push(path.join(home, rel));
  }
  const npxDir = path.join(home, '.npm', '_npx');
  if (fs.existsSync(npxDir)) {
    for (const entry of fs.readdirSync(npxDir)) {
      candidates.push(path.join(npxDir, entry, 'node_modules', 'playwright'));
    }
  }
  for (const spec of candidates) {
    try {
      const pw = require(spec);
      const execPath = process.env.CHROMIUM_PATH
        || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium'
          : fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome'
            : pw.chromium.executablePath());
      if (execPath && fs.existsSync(execPath)) {
        return { chromium: pw.chromium, executablePath: execPath };
      }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-meal-macros-test-'));
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

test('headless Chromium: meal macro inputs and daily totals are untruncated and aligned at 320, 375, 430px in zh and en', async t => {
  const pw = resolvePlaywright();
  if (!pw) {
    t.skip('Playwright/Chromium not installed in this environment');
    return;
  }

  const srv = await startTestServer(t);
  const issued = spawnSync(process.execPath, ['scripts/auth-admin.js', 'invite', 'macros@example.com'], {
    cwd: ROOT, env: srv.env, encoding: 'utf8', timeout: 5000
  });
  assert.equal(issued.status, 0, issued.stderr);
  const invite = JSON.parse(issued.stdout);
  const pwStr = 'macros-strong-password-123';

  const browser = await pw.chromium.launch({
    executablePath: pw.executablePath,
    headless: true,
    args: ['--no-sandbox']
  });
  t.after(async () => { await browser.close(); });

  let storageState;
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(`${srv.base}/login.html?invite=${encodeURIComponent(invite.token)}&email=${encodeURIComponent(invite.email)}`);
    await page.locator('#n').fill('Macros Tester');
    await page.locator('#p').fill(pwStr);
    await page.locator('#c-terms').check();
    await page.locator('#c-sensitive').check();
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
    await page.locator('#f-bf').fill('15');
    await page.locator('button[type="submit"]').click();
    await page.locator('nav#tabs').waitFor({ state: 'visible' });

    await page.evaluate(async () => {
      const td = todayStr();
      await updateDay(td, day => {
        day.meals = [
          {
            id: 'm-bowl',
            type: '午餐',
            time: '21:26',
            text: 'Grilled chicken breast bowl with brown rice, broccoli, and soft-boiled egg',
            est: { kcal: 540.4, protein: 44.54, carbs: 54.0, fat: 14.23, by: 'server', tip: 'Strong protein hit.', confidence: 'High' }
          },
          {
            id: 'm-4digit',
            type: '晚餐',
            time: '19:15',
            text: 'Post-workout feast',
            est: { kcal: 1480.4, protein: 112.5, carbs: 158.6, fat: 42.0, by: 'manual' }
          }
        ];
      }, { quiet: true });
    });
    storageState = await ctx.storageState();
    await ctx.close();
  }

  for (const width of [320, 375, 430]) {
    for (const lang of ['zh', 'en']) {
      const ctx = await browser.newContext({
        storageState,
        viewport: { width, height: 900 },
        locale: lang === 'en' ? 'en-US' : 'zh-CN'
      });
      const page = await ctx.newPage();
      try {
        await page.goto(`${srv.base}/?lang=${lang}`);
        await page.locator('nav#tabs').waitFor({ state: 'visible' });
        await page.evaluate(async l => {
          await setLang(l, { persistProfile: false });
          S.tab = 'food';
          S.mealMode = 'manual';
          S.mfill = { kcal: '2450', protein: '146.5', carbs: '285.4', fat: '68.5' };
          render();
        }, lang);
        await page.locator('.meal').first().waitFor({ state: 'visible' });

        const metrics = await page.evaluate(() => {
          const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          const canvas = document.createElement('canvas');
          const c2d = canvas.getContext('2d');
          const inputs = [...document.querySelectorAll('.macro-grid input')].map(inp => {
            const st = getComputedStyle(inp);
            c2d.font = `${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
            const textW = c2d.measureText(inp.value).width;
            const rect = inp.getBoundingClientRect();
            const box = inp.closest('.mf-box').getBoundingClientRect();
            const lbl = inp.closest('.macro-field').querySelector('.mf-lbl').getBoundingClientRect();
            const unit = inp.closest('.mf-box').querySelector('.mf-unit').getBoundingClientRect();
            return {
              id: inp.id,
              value: inp.value,
              clientW: inp.clientWidth,
              scrollW: inp.scrollWidth,
              textW,
              fits: textW <= inp.clientWidth - 2 && inp.scrollWidth <= inp.clientWidth + 1,
              boxH: box.height,
              lblAligned: Math.abs(lbl.left - box.left) <= 1.5,
              unitNoOverlap: rect.right <= unit.left + 1
            };
          });
          const gridsAligned = [...document.querySelectorAll('.macro-grid')].every(g => {
            const b = [...g.querySelectorAll('.mf-box')].map(x => x.getBoundingClientRect());
            return b.length === 4 && Math.abs(b[0].top - b[1].top) <= 1 && Math.abs(b[2].top - b[3].top) <= 1;
          });
          const bars = [...document.querySelectorAll('.macro-bars .bar')].map(b => b.getBoundingClientRect());
          const barsAligned = bars.length === 4 && bars.every(b =>
            Math.abs(b.left - bars[0].left) <= 1 && Math.abs(b.right - bars[0].right) <= 1 && b.width >= 40
          );
          const headersOneLine = [...document.querySelectorAll('.meal-top')].every(row => {
            const sel = row.querySelector('select').getBoundingClientRect();
            const tm = row.querySelector('.meal-time').getBoundingClientRect();
            return Math.abs((sel.top + sel.height / 2) - (tm.top + tm.height / 2)) <= 4 && sel.right <= tm.left + 1;
          });
          return { docOverflow, inputs, gridsAligned, barsAligned, headersOneLine };
        });

        assert.ok(metrics.docOverflow <= 0, `${width}px ${lang}: unexpected horizontal overflow ${metrics.docOverflow}px`);
        assert.equal(metrics.inputs.length, 12, `${width}px ${lang}: expected 12 macro inputs`);
        for (const inp of metrics.inputs) {
          assert.equal(inp.fits, true, `${width}px ${lang} ${inp.id} (${inp.value}) truncated: textW=${inp.textW}, clientW=${inp.clientW}, scrollW=${inp.scrollW}`);
          assert.equal(inp.lblAligned, true, `${width}px ${lang} ${inp.id} label misaligned`);
          assert.equal(inp.unitNoOverlap, true, `${width}px ${lang} ${inp.id} unit overlaps input`);
          assert.ok(inp.boxH >= 44, `${width}px ${lang} ${inp.id} tap target height ${inp.boxH} < 44`);
        }
        assert.equal(metrics.gridsAligned, true, `${width}px ${lang}: macro grid rows misaligned`);
        assert.equal(metrics.barsAligned, true, `${width}px ${lang}: daily macro bars misaligned`);
        assert.equal(metrics.headersOneLine, true, `${width}px ${lang}: meal card header wrapped`);
      } finally {
        await ctx.close();
      }
    }
  }

  // Verify stored vs displayed values and sequential keystroke decimal entry ('46.' then '5') + real blur
  const editCtx = await browser.newContext({ storageState, viewport: { width: 375, height: 844 }, locale: 'en-US' });
  const editPage = await editCtx.newPage();
  try {
    await editPage.goto(`${srv.base}/?lang=en`);
    await editPage.locator('nav#tabs').waitFor({ state: 'visible' });
    await editPage.locator('nav#tabs [data-act="tab"][data-v="food"]').click();

    // Unrounded stored meal values vs rounded displayed inputs & daily totals
    const initial = await editPage.evaluate(() => {
      const m = S.days[todayStr()].meals.find(x => x.id === 'm-bowl');
      const totals = dayMacros(todayStr());
      return {
        stored: { kcal: m.est.kcal, protein: m.est.protein, carbs: m.est.carbs, fat: m.est.fat },
        displayed: {
          kcal: document.getElementById('me-m-bowl-kcal').value,
          protein: document.getElementById('me-m-bowl-protein').value,
          carbs: document.getElementById('me-m-bowl-carbs').value,
          fat: document.getElementById('me-m-bowl-fat').value
        },
        rawTotals: { kcal: totals.kcal, protein: totals.protein, fat: totals.fat },
        barsText: document.querySelector('.macro-bars').textContent
      };
    });
    assert.deepEqual(initial.stored, { kcal: 540.4, protein: 44.54, carbs: 54, fat: 14.23 });
    assert.deepEqual(initial.displayed, { kcal: '540', protein: '44.5', carbs: '54', fat: '14.2' });
    assert.ok(Math.abs(initial.rawTotals.kcal - 2020.8) < 1e-9);
    assert.ok(Math.abs(initial.rawTotals.protein - 157.04) < 1e-9);
    assert.ok(Math.abs(initial.rawTotals.fat - 56.23) < 1e-9);
    assert.match(initial.barsText, /2021 \/ \d+ kcal/);
    assert.match(initial.barsText, /157 \/ \d+ g/);
    assert.match(initial.barsText, /56\.2 \/ \d+ g/);

    // Sequential real keystrokes: clear, type '46.' -> focus stays, storage untouched until blur
    const pField = editPage.locator('#me-m-bowl-protein');
    await pField.click();
    for (let i = 0; i < 6; i++) await editPage.keyboard.press('ArrowRight');
    for (let i = 0; i < 6; i++) await editPage.keyboard.press('Backspace');
    await editPage.keyboard.type('46.');

    const midEdit = await editPage.evaluate(() => ({
      activeId: document.activeElement?.id,
      storedProtein: S.days[todayStr()].meals.find(x => x.id === 'm-bowl').est.protein
    }));
    assert.equal(midEdit.activeId, 'me-m-bowl-protein', 'typing trailing decimal must keep focus on input');
    assert.equal(midEdit.storedProtein, 44.54, 'typing "46." must leave stored value untouched before blur');

    // Finish typing '5' and blur by clicking outside the input
    await editPage.keyboard.type('5');
    await editPage.locator('h2').first().click();

    await editPage.waitForFunction(() => S.days[todayStr()]?.meals?.find(m => m.id === 'm-bowl')?.est?.protein === 46.5);
    assert.equal(await pField.inputValue(), '46.5');
    const afterDecimal = await editPage.evaluate(() => ({
      storedProtein: S.days[todayStr()].meals.find(x => x.id === 'm-bowl').est.protein,
      rawTotalProtein: dayMacros(todayStr()).protein,
      barsText: document.querySelector('.macro-bars').textContent
    }));
    assert.equal(afterDecimal.storedProtein, 46.5);
    assert.equal(afterDecimal.rawTotalProtein, 159);
    assert.match(afterDecimal.barsText, /159 \/ \d+ g/);

    // Type '50.0' with real keystrokes and blur -> drops trailing .0 in both stored and displayed value
    await pField.click();
    for (let i = 0; i < 6; i++) await editPage.keyboard.press('ArrowRight');
    for (let i = 0; i < 6; i++) await editPage.keyboard.press('Backspace');
    await editPage.keyboard.type('50.0');
    await editPage.locator('h2').first().click();
    await editPage.waitForFunction(() => S.days[todayStr()]?.meals?.find(m => m.id === 'm-bowl')?.est?.protein === 50);
    assert.equal(await pField.inputValue(), '50');
    const afterTrailingZero = await editPage.evaluate(() => document.querySelector('.macro-bars').textContent);
    assert.match(afterTrailingZero, /162\.5 \/ \d+ g/);
  } finally {
    await editCtx.close();
  }
});
