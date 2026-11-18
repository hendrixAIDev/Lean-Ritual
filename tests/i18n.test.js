'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appHtml = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
const appFullScript = appHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
const appPageScript = appFullScript.split('/* ============ 启动 ============ */')[0];

const loginHtml = fs.readFileSync(path.join(__dirname, '../public/login.html'), 'utf8');
const loginScript = loginHtml.match(/<script>([\s\S]*?)<\/script>/)[1];

function makeFixedDate(iso = '2026-11-18T12:00:00Z') {
  const RealDate = Date;
  const fixedMs = RealDate.parse(iso);
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedMs);
      else super(...args);
    }
    static now() { return fixedMs; }
    static parse(s) { return RealDate.parse(s); }
    static UTC(...args) { return RealDate.UTC(...args); }
  }
  return MockDate;
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
  return {
    docs,
    async get(p) { return docs.has(p) ? clone(docs.get(p)) : null; },
    async set(p, d) { docs.set(p, clone(d)); },
    async del(p) { docs.delete(p); },
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
        if (ch.after !== undefined) docs.set(ch.path, clone(ch.after));
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

function createAppEnv({
  search = '',
  hostname = 'leanritual.app',
  storage = {},
  languages = undefined,
  language = undefined,
  docs = {},
  elements = {},
  fixedIso = '2026-11-18T12:00:00'
} = {}) {
  const localStorage = makeStorage(storage);
  const store = makeMemoryStore(docs);
  const warnings = [];
  const listeners = {};
  const appEl = { innerHTML: '', contains: () => false };
  const tabsEl = { innerHTML: '', hidden: true };
  const toastEl = { innerHTML: '', textContent: '', hidden: true };
  const docEl = { lang: 'zh-CN' };
  const bySel = { '#app': appEl, '#tabs': tabsEl, '#toast': toastEl, ...elements };
  const location = {
    hostname,
    search,
    pathname: '/',
    href: `https://${hostname}/${search}`,
    reload() {},
    replace(u) { location.href = u; }
  };
  const window = {
    location,
    scrollTo() {},
    ritual: {
      hosted: true,
      changePassword: async () => {},
      deleteAccount: async () => {},
      logout: async () => {}
    }
  };
  const document = {
    documentElement: docEl,
    title: '薄肌日课',
    activeElement: null,
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelector(sel) { return bySel[sel] || null; },
    querySelectorAll() { return []; },
    getElementById(id) { return bySel['#' + id] || null; },
    createElement(tag) { return { tagName: tag.toUpperCase(), className: '', textContent: '' }; }
  };
  const nav = (languages !== undefined || language !== undefined) ? { languages, language } : undefined;
  const MockDate = makeFixedDate(fixedIso);
  const ctx = vm.createContext({
    window,
    location,
    document,
    localStorage,
    ...(nav ? { navigator: nav } : {}),
    console: {
      log() {},
      info() {},
      error() {},
      warn(...args) { warnings.push(args.join(' ')); }
    },
    URL,
    URLSearchParams,
    Date: MockDate,
    Math,
    JSON,
    Promise,
    Set,
    Map,
    RegExp,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout: () => 0,
    clearTimeout: () => {}
  });
  vm.runInContext(appPageScript, ctx);
  ctx.__store = store;
  vm.runInContext('storageUser = "u1"; S.uid = "u1"; S.cloud = true; S.store = __store;', ctx);
  const clickAct = async (act, v = '') => {
    const btn = {
      dataset: { act, v: String(v) },
      disabled: false,
      closest(sel) { return sel === '[data-act]' ? btn : null; }
    };
    await listeners.click({ target: btn });
  };
  return { ctx, localStorage, store, warnings, listeners, appEl, tabsEl, toastEl, docEl, document, bySel, clickAct };
}

function createLoginEnv({
  search = '',
  storage = {},
  languages = ['zh-CN'],
  fetchImpl
} = {}) {
  const localStorage = makeStorage(storage);
  const docEl = { lang: 'zh-CN' };
  const mk = (id, props = {}) => {
    const el = {
      id,
      value: '',
      hidden: false,
      disabled: false,
      required: false,
      autocomplete: '',
      textContent: '',
      className: '',
      dataset: {},
      attributes: {},
      onclick: null,
      onsubmit: null,
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] ?? null; },
      classList: {
        set: new Set(),
        toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); },
        contains(c) { return this.set.has(c); }
      },
      closest(sel) {
        if (sel === 'button') return el;
        return null;
      },
      focus() {},
      ...props
    };
    return el;
  };
  const langZhBtn = mk('lang-zh', { dataset: { lang: 'zh' }, textContent: '中文' });
  const langEnBtn = mk('lang-en', { dataset: { lang: 'en' }, textContent: 'English' });
  const tabLoginBtn = mk('tab-login', { dataset: { m: 'login' }, textContent: '登录' });
  const tabRegBtn = mk('tab-reg', { dataset: { m: 'register' }, textContent: '凭邀请注册' });

  const els = {
    '#title-h1': mk('title-h1'),
    '#subtitle': mk('subtitle'),
    '#lang-switch': mk('lang-switch'),
    '#lang-zh': langZhBtn,
    '#lang-en': langEnBtn,
    '#banner': mk('banner', { hidden: true }),
    '#f': mk('f'),
    '#tabs': mk('tabs'),
    '#tab-login': tabLoginBtn,
    '#tab-reg': tabRegBtn,
    '#nw': mk('nw', { hidden: true }),
    '#lbl-n': mk('lbl-n'),
    '#n': mk('n'),
    '#ew': mk('ew'),
    '#lbl-e': mk('lbl-e'),
    '#e': mk('e', { value: 'alex@example.com' }),
    '#pw': mk('pw'),
    '#lbl-p': mk('lbl-p'),
    '#p': mk('p', { value: 'password123' }),
    '#iw': mk('iw', { hidden: true }),
    '#lbl-i': mk('lbl-i'),
    '#i': mk('i'),
    '#err': mk('err'),
    '#go': mk('go'),
    '#forgot': mk('forgot'),
    '#resend': mk('resend'),
    '#hint-text': mk('hint-text'),
    '#privacy-link': mk('privacy-link')
  };
  let innerHTMLWrites = 0;
  for (const el of Object.values(els)) {
    Object.defineProperty(el, 'innerHTML', {
      get() { return ''; },
      set() { innerHTMLWrites++; throw new Error(`innerHTML prohibited on #${el.id}`); }
    });
  }
  const location = {
    pathname: '/login.html',
    search,
    hash: '',
    href: 'https://leanritual.app/login.html' + search,
    replace(u) { location.href = u; }
  };
  const window = {};
  const document = {
    documentElement: docEl,
    title: '登录 · 薄肌日课',
    querySelector: sel => els[sel] || null,
    querySelectorAll: sel => {
      if (sel === '#lang-switch button') return [langZhBtn, langEnBtn];
      if (sel === '#tabs button') return [tabLoginBtn, tabRegBtn];
      return [];
    }
  };
  const ctx = vm.createContext({
    window,
    document,
    location,
    localStorage,
    navigator: { languages },
    history: { replaceState(_, __, u) { location.replacedState = u; } },
    URLSearchParams,
    fetch: fetchImpl || (async () => ({ ok: false, status: 400, json: async () => ({ code: 'INVALID_EMAIL_OR_PASSWORD' }) }))
  });
  vm.runInContext(loginScript, ctx);
  return {
    ctx,
    els,
    docEl,
    document,
    localStorage,
    location,
    get innerHTMLWrites() { return innerHTMLWrites; },
    async submit() {
      if (els['#f'].onsubmit) await els['#f'].onsubmit({ preventDefault() {} });
    },
    clickLang(lang) {
      const target = lang === 'en' ? langEnBtn : langZhBtn;
      if (els['#lang-switch'].onclick) els['#lang-switch'].onclick({ target });
    },
    clickMode(m) {
      if (m === 'login' || m === 'register') {
        const target = m === 'register' ? tabRegBtn : tabLoginBtn;
        if (els['#tabs'].onclick) els['#tabs'].onclick({ target });
      } else if (m === 'forgot') {
        if (els['#forgot'].onclick) els['#forgot'].onclick();
      } else if (m === 'resend') {
        if (els['#resend'].onclick) els['#resend'].onclick();
      }
    }
  };
}

