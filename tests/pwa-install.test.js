'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-test-'));
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    MAIL_MODE: 'file',
    DATA_DIR: dir,
    COOKIE_SECURE: '0',
    TRUST_PROXY: '0',
    AUTH_SECRET: 'pwa-test-secret-with-at-least-32-characters',
    AUTH_BASE_URL: base,
    OPENROUTER_API_KEY: ''
  };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      const done = new Promise(r => child.once('exit', r));
      child.kill();
      await done;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout: ' + stderr)), 8000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolve({ base, dir, env });
    });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('server exited early: ' + stderr)); });
  });
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
        || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : pw.chromium.executablePath());
      if (execPath && fs.existsSync(execPath)) {
        return { chromium: pw.chromium, executablePath: execPath };
      }
    } catch {}
  }
  return null;
}

test('manifest.webmanifest has valid fields, matching theme tokens, existing PNG/maskable icons, and no service worker', async () => {
  const raw = fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8');
  const manifest = JSON.parse(raw);

  assert.equal(manifest.name, 'Lean Ritual · 薄肌日课');
  assert.equal(manifest.short_name, '薄肌日课');
  assert.ok([...manifest.short_name].length <= 12);
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#EEF2F0');
  assert.equal(manifest.theme_color, '#0C7560');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);

  const byKey = new Map(manifest.icons.map(i => [`${i.sizes}:${i.purpose}`, i]));
  assert.equal(byKey.get('192x192:any')?.src, '/icons/icon-192.png');
  assert.equal(byKey.get('192x192:any')?.type, 'image/png');
  assert.equal(byKey.get('512x512:any')?.src, '/icons/icon-512.png');
  assert.equal(byKey.get('512x512:any')?.type, 'image/png');
  assert.equal(byKey.get('512x512:maskable')?.src, '/icons/icon-maskable-512.png');
  assert.equal(byKey.get('512x512:maskable')?.type, 'image/png');

  const expectedPngs = [
    ['apple-touch-icon.png', 180, true],
    ['icon-192.png', 192, false],
    ['icon-512.png', 512, false],
    ['icon-maskable-512.png', 512, true],
    ['favicon-32.png', 32, false],
    ['favicon-16.png', 16, false]
  ];
  for (const [file, size, fullBleed] of expectedPngs) {
    const filePath = path.join(ROOT, 'public/icons', file);
    assert.ok(fs.existsSync(filePath), `missing icon ${file}`);
    const img = sharp(filePath);
    const meta = await img.metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, size);
    assert.equal(meta.height, size);
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // Top-left pixel alpha: opaque (#0C7560) for full-bleed iOS/maskable, transparent for rounded-square icons.
    const [r, g, b, a] = [data[0], data[1], data[2], data[3]];
    if (fullBleed) {
      assert.equal(a, 255, `${file} corner must be opaque`);
      assert.deepEqual([r, g, b], [0x0c, 0x75, 0x60], `${file} corner must match #0C7560`);
    } else {
      assert.equal(a, 0, `${file} rounded corner must be transparent`);
    }
    // Center pixel hits the white (#FFFFFF) barbell bar on every icon size.
    const cx = Math.floor(info.width / 2);
    const cy = Math.floor(info.height / 2);
    const idx = (cy * info.width + cx) * 4;
    const minChannel = size >= 180 ? 240 : 120;
    assert.ok(data[idx] > minChannel && data[idx + 1] > minChannel && data[idx + 2] > minChannel && data[idx + 3] === 255, `${file} center mark should be white`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'public/icons/icon.svg')));

  // Explicitly ensure no service worker ships or registers anywhere.
  for (const swName of ['sw.js', 'service-worker.js', 'worker.js']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'public', swName)), false, `unexpected ${swName}`);
  }
  for (const rel of ['app/index.html', 'public/index.html', 'public/login.html', 'public/privacy.html', 'public/terms.html', 'public/guide.html', 'public/shim.js']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(text, /serviceWorker\s*\.\s*register/i, `${rel} must not register a service worker`);
  }
});

