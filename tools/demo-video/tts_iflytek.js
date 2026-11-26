'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const DEFAULT_ENDPOINT = 'wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6';
const DEFAULT_ENV_FILE = path.join(os.homedir(), '.openclaw', '.env.iflytek');
const DEFAULT_VCN = 'x6_xiaoqiChat_pro';
const DEFAULT_SPEED = 62;
const DEFAULT_PITCH = 50;
const DEFAULT_VOLUME = 50;
const DEFAULT_ORAL_LEVEL = 'mid';
const DEFAULT_SPARK_ASSIST = 1;
const DEFAULT_REMAIN = 1;
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
  return process.env.IFLYTEK_ENV_FILE || DEFAULT_ENV_FILE;
}

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let val = match[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    val = val.trim();
    if (val) out[match[1]] = val;
  }
  return out;
}

/**
 * Load iFLYTEK credentials from process.env or ~/.openclaw/.env.iflytek.
 * Never logs, prints, or embeds credentials in error messages.
 */
function loadIflytekCredentials() {
  let fileVars = {};
  const envPath = getEnvFilePath();
  if (fs.existsSync(envPath)) {
    fileVars = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  }
  const appId = (process.env.IFLYTEK_APPID || fileVars.IFLYTEK_APPID || '').trim();
  const apiKey = (process.env.IFLYTEK_API_KEY || fileVars.IFLYTEK_API_KEY || '').trim();
  const apiSecret = (process.env.IFLYTEK_API_SECRET || fileVars.IFLYTEK_API_SECRET || '').trim();
  if (!appId || !apiKey || !apiSecret) return null;
  return { appId, apiKey, apiSecret };
}

function hasIflytekCredentials() {
  return Boolean(loadIflytekCredentials());
}

function requireIflytekCredentials() {
  const creds = loadIflytekCredentials();
  if (!creds) {
    throw new Error(
      `iFLYTEK credentials not found. Set IFLYTEK_APPID, IFLYTEK_API_KEY, and IFLYTEK_API_SECRET or populate ${getEnvFilePath()}.`
    );
  }
  return creds;
}

