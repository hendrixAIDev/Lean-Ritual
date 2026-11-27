'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const appHtml = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
const fullScript = appHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
const pageScript = fullScript.split('/* ============ 启动 ============ */')[0];

function decodeHtml(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function createApp({ lang = 'zh', profile = null, days = {}, feedback = [], profileHistory = [] } = {}) {
  const docs = new Map();
  const baseProfile = {
    sex: 'm', age: 29, height: 176, weight: 72, bf: 15, steps: 9500,
    exp: 'mid', stage: 'cut', trainDays: [1, 3, 5], slot: 'eve',
    equipment: 'gym', startDate: '2026-10-01', injuries: [], supps: [],
    kcalAdjust: 0, deloadEvery: 9, swaps: {}, exEdits: {}, adjustLog: [], schema: 2,
    ...(profile || {})
  };
  docs.set('app/profile', JSON.parse(JSON.stringify(baseProfile)));
  for (const [date, d] of Object.entries(days)) {
    docs.set('days/' + date, JSON.parse(JSON.stringify(d)));
  }
  for (const f of feedback) {
    docs.set('feedback/' + f.id, JSON.parse(JSON.stringify(f)));
  }
  for (const h of profileHistory) {
    docs.set('profileHistory/' + h.id, JSON.parse(JSON.stringify(h)));
  }

  const store = {
    async get(p) { return docs.has(p) ? JSON.parse(JSON.stringify(docs.get(p))) : null; },
    async set(p, d) { docs.set(p, JSON.parse(JSON.stringify(d))); },
    async del(p) { docs.delete(p); },
    async commit(changes) {
      for (const c of changes) {
        if (c.after !== undefined) docs.set(c.path, JSON.parse(JSON.stringify(c.after)));
      }
    },
    async list(col) {
      const out = [];
      for (const [k, v] of docs.entries()) {
        if (k.startsWith(col + '/')) out.push({ id: k.slice(col.length + 1), data: JSON.parse(JSON.stringify(v)) });
      }
      return out;
    }
  };

  const storage = new Map([['bj-lang', lang]]);
  const localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: k => { storage.delete(k); },
    get length() { return storage.size; },
    key: i => [...storage.keys()][i] ?? null
  };

  let focused = null;
  const listeners = {};
  const makeEl = id => ({
    id,
    innerHTML: '',
    textContent: '',
    hidden: id !== 'app',
    contains: () => false,
    setAttribute() {},
    focus() { focused = '#' + id; }
  });
  const appEl = makeEl('app');
  const tabsEl = makeEl('tabs');
  const toastEl = makeEl('toast');
  const srEl = makeEl('sr-status');

  function queryRendered(sel) {
    if (sel === '#app') return appEl;
    if (sel === '#tabs') return tabsEl;
    if (sel === '#toast') return toastEl;
    if (sel === '#sr-status') return srEl;
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      const re = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'i');
      const m = appEl.innerHTML.match(re);
      if (m) {
        const disabled = /\bdisabled\b/i.test(m[0]);
        return { id, disabled, focus() { focused = sel; } };
      }
      return null;
    }
    if (sel === '.chooser button' && /class="chooser"/.test(appEl.innerHTML)) {
      return { focus() { focused = '.chooser button'; } };
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
    getElementById: id => queryRendered('#' + id)
  };

  const ctx = vm.createContext({
    window: { scrollTo() {}, ritual: { hosted: true } },
    document,
    localStorage,
    navigator: { userAgent: 'node-test', languages: [lang === 'en' ? 'en-US' : 'zh-CN'] },
    location: { href: 'http://127.0.0.1/', hostname: '127.0.0.1', search: '' },
    FormData: class FakeFormData {
      constructor(form) { this._m = form?._data || {}; }
      get(k) { const v = this._m[k]; return Array.isArray(v) ? (v[0] ?? null) : (v ?? null); }
      getAll(k) { const v = this._m[k]; return Array.isArray(v) ? v : (v != null ? [v] : []); }
    },
    URL, Date, Math, JSON, Object, Array, Set, Map, Promise, Number, String, Boolean, RegExp, Error,
    AbortController, encodeURIComponent, decodeURIComponent, isNaN, parseFloat, parseInt,
    console: { ...console, warn() {}, error() {} },
    setTimeout, clearTimeout
  });

  vm.runInContext(pageScript, ctx);
  ctx.__store = store;
  ctx.__initProfile = baseProfile;
  ctx.__initDays = days;
  ctx.__initFeedback = feedback;
  ctx.__initHistory = profileHistory;
  vm.runInContext(`
    storageUser = "u1";
    S.uid = "u1";
    S.ready = true;
    S.cloud = true;
    S.store = __store;
    S.profile = migrateProfile(clone(__initProfile));
    S.days = {};
    for (const [k, v] of Object.entries(clone(__initDays))) S.days[k] = migrateDay(v);
    S.feedback = clone(__initFeedback);
    S.profileHistory = clone(__initHistory);
    S.tab = "log";
    render();
  `, ctx);

  async function click(act, v, { disabled = false } = {}) {
    const btn = {
      dataset: { act, ...(v !== undefined ? { v: String(v) } : {}) },
      disabled,
      closest(sel) { return sel === '[data-act]' ? btn : null; }
    };
    for (const fn of listeners.click || []) await fn({ target: btn });
  }

  function getPager(key) {
    const navRe = new RegExp(`<nav\\b[^>]*data-pager="${key}"[^>]*>([\\s\\S]*?)<\\/nav>`);
    const m = appEl.innerHTML.match(navRe);
    if (!m) return null;
    const navTag = appEl.innerHTML.match(new RegExp(`<nav\\b[^>]*data-pager="${key}"[^>]*>`))[0];
    const navAria = decodeHtml((navTag.match(/aria-label="([^"]*)"/) || [])[1] || '');
    const prevTag = m[1].match(new RegExp(`<button\\b[^>]*id="pg-${key}-prev"[^>]*>([\\s\\S]*?)<\\/button>`));
    const nextTag = m[1].match(new RegExp(`<button\\b[^>]*id="pg-${key}-next"[^>]*>([\\s\\S]*?)<\\/button>`));
    const infoMatch = m[1].match(new RegExp(`<span\\b[^>]*id="pg-${key}-info"[^>]*>([\\s\\S]*?)<\\/span>`));
    const parseBtn = bm => bm ? {
      tag: bm[0],
      text: decodeHtml(bm[1]),
      disabled: /\bdisabled\b/.test(bm[0]),
      v: decodeHtml((bm[0].match(/data-v="([^"]*)"/) || [])[1] || ''),
      ariaLabel: decodeHtml((bm[0].match(/aria-label="([^"]*)"/) || [])[1] || ''),
      type: decodeHtml((bm[0].match(/type="([^"]*)"/) || [])[1] || '')
    } : null;
    return {
      navAria,
      info: infoMatch ? decodeHtml(infoMatch[1]) : '',
      prev: parseBtn(prevTag),
      next: parseBtn(nextTag)
    };
  }

  return {
    ctx,
    docs,
    appEl,
    srEl,
    click,
    getPager,
    getFocused: () => focused,
    clearFocused: () => { focused = null; }
  };
}

function makeDays(count, baseDate = '2026-11-26') {
  const days = {};
  const [y, m, d] = baseDate.split('-').map(Number);
  const baseMs = Date.UTC(y, m - 1, d);
  for (let i = 0; i < count; i++) {
    const dt = new Date(baseMs - i * 86400000).toISOString().slice(0, 10);
    days[dt] = {
      date: dt,
      checkin: { weight: +(72 - i * 0.05).toFixed(2), steps: 9000, sleep: 7.5, bf: 15 },
      meals: [
        { id: 'm1-' + i, type: '早餐', text: 'Oats', time: '08:00', est: { kcal: 500, protein: 35, carbs: 55, fat: 15, by: 'manual' } },
        { id: 'm2-' + i, type: '午餐', text: 'Chicken', time: '12:30', est: { kcal: 700, protein: 50, carbs: 70, fat: 18, by: 'manual' } },
        { id: 'm3-' + i, type: '晚餐', text: 'Fish', time: '19:00', est: { kcal: 600, protein: 45, carbs: 60, fat: 16, by: 'manual' } }
      ],
      ...(i % 2 === 0 ? {
        workout: {
          key: 'push', slot: 'eve', done: true, savedAt: dt + 'T18:00:00Z', feel: 3, pain: 'none',
          exercises: [{ name: '上斜杠铃卧推', sets: [{ w: 60 + i, r: 6 }, { w: 60 + i, r: 6 }] }]
        }
      } : {})
    };
  }
  return days;
}

function makeFeedbacks(count) {
  return Array.from({ length: count }, (_, i) => {
    const day = String(26 - i).padStart(2, '0');
    return {
      id: `fb-${i}`,
      createdAt: `2026-11-${day}T10:00:00Z`,
      userText: `Note #${i}`,
      summary: `Summary for card #${i}`,
      good: [`Good #${i}`],
      issues: [],
      adjustments: [
        { kind: 'note', text: `Note advice #${i}` },
        { kind: 'kcal', delta: -100, text: `Trim 100 kcal on card #${i}` }
      ],
      applied: [],
      declined: []
    };
  });
}

function makeAdjustLog(count) {
  // Stored oldest-first in adjustLog, rendered newest-first
  return Array.from({ length: count }, (_, i) => ({
    id: `adj-${i}`,
    date: `2026-11-${String(1 + i).padStart(2, '0')}`,
    scope: 'long',
    kind: 'kcal',
    delta: 10 * (i + 1),
    prev: { kcalAdjust: 0 },
    after: { kcalAdjust: 10 * (i + 1) },
    reverted: false,
    text: `调整条目 #${i}`
  }));
}

function makeProfileHistory(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `ph-${i}`,
    savedAt: `2026-11-${String(26 - i).padStart(2, '0')}T08:00:00Z`,
    changes: [`体重：${75 - i} → ${74 - i}`]
  }));
}

