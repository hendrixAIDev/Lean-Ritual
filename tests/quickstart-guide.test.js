'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;

function extractInlineScript(html) {
  const matches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const inline = matches.find(m => !/\bsrc\s*=/i.test(m[1]));
  assert.ok(inline, 'expected inline <script> block');
  return inline[2];
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
  const storage = {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    dump() { return Object.fromEntries(map.entries()); }
  };
  return new Proxy(storage, {
    ownKeys() { return Array.from(map.keys()); },
    getOwnPropertyDescriptor(_, prop) {
      if (map.has(prop)) return { enumerable: true, configurable: true, value: map.get(prop) };
      return undefined;
    }
  });
}

function makeMemoryStore(initialDocs = {}) {
  const docs = new Map(Object.entries(initialDocs).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const writes = [];
  return {
    docs,
    writes,
    async get(p) { return docs.has(p) ? clone(docs.get(p)) : null; },
    async set(p, d) { writes.push({ op: 'set', path: p }); docs.set(p, clone(d)); },
    async del(p) { writes.push({ op: 'del', path: p }); docs.delete(p); },
    async commit(changes) {
      for (const ch of changes) {
        const cur = docs.has(ch.path) ? docs.get(ch.path) : null;
        if (JSON.stringify(cur) !== JSON.stringify(ch.before ?? null)) {
          const err = new Error('conflict');
          err.code = 'doc_conflict';
          throw err;
        }
      }
      for (const ch of changes) {
        if (ch.after !== undefined) {
          writes.push({ op: 'commit', path: ch.path });
          docs.set(ch.path, clone(ch.after));
        }
      }
    },
    async list(col) {
      const prefix = col + '/';
      const out = [];
      for (const [k, v] of docs.entries()) {
        if (k.startsWith(prefix)) out.push({ id: k.slice(prefix.length), data: clone(v) });
      }
      return out;
    }
  };
}

function mountEnv({
  lang = 'zh',
  uid = 'u1',
  fixedIso = '2026-11-20T12:00:00Z', // 2026-11-20 is Friday (day 5: workout day on [1,3,5]; 2026-11-21 Saturday: rest day)
  store = null,
  initialDocs = {},
  localStorage = null,
  standaloneMatchMedia = false,
  navigatorStandalone = false
} = {}) {
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

  const memStore = store || makeMemoryStore(initialDocs);
  const ls = localStorage || makeStorage({ 'bj-lang': lang });
  const ss = makeStorage({});
  const docListeners = {};
  const toasts = [];
  const announcements = [];
  const focused = [];
  const scrolled = [];
  const scrollToCalls = [];
  const liveInputs = new Map();

  const appEl = { id: 'app', innerHTML: '', contains: () => false };
  const tabsEl = { id: 'tabs', innerHTML: '', hidden: true, setAttribute() {} };
  const toastEl = {
    id: 'toast',
    _text: '',
    hidden: true,
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); if (this._text) toasts.push(this._text); }
  };
  const srEl = {
    id: 'sr-status',
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); if (this._text) announcements.push(this._text); }
  };
  const setupErrEl = { id: 'setup-err', hidden: true, textContent: '' };

  function makeMockNode(id) {
    const existing = liveInputs.get(id);
    if (existing) return existing;
    const escId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tagMatch = appEl.innerHTML.match(new RegExp(`<[^>]+\\bid="${escId}"[^>]*>`));
    const valMatch = tagMatch ? tagMatch[0].match(/\bvalue="([^"]*)"/) : null;
    const node = {
      id,
      value: valMatch ? valMatch[1] : '',
      dataset: {},
      disabled: false,
      focus() { focused.push('#' + id); },
      scrollIntoView(opts) { scrolled.push({ id: '#' + id, opts }); }
    };
    return node;
  }

  function hasIdInHtml(id) {
    return new RegExp(`\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(appEl.innerHTML);
  }

  function querySelector(sel) {
    if (sel === '#app') return appEl;
    if (sel === '#tabs') return tabsEl;
    if (sel === '#toast') return toastEl;
    if (sel === '#sr-status') return srEl;
    if (sel === '#setup-err') return setupErrEl;
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      if (liveInputs.has(id) && hasIdInHtml(id)) return liveInputs.get(id);
      if (hasIdInHtml(id)) return makeMockNode(id);
      return null;
    }
    if (sel === 'input[name="mtype"]:checked') {
      const m = appEl.innerHTML.match(/name="mtype"\s+value="([^"]+)"\s+checked/);
      return m ? { value: m[1] } : null;
    }
    const actMatch = sel.match(/^\[data-act="([^"]+)"\](?:\[data-v="([^"]+)"\])?$/);
    if (actMatch) {
      const [, act, dv] = actMatch;
      const re = dv != null
        ? new RegExp(`data-act="${act}"[^>]*data-v="${dv}"|data-v="${dv}"[^>]*data-act="${act}"`)
        : new RegExp(`data-act="${act}"`);
      if (re.test(appEl.innerHTML)) {
        return {
          focus() { focused.push(sel); },
          scrollIntoView(opts) { scrolled.push({ id: sel, opts }); }
        };
      }
    }
    return null;
  }

  const document = {
    documentElement: { lang: lang === 'en' ? 'en' : 'zh-CN' },
    title: '',
    activeElement: null,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    querySelector,
    querySelectorAll() { return []; },
    getElementById: id => querySelector('#' + id),
    createElement(tag) { return { tagName: tag.toUpperCase(), className: '', textContent: '' }; }
  };

  const window = {
    location: { href: `http://127.0.0.1/?lang=${lang}`, search: `?lang=${lang}`, hostname: '127.0.0.1', reload() {}, replace() {} },
    scrollTo(x, y) { scrollToCalls.push([x, y]); },
    matchMedia(q) {
      if (q === '(display-mode: standalone)') return { matches: !!standaloneMatchMedia };
      return { matches: false };
    },
    addEventListener() {},
    ritual: { hosted: true, logout: async () => {} }
  };

  const navigator = {
    userAgent: 'node-test',
    languages: [lang === 'en' ? 'en-US' : 'zh-CN'],
    standalone: !!navigatorStandalone
  };

  const ctx = vm.createContext({
    window,
    document,
    location: window.location,
    localStorage: ls,
    sessionStorage: ss,
    navigator,
    FormData: class {
      constructor(form) { this._data = form._data || {}; }
      get(k) { const v = this._data[k]; return Array.isArray(v) ? v[0] : (v ?? null); }
      getAll(k) { const v = this._data[k]; return Array.isArray(v) ? v : (v != null ? [v] : []); }
    },
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
    AbortController,
    encodeURIComponent,
    decodeURIComponent,
    isNaN,
    parseFloat,
    parseInt,
    console: { ...console, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  });

  vm.runInContext(script, ctx);
  ctx.__store = memStore;
  vm.runInContext(`
    storageUser = ${JSON.stringify(uid)};
    S.uid = ${JSON.stringify(uid)};
    S.cloud = true;
    S.store = __store;
    S.ready = true;
  `, ctx);

  async function click(act, v) {
    const btn = {
      dataset: { act, ...(v !== undefined ? { v: String(v) } : {}) },
      disabled: false,
      closest(sel) { return sel === '[data-act]' ? btn : null; }
    };
    for (const fn of docListeners.click || []) await fn({ target: btn });
    return btn;
  }

  function setInput(id, value, dataset = {}) {
    const node = {
      id,
      value: String(value),
      dataset,
      disabled: false,
      focus() { focused.push('#' + id); },
      scrollIntoView(opts) { scrolled.push({ id: '#' + id, opts }); }
    };
    liveInputs.set(id, node);
    for (const fn of docListeners.input || []) fn({ target: node });
    return node;
  }

  async function submitForm(data) {
    const btn = { disabled: false };
    await vm.runInContext('submitSetup', ctx)({
      _data: data,
      querySelector: () => btn
    });
  }

  return {
    ctx,
    store: memStore,
    localStorage: ls,
    appEl,
    tabsEl,
    toasts,
    announcements,
    focused,
    scrolled,
    scrollToCalls,
    click,
    setInput,
    submitForm,
    async loadAndRender() {
      await vm.runInContext('loadAll()', ctx);
      vm.runInContext('render()', ctx);
    }
  };
}

const BASE_SETUP_DATA = {
  sex: 'm',
  age: '28',
  height: '176',
  weight: '72',
  bf: '15',
  steps: '9500',
  exp: 'new',
  stage: 'cut',
  trainDays: ['1', '3', '5'],
  slot: 'eve',
  equipment: 'gym',
  injuries: [],
  injNote: '',
  supps: ['creatine', 'protein']
};

test('1. Brand-new setup sets guideDismissed=false and renders Quick Start at 1/4 in zh and en', async () => {
  for (const lang of ['zh', 'en']) {
    const env = mountEnv({ lang });
    await env.loadAndRender();
    assert.equal(vm.runInContext('S.profile', env.ctx), null);

    await env.submitForm(BASE_SETUP_DATA);

    const profile = await env.store.get('app/profile');
    assert.equal(profile.guideDismissed, false, `brand-new setup should set guideDismissed=false (${lang})`);
    assert.equal(vm.runInContext('S.tab', env.ctx), 'today');
    assert.equal(vm.runInContext('isQuickstartVisible()', env.ctx), true);
    assert.equal(vm.runInContext('quickstartDoneCount()', env.ctx), 1);

    const html = env.appEl.innerHTML;
    assert.match(html, /id="quickstart-card"/);
    assert.match(html, /role="progressbar"[^>]*aria-valuemin="0"[^>]*aria-valuemax="4"[^>]*aria-valuenow="1"/);
    assert.match(html, /1 \/ 4/);
    assert.match(html, /data-act="qs-go-checkin"/);
    assert.match(html, /data-act="qs-go-meal"/);
    assert.match(html, /data-act="qs-go-workout"/);
    assert.match(html, /id="qs-tip-feedback"/);
    assert.match(html, /id="qs-tip-a2hs"/);
    // Step badges must be non-interactive status indicators, not buttons/checkboxes
    assert.doesNotMatch(html, /<input[^>]*class="qs-badge"|<button[^>]*class="qs-badge"/);

    if (lang === 'zh') {
      assert.match(html, /新手快速上手/);
      assert.match(html, /生成专属训练与饮食计划/);
      assert.match(html, /去打卡 →/);
      assert.match(html, /去记饮食 →/);
      assert.match(html, /看今日课表 →/);
    } else {
      assert.match(html, /Quick Start/);
      assert.match(html, /Build your baseline plan/);
      assert.match(html, /Check in →/);
      assert.match(html, /Log meal →/);
      assert.match(html, /View today&#39;s plan →|View today's plan →/);
      // Zero CJK leakage in rendered Quick Start card in English mode
      const qsHtml = html.match(/<section[^>]*id="quickstart-card"[\s\S]*?<\/section>/)?.[0] || '';
      assert.ok(qsHtml.length > 0);
      assert.doesNotMatch(qsHtml, CJK_RE, 'English Quick Start card must not leak Chinese');
    }
  }
});

test('2. Persistence across reload, cloud+local dismissal, and Me reopen flow', async () => {
  const sharedStore = makeMemoryStore();
  const sharedLs = makeStorage({ 'bj-lang': 'zh' });

  // First session: complete setup, verify visible
  const s1 = mountEnv({ store: sharedStore, localStorage: sharedLs });
  await s1.submitForm(BASE_SETUP_DATA);
  assert.match(s1.appEl.innerHTML, /id="quickstart-card"/);

  // Reload without dismissing: must remain visible
  const s2 = mountEnv({ store: sharedStore, localStorage: sharedLs });
  await s2.loadAndRender();
  assert.equal(vm.runInContext('isQuickstartVisible()', s2.ctx), true);
  assert.match(s2.appEl.innerHTML, /id="quickstart-card"/);

  // Go to Me while visible: reopen button must NOT appear
  await s2.click('tab', 'me');
  assert.doesNotMatch(s2.appEl.innerHTML, /data-act="qs-reopen"/);

  // Return to Today and dismiss
  await s2.click('tab', 'today');
  await s2.click('qs-dismiss');
  assert.equal(vm.runInContext('isQuickstartVisible()', s2.ctx), false);
  assert.doesNotMatch(s2.appEl.innerHTML, /id="quickstart-card"/);
  assert.equal((await sharedStore.get('app/profile')).guideDismissed, true);
  assert.equal(sharedLs.getItem('bj-user:u1:bj-guide-dismissed'), '"1"');
  assert.ok(s2.toasts.some(m => m.includes('已收起新手指引')), 'dismiss toast should be shown');
  assert.ok(s2.announcements.some(m => m.includes('已收起新手指引')), 'dismiss announcement should be spoken');

  // Reload after dismiss: must stay hidden even on a fresh browser (empty localStorage)
  const s3 = mountEnv({ store: sharedStore, localStorage: makeStorage({ 'bj-lang': 'zh' }) });
  await s3.loadAndRender();
  assert.equal(vm.runInContext('isQuickstartVisible()', s3.ctx), false);
  assert.doesNotMatch(s3.appEl.innerHTML, /id="quickstart-card"/);

  // Open Me: reopen button IS visible under 纲领与帮助
  await s3.click('tab', 'me');
  assert.match(s3.appEl.innerHTML, /纲领与帮助/);
  assert.match(s3.appEl.innerHTML, /data-act="qs-reopen"/);
  assert.match(s3.appEl.innerHTML, /重新打开新手指引/);

  // Click reopen: clears local flag, sets guideDismissed=false in cloud, jumps to Today, focuses #qs-heading
  s3.focused.length = 0;
  await s3.click('qs-reopen');
  assert.equal(vm.runInContext('S.tab', s3.ctx), 'today');
  assert.equal(vm.runInContext('isQuickstartVisible()', s3.ctx), true);
  assert.equal((await sharedStore.get('app/profile')).guideDismissed, false);
  assert.match(s3.appEl.innerHTML, /id="quickstart-card"/);
  assert.ok(s3.focused.includes('#qs-heading'), `expected focus on #qs-heading, got ${JSON.stringify(s3.focused)}`);
  assert.ok(s3.scrollToCalls.some(([x, y]) => x === 0 && y === 0), 'reopen should scroll to top');

  // Reload after reopen: remains visible
  const s4 = mountEnv({ store: sharedStore, localStorage: makeStorage({ 'bj-lang': 'zh' }) });
  await s4.loadAndRender();
  assert.equal(vm.runInContext('isQuickstartVisible()', s4.ctx), true);
  assert.match(s4.appEl.innerHTML, /id="quickstart-card"/);

  // User-scoped local fallback hides card when cloud profile still has guideDismissed=undefined
  const fallbackStore = makeMemoryStore({
    'app/profile': {
      sex: 'm', age: 28, height: 176, weight: 72, bf: 15, steps: 9500,
      exp: 'new', stage: 'cut', trainDays: [1, 3, 5], slot: 'eve', equipment: 'gym',
      startDate: '2026-11-19', injuries: [], supps: []
    }
  });
  const fallbackLs = makeStorage({ 'bj-lang': 'zh', 'bj-user:u1:bj-guide-dismissed': '"1"' });
  const s5 = mountEnv({ store: fallbackStore, localStorage: fallbackLs });
  await s5.loadAndRender();
  assert.equal(vm.runInContext('isQuickstartVisible()', s5.ctx), false, 'local fallback hides card when cloud guideDismissed is undefined');
  assert.doesNotMatch(s5.appEl.innerHTML, /id="quickstart-card"/);
});

test('3a. Live auto-progression 1/4 -> 2/4 (checkin) -> 3/4 (meal) -> 4/4 celebration (strength workout)', async () => {
  const env = mountEnv({ lang: 'zh', fixedIso: '2026-11-20T12:00:00Z' }); // Friday workout day
  await env.submitForm(BASE_SETUP_DATA);
  assert.equal(vm.runInContext('quickstartDoneCount()', env.ctx), 1);
  assert.match(env.appEl.innerHTML, /1 \/ 4/);

  // Step 2: Save check-in -> 2/4
  env.setInput('c-weight', '71.8');
  env.setInput('c-steps', '9200');
  await env.click('save-checkin');
  assert.equal(vm.runInContext('quickstartDoneCount()', env.ctx), 2);
  assert.match(env.appEl.innerHTML, /2 \/ 4/);
  assert.doesNotMatch(env.appEl.innerHTML, /data-act="qs-go-checkin"/);
  assert.match(env.appEl.innerHTML, /data-act="qs-go-meal"/);

  // Step 3: Add a meal -> 3/4
  await env.click('tab', 'food');
  env.setInput('m-text', '鸡胸肉糙米饭');
  env.setInput('mf-kcal', '550', { mf: 'kcal' });
  env.setInput('mf-protein', '45', { mf: 'protein' });
  await env.click('add-meal', 'manual');
  await env.click('tab', 'today');
  assert.equal(vm.runInContext('quickstartDoneCount()', env.ctx), 3);
  assert.match(env.appEl.innerHTML, /3 \/ 4/);
  assert.doesNotMatch(env.appEl.innerHTML, /data-act="qs-go-meal"/);
  assert.match(env.appEl.innerHTML, /data-act="qs-go-workout"/);

  // Step 4: Save a strength workout -> 4/4 celebration state
  vm.runInContext(`
    const pl = planFor(S.date), dr = getDraft(S.date, pl);
    dr.exercises[0].sets[0] = { w: "60", r: "6" };
    persistDrafts();
  `, env.ctx);
  await env.click('save-workout');
  assert.equal(vm.runInContext('quickstartDoneCount()', env.ctx), 4);
  assert.equal(vm.runInContext('isQuickstartVisible()', env.ctx), true, 'celebration state stays visible until dismissed');
  assert.match(env.appEl.innerHTML, /4 \/ 4/);
  assert.match(env.appEl.innerHTML, /qs-celebrate/);
  assert.match(env.appEl.innerHTML, /上手完成！你已跑通全部核心流程/);
  assert.match(env.appEl.innerHTML, /知道了，关闭指引/);
  assert.doesNotMatch(env.appEl.innerHTML, /qs-steps/, 'celebration state replaces long step list');
});

test('3b. Cardio session on a rest day also completes step 4 and triggers 4/4 celebration (including pre-existing <4 user)', async () => {
  const initialDocs = {
    'app/profile': {
      sex: 'm', age: 28, height: 176, weight: 72, bf: 15, steps: 9500,
      exp: 'new', stage: 'cut', trainDays: [1, 3, 5], slot: 'eve', equipment: 'gym',
      startDate: '2026-11-18', injuries: [], supps: []
      // guideDismissed omitted (pre-existing recent sign-up with < 4 steps)
    },
    'days/2026-11-20': {
      date: '2026-11-20',
      checkin: { weight: 71.9, steps: 8800 },
      meals: [{ id: 'm1', type: '午餐', text: 'Chicken bowl', est: { kcal: 600, protein: 45, carbs: 60, fat: 15 } }]
    }
  };
  // 2026-11-21 is Saturday -> rest day
  const env = mountEnv({ lang: 'en', fixedIso: '2026-11-21T12:00:00Z', initialDocs });
  await env.loadAndRender();

  assert.equal(vm.runInContext('S.guideVeteranAutoHide', env.ctx), false);
  assert.equal(vm.runInContext('isQuickstartVisible()', env.ctx), true);
  assert.equal(vm.runInContext('quickstartDoneCount()', env.ctx), 3);
  assert.match(env.appEl.innerHTML, /No Lifting Today/);

  // Log a cardio session on rest day
  await env.click('cardio-open');
  await env.click('cardio-type', 'incline_walk');
  await env.click('cardio-min', '30');
  await env.click('cardio-save');

  assert.equal(vm.runInContext('quickstartDoneCount()', env.ctx), 4);
  assert.equal(vm.runInContext('S.guideVeteranAutoHide', env.ctx), false, 'completing 4th step live must NOT retroactively auto-hide');
  assert.equal(vm.runInContext('isQuickstartVisible()', env.ctx), true);
  assert.match(env.appEl.innerHTML, /4 \/ 4/);
  assert.match(env.appEl.innerHTML, /All set! You&#39;ve got the daily loop down|All set! You've got the daily loop down/);
  assert.match(env.appEl.innerHTML, /Got it, dismiss/);
});

test('4. Quick-jump CTAs switch date/tab & focus target; temporary collapse saves no cloud write and preserves live drafts', async () => {
  const env = mountEnv({ lang: 'zh', fixedIso: '2026-11-20T12:00:00Z' });
  await env.submitForm(BASE_SETUP_DATA);

  // Navigate to a past date first
  await env.click('date', '-1');
  assert.equal(vm.runInContext('S.date', env.ctx), '2026-11-19');

  // 4a. qs-go-checkin resets to today, scrolls and focuses #c-weight
  env.focused.length = 0;
  env.scrolled.length = 0;
  await env.click('qs-go-checkin');
  assert.equal(vm.runInContext('S.date', env.ctx), '2026-11-20');
  assert.ok(env.focused.includes('#c-weight'), `expected #c-weight focus, got ${JSON.stringify(env.focused)}`);
  assert.ok(env.scrolled.some(s => s.id === '#c-weight'), 'expected scrollIntoView on #c-weight');

  // 4b. qs-go-workout on another date resets to today, scrolls to #today-plan-card and focuses #today-plan-heading
  await env.click('date', '-1');
  env.focused.length = 0;
  env.scrolled.length = 0;
  await env.click('qs-go-workout');
  assert.equal(vm.runInContext('S.date', env.ctx), '2026-11-20');
  assert.ok(env.scrolled.some(s => s.id === '#today-plan-card'), 'expected scrollIntoView on #today-plan-card');
  assert.ok(env.focused.includes('#today-plan-heading'), `expected #today-plan-heading focus, got ${JSON.stringify(env.focused)}`);

  // 4c. Temporary collapse preserves live cardio & checkin drafts and performs ZERO cloud writes
  await env.click('cardio-open');
  env.setInput('cardio-minutes', '35', { cardio: 'minutes' });
  env.setInput('cardio-note', '坡度12', { cardio: 'note' });
  env.setInput('c-weight', '71.4');
  const writesBeforeCollapse = env.store.writes.length;

  await env.click('qs-toggle');
  assert.equal(vm.runInContext('S.guideCollapsed', env.ctx), true);
  assert.equal(env.store.writes.length, writesBeforeCollapse, 'collapsing Quick Start must not write to cloud');
  assert.match(env.appEl.innerHTML, /id="qs-toggle"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(env.appEl.innerHTML, /id="qs-body"/);
  // Live drafts still preserved
  assert.equal(vm.runInContext('S.cardioDraft[S.date].minutes', env.ctx), '35');
  assert.equal(vm.runInContext('S.cardioDraft[S.date].note', env.ctx), '坡度12');
  assert.equal(vm.runInContext('S.cfill[S.date].weight', env.ctx), '71.4');

  // Expand back
  await env.click('qs-toggle');
  assert.equal(vm.runInContext('S.guideCollapsed', env.ctx), false);
  assert.match(env.appEl.innerHTML, /id="qs-toggle"[^>]*aria-expanded="true"/);
  assert.match(env.appEl.innerHTML, /id="qs-body"/);

  // 4d. qs-go-meal syncs live cardio inputs, resets empty past date to today, switches to food tab & focuses #m-text
  env.setInput('cardio-minutes', '42', { cardio: 'minutes' });
  await env.click('date', '-1'); // 2026-11-19 has no meals
  env.focused.length = 0;
  await env.click('qs-go-meal');
  assert.equal(vm.runInContext('S.tab', env.ctx), 'food');
  assert.equal(vm.runInContext('S.date', env.ctx), '2026-11-20');
  assert.ok(env.focused.includes('#m-text'), `expected #m-text focus, got ${JSON.stringify(env.focused)}`);
  assert.equal(vm.runInContext('S.cardioDraft["2026-11-20"].minutes', env.ctx), '42');
});

test('5. Pre-existing veteran user auto-hides at loadAll(), while Me reopen explicitly shows it across reloads', async () => {
  const sharedStore = makeMemoryStore({
    'app/profile': {
      sex: 'm', age: 30, height: 178, weight: 74, bf: 14, steps: 9500,
      exp: 'mid', stage: 'cut', trainDays: [1, 3, 5], slot: 'eve', equipment: 'gym',
      startDate: '2026-10-01', injuries: [], supps: []
      // guideDismissed omitted (pre-existing veteran account)
    },
    'days/2026-11-18': {
      date: '2026-11-18',
      checkin: { weight: 73.5, steps: 9500 },
      meals: [{ id: 'm1', type: '午餐', text: '鸡腿饭', est: { kcal: 700, protein: 45, carbs: 70, fat: 20 } }],
      workout: { key: 'push', slot: 'eve', done: true, exercises: [] }
    }
  });

  const s1 = mountEnv({ lang: 'zh', store: sharedStore });
  await s1.loadAndRender();
  assert.equal(vm.runInContext('S.profile.guideDismissed', s1.ctx), undefined);
  assert.equal(vm.runInContext('quickstartDoneCount()', s1.ctx), 4);
  assert.equal(vm.runInContext('S.guideVeteranAutoHide', s1.ctx), true);
  assert.equal(vm.runInContext('isQuickstartVisible()', s1.ctx), false);
  assert.doesNotMatch(s1.appEl.innerHTML, /id="quickstart-card"/);

  // Veteran sees reopen button in Me
  await s1.click('tab', 'me');
  assert.match(s1.appEl.innerHTML, /data-act="qs-reopen"/);

  // Clicking reopen shows Quick Start and persists guideDismissed=false
  await s1.click('qs-reopen');
  assert.equal(vm.runInContext('S.tab', s1.ctx), 'today');
  assert.equal(vm.runInContext('S.guideVeteranAutoHide', s1.ctx), false);
  assert.equal(vm.runInContext('isQuickstartVisible()', s1.ctx), true);
  assert.equal((await sharedStore.get('app/profile')).guideDismissed, false);
  assert.match(s1.appEl.innerHTML, /id="quickstart-card"/);

  // Reload: now stays visible because guideDismissed is explicitly false
  const s2 = mountEnv({ lang: 'zh', store: sharedStore });
  await s2.loadAndRender();
  assert.equal(vm.runInContext('S.guideVeteranAutoHide', s2.ctx), false);
  assert.equal(vm.runInContext('isQuickstartVisible()', s2.ctx), true);
  assert.match(s2.appEl.innerHTML, /id="quickstart-card"/);
});

test('6. Standalone PWA mode hides Add-to-Home-Screen tip while keeping Feedback tip', async () => {
  // Normal browser: shows both tips
  const webEnv = mountEnv({ lang: 'zh' });
  await webEnv.submitForm(BASE_SETUP_DATA);
  assert.match(webEnv.appEl.innerHTML, /id="qs-tip-feedback"/);
  assert.match(webEnv.appEl.innerHTML, /id="qs-tip-a2hs"/);

  // display-mode: standalone via matchMedia
  const pwaMatch = mountEnv({ lang: 'zh', standaloneMatchMedia: true });
  await pwaMatch.submitForm(BASE_SETUP_DATA);
  assert.match(pwaMatch.appEl.innerHTML, /id="qs-tip-feedback"/);
  assert.doesNotMatch(pwaMatch.appEl.innerHTML, /id="qs-tip-a2hs"/);

  // iOS navigator.standalone === true
  const iosPwa = mountEnv({ lang: 'en', navigatorStandalone: true });
  await iosPwa.submitForm(BASE_SETUP_DATA);
  assert.match(iosPwa.appEl.innerHTML, /id="qs-tip-feedback"/);
  assert.doesNotMatch(iosPwa.appEl.innerHTML, /id="qs-tip-a2hs"/);
});

test('7. Editing profile preserves guideDismissed; dismiss/reopen never pollutes profileHistory or adjustLog; migrateProfile sanitizes tri-state', async () => {
  const env = mountEnv({ lang: 'zh' });
  await env.submitForm(BASE_SETUP_DATA);

  // Dismiss Quick Start
  await env.click('qs-dismiss');
  assert.equal((await env.store.get('app/profile')).guideDismissed, true);
  assert.equal((await env.store.list('profileHistory')).length, 0, 'dismissing must not create profileHistory');
  assert.deepEqual((await env.store.get('app/profile')).adjustLog, [], 'dismissing must not create adjustLog');

  // Edit profile via submitSetup: must preserve guideDismissed=true and NOT mention guideDismissed in profileHistory
  await env.click('tab', 'me');
  await env.click('edit');
  await env.submitForm({ ...BASE_SETUP_DATA, weight: '71' });
  const afterEdit = await env.store.get('app/profile');
  assert.equal(afterEdit.guideDismissed, true, 'editing profile must preserve guideDismissed=true');
  assert.equal(afterEdit.weight, 71);
  const ph = await env.store.list('profileHistory');
  assert.equal(ph.length, 1);
  assert.ok(!ph[0].data.changes.some(c => /guide|指引/i.test(c)), 'profileDiff must ignore guideDismissed');

  // Reopen and verify no profileHistory / adjustLog pollution
  await env.click('tab', 'me');
  await env.click('qs-reopen');
  assert.equal((await env.store.get('app/profile')).guideDismissed, false);
  assert.equal((await env.store.list('profileHistory')).length, 1, 'reopening must not create profileHistory');
  assert.deepEqual((await env.store.get('app/profile')).adjustLog, [], 'reopening must not create adjustLog');

  // Edit profile while guideDismissed=false: preserves false
  await env.click('tab', 'me');
  await env.click('edit');
  await env.submitForm({ ...BASE_SETUP_DATA, weight: '70.5' });
  assert.equal((await env.store.get('app/profile')).guideDismissed, false, 'editing profile must preserve guideDismissed=false');

  // migrateProfile tri-state sanitization
  const tri = vm.runInContext(`({
    t: migrateProfile({ guideDismissed: true }).guideDismissed,
    f: migrateProfile({ guideDismissed: false }).guideDismissed,
    u: migrateProfile({}).guideDismissed,
    badStr: migrateProfile({ guideDismissed: "yes" }).guideDismissed,
    badNull: migrateProfile({ guideDismissed: null }).guideDismissed,
    hasBadKey: "guideDismissed" in migrateProfile({ guideDismissed: 1 })
  })`, env.ctx);
  assert.equal(tri.t, true);
  assert.equal(tri.f, false);
  assert.equal(tri.u, undefined);
  assert.equal(tri.badStr, undefined);
  assert.equal(tri.badNull, undefined);
  assert.equal(tri.hasBadKey, false);

  // Logout clears user-scoped localStorage fallback & memory flags
  await env.click('qs-dismiss');
  vm.runInContext('S.guideCollapsed = true; S.guideVeteranAutoHide = true;', env.ctx);
  assert.equal(env.localStorage.getItem('bj-user:u1:bj-guide-dismissed'), '"1"');
  await env.click('logout');
  assert.equal(env.localStorage.getItem('bj-user:u1:bj-guide-dismissed'), null, 'logout must clear user-scoped guide dismissal');
  assert.equal(vm.runInContext('S.guideCollapsed', env.ctx), false);
  assert.equal(vm.runInContext('S.guideVeteranAutoHide', env.ctx), false);
});
