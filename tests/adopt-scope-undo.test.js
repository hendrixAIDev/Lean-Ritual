'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
const fullScript = source.match(/<script>([\s\S]*?)<\/script>/)[1];
const pageScript = fullScript.split('/* ============ 启动 ============ */')[0];

function decodeAttr(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function createApp({ confirmImpl } = {}) {
  const docs = new Map();
  const listCols = prefix => {
    const out = [];
    for (const [k, v] of docs.entries()) {
      if (k.startsWith(prefix + '/')) out.push({ id: k.slice(prefix.length + 1), data: JSON.parse(JSON.stringify(v)) });
    }
    return out;
  };
  const store = {
    async get(p) { return docs.has(p) ? JSON.parse(JSON.stringify(docs.get(p))) : null; },
    async set(p, d) { docs.set(p, JSON.parse(JSON.stringify(d))); },
    async del(p) { docs.delete(p); },
    async list(col) { return listCols(col); }
  };
  const storage = new Map();
  const listeners = {};
  const toasts = [];
  const confirmCalls = [];
  const appEl = { innerHTML: '' };
  const tabsEl = { innerHTML: '', hidden: false };
  const toastEl = {
    hidden: true,
    _t: '',
    get textContent() { return this._t; },
    set textContent(v) { this._t = String(v); toasts.push(this._t); }
  };
  const els = { '#app': appEl, '#tabs': tabsEl, '#toast': toastEl };

  const confirmFn = msg => {
    confirmCalls.push(msg);
    return confirmImpl ? confirmImpl(msg) : false;
  };

  const ctx = vm.createContext({
    window: { scrollTo() {}, confirm: confirmFn, ritual: { hosted: true } },
    confirm: confirmFn,
    location: { href: '/', reload() {}, replace() {} },
    AbortController,
    document: {
      addEventListener(type, fn) { listeners[type] = fn; },
      querySelector(sel) { return els[sel] || null; },
      getElementById(id) { return els['#' + id] || null; }
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
    sex: 'm', age: 29, height: 176, weight: 72, bf: 15, steps: 9500,
    exp: 'mid', stage: 'cut', trainDays: [0, 1, 2, 3, 4, 5, 6], slot: 'eve',
    equipment: 'gym', startDate: '2026-10-01', injuries: [], supps: [],
    kcalAdjust: 0, deloadEvery: 9, swaps: {}, exEdits: {}, adjustLog: [], schema: 2
  };
  docs.set('app/profile', JSON.parse(JSON.stringify(profile)));
  ctx.__initProfile = profile;
  vm.runInContext(`
    storageUser = "u1";
    S.uid = "u1";
    S.ready = true;
    S.cloud = true;
    S.store = __store;
    S.profile = clone(__initProfile);
    S.tab = "fb";
    render();
  `, ctx);

  async function seedFeedback(fb) {
    docs.set('feedback/' + fb.id, JSON.parse(JSON.stringify(fb)));
    ctx.__fb = fb;
    vm.runInContext('S.feedback = [clone(__fb)]; render();', ctx);
  }

  async function click(act, v) {
    const btn = {
      dataset: { act, ...(v !== undefined ? { v: String(v) } : {}) },
      disabled: false,
      closest(sel) { return sel === '[data-act]' ? btn : null; }
    };
    await listeners.click({ target: btn });
    return btn;
  }

  function findButtonDataV(html, act, labelSubstr) {
    const re = new RegExp(`<button[^>]*data-act="${act}"[^>]*data-v=(?:'([^']*)'|"([^"]*)")[^>]*>([\\s\\S]*?)<\\/button>`, 'g');
    for (const m of html.matchAll(re)) {
      const text = decodeAttr(m[3]);
      if (!labelSubstr || text.includes(labelSubstr)) {
        return decodeAttr(m[1] ?? m[2]);
      }
    }
    throw new Error(`Button data-act="${act}" (${labelSubstr || '*'}) not found in HTML:\n${html}`);
  }

  return { ctx, docs, appEl, toasts, confirmCalls, seedFeedback, click, findButtonDataV };
}

test('inline scope chooser opens without window.confirm, shows preview and scope buttons, and supports cancel', async () => {
  const app = createApp();
  await app.seedFeedback({
    id: 'fb_chooser',
    createdAt: '2026-11-18T10:00:00Z',
    summary: '拉日调整',
    adjustments: [
      { kind: 'swap', from: '引体向上（能做 6 个后负重）', to: '高位下拉', text: '无辅助引体机时首选高位下拉（做3组4–6次）' },
      { kind: 'kcal', delta: -120, text: '减脂期略慢' },
      { kind: 'deload', text: '疲劳偏高' }
    ],
    applied: []
  });

  // Exercise swap opens chooser with preview + 4 options (只改今天 / 长期调整 / 不采纳 / 取消)
  const openSwapV = app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：引体向上');
  await app.click('adopt-open', openSwapV);
  assert.equal(app.confirmCalls.length, 0);
  assert.match(app.appEl.innerHTML, /引体向上（能做 6 个后负重） 3×4–6 → 高位下拉 3×4–6/);
  assert.match(app.appEl.innerHTML, />只改今天<\/button>/);
  assert.match(app.appEl.innerHTML, />长期调整<\/button>/);
  assert.match(app.appEl.innerHTML, />不采纳<\/button>/);
  assert.match(app.appEl.innerHTML, />取消<\/button>/);

  // Cancel closes chooser without mutating profile or days
  await app.click('adopt-cancel');
  assert.doesNotMatch(app.appEl.innerHTML, /class="chooser"/);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(S.profile.swaps)', app.ctx)), {});
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(S.profile.exEdits)', app.ctx)), {});

  // kcal and deload choosers offer only 采纳 / 不采纳 / 取消 (no 只改今天)
  const openKcalV = app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：每日 -120 kcal');
  await app.click('adopt-open', openKcalV);
  assert.match(app.appEl.innerHTML, /class="chooser"/);
  assert.match(app.appEl.innerHTML, />采纳<\/button>/);
  assert.match(app.appEl.innerHTML, />不采纳<\/button>/);
  assert.doesNotMatch(app.appEl.innerHTML, />只改今天<\/button>/);
});

test('today-only adoption BEFORE save writes day.exEdits[orig] without changing long-term plan', async () => {
  const app = createApp();
  // Ensure today's scheduled workout is pull (last completed workout yesterday was push)
  const today = vm.runInContext('todayStr()', app.ctx);
  const yesterday = vm.runInContext('addDays(todayStr(), -1)', app.ctx);
  app.docs.set('days/' + yesterday, { date: yesterday, meals: [], workout: { done: true, key: 'push', exercises: [] } });
  vm.runInContext(`S.days[${JSON.stringify(yesterday)}] = { date: ${JSON.stringify(yesterday)}, meals: [], workout: { done: true, key: "push", exercises: [] } };`, app.ctx);

  await app.seedFeedback({
    id: 'fb_today_unsaved',
    createdAt: today + 'T09:00:00Z',
    summary: '今天临时替换',
    adjustments: [
      { kind: 'swap', from: '引体向上（能做 6 个后负重）', to: '高位下拉', sets: 3, lo: 8, hi: 10, text: '器械维修临时换高位下拉' }
    ],
    applied: []
  });

  const openV = app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：引体向上');
  await app.click('adopt-open', openV);
  const todayV = app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '只改今天');
  await app.click('adopt-confirm', todayV);

  assert.equal(app.toasts.at(-1), '已只改今天');
  // day.exEdits updated for today
  const dayEdit = vm.runInContext(`S.days[${JSON.stringify(today)}].exEdits["引体向上（能做 6 个后负重）"]`, app.ctx);
  assert.equal(dayEdit.name, '高位下拉');
  assert.equal(dayEdit.sets, 3);
  assert.equal(dayEdit.lo, 8);
  assert.equal(dayEdit.hi, 10);

  // Today's plan uses 高位下拉 3×8–10 with why="只今天替换"
  const todayPullEx = vm.runInContext(`JSON.parse(JSON.stringify(planFor(${JSON.stringify(today)}).ex.find(e => e.orig === "引体向上（能做 6 个后负重）")))`, app.ctx);
  assert.equal(todayPullEx.name, '高位下拉');
  assert.equal(todayPullEx.lo, 8);
  assert.equal(todayPullEx.hi, 10);
  assert.equal(todayPullEx.why, '只今天替换');

  // Long-term plan untouched!
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(S.profile.swaps)', app.ctx)), {});
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(S.profile.exEdits || {})', app.ctx)), {});
  const resolvedLong = vm.runInContext('resolveEx(PROGRAM.pull.ex[1])', app.ctx);
  assert.equal(resolvedLong.name, '引体向上（能做 6 个后负重）');
  assert.equal(resolvedLong.lo, 4);
  assert.equal(resolvedLong.hi, 6);
});

test('today-only adoption AFTER save updates saved workout record in place (preserving logged sets) and leaves long-term plan untouched', async () => {
  const app = createApp();
  const today = vm.runInContext('todayStr()', app.ctx);
  const savedWorkout = {
    key: 'pull',
    slot: 'eve',
    deload: false,
    done: true,
    savedAt: today + 'T07:30:00Z',
    plan: [
      { name: '硬拉', sets: 3, lo: 4, hi: 6, rest: '3 分钟', inc: 5, orig: '硬拉', why: null },
      { name: '引体向上（能做 6 个后负重）', sets: 3, lo: 4, hi: 6, rest: '3 分钟', inc: 2.5, orig: '引体向上（能做 6 个后负重）', why: null }
    ],
    exercises: [
      { name: '硬拉', sets: [{ w: '100', r: '5' }, { w: '100', r: '5' }, { w: '100', r: '5' }] },
      { name: '引体向上（能做 6 个后负重）', sets: [{ w: '50', r: '6' }, { w: '50', r: '5' }, { w: '50', r: '5' }] }
    ],
    feel: 3,
    pain: 'none',
    painArea: '',
    note: ''
  };
  app.docs.set('days/' + today, { date: today, meals: [], workout: savedWorkout });
  vm.runInContext(`S.days[${JSON.stringify(today)}] = clone(${JSON.stringify({ date: today, meals: [], workout: savedWorkout })}); render();`, app.ctx);

  await app.seedFeedback({
    id: 'fb_owner_prod',
    createdAt: today + 'T08:00:00Z',
    summary: '辅助引体机不可用时高位下拉很好',
    adjustments: [
      { kind: 'swap', from: '引体向上（能做 6 个后负重）', to: '高位下拉', text: '无辅助引体机时首选高位下拉（做3组4–6次）' }
    ],
    applied: []
  });

  const openV = app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：引体向上');
  await app.click('adopt-open', openV);
  assert.match(app.appEl.innerHTML, /今天这练已保存/);
  const todayV = app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '只改今天');
  await app.click('adopt-confirm', todayV);

  assert.match(app.toasts.at(-1), /已只改今天.*保存的训练记录/);

  // Saved workout exercise updated in place; logged sets kept intact
  const updatedW = app.docs.get('days/' + today).workout;
  assert.equal(updatedW.exercises[1].name, '高位下拉');
  assert.deepEqual(updatedW.exercises[1].sets, [{ w: '50', r: '6' }, { w: '50', r: '5' }, { w: '50', r: '5' }]);
  assert.equal(updatedW.plan[1].name, '高位下拉');
  assert.equal(updatedW.plan[1].sets, 3);
  assert.equal(updatedW.plan[1].lo, 4);
  assert.equal(updatedW.plan[1].hi, 6);
  assert.equal(updatedW.plan[1].orig, '引体向上（能做 6 个后负重）');

  // Long-term plan NOT touched
  assert.deepEqual(app.docs.get('app/profile').swaps, {});
  assert.deepEqual(app.docs.get('app/profile').exEdits || {}, {});

  // Revert restores exact saved workout record!
  const undoId = app.docs.get('app/profile').adjustLog.at(-1).id;
  await app.click('undo-adjust', undoId);
  const restoredW = app.docs.get('days/' + today).workout;
  assert.equal(restoredW.exercises[1].name, '引体向上（能做 6 个后负重）');
  assert.deepEqual(restoredW.exercises[1].sets, [{ w: '50', r: '6' }, { w: '50', r: '5' }, { w: '50', r: '5' }]);
  assert.equal(restoredW.plan[1].name, '引体向上（能做 6 个后负重）');
  assert.equal(restoredW.plan[1].why, null);
});

test('long-term swap with suggested sets is stored as exEdit (and runAI preserves swap sets/lo/hi), while bare swap uses p.swaps', async () => {
  const app = createApp();

  // Verify runAI preserves sets/lo/hi on kind="swap"
  app.ctx.__mockSample = {
    async json() {
      return {
        summary: '总结',
        good: [],
        issues: [],
        adjustments: [
          { kind: 'swap', from: '引体向上（能做 6 个后负重）', to: '高位下拉', sets: 4, lo: 6, hi: 10, text: '建议换成高位下拉' },
          { kind: 'swap', from: '平板杠铃卧推', to: '平板哑铃卧推', text: '手腕更舒服' }
        ]
      };
    }
  };
  vm.runInContext('S.sample = __mockSample;', app.ctx);
  await vm.runInContext('runAI()', app.ctx);

  const generated = vm.runInContext('JSON.parse(JSON.stringify(S.feedback[0]))', app.ctx);
  assert.equal(generated.adjustments[0].sets, 4);
  assert.equal(generated.adjustments[0].lo, 6);
  assert.equal(generated.adjustments[0].hi, 10);
  assert.equal(generated.adjustments[1].sets, undefined);

  // Adopt adjustment 0 (swap with numbers) as 长期调整 -> stored in p.exEdits, NOT p.swaps
  const open0 = app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：引体向上');
  await app.click('adopt-open', open0);
  assert.match(app.appEl.innerHTML, /引体向上（能做 6 个后负重） 3×4–6 → 高位下拉 4×6–10/);
  const long0 = app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '长期调整');
  await app.click('adopt-confirm', long0);

  assert.match(app.toasts.at(-1), /^已长期调整/);
  const pAfter0 = app.docs.get('app/profile');
  assert.equal(pAfter0.swaps['引体向上（能做 6 个后负重）'], undefined);
  assert.equal(pAfter0.exEdits['引体向上（能做 6 个后负重）'].name, '高位下拉');
  assert.equal(pAfter0.exEdits['引体向上（能做 6 个后负重）'].sets, 4);
  assert.equal(pAfter0.exEdits['引体向上（能做 6 个后负重）'].lo, 6);
  assert.equal(pAfter0.exEdits['引体向上（能做 6 个后负重）'].hi, 10);

  // Adopt adjustment 1 (bare swap without numbers) as 长期调整 -> stored in p.swaps
  const open1 = app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：平板杠铃卧推');
  await app.click('adopt-open', open1);
  const long1 = app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '长期调整');
  await app.click('adopt-confirm', long1);

  const pAfter1 = app.docs.get('app/profile');
  assert.equal(pAfter1.swaps['平板杠铃卧推'], '平板哑铃卧推');
  assert.equal(pAfter1.exEdits['平板杠铃卧推'], undefined);
});

