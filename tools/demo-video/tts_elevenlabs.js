'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const API_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_ENV_FILE = path.join(os.homedir(), '.config', 'lean-ritual', 'elevenlabs.env');
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
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
  return process.env.ELEVENLABS_ENV_FILE || DEFAULT_ENV_FILE;
}

function parseApiKeyFromEnvText(text) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*(.*)$/);
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
 * Load ElevenLabs API key from process.env.ELEVENLABS_API_KEY or ~/.config/lean-ritual/elevenlabs.env.
 * Never logs, prints, or embeds the key in error messages.
 */
function loadElevenLabsApiKey() {
  const fromEnv = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (fromEnv) return fromEnv;

  const envPath = getEnvFilePath();
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const parsed = parseApiKeyFromEnvText(content);
    if (parsed) return parsed;
  }
  return null;
}

function hasElevenLabsApiKey() {
  return Boolean(loadElevenLabsApiKey());
}

function requireElevenLabsApiKey() {
  const key = loadElevenLabsApiKey();
  if (!key) {
    throw new Error(
      `ElevenLabs API key not found. Set ELEVENLABS_API_KEY in the environment or add ELEVENLABS_API_KEY=... to ${getEnvFilePath()}.`
    );
  }
  return key;
}

function getCacheDir() {
  const base = process.env.DEMO_VIDEO_TTS_CACHE
    ? path.resolve(process.env.DEMO_VIDEO_TTS_CACHE)
    : path.join(os.homedir(), '.cache', 'lean-ritual-demo-video', 'tts');
  return path.join(base, 'elevenlabs');
}

