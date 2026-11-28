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
const { CONSENT_VERSION } = require('../lib/auth');
const { importAccount } = require('../lib/import-export');

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

function mountCardioEnv({
  lang = 'zh',
  uid = 'u1',
  fixedIso = '2026-11-20T18:00:00Z', // 2026-11-20 is Friday (day 5 -> workout day on [1,3,5]; 2026-11-21 Saturday -> rest day)
  profile = null,
  days = {}
} = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const script = extractInlineScript(html).split('/* ============ 启动 ============ */')[0];

  const RealDate = Date;
  let nowMs = RealDate.parse(fixedIso);
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(nowMs);
      else super(...args);
    }
    static now() { return nowMs; }
    static parse(s) { return RealDate.parse(s); }
    static UTC(...args) { return RealDate.UTC(...args); }
  }

  const defaultProfile = {
    sex: 'm', age: 29, height: 176, weight: 72, bf: 15, steps: 8000,
    exp: 'mid', stage: 'cut', trainDays: [1, 3, 5], slot: 'eve',
    equipment: 'gym', startDate: '2026-11-02', injuries: [], supps: [],
    kcalAdjust: 0, deloadEvery: 9, swaps: {}, adjustLog: [],
    ...(profile || {})
  };
  const initialDocs = { 'app/profile': defaultProfile };
  for (const [d, val] of Object.entries(days)) {
    initialDocs['days/' + d] = val;
  }
  const store = makeMemoryStore(initialDocs);
  const localStorage = makeStorage({ 'bj-lang': lang });
  const sessionStorage = makeStorage({});

  const docListeners = {};
  const winListeners = {};
  const toasts = [];
  const announcements = [];
  let aiCalls = 0;

  const appEl = { id: 'app', innerHTML: '', contains: el => !!el && el._inApp !== false };
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

  // Track live DOM input mirrors parsed from appEl.innerHTML, with overrides set by test typing
  const liveInputs = new Map();
  const minChipButtons = new Map();
  const valEl = { id: 'rest-timer-val', textContent: '' };
  const slotEl = {
    id: 'rest-timer-slot',
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      const m = this._html.match(/id="rest-timer-val"[^>]*>([^<]*)</);
      valEl.textContent = m ? m[1] : '';
    },
    contains: el => !!el && ['rt-minus', 'rt-plus', 'rt-toggle', 'rt-dismiss'].includes(el.id)
  };

  function unescHtml(s) {
    return String(s ?? '')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function syncMirrorsFromHtml() {
    const src = appEl.innerHTML;
    liveInputs.clear();
    minChipButtons.clear();
    for (const id of ['cardio-custom-name', 'cardio-minutes', 'cardio-note']) {
      const m = src.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
      if (m) {
        const valM = m[0].match(/value="([^"]*)"/);
        const dcM = m[0].match(/data-cardio="([^"]*)"/);
        liveInputs.set(id, {
          id,
          _inApp: true,
          value: valM ? unescHtml(valM[1]) : '',
          dataset: { cardio: dcM ? dcM[1] : '' },
          disabled: /\bdisabled\b/.test(m[0]),
          focus() { document.activeElement = this; }
        });
      }
    }
    for (const m of src.matchAll(/<button[^>]*data-act="cardio-min"[^>]*data-v="(\d+)"[^>]*>/g)) {
      const v = m[1];
      const classes = new Set((m[0].match(/class="([^"]*)"/)?.[1] || '').split(/\s+/).filter(Boolean));
      const attrs = { 'aria-pressed': m[0].match(/aria-pressed="([^"]*)"/)?.[1] || 'false' };
      minChipButtons.set(v, {
        dataset: { act: 'cardio-min', v },
        classList: { toggle(cls, on) { if (on) classes.add(cls); else classes.delete(cls); }, contains: cls => classes.has(cls) },
        setAttribute(k, val) { attrs[k] = String(val); },
        getAttribute(k) { return attrs[k]; }
      });
    }
    const slotMatch = src.match(/<div id="rest-timer-slot"[^>]*>([\s\S]*?)<\/div>\s*(?=<div|<section|<p|$)/);
    if (slotMatch) slotEl.innerHTML = slotMatch[1];
  }

  const origDesc = Object.getOwnPropertyDescriptor(appEl, 'innerHTML');
  let appHtmlVal = '';
  Object.defineProperty(appEl, 'innerHTML', {
    get() { return appHtmlVal; },
    set(v) { appHtmlVal = String(v); syncMirrorsFromHtml(); }
  });

  const document = {
    documentElement: { lang: lang === 'en' ? 'en' : 'zh-CN' },
    title: '',
    hidden: false,
    activeElement: null,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    querySelector(sel) {
      if (sel === '#app') return appEl;
      if (sel === '#tabs') return tabsEl;
      if (sel === '#toast') return toastEl;
      if (sel === '#sr-status') return srEl;
      if (sel.startsWith('#') && liveInputs.has(sel.slice(1))) return liveInputs.get(sel.slice(1));
      if (sel === '#cardio-open-btn' && appHtmlVal.includes('id="cardio-open-btn"')) {
        return { id: 'cardio-open-btn', focus() { document.activeElement = this; } };
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-act="cardio-min"]') return [...minChipButtons.values()];
      return [];
    },
    getElementById(id) {
      if (id === 'rest-timer-slot') return slotEl;
      if (id === 'rest-timer-val') return slotEl.innerHTML.includes('id="rest-timer-val"') ? valEl : null;
      if (id === 'sr-status') return srEl;
      if (liveInputs.has(id)) return liveInputs.get(id);
      return null;
    }
  };

  const location = { href: 'http://127.0.0.1/', hostname: '127.0.0.1', search: `?lang=${lang}`, replace(u) { location.href = u; } };
  const window = {
    location,
    scrollTo() {},
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    ritual: { hosted: true, async logout() {}, async deleteAccount() {} }
  };

  const ctx = vm.createContext({
    window, document, location, localStorage, sessionStorage,
    navigator: { userAgent: 'node-test', languages: [lang === 'en' ? 'en-US' : 'zh-CN'] },
    URL, URLSearchParams, AbortController,
    Date: MockDate, Math, JSON, Object, Array, Set, Map, Promise, Number, String, Boolean, RegExp, Error,
    encodeURIComponent, decodeURIComponent, isNaN, parseFloat, parseInt,
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: fn => fn(),
    HTMLImageElement: class HTMLImageElement {}
  });
  vm.runInContext(script, ctx);

  ctx.__store = store;
  ctx.__sample = Object.assign(async () => { aiCalls++; return { text: '{}' }; }, {
    json: async () => { aiCalls++; return {}; }
  });
  vm.runInContext(`
    storageUser = ${JSON.stringify(uid)};
    S.uid = ${JSON.stringify(uid)};
    S.ready = true;
    S.cloud = true;
    S.store = __store;
    S.sample = __sample;
    S.serverSample = __sample;
    S.tab = "today";
    S.date = todayStr();
  `, ctx);

  async function bootLoad() {
    await vm.runInContext('loadAll().then(() => render())', ctx);
  }

  async function click(act, v) {
    const btn = {
      dataset: { act, ...(v !== undefined ? { v: String(v) } : {}) },
      disabled: false,
      closest(sel) { return sel === '[data-act]' ? btn : null; }
    };
    for (const fn of (docListeners.click || [])) {
      await fn({ target: btn });
    }
  }

  function typeInput(id, value) {
    const el = liveInputs.get(id);
    assert.ok(el, `expected rendered input #${id}`);
    el.value = String(value);
    document.activeElement = el;
    for (const fn of (docListeners.input || [])) {
      fn({ target: el });
    }
  }

  function setTime(iso) { nowMs = RealDate.parse(iso); }
  function advanceMs(ms) { nowMs += ms; }

  return {
    ctx, store, appEl, toastEl, srEl, document, localStorage, sessionStorage,
    toasts, announcements, liveInputs, minChipButtons,
    getAiCalls: () => aiCalls,
    bootLoad, click, typeInput, setTime, advanceMs
  };
}

