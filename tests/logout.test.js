'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
const pageScript = source.match(/<script>([\s\S]*?)<\/script>/)[1].split('/* ============ 启动 ============ */')[0];

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

function createPage({storage = {}, confirmImpl, logoutImpl, storeImpl} = {}) {
  const events = [];
  const localStorage = makeStorage(storage, events);
  const listeners = {};
  const location = {href: '/'};
  const prompts = [];
  const window = {
    location,
    scrollTo() {},
    ritual: {
      hosted: true,
      logout: logoutImpl || (async () => { events.push('signout'); })
    }
  };
  const ctx = vm.createContext({
    window,
    location,
    document: {
      addEventListener(type, fn) { listeners[type] = fn; },
      querySelector() { return {innerHTML: '', hidden: true, textContent: ''}; },
      getElementById() { return null; }
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
  const clickLogout = () => {
    const btn = {dataset: {act: 'logout'}, disabled: false, closest(sel) { return sel === '[data-act]' ? btn : null; }};
    return listeners.click({target: btn});
  };
  return {ctx, localStorage, location, events, prompts, clickLogout};
}

test('normal logout clears only current user bj-user:<uid>:* keys without unnecessary sync', async () => {
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
  // Viewing Today populates an empty in-memory draft; completed or already-synced days must also stay fast.
  vm.runInContext(`
    S.date = "2026-11-16";
    viewToday();
    S.days["2026-11-14"] = {date:"2026-11-14", meals:[], workout:{done:true, key:"A", exercises:[{name:"平板杠铃卧推", sets:[{w:"60", r:"8"}]}]}};
    S.drafts["2026-11-14|A"] = JSON.parse(JSON.stringify(S.days["2026-11-14"].workout));
    S.days["2026-11-13"] = {date:"2026-11-13", meals:[], workoutDraft:{key:"B", exercises:[{name:"引体向上", sets:[{w:"0", r:"8"}]}], feel:3, pain:"none", painArea:"", note:"已同步"}};
    S.drafts["2026-11-13|B"] = JSON.parse(JSON.stringify(S.days["2026-11-13"].workoutDraft));
  `, ctx);

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

test('unsynced workout drafts sync before clearing local keys and signing out', async () => {
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
    storeImpl: {
      async get(docPath) {
        events.push(`get:${docPath}`);
        return savedDocs.get(docPath) || null;
      },
      async set(docPath, data) {
        // Local data and session must still exist while syncing to authenticated backend.
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

test('failed or timed-out draft sync prompts in Chinese and cancelling keeps local data and session', async () => {
  let logoutCalled = 0;
  const draftRaw = JSON.stringify({
    '2026-11-16|A': {key: 'A', exercises: [{name: '深蹲', sets: [{w: '80', r: '5'}]}]}
  });
  const {ctx, localStorage, location, prompts, clickLogout} = createPage({
    storage: {
      'bj-user:u1:bj-drafts': draftRaw,
      'bj-user:u1:bj-mtext': '"晚饭草稿"',
      'theme': 'light'
    },
    confirmImpl: () => false,
    logoutImpl: async () => { logoutCalled++; },
    storeImpl: {
      async get() { throw new Error('network down'); },
      async set() { throw new Error('network down'); }
    }
  });

  await clickLogout();

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /未同步.*草稿/);
  assert.equal(logoutCalled, 0);
  assert.equal(location.href, '/');
  assert.equal(localStorage.getItem('bj-user:u1:bj-drafts'), draftRaw);
  assert.equal(localStorage.getItem('bj-user:u1:bj-mtext'), '"晚饭草稿"');
  assert.equal(localStorage.getItem('theme'), 'light');

  // Timed-out sync with missing confirm also defaults to cancel, then confirming proceeds to clear & sign out.
  const noConfirm = createPage({
    storage: {'bj-user:u1:bj-drafts': draftRaw, 'bj-user:u2:bj-drafts': '{"keep":true}', 'theme': 'light'},
    logoutImpl: async () => { logoutCalled++; },
    storeImpl: {
      get() { return new Promise(() => {}); },
      set() { return new Promise(() => {}); }
    }
  });
  vm.runInContext('logoutSyncMs = 20;', noConfirm.ctx);
  await noConfirm.clickLogout();
  assert.equal(logoutCalled, 0);
  assert.equal(noConfirm.location.href, '/');
  assert.equal(noConfirm.localStorage.getItem('bj-user:u1:bj-drafts'), draftRaw);

  noConfirm.ctx.confirm = msg => { prompts.push(msg); return true; };
  await noConfirm.clickLogout();
  assert.equal(prompts.length, 2);
  assert.equal(logoutCalled, 1);
  assert.equal(noConfirm.localStorage.getItem('bj-user:u1:bj-drafts'), null);
  assert.equal(noConfirm.localStorage.getItem('bj-user:u2:bj-drafts'), '{"keep":true}');
  assert.equal(noConfirm.localStorage.getItem('theme'), 'light');
  assert.equal(noConfirm.location.href, '/login.html');
  void ctx;
});

test('privacy page documents logout draft sync, local cleanup and shared-device advice', () => {
  const privacy = fs.readFileSync(path.join(__dirname, '../public/privacy.html'), 'utf8');
  assert.doesNotMatch(privacy, /退出登录目前不会清除/);
  assert.match(privacy, /退出登录时会先尝试同步未同步的训练草稿，再清除本设备浏览器中该账号的本地草稿与训练备份/);
  assert.match(privacy, /在共享设备上仍请使用无痕\/隐私窗口/);
});