test('不采纳 marks suggestion as declined, greys it out, and makes zero plan changes', async () => {
  const app = createApp();
  await app.seedFeedback({
    id: 'fb_decline',
    createdAt: '2026-11-18T10:00:00Z',
    summary: '检查',
    adjustments: [
      { kind: 'edit', from: '深蹲', to: '箱式深蹲', sets: 3, lo: 6, hi: 8, text: '降低膝盖压力' }
    ],
    applied: []
  });

  const beforeProfile = JSON.stringify(app.docs.get('app/profile'));
  const openV = app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：深蹲');
  await app.click('adopt-open', openV);
  const decV = app.findButtonDataV(app.appEl.innerHTML, 'adopt-decline', '不采纳');
  await app.click('adopt-decline', decV);

  assert.equal(JSON.stringify(app.docs.get('app/profile')), beforeProfile);
  assert.equal(app.docs.size, 2); // only app/profile and feedback/fb_decline
  assert.deepEqual(app.docs.get('feedback/fb_decline').declined, [0]);
  assert.deepEqual(app.docs.get('feedback/fb_decline').applied, []);
  assert.match(app.appEl.innerHTML, /class="ins declined"/);
  assert.match(app.appEl.innerHTML, /已不采纳/);
});

test('per-adoption revert restores exact non-default previous values across all scopes/kinds, re-enables suggestions, and supports per-item undo in 我的', async () => {
  const app = createApp();
  const today = vm.runInContext('todayStr()', app.ctx);

  // Pre-seed non-empty previous values on profile and today's dayEdits
  vm.runInContext(`
    S.profile.kcalAdjust = -100;
    S.profile.deloadFrom = "2026-10-05";
    S.profile.swaps = { "平板杠铃卧推": "哑铃地板卧推", "杠铃划船": "胸托哑铃划船" };
    S.profile.exEdits = {
      "深蹲": { name: "高脚杯深蹲", sets: 4, lo: 8, hi: 10, inc: 2.5, rest: "2–3 分钟" },
      "侧平举": { name: "弹力带侧平举", sets: 3, lo: 15, hi: 20, inc: 0, rest: "1–2 分钟" }
    };
  `, app.ctx);
  app.docs.set('app/profile', vm.runInContext('JSON.parse(JSON.stringify(S.profile))', app.ctx));
  const priorDayEdit = { name: '引体向上', sets: 4, lo: 4, hi: 8, inc: 0, rest: '3 分钟' };
  app.docs.set('days/' + today, { date: today, meals: [], exEdits: { '引体向上（能做 6 个后负重）': priorDayEdit } });
  vm.runInContext(`S.days[${JSON.stringify(today)}] = clone(${JSON.stringify({ date: today, meals: [], exEdits: { '引体向上（能做 6 个后负重）': priorDayEdit } })});`, app.ctx);

  await app.seedFeedback({
    id: 'fb_all_kinds',
    createdAt: today + 'T11:00:00Z',
    summary: '全类型撤销验证',
    adjustments: [
      { kind: 'swap', from: '引体向上（能做 6 个后负重）', to: '高位下拉', sets: 3, lo: 6, hi: 10, text: '临时换' },
      { kind: 'swap', from: '平板杠铃卧推', to: '平板哑铃卧推', text: '长期纯替换' },
      { kind: 'edit', from: '深蹲', to: '腿举', sets: 3, lo: 10, hi: 12, text: '长期动作编辑' },
      { kind: 'kcal', delta: -150, text: '减热量' },
      { kind: 'deload', text: '开启减载' }
    ],
    applied: []
  });

  // 1. Adopt #0 as today-only -> overwrites priorDayEdit, then revert via feedback card chip ("已采纳 · 撤销")
  await app.click('adopt-open', app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：引体向上'));
  await app.click('adopt-confirm', app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '只改今天'));
  assert.equal(app.docs.get('days/' + today).exEdits['引体向上（能做 6 个后负重）'].name, '高位下拉');
  assert.match(app.appEl.innerHTML, />已采纳 · 撤销<\/button>/);

  const chipUndo0 = app.findButtonDataV(app.appEl.innerHTML, 'undo-adjust', '已采纳 · 撤销');
  await app.click('undo-adjust', chipUndo0);
  assert.deepEqual(app.docs.get('days/' + today).exEdits['引体向上（能做 6 个后负重）'], priorDayEdit);
  assert.equal(app.docs.get('app/profile').adjustLog.at(-1).reverted, true);
  assert.deepEqual(app.docs.get('feedback/fb_all_kinds').applied, []);
  // Suggestion #0 is re-enabled and can be adopted again!
  assert.match(app.appEl.innerHTML, /采纳：引体向上/);

  // 2. Adopt #1 (bare swap), #2 (edit), #3 (kcal), #4 (deload)
  await app.click('adopt-open', app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：平板杠铃卧推'));
  await app.click('adopt-confirm', app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '长期调整'));
  await app.click('adopt-open', app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：深蹲'));
  await app.click('adopt-confirm', app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '长期调整'));
  await app.click('adopt-open', app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：每日 -150 kcal'));
  await app.click('adopt-confirm', app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '采纳'));
  await app.click('adopt-open', app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：本周开始减载'));
  await app.click('adopt-confirm', app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '采纳'));

  let prof = app.docs.get('app/profile');
  assert.equal(prof.swaps['平板杠铃卧推'], '平板哑铃卧推');
  assert.equal(prof.exEdits['深蹲'].name, '腿举');
  assert.equal(prof.kcalAdjust, -250);
  assert.equal(prof.deloadFrom, today);
  assert.deepEqual(app.docs.get('feedback/fb_all_kinds').applied.sort(), [1, 2, 3, 4]);

  // 3. Switch to 我的 tab: verify per-item 撤销 buttons alongside clear-all links, and revert #1 and #2 from 我的!
  await app.click('tab', 'me');
  assert.match(app.appEl.innerHTML, /data-act="clear-exedits"/);
  assert.match(app.appEl.innerHTML, /data-act="clear-swaps"/);
  assert.match(app.appEl.innerHTML, /data-act="del-exedit" data-v="深蹲"/);
  assert.match(app.appEl.innerHTML, /data-act="del-swap" data-v="平板杠铃卧推"/);

  await app.click('del-swap', '平板杠铃卧推');
  prof = app.docs.get('app/profile');
  assert.equal(prof.swaps['平板杠铃卧推'], '哑铃地板卧推'); // restored exact previous swap!
  assert.equal(prof.swaps['杠铃划船'], '胸托哑铃划船'); // other swap untouched!

  await app.click('del-exedit', '深蹲');
  prof = app.docs.get('app/profile');
  assert.equal(prof.exEdits['深蹲'].name, '高脚杯深蹲'); // restored exact previous exEdit!
  assert.equal(prof.exEdits['深蹲'].sets, 4);
  assert.equal(prof.exEdits['侧平举'].name, '弹力带侧平举'); // other exEdit untouched!

  // Also test per-item revert of a legacy swap ('杠铃划船') that had no structured adjustLog entry
  await app.click('del-swap', '杠铃划船');
  assert.equal(app.docs.get('app/profile').swaps['杠铃划船'], undefined);

  // 4. Switch back to 反馈 tab and revert kcal (#3) and deload (#4) from 已采纳的调整 list
  await app.click('tab', 'fb');
  const logNow = app.docs.get('app/profile').adjustLog;
  const kcalEntry = logNow.find(e => e.kind === 'kcal' && !e.reverted);
  const deloadEntry = logNow.find(e => e.kind === 'deload' && !e.reverted);
  await app.click('undo-adjust', kcalEntry.id);
  await app.click('undo-adjust', deloadEntry.id);

  prof = app.docs.get('app/profile');
  assert.equal(prof.kcalAdjust, -100);
  assert.equal(prof.deloadFrom, '2026-10-05');
  assert.deepEqual(app.docs.get('feedback/fb_all_kinds').applied, []);
});