function findFreePort() {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojin-cardio-'));
  const port = await findFreePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dir,
    AUTH_BASE_URL: base,
    AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
    COOKIE_SECURE: '0',
    TRUST_PROXY: '0',
    MAIL_MODE: 'file',
    OPENROUTER_API_KEY: ''
  };
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', c => { stderr += c.toString(); });
  t.after(async () => {
    if (proc.exitCode === null) {
      const stopped = new Promise(r => proc.once('exit', r));
      proc.kill();
      await stopped;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return { base, dir, env, proc };
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`server failed to start: ${stderr}`);
}

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

test('logging, editing, and deleting cardio on both workout and rest days with zh/en translation, "other" validation, HIIT smart intensity, and XSS escaping', async () => {
  const env = mountCardioEnv({ lang: 'zh', fixedIso: '2026-11-20T18:00:00Z' }); // Friday = workout day
  await env.bootLoad();

  // Compact closed state on workout day (below workout card, above check-in)
  const htmlClosed = env.appEl.innerHTML;
  assert.ok(htmlClosed.includes('id="cardio-card"'));
  assert.ok(htmlClosed.includes('有氧运动'));
  assert.ok(htmlClosed.includes('不额外增加当日饮食热量目标'));
  assert.ok(htmlClosed.includes('aria-expanded="false"'));
  assert.ok(!htmlClosed.includes('id="cardio-form"'));
  assert.ok(htmlClosed.indexOf('data-act="save-workout"') < htmlClosed.indexOf('id="cardio-card"'));
  assert.ok(htmlClosed.indexOf('id="cardio-card"') < htmlClosed.indexOf('今日打卡'));

  // Open form -> default 20 min, low intensity, incline_walk selected -> 2-tap save
  await env.click('cardio-open');
  assert.ok(env.appEl.innerHTML.includes('id="cardio-form"'));
  assert.ok(env.appEl.innerHTML.includes('aria-expanded="true"'));
  assert.equal(env.liveInputs.get('cardio-minutes').value, '20');
  assert.equal(env.minChipButtons.get('20').getAttribute('aria-pressed'), 'true');

  // Test HIIT smart intensity default (auto-switches to high when untouched, reverts when switched back, respects manual pick)
  await env.click('cardio-type', 'hiit');
  assert.equal(vm.runInContext('S.cardioDraft[S.date].intensity', env.ctx), 'high');
  await env.click('cardio-type', 'incline_walk');
  assert.equal(vm.runInContext('S.cardioDraft[S.date].intensity', env.ctx), 'low');
  await env.click('cardio-int', 'mod');
  await env.click('cardio-type', 'hiit');
  assert.equal(vm.runInContext('S.cardioDraft[S.date].intensity', env.ctx), 'mod', 'manual intensity pick must not be overwritten');

  // Save incline_walk 20m low with note on workout day
  await env.click('cardio-type', 'incline_walk');
  await env.click('cardio-int', 'low');
  env.typeInput('cardio-note', '坡度 12 速度 5');
  await env.click('cardio-save');

  const workoutDay = vm.runInContext('S.days["2026-11-20"]', env.ctx);
  assert.equal(workoutDay.cardio.length, 1);
  assert.equal(workoutDay.cardio[0].type, 'incline_walk');
  assert.equal(workoutDay.cardio[0].minutes, 20);
  assert.equal(workoutDay.cardio[0].intensity, 'low');
  assert.equal(workoutDay.cardio[0].note, '坡度 12 速度 5');
  assert.equal('customName' in workoutDay.cardio[0], false);
  assert.equal(env.toasts.at(-1), '已保存有氧记录');
  assert.equal(env.announcements.at(-1), '已保存有氧记录');
  assert.equal(env.getAiCalls(), 0, 'zero AI calls on cardio save');

  // Language switch zh -> en translates standard modality automatically without changing stored canonical key
  await env.click('lang', 'en');
  assert.ok(env.appEl.innerHTML.includes('Incline Walk'));
  assert.ok(env.appEl.innerHTML.includes('20 min'));
  assert.ok(env.appEl.innerHTML.includes('Low'));
  assert.ok(env.appEl.innerHTML.includes('+ Add cardio'));
  assert.equal(vm.runInContext('S.days["2026-11-20"].cardio[0].type', env.ctx), 'incline_walk');

  // Edit saved item on workout day -> switch to "other", verify required customName & invalid minutes validation & XSS escaping
  const savedId = workoutDay.cardio[0].id;
  await env.click('cardio-edit', savedId);
  await env.click('cardio-type', 'other');
  env.typeInput('cardio-custom-name', '   ');
  await env.click('cardio-save');
  assert.ok(env.appEl.innerHTML.includes('Please enter an activity name'));
  assert.equal(vm.runInContext('S.days["2026-11-20"].cardio[0].type', env.ctx), 'incline_walk');

  env.typeInput('cardio-custom-name', 'Tennis <img src=x onerror=alert(1)>');
  env.typeInput('cardio-minutes', '20.5');
  await env.click('cardio-save');
  assert.ok(env.appEl.innerHTML.includes('whole number of minutes between 1 and 600'));

  env.typeInput('cardio-minutes', '45');
  assert.equal(env.minChipButtons.get('45').getAttribute('aria-pressed'), 'true');
  assert.equal(env.minChipButtons.get('20').getAttribute('aria-pressed'), 'false');
  env.typeInput('cardio-note', 'Singles & "drills" <b>ok</b>');
  await env.click('cardio-save');

  const updated = vm.runInContext('S.days["2026-11-20"].cardio[0]', env.ctx);
  assert.equal(updated.id, savedId);
  assert.equal(updated.type, 'other');
  assert.equal(updated.customName, 'Tennis <img src=x onerror=alert(1)>');
  assert.equal(updated.minutes, 45);
  assert.equal(updated.note, 'Singles & "drills" <b>ok</b>');
  assert.equal(env.toasts.at(-1), 'Cardio session updated');
  assert.equal(env.announcements.at(-1), 'Cardio session updated');
  assert.doesNotMatch(env.appEl.innerHTML, /<img src=x|<b>ok<\/b>/);
  assert.match(env.appEl.innerHTML, /Tennis &lt;img src=x onerror=alert\(1\)&gt;/);

  // Navigate to next day (2026-11-21 Saturday = rest day) -> Cardio card renders below Rest card & above Check-in
  await env.click('date', '1');
  assert.equal(vm.runInContext('S.date', env.ctx), '2026-11-21');
  const restHtml = env.appEl.innerHTML;
  assert.ok(restHtml.includes('No Lifting Today'));
  assert.ok(restHtml.includes('id="cardio-card"'));
  assert.ok(restHtml.indexOf('No Lifting Today') < restHtml.indexOf('id="cardio-card"'));
  assert.ok(restHtml.indexOf('id="cardio-card"') < restHtml.indexOf('Daily Check-in'));

  // Log & delete on rest day -> deleting last entry removes day.cardio cleanly
  await env.click('cardio-open');
  await env.click('cardio-type', 'bike');
  await env.click('cardio-min', '30');
  await env.click('cardio-int', 'mod');
  await env.click('cardio-save');

  const restSaved = vm.runInContext('S.days["2026-11-21"].cardio', env.ctx);
  assert.equal(restSaved.length, 1);
  assert.deepEqual(
    { type: restSaved[0].type, minutes: restSaved[0].minutes, intensity: restSaved[0].intensity },
    { type: 'bike', minutes: 30, intensity: 'mod' }
  );
  assert.equal('note' in restSaved[0], false, 'empty note omitted');

  await env.click('cardio-del', restSaved[0].id);
  assert.equal(vm.runInContext('"cardio" in S.days["2026-11-21"]', env.ctx), false, 'delete day.cardio when last entry removed');
  assert.equal(env.toasts.at(-1), 'Cardio session deleted');
  assert.equal(env.announcements.at(-1), 'Cardio session deleted');
  assert.equal(env.getAiCalls(), 0, 'zero AI calls across save/update/delete');
});

test('date-scoped & user-scoped draft isolation, live input preservation across chip clicks, rest-timer tick safety, and logout cleanup', async () => {
  const env = mountCardioEnv({ lang: 'zh', fixedIso: '2026-11-20T18:00:00Z' });
  await env.bootLoad();

  // Open cardio form on 2026-11-20, type note/minutes/customName, click chips -> live values preserved
  await env.click('cardio-open');
  await env.click('cardio-type', 'other');
  env.typeInput('cardio-custom-name', '羽毛球双打');
  env.typeInput('cardio-minutes', '35');
  env.typeInput('cardio-note', '微汗，恢复良好');

  // Click intensity chip (causes render) -> customName, minutes, note MUST survive
  await env.click('cardio-int', 'mod');
  assert.equal(env.liveInputs.get('cardio-custom-name').value, '羽毛球双打');
  assert.equal(env.liveInputs.get('cardio-minutes').value, '35');
  assert.equal(env.liveInputs.get('cardio-note').value, '微汗，恢复良好');

  // Start workout rest timer and tick + complete while focused in #cardio-note -> does NOT clobber input or steal focus
  vm.runInContext('startRestTimer("上斜杠铃卧推", 10)', env.ctx);
  const noteEl = env.liveInputs.get('cardio-note');
  env.document.activeElement = noteEl;
  env.advanceMs(3000);
  vm.runInContext('syncRestTimer()', env.ctx);
  assert.equal(env.document.activeElement, noteEl, 'rest timer tick must not steal focus from cardio input');
  assert.equal(env.liveInputs.get('cardio-note').value, '微汗，恢复良好');
  env.advanceMs(8000);
  vm.runInContext('syncRestTimer()', env.ctx);
  assert.equal(env.document.activeElement, noteEl, 'rest timer completion must not steal focus from cardio input');
  assert.equal(env.liveInputs.get('cardio-note').value, '微汗，恢复良好');

  // Switch date via dateBar to 2026-11-21 -> draft MUST NOT leak
  await env.click('date', '1');
  assert.equal(vm.runInContext('S.date', env.ctx), '2026-11-21');
  assert.ok(!env.appEl.innerHTML.includes('id="cardio-form"'));
  assert.ok(!env.appEl.innerHTML.includes('羽毛球双打'));
  assert.ok(!env.appEl.innerHTML.includes('微汗，恢复良好'));

  // Navigate back to 2026-11-20 -> original date's draft is still intact
  await env.click('date', '-1');
  assert.ok(env.appEl.innerHTML.includes('id="cardio-form"'));
  assert.equal(env.liveInputs.get('cardio-custom-name').value, '羽毛球双打');
  assert.equal(env.liveInputs.get('cardio-note').value, '微汗，恢复良好');

  // Logout clears all cardio drafts so next user never sees them
  await vm.runInContext('logout()', env.ctx);
  assert.deepEqual(vm.runInContext('Object.keys(S.cardioDraft)', env.ctx), []);

  // Re-open draft and verify clearUserLocal also clears cardio drafts
  vm.runInContext('openCardioDraft("2026-11-20")', env.ctx);
  assert.equal(vm.runInContext('Object.keys(S.cardioDraft).length', env.ctx), 1);
  vm.runInContext('clearUserLocal("u1")', env.ctx);
  assert.deepEqual(vm.runInContext('Object.keys(S.cardioDraft)', env.ctx), []);
});

test('Record Daily Breakdown (cardio-only rest days + pagination) and 14-day AI Coach Review prompts (zh & en) + calorie/TDEE invariance', async () => {
  // Seed 12 days to verify 10/page pagination alongside a cardio-only rest day
  const days = {};
  for (let i = 1; i <= 11; i++) {
    const d = `2026-11-${String(i + 8).padStart(2, '0')}`; // 2026-11-09 .. 2026-11-19
    days[d] = {
      date: d,
      checkin: { weight: 72 - i * 0.05, steps: 8500, sleep: 7.5 },
      meals: [
        { id: 'm1-' + i, type: '早餐', text: '燕麦', est: { kcal: 500, protein: 35, carbs: 55, fat: 14, by: 'manual' } },
        { id: 'm2-' + i, type: '午餐', text: '鸡胸饭', est: { kcal: 650, protein: 48, carbs: 70, fat: 15, by: 'manual' } },
        { id: 'm3-' + i, type: '晚餐', text: '牛肉面', est: { kcal: 620, protein: 40, carbs: 65, fat: 18, by: 'manual' } }
      ]
    };
  }
  const env = mountCardioEnv({ lang: 'zh', fixedIso: '2026-11-21T12:00:00Z', days }); // 2026-11-21 is Saturday (rest day)
  await env.bootLoad();

  // Capture targets, dayTargets, dayMacros, dayTdee, balanceSeries BEFORE logging cardio
  const before = vm.runInContext(`({
    targets: targets(),
    dayTargets: dayTargets("2026-11-21"),
    dayMacros: dayMacros("2026-11-21"),
    dayTdee: dayTdee("2026-11-21"),
    balance: balanceSeries(14)
  })`, env.ctx);

  // Log two cardio sessions on cardio-only rest day 2026-11-21 (no checkin, no meals, no workout)
  await env.click('cardio-open');
  await env.click('cardio-type', 'incline_walk');
  await env.click('cardio-min', '20');
  await env.click('cardio-int', 'low');
  env.typeInput('cardio-note', '坡度 12');
  await env.click('cardio-save');

  await env.click('cardio-open');
  await env.click('cardio-type', 'hiit');
  await env.click('cardio-min', '15');
  await env.click('cardio-save');

  // Verify calorie/macro targets, snapshot absence, and energy balance are 100% unchanged
  const after = vm.runInContext(`({
    targets: targets(),
    dayTargets: dayTargets("2026-11-21"),
    hasTargetsProp: Object.prototype.hasOwnProperty.call(S.days["2026-11-21"], "targets"),
    dayMacros: dayMacros("2026-11-21"),
    dayTdee: dayTdee("2026-11-21"),
    balance: balanceSeries(14)
  })`, env.ctx);
  assert.equal(after.hasTargetsProp, false, 'logging cardio must not stamp a day.targets snapshot');
  assert.deepEqual(after.targets, before.targets, 'targets() must not change after logging cardio');
  assert.deepEqual(after.dayTargets, before.dayTargets, 'dayTargets() must remain identical after logging cardio');
  assert.deepEqual(after.dayMacros, before.dayMacros, 'dayMacros() must not change after logging cardio');
  assert.equal(after.dayTdee, before.dayTdee, 'dayTdee() must not change after logging cardio');
  assert.deepEqual(after.balance, before.balance, 'balanceSeries() must not change after logging cardio');

  // Record tab -> Daily Breakdown (zh): cardio-only rest day appears on page 1, pagination shows 12 total (10/page)
  await env.click('tab', 'log');
  const logZh = env.appEl.innerHTML;
  assert.ok(logZh.includes('有氧：坡度快走 20分钟（低强度）、间歇有氧 (HIIT) 15分钟（高强度/间歇）'), `expected zh cardio chip in daily breakdown, got: ${logZh.slice(0, 600)}`);
  assert.ok(logZh.includes('1 / 2 · 共 12 条'), 'pagination reflects 12 days including cardio-only day');
  assert.equal((logZh.match(/class="day"/g) || []).length, 10);

  // Switch to English -> Daily Breakdown translates cleanly with zero CJK leakage
  await env.click('lang', 'en');
  const logEn = env.appEl.innerHTML;
  assert.ok(logEn.includes('Cardio: Incline Walk 20m (Low), Intervals (HIIT) 15m (High / Intervals)'));
  assert.ok(logEn.includes('1 / 2 · 12 total'));
  // Strip any stored Chinese meal text from non-cardio checks; verify cardio chip itself has zero CJK
  const cardioChipEn = logEn.match(/<span class="chip">Cardio:[^<]+<\/span>/);
  assert.ok(cardioChipEn, 'English cardio chip rendered');
  assert.equal(CJK_RE.test(cardioChipEn[0]), false, `English cardio chip must have zero CJK: ${cardioChipEn[0]}`);

  // 14-day AI Coach Review prompts in BOTH zh and en include cardio modality, minutes, intensity, and note
  const promptZh = vm.runInContext('buildFeedbackPrompt("", "zh")', env.ctx);
  assert.ok(promptZh.includes('2026-11-21：'));
  assert.ok(promptZh.includes('有氧：坡度快走 20分钟（低强度） 备注:坡度 12；间歇有氧 (HIIT) 15分钟（高强度/间歇）'));

  const promptEn = vm.runInContext('buildFeedbackPrompt("", "en")', env.ctx);
  assert.ok(promptEn.includes('2026-11-21:'));
  assert.ok(promptEn.includes('Cardio: Incline Walk 20m (Low) [坡度 12]; Intervals (HIIT) 15m (High / Intervals)'));
});

test('sanitizer bounds validation and full server cloud sync + export/import round-trip preservation of day.cardio', async t => {
  // 1. Unit check client sanitizer bounds
  const env = mountCardioEnv({ lang: 'zh' });
  const sanitized = vm.runInContext(`migrateDay({
    date: "2026-11-20",
    meals: [],
    cardio: [
      { id: "ok1", type: "run", minutes: 30, intensity: "mod", note: "  " + "x".repeat(150) },
      { id: "ok2", type: "other", customName: "  " + "A".repeat(60), minutes: "45", intensity: "bad_int", note: "" },
      { id: "bad-type", type: "flying", minutes: 20, intensity: "low" },
      { id: "bad-min-0", type: "run", minutes: 0, intensity: "low" },
      { id: "bad-min-hi", type: "run", minutes: 601, intensity: "low" },
      { id: "bad-min-dec", type: "run", minutes: 12.5, intensity: "low" },
      { id: "bad-other-empty", type: "other", customName: "   ", minutes: 20, intensity: "low" },
      ...Array.from({ length: 25 }, (_, i) => ({ id: "cap-" + i, type: "bike", minutes: 10, intensity: "low" }))
    ]
  })`, env.ctx);
  assert.equal(sanitized.cardio.length, 20, 'capped at 20 items per day');
  assert.equal(sanitized.cardio[0].note.length, 120, 'note truncated to 120 chars');
  assert.equal(sanitized.cardio[1].customName.length, 40, 'customName truncated to 40 chars');
  assert.equal(sanitized.cardio[1].minutes, 45);
  assert.equal(sanitized.cardio[1].intensity, 'low', 'invalid intensity normalized to low');
  assert.equal('note' in sanitized.cardio[1], false, 'empty note stripped');
  assert.equal(sanitized.cardio.some(x => x.id.startsWith('bad-')), false, 'invalid entries rejected');

  // 2. Real server round-trip: /api/doc PUT/GET, /api/list, /api/account/export NDJSON, and importAccount
  const srv = await startTestServer(t);
  const email1 = 'cardio-sync@example.com';
  const email2 = 'cardio-import@example.com';
  const pwStr = 'cardio-strong-password-123';

  async function signupAndVerify(email) {
    const issued = spawnSync(process.execPath, ['scripts/auth-admin.js', 'invite', email], {
      cwd: ROOT, env: srv.env, encoding: 'utf8', timeout: 5000
    });
    assert.equal(issued.status, 0, issued.stderr);
    const invite = JSON.parse(issued.stdout);

    const reg = await fetch(`${srv.base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bojin': '1', Origin: srv.base },
      body: JSON.stringify({
        email, password: pwStr, name: 'Cardio Tester',
        invitation: invite.token,
        consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION
      })
    });
    assert.equal(reg.status, 200, await reg.text());

    const mailFiles = fs.readdirSync(path.join(srv.dir, 'mail'));
    const verifyMail = mailFiles
      .map(f => JSON.parse(fs.readFileSync(path.join(srv.dir, 'mail', f), 'utf8')))
      .find(m => m.kind === 'verify' && m.to === email);
    assert.ok(verifyMail, 'verification mail captured');
    const verUrl = new URL(verifyMail.url);
    await fetch(`${srv.base}${verUrl.pathname}${verUrl.search}`, { redirect: 'manual' });

    const login = await fetch(`${srv.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bojin': '1', Origin: srv.base },
      body: JSON.stringify({ email, password: pwStr })
    });
    assert.equal(login.status, 200, await login.text());
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const me = await (await fetch(`${srv.base}/api/me`, { headers: { Cookie: cookie } })).json();
    return { cookie, me };
  }

  const u1 = await signupAndVerify(email1);
  const dayPath = `data/users/${u1.me.id}/app/days/2026-11-21`;
  const dayPayload = {
    date: '2026-11-21',
    meals: [],
    cardio: [
      { id: 'c1', type: 'incline_walk', minutes: 20, intensity: 'low', note: 'Incline 12' },
      { id: 'c2', type: 'other', customName: 'Tennis', minutes: 45, intensity: 'mod' }
    ]
  };
  const putRes = await fetch(`${srv.base}/api/doc?path=${encodeURIComponent(dayPath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Bojin': '1', Cookie: u1.cookie },
    body: JSON.stringify({ data: dayPayload })
  });
  assert.equal(putRes.status, 200);

  const getRes = await (await fetch(`${srv.base}/api/doc?path=${encodeURIComponent(dayPath)}`, {
    headers: { Cookie: u1.cookie }
  })).json();
  assert.equal(getRes.exists, true);
  assert.deepEqual(getRes.data.cardio, dayPayload.cardio);

  // /api/account/export NDJSON preserves day.cardio
  const expText = await (await fetch(`${srv.base}/api/account/export`, {
    headers: { Cookie: u1.cookie }
  })).text();
  const lines = expText.trim().split('\n').map(l => JSON.parse(l));
  const exportedDay = lines.find(l => l.kind === 'document' && l.path === dayPath);
  assert.ok(exportedDay, 'exported NDJSON includes day doc');
  assert.deepEqual(exportedDay.data.cardio, dayPayload.cardio);

  // importAccount restores exported day.cardio into a second verified account
  const u2 = await signupAndVerify(email2);
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojin-cardio-imp-'));
  t.after(() => fs.rmSync(importDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(importDir, 'docs', 'days'), { recursive: true });
  fs.writeFileSync(path.join(importDir, 'docs', 'days', '2026-11-21.json'), JSON.stringify(exportedDay.data));
  const impRes = await importAccount({ dataDir: srv.dir, email: email2, dir: importDir, log() {} });
  assert.equal(impRes.importedDocs, 1);

  const u2Doc = await (await fetch(`${srv.base}/api/doc?path=${encodeURIComponent(`data/users/${u2.me.id}/app/days/2026-11-21`)}`, {
    headers: { Cookie: u2.cookie }
  })).json();
  assert.equal(u2Doc.exists, true);
  assert.deepEqual(u2Doc.data.cardio, dayPayload.cardio);
});

test('headless Chromium E2E: log, edit, reload persistence, language toggle, daily breakdown, and logout draft cleanup', async t => {
  const pw = resolvePlaywright();
  if (!pw) {
    t.skip('Playwright/Chromium not installed in this environment');
    return;
  }

  const srv = await startTestServer(t);
  const email = 'cardio-e2e@example.com';
  const pwStr = 'cardio-e2e-password-123';
  const issued = spawnSync(process.execPath, ['scripts/auth-admin.js', 'invite', email], {
    cwd: ROOT, env: srv.env, encoding: 'utf8', timeout: 5000
  });
  assert.equal(issued.status, 0, issued.stderr);
  const invite = JSON.parse(issued.stdout);

  const browser = await pw.chromium.launch({
    executablePath: pw.executablePath,
    headless: true,
    args: ['--no-sandbox']
  });
  t.after(async () => { await browser.close(); });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(`${srv.base}/login.html?invite=${encodeURIComponent(invite.token)}&email=${encodeURIComponent(email)}`);
  await page.locator('#n').fill('Cardio E2E');
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
  await page.locator('#e').fill(email);
  await page.locator('#p').fill(pwStr);
  await page.locator('#go').click();
  await page.locator('#setup').waitFor({ state: 'visible' });
  await page.locator('#f-age').fill('29');
  await page.locator('#f-height').fill('176');
  await page.locator('#f-weight').fill('72');
  await page.locator('#f-bf').fill('15');
  await page.locator('button[type="submit"]').click();
  await page.locator('nav#tabs').waitFor({ state: 'visible' });

  // Log incline_walk 30m with note
  await page.locator('#cardio-open-btn').click();
  await page.locator('#cardio-note').fill('坡度 12 速度 5');
  await page.locator('[data-act="cardio-min"][data-v="30"]').click();
  assert.equal(await page.locator('#cardio-note').inputValue(), '坡度 12 速度 5', 'note preserved after duration chip click');
  await page.locator('[data-act="cardio-save"]').click();
  await page.locator('.cardio-item').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#cardio-card').textContent()).includes('坡度快走'));
  assert.ok((await page.locator('#cardio-card').textContent()).includes('30 分钟'));

  // Reload page -> persisted from cloud
  await page.reload();
  await page.locator('.cardio-item').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#cardio-card').textContent()).includes('坡度 12 速度 5'));

  // Switch to Record tab -> Daily Breakdown shows cardio
  await page.locator('nav#tabs [data-act="tab"][data-v="log"]').click();
  const logText = await page.locator('#app').textContent();
  assert.ok(logText.includes('有氧：坡度快走 30分钟（低强度）'));

  // Switch language to English -> Daily Breakdown translates standard modality
  await page.locator('nav#tabs [data-act="tab"][data-v="me"]').click();
  await page.locator('[data-act="lang"][data-v="en"]').click();
  await page.locator('nav#tabs [data-act="tab"][data-v="log"]').click();
  const logEnText = await page.locator('#app').textContent();
  assert.ok(logEnText.includes('Cardio: Incline Walk 30m (Low)'));

  await ctx.close();
});

test('P1 regression: cardio add, edit, and delete preserve exact day.targets snapshot value AND absence on today and historical days', async () => {
  // Case A: Existing snapshot differing from current profile targets (including on todayStr())
  const customSnap = { kcal: 2450, protein: 185, carbs: 270, fat: 68, st: 'bulk', w: 76.2, tdee: 2280 };
  const envA = mountCardioEnv({
    lang: 'zh',
    fixedIso: '2026-11-20T18:00:00Z',
    days: {
      '2026-11-20': { date: '2026-11-20', meals: [], targets: { ...customSnap } }
    }
  });
  await envA.bootLoad();
  const liveTargets = vm.runInContext('targets()', envA.ctx);
  assert.notEqual(liveTargets.kcal, customSnap.kcal, 'precondition: current profile targets differ from stored snapshot');

  // Add cardio on today -> stored snapshot must remain exact
  await envA.click('cardio-open');
  await envA.click('cardio-type', 'run');
  await envA.click('cardio-min', '20');
  await envA.click('cardio-save');
  assert.deepEqual(vm.runInContext('S.days["2026-11-20"].targets', envA.ctx), customSnap, 'add preserves today snapshot in memory');
  assert.deepEqual(envA.store.docs.get('days/2026-11-20').targets, customSnap, 'add preserves today snapshot in store');

  // Edit cardio on today -> stored snapshot must remain exact
  const addedId = vm.runInContext('S.days["2026-11-20"].cardio[0].id', envA.ctx);
  await envA.click('cardio-edit', addedId);
  await envA.click('cardio-min', '45');
  await envA.click('cardio-save');
  assert.deepEqual(vm.runInContext('S.days["2026-11-20"].targets', envA.ctx), customSnap, 'edit preserves today snapshot in memory');
  assert.deepEqual(envA.store.docs.get('days/2026-11-20').targets, customSnap, 'edit preserves today snapshot in store');

  // Delete cardio on today -> stored snapshot must remain exact
  await envA.click('cardio-del', addedId);
  assert.deepEqual(vm.runInContext('S.days["2026-11-20"].targets', envA.ctx), customSnap, 'delete preserves today snapshot in memory');
  assert.deepEqual(envA.store.docs.get('days/2026-11-20').targets, customSnap, 'delete preserves today snapshot in store');

  // Case B: Historical day and today WITHOUT day.targets snapshot -> absence preserved across add, edit, delete
  const envB = mountCardioEnv({
    lang: 'zh',
    fixedIso: '2026-11-20T18:00:00Z',
    days: {
      '2026-11-18': { date: '2026-11-18', meals: [], checkin: { weight: 72.1 } },
      '2026-11-20': { date: '2026-11-20', meals: [] }
    }
  });
  await envB.bootLoad();

  for (const date of ['2026-11-18', '2026-11-20']) {
    vm.runInContext(`S.date = ${JSON.stringify(date)}; render();`, envB.ctx);

    await envB.click('cardio-open');
    await envB.click('cardio-type', 'bike');
    await envB.click('cardio-min', '30');
    await envB.click('cardio-save');
    assert.equal(Object.prototype.hasOwnProperty.call(vm.runInContext(`S.days[${JSON.stringify(date)}]`, envB.ctx), 'targets'), false, `${date} add keeps targets absent in memory`);
    assert.equal(Object.prototype.hasOwnProperty.call(envB.store.docs.get('days/' + date), 'targets'), false, `${date} add keeps targets absent in store`);

    const cid = vm.runInContext(`S.days[${JSON.stringify(date)}].cardio[0].id`, envB.ctx);
    await envB.click('cardio-edit', cid);
    await envB.click('cardio-min', '45');
    await envB.click('cardio-save');
    assert.equal(Object.prototype.hasOwnProperty.call(envB.store.docs.get('days/' + date), 'targets'), false, `${date} edit keeps targets absent in store`);

    // Profile change still dynamically flows through dayTargets() because no snapshot was stamped
    const beforeKcal = vm.runInContext(`dayTargets(${JSON.stringify(date)}).kcal`, envB.ctx);
    vm.runInContext('S.profile.kcalAdjust = -200;', envB.ctx);
    const afterKcal = vm.runInContext(`dayTargets(${JSON.stringify(date)}).kcal`, envB.ctx);
    assert.equal(afterKcal, beforeKcal - 200, `${date} dayTargets still follows profile dynamically`);
    vm.runInContext('S.profile.kcalAdjust = 0;', envB.ctx);

    await envB.click('cardio-del', cid);
    assert.equal(Object.prototype.hasOwnProperty.call(envB.store.docs.get('days/' + date), 'targets'), false, `${date} delete keeps targets absent in store`);
  }
});

test('P1 regression: adversarial non-primitive JSON cardio fields never throw during loadAll hydration or rendering', async () => {
  const malformedDay = JSON.parse(JSON.stringify({
    date: '2026-11-20',
    meals: [],
    cardio: [
      { id: { toString: 1 }, type: 'run', minutes: 20, intensity: 'low', customName: { toString: 1 }, note: { toString: [], valueOf: null } },
      { id: 'drop-other-obj', type: 'other', minutes: 30, intensity: 'mod', customName: { toString: 1 }, note: 'bad other' },
      { type: { toString: 1 }, minutes: 20, intensity: 'low' },
      { id: 'drop-min-obj', type: 'bike', minutes: { toString: 1 }, intensity: { valueOf: null } },
      null,
      ['not', 'an', 'object'],
      { id: 'good-sibling', type: 'swim', minutes: 25, intensity: { toString: 1 }, note: 'Pool laps' }
    ]
  }));
  const siblingDay = {
    date: '2026-11-19',
    meals: [],
    cardio: [{ id: 'prev-1', type: 'incline_walk', minutes: 20, intensity: 'low', note: 'Steady' }]
  };
  const env = mountCardioEnv({
    lang: 'zh',
    fixedIso: '2026-11-20T18:00:00Z',
    days: { '2026-11-20': malformedDay, '2026-11-19': siblingDay }
  });

  await env.bootLoad();
  assert.equal(vm.runInContext('!!S.loadError', env.ctx), false, 'loadAll must hydrate cleanly without throwing');

  const hydratedToday = vm.runInContext('S.days["2026-11-20"].cardio', env.ctx);
  assert.equal(hydratedToday.length, 2, 'keeps both valid sessions and drops malformed ones');
  assert.equal(hydratedToday[0].id, 'c0');
  assert.equal(hydratedToday[0].type, 'run');
  assert.equal(hydratedToday[0].minutes, 20);
  assert.equal(hydratedToday[0].intensity, 'low');
  assert.equal('note' in hydratedToday[0], false, 'non-string note treated as empty and omitted');
  assert.equal('customName' in hydratedToday[0], false);

  assert.equal(hydratedToday[1].id, 'good-sibling');
  assert.equal(hydratedToday[1].type, 'swim');
  assert.equal(hydratedToday[1].minutes, 25);
  assert.equal(hydratedToday[1].intensity, 'low', 'non-string intensity safely falls back to low');
  assert.equal(hydratedToday[1].note, 'Pool laps');

  assert.equal(vm.runInContext('S.days["2026-11-19"].cardio.length', env.ctx), 1, 'sibling day preserved intact');
  assert.doesNotThrow(() => vm.runInContext('viewToday(); viewLog(); buildFeedbackPrompt("", "zh"); buildFeedbackPrompt("", "en");', env.ctx));
});

test('P2 regression: sanitizer deduplicates colliding cardio IDs (raw, trimmed, 64-char truncated, fallback) and edit/delete affect only target item', async () => {
  const longBase = 'a'.repeat(64);
  const env = mountCardioEnv({
    lang: 'en',
    fixedIso: '2026-11-20T18:00:00Z',
    days: {
      '2026-11-20': {
        date: '2026-11-20',
        meals: [],
        cardio: [
          { id: 'dup', type: 'run', minutes: 20, intensity: 'low', note: 'first' },
          { id: '  dup  ', type: 'bike', minutes: 30, intensity: 'mod', note: 'second' },
          { id: longBase + 'X', type: 'row', minutes: 15, intensity: 'low', note: 'long-1' },
          { id: longBase + 'Y', type: 'swim', minutes: 25, intensity: 'mod', note: 'long-2' },
          { id: 'c5', type: 'elliptical', minutes: 18, intensity: 'low', note: 'explicit-c5' },
          { type: 'jump_rope', minutes: 12, intensity: 'high', note: 'fallback-c5' }
        ]
      }
    }
  });
  await env.bootLoad();

  const items = vm.runInContext('S.days["2026-11-20"].cardio', env.ctx);
  assert.equal(items.length, 6, 'all 6 valid sessions preserved');
  const ids = items.map(x => x.id);
  assert.equal(new Set(ids).size, 6, `all normalized IDs must be unique: ${JSON.stringify(ids)}`);
  for (const id of ids) assert.ok(id.length <= 64, `normalized ID exceeds 64 chars: ${id.length}`);
  assert.equal(ids[0], 'dup');
  assert.equal(ids[1], 'dup-2');
  assert.equal(ids[2], longBase);
  assert.equal(ids[3], 'a'.repeat(62) + '-2');
  assert.equal(ids[4], 'c5');
  assert.equal(ids[5], 'c5-2');

  // Normalization is idempotent
  const twice = Array.from(vm.runInContext('sanitizeCardioList(S.days["2026-11-20"].cardio).map(x => x.id)', env.ctx));
  assert.deepEqual(twice, Array.from(ids));

  // Edit only the second colliding item ('dup-2') -> first item ('dup') untouched
  await env.click('cardio-edit', 'dup-2');
  assert.equal(env.liveInputs.get('cardio-minutes').value, '30');
  assert.equal(env.liveInputs.get('cardio-note').value, 'second');
  await env.click('cardio-min', '45');
  env.typeInput('cardio-note', 'second-edited');
  await env.click('cardio-save');

  const afterEdit = vm.runInContext('S.days["2026-11-20"].cardio', env.ctx);
  assert.equal(afterEdit.length, 6);
  assert.equal(afterEdit[0].id, 'dup');
  assert.equal(afterEdit[0].minutes, 20);
  assert.equal(afterEdit[0].note, 'first');
  assert.equal(afterEdit[1].id, 'dup-2');
  assert.equal(afterEdit[1].minutes, 45);
  assert.equal(afterEdit[1].note, 'second-edited');

  // Delete only 'dup-2' -> only that single item removed; 'dup' and remaining 4 survive round-trip reload
  await env.click('cardio-del', 'dup-2');
  await env.bootLoad();
  const afterReload = vm.runInContext('S.days["2026-11-20"].cardio', env.ctx);
  assert.equal(afterReload.length, 5);
  assert.deepEqual(Array.from(afterReload, x => x.id), ['dup', longBase, 'a'.repeat(62) + '-2', 'c5', 'c5-2']);
  assert.equal(afterReload[0].note, 'first');
});

test('fallback localStorage-backed store (non-commit get/set path) and bj-wbackup local restoration preserve day.cardio across reloads', async () => {
  const env = mountCardioEnv({ lang: 'zh', fixedIso: '2026-11-20T18:00:00Z' });
  // Build a localStorage-backed store adapter WITHOUT .commit to exercise the non-commit mutate() fallback path
  const localPrefix = 'fallback-cache:';
  const lsBackedStore = {
    async get(p) {
      const raw = env.localStorage.getItem(localPrefix + p);
      return raw ? JSON.parse(raw) : null;
    },
    async set(p, d) {
      env.localStorage.setItem(localPrefix + p, JSON.stringify(d));
    },
    async del(p) {
      env.localStorage.removeItem(localPrefix + p);
    },
    async list(col) {
      const pfx = localPrefix + col + '/';
      const out = [];
      for (const k of Object.keys(env.localStorage.dump())) {
        if (k.startsWith(pfx)) {
          out.push({ id: k.slice(pfx.length), data: JSON.parse(env.localStorage.getItem(k)) });
        }
      }
      return out;
    }
  };
  await lsBackedStore.set('app/profile', env.store.docs.get('app/profile'));
  env.ctx.__lsStore = lsBackedStore;
  vm.runInContext('S.store = __lsStore; S.cloud = false;', env.ctx);
  await env.bootLoad();

  // Add cardio via non-commit fallback store
  await env.click('cardio-open');
  await env.click('cardio-type', 'stairmaster');
  await env.click('cardio-min', '20');
  await env.click('cardio-int', 'mod');
  env.typeInput('cardio-note', '本地缓存回退测试');
  await env.click('cardio-save');

  // Seed a local workout backup in bj-wbackup for the same day, then reload via loadAll() (runs restoreWorkouts)
  vm.runInContext(`lsSet("bj-wbackup", { "2026-11-20": { key: "push", slot: "eve", done: true, savedAt: "2026-11-20T19:00:00Z", exercises: [{ name: "上斜杠铃卧推", sets: [{ w: 60, r: 8 }] }] } });`, env.ctx);
  await env.bootLoad();

  const reloaded = vm.runInContext('S.days["2026-11-20"]', env.ctx);
  assert.equal(reloaded.workout?.done, true, 'workout restored from localStorage bj-wbackup');
  assert.equal(reloaded.cardio.length, 1, 'cardio preserved across localStorage fallback reload and workout restore');
  assert.equal(reloaded.cardio[0].type, 'stairmaster');
  assert.equal(reloaded.cardio[0].minutes, 20);
  assert.equal(reloaded.cardio[0].intensity, 'mod');
  assert.equal(reloaded.cardio[0].note, '本地缓存回退测试');

  // Edit & reload via non-commit fallback store
  const cid = reloaded.cardio[0].id;
  await env.click('cardio-edit', cid);
  await env.click('cardio-min', '30');
  await env.click('cardio-save');
  await env.bootLoad();
  assert.equal(vm.runInContext('S.days["2026-11-20"].cardio[0].minutes', env.ctx), 30);

  // Delete & reload via non-commit fallback store
  await env.click('cardio-del', cid);
  await env.bootLoad();
  assert.equal(vm.runInContext('"cardio" in S.days["2026-11-20"]', env.ctx), false);
});
