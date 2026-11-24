#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolvePlaywright } = require('./playwright-loader');
const { STORYBOARDS, formatScriptMarkdown } = require('./storyboard');
const { generateSharedAssets, generateLangAssets, renderPoster } = require('./assets');
const { seedDemoAccount } = require('./seed');
const { recordAllScenes } = require('./record');
const { synthesizeAllVoices, composeLanguageVideo, probeMedia } = require('./compose');

const ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  const opts = {
    langs: ['zh', 'en'],
    formats: ['9x16', '16x9'],
    tts: 'kokoro',
    outDir: path.join(os.tmpdir(), 'lean-ritual-demo-video'),
    keepWork: false,
    skipBuild: false,
    dryRun: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lang' && argv[i + 1]) {
      const v = argv[++i];
      opts.langs = v === 'all' ? ['zh', 'en'] : v.split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--formats' && argv[i + 1]) {
      const v = argv[++i];
      opts.formats = v === 'all' ? ['9x16', '16x9'] : v.split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--tts' && argv[i + 1]) {
      opts.tts = argv[++i].trim();
    } else if (a === '--out' && argv[i + 1]) {
      opts.outDir = path.resolve(argv[++i]);
    } else if (a === '--keep-work') {
      opts.keepWork = true;
    } else if (a === '--skip-build') {
      opts.skipBuild = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '-h' || a === '--help') {
      console.log(
        `Usage: node tools/demo-video/run.js [--lang zh|en|all] [--formats 9x16,16x9] [--tts kokoro|say] [--out <dir>] [--dry-run] [--skip-build] [--keep-work]`
      );
      process.exit(0);
    }
  }
  for (const l of opts.langs) {
    if (!STORYBOARDS[l]) throw new Error(`Unsupported language: ${l} (use zh, en, or all)`);
  }
  for (const f of opts.formats) {
    if (!['9x16', '16x9'].includes(f)) throw new Error(`Unsupported format: ${f} (use 9x16, 16x9, or all)`);
  }
  if (!['kokoro', 'say'].includes(opts.tts)) {
    throw new Error(`Unsupported TTS engine: ${opts.tts} (use kokoro or say)`);
  }
  return opts;
}