test('pagination is hidden at or below pageSize and shown above pageSize for all 4 record lists', async () => {
  // Exactly at pageSize: daily=10, feedback=3, adjust=5, profileHistory=5 -> NO pagers rendered
  const atLimit = createApp({
    days: makeDays(10),
    feedback: makeFeedbacks(3),
    profile: { adjustLog: makeAdjustLog(5) },
    profileHistory: makeProfileHistory(5)
  });
  await atLimit.click('tab', 'log');
  assert.equal(atLimit.getPager('daily'), null, 'daily pager hidden at 10 items');
  assert.equal((atLimit.appEl.innerHTML.match(/class="day"/g) || []).length, 10);

  await atLimit.click('tab', 'fb');
  assert.equal(atLimit.getPager('feedback'), null, 'feedback pager hidden at 3 cards');
  assert.equal(atLimit.getPager('adjust'), null, 'adjust pager hidden at 5 items');

  await atLimit.click('tab', 'me');
  assert.equal(atLimit.getPager('profileHistory'), null, 'profileHistory pager hidden at 5 items');

  // 1 item above pageSize: daily=11, feedback=4, adjust=6, profileHistory=6 -> ALL 4 pagers rendered
  const overLimit = createApp({
    days: makeDays(11),
    feedback: makeFeedbacks(4),
    profile: { adjustLog: makeAdjustLog(6) },
    profileHistory: makeProfileHistory(6)
  });
  await overLimit.click('tab', 'log');
  const dPg = overLimit.getPager('daily');
  assert.ok(dPg, 'daily pager shown at 11 items');
  assert.equal(dPg.info, '1 / 2 · 共 11 条');
  assert.equal((overLimit.appEl.innerHTML.match(/class="day"/g) || []).length, 10);

  await overLimit.click('tab', 'fb');
  const fPg = overLimit.getPager('feedback');
  const aPg = overLimit.getPager('adjust');
  assert.ok(fPg, 'feedback pager shown at 4 cards');
  assert.equal(fPg.info, '1 / 2 · 共 4 条');
  assert.ok(aPg, 'adjust pager shown at 6 items');
  assert.equal(aPg.info, '1 / 2 · 共 6 条');
  assert.notEqual(fPg.navAria, aPg.navAria, 'multiple pagers on feedback tab must have unique nav aria-labels');
  assert.notEqual(fPg.next.ariaLabel, aPg.next.ariaLabel, 'multiple pagers on feedback tab must have unique button aria-labels');

  await overLimit.click('tab', 'me');
  const pPg = overLimit.getPager('profileHistory');
  assert.ok(pPg, 'profileHistory pager shown at 6 items');
  assert.equal(pPg.info, '1 / 2 · 共 6 条');
});