// Helper to detect any remaining CJK unified ideographs or CJK punctuation in rendered HTML
const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
function findUnexpectedChineseInHtml(html) {
  const cleaned = String(html)
    .replace(/>中文<\/button>/g, '>ZH_BTN</button>')
    .replace(/\shref="https:\/\/search\.bilibili\.com\/[^"]*"/g, ' href="https://search.bilibili.com/"');
  const textOnly = cleaned.replace(/<[^>]+>/g, ' ');
  const badText = [];
  for (const token of textOnly.split(/\s+/)) {
    if (CJK_RE.test(token)) badText.push(`text:${token}`);
  }
  const attrRe = /\b(placeholder|aria-label|alt|title)="([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(cleaned)) !== null) {
    if (CJK_RE.test(m[2])) badText.push(`${m[1]}:${m[2]}`);
  }
  const inputTagRe = /<input\b[^>]*>/g;
  while ((m = inputTagRe.exec(cleaned)) !== null) {
    const tag = m[0];
    if (/type="(?:radio|checkbox|hidden)"/.test(tag)) continue;
    const valM = tag.match(/\bvalue="([^"]*)"/);
    if (valM && CJK_RE.test(valM[1])) badText.push(`input-value:${valM[1]}`);
  }
  return badText;
}

test('language resolution order: ?lang= override > explicit choice > profile.lang after login > navigator.languages > zh fallback', async () => {
  // 1. Fallback to zh when navigator has no languages and nothing is stored
  {
    const env = createAppEnv({ languages: [] });
    assert.equal(vm.runInContext('getLang()', env.ctx), 'zh');
    assert.equal(env.docEl.lang, 'zh-CN');
  }

  // 2. navigator.languages detection: any zh* -> zh, otherwise en
  {
    const envZh = createAppEnv({ languages: ['en-US', 'zh-Hant-HK'] });
    assert.equal(vm.runInContext('getLang()', envZh.ctx), 'zh');
    assert.equal(envZh.docEl.lang, 'zh-CN');

    const envEn = createAppEnv({ languages: ['en-US', 'fr-FR'] });
    assert.equal(vm.runInContext('getLang()', envEn.ctx), 'en');
    assert.equal(envEn.docEl.lang, 'en');
    assert.equal(envEn.document.title, 'Lean Ritual');
  }

  // 3. Explicit localStorage choice (bj-lang) wins over navigator.languages pre-login and when profile.lang is unset
  {
    const env1 = createAppEnv({ storage: { 'bj-lang': 'en' }, languages: ['zh-CN'] });
    assert.equal(vm.runInContext('getLang()', env1.ctx), 'en');

    const env2 = createAppEnv({ storage: { 'bj-lang': 'zh' }, languages: ['en-US'] });
    assert.equal(vm.runInContext('getLang()', env2.ctx), 'zh');

    const login1 = createLoginEnv({ storage: { 'bj-lang': 'en' }, languages: ['zh-CN'] });
    assert.equal(login1.ctx.window.ritualLoginI18n.getLang(), 'en');
    assert.equal(login1.docEl.lang, 'en');
    login1.clickLang('zh');
    assert.equal(login1.ctx.window.ritualLoginI18n.getLang(), 'zh');
    assert.equal(login1.localStorage.getItem('bj-lang'), 'zh');
    assert.equal(login1.docEl.lang, 'zh-CN');
  }

  // 4. On login (loadAll), profile.lang overrides stale localStorage bj-lang; then manual switch updates both bj-lang and profile.lang
  {
    const env = createAppEnv({
      storage: { 'bj-lang': 'zh' },
      languages: ['zh-CN'],
      docs: {
        'app/profile': {
          sex: 'm', age: 28, height: 175, weight: 70, steps: 9500, exp: 'mid',
          stage: 'cut', trainDays: [1, 3, 5], slot: 'eve', equipment: 'gym',
          startDate: '2026-10-01', lang: 'en'
        }
      }
    });
    assert.equal(vm.runInContext('getLang()', env.ctx), 'zh');
    await vm.runInContext('loadAll()', env.ctx);
    assert.equal(vm.runInContext('getLang()', env.ctx), 'en');
    assert.equal(env.localStorage.getItem('bj-lang'), 'en');
    assert.equal(env.docEl.lang, 'en');

    // Clicking manual switch in UI updates both bj-lang and profile.lang
    vm.runInContext('S.ready = true; render();', env.ctx);
    await env.clickAct('lang', 'zh');
    assert.equal(vm.runInContext('getLang()', env.ctx), 'zh');
    assert.equal(env.localStorage.getItem('bj-lang'), 'zh');
    assert.equal((await env.store.get('app/profile')).lang, 'zh');
    assert.equal(env.docEl.lang, 'zh-CN');
  }

  // 5. ?lang=en|zh query param overrides everything (bj-lang, profile.lang, navigator.languages) and sets bj-lang
  {
    const env = createAppEnv({
      search: '?lang=en',
      storage: { 'bj-lang': 'zh' },
      languages: ['zh-CN'],
      docs: {
        'app/profile': {
          sex: 'm', age: 28, height: 175, weight: 70, steps: 9500, exp: 'mid',
          stage: 'cut', trainDays: [1, 3, 5], slot: 'eve', equipment: 'gym',
          startDate: '2026-10-01', lang: 'zh'
        }
      }
    });
    assert.equal(env.localStorage.getItem('bj-lang'), 'en');
    await vm.runInContext('loadAll()', env.ctx);
    assert.equal(vm.runInContext('getLang()', env.ctx), 'en');
    assert.equal(env.localStorage.getItem('bj-lang'), 'en');

    const login = createLoginEnv({ search: '?lang=zh', storage: { 'bj-lang': 'en' }, languages: ['en-US'] });
    assert.equal(login.ctx.window.ritualLoginI18n.getLang(), 'zh');
    assert.equal(login.localStorage.getItem('bj-lang'), 'zh');
    assert.equal(login.docEl.lang, 'zh-CN');
  }
});

