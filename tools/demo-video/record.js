'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VIEWPORT = { width: 390, height: 844 };
const RECORD_SIZE = { width: 780, height: 1688 };
const FFMPEG = process.env.FFMPEG_BIN || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');

function buildInitScript() {
  return ({ tab, initialLang, uid }) => {
    try {
      localStorage.setItem('bj-lang', initialLang);
      localStorage.setItem('bj-tab', tab);
      localStorage.setItem('bj-mmode', 'ai');
      if (uid) {
        localStorage.setItem(`bj-user:${uid}:bj-tab`, tab);
        localStorage.setItem(`bj-user:${uid}:bj-mmode`, 'ai');
      }
    } catch {}

    const ensureStyle = () => {
      if (document.getElementById('__demo-video-style')) return;
      const style = document.createElement('style');
      style.id = '__demo-video-style';
      style.textContent = `
        .__demo-ripple {
          position: fixed;
          width: 48px;
          height: 48px;
          margin-left: -24px;
          margin-top: -24px;
          border-radius: 50%;
          border: 3px solid rgba(12, 117, 96, 0.94);
          background: rgba(12, 117, 96, 0.24);
          box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.78), 0 4px 14px rgba(12, 117, 96, 0.35);
          pointer-events: none;
          z-index: 999999;
          transform: scale(0.35);
          opacity: 0.95;
          animation: __demoRippleAnim 520ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        @keyframes __demoRippleAnim {
          0% { transform: scale(0.35); opacity: 0.96; }
          58% { transform: scale(1.18); opacity: 0.68; }
          100% { transform: scale(1.62); opacity: 0; }
        }
        .__demo-focus-ring {
          position: fixed;
          pointer-events: none;
          z-index: 999990;
          border-radius: 16px;
          border: 2.5px solid rgba(12, 117, 96, 0.85);
          box-shadow: 0 0 0 6px rgba(12, 117, 96, 0.16), 0 8px 24px rgba(12, 117, 96, 0.22);
          animation: __demoFocusPulse 1400ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        @keyframes __demoFocusPulse {
          0% { opacity: 0; transform: scale(0.97); }
          18% { opacity: 1; transform: scale(1.0); }
          75% { opacity: 0.85; transform: scale(1.0); }
          100% { opacity: 0; transform: scale(1.015); }
        }
        ::-webkit-scrollbar { display: none; }
        html, body { scrollbar-width: none; scroll-behavior: auto !important; }
      `;
      (document.head || document.documentElement).appendChild(style);
    };

    const spawnRipple = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return;
      ensureStyle();
      const dot = document.createElement('div');
      dot.className = '__demo-ripple';
      dot.style.left = `${x}px`;
      dot.style.top = `${y}px`;
      document.body.appendChild(dot);
      setTimeout(() => dot.remove(), 560);
    };

    window.__demoHighlight = (el, pad = 6) => {
      if (!el || !el.getBoundingClientRect) return;
      ensureStyle();
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const ring = document.createElement('div');
      ring.className = '__demo-focus-ring';
      ring.style.left = `${Math.max(4, r.left - pad)}px`;
      ring.style.top = `${Math.max(4, r.top - pad)}px`;
      ring.style.width = `${Math.min(window.innerWidth - 8, r.width + pad * 2)}px`;
      ring.style.height = `${Math.min(window.innerHeight - 8, r.height + pad * 2)}px`;
      document.body.appendChild(ring);
      setTimeout(() => ring.remove(), 1480);
    };

    window.addEventListener(
      'pointerdown',
      e => spawnRipple(e.clientX, e.clientY),
      { capture: true, passive: true }
    );
    window.addEventListener(
      'click',
      e => {
        if (e.detail === 0) {
          const r = e.target?.getBoundingClientRect?.();
          if (r && r.width > 0) spawnRipple(r.left + r.width / 2, r.top + r.height / 2);
        }
      },
      { capture: true, passive: true }
    );

    window.__demoScrollTo = (targetY, durationMs = 750) =>
      new Promise(resolve => {
        const startY = window.scrollY;
        const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const endY = Math.max(0, Math.min(maxY, targetY));
        const delta = endY - startY;
        if (Math.abs(delta) < 2 || durationMs <= 0) {
          window.scrollTo({ top: endY, left: 0, behavior: 'instant' });
          resolve();
          return;
        }
        const t0 = performance.now();
        const step = now => {
          const p = Math.min(1, (now - t0) / durationMs);
          const ease = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
          window.scrollTo({ top: startY + delta * ease, left: 0, behavior: 'instant' });
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });

    window.__demoScrollIntoCenter = (el, durationMs = 700, offset = -40) => {
      if (!el) return Promise.resolve();
      const rect = el.getBoundingClientRect();
      const target = window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2 + offset;
      return window.__demoScrollTo(target, durationMs);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureStyle, { once: true });
    } else {
      ensureStyle();
    }
  };
}

