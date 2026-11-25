'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_ENV_FILE = path.join(os.homedir(), '.config', 'lean-ritual', 'gemini.env');
const DEFAULT_MODEL_ID = 'gemini-3.8-flash-tts';
const DEFAULT_VOICE_NAME = 'Leda';
const DEFAULT_STYLE_PROMPT = 'cheerful, motivating female fitness coach, energetic and warm, encouraging, natural Mandarin, brisk upbeat pace';
const FFMPEG = process.env.FFMPEG_BIN || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const FFPROBE = process.env.FFPROBE_BIN || (fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');

function runBin(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').slice(-1500);
    throw new Error(`${bin} failed (exit ${err.status}):\n${detail}`);
  }
}

function getEnvFilePath() {
  return process.env.GEMINI_ENV_FILE || DEFAULT_ENV_FILE;
}

function parseApiKeyFromEnvText(text) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/);
    if (!match) continue;
    let val = match[1].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    val = val.trim();
    if (val) return val;
  }
  return null;
}

/**
 * Load Gemini API key from process.env.GEMINI_API_KEY or ~/.config/lean-ritual/gemini.env.
 * Never logs, prints, or embeds the key in error messages.
 */
function loadGeminiApiKey() {
  const fromEnv = (process.env.GEMINI_API_KEY || '').trim();
  if (fromEnv) return fromEnv;

  const envPath = getEnvFilePath();
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const parsed = parseApiKeyFromEnvText(content);
    if (parsed) return parsed;
  }
  return null;
}

function hasGeminiApiKey() {
  return Boolean(loadGeminiApiKey());
}

function requireGeminiApiKey() {
  const key = loadGeminiApiKey();
  if (!key) {
    throw new Error(
      `Gemini API key not found. Set GEMINI_API_KEY in the environment or add GEMINI_API_KEY=... to ${getEnvFilePath()}.`
    );
  }
  return key;
}

function getCacheDir() {
  const base = process.env.DEMO_VIDEO_TTS_CACHE
    ? path.resolve(process.env.DEMO_VIDEO_TTS_CACHE)
    : path.join(os.homedir(), '.cache', 'lean-ritual-demo-video', 'tts');
  return path.join(base, 'gemini');
}

function computeCacheKey({ text, voiceName, modelId, stylePrompt }) {
  const payload = JSON.stringify({
    v: 3,
    text,
    voiceName,
    modelId,
    stylePrompt: stylePrompt || ''
  });
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function probeDuration(wavPath) {
  const out = runBin(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    wavPath
  ]);
  return Number(JSON.parse(out).format?.duration || 0);
}

function parsePcmSampleRate(mimeType) {
  const m = String(mimeType || '').match(/rate=(\d+)/i);
  const rate = m ? Number(m[1]) : 24000;
  return Number.isFinite(rate) && rate >= 8000 && rate <= 96000 ? rate : 24000;
}

function isWavPayload(buf, mimeType) {
  if (buf && buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WAVE') {
    return true;
  }
  return /^audio\/(?:x-)?wav\b/i.test(String(mimeType || ''));
}

/**
 * Decode Gemini audio response (either RIFF WAV with optional trailing C2PA chunk
 * on Gemini 3.8 models, or raw s16le mono PCM on Gemini 2.5/3.1 models) to 48kHz
 * stereo PCM WAV, peak-normalize to -1.5 dBFS, and apply 8ms edge micro-fades.
 */
