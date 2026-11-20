'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const ICON_SVG = fs.readFileSync(path.join(ROOT, 'public/icons/icon.svg'), 'utf8');

const CANVAS_W = 1080;
const CANVAS_H = 1920;
const PHONE_W = 740;
const PHONE_H = 1602;
const PHONE_X = Math.round((CANVAS_W - PHONE_W) / 2); // 170
const PHONE_Y = 104;
const PHONE_R = 40;

const FONT_STACK = `"PingFang SC", "Hiragino Sans GB", -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif`;

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderHtmlImage(browser, { width, height, html, outPath, transparent = false, type = 'png', quality }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({
      path: outPath,
      type,
      ...(type === 'jpeg' ? { quality: quality || 90 } : { omitBackground: transparent })
    });
  } finally {
    await context.close();
  }
}

async function renderFrameShell(browser, outPath) {
  // Opaque studio backdrop + sleek phone bezel with an antialiased transparent rounded-rect cutout
  // so the phone video sits behind it and gets crisp rounded corners with zero aliasing.
  const bx = PHONE_X - 14;
  const by = PHONE_Y - 14;
  const bw = PHONE_W + 28;
  const bh = PHONE_H + 28;
  const br = PHONE_R + 12;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; width: ${CANVAS_W}px; height: ${CANVAS_H}px; background: transparent; overflow: hidden; }
  svg { display: block; width: ${CANVAS_W}px; height: ${CANVAS_H}px; }
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0%" stop-color="#13221D"/>
      <stop offset="52%" stop-color="#0D1613"/>
      <stop offset="100%" stop-color="#0A1210"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="12%" r="60%">
      <stop offset="0%" stop-color="#0C7560" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="#0C7560" stop-opacity="0"/>
    </radialGradient>
    <mask id="cutout">
      <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="white"/>
      <rect x="${PHONE_X}" y="${PHONE_Y}" width="${PHONE_W}" height="${PHONE_H}" rx="${PHONE_R}" ry="${PHONE_R}" fill="black"/>
    </mask>
    <filter id="bezelShadow" x="-10%" y="-5%" width="120%" height="110%">
      <feDropShadow dx="0" dy="22" stdDeviation="28" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <g mask="url(#cutout)">
    <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#bg)"/>
    <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#glow)"/>
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${br}" ry="${br}" fill="#1A2622" stroke="#364B44" stroke-width="2.5" filter="url(#bezelShadow)"/>
    <rect x="${PHONE_X - 4}" y="${PHONE_Y - 4}" width="${PHONE_W + 8}" height="${PHONE_H + 8}" rx="${PHONE_R + 4}" ry="${PHONE_R + 4}" fill="#090F0D"/>
  </g>
  <rect x="${PHONE_X}" y="${PHONE_Y}" width="${PHONE_W}" height="${PHONE_H}" rx="${PHONE_R}" ry="${PHONE_R}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