async function smoothScrollTo(page, y, ms = 750) {
  await page.evaluate(({ y: ty, ms: dur }) => window.__demoScrollTo(ty, dur), { y, ms });
}

async function smoothCenter(page, locator, ms = 650, offset = -40) {
  const handle = await locator.elementHandle();
  if (!handle) return;
  await page.evaluate(
    ({ el, dur, off }) => window.__demoScrollIntoCenter(el, dur, off),
    { el: handle, dur: ms, off: offset }
  );
  await handle.dispose();
}

async function highlightEl(page, locator, pad = 6) {
  const handle = await locator.elementHandle();
  if (!handle) return;
  await page.evaluate(({ el, p }) => window.__demoHighlight?.(el, p), { el: handle, p: pad });
  await handle.dispose();
}

async function humanTap(page, locator, { scroll = true, pauseBefore = 180, pauseAfter = 320, markEvent } = {}) {
  await locator.waitFor({ state: 'visible' });
  if (scroll) await smoothCenter(page, locator, 550);
  await page.waitForTimeout(pauseBefore);
  markEvent?.('tap');
  await locator.click();
  await page.waitForTimeout(pauseAfter);
}

async function humanType(page, locator, text, { delay = 65, scroll = true, pauseAfter = 240 } = {}) {
  await locator.waitFor({ state: 'visible' });
  if (scroll) await smoothCenter(page, locator, 500);
  await page.waitForTimeout(140);
  await locator.click();
  await page.waitForTimeout(120);
  await locator.fill('');
  await locator.pressSequentially(String(text), { delay });
  await page.waitForTimeout(pauseAfter);
}