test('t() interpolation, missing-en fallback to zh, and once-only dev warning', () => {
  // Dictionary parity check on pristine context first
  const clean = createAppEnv({ hostname: 'leanritual.app', languages: ['en-US'] });
  const parity = vm.runInContext(`({
    missingEn: Object.keys(I18N.zh).filter(k => !(k in I18N.en)),
    missingZh: Object.keys(I18N.en).filter(k => !(k in I18N.zh)),
    missingCues: Object.keys(CUES).filter(k => !(k in CUES_EN))
  })`, clean.ctx);
  assert.deepEqual(parity.missingEn, []);
  assert.deepEqual(parity.missingZh, []);
  assert.deepEqual(parity.missingCues, []);

  // Dev hostname (localhost) logs missing en key once and falls back to zh
  const dev = createAppEnv({ hostname: 'localhost', languages: ['en-US'] });
  vm.runInContext('I18N.zh["test.onlyZh"] = "仅中文提示 {n}";', dev.ctx);
  assert.equal(vm.runInContext('t("test.onlyZh", { n: 3 })', dev.ctx), '仅中文提示 3');
  assert.equal(vm.runInContext('t("test.onlyZh", { n: 5 })', dev.ctx), '仅中文提示 5');
  assert.equal(dev.warnings.length, 1);
  assert.match(dev.warnings[0], /missing en key:.*test\.onlyZh/);

  // Production hostname never logs warnings on missing en key, still falls back to zh
  const prod = createAppEnv({ hostname: 'leanritual.app', languages: ['en-US'] });
  vm.runInContext('I18N.zh["test.onlyZh"] = "仅中文提示";', prod.ctx);
  assert.equal(vm.runInContext('t("test.onlyZh")', prod.ctx), '仅中文提示');
  assert.equal(prod.warnings.length, 0);
});

