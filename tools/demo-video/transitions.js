'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  CANVAS_W,
  CANVAS_H,
  PHONE_W,
  PHONE_H,
  PHONE_X,
  PHONE_Y,
  PHONE_R,
  TOP_BAND_H,
  CAP_BAND_H,
  W16_CANVAS_W,
  W16_CANVAS_H,
  W16_PHONE_W,
  W16_PHONE_H,
  W16_PHONE_X,
  W16_PHONE_Y,
  W16_PHONE_R,
  W16_PANEL_W,
  W16_PANEL_H
} = require('./assets');

const FFMPEG = process.env.FFMPEG_BIN || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const FPS = 30;
const FONT_STACK = `"PingFang SC", "Hiragino Sans GB", -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif`;

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function runFfmpeg(args) {
  try {
    return execFileSync(FFMPEG, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').slice(-1500);
    throw new Error(`ffmpeg failed (exit ${err.status}):\n${detail}`);
  }
}

/**
 * Split caption into kinetic tokens: English splits by word, Chinese splits into natural 2-4 char rhythmic chunks.
 */
function splitKineticTokens(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  const hasCjk = /[\u4e00-\u9fff]/.test(s);
  if (!hasCjk) {
    return s.split(/\s+/).filter(Boolean).map((w, i, arr) => (i < arr.length - 1 ? `${w}\u00A0` : w));
  }
  // Keep Latin/number runs together, group CJK into snappy 2-3 char phrases breaking at punctuation
  const raw = s.match(/[A-Za-z0-9.+-]+|[，。、；：·—\-\s]|[\u4e00-\u9fff]{1,3}/g) || [s];
  const tokens = [];
  for (const tok of raw) {
    if (/^[，。、；：·—\-]$/.test(tok) && tokens.length) {
      tokens[tokens.length - 1] += tok;
    } else if (/^\s+$/.test(tok)) {
      if (tokens.length) tokens[tokens.length - 1] += '\u00A0';
    } else {
      tokens.push(tok);
    }
  }
  return tokens;
}

/**
 * Parse callout text into static segments and animatable numeric count-up tokens (e.g. 540, 46.5, 60, 7, 14).
 */
function parseCountupHtml(text) {
  const s = String(text || '');
  const parts = s.split(/(\d+(?:\.\d+)?)/g);
  let idx = 0;
  return parts
    .map(part => {
      if (/^\d+(?:\.\d+)?$/.test(part)) {
        const decimals = part.includes('.') ? part.split('.')[1].length : 0;
        const target = Number(part);
        return `<span class="cu" data-target="${target}" data-dec="${decimals}" data-idx="${idx++}">${escHtml(part)}</span>`;
      }
      return escHtml(part);
    })
    .join('');
}

function getLayoutSpec(wide) {
  if (wide) {
    return {
      canvasW: W16_CANVAS_W,
      canvasH: W16_CANVAS_H,
      phoneW: W16_PHONE_W,
      phoneH: W16_PHONE_H,
      phoneX: W16_PHONE_X,
      phoneY: W16_PHONE_Y,
      phoneR: W16_PHONE_R
    };
  }
  return {
    canvasW: CANVAS_W,
    canvasH: CANVAS_H,
    phoneW: PHONE_W,
    phoneH: PHONE_H,
    phoneX: PHONE_X,
    phoneY: PHONE_Y,
    phoneR: PHONE_R
  };
}

/**
 * Render a deterministic 30fps transition bridge MP4 between two exact scene PNG screenshots.
 * Frame 0 matches outgoing scene's exact fixed phone placement; final frame matches incoming scene's exact placement.
 * Styles:
 *   - 'perspective_swing': 3D perspective Y-tilt swing + parallax grid/aurora + glossy emerald bezel light sweep
 *   - 'whip_blur':         High-energy scale-and-blur directional whip cut + beat-synced emerald pulse flash
 *   - 'depth_parallax':    3D depth-stack slide (X+Y+tilt) + opposing parallax grid + dual diagonal light sweep + rim glow
 */
async function renderTransitionBridge({
  browser,
  style = 'depth_parallax',
  outFramePath,
  inFramePath,
  wide = false,
  durationSec = 0.60,
  badgeLabel = '',
  outMp4,
  workDir
}) {
  const L = getLayoutSpec(wide);
  const outB64 = fs.readFileSync(outFramePath).toString('base64');
  const inB64 = fs.readFileSync(inFramePath).toString('base64');
  const totalFrames = Math.max(10, Math.round(durationSec * FPS));
  const framesDir = path.join(workDir, `bridge-${style}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(framesDir, { recursive: true });

  const bx = L.phoneX - (wide ? 11 : 14);
  const by = L.phoneY - (wide ? 11 : 14);
  const bw = L.phoneW + (wide ? 22 : 28);
  const bh = L.phoneH + (wide ? 22 : 28);
  const br = L.phoneR + (wide ? 10 : 12);

  const badgeHtml = badgeLabel
    ? `<div class="style-badge">${escHtml(badgeLabel)}</div>`
    : '';

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    width: ${L.canvasW}px; height: ${L.canvasH}px;
    overflow: hidden;
    font-family: ${FONT_STACK};
    background: linear-gradient(${wide ? '130deg' : '155deg'}, #142922 0%, #0C1714 50%, #08100E 100%);
    position: relative;
  }
  .bg-grid {
    position: absolute;
    inset: -160px;
    background-image:
      linear-gradient(rgba(116,224,193,0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(116,224,193,0.05) 1px, transparent 1px);
    background-size: 48px 48px;
    will-change: transform;
  }
  .orb-a {
    position: absolute;
    width: ${wide ? 960 : 880}px; height: ${wide ? 960 : 880}px;
    left: ${wide ? 120 : 100}px; top: ${wide ? -220 : -140}px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(18,161,132,0.38) 0%, rgba(12,117,96,0.08) 52%, transparent 72%);
  }
  .orb-b {
    position: absolute;
    width: ${wide ? 820 : 760}px; height: ${wide ? 820 : 760}px;
    right: ${wide ? -120 : -80}px; bottom: ${wide ? -240 : -180}px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(52,211,153,0.24) 0%, rgba(12,117,96,0.05) 54%, transparent 74%);
  }
  .stage {
    position: absolute; inset: 0;
    perspective: 1500px;
    transform-style: preserve-3d;
  }
  .phone-wrap {
    position: absolute;
    left: ${bx}px; top: ${by}px;
    width: ${bw}px; height: ${bh}px;
    border-radius: ${br}px;
    background: #0B1210;
    padding: ${wide ? 11 : 14}px;
    box-shadow:
      0 0 0 2.5px rgba(88, 128, 116, 0.72),
      0 28px 64px rgba(0, 0, 0, 0.56),
      0 0 42px rgba(16, 185, 129, 0.16);
    transform-origin: center center;
    overflow: hidden;
  }
  .phone-screen {
    width: 100%; height: 100%;
    border-radius: ${L.phoneR}px;
    overflow: hidden;
    position: relative;
    background: #F6F7F5;
  }
  .phone-screen img {
    width: 100%; height: 100%;
    display: block;
    object-fit: fill;
  }
  .sheen {
    position: absolute;
    inset: -30%;
    background: linear-gradient(112deg, transparent 36%, rgba(167,243,208,0.34) 48%, rgba(255,255,255,0.42) 50%, rgba(167,243,208,0.22) 53%, transparent 64%);
    pointer-events: none;
    opacity: 0;
  }
  .beat-flash {
    position: absolute; inset: 0;
    background: radial-gradient(circle at ${wide ? '30% 50%' : '50% 46%'}, rgba(52,211,153,0.34) 0%, rgba(16,185,129,0.12) 40%, transparent 72%);
    opacity: 0;
    pointer-events: none;
    mix-blend-mode: screen;
  }
  .light-bar {
    position: absolute;
    top: -15%; bottom: -15%;
    width: 240px;
    background: linear-gradient(90deg, transparent 0%, rgba(110,231,183,0.34) 50%, transparent 100%);
    transform: skewX(-16deg) translateX(-400px);
    opacity: 0;
    pointer-events: none;
  }
  .style-badge {
    position: absolute;
    top: 32px; left: 50%; transform: translateX(-50%);
    padding: 12px 26px; border-radius: 999px;
    background: rgba(10, 26, 21, 0.88);
    border: 1.5px solid rgba(110, 231, 183, 0.55);
    color: #A7F3D0; font-size: 24px; font-weight: 700; letter-spacing: 0.03em;
    z-index: 20;
  }
</style></head><body>
  <div class="bg-grid" id="grid"></div>
  <div class="orb-a" id="orba"></div>
  <div class="orb-b" id="orbb"></div>
  <div class="stage">
    <div class="phone-wrap" id="pOut">
      <div class="phone-screen"><img src="data:image/png;base64,${outB64}" alt=""/></div>
      <div class="sheen" id="sheenOut"></div>
    </div>
    <div class="phone-wrap" id="pIn" style="opacity:0">
      <div class="phone-screen"><img src="data:image/png;base64,${inB64}" alt=""/></div>
      <div class="sheen" id="sheenIn"></div>
    </div>
  </div>
  <div class="light-bar" id="lbar"></div>
  <div class="beat-flash" id="flash"></div>
  ${badgeHtml}
  <script>
    const easeInOutCubic = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    const easeOutExpo = x => x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
    const easeInCubic = x => x * x * x;
    const easeOutBack = x => {
      const c1 = 1.15;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    };
    const clamp01 = x => Math.max(0, Math.min(1, x));

    window.__setProgress = (p, style) => {
      const pOut = document.getElementById('pOut');
      const pIn = document.getElementById('pIn');
      const grid = document.getElementById('grid');
      const orba = document.getElementById('orba');
      const orbb = document.getElementById('orbb');
      const flash = document.getElementById('flash');
      const lbar = document.getElementById('lbar');
      const sheenIn = document.getElementById('sheenIn');

      // Ensure exact pixel lock at endpoints p=0 and p=1
      if (p <= 0.0001) {
        pOut.style.cssText = 'opacity:1;transform:none;filter:none;z-index:2;';
        pIn.style.cssText = 'opacity:0;transform:none;filter:none;z-index:1;';
        grid.style.transform = 'none';
        flash.style.opacity = '0';
        lbar.style.opacity = '0';
        sheenIn.style.opacity = '0';
        return;
      }
      if (p >= 0.9999) {
        pOut.style.cssText = 'opacity:0;transform:none;filter:none;z-index:1;';
        pIn.style.cssText = 'opacity:1;transform:none;filter:none;z-index:2;';
        grid.style.transform = 'none';
        flash.style.opacity = '0';
        lbar.style.opacity = '0';
        sheenIn.style.opacity = '0';
        return;
      }

      const e = easeInOutCubic(p);
      const bell = Math.sin(Math.PI * p);

      if (style === 'perspective_swing') {
        const outP = clamp01(p / 0.48);
        const inP = clamp01((p - 0.36) / 0.64);
        const eo = easeInCubic(outP);
        const ei = easeOutBack(inP);
        const eiPlain = easeOutExpo(inP);

        pOut.style.opacity = String((1 - eo).toFixed(3));
        pOut.style.transform = \`translateX(\${(-260 * eo).toFixed(1)}px) translateZ(\${(-160 * eo).toFixed(1)}px) rotateY(\${(26 * eo).toFixed(2)}deg) scale(\${(1 - 0.16 * eo).toFixed(4)})\`;
        pOut.style.filter = \`blur(\${(5.0 * eo).toFixed(2)}px)\`;
        pOut.style.zIndex = '1';

        const inScale = 0.86 + 0.14 * ei;
        const inX = 270 * (1 - eiPlain);
        const inRotY = -24 * (1 - eiPlain);
        pIn.style.opacity = String(clamp01(inP * 2.5).toFixed(3));
        pIn.style.transform = \`translateX(\${inX.toFixed(1)}px) rotateY(\${inRotY.toFixed(2)}deg) scale(\${inScale.toFixed(4)})\`;
        pIn.style.filter = \`blur(\${(4.5 * (1 - eiPlain)).toFixed(2)}px)\`;
        pIn.style.zIndex = '2';

        grid.style.transform = \`translateX(\${(-84 * bell).toFixed(1)}px)\`;
        orba.style.transform = \`translateX(\${(52 * bell).toFixed(1)}px) scale(\${(1 + 0.14 * bell).toFixed(3)})\`;
        flash.style.opacity = String((0.78 * Math.pow(bell, 2.0)).toFixed(3));

        const sheenX = -120 + 260 * inP;
        sheenIn.style.opacity = String((0.90 * Math.sin(Math.PI * inP)).toFixed(3));
        sheenIn.style.transform = \`translateX(\${sheenX.toFixed(1)}%)\`;
        lbar.style.opacity = String((0.72 * Math.pow(bell, 1.8)).toFixed(3));
        lbar.style.transform = \`skewX(-16deg) translateX(\${(-260 + (${L.canvasW} + 520) * e).toFixed(1)}px)\`;
      } else if (style === 'whip_blur') {
        const split = 0.45;
        if (p < split) {
          const u = easeInCubic(p / split);
          pOut.style.opacity = String((1 - u * 0.85).toFixed(3));
          pOut.style.transform = \`translateX(\${(-320 * u).toFixed(1)}px) scale(\${(1 + 0.11 * u).toFixed(4)})\`;
          pOut.style.filter = \`blur(\${(14 * u).toFixed(2)}px) brightness(\${(1 + 0.25 * u).toFixed(3)})\`;
          pOut.style.zIndex = '2';
          pIn.style.opacity = '0';
          pIn.style.zIndex = '1';
        } else {
          const u = easeOutExpo((p - split) / (1 - split));
          const ub = easeOutBack((p - split) / (1 - split));
          pOut.style.opacity = '0';
          pOut.style.zIndex = '1';
          pIn.style.opacity = String(clamp01(0.25 + u * 0.95).toFixed(3));
          pIn.style.transform = \`translateX(\${(300 * (1 - u)).toFixed(1)}px) scale(\${(0.88 + 0.12 * ub).toFixed(4)})\`;
          pIn.style.filter = \`blur(\${(12 * (1 - u)).toFixed(2)}px)\`;
          pIn.style.zIndex = '2';
        }
        const flashPeak = Math.exp(-Math.pow((p - split) / 0.14, 2));
        flash.style.opacity = String((0.95 * flashPeak).toFixed(3));
        grid.style.transform = \`translateX(\${(-110 * bell).toFixed(1)}px) scale(\${(1 + 0.05 * flashPeak).toFixed(3)})\`;
        lbar.style.opacity = String((0.9 * flashPeak).toFixed(3));
        lbar.style.transform = \`skewX(-22deg) translateX(\${(-240 + (${L.canvasW} + 480) * p).toFixed(1)}px)\`;
        sheenIn.style.opacity = '0';
      } else {
        // 'depth_parallax': 3D depth-stack slide + opposing parallax grid + glossy emerald light sweep
        const outP = clamp01(p / 0.58);
        const inP = clamp01((p - 0.24) / 0.76);
        const eo = easeInCubic(outP);
        const ei = easeOutExpo(inP);
        const es = easeOutBack(inP);

        pOut.style.opacity = String((1 - eo).toFixed(3));
        pOut.style.transform = \`translate3d(\${(-165 * eo).toFixed(1)}px, \${(-64 * eo).toFixed(1)}px, \${(-160 * eo).toFixed(1)}px) rotateX(\${(7 * eo).toFixed(2)}deg) rotateY(\${(16 * eo).toFixed(2)}deg) scale(\${(1 - 0.16 * eo).toFixed(4)})\`;
        pOut.style.filter = \`blur(\${(5.0 * eo).toFixed(2)}px)\`;
        pOut.style.zIndex = '1';

        pIn.style.opacity = String(clamp01(inP * 2.4).toFixed(3));
        pIn.style.transform = \`translate3d(\${(175 * (1 - ei)).toFixed(1)}px, \${(78 * (1 - ei)).toFixed(1)}px, 0px) rotateX(\${(-6 * (1 - ei)).toFixed(2)}deg) rotateY(\${(-15 * (1 - ei)).toFixed(2)}deg) scale(\${(0.86 + 0.14 * es).toFixed(4)})\`;
        pIn.style.filter = \`blur(\${(4.5 * (1 - ei)).toFixed(2)}px)\`;
        pIn.style.zIndex = '2';

        // Opposing parallax background drift
        grid.style.transform = \`translate3d(\${(86 * bell).toFixed(1)}px, \${(-34 * bell).toFixed(1)}px, 0)\`;
        orba.style.transform = \`translate(\${(-56 * bell).toFixed(1)}px, \${(36 * bell).toFixed(1)}px) scale(\${(1 + 0.14 * bell).toFixed(3)})\`;
        orbb.style.transform = \`translate(\${(48 * bell).toFixed(1)}px, \${(-28 * bell).toFixed(1)}px)\`;

        flash.style.opacity = String((0.72 * Math.pow(bell, 2.2)).toFixed(3));
        const sheenX = -110 + 240 * inP;
        sheenIn.style.opacity = String((0.92 * Math.sin(Math.PI * inP)).toFixed(3));
        sheenIn.style.transform = \`translateX(\${sheenX.toFixed(1)}%)\`;
        lbar.style.opacity = String((0.72 * Math.pow(bell, 1.7)).toFixed(3));
        lbar.style.transform = \`skewX(-18deg) translateX(\${(-260 + (${L.canvasW} + 520) * e).toFixed(1)}px)\`;
      }
    };
  </script>
</body></html>`;

  const context = await browser.newContext({ viewport: { width: L.canvasW, height: L.canvasH }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    for (let i = 0; i < totalFrames; i++) {
      const p = totalFrames === 1 ? 1 : i / (totalFrames - 1);
      await page.evaluate(({ prog, st }) => window.__setProgress(prog, st), { prog: p, st: style });
      await page.screenshot({ path: path.join(framesDir, `f-${String(i).padStart(4, '0')}.png`), type: 'png' });
    }
  } finally {
    await context.close();
  }

  runFfmpeg([
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(framesDir, 'f-%04d.png'),
    '-r', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-an',
    outMp4
  ]);
  fs.rmSync(framesDir, { recursive: true, force: true });
  return { mp4: outMp4, duration: totalFrames / FPS };
}

/**
 * Render kinetic per-word/chunk caption entrance as transparent PNG sequence (9:16 bottom band).
 * After the entrance finishes, ffmpeg holds the final frame 100% static via tpad=stop_mode=clone.
 */
async function renderKineticCaptionSeq(browser, { text, outDir, durationSec = 0.50 }) {
  fs.mkdirSync(outDir, { recursive: true });
  const tokens = splitKineticTokens(text);
  const totalFrames = Math.max(8, Math.round(durationSec * FPS));
  const tokensHtml = tokens.map((tok, i) => `<span class="tk" data-i="${i}">${escHtml(tok)}</span>`).join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body {
    margin: 0; padding: 0;
    width: ${CANVAS_W}px; height: ${CAP_BAND_H}px;
    background: transparent;
    display: flex; align-items: center; justify-content: center;
    font-family: ${FONT_STACK};
    -webkit-font-smoothing: antialiased;
  }
  .card {
    max-width: 960px; min-width: 720px;
    padding: 22px 38px;
    border-radius: 24px;
    background: rgba(9, 20, 17, 0.88);
    border: 1.5px solid rgba(116, 224, 193, 0.28);
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
    text-align: center;
    color: #F4F9F7;
    font-size: 38px; font-weight: 700; line-height: 1.36; letter-spacing: 0.01em;
  }
  .tk { display: inline-block; will-change: transform, opacity; }
</style></head><body>
  <div class="card" id="card">${tokensHtml}</div>
  <script>
    const els = [...document.querySelectorAll('.tk')];
    const n = Math.max(1, els.length);
    const easeOutBack = x => 1 + 2.1 * Math.pow(x - 1, 3) + 1.1 * Math.pow(x - 1, 2);
    const clamp01 = x => Math.max(0, Math.min(1, x));
    window.__setFrame = p => {
      const card = document.getElementById('card');
      const cp = clamp01(p / 0.35);
      card.style.opacity = String((0.15 + 0.85 * cp).toFixed(3));
      card.style.transform = \`translateY(\${(14 * (1 - cp)).toFixed(1)}px)\`;
      els.forEach((el, i) => {
        if (p >= 0.999) {
          el.style.opacity = '1';
          el.style.transform = 'none';
          return;
        }
        const start = (i / n) * 0.52;
        const local = clamp01((p - start) / 0.48);
        const e = easeOutBack(local);
        el.style.opacity = String(clamp01(local * 1.4).toFixed(3));
        el.style.transform = \`translateY(\${(22 * (1 - e)).toFixed(1)}px) scale(\${(0.92 + 0.08 * e).toFixed(4)})\`;
      });
    };
  </script>
</body></html>`;

  const context = await browser.newContext({ viewport: { width: CANVAS_W, height: CAP_BAND_H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    for (let i = 0; i < totalFrames; i++) {
      const p = totalFrames === 1 ? 1 : i / (totalFrames - 1);
      await page.evaluate(prog => window.__setFrame(prog), p);
      await page.screenshot({ path: path.join(outDir, `f-${String(i).padStart(4, '0')}.png`), type: 'png', omitBackground: true });
    }
  } finally {
    await context.close();
  }
  return { pattern: path.join(outDir, 'f-%04d.png'), frames: totalFrames, duration: totalFrames / FPS };
}

/**
 * Render animated callout pill with live number count-ups + glossy emerald sweep (9:16 top band).
 */
async function renderKineticCalloutSeq(browser, { text, outDir, durationSec = 0.60 }) {
  fs.mkdirSync(outDir, { recursive: true });
  const totalFrames = Math.max(10, Math.round(durationSec * FPS));
  const innerHtml = parseCountupHtml(text);

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body {
    margin: 0; padding: 0;
    width: ${CANVAS_W}px; height: ${TOP_BAND_H}px;
    background: transparent;
    display: flex; align-items: center; justify-content: center;
    font-family: ${FONT_STACK};
    -webkit-font-smoothing: antialiased;
  }
  .pill {
    position: relative;
    overflow: hidden;
    display: inline-flex; align-items: center; gap: 12px;
    padding: 13px 28px; border-radius: 999px;
    background: linear-gradient(135deg, rgba(12,117,96,0.96), rgba(16,158,128,0.94));
    border: 1.5px solid rgba(167,243,208,0.65);
    color: #FFFFFF; font-size: 26px; font-weight: 700;
    box-shadow: 0 10px 28px rgba(12,117,96,0.44);
    font-variant-numeric: tabular-nums;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #A7F3D0; box-shadow: 0 0 12px #A7F3D0; flex: none; }
  .sweep {
    position: absolute; inset: 0;
    background: linear-gradient(110deg, transparent 25%, rgba(255,255,255,0.42) 50%, transparent 75%);
    pointer-events: none;
  }
</style></head><body>
  <div class="pill" id="pill"><span class="dot"></span><span>${innerHtml}</span><div class="sweep" id="sweep"></div></div>
  <script>
    const nums = [...document.querySelectorAll('.cu')];
    const easeOutExpo = x => x >= 1 ? 1 : 1 - Math.pow(2, -9 * x);
    const easeOutBack = x => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);
    const clamp01 = x => Math.max(0, Math.min(1, x));
    window.__setFrame = p => {
      const pill = document.getElementById('pill');
      const sweep = document.getElementById('sweep');
      const ep = easeOutBack(clamp01(p / 0.45));
      pill.style.opacity = String(clamp01(p * 3.0).toFixed(3));
      pill.style.transform = \`translateY(\${(-18 * (1 - ep)).toFixed(1)}px) scale(\${(0.86 + 0.14 * ep).toFixed(4)})\`;
      const en = easeOutExpo(clamp01(p / 0.88));
      nums.forEach(el => {
        const target = Number(el.dataset.target);
        const dec = Number(el.dataset.dec || 0);
        const val = p >= 0.999 ? target : target * en;
        el.textContent = dec > 0 ? val.toFixed(dec) : String(Math.round(val));
      });
      const sx = -120 + 260 * p;
      sweep.style.transform = \`translateX(\${sx.toFixed(1)}%)\`;
      sweep.style.opacity = String((0.9 * Math.sin(Math.PI * p)).toFixed(3));
    };
  </script>
</body></html>`;

  const context = await browser.newContext({ viewport: { width: CANVAS_W, height: TOP_BAND_H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    for (let i = 0; i < totalFrames; i++) {
      const p = totalFrames === 1 ? 1 : i / (totalFrames - 1);
      await page.evaluate(prog => window.__setFrame(prog), p);
      await page.screenshot({ path: path.join(outDir, `f-${String(i).padStart(4, '0')}.png`), type: 'png', omitBackground: true });
    }
  } finally {
    await context.close();
  }
  return { pattern: path.join(outDir, 'f-%04d.png'), frames: totalFrames, duration: totalFrames / FPS };
}

/**
 * Render kinetic 16:9 side panel entrance (per-word headline + count-up callout pill + step dots).
 */
async function renderKineticPanel16x9Seq(browser, { chapter, caption, callout, sceneIdx, totalScenes, outDir, durationSec = 0.60 }) {
  fs.mkdirSync(outDir, { recursive: true });
  const totalFrames = Math.max(10, Math.round(durationSec * FPS));
  const cleanChapter = String(chapter || '').replace(/^\d+\s*[·•-]\s*/, '');
  const tokens = splitKineticTokens(caption);
  const tokensHtml = tokens.map((tok, i) => `<span class="tk" data-i="${i}">${escHtml(tok)}</span>`).join('');
  const calloutHtml = callout
    ? `<div class="callout" id="callout"><span class="cd"></span><span>${parseCountupHtml(callout)}</span><div class="sweep" id="sweep"></div></div>`
    : '';
  const dotsHtml = Array.from({ length: totalScenes }, (_, i) => {
    const cls = i === sceneIdx ? 'dot active' : i < sceneIdx ? 'dot done' : 'dot';
    return `<span class="${cls}"></span>`;
  }).join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body {
    margin: 0; padding: 0;
    width: ${W16_PANEL_W}px; height: ${W16_PANEL_H}px;
    background: transparent;
    font-family: ${FONT_STACK};
    -webkit-font-smoothing: antialiased;
    color: #F4F9F7;
    display: flex; flex-direction: column; justify-content: center;
  }
  .stack { display: flex; flex-direction: column; gap: 30px; max-width: 1060px; }
  .chapter {
    display: inline-flex; align-items: center; gap: 12px; align-self: flex-start;
    padding: 11px 22px; border-radius: 999px;
    background: rgba(16, 185, 129, 0.14);
    border: 1.5px solid rgba(52, 211, 153, 0.42);
    color: #A7F3D0; font-size: 24px; font-weight: 700; letter-spacing: 0.04em;
  }
  .chapter .num { color: #34D399; font-weight: 800; }
  h2 {
    margin: 0;
    font-size: 54px; font-weight: 800; line-height: 1.24; letter-spacing: -0.015em;
    color: #FFFFFF;
  }
  .tk { display: inline-block; will-change: transform, opacity; }
  .callout {
    position: relative; overflow: hidden;
    display: inline-flex; align-items: center; gap: 14px; align-self: flex-start;
    padding: 16px 30px; border-radius: 18px;
    background: linear-gradient(135deg, rgba(12,117,96,0.92), rgba(16,158,128,0.88));
    border: 1.5px solid rgba(167,243,208,0.55);
    color: #FFFFFF; font-size: 28px; font-weight: 700;
    box-shadow: 0 14px 36px rgba(12,117,96,0.34);
    font-variant-numeric: tabular-nums;
  }
  .callout .cd { width: 11px; height: 11px; border-radius: 50%; background: #A7F3D0; box-shadow: 0 0 12px #A7F3D0; flex: none; }
  .sweep {
    position: absolute; inset: 0;
    background: linear-gradient(110deg, transparent 25%, rgba(255,255,255,0.40) 50%, transparent 75%);
    pointer-events: none;
  }
  .dots { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
  .dot { width: 14px; height: 8px; border-radius: 999px; background: rgba(255, 255, 255, 0.16); }
  .dot.done { width: 18px; background: rgba(52, 211, 153, 0.55); }
  .dot.active { width: 48px; background: linear-gradient(90deg, #10B981, #6EE7B7); box-shadow: 0 0 16px rgba(52, 211, 153, 0.65); }
</style></head><body>
  <div class="stack">
    <div class="chapter" id="chap"><span class="num">${String(sceneIdx + 1).padStart(2, '0')} / ${String(totalScenes).padStart(2, '0')}</span><span>${escHtml(cleanChapter)}</span></div>
    <h2>${tokensHtml}</h2>
    ${calloutHtml}
    <div class="dots" id="dots">${dotsHtml}</div>
  </div>
  <script>
    const els = [...document.querySelectorAll('.tk')];
    const nums = [...document.querySelectorAll('.cu')];
    const n = Math.max(1, els.length);
    const easeOutBack = x => 1 + 2.1 * Math.pow(x - 1, 3) + 1.1 * Math.pow(x - 1, 2);
    const easeOutExpo = x => x >= 1 ? 1 : 1 - Math.pow(2, -9 * x);
    const clamp01 = x => Math.max(0, Math.min(1, x));
    window.__setFrame = p => {
      const chap = document.getElementById('chap');
      const cp = easeOutExpo(clamp01(p / 0.35));
      chap.style.opacity = String(cp.toFixed(3));
      chap.style.transform = \`translateX(\${(-24 * (1 - cp)).toFixed(1)}px)\`;
      els.forEach((el, i) => {
        if (p >= 0.999) { el.style.opacity = '1'; el.style.transform = 'none'; return; }
        const start = 0.06 + (i / n) * 0.44;
        const local = clamp01((p - start) / 0.45);
        const e = easeOutBack(local);
        el.style.opacity = String(clamp01(local * 1.4).toFixed(3));
        el.style.transform = \`translateY(\${(26 * (1 - e)).toFixed(1)}px)\`;
      });
      const callout = document.getElementById('callout');
      if (callout) {
        const calP = clamp01((p - 0.16) / 0.48);
        const ce = easeOutBack(calP);
        callout.style.opacity = String(clamp01(calP * 2.2).toFixed(3));
        callout.style.transform = \`translateY(\${(18 * (1 - ce)).toFixed(1)}px) scale(\${(0.92 + 0.08 * ce).toFixed(4)})\`;
        const en = easeOutExpo(clamp01((p - 0.16) / 0.78));
        nums.forEach(el => {
          const target = Number(el.dataset.target);
          const dec = Number(el.dataset.dec || 0);
          const val = p >= 0.999 ? target : target * en;
          el.textContent = dec > 0 ? val.toFixed(dec) : String(Math.round(val));
        });
        const sweep = document.getElementById('sweep');
        if (sweep) {
          sweep.style.transform = \`translateX(\${(-120 + 260 * p).toFixed(1)}%)\`;
          sweep.style.opacity = String((0.85 * Math.sin(Math.PI * p)).toFixed(3));
        }
      }
      const dots = document.getElementById('dots');
      dots.style.opacity = String(clamp01(p * 2.5).toFixed(3));
    };
  </script>
</body></html>`;

  const context = await browser.newContext({ viewport: { width: W16_PANEL_W, height: W16_PANEL_H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    for (let i = 0; i < totalFrames; i++) {
      const p = totalFrames === 1 ? 1 : i / (totalFrames - 1);
      await page.evaluate(prog => window.__setFrame(prog), p);
      await page.screenshot({ path: path.join(outDir, `f-${String(i).padStart(4, '0')}.png`), type: 'png', omitBackground: true });
    }
  } finally {
    await context.close();
  }
  return { pattern: path.join(outDir, 'f-%04d.png'), frames: totalFrames, duration: totalFrames / FPS };
}

module.exports = {
  splitKineticTokens,
  parseCountupHtml,
  renderTransitionBridge,
  renderKineticCaptionSeq,
  renderKineticCalloutSeq,
  renderKineticPanel16x9Seq
};
