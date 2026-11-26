'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  TITLE_COVER_TIME_SEC,
  extractTitleCover,
  embedCoverArt,
  probeMedia
} = require('../tools/demo-video/compose');

const FFMPEG = process.env.FFMPEG_BIN || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const FFPROBE = process.env.FFPROBE_BIN || (fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');
const HAS_FFMPEG =
  spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync(FFPROBE, ['-version'], { stdio: 'ignore' }).status === 0;

function readTopLevelAtoms(filePath) {
  const buf = fs.readFileSync(filePath);
  const atoms = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1');
    if (size === 1) {
      if (pos + 16 > buf.length) break;
      size = Number(buf.readBigUInt64BE(pos + 8));
    } else if (size === 0) {
      size = buf.length - pos;
    }
    if (size < 8) break;
    atoms.push(type);
    pos += size;
  }
  return atoms;
}

function streamMd5(filePath, streamSpec) {
  return execFileSync(
    FFMPEG,
    ['-v', 'error', '-i', filePath, '-map', streamSpec, '-c', 'copy', '-f', 'md5', '-'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
}

test('extractTitleCover and embedCoverArt extract full-res JPEG and remux attached_pic with faststart', { skip: !HAS_FFMPEG }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-video-cover-test-'));
  try {
    const srcMp4 = path.join(tmpDir, 'title.mp4');
    // Synthetic 3s 320x180 H.264 + AAC MP4 matching generator codecs
    execFileSync(FFMPEG, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=#0C1714:s=320x180:r=30:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-movflags', '+faststart',
      srcMp4
    ], { stdio: 'ignore' });

    const beforeInfo = probeMedia(srcMp4);
    assert.equal(beforeInfo.video.codec, 'h264');
    assert.equal(beforeInfo.video.width, 320);
    assert.equal(beforeInfo.video.height, 180);
    assert.equal(beforeInfo.audio.codec, 'aac');
    assert.equal(beforeInfo.cover, null);

    const coverJpg = path.join(tmpDir, 'poster.jpg');
    extractTitleCover({ titleSegMp4: srcMp4, outJpg: coverJpg, atSec: TITLE_COVER_TIME_SEC });
    assert.ok(fs.existsSync(coverJpg), 'cover JPEG should be written');
    const coverBytes = fs.readFileSync(coverJpg);
    assert.equal(coverBytes[0], 0xff);
    assert.equal(coverBytes[1], 0xd8, 'cover should be a valid JPEG');

    const beforeVideoMd5 = streamMd5(srcMp4, '0:v:0');
    const beforeAudioMd5 = streamMd5(srcMp4, '0:a:0');

    const outMp4 = path.join(tmpDir, 'final.mp4');
    embedCoverArt({ inMp4: srcMp4, coverJpg, outMp4 });

    const afterInfo = probeMedia(outMp4);
    assert.equal(afterInfo.video.codec, 'h264');
    assert.equal(afterInfo.video.width, 320);
    assert.equal(afterInfo.video.height, 180);
    assert.equal(afterInfo.audio.codec, 'aac');
    assert.deepEqual(afterInfo.cover, { codec: 'mjpeg', width: 320, height: 180 });
    assert.ok(Math.abs(afterInfo.duration - beforeInfo.duration) < 0.05, 'duration should stay unchanged');

    // Remux-only guarantee: encoded H.264 and AAC elementary streams are byte-identical.
    assert.equal(streamMd5(outMp4, '0:v:0'), beforeVideoMd5);
    assert.equal(streamMd5(outMp4, '0:a:0'), beforeAudioMd5);

    // Faststart guarantee: moov atom precedes mdat.
    const atoms = readTopLevelAtoms(outMp4);
    assert.ok(atoms.includes('moov') && atoms.includes('mdat'));
    assert.ok(atoms.indexOf('moov') < atoms.indexOf('mdat'), `expected moov before mdat, got ${atoms.join(',')}`);

    // In-place embedding also works safely via temp file + atomic rename, and re-embedding replaces rather than duplicates the cover.
    embedCoverArt({ inMp4: srcMp4, coverJpg, outMp4: srcMp4 });
    embedCoverArt({ inMp4: srcMp4, coverJpg, outMp4: srcMp4 });
    const inPlaceInfo = probeMedia(srcMp4);
    assert.deepEqual(inPlaceInfo.cover, { codec: 'mjpeg', width: 320, height: 180 });
    assert.equal(streamMd5(srcMp4, '0:V:0'), beforeVideoMd5);
    assert.equal(streamMd5(srcMp4, '0:a:0'), beforeAudioMd5);
    const rawStreams = JSON.parse(
      execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', srcMp4], { encoding: 'utf8' })
    ).streams;
    assert.equal(rawStreams.filter(s => s.disposition?.attached_pic).length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