async function attachGuardsAndMocks(page, baseUrl, sb, sceneId) {
  const guards = {
    pageErrors: [],
    consoleErrors: [],
    cspViolations: [],
    external: []
  };

  await page.exposeFunction('__recordDemoCSP', v => guards.cspViolations.push(`[${sceneId}] ${v}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', e => {
      window.__recordDemoCSP(`${e.violatedDirective}: ${e.blockedURI}`);
    });
  });

  page.on('pageerror', err => guards.pageErrors.push(`[${sceneId}] ${err.message}`));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Content Security Policy|Refused to|unsafe-eval/i.test(text)) {
      guards.cspViolations.push(`[${sceneId}] ${text}`);
      return;
    }
    if (msg.location()?.url?.endsWith('/favicon.ico') && /status of 404/.test(text)) return;
    guards.consoleErrors.push(`[${sceneId}] ${text}`);
  });
  page.on('request', req => {
    const u = req.url();
    if (/^https?:/.test(u) && !u.startsWith(baseUrl)) guards.external.push(u);
  });

  // Mock /api/ai via Playwright route interception — zero real AI spend, instant realistic responses.
  await page.route('**/api/ai', async route => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    let body = {};
    try {
      body = req.postDataJSON() || {};
    } catch {}
    const promptText = (body.messages || []).map(m => String(m?.content || '')).join('\n');
    const isMeal = (Array.isArray(body.images) && body.images.length > 0) || /运动营养师|sports nutritionist/i.test(promptText);
    const isCoach = /力量训练和营养教练|strength and nutrition coach/i.test(promptText);

    if (isMeal) {
      await new Promise(r => setTimeout(r, 550));
      return route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ text: JSON.stringify(sb.mocks.mealEstimate), truncated: false })
      });
    }
    if (isCoach) {
      await new Promise(r => setTimeout(r, 650));
      return route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ text: JSON.stringify(sb.mocks.coachReview), truncated: false })
      });
    }
    return route.fulfill({
      status: 500,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ error: 'unexpected_ai_prompt', message: 'Unhandled mock AI prompt' })
    });
  });

  return guards;
}

function encodeScreencastFrames({ frames, totalDurSec, outMp4, concatPath }) {
  assert.ok(frames.length > 0, 'No screencast frames captured');
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const cur = frames[i];
    const nextT = i + 1 < frames.length ? frames[i + 1].t : Math.max(totalDurSec, cur.t + 0.033);
    const dur = Math.max(0.008, nextT - cur.t);
    const escaped = cur.file.replace(/'/g, "'\\''");
    lines.push(`file '${escaped}'`);
    lines.push(`duration ${dur.toFixed(6)}`);
  }
  const lastEsc = frames[frames.length - 1].file.replace(/'/g, "'\\''");
  lines.push(`file '${lastEsc}'`);
  fs.writeFileSync(concatPath, lines.join('\n') + '\n', 'utf8');

  execFileSync(
    FFMPEG,
    [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
      '-vf', `fps=30,scale=${RECORD_SIZE.width}:${RECORD_SIZE.height}:flags=lanczos,format=yuv420p`,
      '-r', '30',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '12',
      '-an',
      outMp4
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }
  );
}

async function recordSingleScene({ browser, srv, storageState, uid, sb, rawDir, sceneId, startTab, run }) {
  console.log(`  [${sb.lang}] recording scene: ${sceneId} (tab=${startTab})`);
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    locale: sb.locale,
    extraHTTPHeaders: {
      'Accept-Language': sb.lang === 'zh' ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9'
    },
    colorScheme: 'light',
    storageState,
    acceptDownloads: true
  });

  await context.addInitScript(buildInitScript(), { tab: startTab, initialLang: sb.lang, uid });

  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const guards = await attachGuardsAndMocks(page, srv.base, sb, sceneId);
  const cdp = await context.newCDPSession(page);

  const sceneFramesDir = path.join(rawDir, `frames-${sceneId}`);
  fs.mkdirSync(sceneFramesDir, { recursive: true });
  const frames = [];
  let frameSeq = 0;
  let recording = false;
  let sceneReadyAt = 0;

  cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    const now = Date.now();
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId });
    } catch {}
    if (!recording) return;
    const t = Math.max(0, (now - sceneReadyAt) / 1000);
    const file = path.join(sceneFramesDir, `f-${String(frameSeq++).padStart(6, '0')}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t });
  });

  const beatSplits = [];
  const events = [];
  let posterShotPath = null;

  try {
    await page.goto(srv.base + '/', { waitUntil: 'networkidle' });
    if (startTab === 'setup') {
      await page.locator('#setup').waitFor({ state: 'visible' });
    } else {
      await page.locator('#tabs').waitFor({ state: 'visible' });
      const activeTab = await page.locator('#tabs button.on').getAttribute('data-v');
      if (activeTab !== startTab) {
        await page.locator(`#tabs [data-act="tab"][data-v="${startTab}"]`).click();
      }
    }
    await page.waitForTimeout(420);

    // Ensure no banner errors are visible before recording begins
    assert.equal(await page.locator('.banner').count(), 0, `[${sceneId}] Unexpected error/offline banner`);

    // Capture exact initial lossless frame at t=0, then start CDP PNG screencast
    sceneReadyAt = Date.now();
    const initialFile = path.join(sceneFramesDir, `f-${String(frameSeq++).padStart(6, '0')}.png`);
    await page.screenshot({ path: initialFile, type: 'png' });
    frames.push({ file: initialFile, t: 0 });

    recording = true;
    await cdp.send('Page.startScreencast', {
      format: 'png',
      maxWidth: RECORD_SIZE.width,
      maxHeight: RECORD_SIZE.height,
      everyNthFrame: 1
    });

    const markBeat = () => {
      beatSplits.push((Date.now() - sceneReadyAt) / 1000);
    };
    const markEvent = kind => {
      events.push({ t: (Date.now() - sceneReadyAt) / 1000, kind });
    };

    const res = await run(page, { markBeat, markEvent });
    if (res?.posterShotPath) posterShotPath = res.posterShotPath;

    const sceneDuration = (Date.now() - sceneReadyAt) / 1000;

    // Wait briefly for any in-flight screencast frame then stop cleanly
    await page.waitForTimeout(180);
    recording = false;
    await cdp.send('Page.stopScreencast').catch(() => {});

    assert.deepEqual(guards.cspViolations, [], `[${sceneId}] CSP violations: ${guards.cspViolations.join('; ')}`);
    assert.deepEqual(guards.pageErrors, [], `[${sceneId}] Page errors: ${guards.pageErrors.join('; ')}`);
    assert.deepEqual(guards.consoleErrors, [], `[${sceneId}] Console errors: ${guards.consoleErrors.join('; ')}`);
    assert.deepEqual(guards.external, [], `[${sceneId}] External requests: ${guards.external.join('; ')}`);

    await context.close();

    const videoPath = path.join(rawDir, `raw-${sceneId}.mp4`);
    const concatPath = path.join(sceneFramesDir, 'concat.txt');
    encodeScreencastFrames({ frames, totalDurSec: sceneDuration, outMp4: videoPath, concatPath });
    fs.rmSync(sceneFramesDir, { recursive: true, force: true });

    return {
      id: sceneId,
      videoPath,
      trimStart: 0,
      recordedDuration: sceneDuration,
      beatSplits,
      events,
      posterShotPath
    };
  } catch (err) {
    recording = false;
    await cdp.send('Page.stopScreencast').catch(() => {});
    await context.close().catch(() => {});
    fs.rmSync(sceneFramesDir, { recursive: true, force: true });
    throw err;
  }
}

