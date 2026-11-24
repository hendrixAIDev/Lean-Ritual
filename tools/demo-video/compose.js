'use strict';

const assert = require('node:assert/strict');
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
  CAP_BAND_Y,
  W16_CANVAS_W,
  W16_CANVAS_H,
  W16_PHONE_W,
  W16_PHONE_H,
  W16_PHONE_X,
  W16_PHONE_Y,
  W16_PANEL_X,
  W16_PANEL_Y
} = require('./assets');
const elevenlabs = require('./tts_elevenlabs');
const { renderTransitionBridge } = require('./transitions');

const FFMPEG = process.env.FFMPEG_BIN || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const FFPROBE = process.env.FFPROBE_BIN || (fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');
const UV_BIN = process.env.UV_BIN || (fs.existsSync('/opt/homebrew/bin/uv') ? '/opt/homebrew/bin/uv' : 'uv');
const TRANSITION_DUR = 0.48;
const BRIDGE_DUR = 0.57; // 17 frames @ 30fps for 3D perspective_swing transition bridge
const FPS = 30;
const MAX_BYTES = 25 * 1024 * 1024;

function runBin(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').slice(-2000);
    throw new Error(`${bin} failed (exit ${err.status}):\n${detail}`);
  }
}

function probeMedia(filePath) {
  const out = runBin(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ]);
  const info = JSON.parse(out);
  const v = (info.streams || []).find(s => s.codec_type === 'video');
  const a = (info.streams || []).find(s => s.codec_type === 'audio');
  const parseRate = r => {
    if (!r) return 0;
    const [n, d] = String(r).split('/').map(Number);
    return d ? n / d : n || 0;
  };
  return {
    duration: Number(info.format?.duration || 0),
    sizeBytes: Number(info.format?.size || fs.statSync(filePath).size),
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: parseRate(v.avg_frame_rate || v.r_frame_rate) } : null,
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate || 0), channels: a.channels } : null
  };
}

