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

function createApp({ lang = 'zh', profileOverrides = {}, docs = new Map() } = {}) {
  const listCols = prefix => {
    const out = [];
    for (const [k, v] of docs.entries()) {
      if (k.startsWith(prefix + '/')) out.push({ id: k.slice(prefix.length + 1), data: JSON.parse(JSON.stringify(v)) });
    }
    return out;
  };
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
    async list(col) { return listCols(col); }
  };

  const storage = new Map([['bj-lang', lang]]);
  const listeners = {};
  const toasts = [];
  const announcements = [];
  let focused = null;

  const appEl = { innerHTML: '' };
  const tabsEl = { innerHTML: '', hidden: false };
  const toastEl = {
    hidden: true,
    _t: '',
    get textContent() { return this._t; },
    set textContent(v) { this._t = String(v); toasts.push(this._t); }
  };
  const srEl = {
    _t: '',
    get textContent() { return this._t; },
    set textContent(v) { this._t = String(v); if (v) announcements.push(this._t); }
  };

  function parseButtons(html, actFilter) {
    const out = [];
    const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    for (const m of html.matchAll(re)) {
      const attrs = m[1];
      const act = attrs.match(/\bdata-act="([^"]*)"/)?.[1] || '';
      if (actFilter && act !== actFilter) continue;
      const vMatch = attrs.match(/\bdata-v=(?:'([^']*)'|"([^"]*)")/);
      const v = vMatch ? decodeAttr(vMatch[1] ?? vMatch[2]) : undefined;
      const src = attrs.match(/\bdata-src="([^"]*)"/)?.[1];
      const type = attrs.match(/\btype="([^"]*)"/)?.[1];
      const id = attrs.match(/\bid="([^"]*)"/)?.[1];
      const key = attrs.match(/\bdata-key="([^"]*)"/)?.[1];
      out.push({
        id,
        type,
        text: stripTags(m[2]),
        dataset: { act, ...(v !== undefined ? { v } : {}), ...(src ? { src } : {}), ...(key ? { key } : {}) },
        disabled: /\bdisabled\b/.test(attrs),
        focus() { focused = `${act}:${v ?? ''}:${src ?? ''}`; }
      });
    }
    return out;
  }

  const document = {
    documentElement: { lang: lang === 'en' ? 'en' : 'zh-CN' },
    title: '',
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector(sel) {
      if (sel === '#app') return appEl;
      if (sel === '#tabs') return tabsEl;
      if (sel === '#toast') return toastEl;
      if (sel === '#sr-status') return srEl;
      if (sel === '#undo-conflict-dialog [data-act="dismiss-conflict"]') {
        const dlg = appEl.innerHTML.match(/<div[^>]*id="undo-conflict-dialog"[\s\S]*$/);
        if (dlg && /data-act="dismiss-conflict"/.test(dlg[0])) {
          return { focus() { focused = 'dialog:dismiss-conflict'; } };
        }
        return null;
      }
      if (sel === '#undo-conflict-dialog button') {
        if (/id="undo-conflict-dialog"/.test(appEl.innerHTML)) {
          return { focus() { focused = 'dialog:button'; } };
        }
        return null;
      }
      if (sel === '.chooser button' && /class="chooser"/.test(appEl.innerHTML)) {
        return { focus() { focused = 'chooser:button'; } };
      }
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        if (new RegExp(`\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(appEl.innerHTML)) {
          return { id, focus() { focused = sel; } };
        }
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-act="undo-adjust"]') return parseButtons(appEl.innerHTML, 'undo-adjust');
      if (sel === '[data-act="adopt-open"]') return parseButtons(appEl.innerHTML, 'adopt-open');
      return [];
    },
    getElementById(id) { return this.querySelector('#' + id); }
  };

  const ctx = vm.createContext({
    window: { scrollTo() {}, ritual: { hosted: true } },
    location: { href: 'http://127.0.0.1/', hostname: '127.0.0.1', search: '', reload() {}, replace() {} },
    navigator: { languages: [lang === 'en' ? 'en-US' : 'zh-CN'] },
    AbortController,
    document,
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
    sex: 'm', age: 29, height: 176, weight: 72, bf: 15, steps: 9500,
    exp: 'mid', stage: 'cut', trainDays: [0, 1, 2, 3, 4, 5, 6], slot: 'eve',
    equipment: 'gym', startDate: '2026-10-01', injuries: [], supps: [],
    kcalAdjust: 0, deloadEvery: 9, swaps: {}, exEdits: {}, adjustLog: [],
    lang, schema: 2,
    ...profileOverrides
  };
  docs.set('app/profile', JSON.parse(JSON.stringify(profile)));
  ctx.__initProfile = profile;
  vm.runInContext(`
    storageUser = "u1";
    S.uid = "u1";
    S.ready = true;
    S.cloud = true;
    S.store = __store;
    S.explicitLang = ${JSON.stringify(lang)};
    S.profile = clone(__initProfile);
    S.tab = "fb";
    render();
  `, ctx);

  async function seedFeedback(list) {
    const arr = Array.isArray(list) ? list : [list];
    for (const fb of arr) docs.set('feedback/' + fb.id, JSON.parse(JSON.stringify(fb)));
    ctx.__fbs = arr;
    vm.runInContext('S.feedback = clone(__fbs); render();', ctx);
  }

  async function click(act, v, extraDataset = {}) {
    const btn = {
      dataset: { act, ...(v !== undefined ? { v: String(v) } : {}), ...extraDataset },
      disabled: false,
      closest(sel) { return sel === '[data-act]' ? btn : null; }
    };
    for (const fn of listeners.click || []) await fn({ target: btn });
    return btn;
  }

  function keydown(key) {
    let prevented = false;
    for (const fn of listeners.keydown || []) {
      fn({ key, preventDefault() { prevented = true; } });
    }
    return prevented;
  }

  function findButtonDataV(act, labelSubstr) {
    const btn = parseButtons(appEl.innerHTML, act).find(b => !labelSubstr || b.text.includes(labelSubstr));
    if (!btn) throw new Error(`Button data-act="${act}" (${labelSubstr || '*'}) not found in HTML`);
    return btn.dataset.v;
  }

  return {
    ctx, docs, appEl, toasts, announcements,
    getFocused: () => focused,
    clearFocused: () => { focused = null; },
    parseButtons: act => parseButtons(appEl.innerHTML, act),
    seedFeedback, click, keydown, findButtonDataV
  };
}

test('direct 1-tap undo works immediately when unedited across kcalAdjust, stage, swaps, exEdits, and today dayEdit', async () => {
  const app = createApp();
  const today = vm.runInContext('todayStr()', app.ctx);
  await app.seedFeedback({
    id: 'fb-direct',
    createdAt: today + 'T09:00:00Z',
    summary: '多类型一键撤销',
    adjustments: [
      { kind: 'kcal', delta: -120, text: '下调热量' },
      { kind: 'stage', stage: 'maintain', text: '进入维持期' },
      { kind: 'swap', from: '平板杠铃卧推', to: '平板哑铃卧推', text: '长期换哑铃' },
      { kind: 'edit', from: '深蹲', to: '腿举', sets: 3, lo: 8, hi: 12, text: '长期腿举' },
      { kind: 'swap', from: '硬拉', to: '杠铃臀推', sets: 3, lo: 8, hi: 10, text: '今天换臀推' }
    ],
    applied: []
  });

  // Adopt all 5
  await app.click('adopt-open', app.findButtonDataV('adopt-open', '-120 kcal'));
  await app.click('adopt-confirm', app.findButtonDataV('adopt-confirm', '采纳'));

  await app.click('adopt-open', app.findButtonDataV('adopt-open', '阶段目标改为维持'));
  await app.click('adopt-confirm', app.findButtonDataV('adopt-confirm', '采纳'));

  await app.click('adopt-open', app.findButtonDataV('adopt-open', '平板杠铃卧推'));
  await app.click('adopt-confirm', app.findButtonDataV('adopt-confirm', '长期调整'));

  await app.click('adopt-open', app.findButtonDataV('adopt-open', '深蹲'));
  await app.click('adopt-confirm', app.findButtonDataV('adopt-confirm', '长期调整'));

  await app.click('adopt-open', app.findButtonDataV('adopt-open', '硬拉'));
  await app.click('adopt-confirm', app.findButtonDataV('adopt-confirm', '只改今天'));

  const log = app.docs.get('app/profile').adjustLog;
  assert.equal(log.length, 5);
  assert.equal(app.docs.get('app/profile').kcalAdjust, -120);
  assert.equal(app.docs.get('app/profile').stage, 'maintain');
  assert.equal(app.docs.get('app/profile').swaps['平板杠铃卧推'], '平板哑铃卧推');
  assert.equal(app.docs.get('app/profile').exEdits['深蹲'].name, '腿举');
  assert.equal(app.docs.get('days/' + today).exEdits['硬拉'].name, '杠铃臀推');

  // Every adjustment stores both prev and after snapshots
  for (const e of log) {
    assert.ok(e.prev && typeof e.prev === 'object', `missing prev on ${e.kind}`);
    assert.ok(e.after && typeof e.after === 'object', `missing after on ${e.kind}`);
  }

  // Undo each in 1 tap: zero conflict dialog opened, exact previous values restored
  for (const e of log) {
    await app.click('undo-adjust', e.id, { src: 'list' });
    assert.doesNotMatch(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  }

  const p = app.docs.get('app/profile');
  assert.equal(p.kcalAdjust, 0);
  assert.equal(p.stage, 'cut');
  assert.deepEqual(p.swaps, {});
  assert.deepEqual(p.exEdits, {});
  assert.equal(app.docs.get('days/' + today).exEdits, undefined);
  assert.deepEqual(app.docs.get('feedback/fb-direct').applied, []);
  assert.ok(p.adjustLog.every(e => e.reverted === true));
});

test('conflict guard opens accessible dialog for kcalAdjust, stage, swaps, exEdits, and today workout.done, supporting Keep Current, Escape focus restore, and Overwrite & Undo', async () => {
  const app = createApp({ lang: 'zh' });
  const today = vm.runInContext('todayStr()', app.ctx);
  await app.seedFeedback({
    id: 'fb-guard',
    createdAt: today + 'T10:00:00Z',
    summary: '冲突守护全覆盖',
    adjustments: [
      { kind: 'kcal', delta: -120, text: '下调热量' },
      { kind: 'stage', stage: 'maintain', text: '改为维持' },
      { kind: 'swap', from: '平板杠铃卧推', to: '平板哑铃卧推', text: '长期换哑铃' },
      { kind: 'edit', from: '深蹲', to: '腿举', sets: 3, lo: 8, hi: 12, text: '长期改腿举' },
      { kind: 'swap', from: '硬拉', to: '杠铃臀推', sets: 3, lo: 8, hi: 10, text: '今天换臀推' }
    ],
    applied: []
  });

  // Adopt all 5
  await app.click('adopt-open', app.findButtonDataV('adopt-open', '-120 kcal'));
  await app.click('adopt-confirm', app.findButtonDataV('adopt-confirm', '采纳'));
  await app.click('adopt-open', app.findButtonDataV('adopt-open', '阶段目标改为维持'));
  await app.click('adopt-confirm', app.findButtonDataV('adopt-confirm', '采纳'));
  await app.click('adopt-open', app.findButtonDataV('adopt-open', '平板杠铃卧推'));
  await app.click('adopt-confirm', app.findButtonDataV('adopt-confirm', '长期调整'));
  await app.click('adopt-open', app.findButtonDataV('adopt-open', '深蹲'));
  await app.click('adopt-confirm', app.findButtonDataV('adopt-confirm', '长期调整'));
  await app.click('adopt-open', app.findButtonDataV('adopt-open', '硬拉'));
  await app.click('adopt-confirm', app.findButtonDataV('adopt-confirm', '只改今天'));

  const [eKcal, eStage, eSwap, eEdit, eToday] = app.docs.get('app/profile').adjustLog;

  // Manually edit all 5 target fields after adoption!
  vm.runInContext(`
    S.profile.kcalAdjust = -200;
    S.profile.stage = "bulk";
    S.profile.swaps["平板杠铃卧推"] = "哑铃地板卧推";
    S.profile.exEdits["深蹲"] = { name: "高脚杯深蹲", sets: 4, lo: 6, hi: 8, inc: 2.5, rest: "2–3 分钟" };
    S.days[${JSON.stringify(today)}].workout = { done: true, key: "pull", exercises: [{ name: "杠铃臀推", sets: [{ w: "80", r: "10" }] }] };
    render();
  `, app.ctx);
  app.docs.set('app/profile', vm.runInContext('JSON.parse(JSON.stringify(S.profile))', app.ctx));
  app.docs.set('days/' + today, vm.runInContext(`JSON.parse(JSON.stringify(S.days[${JSON.stringify(today)}]))`, app.ctx));

  // 1. kcalAdjust conflict -> Keep Current preserves -200 & restores focus, then Overwrite & Undo restores 0
  await app.click('undo-adjust', eKcal.id, { src: 'list' });
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"[^>]*role="alertdialog"[^>]*aria-labelledby="undo-conflict-title"[^>]*aria-describedby="undo-conflict-desc"/);
  assert.match(app.appEl.innerHTML, /-200 kcal/);
  assert.match(app.appEl.innerHTML, /0 kcal（无调整）/);
  assert.equal(app.getFocused(), 'dialog:dismiss-conflict', 'focus moves to safe Keep Current button when conflict dialog opens');
  // All dialog buttons have explicit type="button"
  const dlgBtns = app.parseButtons().filter(b => ['dismiss-conflict', 'undo-force', 'reset-kcal'].includes(b.dataset.act));
  assert.ok(dlgBtns.length >= 2);
  for (const b of dlgBtns) assert.equal(b.type, 'button', `${b.dataset.act} must have type="button"`);

  // Keep Current cancels without overwriting and restores focus to triggering undo button
  await app.click('dismiss-conflict');
  assert.doesNotMatch(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.equal(app.docs.get('app/profile').kcalAdjust, -200);
  assert.equal(app.docs.get('app/profile').adjustLog[0].reverted, false);
  assert.equal(app.getFocused(), `undo-adjust:${eKcal.id}:list`);

  // Re-trigger -> Escape cancels and restores focus to triggering undo button
  await app.click('undo-adjust', eKcal.id, { src: 'list' });
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.equal(app.keydown('Escape'), true);
  assert.doesNotMatch(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.equal(app.docs.get('app/profile').kcalAdjust, -200);
  assert.equal(app.getFocused(), `undo-adjust:${eKcal.id}:list`);

  // Re-trigger -> Overwrite & Undo force-restores 0
  await app.click('undo-adjust', eKcal.id, { src: 'list' });
  await app.click('undo-force', eKcal.id);
  assert.doesNotMatch(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.equal(app.docs.get('app/profile').kcalAdjust, 0);
  assert.equal(app.docs.get('app/profile').adjustLog[0].reverted, true);
  assert.ok(!app.docs.get('feedback/fb-guard').applied.includes(0));

  // 2. stage conflict -> shows 精益增肌 vs 减脂 -> Overwrite restores cut
  await app.click('undo-adjust', eStage.id, { src: 'list' });
  assert.match(app.appEl.innerHTML, /精益增肌/);
  assert.match(app.appEl.innerHTML, /减脂/);
  assert.equal(app.docs.get('app/profile').stage, 'bulk');
  await app.click('undo-force', eStage.id);
  assert.equal(app.docs.get('app/profile').stage, 'cut');
  assert.equal(app.docs.get('app/profile').adjustLog[1].reverted, true);

  // 3. swaps conflict -> shows 哑铃地板卧推 vs 默认（平板杠铃卧推） -> Overwrite removes swap
  await app.click('undo-adjust', eSwap.id, { src: 'list' });
  assert.match(app.appEl.innerHTML, /哑铃地板卧推/);
  assert.match(app.appEl.innerHTML, /默认（平板杠铃卧推）/);
  await app.click('undo-force', eSwap.id);
  assert.equal(app.docs.get('app/profile').swaps['平板杠铃卧推'], undefined);
  assert.equal(app.docs.get('app/profile').adjustLog[2].reverted, true);

  // 4. exEdits conflict -> shows 高脚杯深蹲 4×6–8 vs 默认（深蹲） -> Overwrite removes exEdit
  await app.click('undo-adjust', eEdit.id, { src: 'list' });
  assert.match(app.appEl.innerHTML, /高脚杯深蹲 4×6–8/);
  assert.match(app.appEl.innerHTML, /默认（深蹲）/);
  await app.click('undo-force', eEdit.id);
  assert.equal(app.docs.get('app/profile').exEdits['深蹲'], undefined);
  assert.equal(app.docs.get('app/profile').adjustLog[3].reverted, true);

  // 5. today dayEdit conflict when workout.done === true -> warns & shows note, Overwrite clears day.exEdits without clobbering saved workout!
  await app.click('undo-adjust', eToday.id, { src: 'card' });
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.match(app.appEl.innerHTML, /今天训练已保存/);
  assert.match(app.appEl.innerHTML, /不会改写已保存的训练日志/);
  // Dialog rendered exactly once (only under card trigger, no duplicate ID)
  assert.equal((app.appEl.innerHTML.match(/id="undo-conflict-dialog"/g) || []).length, 1);
  // Escape returns focus to the card trigger!
  app.keydown('Escape');
  assert.equal(app.getFocused(), `undo-adjust:${eToday.id}:card`);
  // Re-open and confirm Overwrite & Undo
  await app.click('undo-adjust', eToday.id, { src: 'card' });
  await app.click('undo-force', eToday.id);
  assert.equal(app.docs.get('days/' + today).exEdits, undefined);
  assert.equal(app.docs.get('days/' + today).workout.done, true, 'saved workout must stay untouched');
  assert.equal(app.docs.get('days/' + today).workout.exercises[0].name, '杠铃臀推');
  assert.equal(app.docs.get('app/profile').adjustLog[4].reverted, true);
  assert.deepEqual(app.docs.get('feedback/fb-guard').applied, []);
});

test('conflict guard works in English with zero CJK leakage and on page 2 of paginated Applied Adjustments', async () => {
  const adjustLog = [
    // index 0 -> oldest -> appears on page 2!
    {
      id: 'adj-p2-stage',
      date: '2026-11-01',
      scope: 'long',
      kind: 'stage',
      stage: 'maintain',
      prev: { stage: 'cut' },
      after: { stage: 'maintain' },
      reverted: false,
      text: '阶段目标改为维持'
    },
    // index 1..6 -> push index 0 onto page 2 (PAGE_SIZE.adjust === 5)
    ...Array.from({ length: 6 }, (_, i) => ({
      date: `2026-11-0${i + 2}`,
      text: '热量调整归零'
    }))
  ];

  const app = createApp({
    lang: 'en',
    profileOverrides: {
      stage: 'bulk', // edited after adj-p2-stage set it to maintain!
      adjustLog
    }
  });

  // Go to page 2 of Applied Adjustments
  await app.click('page', 'adjust:2');
  assert.match(app.appEl.innerHTML, /data-act="undo-adjust" data-v="adj-p2-stage"/);

  // Trigger undo on page 2 -> opens English conflict dialog
  await app.click('undo-adjust', 'adj-p2-stage', { src: 'list' });
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.match(app.appEl.innerHTML, /Overwrite current setting\?/);
  assert.match(app.appEl.innerHTML, /Current value/);
  assert.match(app.appEl.innerHTML, /Lean Bulk/);
  assert.match(app.appEl.innerHTML, /Undo will restore/);
  assert.match(app.appEl.innerHTML, /Cut/);
  assert.match(app.appEl.innerHTML, /Keep Current/);
  assert.match(app.appEl.innerHTML, /Overwrite &amp; Undo/);

  // Zero Chinese characters inside the English conflict dialog!
  const dlgMatch = app.appEl.innerHTML.match(/<div class="conflict-dialog[\s\S]*?<\/div>\s*<\/li>/);
  assert.ok(dlgMatch, 'conflict dialog should render inside page 2 list item');
  assert.equal(CJK_RE.test(stripTags(dlgMatch[0])), false, `Unexpected CJK in EN conflict dialog: ${stripTags(dlgMatch[0])}`);

  // Confirm Overwrite & Undo from page 2
  await app.click('undo-force', 'adj-p2-stage');
  assert.equal(app.docs.get('app/profile').stage, 'cut');
  assert.equal(app.docs.get('app/profile').adjustLog[0].reverted, true);
  assert.match(app.toasts.at(-1), /Adjustment undone/);
});

test('legacy structured adjustLog entries lacking explicit after get derived conflict detection and undo, while plain {date,text} entries stay non-undoable', async () => {
  const today = '2026-11-27';
  const legacyLog = [
    { date: '2026-11-01', text: '旧版纯文本记录' },
    { id: 'leg-kcal-ok', date: '2026-11-02', scope: 'long', kind: 'kcal', delta: -100, prev: { kcalAdjust: 0 }, reverted: false, text: '每日热量 -100 kcal' },
    { id: 'leg-stage-conflict', date: '2026-11-03', scope: 'long', kind: 'stage', to: 'maintain', prev: { stage: 'cut' }, reverted: false, text: '阶段目标改为维持' },
    { id: 'leg-swap-conflict', date: '2026-11-04', scope: 'long', kind: 'swap', from: '平板杠铃卧推', to: '平板哑铃卧推', prev: { swap: null, exEdit: null }, reverted: false, text: '平板杠铃卧推 换成 平板哑铃卧推' },
    { id: 'leg-edit-ok', date: '2026-11-05', scope: 'long', kind: 'edit', from: '深蹲', to: '腿举', sets: 3, lo: 8, hi: 12, prev: { swap: null, exEdit: null }, reverted: false, text: '「深蹲」长期换成 腿举 3×8–12' }
  ];

  const app = createApp({
    lang: 'zh',
    profileOverrides: {
      kcalAdjust: -100, // matches derived after (-100) -> 1-tap undo!
      stage: 'bulk', // differs from derived after ('maintain') -> conflict!
      swaps: { '平板杠铃卧推': '哑铃地板卧推' }, // differs from derived after ('平板哑铃卧推') -> conflict!
      exEdits: { '深蹲': { name: '腿举', sets: 3, lo: 8, hi: 12, inc: 5, rest: '3 分钟' } }, // matches derived partial spec -> 1-tap undo!
      adjustLog: legacyLog
    }
  });

  // Plain entry has no undo button; structured legacy entries without `after` DO have undo buttons
  assert.doesNotMatch(app.appEl.innerHTML, /旧版纯文本记录[\s\S]*?data-act="undo-adjust"/);
  assert.match(app.appEl.innerHTML, /data-act="undo-adjust" data-v="leg-kcal-ok"/);
  assert.match(app.appEl.innerHTML, /data-act="undo-adjust" data-v="leg-stage-conflict"/);
  assert.match(app.appEl.innerHTML, /data-act="undo-adjust" data-v="leg-swap-conflict"/);
  assert.match(app.appEl.innerHTML, /data-act="undo-adjust" data-v="leg-edit-ok"/);

  // 1-tap undo works for unedited legacy kcal and legacy edit
  await app.click('undo-adjust', 'leg-kcal-ok', { src: 'list' });
  assert.doesNotMatch(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.equal(app.docs.get('app/profile').kcalAdjust, 0);

  await app.click('undo-adjust', 'leg-edit-ok', { src: 'list' });
  assert.doesNotMatch(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.equal(app.docs.get('app/profile').exEdits['深蹲'], undefined);

  // Conflict detected for edited legacy stage -> confirm Overwrite restores cut
  await app.click('undo-adjust', 'leg-stage-conflict', { src: 'list' });
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.equal(app.docs.get('app/profile').stage, 'bulk');
  await app.click('undo-force', 'leg-stage-conflict');
  assert.equal(app.docs.get('app/profile').stage, 'cut');

  // Conflict detected for edited legacy swap -> Keep Current keeps 哑铃地板卧推
  await app.click('undo-adjust', 'leg-swap-conflict', { src: 'list' });
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  await app.click('dismiss-conflict');
  assert.equal(app.docs.get('app/profile').swaps['平板杠铃卧推'], '哑铃地板卧推');
  void today;
});

test('conflict dialog escapes hostile exercise names cleanly (no XSS)', async () => {
  const hostile = `<img src=x onerror="alert(1)">'&"`;
  const app = createApp({
    lang: 'zh',
    profileOverrides: {
      swaps: { '深蹲': hostile },
      adjustLog: [{
        id: 'adj-xss',
        date: '2026-11-26',
        scope: 'long',
        kind: 'swap',
        from: '深蹲',
        to: '腿举',
        prev: { swap: null, exEdit: null },
        after: { swap: '腿举', exEdit: null },
        reverted: false,
        text: '深蹲 换成 腿举'
      }]
    }
  });

  await app.click('undo-adjust', 'adj-xss', { src: 'list' });
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.doesNotMatch(app.appEl.innerHTML, /<img\b/i);
  assert.match(app.appEl.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&#39;&amp;&quot;/);
});

test('overwrite revalidates confirmed snapshot inside transaction and refreshes dialog if persisted value changed again', async () => {
  const app = createApp({ lang: 'en' });
  const today = vm.runInContext('todayStr()', app.ctx);
  await app.seedFeedback({
    id: 'fb-race-confirm',
    createdAt: today + 'T10:00:00Z',
    summary: 'Transactional overwrite check',
    adjustments: [{ kind: 'kcal', delta: -100, text: 'Trim 100 kcal' }],
    applied: []
  });

  // 1. Adopt -100 kcal
  await app.click('adopt-open', app.findButtonDataV('adopt-open', '-100 kcal'));
  await app.click('adopt-confirm', app.findButtonDataV('adopt-confirm', 'Adopt'));
  const entryId = app.docs.get('app/profile').adjustLog[0].id;
  assert.equal(app.docs.get('app/profile').kcalAdjust, -100);

  // 2. Persisted value changes to +200 -> open conflict dialog showing +200 vs 0
  const p200 = app.docs.get('app/profile');
  p200.kcalAdjust = 200;
  app.docs.set('app/profile', p200);
  await app.click('undo-adjust', entryId, { src: 'list' });
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.match(app.appEl.innerHTML, /\+200 kcal/);

  // 3. Another tab changes persisted value again to +400 BEFORE user clicks Overwrite!
  const p400 = app.docs.get('app/profile');
  p400.kcalAdjust = 400;
  app.docs.set('app/profile', p400);

  // 4. Click Overwrite & Undo -> MUST abort write, preserve +400, and refresh dialog with +400!
  await app.click('undo-force', entryId);
  assert.equal(app.docs.get('app/profile').kcalAdjust, 400, 'must NOT overwrite +400 when user only confirmed +200');
  assert.equal(app.docs.get('app/profile').adjustLog[0].reverted, false);
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.match(app.appEl.innerHTML, /\+400 kcal/);
  assert.match(app.appEl.innerHTML, /changed again/i);
  assert.equal(CJK_RE.test(stripTags(app.appEl.innerHTML)), false, 'refreshed English conflict dialog must have zero CJK');

  // 5. Now user sees +400 and clicks Overwrite & Undo again -> snapshot matches +400 -> restores 0!
  await app.click('undo-force', entryId);
  assert.equal(app.docs.get('app/profile').kcalAdjust, 0);
  assert.equal(app.docs.get('app/profile').adjustLog[0].reverted, true);
  assert.doesNotMatch(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
});

test('legacy numeric edit checks rest/inc (never silently discards), and legacy savedWorkout/dayEdit without after get conservative Undo confirmation', async () => {
  const today = '2026-11-27';
  const prevSavedEx = { name: '引体向上（能做 6 个后负重）', sets: [{ w: '80', r: '5' }, { w: '80', r: '5' }] };
  const prevSavedPlan = { name: '引体向上（能做 6 个后负重）', sets: 2, lo: 4, hi: 6, rest: '3 分钟', inc: 2.5, orig: '引体向上（能做 6 个后负重）', why: null };
  const curSavedEx = { name: '高位下拉', sets: [{ w: '95', r: '5' }, { w: '95', r: '5' }] };
  const curSavedPlan = { name: '高位下拉', sets: 2, lo: 4, hi: 6, rest: '2–3 分钟', inc: 2.5, orig: '引体向上（能做 6 个后负重）', why: '记录后手动改过' };

  const app = createApp({
    lang: 'zh',
    profileOverrides: {
      exEdits: {
        // Same name/sets/lo/hi as legacy edit, but different rest & inc!
        '深蹲': { name: '腿举', sets: 3, lo: 8, hi: 12, inc: 2.5, rest: '1–2 分钟' },
        // Custom exercise not in exMeta
        '杠铃划船': { name: '自定义划船', sets: 3, lo: 8, hi: 12, inc: 2.5, rest: '2 分钟' }
      },
      adjustLog: [
        { id: 'leg-rest-inc', date: '2026-11-20', scope: 'long', kind: 'edit', from: '深蹲', to: '腿举', sets: 3, lo: 8, hi: 12, prev: { swap: null, exEdit: null }, reverted: false, text: '「深蹲」长期换成 腿举 3×8–12' },
        { id: 'leg-custom', date: '2026-11-21', scope: 'long', kind: 'edit', from: '杠铃划船', to: '自定义划船', sets: 3, lo: 8, hi: 12, prev: { swap: null, exEdit: null }, reverted: false, text: '「杠铃划船」长期换成 自定义划船 3×8–12' },
        { id: 'leg-saved-w', date: today, dayDate: today, scope: 'today', kind: 'swap', from: '引体向上（能做 6 个后负重）', to: '高位下拉', sets: 2, lo: 4, hi: 6, prev: { mode: 'savedWorkout', exIdx: 0, hadPlan: true, planItem: prevSavedPlan, exercise: prevSavedEx }, feedbackId: 'fb-leg-sw', idx: 0, reverted: false, text: '只改今天（已保存记录）：「引体向上（能做 6 个后负重）」→ 高位下拉 2×4–6' }
      ]
    }
  });

  app.docs.set('days/' + today, {
    date: today,
    meals: [],
    workout: { done: true, key: 'pull', plan: [curSavedPlan], exercises: [curSavedEx] }
  });
  vm.runInContext(`S.days[${JSON.stringify(today)}] = clone(${JSON.stringify(app.docs.get('days/' + today))});`, app.ctx);
  await app.seedFeedback({
    id: 'fb-leg-sw',
    createdAt: today + 'T09:00:00Z',
    summary: 'Legacy savedWorkout entry',
    adjustments: [{ kind: 'swap', from: '引体向上（能做 6 个后负重）', to: '高位下拉', sets: 2, lo: 4, hi: 6, text: '换高位下拉' }],
    applied: [0]
  });

  // 1. Legacy edit with changed rest/inc MUST trigger conflict dialog (NOT silently delete) and show rest/inc!
  await app.click('undo-adjust', 'leg-rest-inc', { src: 'list' });
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.match(app.appEl.innerHTML, /1–2 分钟/);
  assert.match(app.appEl.innerHTML, /\+2\.5kg/);
  assert.equal(app.docs.get('app/profile').exEdits['深蹲'].rest, '1–2 分钟');
  await app.click('dismiss-conflict');

  // 2. Legacy custom exercise lacking exMeta conservatively requires confirmation
  await app.click('undo-adjust', 'leg-custom', { src: 'list' });
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.equal(app.docs.get('app/profile').exEdits['杠铃划船'].name, '自定义划船');
  await app.click('undo-force', 'leg-custom');
  assert.equal(app.docs.get('app/profile').exEdits['杠铃划船'], undefined);

  // 3. Legacy savedWorkout lacking `after` shows Undo button on BOTH list AND feedback card, and conservatively confirms with logged sets!
  const undoBtns = app.parseButtons('undo-adjust').filter(b => b.dataset.v === 'leg-saved-w');
  assert.equal(undoBtns.length, 2, 'legacy savedWorkout should render Undo on both card and list');
  await app.click('undo-adjust', 'leg-saved-w', { src: 'card' });
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.match(app.appEl.innerHTML, /95kg×5/);
  assert.match(app.appEl.innerHTML, /80kg×5/);
  await app.click('undo-force', 'leg-saved-w');
  const restored = app.docs.get('days/' + today).workout;
  assert.equal(restored.exercises[0].name, '引体向上（能做 6 个后负重）');
  assert.equal(restored.exercises[0].sets[0].w, '80');
});

test('savedWorkout overwrite shows logged weight/rep diff on AI Feedback page 2 and refuses to overwrite a mismatched/reordered slot', async () => {
  const today = vm.runInContext('todayStr()', createApp().ctx);
  const app = createApp({ lang: 'en' });

  const origPlan = [
    { name: '硬拉', sets: 3, lo: 4, hi: 6, rest: '3 分钟', inc: 5, orig: '硬拉', why: null },
    { name: '引体向上（能做 6 个后负重）', sets: 3, lo: 4, hi: 6, rest: '3 分钟', inc: 2.5, orig: '引体向上（能做 6 个后负重）', why: null }
  ];
  const origExercises = [
    { name: '硬拉', sets: [{ w: '120', r: '5' }, { w: '120', r: '5' }, { w: '120', r: '5' }] },
    { name: '引体向上（能做 6 个后负重）', sets: [{ w: '80', r: '5' }, { w: '80', r: '5' }, { w: '80', r: '5' }] }
  ];
  app.docs.set('days/' + today, {
    date: today,
    meals: [],
    workout: { done: true, key: 'pull', slot: 'eve', deload: false, plan: origPlan, exercises: origExercises }
  });
  vm.runInContext(`S.days[${JSON.stringify(today)}] = clone(${JSON.stringify(app.docs.get('days/' + today))});`, app.ctx);

  // Seed 4 feedback cards so our target card is on AI Feedback page 2 (PAGE_SIZE.feedback === 3)
  await app.seedFeedback([
    { id: 'fb-p1-1', createdAt: today + 'T12:00:00Z', summary: 'Card 1', adjustments: [], applied: [] },
    { id: 'fb-p1-2', createdAt: today + 'T11:00:00Z', summary: 'Card 2', adjustments: [], applied: [] },
    { id: 'fb-p1-3', createdAt: today + 'T10:00:00Z', summary: 'Card 3', adjustments: [], applied: [] },
    {
      id: 'fb-p2-saved',
      createdAt: today + 'T09:00:00Z',
      summary: 'Saved workout swap on page 2',
      adjustments: [{ kind: 'swap', from: '引体向上（能做 6 个后负重）', to: '高位下拉', sets: 3, lo: 4, hi: 6, text: 'Swap to pulldown' }],
      applied: []
    }
  ]);

  await app.click('page', 'feedback:2');
  await app.click('adopt-open', app.findButtonDataV('adopt-open', 'Pull-Up'));
  await app.click('adopt-confirm', app.findButtonDataV('adopt-confirm', 'Today only'));
  const entryId = app.docs.get('app/profile').adjustLog.at(-1).id;

  // User later edits logged weight from 80 kg -> 95 kg
  const dDay = app.docs.get('days/' + today);
  dDay.workout.exercises[1].sets = [{ w: '95', r: '5' }, { w: '95', r: '5' }, { w: '95', r: '5' }];
  app.docs.set('days/' + today, dDay);

  await app.click('undo-adjust', entryId, { src: 'card' });
  assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
  assert.match(app.appEl.innerHTML, /95kg×5/, 'dialog must display current logged weight 95kg');
  assert.match(app.appEl.innerHTML, /80kg×5/, 'dialog must display restored logged weight 80kg');
  assert.equal(CJK_RE.test(stripTags(app.appEl.innerHTML)), false, 'EN savedWorkout conflict dialog must have zero CJK');

  // Now simulate slot mismatch (slot 1 replaced by an unrelated exercise 平板杠铃卧推) -> Overwrite MUST be blocked!
  const reordered = app.docs.get('days/' + today);
  reordered.workout.plan[1] = { name: '平板杠铃卧推', sets: 3, lo: 4, hi: 6, rest: '3 分钟', inc: 2.5, orig: '平板杠铃卧推', why: null };
  reordered.workout.exercises[1] = { name: '平板杠铃卧推', sets: [{ w: '70', r: '6' }] };
  app.docs.set('days/' + today, reordered);

  await app.click('undo-force', entryId);
  // Must refuse to overwrite unrelated exercise at index 1!
  assert.equal(app.docs.get('days/' + today).workout.exercises[1].name, '平板杠铃卧推');
  assert.equal(app.docs.get('days/' + today).workout.exercises[1].sets[0].w, '70');
  assert.equal(app.docs.get('app/profile').adjustLog.at(-1).reverted, false);
  assert.doesNotMatch(app.appEl.innerHTML, /data-act="undo-force"/, 'Overwrite button must be hidden when target slot no longer matches');
});

test('savedWorkout undo blocks ambiguous duplicate name-only matches and stripped-plan hadPlan=true snapshots, while allowing unambiguous plan-less restore', async () => {
  const today = '2026-11-27';
  const prevDeadliftEx = { name: '硬拉', sets: [{ w: '80', r: '5' }, { w: '80', r: '5' }, { w: '80', r: '5' }] };
  const prevDeadliftPlan = { name: '硬拉', sets: 3, lo: 4, hi: 6, rest: '3 分钟', inc: 5, orig: '硬拉', why: null };

  // 1. Codex exact probe: plan-less workout with two duplicate 杠铃臀推 rows + legacy entry with prev.hadPlan: true
  {
    const app = createApp({
      lang: 'zh',
      profileOverrides: {
        adjustLog: [{
          id: 'leg-dup-hadplan',
          date: today,
          dayDate: today,
          scope: 'today',
          kind: 'swap',
          from: '硬拉',
          to: '杠铃臀推',
          sets: 3,
          lo: 8,
          hi: 10,
          prev: { mode: 'savedWorkout', exIdx: 0, hadPlan: true, planItem: prevDeadliftPlan, exercise: prevDeadliftEx },
          reverted: false,
          text: '只改今天（已保存记录）：「硬拉」→ 杠铃臀推 3×8–10'
        }]
      }
    });
    const dupWorkout = {
      done: true,
      key: 'pull',
      exercises: [
        { name: '杠铃臀推', sets: [{ w: '95', r: '6' }, { w: '95', r: '6' }, { w: '95', r: '6' }] },
        { name: '杠铃臀推', sets: [{ w: '85', r: '8' }, { w: '85', r: '8' }, { w: '85', r: '8' }] }
      ]
    };
    app.docs.set('days/' + today, { date: today, meals: [], workout: dupWorkout });
    vm.runInContext(`S.days[${JSON.stringify(today)}] = clone(${JSON.stringify(app.docs.get('days/' + today))}); render();`, app.ctx);

    await app.click('undo-adjust', 'leg-dup-hadplan', { src: 'list' });
    assert.match(app.appEl.innerHTML, /id="undo-conflict-dialog"/);
    assert.doesNotMatch(app.appEl.innerHTML, /data-act="undo-force"/, 'must NOT offer Overwrite for duplicate name-only match or stripped plan');

    // Direct forced call must also refuse and leave both rows and reverted flag untouched
    await vm.runInContext('undoAdjust("leg-dup-hadplan", { force: true, expectedSnap: S.undoConflict?.confirmedSnap })', app.ctx);
    const saved = app.docs.get('days/' + today).workout;
    assert.equal(saved.exercises[0].name, '杠铃臀推');
    assert.equal(saved.exercises[0].sets[0].w, '95');
    assert.equal(saved.exercises[1].name, '杠铃臀推');
    assert.equal(saved.exercises[1].sets[0].w, '85');
    assert.equal(app.docs.get('app/profile').adjustLog[0].reverted, false);
  }

  // 2. Duplicate name-only rows EVEN when prev.hadPlan: false -> still ambiguous -> Overwrite blocked!
  {
    const app = createApp({
      lang: 'en',
      profileOverrides: {
        adjustLog: [{
          id: 'leg-dup-noplan',
          date: today,
          dayDate: today,
          scope: 'today',
          kind: 'swap',
          from: '硬拉',
          to: '杠铃臀推',
          sets: 3,
          lo: 8,
          hi: 10,
          prev: { mode: 'savedWorkout', exIdx: 0, hadPlan: false, planItem: null, exercise: prevDeadliftEx },
          reverted: false,
          text: '只改今天（已保存记录）：「硬拉」→ 杠铃臀推 3×8–10'
        }]
      }
    });
    const dupWorkout = {
      done: true,
      key: 'pull',
      exercises: [
        { name: '杠铃臀推', sets: [{ w: '95', r: '6' }] },
        { name: '杠铃臀推', sets: [{ w: '85', r: '8' }] }
      ]
    };
    app.docs.set('days/' + today, { date: today, meals: [], workout: dupWorkout });
    vm.runInContext(`S.days[${JSON.stringify(today)}] = clone(${JSON.stringify(app.docs.get('days/' + today))}); render();`, app.ctx);

    await app.click('undo-adjust', 'leg-dup-noplan', { src: 'list' });
    assert.doesNotMatch(app.appEl.innerHTML, /data-act="undo-force"/, 'ambiguous duplicate rows without orig must block Overwrite');
    assert.equal(app.docs.get('days/' + today).workout.exercises[0].sets[0].w, '95');
  }

  // 3. Single matching row on a plan-less workout when prev.hadPlan: true -> cannot restore prev.planItem -> Overwrite blocked!
  {
    const app = createApp({
      lang: 'zh',
      profileOverrides: {
        adjustLog: [{
          id: 'leg-stripped-plan',
          date: today,
          dayDate: today,
          scope: 'today',
          kind: 'swap',
          from: '硬拉',
          to: '杠铃臀推',
          sets: 3,
          lo: 8,
          hi: 10,
          prev: { mode: 'savedWorkout', exIdx: 0, hadPlan: true, planItem: prevDeadliftPlan, exercise: prevDeadliftEx },
          reverted: false,
          text: '只改今天（已保存记录）：「硬拉」→ 杠铃臀推 3×8–10'
        }]
      }
    });
    app.docs.set('days/' + today, {
      date: today,
      meals: [],
      workout: { done: true, key: 'pull', exercises: [{ name: '杠铃臀推', sets: [{ w: '95', r: '6' }] }] }
    });
    vm.runInContext(`S.days[${JSON.stringify(today)}] = clone(${JSON.stringify(app.docs.get('days/' + today))}); render();`, app.ctx);

    await app.click('undo-adjust', 'leg-stripped-plan', { src: 'list' });
    assert.doesNotMatch(app.appEl.innerHTML, /data-act="undo-force"/, 'stripped w.plan when prev.hadPlan=true must block Overwrite');
    assert.equal(app.docs.get('app/profile').adjustLog[0].reverted, false);
  }

  // 4. Unambiguous single matching row on a plan-less workout when prev.hadPlan: false -> Overwrite allowed and restores cleanly!
  {
    const app = createApp({
      lang: 'zh',
      profileOverrides: {
        adjustLog: [{
          id: 'leg-unambig-noplan',
          date: today,
          dayDate: today,
          scope: 'today',
          kind: 'swap',
          from: '硬拉',
          to: '杠铃臀推',
          sets: 3,
          lo: 8,
          hi: 10,
          prev: { mode: 'savedWorkout', exIdx: 0, hadPlan: false, planItem: null, exercise: prevDeadliftEx },
          reverted: false,
          text: '只改今天（已保存记录）：「硬拉」→ 杠铃臀推 3×8–10'
        }]
      }
    });
    app.docs.set('days/' + today, {
      date: today,
      meals: [],
      workout: {
        done: true,
        key: 'pull',
        exercises: [
          { name: '杠铃臀推', sets: [{ w: '95', r: '6' }] },
          { name: '杠铃划船', sets: [{ w: '60', r: '6' }] }
        ]
      }
    });
    vm.runInContext(`S.days[${JSON.stringify(today)}] = clone(${JSON.stringify(app.docs.get('days/' + today))}); render();`, app.ctx);

    await app.click('undo-adjust', 'leg-unambig-noplan', { src: 'list' });
    assert.match(app.appEl.innerHTML, /data-act="undo-force"/);
    assert.match(app.appEl.innerHTML, /95kg×6/);
    assert.match(app.appEl.innerHTML, /80kg×5/);
    await app.click('undo-force', 'leg-unambig-noplan');
    const restored = app.docs.get('days/' + today).workout;
    assert.equal(restored.exercises[0].name, '硬拉');
    assert.equal(restored.exercises[0].sets[0].w, '80');
    assert.equal(restored.plan, undefined, 'plan-less workout stays cleanly plan-less after restoring hadPlan=false snapshot');
    assert.equal(app.docs.get('app/profile').adjustLog[0].reverted, true);
  }
});
