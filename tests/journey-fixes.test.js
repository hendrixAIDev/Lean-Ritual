'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp({ storeImpl, assetsImpl, elements = {}, fastTimers = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  const fullScript = source.match(/<script>([\s\S]*?)<\/script>/)[1];
  const pageScript = fullScript.split('/* ============ 启动 ============ */')[0];

  const storage = new Map();
  const listeners = {};
  const toasts = [];
  const appEl = { innerHTML: '' };
  const tabsEl = { innerHTML: '', hidden: true };
  const toastEl = {
    hidden: true,
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); toasts.push(this._text); }
  };

  const baseElements = {
    '#app': appEl,
    '#tabs': tabsEl,
    '#toast': toastEl,
    ...elements
  };

  const ctx = vm.createContext({
    window: { scrollTo() {}, ritual: { hosted: true } },
    location: { href: '/', reload() {} },
    FormData: class {
      constructor(form) { this._data = form._data || {}; }
      get(k) { const v = this._data[k]; return Array.isArray(v) ? v[0] : (v ?? null); }
      getAll(k) { const v = this._data[k]; return Array.isArray(v) ? v : (v != null ? [v] : []); }
    },
    Blob,
    URL: {
      createObjectURL: () => 'blob:local-test',
      revokeObjectURL: () => {}
    },
    Image: class {
      set src(_) { setTimeout(() => this.onload && this.onload(), 0); }
      get width() { return 20; }
      get height() { return 20; }
    },
    document: {
      addEventListener(type, fn) { listeners[type] = fn; },
      querySelector(sel) { return baseElements[sel] || null; },
      getElementById(id) { return baseElements['#' + id] || null; },
      createElement(tag) {
        if (tag === 'canvas') {
          return {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage() {} }),
            toBlob: cb => cb({ type: 'image/jpeg', size: 12 }),
            toDataURL: () => 'data:image/jpeg;base64,AA=='
          };
        }
        return {};
      }
    },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    console: { ...console, warn() {}, error() {} },
    Date,
    setTimeout: fastTimers ? (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)) : setTimeout,
    clearTimeout
  });

  vm.runInContext(pageScript, ctx);
  ctx.__store = storeImpl || { async get() { return null; }, async set() {} };
  ctx.__assets = assetsImpl || null;
  vm.runInContext(`
    storageUser = "u_test";
    S.uid = "u_test";
    S.ready = true;
    S.cloud = true;
    S.store = __store;
    S.assets = __assets;
  `, ctx);

  const clickAct = (act, v) => {
    const btn = {
      dataset: { act, ...(v !== undefined ? { v: String(v) } : {}) },
      disabled: false,
      closest(sel) { return sel === '[data-act]' ? btn : null; }
    };
    return listeners.click({ target: btn }).then(() => btn);
  };

  return { ctx, appEl, tabsEl, toastEl, toasts, listeners, baseElements, clickAct };
}

test('rapid overlapping check-in saves preserve latest input and never revert to stale response', async () => {
  const resolvers = [];
  const serverDocs = new Map();
  const weightEl = { id: 'c-weight', value: '72.1', dataset: {} };
  const stepsEl = { id: 'c-steps', value: '8000', dataset: {} };
  const sleepEl = { id: 'c-sleep', value: '7.5', dataset: {} };
  const bfEl = { id: 'c-bf', value: '', dataset: {} };

  const { ctx, appEl, listeners, clickAct } = loadApp({
    elements: { '#c-weight': weightEl, '#c-steps': stepsEl, '#c-sleep': sleepEl, '#c-bf': bfEl },
    storeImpl: {
      async get(p) { return serverDocs.get(p) || null; },
      set(p, data) {
        return new Promise(resolve => {
          resolvers.push(() => { serverDocs.set(p, JSON.parse(JSON.stringify(data))); resolve(); });
        });
      }
    }
  });
  vm.runInContext(`
    S.profile = {sex:"m",age:28,height:176,weight:72.5,trainDays:[1,3,5],slot:"eve",stage:"auto",exp:"new",equipment:"gym",startDate:"2026-11-01",injuries:[],supps:[]};
    S.tab = "today";
  `, ctx);

  // Trigger first save with steps = 8000
  listeners.input({ target: stepsEl });
  const save1 = clickAct('save-checkin');
  await new Promise(r => setImmediate(r));

  // Before save1 finishes, user types 8011 into #c-steps and clicks save again
  stepsEl.value = '8011';
  listeners.input({ target: stepsEl });
  const save2 = clickAct('save-checkin');
  await new Promise(r => setImmediate(r));

  // User also starts typing 8012 before save1 resolves
  stepsEl.value = '8012';
  listeners.input({ target: stepsEl });

  // Resolve save1, then save2
  assert.equal(resolvers.length, 1);
  resolvers.shift()();
  await save1;
  await new Promise(r => setImmediate(r));
  assert.equal(resolvers.length, 1);
  resolvers.shift()();
  await save2;

  const date = vm.runInContext('S.date', ctx);
  assert.equal(serverDocs.get('days/' + date).checkin.steps, 8011);
  assert.equal(vm.runInContext('S.days[S.date].checkin.steps', ctx), 8011);
  // Rendered input must keep the newer unsaved edit 8012 rather than clobbering with 8000 or 8011
  assert.match(appEl.innerHTML, /id="c-steps"[^>]*value="8012"/);
});