</svg>
</body></html>`;

  await renderHtmlImage(browser, { width: CANVAS_W, height: CANVAS_H, html, outPath, transparent: true });
}

async function renderCaptionOverlay(browser, { chapter, caption, tipBadge, outPath }) {
  const topChip = tipBadge
    ? `<div class="top-tip"><span class="dot"></span>${escHtml(tipBadge)}</div>`
    : `<div class="chapter">${escHtml(chapter)}</div>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body {
    margin: 0; padding: 0;
    width: ${CANVAS_W}px; height: ${CANVAS_H}px;
    background: transparent;
    font-family: ${FONT_STACK};
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  .top-wrap {
    position: absolute;
    top: 24px; left: 0; right: 0;
    display: flex; justify-content: center; align-items: center;
    height: 58px;
  }
  .chapter {
    padding: 10px 26px;
    border-radius: 999px;
    background: rgba(12, 117, 96, 0.22);
    border: 1.5px solid rgba(63, 191, 158, 0.42);
    color: #D7F2E9;
    font-size: 25px;
    font-weight: 600;
    letter-spacing: 0.04em;
    box-shadow: 0 6px 20px rgba(0,0,0,0.28);
  }
  .top-tip {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    padding: 11px 28px;
    border-radius: 999px;
    background: rgba(12, 117, 96, 0.92);
    border: 1.5px solid rgba(173, 240, 219, 0.55);
    color: #FFFFFF;
    font-size: 24px;
    font-weight: 600;
    box-shadow: 0 8px 24px rgba(0,0,0,0.38);
  }
  .top-tip .dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: #A7F3D0; flex: none;
  }
  .cap-wrap {
    position: absolute;
    top: 1726px;
    bottom: 24px;
    left: 44px;
    right: 44px;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .cap-pill {
    max-width: 980px;
    padding: 20px 36px;
    border-radius: 26px;
    background: rgba(10, 17, 15, 0.86);
    border: 1.5px solid rgba(63, 191, 158, 0.34);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    color: #F4FAF7;
    font-size: 35px;
    font-weight: 600;
    line-height: 1.38;
    text-align: center;
    text-wrap: balance;
  }
</style></head><body>
  <div class="top-wrap">${topChip}</div>
  <div class="cap-wrap"><div class="cap-pill">${escHtml(caption)}</div></div>
</body></html>`;

  await renderHtmlImage(browser, { width: CANVAS_W, height: CANVAS_H, html, outPath, transparent: true });
}

async function renderTitleCard(browser, card, outPath) {
  const pillsHtml = (card.pills || []).map(p => `<span class="pill">${escHtml(p)}</span>`).join('');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body {
    margin: 0; padding: 0;
    width: ${CANVAS_W}px; height: ${CANVAS_H}px;
    font-family: ${FONT_STACK};
    -webkit-font-smoothing: antialiased;
    background: radial-gradient(circle at 50% 24%, rgba(12,117,96,0.45), transparent 58%),
                linear-gradient(160deg, #13241E 0%, #0D1714 55%, #09110E 100%);
    color: #F2F7F5;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    text-align: center;
    overflow: hidden;
  }
  .wrap {
    width: 880px;
    display: flex; flex-direction: column;
    align-items: center; gap: 36px;
  }
  .icon {
    width: 176px; height: 176px;
    border-radius: 40px;
    box-shadow: 0 24px 60px rgba(12, 117, 96, 0.42), 0 0 0 2px rgba(63,191,158,0.28);
    overflow: hidden;
  }
  .icon svg { width: 100%; height: 100%; display: block; }
  .eyebrow {
    font-size: 26px; font-weight: 600;
    letter-spacing: 0.16em;
    color: #6CD8B8;
  }
  h1 {
    margin: 0;
    font-size: 112px; font-weight: 800;
    line-height: 1.08;
    letter-spacing: -0.01em;
    color: #FFFFFF;
  }
  .tagline {
    margin: 0;
    font-size: 46px; font-weight: 600;
    line-height: 1.38;
    color: #D7E5E0;
    text-wrap: balance;
  }
  .pills {
    display: flex; flex-wrap: wrap; justify-content: center; gap: 18px;
    margin-top: 12px;
  }
  .pill {
    padding: 16px 32px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    border: 1.5px solid rgba(108, 216, 184, 0.34);
    color: #E7F5F0;
    font-size: 30px; font-weight: 600;
  }
</style></head><body>
  <div class="wrap">
    <div class="icon">${ICON_SVG}</div>
    <div class="eyebrow">${escHtml(card.eyebrow)}</div>
    <h1>${escHtml(card.title)}</h1>
    <p class="tagline">${escHtml(card.tagline)}</p>
    <div class="pills">${pillsHtml}</div>
  </div>
</body></html>`;

  await renderHtmlImage(browser, { width: CANVAS_W, height: CANVAS_H, html, outPath, transparent: false });
}

