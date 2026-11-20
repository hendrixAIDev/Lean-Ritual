'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PHONE_W, PHONE_H, PHONE_X, PHONE_Y, CANVAS_W, CANVAS_H } = require('./assets');

const FFMPEG = process.env.FFMPEG_BIN || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const FFPROBE = process.env.FFPROBE_BIN || (fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');
const FADE_DUR = 0.35;
const FPS = 30;
const MAX_BYTES = 25 * 1024 * 1024;

function runBin(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').slice(-1500);
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

function synthesizeVoiceWav({ text, voice, rate, outWav, tmpDir, tag }) {
  const aiff = path.join(tmpDir, `${tag}.aiff`);
  runBin('/usr/bin/say', ['-v', voice, '-r', String(rate), '-o', aiff, text]);
  runBin(FFMPEG, [
    '-y',
    '-i', aiff,
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    outWav
  ]);
  fs.rmSync(aiff, { force: true });
  return probeMedia(outWav).duration;
}

function renderStaticCardVideo({ imgPath, duration, outMp4 }) {
  runBin(FFMPEG, [
    '-y',
    '-loop', '1',
    '-i', imgPath,
    '-t', duration.toFixed(3),
    '-r', String(FPS),
    '-vf', `scale=${CANVAS_W}:${CANVAS_H},format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-an',
    outMp4
  ]);
}

function renderSceneVideo({ rawWebm, trimStart, sceneDur, splitAt, shellPath, overlays, outMp4 }) {
  const rawInfo = probeMedia(rawWebm);
  const avail = Math.max(0.5, rawInfo.duration - trimStart);
  const padNeeded = Math.max(0.25, sceneDur - avail + 0.5);

  const args = [
    '-y',
    '-ss', trimStart.toFixed(3),
    '-i', rawWebm,
    '-loop', '1', '-i', shellPath
  ];

  overlays.forEach(ov => {
    args.push('-loop', '1', '-i', ov);
  });

  const filters = [];
  filters.push(`color=c=#0D1613:s=${CANVAS_W}x${CANVAS_H}:r=${FPS}:d=${sceneDur.toFixed(3)}[base]`);
  filters.push(
    `[0:v]fps=${FPS},scale=${PHONE_W}:${PHONE_H}:flags=lanczos,tpad=stop_mode=clone:stop_duration=${padNeeded.toFixed(3)},trim=duration=${sceneDur.toFixed(3)},setpts=PTS-STARTPTS[phone]`
  );
  filters.push(`[base][phone]overlay=${PHONE_X}:${PHONE_Y}:shortest=1[staged]`);
  filters.push(`[staged][1:v]overlay=0:0:shortest=1[framed]`);

  if (overlays.length === 1) {
    filters.push(`[framed][2:v]overlay=0:0:shortest=1,format=yuv420p[outv]`);
  } else {
    const sp = splitAt.toFixed(3);
    filters.push(`[framed][2:v]overlay=0:0:enable='lt(t,${sp})':shortest=1[ov0]`);
    filters.push(`[ov0][3:v]overlay=0:0:enable='gte(t,${sp})':shortest=1,format=yuv420p[outv]`);
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

function concatWithCrossfades({ segments, outVideoOnly }) {
  const args = ['-y'];
  segments.forEach(seg => args.push('-i', seg.mp4));

  const filters = [];
  let accDur = segments[0].duration;
  let prevLabel = '0:v';

  for (let i = 1; i < segments.length; i++) {
    const offset = Math.max(0.1, accDur - FADE_DUR);
    const outLabel = i === segments.length - 1 ? 'vout' : `xf${i}`;
    filters.push(
      `[${prevLabel}][${i}:v]xfade=transition=fade:duration=${FADE_DUR.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`
    );
    accDur = offset + segments[i].duration;
    prevLabel = outLabel;
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-r', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-level', '4.1',
    '-preset', 'medium',
    '-crf', '22',
    '-movflags', '+faststart',
    '-an',
    outVideoOnly
  );

  runBin(FFMPEG, args);
  return accDur;
}

function muxSilentAac({ videoOnlyMp4, totalDur, outMp4 }) {
  runBin(FFMPEG, [
    '-y',
    '-i', videoOnlyMp4,
    '-f', 'lavfi',
    '-i', 'anullsrc=r=48000:cl=stereo',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-t', totalDur.toFixed(3),
    '-movflags', '+faststart',
    outMp4
  ]);
}

function muxVoiceoverAac({ videoOnlyMp4, voiceCues, totalDur, outMp4 }) {
  const args = ['-y', '-i', videoOnlyMp4];
  voiceCues.forEach(c => args.push('-i', c.wav));

  const filters = [];
  const mixInputs = [];
  voiceCues.forEach((cue, i) => {
    const idx = i + 1;
    const ms = Math.max(0, Math.round(cue.startSec * 1000));
    filters.push(`[${idx}:a]adelay=${ms}|${ms}[a${idx}]`);
    mixInputs.push(`[a${idx}]`);
  });

  filters.push(
    `${mixInputs.join('')}amix=inputs=${voiceCues.length}:duration=longest:normalize=0,volume=1.18,alimiter=limit=0.95,apad,atrim=0:${totalDur.toFixed(3)}[aout]`
  );

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '0:v:0',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-t', totalDur.toFixed(3),
    '-movflags', '+faststart',
    outMp4
  );

  runBin(FFMPEG, args);
}

function extractCheckFrames(mp4Path, framesDir, prefix) {
  fs.mkdirSync(framesDir, { recursive: true });
  const info = probeMedia(mp4Path);
  const pcts = [0.06, 0.22, 0.40, 0.58, 0.76, 0.94];
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

function verifyMp4(mp4Path) {
  const info = probeMedia(mp4Path);
  assert.equal(info.video?.codec, 'h264', `${mp4Path}: expected h264 video`);
  assert.equal(info.video?.width, CANVAS_W, `${mp4Path}: expected width ${CANVAS_W}`);
  assert.equal(info.video?.height, CANVAS_H, `${mp4Path}: expected height ${CANVAS_H}`);
  assert.ok(Math.abs(info.video.fps - FPS) < 0.5, `${mp4Path}: expected ${FPS}fps, got ${info.video.fps}`);
  assert.equal(info.audio?.codec, 'aac', `${mp4Path}: expected aac audio`);
  assert.ok(info.duration >= 100 && info.duration <= 130, `${mp4Path}: duration ${info.duration.toFixed(1)}s out of 100-130s range`);
  assert.ok(info.sizeBytes <= MAX_BYTES, `${mp4Path}: size ${(info.sizeBytes / 1048576).toFixed(2)} MB exceeds 25 MB`);
  return info;
}

function composeLanguageVideo({ sb, recordedScenes, langAssets, shellPath, workDir, outDir }) {
  const compDir = path.join(workDir, `compose-${sb.lang}`);
  fs.mkdirSync(compDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Synthesize all macOS `say` voiceover WAVs and measure exact spoken durations
  const titleWav = path.join(compDir, 'vo-title.wav');
  const titleVoDur = synthesizeVoiceWav({
    text: sb.titleCard.narration,
    voice: sb.voice.name,
    rate: sb.voice.rate,
    outWav: titleWav,
    tmpDir: compDir,
    tag: 'vo-title'
  });

  const outroWav = path.join(compDir, 'vo-outro.wav');
  const outroVoDur = synthesizeVoiceWav({
    text: sb.outroCard.narration,
    voice: sb.voice.name,
    rate: sb.voice.rate,
    outWav: outroWav,
    tmpDir: compDir,
    tag: 'vo-outro'
  });

  const recById = new Map(recordedScenes.map(r => [r.id, r]));
  const segments = [];
  const voicePlan = [];

  // Title segment
  const titleDur = Math.max(sb.titleCard.duration, titleVoDur + 0.75);
  const titleMp4 = path.join(compDir, 'seg-00-title.mp4');
  renderStaticCardVideo({ imgPath: langAssets.titlePath, duration: titleDur, outMp4: titleMp4 });
  segments.push({ id: 'title', mp4: titleMp4, duration: titleDur });
  voicePlan.push({ segIdx: 0, localOffset: 0.25, wav: titleWav });

  // App scene segments
  sb.scenes.forEach((sc, idx) => {
    const rec = recById.get(sc.id);
    assert.ok(rec, `Missing recorded video for scene ${sc.id}`);

    const beatWavs = [];
    const beatDurs = [];
    sc.beats.forEach((beat, bi) => {
      const wav = path.join(compDir, `vo-${sc.id}-${bi}.wav`);
      const dur = synthesizeVoiceWav({
        text: beat.narration,
        voice: sb.voice.name,
        rate: sb.voice.rate,
        outWav: wav,
        tmpDir: compDir,
        tag: `vo-${sc.id}-${bi}`
      });
      beatWavs.push(wav);
      beatDurs.push(dur);
    });

    const rawInfo = probeMedia(rec.videoPath);
    const usableDur = Math.max(2.0, rawInfo.duration - rec.trimStart);

    let splitAt = usableDur / 2;
    let sceneDur = Math.max(usableDur, sc.minDuration);
    const segIdx = segments.length;

    if (sc.beats.length === 1) {
      const minForVo = 0.35 + beatDurs[0] + 0.65;
      sceneDur = Math.max(sceneDur, minForVo);
      voicePlan.push({ segIdx, localOffset: 0.35, wav: beatWavs[0] });
    } else {
      const rawSplit = rec.beatSplits[0] ?? usableDur * 0.5;
      const beat0End = 0.35 + beatDurs[0] + 0.35;
      splitAt = Math.max(2.5, Math.min(usableDur - 1.5, rawSplit));
      const voBeat1Start = Math.max(splitAt, beat0End);
      const minForVo = voBeat1Start + beatDurs[1] + 0.7;
      sceneDur = Math.max(sceneDur, minForVo);

      voicePlan.push({ segIdx, localOffset: 0.35, wav: beatWavs[0] });
      voicePlan.push({ segIdx, localOffset: voBeat1Start, wav: beatWavs[1] });
    }

    const segMp4 = path.join(compDir, `seg-${String(idx + 1).padStart(2, '0')}-${sc.id}.mp4`);
    renderSceneVideo({
      rawWebm: rec.videoPath,
      trimStart: rec.trimStart,
      sceneDur,
      splitAt,
      shellPath,
      overlays: langAssets.overlays[sc.id],
      outMp4: segMp4
    });
    segments.push({ id: sc.id, mp4: segMp4, duration: sceneDur });
  });

  // Outro segment
  const outroDur = Math.max(sb.outroCard.duration, outroVoDur + 1.1);
  const outroMp4 = path.join(compDir, 'seg-99-outro.mp4');
  renderStaticCardVideo({ imgPath: langAssets.outroPath, duration: outroDur, outMp4: outroMp4 });
  const outroSegIdx = segments.length;
  segments.push({ id: 'outro', mp4: outroMp4, duration: outroDur });
  voicePlan.push({ segIdx: outroSegIdx, localOffset: 0.45, wav: outroWav });

  // Compute global timeline start/end for each segment (accounting for crossfades)
  const timeline = [];
  let cursor = 0;
  segments.forEach((seg, i) => {
    const start = i === 0 ? 0 : cursor - FADE_DUR;
    const end = start + seg.duration;
    timeline.push({ id: seg.id, start, end, duration: seg.duration });
    cursor = end;
  });

  const videoOnlyMp4 = path.join(compDir, `video-only-${sb.lang}.mp4`);
  const totalDur = concatWithCrossfades({ segments, outVideoOnly: videoOnlyMp4 });

  const voiceCues = voicePlan.map(item => ({
    wav: item.wav,
    startSec: timeline[item.segIdx].start + item.localOffset
  }));

  const silentMp4 = path.join(outDir, `lean-ritual-intro-${sb.lang}.mp4`);
  const voiceMp4 = path.join(outDir, `lean-ritual-intro-${sb.lang}-voice.mp4`);

  muxSilentAac({ videoOnlyMp4, totalDur, outMp4: silentMp4 });
  muxVoiceoverAac({ videoOnlyMp4, voiceCues, totalDur, outMp4: voiceMp4 });

  const silentInfo = verifyMp4(silentMp4);
  const voiceInfo = verifyMp4(voiceMp4);

  const framesDir = path.join(outDir, 'frames');
  const silentFrames = extractCheckFrames(silentMp4, framesDir, `lean-ritual-intro-${sb.lang}`);
  const voiceFrames = extractCheckFrames(voiceMp4, framesDir, `lean-ritual-intro-${sb.lang}-voice`);

  return {
    timeline,
    outputs: [
      { path: silentMp4, info: silentInfo, frames: silentFrames },
      { path: voiceMp4, info: voiceInfo, frames: voiceFrames }
    ]
  };
}

module.exports = { composeLanguageVideo, probeMedia };