test('date, rest, and weight formatting in both zh and en', async () => {
  const env = createAppEnv({ storage: { 'bj-lang': 'zh' }, languages: ['zh-CN'] });
  // 2026-11-18 is a Wednesday
  assert.equal(vm.runInContext('fmtDate("2026-11-18")', env.ctx), '11月18日 周三');
  assert.equal(vm.runInContext('fmtShortDate("2026-11-18")', env.ctx), '11月18日');
  assert.equal(vm.runInContext('fmtW(0)', env.ctx), '自重');
  assert.equal(vm.runInContext('fmtW(62.5)', env.ctx), '62.5kg');
  assert.equal(vm.runInContext('fmtRest("2–3 分钟")', env.ctx), '2–3 分钟');

  await vm.runInContext('setLang("en")', env.ctx);
  assert.equal(vm.runInContext('fmtDate("2026-11-18")', env.ctx), 'Wed, Nov 18');
  assert.equal(vm.runInContext('fmtShortDate("2026-11-18")', env.ctx), 'Nov 18');
  assert.equal(vm.runInContext('fmtW(0)', env.ctx), 'BW');
  assert.equal(vm.runInContext('fmtW(62.5)', env.ctx), '62.5kg');
  assert.equal(vm.runInContext('fmtRest("2–3 分钟")', env.ctx), '2–3 min');
});

