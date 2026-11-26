'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const sharp = require('sharp');

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
const REQUIRE_FFMPEG = process.env.CI === 'true' || process.env.REQUIRE_FFMPEG === '1';

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

async function readCenterRgb(imagePath) {
  const { data, info } = await sharp(imagePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cx = Math.floor(info.width / 2);
  const cy = Math.floor(info.height / 2);
  const offset = (cy * info.width + cx) * info.channels;
  return {
    width: info.width,
    height: info.height,
    r: data[offset],
    g: data[offset + 1],
    b: data[offset + 2]
  };
}

test(
  'extractTitleCover and embedCoverArt capture the 2.0s title frame and remux attached_pic with faststart',
  { skip: !HAS_FFMPEG && !REQUIRE_FFMPEG },
  async () => {
    assert.ok(HAS_FFMPEG, 'ffmpeg and ffprobe must be installed when CI=true or REQUIRE_FFMPEG=1');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-video-cover-test-'));
    try {
      const srcMp4 = path.join(tmpDir, 'title.mp4');
      // Time-varying 3s 320x180 H.264 + AAC fixture:
      //   0.0s..1.5s = red (#DC2626), 1.5s..3.0s = emerald green (#0C7560).
      // Extracting at TITLE_COVER_TIME_SEC (2.0s) must capture emerald green, not the opening frame.
      execFileSync(FFMPEG, [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=#DC2626:s=320x180:r=30:d=1.5',
        '-f', 'lavfi', '-i', 'color=c=#0C7560:s=320x180:r=30:d=1.5',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
        '-map', '[v]',
        '-map', '2:a:0',
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

      // Sanity-check that early frame (0.2s) is red while default TITLE_COVER_TIME_SEC (2.0s) is emerald green.
      const earlyJpg = path.join(tmpDir, 'early.jpg');
      extractTitleCover({ titleSegMp4: srcMp4, outJpg: earlyJpg, atSec: 0.2 });
      const earlyRgb = await readCenterRgb(earlyJpg);
      assert.equal(earlyRgb.width, 320);
      assert.equal(earlyRgb.height, 180);
      assert.ok(
        earlyRgb.r > earlyRgb.g + 80 && earlyRgb.r > earlyRgb.b + 80,
        `expected red frame at 0.2s, got rgb(${earlyRgb.r},${earlyRgb.g},${earlyRgb.b})`
      );

      const coverJpg = path.join(tmpDir, 'poster.jpg');
      extractTitleCover({ titleSegMp4: srcMp4, outJpg: coverJpg, atSec: TITLE_COVER_TIME_SEC });
      assert.ok(fs.existsSync(coverJpg), 'cover JPEG should be written');
      const coverBytes = fs.readFileSync(coverJpg);
      assert.equal(coverBytes[0], 0xff);
      assert.equal(coverBytes[1], 0xd8, 'cover should be a valid JPEG');

      const coverRgb = await readCenterRgb(coverJpg);
      assert.equal(coverRgb.width, 320);
      assert.equal(coverRgb.height, 180);
      assert.ok(
        coverRgb.g > coverRgb.r + 40 && coverRgb.b > coverRgb.r + 20,
        `expected emerald green frame at ${TITLE_COVER_TIME_SEC}s, got rgb(${coverRgb.r},${coverRgb.g},${coverRgb.b})`
      );

      const beforeVideoMd5 = streamMd5(srcMp4, '0:V:0');
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
      assert.equal(streamMd5(outMp4, '0:V:0'), beforeVideoMd5);
      assert.equal(streamMd5(outMp4, '0:a:0'), beforeAudioMd5);

      // Embedded attached_pic bytes match the extracted title-card cover JPEG.
      const extractedCover = path.join(tmpDir, 'extracted-cover.jpg');
      execFileSync(FFMPEG, [
        '-v', 'error', '-y',
        '-i', outMp4,
        '-map', '0:v:1',
        '-c', 'copy',
        extractedCover
      ], { stdio: 'ignore' });
      assert.ok(fs.readFileSync(extractedCover).equals(coverBytes), 'embedded cover bytes should match coverJpg');

      // Faststart guarantee: moov atom precedes mdat.
      const atoms = readTopLevelAtoms(outMp4);
      assert.ok(atoms.includes('moov') && atoms.includes('mdat'));
      assert.ok(atoms.indexOf('moov') < atoms.indexOf('mdat'), `expected moov before mdat, got ${atoms.join(',')}`);

      // In-place embedding works safely via temp file + atomic rename, and re-embedding replaces rather than duplicates the cover.
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
  }
);
