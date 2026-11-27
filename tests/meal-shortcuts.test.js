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
const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;

function extractInlineScript(html) {
  const matches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const inline = matches.find(m => !/\bsrc\s*=/i.test(m[1]));
  assert.ok(inline, 'expected inline <script> block');
  return inline[2];
}

function mountApp({ lang = 'zh', days = {}, profile = null, fixedIso = '2026-11-20T12:30:00', onCommit = null } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const script = extractInlineScript(html).split('/* ============ 启动 ============ */')[0];

  const RealDate = Date;
  const fixedMs = RealDate.parse(fixedIso);
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedMs);
      else super(...args);
    }
    static now() { return fixedMs; }
    static parse(s) { return RealDate.parse(s); }
    static UTC(...args) { return RealDate.UTC(...args); }
  }

  const storage = new Map([['bj-lang', lang]]);
  const localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: k => { storage.delete(k); },
    get length() { return storage.size; },
    key: i => [...storage.keys()][i] ?? null
  };

  const storeData = new Map();
  const baseProfile = profile || {
    sex: 'm', age: 29, height: 176, weight: 72, bf: 15, steps: 9500,
    exp: 'mid', stage: 'cut', trainDays: [1, 3, 5], slot: 'eve', equipment: 'gym',
    injuries: [], supps: ['creatine'], startDate: '2026-11-01', lang
  };
  storeData.set('app/profile', JSON.parse(JSON.stringify(baseProfile)));
  for (const [d, val] of Object.entries(days)) {
    storeData.set(`days/${d}`, JSON.parse(JSON.stringify(val)));
  }

  const deletedAssets = [];
  const listeners = {};
  const mTextEl = { id: 'm-text', value: '' };
  const appEl = {
    id: 'app',
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      const tm = this._html.match(/<textarea\b[^>]*id="m-text"[^>]*>([\s\S]*?)<\/textarea>/);
      if (tm) {
        mTextEl.value = tm[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      }
    },
    contains: () => false
  };
  const tabsEl = { id: 'tabs', innerHTML: '', hidden: true, setAttribute() {} };
  const toastEl = { id: 'toast', innerHTML: '', textContent: '', hidden: true };
  const srEl = { id: 'sr-status', textContent: '' };
  const shortcutsEl = { id: 'meal-shortcuts', innerHTML: '' };
  let checkedMtype = null;

  const document = {
    documentElement: { lang: lang === 'en' ? 'en' : 'zh-CN' },
    title: '',
    activeElement: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector(sel) {
      if (sel === '#app') return appEl;
      if (sel === '#tabs') return tabsEl;
      if (sel === '#toast') return toastEl;
      if (sel === '#sr-status') return srEl;
      if (sel === '#m-text') return mTextEl;
      if (sel === 'input[name="mtype"]:checked') return checkedMtype ? { value: checkedMtype } : null;
      return null;
    },
    querySelectorAll() { return []; },
    getElementById(id) {
      if (id === 'meal-shortcuts') return appEl.innerHTML.includes('id="meal-shortcuts"') ? shortcutsEl : null;
      if (id === 'm-text') return mTextEl;
      if (id === 'sr-status') return srEl;
      return null;
    }
  };

  const store = {
    async get(p) { return storeData.has(p) ? JSON.parse(JSON.stringify(storeData.get(p))) : null; },
    async set(p, d) { storeData.set(p, JSON.parse(JSON.stringify(d))); },
    async commit(changes) {
      if (onCommit) await onCommit(changes);
      for (const c of changes) {
        if (c.after !== undefined) storeData.set(c.path, JSON.parse(JSON.stringify(c.after)));
      }
    }
  };
  const assets = {
    async delete(id) { deletedAssets.push(id); }
  };

  const ctx = vm.createContext({
    window: { scrollTo() {}, ritual: { hosted: true } },
    document,
    localStorage,
    navigator: { userAgent: 'node-test', languages: [lang === 'en' ? 'en-US' : 'zh-CN'] },
    location: { href: 'http://127.0.0.1/', hostname: '127.0.0.1', search: `?lang=${lang}` },
    URL,
    Date: MockDate,
    Math,
    JSON,
    Object,
    Array,
    Set,
    Map,
    Promise,
    Number,
    String,
    Boolean,
    RegExp,
    Error,
    encodeURIComponent,
    decodeURIComponent,
    isNaN,
    parseFloat,
    parseInt,
    console,
    setTimeout,
    clearTimeout
  });

  vm.runInContext(script, ctx);
  ctx._initProfile = baseProfile;
  ctx._initDays = days;
  ctx._store = store;
  ctx._assets = assets;
  vm.runInContext(`
    storageUser = "u1";
    S.uid = "u1";
    S.cloud = true;
    S.store = _store;
    S.assets = _assets;
    S.profile = clone(_initProfile);
    S.days = clone(_initDays);
    S.tab = "food";
    S.date = todayStr();
    S.ready = true;
    render();
  `, ctx);

  return {
    ctx,
    appEl,
    toastEl,
    mTextEl,
    shortcutsEl,
    deletedAssets,
    storeData,
    setCheckedMtype(v) { checkedMtype = v; },
    async click(act, v) {
      const btn = {
        dataset: { act, ...(v !== undefined ? { v: String(v) } : {}) },
        disabled: false,
        closest(sel) { return sel === '[data-act]' ? btn : null; }
      };
      for (const fn of listeners.click || []) await fn({ target: btn });
    },
    async changeMtype(v) {
      checkedMtype = v;
      for (const fn of listeners.change || []) await fn({ target: { name: 'mtype', value: v, dataset: {} } });
    }
  };
}