test('login.html in English renders zero Chinese strings across all modes, banners, and Better Auth errors', async () => {
  const collectLoginTexts = env => {
    const out = [];
    for (const [sel, el] of Object.entries(env.els)) {
      if (sel === '#lang-zh') continue; // The "中文" toggle button itself
      if (!el.hidden && el.textContent && CJK_RE.test(el.textContent)) out.push(`${sel}:${el.textContent}`);
      for (const [k, v] of Object.entries(el.attributes || {})) {
        if (CJK_RE.test(v)) out.push(`${sel}[${k}]:${v}`);
      }
    }
    if (CJK_RE.test(env.document.title)) out.push(`title:${env.document.title}`);
    return out;
  };

  for (const search of ['', '?verified=1', '?deleted=1', '?token=tok_abc']) {
    const env = createLoginEnv({ search, languages: ['en-US'] });
    assert.equal(env.docEl.lang, 'en');
    assert.deepEqual(collectLoginTexts(env), [], `unexpected zh in login (${search || 'default'})`);
    env.clickMode('register');
    assert.deepEqual(collectLoginTexts(env), []);
    env.clickMode('forgot');
    assert.deepEqual(collectLoginTexts(env), []);
    env.clickMode('resend');
    assert.deepEqual(collectLoginTexts(env), []);
    assert.equal(env.innerHTMLWrites, 0);
  }

  // Test all Better Auth error codes and error messages in English mode
  const codes = [
    'INVALID_EMAIL_OR_PASSWORD', 'EMAIL_NOT_VERIFIED', 'INVALID_EMAIL',
    'PASSWORD_TOO_SHORT', 'PASSWORD_TOO_LONG', 'USER_ALREADY_EXISTS',
    'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', 'INVALID_PASSWORD',
    'INVALID_TOKEN', 'TOKEN_EXPIRED', 'USER_NOT_FOUND', 'TOO_MANY_REQUESTS',
    'SESSION_EXPIRED', 'INVITE_REQUIRED', 'INVITE_INVALID', 'VALIDATION_ERROR',
    'TOTALLY_UNKNOWN_CODE'
  ];
  for (const code of codes) {
    const env = createLoginEnv({
      languages: ['en-US'],
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ code, message: 'Server detail' }) })
    });
    await env.submit();
    const msg = env.els['#err'].textContent;
    assert.ok(msg.length > 0);
    assert.doesNotMatch(msg, CJK_RE, `error code ${code} leaked Chinese: ${msg}`);
  }
});