test('revert refuses when value was changed afterwards and offers clear-all links without mutating current value', async () => {
  const app = createApp();
  const today = vm.runInContext('todayStr()', app.ctx);
  await app.seedFeedback({
    id: 'fb_conflict',
    createdAt: today + 'T12:00:00Z',
    summary: '冲突保护测试',
    adjustments: [
      { kind: 'swap', from: '引体向上（能做 6 个后负重）', to: '高位下拉', sets: 3, lo: 8, hi: 10, text: '长期换' },
      { kind: 'swap', from: '杠铃划船', to: '胸托哑铃划船', text: '今天换' }
    ],
    applied: []
  });

  // Adopt #0 as long-term and #1 as today-only
  await app.click('adopt-open', app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：引体向上'));
  await app.click('adopt-confirm', app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '长期调整'));
  await app.click('adopt-open', app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：杠铃划船'));
  await app.click('adopt-confirm', app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '只改今天'));

  const [longEntry, todayEntry] = app.docs.get('app/profile').adjustLog;

  // User later changes S.profile.exEdits['引体向上（能做 6 个后负重）'] to 4×6–8
  vm.runInContext(`
    S.profile.exEdits["引体向上（能做 6 个后负重）"].sets = 4;
  `, app.ctx);
  app.docs.set('app/profile', vm.runInContext('JSON.parse(JSON.stringify(S.profile))', app.ctx));

  await app.click('undo-adjust', longEntry.id);
  // Must refuse revert, preserve sets=4, keep reverted=false, keep applied, and show clear-all links!
  assert.equal(app.docs.get('app/profile').exEdits['引体向上（能做 6 个后负重）'].sets, 4);
  assert.equal(app.docs.get('app/profile').adjustLog[0].reverted, false);
  assert.ok(app.docs.get('feedback/fb_conflict').applied.includes(0));
  assert.match(app.appEl.innerHTML, /之后又被修改过/);
  assert.match(app.appEl.innerHTML, /data-act="clear-exedits"/);
  assert.match(app.appEl.innerHTML, /data-act="clear-swaps"/);

  // User later saves today's workout after adopting today-only dayEdit -> reverting #1 also refuses!
  vm.runInContext(`
    S.days[${JSON.stringify(today)}].workout = { done: true, key: "pull", exercises: [] };
  `, app.ctx);
  app.docs.set('days/' + today, vm.runInContext(`JSON.parse(JSON.stringify(S.days[${JSON.stringify(today)}]))`, app.ctx));

  await app.click('undo-adjust', todayEntry.id);
  assert.equal(app.docs.get('app/profile').adjustLog[1].reverted, false);
  assert.ok(app.docs.get('feedback/fb_conflict').applied.includes(1));
  assert.match(app.appEl.innerHTML, /后来又被修改过（或已保存）/);
});