function normalizeAudioToWav(rawPath, wavPath, { isWav = false, sampleRate = 24000 } = {}) {
  const tmpDecoded = wavPath.replace(/\.wav$/, '.tmp-dec.wav');
  try {
    const decodeArgs = isWav
      ? ['-y', '-i', rawPath, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', tmpDecoded]
      : ['-y', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', rawPath, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', tmpDecoded];
    runBin(FFMPEG, decodeArgs);

    const dur = probeDuration(tmpDecoded);
    let maxDb = -1.5;
    const vd = spawnSync(FFMPEG, ['-hide_banner', '-i', tmpDecoded, '-af', 'volumedetect', '-f', 'null', '-'], {
      encoding: 'utf8'
    });
    const m = (vd.stderr || '').match(/max_volume:\s*([-\d.]+)\s*dB/);
    if (m) maxDb = Number(m[1]);

    const gainDb = Number.isFinite(maxDb) && maxDb > -60 ? Math.min(18, -1.5 - maxDb) : 0;
    const fadeOutStart = Math.max(0.02, dur - 0.010);

    runBin(FFMPEG, [
      '-y',
      '-i', tmpDecoded,
      '-af',
      `volume=${gainDb.toFixed(2)}dB,afade=t=in:st=0:d=0.008,afade=t=out:st=${fadeOutStart.toFixed(4)}:d=0.008`,
      '-ar', '48000',
      '-ac', '2',
      '-c:a', 'pcm_s16le',
      wavPath
    ]);
  } finally {
    fs.rmSync(tmpDecoded, { force: true });
  }
  return probeDuration(wavPath);
}

async function generateAudioFromApi({ modelId, voiceName, stylePrompt, text }) {
  const apiKey = requireGeminiApiKey();
  const url = `${API_BASE}/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const supportsSpeechMetadata = /^gemini-3\./i.test(modelId);
  const part = supportsSpeechMetadata
    ? {
        text,
        ...(stylePrompt ? { speechMetadata: { style: stylePrompt } } : {})
      }
    : {
        text: stylePrompt ? `Speak as a ${stylePrompt}: ${text}` : text
      };
  const reqBody = {
    contents: [{ role: 'user', parts: [part] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName }
        }
      }
    }
  };

  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
      });
      if (!res.ok) {
        let errText = '';
        try {
          errText = (await res.text()).slice(0, 800);
        } catch {}
        errText = errText.split(apiKey).join('[REDACTED]');
        const err = new Error(`Gemini TTS ${modelId} failed (HTTP ${res.status}): ${errText}`);
        err.status = res.status;
        const retryMatch = errText.match(/Please retry in\s+([\d.]+)s/i);
        if (retryMatch) {
          err.retryAfterMs = Math.min(70000, Math.ceil(Number(retryMatch[1]) * 1000) + 1000);
        }
        throw err;
      }
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const audioPart = parts.find(p => p.inlineData?.data);
      if (!audioPart) {
        throw new Error(`Gemini TTS ${modelId} returned no inline audio data`);
      }
      const audioBuf = Buffer.from(audioPart.inlineData.data, 'base64');
      if (audioBuf.length < 1024) {
        throw new Error(`Gemini TTS ${modelId} returned unexpectedly small audio (${audioBuf.length} bytes)`);
      }
      const mimeType = audioPart.inlineData.mimeType || '';
      const usage = data.usageMetadata || {};
      return {
        audioBuf,
        isWav: isWavPayload(audioBuf, mimeType),
        sampleRate: parsePcmSampleRate(mimeType),
        promptTokens: Number(usage.promptTokenCount || 0),
        audioTokens: Number(usage.candidatesTokenCount || 0)
      };
    } catch (err) {
      const safeMsg = String(err?.message || err).split(apiKey).join('[REDACTED]');
      lastErr = new Error(safeMsg);
      const retryable = !err.status || err.status === 429 || err.status >= 500;
      if (attempt < 4 && retryable) {
        const delayMs = err.retryAfterMs || (err.status === 429 ? 20000 * attempt : 1500 * attempt);
        if (err.status === 429) {
          console.log(`  [gemini] rate limit (10 RPM), waiting ${(delayMs / 1000).toFixed(1)}s before retry...`);
        }
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

async function synthesizeLine({
  text,
  voiceName = DEFAULT_VOICE_NAME,
  modelId = DEFAULT_MODEL_ID,
  stylePrompt = DEFAULT_STYLE_PROMPT,
  outWav,
  forceRefresh = false
}) {
  if (!voiceName) throw new Error('Gemini voiceName is required');
  const cacheDir = getCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });

  const hash = computeCacheKey({ text, voiceName, modelId, stylePrompt });
  const cachedWav = path.join(cacheDir, `${hash}.wav`);
  const cachedMeta = path.join(cacheDir, `${hash}.meta.json`);

  let cached = false;
  let duration = 0;
  let promptTokens = 0;
  let audioTokens = 0;

  if (!forceRefresh && fs.existsSync(cachedWav) && fs.statSync(cachedWav).size > 1000) {
    cached = true;
    duration = probeDuration(cachedWav);
    if (fs.existsSync(cachedMeta)) {
      try {
        const meta = JSON.parse(fs.readFileSync(cachedMeta, 'utf8'));
        promptTokens = Number(meta.promptTokens || 0);
        audioTokens = Number(meta.audioTokens || 0);
      } catch {}
    }
  } else {
    const res = await generateAudioFromApi({ modelId, voiceName, stylePrompt, text });
    const tmpRaw = path.join(cacheDir, `${hash}.tmp.${res.isWav ? 'wav' : 'pcm'}`);
    try {
      fs.writeFileSync(tmpRaw, res.audioBuf);
      duration = normalizeAudioToWav(tmpRaw, cachedWav, {
        isWav: res.isWav,
        sampleRate: res.sampleRate
      });
    } finally {
      fs.rmSync(tmpRaw, { force: true });
    }
    promptTokens = res.promptTokens;
    audioTokens = res.audioTokens;
    fs.writeFileSync(
      cachedMeta,
      JSON.stringify(
        {
          hash,
          modelId,
          voiceName,
          stylePrompt,
          textLength: text.length,
          promptTokens,
          audioTokens,
          duration,
          createdAt: new Date().toISOString()
        },
        null,
        2
      ),
      'utf8'
    );
  }

  if (outWav) {
    fs.mkdirSync(path.dirname(outWav), { recursive: true });
    fs.copyFileSync(cachedWav, outWav);
  }

  return {
    wav: outWav || cachedWav,
    duration,
    cached,
    textLength: text.length,
    promptTokensNew: cached ? 0 : promptTokens,
    audioTokensNew: cached ? 0 : audioTokens,
    audioTokensCached: cached ? audioTokens : 0,
    hash
  };
}

async function synthesizeBatch({
  items,
  voiceName = DEFAULT_VOICE_NAME,
  modelId = DEFAULT_MODEL_ID,
  stylePrompt = DEFAULT_STYLE_PROMPT
}) {
  const cues = {};
  let apiCalls = 0;
  let cacheHits = 0;
  let textCharsTotal = 0;
  let textCharsNew = 0;
  let promptTokensNew = 0;
  let audioTokensNew = 0;
  let audioTokensCached = 0;

  for (const item of items) {
    const res = await synthesizeLine({
      text: item.text,
      voiceName,
      modelId,
      stylePrompt: item.stylePrompt || stylePrompt,
      outWav: item.outWav
    });
    cues[item.id] = { wav: res.wav, duration: res.duration };
    textCharsTotal += res.textLength;
    promptTokensNew += res.promptTokensNew;
    audioTokensNew += res.audioTokensNew;
    audioTokensCached += res.audioTokensCached;
    if (res.cached) {
      cacheHits++;
    } else {
      apiCalls++;
      textCharsNew += res.textLength;
    }
  }

  return {
    voiceLabel: `Gemini TTS (${modelId} · ${voiceName})`,
    cues,
    stats: {
      provider: 'gemini',
      apiCalls,
      cacheHits,
      textCharsTotal,
      textCharsNew,
      promptTokensNew,
      audioTokensNew,
      audioTokensCached
    }
  };
}

module.exports = {
  DEFAULT_ENV_FILE,
  DEFAULT_MODEL_ID,
  DEFAULT_VOICE_NAME,
  DEFAULT_STYLE_PROMPT,
  loadGeminiApiKey,
  hasGeminiApiKey,
  requireGeminiApiKey,
  getCacheDir,
  computeCacheKey,
  normalizeAudioToWav,
  synthesizeLine,
  synthesizeBatch
};