test('meal shortcuts: renders nothing when 0 eligible past meals and ignores pending, failed, invalid, and blank entries', () => {
  const emptyApp = mountApp({ days: {} });
  assert.doesNotMatch(emptyApp.appEl.innerHTML, /id="meal-shortcuts"/);
  assert.doesNotMatch(emptyApp.appEl.innerHTML, /常用餐食/);
  assert.equal(vm.runInContext('recentMealShortcuts("午餐").length', emptyApp.ctx), 0);

  const noisyApp = mountApp({
    days: {
      '2026-11-18': {
        date: '2026-11-18',
        meals: [
          { id: 'm-pending', type: '午餐', text: 'Pending meal', time: '12:00', visionReq: { status: 'pending', at: '2026-11-20T12:00:00Z' }, est: { kcal: 500, protein: 30, carbs: 50, fat: 15 } },
          { id: 'm-failed-req', type: '午餐', text: 'Failed req', time: '12:05', visionReq: { status: 'failed' }, est: { kcal: 500, protein: 30, carbs: 50, fat: 15 } },
          { id: 'm-null-est', type: '午餐', text: 'No estimate yet', time: '12:10', est: null },
          { id: 'm-err-est', type: '午餐', text: 'Failed estimate', time: '12:12', est: { kcal: 400, protein: 30, carbs: 40, fat: 10, failed: true } },
          { id: 'm-nan', type: '午餐', text: 'Corrupt NaN', time: '12:15', est: { kcal: 'NaN', protein: 30, carbs: 40, fat: 10 } },
          { id: 'm-inf', type: '午餐', text: 'Corrupt Inf', time: '12:16', est: { kcal: 400, protein: Infinity, carbs: 40, fat: 10 } },
          { id: 'm-neg', type: '午餐', text: 'Negative macro', time: '12:17', est: { kcal: 400, protein: -5, carbs: 40, fat: 10 } },
          { id: 'm-partial', type: '午餐', text: 'Partial macros', time: '12:18', est: { kcal: 400, protein: 30, carbs: null, fat: null } },
          { id: 'm-zero', type: '午餐', text: 'All zeros', time: '12:19', est: { kcal: 0, protein: 0, carbs: 0, fat: 0 } },
          { id: 'm-blank', type: '午餐', text: '   ', time: '12:20', est: { kcal: 400, protein: 30, carbs: 40, fat: 10 } }
        ]
      }
    }
  });
  assert.equal(vm.runInContext('recentMealShortcuts("午餐").length', noisyApp.ctx), 0);
  assert.doesNotMatch(noisyApp.appEl.innerHTML, /id="meal-shortcuts"/);
});

