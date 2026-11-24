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
const sharp = require('sharp');

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

function mountApp({ lang = 'zh', profile = null, days = {}, assetsImpl = null, sendFeedbackImpl = null, failNextDayWrite = false } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const script = extractInlineScript(html);

  let focusedTarget = null;
  let shouldFailWrite = failNextDayWrite;
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
  const srStatusEl = makeEl('sr-status');
  const mTextState = { value: '' };
  const ufbMsgState = { value: '' };

  const clickLog = [];
  const fakeInputs = new Map();

  function getOrMakeFakeInput(id) {
    if (!fakeInputs.has(id)) {
      const m = appEl.innerHTML.match(new RegExp(`<input\\b[^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`));
      if (!m) return null;
      const disabled = /\bdisabled\b/.test(m[0]);
      const moreM = m[0].match(/\bdata-more="([^"]+)"/);
      const obj = {
        id,
        disabled,
        dataset: moreM ? { more: moreM[1] } : {},
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
      if (id === 'sr-status') return srStatusEl;
      if (id === 'm-text' && /\bid="m-text"/.test(src)) {
        return {
          id: 'm-text',
          get value() { return mTextState.value; },
          set value(v) { mTextState.value = String(v); },
          focus() { focusedTarget = '#m-text'; }
        };
      }
      if (id === 'ufb-msg' && /\bid="ufb-msg"/.test(src)) {
        return {
          id: 'ufb-msg',
          get value() { return ufbMsgState.value; },
          set value(v) { ufbMsgState.value = String(v); },
          focus() { focusedTarget = '#ufb-msg'; }
        };
      }
      const inp = getOrMakeFakeInput(id);
      if (inp) return inp;
      const tagM = src.match(new RegExp(`<[a-z]+\\b[^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`));
      if (tagM) {
        return {
          id,
          disabled: /\bdisabled\b/.test(tagM[0]),
          focus() { focusedTarget = sel; }
        };
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
        async set(d) {
          if (shouldFailWrite && p.includes('/days/')) {
            shouldFailWrite = false;
            throw Object.assign(new Error('write failed'), { code: 'network' });
          }
          storeData.set(p, JSON.parse(JSON.stringify(d)));
        },
        async delete() { storeData.delete(p); }
      };
    },
    async commit(changes) {
      if (shouldFailWrite && changes.some(c => c.path.includes('/days/'))) {
        shouldFailWrite = false;
        throw Object.assign(new Error('write failed'), { code: 'network' });
      }
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
      sendFeedback: sendFeedbackImpl || (async () => ({ ok: true })),
      async use(name) {
        if (name === 'db') return db;
        if (name === 'assets') return assetsImpl;
        if (name === 'user') return { async me() { return { id: 'u1', username: 'tester', created: '2026-11-18T00:00:00Z' }; } };
        return null;
      }
    }
  };

  let nextBlobId = 1;
  const createdUrls = [];
  const revokedUrls = [];
  const TestURL = class extends URL {
    static createObjectURL(obj) {
      const u = `blob:test-${nextBlobId++}`;
      createdUrls.push({ url: u, obj });
      return u;
    }
    static revokeObjectURL(u) { revokedUrls.push(u); }
  };

  class FakeFileReader {
    readAsDataURL(blob) {
      const data = blob?.data || 'AA==';
      this.result = `data:${blob?.type || 'image/png'};base64,${data}`;
      if (this.onload) this.onload();
    }
  }

  const ctx = vm.createContext({
    window,
    document,
    localStorage,
    FileReader: FakeFileReader,
    navigator: { userAgent: 'node-test', onLine: true, languages: [lang === 'en' ? 'en-US' : 'zh-CN'] },
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

  async function dispatchChange(el) {
    fakeInputs.clear();
    for (const fn of (listeners.change || [])) {
      await fn({ target: el, preventDefault() {} });
    }
  }

  return {
    ctx,
    appEl,
    toastEl,
    srStatusEl,
    mTextState,
    ufbMsgState,
    storeData,
    clickLog,
    createdUrls,
    revokedUrls,
    setFailNextDayWrite(v) { shouldFailWrite = v; },
    getFocused: () => focusedTarget,
    resetFocus: () => { focusedTarget = null; },
    waitBoot,
    dispatchClick,
    dispatchChange
  };
}

const SAMPLE_PROFILE = {
  sex: 'm', age: 29, height: 176, weight: 72, bf: 15,
  equipment: 'gym', trainDays: [1, 3, 5], slot: 'eve',
  stage: 'cut', exp: 'mid', injuries: [], supps: [], startDate: '2026-11-01'
};

test('all file inputs are hidden behind localized triggers and live status region stays mounted outside #app', () => {
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

  // Persistent live region mounted inside <main> as a sibling of #app (never replaced by render)
  assert.match(html, /<main><div id="app">[\s\S]*?<\/div><div class="sr" id="sr-status" role="status" aria-live="polite" aria-atomic="true"><\/div><\/main>/);
  // Inline status spans must not recreate role="status" / aria-live on innerHTML replacement
  const inlineStatusSpans = [...html.matchAll(/<span id="(?:m-photo-status|ufb-shot-status)"[^>]*>/g)].map(m => m[0]);
  assert.equal(inlineStatusSpans.length, 2);
  for (const span of inlineStatusSpans) {
    assert.doesNotMatch(span, /\brole="status"|\baria-live=/, `inline status span should rely on persistent #sr-status: ${span}`);
  }
});

const TEST_DATE = '2026-11-18';
const OTHER_DATE = '2026-11-19';

test('localized photo picker UI, indexed remove names, live announcements, limit focus, and distinct URL cleanup in zh and en', async () => {
  const sampleDay = {
    date: TEST_DATE,
    meals: [{ id: 'meal-1', type: '午餐', text: 'Chicken rice', time: '12:30', est: { kcal: 620, protein: 46, by: 'manual' } }]
  };

  for (const lang of ['zh', 'en']) {
    const feedbackSent = [];
    const app = mountApp({
      lang,
      profile: SAMPLE_PROFILE,
      days: { [TEST_DATE]: sampleDay },
      sendFeedbackImpl: async payload => { feedbackSent.push(payload); return { ok: true }; }
    });
    await app.waitBoot();

    // Food tab: empty state
    vm.runInContext(`S.tab = "food"; S.date = "${TEST_DATE}"; S.pendingPhotos = null; render();`, app.ctx);
    const emptyFood = app.appEl.innerHTML;
    assert.match(emptyFood, /id="m-photo"[^>]*class="file-input"[^>]*accept="image\/\*"[^>]*multiple/);
    assert.match(emptyFood, /id="m-photo-btn"[^>]*data-act="pick-file"[^>]*data-for="m-photo"/);
    assert.match(emptyFood, lang === 'zh' ? />选择照片<\/span><\/button>/ : />Choose photos<\/span><\/button>/);
    assert.match(emptyFood, lang === 'zh' ? /id="m-photo-status"[^>]*>未选择</ : /id="m-photo-status"[^>]*>No photo selected</);
    assert.match(emptyFood, /id="more-meal-1"[^>]*data-more="meal-1"/);
    assert.match(emptyFood, lang === 'zh'
      ? /data-act="pick-file" data-for="more-meal-1"[^>]*>\+ 照片<span class="sr">，午餐<\/span><\/button>/
      : /data-act="pick-file" data-for="more-meal-1"[^>]*>\+ Photo<span class="sr">, Lunch<\/span><\/button>/);

    // Clicking styled buttons clears value and triggers hidden input click
    await app.dispatchClick({ act: 'pick-file', for: 'm-photo' });
    assert.deepEqual(app.clickLog, [{ id: 'm-photo', valueAtClick: '' }]);
    app.clickLog.length = 0;

    await app.dispatchClick({ act: 'pick-file', for: 'more-meal-1' });
    assert.deepEqual(app.clickLog, [{ id: 'more-meal-1', valueAtClick: '' }]);
    app.clickLog.length = 0;

    // Select 2 photos via change event -> distinct object URLs, indexed remove names, live status announcement
    const fileA = { name: 'a.jpg', type: 'image/jpeg' };
    const fileB = { name: 'b.jpg', type: 'image/jpeg' };
    const mPhotoEl = { id: 'm-photo', dataset: {}, files: [fileA, fileB], value: 'C:\\fakepath\\a.jpg' };
    await app.dispatchChange(mPhotoEl);
    assert.equal(mPhotoEl.value, '', 'm-photo value clears after selection for same-file reselection');
    assert.equal(app.createdUrls.length, 2);
    const [urlA, urlB] = app.createdUrls.map(x => x.url);
    assert.notEqual(urlA, urlB);
    assert.equal(app.srStatusEl.textContent, lang === 'zh' ? '已选 2 张' : '2 selected');
    assert.equal(app.getFocused(), '#m-photo-btn');

    const twoFood = app.appEl.innerHTML;
    assert.match(twoFood, lang === 'zh' ? /id="m-photo-rm-0"[^>]*aria-label="去掉第 1 张照片"/ : /id="m-photo-rm-0"[^>]*aria-label="Remove photo 1"/);
    assert.match(twoFood, lang === 'zh' ? /id="m-photo-rm-1"[^>]*aria-label="去掉第 2 张照片"/ : /id="m-photo-rm-1"[^>]*aria-label="Remove photo 2"/);

    // Remove photo 1 -> revokes urlA only, updates #sr-status, focuses remaining #m-photo-rm-0
    app.resetFocus();
    await app.dispatchClick({ act: 'unpick', v: '0' });
    assert.deepEqual(app.revokedUrls, [urlA]);
    assert.equal(app.srStatusEl.textContent, lang === 'zh' ? '已选 1 张' : '1 selected');
    assert.equal(app.getFocused(), '#m-photo-rm-0');

    // Remove remaining photo -> revokes urlB, restores focus to #m-photo-btn
    app.resetFocus();
    await app.dispatchClick({ act: 'unpick', v: '0' });
    assert.deepEqual(app.revokedUrls, [urlA, urlB]);
    assert.equal(app.srStatusEl.textContent, lang === 'zh' ? '未选择' : 'No photo selected');
    assert.equal(app.getFocused(), '#m-photo-btn');

    // Select 4 photos -> reaches max limit, disables button & input, announces limit, moves focus to #m-photo-rm-0
    app.resetFocus();
    const fourFiles = [1, 2, 3, 4].map(i => ({ name: `p${i}.jpg`, type: 'image/jpeg' }));
    await app.dispatchChange({ id: 'm-photo', dataset: {}, files: fourFiles, value: 'p4.jpg' });
    const maxFood = app.appEl.innerHTML;
    assert.match(maxFood, /id="m-photo-btn"[^>]*\bdisabled\b/);
    assert.match(maxFood, /id="m-photo"[^>]*\bdisabled\b/);
    assert.equal(app.srStatusEl.textContent, lang === 'zh' ? '已选 4 张 · 最多 4 张' : '4 selected · Max 4 photos');
    assert.equal(app.getFocused(), '#m-photo-rm-0', 'focus must move to an enabled target when picker disables at max');
    await app.dispatchClick({ act: 'pick-file', for: 'm-photo' });
    assert.deepEqual(app.clickLog, [], 'disabled file input must not be clicked at max photos');

    // Clean up those 4 photos and verify every URL revoked
    for (let i = 0; i < 4; i++) await app.dispatchClick({ act: 'unpick', v: '0' });
    assert.equal(app.revokedUrls.length, app.createdUrls.length, 'all meal draft URLs revoked on removal');

    // Feedback screenshot lifecycle: select -> replace -> remove -> select -> cancel -> select -> submit
    vm.runInContext(`
      S.tab = "me";
      S.ufb = { type: "bug", message: "", includeDeviceInfo: true, file: null, previewUrl: null, busy: false, errKey: null, errObj: null };
      render();
    `, app.ctx);
    const ufbBeforeCount = app.createdUrls.length;
    const shot1 = { name: 's1.png', type: 'image/png', size: 100, data: PNG_1X1.toString('base64') };
    const shot2 = { name: 's2.png', type: 'image/png', size: 100, data: PNG_1X1.toString('base64') };
    const shot3 = { name: 's3.png', type: 'image/png', size: 100, data: PNG_1X1.toString('base64') };
    const shot4 = { name: 's4.png', type: 'image/png', size: 100, data: PNG_1X1.toString('base64') };

    // 1) Pick shot1 -> live announcement + URL created
    await app.dispatchChange({ id: 'ufb-file', dataset: {}, files: [shot1], value: 's1.png' });
    const ufbUrl1 = app.createdUrls[ufbBeforeCount].url;
    assert.equal(app.srStatusEl.textContent, lang === 'zh' ? '已选 1 张' : '1 selected');
    assert.equal(app.getFocused(), '#ufb-file-btn');

    // 2) Replace with shot2 -> revokes ufbUrl1
    await app.dispatchChange({ id: 'ufb-file', dataset: {}, files: [shot2], value: 's2.png' });
    const ufbUrl2 = app.createdUrls[ufbBeforeCount + 1].url;
    assert.ok(app.revokedUrls.includes(ufbUrl1), 'replacing feedback screenshot must revoke previous URL');

    // 3) Remove -> revokes ufbUrl2, announces unselected, focuses #ufb-file-btn
    app.resetFocus();
    await app.dispatchClick({ act: 'ufb-unpick' });
    assert.ok(app.revokedUrls.includes(ufbUrl2), 'removing feedback screenshot must revoke URL');
    assert.equal(app.srStatusEl.textContent, lang === 'zh' ? '未选择' : 'No photo selected');
    assert.equal(app.getFocused(), '#ufb-file-btn');

    // 4) Pick shot3 then cancel -> revokes ufbUrl3
    await app.dispatchChange({ id: 'ufb-file', dataset: {}, files: [shot3], value: 's3.png' });
    const ufbUrl3 = app.createdUrls[ufbBeforeCount + 2].url;
    await app.dispatchClick({ act: 'ufb-cancel' });
    assert.ok(app.revokedUrls.includes(ufbUrl3), 'canceling feedback form must revoke screenshot URL');

    // 5) Re-open, pick shot4, submit -> revokes ufbUrl4 and sends screenshot payload
    await app.dispatchClick({ act: 'ufb-open' });
    await app.dispatchChange({ id: 'ufb-file', dataset: {}, files: [shot4], value: 's4.png' });
    const ufbUrl4 = app.createdUrls[ufbBeforeCount + 3].url;
    app.ufbMsgState.value = 'Photo picker feedback test';
    await app.dispatchClick({ act: 'ufb-submit' });
    assert.equal(feedbackSent.length, 1);
    assert.equal(feedbackSent[0].screenshot?.contentType, 'image/png');
    assert.equal(feedbackSent[0].screenshot?.dataBase64, PNG_1X1.toString('base64'));
    assert.ok(app.revokedUrls.includes(ufbUrl4), 'submitting feedback must revoke screenshot URL');

    // Every single created object URL across the whole test must have been revoked
    assert.deepEqual(
      [...app.revokedUrls].sort(),
      app.createdUrls.map(x => x.url).sort(),
      `leaked object URLs in ${lang}`
    );
  }
});

test('meal-save race: photo edits are disabled and guarded during deferred upload, clearing only saved photos without leaking URLs', async () => {
  const uploadedNames = [];
  const deferreds = [];
  const app = mountApp({
    lang: 'zh',
    profile: SAMPLE_PROFILE,
    assetsImpl: {
      upload(blob) {
        uploadedNames.push(blob.tag);
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        deferreds.push({ tag: blob.tag, resolve });
        return promise;
      }
    }
  });
  await app.waitBoot();

  // Stub compress2 so each File passes through its distinct tag deterministically
  vm.runInContext(`
    compress2 = async file => ({ ok: true, blob: { tag: file.name, type: "image/jpeg" }, thumb: null });
    S.tab = "food";
    S.date = "${TEST_DATE}";
    S.mealMode = "manual";
    render();
  `, app.ctx);

  const fileA = { name: 'photo-A.jpg', type: 'image/jpeg' };
  const fileB = { name: 'photo-B.jpg', type: 'image/jpeg' };
  const fileC = { name: 'photo-C.jpg', type: 'image/jpeg' };

  // Select A and B
  await app.dispatchChange({ id: 'm-photo', dataset: {}, files: [fileA, fileB], value: 'photo-B.jpg' });
  const [urlA, urlB] = app.createdUrls.map(x => x.url);
  assert.equal(app.createdUrls.length, 2);

  // Start saving (deferred upload pauses inside addMeal)
  app.mTextState.value = 'Slow upload meal';
  const savePromise = app.dispatchClick({ act: 'add-meal', v: 'manual' });
  await new Promise(r => setTimeout(r, 15));

  // Verify picker and remove buttons are disabled while save is in flight
  assert.equal(vm.runInContext('S.busy.addMeal', app.ctx), true);
  assert.match(app.appEl.innerHTML, /id="m-photo"[^>]*\bdisabled\b/);
  assert.match(app.appEl.innerHTML, /id="m-photo-btn"[^>]*\bdisabled\b/);
  assert.match(app.appEl.innerHTML, /id="m-photo-rm-0"[^>]*\bdisabled\b/);
  assert.match(app.appEl.innerHTML, /id="m-photo-rm-1"[^>]*\bdisabled\b/);

  // Attempt to remove A, click picker, and inject late change with C during save
  await app.dispatchClick({ act: 'unpick', v: '0' });
  await app.dispatchClick({ act: 'pick-file', for: 'm-photo' });
  const lateInput = { id: 'm-photo', dataset: {}, files: [fileC], value: 'photo-C.jpg' };
  await app.dispatchChange(lateInput);

  assert.equal(lateInput.value, '', 'late change event during save must clear input value');
  assert.deepEqual(app.clickLog, [], 'picker trigger must be ignored while save is in flight');
  assert.equal(vm.runInContext('S.pendingPhotos.length', app.ctx), 2, 'A must not be removed and C must not be added mid-save');
  assert.equal(app.revokedUrls.length, 0, 'A URL must not be revoked while save is still in flight');
  assert.equal(app.createdUrls.filter(x => x.obj === fileC).length, 0, 'late C selection must not create or leak an object URL');

  // Resolve deferred uploads A then B
  assert.equal(deferreds.length, 1);
  assert.equal(deferreds[0].tag, 'photo-A.jpg');
  deferreds[0].resolve({ id: 'a'.repeat(32) });
  await new Promise(r => setTimeout(r, 15));
  assert.equal(deferreds.length, 2);
  assert.equal(deferreds[1].tag, 'photo-B.jpg');
  deferreds[1].resolve({ id: 'b'.repeat(32) });
  await savePromise;

  // Verify exact snapshot A & B were saved, draft reset, and ALL created URLs revoked (zero leaks)
  assert.deepEqual(uploadedNames, ['photo-A.jpg', 'photo-B.jpg']);
  assert.equal(vm.runInContext('S.pendingPhotos', app.ctx), null);
  assert.equal(vm.runInContext('S.busy.addMeal', app.ctx), false);
  assert.ok(app.revokedUrls.includes(urlA), 'urlA revoked after save');
  assert.ok(app.revokedUrls.includes(urlB), 'urlB revoked after save');
  assert.deepEqual(
    [...app.revokedUrls].sort(),
    app.createdUrls.map(x => x.url).sort(),
    'every created object URL (including transient S.files preview URL) must be revoked after successful save'
  );

  // Defensive test: if a write fails, pending photos and URLs stay intact and picker re-enables for retry
  await app.dispatchChange({ id: 'm-photo', dataset: {}, files: [fileC], value: 'photo-C.jpg' });
  const urlC = app.createdUrls.at(-1).url;
  app.setFailNextDayWrite(true);
  app.mTextState.value = 'Retryable meal';
  const failSave = app.dispatchClick({ act: 'add-meal', v: 'manual' });
  await new Promise(r => setTimeout(r, 15));
  deferreds.at(-1).resolve({ id: 'c'.repeat(32) });
  await failSave;

  assert.equal(vm.runInContext('S.busy.addMeal', app.ctx), false);
  assert.equal(vm.runInContext('S.pendingPhotos.length', app.ctx), 1, 'failed save must keep pending photo for retry');
  assert.equal(app.revokedUrls.includes(urlC), false, 'failed save must not revoke pending preview URL');
  assert.doesNotMatch(app.appEl.innerHTML, /id="m-photo-btn"[^>]*\bdisabled\b/, 'picker re-enables after failed save');
  assert.doesNotMatch(app.appEl.innerHTML, /id="m-photo-rm-0"[^>]*\bdisabled\b/, 'remove button re-enables after failed save');

  // Defensive test: clear only what was saved (if another entry exists outside the snapshot, preserve it)
  const extraEntry = { file: fileA, url: 'blob:untracked-extra' };
  const retrySave = app.dispatchClick({ act: 'add-meal', v: 'manual' });
  await new Promise(r => setTimeout(r, 15));
  // Simulate an external push into S.pendingPhotos during save
  app.ctx.__extra = extraEntry;
  vm.runInContext('S.pendingPhotos.push(__extra);', app.ctx);
  deferreds.at(-1).resolve({ id: 'd'.repeat(32) });
  await retrySave;
  assert.ok(app.revokedUrls.includes(urlC), 'saved snapshot item urlC was revoked');
  assert.equal(app.revokedUrls.includes('blob:untracked-extra'), false, 'unsaved entry URL was not revoked');
  assert.equal(vm.runInContext('S.pendingPhotos?.length', app.ctx), 1, 'unsaved entry preserved');
  assert.equal(vm.runInContext('S.pendingPhotos[0].url', app.ctx), 'blob:untracked-extra');
});

test('failed meal write cleans up attempt S.files cache while keeping draft, and retry-photo defers preview revocation until day update succeeds', async () => {
  // 1) Assets unavailable + day write failure -> attempt cache entry & URL released, draft + selection preserved
  const noAssetsApp = mountApp({
    lang: 'zh',
    profile: SAMPLE_PROFILE,
    assetsImpl: null,
    failNextDayWrite: true
  });
  await noAssetsApp.waitBoot();
  vm.runInContext(`
    compress2 = async file => ({ ok: true, blob: { tag: file.name, type: "image/jpeg" }, thumb: "data:image/jpeg;base64,AA==" });
    S.tab = "food";
    S.date = "${TEST_DATE}";
    S.mealMode = "manual";
    render();
  `, noAssetsApp.ctx);

  const draftFile = { name: 'offline-meal.jpg', type: 'image/jpeg' };
  await noAssetsApp.dispatchChange({ id: 'm-photo', dataset: {}, files: [draftFile], value: 'offline-meal.jpg' });
  const draftUrl = noAssetsApp.createdUrls[0].url;
  noAssetsApp.mTextState.value = 'Offline draft meal';

  await noAssetsApp.dispatchClick({ act: 'add-meal', v: 'manual' });

  // Attempt created a transient S.files[mealId].url and must have revoked & deleted it on write failure
  assert.equal(noAssetsApp.createdUrls.length, 2, 'expected draft URL + attempt S.files URL');
  const attemptUrl = noAssetsApp.createdUrls[1].url;
  assert.deepEqual(vm.runInContext('Object.keys(S.files)', noAssetsApp.ctx), [], 'failed attempt must not leave an unreferenced entry in S.files');
  assert.ok(noAssetsApp.revokedUrls.includes(attemptUrl), 'failed attempt S.files URL must be revoked');
  assert.equal(noAssetsApp.revokedUrls.includes(draftUrl), false, 'draft preview URL must stay live for retry');
  assert.equal(vm.runInContext('S.pendingPhotos?.length', noAssetsApp.ctx), 1, 'draft selection preserved for retry');
  assert.equal(noAssetsApp.mTextState.value, 'Offline draft meal', 'draft meal text preserved for retry');

  // Now retry succeeds -> draft URL revoked, S.pendingPhotos cleared, saved meal retains its active S.files entry
  await noAssetsApp.dispatchClick({ act: 'add-meal', v: 'manual' });
  assert.equal(vm.runInContext('S.pendingPhotos', noAssetsApp.ctx), null);
  assert.ok(noAssetsApp.revokedUrls.includes(draftUrl), 'draft URL revoked once retry succeeds');
  assert.equal(vm.runInContext('Object.keys(S.files).length', noAssetsApp.ctx), 1, 'saved meal keeps its local fallback cache entry');

  // 2) retry-photo: upload succeeds, day write fails -> fallback preview URL must NOT be revoked yet; succeeds on retry -> revoked
  const retryApp = mountApp({
    lang: 'zh',
    profile: SAMPLE_PROFILE,
    days: {
      [TEST_DATE]: {
        date: TEST_DATE,
        meals: [{ id: 'm-retry', type: '午餐', text: 'Retry meal', time: '12:00', photo: null, photoErr: 'network', est: null }]
      }
    },
    assetsImpl: { async upload() { return { id: 'e'.repeat(32) }; } },
    failNextDayWrite: true
  });
  await retryApp.waitBoot();
  vm.runInContext(`
    S.tab = "food";
    S.date = "${TEST_DATE}";
    S.days["${TEST_DATE}"] = {
      date: "${TEST_DATE}",
      meals: [{ id: "m-retry", type: "午餐", text: "Retry meal", time: "12:00", photo: null, photoErr: "network", est: null }]
    };
    S.files["m-retry"] = { blob: { tag: "retry.jpg", type: "image/jpeg" }, url: URL.createObjectURL({ tag: "retry.jpg" }), key: "retry-key-12345678" };
    render();
  `, retryApp.ctx);
  const fallbackUrl = retryApp.createdUrls[0].url;

  // First retry-photo: upload succeeds, day write fails -> preview URL remains intact
  await retryApp.dispatchClick({ act: 'retry-photo', v: 'm-retry' });
  assert.equal(retryApp.revokedUrls.includes(fallbackUrl), false, 'fallback preview URL must not be revoked when day write fails');
  assert.equal(vm.runInContext('S.files["m-retry"]?.url', retryApp.ctx), fallbackUrl);

  // Second retry-photo: upload and day write both succeed -> preview URL is revoked
  await retryApp.dispatchClick({ act: 'retry-photo', v: 'm-retry' });
  assert.ok(retryApp.revokedUrls.includes(fallbackUrl), 'fallback preview URL revoked after day update succeeds');
  assert.equal(vm.runInContext('S.files["m-retry"]?.url', retryApp.ctx), null);
  assert.equal(vm.runInContext(`S.days["${TEST_DATE}"].meals[0].photo`, retryApp.ctx), 'e'.repeat(32));
});

test('day switch during in-flight save or retry-photo stays bound to original meal date and guards missing target meal', async () => {
  const deferreds = [];
  const app = mountApp({
    lang: 'zh',
    profile: SAMPLE_PROFILE,
    days: {
      [TEST_DATE]: {
        date: TEST_DATE,
        meals: [{ id: 'm-orig', type: '午餐', text: 'Original day meal', time: '12:00', photo: null, photoErr: 'network', est: null }]
      },
      [OTHER_DATE]: {
        date: OTHER_DATE,
        meals: []
      }
    },
    assetsImpl: {
      upload(blob) {
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        deferreds.push({ tag: blob.tag, resolve });
        return promise;
      }
    }
  });
  await app.waitBoot();
  vm.runInContext(`
    compress2 = async file => ({ ok: true, blob: { tag: file.name, type: "image/jpeg" }, thumb: null });
    S.tab = "food";
    S.date = "${TEST_DATE}";
    S.mealMode = "manual";
    S.days["${TEST_DATE}"] = {
      date: "${TEST_DATE}",
      meals: [{ id: "m-orig", type: "午餐", text: "Original day meal", time: "12:00", photo: null, photoErr: "network", est: null }]
    };
    S.days["${OTHER_DATE}"] = { date: "${OTHER_DATE}", meals: [] };
    S.files["m-orig"] = { blob: { tag: "orig-retry.jpg", type: "image/jpeg" }, url: URL.createObjectURL({ tag: "orig-retry.jpg" }), key: "orig-retry-key-1234" };
    render();
  `, app.ctx);
  const origRetryUrl = app.createdUrls[0].url;

  // 1) Switch day while addMeal upload is in flight -> meal still writes to TEST_DATE, not OTHER_DATE
  await app.dispatchChange({ id: 'm-photo', dataset: {}, files: [{ name: 'day-bound.jpg', type: 'image/jpeg' }], value: 'day-bound.jpg' });
  app.mTextState.value = 'Bound to original date';
  const saveP = app.dispatchClick({ act: 'add-meal', v: 'manual' });
  await new Promise(r => setTimeout(r, 15));
  vm.runInContext(`S.date = "${OTHER_DATE}";`, app.ctx);
  deferreds.shift().resolve({ id: '1'.repeat(32) });
  await saveP;

  assert.equal(vm.runInContext(`S.days["${TEST_DATE}"].meals.some(m => m.text === "Bound to original date" && m.photo === "${'1'.repeat(32)}")`, app.ctx), true, 'saved meal must stay bound to original date');
  assert.equal(vm.runInContext(`S.days["${OTHER_DATE}"].meals.length`, app.ctx), 0, 'switched-to date must remain untouched');

  // 2) Switch day while retry-photo upload is in flight -> updates TEST_DATE meal, clears photoErr, and revokes fallback URL
  vm.runInContext(`S.date = "${TEST_DATE}";`, app.ctx);
  const retryP = app.dispatchClick({ act: 'retry-photo', v: 'm-orig' });
  await new Promise(r => setTimeout(r, 15));
  vm.runInContext(`S.date = "${OTHER_DATE}";`, app.ctx);
  deferreds.shift().resolve({ id: '2'.repeat(32) });
  await retryP;

  assert.equal(vm.runInContext(`S.days["${TEST_DATE}"].meals.find(m => m.id === "m-orig")?.photo`, app.ctx), '2'.repeat(32), 'retry must update meal on original date');
  assert.equal(vm.runInContext(`S.days["${TEST_DATE}"].meals.find(m => m.id === "m-orig")?.photoErr`, app.ctx), undefined);
  assert.ok(app.revokedUrls.includes(origRetryUrl), 'fallback URL revoked once original-date meal updated');
  assert.equal(vm.runInContext('S.files["m-orig"]?.url', app.ctx), null);

  // 3) Target meal deleted while retry-photo upload is in flight -> does not revoke fallback URL or toast photoSaved
  vm.runInContext(`
    S.date = "${TEST_DATE}";
    S.days["${TEST_DATE}"].meals.push({ id: "m-gone", type: "晚餐", text: "Will vanish", time: "19:00", photo: null, photoErr: "network", est: null });
    S.files["m-gone"] = { blob: { tag: "gone.jpg", type: "image/jpeg" }, url: URL.createObjectURL({ tag: "gone.jpg" }), key: "gone-retry-key-1234" };
  `, app.ctx);
  const goneUrl = app.createdUrls.at(-1).url;
  app.toastEl.textContent = '';
  const goneRetryP = app.dispatchClick({ act: 'retry-photo', v: 'm-gone' });
  await new Promise(r => setTimeout(r, 15));
  // Stored day no longer contains m-gone when updateDay runs
  app.storeData.set(`data/users/u1/app/days/${TEST_DATE}`, { date: TEST_DATE, meals: [] });
  deferreds.shift().resolve({ id: '3'.repeat(32) });
  await goneRetryP;

  assert.equal(app.revokedUrls.includes(goneUrl), false, 'must not revoke fallback if target meal was not updated');
  assert.equal(app.toastEl.textContent, '', 'must not toast photoSaved when target meal was missing');
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

test('headless Chromium 375px: localized photo pickers, persistent live region, submission attachments, same-file reselection, and axe-core in zh & en', async t => {
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

  // Generate distinct-dimension PNGs so outgoing uploads can be unambiguously verified
  const imgRemoved = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 220, g: 40, b: 40 } } }).png().toBuffer();
  const imgKept = await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 30, g: 130, b: 220 } } }).png().toBuffer();
  const imgExtra = await sharp({ create: { width: 36, height: 36, channels: 3, background: { r: 40, g: 170, b: 90 } } }).png().toBuffer();
  const imgFeedback = await sharp({ create: { width: 40, height: 24, channels: 3, background: { r: 160, g: 80, b: 200 } } }).png().toBuffer();

  const browser = await pw.chromium.launch({
    executablePath: pw.executablePath,
    headless: true,
    args: ['--no-sandbox']
  });
  t.after(async () => { await browser.close(); });

  // Register, verify, and complete setup once
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'en-US' });
    const page = await ctx.newPage();
    await page.goto(`${srv.base}/login.html?invite=${encodeURIComponent(invite.token)}&email=${encodeURIComponent(invite.email)}&lang=zh`);
    await page.locator('#n').fill('Picker Tester');
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
    await page.locator('button[type="submit"]').click();
    await page.locator('nav#tabs').waitFor({ state: 'visible' });
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
        return { id: el.id, w: r.width, h: r.height, ariaHidden: el.getAttribute('aria-hidden'), tabIndex: el.tabIndex };
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
    const assetUploads = [];
    const feedbackPayloads = [];

    await page.exposeFunction('recordPickerCSP', v => cspViolations.push(v));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', e => {
        window.recordPickerCSP(`${e.violatedDirective}: ${e.blockedURI}`);
      });
    });
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('request', req => {
      if (req.method() === 'POST' && req.url().endsWith('/api/feedback')) {
        feedbackPayloads.push(req.postDataJSON());
      }
    });
    page.on('response', async res => {
      const req = res.request();
      if (req.method() === 'POST' && req.url().endsWith('/api/assets') && res.status() === 200) {
        try {
          const json = await res.json();
          if (json?.id) assetUploads.push({ id: json.id, bytes: fs.readFileSync(path.join(srv.dir, 'blobs', json.id)) });
        } catch {}
      }
    });

    try {
      await page.goto(`${srv.base}/login.html?lang=${lang}`);
      await page.locator('#e').fill(invite.email);
      await page.locator('#p').fill(pwStr);
      await page.locator('#go').click();
      await page.locator('nav#tabs').waitFor({ state: 'visible' });
      await page.evaluate(async l => { await setLang(l, { persistProfile: false }); }, lang);

      // Keep a reference to the mounted #sr-status node to prove it is never replaced
      const hasSrNode = await page.evaluate(() => {
        window.__srRef = document.getElementById('sr-status');
        return !!window.__srRef && window.__srRef.getAttribute('role') === 'status';
      });
      assert.equal(hasSrNode, true, 'persistent #sr-status node must be mounted on boot');

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

      // Select 4 photos at once -> verify limit status, disabled picker, persistent #sr-status update, and focus target
      await fcSpace.setFiles([
        { name: 'one.png', mimeType: 'image/png', buffer: imgRemoved },
        { name: 'two.png', mimeType: 'image/png', buffer: imgKept },
        { name: 'three.png', mimeType: 'image/png', buffer: imgExtra },
        { name: 'four.png', mimeType: 'image/png', buffer: imgFeedback }
      ]);
      const maxExpected = lang === 'zh' ? '已选 4 张 · 最多 4 张' : '4 selected · Max 4 photos';
      assert.equal((await page.locator('#m-photo-status').innerText()).trim(), maxExpected);
      await page.waitForFunction(exp => document.getElementById('sr-status')?.textContent === exp, maxExpected);
      assert.equal(await page.evaluate(() => window.__srRef === document.getElementById('sr-status')), true, '#sr-status node must stay mounted across renders');
      assert.equal(await page.locator('#m-photo-btn').isDisabled(), true, 'picker disables at 4 photos');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'm-photo-rm-0', 'focus moves to first remove button at 4-photo limit');
      assert.equal(await page.locator('#m-photo-rm-0').getAttribute('aria-label'), lang === 'zh' ? '去掉第 1 张照片' : 'Remove photo 1');
      assert.equal(await page.locator('#m-photo-rm-1').getAttribute('aria-label'), lang === 'zh' ? '去掉第 2 张照片' : 'Remove photo 2');
      await assertAxeClean(context, page, `${labelPrefix}/food-4photos`);

      // Remove all 4 photos cleanly back to 0
      for (let i = 0; i < 4; i++) {
        await page.locator('[data-act="unpick"]').first().click();
      }
      assert.equal((await page.locator('#m-photo-status').innerText()).trim(), lang === 'zh' ? '未选择' : 'No photo selected');
      assert.equal(await page.locator('#m-photo-btn').isDisabled(), false);

      // End-to-end submission flow in light mode (zh & en): pick imgRemoved + imgKept, remove imgRemoved,
      // test same-file reselection, save meal, verify only kept image uploaded & draft resets,
      // attach extra photo to saved meal, and submit feedback with screenshot.
      if (colorScheme === 'light') {
        assetUploads.length = 0;
        feedbackPayloads.length = 0;

        // 1) Pick imgRemoved + imgKept, then remove imgRemoved
        const [fcTwo] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.locator('#m-photo-btn').click()
        ]);
        await fcTwo.setFiles([
          { name: 'removed.png', mimeType: 'image/png', buffer: imgRemoved },
          { name: 'kept.png', mimeType: 'image/png', buffer: imgKept }
        ]);
        assert.equal((await page.locator('#m-photo-status').innerText()).trim(), lang === 'zh' ? '已选 2 张' : '2 selected');
        await assertAxeClean(context, page, `${labelPrefix}/food-2photos`);

        // Remove imgRemoved (index 0), then also remove imgKept and re-pick the EXACT same file (same-file reselection)
        await page.locator('#m-photo-rm-0').click();
        assert.equal((await page.locator('#m-photo-status').innerText()).trim(), lang === 'zh' ? '已选 1 张' : '1 selected');
        await page.locator('#m-photo-rm-0').click();
        assert.equal((await page.locator('#m-photo-status').innerText()).trim(), lang === 'zh' ? '未选择' : 'No photo selected');

        const [fcReselect] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.locator('#m-photo-btn').click()
        ]);
        await fcReselect.setFiles({ name: 'kept.png', mimeType: 'image/png', buffer: imgKept });
        assert.equal((await page.locator('#m-photo-status').innerText()).trim(), lang === 'zh' ? '已选 1 张' : '1 selected');

        // Save meal in manual mode
        await page.locator('[data-act="mmode"][data-v="manual"]').click();
        const mealLabel = `Picker meal ${lang}`;
        await page.locator('#m-text').fill(mealLabel);
        await page.locator('#mf-kcal').fill('480');
        await page.locator('[data-act="add-meal"]').click();
        await page.locator('.meal p.small').filter({ hasText: mealLabel }).waitFor();

        // Draft resets cleanly
        assert.equal((await page.locator('#m-photo-status').innerText()).trim(), lang === 'zh' ? '未选择' : 'No photo selected');
        assert.equal(await page.locator('.previews figure').count(), 0);
        assert.equal(await page.locator('#m-photo-btn').isDisabled(), false);

        // Verify outgoing /api/assets upload contains ONLY imgKept (48x32) and NOT imgRemoved (20x20)
        assert.equal(assetUploads.length, 1, 'exactly 1 photo should have been uploaded (removed image must be absent)');
        const uploadedMeta = await sharp(assetUploads[0].bytes).metadata();
        assert.equal(uploadedMeta.width, 48, 'uploaded meal image width matches kept image');
        assert.equal(uploadedMeta.height, 32, 'uploaded meal image height matches kept image');

        // 2) Attach an extra photo to the saved meal via its localized "+ Photo" button
        const savedMealCard = page.locator('.meal').filter({ hasText: mealLabel });
        const addMoreBtn = savedMealCard.locator('[data-act="pick-file"]');
        const [fcMore] = await Promise.all([
          page.waitForEvent('filechooser'),
          addMoreBtn.click()
        ]);
        assert.equal(fcMore.isMultiple(), false, 'meal card add-photo input stays single-file');
        await fcMore.setFiles({ name: 'extra.png', mimeType: 'image/png', buffer: imgExtra });
        await savedMealCard.locator('.more img').waitFor({ state: 'visible' });
        assert.equal(assetUploads.length, 2, 'extra photo uploaded to /api/assets');
        const extraMeta = await sharp(assetUploads[1].bytes).metadata();
        assert.equal(extraMeta.width, 36);
        assert.equal(extraMeta.height, 36);
      }

      // 3) Feedback screenshot picker on Me tab
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
      await fcUfb.setFiles({ name: 'bug.png', mimeType: 'image/png', buffer: imgFeedback });

      assert.equal((await page.locator('#ufb-file-btn').innerText()).trim(), lang === 'zh' ? '换一张截图' : 'Replace screenshot');
      assert.equal((await page.locator('#ufb-shot-status').innerText()).trim(), lang === 'zh' ? '已选 1 张' : '1 selected');
      await page.waitForFunction(exp => document.getElementById('sr-status')?.textContent === exp, lang === 'zh' ? '已选 1 张' : '1 selected');
      assert.equal(await page.locator('#tester-fb-card .previews img.preview').count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal overflow on ${labelPrefix}/ufb-selected`);
      await assertAxeClean(context, page, `${labelPrefix}/ufb-selected`);

      // Remove screenshot, verify same-file reselection, then submit feedback in light mode
      await page.locator('[data-act="ufb-unpick"]').click();
      assert.equal((await page.locator('#ufb-shot-status').innerText()).trim(), lang === 'zh' ? '未选择' : 'No photo selected');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'ufb-file-btn');

      if (colorScheme === 'light') {
        const [fcUfbAgain] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.locator('#ufb-file-btn').click()
        ]);
        await fcUfbAgain.setFiles({ name: 'bug.png', mimeType: 'image/png', buffer: imgFeedback });
        assert.equal((await page.locator('#ufb-shot-status').innerText()).trim(), lang === 'zh' ? '已选 1 张' : '1 selected');

        await page.locator('#ufb-msg').fill(`Feedback with screenshot (${lang})`);
        await page.locator('[data-act="ufb-submit"]').click();
        await page.locator('[data-act="ufb-open"]').waitFor({ state: 'visible' });
        assert.equal(feedbackPayloads.length, 1);
        assert.match(feedbackPayloads[0].screenshot?.contentType || '', /^image\/(jpeg|png)$/);
        const shotMeta = await sharp(Buffer.from(feedbackPayloads[0].screenshot.dataBase64, 'base64')).metadata();
        assert.equal(shotMeta.width, 40);
        assert.equal(shotMeta.height, 24);
      }

      assert.equal(await page.evaluate(() => window.__srRef === document.getElementById('sr-status')), true, '#sr-status node never unmounted');
      assert.deepEqual(cspViolations, [], `CSP violations in ${labelPrefix}`);
      assert.deepEqual(pageErrors, [], `Page errors in ${labelPrefix}`);
    } finally {
      await context.close();
    }
  }
});
