'use strict';
// lib/media.js: allowlist, symlink containment, one-descriptor lifecycle, Range and validators.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createMedia, ASSETS, VIDEOS } = require('../lib/media');

const NAME = 'intro-zh-9x16.mp4';
const POSTER = 'intro-zh-9x16.jpg';
const BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

/** Media server over a temp root, keeping every handle so tests can prove its fd was released. */
async function fixture(t, { beforeOpen, afterOpen, wrap, videos = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-media-'));
  const host = path.join(dir, 'host'), bundled = path.join(dir, 'bundled');
  fs.mkdirSync(host); fs.mkdirSync(bundled);
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
  const media = createMedia({ mediaDir: host, posterDir: bundled, open });
  const server = http.createServer((req, res) => { media.handle(req, res).catch(() => res.destroy()); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (name, headers = {}, method = 'GET') => fetch(`http://127.0.0.1:${server.address().port}/media/${name}`, { method, headers });
  const settled = async () => {
    // FileHandle.fd is -1 once closed.
    for (let i = 0; i < 100 && handles.some(h => h.fd !== -1); i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(handles.map(h => h.fd), handles.map(() => -1), 'every opened descriptor is closed');
  };
  return { dir, host, bundled, media, handles, call, settled, port: server.address().port };
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
  for (const mediaDir of [null, undefined, '']) assert.equal(await createMedia({ mediaDir, posterDir: 'x' }).enabled(), false);
  assert.equal(await createMedia({ mediaDir: '/nonexistent/media', posterDir: 'x' }).enabled(), false);
  const f = await fixture(t, { videos: false });
  for (const name of ASSETS.keys()) if (name.endsWith('.jpg')) { fs.writeFileSync(path.join(f.host, name), 'host'); fs.writeFileSync(path.join(f.bundled, name), 'bundled'); }
  // A video in the poster folder is never used: MP4s come only from MEDIA_DIR.
  for (const name of VIDEOS) fs.writeFileSync(path.join(f.bundled, name), BYTES);
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
  fs.writeFileSync(path.join(f.bundled, POSTER), 'bundled');
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
  assert.equal(await (await f.call(POSTER)).text(), 'bundled', 'a missing host poster falls back to the bundled one');
  fs.writeFileSync(target, 'host');
  assert.equal(await (await f.call(POSTER)).text(), 'host', 'a host poster wins');
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