test('legacy plain {date,text} adjustLog entries and legacy applied chips render without 撤销', async () => {
  const app = createApp();
  vm.runInContext(`
    S.profile.adjustLog = [
      { date: "2026-11-02", text: "旧版纯文本记录：深蹲 换成 腿举" }
    ];
  `, app.ctx);
  app.docs.set('app/profile', vm.runInContext('JSON.parse(JSON.stringify(S.profile))', app.ctx));

  await app.seedFeedback({
    id: 'fb_legacy',
    createdAt: '2026-11-02T10:00:00Z',
    summary: '旧反馈',
    adjustments: [
      { kind: 'swap', from: '深蹲', to: '腿举', text: '旧已采纳项' },
      { kind: 'kcal', delta: -100, text: '新未采纳项' }
    ],
    applied: [0]
  });

  // Legacy adjustLog entry has no undo button, and legacy applied chip renders plain disabled 已采纳
  assert.match(app.appEl.innerHTML, /11-02 旧版纯文本记录：深蹲 换成 腿举/);
  assert.doesNotMatch(app.appEl.innerHTML, /data-act="undo-adjust"/);
  assert.match(app.appEl.innerHTML, /<button class="chip" disabled>已采纳<\/button>/);

  // Now adopt the new item -> new entry has 撤销, while legacy entry still does not!
  await app.click('adopt-open', app.findButtonDataV(app.appEl.innerHTML, 'adopt-open', '采纳：每日 -100 kcal'));
  await app.click('adopt-confirm', app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '采纳'));

  const listMatch = app.appEl.innerHTML.match(/<h3>已采纳的调整<\/h3><ul class="clean small">([\s\S]*?)<\/ul>/);
  assert.ok(listMatch);
  const lis = [...listMatch[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(m => m[1]);
  assert.equal(lis.length, 2);
  assert.match(lis[0], /每日热量 -100 kcal[\s\S]*data-act="undo-adjust"/);
  assert.doesNotMatch(lis[1], /data-act="undo-adjust"/);
});

test('no XSS via AI-provided from/to/text strings in chooser preview, data-v JSON round-trip, adjustLog, or 我的', async () => {
  const app = createApp();
  const xssFrom = `<img src=x onerror="alert('from')">'&"`;
  const xssTo = `<svg onload=alert("to")>'&"`;
  const xssText = `<script>alert(1)</script> 做3组8–12次`;

  await app.seedFeedback({
    id: 'fb_xss',
    createdAt: '2026-11-18T12:00:00Z',
    summary: 'XSS 防护测试',
    adjustments: [
      { kind: 'swap', from: xssFrom, to: xssTo, text: xssText }
    ],
    applied: []
  });

  function assertSafeHtml(html) {
    assert.doesNotMatch(html, /<(?:img|svg|script)\b|&amp;amp;|&amp;quot;/i);
    for (const m of html.matchAll(/<([a-zA-Z0-9-]+)([^>]*)>/g)) {
      const stripped = m[2].replace(/'[^']*'|\"[^\"]*\"/g, '""');
      assert.doesNotMatch(stripped, /\bon[a-z]+\s*=/i, `unexpected inline handler on <${m[1]}>: ${m[0]}`);
    }
  }

  // Closed state: no raw tags or unescaped handlers
  assertSafeHtml(app.appEl.innerHTML);

  // Round-trip data-v JSON and open chooser
  const openV = app.findButtonDataV(app.appEl.innerHTML, 'adopt-open');
  const parsedOpen = JSON.parse(openV);
  assert.equal(parsedOpen.a.from, xssFrom);
  assert.equal(parsedOpen.a.to, xssTo);

  await app.click('adopt-open', openV);
  // Open chooser preview escapes both hostile strings exactly once
  assert.match(app.appEl.innerHTML, /class="chooser"/);
  assertSafeHtml(app.appEl.innerHTML);
  assert.match(app.appEl.innerHTML, /&lt;img src=x onerror=&quot;alert\(&#39;from&#39;\)&quot;&gt;.*→.*&lt;svg onload=alert\(&quot;to&quot;\)&gt;.*3×8–12/);

  // Confirm long-term adoption via round-tripped data-v and verify Feedback + 我的 views remain XSS-free
  const longV = app.findButtonDataV(app.appEl.innerHTML, 'adopt-confirm', '长期调整');
  assert.equal(JSON.parse(longV).a.from, xssFrom);
  await app.click('adopt-confirm', longV);
  assertSafeHtml(app.appEl.innerHTML);

  await app.click('tab', 'me');
  assertSafeHtml(app.appEl.innerHTML);
  assert.match(app.appEl.innerHTML, /&lt;img src=x onerror=&quot;alert\(&#39;from&#39;\)&quot;&gt;/);
});
