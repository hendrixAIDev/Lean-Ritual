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

function mountTimerEnv({ lang = 'zh', uid = 'u1', sessionInit = {}, completedWorkout = false } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const script = extractInlineScript(html).split('/* ============ 启动 ============ */')[0];

  const RealDate = Date;
  let nowMs = RealDate.parse('2026-11-20T18:00:00Z');
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(nowMs);
      else super(...args);
    }
    static now() { return nowMs; }
    static parse(s) { return RealDate.parse(s); }
    static UTC(...args) { return RealDate.UTC(...args); }
  }

  const intervals = new Map();
  let nextIntervalId = 1;
  const mockSetInterval = (fn, ms) => {
    const id = nextIntervalId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  const mockClearInterval = id => { intervals.delete(id); };

  const localStorage = makeStorage({ 'bj-lang': lang });
  const sessionStorage = makeStorage(sessionInit);

  const docListeners = {};
  const winListeners = {};
  const announcements = [];
  let renderCount = 0;

  const appEl = { id: 'app', innerHTML: '', contains: () => false };
  const tabsEl = { id: 'tabs', innerHTML: '', hidden: true, setAttribute() {} };
  const toastEl = { id: 'toast', innerHTML: '', textContent: '', hidden: true };
  const srEl = {
    id: 'sr-status',
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) {
      this._text = String(v);
      if (this._text) announcements.push(this._text);
    }
  };
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
  const weightInputEl = { id: 'w-0-0-w', value: '60', disabled: false, focus() { document.activeElement = weightInputEl; } };

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
      if (sel === '[data-act="rest-start"]') return { focus() {} };
      return null;
    },
    querySelectorAll() { return []; },
    getElementById(id) {
      if (id === 'rest-timer-slot') return slotEl;
      if (id === 'rest-timer-val') return slotEl.innerHTML.includes('id="rest-timer-val"') ? valEl : null;
      if (id === 'sr-status') return srEl;
      if (id === 'w-0-0-w') return weightInputEl;
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
    window,
    document,
    location,
    localStorage,
    sessionStorage,
    navigator: { userAgent: 'node-test', languages: [lang === 'en' ? 'en-US' : 'zh-CN'] },
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
    clearTimeout,
    setInterval: mockSetInterval,
    clearInterval: mockClearInterval
  });

  vm.runInContext(script, ctx);

  // Instrument render() to verify ticks NEVER trigger full render()
  ctx._onRender = () => {
    renderCount++;
    const m = appEl.innerHTML.match(/<div id="rest-timer-slot"[^>]*>([\s\S]*?)<\/div>\s*(?:<div class="ex"|<div class="tip)/);
    if (m) slotEl.innerHTML = m[1];
  };
  vm.runInContext(`
    const __origRender = render;
    render = function(){ __origRender(); _onRender(); };
  `, ctx);

  const td = '2026-11-20';
  vm.runInContext(`
    storageUser = ${JSON.stringify(uid)};
    S.uid = ${JSON.stringify(uid)};
    S.hostUser = { id: ${JSON.stringify(uid)}, username: "lifter" };
    S.cloud = true;
    S.profile = {
      sex: "m", age: 29, height: 176, weight: 72, bf: 15, steps: 9500,
      exp: "mid", stage: "cut", trainDays: [1, 3, 5], slot: "eve", equipment: "gym",
      injuries: [], supps: ["creatine"], startDate: "2026-11-01", lang: ${JSON.stringify(lang)}
    };
    S.date = ${JSON.stringify(td)};
    S.days[${JSON.stringify(td)}] = {
      date: ${JSON.stringify(td)},
      override: "push",
      meals: [],
      ${completedWorkout ? `workout: { key: "push", slot: "eve", done: true, exercises: [{ name: "上斜杠铃卧推", sets: [{ w: 60, r: 5 }] }] }` : ''}
    };
    S.tab = "today";
    hydrateRestTimer(S.uid);
    S.ready = true;
    render();
  `, ctx);
  renderCount = 0; // reset after initial mount

  return {
    ctx,
    appEl,
    slotEl,
    valEl,
    srEl,
    weightInputEl,
    document,
    sessionStorage,
    announcements,
    intervals,
    getRenderCount: () => renderCount,
    advanceMs(ms) { nowMs += ms; },
    tickAll() { for (const { fn } of [...intervals.values()]) fn(); },
    fireDoc(type) { for (const fn of docListeners[type] || []) fn({}); },
    fireWin(type) { for (const fn of winListeners[type] || []) fn({}); },
    async click(act, v) {
      const btn = {
        dataset: { act, ...(v !== undefined ? { v: String(v) } : {}) },
        disabled: false,
        closest(sel) { return sel === '[data-act]' ? btn : null; }
      };
      for (const fn of docListeners.click || []) await fn({ target: btn });
    }
  };
}

test('parseRestSeconds handles Chinese & English durations, ranges (midpoint), clock strings, and 90s fallback', () => {
  const env = mountTimerEnv();
  const parse = raw => vm.runInContext(`parseRestSeconds(${JSON.stringify(raw)})`, env.ctx);
  assert.equal(parse('3 分钟'), 180);
  assert.equal(parse('2–3 分钟'), 150);
  assert.equal(parse('1–2 分钟'), 90);
  assert.equal(parse('1 分钟'), 60);
  assert.equal(parse('3 min'), 180);
  assert.equal(parse('2-3 min'), 150);
  assert.equal(parse('1–2 minutes'), 90);
  assert.equal(parse('1.5 min'), 90);
  assert.equal(parse('90s'), 90);
  assert.equal(parse('45 sec'), 45);
  assert.equal(parse('60 秒'), 60);
  assert.equal(parse('60–90 秒'), 75);
  assert.equal(parse('2:30'), 150);
  assert.equal(parse(''), 90);
  assert.equal(parse(null), 90);
  assert.equal(parse('whenever ready'), 90);
});

test('1-tap rest buttons appear on active workouts (not completed workouts), localize in zh/en, and pass WCAG 2.5.3', () => {
  const zhActive = mountTimerEnv({ lang: 'zh', completedWorkout: false });
  const zhBtns = [...zhActive.appEl.innerHTML.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(m => m[1].includes('data-act="rest-start"'));
  assert.equal(zhBtns.length, 5, 'push day has 5 exercises with 1-tap rest buttons');
  assert.equal(zhBtns[0][2], '休 3:00');
  assert.equal(zhBtns[3][2], '休 1:30');
  for (const [, attrs, text] of zhBtns) {
    assert.match(attrs, /\btype="button"/);
    const aria = attrs.match(/\baria-label="([^"]+)"/)?.[1] || '';
    assert.ok(aria.startsWith(text), `WCAG 2.5.3: "${aria}" must start with "${text}"`);
  }

  const enActive = mountTimerEnv({ lang: 'en', completedWorkout: false });
  const enBtns = [...enActive.appEl.innerHTML.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(m => m[1].includes('data-act="rest-start"'));
  assert.equal(enBtns.length, 5);
  assert.equal(enBtns[0][2], 'Rest 3:00');
  assert.equal(enBtns[3][2], 'Rest 1:30');
  for (const [, attrs, text] of enBtns) {
    const aria = attrs.match(/\baria-label="([^"]+)"/)?.[1] || '';
    assert.ok(aria.startsWith(text));
    assert.equal(CJK_RE.test(aria), false);
    assert.equal(CJK_RE.test(text), false);
  }

  const completed = mountTimerEnv({ lang: 'zh', completedWorkout: true });
  assert.doesNotMatch(completed.appEl.innerHTML, /data-act="rest-start"/, 'completed workout omits 1-tap rest start buttons');
});

test('wall-clock lock-screen jump (Date.now + visibilitychange / pageshow / focus), controls (-15s, +30s, Pause/Resume, Dismiss), focus preservation, and ARIA rules', async () => {
  const env = mountTimerEnv({ lang: 'zh' });

  // Focus a weight input as if lifter is typing weights
  env.weightInputEl.focus();
  assert.equal(env.document.activeElement, env.weightInputEl);

  // Start 3:00 (180s) rest timer for exercise 0 (上斜杠铃卧推)
  await env.click('rest-start', '0');
  assert.equal(env.valEl.textContent, '3:00');
  assert.equal(env.getRenderCount(), 0, 'starting rest timer updates slot in-place without full render()');
  assert.equal(env.document.activeElement, env.weightInputEl, 'weight input keeps focus');
  assert.equal(env.announcements.length, 1, 'start announces once via #sr-status');
  assert.match(env.announcements[0], /上斜杠铃卧推.*3:00/);

  // Verify NO aria-live on timer bar or countdown value
  assert.doesNotMatch(env.slotEl.innerHTML, /aria-live/, 'timer bar and MM:SS must NEVER have aria-live');

  // Tick several seconds while typing -> ONLY textContent updates, zero render(), zero #sr-status spam, focus preserved
  env.advanceMs(1000);
  env.tickAll();
  assert.equal(env.valEl.textContent, '2:59');
  env.advanceMs(4000);
  env.tickAll();
  assert.equal(env.valEl.textContent, '2:55');
  assert.equal(env.getRenderCount(), 0, 'ticks must NEVER call render()');
  assert.equal(env.announcements.length, 1, 'ticks must NEVER spam #sr-status');
  assert.equal(env.document.activeElement, env.weightInputEl, 'weight input keeps focus while timer ticks');

  // Simulated 2-minute iPhone lock screen: advance wall clock by 120s without ticks, then fire visibilitychange
  env.advanceMs(120_000);
  env.fireDoc('visibilitychange');
  assert.equal(env.valEl.textContent, '0:55', 'visibilitychange immediately recalculates exact wall-clock remaining time');
  assert.equal(env.getRenderCount(), 0);

  // Test -15s and +30s
  await env.click('rest-adj', '-15');
  assert.equal(env.valEl.textContent, '0:40');
  await env.click('rest-adj', '30');
  assert.equal(env.valEl.textContent, '1:10');

  // Test Pause -> wall clock advances 5 minutes while paused -> remaining stays frozen at 1:10
  await env.click('rest-toggle');
  assert.equal(env.intervals.size, 0, 'pausing stops tick interval');
  assert.match(env.slotEl.innerHTML, /继续/);
  assert.equal(env.announcements.length, 2, 'pause announces once via #sr-status');
  env.advanceMs(300_000);
  env.fireWin('pageshow');
  env.fireWin('focus');
  assert.equal(env.valEl.textContent, '1:10', 'paused timer does not drain while locked');

  // Test Resume -> runs again from 1:10
  await env.click('rest-toggle');
  assert.equal(env.intervals.size, 1, 'resuming restarts tick interval');
  assert.match(env.slotEl.innerHTML, /暂停/);
  assert.equal(env.announcements.length, 3, 'resume announces once via #sr-status');

  // Lock screen past completion: advance 80s and fire pageshow -> transitions to completion state immediately
  env.advanceMs(80_000);
  env.fireWin('pageshow');
  assert.equal(env.valEl.textContent, '0:00');
  assert.match(env.slotEl.innerHTML, /休息结束 · 开始下一组/);
  assert.equal(env.intervals.size, 0, 'completion stops tick interval');
  assert.equal(env.announcements.length, 4, 'completion announces ONCE via #sr-status');
  assert.match(env.announcements[3], /休息结束/);
  assert.equal(env.document.activeElement, env.weightInputEl, 'weight input still keeps focus when timer finishes');

  // Repeated focus/visibilitychange after done does NOT re-announce
  env.fireWin('focus');
  env.fireDoc('visibilitychange');
  assert.equal(env.announcements.length, 4, 'completion must not re-announce');

  // Full render() cleanly re-hydrates completed timer bar
  vm.runInContext('render()', env.ctx);
  assert.match(env.appEl.innerHTML, /id="rest-timer-bar"/);
  assert.match(env.appEl.innerHTML, /休息结束 · 开始下一组/);

  // +30s from completed state revives timer cleanly
  await env.click('rest-adj', '30');
  assert.equal(env.valEl.textContent, '0:30');
  assert.equal(env.intervals.size, 1);

  // Dismiss clears timer bar, stops interval, removes sessionStorage entry
  await env.click('rest-dismiss');
  assert.equal(env.slotEl.innerHTML, '');
  assert.equal(env.intervals.size, 0);
  assert.equal(env.sessionStorage.getItem('lr_rest_timer_u1'), null);
});

test('sessionStorage is strictly user-scoped, cleared on logout, and isolated across account switches', async () => {
  // 1. Start timer for u1 -> stored strictly under lr_rest_timer_u1
  const u1 = mountTimerEnv({ lang: 'en', uid: 'u1' });
  await u1.click('rest-start', '0');
  const savedRaw = u1.sessionStorage.getItem('lr_rest_timer_u1');
  assert.ok(savedRaw, 'timer persisted under lr_rest_timer_u1');
  assert.equal(u1.sessionStorage.getItem('lr_rest_timer_u2'), null);

  // 2. Same user reloads / re-hydrates -> timer restored accurately
  const u1Reload = mountTimerEnv({ lang: 'en', uid: 'u1', sessionInit: { lr_rest_timer_u1: savedRaw } });
  assert.match(u1Reload.appEl.innerHTML, /id="rest-timer-bar"/);
  assert.match(u1Reload.appEl.innerHTML, /Incline Barbell Bench Press/);
  assert.equal(u1Reload.valEl.textContent, '3:00');

  // 3. Different user u2 opens app on shared browser -> u1's timer is purged and NOT shown to u2
  const u2 = mountTimerEnv({ lang: 'en', uid: 'u2', sessionInit: { lr_rest_timer_u1: savedRaw } });
  assert.equal(u2.sessionStorage.getItem('lr_rest_timer_u1'), null, 'prior user timer purged on user switch');
  assert.equal(vm.runInContext('S.restTimer', u2.ctx), null);
  assert.doesNotMatch(u2.appEl.innerHTML, /id="rest-timer-bar"/);

  // 4. Logout clears current user's sessionStorage timer and stops interval
  await u1.click('logout');
  assert.equal(u1.sessionStorage.getItem('lr_rest_timer_u1'), null, 'logout clears lr_rest_timer_<uid>');
  assert.equal(vm.runInContext('S.restTimer', u1.ctx), null);
  assert.equal(u1.intervals.size, 0);
});

test('rest timer date-scoping regression: hidden on adjacent completed or other workout dates, preserved on return, and cleared when owning workout is marked done', async () => {
  const env = mountTimerEnv({ lang: 'zh', uid: 'u1' });
  // Seed adjacent date 2026-11-19 with a completed workout and 2026-11-21 with an active workout
  vm.runInContext(`
    S.days["2026-11-19"] = {
      date: "2026-11-19",
      meals: [],
      workout: { key: "pull", slot: "eve", done: true, exercises: [{ name: "硬拉", sets: [{ w: 100, r: 5 }] }] }
    };
    S.days["2026-11-21"] = { date: "2026-11-21", override: "legs", meals: [] };
    render();
  `, env.ctx);

  // Start 3:00 timer on active workout date 2026-11-20
  await env.click('rest-start', '0');
  assert.equal(env.valEl.textContent, '3:00');
  assert.equal(vm.runInContext('S.restTimer.date', env.ctx), '2026-11-20');

  // Switch to adjacent date 2026-11-19 (completed workout): bar and controls must be hidden!
  await env.click('date', '-1');
  assert.equal(vm.runInContext('S.date', env.ctx), '2026-11-19');
  assert.doesNotMatch(env.appEl.innerHTML, /id="rest-timer-bar"/, 'completed adjacent date hides prior timer bar');
  assert.doesNotMatch(env.appEl.innerHTML, /data-act="rest-(?:adj|toggle|dismiss|start)"/, 'completed adjacent date renders no timer controls');
  assert.equal(env.slotEl.innerHTML, '', 'rest-timer-slot is empty on completed adjacent date');

  // Direct control clicks while on 2026-11-19 must NOT mutate or dismiss 2026-11-20's timer
  await env.click('rest-adj', '-15');
  await env.click('rest-toggle');
  await env.click('rest-dismiss');
  await env.click('rest-start', '0');
  assert.ok(vm.runInContext('S.restTimer', env.ctx), 'owning date timer remains intact while viewing another date');
  assert.equal(vm.runInContext('S.restTimer.pausedRemainingMs', env.ctx), null, 'owning date timer was not paused from another date');

  // Advance wall clock by 45s while away and tick -> bar stays hidden on 2026-11-19
  env.advanceMs(45_000);
  env.tickAll();
  assert.equal(env.slotEl.innerHTML, '');

  // Also check navigating to another active workout date (2026-11-21) hides 2026-11-20's timer
  await env.click('date', '1'); // -> 2026-11-20
  await env.click('date', '1'); // -> 2026-11-21
  assert.equal(vm.runInContext('S.date', env.ctx), '2026-11-21');
  assert.doesNotMatch(env.appEl.innerHTML, /id="rest-timer-bar"/, 'different active workout date hides 2026-11-20 timer');

  // Navigate back to owning active workout date 2026-11-20 -> timer reappears with exact remaining time (2:15)
  await env.click('date', '-1');
  assert.equal(vm.runInContext('S.date', env.ctx), '2026-11-20');
  assert.match(env.appEl.innerHTML, /id="rest-timer-bar"/, 'returning to owning workout date shows active timer bar');
  assert.equal(env.valEl.textContent, '2:15', 'accurate wall-clock remaining time after navigating away and back');

  // Marking owning workout done clears the timer state, storage, and UI bar
  vm.runInContext(`
    S.days["2026-11-20"].workout = { key: "push", slot: "eve", done: true, exercises: [{ name: "上斜杠铃卧推", sets: [{ w: 60, r: 5 }] }] };
    render();
  `, env.ctx);
  assert.equal(vm.runInContext('S.restTimer', env.ctx), null, 'marking owning workout done clears timer');
  assert.equal(env.sessionStorage.getItem('lr_rest_timer_u1'), null, 'sessionStorage entry cleared when owning workout is done');
  assert.doesNotMatch(env.appEl.innerHTML, /id="rest-timer-bar"/);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-rest-timer-'));
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

test('headless Chromium: rest timer preserves focus while ticking, persists across reload, clears on logout, and passes axe-core in light/dark, mobile/desktop, zh/en', async t => {
  const pw = resolvePlaywright();
  if (!pw) { t.skip('Playwright/Chromium not installed'); return; }

  const axeSource = fs.readFileSync(AXE_PATH, 'utf8');
  const srv = await startTestServer(t);
  const issued = spawnSync(process.execPath, ['scripts/auth-admin.js', 'invite', 'timer@example.com'], {
    cwd: ROOT, env: srv.env, encoding: 'utf8', timeout: 5000
  });
  assert.equal(issued.status, 0, issued.stderr);
  const invite = JSON.parse(issued.stdout);
  const pwStr = 'timer-strong-password-123';

  const browser = await pw.chromium.launch({ executablePath: pw.executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.goto(`${srv.base}/login.html?invite=${encodeURIComponent(invite.token)}&email=${encodeURIComponent(invite.email)}`);
  await page.locator('#n').fill('Timer Tester');
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

  // Ensure today is an active push workout
  await page.evaluate(async () => {
    await updateDay(todayStr(), d => { d.override = 'push'; }, { quiet: true });
    render();
  });

  // Start rest timer on exercise 0 (3:00)
  await page.locator('[data-act="rest-start"]').first().click();
  await page.locator('#rest-timer-bar').waitFor({ state: 'visible' });
  const initialVal = await page.locator('#rest-timer-val').textContent();
  assert.match(initialVal, /^3:00|2:59$/);

  // Focus weight input, type while real 300ms ticks fire over 1.3s -> focus & value stay intact!
  const wInput = page.locator('#w-0-0-w');
  await wInput.focus();
  await page.keyboard.type('62.5');
  await page.waitForTimeout(1300);
  const focusCheck = await page.evaluate(() => ({
    activeId: document.activeElement?.id || null,
    val: document.getElementById('w-0-0-w')?.value || '',
    timerText: document.getElementById('rest-timer-val')?.textContent || '',
    hasAriaLive: document.getElementById('rest-timer-bar')?.hasAttribute('aria-live') || document.getElementById('rest-timer-val')?.hasAttribute('aria-live')
  }));
  assert.equal(focusCheck.activeId, 'w-0-0-w', 'weight input keeps focus across real ticks');
  assert.equal(focusCheck.val, '62.5');
  assert.notEqual(focusCheck.timerText, '3:00', 'timer ticked down in-place');
  assert.equal(focusCheck.hasAriaLive, false, 'no aria-live on ticking timer');

  // Verify user-scoped sessionStorage persistence across reload
  const storedKey = await page.evaluate(() => {
    const k = `lr_rest_timer_${S.uid}`;
    return { key: k, raw: sessionStorage.getItem(k) };
  });
  assert.ok(storedKey.raw, 'sessionStorage has user-scoped rest timer key');
  await page.reload();
  await page.locator('#rest-timer-bar').waitFor({ state: 'visible' });

  // Axe-core audit with active timer bar visible across light/dark, mobile/desktop, zh/en
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Runtime.evaluate', { expression: axeSource, awaitPromise: false });
  const configs = [
    { lang: 'zh', scheme: 'light', vp: { width: 390, height: 844 } },
    { lang: 'zh', scheme: 'dark', vp: { width: 390, height: 844 } },
    { lang: 'en', scheme: 'light', vp: { width: 390, height: 844 } },
    { lang: 'en', scheme: 'dark', vp: { width: 390, height: 844 } },
    { lang: 'en', scheme: 'light', vp: { width: 1280, height: 800 } }
  ];
  for (const cfg of configs) {
    await page.setViewportSize(cfg.vp);
    await page.emulateMedia({ colorScheme: cfg.scheme });
    await page.evaluate(async l => { await setLang(l, { persistProfile: false }); }, cfg.lang);
    await page.locator('#rest-timer-bar').waitFor({ state: 'visible' });
    const res = await cdp.send('Runtime.evaluate', {
      expression: `window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        rules: { 'target-size': { enabled: true } }
      }).then(r => JSON.stringify(r.violations))`,
      awaitPromise: true,
      returnByValue: true
    });
    assert.deepEqual(JSON.parse(res.result.value), [], `axe violations with active timer in ${cfg.lang}/${cfg.scheme}/${cfg.vp.width}`);
  }
  await cdp.detach();

  // Logout clears user-scoped sessionStorage timer
  await page.evaluate(async () => {
    // Clear draft so logout doesn't prompt on unsaved weight entry
    S.drafts = {}; persistDrafts();
    await logout();
  });
  await page.waitForURL(/\/login\.html/);
  const remainingTimer = await page.evaluate(k => sessionStorage.getItem(k), storedKey.key);
  assert.equal(remainingTimer, null, 'logout clears lr_rest_timer_<uid> from sessionStorage');
  assert.deepEqual(pageErrors, []);
  await ctx.close();
});