test('meal shortcuts: deduplicates normalized titles + rounded macros, ranks matching mealType + frequency + recency, caps at 6', async () => {
  const days = {
    '2026-11-10': {
      date: '2026-11-10',
      meals: [
        { id: 'a1', type: '早餐', text: '  Oats  + Eggs ', time: '08:00', est: { kcal: 500.4, protein: 35.04, carbs: 55.0, fat: 15.0 } },
        { id: 'b1', type: '午餐', text: 'Chicken rice', time: '12:30', est: { kcal: 680, protein: 48, carbs: 72, fat: 18 } },
        { id: 'd1', type: '晚餐', text: 'Salmon bowl', time: '19:00', est: { kcal: 610, protein: 42, carbs: 58, fat: 20 } }
      ]
    },
    '2026-11-11': {
      date: '2026-11-11',
      meals: [
        { id: 'a2', type: '早餐', text: 'oats + eggs', time: '08:15', est: { kcal: 499.6, protein: 34.96, carbs: 55.0, fat: 15.0 } },
        { id: 'b2', type: '午餐', text: 'Chicken rice', time: '12:35', est: { kcal: 680, protein: 48, carbs: 72, fat: 18 } }
      ]
    },
    '2026-11-12': {
      date: '2026-11-12',
      meals: [
        { id: 'b3', type: '午餐', text: 'Chicken rice', time: '12:30', est: { kcal: 680, protein: 48, carbs: 72, fat: 18 } },
        { id: 's1', type: '加餐', text: 'Whey shake', time: '15:30', est: { kcal: 120, protein: 25, carbs: 2, fat: 0 } },
        { id: 'd2', type: '晚餐', text: 'Steak + potato', time: '19:10', est: { kcal: 700, protein: 50, carbs: 60, fat: 25 } }
      ]
    },
    '2026-11-15': {
      date: '2026-11-15',
      meals: [
        { id: 'l2', type: '午餐', text: 'Beef noodles', time: '12:20', est: { kcal: 640, protein: 40, carbs: 75, fat: 16 } },
        { id: 'd3', type: '晚餐', text: 'Shrimp salad', time: '19:00', est: { kcal: 430, protein: 38, carbs: 30, fat: 14 } }
      ]
    },
    '2026-11-19': {
      date: '2026-11-19',
      meals: [
        { id: 'a3', type: '早餐', text: 'Oats + Eggs', time: '08:10', est: { kcal: 500, protein: 35, carbs: 55, fat: 15 } },
        { id: 'd4', type: '晚餐', text: 'Tofu stir-fry', time: '19:00', est: { kcal: 480, protein: 32, carbs: 45, fat: 16 } },
        { id: 's2', type: '加餐', text: 'Greek yogurt', time: '16:00', est: { kcal: 180, protein: 18, carbs: 14, fat: 4 } }
      ]
    }
  };

  const app = mountApp({ lang: 'zh', days });
  // Default mealType at 12:30 is 午餐
  const lunchList = JSON.parse(vm.runInContext('JSON.stringify(recentMealShortcuts("午餐"))', app.ctx));
  assert.equal(lunchList.length, 6, 'surfaces at most 6 shortcuts');
  assert.equal(lunchList[0].text, 'Chicken rice', 'most frequent matching lunch ranks #1');
  assert.equal(lunchList[0].count, 3);
  assert.equal(lunchList[1].text, 'Beef noodles', 'other matching lunch ranks #2 ahead of non-lunch meals');
  // Oats + Eggs deduplicated across 3 casing/rounding variants into 1 entry with count 3
  const oatsEntry = lunchList.find(x => x.text === 'Oats + Eggs');
  assert.ok(oatsEntry, 'Oats + Eggs deduplicated with latest casing');
  assert.equal(oatsEntry.count, 3);

  // Switching selected mealType to 早餐 prioritizes Oats + Eggs first
  const breakfastList = JSON.parse(vm.runInContext('JSON.stringify(recentMealShortcuts("早餐"))', app.ctx));
  assert.equal(breakfastList[0].text, 'Oats + Eggs', 'matching breakfast meal ranks #1 when breakfast selected');

  // Switching mtype radio updates #meal-shortcuts in-place
  app.mTextEl.value = 'Draft note';
  await app.changeMtype('早餐');
  assert.match(app.shortcutsEl.innerHTML, /Oats \+ Eggs/, 'mtype change refreshes shortcuts');
  assert.equal(app.mTextEl.value, 'Draft note', 'mtype change preserves #m-text input');
  assert.equal(vm.runInContext('S.mealShortcuts[0].text', app.ctx), 'Oats + Eggs');
});

