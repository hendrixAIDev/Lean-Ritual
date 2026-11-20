# Lean Ritual Product Intro Video Generator

Reproducible generator for the ~2-minute vertical (1080×1920, 30fps, H.264 + AAC) user walkthrough videos of **Lean Ritual (薄肌日课)** in Chinese (`zh`) and English (`en`), each with both captions-only and macOS `say` voiceover variants.

## What It Does

- Starts a disposable local `server.js` on `127.0.0.1` with a temporary `DATA_DIR` (never touches production or real user data).
- Creates a synthetic demo account (`demo@example.com`, display name `小林` / `Alex`) and seeds 3 weeks of realistic check-ins (gentle weight trend), progressive-load Push/Pull/Legs workouts, and daily meals.
- Intercepts `POST /api/ai` in Playwright so meal-photo macro estimation and AI coach reviews return instant, realistic results with zero AI API spend.
- Records 6 human-paced mobile scenes (`390×844` @2x → `780×1688`) with an injected tap-ripple overlay, smooth scrolling, and realistic typing delays.
- Composites title/outro cards, rounded phone bezel, chapter badges, burned-in captions (bottom-safe area, zero overlap with app controls), light 0.35s crossfades, and macOS `say` voiceover via `ffmpeg`.
- Verifies duration (`100–130s`), resolution (`1080×1920`), codecs (`h264`/`aac`), and size (`≤ 25 MB`) with `ffprobe`, and extracts 6 verification frames per video into `frames/`.

## Prerequisites

- Node.js `>= 22.16` and repo dependencies installed (`npm ci`)
- `ffmpeg` and `ffprobe` (e.g. `/opt/homebrew/bin/ffmpeg`)
- Playwright (`playwright` or `playwright-core`) with Chromium installed (override via `PLAYWRIGHT_MODULE` / `CHROMIUM_PATH` if needed)
- macOS `/usr/bin/say` with `Tingting` (`zh_CN`) and `Samantha` (`en_US`) voices

## One-Command Regenerate

```sh
npm ci && node tools/demo-video/run.js --out /tmp/lean-ritual-video
```

### Options

- `--lang zh|en|all` — choose language(s) to generate (default: `all`)
- `--out <dir>` — output directory outside the repo (default: `/tmp/lean-ritual-demo-video`)
- `--dry-run` — seed and record only the `hook` scene to sanity-check the pipeline without composing MP4s
- `--skip-build` — skip running `node build.js` first
- `--keep-work` — keep temporary intermediate recordings/clips for inspection

## Outputs Written to `--out`

- `lean-ritual-intro-zh.mp4` / `lean-ritual-intro-zh-voice.mp4`
- `lean-ritual-intro-en.mp4` / `lean-ritual-intro-en-voice.mp4`
- `poster-zh.jpg` / `poster-en.jpg`
- `script-zh.md` / `script-en.md`
- `frames/<video>-frame-{1..6}.jpg`

## Files

- `run.js` — CLI orchestrator
- `storyboard.js` — Chinese & English copy, captions, voiceover scripts, and AI mock responses
- `seed.js` — disposable local server + 3-week synthetic account seeder
- `assets.js` — Chromium-rendered title/outro cards, phone bezel mask, caption pills, posters, and royalty-free meal photos
- `record.js` — Playwright mobile recorder with tap-ripple injection and AI route mocks
- `compose.js` — `say` TTS synthesis, `ffmpeg` compositing/crossfading, `ffprobe` verification, and frame extraction
- `playwright-loader.js` — Playwright/Chromium discovery helper