async function renderOutroCard(browser, card, outPath) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body {
    margin: 0; padding: 0;
    width: ${CANVAS_W}px; height: ${CANVAS_H}px;
    font-family: ${FONT_STACK};
    -webkit-font-smoothing: antialiased;
    background: radial-gradient(circle at 50% 34%, rgba(12,117,96,0.44), transparent 56%),
                linear-gradient(160deg, #13241E 0%, #0D1714 55%, #09110E 100%);
    color: #F2F7F5;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    text-align: center;
    overflow: hidden;
  }
  .wrap {
    width: 880px;
    display: flex; flex-direction: column;
    align-items: center; gap: 34px;
  }
  .icon {
    width: 152px; height: 152px;
    border-radius: 36px;
    box-shadow: 0 22px 54px rgba(12, 117, 96, 0.42), 0 0 0 2px rgba(63,191,158,0.28);
    overflow: hidden;
  }
  .icon svg { width: 100%; height: 100%; display: block; }
  .eyebrow {
    font-size: 26px; font-weight: 600;
    letter-spacing: 0.14em;
    color: #6CD8B8;
  }
  h2 {
    margin: 0;
    font-size: 56px; font-weight: 700;
    line-height: 1.3;
    color: #FFFFFF;
    text-wrap: balance;
  }
  .url-box {
    margin-top: 8px;
    padding: 26px 56px;
    border-radius: 26px;
    background: #0C7560;
    border: 2px solid rgba(167, 243, 208, 0.55);
    color: #FFFFFF;
    font-size: 48px;
    font-weight: 700;
    letter-spacing: 0.02em;
    box-shadow: 0 18px 46px rgba(12, 117, 96, 0.45);
  }
  .badge {
    padding: 14px 36px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.1);
    border: 1.5px solid rgba(108, 216, 184, 0.4);
    color: #D7F2E9;
    font-size: 32px; font-weight: 600;
  }
  .foot {
    margin-top: 10px;
    font-size: 28px;
    color: #9BB4AB;
  }
</style></head><body>
  <div class="wrap">
    <div class="icon">${ICON_SVG}</div>
    <div class="eyebrow">${escHtml(card.eyebrow)}</div>
    <h2>${escHtml(card.title)}</h2>
    <div class="url-box">${escHtml(card.url)}</div>
    <div class="badge">${escHtml(card.badge)}</div>
    <div class="foot">${escHtml(card.footnote)}</div>
  </div>
</body></html>`;

  await renderHtmlImage(browser, { width: CANVAS_W, height: CANVAS_H, html, outPath, transparent: false });
}

async function renderPoster(browser, { poster, screenshotPath, outPath }) {
  const imgB64 = fs.readFileSync(screenshotPath).toString('base64');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body {
    margin: 0; padding: 0;
    width: ${CANVAS_W}px; height: ${CANVAS_H}px;
    font-family: ${FONT_STACK};
    -webkit-font-smoothing: antialiased;
    background: radial-gradient(circle at 50% 16%, rgba(12,117,96,0.45), transparent 55%),
                linear-gradient(160deg, #13241E 0%, #0D1714 60%, #09110E 100%);
    color: #FFFFFF;
    overflow: hidden;
  }
  .header {
    padding: 88px 72px 0;
    display: flex; flex-direction: column; align-items: center; text-align: center; gap: 22px;
  }
  .brand-row {
    display: inline-flex; align-items: center; gap: 18px;
  }
  .mini-icon {
    width: 64px; height: 64px; border-radius: 16px; overflow: hidden;
    box-shadow: 0 8px 22px rgba(12,117,96,0.4);
  }
  .mini-icon svg { width: 100%; height: 100%; display: block; }
  .eyebrow {
    font-size: 28px; font-weight: 700; letter-spacing: 0.14em; color: #6CD8B8;
  }
  h1 {
    margin: 0; font-size: 68px; font-weight: 800; line-height: 1.22; text-wrap: balance;
  }
  .sub {
    margin: 0; font-size: 30px; color: #BFD4CC; font-weight: 500;
  }
  .phone-stage {
    position: absolute;
    left: 50%; transform: translateX(-50%);
    top: 430px;
    width: 720px;
    border-radius: 48px;
    padding: 14px;
    background: #1A2622;
    border: 2px solid #3A524A;
    box-shadow: 0 36px 80px rgba(0,0,0,0.62);
  }
  .phone-stage img {
    display: block;
    width: 100%;
    border-radius: 36px;
  }
</style></head><body>
  <div class="header">
    <div class="brand-row">
      <div class="mini-icon">${ICON_SVG}</div>
      <div class="eyebrow">${escHtml(poster.eyebrow)}</div>
    </div>
    <h1>${escHtml(poster.headline)}</h1>
    <p class="sub">${escHtml(poster.subline)}</p>
  </div>
  <div class="phone-stage">
    <img src="data:image/png;base64,${imgB64}" alt=""/>
  </div>
</body></html>`;

  await renderHtmlImage(browser, { width: CANVAS_W, height: CANVAS_H, html, outPath, type: 'jpeg', quality: 90 });
}

