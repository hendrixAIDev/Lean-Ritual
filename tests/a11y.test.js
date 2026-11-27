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

function extractInlineScript(html) {
  const matches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const inline = matches.find(m => !/\bsrc\s*=/i.test(m[1]));
  assert.ok(inline, 'expected inline <script> block');
  return inline[2];
}

function mountApp({ lang = 'zh', profile = null, days = {}, feedback = [] } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const script = extractInlineScript(html);

  let focusedTarget = null;
  const listeners = {};
  const storeData = new Map();
  if (profile) storeData.set('data/users/u1/app/app/profile', JSON.parse(JSON.stringify(profile)));
  for (const [d, val] of Object.entries(days)) {
    storeData.set(`data/users/u1/app/days/${d}`, JSON.parse(JSON.stringify(val)));
  }
  for (const f of feedback) {
    storeData.set(`data/users/u1/app/feedback/${f.id}`, JSON.parse(JSON.stringify(f)));
  }

  const storage = new Map([['bj-lang', lang]]);
  const localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: k => { storage.delete(k); },
    get length() { return storage.size; },
    key: i => [...storage.keys()][i] ?? null
  };

  const makeEl = id => ({
    id,
    innerHTML: '',
    textContent: '',
    hidden: id !== 'app',
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    contains: () => false,
    focus() { focusedTarget = `#${id}`; }
  });
  const appEl = makeEl('app');
  const tabsEl = makeEl('tabs');
  const toastEl = makeEl('toast');

  function queryRendered(sel) {
    const src = appEl.innerHTML;
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      if (id === 'app') return appEl;
      if (id === 'tabs') return tabsEl;
      if (id === 'toast') return toastEl;
      if (new RegExp(`\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(src)) {
        return { id, focus() { focusedTarget = sel; } };
      }
      return null;
    }
    if (sel === '.chooser button' && /class="chooser"/.test(src)) {
      return { focus() { focusedTarget = '.chooser button'; } };
    }
    const actMatch = sel.match(/^\[data-act="([^"]+)"\](?:\[data-v="([^"]+)"\])?$/);
    if (actMatch) {
      const [, act, dv] = actMatch;
      const re = dv != null
        ? new RegExp(`data-act="${act}"[^>]*data-v="${dv}"|data-v="${dv}"[^>]*data-act="${act}"`)
        : new RegExp(`data-act="${act}"`);
      if (re.test(src)) return { focus() { focusedTarget = sel; } };
    }
    return null;
  }

  const document = {
    documentElement: { lang: 'zh-CN' },
    title: '',
    activeElement: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector: sel => queryRendered(sel),
    querySelectorAll(sel) {
      if (sel === '[data-act="adopt-open"]') {
        return [...appEl.innerHTML.matchAll(/<button\b[^>]*data-act="adopt-open"[^>]*data-key="([^"]+)"[^>]*>/g)].map(m => ({
          dataset: { act: 'adopt-open', key: m[1] },
          focus() { focusedTarget = `[data-act="adopt-open"][data-key="${m[1]}"]`; }
        }));
      }
      return [];
    },
    getElementById: id => queryRendered(`#${id}`)
  };

  const db = {
    doc(p) {
      return {
        async get() {
          return storeData.has(p) ? { exists: true, data: () => JSON.parse(JSON.stringify(storeData.get(p))) } : { exists: false };
        },
        async set(d) { storeData.set(p, JSON.parse(JSON.stringify(d))); },
        async delete() { storeData.delete(p); }
      };
    },
    async commit(changes) {
      for (const c of changes) {
        if (c.after !== undefined) storeData.set(c.path, JSON.parse(JSON.stringify(c.after)));
      }
    },
    collection(prefix) {
      return {
        orderBy() { return this; },
        limit() { return this; },
        async get() {
          const docs = [];
          for (const [k, v] of storeData.entries()) {
            if (k.startsWith(prefix + '/')) {
              docs.push({ id: k.slice(prefix.length + 1), data: () => JSON.parse(JSON.stringify(v)) });
            }
          }
          return { docs };
        }
      };
    }
  };

  const window = {
    scrollTo() {},
    ritual: {
      hosted: true,
      async use(name) {
        if (name === 'db') return db;
        if (name === 'user') return { async me() { return { id: 'u1', username: 'tester', created: '2026-11-18T00:00:00Z' }; } };
        return null;
      }
    }
  };

  const ctx = vm.createContext({
    window,
    document,
    localStorage,
    navigator: { userAgent: 'node-test', languages: [lang === 'en' ? 'en-US' : 'zh-CN'] },
    location: { href: 'http://127.0.0.1:8080/', hostname: '127.0.0.1', search: `?lang=${lang}` },
    URL,
    Date,
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
    console,
    setTimeout,
    clearTimeout
  });

  vm.runInContext(script, ctx);

  return {
    ctx,
    appEl,
    tabsEl,
    toastEl,
    document,
    getFocused: () => focusedTarget,
    clearFocused: () => { focusedTarget = null; },
    async waitReady() {
      for (let i = 0; i < 30; i++) {
        if (vm.runInContext('S.ready', ctx)) return;
        await new Promise(r => setTimeout(r, 5));
      }
      throw new Error('App did not become ready');
    },
    async click(act, v) {
      const btn = {
        dataset: { act, ...(v !== undefined ? { v: String(v) } : {}) },
        disabled: false,
        closest(sel) { return sel === '[data-act]' ? btn : null; }
      };
      for (const fn of listeners.click || []) await fn({ target: btn });
    },
    keydown(key) {
      let prevented = false;
      for (const fn of listeners.keydown || []) {
        fn({ key, preventDefault() { prevented = true; } });
      }
      return prevented;
    }
  };
}

function parseTagAttrs(tagHtml) {
  const attrs = {};
  for (const m of tagHtml.matchAll(/\b([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)) {
    if (m[1].toLowerCase() === 'input') continue;
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

test('workout grid inputs have unique localized accessible names, decimal weight & numeric rep keypads in zh and en', async () => {
  const baseProfile = {
    sex: 'm', age: 29, height: 176, weight: 72, bf: 15, steps: 9500,
    exp: 'mid', stage: 'cut', trainDays: [1, 3, 5], slot: 'eve', equipment: 'gym',
    injuries: [], supps: ['creatine'], startDate: '2026-11-01'
  };

  // 1. Chinese workout session (Push day + extra bonus exercise)
  const zhApp = mountApp({ lang: 'zh', profile: baseProfile });
  await zhApp.waitReady();
  const td = vm.runInContext('todayStr()', zhApp.ctx);
  vm.runInContext(`S.days[${JSON.stringify(td)}] = { date: ${JSON.stringify(td)}, override: "push", extra: { ex: [{ name: "平板支撑（秒）", sets: 2, lo: 30, hi: 60 }] }, meals: [] }; render();`, zhApp.ctx);

  const zhSetInputs = [...zhApp.appEl.innerHTML.matchAll(/<input\b[^>]*\bdata-set="[^"]+"[^>]*>/g)].map(m => parseTagAttrs(m[0]));
  assert.ok(zhSetInputs.length >= 34, `expected >= 34 set inputs (5 exercises × 3 sets × 2 + 1 timed × 2 × 2), got ${zhSetInputs.length}`);

  const byIdZh = new Map(zhSetInputs.map(a => [a.id, a]));
  assert.equal(byIdZh.get('w-0-0-w')['aria-label'], '上斜杠铃卧推 第1组 重量');
  assert.equal(byIdZh.get('w-0-0-r')['aria-label'], '上斜杠铃卧推 第1组 次数');
  assert.equal(byIdZh.get('w-0-2-w')['aria-label'], '上斜杠铃卧推 第3组 重量');
  assert.equal(byIdZh.get('w-0-2-r')['aria-label'], '上斜杠铃卧推 第3组 次数');
  assert.equal(byIdZh.get('w-1-0-w')['aria-label'], '平板杠铃卧推 第1组 重量');
  assert.equal(byIdZh.get('w-5-0-w')['aria-label'], '平板支撑（秒） 第1组 重量');
  assert.equal(byIdZh.get('w-5-0-r')['aria-label'], '平板支撑（秒） 第1组 秒数');
  assert.equal(byIdZh.get('w-5-1-r')['aria-label'], '平板支撑（秒） 第2组 秒数');

  const zhLabels = zhSetInputs.map(a => a['aria-label']);
  assert.equal(new Set(zhLabels).size, zhLabels.length, 'every workout set input in zh must have a unique accessible name');
  for (const inp of zhSetInputs) {
    assert.equal(inp.autocomplete, 'off');
    if (inp.id.endsWith('-w')) {
      assert.equal(inp.inputmode, 'decimal', `${inp.id} weight must use decimal keypad`);
    } else {
      assert.equal(inp.inputmode, 'numeric', `${inp.id} reps/seconds must use numeric keypad`);
    }
  }

  // Dynamic inputs (#ex-new, #lib-*, #cu-0-name) also have explicit aria-labels in zh
  const zhExNew = parseTagAttrs(zhApp.appEl.innerHTML.match(/<input\b[^>]*\bid="ex-new"[^>]*>/)[0]);
  assert.equal(zhExNew['aria-label'], '其他动作名');
  const zhLib = parseTagAttrs(zhApp.appEl.innerHTML.match(/<input\b[^>]*\bdata-lib="[^"]+"[^>]*>/)[0]);
  assert.match(zhLib['aria-label'], /收藏教学视频链接（上斜杠铃卧推）/);
  assert.equal(zhLib.inputmode, 'url');

  // 2. English workout session (Push day + timed extra + custom workout)
  const enApp = mountApp({ lang: 'en', profile: { ...baseProfile, lang: 'en' } });
  await enApp.waitReady();
  vm.runInContext(`S.days[${JSON.stringify(td)}] = { date: ${JSON.stringify(td)}, override: "push", extra: { ex: [{ name: "平板支撑（秒）", sets: 2, lo: 30, hi: 60 }] }, meals: [] }; render();`, enApp.ctx);

  const enSetInputs = [...enApp.appEl.innerHTML.matchAll(/<input\b[^>]*\bdata-set="[^"]+"[^>]*>/g)].map(m => parseTagAttrs(m[0]));
  const byIdEn = new Map(enSetInputs.map(a => [a.id, a]));
  assert.equal(byIdEn.get('w-0-0-w')['aria-label'], 'Incline Barbell Bench Press · Set 1 weight');
  assert.equal(byIdEn.get('w-0-0-r')['aria-label'], 'Incline Barbell Bench Press · Set 1 reps');
  assert.equal(byIdEn.get('w-1-0-w')['aria-label'], 'Barbell Bench Press · Set 1 weight');
  assert.equal(byIdEn.get('w-5-0-w')['aria-label'], 'Plank (sec) · Set 1 weight');
  assert.equal(byIdEn.get('w-5-0-r')['aria-label'], 'Plank (sec) · Set 1 seconds');

  const enLabels = enSetInputs.map(a => a['aria-label']);
  assert.equal(new Set(enLabels).size, enLabels.length, 'every workout set input in en must have a unique accessible name');

  // Custom workout exercise name input aria-label in English
  vm.runInContext(`S.days[${JSON.stringify(td)}].custom = { ex: [{ name: "死虫", sets: 3, lo: 8, hi: 12 }] }; S.days[${JSON.stringify(td)}].override = "custom"; render();`, enApp.ctx);
  const enCuName = parseTagAttrs(enApp.appEl.innerHTML.match(/<input\b[^>]*\bid="cu-0-name"[^>]*>/)[0]);
  assert.equal(enCuName['aria-label'], 'Exercise 1 name');
});

test('chooser, inline editors, landmarks, live regions, reduced-motion, contrast tokens, and release exclusion', async () => {
  // 1. Static shell & CSS checks across app/index.html and public/*.html
  for (const rel of ['app/index.html', 'public/index.html', 'public/login.html', 'public/privacy.html', 'public/terms.html', 'public/guide.html']) {
    const html = withLinkedCss(rel);
    assert.match(html, /<main\b/i, `${rel} must contain a <main> landmark`);
    assert.match(html, /:focus-visible\s*\{/, `${rel} must define visible focus styles`);
    assert.match(html, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/, `${rel} must respect prefers-reduced-motion`);
  }
  const builtIndex = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(builtIndex, /<div[^>]*\bid="toast"[^>]*\brole="status"[^>]*\baria-live="polite"/);
  assert.match(builtIndex, /<nav[^>]*\bid="tabs"[^>]*\baria-label=/);

  // 2. Release packaging boundary: axe-core is test-only and excluded from public/ and ops/package-release.py
  assert.equal(fs.existsSync(AXE_PATH), true, 'vendored axe.min.js must exist under tests/fixtures/axe-core');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkgJson.dependencies['axe-core'], undefined, 'axe-core must never be a production dependency');
  assert.equal(pkgJson.devDependencies?.['axe-core'], undefined, 'axe-core must not enter node_modules packaged by ops/package-release.py');
  const releaseScript = fs.readFileSync(path.join(ROOT, 'ops/package-release.py'), 'utf8');
  assert.doesNotMatch(releaseScript, /\btests\b/, 'ops/package-release.py must not bundle tests/');
  for (const f of fs.readdirSync(path.join(ROOT, 'public'), { recursive: true })) {
    assert.doesNotMatch(String(f), /(?:^|[\\/])axe(?:[-.]|$)/i, 'public/ must never ship axe-core');
  }

  // 2b. Verify :root color tokens meet WCAG AA >= 4.5:1 contrast in both light and dark modes
  const lum = hex => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const n = parseInt(full, 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const contrast = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const parseVars = block => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})/g)].map(m => [m[1], m[2]]));
  const appCss = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  const appLight = parseVars(appCss.match(/:root\s*\{([^}]*)\}/)[1]);
  const appDark = parseVars(appCss.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)[1]);
  for (const [themeName, v] of [['app-light', appLight], ['app-dark', appDark]]) {
    for (const [pair, fg, bg] of [
      ['ink/bg', v.ink, v.bg],
      ['ink/surface', v.ink, v.surface],
      ['muted/bg', v.muted, v.bg],
      ['muted/surface', v.muted, v.surface],
      ['muted/sunk', v.muted, v.sunk],
      ['muted/bad-soft', v.muted, v['bad-soft']],
      ['warn/warn-soft', v.warn, v['warn-soft']],
      ['bad/bad-soft', v.bad, v['bad-soft']],
      ['accent/surface', v.accent, v.surface],
      ['accent/sunk', v.accent, v.sunk],
      ['on-accent/accent', v['on-accent'], v.accent]
    ]) {
      assert.ok(contrast(fg, bg) >= 4.5, `${themeName} ${pair} (${fg} on ${bg}) contrast ${contrast(fg, bg).toFixed(2)} < 4.5`);
    }
  }
  // The public pages are dark only and take every colour from the shared site theme (Nocturne).
  for (const rel of ['public/landing.html', 'public/login.html', 'public/privacy.html', 'public/terms.html', 'public/guide.html']) {
    const css = withLinkedCss(rel);
    assert.match(css, /<link rel="stylesheet" href="\/site\/theme\.css">/, `${rel} must load the shared theme`);
    assert.doesNotMatch(css, /<style\b|\sstyle="/i, `${rel} must keep its styles in the shared stylesheets`);
    assert.doesNotMatch(css, /prefers-color-scheme:\s*light\)\s*\{/, `${rel} is dark only`);
  }
  const site = parseVars(fs.readFileSync(path.join(ROOT, 'public/site/theme.css'), 'utf8').match(/:root\s*\{([^}]*)\}/)[1]);
  for (const [pair, fg, bg, min] of [
    ['ivory/bg', site.ivory, site.bg, 7], ['text-read/bg', site['text-read'], site.bg, 7], ['muted/bg', site.muted, site.bg, 7],
    ['muted/solid', site.muted, site.solid, 7], ['muted/field', site.muted, site.field, 7], ['emerald-hi/bg', site['emerald-hi'], site.bg, 7],
    ['emerald-hi/solid', site['emerald-hi'], site.solid, 7], ['placeholder/field', site.placeholder, site.field, 4.5],
    ['danger/solid', site.danger, site.solid, 4.5], ['warn/bg', site.warn, site.bg, 4.5], ['on-emerald/emerald', site['on-emerald'], site.emerald, 4.5],
    ['on-emerald/emerald-hi', site['on-emerald'], site['emerald-hi'], 4.5],
    // input and checkbox borders are non-text UI: 3:1 against the field and the panel around it
    ['field-line/field', site['field-line'], site.field, 3], ['field-line/solid', site['field-line'], site.solid, 3], ['field-line/bg', site['field-line'], site.bg, 3]
  ]) assert.ok(contrast(fg, bg) >= min, `site ${pair} (${fg} on ${bg}) contrast ${contrast(fg, bg).toFixed(2)} < ${min}`);

  // 3. Keyboard focus & Escape dismissal on the 采纳 chooser and inline exercise editor
  const app = mountApp({
    lang: 'en',
    profile: {
      sex: 'm', age: 29, height: 176, weight: 72, bf: 15, steps: 9500,
      exp: 'mid', stage: 'cut', trainDays: [1, 3, 5], slot: 'eve', equipment: 'gym',
      injuries: [], supps: [], startDate: '2026-11-01', lang: 'en'
    },
    feedback: [{
      id: 'fb1',
      createdAt: '2026-11-18T10:00:00Z',
      summary: 'Good progress.',
      adjustments: [{ kind: 'swap', from: '平板杠铃卧推', to: '哑铃地板卧推', sets: 3, lo: 6, hi: 8, text: 'Protect shoulder.' }],
      applied: [],
      declined: []
    }]
  });
  await app.waitReady();
  await app.click('tab', 'fb');
  const openMatch = app.appEl.innerHTML.match(/data-act="adopt-open"[^>]*data-v='([^']+)'/);
  assert.ok(openMatch, 'expected adopt-open button');
  const openPayload = openMatch[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  app.clearFocused();
  await app.click('adopt-open', openPayload);
  assert.match(app.appEl.innerHTML, /class="chooser" role="group" aria-label="Choose adoption scope"/);
  assert.equal(app.getFocused(), '.chooser button', 'opening chooser moves focus into chooser');

  app.clearFocused();
  const escaped = app.keydown('Escape');
  assert.equal(escaped, true, 'Escape closes open chooser');
  assert.doesNotMatch(app.appEl.innerHTML, /class="chooser"/);
  assert.equal(app.getFocused(), '[data-act="adopt-open"][data-key="fb1:0"]', 'closing chooser restores focus to trigger');
});

/** A page's HTML followed by the local stylesheets it links, so CSS checks see the styles the page really gets. */
function withLinkedCss(rel) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="(\/[^"]+\.css)">/g)].map(m => fs.readFileSync(path.join(ROOT, 'public', m[1]), 'utf8'));
  return [html, ...sheets].join('\n');
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