function ensureBuilt() {
  const res = spawnSync(process.execPath, ['build.js'], { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) throw new Error('build.js failed');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.skipBuild) ensureBuilt();

  fs.mkdirSync(opts.outDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-ritual-video-work-'));
  console.log(`Output dir: ${opts.outDir}`);
  console.log(`Work dir:   ${workDir}`);
  console.log(`Formats:    ${opts.formats.join(', ')} | TTS: ${opts.tts}`);

  const { chromium, executablePath, modulePath } = resolvePlaywright();
  console.log(`Playwright: ${modulePath}`);
  console.log(`Chromium:   ${executablePath}`);

  const assetBrowser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox']
  });
  // Chromium screencast needs --force-device-scale-factor=2 so 390x844 @2x fills 780x1688 cleanly.
  const recordBrowser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--force-device-scale-factor=2']
  });

  const summary = [];
  try {
    const shared = await generateSharedAssets(assetBrowser, workDir, opts.formats);

    for (const lang of opts.langs) {
      const sb = STORYBOARDS[lang];
      const compDir = path.join(workDir, `compose-${lang}`);
      fs.mkdirSync(compDir, { recursive: true });

      let preSynth = null;
      let titleDur = sb.titleCard.duration;
      let outroDur = sb.outroCard.duration;

      if (!opts.dryRun) {
        console.log(`\n=== [${lang}] Synthesizing neural narration (${opts.tts}) ===`);
        preSynth = synthesizeAllVoices({ sb, compDir, ttsEngine: opts.tts });
        console.log(`  voice: ${preSynth.voiceLabel}`);
        titleDur = Math.max(sb.titleCard.duration, preSynth.cues.title.duration + 0.85);
        outroDur = Math.max(sb.outroCard.duration, preSynth.cues.outro.duration + 1.15);
      }

      console.log(`=== [${lang}] Generating animated cards, overlays & seeding synthetic account ===`);
      const langAssets = opts.dryRun
        ? null
        : await generateLangAssets(assetBrowser, sb, workDir, { formats: opts.formats, titleDur, outroDur });
      const seeded = await seedDemoAccount(assetBrowser, sb, shared.breakfastPhoto);

      try {
        if (opts.dryRun) {
          console.log(`=== [${lang}] Dry run: recording hook scene only ===`);
          const recorded = await recordAllScenes({
            browser: recordBrowser,
            srv: seeded.srv,
            storageState: seeded.storageState,
            uid: seeded.uid,
            sb,
            workDir,
            lunchPhotoPath: shared.lunchPhoto,
            onlyScenes: ['hook']
          });
          const hookInfo = probeMedia(recorded[0].videoPath);
          summary.push({
            file: `[dry-run] ${lang}/hook.webm`,
            duration: `${hookInfo.duration.toFixed(1)}s`,
            resolution: `${hookInfo.video.width}x${hookInfo.video.height}`,
            codecs: hookInfo.video.codec,
            sizeMB: `${(hookInfo.sizeBytes / 1048576).toFixed(2)} MB`
          });
          continue;
        }

        console.log(`=== [${lang}] Recording 6 live walkthrough scenes ===`);
        const recorded = await recordAllScenes({
          browser: recordBrowser,
          srv: seeded.srv,
          storageState: seeded.storageState,
          uid: seeded.uid,
          sb,
          workDir,
          lunchPhotoPath: shared.lunchPhoto
        });

        const hookScene = recorded.find(r => r.id === 'hook');
        if (opts.formats.includes('9x16')) {
          const posterPath = path.join(opts.outDir, `poster-${lang}.jpg`);
          await renderPoster(assetBrowser, {
            poster: sb.poster,
            screenshotPath: hookScene.posterShotPath,
            outPath: posterPath,
            wide: false
          });
          summary.push({
            file: path.basename(posterPath),
            duration: '-',
            resolution: '1080x1920',
            codecs: 'jpeg',
            sizeMB: `${(fs.statSync(posterPath).size / 1048576).toFixed(2)} MB`
          });
        }
        if (opts.formats.includes('16x9')) {
          const posterWidePath = path.join(opts.outDir, `poster-${lang}-16x9.jpg`);
          await renderPoster(assetBrowser, {
            poster: sb.poster,
            screenshotPath: hookScene.posterShotPath,
            outPath: posterWidePath,
            wide: true
          });
          summary.push({
            file: path.basename(posterWidePath),
            duration: '-',
            resolution: '1920x1080',
            codecs: 'jpeg',
            sizeMB: `${(fs.statSync(posterWidePath).size / 1048576).toFixed(2)} MB`
          });
        }

        console.log(`=== [${lang}] Composing final MP4s (${opts.formats.join(', ')}) + ducked BGM/SFX + contact sheets ===`);
        const composed = composeLanguageVideo({
          sb,
          recordedScenes: recorded,
          langAssets,
          sharedAssets: shared,
          workDir,
          outDir: opts.outDir,
          formats: opts.formats,
          ttsEngine: opts.tts,
          preSynth
        });

        const scriptPath = path.join(opts.outDir, `script-${lang}.md`);
        fs.writeFileSync(
          scriptPath,
          formatScriptMarkdown(sb, composed.timeline, { voiceLabel: composed.voiceLabel }),
          'utf8'
        );

        for (const out of composed.outputs) {
          summary.push({
            file: path.basename(out.path),
            duration: `${out.info.duration.toFixed(1)}s`,
            resolution: `${out.info.video.width}x${out.info.video.height}@${Math.round(out.info.video.fps)}fps`,
            codecs: `${out.info.video.codec}/${out.info.audio.codec}`,
            sizeMB: `${(out.info.sizeBytes / 1048576).toFixed(2)} MB`
          });
          summary.push({
            file: path.basename(out.sheetPath),
            duration: '-',
            resolution: '4x4 sheet',
            codecs: 'jpeg',
            sizeMB: `${(fs.statSync(out.sheetPath).size / 1048576).toFixed(2)} MB`
          });
        }
        summary.push({
          file: path.basename(scriptPath),
          duration: '-',
          resolution: '-',
          codecs: 'markdown',
          sizeMB: `${(fs.statSync(scriptPath).size / 1024).toFixed(1)} KB`
        });
      } finally {
        await seeded.srv.stop();
      }
    }

    console.log('\n=== DONE ===');
    console.table(summary);
  } finally {
    await recordBrowser.close();
    await assetBrowser.close();
    if (!opts.keepWork) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