async function renderMealPhoto(browser, kind, outPath) {
  // Royalty-free, clean overhead food-bowl illustration rendered via SVG to JPEG.
  const isBreakfast = kind === 'breakfast';
  const html = isBreakfast
    ? `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:720px;height:720px;overflow:hidden}</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720">
  <defs>
    <linearGradient id="tbl" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#D7C3A8"/><stop offset="100%" stop-color="#BFA482"/></linearGradient>
    <radialGradient id="bowl" cx="45%" cy="40%" r="58%"><stop offset="0%" stop-color="#FFFFFF"/><stop offset="85%" stop-color="#E8ECE9"/><stop offset="100%" stop-color="#CFD7D3"/></radialGradient>
    <radialGradient id="yogurt" cx="45%" cy="40%" r="55%"><stop offset="0%" stop-color="#FFFDF8"/><stop offset="100%" stop-color="#F1ECE0"/></radialGradient>
  </defs>
  <rect width="720" height="720" fill="url(#tbl)"/>
  <circle cx="372" cy="382" r="268" fill="rgba(45,30,15,0.22)"/>
  <circle cx="360" cy="360" r="266" fill="url(#bowl)" stroke="#DCE2DF" stroke-width="6"/>
  <circle cx="360" cy="360" r="228" fill="url(#yogurt)"/>
  <!-- Oats cluster -->
  <g fill="#D8B685" stroke="#B68F59" stroke-width="1.5">
    <ellipse cx="255" cy="275" rx="34" ry="18" transform="rotate(-22 255 275)"/>
    <ellipse cx="295" cy="245" rx="30" ry="15" transform="rotate(14 295 245)"/>
    <ellipse cx="235" cy="325" rx="32" ry="16" transform="rotate(28 235 325)"/>
    <ellipse cx="285" cy="300" rx="28" ry="14" transform="rotate(-10 285 300)"/>
    <ellipse cx="260" cy="365" rx="30" ry="15" transform="rotate(-32 260 365)"/>
  </g>
  <!-- Banana slices -->
  <g>
    <circle cx="445" cy="260" r="36" fill="#F8E7A2" stroke="#E5C968" stroke-width="3"/>
    <circle cx="495" cy="312" r="35" fill="#F8E7A2" stroke="#E5C968" stroke-width="3"/>
    <circle cx="465" cy="378" r="36" fill="#F8E7A2" stroke="#E5C968" stroke-width="3"/>
    <circle cx="445" cy="260" r="14" fill="#F3DC82"/>
    <circle cx="495" cy="312" r="14" fill="#F3DC82"/>
    <circle cx="465" cy="378" r="14" fill="#F3DC82"/>
  </g>
  <!-- Blueberries -->
  <g fill="#374B8C" stroke="#223060" stroke-width="2">
    <circle cx="365" cy="245" r="20"/><circle cx="400" cy="295" r="18"/><circle cx="352" cy="312" r="19"/>
    <circle cx="395" cy="355" r="20"/><circle cx="348" cy="382" r="17"/><circle cx="385" cy="415" r="19"/>
    <circle cx="435" cy="435" r="18"/><circle cx="330" cy="435" r="19"/>
  </g>
  <!-- Boiled egg halves -->
  <g transform="translate(290,468) rotate(-14)">
    <ellipse cx="0" cy="0" rx="58" ry="44" fill="#FFFFFF" stroke="#E2DFD5" stroke-width="3"/>
    <ellipse cx="6" cy="2" rx="28" ry="23" fill="#F5A623"/>
    <ellipse cx="0" cy="-4" rx="10" ry="7" fill="#FFD166" opacity="0.7"/>
  </g>
  <!-- Chia / seeds -->
  <g fill="#3A3A3A" opacity="0.65">
    <circle cx="330" cy="275" r="3"/><circle cx="345" cy="290" r="2.5"/><circle cx="370" cy="340" r="3"/>
    <circle cx="415" cy="330" r="2.5"/><circle cx="315" cy="395" r="3"/><circle cx="410" cy="465" r="2.5"/>
  </g>
</svg></body></html>`
    : `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:720px;height:720px;overflow:hidden}</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720">
  <defs>
    <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#C8A985"/><stop offset="50%" stop-color="#B9966E"/><stop offset="100%" stop-color="#A68259"/></linearGradient>
    <radialGradient id="ceramic" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#FAFAF8"/><stop offset="82%" stop-color="#E7ECE9"/><stop offset="100%" stop-color="#CBD4D0"/></radialGradient>
    <linearGradient id="chicken" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#E6A962"/><stop offset="55%" stop-color="#C97E3B"/><stop offset="100%" stop-color="#9E5721"/></linearGradient>
    <radialGradient id="rice" cx="50%" cy="50%" r="55%"><stop offset="0%" stop-color="#E8D8BE"/><stop offset="100%" stop-color="#CBB38E"/></radialGradient>
  </defs>
  <rect width="720" height="720" fill="url(#wood)"/>
  <g stroke="rgba(90,58,28,0.12)" stroke-width="3">
    <line x1="0" y1="120" x2="720" y2="120"/><line x1="0" y1="260" x2="720" y2="260"/>
    <line x1="0" y1="410" x2="720" y2="410"/><line x1="0" y1="560" x2="720" y2="560"/>
  </g>
  <!-- Bowl shadow & rim -->
  <circle cx="376" cy="384" r="272" fill="rgba(35,22,10,0.28)"/>
  <circle cx="360" cy="360" r="270" fill="url(#ceramic)" stroke="#D9E0DC" stroke-width="6"/>
  <circle cx="360" cy="360" r="234" fill="#F3F2EC"/>
  <!-- Brown rice quadrant (bottom-left) -->
  <path d="M 145 360 A 215 215 0 0 0 385 572 L 365 365 Z" fill="url(#rice)"/>
  <g fill="#B69971" opacity="0.65">
    <ellipse cx="220" cy="415" rx="10" ry="5" transform="rotate(20 220 415)"/>
    <ellipse cx="265" cy="450" rx="11" ry="5" transform="rotate(-15 265 450)"/>
    <ellipse cx="235" cy="475" rx="10" ry="5" transform="rotate(35 235 475)"/>
    <ellipse cx="305" cy="495" rx="11" ry="5" transform="rotate(-25 305 495)"/>
    <ellipse cx="335" cy="530" rx="10" ry="5" transform="rotate(10 335 530)"/>
    <ellipse cx="275" cy="515" rx="10" ry="5" transform="rotate(-5 275 515)"/>
    <ellipse cx="200" cy="390" rx="9" ry="4" transform="rotate(-30 200 390)"/>
    <ellipse cx="295" cy="430" rx="10" ry="5" transform="rotate(18 295 430)"/>
  </g>
  <!-- Black sesame on rice -->
  <g fill="#262626">
    <ellipse cx="245" cy="440" rx="4" ry="2.2" transform="rotate(30 245 440)"/>
    <ellipse cx="285" cy="472" rx="4" ry="2.2" transform="rotate(-20 285 472)"/>
    <ellipse cx="315" cy="455" rx="4" ry="2.2" transform="rotate(45 315 455)"/>
    <ellipse cx="262" cy="495" rx="4" ry="2.2" transform="rotate(12 262 495)"/>
    <ellipse cx="328" cy="505" rx="4" ry="2.2" transform="rotate(-35 328 505)"/>
  </g>
  <!-- Broccoli florets (top-right) -->
  <g>
    <g fill="#2F7D46" stroke="#1E5930" stroke-width="2.5">
      <circle cx="430" cy="220" r="38"/><circle cx="475" cy="245" r="36"/><circle cx="515" cy="295" r="38"/>
      <circle cx="465" cy="305" r="36"/><circle cx="520" cy="355" r="34"/><circle cx="415" cy="272" r="34"/>
    </g>
    <g fill="#45A25E">
      <circle cx="422" cy="212" r="18"/><circle cx="470" cy="236" r="17"/><circle cx="510" cy="285" r="19"/>
      <circle cx="458" cy="296" r="16"/><circle cx="515" cy="348" r="16"/><circle cx="410" cy="266" r="15"/>
    </g>
  </g>
  <!-- Sliced grilled chicken breast (top-left) -->
  <g transform="translate(278,268) rotate(-28)">
    <rect x="-126" y="-88" width="252" height="52" rx="26" fill="url(#chicken)" stroke="#8F4E1E" stroke-width="3"/>
    <rect x="-132" y="-28" width="264" height="54" rx="27" fill="url(#chicken)" stroke="#8F4E1E" stroke-width="3"/>
    <rect x="-118" y="34" width="236" height="52" rx="26" fill="url(#chicken)" stroke="#8F4E1E" stroke-width="3"/>
    <!-- Grill marks -->
    <g stroke="#5B2D0C" stroke-width="5" stroke-linecap="round" opacity="0.6">
      <line x1="-82" y1="-78" x2="-62" y2="-46"/><line x1="-22" y1="-80" x2="-2" y2="-46"/><line x1="42" y1="-78" x2="62" y2="-46"/>
      <line x1="-74" y1="-18" x2="-54" y2="16"/><line x1="-8" y1="-18" x2="12" y2="16"/><line x1="56" y1="-18" x2="76" y2="16"/>
      <line x1="-60" y1="44" x2="-42" y2="74"/><line x1="8" y1="44" x2="26" y2="74"/><line x1="68" y1="44" x2="84" y2="74"/>
    </g>
  </g>
  <!-- Avocado slices (bottom-right) -->
  <g transform="translate(472,448) rotate(24)">
    <path d="M -55 -28 Q 0 -62 60 -20 Q 12 22 -55 -28 Z" fill="#89BC55" stroke="#4D7A27" stroke-width="4"/>
    <path d="M -45 6 Q 10 -28 70 14 Q 22 56 -45 6 Z" fill="#9CCD64" stroke="#4D7A27" stroke-width="4"/>
    <path d="M -32 42 Q 20 8 78 48 Q 30 88 -32 42 Z" fill="#A9DA71" stroke="#4D7A27" stroke-width="4"/>
  </g>
  <!-- Halved soft-boiled egg (center-bottom-right) -->
  <g transform="translate(405,432) rotate(-18)">
    <ellipse cx="0" cy="0" rx="64" ry="48" fill="#FFFFFF" stroke="#E0DDD3" stroke-width="3"/>
    <ellipse cx="8" cy="2" rx="31" ry="25" fill="#F29F1D"/>
    <ellipse cx="2" cy="-5" rx="11" ry="8" fill="#FFD166" opacity="0.72"/>
  </g>
  <!-- Subtle herb flecks -->
  <g fill="#2C7A4B" opacity="0.85">
    <circle cx="245" cy="245" r="4"/><circle cx="312" cy="288" r="3.5"/><circle cx="272" cy="312" r="4"/>
    <circle cx="395" cy="402" r="3"/><circle cx="430" cy="445" r="3.5"/>
  </g>
</svg></body></html>`;

  await renderHtmlImage(browser, { width: 720, height: 720, html, outPath, type: 'jpeg', quality: 92 });
}

