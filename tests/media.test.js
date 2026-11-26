'use strict';
// lib/media.js: allowlist, symlink containment, one-descriptor lifecycle, Range and validators.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createMedia, mediaOptions, ASSETS, VIDEOS, DEFAULT_CHECK_TTL_MS } = require('../lib/media');

const NAME = 'intro-zh-9x16.mp4';
const POSTER = 'intro-zh-9x16.jpg';
const BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

/** Media server over a temp root, keeping every handle so tests can prove its fd was released. */
async function fixture(t, { beforeOpen, afterOpen, wrap, videos = true, checkTtlMs = 0, now, lstat, access } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-media-'));
  const host = path.join(dir, 'host');
  fs.mkdirSync(host);
  if (videos) for (const name of VIDEOS) fs.writeFileSync(path.join(host, name), BYTES);
  const handles = [];
  const open = async (file, flags) => {
    if (beforeOpen) beforeOpen(file);
    const handle = await fs.promises.open(file, flags);
    handles.push(handle);
    if (afterOpen) await afterOpen(file);
    if (wrap) wrap(handle);
    return handle;
  };
  const media = createMedia({ mediaDir: host, open, checkTtlMs, ...(now ? { now } : {}), ...(lstat ? { lstat } : {}), ...(access ? { access } : {}) });
  const server = http.createServer((req, res) => { media.handle(req, res).catch(() => res.destroy()); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (name, headers = {}, method = 'GET') => fetch(`http://127.0.0.1:${server.address().port}/media/${name}`, { method, headers });
  const settled = async () => {
    // FileHandle.fd is -1 once closed.
    for (let i = 0; i < 100 && handles.some(h => h.fd !== -1); i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(handles.map(h => h.fd), handles.map(() => -1), 'every opened descriptor is closed');
  };
  return { dir, host, media, handles, call, settled, port: server.address().port };
}

test('only the four intro videos and their posters can be published', async t => {
  const f = await fixture(t);
  assert.deepEqual([...ASSETS.keys()].sort(), ['intro-en-16x9.jpg', 'intro-en-16x9.mp4', 'intro-en-9x16.jpg', 'intro-en-9x16.mp4',
    'intro-zh-16x9.jpg', 'intro-zh-16x9.mp4', 'intro-zh-9x16.jpg', 'intro-zh-9x16.mp4']);
  for (const name of ['private.mp4', 'family.jpg', 'intro-fr-9x16.mp4', 'intro-zh-9x16.webp', 'intro-zh-1x1.mp4', 'notes.txt']) {
    fs.writeFileSync(path.join(f.host, name), 'private');
    assert.equal((await f.call(name)).status, 404, name);
  }
  fs.mkdirSync(path.join(f.host, 'sub'));
  fs.writeFileSync(path.join(f.host, 'sub', NAME), 'private');
  for (const name of ['sub%2f' + NAME, '..%2f' + NAME, '%2e%2e%2fhost%2f' + NAME, NAME + '%00', NAME.toUpperCase(), '%zz', '', 'constructor', '__proto__'])
    assert.equal((await f.call(name)).status, 404, name);
  assert.equal(f.handles.length, 0, 'refused names never touch the filesystem');
  for (const name of ASSETS.keys()) {
    fs.writeFileSync(path.join(f.host, name), BYTES);
    const r = await f.call(name);
    assert.equal(r.status, 200, name);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(BYTES));
  }
  await f.settled();
});

test('off by default: nothing is served until MEDIA_DIR holds all four videos as real files', async t => {
  for (const mediaDir of [null, undefined, '']) assert.equal(await createMedia({ mediaDir }).enabled(), false);
  assert.equal(await createMedia({ mediaDir: '/nonexistent/media' }).enabled(), false);
  const f = await fixture(t, { videos: false });
  for (const name of ASSETS.keys()) if (name.endsWith('.jpg')) fs.writeFileSync(path.join(f.host, name), 'host');
  const off = async why => {
    assert.equal(await f.media.enabled(), false, why);
    for (const name of ASSETS.keys()) {
      const r = await f.call(name);
      assert.equal(r.status, 404, why + ': ' + name);
      assert.equal(r.headers.get('cache-control'), 'no-cache', 'the 404 must not outlive installing the videos');
      assert.equal(await r.text(), '');
    }
  };
  await off('no videos');
  for (const name of VIDEOS.slice(0, 3)) { fs.writeFileSync(path.join(f.host, name), BYTES); await off('incomplete set'); }
  const last = path.join(f.host, VIDEOS[3]);
  fs.writeFileSync(last, ''); await off('empty file'); fs.unlinkSync(last);
  fs.mkdirSync(last); await off('directory'); fs.rmdirSync(last);
  fs.symlinkSync(path.join(f.host, VIDEOS[0]), last); await off('symlink'); fs.unlinkSync(last);
  fs.writeFileSync(last, BYTES);
  if (process.getuid() !== 0) { fs.chmodSync(last, 0); await off('unreadable'); fs.chmodSync(last, 0o600); }
  assert.equal(f.handles.length, 0, 'no file is opened while hidden');
  assert.equal(await f.media.enabled(), true);
  for (const name of ASSETS.keys()) assert.equal((await f.call(name)).status, 200, name);
  for (const name of VIDEOS) {
    const file = path.join(f.host, name);
    fs.renameSync(file, file + '.off');
    await off('withdrawn without a restart: ' + name);
    fs.renameSync(file + '.off', file);
  }
  assert.equal(await f.media.enabled(), true);
  await f.settled();
});

test('symlinks, directories and FIFOs under an allowed name are refused', async t => {
  const f = await fixture(t);
  const target = path.join(f.host, POSTER);
  const secret = path.join(f.dir, 'secret.jpg');
  fs.writeFileSync(secret, 'outside the root');
  fs.writeFileSync(path.join(f.host, 'inside.jpg'), 'inside the root');
  for (const to of [secret, path.join(f.host, 'inside.jpg'), path.join(f.dir, 'dangling')]) {
    fs.symlinkSync(to, target);
    const r = await f.call(POSTER);
    assert.equal(r.status, 404, 'symlink to ' + to);
    assert.equal(await r.text(), '');
    fs.unlinkSync(target);
  }
  fs.mkdirSync(target);
  assert.equal((await f.call(POSTER)).status, 404, 'directory');
  fs.rmdirSync(target);
  assert.equal(spawnSync('mkfifo', [target]).status, 0);
  assert.equal((await f.call(POSTER)).status, 404, 'a FIFO neither hangs nor serves');
  fs.unlinkSync(target);
  assert.equal((await f.call(POSTER)).status, 404, 'a missing host poster returns 404 with no bundled fallback');
  fs.writeFileSync(target, 'host');
  assert.equal(await (await f.call(POSTER)).text(), 'host', 'a host poster is served from MEDIA_DIR');
  await f.settled();
});

test('a video swapped for a symlink after the availability check is still refused', async t => {
  const f = await fixture(t, { beforeOpen: file => { fs.unlinkSync(file); fs.symlinkSync('/etc/hosts', file); } });
  assert.equal((await f.call(NAME)).status, 404);
  await f.settled();
});

test('headers and bytes come from one descriptor even if the path is swapped after open', async t => {
  const f = await fixture(t, { afterOpen: file => {
    if (!fs.existsSync(file)) return;
    fs.renameSync(file, file + '.old');
    fs.symlinkSync('/etc/hosts', file);
  } });
  fs.writeFileSync(path.join(f.host, NAME), BYTES);
  const r = await f.call(NAME);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), String(BYTES.length));
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(BYTES));
  await f.settled();
});