test('page navigation, boundary disabled states, zh/en localization, focus management, and page persistence across language toggle', async () => {
  const app = createApp({
    lang: 'zh',
    days: makeDays(24),
    feedback: makeFeedbacks(7),
    profile: { adjustLog: makeAdjustLog(12) },
    profileHistory: makeProfileHistory(11)
  });

  // 1. Daily breakdown: 24 days -> 3 pages (10, 10, 4)
  await app.click('tab', 'log');
  let pg = app.getPager('daily');
  assert.equal(pg.info, '1 / 3 · 共 24 条');
  assert.equal(pg.prev.disabled, true);
  assert.equal(pg.next.disabled, false);
  assert.equal(pg.prev.type, 'button');
  assert.equal(pg.next.type, 'button');
  assert.equal(pg.navAria, '每日明细分页');
  assert.equal(pg.prev.text, '上一页');
  assert.equal(pg.next.text, '下一页');
  assert.ok(pg.prev.ariaLabel.startsWith(pg.prev.text), 'prev aria-label starts with visible label');
  assert.ok(pg.next.ariaLabel.startsWith(pg.next.text), 'next aria-label starts with visible label');
  assert.match(app.appEl.innerHTML, /data-act="goto" data-v="2026-11-26"/);
  assert.doesNotMatch(app.appEl.innerHTML, /data-act="goto" data-v="2026-11-16"/);

  // Disabled Prev click is a no-op
  await app.click('page', 'daily:0', { disabled: true });
  assert.equal(app.getPager('daily').info, '1 / 3 · 共 24 条');

  // Next -> Page 2 (10 items: 2026-11-16 .. 2026-11-07)
  await app.click('page', pg.next.v);
  pg = app.getPager('daily');
  assert.equal(pg.info, '2 / 3 · 共 24 条');
  assert.equal(pg.prev.disabled, false);
  assert.equal(pg.next.disabled, false);
  assert.equal(app.getFocused(), '#pg-daily-next', 'middle page keeps focus on next');
  assert.equal(app.srEl.textContent, '每日明细，第 2 / 3 页，共 24 条');
  assert.match(app.appEl.innerHTML, /data-act="goto" data-v="2026-11-16"/);
  assert.doesNotMatch(app.appEl.innerHTML, /data-act="goto" data-v="2026-11-26"/);

  // Clicking a day on page 2 navigates to that exact date, and returning to Log preserves page 2
  await app.click('goto', '2026-11-16');
  assert.equal(vm.runInContext('S.tab', app.ctx), 'today');
  assert.equal(vm.runInContext('S.date', app.ctx), '2026-11-16');
  await app.click('tab', 'log');
  assert.equal(app.getPager('daily').info, '2 / 3 · 共 24 条', 'returning to log preserves page 2');

  // Next -> Page 3 (4 items: 2026-11-06 .. 2026-11-03), focus moves to Prev since Next is disabled
  await app.click('page', app.getPager('daily').next.v);
  pg = app.getPager('daily');
  assert.equal(pg.info, '3 / 3 · 共 24 条');
  assert.equal(pg.prev.disabled, false);
  assert.equal(pg.next.disabled, true);
  assert.equal((app.appEl.innerHTML.match(/class="day"/g) || []).length, 4);
  assert.equal(app.getFocused(), '#pg-daily-prev', 'reaching last page shifts focus to prev');

  // Switch to English -> stays on page 3, English labels & zero Chinese in pager
  await app.click('lang', 'en');
  pg = app.getPager('daily');
  assert.equal(pg.info, '3 / 3 · 24 total', 'language switch preserves daily page 3');
  assert.equal(pg.navAria, 'Daily Breakdown pagination');
  assert.equal(pg.prev.text, 'Prev');
  assert.equal(pg.next.text, 'Next');
  assert.ok(pg.prev.ariaLabel.startsWith(pg.prev.text));
  assert.ok(pg.next.ariaLabel.startsWith(pg.next.text));
  assert.doesNotMatch(pg.navAria + pg.info + pg.prev.ariaLabel + pg.next.ariaLabel, /[\u4e00-\u9fff]/);

  // 2. Feedback & Applied Adjustments (in English)
  await app.click('tab', 'fb');
  let fPg = app.getPager('feedback');
  let aPg = app.getPager('adjust');
  assert.equal(fPg.info, '1 / 3 · 7 total');
  assert.equal(fPg.navAria, 'AI Feedback pagination');
  assert.equal(aPg.info, '1 / 3 · 12 total');
  assert.equal(aPg.navAria, 'Applied Adjustments pagination');
  assert.match(app.appEl.innerHTML, /Summary for card #0/);
  assert.match(app.appEl.innerHTML, /Summary for card #2/);
  assert.doesNotMatch(app.appEl.innerHTML, /Summary for card #3/);

  await app.click('page', fPg.next.v);
  fPg = app.getPager('feedback');
  assert.equal(fPg.info, '2 / 3 · 7 total');
  assert.equal(app.srEl.textContent, 'AI Feedback, page 2 of 3, 7 total');
  assert.match(app.appEl.innerHTML, /Summary for card #3/);
  assert.match(app.appEl.innerHTML, /Summary for card #5/);
  assert.doesNotMatch(app.appEl.innerHTML, /Summary for card #0/);
  assert.doesNotMatch(app.appEl.innerHTML, /Summary for card #6/);

  await app.click('page', fPg.next.v);
  fPg = app.getPager('feedback');
  assert.equal(fPg.info, '3 / 3 · 7 total');
  assert.equal(fPg.next.disabled, true);
  assert.match(app.appEl.innerHTML, /Summary for card #6/);

  // 3. Profile History (11 items -> 3 pages: 5, 5, 1)
  await app.click('tab', 'me');
  let pPg = app.getPager('profileHistory');
  assert.equal(pPg.info, '1 / 3 · 11 total');
  assert.equal(pPg.navAria, 'Profile History pagination');
  await app.click('page', pPg.next.v);
  pPg = app.getPager('profileHistory');
  assert.equal(pPg.info, '2 / 3 · 11 total');
  // Toggle back to zh on Me tab -> stays on page 2
  await app.click('lang', 'zh');
  pPg = app.getPager('profileHistory');
  assert.equal(pPg.info, '2 / 3 · 共 11 条', 'toggling language on Me tab preserves profileHistory page 2');
  assert.equal(pPg.navAria, '资料变更记录分页');
});

test('undo on page 2 of Applied Adjustments and adopt/undo on page 2 of AI Feedback target exact underlying records', async () => {
  // Build 8 adjustLog entries (oldest-first):
  // Rendered reversed: page 1 has adj-7..adj-3; page 2 has adj-2, adj-1, adj-0.
  // Make adj-1 (on page 2!) the active kcalAdjust=+150 entry so undo has no conflict and restores kcalAdjust=0.
  const adjustLog = Array.from({ length: 8 }, (_, i) => {
    if (i === 1) {
      return {
        id: 'adj-page2-target',
        date: '2026-11-02',
        scope: 'long',
        kind: 'kcal',
        delta: 150,
        prev: { kcalAdjust: 0 },
        after: { kcalAdjust: 150 },
        reverted: false,
        text: '每日热量 +150 kcal'
      };
    }
    return {
      id: `adj-plain-${i}`,
      date: `2026-11-${String(1 + i).padStart(2, '0')}`,
      text: `历史调整 #${i}`
    };
  });

  const feedbacks = makeFeedbacks(5); // page 1: fb-0..fb-2; page 2: fb-3, fb-4
  const app = createApp({
    lang: 'zh',
    profile: { kcalAdjust: 150, adjustLog },
    feedback: feedbacks
  });

  await app.click('tab', 'fb');
  // Go to page 2 of Applied Adjustments
  await app.click('page', app.getPager('adjust').next.v);
  assert.equal(app.getPager('adjust').info, '2 / 2 · 共 8 条');
  assert.match(app.appEl.innerHTML, /data-act="undo-adjust" data-v="adj-page2-target"/);
  assert.doesNotMatch(app.appEl.innerHTML, /历史调整 #7/);

  // Click Undo on page 2 -> reverts exact adj-page2-target, restores kcalAdjust to 0, stays on page 2
  await app.click('undo-adjust', 'adj-page2-target');
  const savedAfterUndo = app.docs.get('app/profile');
  assert.equal(savedAfterUndo.kcalAdjust, 0, 'kcalAdjust restored from page 2 undo');
  assert.equal(savedAfterUndo.adjustLog[1].reverted, true, 'exact underlying adjustLog[1] marked reverted');
  assert.equal(savedAfterUndo.adjustLog[7].reverted, undefined, 'page 1 entry untouched');
  assert.equal(app.getPager('adjust').info, '2 / 2 · 共 8 条', 'undo stays on page 2');
  assert.match(app.appEl.innerHTML, /（已撤销）/);

  // Now navigate to page 2 of AI Feedback (fb-3, fb-4) and adopt adjustment index 1 on fb-4
  await app.click('page', app.getPager('feedback').next.v);
  assert.equal(app.getPager('feedback').info, '2 / 2 · 共 5 条');
  assert.match(app.appEl.innerHTML, /Summary for card #4/);
  assert.doesNotMatch(app.appEl.innerHTML, /Summary for card #0/);

  const openMatch = app.appEl.innerHTML.match(/data-act="adopt-open"[^>]*data-key="fb-4:1"[^>]*data-v='([^']+)'/);
  assert.ok(openMatch, 'expected adopt-open button for fb-4:1 on page 2');
  await app.click('adopt-open', decodeHtml(openMatch[1]));
  const confirmMatch = app.appEl.innerHTML.match(/data-act="adopt-confirm"[^>]*data-v='([^']+)'/);
  assert.ok(confirmMatch, 'expected adopt-confirm button in chooser');
  await app.click('adopt-confirm', decodeHtml(confirmMatch[1]));

  // Verify fb-4 (index 4 in S.feedback, NOT index 1!) was marked applied, kcalAdjust updated to -100,
  // feedback stays on page 2, and adjustLog resets to page 1 so the new entry is immediately visible at top!
  assert.deepEqual(Array.from(vm.runInContext('S.feedback[4].applied', app.ctx)), [1]);
  assert.deepEqual(Array.from(vm.runInContext('S.feedback[1].applied', app.ctx)), []);
  assert.equal(app.docs.get('app/profile').kcalAdjust, -100);
  assert.equal(app.getPager('feedback').info, '2 / 2 · 共 5 条', 'adopting on feedback page 2 stays on page 2');
  assert.equal(app.getPager('adjust').info, '1 / 2 · 共 9 条', 'adding a new adjustLog entry resets adjust pager to page 1');

  // Click 已采纳 · 撤销 right on the page-2 AI feedback card
  const cardUndoMatch = app.appEl.innerHTML.match(/class="chip" data-act="undo-adjust" data-v="([^"]+)"/);
  assert.ok(cardUndoMatch, 'expected undo chip on page-2 feedback card');
  await app.click('undo-adjust', decodeHtml(cardUndoMatch[1]));
  assert.deepEqual(Array.from(vm.runInContext('S.feedback[4].applied', app.ctx)), []);
  assert.equal(app.docs.get('app/profile').kcalAdjust, 0);
  assert.equal(app.getPager('feedback').info, '2 / 2 · 共 5 条', 'undoing on feedback page 2 stays on page 2');
});

test('clamps page bounds when last item on last page is removed and resets to page 1 when new entries are added', async () => {
  const app = createApp({
    lang: 'zh',
    days: makeDays(11),
    feedback: makeFeedbacks(4),
    profile: { adjustLog: makeAdjustLog(6) },
    profileHistory: makeProfileHistory(6)
  });

  // 1. Clamping when last item on page 2 is removed across all 4 sections
  await app.click('tab', 'fb');
  await app.click('page', app.getPager('adjust').next.v);
  await app.click('page', app.getPager('feedback').next.v);
  assert.equal(vm.runInContext('S.pages.adjust', app.ctx), 2);
  assert.equal(vm.runInContext('S.pages.feedback', app.ctx), 2);

  // Remove 1 item from each so totalPages drops from 2 -> 1
  vm.runInContext(`
    S.profile.adjustLog.shift();
    S.feedback.pop();
    render();
  `, app.ctx);
  assert.equal(vm.runInContext('S.pages.adjust', app.ctx), 1, 'adjust page clamped to 1');
  assert.equal(vm.runInContext('S.pages.feedback', app.ctx), 1, 'feedback page clamped to 1');
  assert.equal(app.getPager('adjust'), null, 'adjust pager hidden after shrinking to 5');
  assert.equal(app.getPager('feedback'), null, 'feedback pager hidden after shrinking to 3');
  assert.match(app.appEl.innerHTML, /Summary for card #0/, 'page 1 rendered cleanly instead of empty page');

  // Same clamp check for daily and profileHistory
  await app.click('tab', 'log');
  await app.click('page', app.getPager('daily').next.v);
  assert.equal(vm.runInContext('S.pages.daily', app.ctx), 2);
  vm.runInContext(`delete S.days["2026-11-16"]; render();`, app.ctx);
  assert.equal(vm.runInContext('S.pages.daily', app.ctx), 1, 'daily page clamped to 1');
  assert.equal(app.getPager('daily'), null);
  assert.equal((app.appEl.innerHTML.match(/class="day"/g) || []).length, 10);

  await app.click('tab', 'me');
  await app.click('page', app.getPager('profileHistory').next.v);
  assert.equal(vm.runInContext('S.pages.profileHistory', app.ctx), 2);
  vm.runInContext(`S.profileHistory.pop(); render();`, app.ctx);
  assert.equal(vm.runInContext('S.pages.profileHistory', app.ctx), 1, 'profileHistory page clamped to 1');
  assert.equal(app.getPager('profileHistory'), null);

  // 2. Adding new entries resets that list to page 1; editing existing day preserves daily page
  const app2 = createApp({
    lang: 'zh',
    days: makeDays(15),
    feedback: makeFeedbacks(5),
    profile: { kcalAdjust: 100, adjustLog: makeAdjustLog(8) },
    profileHistory: makeProfileHistory(7)
  });

  // Daily: go to page 2 -> update EXISTING day -> stays on page 2; add BRAND-NEW day -> resets to page 1
  await app2.click('tab', 'log');
  await app2.click('page', app2.getPager('daily').next.v);
  assert.equal(vm.runInContext('S.pages.daily', app2.ctx), 2);
  await vm.runInContext(`updateDay("2026-11-26", d => { d.checkin.steps = 9999; })`, app2.ctx);
  assert.equal(vm.runInContext('S.pages.daily', app2.ctx), 2, 'editing an existing day preserves daily page');
  await vm.runInContext(`updateDay("2026-11-27", d => { d.checkin = { weight: 71.5 }; })`, app2.ctx);
  assert.equal(vm.runInContext('S.pages.daily', app2.ctx), 1, 'adding a new day resets daily page to 1');

  // Adjust: go to page 2 -> reset-kcal pushes a new adjustLog entry -> resets adjust page to 1
  await app2.click('tab', 'fb');
  await app2.click('page', app2.getPager('adjust').next.v);
  assert.equal(vm.runInContext('S.pages.adjust', app2.ctx), 2);
  await app2.click('reset-kcal');
  await new Promise(r => setTimeout(r, 15));
  assert.equal(vm.runInContext('S.pages.adjust', app2.ctx), 1, 'appending to adjustLog resets adjust page to 1');

  // Feedback: go to page 2 -> runAI adds new card at top -> resets feedback page to 1
  await app2.click('page', app2.getPager('feedback').next.v);
  assert.equal(vm.runInContext('S.pages.feedback', app2.ctx), 2);
  vm.runInContext(`S.sample = { async json() { return { summary: "Fresh AI review", good: [], issues: [], adjustments: [] }; } };`, app2.ctx);
  await vm.runInContext('runAI()', app2.ctx);
  assert.equal(vm.runInContext('S.pages.feedback', app2.ctx), 1, 'runAI resets feedback page to 1');
  assert.match(app2.appEl.innerHTML, /Fresh AI review/);

  // Profile history: go to page 2 -> submitSetup saves a profile change -> resets profileHistory page to 1
  await app2.click('tab', 'me');
  await app2.click('page', app2.getPager('profileHistory').next.v);
  assert.equal(vm.runInContext('S.pages.profileHistory', app2.ctx), 2);
  await vm.runInContext(`submitSetup({ _data: { sex: "m", age: "29", height: "176", weight: "71", bf: "14.5", steps: "9500", exp: "mid", stage: "cut", trainDays: ["1","3","5"], slot: "am", equipment: "gym", injuries: [], injNote: "", supps: [] } })`, app2.ctx);
  assert.equal(vm.runInContext('S.pages.profileHistory', app2.ctx), 1, 'submitSetup resets profileHistory page to 1');
});

test('UI pagination is display-only: stats, charts, 7d/14d calculations, and AI prompt digest are unaffected by active page', async () => {
  const app = createApp({
    lang: 'en',
    days: makeDays(25),
    feedback: makeFeedbacks(6),
    profile: { adjustLog: makeAdjustLog(11) },
    profileHistory: makeProfileHistory(9)
  });

  const snapshot = () => vm.runInContext(`({
    checkinsLen: checkins().length,
    avg7: avgWeight("2026-11-26"),
    avgBf14: avgBf("2026-11-26"),
    balance: balanceSeries(14),
    lifts: liftSeries(),
    insights: insights(),
    digest: dataDigest("en")
  })`, app.ctx);

  await app.click('tab', 'log');
  const onPage1 = snapshot();

  await app.click('page', app.getPager('daily').next.v);
  await app.click('page', app.getPager('daily').next.v);
  assert.equal(vm.runInContext('S.pages.daily', app.ctx), 3);

  const onPage3 = snapshot();
  assert.deepEqual(onPage3, onPage1, 'underlying stats, charts, insights, and AI digest must be identical regardless of UI page');
});