function computeCacheKey({ text, voiceId, modelId, outputFormat, voiceSettings }) {
  const payload = JSON.stringify({
    v: 1,
    text,
    voiceId,
    modelId,
    outputFormat,
    voiceSettings: voiceSettings || {}
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

/**
 * Decode ElevenLabs MP3 to 48kHz stereo PCM WAV, apply 8ms edge micro-fades,
 * and peak-normalize to -1.5 dBFS to match Kokoro levels without clipping initial consonants.
 */
function normalizeMp3ToWav(mp3Path, wavPath) {
  const tmpDecoded = wavPath.replace(/\.wav$/, '.tmp-dec.wav');
  try {
    // Pass 1: decode to 48kHz stereo PCM intact (preserve voiceless consonant onsets cleanly)
    runBin(FFMPEG, [
      '-y',
      '-i', mp3Path,
      '-ar', '48000',
      '-ac', '2',
      '-c:a', 'pcm_s16le',
      tmpDecoded
    ]);

    const dur = probeDuration(tmpDecoded);
    // Measure max peak volume so we normalize to -1.5 dBFS cleanly
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

function sanitizeErrorText(text, secrets = [], maxLen = 240) {
  let s = String(text || '');
  // Redact all known secrets (raw & URL-encoded) on the FULL string BEFORE any truncation.
  for (const secret of secrets) {
    if (!secret) continue;
    const raw = String(secret);
    s = s.split(raw).join('[REDACTED]');
    try {
      const encoded = encodeURIComponent(raw);
      if (encoded && encoded !== raw) s = s.split(encoded).join('[REDACTED]');
    } catch {}
  }
  s = s.replace(/(https?:\/\/[^\s?#"']+)\?[^\s"'<>)]*/gi, '$1?[REDACTED]');
  s = s.replace(/([?&](?:key|api_key|authorization|signature|token|secret)=)[^&\s"'<>)]+/gi, '$1[REDACTED]');
  s = s.replace(/\b(xi-api-key|x-goog-api-key|authorization)\s*[:=]\s*["']?[^\s"',;}\]]+["']?/gi, '$1: [REDACTED]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  s = s.replace(/\bsk_[0-9A-Za-z_-]{10,}/g, '[REDACTED]');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) {
    s = `${s.slice(0, maxLen)}…`;
  }
  return s;
}

function extractSafeHttpErrorSummary(rawBody, secrets = []) {
  const full = String(rawBody || '');
  if (!full.trim()) return 'no error details';
  try {
    const parsed = JSON.parse(full);
    const detail = parsed?.detail;
    if (typeof detail === 'string' && detail.trim()) {
      return sanitizeErrorText(detail, secrets, 200);
    }
    if (detail && typeof detail === 'object') {
      const bits = [];
      if (detail.status) bits.push(sanitizeErrorText(detail.status, secrets, 60));
      if (typeof detail.message === 'string' && detail.message.trim()) {
        bits.push(sanitizeErrorText(detail.message, secrets, 200));
      }
      if (bits.length) return bits.join(' - ');
    }
    if (parsed?.error && typeof parsed.error === 'object' && parsed.error.message) {
      return sanitizeErrorText(parsed.error.message, secrets, 200);
    }
  } catch {}
  return 'provider error body omitted';
}

async function apiRequest(endpoint, { method = 'GET', body = null, accept = 'application/json', fetchImpl = globalThis.fetch } = {}) {
  const apiKey = requireElevenLabsApiKey();
  const headers = {
    'xi-api-key': apiKey,
    Accept: accept
  };
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetchImpl(`${API_BASE}${endpoint}`, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    const safeEndpoint = String(endpoint).split('?')[0];
    throw new Error(`ElevenLabs API ${method} ${safeEndpoint} network error: ${sanitizeErrorText(err?.message || err, [apiKey], 240)}`);
  }
  if (!res.ok) {
    let rawErrText = '';
    try {
      rawErrText = await res.text();
    } catch {}
    const safeSummary = extractSafeHttpErrorSummary(rawErrText, [apiKey]);
    const safeEndpoint = String(endpoint).split('?')[0];
    const err = new Error(`ElevenLabs API ${method} ${safeEndpoint} failed (HTTP ${res.status}): ${safeSummary}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function getAccountSubscription() {
  const res = await apiRequest('/user/subscription');
  return res.json();
}

async function listMyVoices() {
  const res = await apiRequest('/voices');
  const data = await res.json();
  return data.voices || [];
}

async function searchSharedVoices({
  language = 'zh',
  pageSize = 30,
  category = '',
  gender = '',
  search = '',
  sort = 'usage_character_count_1y'
} = {}) {
  const params = new URLSearchParams();
  if (language) params.set('language', language);
  if (pageSize) params.set('page_size', String(pageSize));
  if (category) params.set('category', category);
  if (gender) params.set('gender', gender);
  if (search) params.set('search', search);
  if (sort) params.set('sort', sort);
  const res = await apiRequest(`/shared-voices?${params.toString()}`);
  const data = await res.json();
  return data.voices || [];
}

async function addSharedVoice(publicOwnerId, voiceId, newName) {
  const res = await apiRequest(`/voices/add/${encodeURIComponent(publicOwnerId)}/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    body: { new_name: newName }
  });
  return res.json();
}

async function synthesizeLine({
  text,
  voiceId,
  modelId = DEFAULT_MODEL_ID,
  outputFormat = DEFAULT_OUTPUT_FORMAT,
  voiceSettings = { stability: 0.52, similarity_boost: 0.78, style: 0.15, use_speaker_boost: true },
  outWav,
  outMp3 = null
}) {
  if (!voiceId) throw new Error('ElevenLabs voiceId is required');
  const cacheDir = getCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });

  const hash = computeCacheKey({ text, voiceId, modelId, outputFormat, voiceSettings });
  const cachedWav = path.join(cacheDir, `${hash}.wav`);
  const cachedMp3 = path.join(cacheDir, `${hash}.mp3`);
  const cachedMeta = path.join(cacheDir, `${hash}.meta.json`);

  let cached = false;
  let charsBilled = 0;
  let duration = 0;

  if (fs.existsSync(cachedWav) && fs.statSync(cachedWav).size > 1000) {
    cached = true;
    duration = probeDuration(cachedWav);
    if (fs.existsSync(cachedMeta)) {
      try {
        const meta = JSON.parse(fs.readFileSync(cachedMeta, 'utf8'));
        charsBilled = Number(meta.charsBilled || text.length);
      } catch {}
    }
  } else {
    const endpoint = `/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
    const reqBody = {
      text,
      model_id: modelId,
      voice_settings: voiceSettings
    };
    const res = await apiRequest(endpoint, {
      method: 'POST',
      body: reqBody,
      accept: 'audio/mpeg'
    });
    const costHeader = res.headers.get('character-cost');
    charsBilled = costHeader ? Number(costHeader) : text.length;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 256) {
      throw new Error(`ElevenLabs returned unexpectedly small audio (${buf.length} bytes)`);
    }
    fs.writeFileSync(cachedMp3, buf);
    duration = normalizeMp3ToWav(cachedMp3, cachedWav);
    fs.writeFileSync(
      cachedMeta,
      JSON.stringify(
        {
          hash,
          voiceId,
          modelId,
          outputFormat,
          voiceSettings,
          textLength: text.length,
          charsBilled,
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
  if (outMp3 && fs.existsSync(cachedMp3)) {
    fs.mkdirSync(path.dirname(outMp3), { recursive: true });
    fs.copyFileSync(cachedMp3, outMp3);
  }

  return {
    wav: outWav || cachedWav,
    mp3: outMp3 || (fs.existsSync(cachedMp3) ? cachedMp3 : null),
    duration,
    cached,
    textLength: text.length,
    charsBilled: cached ? 0 : charsBilled,
    charsCached: cached ? (charsBilled || text.length) : 0,
    hash
  };
}

async function synthesizeBatch({ items, voiceId, voiceName = '', modelId = DEFAULT_MODEL_ID, voiceSettings }) {
  const cues = {};
  let totalCharsBilled = 0;
  let totalCharsCached = 0;
  let totalTextCharsNew = 0;
  let totalTextChars = 0;
  let apiCalls = 0;
  let cacheHits = 0;

  for (const item of items) {
    const res = await synthesizeLine({
      text: item.text,
      voiceId,
      modelId,
      voiceSettings,
      outWav: item.outWav
    });
    cues[item.id] = { wav: res.wav, duration: res.duration };
    totalTextChars += res.textLength;
    totalCharsBilled += res.charsBilled;
    totalCharsCached += res.charsCached;
    if (res.cached) {
      cacheHits++;
    } else {
      apiCalls++;
      totalTextCharsNew += res.textLength;
    }
  }

  const labelName = voiceName ? `${voiceName} (${voiceId})` : voiceId;
  return {
    voiceLabel: `ElevenLabs (${modelId} · ${labelName})`,
    cues,
    stats: {
      apiCalls,
      cacheHits,
      textCharsTotal: totalTextChars,
      textCharsNew: totalTextCharsNew,
      charsBilled: totalCharsBilled,
      charsCached: totalCharsCached
    }
  };
}

module.exports = {
  DEFAULT_ENV_FILE,
  DEFAULT_MODEL_ID,
  loadElevenLabsApiKey,
  hasElevenLabsApiKey,
  requireElevenLabsApiKey,
  getCacheDir,
  computeCacheKey,
  normalizeMp3ToWav,
  sanitizeErrorText,
  extractSafeHttpErrorSummary,
  apiRequest,
  getAccountSubscription,
  listMyVoices,
  searchSharedVoices,
  addSharedVoice,
  synthesizeLine,
  synthesizeBatch
};