test('descriptors close on 200, 206, HEAD, 304, 416, stat failure, read failure and truncation', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.host, NAME), BYTES);
  const full = await f.call(NAME); await full.arrayBuffer();
  const etag = full.headers.get('etag');
  for (const [headers, method, status] of [[{ Range: 'bytes=0-9' }, 'GET', 206], [{}, 'HEAD', 200], [{ 'If-None-Match': etag }, 'GET', 304], [{ Range: 'bytes=9999-' }, 'GET', 416]]) {
    const r = await f.call(NAME, headers, method);
    assert.equal(r.status, status);
    await r.arrayBuffer();
  }
  assert.equal(f.handles.length, 5);
  await f.settled();

  const badStat = await fixture(t, { wrap: h => { h.stat = async () => { throw Object.assign(new Error('x'), { code: 'EIO' }); }; } });
  fs.writeFileSync(path.join(badStat.host, NAME), BYTES);
  assert.equal((await badStat.call(NAME)).status, 404);
  await badStat.settled();

  const setup = await fixture(t, { wrap: h => { h.createReadStream = () => { throw Object.assign(new Error('x'), { code: 'EIO' }); }; } });
  fs.writeFileSync(path.join(setup.host, NAME), BYTES);
  await assert.rejects(async () => { await (await setup.call(NAME)).arrayBuffer(); });
  await setup.settled();

  // The descriptor reports more bytes than it can deliver: the client must see a broken transfer, not hang.
  const short = await fixture(t, { wrap: h => { const stat = h.stat.bind(h); h.stat = async () => { const st = await stat(); st.size += 1000; return st; }; } });
  fs.writeFileSync(path.join(short.host, NAME), BYTES);
  const started = Date.now();
  await assert.rejects(async () => { await (await short.call(NAME)).arrayBuffer(); });
  assert.ok(Date.now() - started < 2000, 'fails at once instead of waiting for the keep-alive timeout');
  await short.settled();
});