test('failed writes when offline do not show false saved states or discard onboarding/form inputs', async () => {
  const errEl = { hidden: true, textContent: '' };
  const weightEl = { id: 'c-weight', value: '73.2', dataset: {} };
  const sleepEl = { id: 'c-sleep', value: '8', dataset: {} };
  const mTextEl = { id: 'm-text', value: '断网餐食', dataset: {} };
  const { ctx, appEl, tabsEl, listeners, clickAct } = loadApp({
    elements: { '#setup-err': errEl, '#c-weight': weightEl, '#c-sleep': sleepEl, '#m-text': mTextEl },
    storeImpl: {
      async get() { throw { code: 'network', message: '连不上服务器' }; },
      async set() { throw { code: 'network', message: '连不上服务器' }; }
    }
  });

  // 1. Onboarding failure keeps S.profile null and keeps #setup visible
  const submitBtn = { disabled: false };
  await vm.runInContext('submitSetup', ctx)({
    _data: { sex: 'm', age: '29', height: '178', weight: '74', bf: '', steps: '9500', exp: 'new', stage: 'auto', trainDays: ['1', '3', '5'], slot: 'eve', equipment: 'gym' },
    querySelector: () => submitBtn
  });
  assert.equal(vm.runInContext('S.profile', ctx), null);
  assert.equal(tabsEl.hidden, true);
  assert.equal(submitBtn.disabled, false);

  // Now set up a loaded profile to test checkin, meal, and workout failures
  vm.runInContext(`
    S.profile = {sex:"m",age:29,height:178,weight:74,trainDays:[0,1,2,3,4,5,6],slot:"eve",stage:"auto",exp:"new",equipment:"gym",startDate:"2026-11-01",injuries:[],supps:[]};
    S.tab = "today";
    render();
  `, ctx);

  // 2. Check-in failure does not mark day as 已记录, while keeping typed input in viewToday()
  listeners.input({ target: weightEl });
  listeners.input({ target: sleepEl });
  await clickAct('save-checkin');
  assert.equal(vm.runInContext('S.days[S.date]?.checkin', ctx), undefined);
  assert.doesNotMatch(appEl.innerHTML, /已记录/);
  assert.match(vm.runInContext('viewToday()', ctx), /id="c-weight"[^>]*value="73\.2"/);

  // 3. Workout save failure does not mark workout 已完成
  vm.runInContext(`
    const pl = planFor(S.date), dr = getDraft(S.date, pl);
    dr.exercises[0].sets[0] = { w: "60", r: "6" };
    persistDrafts();
  `, ctx);
  await clickAct('save-workout');
  assert.equal(vm.runInContext('Boolean(S.days[S.date]?.workout?.done)', ctx), false);
  assert.doesNotMatch(vm.runInContext('viewToday()', ctx), /<span class="chip on">已完成<\/span>/);

  // 4. Meal save failure does not insert a phantom meal into S.days[date].meals
  vm.runInContext('S.tab = "food"; S.mfill = { kcal: "500" }; lsSet("bj-mtext", "断网餐食"); render();', ctx);
  await clickAct('add-meal', 'manual');
  assert.equal(vm.runInContext('(S.days[S.date]?.meals || []).length', ctx), 0);
  assert.equal(vm.runInContext('lsGet("bj-mtext", "")', ctx), '断网餐食');
});

test('double-clicking add-meal guards concurrent execution and uploads photo only once', async () => {
  let uploadCalls = 0;
  let savedDay = null;
  const mTextEl = { id: 'm-text', value: '双击带图餐' };
  const { ctx, clickAct } = loadApp({
    elements: { '#m-text': mTextEl },
    assetsImpl: {
      async upload() {
        uploadCalls++;
        await new Promise(r => setTimeout(r, 20));
        return { id: 'a'.repeat(32) };
      }
    },
    storeImpl: {
      async get() { return savedDay; },
      async set(_, data) {
        await new Promise(r => setTimeout(r, 10));
        savedDay = JSON.parse(JSON.stringify(data));
      }
    }
  });
  vm.runInContext(`
    S.profile = {sex:"m",age:28,height:176,weight:72,trainDays:[1,3,5],slot:"eve",stage:"auto",exp:"new",equipment:"gym",startDate:"2026-11-01",injuries:[],supps:[]};
    S.tab = "food";
    S.pendingPhotos = [{ file: { name: "meal.jpg", type: "image/jpeg" }, url: "blob:preview-1" }];
    S.mfill = { kcal: "400" };
  `, ctx);

  await Promise.all([clickAct('add-meal', 'manual'), clickAct('add-meal', 'manual')]);
  assert.equal(uploadCalls, 1);
  assert.equal(savedDay.meals.length, 1);
  assert.equal(savedDay.meals[0].text, '双击带图餐');
  assert.doesNotMatch(vm.runInContext('viewFood()', ctx), /保存中…|data-act="add-meal"[^>]*disabled/);
});