function redactSecrets(msg, creds, extraSecrets = [], maxLen = 280) {
  let s = String(msg || '');
  const secrets = [];
  if (creds) {
    secrets.push(creds.apiSecret, creds.apiKey, creds.appId);
  }
  for (const extra of extraSecrets || []) {
    if (extra) secrets.push(extra);
  }
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
  // Strip signed query strings and auth parameters from any URL or header fragment.
  s = s.replace(/(wss?:\/\/[^\s?#"']+)\?[^\s"'<>)]*/gi, '$1?[REDACTED]');
  s = s.replace(/(https?:\/\/[^\s?#"']+)\?[^\s"'<>)]*/gi, '$1?[REDACTED]');
  s = s.replace(/([?&](?:authorization|signature|api_key|key|token|secret)=)[^&\s"'<>)]+/gi, '$1[REDACTED]');
  s = s.replace(/\b(authorization|signature|api_key)\s*[:=]\s*["']?[^\s"',;}\]]+["']?/gi, '$1=[REDACTED]');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) {
    s = `${s.slice(0, maxLen)}…`;
  }
  return s;
}

function buildSignedRequest(endpoint, creds) {
  const u = new URL(endpoint);
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${u.host}\ndate: ${date}\nGET ${u.pathname} HTTP/1.1`;
  const signatureSha = crypto.createHmac('sha256', creds.apiSecret).update(signatureOrigin).digest('base64');
  const authOrigin = `api_key="${creds.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signatureSha}"`;
  const authorization = Buffer.from(authOrigin, 'utf8').toString('base64');
  const params = new URLSearchParams({
    authorization,
    date,
    host: u.host
  });
  return {
    url: `${endpoint}?${params.toString()}`,
    authorization,
    signature: signatureSha
  };
}

function buildSignedUrl(endpoint, creds) {
  return buildSignedRequest(endpoint, creds).url;
}

function getCacheDir() {
  const base = process.env.DEMO_VIDEO_TTS_CACHE
    ? path.resolve(process.env.DEMO_VIDEO_TTS_CACHE)
    : path.join(os.homedir(), '.cache', 'lean-ritual-demo-video', 'tts');
  return path.join(base, 'iflytek');
}

function computeCacheKey({ text, vcn, speed, volume, pitch, oralLevel, sparkAssist, remain, endpoint }) {
  const payload = JSON.stringify({
    v: 2,
    endpoint,
    vcn,
    speed,
    volume,
    pitch,
    oralLevel,
    sparkAssist: sparkAssist ?? 1,
    remain: remain ?? 0,
    text
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
 * Decode iFLYTEK raw 24kHz 16-bit mono PCM to 48kHz stereo PCM WAV,
 * trim trailing silence conservatively if needed, peak-normalize to -1.5 dBFS,
 * and apply 8ms edge micro-fades to match Gemini/ElevenLabs levels.
 */
function normalizePcmToWav(pcmPath, wavPath, sampleRate = 24000) {
  const tmpDecoded = wavPath.replace(/\.wav$/, '.tmp-dec.wav');
  try {
    runBin(FFMPEG, [
      '-y',
      '-f', 's16le',
      '-ar', String(sampleRate),
      '-ac', '1',
      '-i', pcmPath,
      '-ar', '48000',
      '-ac', '2',
      '-c:a', 'pcm_s16le',
      tmpDecoded
    ]);

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

function synthesizeRawFromApi({
  text,
  vcn = DEFAULT_VCN,
  speed = DEFAULT_SPEED,
  volume = DEFAULT_VOLUME,
  pitch = DEFAULT_PITCH,
  oralLevel = DEFAULT_ORAL_LEVEL,
  sparkAssist = DEFAULT_SPARK_ASSIST,
  remain = DEFAULT_REMAIN,
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = 30000,
  WebSocketImpl = globalThis.WebSocket
}) {
  const creds = requireIflytekCredentials();
  const signed = buildSignedRequest(endpoint, creds);
  const extraSecrets = [signed.url, signed.authorization, signed.signature];

  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let sid = '';

    let ws;
    try {
      ws = new WebSocketImpl(signed.url);
    } catch (err) {
      reject(new Error(redactSecrets(err?.message || err, creds, extraSecrets)));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error(`iFLYTEK TTS timed out after ${timeoutMs}ms (vcn=${vcn})`));
    }, timeoutMs);

    const finishErr = err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      const clean = new Error(redactSecrets(err?.message || err, creds, extraSecrets));
      if (err?.code !== undefined) clean.code = err.code;
      reject(clean);
    };

    const finishOk = () => {
      if (settled) return;
      const pcm = Buffer.concat(chunks);
      if (pcm.length < 1024) {
        finishErr(new Error(`iFLYTEK TTS returned unexpectedly small audio (${pcm.length} bytes)`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ pcm, sampleRate: 24000 });
    };

    ws.addEventListener('open', () => {
      const frame = {
        header: {
          app_id: creds.appId,
          status: 2
        },
        parameter: {
          oral: {
            oral_level: oralLevel,
            spark_assist: sparkAssist,
            remain
          },
          tts: {
            vcn,
            speed,
            volume,
            pitch,
            bgs: 0,
            reg: 0,
            rdn: 0,
            rhy: 0,
            audio: {
              encoding: 'raw',
              sample_rate: 24000,
              channels: 1,
              bit_depth: 16,
              frame_size: 0
            }
          }
        },
        payload: {
          text: {
            encoding: 'utf8',
            compress: 'raw',
            format: 'plain',
            status: 2,
            seq: 0,
            text: Buffer.from(text, 'utf8').toString('base64')
          }
        }
      };
      ws.send(JSON.stringify(frame));
    });

    ws.addEventListener('message', event => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
        const code = msg?.header?.code ?? 0;
        sid = msg?.header?.sid || sid;
        if (code !== 0) {
          const safeDetail = redactSecrets(msg?.header?.message || '', creds, extraSecrets, 180);
          const safeSid = redactSecrets(sid, creds, extraSecrets, 64);
          const err = new Error(`iFLYTEK TTS error code=${code} message="${safeDetail}"${safeSid ? ` sid=${safeSid}` : ''}`);
          err.code = code;
          finishErr(err);
          return;
        }
        const audioB64 = msg?.payload?.audio?.audio;
        if (audioB64) {
          chunks.push(Buffer.from(audioB64, 'base64'));
        }
        const audioStatus = msg?.payload?.audio?.status ?? msg?.header?.status;
        if (audioStatus === 2) {
          finishOk();
        }
      } catch (err) {
        finishErr(err);
      }
    });

    ws.addEventListener('error', event => {
      const detail = redactSecrets(event?.message || event?.error?.message || 'WebSocket connection error', creds, extraSecrets, 200);
      finishErr(new Error(`iFLYTEK WebSocket error: ${detail}`));
    });

    ws.addEventListener('close', event => {
      if (!settled) {
        if (chunks.length > 0 && event.code === 1000) {
          finishOk();
        } else {
          const safeReason = redactSecrets(event.reason || 'none', creds, extraSecrets, 160);
          finishErr(new Error(`iFLYTEK WebSocket closed unexpectedly (code=${event.code}, reason=${safeReason})`));
        }
      }
    });
  });
}

async function synthesizeLine({
  text,
  vcn = DEFAULT_VCN,
  speed = DEFAULT_SPEED,
  volume = DEFAULT_VOLUME,
  pitch = DEFAULT_PITCH,
  oralLevel = DEFAULT_ORAL_LEVEL,
  sparkAssist = DEFAULT_SPARK_ASSIST,
  remain = DEFAULT_REMAIN,
  endpoint = DEFAULT_ENDPOINT,
  outWav,
  forceRefresh = false
}) {
  const cacheDir = getCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });

  const hash = computeCacheKey({ text, vcn, speed, volume, pitch, oralLevel, sparkAssist, remain, endpoint });
  const cachedWav = path.join(cacheDir, `${hash}.wav`);
  const cachedMeta = path.join(cacheDir, `${hash}.meta.json`);

  let cached = false;
  let duration = 0;

  if (!forceRefresh && fs.existsSync(cachedWav) && fs.statSync(cachedWav).size > 1000) {
    cached = true;
    duration = probeDuration(cachedWav);
  } else {
    const res = await synthesizeRawFromApi({ text, vcn, speed, volume, pitch, oralLevel, sparkAssist, remain, endpoint });
    const tmpPcm = path.join(cacheDir, `${hash}.tmp.pcm`);
    try {
      fs.writeFileSync(tmpPcm, res.pcm);
      duration = normalizePcmToWav(tmpPcm, cachedWav, res.sampleRate);
    } finally {
      fs.rmSync(tmpPcm, { force: true });
    }
    fs.writeFileSync(
      cachedMeta,
      JSON.stringify(
        {
          hash,
          vcn,
          speed,
          volume,
          pitch,
          oralLevel,
          sparkAssist,
          remain,
          textLength: text.length,
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
    charsNew: cached ? 0 : text.length,
    charsCached: cached ? text.length : 0,
    hash
  };
}

async function synthesizeBatch({
  items,
  vcn = DEFAULT_VCN,
  speed = DEFAULT_SPEED,
  volume = DEFAULT_VOLUME,
  pitch = DEFAULT_PITCH,
  oralLevel = DEFAULT_ORAL_LEVEL,
  sparkAssist = DEFAULT_SPARK_ASSIST,
  remain = DEFAULT_REMAIN,
  endpoint = DEFAULT_ENDPOINT
}) {
  const cues = {};
  let apiCalls = 0;
  let cacheHits = 0;
  let textCharsTotal = 0;
  let textCharsNew = 0;

  for (const item of items) {
    const res = await synthesizeLine({
      text: item.text,
      vcn,
      speed: item.speed ?? speed,
      volume: item.volume ?? volume,
      pitch: item.pitch ?? pitch,
      oralLevel: item.oralLevel ?? oralLevel,
      sparkAssist: item.sparkAssist ?? sparkAssist,
      remain: item.remain ?? remain,
      endpoint,
      outWav: item.outWav
    });
    cues[item.id] = { wav: res.wav, duration: res.duration };
    textCharsTotal += res.textLength;
    if (res.cached) {
      cacheHits++;
    } else {
      apiCalls++;
      textCharsNew += res.charsNew;
    }
  }

  return {
    voiceLabel: `iFLYTEK 超拟人 (${vcn} · speed=${speed}, pitch=${pitch}, vol=${volume}, oral=${oralLevel})`,
    cues,
    stats: {
      provider: 'iflytek',
      apiCalls,
      cacheHits,
      textCharsTotal,
      textCharsNew
    }
  };
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_ENV_FILE,
  DEFAULT_VCN,
  DEFAULT_SPEED,
  DEFAULT_PITCH,
  DEFAULT_VOLUME,
  DEFAULT_ORAL_LEVEL,
  DEFAULT_SPARK_ASSIST,
  DEFAULT_REMAIN,
  loadIflytekCredentials,
  hasIflytekCredentials,
  requireIflytekCredentials,
  getCacheDir,
  computeCacheKey,
  redactSecrets,
  buildSignedRequest,
  buildSignedUrl,
  normalizePcmToWav,
  synthesizeRawFromApi,
  synthesizeLine,
  synthesizeBatch
};