test('meal shortcuts: 1-tap adds clean standalone manual meal to viewed day and NEVER copies photo blob fields', async () => {
  const histDate = '2026-11-18';
  const viewDate = '2026-11-19';
  const days = {
    [histDate]: {
      date: histDate,
      meals: [
        {
          id: 'hist-photo-meal',
          type: '午餐',
          text: '鸡胸肉糙米饭',
          time: '12:15',
          photo: 'blob_secret_orig_1',
          photoId: 'pid_legacy_1',
          thumb: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
          more: [{ id: 'blob_extra_leftover_2', tag: '剩下', at: '2026-11-18T12:45:00Z' }],
          est: { kcal: 620, protein: 46.5, carbs: 64.2, fat: 14.8, by: 'server', photoUsed: true }
        }
      ]
    },
    [viewDate]: { date: viewDate, meals: [] }
  };

  const app = mountApp({ lang: 'zh', days });
  vm.runInContext(`S.date = ${JSON.stringify(viewDate)}; render();`, app.ctx);
  app.setCheckedMtype('晚餐');

  await app.click('quick-meal', '0');

  const meals = JSON.parse(vm.runInContext(`JSON.stringify(S.days[${JSON.stringify(viewDate)}].meals)`, app.ctx));
  assert.equal(meals.length, 1);
  const added = meals[0];
  assert.notEqual(added.id, 'hist-photo-meal');
  assert.equal(added.type, '晚餐', 'uses currently selected mealType');
  assert.equal(added.text, '鸡胸肉糙米饭');
  assert.equal(added.photo, null, 'photo must be null');
  assert.equal('photoId' in added, false, 'must NOT copy photoId');
  assert.equal('thumb' in added, false, 'must NOT copy thumb');
  assert.equal('more' in added, false, 'must NOT copy more photos');
  assert.equal('photoErr' in added, false);
  assert.equal('visionReq' in added, false);
  assert.equal(added.est.kcal, 620);
  assert.equal(added.est.protein, 46.5);
  assert.equal(added.est.carbs, 64.2);
  assert.equal(added.est.fat, 14.8);
  assert.equal(added.est.by, 'manual');
  assert.equal(app.toastEl.textContent, '已添加「鸡胸肉糙米饭」');
  assert.equal(app.toastEl.hidden, false);

  // Deleting the newly logged meal MUST NOT delete the historical meal's blobs
  await app.click('del-meal', added.id); // first tap -> confirm
  await app.click('del-meal', added.id); // second tap -> delete
  assert.deepEqual(app.deletedAssets, [], 'deleting copied meal must purge ZERO server blobs');

  // Historical meal photo and extra photo remain completely intact
  const histMeal = JSON.parse(vm.runInContext(`JSON.stringify(S.days[${JSON.stringify(histDate)}].meals[0])`, app.ctx));
  assert.equal(histMeal.photo, 'blob_secret_orig_1');
  assert.equal(histMeal.more[0].id, 'blob_extra_leftover_2');

  // Re-add on viewDate, then delete historical meal -> copied meal stays intact
  await app.click('quick-meal', '0');
  vm.runInContext(`S.date = ${JSON.stringify(histDate)}; render();`, app.ctx);
  await app.click('del-meal', 'hist-photo-meal');
  await app.click('del-meal', 'hist-photo-meal');
  assert.deepEqual(app.deletedAssets, ['blob_secret_orig_1', 'blob_extra_leftover_2']);
  const surviving = JSON.parse(vm.runInContext(`JSON.stringify(S.days[${JSON.stringify(viewDate)}].meals)`, app.ctx));
  assert.equal(surviving.length, 1);
  assert.equal(surviving[0].text, '鸡胸肉糙米饭');
  assert.equal(surviving[0].photo, null);
});

