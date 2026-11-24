# Lean Ritual Product Intro Video Generator (v2)

Reproducible generator for the ~2-minute user walkthrough videos of **Lean Ritual (薄肌日课)** in Chinese (`zh`) and English (`en`), outputting both **1080×1920 (9:16 vertical)** and **1920×1080 (16:9 widescreen)** 30fps H.264 + AAC MP4s with local neural voiceover, motion graphics, voice-ducked background music, and synced UI sound effects.

See [ASSETS.md](./ASSETS.md) for the complete asset & license manifest.

## What It Does

- Starts a disposable local `server.js` on `127.0.0.1` with a temporary `DATA_DIR` (never touches production or real user data).
- Creates a synthetic demo account (`demo@example.com`, display name `小林` / `Alex`) and seeds 3 weeks of realistic check-ins (gentle weight trend), progressive-load Push/Pull/Legs workouts, and daily meals.
- Intercepts `POST /api/ai` in Playwright so meal-photo macro estimation and AI coach reviews return instant, realistic results with zero AI API spend and zero loading/error screens.
- Records 6 human-paced mobile scenes (`390×844` @2x → `780×1688`) with tap ripples, subtle milestone focus pulses, smooth scrolling, and frame-accurate UI interaction timestamps.
- Synthesizes natural local neural narration with **Kokoro-82M** (Apache-2.0 via `sherpa-onnx`): `af_heart` (`kokoro-multi-lang-v1_0`) for English and `zf_001` (`kokoro-multi-lang-v1_1`) for Mandarin Chinese. (Optional `--tts say` fallback prefers macOS Enhanced/Premium voices if installed.)
- Generates an original warm Rhodes/ambient background music bed + tactile UI taps, transition swooshes, confirmation chimes, and callout pops (`sound_design.py`, CC0 / original), mixing BGM through `sidechaincompress` so music ducks cleanly under narration.
- Composites animated HTML/CSS title & outro cards (with brand mark, `https://leanritual.app`, and invitation-only beta badge), supersampled smooth camera zoom/pan into explained UI areas, slide-up animated captions & callout chips, live top progress bar, and curated `xfade` scene transitions (`circleopen`, `smoothleft`, `smoothup`, `fade`).
- Verifies duration (`95–135s`), resolution, codecs (`h264`/`aac`), and file size (`≤ 25 MB`) with `ffprobe`, and generates posters, 4×4 contact sheets, script markdown, and verification frames.

## Prerequisites

- Node.js `>= 22.16` and repo dependencies installed (`npm ci`)
- `ffmpeg` and `ffprobe` (e.g. `/opt/homebrew/bin/ffmpeg`)
- `uv` (manages isolated Python 3.11 environments for `sherpa-onnx`, `numpy`, and `soundfile`; downloads Kokoro models once to `~/.cache/lean-ritual-demo-video/tts`)
- Playwright (`playwright` or `playwright-core`) with Chromium installed (override via `PLAYWRIGHT_MODULE` / `CHROMIUM_PATH` if needed)

## One-Command Regenerate

```sh
npm ci && node tools/demo-video/run.js --out /tmp/lean-ritual-video
```

### Options

- `--lang zh|en|all` — choose language(s) to generate (default: `all`)
- `--formats 9x16,16x9|9x16|16x9|all` — aspect ratio cuts to render (default: `9x16,16x9`)
- `--tts kokoro|say` — narration engine (default: `kokoro`; `say` uses macOS `/usr/bin/say`)
- `--out <dir>` — output directory outside the repo (default: `/tmp/lean-ritual-demo-video`)
- `--dry-run` — seed and record only the `hook` scene to sanity-check the pipeline without composing MP4s
- `--skip-build` — skip running `node build.js` first
- `--keep-work` — keep temporary intermediate recordings/clips for inspection

## Outputs Written to `--out`

- `lean-ritual-intro-zh.mp4` / `lean-ritual-intro-en.mp4` (1080×1920 vertical)
- `lean-ritual-intro-zh-16x9.mp4` / `lean-ritual-intro-en-16x9.mp4` (1920×1080 widescreen)
- `poster-zh.jpg` / `poster-en.jpg` & `poster-zh-16x9.jpg` / `poster-en-16x9.jpg`
- `sheet-zh.jpg` / `sheet-en.jpg` & `sheet-zh-16x9.jpg` / `sheet-en-16x9.jpg` (4×4 contact sheets)
- `script-zh.md` / `script-en.md`
- `frames/<video>-frame-{1..6}.jpg`

## Files

- `run.js` — CLI orchestrator
- `storyboard.js` — Chinese & English copy, captions, callouts, camera motion specs, narration scripts, and AI mock responses
- `seed.js` — disposable local server + 3-week synthetic account seeder
- `assets.js` — Chromium-rendered animated title/outro cards, 9:16 & 16:9 frame shells, modular overlays, posters, and meal photos
- `record.js` — Playwright mobile recorder with tap ripples, focus highlights, UI event timestamps, and AI route mocks
- `tts_kokoro.py` — local Kokoro-82M neural TTS batch synthesizer (via `sherpa-onnx`)
- `sound_design.py` — procedural studio BGM & UI foley SFX synthesizer
- `compose.js` — `ffmpeg` camera zoom/pan, animated overlay compositing, `xfade` transitions, sidechain-ducked audio mastering, verification, and contact sheet generation
- `playwright-loader.js` — Playwright/Chromium discovery helper
- `ASSETS.md` — asset sources and commercial licenses