test('rendered English views across Setup, Today, Meals, Log, Feedback, and Me contain zero zh-only UI strings', async () => {
  const today = '2026-11-18'; // Wednesday (trainDay in [1,3,5])
  const restDate = '2026-11-19'; // Thursday (rest day)
  const d1 = '2026-11-16';
  const d2 = '2026-11-13';
  const d3 = '2026-11-11';
  const dPrev = '2026-11-09';

  const docs = {
    'app/profile': {
      sex: 'm', age: 29, height: 178, weight: 74, bf: 16.5, steps: 9500,
      exp: 'mid', stage: 'cut', trainDays: [1, 3, 5], slot: 'am', equipment: 'gym',
      injuries: ['shoulder', 'lowback'], injNote: 'Mild shoulder tightness',
      supps: ['protein', 'creatine', 'caffeine', 'vitd', 'fishoil'],
      startDate: '2026-10-05', kcalAdjust: -100, deloadEvery: 9, lang: 'en',
      swaps: { '深蹲': '腿举' },
      exEdits: { '平板杠铃卧推': { name: '哑铃地板卧推', sets: 3, lo: 6, hi: 8, inc: 2, rest: '2–3 分钟' } },
      adjustLog: [
        { id: 'adj1', key: 'fb1:0', fbId: 'fb1', idx: 0, date: d1, kind: 'kcal', scope: 'long', delta: -100, prev: { kcalAdjust: 0 }, text: '每日热量 -100 kcal' },
        { date: d2, text: '热量调整归零' },
        { date: d3, text: '「平板杠铃卧推」长期换成 哑铃地板卧推 3×6–8' }
      ]
    },
    'profileHistory/ph1': {
      id: 'ph1',
      savedAt: '2026-11-10T08:00:00Z',
      changes: ['体重：75 → 74', '训练日：周一、周三 → 周一、周三、周五', '伤病：无 → 肩、下背/腰', '补剂：protein → protein、creatine']
    },
    'feedback/fb1': {
      id: 'fb1',
      date: d1,
      createdAt: '2026-11-16T10:00:00Z',
      userText: 'Bench felt solid this week',
      good: ['Consistent sessions and protein intake.'],
      issues: ['Sleep dipped slightly mid-week.'],
      adjustments: [
        { kind: 'kcal', delta: -100, text: 'Trim 100 kcal/day' },
        { kind: 'swap', from: '杠铃划船', to: '胸托哑铃划船', sets: 3, lo: 8, hi: 12, text: 'Swap row variation for lower back comfort' },
        { kind: 'deload', text: 'Optional recovery week' }
      ],
      applied: [0],
      declined: [2]
    },
    [`days/${dPrev}`]: {
      date: dPrev,
      checkin: { weight: 74.8, bf: 16.8, sleep: 6.5, steps: 8200 },
      meals: []
    },
    [`days/${d3}`]: {
      date: d3,
      checkin: { weight: 74.6, bf: 16.6, sleep: 6.5, steps: 8500 },
      workout: {
        done: true, key: 'push', slot: 'am', deload: false,
        exercises: [{ name: '上斜哑铃卧推（中立握）', sets: [{ w: 20, r: 8 }, { w: 20, r: 8 }] }],
        feel: 4, pain: 'mild', painArea: 'Right front delt'
      },
      meals: []
    },
    [`days/${d2}`]: {
      date: d2,
      checkin: { weight: 74.4, bf: 16.5, sleep: 6.5, steps: 9000 },
      workout: {
        done: true, key: 'push', slot: 'am', deload: false,
        exercises: [{ name: '上斜哑铃卧推（中立握）', sets: [{ w: 20, r: 8 }, { w: 20, r: 8 }] }],
        feel: 4, pain: 'bad', painArea: 'Right shoulder'
      },
      meals: []
    },
    [`days/${d1}`]: {
      date: d1,
      checkin: { weight: 74.2, bf: 16.4, sleep: 6.8, steps: 9200 },
      workout: {
        done: true, key: 'push', slot: 'am', deload: false,
        exercises: [
          { name: '上斜哑铃卧推（中立握）', sets: [{ w: 20, r: 8 }, { w: 20, r: 8 }] },
          { name: '平板支撑（秒）', sets: [{ w: 0, r: 45 }] }
        ],
        feel: 4, pain: 'none', painArea: ''
      },
      meals: [
        { id: 'm_a', type: '早餐', time: '08:00', text: 'Oats and whey', est: { kcal: 500, protein: 40, carbs: 60, fat: 10, by: 'manual' } },
        { id: 'm_b', type: '午餐', time: '12:30', text: 'Chicken rice', est: { kcal: 700, protein: 50, carbs: 80, fat: 18, by: 'manual' } },
        { id: 'm_c', type: '晚餐', time: '19:00', text: 'Salmon and potatoes', est: { kcal: 650, protein: 45, carbs: 55, fat: 22, by: 'manual' } }
      ]
    },
    [`days/${today}`]: {
      date: today,
      checkin: { weight: 74.0, bf: 16.3, sleep: 7.5, steps: 9600, waist: 79 },
      extra: { ex: [{ name: '死虫', sets: 3, lo: 8, hi: 12 }] },
      meals: [
        {
          id: 'm1', type: '早餐', time: '08:15', text: 'Greek yogurt + oats', photo: 'blob123',
          more: [{ id: 'blob456', tag: '剩下', at: '2026-11-18T08:40:00Z' }],
          est: {
            kcal: 420, protein: 32, carbs: 48, fat: 9,
            by: 'label', label: true, confidence: '高',
            calc: '每100g 370kJ（88 kcal）、蛋白 10g、脂肪 2g、碳水 12g，× 2.5',
            tip: 'Good morning protein hit.',
            photos: 1
          }
        },
        {
          id: 'm2', type: '午餐', time: '12:40', text: 'Grilled chicken bowl',
          photoErr: 'network',
          est: { kcal: 680, protein: 48, carbs: 72, fat: 16, by: 'server', ocr: true, label: false, photoUsed: false }
        }
      ]
    }
  };

  const env = createAppEnv({ languages: ['en-US'], docs, fixedIso: `${today}T12:00:00` });
  vm.runInContext(`
    S.date = "${today}";
    S.sample = { json: async () => ({}), text: async () => "" };
    S.assets = { upload: async () => ({ id: "b1" }), delete: async () => {} };
    S.hostUser = { id: "u1", username: "alex", created: "2026-10-05T00:00:00Z", mustChange: true };
    S.openCues = new Set(["上斜哑铃卧推", "死虫"]);
  `, env.ctx);

  // 1. Setup view BEFORE profile loads (onboarding)
  vm.runInContext('S.ready = true; render();', env.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(env.appEl.innerHTML), [], 'Setup onboarding view');

  // Load full data & render all 5 tabs
  await vm.runInContext('loadAll()', env.ctx);
  vm.runInContext('render()', env.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(env.tabsEl.innerHTML), [], 'Bottom nav tabs');

  // 2. Today tab: training day + open exercise editor + custom workout + rest day
  assert.deepEqual(findUnexpectedChineseInHtml(env.appEl.innerHTML), [], 'Today training view');
  vm.runInContext('openEditor(0); render();', env.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(env.appEl.innerHTML), [], 'Today exercise editor');
  vm.runInContext('S.ed = null; S.days["2026-11-18"].override = "custom"; S.days["2026-11-18"].custom = { ex: [{ name: "平板支撑（秒）", sets: 3, lo: 30, hi: 60 }, { name: "", sets: 3, lo: 10, hi: 15 }] }; render();', env.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(env.appEl.innerHTML), [], 'Today custom workout view');
  vm.runInContext(`delete S.days["2026-11-18"].override; S.date = "${restDate}"; render();`, env.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(env.appEl.innerHTML), [], 'Today rest day view');

  // 3. Meals tab (AI mode, Manual mode, and open nutrition label calculator)
  vm.runInContext(`S.date = "${today}"; S.tab = "food"; S.label = { id: "m1", base: "100", u: "kJ", e: "370", p: "10", f: "2", c: "12", amt: "250" }; render();`, env.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(env.appEl.innerHTML), [], 'Meals tab AI + label form');
  vm.runInContext('S.mealMode = "manual"; render();', env.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(env.appEl.innerHTML), [], 'Meals tab Manual mode');

  // 4. Log tab (populated charts + empty states)
  vm.runInContext('S.tab = "log"; render();', env.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(env.appEl.innerHTML), [], 'Log tab populated');
  const emptyEnv = createAppEnv({
    languages: ['en-US'],
    fixedIso: `${today}T12:00:00`,
    docs: { 'app/profile': { sex: 'f', age: 26, height: 165, weight: 56, steps: 6500, exp: 'new', stage: 'maintain', trainDays: [1, 3, 5], slot: 'eve', equipment: 'home', startDate: today, lang: 'en' } }
  });
  await vm.runInContext('loadAll()', emptyEnv.ctx);
  vm.runInContext(`S.date = "${today}"; S.ready = true; S.tab = "log"; render();`, emptyEnv.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(emptyEnv.appEl.innerHTML), [], 'Log tab empty states');

  // 5. Feedback tab (insights + applied list + AI card + open scope chooser + conflict banner)
  vm.runInContext('S.tab = "fb"; S.adopt = "fb1:1"; S.undoConflict = { adjId: "adj1", kind: "swap", scope: "long" }; render();', env.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(env.appEl.innerHTML), [], 'Feedback tab');

  // 6. Me tab (targets, formula, profile, exEdits, swaps, profileHistory, account, password edit, edit profile)
  vm.runInContext('S.tab = "me"; render();', env.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(env.appEl.innerHTML), [], 'Me tab');
  vm.runInContext('S.pwEdit = { msg: apiErrMsg({ code: "INVALID_PASSWORD" }, t("account.pwFail")) }; render();', env.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(env.appEl.innerHTML), [], 'Me tab pwEdit');
  vm.runInContext('S.editing = true; render();', env.ctx);
  assert.deepEqual(findUnexpectedChineseInHtml(env.appEl.innerHTML), [], 'Me -> Edit profile');

  // 7. Banners & API error mapping in English
  const errChecks = vm.runInContext(`[
    formatSaveErr({ code: "doc_conflict", message: "记录已在其他页面更新，请重试" }),
    formatSaveErr({ code: "doc_quota", message: "文档数量已达上限" }),
    apiErrMsg({ code: "storage_quota", message: "照片存储空间已满" }, "fallback"),
    PHOTO_ERR("storage_quota", false),
    t("boot.authUnavailable")
  ]`, env.ctx);
  for (const s of errChecks) {
    assert.doesNotMatch(s, CJK_RE, `English error leaked Chinese: ${s}`);
  }
});