test('meal shortcuts: HTML-escapes hostile meal names, enforces WCAG 2.5.3 aria-label prefix, and localizes cleanly in en', async () => {
  const hostile = '<img src=x onerror="alert(1)"> & "bowl"';
  const days = {
    '2026-11-18': {
      date: '2026-11-18',
      meals: [
        { id: 'h1', type: '午餐', text: hostile, time: '12:00', est: { kcal: 540, protein: 40, carbs: 50, fat: 15, by: 'manual' } },
        { id: 'h2', type: '午餐', text: hostile, time: '13:00', est: { kcal: 540, protein: 30, carbs: 60, fat: 15, by: 'manual' } }
      ]
    }
  };

  const enApp = mountApp({ lang: 'en', days });
  const html = enApp.appEl.innerHTML;
  assert.doesNotMatch(html, /<img\b/i, 'hostile HTML tag must be escaped');
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; &quot;bowl&quot;/, 'hostile meal name escaped once');
  assert.doesNotMatch(html, /&amp;amp;|&amp;quot;/, 'must not double-escape');
  assert.match(html, /Quick-add meals/);

  const shortcutSection = html.match(/<div class="meal-shortcuts"[\s\S]*?<\/div>\s*<\/div>/)[0];
  assert.equal(CJK_RE.test(shortcutSection), false, `English shortcuts must contain zero CJK: ${shortcutSection}`);

  // Extract all shortcut buttons and verify type="button", unique aria-labels, and WCAG 2.5.3 visible-text prefix
  const btns = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(m => m[1].includes('data-act="quick-meal"'));
  assert.equal(btns.length, 2, 'same title with different protein/carbs yields 2 distinct shortcuts');
  const labels = new Set();
  for (const [, attrs, inner] of btns) {
    assert.match(attrs, /\btype="button"/, 'shortcut button must have type="button"');
    const aria = attrs.match(/\baria-label="([^"]+)"/)?.[1] || '';
    assert.ok(aria.length > 0);
    labels.add(aria);
    const visText = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    assert.ok(aria.startsWith(visText), `WCAG 2.5.3: aria-label "${aria}" must start with visible text "${visText}"`);
  }
  assert.equal(labels.size, 2, 'each shortcut button must have a unique aria-label');

  // Clicking in English mode produces English toast
  enApp.setCheckedMtype('午餐');
  await enApp.click('quick-meal', '0');
  assert.equal(enApp.toastEl.textContent, `Added "${hostile}"`);
});

