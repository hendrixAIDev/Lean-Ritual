'use strict';
// Phone rules shared by the server and the sign-in page (public/site/phone-rules.js): the
// country code dropdown, turning what people type at home into E.164, and lib/phone.js's
// normalizePhone, which stays the server's only judge of a number.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const phone = require('../lib/phone');
const P = require('../public/site/phone-rules.js');

let playwright = null;
try { playwright = require('playwright'); } catch { playwright = null; }

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:18100';
// One mobile example per region from libphonenumber, written the domestic way (tools/phone-rules/generate.js).
const { examples: EXAMPLES } = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/phone-examples.json'), 'utf8'));
const shown = iso => (iso === 'CA' ? 'US' : iso);   // Canada is listed under +1 with the United States

test('the server and the page share one rule: lib/phone.js uses normalizePhone from phone-rules.js', () => {
  assert.equal(phone.normalizePhone, P.normalizePhone);
  const lib = fs.readFileSync(path.join(ROOT, 'lib/phone.js'), 'utf8');
  assert.match(lib, /require\("\.\.\/public\/site\/phone-rules\.js"\)/);
  assert.doesNotMatch(lib, /E164_RE|MAINLAND/, 'no second copy of the rule');
  // The rule itself is unchanged.
  for (const [input, want] of [['13800138000', '+8613800138000'], ['+86 138-0013-8000', '+8613800138000'], ['008613800138000', '+8613800138000'], ['＋８６１３８００１３８０００', '+8613800138000'],
    ['+8612345678901', null], ['+86123', null], ['+1 415 555 2671', '+14155552671'], ['+123456', null], ['+1234567', '+1234567'], ['+1234567890123456', null], ['abc', null], ['', null], [null, null]])
    assert.equal(P.normalizePhone(input), want, String(input));
});

test('the list: the common regions first in the asked order, then every other region A-Z in the page language', () => {
  const zh = P.options('zh'), en = P.options('en');
  assert.deepEqual(zh.common.map(o => o.label), ['中国大陆 +86', '美国/加拿大 +1', '香港 +852', '澳门 +853', '台湾 +886', '新加坡 +65', '日本 +81', '韩国 +82', '英国 +44', '澳大利亚 +61']);
  assert.deepEqual(en.common.map(o => o.label), ['Mainland China +86', 'United States / Canada +1', 'Hong Kong +852', 'Macao +853', 'Taiwan +886', 'Singapore +65', 'Japan +81', 'South Korea +82', 'United Kingdom +44', 'Australia +61']);
  for (const [lang, list] of [['zh', zh], ['en', en]]) {
    const all = [...list.common, ...list.rest].map(o => o.iso);
    assert.equal(new Set(all).size, all.length, lang + ': each region once');
    assert.deepEqual([...all].sort(), P.regions().filter(iso => iso !== 'CA').sort(), lang + ': every region except Canada');
    const collator = new Intl.Collator(lang === 'en' ? 'en' : 'zh-CN');
    const names = list.rest.map(o => o.label.replace(/ \+\d+$/, ''));
    assert.deepEqual(names, [...names].sort(collator.compare), lang + ': alphabetical');
    for (const o of [...list.common, ...list.rest]) assert.equal(o.label, `${P.regionName(o.iso, lang)} +${P.callingCode(o.iso)}`);
  }
  assert.equal(en.rest.find(o => o.iso === 'JM').label, 'Jamaica +1');
  assert.ok(!en.rest.some(o => /[一-鿿]/.test(o.label)) && !zh.rest.some(o => /^[A-Z]{2} \+/.test(o.label)), 'names are in the page language');
});

test('defaults follow the page language: +86 in Chinese, +1 in English, with a domestic example for every region', () => {
  assert.equal(P.defaultFor('zh'), 'CN');
  assert.equal(P.defaultFor('en'), 'US');
  assert.equal(P.example('CN'), '138 0013 8000');
  assert.equal(P.example('US'), '415 555 2671');
  for (const iso of P.regions()) assert.ok(P.example(iso), iso + ' has an example');
});

