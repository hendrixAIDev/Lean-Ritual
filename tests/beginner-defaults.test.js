'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
const fullScript = source.match(/<script>([\s\S]*?)<\/script>/)[1];
const pageScript = fullScript.split('/* ============ 启动 ============ */')[0];

const CJK_RE = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
const PULLUP_ORIG = '引体向上（能做 6 个后负重）';

function decodeAttr(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeAttr(String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function createApp({ lang = 'zh', profileOverrides = {}, days = {} } = {}) {
  const docs = new Map();
  const store = {
    async get(p) { return docs.has(p) ? JSON.parse(JSON.stringify(docs.get(p))) : null; },
    set(p, d) { docs.set(p, JSON.parse(JSON.stringify(d))); },
    async commit(changes) {
      for (const { path: p, before } of changes) {
        if (JSON.stringify(docs.get(p) ?? null) !== JSON.stringify(before)) {
          throw Object.assign(new Error('stale snapshot'), { code: 'doc_conflict' });
        }
      }
      for (const { path: p, after } of changes) {
        if (after !== undefined) store.set(p, after);
      }
    },
    async del(p) { docs.delete(p); },
    async list() { return []; }
  };

  const storage = new Map([['bj-lang', lang]]);
  const listeners = {};
  const toasts = [];
  const appEl = { innerHTML: '' };
  const tabsEl = { innerHTML: '', hidden: false };
  const toastEl = {
    hidden: true,
    _t: '',
    get textContent() { return this._t; },
    set textContent(v) { this._t = String(v); toasts.push(this._t); }
  };

  const ctx = vm.createContext({
    window: { scrollTo() {}, ritual: { hosted: true } },
    location: { href: 'http://127.0.0.1/', hostname: '127.0.0.1', search: '', reload() {}, replace() {} },
    navigator: { languages: [lang === 'en' ? 'en-US' : 'zh-CN'] },
    AbortController,
    document: {
      documentElement: { lang: lang === 'en' ? 'en' : 'zh-CN' },
      title: '',
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      querySelector(sel) {
        if (sel === '#app') return appEl;
        if (sel === '#tabs') return tabsEl;
        if (sel === '#toast') return toastEl;
        return null;
      },
      querySelectorAll() { return []; },
      getElementById(id) { return this.querySelector('#' + id); }
    },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    console: { ...console, warn() {}, error() {} },
    URL,
    Date,
    setTimeout,
    clearTimeout
  });

  vm.runInContext(pageScript, ctx);
  ctx.__store = store;

  const profile = {
    sex: 'm', age: 26, height: 175, weight: 70, bf: 16, steps: 9500,
    exp: 'new', stage: 'cut', trainDays: [0, 1, 2, 3, 4, 5, 6], slot: 'eve',
    equipment: 'gym', startDate: '2026-11-01', injuries: [], supps: [],
    kcalAdjust: 0, deloadEvery: 9, swaps: {}, exEdits: {}, adjustLog: [],
    lang, schema: 2,
    ...profileOverrides
  };
  docs.set('app/profile', JSON.parse(JSON.stringify(profile)));
  for (const [d, val] of Object.entries(days)) {
    docs.set('days/' + d, JSON.parse(JSON.stringify(val)));
  }

  ctx.__initProfile = profile;
  ctx.__initDays = days;
  vm.runInContext(`
    storageUser = "u1";
    S.uid = "u1";
    S.ready = true;
    S.cloud = true;
    S.store = __store;
    S.sample = null;
    S.explicitLang = ${JSON.stringify(lang)};
    S.profile = clone(__initProfile);
    S.days = clone(__initDays);
    S.tab = "today";
    render();
  `, ctx);

  async function click(act, v) {
    const btn = {
      dataset: { act, ...(v !== undefined ? { v: String(v) } : {}) },
      disabled: false,
      closest(sel) { return sel === '[data-act]' ? btn : null; }
    };
    for (const fn of listeners.click || []) await fn({ target: btn });
  }

  return { ctx, docs, appEl, toasts, click };
}

test('Gym and Home Pull day resolve beginner-friendly defaults for exp="new" with zero duplicate exercises, while mid/adv remain unchanged', () => {
  const app = createApp();
  const resolveAll = (exp, equipment, injuries = []) => vm.runInContext(`
    (() => {
      const p = { exp: ${JSON.stringify(exp)}, equipment: ${JSON.stringify(equipment)}, injuries: ${JSON.stringify(injuries)}, swaps: {}, exEdits: {} };
      return Object.fromEntries(ORDER.map(k => [k, PROGRAM[k].ex.map(ex => resolveExForProfile(ex, p))]));
    })()
  `, app.ctx);

  // 1. Gym exp="new": pull[1] -> 高位下拉 3×8–12, rest 2–3 分钟, inc 2.5, why 新手默认
  const gymNew = resolveAll('new', 'gym');
  assert.equal(gymNew.pull[1].name, '高位下拉');
  assert.equal(gymNew.pull[1].orig, PULLUP_ORIG);
  assert.equal(gymNew.pull[1].sets, 3);
  assert.equal(gymNew.pull[1].lo, 8);
  assert.equal(gymNew.pull[1].hi, 12);
  assert.equal(gymNew.pull[1].rest, '2–3 分钟');
  assert.equal(gymNew.pull[1].inc, 2.5);
  assert.equal(gymNew.pull[1].why, '新手默认');

  // 2. Gym exp="mid" & "adv": unchanged 引体向上（能做 6 个后负重） 3×4–6
  for (const exp of ['mid', 'adv']) {
    const gymExp = resolveAll(exp, 'gym');
    assert.equal(gymExp.pull[1].name, PULLUP_ORIG);
    assert.equal(gymExp.pull[1].sets, 3);
    assert.equal(gymExp.pull[1].lo, 4);
    assert.equal(gymExp.pull[1].hi, 6);
    assert.equal(gymExp.pull[1].rest, '3 分钟');
    assert.equal(gymExp.pull[1].inc, 2.5);
    assert.equal(gymExp.pull[1].why, null);
  }

  // 3. Home exp="new": pull[1] -> 弹力带下拉（门扣或高处固定） 3×10–15, inc 0, why 新手默认 (and NO duplicate 反向划船!)
  const homeNew = resolveAll('new', 'home');
  assert.equal(homeNew.pull[1].name, '弹力带下拉（门扣或高处固定）');
  assert.equal(homeNew.pull[1].orig, PULLUP_ORIG);
  assert.equal(homeNew.pull[1].sets, 3);
  assert.equal(homeNew.pull[1].lo, 10);
  assert.equal(homeNew.pull[1].hi, 15);
  assert.equal(homeNew.pull[1].inc, 0);
  assert.equal(homeNew.pull[1].why, '新手默认');
  assert.equal(homeNew.pull[2].name, '反向划船（桌下或低杠）');

  // 4. Home exp="mid" & "adv": unchanged 引体向上 3×4–10, why 居家器械
  for (const exp of ['mid', 'adv']) {
    const homeExp = resolveAll(exp, 'home');
    assert.equal(homeExp.pull[1].name, '引体向上');
    assert.equal(homeExp.pull[1].lo, 4);
    assert.equal(homeExp.pull[1].hi, 10);
    assert.equal(homeExp.pull[1].inc, 0);
    assert.equal(homeExp.pull[1].why, '居家器械');
  }

  // 5. Verify ZERO duplicate exercise names within any workout across all exp × equipment combinations
  for (const exp of ['new', 'mid', 'adv']) {
    for (const eq of ['gym', 'home']) {
      const days = resolveAll(exp, eq);
      for (const k of ['push', 'pull', 'legs']) {
        const names = days[k].map(e => e.name);
        assert.equal(new Set(names).size, names.length, `Duplicate exercise found in ${exp}/${eq}/${k}: ${JSON.stringify(names)}`);
      }
    }
  }
});

test('precedence order: injuries, p.swaps, p.exEdits, and day.exEdits all override beginner defaults cleanly', () => {
  const app = createApp();
  const today = vm.runInContext('todayStr()', app.ctx);

  // 1. Injury substitution (shoulder / elbow) overrides Gym beginner default to 高位下拉（中立握）
  for (const inj of ['shoulder', 'elbow']) {
    const res = vm.runInContext(`
      resolveExForProfile(PROGRAM.pull.ex[1], { exp: "new", equipment: "gym", injuries: [${JSON.stringify(inj)}], swaps: {}, exEdits: {} })
    `, app.ctx);
    assert.equal(res.name, '高位下拉（中立握）');
    assert.equal(res.lo, 8);
    assert.equal(res.hi, 12);
    assert.match(res.why, /有伤，已替换/);
  }

  // 2. p.swaps overrides beginner default & injury substitution
  const swapped = vm.runInContext(`
    resolveExForProfile(PROGRAM.pull.ex[1], {
      exp: "new", equipment: "gym", injuries: ["shoulder"],
      swaps: { ${JSON.stringify(PULLUP_ORIG)}: ${JSON.stringify(PULLUP_ORIG)} }, exEdits: {}
    })
  `, app.ctx);
  assert.equal(swapped.name, PULLUP_ORIG);
  assert.equal(swapped.why, '根据反馈调整');

  // 3. p.exEdits overrides beginner default & p.swaps
  const longEdited = vm.runInContext(`
    resolveExForProfile(PROGRAM.pull.ex[1], {
      exp: "new", equipment: "gym", injuries: [],
      swaps: { ${JSON.stringify(PULLUP_ORIG)}: "高位下拉" },
      exEdits: { ${JSON.stringify(PULLUP_ORIG)}: { name: ${JSON.stringify(PULLUP_ORIG)}, sets: 4, lo: 4, hi: 6, rest: "3 分钟", inc: 2.5 } }
    })
  `, app.ctx);
  assert.equal(longEdited.name, PULLUP_ORIG);
  assert.equal(longEdited.sets, 4);
  assert.equal(longEdited.why, '你设定的长期调整');

  // 4. day.exEdits overrides beginner default & long-term edits on that day only
  vm.runInContext(`
    S.profile.exp = "new";
    S.profile.equipment = "gym";
    S.profile.exEdits = {};
    S.days[${JSON.stringify(today)}] = {
      date: ${JSON.stringify(today)},
      override: "pull",
      meals: [],
      exEdits: { ${JSON.stringify(PULLUP_ORIG)}: { name: ${JSON.stringify(PULLUP_ORIG)}, sets: 3, lo: 4, hi: 6, rest: "3 分钟", inc: 2.5 } }
    };
  `, app.ctx);
  const todayPlan = vm.runInContext(`planFor(${JSON.stringify(today)})`, app.ctx);
  assert.equal(todayPlan.ex[1].name, PULLUP_ORIG);
  assert.equal(todayPlan.ex[1].why, '只今天替换');
});

test('strong beginner can switch from default Lat Pulldown to Pull-Ups in 1 tap via inline editor with zero AI calls', async () => {
  const today = '2026-11-27';
  const app = createApp({
    lang: 'zh',
    profileOverrides: { exp: 'new', equipment: 'gym' },
    days: { [today]: { date: today, override: 'pull', meals: [] } }
  });
  vm.runInContext(`S.date = ${JSON.stringify(today)}; render();`, app.ctx);

  // Initially renders 高位下拉 with 新手默认 badge
  assert.match(app.appEl.innerHTML, /高位下拉/);
  assert.match(app.appEl.innerHTML, /新手默认/);

  // Open inline editor on exercise #1 (pull[1]) with S.sample === null (zero AI)
  await app.click('ed-open', '1');
  assert.match(app.appEl.innerHTML, new RegExp(`data-act="ed-pick" data-v="${PULLUP_ORIG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.doesNotMatch(app.appEl.innerHTML, /data-act="ed-ai"/, 'works completely without AI enabled');

  // 1-tap preset pick switches editor to 引体向上（能做 6 个后负重） 3×4–6
  await app.click('ed-pick', PULLUP_ORIG);
  const edAfterPick = vm.runInContext('clone(S.ed)', app.ctx);
  assert.equal(edAfterPick.name, PULLUP_ORIG);
  assert.equal(edAfterPick.sets, 3);
  assert.equal(edAfterPick.lo, 4);
  assert.equal(edAfterPick.hi, 6);

  // Save as long-term ("always") -> overrides beginner default permanently
  await app.click('ed-scope', 'always');
  await app.click('ed-save');
  const savedPlanEx = vm.runInContext(`planFor(${JSON.stringify(today)}).ex[1]`, app.ctx);
  assert.equal(savedPlanEx.name, PULLUP_ORIG);
  assert.equal(savedPlanEx.lo, 4);
  assert.equal(savedPlanEx.hi, 6);
  assert.equal(savedPlanEx.why, '你设定的长期调整');
  assert.equal(app.docs.get('app/profile').exEdits[PULLUP_ORIG].name, PULLUP_ORIG);

  // Resetting returns cleanly to beginner default 高位下拉
  await app.click('ed-open', '1');
  await app.click('ed-reset');
  const resetEx = vm.runInContext(`planFor(${JSON.stringify(today)}).ex[1]`, app.ctx);
  assert.equal(resetEx.name, '高位下拉');
  assert.equal(resetEx.why, '新手默认');
});

test('translations, cues, why badge, exMeta, history(), and suggest() work identically in zh and en without CJK leakage', () => {
  const today = '2026-11-27';
  const prevDay = '2026-11-20';

  // English Gym beginner Pull day + prior Lat Pulldown history at 12 reps -> suggests +2.5kg
  const enGym = createApp({
    lang: 'en',
    profileOverrides: { exp: 'new', equipment: 'gym', lang: 'en' },
    days: {
      [prevDay]: {
        date: prevDay,
        meals: [],
        workout: {
          done: true,
          key: 'pull',
          exercises: [
            { name: '高位下拉', sets: [{ w: '40', r: '12' }, { w: '40', r: '12' }, { w: '40', r: '12' }] }
          ]
        }
      },
      [today]: { date: today, override: 'pull', meals: [] }
    }
  });
  vm.runInContext(`S.date = ${JSON.stringify(today)}; render();`, enGym.ctx);

  assert.match(enGym.appEl.innerHTML, /Lat Pulldown/);
  assert.match(enGym.appEl.innerHTML, /Beginner default/);
  assert.equal(CJK_RE.test(stripTags(enGym.appEl.innerHTML)), false, `Unexpected CJK in EN Gym Today view: ${stripTags(enGym.appEl.innerHTML)}`);

  const gymMeta = vm.runInContext('exMeta("高位下拉")', enGym.ctx);
  assert.equal(gymMeta.name, '高位下拉');
  assert.equal(gymMeta.lo, 8);
  assert.equal(gymMeta.hi, 12);
  assert.equal(gymMeta.inc, 2.5);

  const gymSug = vm.runInContext(`suggest(planFor(${JSON.stringify(today)}).ex[1], ${JSON.stringify(today)}, false)`, enGym.ctx);
  assert.equal(gymSug.w, 42.5, 'hitting 12 reps on Lat Pulldown suggests +2.5kg progression');

  // English Home beginner Pull day + cues + zero CJK leakage + progression (+1 rep since inc === 0)
  const enHome = createApp({
    lang: 'en',
    profileOverrides: { exp: 'new', equipment: 'home', lang: 'en' },
    days: {
      [prevDay]: {
        date: prevDay,
        meals: [],
        workout: {
          done: true,
          key: 'pull',
          exercises: [
            { name: '弹力带下拉（门扣或高处固定）', sets: [{ w: '0', r: '12' }, { w: '0', r: '12' }, { w: '0', r: '12' }] }
          ]
        }
      },
      [today]: { date: today, override: 'pull', meals: [] }
    }
  });
  vm.runInContext(`S.date = ${JSON.stringify(today)}; render();`, enHome.ctx);

  assert.match(enHome.appEl.innerHTML, /Band Lat Pulldown \(Door Anchor or High Point\)/);
  assert.match(enHome.appEl.innerHTML, /Beginner default/);
  assert.match(enHome.appEl.innerHTML, /Anchor band with a door anchor or high point/);
  assert.equal(CJK_RE.test(stripTags(enHome.appEl.innerHTML)), false, `Unexpected CJK in EN Home Today view: ${stripTags(enHome.appEl.innerHTML)}`);

  const homeMeta = vm.runInContext('exMeta("弹力带下拉（门扣或高处固定）")', enHome.ctx);
  assert.equal(homeMeta.name, '弹力带下拉（门扣或高处固定）');
  assert.equal(homeMeta.lo, 10);
  assert.equal(homeMeta.hi, 15);
  assert.equal(homeMeta.inc, 0);

  const homeSug = vm.runInContext(`suggest(planFor(${JSON.stringify(today)}).ex[1], ${JSON.stringify(today)}, false)`, enHome.ctx);
  assert.equal(homeSug.w, 0);
  assert.match(homeSug.text, /13/);

  // Chinese cues exist for both exercises
  const zhCues = vm.runInContext('({ lat: CUES["高位下拉"], band: CUES["弹力带下拉"] })', enHome.ctx);
  assert.ok(Array.isArray(zhCues.lat) && zhCues.lat.length >= 3);
  assert.ok(Array.isArray(zhCues.band) && zhCues.band.length >= 3);
});

test('past completed workouts (day.workout.done / savedPlan) are 100% unaffected when exp changes between new and mid/adv', () => {
  const pastDate = '2026-11-15';
  const savedWorkout = {
    done: true,
    key: 'pull',
    slot: 'eve',
    deload: false,
    savedAt: pastDate + 'T18:00:00Z',
    plan: [
      { name: '硬拉', sets: 3, lo: 4, hi: 6, rest: '3 分钟', inc: 5, orig: '硬拉', why: null },
      { name: PULLUP_ORIG, sets: 3, lo: 4, hi: 6, rest: '3 分钟', inc: 2.5, orig: PULLUP_ORIG, why: null }
    ],
    exercises: [
      { name: '硬拉', sets: [{ w: '100', r: '5' }, { w: '100', r: '5' }, { w: '100', r: '5' }] },
      { name: PULLUP_ORIG, sets: [{ w: '0', r: '6' }, { w: '0', r: '6' }, { w: '0', r: '5' }] }
    ]
  };
  const legacySavedDate = '2026-11-10';
  const legacyWorkout = {
    done: true,
    key: 'pull',
    slot: 'eve',
    exercises: [
      { name: PULLUP_ORIG, sets: [{ w: '0', r: '5' }, { w: '0', r: '5' }, { w: '0', r: '5' }] }
    ]
  };

  const app = createApp({
    profileOverrides: { exp: 'mid', equipment: 'gym' },
    days: {
      [pastDate]: { date: pastDate, meals: [], workout: savedWorkout },
      [legacySavedDate]: { date: legacySavedDate, meals: [], workout: legacyWorkout }
    }
  });

  const beforeWithPlan = vm.runInContext(`JSON.stringify(planFor(${JSON.stringify(pastDate)}))`, app.ctx);
  const beforeLegacy = vm.runInContext(`JSON.stringify(planFor(${JSON.stringify(legacySavedDate)}))`, app.ctx);

  // Switch experience to beginner ("new") and even change equipment to "home"
  vm.runInContext('S.profile.exp = "new"; S.profile.equipment = "home";', app.ctx);

  const afterWithPlan = vm.runInContext(`JSON.stringify(planFor(${JSON.stringify(pastDate)}))`, app.ctx);
  const afterLegacy = vm.runInContext(`JSON.stringify(planFor(${JSON.stringify(legacySavedDate)}))`, app.ctx);

  assert.equal(afterWithPlan, beforeWithPlan, 'completed workout with saved plan must be 100% unaffected');
  assert.equal(afterLegacy, beforeLegacy, 'legacy completed workout without plan snapshot must be 100% unaffected');
});

test('name-only p.swaps back to Pull-Up restores canonical pull-up sets/reps/rest/inc (does not inherit band pulldown defaults)', () => {
  const app = createApp();

  // Home beginner with name-only swap back to weighted Pull-Up
  const swappedWeighted = vm.runInContext(`
    resolveExForProfile(PROGRAM.pull.ex[1], {
      exp: "new", equipment: "home", injuries: [],
      swaps: { ${JSON.stringify(PULLUP_ORIG)}: ${JSON.stringify(PULLUP_ORIG)} },
      exEdits: {}
    })
  `, app.ctx);
  assert.equal(swappedWeighted.name, PULLUP_ORIG);
  assert.equal(swappedWeighted.sets, 3);
  assert.equal(swappedWeighted.lo, 4);
  assert.equal(swappedWeighted.hi, 6);
  assert.equal(swappedWeighted.rest, '3 分钟');
  assert.equal(swappedWeighted.inc, 2.5);
  assert.equal(swappedWeighted.why, '根据反馈调整');

  // Home beginner with name-only swap to bodyweight Pull-Up
  const swappedBw = vm.runInContext(`
    resolveExForProfile(PROGRAM.pull.ex[1], {
      exp: "new", equipment: "home", injuries: [],
      swaps: { ${JSON.stringify(PULLUP_ORIG)}: "引体向上" },
      exEdits: {}
    })
  `, app.ctx);
  assert.equal(swappedBw.name, '引体向上');
  assert.equal(swappedBw.sets, 3);
  assert.equal(swappedBw.lo, 4);
  assert.equal(swappedBw.hi, 10);
  assert.equal(swappedBw.rest, '3 分钟');
  assert.equal(swappedBw.inc, 0);
  assert.equal(swappedBw.why, '根据反馈调整');
});

test('injury substitutions use grip-specific neutral cues on Gym and Home shoulder/elbow profiles without breaking Home lowback', () => {
  const today = '2026-11-27';

  // 1. Gym neutral-grip cues in zh & en must instruct neutral/parallel grip, NOT overhand grip
  const zhGym = createApp({ lang: 'zh', profileOverrides: { exp: 'new', equipment: 'gym', injuries: ['shoulder'] }, days: { [today]: { date: today, override: 'pull', meals: [] } } });
  const zhNeutralHtml = vm.runInContext('howTo("高位下拉（中立握）")', zhGym.ctx);
  const zhOverhandHtml = vm.runInContext('howTo("高位下拉")', zhGym.ctx);
  assert.match(zhNeutralHtml, /对握\/中立握/);
  assert.doesNotMatch(zhNeutralHtml, /正手/);
  assert.match(zhOverhandHtml, /正手/);

  const enGym = createApp({ lang: 'en', profileOverrides: { exp: 'new', equipment: 'gym', injuries: ['elbow'], lang: 'en' }, days: { [today]: { date: today, override: 'pull', meals: [] } } });
  const enNeutralHtml = vm.runInContext('howTo("高位下拉（中立握）")', enGym.ctx);
  const enOverhandHtml = vm.runInContext('howTo("高位下拉")', enGym.ctx);
  assert.match(enNeutralHtml, /neutral\/parallel-grip/i);
  assert.doesNotMatch(enNeutralHtml, /overhand/i);
  assert.match(enOverhandHtml, /overhand/i);

  // 2. Home shoulder/elbow beginner gets neutral-grip pain-free ROM band pulldown with dedicated cues and zero duplicates
  for (const inj of ['shoulder', 'elbow']) {
    const res = vm.runInContext(`
      PROGRAM.pull.ex.map(ex => resolveExForProfile(ex, { exp: "new", equipment: "home", injuries: [${JSON.stringify(inj)}], swaps: {}, exEdits: {} }))
    `, zhGym.ctx);
    assert.equal(res[1].name, '弹力带下拉（中立握，无痛幅度）');
    assert.equal(res[1].sets, 3);
    assert.equal(res[1].lo, 10);
    assert.equal(res[1].hi, 15);
    assert.equal(res[1].inc, 0);
    assert.match(res[1].why, /有伤，已替换/);
    const names = res.map(e => e.name);
    assert.equal(new Set(names).size, names.length, `zero duplicates for home/${inj}/pull`);
  }

  // English Home shoulder Today view renders neutral-grip band pulldown & cues with zero CJK
  const enHomeInj = createApp({
    lang: 'en',
    profileOverrides: { exp: 'new', equipment: 'home', injuries: ['shoulder'], lang: 'en' },
    days: { [today]: { date: today, override: 'pull', meals: [] } }
  });
  vm.runInContext(`S.date = ${JSON.stringify(today)}; render();`, enHomeInj.ctx);
  assert.match(enHomeInj.appEl.innerHTML, /Band Lat Pulldown \(Neutral Grip, Pain-Free ROM\)/);
  assert.match(enHomeInj.appEl.innerHTML, /palms facing each other/i);
  assert.equal(CJK_RE.test(stripTags(enHomeInj.appEl.innerHTML)), false, `Unexpected CJK in EN Home shoulder view: ${stripTags(enHomeInj.appEl.innerHTML)}`);

  // 3. Home lowback still swaps hinge to glute bridge and keeps regular beginner band pulldown in vertical pull slot
  const homeLowback = vm.runInContext(`
    PROGRAM.pull.ex.map(ex => resolveExForProfile(ex, { exp: "new", equipment: "home", injuries: ["lowback"], swaps: {}, exEdits: {} }))
  `, zhGym.ctx);
  assert.equal(homeLowback[0].name, '臀桥（可背包负重）');
  assert.equal(homeLowback[1].name, '弹力带下拉（门扣或高处固定）');
  assert.equal(homeLowback[1].why, '新手默认');
});

