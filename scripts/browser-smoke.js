'use strict';
// Reusable local E2E journey & browser smoke suite (mobile + desktop).
// Requires Playwright and a Chromium executable; uses only disposable local data on 127.0.0.1.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');

function committedDoc(response, matchesPath) {
  const request = response.request();
  if (new URL(response.url()).pathname !== '/api/doc-commit' || request.method() !== 'POST') return false;
  return request.postDataJSON().changes.some(change => change.after && matchesPath(change.path));
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

function readMails(dir) {
  const mailDir = path.join(dir, 'mail');
  if (!fs.existsSync(mailDir)) return [];
  return fs.readdirSync(mailDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(mailDir, f), 'utf8')));
}

async function startLocalServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-browser-'));
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
    OPENROUTER_API_KEY: '',
    ...extraEnv
  };
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  server.stderr.on('data', d => { stderr += d.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('startup timeout ' + stderr)), 8000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', reject);
    server.once('exit', () => { clearTimeout(timer); reject(new Error(stderr)); });
  });
  const invite = email => {
    const issued = spawnSync(process.execPath, ['scripts/auth-admin.js', 'invite', email], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 5000
    });
    if (issued.error) throw issued.error;
    assert.equal(issued.status, 0, issued.stderr);
    return JSON.parse(issued.stdout);
  };
  const stop = async () => {
    if (server.exitCode === null) {
      const stopped = new Promise(r => server.once('exit', r));
      server.kill();
      await stopped;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, base, env, invite, stop };
}

async function attachGuards(page, base, label) {
  const state = { pageErrors: [], consoleErrors: [], cspViolations: [], external: [], allowConsoleNetErr: false, allowOcrWasmStderr: false };
  await page.exposeFunction('recordCSP', value => state.cspViolations.push(`[${label}] ${value}`));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => window.recordCSP(e.violatedDirective + ': ' + e.blockedURI)));
  page.on('pageerror', e => state.pageErrors.push(`[${label}] ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Content Security Policy|Refused to|unsafe-eval/i.test(text)) {
      state.cspViolations.push(`[${label}] ${text}`);
      return;
    }
    if (m.location()?.url?.endsWith('/favicon.ico') && /status of 404/.test(text)) return;
    if (state.allowConsoleNetErr && (/Failed to load resource/.test(text) || /连不上服务器|Cannot reach server/.test(text))) return;
    if (state.allowOcrWasmStderr && (/^Warning: Parameter not found:|^Estimating resolution as /.test(text))) return;
    state.consoleErrors.push(`[${label}] ${text}`);
  });
  page.on('request', r => {
    if (/^https?:/.test(r.url()) && !r.url().startsWith(base)) state.external.push(r.url());
  });
  return state;
}

async function screenshotOnFailure(page, name) {
  const dir = process.env.SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-fail-shot-'));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${name}.png`);
  await page.screenshot({ path: target, fullPage: true }).catch(() => {});
  console.error(`Failure screenshot saved: ${target}`);
}

