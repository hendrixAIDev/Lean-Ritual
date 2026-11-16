'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
const fullScript = source.match(/<script>([\s\S]*?)<\/script>/)[1];
const pageScript = fullScript.split('/* ============ 启动 ============ */')[0];

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  let depth = 0, opened = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; opened = true; }
    else if (src[i] === '}') {
      depth--;
      if (opened && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${signature}`);
}

function makeStorage(initial = {}, events = null) {
  const map = new Map(Object.entries(initial));
  const storage = {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) {
      if (events) events.push(`remove:${k}`);
      map.delete(k);
    }
  };
  return new Proxy(storage, {
    ownKeys() { return Array.from(map.keys()); },
    getOwnPropertyDescriptor(_, prop) {
      if (map.has(prop)) return {enumerable: true, configurable: true, value: map.get(prop)};
      return undefined;
    }
  });
}

function createPage({storage = {}, confirmImpl, logoutImpl, deleteAccountImpl, storeImpl, elements = {}} = {}) {
  const events = [];
  const localStorage = makeStorage(storage, events);
  const listeners = {};
  const location = {
    href: '/',
    replaced: null,
    replace(url) { location.replaced = url; location.href = url; }
  };
  const prompts = [];
  const window = {
    location,
    scrollTo() {},
    ritual: {
      hosted: true,
      logout: logoutImpl || (async () => { events.push('signout'); }),
      deleteAccount: deleteAccountImpl || (async pw => { events.push(`delete:${pw}`); })
    }
  };
  const toastEl = {innerHTML: '', hidden: true, textContent: ''};
  const ctx = vm.createContext({
    window,
    location,
    document: {
      addEventListener(type, fn) { listeners[type] = fn; },
      querySelector(sel) { return elements[sel] || toastEl; },
      getElementById(id) { return elements['#' + id] || null; }
    },
    localStorage,
    confirm: confirmImpl === undefined ? undefined : (msg => { prompts.push(msg); return confirmImpl(msg); }),
    console,
    URL,
    Date,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(pageScript, ctx);
  vm.runInContext(`
    storageUser = "u1";
    S.uid = "u1";
    S.cloud = true;
    S.profile = {sex:"m",age:28,height:175,weight:72.5,trainDays:[1,3,5],slot:"pm",stage:"maintain",exp:"new",equipment:"gym",startDate:"2026-11-01",injuries:[],supps:[]};
    S.drafts = lsGet("bj-drafts", {});
  `, ctx);
  if (storeImpl) ctx.SStore = storeImpl;
  vm.runInContext('S.store = typeof SStore !== "undefined" ? SStore : null;', ctx);
  const clickAct = act => {
    const btn = {dataset: {act}, disabled: false, closest(sel) { return sel === '[data-act]' ? btn : null; }};
    return listeners.click({target: btn}).then(() => btn);
  };
  return {ctx, localStorage, location, events, prompts, listeners, clickLogout: () => clickAct('logout'), clickAct};
}

test('syncDraft and rescueDrafts remain byte-identical to origin/main', () => {
  const expectedSyncDraft = [
    'function syncDraft(date, key){',
    '  clearTimeout(syncDraft.t);',
    '  syncDraft.t = setTimeout(() => {',
    '    const d = S.drafts[draftKey(date, key)]; if (!d) return;',
    '    if (S.days[date]?.workout?.done && S.days[date].workout.key === key) return;',
    '    updateDay(date, x => { x.workoutDraft = {...clone(d), key, updatedAt:new Date().toISOString()}; }, {quiet:true, silent:true}).catch(() => {});',
    '  }, 2000);',
    '}'
  ].join('\n');
  const expectedRescueDrafts = [
    'function rescueDrafts(){',
    '  if (!S.profile) return;',
    '  const found = [];',
    '  for (const [k, d] of Object.entries(S.drafts || {})) {',
    '    if (!d?.exercises?.some(e => e.sets?.some(t => t.r !== "" || t.w !== ""))) continue;',
    '    const date = k.split("|")[0];',
    '    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date) || S.days[date]?.workout?.done) continue;',
    '    found.push(date);',
    '    updateDay(date, x => { if (!x.workout?.done && !x.workoutDraft) x.workoutDraft = {...clone(d), key:d.key, updatedAt:new Date().toISOString()}; }, {quiet:true, silent:true}).catch(() => {});',
    '  }',
    '  if (found.length) toast(`找到 ${[...new Set(found)].map(d => fmtDate(d).split(" ")[0]).join("、")} 填了但没保存的训练，打开那天点“完成训练，保存”即可`, 8000);',
    '}'
  ].join('\n');
  assert.equal(extractFunction(fullScript, 'function syncDraft('), expectedSyncDraft);
  assert.equal(extractFunction(fullScript, 'function rescueDrafts('), expectedRescueDrafts);
});

test('normal logout with blank drafts clears only current user bj-user:<uid>:* keys with zero store calls', async () => {
  let storeCalls = 0;
  const {ctx, localStorage, location, events, prompts, clickLogout} = createPage({
    storage: {
      'bj-user:u1:bj-drafts': '{}',
      'bj-user:u1:bj-wbackup': '{"2026-11-15":{"done":true}}',
      'bj-user:u1:bj-mtext': '"鸡胸肉沙拉"',
      'bj-user:u1:bj-fbtext': '"膝盖轻微不适"',
      'bj-user:u1:bj-tab': '"today"',
      'bj-user:u2:bj-drafts': '{"2026-11-16|A":{"key":"A"}}',
      'bj-user:u2:bj-wbackup': '{"2026-11-15":{"done":true}}',
      'bj-user:u10:bj-mtext': '"不应被前缀误删"',
      'theme': 'dark',
      'bj-drafts': '{"legacy":true}'
    },
    confirmImpl: () => { throw new Error('confirm should not run when nothing is unsynced'); },
    storeImpl: {
      async get() { storeCalls++; return null; },
      async set() { storeCalls++; }
    }
  });
  assert.equal(vm.runInContext('logoutSyncMs', ctx), 5000);
  vm.runInContext('S.date = "2026-11-16"; viewToday();', ctx);

  await clickLogout();

  assert.equal(storeCalls, 0);
  assert.equal(prompts.length, 0);
  assert.equal(localStorage.getItem('bj-user:u1:bj-drafts'), null);
  assert.equal(localStorage.getItem('bj-user:u1:bj-wbackup'), null);
  assert.equal(localStorage.getItem('bj-user:u1:bj-mtext'), null);
  assert.equal(localStorage.getItem('bj-user:u1:bj-fbtext'), null);
  assert.equal(localStorage.getItem('bj-user:u1:bj-tab'), null);
  assert.equal(localStorage.getItem('bj-user:u2:bj-drafts'), '{"2026-11-16|A":{"key":"A"}}');
  assert.equal(localStorage.getItem('bj-user:u2:bj-wbackup'), '{"2026-11-15":{"done":true}}');
  assert.equal(localStorage.getItem('bj-user:u10:bj-mtext'), '"不应被前缀误删"');
  assert.equal(localStorage.getItem('theme'), 'dark');
  assert.equal(localStorage.getItem('bj-drafts'), '{"legacy":true}');
  assert.equal(events.at(-1), 'signout');
  assert.equal(location.href, '/login.html');
});

test('all-synced drafts (matching cloud saved workout or cloud workoutDraft) clear silently without writes', async () => {
  let setCalls = 0;
  const cloudDocs = new Map([
    ['days/2026-11-14', {
      date: '2026-11-14',
      meals: [],
      workout: {done: true, key: 'A', exercises: [{name: '平板杠铃卧推', sets: [{w: '60', r: '8'}]}], feel: 4, pain: 'none', painArea: '', note: ''}
    }],
    ['days/2026-11-16', {
      date: '2026-11-16',
      meals: [],
      workoutDraft: {key: 'B', exercises: [{name: '引体向上', sets: [{w: '0', r: '8'}]}], feel: 3, pain: 'none', painArea: '', note: '已同步'}
    }]
  ]);
  const {localStorage, location, prompts, clickLogout} = createPage({
    storage: {
      'bj-user:u1:bj-drafts': JSON.stringify({
        '2026-11-14|A': {key: 'A', exercises: [{name: '平板杠铃卧推', sets: [{w: '60', r: '8'}]}], feel: 4, pain: 'none', painArea: '', note: ''},
        '2026-11-16|B': {key: 'B', exercises: [{name: '引体向上', sets: [{w: '0', r: '8'}]}], feel: 3, pain: 'none', painArea: '', note: '已同步'}
      }),
      'bj-user:u2:bj-drafts': '{"keep":true}'
    },
    confirmImpl: () => { throw new Error('confirm should not run when all drafts match cloud'); },
    storeImpl: {
      async get(p) { return cloudDocs.get(p) || null; },
      async set() { setCalls++; }
    }
  });

  await clickLogout();

  assert.equal(setCalls, 0);
  assert.equal(prompts.length, 0);
  assert.equal(localStorage.getItem('bj-user:u1:bj-drafts'), null);
  assert.equal(localStorage.getItem('bj-user:u2:bj-drafts'), '{"keep":true}');
  assert.equal(location.href, '/login.html');
});

test('single representable unsynced workout draft syncs before clearing local keys and signing out', async () => {
  const savedDocs = new Map();
  const {localStorage, location, events, clickLogout} = createPage({
    storage: {
      'bj-user:u1:bj-drafts': JSON.stringify({
        '2026-11-16|A': {
          key: 'A',
          exercises: [{name: '平板杠铃卧推', sets: [{w: '62.5', r: '8'}]}],
          feel: 4,
          pain: 'none',
          painArea: '',
          note: '状态不错'
        }
      }),
      'bj-user:u1:bj-wbackup': '{"2026-11-14":{"done":true}}',
      'bj-user:u2:bj-mtext': '"保留其他账号"'
    },
    confirmImpl: () => { throw new Error('confirm should not run when single draft sync succeeds'); },
    storeImpl: {
      async get(docPath) {
        events.push(`get:${docPath}`);
        return savedDocs.get(docPath) || null;
      },
      async set(docPath, data) {
        assert.ok(localStorage.getItem('bj-user:u1:bj-drafts'));
        assert.ok(!events.includes('signout'));
        events.push(`set:${docPath}`);
        savedDocs.set(docPath, data);
      }
    }
  });

  await clickLogout();

  const syncedDay = savedDocs.get('days/2026-11-16');
  assert.ok(syncedDay?.workoutDraft);
  assert.equal(syncedDay.workoutDraft.key, 'A');
  assert.equal(syncedDay.workoutDraft.exercises[0].sets[0].w, '62.5');
  assert.equal(syncedDay.workoutDraft.note, '状态不错');
  assert.equal(localStorage.getItem('bj-user:u1:bj-drafts'), null);
  assert.equal(localStorage.getItem('bj-user:u1:bj-wbackup'), null);
  assert.equal(localStorage.getItem('bj-user:u2:bj-mtext'), '"保留其他账号"');
  assert.ok(events.indexOf('set:days/2026-11-16') < events.indexOf('remove:bj-user:u1:bj-drafts'));
  assert.ok(events.indexOf('remove:bj-user:u1:bj-drafts') < events.indexOf('signout'));
  assert.equal(location.href, '/login.html');
});

test('completed workout A plus unsaved workout B on the same day prompts and cancel preserves everything', async () => {
  let setCalls = 0, logoutCalled = 0;
  const savedDay = {
    date: '2026-11-16',
    meals: [],
    workout: {done: true, key: 'A', exercises: [{name: '平板杠铃卧推', sets: [{w: '60', r: '8'}]}]}
  };
  const draftsRaw = JSON.stringify({
    '2026-11-16|A': {key: 'A', exercises: [{name: '平板杠铃卧推', sets: [{w: '60', r: '8'}]}]},
    '2026-11-16|B': {key: 'B', exercises: [{name: '引体向上', sets: [{w: '0', r: '10'}]}]}
  });
  const {ctx, localStorage, location, prompts, clickLogout} = createPage({
    storage: {'bj-user:u1:bj-drafts': draftsRaw, 'bj-user:u1:bj-wbackup': '{"2026-11-16":{"done":true}}'},
    confirmImpl: () => false,
    logoutImpl: async () => { logoutCalled++; },
    storeImpl: {
      async get(p) { return p === 'days/2026-11-16' ? savedDay : null; },
      async set() { setCalls++; }
    }
  });
  vm.runInContext(`S.days["2026-11-16"] = ${JSON.stringify(savedDay)};`, ctx);

  const btn = await clickLogout();

  assert.equal(setCalls, 0);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /训练草稿.*丢失/);
  assert.equal(logoutCalled, 0);
  assert.equal(location.href, '/');
  assert.equal(btn.disabled, false);
  assert.equal(vm.runInContext('S.busy.logout', ctx), false);
  assert.equal(vm.runInContext('storageUser', ctx), 'u1');
  assert.equal(localStorage.getItem('bj-user:u1:bj-drafts'), draftsRaw);
  assert.equal(localStorage.getItem('bj-user:u1:bj-wbackup'), '{"2026-11-16":{"done":true}}');
});

test('edited-but-unsaved completed workout prompts instead of silently discarding edits', async () => {
  let setCalls = 0, logoutCalled = 0;
  const savedDay = {
    date: '2026-11-16',
    meals: [],
    workout: {done: true, key: 'A', exercises: [{name: '平板杠铃卧推', sets: [{w: '60', r: '8'}]}], note: ''}
  };
  const editedDraftRaw = JSON.stringify({
    '2026-11-16|A': {key: 'A', exercises: [{name: '平板杠铃卧推', sets: [{w: '65', r: '8'}]}], note: '加了 5kg 未点保存'}
  });
  const {ctx, localStorage, location, prompts, clickLogout} = createPage({
    storage: {'bj-user:u1:bj-drafts': editedDraftRaw},
    confirmImpl: () => false,
    logoutImpl: async () => { logoutCalled++; },
    storeImpl: {
      async get(p) { return p === 'days/2026-11-16' ? savedDay : null; },
      async set() { setCalls++; }
    }
  });
  vm.runInContext(`S.days["2026-11-16"] = ${JSON.stringify(savedDay)};`, ctx);

  await clickLogout();

  assert.equal(setCalls, 0);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /训练草稿.*丢失/);
  assert.equal(logoutCalled, 0);
  assert.equal(location.href, '/');
  assert.equal(localStorage.getItem('bj-user:u1:bj-drafts'), editedDraftRaw);
});

test('two unsaved plan keys on the same day never overwrite each other in workoutDraft and prompt before clearing', async () => {
  let setCalls = 0, logoutCalled = 0;
  const twoKeysRaw = JSON.stringify({
    '2026-11-16|A': {key: 'A', exercises: [{name: '平板杠铃卧推', sets: [{w: '60', r: '8'}]}]},
    '2026-11-16|B': {key: 'B', exercises: [{name: '深蹲', sets: [{w: '80', r: '5'}]}]}
  });
  // Case 1: cloud is empty; neither pending draft may overwrite the other.
  const emptyCloud = createPage({
    storage: {'bj-user:u1:bj-drafts': twoKeysRaw},
    confirmImpl: () => false,
    logoutImpl: async () => { logoutCalled++; },
    storeImpl: {
      async get() { return null; },
      async set() { setCalls++; }
    }
  });
  await emptyCloud.clickLogout();
  assert.equal(setCalls, 0);
  assert.equal(emptyCloud.prompts.length, 1);
  assert.equal(logoutCalled, 0);
  assert.equal(emptyCloud.localStorage.getItem('bj-user:u1:bj-drafts'), twoKeysRaw);

  // Case 2: cloud already has workoutDraft for A; local pending B must not overwrite cloud A.
  const cloudWithA = {
    date: '2026-11-16',
    meals: [],
    workoutDraft: {key: 'A', exercises: [{name: '平板杠铃卧推', sets: [{w: '60', r: '8'}]}]}
  };
  const existingCloud = createPage({
    storage: {'bj-user:u1:bj-drafts': twoKeysRaw},
    confirmImpl: () => false,
    logoutImpl: async () => { logoutCalled++; },
    storeImpl: {
      async get() { return cloudWithA; },
      async set() { setCalls++; }
    }
  });
  await existingCloud.clickLogout();
  assert.equal(setCalls, 0);
  assert.equal(existingCloud.prompts.length, 1);
  assert.equal(logoutCalled, 0);
  assert.equal(existingCloud.localStorage.getItem('bj-user:u1:bj-drafts'), twoKeysRaw);
});

test('sync timeout defaults to cancel when confirm is absent, keeps everything on cancel, and clears on confirm', async () => {
  let logoutCalled = 0;
  const draftRaw = JSON.stringify({
    '2026-11-16|A': {key: 'A', exercises: [{name: '深蹲', sets: [{w: '80', r: '5'}]}]}
  });
  const prompts = [];
  const page = createPage({
    storage: {'bj-user:u1:bj-drafts': draftRaw, 'bj-user:u2:bj-drafts': '{"keep":true}', 'theme': 'light'},
    logoutImpl: async () => { logoutCalled++; },
    storeImpl: {
      get() { return new Promise(() => {}); },
      set() { return new Promise(() => {}); }
    }
  });
  vm.runInContext('logoutSyncMs = 20;', page.ctx);

  // Missing confirm defaults to cancel.
  await page.clickLogout();
  assert.equal(logoutCalled, 0);
  assert.equal(page.location.href, '/');
  assert.equal(page.localStorage.getItem('bj-user:u1:bj-drafts'), draftRaw);

  // Explicit cancel keeps everything and leaves nothing destructive armed.
  page.ctx.confirm = msg => { prompts.push(msg); return false; };
  await page.clickLogout();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /训练草稿.*丢失/);
  assert.equal(logoutCalled, 0);
  assert.equal(page.location.href, '/');
  assert.equal(page.localStorage.getItem('bj-user:u1:bj-drafts'), draftRaw);
  assert.equal(vm.runInContext('storageUser', page.ctx), 'u1');

  // Explicit confirm clears current user's keys only and signs out.
  page.ctx.confirm = msg => { prompts.push(msg); return true; };
  await page.clickLogout();
  assert.equal(prompts.length, 2);
  assert.equal(logoutCalled, 1);
  assert.equal(page.localStorage.getItem('bj-user:u1:bj-drafts'), null);
  assert.equal(page.localStorage.getItem('bj-user:u2:bj-drafts'), '{"keep":true}');
  assert.equal(page.localStorage.getItem('theme'), 'light');
  assert.equal(page.location.href, '/login.html');
});

test('divergent in-memory S.drafts and localStorage payloads for the same date|key prompt instead of silent clear', async () => {
  let setCalls = 0, logoutCalled = 0;
  const draftX = {key: 'A', exercises: [{name: '平板杠铃卧推', sets: [{w: '60', r: '8'}]}], feel: 3, pain: 'none', painArea: '', note: ''};
  const draftYRaw = JSON.stringify({
    '2026-11-16|A': {key: 'A', exercises: [{name: '平板杠铃卧推', sets: [{w: '65', r: '10'}]}], feel: 4, pain: 'none', painArea: '', note: '另一标签页新改'}
  });
  const cloudWithX = {date: '2026-11-16', meals: [], workoutDraft: draftX};
  const page = createPage({
    storage: {'bj-user:u1:bj-drafts': JSON.stringify({'2026-11-16|A': draftX})},
    confirmImpl: () => false,
    logoutImpl: async () => { logoutCalled++; },
    storeImpl: {
      async get(p) { return p === 'days/2026-11-16' ? cloudWithX : null; },
      async set() { setCalls++; }
    }
  });
  // Simulate Tab B persisting newer unsynced payload Y to localStorage while Tab A still holds X in memory.
  page.localStorage.setItem('bj-user:u1:bj-drafts', draftYRaw);

  await page.clickLogout();

  assert.equal(setCalls, 0);
  assert.equal(page.prompts.length, 1);
  assert.match(page.prompts[0], /训练草稿.*丢失/);
  assert.equal(logoutCalled, 0);
  assert.equal(page.location.href, '/');
  assert.equal(page.localStorage.getItem('bj-user:u1:bj-drafts'), draftYRaw);
});

test('edits made during awaited verification are caught before clearing (re-verified once or prompted)', async () => {
  // Part 1: user edits a completed workout day while cloud parity read is in flight -> cannot safely sync, must prompt.
  let logoutCalled = 0;
  const completedDay = {
    date: '2026-11-16',
    meals: [],
    workout: {done: true, key: 'push', exercises: [{name: '平板杠铃卧推', sets: [{w: '60', r: '8'}]}]}
  };
  let editedRaw = '';
  const unverifiedEdit = createPage({
    storage: {
      'bj-user:u1:bj-drafts': JSON.stringify({
        '2026-11-16|push': {key: 'push', exercises: [{name: '平板杠铃卧推', sets: [{w: '60', r: '8'}]}]}
      })
    },
    confirmImpl: () => false,
    logoutImpl: async () => { logoutCalled++; },
    storeImpl: {
      async get() {
        await new Promise(r => setTimeout(r, 5));
        vm.runInContext(`
          S.drafts["2026-11-16|push"].exercises[0].sets[0].w = "65";
          persistDrafts();
        `, unverifiedEdit.ctx);
        editedRaw = unverifiedEdit.localStorage.getItem('bj-user:u1:bj-drafts');
        return completedDay;
      },
      async set() { throw new Error('must not overwrite completed workout day'); }
    }
  });
  vm.runInContext(`S.days["2026-11-16"] = ${JSON.stringify(completedDay)};`, unverifiedEdit.ctx);

  await unverifiedEdit.clickLogout();

  assert.equal(unverifiedEdit.prompts.length, 1);
  assert.match(unverifiedEdit.prompts[0], /训练草稿.*丢失/);
  assert.equal(logoutCalled, 0);
  assert.equal(unverifiedEdit.location.href, '/');
  assert.equal(unverifiedEdit.localStorage.getItem('bj-user:u1:bj-drafts'), editedRaw);
  assert.match(editedRaw, /"65"/);

  // Part 2: user types into an active draft via real input handler during initial cloud parity read -> re-verifies once and syncs 65kg before clearing.
  const cloudDocs = new Map([
    ['days/2026-11-16', {
      date: '2026-11-16',
      meals: [],
      workoutDraft: {key: 'push', exercises: [{name: '平板杠铃卧推', sets: [{w: '60', r: '8'}, {w: '', r: ''}, {w: '', r: ''}]}]}
    }]
  ]);
  let getCount = 0;
  const syncableEdit = createPage({
    storage: {},
    confirmImpl: () => { throw new Error('confirm should not run when single re-verify syncs new edit'); },
    storeImpl: {
      async get(p) {
        getCount++;
        if (getCount === 1) {
          await new Promise(r => setTimeout(r, 5));
          // Fire real DOM input event on set 0 weight during the awaited initial verification.
          syncableEdit.listeners.input({target: {dataset: {set: '0.0.w'}, value: '65'}});
        }
        return cloudDocs.get(p) || null;
      },
      async set(p, data) { cloudDocs.set(p, data); }
    }
  });
  vm.runInContext(`
    S.date = "2026-11-16";
    S.days["2026-11-16"] = ${JSON.stringify(cloudDocs.get('days/2026-11-16'))};
    getDraft("2026-11-16", planFor("2026-11-16"));
    S.drafts["2026-11-16|push"].exercises[0].sets[0] = {w: "60", r: "8"};
    persistDrafts();
  `, syncableEdit.ctx);

  await syncableEdit.clickLogout();

  assert.equal(cloudDocs.get('days/2026-11-16').workoutDraft.exercises[0].sets[0].w, '65');
  assert.equal(syncableEdit.localStorage.getItem('bj-user:u1:bj-drafts'), null);
  assert.equal(syncableEdit.location.href, '/login.html');
});

test('account deletion still clears only deleted user localStorage keys', async () => {
  const {localStorage, location, events, clickAct} = createPage({
    storage: {
      'bj-user:u1:bj-drafts': '{"2026-11-16|A":{"key":"A"}}',
      'bj-user:u1:bj-wbackup': '{"2026-11-15":{"done":true}}',
      'bj-user:u2:bj-drafts': '{"other":true}',
      'theme': 'dark'
    },
    elements: {
      '#delete-password': {value: 'correct-horse-battery-staple'},
      '#delete-confirm': {checked: true}
    }
  });

  await clickAct('delete-account');

  assert.deepEqual(events.filter(e => e.startsWith('delete:')), ['delete:correct-horse-battery-staple']);
  assert.equal(localStorage.getItem('bj-user:u1:bj-drafts'), null);
  assert.equal(localStorage.getItem('bj-user:u1:bj-wbackup'), null);
  assert.equal(localStorage.getItem('bj-user:u2:bj-drafts'), '{"other":true}');
  assert.equal(localStorage.getItem('theme'), 'dark');
  assert.equal(location.replaced, '/login.html?deleted=1');
});

test('privacy page documents logout draft sync, local cleanup and shared-device advice', () => {
  const privacy = fs.readFileSync(path.join(__dirname, '../public/privacy.html'), 'utf8');
  assert.doesNotMatch(privacy, /退出登录目前不会清除/);
  assert.match(privacy, /退出登录时会先尝试同步未同步的训练草稿，再清除本设备浏览器中该账号的本地草稿与训练备份/);
  assert.match(privacy, /在共享设备上仍请使用无痕\/隐私窗口/);
});