test('a client that disconnects mid-download releases the descriptor', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.host, NAME), Buffer.alloc(32 * 1024 * 1024, 7));
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: f.port, path: '/media/' + NAME }, res => {
      res.once('data', () => { assert.notEqual(f.handles[0].fd, -1, 'still streaming'); req.destroy(); resolve(); });
    });
    req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
  });
  await f.settled();
  assert.equal(f.handles.length, 1);
});

test('Range applies to GET only; units are case-insensitive; multi-range gets the whole file', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.host, NAME), BYTES);
  for (const range of ['bytes=0-9', 'bytes=9999-', 'bytes=nonsense']) {
    const head = await f.call(NAME, { Range: range }, 'HEAD');
    assert.equal(head.status, 200, 'HEAD ignores ' + range);
    assert.equal(head.headers.get('content-length'), '4096');
    assert.equal(head.headers.get('content-range'), null);
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  const upper = await f.call(NAME, { Range: 'BYTES=10-19' });
  assert.equal(upper.status, 206);
  assert.ok(Buffer.from(await upper.arrayBuffer()).equals(BYTES.subarray(10, 20)));
  for (const range of ['bytes=0-1,5-6', 'Bytes=0-1, -5', 'items=0-1']) {
    const r = await f.call(NAME, { Range: range });
    assert.equal(r.status, 200, range);
    assert.equal((await r.arrayBuffer()).byteLength, 4096);
  }
  const bad = await f.call(NAME, { Range: 'bytes=9999-' });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('cache-control'), 'no-store', 'an error is never cached for a week');
});

test('validators: If-None-Match (tag, list, weak, *), If-Modified-Since and If-Range', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.host, NAME), BYTES);
  const first = await f.call(NAME); await first.arrayBuffer();
  const etag = first.headers.get('etag'), modified = first.headers.get('last-modified');
  for (const value of ['*', etag, 'W/' + etag, '"other", ' + etag]) for (const method of ['GET', 'HEAD'])
    assert.equal((await f.call(NAME, { 'If-None-Match': value }, method)).status, 304, method + ' ' + value);
  assert.equal((await f.call(NAME, { 'If-None-Match': etag, Range: 'bytes=0-9' })).status, 304, 'If-None-Match wins over Range');
  assert.equal((await f.call('intro-en-9x16.jpg', { 'If-None-Match': '*' })).status, 404, '* does not match a missing file');
  assert.equal((await f.call(NAME, { 'If-Modified-Since': modified })).status, 304);
  assert.equal((await f.call(NAME, { 'If-Modified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' })).status, 200);
  assert.equal((await f.call(NAME, { 'If-None-Match': '"other"', 'If-Modified-Since': modified })).status, 200, 'If-None-Match takes precedence');
  assert.equal((await f.call(NAME, { Range: 'bytes=0-9', 'If-Range': etag })).status, 206);
  assert.equal((await f.call(NAME, { Range: 'bytes=0-9', 'If-Range': '"other"' })).status, 200);
});