test('meal shortcuts delayed-write regression: preserves edits typed while write is pending and never leaks drafts across dates', async () => {
  let releaseCommit = null;
  let commitCount = 0;
  const days = {
    '2026-11-18': {
      date: '2026-11-18',
      meals: [
        { id: 'h1', type: '午餐', text: '鸡胸肉米饭', time: '12:30', est: { kcal: 640, protein: 48, carbs: 70, fat: 16, by: 'manual' } }
      ]
    },
    '2026-11-19': { date: '2026-11-19', meals: [] },
    '2026-11-20': { date: '2026-11-20', meals: [] }
  };

  const app = mountApp({
    lang: 'zh',
    days,
    onCommit: () => {
      commitCount++;
      return new Promise(resolve => { releaseCommit = resolve; });
    }
  });

  // Scenario A: same date — overlapping double-tap + editing #m-text while write is pending
  app.mTextEl.value = 'Pre-tap draft';
  const tap1 = app.click('quick-meal', '0');
  // Wait microtasks until commit is in-flight
  for (let i = 0; i < 10 && !releaseCommit; i++) await Promise.resolve();
  assert.ok(releaseCommit, 'first shortcut tap entered async commit');

  // Overlapping second tap while first is in-flight must be ignored
  await app.click('quick-meal', '0');
  assert.equal(commitCount, 1, 'overlapping double-tap commits only once');

  // Edit draft while write is still pending (even without firing input/lsSet)
  app.mTextEl.value = 'Pre-tap draft + broccoli';

  const done1 = releaseCommit;
  releaseCommit = null;
  done1();
  await tap1;

  assert.equal(vm.runInContext('S.days["2026-11-20"].meals.length', app.ctx), 1, 'exactly one meal saved');
  assert.equal(app.mTextEl.value, 'Pre-tap draft + broccoli', 'latest edits typed while write was pending are preserved');

  // Scenario B: user switches dates while shortcut write is pending -> draft for new date is preserved & old date draft never leaks
  app.mTextEl.value = 'Day 20 draft';
  const tap2 = app.click('quick-meal', '0');
  for (let i = 0; i < 10 && !releaseCommit; i++) await Promise.resolve();
  assert.ok(releaseCommit, 'second shortcut tap entered async commit');

  // Navigate to previous day (2026-11-19) while 2026-11-20 write is still pending, and type a new draft there
  await app.click('date', '-1');
  assert.equal(vm.runInContext('S.date', app.ctx), '2026-11-19');
  app.mTextEl.value = 'Day 19 draft';

  const done2 = releaseCommit;
  releaseCommit = null;
  done2();
  await tap2;

  assert.equal(vm.runInContext('S.date', app.ctx), '2026-11-19', 'stays on switched date');
  assert.equal(app.mTextEl.value, 'Day 19 draft', 'switched date draft is preserved and never clobbered by prior date draft');
  assert.equal(vm.runInContext('S.days["2026-11-19"].meals.length', app.ctx), 0, 'meal was NOT written to switched date');
  assert.equal(vm.runInContext('S.days["2026-11-20"].meals.length', app.ctx), 2, 'meal was written to owning date 2026-11-20');
});