function getFreePort() {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-a11y-test-'));
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dir,
    PORT: String(port),
    HOST: '127.0.0.1',
    AUTH_BASE_URL: base,
    AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
    COOKIE_SECURE: '0',
    TRUST_PROXY: '0',
    MAIL_MODE: 'file',
    OPENROUTER_API_KEY: ''
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

test('headless Chromium axe-core audit: zero serious/critical violations across main views in zh and en (mobile & desktop, light & dark) with zero CSP violations', async t => {
  const pw = resolvePlaywright();
  if (!pw) {
    t.skip('Playwright/Chromium not installed in this environment');
    return;
  }

  const axeSource = fs.readFileSync(AXE_PATH, 'utf8');
  const srv = await startTestServer(t);
  const issued = spawnSync(process.execPath, ['scripts/auth-admin.js', 'invite', 'a11y@example.com'], {
    cwd: ROOT, env: srv.env, encoding: 'utf8', timeout: 5000
  });
  assert.equal(issued.status, 0, issued.stderr);
  const invite = JSON.parse(issued.stdout);
  const pwStr = 'a11y-strong-password-123';

  const browser = await pw.chromium.launch({
    executablePath: pw.executablePath,
    headless: true,
    args: ['--no-sandbox']
  });
  t.after(async () => { await browser.close(); });

  // Register, verify, and seed rich app data once
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(`${srv.base}/login.html?invite=${encodeURIComponent(invite.token)}&email=${encodeURIComponent(invite.email)}`);
    await page.locator('#n').fill('A11y Tester');
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
    await page.locator('#e').fill(invite.email);
    await page.locator('#p').fill(pwStr);
    await page.locator('#go').click();
    await page.locator('#setup').waitFor({ state: 'visible' });
    await page.locator('#f-age').fill('29');
    await page.locator('#f-height').fill('176');
    await page.locator('#f-weight').fill('72');
    await page.locator('#f-bf').fill('15');
    await page.locator('button[type="submit"]').click();
    await page.locator('nav#tabs').waitFor({ state: 'visible' });

    await page.evaluate(async () => {
      const td = todayStr();
      for (let i = 12; i >= 1; i--) {
        const d = addDays(td, -i);
        await updateDay(d, day => {
          day.checkin = { weight: 72.2 - i * 0.05, steps: 9000, sleep: 7.5, bf: 15 };
          day.meals = [
            { id: 'm1-' + i, type: '早餐', text: 'Oats + eggs', time: '08:00', est: { kcal: 500, protein: 35, carbs: 55, fat: 15, by: 'manual' } },
            { id: 'm2-' + i, type: '午餐', text: 'Chicken rice', time: '12:30', est: { kcal: 680, protein: 48, carbs: 72, fat: 18, by: 'manual' } },
            { id: 'm3-' + i, type: '晚餐', text: 'Salmon + rice', time: '19:00', est: { kcal: 610, protein: 42, carbs: 58, fat: 20, by: 'manual' } }
          ];
          if (i % 2 === 0) {
            day.workout = {
              key: 'push', slot: 'eve', done: true, savedAt: new Date().toISOString(),
              feel: 3, pain: i === 2 ? 'mild' : 'none', painArea: '',
              exercises: [{ name: '上斜杠铃卧推', sets: [{ w: 60 + i, r: 5 }, { w: 60, r: 5 }, { w: 60, r: 5 }] }]
            };
          }
        }, { quiet: true });
      }
      await updateDay(td, day => {
        day.override = 'push';
        day.checkin = { weight: 71.8, steps: 8800, sleep: 7.5, bf: 14.9 };
        day.meals = [{
          id: 'td-m1', type: '午餐', text: 'Beef bowl', time: '12:40',
          est: { kcal: 640, protein: 44, carbs: 68, fat: 19, by: 'manual' }
        }];
      }, { quiet: true });
      const nowMs = Date.now();
      const fb = {
        id: 'fb-a11y',
        createdAt: new Date(nowMs).toISOString(),
        userText: 'Shoulder tight on bench',
        summary: 'Steady progress; consider floor press for comfort.',
        good: ['Consistent protein'],
        issues: ['Mild shoulder tightness'],
        adjustments: [
          { kind: 'swap', from: '平板杠铃卧推', to: '哑铃地板卧推', sets: 3, lo: 6, hi: 8, text: 'Swap bench press to floor press.' },
          { kind: 'kcal', delta: -100, text: 'Trim 100 kcal.' }
        ],
        applied: [],
        declined: [1]
      };
      const extraFbs = [1, 2, 3].map(n => ({
        id: 'fb-a11y-old-' + n,
        createdAt: new Date(nowMs - n * 86400000).toISOString(),
        userText: '',
        summary: 'Historical review #' + n,
        good: ['Consistent sessions'],
        issues: [],
        adjustments: [],
        applied: [],
        declined: []
      }));
      S.feedback = [fb, ...extraFbs];
      for (const item of S.feedback) await write('feedback/' + item.id, item);
      const historyItems = Array.from({ length: 6 }, (_, idx) => ({
        id: 'ph-a11y-' + idx,
        savedAt: new Date(nowMs - idx * 86400000).toISOString(),
        changes: ['时段：晚上 → 下午']
      }));
      for (const h of historyItems) await write('profileHistory/' + h.id, h);
      S.profileHistory = historyItems;
      await updateProfile(p => {
        p.injuries = ['shoulder'];
        p.swaps = { '站姿杠铃推举': '地雷架单臂推举' };
        p.adjustLog = [
          { id: 'adj-a11y-1', date: addDays(td, -5), scope: 'long', kind: 'kcal', delta: -100, prev: { kcalAdjust: 0 }, after: { kcalAdjust: -100 }, reverted: false, text: '每日热量 -100 kcal' },
          { date: addDays(td, -4), text: '「深蹲」长期换成 腿屈伸 3×10–15' },
          { date: addDays(td, -3), text: '「面拉或后飞鸟」长期换成 面拉 3×12–15' },
          { date: addDays(td, -2), text: '「上斜杠铃卧推」长期换成 上斜俯卧撑 3×6–12' },
          { date: addDays(td, -1), text: '热量调整归零' },
          { id: 'adj-a11y-6', date: td, scope: 'long', kind: 'kcal', delta: 100, prev: { kcalAdjust: 0 }, after: { kcalAdjust: 100 }, reverted: false, text: '每日热量 +100 kcal' }
        ];
      });
      render();
    });
    await ctx.close();
  }

  async function assertAxeClean(context, page, label) {
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send('Runtime.evaluate', { expression: axeSource, awaitPromise: false });
      const res = await cdp.send('Runtime.evaluate', {
        expression: `window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
          rules: { 'target-size': { enabled: true } }
        }).then(r => JSON.stringify(r.violations.map(v => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.map(n => ({ target: n.target, html: n.html.slice(0, 120), summary: n.failureSummary }))
        }))))`,
        awaitPromise: true,
        returnByValue: true
      });
      const violations = JSON.parse(res.result.value);
      const seriousOrCritical = violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
      assert.deepEqual(seriousOrCritical, [], `Serious/critical axe violations on ${label}: ${JSON.stringify(seriousOrCritical, null, 2)}`);
      assert.deepEqual(violations, [], `Axe violations on ${label}: ${JSON.stringify(violations, null, 2)}`);
    } finally {
      await cdp.detach();
    }
  }

  const configs = [
    { lang: 'zh', colorScheme: 'light', viewport: { width: 390, height: 844 }, name: 'zh-mobile-light' },
    { lang: 'en', colorScheme: 'light', viewport: { width: 390, height: 844 }, name: 'en-mobile-light' },
    { lang: 'zh', colorScheme: 'dark', viewport: { width: 390, height: 844 }, name: 'zh-mobile-dark' },
    { lang: 'en', colorScheme: 'dark', viewport: { width: 390, height: 844 }, name: 'en-mobile-dark' },
    { lang: 'en', colorScheme: 'light', viewport: { width: 1280, height: 800 }, name: 'en-desktop-light' }
  ];

  for (const cfg of configs) {
    const context = await browser.newContext({
      viewport: cfg.viewport,
      locale: cfg.lang === 'en' ? 'en-US' : 'zh-CN',
      colorScheme: cfg.colorScheme
    });
    const page = await context.newPage();
    const cspViolations = [];
    const pageErrors = [];
    await page.exposeFunction('recordA11yCSP', v => cspViolations.push(v));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', e => {
        window.recordA11yCSP(`${e.violatedDirective}: ${e.blockedURI}`);
      });
    });
    page.on('pageerror', e => pageErrors.push(e.message));

    try {
      await page.goto(`${srv.base}/privacy.html?lang=${cfg.lang}`);
      await assertAxeClean(context, page, `${cfg.name}/privacy`);

      await page.goto(`${srv.base}/terms.html?lang=${cfg.lang}`);
      await assertAxeClean(context, page, `${cfg.name}/terms`);

      await page.goto(`${srv.base}/guide.html?lang=${cfg.lang}`);
      await assertAxeClean(context, page, `${cfg.name}/guide`);

      await page.goto(`${srv.base}/login.html?lang=${cfg.lang}`);
      await assertAxeClean(context, page, `${cfg.name}/login`);
      await page.locator('#tabs button[data-m="register"]').click();
      await assertAxeClean(context, page, `${cfg.name}/login-register`);
      await page.locator('#tabs button[data-m="login"]').click();

      await page.locator('#e').fill(invite.email);
      await page.locator('#p').fill(pwStr);
      await page.locator('#go').click();
      await page.locator('nav#tabs').waitFor({ state: 'visible' });
      await page.evaluate(async l => { await setLang(l, { persistProfile: false }); }, cfg.lang);

      // Today (workout + open form cues + primary 44x44 tap target checks on mobile)
      await page.locator('nav#tabs [data-act="tab"][data-v="today"]').click();
      await page.evaluate(() => { document.querySelector('details.how')?.setAttribute('open', ''); });
      await assertAxeClean(context, page, `${cfg.name}/today`);

      if (cfg.viewport.width === 390 && cfg.colorScheme === 'light') {
        const sizes = await page.evaluate(() => {
          const check = sel => {
            const el = document.querySelector(sel);
            const r = el.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
          };
          return {
            prevDate: check('[data-act="date"][data-v="-1"]'),
            slotChip: check('[data-act="slot"]'),
            tabBtn: check('nav#tabs button')
          };
        });
        assert.ok(sizes.prevDate.w >= 44 && sizes.prevDate.h >= 44, `date arrow >= 44x44: ${JSON.stringify(sizes.prevDate)}`);
        assert.ok(sizes.slotChip.w >= 44 && sizes.slotChip.h >= 44, `chip >= 44x44: ${JSON.stringify(sizes.slotChip)}`);
        assert.ok(sizes.tabBtn.w >= 44 && sizes.tabBtn.h >= 44, `tab >= 44x44: ${JSON.stringify(sizes.tabBtn)}`);
      }

      // Food (manual mode + label calculator)
      await page.locator('nav#tabs [data-act="tab"][data-v="food"]').click();
      await page.locator('[data-act="mmode"][data-v="manual"]').click();
      await page.evaluate(() => { S.label = { id: 'td-m1', base: '100', u: 'kJ', e: '400', p: '10', f: '5', c: '20', amt: '200' }; render(); });
      await assertAxeClean(context, page, `${cfg.name}/food`);
      await page.evaluate(() => { S.label = null; render(); });

      // Log (with daily breakdown pagination visible)
      await page.locator('nav#tabs [data-act="tab"][data-v="log"]').click();
      await page.locator('nav[data-pager="daily"]').waitFor({ state: 'visible' });
      await assertAxeClean(context, page, `${cfg.name}/log`);
      if (cfg.viewport.width === 390 && cfg.colorScheme === 'light') {
        const pagerSizes = await page.evaluate(() => ['prev', 'next'].map(dir => {
          const r = document.getElementById(`pg-daily-${dir}`).getBoundingClientRect();
          return { dir, w: Math.round(r.width), h: Math.round(r.height) };
        }));
        for (const s of pagerSizes) {
          assert.ok(s.w >= 44 && s.h >= 44, `daily pager ${s.dir} >= 44x44: ${JSON.stringify(s)}`);
        }
      }
      await page.locator('#pg-daily-next').click();
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'pg-daily-prev', 'reaching last page moves focus to prev');
      await page.locator('#pg-daily-prev').click();
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'pg-daily-next', 'returning to first page moves focus to next');

      // Feedback (with BOTH AI feedback pagination and applied adjustments pagination visible) + 采纳 chooser keyboard reachability
      await page.locator('nav#tabs [data-act="tab"][data-v="fb"]').click();
      await page.locator('nav[data-pager="feedback"]').waitFor({ state: 'visible' });
      await page.locator('nav[data-pager="adjust"]').waitFor({ state: 'visible' });
      await assertAxeClean(context, page, `${cfg.name}/feedback`);
      const adoptTrigger = page.locator('[data-act="adopt-open"]').first();
      await adoptTrigger.focus();
      await page.keyboard.press('Enter');
      await page.locator('.chooser').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.chooser')), true, 'Enter on adopt-open moves focus into chooser');
      await assertAxeClean(context, page, `${cfg.name}/adopt-chooser`);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.chooser').count(), 0, 'Escape dismisses chooser');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.act), 'adopt-open', 'Escape restores focus to adopt-open trigger');

      // Me (with profile history pagination visible) + tester feedback form + delete-account disclosure + setup edit mode
      await page.locator('nav#tabs [data-act="tab"][data-v="me"]').click();
      await page.locator('nav[data-pager="profileHistory"]').waitFor({ state: 'visible' });
      await page.evaluate(() => { document.querySelector('details')?.setAttribute('open', ''); });
      await assertAxeClean(context, page, `${cfg.name}/me`);
      await page.locator('[data-act="ufb-open"]').click();
      await page.locator('#ufb-msg').waitFor({ state: 'visible' });
      await assertAxeClean(context, page, `${cfg.name}/me-feedback`);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#ufb-msg').count(), 0, 'Escape dismisses feedback form');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.act), 'ufb-open', 'Escape restores focus to ufb-open trigger');
      await page.locator('[data-act="edit"]').click();
      await assertAxeClean(context, page, `${cfg.name}/setup`);

      assert.deepEqual(cspViolations, [], `CSP violations in ${cfg.name}`);
      assert.deepEqual(pageErrors, [], `Page errors in ${cfg.name}`);
    } finally {
      await context.close();
    }
  }
});