// Codex review of PR #57: one libphonenumber example per region typed at home, 32 regions wrong before this table.
const CODEX_32 = [
  ['AS', '(684) 733-1234', '+16847331234'], ['AI', '(264) 235-1234', '+12642351234'], ['AG', '(268) 464-1234', '+12684641234'], ['AR', '011 15-2345-6789', '+5491123456789'],
  ['BS', '(242) 359-1234', '+12423591234'], ['BB', '(246) 250-1234', '+12462501234'], ['BY', '8 029 491-19-11', '+375294911911'], ['BJ', '01 95 12 34 56', '+2290195123456'],
  ['BM', '(441) 370-1234', '+14413701234'], ['VG', '(284) 300-1234', '+12843001234'], ['KY', '(345) 323-1234', '+13453231234'], ['CG', '06 123 4567', '+242061234567'],
  ['DM', '(767) 225-1234', '+17672251234'], ['DO', '(809) 234-5678', '+18092345678'], ['GA', '06 03 12 34', '+24106031234'], ['GD', '(473) 403-1234', '+14734031234'],
  ['GU', '(671) 300-1234', '+16713001234'], ['HU', '06 20 123 4567', '+36201234567'], ['JM', '(876) 210-1234', '+18762101234'], ['KZ', '8 (771) 000 9998', '+77710009998'],
  ['MS', '(664) 492-3456', '+16644923456'], ['MP', '(670) 234-5678', '+16702345678'], ['PR', '(787) 234-5678', '+17872345678'], ['RU', '8 (912) 345-67-89', '+79123456789'],
  ['SX', '(721) 520-5678', '+17215205678'], ['KN', '(869) 765-2917', '+18697652917'], ['LC', '(758) 284-5678', '+17582845678'], ['VC', '(784) 430-1234', '+17844301234'],
  ['TT', '(868) 291-1234', '+18682911234'], ['TM', '8 66 123456', '+99366123456'], ['TC', '(649) 231-1234', '+16492311234'], ['VI', '(340) 642-1234', '+13406421234']
];

test("Codex's 32 domestic formats become the E.164 that lib/phone.js accepts", () => {
  assert.equal(CODEX_32.length, 32);
  for (const [iso, typed, e164] of CODEX_32) {
    assert.equal(P.toE164(iso, typed), e164, `${iso} ${typed}`);
    assert.equal(phone.normalizePhone(e164), e164);
  }
});

test('every region: its domestic example, bare digits, dashes, and a NANP leading 1 all become the same E.164', () => {
  assert.ok(EXAMPLES.length >= 240);
  for (const { iso, national, e164 } of EXAMPLES) {
    const variants = [national, national.replace(/\D/g, ''), national.replace(/[ ()]+/g, '-'), ` ${national} `, national.replace(/\d/g, d => String.fromCharCode(d.charCodeAt(0) + 0xFEE0))];
    if (P.callingCode(iso) === '1') variants.push('1 ' + national, '1-' + national.replace(/\D/g, ''));
    for (const typed of variants) assert.equal(P.toE164(shown(iso), typed), e164, `${iso} "${typed}"`);
    assert.equal(phone.normalizePhone(e164), e164, `${iso}: the server accepts ${e164}`);
  }
});

test('an E.164 number splits into a listed region and digits that rebuild exactly that number (invites)', () => {
  // Regions that share their main region's numbering show the main region (libphonenumber's Cocos example is an
  // Australian mobile); the number itself is always rebuilt exactly.
  const SHARED = { AX: 'FI', BL: 'GP', CC: 'AU', CX: 'AU', EH: 'MA', GG: 'GB', IM: 'GB', JE: 'GB', MF: 'GP', SJ: 'NO', VA: 'IT', YT: 'RE' };
  for (const { iso, e164 } of EXAMPLES) {
    const parts = P.split(e164);
    assert.equal(parts.iso, SHARED[iso] || shown(iso), e164);
    assert.equal(P.toE164(parts.iso, parts.national), e164, `${iso} round trip`);
    assert.equal(P.split(e164, iso).iso, iso === 'CA' ? 'US' : iso, `${iso} stays chosen when it was already chosen`);
  }
  // Alternate NANP area codes stay as invited (Codex P1).
  for (const [e164, iso] of [['+18295551234', 'DO'], ['+18495551234', 'DO'], ['+16585551234', 'JM'], ['+19395551234', 'PR'], ['+16135550123', 'US']]) {
    const parts = P.split(e164);
    assert.equal(parts.iso, iso, e164);
    assert.equal(P.toE164(parts.iso, parts.national), e164);
  }
  assert.equal(P.split('+77011234567', 'KZ').iso, 'KZ', 'a shared code keeps the region already chosen');
  assert.equal(P.split('+79161234567').iso, 'RU');
  for (const notFull of ['13800138000', '', '+', 'abc', '+0123']) assert.equal(P.split(notFull), null, notFull);
});

