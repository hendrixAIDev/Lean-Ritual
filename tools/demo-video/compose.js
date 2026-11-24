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

const FFMPEG = process.env.FFMPEG_BIN || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const FFPROBE = process.env.FFPROBE_BIN || (fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');
const UV_BIN = process.env.UV_BIN || (fs.existsSync('/opt/homebrew/bin/uv') ? '/opt/homebrew/bin/uv' : 'uv');
const TRANSITION_DUR = 0.48;
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

function synthesizeAllVoices({ sb, compDir, ttsEngine = 'kokoro' }) {
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

function buildZoomPanFilter({ phoneW, phoneH, sceneDur, camera }) {
  const totalFrames = Math.max(30, Math.round(sceneDur * FPS));
  const maxZoom = camera?.maxZoom || 1.1;
  const delta = Math.max(0.01, maxZoom - 1.0);
  const fx = camera?.fx ?? 0.5;
  const fy = camera?.fy ?? 0.45;
  // Supersample 2x before zoompan so sub-pixel motion has zero integer-pixel jitter.
  const superW = phoneW * 2;
  const superH = phoneH * 2;
  const zExpr = `1+${delta.toFixed(4)}*pow(sin(PI*min(1,in/${totalFrames})),1.4)`;
  const xExpr = `(iw-iw/zoom)*${fx.toFixed(3)}`;
  const yExpr = `(ih-ih/zoom)*${fy.toFixed(3)}`;
  return `scale=${superW}:${superH}:flags=lanczos,zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${phoneW}x${phoneH}:fps=${FPS}`;
}

function renderScene9x16({ rawWebm, trimStart, sceneDur, splitAt, shellPath, sceneOverlays, camera, outMp4 }) {
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
    args.push('-loop', '1', '-i', b.capPath);
    inputIdx[`cap${bi}`] = nextIdx++;
    if (b.calloutPath) {
      args.push('-loop', '1', '-i', b.calloutPath);
      inputIdx[`call${bi}`] = nextIdx++;
    }
  });

  const filters = [];
  const zp = buildZoomPanFilter({ phoneW: PHONE_W, phoneH: PHONE_H, sceneDur, camera });

  filters.push(`color=c=#0C1714:s=${CANVAS_W}x${CANVAS_H}:r=${FPS}:d=${sceneDur.toFixed(3)}[base]`);
  filters.push(
    `[0:v]fps=${FPS},tpad=stop_mode=clone:stop_duration=${padNeeded.toFixed(3)},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,${zp}[phone]`
  );
  filters.push(`[base][phone]overlay=${PHONE_X}:${PHONE_Y}:shortest=1[staged]`);
  filters.push(`[staged][1:v]overlay=0:0:shortest=1[framed]`);

  let cur = 'framed';

  // Top header chip choreography: chapter chip fades in gently; if a beat has a callout, swap cleanly in the top band!
  const b0HasCall = Boolean(beats[0]?.calloutPath);
  const b1HasCall = Boolean(beats[1]?.calloutPath);
  const chapFadeOut = b0HasCall ? 1.8 : b1HasCall ? Math.max(1.5, splitAt - 0.15) : sceneDur - 0.25;

  filters.push(
    `[2:v]fps=${FPS},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,format=rgba,` +
    `fade=t=in:st=0.08:d=0.30:alpha=1,fade=t=out:st=${chapFadeOut.toFixed(3)}:d=0.25:alpha=1[chap]`
  );
  filters.push(
    `[${cur}][chap]overlay=x=0:y='-16*pow(1-min(1,max(0,(t-0.08)/0.30)),3)':shortest=1[top0]`
  );
  cur = 'top0';

  if (b0HasCall) {
    const cStart = 2.0;
    const cEnd = beats.length > 1 ? Math.max(cStart + 1.2, splitAt - 0.2) : sceneDur - 0.3;
    const idx = inputIdx.call0;
    filters.push(
      `[${idx}:v]fps=${FPS},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,format=rgba,` +
      `fade=t=in:st=${cStart.toFixed(3)}:d=0.30:alpha=1,fade=t=out:st=${cEnd.toFixed(3)}:d=0.24:alpha=1[call0]`
    );
    filters.push(
      `[${cur}][call0]overlay=x=0:y='-18*pow(1-min(1,max(0,(t-${cStart.toFixed(3)})/0.32)),3)':shortest=1[top1]`
    );
    cur = 'top1';
  }

  if (b1HasCall) {
    const cStart = Math.max(0.8, splitAt + 0.12);
    const cEnd = Math.max(cStart + 1.0, sceneDur - 0.28);
    const idx = inputIdx.call1;
    filters.push(
      `[${idx}:v]fps=${FPS},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,format=rgba,` +
      `fade=t=in:st=${cStart.toFixed(3)}:d=0.30:alpha=1,fade=t=out:st=${cEnd.toFixed(3)}:d=0.24:alpha=1[call1]`
    );
    filters.push(
      `[${cur}][call1]overlay=x=0:y='-18*pow(1-min(1,max(0,(t-${cStart.toFixed(3)})/0.32)),3)':shortest=1[top2]`
    );
    cur = 'top2';
  }

  // Bottom animated captions: smooth slide-up (+28px -> 0) + alpha fade-in/out!
  if (beats.length === 1) {
    const idx = inputIdx.cap0;
    filters.push(
      `[${idx}:v]fps=${FPS},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,format=rgba,` +
      `fade=t=in:st=0.12:d=0.32:alpha=1,fade=t=out:st=${Math.max(0.5, sceneDur - 0.28).toFixed(3)}:d=0.24:alpha=1[cap0]`
    );
    filters.push(
      `[${cur}][cap0]overlay=x=0:y='${CAP_BAND_Y}+28*pow(1-min(1,max(0,(t-0.12)/0.34)),3)':shortest=1,format=yuv420p[outv]`
    );
  } else {
    const sp = splitAt;
    const c0Out = Math.max(0.8, sp - 0.24);
    const c1In = sp;
    const c1Out = Math.max(c1In + 0.6, sceneDur - 0.28);

    filters.push(
      `[${inputIdx.cap0}:v]fps=${FPS},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,format=rgba,` +
      `fade=t=in:st=0.12:d=0.32:alpha=1,fade=t=out:st=${c0Out.toFixed(3)}:d=0.22:alpha=1[cap0]`
    );
    filters.push(
      `[${cur}][cap0]overlay=x=0:y='${CAP_BAND_Y}+28*pow(1-min(1,max(0,(t-0.12)/0.34)),3)':shortest=1[c0ov]`
    );

    filters.push(
      `[${inputIdx.cap1}:v]fps=${FPS},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,format=rgba,` +
      `fade=t=in:st=${c1In.toFixed(3)}:d=0.32:alpha=1,fade=t=out:st=${c1Out.toFixed(3)}:d=0.24:alpha=1[cap1]`
    );
    filters.push(
      `[c0ov][cap1]overlay=x=0:y='${CAP_BAND_Y}+28*pow(1-min(1,max(0,(t-${c1In.toFixed(3)})/0.34)),3)':shortest=1,format=yuv420p[outv]`
    );
  }

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

function renderScene16x9({ rawWebm, trimStart, sceneDur, splitAt, shell16x9Path, panels, camera, outMp4 }) {
  const rawInfo = probeMedia(rawWebm);
  const avail = Math.max(0.5, rawInfo.duration - trimStart);
  const padNeeded = Math.max(0.25, sceneDur - avail + 0.5);

  const args = [
    '-y',
    '-ss', trimStart.toFixed(3),
    '-i', rawWebm,
    '-loop', '1', '-i', shell16x9Path
  ];
  panels.forEach(p => args.push('-loop', '1', '-i', p));

  const filters = [];
  const zp = buildZoomPanFilter({ phoneW: W16_PHONE_W, phoneH: W16_PHONE_H, sceneDur, camera });

  filters.push(`color=c=#0C1714:s=${W16_CANVAS_W}x${W16_CANVAS_H}:r=${FPS}:d=${sceneDur.toFixed(3)}[base]`);
  filters.push(
    `[0:v]fps=${FPS},tpad=stop_mode=clone:stop_duration=${padNeeded.toFixed(3)},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,${zp}[phone]`
  );
  filters.push(`[base][phone]overlay=${W16_PHONE_X}:${W16_PHONE_Y}:shortest=1[staged]`);
  filters.push(`[staged][1:v]overlay=0:0:shortest=1[framed]`);

  if (panels.length === 1) {
    filters.push(
      `[2:v]fps=${FPS},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,format=rgba,` +
      `fade=t=in:st=0.14:d=0.34:alpha=1,fade=t=out:st=${Math.max(0.5, sceneDur - 0.28).toFixed(3)}:d=0.24:alpha=1[p0]`
    );
    filters.push(
      `[framed][p0]overlay=x=${W16_PANEL_X}:y='${W16_PANEL_Y}+30*pow(1-min(1,max(0,(t-0.14)/0.36)),3)':shortest=1,format=yuv420p[outv]`
    );
  } else {
    const c0Out = Math.max(0.8, splitAt - 0.24);
    const c1In = splitAt;
    const c1Out = Math.max(c1In + 0.6, sceneDur - 0.28);

    filters.push(
      `[2:v]fps=${FPS},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,format=rgba,` +
      `fade=t=in:st=0.14:d=0.34:alpha=1,fade=t=out:st=${c0Out.toFixed(3)}:d=0.22:alpha=1[p0]`
    );
    filters.push(
      `[framed][p0]overlay=x=${W16_PANEL_X}:y='${W16_PANEL_Y}+30*pow(1-min(1,max(0,(t-0.14)/0.36)),3)':shortest=1[ov0]`
    );
    filters.push(
      `[3:v]fps=${FPS},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS,format=rgba,` +
      `fade=t=in:st=${c1In.toFixed(3)}:d=0.34:alpha=1,fade=t=out:st=${c1Out.toFixed(3)}:d=0.24:alpha=1[p1]`
    );
    filters.push(
      `[ov0][p1]overlay=x=${W16_PANEL_X}:y='${W16_PANEL_Y}+30*pow(1-min(1,max(0,(t-${c1In.toFixed(3)})/0.36)),3)':shortest=1,format=yuv420p[outv]`
    );
  }

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

function concatWithTransitions({ segments, width, outVideoOnly }) {
  const args = ['-y'];
  segments.forEach(seg => args.push('-i', seg.mp4));

  const filters = [];
  let accDur = segments[0].duration;
  let prevLabel = '0:v';

  for (let i = 1; i < segments.length; i++) {
    const offset = Math.max(0.1, accDur - TRANSITION_DUR);
    const trans = segments[i].transition || 'smoothleft';
    const outLabel = i === segments.length - 1 ? 'merged' : `xf${i}`;
    filters.push(
      `[${prevLabel}][${i}:v]xfade=transition=${trans}:duration=${TRANSITION_DUR.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`
    );
    accDur = offset + segments[i].duration;
    prevLabel = outLabel;
  }

  // Sleek animated emerald hairline progress bar along top edge across the full video
  const totalDur = accDur;
  filters.push(`color=c=#34D399@0.92:s=${width}x6:r=${FPS}:d=${totalDur.toFixed(3)}[pbar]`);
  filters.push(
    `[merged][pbar]overlay=x='-${width}+${width}*min(1,t/${totalDur.toFixed(3)})':y=0:shortest=1,format=yuv420p[vout]`
  );

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-r', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-level', '4.1',
    '-preset', 'medium',
    '-crf', '24',
    '-maxrate', '1450k',
    '-bufsize', '2900k',
    '-movflags', '+faststart',
    '-an',
    outVideoOnly
  );

  runBin(FFMPEG, args);
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
      `[1:a]atrim=0:${totalDur.toFixed(3)},volume=0.24[bgm0]`,
      `[bgm0][vsc]sidechaincompress=threshold=0.022:ratio=6.5:attack=35:release=460:makeup=1[bgm_duck]`,
      `[vmain][bgm_duck][2:a]amix=inputs=3:duration=first:normalize=0,alimiter=limit=0.95,atrim=0:${totalDur.toFixed(3)}[aout]`
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
  assert.ok(info.duration >= 95 && info.duration <= 135, `${mp4Path}: duration ${info.duration.toFixed(1)}s out of 95-135s range`);
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
      const minForVo = 0.42 + beatVo[0].duration + 0.72;
      sceneDur = Math.max(sceneDur, minForVo);
      voicePlan.push({ segIdx, localOffset: 0.42, wav: beatVo[0].wav });
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

  // Compute global timeline start/end accounting for xfade overlaps
  const timeline = [];
  let cursor = 0;
  plan.forEach((seg, i) => {
    const start = i === 0 ? 0 : cursor - TRANSITION_DUR;
    const end = start + seg.duration;
    timeline.push({ id: seg.id, start, end, duration: seg.duration });
    cursor = end;
  });

  const totalDur = cursor;
  return { plan, timeline, totalDur, titleDur, outroDur, voicePlan, sfxPlan };
}

function composeLanguageVideo({
  sb,
  recordedScenes,
  langAssets,
  sharedAssets,
  workDir,
  outDir,
  formats = ['9x16', '16x9'],
  ttsEngine = 'kokoro',
  preSynth = null
}) {
  const compDir = path.join(workDir, `compose-${sb.lang}`);
  fs.mkdirSync(compDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const synth = preSynth || synthesizeAllVoices({ sb, compDir, ttsEngine });
  const { plan, timeline, totalDur, voicePlan, sfxPlan } = planLanguageTimeline({
    sb,
    recordedScenes,
    voiceCuesMap: synth.cues
  });

  // Generate tailored original BGM + UI SFX
  const soundDir = path.join(compDir, 'sound');
  const sound = generateSoundAssets({ totalDur, soundDir });

  // Build global voice cues and SFX cues
  const voiceCues = voicePlan.map(item => ({
    wav: item.wav,
    startSec: timeline[item.segIdx].start + item.localOffset
  }));

  const sfxCues = [];
  // Add silky transition swoosh at every xfade boundary
  for (let i = 1; i < timeline.length; i++) {
    sfxCues.push({
      wav: sound.sfx.swoosh,
      startSec: Math.max(0.05, timeline[i].start - 0.04),
      gain: 0.42
    });
  }
  const sfxGain = { tap: 0.42, chime: 0.44, pop: 0.34 };
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
          camera: p.scene.camera,
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
          camera: p.scene.camera,
          outMp4: segMp4
        });
      }
      segments.push({ id: p.id, mp4: segMp4, duration: p.duration, transition: p.transition });
    }

    const videoOnlyMp4 = path.join(compDir, `video-only-${sb.lang}-${fmt}.mp4`);
    const finalDur = concatWithTransitions({ segments, width: w, outVideoOnly: videoOnlyMp4 });

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