async function runFullStandaloneJourney(browser, label, viewport, jpegFixture) {
  const srv = await startLocalServer({ OPENROUTER_API_KEY: '' });
  const context = await browser.newContext({ viewport, locale: 'zh-CN', acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const guards = await attachGuards(page, srv.base, label);

  try {
    const email = `journey-${label}@example.com`;
    const pw1 = 'ritual-strong-pass-1234';
    const pw2 = 'ritual-strong-pass-5678';
    const pw3 = 'ritual-strong-pass-9012';

    // 1. Invite -> register -> verify email -> login
    const inv = srv.invite(email);
    await page.goto(inv.url);
    assert.equal(await page.locator('#e').inputValue(), email);
    await page.locator('#n').fill('小李 & "测试"');
    await page.locator('#p').fill(pw1);
    await page.locator('#go').click();
    await page.getByText('请查收验证邮件，验证后再登录。', { exact: true }).waitFor();

    const verifyMail = readMails(srv.dir).find(m => m.kind === 'verify' && m.to === email);
    assert.ok(verifyMail);
    await page.goto(verifyMail.url);
    await page.waitForURL(u => u.pathname === '/login.html');

    // Offline login shows Chinese message instead of raw TypeError
    guards.allowConsoleNetErr = true;
    await context.setOffline(true);
    await page.locator('#e').fill(email);
    await page.locator('#p').fill(pw1);
    await page.locator('#go').click();
    await page.getByText('连不上服务器。', { exact: true }).waitFor();
    await context.setOffline(false);
    guards.allowConsoleNetErr = false;

    await page.locator('#go').click();
    await page.locator('#setup').waitFor({ state: 'visible' });

    // 2. Onboarding/profile setup -> save -> reload persists
    await page.locator('#f-age').fill('28');
    await page.locator('#f-height').fill('176');
    await page.locator('#f-weight').fill('72.5');
    await page.locator('#f-bf').fill('15');
    const dow = new Date().getDay();
    const cb = page.locator(`#setup input[name="trainDays"][value="${dow}"]`);
    if (!(await cb.isChecked())) await cb.locator('..').click();

    const profileSaved = page.waitForResponse(r => committedDoc(r, path => path.endsWith('/app/profile')));
    await page.getByRole('button', { name: '生成我的计划', exact: true }).click();
    await profileSaved;
    await page.locator('#tabs').waitFor({ state: 'visible' });
    await page.reload();
    await page.locator('#tabs').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#setup').count(), 0);

    // 3. Today tab: record check-in (weight, sleep) -> reload persists
    await page.locator('#c-weight').fill('72.1');
    await page.locator('#c-sleep').fill('7.5');
    const checkinSaved = page.waitForResponse(r => committedDoc(r, path => path.includes('/days/')));
    await page.locator('[data-act="save-checkin"]').click();
    await checkinSaved;
    await page.getByText('已记录', { exact: true }).waitFor();
    await page.reload();
    await page.locator('#tabs').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#c-weight').inputValue(), '72.1');
    assert.equal(await page.locator('#c-sleep').inputValue(), '7.5');

    // 4. Meals: manual meal with macros + meal with JPEG photo (AI disabled) -> reload persists, photo displays
    await page.locator('#tabs [data-act="tab"][data-v="food"]').click();
    assert.equal(await page.locator('[data-act="mmode"][data-v="ai"]').isDisabled(), true);
    await page.locator('#m-text').fill('鸡胸肉配米饭');
    await page.locator('#mf-kcal').fill('550');
    await page.locator('#mf-protein').fill('45');
    await page.locator('#mf-carbs').fill('65');
    await page.locator('#mf-fat').fill('10');
    await page.locator('[data-act="add-meal"]').click();
    await page.getByText('鸡胸肉配米饭', { exact: true }).waitFor();

    await page.locator('#m-photo').setInputFiles({ name: 'meal.jpg', mimeType: 'image/jpeg', buffer: jpegFixture });
    await page.locator('.previews img.preview').waitFor({ state: 'visible' });
    await page.locator('#m-text').fill('牛肉面配卤蛋');
    await page.locator('#mf-kcal').fill('680');
    await page.locator('#mf-protein').fill('38');
    await page.locator('[data-act="add-meal"]').click();
    await page.getByText('牛肉面配卤蛋', { exact: true }).waitFor();

    await page.reload();
    await page.locator('#tabs').waitFor({ state: 'visible' });
    const photoMeal = page.locator('.meal').filter({ hasText: '牛肉面配卤蛋' });
    await photoMeal.waitFor({ state: 'visible' });
    const imgInfo = await photoMeal.locator('img.ph').evaluate(async el => {
      if (!el.complete) await new Promise((res, rej) => { el.onload = res; el.onerror = rej; });
      return { naturalWidth: el.naturalWidth, src: el.getAttribute('src') };
    });
    assert.ok(imgInfo.naturalWidth > 0);
    assert.match(imgInfo.src, /^\/_blob\/[0-9a-f]{32}$/);

    // 5. Workout: enter sets for two exercises -> draft autosync -> reload restores draft -> save -> log shows it
    await page.locator('#tabs [data-act="tab"][data-v="today"]').click();
    await page.locator('#w-0-0-w').fill('60');
    await page.locator('#w-0-0-r').fill('6');
    await page.locator('#w-1-0-w').fill('70');
    await page.locator('#w-1-0-r').fill('5');
    const draftSynced = await page.waitForResponse(
      r => committedDoc(r, path => path.includes('/days/')),
      { timeout: 6000 }
    );
    assert.equal(draftSynced.status(), 200);

    await page.reload();
    await page.locator('#tabs').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#w-0-0-w').inputValue(), '60');
    assert.equal(await page.locator('#w-0-0-r').inputValue(), '6');
    assert.equal(await page.locator('#w-1-0-w').inputValue(), '70');
    assert.equal(await page.locator('#w-1-0-r').inputValue(), '5');

    const workoutSaved = page.waitForResponse(r => committedDoc(r, path => path.includes('/days/')));
    await page.locator('[data-act="save-workout"]').click();
    await workoutSaved;
    await page.getByText('已完成', { exact: true }).waitFor();

    await page.locator('#tabs [data-act="tab"][data-v="log"]').click();
    await page.locator('section.card').filter({ hasText: '每日明细' }).getByText('推').waitFor({ state: 'visible' });
    await page.locator('section.card').filter({ hasText: '力量进步' }).getByText('60kg×6').waitFor({ state: 'visible' });

    // 6. Logout with nothing unsynced -> clears account-scoped localStorage -> login again -> data still there
    await page.locator('#tabs [data-act="tab"][data-v="me"]').click();
    let prompted = false;
    page.once('dialog', d => { prompted = true; d.accept(); });
    await page.locator('[data-act="logout"]').click();
    await page.waitForURL('**/login.html');
    assert.equal(prompted, false);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('bj-user:'))), false);

    await page.locator('#e').fill(email);
    await page.locator('#p').fill(pw1);
    await page.locator('#go').click();
    await page.locator('#tabs').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#c-weight').inputValue(), '72.1');
    await page.getByText('已完成', { exact: true }).waitFor();

    // 7. Password change; password reset via emailed link; old sessions invalidated
    const ctx2 = await browser.newContext({ viewport, locale: 'zh-CN' });
    const page2 = await ctx2.newPage();
    await page2.goto(srv.base + '/login.html');
    await page2.locator('#e').fill(email);
    await page2.locator('#p').fill(pw1);
    await page2.locator('#go').click();
    await page2.locator('#tabs').waitFor({ state: 'visible' });

    await page.locator('#tabs [data-act="tab"][data-v="me"]').click();
    await page.locator('[data-act="pw-edit"]').click();
    await page.locator('#pw-old').fill(pw1);
    await page.locator('#pw-new').fill(pw2);
    await page.locator('#pw-new2').fill(pw2);
    await page.locator('[data-act="pw-save"]').click();
    await page.getByText('密码已更新，其他设备需要重新登录', { exact: true }).waitFor();

    await page2.reload();
    await page2.waitForURL('**/login.html');

    await page2.locator('#e').fill(email);
    await page2.locator('#p').fill(pw2);
    await page2.locator('#go').click();
    await page2.locator('#tabs').waitFor({ state: 'visible' });

    await page.locator('[data-act="logout"]').click();
    await page.waitForURL('**/login.html');
    await page.locator('#forgot').click();
    await page.locator('#e').fill(email);
    await page.locator('#go').click();
    await page.getByText('如果邮箱符合条件，邮件会发送到你的邮箱。请检查垃圾邮件。', { exact: true }).waitFor();

    const resetMail = readMails(srv.dir).filter(m => m.kind === 'reset' && m.to === email).at(-1);
    assert.ok(resetMail);
    await page.goto(resetMail.url);
    await page.waitForURL(u => u.pathname === '/login.html' && u.searchParams.has('token'));
    await page.locator('#p').fill(pw3);
    await page.locator('#go').click();
    await page.getByText('密码已更新，请重新登录。', { exact: true }).waitFor();

    await page2.reload();
    await page2.waitForURL('**/login.html');
    await ctx2.close();

    await page.locator('#e').fill(email);
    await page.locator('#p').fill(pw3);
    await page.locator('#go').click();
    await page.locator('#tabs').waitFor({ state: 'visible' });

    // 9. Edge cases: special chars, long Chinese notes, rapid repeated saves, offline toggle during save
    await page.locator('#tabs [data-act="tab"][data-v="today"]').click();
    const special = `特殊字符 & <script>alert("xss")</script> "双引号" '单引号'`;
    const longChinese = '这是一段很长的中文训练备注，用来测试长文本显示与保存。'.repeat(50) + ' ' + special;
    await page.locator('#w-note').fill(longChinese);
    await page.locator('[data-act="pain"][data-v="pain"]').click();
    const painSpecial = `右肩 & <img src=x onerror=alert(1)> "痛" '测'`;
    await page.locator('#w-painarea').fill(painSpecial);
    const noteSaved = page.waitForResponse(r => committedDoc(r, path => path.includes('/days/')));
    await page.locator('[data-act="save-workout"]').click();
    await noteSaved;

    // Rapid repeated check-in saves + rapid double-click on photo meal (no 429, no clobbered input)
    let status429 = 0;
    const onResp = r => { if (r.status() === 429) status429++; };
    page.on('response', onResp);
    for (let i = 0; i < 10; i++) {
      await page.locator('#c-steps').fill(String(9000 + i));
      await page.locator('[data-act="save-checkin"]').click();
    }
    await page.waitForTimeout(800);
    assert.equal(await page.locator('#c-steps').inputValue(), '9009');

    await page.locator('#tabs [data-act="tab"][data-v="food"]').click();
    await page.locator('#m-photo').setInputFiles({ name: 'rapid.jpg', mimeType: 'image/jpeg', buffer: jpegFixture });
    await page.locator('.previews img.preview').waitFor({ state: 'visible' });
    const mealSpecial = `燕麦 & 牛奶 <b>加餐</b> "无糖" '热'`;
    await page.locator('#m-text').fill(mealSpecial);
    await page.locator('#mf-kcal').fill('260');
    await page.evaluate(() => {
      const btn = document.querySelector('[data-act="add-meal"]');
      btn.click();
      btn.click();
    });
    await page.getByText(mealSpecial, { exact: true }).waitFor();
    page.off('response', onResp);
    assert.equal(status429, 0);
    assert.equal(await page.locator('.meal').filter({ hasText: '燕麦 & 牛奶' }).count(), 1);

    // Offline toggle during save (check-in + photo meal), then back online -> zero data loss
    guards.allowConsoleNetErr = true;
    await page.locator('#tabs [data-act="tab"][data-v="today"]').click();
    await page.locator('#c-weight').fill('71.9');
    await context.setOffline(true);
    const offlineCheckin = page.locator('[data-act="save-checkin"]').click();
    await page.waitForTimeout(1100);
    await context.setOffline(false);
    await offlineCheckin;
    await page.getByText('打卡已保存', { exact: true }).waitFor({ timeout: 10000 });

    await page.locator('#tabs [data-act="tab"][data-v="food"]').click();
    await page.locator('#m-photo').setInputFiles({ name: 'offline.jpg', mimeType: 'image/jpeg', buffer: jpegFixture });
    await page.locator('.previews img.preview').waitFor({ state: 'visible' });
    await page.locator('#m-text').fill('断网恢复餐');
    await page.locator('#mf-kcal').fill('410');
    await context.setOffline(true);
    await page.locator('[data-act="add-meal"]').click();
    await page.waitForTimeout(1100);
    await context.setOffline(false);
    await page.getByText('断网恢复餐', { exact: true }).waitFor({ timeout: 12000 });

    // Commit-then-response-loss on POST /api/assets: server commits blob, response drops, client retry reuses Idempotency-Key without creating an orphan copy.
    const blobsBeforeLoss = fs.readdirSync(path.join(srv.dir, 'blobs')).length;
    let droppedCommittedResponse = false, firstIdemKey = null, retriedIdemKey = null;
    await page.route('**/api/assets', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const keyHeader = route.request().headers()['idempotency-key'];
      if (!droppedCommittedResponse) {
        droppedCommittedResponse = true;
        firstIdemKey = keyHeader;
        const upstream = await route.fetch();
        assert.equal(upstream.status(), 200);
        return route.abort('connectionreset');
      }
      retriedIdemKey = keyHeader;
      return route.continue();
    });
    await page.locator('#m-photo').setInputFiles({ name: 'idem.jpg', mimeType: 'image/jpeg', buffer: jpegFixture });
    await page.locator('.previews img.preview').waitFor({ state: 'visible' });
    await page.locator('#m-text').fill('幂等重传餐');
    await page.locator('#mf-kcal').fill('390');
    await page.locator('[data-act="add-meal"]').click();
    await page.getByText('幂等重传餐', { exact: true }).waitFor({ timeout: 10000 });
    await page.unroute('**/api/assets');
    guards.allowConsoleNetErr = false;
    assert.ok(firstIdemKey && firstIdemKey === retriedIdemKey);
    assert.equal(fs.readdirSync(path.join(srv.dir, 'blobs')).length, blobsBeforeLoss + 1);

    await page.reload();
    await page.locator('#tabs').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.meal p.small').filter({ hasText: '燕麦 &' }).textContent(), mealSpecial);
    assert.equal(await page.locator('.meal').filter({ hasText: '断网恢复餐' }).locator('img.ph[src^="/_blob/"]').count(), 1);
    await page.locator('#tabs [data-act="tab"][data-v="today"]').click();
    assert.equal(await page.locator('#c-weight').inputValue(), '71.9');
    assert.equal(await page.locator('#w-note').inputValue(), longChinese);
    await page.locator('#tabs [data-act="tab"][data-v="fb"]').click();
    assert.ok((await page.locator('.ins.bad p.small').textContent()).includes(painSpecial));

    // AI suggestion adoption scope chooser + today-only saved-record update + per-item undo + decline
    await page.evaluate(async () => {
      const fb = {
        id: 'fb_e2e',
        createdAt: new Date().toISOString(),
        summary: '肩部不适时建议把平板杠铃卧推换成哑铃卧推。',
        good: ['坚持记录'],
        issues: ['右肩不适'],
        adjustments: [
          { kind: 'swap', from: '平板杠铃卧推', to: '平板哑铃卧推', sets: 3, lo: 8, hi: 10, text: '减少肩前侧压力（做3组8–10次）' },
          { kind: 'kcal', delta: -120, text: '测试不采纳 <img src=x onerror=alert(1)>' }
        ],
        applied: []
      };
      await S.store.set('feedback/fb_e2e', fb);
      S.feedback = [fb];
      render();
    });
    await page.locator('[data-act="adopt-open"]').filter({ hasText: '采纳：平板杠铃卧推' }).click();
    await page.locator('.chooser').getByText('平板杠铃卧推 3×4–6 → 平板哑铃卧推 3×8–10').waitFor({ state: 'visible' });
    await page.locator('[data-act="adopt-confirm"]').filter({ hasText: '只改今天' }).click();
    await page.locator('[data-act="undo-adjust"]').filter({ hasText: '已采纳 · 撤销' }).waitFor({ state: 'visible' });

    // Saved workout updated in place with logged 70×5 preserved, and no long-term exEdit created
    await page.locator('#tabs [data-act="tab"][data-v="today"]').click();
    await page.locator('.ex-h b').filter({ hasText: '平板哑铃卧推' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#w-1-0-w').inputValue(), '70');
    assert.equal(await page.locator('#w-1-0-r').inputValue(), '5');
    await page.locator('#tabs [data-act="tab"][data-v="me"]').click();
    assert.equal(await page.locator('[data-act="del-exedit"]').count(), 0);

    // Undo from feedback chip restores saved workout to 平板杠铃卧推 and re-enables suggestion
    await page.locator('#tabs [data-act="tab"][data-v="fb"]').click();
    await page.locator('[data-act="undo-adjust"]').filter({ hasText: '已采纳 · 撤销' }).click();
    await page.locator('[data-act="adopt-open"]').filter({ hasText: '采纳：平板杠铃卧推' }).waitFor({ state: 'visible' });
    await page.locator('#tabs [data-act="tab"][data-v="today"]').click();
    await page.locator('.ex-h b').filter({ hasText: '平板杠铃卧推' }).waitFor({ state: 'visible' });

    // Long-term adoption with sets stores exEdit, individually revertible in 我的; decline persists across reload
    await page.locator('#tabs [data-act="tab"][data-v="fb"]').click();
    await page.locator('[data-act="adopt-open"]').filter({ hasText: '采纳：平板杠铃卧推' }).click();
    await page.locator('[data-act="adopt-confirm"]').filter({ hasText: '长期调整' }).click();
    await page.locator('[data-act="adopt-open"]').filter({ hasText: '采纳：每日 -120 kcal' }).click();
    await page.locator('[data-act="adopt-decline"]').click();
    await page.getByText('已不采纳', { exact: true }).waitFor({ state: 'visible' });
    await page.reload();
    await page.locator('#tabs').waitFor({ state: 'visible' });
    await page.getByText('已不采纳', { exact: true }).waitFor({ state: 'visible' });
    await page.locator('#tabs [data-act="tab"][data-v="me"]').click();
    await page.locator('[data-act="del-exedit"][data-v="平板杠铃卧推"]').waitFor({ state: 'visible' });
    await page.locator('[data-act="del-exedit"][data-v="平板杠铃卧推"]').click();
    await page.locator('[data-act="del-exedit"]').waitFor({ state: 'detached' });

    // 8. Export NDJSON -> account deletion with password -> cannot log in again
    await page.locator('#tabs [data-act="tab"][data-v="me"]').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: '导出我的记录和照片', exact: true }).click()
    ]);
    const exported = fs.readFileSync(await download.path(), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(exported.some(x => x.kind === 'account' && x.user.email === email));
    assert.ok(exported.some(x => x.kind === 'document' && x.path.endsWith('/app/profile')));
    assert.ok(exported.some(x => x.kind === 'document' && x.data?.workout?.done));
    assert.ok(exported.some(x => x.kind === 'photo' && x.dataBase64?.length > 20));

    await page.getByText('删除账号', { exact: true }).click();
    await page.locator('#delete-password').fill(pw3);
    await page.locator('#delete-confirm').check();
    await page.locator('[data-act="delete-account"]').click();
    await page.waitForURL('**/login.html?deleted=1');
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('bj-user:'))), false);

    guards.allowConsoleNetErr = true;
    await page.locator('#e').fill(email);
    await page.locator('#p').fill(pw3);
    await page.locator('#go').click();
    await page.waitForFunction(() => document.querySelector('#err')?.textContent.trim().length > 0);
    assert.ok(page.url().includes('/login.html'));
    guards.allowConsoleNetErr = false;

    assert.deepEqual(guards.cspViolations, []);
    assert.deepEqual(guards.pageErrors, []);
    assert.deepEqual(guards.consoleErrors, []);
    assert.deepEqual(guards.external, []);
    console.log(`PASS [${label}]: full standalone journey (invite, verify, login, onboarding, check-in, manual/photo meals, workout draft autosync + log, logout/relogin, password change + reset + session revocation, edge cases, export + account deletion)`);
  } catch (err) {
    await screenshotOnFailure(page, `journey-${label}`);
    throw err;
  } finally {
    await context.close();
    await srv.stop();
  }
}