test('a full +number or 00 number is sent in E.164 when valid, otherwise as typed for the server to refuse', () => {
  assert.equal(P.toE164('US', '+44 7400 123456'), '+447400123456');
  assert.equal(P.toE164('CN', '0044 7400 123456'), '+447400123456');
  assert.equal(P.toE164('US', '＋８６ １３８ ００１３ ８０００'), '+8613800138000');
  assert.equal(P.toE164('US', '+86 123'), '+86 123');
  assert.equal(P.toE164('CN', '8613800138000'), '+8613800138000', 'the calling code typed without +');
  assert.equal(P.toE164('CN', '   '), '', 'empty stays empty, so the field is still required');
});

test("invalid numbers are still the server's call: they reach lib/phone.js and are refused there", () => {
  for (const [iso, typed] of [['CN', '12345'], ['CN', '2800138000'], ['US', '12'], ['CN', '+86 123'], ['CN', 'abc']]) {
    const sent = P.toE164(iso, typed);
    assert.ok(sent.length > 0, 'the page does not swallow it');
    assert.equal(phone.normalizePhone(sent), null, `${iso} ${typed} -> ${sent}`);
  }
});

test('the phone metadata ships with its licences: MIT (libphonenumber-js) and Apache-2.0 (Google libphonenumber)', () => {
  const notices = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const version = P.source.match(/libphonenumber-js (\d+\.\d+\.\d+)/)[1];
  assert.ok(notices.includes('libphonenumber-js ' + version), 'the notices name the version the table came from');
  assert.match(notices, /\(The MIT License\)\s+Copyright \(c\) 2016 @catamphetamine/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(notices, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(notices, /END OF TERMS AND CONDITIONS/);
  assert.match(notices, /Copyright \(C\) The Libphonenumber Authors/);
  // The served file says where its data comes from and points at the full texts.
  const head = fs.readFileSync(path.join(ROOT, 'public/site/phone-rules.js'), 'utf8').split('(function')[0];
  assert.match(head, /libphonenumber-js \(MIT/);
  assert.match(head, /Google libphonenumber \(Apache-2\.0/);
  assert.match(head, /THIRD_PARTY_NOTICES\.md/);
  // ...and the release package carries the notices (ops/package-release.py's allowlist).
  const release = fs.readFileSync(path.join(ROOT, 'ops/package-release.py'), 'utf8');
  assert.match(release.match(/required = \[[^\]]*\]/)[0], /"THIRD_PARTY_NOTICES\.md"/);
});

test('login.html: one labelled dropdown on the phone field, the rules and page code in files, no inline script', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/login.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  // In <head>, render-blocking: the invite form opens before the first paint, so nothing jumps.
  assert.match(head, /<script src="\/client-errors\.js" referrerpolicy="no-referrer"><\/script>\n<script src="\/site\/phone-rules\.js" defer blocking="render"><\/script>\n<script src="\/site\/login\.js" defer blocking="render"><\/script>/);
  assert.doesNotMatch(html, /<script>|<script\b(?![^>]*\bsrc=)/, 'no inline script');
  assert.match(html, /<div class="phone-field" id="phw" role="group" aria-labelledby="lbl-ph" hidden><label class="field-label" id="lbl-ph" for="ph">手机号<\/label><div class="phone-row"><select id="cc" autocomplete="tel-country-code" aria-label="国家或地区代码" hidden><\/select><input id="ph" type="tel"/);
  assert.equal((html.match(/type="tel"/g) || []).length, 1, 'login.html has one phone field (sign-in and invite sign-up share it)');
  const src = fs.readFileSync(path.join(ROOT, 'public/site/phone-rules.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|eval\(|new Function/);
  assert.match(src, /var SOURCE = "libphonenumber-js \d+\.\d+\.\d+ metadata";/);
});

async function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-phone-country-'));
  const env = { ...process.env, DATA_DIR: path.join(dir, 'data'), MEDIA_DIR: '', PORT: new URL(BASE).port, HOST: '127.0.0.1', AUTH_BASE_URL: BASE,
    AUTH_SECRET: 'phone-country-secret-at-least-32-characters', COOKIE_SECURE: '0', TRUST_PROXY: '0', MAIL_MODE: 'file', OPENROUTER_API_KEY: '', GEMINI_API_KEY: '' };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', d => { errors += d; });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = new Promise(r => child.once('exit', r)); child.kill(); await stopped; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('startup timeout ' + errors)), 8000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(errors)); });
  });
}

test('the dropdown in a real browser', { skip: playwright ? false : 'Playwright is not installed', timeout: 300000 }, async t => {
  await startServer(t);
  const webkit = process.env.BROWSER === 'webkit';
  const browser = webkit ? await playwright.webkit.launch() : await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const AXE = fs.readFileSync(path.join(ROOT, 'tests/fixtures/axe-core/axe.min.js'), 'utf8');
  const shots = process.env.SITE_SCREENSHOTS;

  async function open(url, lang = 'zh') {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: lang === 'en' ? 'en-US' : 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [], sent = [];
    page.on('pageerror', e => errors.push(e.message));
    // Record what the page sends, then let the real server answer.
    await page.route('**/api/auth/**', async route => { const body = route.request().postData(); if (body) sent.push(JSON.parse(body)); await route.continue(); });
    await page.goto(BASE + url + (url.includes('?') ? '&' : '?') + 'lang=' + lang);
    return { context, page, errors, sent };
  }
  const state = page => page.evaluate(() => ({ cc: document.querySelector('#cc').value, ph: document.querySelector('#ph').value,
    placeholder: document.querySelector('#ph').placeholder, label: document.querySelector('#cc').selectedOptions[0].textContent, name: document.querySelector('#cc').getAttribute('aria-label') }));

  await t.test('defaults per language, and a language switch moves the default until the user picks', async () => {
    const { context, page, errors } = await open('/login.html?method=phone');
    assert.deepEqual(await state(page), { cc: 'CN', ph: '', placeholder: '138 0013 8000', label: '中国大陆 +86', name: '国家或地区代码' });
    await page.click('#lang-switch [data-lang="en"]');
    assert.deepEqual(await state(page), { cc: 'US', ph: '', placeholder: '415 555 2671', label: 'United States / Canada +1', name: 'Country or region code' });
    await page.selectOption('#cc', 'JP');
    assert.equal((await state(page)).placeholder, '090-1234-5678');
    await page.click('#lang-switch [data-lang="zh"]');
    assert.deepEqual(await state(page), { cc: 'JP', ph: '', placeholder: '090-1234-5678', label: '日本 +81', name: '国家或地区代码' });
    await page.selectOption('#cc', 'FR');
    assert.equal((await state(page)).placeholder, '06 12 34 56 78');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test('keyboard: Tab reaches the dropdown, letters jump to a region, and axe finds nothing', async () => {
    const { context, page } = await open('/login.html?method=phone', 'en');
    await page.locator('#method-tabs [data-method="phone"]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'cc');
    if (!webkit) { await page.keyboard.type('Jap'); assert.equal((await state(page)).cc, 'JP'); }
    await page.evaluate(AXE);
    const violations = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map(v => v.id));
    assert.deepEqual(violations, []);
    await context.close();
  });

  await t.test('sign-in sends E.164 built from the dropdown; a typed +number is honoured and moves the dropdown', async () => {
    let { context, page, sent } = await open('/login.html?method=phone', 'en');
    await page.fill('#ph', '(415) 555-2671');
    await page.fill('#p', 'not-the-password-1');
    await page.click('#go');
    await page.waitForFunction(() => document.querySelector('#err').textContent.trim());
    assert.equal(sent[0].phoneNumber, '+14155552671');
    assert.equal(await page.textContent('#err'), 'Incorrect phone number or password.', 'unknown number: the same answer as a wrong password');
    await context.close();

    ({ context, page, sent } = await open('/login.html?method=phone', 'zh'));
    await page.locator('#ph').pressSequentially('+44 7400 123456');
    assert.equal((await state(page)).cc, 'GB');
    await page.fill('#p', 'not-the-password-1');
    await page.click('#go');
    await page.waitForFunction(() => document.querySelector('#err').textContent.trim());
    assert.equal(sent[0].phoneNumber, '+447400123456', 'a typed +number is sent in E.164');
    await context.close();
  });

  await t.test('invalid numbers get the server\'s own message, the same for every invalid number', async () => {
    for (const typed of ['12345', '2800138000']) {
      const { context, page, sent } = await open('/login.html?method=phone', 'zh');
      await page.fill('#ph', typed);
      await page.fill('#p', 'not-the-password-1');
      await page.click('#go');
      await page.waitForFunction(() => document.querySelector('#err').textContent.trim());
      assert.equal(sent[0].phoneNumber, '+86' + typed);
      assert.match(await page.textContent('#err'), /^(请输入有效的手机号|手机号或密码错误)/);
      await context.close();
    }
  });

  await t.test('domestic formats are sent as the server\'s E.164: UK trunk 0, Jamaica area code, Russia 8, Argentina 15', async () => {
    for (const [iso, typed, e164] of [['GB', '07400 123456', '+447400123456'], ['JM', '(876) 210-1234', '+18762101234'], ['RU', '8 (912) 345-67-89', '+79123456789'], ['AR', '011 15-2345-6789', '+5491123456789']]) {
      const { context, page, sent } = await open('/login.html?method=phone', 'en');
      await page.selectOption('#cc', iso);
      await page.fill('#ph', typed);
      await page.fill('#p', 'not-the-password-1');
      await page.click('#go');
      await page.waitForFunction(() => document.querySelector('#err').textContent.trim());
      assert.equal(sent[0].phoneNumber, e164, `${iso} ${typed}`);
      await context.close();
    }
  });

  await t.test('every listed country: an invite link prefills its number and signs up with exactly that number', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', reducedMotion: 'reduce' });
    const page = await context.newPage();
    let body = null;
    await page.route('**/api/auth/sign-up/phone-number', route => { body = JSON.parse(route.request().postData()); return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'INVALID_INVITATION' }) }); });
    const cases = [...EXAMPLES.map(e => e.e164), '+18295551234', '+18495551234', '+16585551234', '+19395551234'];
    for (const e164 of cases) {
      body = null;
      await page.goto(`${BASE}/login.html?invite=demo-invite&phone=${encodeURIComponent(e164)}&lang=en`);
      const shown = await state(page);
      assert.equal(shown.cc, P.split(e164).iso, e164 + ': dropdown');
      assert.equal('+' + P.callingCode(shown.cc) + shown.ph, e164, e164 + ': the field shows the invited number');
      await page.fill('#n', 'Reader'); await page.fill('#p', 'a-long-password-1');
      await page.check('#c-terms'); await page.check('#c-sensitive');
      await page.click('#go');
      await page.waitForFunction(() => document.querySelector('#err').textContent.trim());
      assert.equal(body.phoneNumber, e164, e164 + ': sent unchanged');
    }
    // Editing the number afterwards sends what was typed, by the region's rules.
    await page.goto(`${BASE}/login.html?invite=demo-invite&phone=${encodeURIComponent('+18295551234')}&lang=en`);
    await page.fill('#ph', '(829) 555-9876');
    await page.fill('#n', 'Reader'); await page.fill('#p', 'a-long-password-1');
    await page.check('#c-terms'); await page.check('#c-sensitive');
    await page.click('#go');
    await page.waitForFunction(() => document.querySelector('#err').textContent.trim());
    assert.equal(body.phoneNumber, '+18295559876');
    await context.close();
  });

  await t.test('an invite link fills the dropdown and the number, and keeps them across a language switch', async () => {
    const { context, page } = await open('/login.html?invite=demo-invite&phone=%2B8613800138201', 'en');
    assert.deepEqual(await state(page), { cc: 'CN', ph: '13800138201', placeholder: '138 0013 8000', label: 'Mainland China +86', name: 'Country or region code' });
    assert.equal(await page.isVisible('#cw'), true, 'invite sign-up');
    await page.click('#lang-switch [data-lang="zh"]');
    assert.equal((await state(page)).cc, 'CN');
    if (shots) for (const lang of ['zh', 'en']) {
      await page.click(`#lang-switch [data-lang="${lang}"]`);
      await page.screenshot({ path: path.join(shots, `phone-invite-prefilled-${lang}-390.png`), fullPage: true });
    }
    await context.close();
  });

  if (shots) await t.test('screenshots', async () => {
    for (const lang of ['zh', 'en']) {
      const { context, page } = await open('/login.html?method=phone', lang);
      await page.screenshot({ path: path.join(shots, `phone-code-default-${lang}-390.png`), fullPage: true });
      await page.locator('#ph').pressSequentially('+44 7400 123456');
      await page.locator('#ph').blur();
      await page.screenshot({ path: path.join(shots, `phone-code-typed-plus-${lang}-390.png`), fullPage: true });
      await context.close();
    }
  });
});