function resolveSayVoice(preferredList) {
  let available = '';
  try {
    available = runBin('/usr/bin/say', ['-v', '?']);
  } catch {
    return preferredList[preferredList.length - 1];
  }
  const names = new Set(
    available
      .split('\n')
      .map(line => line.replace(/\s+[a-z]{2}_[A-Z]{2}\s+#.*$/, '').trim())
      .filter(Boolean)
  );
  for (const candidate of preferredList) {
    if (names.has(candidate)) return candidate;
  }
  return preferredList[preferredList.length - 1];
}

async function synthesizeAllVoices({ sb, compDir, ttsEngine = 'kokoro', elevenlabsVoiceId = null }) {
  const items = [];
  const addItem = (id, text) => {
    items.push({ id, text, outWav: path.join(compDir, `vo-${id}.wav`) });
  };

  addItem('title', sb.titleCard.spoken || sb.titleCard.narration);
  sb.scenes.forEach(sc => {
    sc.beats.forEach((beat, bi) => {
      addItem(`${sc.id}-${bi}`, beat.spoken || beat.narration);
    });
  });
  addItem('outro', sb.outroCard.spoken || sb.outroCard.narration);

  if (ttsEngine === 'elevenlabs') {
    const elCfg = sb.voice.elevenlabs || {};
    const voiceId = elevenlabsVoiceId || elCfg.voiceId;
    if (!voiceId) {
      throw new Error(
        `No ElevenLabs voice ID configured for language "${sb.lang}". Pass --voice-${sb.lang} <voice_id> or set sb.voice.elevenlabs.voiceId.`
      );
    }
    const voiceName = elevenlabsVoiceId && elevenlabsVoiceId !== elCfg.voiceId ? '' : (elCfg.voiceName || '');
    return elevenlabs.synthesizeBatch({
      items,
      voiceId,
      voiceName,
      modelId: elCfg.modelId || elevenlabs.DEFAULT_MODEL_ID,
      voiceSettings: elCfg.voiceSettings
    });
  }

  if (ttsEngine === 'kokoro') {
    const jobPath = path.join(compDir, `tts-job-${sb.lang}.json`);
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        lang: sb.lang,
        model: sb.voice.model,
        sid: sb.voice.sid,
        speed: sb.voice.speed,
        items
      }),
      'utf8'
    );
    const scriptPath = path.join(__dirname, 'tts_kokoro.py');
    const out = runBin(UV_BIN, [
      'run', '--quiet', '--python', '3.11',
      '--with', 'sherpa-onnx<2',
      '--with', 'soundfile',
      'python', scriptPath, jobPath
    ]);
    const parsed = JSON.parse(out.trim().split('\n').pop());
    return {
      voiceLabel: `Kokoro-82M (${sb.voice.model} · ${sb.voice.speaker}, sid=${sb.voice.sid}, speed=${sb.voice.speed}, Apache-2.0)`,
      cues: parsed.items
    };
  }

  // Fallback: macOS `say` (prefers Enhanced/Premium voice if installed)
  const chosenVoice = resolveSayVoice(sb.voice.sayFallback.preferred);
  const rate = sb.voice.sayFallback.rate;
  const cues = {};
  for (const item of items) {
    const aiff = path.join(compDir, `say-${item.id}.aiff`);
    runBin('/usr/bin/say', ['-v', chosenVoice, '-r', String(rate), '-o', aiff, item.text]);
    runBin(FFMPEG, ['-y', '-i', aiff, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', item.outWav]);
    fs.rmSync(aiff, { force: true });
    cues[item.id] = { wav: item.outWav, duration: probeMedia(item.outWav).duration };
  }
  return {
    voiceLabel: `macOS say (-v "${chosenVoice}" -r ${rate})`,
    cues
  };
}

function generateSoundAssets({ totalDur, soundDir }) {
  const scriptPath = path.join(__dirname, 'sound_design.py');
  const out = runBin(UV_BIN, [
    'run', '--quiet', '--python', '3.11',
    '--with', 'numpy',
    '--with', 'soundfile',
    'python', scriptPath, totalDur.toFixed(3), soundDir
  ]);
  return JSON.parse(out.trim().split('\n').pop());
}

function renderAnimatedCardSegment({ videoPath, trimStart, duration, width, height, outMp4 }) {
  const info = probeMedia(videoPath);
  const avail = Math.max(0.5, info.duration - trimStart);
  const padNeeded = Math.max(0.25, duration - avail + 0.4);
  runBin(FFMPEG, [
    '-y',
    '-ss', trimStart.toFixed(3),
    '-i', videoPath,
    '-vf', `fps=${FPS},scale=${width}:${height}:flags=lanczos,tpad=stop_mode=clone:stop_duration=${padNeeded.toFixed(3)},trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p`,
    '-t', duration.toFixed(3),
    '-r', String(FPS),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-an',
    outMp4
  ]);
}

// Fixed, rock-solid static scaling inside the phone frame (no zoompan jitter or cropping).
function buildStaticPhoneScaleFilter({ phoneW, phoneH }) {
  return `scale=${phoneW}:${phoneH}:flags=lanczos`;
}

function renderScene9x16({ rawWebm, trimStart, sceneDur, splitAt, shellPath, sceneOverlays, outMp4 }) {
  const rawInfo = probeMedia(rawWebm);
  const avail = Math.max(0.5, rawInfo.duration - trimStart);
  const padNeeded = Math.max(0.25, sceneDur - avail + 0.5);

  const args = [
    '-y',
    '-ss', trimStart.toFixed(3),
    '-i', rawWebm,
    '-loop', '1', '-i', shellPath,
    '-loop', '1', '-i', sceneOverlays.chapter
  ];

  const beats = sceneOverlays.beats;
  const inputIdx = {};
  let nextIdx = 3;
  beats.forEach((b, bi) => {
    args.push('-framerate', String(FPS), '-i', b.capSeq.pattern);
    inputIdx[`cap${bi}`] = nextIdx++;
    if (b.calloutSeq) {
      args.push('-framerate', String(FPS), '-i', b.calloutSeq.pattern);
      inputIdx[`call${bi}`] = nextIdx++;
    }
  });

  const filters = [];
  const phoneScale = buildStaticPhoneScaleFilter({ phoneW: PHONE_W, phoneH: PHONE_H });

  filters.push(`color=c=#0C1714:s=${CANVAS_W}x${CANVAS_H}:r=${FPS}:d=${sceneDur.toFixed(3)}[base]`);
  filters.push(
    `[0:v]fps=${FPS},tpad=stop_mode=clone:stop_duration=${padNeeded.toFixed(3)},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,${phoneScale}[phone]`
  );
  filters.push(`[base][phone]overlay=${PHONE_X}:${PHONE_Y}:shortest=1[staged]`);
  filters.push(`[staged][1:v]overlay=0:0:shortest=1[framed]`);

  let cur = 'framed';

  // Top header chip choreography: chapter chip fades in; kinetic count-up callout pills swap in cleanly!
  const b0HasCall = Boolean(beats[0]?.calloutSeq);
  const b1HasCall = Boolean(beats[1]?.calloutSeq);
  const chapFadeOut = b0HasCall ? 1.55 : b1HasCall ? Math.max(1.4, splitAt - 0.15) : sceneDur - 0.25;

  filters.push(
    `[2:v]fps=${FPS},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,format=rgba,` +
    `fade=t=in:st=0.06:d=0.26:alpha=1,fade=t=out:st=${chapFadeOut.toFixed(3)}:d=0.22:alpha=1[chap]`
  );
  filters.push(
    `[${cur}][chap]overlay=x=0:y='-14*pow(1-min(1,max(0,(t-0.06)/0.26)),3)':shortest=1[top0]`
  );
  cur = 'top0';

  const addKineticSeqOverlay = (idx, seq, startSec, fadeOutSt, yPos, outLabel) => {
    const endSec = Math.min(sceneDur, fadeOutSt + 0.26);
    const holdDur = Math.max(0.5, endSec - startSec - seq.duration + 0.4);
    const tag = `k_${outLabel}`;
    filters.push(
      `[${idx}:v]fps=${FPS},format=rgba,tpad=stop_mode=clone:stop_duration=${holdDur.toFixed(3)},` +
      `setpts=PTS-STARTPTS+${startSec.toFixed(3)}/TB,` +
      `fade=t=out:st=${fadeOutSt.toFixed(3)}:d=0.22:alpha=1[${tag}]`
    );
    filters.push(
      `[${cur}][${tag}]overlay=x=0:y=${yPos}:eof_action=pass:enable='between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})'[${outLabel}]`
    );
    cur = outLabel;
  };

  if (b0HasCall) {
    const cStart = 1.75;
    const cEnd = beats.length > 1 ? Math.max(cStart + 1.1, splitAt - 0.22) : sceneDur - 0.28;
    addKineticSeqOverlay(inputIdx.call0, beats[0].calloutSeq, cStart, cEnd, 0, 'top1');
  }

  if (b1HasCall) {
    const cStart = Math.max(0.7, splitAt + 0.10);
    const cEnd = Math.max(cStart + 0.9, sceneDur - 0.28);
    addKineticSeqOverlay(inputIdx.call1, beats[1].calloutSeq, cStart, cEnd, 0, 'top2');
  }

  // Bottom kinetic per-word/chunk captions
  if (beats.length === 1) {
    addKineticSeqOverlay(inputIdx.cap0, beats[0].capSeq, 0.08, Math.max(0.5, sceneDur - 0.28), CAP_BAND_Y, 'c0ov');
  } else {
    const sp = splitAt;
    const c0Out = Math.max(0.8, sp - 0.24);
    const c1In = sp;
    const c1Out = Math.max(c1In + 0.6, sceneDur - 0.28);
    addKineticSeqOverlay(inputIdx.cap0, beats[0].capSeq, 0.08, c0Out, CAP_BAND_Y, 'c0ov');
    addKineticSeqOverlay(inputIdx.cap1, beats[1].capSeq, c1In, c1Out, CAP_BAND_Y, 'c1ov');
  }

  filters.push(`[${cur}]format=yuv420p[outv]`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    '-t', sceneDur.toFixed(3),
    '-r', String(FPS),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-an',
    outMp4
  );

  runBin(FFMPEG, args);
}

function renderScene16x9({ rawWebm, trimStart, sceneDur, splitAt, shell16x9Path, panels, outMp4 }) {
  const rawInfo = probeMedia(rawWebm);
  const avail = Math.max(0.5, rawInfo.duration - trimStart);
  const padNeeded = Math.max(0.25, sceneDur - avail + 0.5);

  const args = [
    '-y',
    '-ss', trimStart.toFixed(3),
    '-i', rawWebm,
    '-loop', '1', '-i', shell16x9Path
  ];
  panels.forEach(seq => args.push('-framerate', String(FPS), '-i', seq.pattern));

  const filters = [];
  const phoneScale = buildStaticPhoneScaleFilter({ phoneW: W16_PHONE_W, phoneH: W16_PHONE_H });

  filters.push(`color=c=#0C1714:s=${W16_CANVAS_W}x${W16_CANVAS_H}:r=${FPS}:d=${sceneDur.toFixed(3)}[base]`);
  filters.push(
    `[0:v]fps=${FPS},tpad=stop_mode=clone:stop_duration=${padNeeded.toFixed(3)},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,${phoneScale}[phone]`
  );
  filters.push(`[base][phone]overlay=${W16_PHONE_X}:${W16_PHONE_Y}:shortest=1[staged]`);
  filters.push(`[staged][1:v]overlay=0:0:shortest=1[framed]`);

  let cur = 'framed';
  const addPanelSeq = (idx, seq, startSec, fadeOutSt, outLabel) => {
    const endSec = Math.min(sceneDur, fadeOutSt + 0.26);
    const holdDur = Math.max(0.5, endSec - startSec - seq.duration + 0.4);
    const tag = `kp_${outLabel}`;
    filters.push(
      `[${idx}:v]fps=${FPS},format=rgba,tpad=stop_mode=clone:stop_duration=${holdDur.toFixed(3)},` +
      `setpts=PTS-STARTPTS+${startSec.toFixed(3)}/TB,` +
      `fade=t=out:st=${fadeOutSt.toFixed(3)}:d=0.22:alpha=1[${tag}]`
    );
    filters.push(
      `[${cur}][${tag}]overlay=x=${W16_PANEL_X}:y=${W16_PANEL_Y}:eof_action=pass:enable='between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})'[${outLabel}]`
    );
    cur = outLabel;
  };

  if (panels.length === 1) {
    addPanelSeq(2, panels[0], 0.08, Math.max(0.5, sceneDur - 0.28), 'ov0');
  } else {
    const c0Out = Math.max(0.8, splitAt - 0.24);
    const c1In = splitAt;
    const c1Out = Math.max(c1In + 0.6, sceneDur - 0.28);
    addPanelSeq(2, panels[0], 0.08, c0Out, 'ov0');
    addPanelSeq(3, panels[1], c1In, c1Out, 'ov1');
  }

  filters.push(`[${cur}]format=yuv420p[outv]`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    '-t', sceneDur.toFixed(3),
    '-r', String(FPS),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-an',
    outMp4
  );

  runBin(FFMPEG, args);
}

function extractPhoneFrame({ sceneMp4, tsSec, phoneW, phoneH, phoneX, phoneY, outPng }) {
  runBin(FFMPEG, [
    '-y',
    '-ss', Math.max(0, tsSec).toFixed(3),
    '-i', sceneMp4,
    '-frames:v', '1',
    '-vf', `crop=${phoneW}:${phoneH}:${phoneX}:${phoneY}`,
    outPng
  ]);
}

function assembleFinalVideo({ segments, bridges, width, outVideoOnly, segDir }) {
  // segments = [title, scene0, scene1, ..., sceneN, outro]
  // bridges = Map(segIdx -> { mp4, duration }) for 3D perspective_swing bridges placed BEFORE segIdx
  const bodyItems = [];
  let bodyDur = 0;
  for (let i = 1; i < segments.length - 1; i++) {
    const br = bridges.get(i);
    if (br) {
      bodyItems.push(br.mp4);
      bodyDur += br.duration;
    }
    bodyItems.push(segments[i].mp4);
    bodyDur += segments[i].duration;
  }

  const listPath = path.join(segDir, 'body-concat.txt');
  fs.writeFileSync(listPath, bodyItems.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
  const bodyMp4 = path.join(segDir, 'body-merged.mp4');
  runBin(FFMPEG, [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '16',
    '-r', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-an',
    bodyMp4
  ]);

  const titleSeg = segments[0];
  const outroSeg = segments[segments.length - 1];
  const off1 = Math.max(0.1, titleSeg.duration - TRANSITION_DUR);
  const afterBody = off1 + bodyDur;
  const off2 = Math.max(off1 + 0.5, afterBody - TRANSITION_DUR);
  const totalDur = off2 + outroSeg.duration;

  const filters = [
    `[0:v][1:v]xfade=transition=circleopen:duration=${TRANSITION_DUR.toFixed(3)}:offset=${off1.toFixed(3)}[xf1]`,
    `[xf1][2:v]xfade=transition=fade:duration=${TRANSITION_DUR.toFixed(3)}:offset=${off2.toFixed(3)}[merged]`,
    `color=c=#34D399@0.92:s=${width}x6:r=${FPS}:d=${totalDur.toFixed(3)}[pbar]`,
    `[merged][pbar]overlay=x='-${width}+${width}*min(1,t/${totalDur.toFixed(3)})':y=0:shortest=1,format=yuv420p[vout]`
  ];

  runBin(FFMPEG, [
    '-y',
    '-i', titleSeg.mp4,
    '-i', bodyMp4,
    '-i', outroSeg.mp4,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-r', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-level', '4.1',
    '-preset', 'medium',
    '-crf', '20',
    '-maxrate', '1600k',
    '-bufsize', '3200k',
    '-movflags', '+faststart',
    '-an',
    outVideoOnly
  ]);

  return totalDur;
}

function buildMasterAudioMix({ voiceCues, sfxCues, bgmWav, totalDur, outWav }) {
  // Step 1: Assemble narration stem with gentle broadcast vocal polish
  const voiceStem = outWav.replace(/\.wav$/, '-voice.wav');
  const vArgs = ['-y'];
  voiceCues.forEach(c => vArgs.push('-i', c.wav));
  const vFilters = [];
  const vMix = [];
  voiceCues.forEach((cue, i) => {
    const ms = Math.max(0, Math.round(cue.startSec * 1000));
    vFilters.push(`[${i}:a]adelay=${ms}|${ms}[v${i}]`);
    vMix.push(`[v${i}]`);
  });
  vFilters.push(
    `${vMix.join('')}amix=inputs=${voiceCues.length}:duration=longest:normalize=0,` +
    `highpass=f=80,equalizer=f=3100:t=q:w=1.2:g=1.4,` +
    `acompressor=threshold=-16dB:ratio=2.4:attack=15:release=150:makeup=1.5,` +
    `volume=1.08,alimiter=limit=0.94,apad,atrim=0:${totalDur.toFixed(3)}[vout]`
  );
  vArgs.push('-filter_complex', vFilters.join(';'), '-map', '[vout]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', voiceStem);
  runBin(FFMPEG, vArgs);

  // Step 2: Assemble subtle UI SFX stem (swooshes + taps + chimes + pops)
  const sfxStem = outWav.replace(/\.wav$/, '-sfx.wav');
  if (sfxCues.length > 0) {
    const sArgs = ['-y'];
    sfxCues.forEach(c => sArgs.push('-i', c.wav));
    const sFilters = [];
    const sMix = [];
    sfxCues.forEach((cue, i) => {
      const ms = Math.max(0, Math.round(cue.startSec * 1000));
      const gain = cue.gain ?? 0.5;
      sFilters.push(`[${i}:a]volume=${gain.toFixed(3)},adelay=${ms}|${ms}[s${i}]`);
      sMix.push(`[s${i}]`);
    });
    sFilters.push(
      `${sMix.join('')}amix=inputs=${sfxCues.length}:duration=longest:normalize=0,alimiter=limit=0.85,apad,atrim=0:${totalDur.toFixed(3)}[sout]`
    );
    sArgs.push('-filter_complex', sFilters.join(';'), '-map', '[sout]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', sfxStem);
    runBin(FFMPEG, sArgs);
  } else {
    runBin(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', totalDur.toFixed(3), '-c:a', 'pcm_s16le', sfxStem]);
  }

  // Step 3: Sidechain-duck BGM cleanly under voice + mix voice + ducked BGM + SFX
  runBin(FFMPEG, [
    '-y',
    '-i', voiceStem,
    '-i', bgmWav,
    '-i', sfxStem,
    '-filter_complex',
    [
      `[0:a]asplit=2[vmain][vsc]`,
      `[1:a]atrim=0:${totalDur.toFixed(3)},volume=0.27[bgm0]`,
      `[bgm0][vsc]sidechaincompress=threshold=0.020:ratio=6.8:attack=30:release=420:makeup=1[bgm_duck]`,
      `[vmain][bgm_duck][2:a]amix=inputs=3:duration=first:normalize=0,alimiter=limit=0.89,atrim=0:${totalDur.toFixed(3)}[aout]`
    ].join(';'),
    '-map', '[aout]',
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    outWav
  ]);

  return outWav;
}

function muxVideoAndAudio({ videoOnlyMp4, audioWav, totalDur, outMp4 }) {
  runBin(FFMPEG, [
    '-y',
    '-i', videoOnlyMp4,
    '-i', audioWav,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '48000',
    '-t', totalDur.toFixed(3),
    '-movflags', '+faststart',
    outMp4
  ]);
}

function extractCheckFrames(mp4Path, framesDir, prefix) {
  fs.mkdirSync(framesDir, { recursive: true });
  const info = probeMedia(mp4Path);
  const pcts = [0.04, 0.20, 0.38, 0.56, 0.74, 0.96];
  const files = [];
  pcts.forEach((p, idx) => {
    const ts = Math.max(0.2, Math.min(info.duration - 0.3, info.duration * p));
    const outJpg = path.join(framesDir, `${prefix}-frame-${idx + 1}.jpg`);
    runBin(FFMPEG, [
      '-y',
      '-ss', ts.toFixed(3),
      '-i', mp4Path,
      '-frames:v', '1',
      '-q:v', '3',
      outJpg
    ]);
    files.push(outJpg);
  });
  return files;
}

function generateContactSheet({ mp4Path, outJpg, thumbW = 360 }) {
  const info = probeMedia(mp4Path);
  // Sample 16 evenly spaced frames across the full video (including animated title & outro cards)
  const count = 16;
  const interval = Math.max(0.5, (info.duration - 1.2) / (count - 1));
  runBin(FFMPEG, [
    '-y',
    '-ss', '0.9',
    '-i', mp4Path,
    '-vf', `fps=1/${interval.toFixed(4)},scale=${thumbW}:-2:flags=lanczos,tile=4x4:padding=10:margin=14:color=#0B1613`,
    '-frames:v', '1',
    '-q:v', '3',
    outJpg
  ]);
  return outJpg;
}

function verifyMp4(mp4Path, expectedW, expectedH) {
  const info = probeMedia(mp4Path);
  assert.equal(info.video?.codec, 'h264', `${mp4Path}: expected h264 video`);
  assert.equal(info.video?.width, expectedW, `${mp4Path}: expected width ${expectedW}`);
  assert.equal(info.video?.height, expectedH, `${mp4Path}: expected height ${expectedH}`);
  assert.ok(Math.abs(info.video.fps - FPS) < 0.5, `${mp4Path}: expected ${FPS}fps, got ${info.video.fps}`);
  assert.equal(info.audio?.codec, 'aac', `${mp4Path}: expected aac audio`);
  assert.ok(info.duration >= 75 && info.duration <= 135, `${mp4Path}: duration ${info.duration.toFixed(1)}s out of 75-135s range`);
  assert.ok(info.sizeBytes <= MAX_BYTES, `${mp4Path}: size ${(info.sizeBytes / 1048576).toFixed(2)} MB exceeds 25 MB`);
  return info;
}

function planLanguageTimeline({ sb, recordedScenes, voiceCuesMap }) {
  const recById = new Map(recordedScenes.map(r => [r.id, r]));
  const titleVo = voiceCuesMap.title;
  const outroVo = voiceCuesMap.outro;

  const titleDur = Math.max(sb.titleCard.duration, titleVo.duration + 0.85);
  const outroDur = Math.max(sb.outroCard.duration, outroVo.duration + 1.15);

  const plan = [];
  const voicePlan = [];
  const sfxPlan = [];

  plan.push({ id: 'title', duration: titleDur, transition: null });
  voicePlan.push({ segIdx: 0, localOffset: 0.30, wav: titleVo.wav });

  sb.scenes.forEach(sc => {
    const rec = recById.get(sc.id);
    assert.ok(rec, `Missing recorded video for scene ${sc.id}`);

    const beatVo = sc.beats.map((_, bi) => voiceCuesMap[`${sc.id}-${bi}`]);
    const rawInfo = probeMedia(rec.videoPath);
    const usableDur = Math.max(2.0, rawInfo.duration - rec.trimStart);

    let splitAt = usableDur / 2;
    let sceneDur = Math.max(usableDur, sc.minDuration);
    const segIdx = plan.length;

    if (sc.beats.length === 1) {
      const leadIn = sc.id === 'export' ? 0.55 : 0.42;
      const minForVo = leadIn + beatVo[0].duration + 0.72;
      sceneDur = Math.max(sceneDur, minForVo);
      voicePlan.push({ segIdx, localOffset: leadIn, wav: beatVo[0].wav });
      if (sc.beats[0]?.callout) {
        sfxPlan.push({ segIdx, localOffset: 1.9, kind: 'pop' });
      }
    } else {
      const rawSplit = rec.beatSplits[0] ?? usableDur * 0.5;
      const beat0End = 0.42 + beatVo[0].duration + 0.38;
      splitAt = Math.max(2.6, Math.min(usableDur - 1.5, rawSplit));
      const voBeat1Start = Math.max(splitAt, beat0End);
      const minForVo = voBeat1Start + beatVo[1].duration + 0.78;
      sceneDur = Math.max(sceneDur, minForVo);

      voicePlan.push({ segIdx, localOffset: 0.42, wav: beatVo[0].wav });
      voicePlan.push({ segIdx, localOffset: voBeat1Start, wav: beatVo[1].wav });

      // Subtle pop SFX when callout chips appear
      if (sc.beats[0]?.callout) {
        sfxPlan.push({ segIdx, localOffset: 2.0, kind: 'pop' });
      }
      if (sc.beats[1]?.callout) {
        sfxPlan.push({ segIdx, localOffset: Math.max(0.8, splitAt + 0.12), kind: 'pop' });
      }
    }

    // Add recorded UI interaction events (tap / chime), deduplicated slightly so taps stay crisp
    let lastTap = -1;
    for (const ev of rec.events || []) {
      if (ev.t < 0.1 || ev.t > sceneDur - 0.35) continue;
      if (ev.kind === 'tap') {
        if (ev.t - lastTap < 0.18) continue;
        lastTap = ev.t;
      }
      sfxPlan.push({ segIdx, localOffset: ev.t, kind: ev.kind });
    }

    plan.push({
      id: sc.id,
      duration: sceneDur,
      splitAt,
      transition: sc.transition || 'smoothleft',
      scene: sc,
      rec
    });
  });

  const outroSegIdx = plan.length;
  plan.push({ id: 'outro', duration: outroDur, transition: 'fade' });
  voicePlan.push({ segIdx: outroSegIdx, localOffset: 0.48, wav: outroVo.wav });

  // Compute global timeline start/end accounting for xfade overlaps & 3D perspective_swing bridges
  const timeline = [];
  let cursor = 0;
  plan.forEach((seg, i) => {
    let start;
    if (i === 0) {
      start = 0;
    } else if (seg.transition === 'perspective_swing') {
      start = cursor + BRIDGE_DUR;
    } else {
      start = cursor - TRANSITION_DUR;
    }
    const end = start + seg.duration;
    timeline.push({ id: seg.id, start, end, duration: seg.duration, transition: seg.transition });
    cursor = end;
  });

  const totalDur = cursor;
  return { plan, timeline, totalDur, titleDur, outroDur, voicePlan, sfxPlan };
}

async function composeLanguageVideo({
  sb,
  recordedScenes,
  langAssets,
  sharedAssets,
  assetBrowser,
  workDir,
  outDir,
  formats = ['9x16', '16x9'],
  ttsEngine = 'kokoro',
  elevenlabsVoiceId = null,
  preSynth = null
}) {
  const compDir = path.join(workDir, `compose-${sb.lang}`);
  fs.mkdirSync(compDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const synth = preSynth || (await synthesizeAllVoices({ sb, compDir, ttsEngine, elevenlabsVoiceId }));
  const { plan, timeline, totalDur, voicePlan, sfxPlan } = planLanguageTimeline({
    sb,
    recordedScenes,
    voiceCuesMap: synth.cues
  });

  // Generate tailored original upbeat 116 BPM BGM + UI & transition impact SFX
  const soundDir = path.join(compDir, 'sound');
  const sound = generateSoundAssets({ totalDur, soundDir });

  // Build global voice cues and SFX cues
  const voiceCues = voicePlan.map(item => ({
    wav: item.wav,
    startSec: timeline[item.segIdx].start + item.localOffset
  }));

  const sfxCues = [];
  // Add beat-synced impact/swoosh at every section boundary
  for (let i = 1; i < timeline.length; i++) {
    const prevEnd = timeline[i - 1].end;
    if (timeline[i].transition === 'perspective_swing' && sound.sfx.impact) {
      sfxCues.push({
        wav: sound.sfx.impact,
        startSec: Math.max(0.05, prevEnd + 0.08),
        gain: 0.52
      });
    } else {
      sfxCues.push({
        wav: sound.sfx.swoosh,
        startSec: Math.max(0.05, timeline[i].start - 0.04),
        gain: 0.44
      });
    }
  }
  const sfxGain = { tap: 0.40, chime: 0.44, pop: 0.36 };
  for (const ev of sfxPlan) {
    const wav = sound.sfx[ev.kind];
    if (!wav) continue;
    sfxCues.push({
      wav,
      startSec: timeline[ev.segIdx].start + ev.localOffset,
      gain: sfxGain[ev.kind] ?? 0.4
    });
  }

  const masterAudioWav = path.join(compDir, `master-audio-${sb.lang}.wav`);
  buildMasterAudioMix({
    voiceCues,
    sfxCues,
    bgmWav: sound.bgm,
    totalDur,
    outWav: masterAudioWav
  });

  const outputs = [];
  const framesDir = path.join(outDir, 'frames');

  // Render requested aspect-ratio formats (9:16 vertical and/or 16:9 widescreen)
  for (const fmt of formats) {
    const isWide = fmt === '16x9';
    const w = isWide ? W16_CANVAS_W : CANVAS_W;
    const h = isWide ? W16_CANVAS_H : CANVAS_H;
    const phW = isWide ? W16_PHONE_W : PHONE_W;
    const phH = isWide ? W16_PHONE_H : PHONE_H;
    const phX = isWide ? W16_PHONE_X : PHONE_X;
    const phY = isWide ? W16_PHONE_Y : PHONE_Y;
    const segDir = path.join(compDir, `segs-${fmt}`);
    fs.mkdirSync(segDir, { recursive: true });

    const segments = [];
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const segMp4 = path.join(segDir, `seg-${String(i).padStart(2, '0')}-${p.id}.mp4`);
      if (p.id === 'title') {
        const card = langAssets.cards[fmt].title;
        renderAnimatedCardSegment({
          videoPath: card.videoPath,
          trimStart: card.trimStart,
          duration: p.duration,
          width: w,
          height: h,
          outMp4: segMp4
        });
      } else if (p.id === 'outro') {
        const card = langAssets.cards[fmt].outro;
        renderAnimatedCardSegment({
          videoPath: card.videoPath,
          trimStart: card.trimStart,
          duration: p.duration,
          width: w,
          height: h,
          outMp4: segMp4
        });
      } else if (isWide) {
        renderScene16x9({
          rawWebm: p.rec.videoPath,
          trimStart: p.rec.trimStart,
          sceneDur: p.duration,
          splitAt: p.splitAt,
          shell16x9Path: sharedAssets.shell16x9Path,
          panels: langAssets.panels16x9[p.id],
          outMp4: segMp4
        });
      } else {
        renderScene9x16({
          rawWebm: p.rec.videoPath,
          trimStart: p.rec.trimStart,
          sceneDur: p.duration,
          splitAt: p.splitAt,
          shellPath: sharedAssets.shellPath,
          sceneOverlays: langAssets.overlays9x16[p.id],
          outMp4: segMp4
        });
      }
      segments.push({ id: p.id, mp4: segMp4, duration: p.duration, transition: p.transition });
    }

    // Render 3D perspective_swing bridges between consecutive app scenes using exact boundary phone frames
    const bridges = new Map();
    for (let i = 2; i < segments.length - 1; i++) {
      if (segments[i].transition !== 'perspective_swing') continue;
      const outPng = path.join(segDir, `edge-out-${i - 1}.png`);
      const inPng = path.join(segDir, `edge-in-${i}.png`);
      extractPhoneFrame({
        sceneMp4: segments[i - 1].mp4,
        tsSec: Math.max(0.05, segments[i - 1].duration - 0.08),
        phoneW: phW,
        phoneH: phH,
        phoneX: phX,
        phoneY: phY,
        outPng
      });
      extractPhoneFrame({
        sceneMp4: segments[i].mp4,
        tsSec: 0.04,
        phoneW: phW,
        phoneH: phH,
        phoneX: phX,
        phoneY: phY,
        outPng: inPng
      });
      const brMp4 = path.join(segDir, `bridge-${i - 1}-to-${i}.mp4`);
      const br = await renderTransitionBridge({
        browser: assetBrowser,
        style: 'perspective_swing',
        outFramePath: outPng,
        inFramePath: inPng,
        wide: isWide,
        durationSec: BRIDGE_DUR,
        outMp4: brMp4,
        workDir: segDir
      });
      bridges.set(i, br);
    }

    const videoOnlyMp4 = path.join(compDir, `video-only-${sb.lang}-${fmt}.mp4`);
    const finalDur = assembleFinalVideo({ segments, bridges, width: w, outVideoOnly: videoOnlyMp4, segDir });

    const baseName = isWide ? `lean-ritual-intro-${sb.lang}-16x9` : `lean-ritual-intro-${sb.lang}`;
    const finalMp4 = path.join(outDir, `${baseName}.mp4`);
    muxVideoAndAudio({ videoOnlyMp4, audioWav: masterAudioWav, totalDur: finalDur, outMp4: finalMp4 });

    const info = verifyMp4(finalMp4, w, h);
    const frames = extractCheckFrames(finalMp4, framesDir, baseName);
    const sheetPath = path.join(outDir, isWide ? `sheet-${sb.lang}-16x9.jpg` : `sheet-${sb.lang}.jpg`);
    generateContactSheet({ mp4Path: finalMp4, outJpg: sheetPath, thumbW: isWide ? 480 : 320 });

    outputs.push({ format: fmt, path: finalMp4, info, frames, sheetPath });
  }

  return {
    timeline,
    voiceLabel: synth.voiceLabel,
    outputs
  };
}

module.exports = {
  synthesizeAllVoices,
  planLanguageTimeline,
  composeLanguageVideo,
  probeMedia
};