function resolvePlaywright() {
  const candidates = ['playwright'];
  const home = os.homedir();
  for (const rel of ['.claude/skills/gstack/node_modules/playwright', '.agents/skills/gstack/node_modules/playwright']) {
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
      if (execPath && fs.existsSync(execPath)) return { chromium: pw.chromium, executablePath: execPath };
    } catch {}
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

async function startTestServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-meal-sc-'));
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', AUTH_BASE_URL: base,
    AUTH_SECRET: crypto.randomBytes(32).toString('hex'), COOKIE_SECURE: '0',
    TRUST_PROXY: '0', MAIL_MODE: 'file', OPENROUTER_API_KEY: ''
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

test('headless Chromium: meal shortcuts 1-tap logging, 44x44 targets, light/dark + zh/en axe-core clean', async t => {
  const pw = resolvePlaywright();
  if (!pw) { t.skip('Playwright/Chromium not installed'); return; }

  const axeSource = fs.readFileSync(AXE_PATH, 'utf8');
  const srv = await startTestServer(t);
  const issued = spawnSync(process.execPath, ['scripts/auth-admin.js', 'invite', 'meals@example.com'], {
    cwd: ROOT, env: srv.env, encoding: 'utf8', timeout: 5000
  });
  assert.equal(issued.status, 0, issued.stderr);
  const invite = JSON.parse(issued.stdout);
  const pwStr = 'meals-strong-password-123';

  const browser = await pw.chromium.launch({ executablePath: pw.executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.goto(`${srv.base}/login.html?invite=${encodeURIComponent(invite.token)}&email=${encodeURIComponent(invite.email)}`);
  await page.locator('#n').fill('Meal Tester');
  await page.locator('#p').fill(pwStr);
  await page.locator('#c-terms').check();
  await page.locator('#c-sensitive').check();
  await page.locator('#go').click();
  await page.getByText('请查收验证邮件，验证后再登录。', { exact: true }).waitFor();
  const mail = fs.readdirSync(path.join(srv.dir, 'mail')).map(f => JSON.parse(fs.readFileSync(path.join(srv.dir, 'mail', f), 'utf8'))).find(m => m.kind === 'verify');
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

  // Verify 0 meals -> shortcuts hidden
  await page.locator('nav#tabs [data-act="tab"][data-v="food"]').click();
  assert.equal(await page.locator('#meal-shortcuts').count(), 0, '0 past meals renders nothing');

  // Seed historical meals with a photo blob on yesterday
  await page.evaluate(async () => {
    const yest = addDays(todayStr(), -1);
    await updateDay(yest, day => {
      day.meals = [
        { id: 'y-b1', type: '早餐', text: '燕麦鸡蛋牛奶', time: '08:00', photo: 'blob_hist_99', est: { kcal: 490, protein: 34, carbs: 52, fat: 14, by: 'manual' } },
        { id: 'y-l1', type: '午餐', text: '鸡胸肉米饭', time: '12:30', est: { kcal: 650, protein: 48, carbs: 70, fat: 16, by: 'manual' } }
      ];
    }, { quiet: true });
    render();
  });

  await page.locator('#meal-shortcuts .shortcut-chip').first().waitFor({ state: 'visible' });
  // Select breakfast radio -> breakfast meal moves to #1
  await page.locator('input[name="mtype"][value="早餐"]').check({ force: true });
  const firstText = await page.locator('#meal-shortcuts .shortcut-chip').first().textContent();
  assert.match(firstText, /燕麦鸡蛋牛奶/);

  // Check tap target >= 44x44
  const rect = await page.locator('#meal-shortcuts .shortcut-chip').first().boundingBox();
  assert.ok(rect.width >= 44 && rect.height >= 44, `shortcut tap target >= 44x44: ${JSON.stringify(rect)}`);

  // 1-tap add -> logs clean meal without photo blob and shows localized toast
  await page.locator('#meal-shortcuts .shortcut-chip').first().click();
  await page.locator('#toast', { hasText: '已添加「燕麦鸡蛋牛奶」' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#toast').textContent(), '已添加「燕麦鸡蛋牛奶」');

  const todayMeals = await page.evaluate(() => S.days[todayStr()]?.meals || []);
  assert.equal(todayMeals.length, 1);
  assert.equal(todayMeals[0].text, '燕麦鸡蛋牛奶');
  assert.equal(todayMeals[0].photo, null);
  assert.equal(todayMeals[0].est.kcal, 490);
  assert.equal(todayMeals[0].est.by, 'manual');

  // Audit axe-core in light/dark + zh/en
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Runtime.evaluate', { expression: axeSource, awaitPromise: false });
  for (const { lang, scheme } of [
    { lang: 'zh', scheme: 'light' },
    { lang: 'zh', scheme: 'dark' },
    { lang: 'en', scheme: 'light' },
    { lang: 'en', scheme: 'dark' }
  ]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(async l => { await setLang(l, { persistProfile: false }); }, lang);
    const res = await cdp.send('Runtime.evaluate', {
      expression: `window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        rules: { 'target-size': { enabled: true } }
      }).then(r => JSON.stringify(r.violations))`,
      awaitPromise: true,
      returnByValue: true
    });
    assert.deepEqual(JSON.parse(res.result.value), [], `axe violations in ${lang}/${scheme}`);
  }
  await cdp.detach();
  assert.deepEqual(pageErrors, []);
  await ctx.close();
});