test('photo upload retries transient network errors and surfaces clean Chinese message without overwriting toast', async () => {
  let attempts = 0;
  let savedDay = null;
  const mTextEl = { id: 'm-text', value: '短暂断网带图餐', dataset: {} };
  const { ctx, clickAct } = loadApp({
    fastTimers: true,
    elements: { '#m-text': mTextEl },
    assetsImpl: {
      async upload() {
        attempts++;
        if (attempts === 1) throw { code: 'network', message: '连不上服务器' };
        return { id: 'b'.repeat(32) };
      }
    },
    storeImpl: {
      async get() { return savedDay; },
      async set(_, data) { savedDay = JSON.parse(JSON.stringify(data)); }
    }
  });
  vm.runInContext(`
    S.profile = {sex:"m",age:28,height:176,weight:72,trainDays:[1,3,5],slot:"eve",stage:"auto",exp:"new",equipment:"gym",startDate:"2026-11-01",injuries:[],supps:[]};
    S.tab = "food";
    S.pendingPhotos = [{ file: { name: "meal.jpg", type: "image/jpeg" }, url: "blob:preview-1" }];
    S.mfill = { kcal: "410" };
  `, ctx);

  await clickAct('add-meal', 'manual');
  assert.equal(attempts, 2);
  assert.equal(savedDay.meals[0].photo, 'b'.repeat(32));
  assert.equal(savedDay.meals[0].photoErr, undefined);

  // Now simulate persistent upload failure while doc write succeeds: toast must not be overwritten by "已记下",
  // and PHOTO_ERR / mealCard must not show raw "错误码 network" or tell user to click nonexistent "重传照片" after reload.
  const failApp = loadApp({
    fastTimers: true,
    elements: { '#m-text': { id: 'm-text', value: '照片上传失败餐', dataset: {} } },
    assetsImpl: { async upload() { throw { code: 'network', message: '连不上服务器' }; } },
    storeImpl: {
      async get() { return savedDay; },
      async set(_, data) { savedDay = JSON.parse(JSON.stringify(data)); }
    }
  });
  vm.runInContext(`
    S.profile = {sex:"m",age:28,height:176,weight:72,trainDays:[1,3,5],slot:"eve",stage:"auto",exp:"new",equipment:"gym",startDate:"2026-11-01",injuries:[],supps:[]};
    S.tab = "food";
    S.pendingPhotos = [{ file: { name: "meal2.jpg", type: "image/jpeg" }, url: "blob:preview-2" }];
    S.mfill = { kcal: "300" };
  `, failApp.ctx);
  await failApp.clickAct('add-meal', 'manual');
  assert.notEqual(failApp.toasts.at(-1), '已记下');
  assert.doesNotMatch(failApp.toasts.at(-1), /network/);

  // Simulate page reload where S.files is empty
  vm.runInContext('S.files = {}; render();', failApp.ctx);
  assert.doesNotMatch(failApp.appEl.innerHTML, /错误码 network/);
  assert.doesNotMatch(failApp.appEl.innerHTML, /重传照片/);
  assert.match(failApp.appEl.innerHTML, /\+ 照片/);
});

test('login.html shows Chinese offline message instead of raw Failed to fetch when network fails', async () => {
  const loginHtml = fs.readFileSync(path.join(__dirname, '../public/login.html'), 'utf8');
  const script = loginHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {
    '#n': { value: '' },
    '#e': { value: 'user@example.com', required: true },
    '#p': { value: 'strong-password-1234', required: true, autocomplete: '' },
    '#i': { value: '' },
    '#nw': { hidden: true },
    '#ew': { hidden: false },
    '#pw': { hidden: false },
    '#iw': { hidden: true },
    '#err': { textContent: '' },
    '#go': { textContent: '登录', disabled: false },
    '#tabs': { onclick: null },
    '#forgot': { onclick: null },
    '#resend': { onclick: null },
    '#f': { onsubmit: null }
  };
  const ctx = vm.createContext({
    location: { search: '', replace() {} },
    history: { replaceState() {} },
    URLSearchParams,
    Error,
    fetch: async () => { throw new TypeError('Failed to fetch'); },
    document: {
      querySelector: s => els[s],
      querySelectorAll: () => []
    }
  });
  vm.runInContext(script, ctx);
  await els['#f'].onsubmit({ preventDefault() {} });
  assert.equal(els['#err'].textContent, '连不上服务器。');
  assert.equal(els['#go'].disabled, false);
});