test('all HTML pages include manifest, icons, light/dark theme-color, iOS standalone meta, and safe-area support in <head>', () => {
  const pages = [
    { file: 'app/index.html', cover: true },
    { file: 'public/index.html', cover: true },
    { file: 'public/login.html', cover: true },
    { file: 'public/privacy.html', cover: false },
    { file: 'public/terms.html', cover: false },
    { file: 'public/guide.html', cover: false }
  ];
  for (const { file, cover } of pages) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const headMatch = html.match(/<head>([\s\S]*?)<\/head>/i);
    assert.ok(headMatch, `${file} must have an explicit <head>...</head> section`);
    const head = headMatch[1];

    assert.match(head, /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s*>/);
    assert.match(head, /<link\s+rel="apple-touch-icon"\s+sizes="180x180"\s+href="\/icons\/apple-touch-icon\.png"\s*>/);
    assert.match(head, /<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="\/icons\/icon\.svg"\s*>/);
    assert.match(head, /<link\s+rel="icon"\s+type="image\/png"\s+sizes="32x32"\s+href="\/icons\/favicon-32\.png"\s*>/);
    assert.match(head, /<link\s+rel="icon"\s+type="image\/png"\s+sizes="16x16"\s+href="\/icons\/favicon-16\.png"\s*>/);
    assert.match(head, /<meta\s+name="theme-color"\s+content="#[0-9A-Fa-f]{6}"\s+media="\(prefers-color-scheme:\s*light\)"\s*>/);
    assert.match(head, /<meta\s+name="theme-color"\s+content="#[0-9A-Fa-f]{6}"\s+media="\(prefers-color-scheme:\s*dark\)"\s*>/);
    assert.match(head, /<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"\s*>/);
    assert.match(head, /<meta\s+name="mobile-web-app-capable"\s+content="yes"\s*>/);
    assert.match(head, /<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="default"\s*>/);
    assert.match(head, /<meta\s+name="apple-mobile-web-app-title"\s+content="薄肌日课"\s*>/);
    if (cover) {
      assert.match(head, /<meta\s+name="viewport"\s+content="[^"]*viewport-fit=cover[^"]*"\s*>/);
      assert.match(head, /env\(safe-area-inset-bottom/);
    }
  }
  const appHead = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').match(/<head>([\s\S]*?)<\/head>/i)[1];
  assert.match(appHead, /#app\{[^}]*calc\(96px \+ env\(safe-area-inset-bottom,0px\)\)/);
  assert.match(appHead, /\.tabs\{[^}]*padding-bottom:env\(safe-area-inset-bottom,0px\)/);
  assert.match(appHead, /\.toast\{[^}]*bottom:calc\(84px \+ env\(safe-area-inset-bottom,0px\)\)/);
});

test('server serves manifest.webmanifest and icons with proper Content-Type, Cache-Control, and CSP headers', async t => {
  const { base } = await startTestServer(t);

  const mfRes = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(mfRes.status, 200);
  assert.equal(mfRes.headers.get('content-type'), 'application/manifest+json');
  assert.equal(mfRes.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(mfRes.headers.get('x-content-type-options'), 'nosniff');
  const csp = mfRes.headers.get('content-security-policy');
  assert.match(csp, /(?:manifest-src|default-src)\s+'self'/);
  assert.match(csp, /img-src\s+'self'/);
  const mf = await mfRes.json();
  assert.equal(mf.name, 'Lean Ritual · 薄肌日课');
  assert.equal(mf.display, 'standalone');

  for (const [route, expectedType] of [
    ['/icons/apple-touch-icon.png', 'image/png'],
    ['/icons/icon-192.png', 'image/png'],
    ['/icons/icon-512.png', 'image/png'],
    ['/icons/icon-maskable-512.png', 'image/png'],
    ['/icons/favicon-32.png', 'image/png'],
    ['/icons/favicon-16.png', 'image/png'],
    ['/icons/icon.svg', 'image/svg+xml']
  ]) {
    const r = await fetch(`${base}${route}`);
    assert.equal(r.status, 200, `GET ${route} failed`);
    assert.equal(r.headers.get('content-type'), expectedType);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=86400');
    assert.ok((await r.arrayBuffer()).byteLength > 0);
  }
});

test('headless Chromium detects web app manifest and loads icons across all pages with zero CSP violations', async t => {
  const pw = resolvePlaywright();
  if (!pw) {
    t.skip('Playwright/Chromium not installed in this environment');
    return;
  }

  const srv = await startTestServer(t);
  const authEnv = { ...srv.env, AUTH_BASE_URL: srv.base };
  const issued = spawnSync(process.execPath, ['scripts/auth-admin.js', 'invite', 'pwa@example.com'], {
    cwd: ROOT, env: authEnv, encoding: 'utf8', timeout: 5000
  });
  assert.equal(issued.status, 0, issued.stderr);
  const invite = JSON.parse(issued.stdout);

  const browser = await pw.chromium.launch({
    executablePath: pw.executablePath,
    headless: true,
    args: ['--no-sandbox']
  });
  t.after(async () => { await browser.close(); });

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const cspViolations = [];
  const consoleErrors = [];
  const pageErrors = [];

  await page.exposeFunction('recordPwaCSP', v => cspViolations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', e => {
      window.recordPwaCSP(`${e.violatedDirective}: ${e.blockedURI}`);
    });
  });
  page.on('console', m => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', e => pageErrors.push(e.message));

  async function assertManifestAndHeadOnPage(expectedPath) {
    assert.equal(new URL(page.url()).pathname, expectedPath);
    const cdp = await context.newCDPSession(page);
    const appManifest = await cdp.send('Page.getAppManifest');
    await cdp.detach();
    assert.equal(appManifest.url, `${srv.base}/manifest.webmanifest`);
    assert.deepEqual(appManifest.errors, []);
    assert.equal(JSON.parse(appManifest.data).short_name, '薄肌日课');

    const check = await page.evaluate(async () => {
      const link = document.head.querySelector('link[rel="manifest"]');
      if (!link) return { ok: false, reason: 'missing link[rel=manifest] in document.head' };
      const res = await fetch(link.href);
      const manifest = await res.json();
      const loadImg = src => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ src, w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error('failed to load ' + src));
        img.src = src;
      });
      const touchHref = document.head.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href');
      const loaded = await Promise.all([
        ...manifest.icons.map(i => loadImg(i.src)),
        loadImg(touchHref)
      ]);
      const swRegs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
      return {
        ok: true,
        contentType: res.headers.get('content-type'),
        manifest,
        loaded,
        swCount: swRegs.length,
        lightTheme: document.head.querySelector('meta[name="theme-color"][media*="light"]')?.content,
        darkTheme: document.head.querySelector('meta[name="theme-color"][media*="dark"]')?.content,
        capable: document.head.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content
      };
    });
    assert.equal(check.ok, true, check.reason);
    assert.equal(check.contentType, 'application/manifest+json');
    assert.equal(check.manifest.name, 'Lean Ritual · 薄肌日课');
    assert.equal(check.manifest.display, 'standalone');
    assert.equal(check.swCount, 0);
    assert.match(check.lightTheme, /^#[0-9A-Fa-f]{6}$/);
    assert.match(check.darkTheme, /^#[0-9A-Fa-f]{6}$/);
    assert.equal(check.capable, 'yes');
    assert.deepEqual(check.loaded, [
      { src: '/icons/icon-192.png', w: 192, h: 192 },
      { src: '/icons/icon-512.png', w: 512, h: 512 },
      { src: '/icons/icon-maskable-512.png', w: 512, h: 512 },
      { src: '/icons/apple-touch-icon.png', w: 180, h: 180 }
    ]);
  }

  for (const route of ['/login.html', '/privacy.html', '/terms.html', '/guide.html']) {
    await page.goto(`${srv.base}${route}`);
    await assertManifestAndHeadOnPage(route);
  }

  // Register, verify, and log in so we also verify authenticated / (public/index.html).
  const pwStr = 'pwa-install-strong-password';
  await page.goto(`${srv.base}/login.html?invite=${encodeURIComponent(invite.token)}&email=${encodeURIComponent(invite.email)}`);
  await page.locator('#n').fill('PWA Tester');
  await page.locator('#p').fill(pwStr);
  await page.locator('#c-terms').check();
  await page.locator('#c-sensitive').check();
  await page.locator('#go').click();
  await page.getByText('请查收验证邮件，验证后再登录。', { exact: true }).waitFor();
  const mail = fs.readdirSync(path.join(srv.dir, 'mail'))
    .map(f => JSON.parse(fs.readFileSync(path.join(srv.dir, 'mail', f), 'utf8')))
    .find(m => m.kind === 'verify');
  const verifyUrl = new URL(mail.url);
  await page.goto(`${srv.base}${verifyUrl.pathname}${verifyUrl.search}`);
  await page.getByText('邮箱已验证，请登录。', { exact: true }).waitFor();
  await page.locator('#e').fill(invite.email);
  await page.locator('#p').fill(pwStr);
  await page.locator('#go').click();
  await page.locator('#setup').waitFor();
  await assertManifestAndHeadOnPage('/');

  assert.deepEqual(cspViolations, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
});