test('switching language to English and saving keeps stored keys (workout, swaps, exEdits, adjustLog, meal type) canonical, while legacy/custom text stays intact', async () => {
  const today = '2026-11-18';
  const env = createAppEnv({
    languages: ['zh-CN'],
    fixedIso: `${today}T12:00:00`,
    docs: {
      'app/profile': {
        sex: 'm', age: 30, height: 176, weight: 72, steps: 8000, exp: 'mid',
        stage: 'cut', trainDays: [1, 3, 5], slot: 'eve', equipment: 'gym',
        startDate: '2026-11-01'
      },
      'feedback/fb1': {
        id: 'fb1',
        date: today,
        createdAt: '2026-11-18T09:00:00Z',
        good: ['训练稳定推进'],
        issues: ['注意肘部热身'],
        adjustments: [
          { kind: 'swap', from: '深蹲', to: '腿举', text: '膝盖更稳妥' },
          { kind: 'kcal', delta: -120, text: '微调热量' }
        ],
        applied: []
      }
    }
  });

  await vm.runInContext('loadAll()', env.ctx);
  vm.runInContext(`S.date = "${today}"; S.ready = true; render();`, env.ctx);

  // Switch to English
  await env.clickAct('lang', 'en');
  assert.equal(vm.runInContext('getLang()', env.ctx), 'en');

  // 1. Open editor on exercise 0 (上斜杠铃卧推), pick Dumbbell Floor Press (哑铃地板卧推), save long-term
  vm.runInContext('openEditor(0);', env.ctx);
  assert.equal(vm.runInContext('S.ed.name', env.ctx), 'Incline Barbell Bench Press');
  await env.clickAct('ed-pick', '哑铃地板卧推');
  assert.equal(vm.runInContext('S.ed.name', env.ctx), 'Dumbbell Floor Press');
  await env.clickAct('ed-scope', 'always');
  await env.clickAct('ed-save');

  const profAfterEdit = await env.store.get('app/profile');
  assert.equal(profAfterEdit.exEdits['上斜杠铃卧推'].name, '哑铃地板卧推');
  assert.equal(profAfterEdit.exEdits['上斜杠铃卧推'].rest, '3 分钟');
  assert.equal(profAfterEdit.adjustLog.at(-1).text, '「上斜杠铃卧推」长期换成 哑铃地板卧推 3×4–6');

  // 2. Adopt bare swap (深蹲 -> 腿举) and kcal (-120) while in English
  await vm.runInContext('applyAction({ fid: "fb1", idx: 0, scope: "long", a: { kind: "swap", from: "深蹲", to: "腿举" } })', env.ctx);
  await vm.runInContext('applyAction({ fid: "fb1", idx: 1, scope: "long", a: { kind: "kcal", delta: -120 } })', env.ctx);

  const profAfterAdopt = await env.store.get('app/profile');
  assert.equal(profAfterAdopt.swaps['深蹲'], '腿举');
  assert.equal(profAfterAdopt.kcalAdjust, -120);
  assert.equal(profAfterAdopt.adjustLog.at(-1).text, '每日热量 -120 kcal');

  // 3. Log a set and save workout in English -> stored exercise names & plan keys stay canonical Chinese
  vm.runInContext('(() => { const pl = planFor(S.date), d = getDraft(S.date, pl); d.exercises[0].sets[0] = { w: "24", r: "6" }; })()', env.ctx);
  await env.clickAct('save-workout');
  const savedDay = await env.store.get(`days/${today}`);
  assert.equal(savedDay.workout.key, 'push');
  assert.equal(savedDay.workout.exercises[0].name, '哑铃地板卧推');
  assert.equal(savedDay.workout.plan[0].orig, '上斜杠铃卧推');

  // 4. Custom unknown exercise name (both English and Chinese) falls back to the stored string as-is, and legacy AI Chinese text renders untouched
  assert.equal(vm.runInContext('exName("Cable Crossover")', env.ctx), 'Cable Crossover');
  assert.equal(vm.runInContext('exName("自创龙门架夹胸")', env.ctx), '自创龙门架夹胸');
  vm.runInContext('S.tab = "fb"; render();', env.ctx);
  assert.match(env.appEl.innerHTML, /训练稳定推进/);
  assert.match(env.appEl.innerHTML, /Barbell Squat → Leg Press/);
});