test('availability check caches within TTL, refreshes on expiry, and skips fs when MEDIA_DIR is unset', async t => {
  assert.equal(DEFAULT_CHECK_TTL_MS, 30_000);
  assert.deepEqual(mediaOptions({}), { checkTtlMs: 30_000 });
  assert.deepEqual(mediaOptions({ MEDIA_CHECK_TTL_MS: '' }), { checkTtlMs: 30_000 });
  assert.deepEqual(mediaOptions({ MEDIA_CHECK_TTL_MS: '45000' }), { checkTtlMs: 45_000 });
  for (const bad of ['0', '-1', 'abc', '1.5', '300001'])
    assert.throws(() => mediaOptions({ MEDIA_CHECK_TTL_MS: bad }), /MEDIA_CHECK_TTL_MS/);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => createMedia({ mediaDir: '/tmp', checkTtlMs: bad }), /checkTtlMs/);

  let ops = 0;
  const unset = createMedia({
    mediaDir: null,
    lstat: async p => { ops++; return fs.promises.lstat(p); },
    access: async (p, m) => { ops++; return fs.promises.access(p, m); }
  });
  assert.deepEqual(await Promise.all([unset.enabled(), unset.enabled(), unset.enabled()]), [false, false, false]);
  assert.equal(ops, 0, 'unset MEDIA_DIR performs zero filesystem operations');

  let clock = 1000;
  let lstatCount = 0, accessCount = 0;
  const f = await fixture(t, {
    checkTtlMs: DEFAULT_CHECK_TTL_MS,
    now: () => clock,
    lstat: async p => { lstatCount++; return fs.promises.lstat(p); },
    access: async (p, m) => { accessCount++; return fs.promises.access(p, m); }
  });
  // Non-allowlisted paths never trigger an availability probe even on cold cache.
  assert.equal((await f.call('private.mp4')).status, 404);
  assert.equal(lstatCount + accessCount, 0, 'refused asset name triggers no availability check');

  assert.equal(await f.media.enabled(), true);
  assert.equal(lstatCount, 4);
  assert.equal(accessCount, 4);

  // Repeated enabled() and HTTP requests within TTL perform zero extra metadata checks.
  for (let i = 0; i < 5; i++) assert.equal(await f.media.enabled(), true);
  assert.equal((await f.call(NAME, {}, 'HEAD')).status, 200);
  clock += DEFAULT_CHECK_TTL_MS - 1;
  assert.equal(await f.media.enabled(), true);
  assert.equal(lstatCount + accessCount, 8, 'cached true avoids extra fs metadata calls');

  // Remove one file; once TTL expires, the next check observes false and caches it for TTL.
  const removed = path.join(f.host, VIDEOS[3]);
  fs.renameSync(removed, removed + '.off');
  assert.equal(await f.media.enabled(), true, 'still within TTL before expiry');
  clock += 1;
  assert.equal(await f.media.enabled(), false, 're-checked on TTL expiry');
  const afterMiss = lstatCount + accessCount;
  assert.ok(afterMiss > 8 && afterMiss <= 16);
  clock += DEFAULT_CHECK_TTL_MS - 1;
  for (let i = 0; i < 5; i++) assert.equal(await f.media.enabled(), false);
  assert.equal((await f.call(NAME)).status, 404);
  assert.equal(lstatCount + accessCount, afterMiss, 'cached false avoids extra fs metadata calls');

  // Restore file and expire TTL: re-checks and turns back on.
  fs.renameSync(removed + '.off', removed);
  clock += 1;
  assert.equal(await f.media.enabled(), true);
  assert.equal(lstatCount + accessCount, afterMiss + 8);
  await f.settled();
});