async function runReadGuardOcrAndAiSmoke(browser) {
  const providerPort = await getFreePort();
  const providerRequests = [];
  const provider = http.createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    providerRequests.push(JSON.parse(Buffer.concat(parts).toString()));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ kcal: 321, protein: 20, carbs: 40, fat: 9, items: [], confidence: '中', tip: 'test estimate' }) } }]
    }));
  });
  await new Promise(r => provider.listen(providerPort, '127.0.0.1', r));
  const srv = await startLocalServer({
    OPENROUTER_API_KEY: 'local-test-provider-key',
    OPENROUTER_BASE: `http://127.0.0.1:${providerPort}/v1`
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const guards = await attachGuards(page, srv.base, 'ai-ocr-smoke');

  try {
    const invite = srv.invite('browser@example.com');
    await page.goto(invite.url);
    await page.locator('#n').fill('Browser tester');
    await page.locator('#p').fill('browser strong password');
    await page.locator('#go').click();
    await page.getByText('请查收验证邮件，验证后再登录。', { exact: true }).waitFor();
    const mail = readMails(srv.dir).find(m => m.kind === 'verify');
    await page.goto(mail.url);
    await page.locator('#e').fill(invite.email);
    await page.locator('#p').fill('browser strong password');
    await page.locator('#go').click();
    await page.locator('#setup').waitFor();
    await page.locator('#f-age').fill('30');
    await page.locator('#f-height').fill('175');
    await page.locator('#f-weight').fill('70');
    const profileSaved = page.waitForResponse(r => committedDoc(r, path => path.endsWith('/app/profile')));
    await page.getByRole('button', { name: '生成我的计划', exact: true }).click();
    await profileSaved;
    await page.locator('#tabs').waitFor({ state: 'visible' });
    await page.locator('#tabs [data-act="tab"][data-v="food"]').click();
    await page.locator('[data-act="mmode"][data-v="manual"]').click();
    await page.locator('#m-text').fill('Browser smoke test meal');
    await page.locator('#mf-kcal').fill('300');
    await page.locator('[data-act="add-meal"]').click();
    await page.getByText('Browser smoke test meal', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('Browser smoke test meal', { exact: true }).waitFor();

    // A failed profile read must not look like a new account or allow overwrites.
    guards.allowConsoleNetErr = true;
    await page.route('**/api/doc?*', route => {
      const documentPath = new URL(route.request().url()).searchParams.get('path');
      return documentPath?.endsWith('/app/profile') ? route.abort() : route.continue();
    });
    await page.reload();
    // shim.js retries safe GETs across [500, 1000, 2000, 4000, 8000]ms (15.5s total) before failing closed.
    await page.getByRole('button', { name: '重新加载', exact: true }).waitFor({ timeout: 25000 });
    assert.equal(await page.locator('#setup').count(), 0);
    assert.equal(await page.locator('#tabs').isVisible(), false);
    await page.unroute('**/api/doc?*');
    guards.allowConsoleNetErr = false;
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await page.getByText('Browser smoke test meal', { exact: true }).waitFor();
    assert.equal(await page.locator('#setup').count(), 0);

    // Load OCR entirely from our origin and recognize a generated nutrition label.
    guards.allowOcrWasmStderr = true;
    const ocr = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 900;
      canvas.height = 200;
      const c = canvas.getContext('2d');
      c.fillStyle = 'white';
      c.fillRect(0, 0, 900, 200);
      c.fillStyle = 'black';
      c.font = '48px sans-serif';
      c.fillText('ENERGY 300 kcal', 30, 100);
      const blob = await new Promise(r => canvas.toBlob(r));
      return Promise.race([ocrImage(blob), new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timeout')), 45000))]);
    });
    guards.allowOcrWasmStderr = false;
    assert.match(ocr, /300/);

    await page.locator('[data-act="mmode"][data-v="ai"]').click();
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 20;
      c.height = 20;
      c.getContext('2d').fillRect(0, 0, 20, 20);
      return c.toDataURL().split(',')[1];
    });
    await page.locator('#m-photo').setInputFiles({ name: 'meal.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.locator('#m-text').fill('Mock AI photo meal');
    await page.locator('[data-act="add-meal"]').click();
    await page.waitForFunction(() => Object.values(S.days).some(d => d.meals?.some(m => m.text === 'Mock AI photo meal' && m.est?.kcal === 321)));
    assert.equal(providerRequests.length, 1);
    assert.ok(providerRequests[0].messages.at(-1).content.some(c => c.type === 'image_url'));
    await page.reload();
    await page.getByText('Mock AI photo meal', { exact: true }).waitFor();

    if (process.env.HEIC_FIXTURE) {
      const converted = await page.evaluate(async base64 => {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const result = await compress2(new File([bytes], 'fixture.heic', { type: 'image/heic' }));
        return { ok: result.ok, type: result.blob?.type, size: result.blob?.size };
      }, fs.readFileSync(process.env.HEIC_FIXTURE).toString('base64'));
      assert.equal(converted.ok, true);
      assert.equal(converted.type, 'image/jpeg');
      assert.ok(converted.size > 0);
      console.log('PASS: real HEIC fixture converts to JPEG using the local library');
    }

    assert.deepEqual(guards.cspViolations, []);
    assert.deepEqual(guards.pageErrors, []);
    assert.deepEqual(guards.consoleErrors, []);
    assert.deepEqual(guards.external, []);
    console.log('PASS [ai-ocr-smoke]: failed profile read guard, local OCR, and mocked backend photo AI');
  } catch (err) {
    await screenshotOnFailure(page, 'ai-ocr-smoke');
    throw err;
  } finally {
    await context.close();
    await srv.stop();
    await new Promise(r => provider.close(r));
  }
}

async function assertZeroChineseVisible(page, where) {
  const leaks = await page.evaluate(() => {
    const cjk = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('[data-lang="zh"], [data-act="lang"][data-v="zh"], script, style, datalist').forEach(n => n.remove());
    const out = [];
    const txt = (clone.innerText || clone.textContent || '').trim();
    for (const token of txt.split(/\s+/)) {
      if (cjk.test(token)) out.push('text:' + token);
    }
    return out;
  });
  assert.deepEqual(leaks, [], `Unexpected Chinese UI text on ${where}: ${leaks.join(', ')}`);
}

async function runEnglishJourney(browser, jpegFixture) {
  const srv = await startLocalServer({ OPENROUTER_API_KEY: '' });
  const viewport = { width: 390, height: 844 };
  const context = await browser.newContext({ viewport, locale: 'en-US', acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const guards = await attachGuards(page, srv.base, 'mobile-en');

  try {
    const email = 'journey-en@example.com';
    const pw = 'english-strong-pass-1234';

    // 1. Default en-US locale opens login.html in English; manual switch & ?lang= override work
    await page.goto(srv.base + '/login.html');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.locator('#go').textContent(), 'Sign in');
    await assertZeroChineseVisible(page, 'login.html (default en-US)');

    await page.locator('#lang-switch [data-lang="zh"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
    assert.equal(await page.locator('#go').textContent(), '登录');

    await page.goto(srv.base + '/login.html?lang=en');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.evaluate(() => localStorage.getItem('bj-lang')), 'en');

    // 2. Invite -> register -> verify -> wrong password error -> sign in (all in English)
    const inv = srv.invite(email);
    await page.goto(inv.url);
    await page.locator('#n').fill('Alex Mercer');
    await page.locator('#p').fill(pw);
    await page.locator('#go').click();
    await page.getByText('Check your email and verify your address before signing in.', { exact: true }).waitFor();

    const verifyMail = readMails(srv.dir).find(m => m.kind === 'verify' && m.to === email);
    assert.ok(verifyMail);
    await page.goto(verifyMail.url);
    await page.getByText('Email verified. Please sign in.', { exact: true }).waitFor();

    guards.allowConsoleNetErr = true;
    await page.locator('#e').fill(email);
    await page.locator('#p').fill('wrong-password-999');
    await page.locator('#go').click();
    await page.getByText('Incorrect email or password.', { exact: true }).waitFor();
    guards.allowConsoleNetErr = false;

    await page.locator('#p').fill(pw);
    await page.locator('#go').click();
    await page.locator('#setup').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    await assertZeroChineseVisible(page, 'setup (en)');

    // 3. Complete onboarding -> profile.lang persisted as 'en'
    await page.locator('#f-age').fill('29');
    await page.locator('#f-height').fill('178');
    await page.locator('#f-weight').fill('73.0');
    const dow = new Date().getDay();
    const cb = page.locator(`#setup input[name="trainDays"][value="${dow}"]`);
    if (!(await cb.isChecked())) await cb.locator('..').click();

    const profileSaved = page.waitForResponse(r => committedDoc(r, p => p.endsWith('/app/profile')));
    await page.getByRole('button', { name: 'Build my plan', exact: true }).click();
    await profileSaved;
    await page.locator('nav#tabs').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => S.profile?.lang), 'en');

    // 4. Today tab: English date format, check-in, workout logging with canonical stored keys
    const dateText = await page.locator('.datebar .d').textContent();
    assert.match(dateText, /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d+$/);
    await assertZeroChineseVisible(page, 'Today tab');

    await page.locator('#c-weight').fill('72.8');
    await page.locator('#c-sleep').fill('7.8');
    const checkinSaved = page.waitForResponse(r => committedDoc(r, p => p.includes('/days/')));
    await page.locator('[data-act="save-checkin"]').click();
    await checkinSaved;
    await page.getByText('Logged', { exact: true }).waitFor();

    await page.locator('#w-0-0-w').fill('60');
    await page.locator('#w-0-0-r').fill('6');
    const workoutSaved = page.waitForResponse(r => committedDoc(r, p => p.includes('/days/')));
    await page.locator('[data-act="save-workout"]').click();
    await workoutSaved;
    await page.getByText('Completed', { exact: true }).waitFor();

    const storedExName = await page.evaluate(() => S.days[S.date]?.workout?.exercises?.[0]?.name);
    assert.equal(storedExName, '上斜杠铃卧推');

    // 5. Meals, Log, Feedback, and Me tabs render cleanly in English with zero Chinese UI strings
    await page.locator('#tabs [data-act="tab"][data-v="food"]').click();
    await page.locator('#m-photo').setInputFiles({ name: 'en-meal.jpg', mimeType: 'image/jpeg', buffer: jpegFixture });
    await page.locator('.previews img.preview').waitFor({ state: 'visible' });
    await page.locator('#m-text').fill('Grilled salmon & rice');
    await page.locator('#mf-kcal').fill('620');
    await page.locator('#mf-protein').fill('46');
    await page.locator('[data-act="add-meal"]').click();
    await page.getByText('Grilled salmon & rice', { exact: true }).waitFor();
    await assertZeroChineseVisible(page, 'Meals tab');

    for (const tab of ['log', 'fb', 'me']) {
      await page.locator(`#tabs [data-act="tab"][data-v="${tab}"]`).click();
      await assertZeroChineseVisible(page, `${tab} tab`);
    }

    // 6. Cross-device profile.lang override (when no explicit choice was made) AND explicit login-page switch / ?lang= handoff
    const ctxZh = await browser.newContext({ viewport, locale: 'zh-CN' });
    const pageZh = await ctxZh.newPage();
    const guardsZh = await attachGuards(pageZh, srv.base, 'cross-device-lang');
    try {
      // 6a. Stale bj-lang without explicit choice in this session -> profile.lang ('en') wins
      await pageZh.goto(srv.base + '/login.html');
      assert.equal(await pageZh.evaluate(() => document.documentElement.lang), 'zh-CN');
      await pageZh.evaluate(() => localStorage.setItem('bj-lang', 'zh'));
      await pageZh.locator('#e').fill(email);
      await pageZh.locator('#p').fill(pw);
      await pageZh.locator('#go').click();
      await pageZh.locator('nav#tabs').waitFor({ state: 'visible' });
      assert.equal(await pageZh.evaluate(() => document.documentElement.lang), 'en');
      assert.equal(await pageZh.evaluate(() => localStorage.getItem('bj-lang')), 'en');
      await assertZeroChineseVisible(pageZh, 'cross-device Me/Today after login');

      // 6b. Switch to 中文 in Me -> updates profile.lang to 'zh', then sign out
      await pageZh.locator('nav#tabs [data-act="tab"][data-v="me"]').click();
      const langSaved = pageZh.waitForResponse(r => committedDoc(r, p => p.endsWith('/app/profile')));
      await pageZh.locator('[data-act="lang"][data-v="zh"]').click();
      await langSaved;
      assert.equal(await pageZh.evaluate(() => document.documentElement.lang), 'zh-CN');
      assert.equal(await pageZh.evaluate(() => S.profile?.lang), 'zh');
      await pageZh.locator('[data-act="logout"]').click();
      await pageZh.waitForURL('**/login.html');

      // 6c. Explicit login-page switch to English when profile.lang='zh' -> stays 'en' after login and updates profile.lang='en' without clobbering weight
      await pageZh.locator('#lang-switch [data-lang="en"]').click();
      assert.equal(await pageZh.evaluate(() => document.documentElement.lang), 'en');
      await pageZh.locator('#e').fill(email);
      await pageZh.locator('#p').fill(pw);
      await pageZh.locator('#go').click();
      await pageZh.locator('nav#tabs').waitFor({ state: 'visible' });
      assert.equal(await pageZh.evaluate(() => document.documentElement.lang), 'en');
      assert.deepEqual(await pageZh.evaluate(() => ({ lang: S.profile?.lang, weight: S.profile?.weight })), { lang: 'en', weight: 73 });
      await assertZeroChineseVisible(pageZh, 'after explicit login-page switch to English');

      // 6d. ?lang=zh on login.html when profile.lang='en' -> stays 'zh' after login and updates profile.lang='zh'
      await pageZh.locator('nav#tabs [data-act="tab"][data-v="me"]').click();
      await pageZh.locator('[data-act="logout"]').click();
      await pageZh.waitForURL('**/login.html');
      await pageZh.goto(srv.base + '/login.html?lang=zh');
      await pageZh.locator('#e').fill(email);
      await pageZh.locator('#p').fill(pw);
      await pageZh.locator('#go').click();
      await pageZh.locator('nav#tabs').waitFor({ state: 'visible' });
      assert.equal(await pageZh.evaluate(() => document.documentElement.lang), 'zh-CN');
      assert.deepEqual(await pageZh.evaluate(() => ({ lang: S.profile?.lang, weight: S.profile?.weight })), { lang: 'zh', weight: 73 });

      assert.deepEqual(guardsZh.cspViolations, []);
      assert.deepEqual(guardsZh.pageErrors, []);
      assert.deepEqual(guardsZh.consoleErrors, []);
      assert.deepEqual(guardsZh.external, []);
    } finally {
      await ctxZh.close();
    }

    assert.deepEqual(guards.cspViolations, []);
    assert.deepEqual(guards.pageErrors, []);
    assert.deepEqual(guards.consoleErrors, []);
    assert.deepEqual(guards.external, []);
    console.log('PASS [mobile-en]: English locale detection, manual switch, ?lang= override, full onboarding/workout/meal journey, zero zh UI leaks, and cross-device profile.lang sync');
  } catch (err) {
    await screenshotOnFailure(page, 'journey-mobile-en');
    throw err;
  } finally {
    await context.close();
    await srv.stop();
  }
}

(async () => {
  const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ['--no-sandbox']
  });
  try {
    const jpegFixture = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 120, b: 60 } }
    }).jpeg({ quality: 85 }).toBuffer();
    await runFullStandaloneJourney(browser, 'mobile', { width: 390, height: 844 }, jpegFixture);
    await runFullStandaloneJourney(browser, 'desktop', { width: 1280, height: 800 }, jpegFixture);
    await runReadGuardOcrAndAiSmoke(browser);
    await runEnglishJourney(browser, jpegFixture);
  } finally {
    await browser.close();
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
