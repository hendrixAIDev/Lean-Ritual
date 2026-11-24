'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VIEWPORT = { width: 390, height: 844 };
const RECORD_SIZE = { width: 780, height: 1688 };

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
        html, body { scrollbar-width: none; }
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
          window.scrollTo(0, endY);
          resolve();
          return;
        }
        const t0 = performance.now();
        const step = now => {
          const p = Math.min(1, (now - t0) / durationMs);
          const ease = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
          window.scrollTo(0, startY + delta * ease);
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

async function recordSingleScene({ browser, srv, storageState, uid, sb, rawDir, sceneId, startTab, run }) {
  console.log(`  [${sb.lang}] recording scene: ${sceneId} (tab=${startTab})`);
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    locale: sb.locale,
    colorScheme: 'light',
    storageState,
    acceptDownloads: true,
    recordVideo: { dir: rawDir, size: RECORD_SIZE }
  });

  await context.addInitScript(buildInitScript(), { tab: startTab, initialLang: sb.lang, uid });

  const pageCreatedAt = Date.now();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const guards = await attachGuardsAndMocks(page, srv.base, sb, sceneId);

  let trimStart = 0;
  const beatSplits = [];
  const events = [];
  let posterShotPath = null;

  try {
    await page.goto(srv.base + '/', { waitUntil: 'networkidle' });
    await page.locator('#tabs').waitFor({ state: 'visible' });
    const activeTab = await page.locator('#tabs button.on').getAttribute('data-v');
    if (activeTab !== startTab) {
      await page.locator(`#tabs [data-act="tab"][data-v="${startTab}"]`).click();
    }
    await page.waitForTimeout(450);

    // Ensure no banner errors are visible before recording begins
    assert.equal(await page.locator('.banner').count(), 0, `[${sceneId}] Unexpected error/offline banner`);

    const sceneReadyAt = Date.now();
    // Leave a tiny safety buffer so trim cuts past any navigation/hydration paint.
    trimStart = Math.max(0.25, (sceneReadyAt - pageCreatedAt) / 1000);

    const markBeat = () => {
      beatSplits.push((Date.now() - sceneReadyAt) / 1000);
    };
    const markEvent = kind => {
      events.push({ t: (Date.now() - sceneReadyAt) / 1000, kind });
    };

    const res = await run(page, { markBeat, markEvent });
    if (res?.posterShotPath) posterShotPath = res.posterShotPath;

    const sceneDuration = (Date.now() - sceneReadyAt) / 1000;

    // Wait briefly so final frames flush cleanly into WebM
    await page.waitForTimeout(250);

    assert.deepEqual(guards.cspViolations, [], `[${sceneId}] CSP violations: ${guards.cspViolations.join('; ')}`);
    assert.deepEqual(guards.pageErrors, [], `[${sceneId}] Page errors: ${guards.pageErrors.join('; ')}`);
    assert.deepEqual(guards.consoleErrors, [], `[${sceneId}] Console errors: ${guards.consoleErrors.join('; ')}`);
    assert.deepEqual(guards.external, [], `[${sceneId}] External requests: ${guards.external.join('; ')}`);

    const video = page.video();
    await context.close();
    const videoPath = await video.path();

    return {
      id: sceneId,
      videoPath,
      trimStart,
      recordedDuration: sceneDuration,
      beatSplits,
      events,
      posterShotPath
    };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

async function recordAllScenes({ browser, srv, storageState, uid, sb, workDir, lunchPhotoPath, onlyScenes = null }) {
  const rawDir = path.join(workDir, `raw-${sb.lang}`);
  fs.mkdirSync(rawDir, { recursive: true });
  const isZh = sb.lang === 'zh';
  const want = id => !onlyScenes || onlyScenes.includes(id);

  const scenes = [];
  const baseOpts = { browser, srv, storageState, uid, sb, rawDir };

  // Scene 0: Hook — App Home (Today)
  if (want('hook')) scenes.push(
    await recordSingleScene({
      ...baseOpts,
      sceneId: 'hook',
      startTab: 'today',
      run: async page => {
        const posterShotPath = path.join(rawDir, `poster-screen-${sb.lang}.png`);
        await page.screenshot({ path: posterShotPath });
        await page.waitForTimeout(1500);
        await smoothScrollTo(page, 210, 1100);
        await page.waitForTimeout(1200);
        await smoothScrollTo(page, 0, 900);
        await page.waitForTimeout(700);
        return { posterShotPath };
      }
    })
  );

  // Scene 1: Today — Daily Check-in
  if (want('checkin')) scenes.push(
    await recordSingleScene({
      ...baseOpts,
      sceneId: 'checkin',
      startTab: 'today',
      run: async (page, { markBeat, markEvent }) => {
        await page.waitForTimeout(500);
        const checkinCard = page.locator('#c-weight').locator('xpath=ancestor::section[contains(@class,"card")]');
        await smoothCenter(page, checkinCard, 1050, -10);
        await page.waitForTimeout(550);

        await humanType(page, page.locator('#c-weight'), '72.4', { delay: 105, scroll: false, pauseAfter: 400 });
        await humanType(page, page.locator('#c-steps'), '9600', { delay: 95, scroll: false, pauseAfter: 400 });
        await humanType(page, page.locator('#c-sleep'), '7.5', { delay: 105, scroll: false, pauseAfter: 550 });

        markBeat();
        await humanTap(page, page.locator('[data-act="save-checkin"]'), {
          scroll: false,
          pauseBefore: 240,
          pauseAfter: 350,
          markEvent
        });
        const loggedPill = page.getByText(isZh ? '已记录' : 'Logged', { exact: true });
        await loggedPill.waitFor({ state: 'visible' });
        markEvent('chime');
        await highlightEl(page, checkinCard, 4);
        await page.waitForTimeout(3000);
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
        await page.waitForTimeout(650);
        // Log sets for Exercise 1 (Incline Barbell Bench Press)
        await smoothCenter(page, page.locator('#ex-h-0'), 700, 120);
        await page.waitForTimeout(450);
        await humanType(page, page.locator('#w-0-0-w'), '60', { delay: 85, scroll: false, pauseAfter: 160 });
        await humanType(page, page.locator('#w-0-0-r'), '6', { delay: 85, scroll: false, pauseAfter: 210 });
        await humanType(page, page.locator('#w-0-1-w'), '60', { delay: 75, scroll: false, pauseAfter: 160 });
        await humanType(page, page.locator('#w-0-1-r'), '6', { delay: 75, scroll: false, pauseAfter: 210 });
        await humanType(page, page.locator('#w-0-2-w'), '60', { delay: 75, scroll: false, pauseAfter: 160 });
        await humanType(page, page.locator('#w-0-2-r'), '5', { delay: 75, scroll: false, pauseAfter: 320 });

        // Log first two sets of Exercise 2 (Flat Barbell Bench Press)
        await smoothCenter(page, page.locator('#ex-h-1'), 750, 110);
        await page.waitForTimeout(380);
        await humanType(page, page.locator('#w-1-0-w'), '67.5', { delay: 75, scroll: false, pauseAfter: 160 });
        await humanType(page, page.locator('#w-1-0-r'), '5', { delay: 75, scroll: false, pauseAfter: 200 });
        await humanType(page, page.locator('#w-1-1-w'), '67.5', { delay: 75, scroll: false, pauseAfter: 160 });
        await humanType(page, page.locator('#w-1-1-r'), '5', { delay: 75, scroll: false, pauseAfter: 320 });

        // Scroll to feel chips & Save Workout button
        await smoothCenter(page, page.locator('[data-act="save-workout"]'), 950, -100);
        await humanTap(page, page.locator('[data-act="feel"][data-v="2"]'), {
          scroll: false,
          pauseBefore: 180,
          pauseAfter: 300,
          markEvent
        });
        await humanTap(page, page.locator('[data-act="save-workout"]'), {
          scroll: false,
          pauseBefore: 240,
          pauseAfter: 450,
          markEvent
        });
        await smoothScrollTo(page, 0, 750);
        const doneTag = page.getByText(isZh ? '已完成' : 'Completed', { exact: true });
        await doneTag.waitFor({ state: 'visible' });
        markEvent('chime');
        await highlightEl(page, doneTag, 8);
        await page.waitForTimeout(1050);

        // Beat 2: Tap Log tab to showcase weight chart, calorie balance, strength progress & daily history
        markBeat();
        await humanTap(page, page.locator('#tabs [data-act="tab"][data-v="log"]'), {
          scroll: false,
          pauseBefore: 200,
          pauseAfter: 400,
          markEvent
        });
        await page.waitForTimeout(2300);
        await smoothScrollTo(page, 390, 1100);
        await page.waitForTimeout(2100);
        await smoothScrollTo(page, 840, 1100);
        await page.waitForTimeout(2300);
        await smoothScrollTo(page, 1210, 950);
        await page.waitForTimeout(1600);
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
        await page.waitForTimeout(1000);
        const logCard = page.locator('#m-text').locator('xpath=ancestor::section[contains(@class,"card")]');
        await smoothCenter(page, logCard, 800, 10);
        await page.waitForTimeout(420);

        // Select Lunch meal type chip
        const lunchChip = page.locator('input[name="mtype"][value="午餐"]').locator('xpath=following-sibling::span');
        await humanTap(page, lunchChip, { scroll: false, pauseBefore: 180, pauseAfter: 320, markEvent });

        // Attach generated high-protein chicken bowl photo
        const photoBuf = fs.readFileSync(lunchPhotoPath);
        await page.locator('#m-photo').setInputFiles({
          name: 'lunch-bowl.jpg',
          mimeType: 'image/jpeg',
          buffer: photoBuf
        });
        await page.locator('.previews img.preview').waitFor({ state: 'visible' });
        await page.waitForTimeout(1100);

        // Type concise description
        await humanType(page, page.locator('#m-text'), sb.mocks.mealNote, {
          delay: isZh ? 70 : 40,
          scroll: false,
          pauseAfter: 400
        });

        // Tap Save & AI estimate
        const addBtn = page.locator('[data-act="add-meal"]');
        await humanTap(page, addBtn, { scroll: true, pauseBefore: 240, pauseAfter: 240, markEvent });

        // Wait for AI estimate to populate kcal=540
        await page.waitForFunction(() => {
          const inputs = [...document.querySelectorAll('input[data-k="kcal"]')];
          return inputs.some(i => i.value === '540');
        }, { timeout: 10000 });

        markBeat();
        markEvent('chime');
        // Scroll smoothly to show the newly estimated meal card with photo + macros + tip
        const newMeal = page.locator('.meal').filter({ hasText: sb.mocks.mealNote.slice(0, 12) }).first();
        await smoothCenter(page, newMeal, 850, -10);
        await highlightEl(page, newMeal, 5);
        await page.waitForTimeout(3300);

        // Scroll back to top so viewer sees daily calorie & protein bars updated!
        await smoothScrollTo(page, 0, 950);
        await page.waitForTimeout(2800);
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
        await page.waitForTimeout(1450);
        await smoothCenter(page, page.locator('#fb-text'), 850, 10);
        await page.waitForTimeout(400);

        // Type realistic user note and submit to AI coach
        await humanType(page, page.locator('#fb-text'), sb.mocks.coachNote, {
          delay: isZh ? 62 : 36,
          scroll: false,
          pauseAfter: 420
        });
        await humanTap(page, page.locator('[data-act="ai-run"]'), {
          scroll: false,
          pauseBefore: 220,
          pauseAfter: 280,
          markEvent
        });

        // Wait for AI review card with adopt-open chip to appear
        const adoptChip = page.locator('[data-act="adopt-open"]').first();
        await adoptChip.waitFor({ state: 'visible', timeout: 10000 });
        markEvent('chime');

        // Pause briefly on the review summary
        const fbSection = adoptChip.locator('xpath=ancestor::section[contains(@class,"card")]');
        await smoothCenter(page, fbSection, 850, -80);
        await page.waitForTimeout(2200);

        // Beat 2: Open adoption chooser (Today only / Long-term / Decline) -> adopt Today only -> Undo!
        markBeat();
        await smoothCenter(page, adoptChip, 650, 20);
        await humanTap(page, adoptChip, { scroll: false, pauseBefore: 240, pauseAfter: 450, markEvent });
        await page.locator('.chooser').waitFor({ state: 'visible' });
        await smoothCenter(page, page.locator('.chooser'), 480, 0);
        await highlightEl(page, page.locator('.chooser'), 6);
        await page.waitForTimeout(2400);

        // Tap "只改今天" / "Today only"
        const todayBtn = page.locator('[data-act="adopt-confirm"]').first();
        await humanTap(page, todayBtn, { scroll: false, pauseBefore: 220, pauseAfter: 380, markEvent });
        const undoChip = page.locator('[data-act="undo-adjust"]').first();
        await undoChip.waitFor({ state: 'visible' });
        markEvent('chime');
        await highlightEl(page, undoChip, 6);
        await page.waitForTimeout(2200);

        // Tap "已采纳 · 撤销" / "Applied · Undo" to prove full reversibility!
        await humanTap(page, undoChip, { scroll: false, pauseBefore: 240, pauseAfter: 420, markEvent });
        await adoptChip.waitFor({ state: 'visible' });
        await page.waitForTimeout(2000);
      }
    })
  );

  // Scene 5: Me — Home Screen Hint, Language Switch, Export Data
  if (want('me')) scenes.push(
    await recordSingleScene({
      ...baseOpts,
      sceneId: 'me',
      startTab: 'me',
      run: async (page, { markBeat, markEvent }) => {
        await page.waitForTimeout(1450);

        // Toggle language briefly so viewers see seamless zh <-> en support
        const otherLang = isZh ? 'en' : 'zh';
        await humanTap(page, page.locator(`[data-act="lang"][data-v="${otherLang}"]`), {
          scroll: false,
          pauseBefore: 240,
          pauseAfter: 350,
          markEvent
        });
        await page.waitForTimeout(2400);

        // Switch back to video's primary language
        await humanTap(page, page.locator(`[data-act="lang"][data-v="${sb.lang}"]`), {
          scroll: false,
          pauseBefore: 220,
          pauseAfter: 350,
          markEvent
        });
        await page.waitForTimeout(1100);

        // Beat 2: Scroll to Account card & Export data ("your data is yours")
        markBeat();
        const exportBtn = page.locator('a[href="/api/account/export"]');
        await smoothCenter(page, exportBtn, 1000, -40);
        await highlightEl(page, exportBtn, 6);
        await page.waitForTimeout(1400);

        const [download] = await Promise.all([
          page.waitForEvent('download'),
          humanTap(page, exportBtn, { scroll: false, pauseBefore: 220, pauseAfter: 280, markEvent })
        ]);
        const dlPath = await download.path();
        assert.ok(dlPath && fs.statSync(dlPath).size > 500, 'Expected non-empty NDJSON export download');
        markEvent('chime');
        await page.waitForTimeout(3000);
      }
    })
  );

  return scenes;
}

module.exports = { recordAllScenes, VIEWPORT, RECORD_SIZE };