async function recordAllScenes({
  browser,
  srv,
  storageState,
  uid,
  setupStorageState = null,
  setupUid = null,
  sb,
  workDir,
  lunchPhotoPath,
  onlyScenes = null
}) {
  const rawDir = path.join(workDir, `raw-${sb.lang}`);
  fs.mkdirSync(rawDir, { recursive: true });
  const isZh = sb.lang === 'zh';
  const want = id => !onlyScenes || onlyScenes.includes(id);

  const scenes = [];
  const baseOpts = { browser, srv, storageState, uid, sb, rawDir };

  // Scene 1: 1-Minute Setup — Real first-time profile setup (metrics, goals, injuries -> tailored plan)
  if (want('setup')) scenes.push(
    await recordSingleScene({
      ...baseOpts,
      storageState: setupStorageState || storageState,
      uid: setupUid || uid,
      sceneId: 'setup',
      startTab: 'setup',
      run: async (page, { markBeat, markEvent }) => {
        await page.waitForTimeout(260);
        await humanType(page, page.locator('#f-age'), '28', { delay: 32, scroll: false, pauseAfter: 60 });
        await humanType(page, page.locator('#f-height'), '176', { delay: 32, scroll: false, pauseAfter: 60 });
        await humanType(page, page.locator('#f-weight'), '74.4', { delay: 32, scroll: false, pauseAfter: 60 });
        await humanType(page, page.locator('#f-bf'), '16.5', { delay: 32, scroll: false, pauseAfter: 90 });

        // Scroll past Training Plan (goal, schedule, gym) to Injuries section
        await smoothCenter(page, page.locator('#lbl-stage'), 420, 40);
        await page.waitForTimeout(240);
        await smoothCenter(page, page.locator('#lbl-inj'), 440, 60);
        await page.waitForTimeout(140);

        // Select Shoulder injury & add short note
        const shoulderChip = page.locator('input[name="injuries"][value="shoulder"]').locator('xpath=following-sibling::span');
        await humanTap(page, shoulderChip, { scroll: false, pauseBefore: 80, pauseAfter: 110, markEvent });
        await humanType(page, page.locator('#f-injnote'), sb.mocks.setupInjNote, {
          delay: isZh ? 28 : 18,
          scroll: false,
          pauseAfter: 140
        });

        // Beat 2: Submit "Build my plan" -> land on tailored Today workout & macros with shoulder-safe swap
        markBeat();
        const submitBtn = page.locator('#setup button[type="submit"]');
        await smoothCenter(page, submitBtn, 420, -30);
        await highlightEl(page, submitBtn, 5);
        await humanTap(page, submitBtn, { scroll: false, pauseBefore: 110, pauseAfter: 160, markEvent });

        await page.locator('#tabs').waitFor({ state: 'visible', timeout: 10000 });
        markEvent('chime');
        await page.waitForTimeout(1200);
        // Scroll slightly to showcase joint-safe swapped exercise & calculated daily macros
        await smoothScrollTo(page, 260, 560);
        await page.waitForTimeout(1350);
        await smoothScrollTo(page, 0, 500);
        await page.waitForTimeout(850);
      }
    })
  );

  // Scene 2: Today — Daily Check-in (also captures rich Week 4 Today poster screenshot)
  if (want('checkin')) scenes.push(
    await recordSingleScene({
      ...baseOpts,
      sceneId: 'checkin',
      startTab: 'today',
      run: async (page, { markBeat, markEvent }) => {
        const posterShotPath = path.join(rawDir, `poster-screen-${sb.lang}.png`);
        await page.screenshot({ path: posterShotPath });
        await page.waitForTimeout(260);
        const checkinCard = page.locator('#c-weight').locator('xpath=ancestor::section[contains(@class,"card")]');
        await smoothCenter(page, checkinCard, 620, -10);
        await page.waitForTimeout(220);

        await humanType(page, page.locator('#c-weight'), '72.4', { delay: 55, scroll: false, pauseAfter: 160 });
        await humanType(page, page.locator('#c-steps'), '9600', { delay: 50, scroll: false, pauseAfter: 160 });
        await humanType(page, page.locator('#c-sleep'), '7.5', { delay: 55, scroll: false, pauseAfter: 240 });

        markBeat();
        await humanTap(page, page.locator('[data-act="save-checkin"]'), {
          scroll: false,
          pauseBefore: 140,
          pauseAfter: 200,
          markEvent
        });
        const loggedPill = page.getByText(isZh ? '已记录' : 'Logged', { exact: true });
        await loggedPill.waitFor({ state: 'visible' });
        markEvent('chime');
        await highlightEl(page, checkinCard, 4);
        await page.waitForTimeout(1550);
        return { posterShotPath };
      }
    })
  );

  // Scene 2: Log Workout + Switch to Log Tab (Weight, Calorie Balance, Strength Progress)
  if (want('workout_log')) scenes.push(
    await recordSingleScene({
      ...baseOpts,
      sceneId: 'workout_log',
      startTab: 'today',
      run: async (page, { markBeat, markEvent }) => {
        await page.waitForTimeout(260);
        // Log sets for Exercise 1 (Incline Barbell Bench Press)
        await smoothCenter(page, page.locator('#ex-h-0'), 420, 120);
        await page.waitForTimeout(150);
        await humanType(page, page.locator('#w-0-0-w'), '60', { delay: 32, scroll: false, pauseAfter: 60 });
        await humanType(page, page.locator('#w-0-0-r'), '6', { delay: 32, scroll: false, pauseAfter: 70 });
        await humanType(page, page.locator('#w-0-1-w'), '60', { delay: 30, scroll: false, pauseAfter: 60 });
        await humanType(page, page.locator('#w-0-1-r'), '6', { delay: 30, scroll: false, pauseAfter: 70 });
        await humanType(page, page.locator('#w-0-2-w'), '60', { delay: 30, scroll: false, pauseAfter: 60 });
        await humanType(page, page.locator('#w-0-2-r'), '5', { delay: 30, scroll: false, pauseAfter: 100 });

        // Scroll to feel chips & Save Workout button
        await smoothCenter(page, page.locator('[data-act="save-workout"]'), 520, -100);
        await humanTap(page, page.locator('[data-act="feel"][data-v="2"]'), {
          scroll: false,
          pauseBefore: 90,
          pauseAfter: 120,
          markEvent
        });
        await humanTap(page, page.locator('[data-act="save-workout"]'), {
          scroll: false,
          pauseBefore: 100,
          pauseAfter: 180,
          markEvent
        });
        await smoothScrollTo(page, 0, 440);
        const doneTag = page.getByText(isZh ? '已完成' : 'Completed', { exact: true });
        await doneTag.waitFor({ state: 'visible' });
        markEvent('chime');
        await highlightEl(page, doneTag, 8);
        await page.waitForTimeout(420);

        // Beat 2: Tap Log tab to showcase weight chart, calorie balance, strength progress & daily history
        markBeat();
        await humanTap(page, page.locator('#tabs [data-act="tab"][data-v="log"]'), {
          scroll: false,
          pauseBefore: 100,
          pauseAfter: 180,
          markEvent
        });
        await page.waitForTimeout(680);
        await smoothScrollTo(page, 390, 560);
        await page.waitForTimeout(680);
        await smoothScrollTo(page, 840, 560);
        await page.waitForTimeout(680);
        await smoothScrollTo(page, 1210, 500);
        await page.waitForTimeout(380);
      }
    })
  );

  // Scene 3: Meals — Snap Photo -> AI Estimate -> Updated Macro Bars
  if (want('meals')) scenes.push(
    await recordSingleScene({
      ...baseOpts,
      sceneId: 'meals',
      startTab: 'food',
      run: async (page, { markBeat, markEvent }) => {
        await page.waitForTimeout(300);
        const logCard = page.locator('#m-text').locator('xpath=ancestor::section[contains(@class,"card")]');
        await smoothCenter(page, logCard, 440, 10);
        await page.waitForTimeout(160);

        // Select Lunch meal type chip
        const lunchChip = page.locator('input[name="mtype"][value="午餐"]').locator('xpath=following-sibling::span');
        await humanTap(page, lunchChip, { scroll: false, pauseBefore: 90, pauseAfter: 130, markEvent });

        // Highlight localized photo picker button (#m-photo-btn) and attach generated high-protein chicken bowl photo
        const photoBtn = page.locator('#m-photo-btn');
        if (await photoBtn.count()) {
          await highlightEl(page, photoBtn, 5);
          markEvent('tap');
          await page.waitForTimeout(160);
        }
        const photoBuf = fs.readFileSync(lunchPhotoPath);
        await page.locator('#m-photo').setInputFiles({
          name: 'lunch-bowl.jpg',
          mimeType: 'image/jpeg',
          buffer: photoBuf
        });
        await page.locator('.previews img.preview').waitFor({ state: 'visible' });
        await page.waitForTimeout(420);

        // Type concise description
        await humanType(page, page.locator('#m-text'), sb.mocks.mealNote, {
          delay: isZh ? 26 : 18,
          scroll: false,
          pauseAfter: 140
        });

        // Tap Save & AI estimate
        const addBtn = page.locator('[data-act="add-meal"]');
        await humanTap(page, addBtn, { scroll: true, pauseBefore: 100, pauseAfter: 120, markEvent });

        // Wait for AI estimate to populate kcal=540 and addMeal to settle
        await page.waitForFunction(() => {
          const inputs = [...document.querySelectorAll('input[data-k="kcal"]')];
          return inputs.some(i => i.value === '540') && !window.S?.busy?.addMeal;
        }, { timeout: 10000 });

        markBeat();
        markEvent('chime');
        // Scroll smoothly to show the newly estimated meal card with photo + macros + tip
        const newMeal = page.locator('.meal').filter({ hasText: sb.mocks.mealNote.slice(0, 12) }).first();
        await smoothCenter(page, newMeal, 540, -10);
        await highlightEl(page, newMeal, 5);
        await page.waitForTimeout(1650);

        // Scroll back to top so viewer sees daily calorie & protein bars updated!
        await smoothScrollTo(page, 0, 560);
        await page.waitForTimeout(950);
      }
    })
  );

  // Scene 4: Feedback — AI Coach Review -> Adopt Chooser -> One-Tap Undo
  if (want('coach')) scenes.push(
    await recordSingleScene({
      ...baseOpts,
      sceneId: 'coach',
      startTab: 'fb',
      run: async (page, { markBeat, markEvent }) => {
        await page.waitForTimeout(650);
        await smoothCenter(page, page.locator('#fb-text'), 620, 10);
        await page.waitForTimeout(240);

        // Type realistic user note and submit to AI coach
        await humanType(page, page.locator('#fb-text'), sb.mocks.coachNote, {
          delay: isZh ? 40 : 24,
          scroll: false,
          pauseAfter: 240
        });
        await humanTap(page, page.locator('[data-act="ai-run"]'), {
          scroll: false,
          pauseBefore: 150,
          pauseAfter: 200,
          markEvent
        });

        // Wait for AI review card with adopt-open chip to appear
        const adoptChip = page.locator('[data-act="adopt-open"]').first();
        await adoptChip.waitFor({ state: 'visible', timeout: 10000 });
        markEvent('chime');

        // Pause briefly on the review summary
        const fbSection = adoptChip.locator('xpath=ancestor::section[contains(@class,"card")]');
        await smoothCenter(page, fbSection, 620, -80);
        await page.waitForTimeout(1600);

        // Beat 2: Adopt suggestion in one tap -> highlight Undo chip -> tap Undo to prove full reversibility!
        markBeat();
        await smoothCenter(page, adoptChip, 360, 20);
        await humanTap(page, adoptChip, { scroll: false, pauseBefore: 110, pauseAfter: 140, markEvent });
        await page.locator('.chooser').waitFor({ state: 'visible' });
        const confirmBtn = page.locator('[data-act="adopt-confirm"]').first();
        await humanTap(page, confirmBtn, { scroll: false, pauseBefore: 100, pauseAfter: 160, markEvent });
        const undoChip = page.locator('[data-act="undo-adjust"]').first();
        await undoChip.waitFor({ state: 'visible' });
        markEvent('chime');
        await highlightEl(page, undoChip, 6);
        await page.waitForTimeout(900);

        // Tap "已采纳 · 撤销" / "Applied · Undo" to prove any change can be undone anytime!
        await humanTap(page, undoChip, { scroll: false, pauseBefore: 120, pauseAfter: 180, markEvent });
        await adoptChip.waitFor({ state: 'visible' });
        await page.waitForTimeout(680);
      }
    })
  );

  // Scene 6: Me — Home Screen & Bilingual Switch
  if (want('me')) scenes.push(
    await recordSingleScene({
      ...baseOpts,
      sceneId: 'me',
      startTab: 'me',
      run: async (page, { markEvent }) => {
        await page.waitForTimeout(550);

        // Toggle language briefly so viewers see seamless zh <-> en support
        const otherLang = isZh ? 'en' : 'zh';
        await humanTap(page, page.locator(`[data-act="lang"][data-v="${otherLang}"]`), {
          scroll: false,
          pauseBefore: 150,
          pauseAfter: 220,
          markEvent
        });
        await page.waitForTimeout(1500);

        // Switch back to video's primary language
        await humanTap(page, page.locator(`[data-act="lang"][data-v="${sb.lang}"]`), {
          scroll: false,
          pauseBefore: 150,
          pauseAfter: 220,
          markEvent
        });
        await page.waitForTimeout(850);
      }
    })
  );

  // Scene 7: Me — One-Tap Data Export ("your data is yours")
  if (want('export')) scenes.push(
    await recordSingleScene({
      ...baseOpts,
      sceneId: 'export',
      startTab: 'me',
      run: async (page, { markEvent }) => {
        await page.waitForTimeout(260);
        const exportBtn = page.locator('a[href="/api/account/export"]');
        await smoothCenter(page, exportBtn, 680, -40);
        await highlightEl(page, exportBtn, 6);
        await page.waitForTimeout(680);

        const [download] = await Promise.all([
          page.waitForEvent('download'),
          humanTap(page, exportBtn, { scroll: false, pauseBefore: 150, pauseAfter: 220, markEvent })
        ]);
        const dlPath = await download.path();
        assert.ok(dlPath && fs.statSync(dlPath).size > 500, 'Expected non-empty NDJSON export download');
        markEvent('chime');
        await page.waitForTimeout(1450);
      }
    })
  );

  return scenes;
}

module.exports = { recordAllScenes, VIEWPORT, RECORD_SIZE };
