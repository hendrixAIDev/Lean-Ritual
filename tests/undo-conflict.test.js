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
