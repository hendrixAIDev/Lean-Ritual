'use strict';
// The country code dropdown on login.html's phone fields (public/site/phone-country.js).
// The server's lib/phone.js stays the judge of every number; these tests prove the page
// sends it "+<code><national number>" and leaves anything typed with "+" as typed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { normalizePhone } = require('../lib/phone');

let playwright = null;
try { playwright = require('playwright'); } catch { playwright = null; }

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/site/phone-country.js'), 'utf8');
const BASE = 'http://127.0.0.1:18100';

function load() {
  const ctx = { window: {}, Intl };
  vm.runInNewContext(SRC, ctx);
  return ctx.window.ritualPhoneCountry;
}

test('the list: the common regions first in the asked order, then every other region A-Z in the page language', () => {
  const P = load();
  const plain = v => JSON.parse(JSON.stringify(v));   // out of the vm realm, for deepEqual
  const zh = plain(P.options('zh')), en = plain(P.options('en'));
  assert.deepEqual(zh.common.map(o => o.label), ['中国大陆 +86', '美国/加拿大 +1', '香港 +852', '澳门 +853', '台湾 +886', '新加坡 +65', '日本 +81', '韩国 +82', '英国 +44', '澳大利亚 +61']);
  assert.deepEqual(en.common.map(o => o.label), ['Mainland China +86', 'United States / Canada +1', 'Hong Kong +852', 'Macao +853', 'Taiwan +886', 'Singapore +65', 'Japan +81', 'South Korea +82', 'United Kingdom +44', 'Australia +61']);
  for (const [lang, list] of [['zh', zh], ['en', en]]) {
    const all = [...list.common, ...list.rest].map(o => o.iso);
    assert.equal(new Set(all).size, all.length, lang + ': each region once');
    assert.ok(list.rest.length > 200, lang + ': every region');
    assert.ok(!all.includes('CA'), 'Canada is listed under +1 with the United States');
    const collator = new Intl.Collator(lang === 'en' ? 'en' : 'zh-CN');
    const names = list.rest.map(o => o.label.replace(/ \+\d+$/, ''));
    assert.deepEqual(names, [...names].sort(collator.compare), lang + ': alphabetical');
    for (const o of [...list.common, ...list.rest]) assert.match(o.label, /\S \+\d{1,4}$/, o.iso);
  }
  assert.equal(en.rest.find(o => o.iso === 'JM').label, 'Jamaica +1876');
  assert.ok(!en.rest.some(o => /[一-鿿]/.test(o.label)) && !zh.rest.some(o => /^[A-Z]{2} \+/.test(o.label)), 'names are in the page language');
});

test('defaults follow the page language: +86 in Chinese, +1 in English, with an example number for each', () => {
  const P = load();
  assert.equal(P.defaultFor('zh'), 'CN');
  assert.equal(P.defaultFor('en'), 'US');
  assert.equal(P.example('CN'), '138 0013 8000');
  assert.equal(P.example('US'), '415 555 2671');
  assert.equal(P.example('FR'), null, 'no example: the page shows "number without the country code"');
});

test('a national number becomes E.164 that the server accepts unchanged', () => {
  const P = load();
  for (const [iso, typed, e164] of [
    ['CN', '138 0013 8000', '+8613800138000'], ['CN', '１３８ ００１３ ８０００', '+8613800138000'], ['US', '(415) 555-2671', '+14155552671'],
    ['US', '1 415 555 2671', '+14155552671'], ['HK', '5123 4567', '+85251234567'], ['GB', '07400 123456', '+447400123456'],
    ['JP', '090-1234-5678', '+819012345678'], ['KR', '010 1234 5678', '+821012345678'], ['AU', '0412 345 678', '+61412345678'],
    ['TW', '0912 345 678', '+886912345678'], ['IT', '06 1234 5678', '+390612345678'], ['JM', '555 1234', '+18765551234']
  ]) {
    const sent = P.combine(iso, typed);
    assert.equal(sent, e164, `${iso} ${typed}`);
    assert.equal(normalizePhone(sent), e164, 'lib/phone.js keeps it as is');
  }
  assert.equal(P.combine('CN', '   '), '', 'empty stays empty, so the field is still required');
});

test('a full +number is sent as typed, and picks its region', () => {
  const P = load();
  for (const typed of ['+44 7400 123456', '+86 138-0013-8000', '0044 7400 123456', '＋８６１３８００１３８０００'])
    assert.equal(normalizePhone(P.combine('US', typed)), normalizePhone(typed), typed);
  assert.deepEqual({ ...P.split('+8613800138201') }, { iso: 'CN', national: '13800138201' });
  assert.deepEqual({ ...P.split('+14155552699') }, { iso: 'US', national: '4155552699' });
  assert.deepEqual({ ...P.split('+1 876 555 1234') }, { iso: 'JM', national: '5551234' });
  assert.deepEqual({ ...P.split('0044 7400 123456') }, { iso: 'GB', national: '7400123456' });
  assert.equal(P.split('+79161234567').iso, 'RU');
  assert.equal(P.split('+77011234567', 'KZ').iso, 'KZ', 'a shared code keeps the region already chosen');
  assert.equal(P.split('+393331234567').iso, 'IT');
  for (const notFull of ['13800138000', '', '+', 'abc', '+0123']) assert.equal(P.split(notFull), null, notFull);
});

test('invalid numbers are still the server\'s call: they reach lib/phone.js and are refused there', () => {
  const P = load();
  for (const [iso, typed] of [['CN', '12345'], ['CN', '2800138000'], ['US', '12'], ['CN', '+86 123'], ['CN', 'abc']]) {
    const sent = P.combine(iso, typed);
    assert.ok(sent.length > 0, 'the page does not swallow it');
    assert.equal(normalizePhone(sent), null, `${iso} ${typed} -> ${sent}`);
  }
});

test('login.html: one labelled dropdown on the phone field, hidden until the script fills it, and no inline code', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/login.html'), 'utf8');
  assert.match(html, /<script src="\/site\/phone-country\.js"><\/script>\n<script>/, 'loaded before the page script');
  assert.match(html, /<div class="phone-field" id="phw" role="group" aria-labelledby="lbl-ph" hidden><label class="field-label" id="lbl-ph" for="ph">手机号<\/label><div class="phone-row"><select id="cc" autocomplete="tel-country-code" aria-label="国家或地区代码" hidden><\/select><input id="ph" type="tel"/);
  assert.equal((html.match(/type="tel"/g) || []).length, 1, 'login.html has one phone field (sign-in and invite sign-up share it)');
  assert.doesNotMatch(SRC, /innerHTML|eval\(|new Function/);
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
    assert.equal((await state(page)).placeholder, '90 1234 5678');
    await page.click('#lang-switch [data-lang="zh"]');
    assert.deepEqual(await state(page), { cc: 'JP', ph: '', placeholder: '90 1234 5678', label: '日本 +81', name: '国家或地区代码' });
    await page.selectOption('#cc', 'FR');
    assert.equal((await state(page)).placeholder, '不含国家代码的号码');
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
    assert.equal(normalizePhone(sent[0].phoneNumber), '+447400123456');
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