async function generateSharedAssets(browser, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const shellPath = path.join(workDir, 'frame-shell.png');
  const lunchPhoto = path.join(workDir, 'meal-lunch.jpg');
  const breakfastPhoto = path.join(workDir, 'meal-breakfast.jpg');

  await renderFrameShell(browser, shellPath);
  await renderMealPhoto(browser, 'lunch', lunchPhoto);
  await renderMealPhoto(browser, 'breakfast', breakfastPhoto);

  return { shellPath, lunchPhoto, breakfastPhoto };
}

async function generateLangAssets(browser, sb, workDir) {
  const dir = path.join(workDir, `assets-${sb.lang}`);
  fs.mkdirSync(dir, { recursive: true });

  const titlePath = path.join(dir, 'title.png');
  const outroPath = path.join(dir, 'outro.png');
  await renderTitleCard(browser, sb.titleCard, titlePath);
  await renderOutroCard(browser, sb.outroCard, outroPath);

  const overlays = {};
  for (const sc of sb.scenes) {
    overlays[sc.id] = [];
    for (let i = 0; i < sc.beats.length; i++) {
      const beat = sc.beats[i];
      const outPath = path.join(dir, `overlay-${sc.id}-${i}.png`);
      await renderCaptionOverlay(browser, {
        chapter: sc.chapter,
        caption: beat.caption,
        tipBadge: beat.tipBadge,
        outPath
      });
      overlays[sc.id].push(outPath);
    }
  }

  return { dir, titlePath, outroPath, overlays };
}

module.exports = {
  CANVAS_W,
  CANVAS_H,
  PHONE_W,
  PHONE_H,
  PHONE_X,
  PHONE_Y,
  generateSharedAssets,
  generateLangAssets,
  renderPoster
};