test('concurrent availability checks coalesce via single-flight', async t => {
  let clock = 5000;
  let lstatCount = 0, accessCount = 0;
  let releaseGate;
  let gate = new Promise(r => { releaseGate = r; });
  const f = await fixture(t, {
    checkTtlMs: DEFAULT_CHECK_TTL_MS,
    now: () => clock,
    lstat: async p => {
      lstatCount++;
      await gate;
      return fs.promises.lstat(p);
    },
    access: async (p, m) => { accessCount++; return fs.promises.access(p, m); }
  });

  // Launch 10 concurrent checks + 2 HTTP requests while the first probe is in flight.
  const pending = [
    ...Array.from({ length: 10 }, () => f.media.enabled()),
    f.call(NAME, {}, 'HEAD').then(r => r.status === 200),
    f.call(NAME, {}, 'HEAD').then(r => r.status === 200)
  ];
  await new Promise(r => setImmediate(r));
  assert.equal(lstatCount, 1, 'only one in-flight probe started across all concurrent callers');
  releaseGate();
  const results = await Promise.all(pending);
  assert.deepEqual(results, Array(12).fill(true));
  assert.equal(lstatCount, 4);
  assert.equal(accessCount, 4);

  // Expire TTL and verify another burst of concurrent callers also coalesces into one refresh.
  clock += DEFAULT_CHECK_TTL_MS;
  gate = new Promise(r => { releaseGate = r; });
  const burst = Array.from({ length: 8 }, () => f.media.enabled());
  await new Promise(r => setImmediate(r));
  assert.equal(lstatCount, 5, 'only one refresh probe started after TTL expiry');
  releaseGate();
  assert.deepEqual(await Promise.all(burst), Array(8).fill(true));
  assert.equal(lstatCount, 8);
  assert.equal(accessCount, 8);
  await f.settled();
});

test('a miss on a required video invalidates the cached true result, while a missing poster does not', async t => {
  let clock = 1000;
  let ops = 0;
  const f = await fixture(t, {
    checkTtlMs: DEFAULT_CHECK_TTL_MS,
    now: () => clock,
    lstat: async p => { ops++; return fs.promises.lstat(p); },
    access: async (p, m) => { ops++; return fs.promises.access(p, m); }
  });

  // Warm the cache as enabled.
  assert.equal(await f.media.enabled(), true);
  assert.equal(ops, 8);

  // Missing poster returns 404 (no bundled fallback) and does NOT invalidate video availability.
  assert.equal((await f.call(POSTER)).status, 404);
  assert.equal(await f.media.enabled(), true);
  assert.equal(ops, 8, 'missing poster does not bust the cache');

  // Removing a required MP4 and requesting it returns 404 and immediately invalidates the stale true cache.
  const target = path.join(f.host, NAME);
  fs.unlinkSync(target);
  assert.equal((await f.call(NAME)).status, 404);
  assert.equal(await f.media.enabled(), false, 're-checked immediately after video miss');
  const afterDeleteOps = ops;
  assert.ok(afterDeleteOps > 8 && afterDeleteOps <= 16);
  // Subsequent checks within TTL stay cached false (bounded).
  for (let i = 0; i < 5; i++) assert.equal(await f.media.enabled(), false);
  assert.equal(ops, afterDeleteOps);

  // Restore, advance TTL, warm true again, then truncate the video to 0 bytes.
  fs.writeFileSync(target, BYTES);
  clock += DEFAULT_CHECK_TTL_MS;
  assert.equal(await f.media.enabled(), true);
  fs.writeFileSync(target, '');
  assert.equal((await f.call(NAME)).status, 404, '0-byte video is refused even while cached true');
  assert.equal(await f.media.enabled(), false, '0-byte video invalidates cached true');

  // Restore, advance TTL, warm true again, then swap the video for a symlink.
  fs.writeFileSync(target, BYTES);
  clock += DEFAULT_CHECK_TTL_MS;
  assert.equal(await f.media.enabled(), true);
  fs.unlinkSync(target);
  fs.symlinkSync('/etc/hosts', target);
  assert.equal((await f.call(NAME)).status, 404, 'symlinked video is refused even while cached true');
  assert.equal(await f.media.enabled(), false, 'symlinked video invalidates cached true');

  await f.settled();
});
