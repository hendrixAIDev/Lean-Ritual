'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const EXIF_PHOTO_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const BOGUS_PHOTO_ID = 'deadbeefdeadbeefdeadbeefdeadbeef';

async function buildExportFixture(baseDir) {
  const exportDir = path.join(baseDir, 'bojin-server-import');
  const writeDoc = (rel, obj) => {
    const file = path.join(exportDir, 'docs', ...rel.split('/')) + '.json';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  };
  writeDoc('app/profile', { weight: 72.5, height: 178, goal: 'lean' });
  writeDoc('app/library', { links: { squat: 'https://example.com/squat' } });
  writeDoc('days/2026-10-12', {
    date: '2026-10-12',
    weight: 72.3,
    meals: [{ id: 'm_lunch', type: '午餐', text: '鸡胸肉沙拉', photo: EXIF_PHOTO_ID }],
  });
  writeDoc('workoutLog/2026-10-12_A', {
    date: '2026-10-12',
    savedAt: '2026-10-12T12:00:00.000Z',
    workout: { plan: 'A', done: true },
  });
  writeDoc('profileHistory/ph_001', { id: 'ph_001', savedAt: '2026-10-01T00:00:00.000Z', weight: 74 });
  writeDoc('feedback/fb_001', { id: 'fb_001', createdAt: '2026-10-05T00:00:00.000Z', text: '训练状态稳定' });

  const blobsDir = path.join(exportDir, 'blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
  const jpegWithExif = await sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: 210, g: 95, b: 45 } },
  })
    .withMetadata({
      orientation: 6,
      exif: {
        IFD0: {
          Make: 'SecretCameraMake',
          Model: 'SecretPhonePro',
          ImageDescription: 'GPS_37.7749_-122.4194_PrivateLocation',
        },
      },
    })
    .jpeg({ quality: 90 })
    .toBuffer();

  // Sanity-check that our fixture JPEG really carries EXIF bytes before import.
  const rawMeta = await sharp(jpegWithExif).metadata();
  assert.equal(rawMeta.format, 'jpeg');
  assert.ok(rawMeta.exif && rawMeta.exif.length > 0);
  assert.ok(jpegWithExif.includes(Buffer.from('SecretCameraMake')));
  assert.ok(jpegWithExif.includes(Buffer.from('GPS_37.7749_-122.4194_PrivateLocation')));

  fs.writeFileSync(path.join(blobsDir, `${EXIF_PHOTO_ID}.jpg`), jpegWithExif);
  fs.writeFileSync(path.join(blobsDir, `${BOGUS_PHOTO_ID}.jpg`), Buffer.from('not-a-valid-image <script>alert(1)</script>'));
  // macOS Finder metadata should be harmlessly ignored.
  fs.writeFileSync(path.join(blobsDir, '.DS_Store'), Buffer.from('finder'));
  fs.writeFileSync(path.join(exportDir, 'docs', '.DS_Store'), Buffer.from('finder'));

  return { exportDir, jpegWithExif };
}

function makeEnv(dataDir, extra = {}) {
  return {
    ...process.env,
    DATA_DIR: dataDir,
    HOST: '127.0.0.1',
    PORT: '0',
    AUTH_BASE_URL: 'http://127.0.0.1:18080',
    AUTH_SECRET: 'import-test-secret-with-at-least-32-characters',
    COOKIE_SECURE: '0',
    TRUST_PROXY: '0',
    MAIL_MODE: 'file',
    OPENROUTER_API_KEY: '',
    ...extra,
  };
}

function runCli(args, env) {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'server.js'), ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (res.error) throw res.error;
  return res;
}

let authIpCounter = 0;
async function createAuthAccount(dataDir, email, { verify = true } = {}) {
  const mails = [];
  const clientIp = `198.51.100.${(++authIpCounter % 250) + 1}`;
  const { createAuth } = require('../lib/auth');
  const service = await createAuth({
    dataDir,
    baseURL: 'http://localhost:8080',
    secret: 'import-test-secret-with-at-least-32-characters',
    cookieSecure: false,
    sendEmail: async m => mails.push(m),
  });
  try {
    const invite = service.invites.issue(email);
    const password = 'strong-migration-test-password';
    const res = await service.auth.handler(new Request('http://localhost:8080/api/auth/sign-up/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ritual-client-ip': clientIp,
        origin: 'http://localhost:8080',
      },
      body: JSON.stringify({ email: invite.email, name: 'Owner', password, invitation: invite.token, consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: '2026-11-25' }),
    }));
    assert.equal(res.status, 200, await res.clone().text());
    if (verify) {
      const verifyMail = mails.find(m => m.kind === 'verify' && m.to === invite.email);
      assert.ok(verifyMail);
      assert.equal((await service.auth.handler(new Request(verifyMail.url))).status, 302);
    }
    return { uid: invite.userId, email: invite.email, password };
  } finally {
    service.close();
  }
}

test('email resolution requires an existing, unambiguous, verified Better Auth account', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-import-auth-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dataDir = path.join(tmp, 'data');
  const { exportDir } = await buildExportFixture(tmp);
  const env = makeEnv(dataDir);

  // Missing auth.sqlite
  let res = runCli(['import-account', '--email', 'nobody@example.com', exportDir], env);
  assert.notEqual(res.status, 0);

  const unverified = await createAuthAccount(dataDir, 'unverified@example.com', { verify: false });
  const verified = await createAuthAccount(dataDir, 'owner@example.com', { verify: true });

  // Missing account
  res = runCli(['import-account', '--email', 'missing@example.com', exportDir], env);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /not found|找不到|不存在/i);

  // Unverified account refused
  res = runCli(['import-account', '--email', unverified.email, exportDir], env);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /verif|未验证/i);

  // Ambiguous normalized email refused
  const dupDir = path.join(tmp, 'dup-data');
  fs.mkdirSync(dupDir, { recursive: true });
  const dupAuth = new DatabaseSync(path.join(dupDir, 'auth.sqlite'));
  dupAuth.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER, createdAt TEXT, updatedAt TEXT);
    INSERT INTO user VALUES ('u_dup_1', 'One', 'dup@example.com', 1, 'now', 'now');
    INSERT INTO user VALUES ('u_dup_2', 'Two', 'DUP@example.com', 1, 'now', 'now');
  `);
  dupAuth.close();
  res = runCli(['import-account', '--email', 'dup@example.com', exportDir], makeEnv(dupDir));
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /ambiguous|多|冲突/i);

  // Verified account resolves with case/whitespace normalization
  res = runCli(['import-account', '--email', '  OWNER@Example.com  ', exportDir, '--dry-run'], env);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, new RegExp(verified.uid));
});

test('dry-run reports collections, normalized photo bytes, skips, undecodable blobs, quota estimate, and writes nothing', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-import-dry-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dataDir = path.join(tmp, 'data');
  const { exportDir } = await buildExportFixture(tmp);
  const owner = await createAuthAccount(dataDir, 'dryrun@example.com', { verify: true });
  const env = makeEnv(dataDir);

  // Before dry-run, bojin.db and blobs/ do not even exist yet.
  assert.equal(fs.existsSync(path.join(dataDir, 'bojin.db')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'blobs')), false);
  const authShaBefore = crypto.createHash('sha256').update(fs.readFileSync(path.join(dataDir, 'auth.sqlite'))).digest('hex');

  const res = runCli(['import-account', '--email', owner.email, exportDir, '--dry-run'], env);
  assert.equal(res.status, 0, res.stderr);

  // Nothing created or modified in DATA_DIR (except transient reader lease which is cleaned up on exit)
  assert.equal(fs.existsSync(path.join(dataDir, 'bojin.db')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'blobs')), false);
  const authShaAfter = crypto.createHash('sha256').update(fs.readFileSync(path.join(dataDir, 'auth.sqlite'))).digest('hex');
  assert.equal(authShaAfter, authShaBefore);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, '.access', 'readers')), []);

  // Verify dry-run output details
  for (const col of ['app', 'days', 'feedback', 'profileHistory', 'workoutLog']) {
    assert.match(res.stdout, new RegExp(`${col}\\b`));
  }
  assert.match(res.stdout, new RegExp(BOGUS_PHOTO_ID));
  assert.match(res.stdout, /dry-run/i);
  assert.match(res.stdout, /quota|额度/i);
});

test('import-account preserves uid paths, fills missing without overwriting, strips EXIF keeping blob id, reports undecodable blobs, is idempotent, and serves over HTTP', { timeout: 30000 }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-import-full-'));
  const dataDir = path.join(tmp, 'data');
  const { exportDir } = await buildExportFixture(tmp);
  const owner = await createAuthAccount(dataDir, 'jay@example.com', { verify: true });
  const other = await createAuthAccount(dataDir, 'other@example.com', { verify: true });
  const env = makeEnv(dataDir, { PORT: '0' });

  // Start the live server FIRST so we also prove import-account runs safely alongside the running app!
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverErr = '';
  child.stderr.on('data', d => { serverErr += d; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise(r => child.once('exit', r));
      child.kill();
      await exited;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const startup = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('startup timeout: ' + serverErr)), 8000);
    child.stdout.once('data', d => { clearTimeout(timer); resolve(d.toString()); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(serverErr)); });
  });
  const port = +startup.match(/:(\d+)/)[1];
  const base = `http://127.0.0.1:${port}`;

  const login = async account => {
    const r = await fetch(base + '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:18080', 'Content-Type': 'application/json', 'X-Bojin': '1' },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  };
  const ownerCookie = await login(owner);
  const otherCookie = await login(other);

  // Seed one pre-existing doc via live HTTP PUT to prove fill-missing never overwrites existing docs.
  const existingProfile = { weight: 70.1, height: 178, existingMarker: 'keep-me' };
  const putRes = await fetch(`${base}/api/doc?path=${encodeURIComponent(`data/users/${owner.uid}/app/app/profile`)}`, {
    method: 'PUT',
    headers: { cookie: ownerCookie, 'Content-Type': 'application/json', 'X-Bojin': '1' },
    body: JSON.stringify({ data: existingProfile }),
  });
  assert.equal(putRes.status, 200);

  // Run real import while server is running
  const first = runCli(['import-account', '--email', owner.email, exportDir], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(BOGUS_PHOTO_ID));
  assert.match(first.stdout, /文档\s*5\s*条.*跳过\s*1\s*条|5.*skipped\s*1/i);

  // Inspect SQLite & filesystem state
  const db = new DatabaseSync(path.join(dataDir, 'bojin.db'), { readOnly: true });
  try {
    const docs = db.prepare('SELECT path, uid, parent, data FROM docs WHERE uid = ? ORDER BY path').all(owner.uid);
    assert.equal(docs.length, 6);
    assert.deepEqual(
      docs.map(d => d.path),
      [
        `data/users/${owner.uid}/app/app/library`,
        `data/users/${owner.uid}/app/app/profile`,
        `data/users/${owner.uid}/app/days/2026-10-12`,
        `data/users/${owner.uid}/app/feedback/fb_001`,
        `data/users/${owner.uid}/app/profileHistory/ph_001`,
        `data/users/${owner.uid}/app/workoutLog/2026-10-12_A`,
      ]
    );
    // Existing doc preserved intact
    const profileRow = docs.find(d => d.path.endsWith('/app/profile'));
    assert.deepEqual(JSON.parse(profileRow.data), existingProfile);
    assert.equal(profileRow.parent, `data/users/${owner.uid}/app/app`);

    // Valid photo stored under SAME id, WebP type, exact normalized byte size; bogus photo absent
    const blobs = db.prepare('SELECT id, uid, type, size FROM blobs').all();
    assert.equal(blobs.length, 1);
    const storedPath = path.join(dataDir, 'blobs', EXIF_PHOTO_ID);
    const storedBytes = fs.readFileSync(storedPath);
    assert.deepEqual({ ...blobs[0] }, {
      id: EXIF_PHOTO_ID,
      uid: owner.uid,
      type: 'image/webp',
      size: storedBytes.length,
    });
    assert.equal(fs.existsSync(path.join(dataDir, 'blobs', BOGUS_PHOTO_ID)), false);

    // EXIF metadata stripped and orientation applied
    const storedMeta = await sharp(storedBytes).metadata();
    assert.equal(storedMeta.format, 'webp');
    assert.equal(storedMeta.exif, undefined);
    assert.equal(storedMeta.width, 24);
    assert.equal(storedMeta.height, 32);
    assert.equal(storedBytes.includes(Buffer.from('SecretCameraMake')), false);
    assert.equal(storedBytes.includes(Buffer.from('SecretPhonePro')), false);
    assert.equal(storedBytes.includes(Buffer.from('GPS_37.7749_-122.4194_PrivateLocation')), false);
  } finally {
    db.close();
  }

  // Live HTTP verification: owner can fetch imported day doc and normalized photo by original ID; other user gets 403/404
  const dayRes = await fetch(`${base}/api/doc?path=${encodeURIComponent(`data/users/${owner.uid}/app/days/2026-10-12`)}`, {
    headers: { cookie: ownerCookie, 'X-Bojin': '1' },
  });
  assert.equal(dayRes.status, 200);
  const dayJson = await dayRes.json();
  assert.equal(dayJson.exists, true);
  assert.equal(dayJson.data.meals[0].photo, EXIF_PHOTO_ID);

  const blobRes = await fetch(`${base}/_blob/${EXIF_PHOTO_ID}`, { headers: { cookie: ownerCookie } });
  assert.equal(blobRes.status, 200);
  assert.equal(blobRes.headers.get('content-type'), 'image/webp');
  const servedBytes = Buffer.from(await blobRes.arrayBuffer());
  assert.equal((await sharp(servedBytes).metadata()).exif, undefined);

  assert.equal((await fetch(`${base}/_blob/${EXIF_PHOTO_ID}`, { headers: { cookie: otherCookie } })).status, 404);

  // Idempotent re-run imports 0 new docs and 0 new photos
  const blobMtimeBefore = fs.statSync(path.join(dataDir, 'blobs', EXIF_PHOTO_ID)).mtimeMs;
  const second = runCli(['import-account', '--email=' + owner.email, exportDir], env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /文档\s*0\s*条.*跳过\s*6\s*条|0.*skipped\s*6/i);
  assert.match(second.stdout, /照片\s*0\s*张.*跳过\s*1\s*张|0.*skipped\s*1/i);
  const blobMtimeAfter = fs.statSync(path.join(dataDir, 'blobs', EXIF_PHOTO_ID)).mtimeMs;
  assert.equal(blobMtimeAfter, blobMtimeBefore);

  // Dry-run on populated bojin.db reports skips and leaves database/blobs completely untouched
  const dryAfter = runCli(['import-account', '--dry-run', `--email=${owner.email}`, exportDir], env);
  assert.equal(dryAfter.status, 0, dryAfter.stderr);
  assert.match(dryAfter.stdout, /待导入\s*0\s*条.*跳过\s*6\s*条/);
  assert.match(dryAfter.stdout, /待导入\s*0\s*张.*跳过\s*1\s*张/);

  // Stop live server and verify imported data passes consistent backup snapshot verification
  const stopped = new Promise(r => child.once('exit', r));
  child.kill();
  await stopped;
  const { createSnapshot, verifySnapshot } = require('../lib/snapshots');
  const snapDir = path.join(tmp, 'post-import-snapshot');
  await createSnapshot(dataDir, snapDir);
  const manifest = verifySnapshot(snapDir);
  assert.ok(manifest.files.some(f => f.name === `blobs/${EXIF_PHOTO_ID}`));
});

test('traversal paths, symlinks, invalid segments, and bad JSON are rejected without writing', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-import-sec-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dataDir = path.join(tmp, 'data');
  const owner = await createAuthAccount(dataDir, 'sec@example.com', { verify: true });
  const env = makeEnv(dataDir);

  // 1. Direct helper path validation rejects traversal and odd segments
  const { validateDocRel } = require('../lib/import-export');
  for (const bad of [
    '',
    'rootonly',
    'a/b/c',
    '../other/profile',
    'days/../../other/profile',
    './profile',
    'days/.',
    'days/..',
    'days/bad space',
    'days/bad$char',
    'days\\2026-10-12',
  ]) {
    assert.throws(() => validateDocRel(bad, owner.uid), /path|路径/i, `expected rejection for ${bad}`);
  }

  // 2. Odd-segment file in docs/ rejected
  const oddDir = path.join(tmp, 'odd-export');
  fs.mkdirSync(path.join(oddDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(oddDir, 'docs', 'orphan.json'), '{"ok":true}');
  let res = runCli(['import-account', '--email', owner.email, oddDir], env);
  assert.notEqual(res.status, 0);

  // 3. Invalid segment character in docs/ rejected
  const badSegDir = path.join(tmp, 'badseg-export');
  fs.mkdirSync(path.join(badSegDir, 'docs', 'days'), { recursive: true });
  fs.writeFileSync(path.join(badSegDir, 'docs', 'days', 'bad name.json'), '{"ok":true}');
  res = runCli(['import-account', '--email', owner.email, badSegDir], env);
  assert.notEqual(res.status, 0);

  // 4. Symlink inside docs/ rejected
  const outsideSecret = path.join(tmp, 'outside.json');
  fs.writeFileSync(outsideSecret, '{"stolen":true}');
  const symDocDir = path.join(tmp, 'symdoc-export');
  fs.mkdirSync(path.join(symDocDir, 'docs', 'days'), { recursive: true });
  fs.symlinkSync(outsideSecret, path.join(symDocDir, 'docs', 'days', '2026-10-12.json'));
  res = runCli(['import-account', '--email', owner.email, symDocDir], env);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /symlink|traversal|符号链接|路径/i);

  // 5. Symlink inside blobs/ rejected
  const symBlobDir = path.join(tmp, 'symblob-export');
  fs.mkdirSync(path.join(symBlobDir, 'blobs'), { recursive: true });
  fs.symlinkSync(outsideSecret, path.join(symBlobDir, 'blobs', `${EXIF_PHOTO_ID}.jpg`));
  res = runCli(['import-account', '--email', owner.email, symBlobDir], env);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /symlink|traversal|符号链接|路径/i);

  // 6. Malformed JSON and non-object JSON rejected
  const badJsonDir = path.join(tmp, 'badjson-export');
  fs.mkdirSync(path.join(badJsonDir, 'docs', 'days'), { recursive: true });
  fs.writeFileSync(path.join(badJsonDir, 'docs', 'days', '2026-10-12.json'), '{not-valid-json');
  res = runCli(['import-account', '--email', owner.email, badJsonDir], env);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /JSON/i);

  fs.writeFileSync(path.join(badJsonDir, 'docs', 'days', '2026-10-12.json'), '[1,2,3]');
  res = runCli(['import-account', '--email', owner.email, badJsonDir], env);
  assert.notEqual(res.status, 0);

  if (fs.existsSync(path.join(dataDir, 'bojin.db'))) {
    const checkDb = new DatabaseSync(path.join(dataDir, 'bojin.db'), { readOnly: true });
    try {
      assert.equal(checkDb.prepare('SELECT COUNT(*) n FROM docs').get().n, 0);
      assert.equal(checkDb.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0);
    } finally {
      checkDb.close();
    }
  }
});

test('document and photo quota errors are reported clearly and leave no partial/orphan files', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-import-quota-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dataDir = path.join(tmp, 'data');
  const { exportDir } = await buildExportFixture(tmp);
  const owner = await createAuthAccount(dataDir, 'quota@example.com', { verify: true });

  // 1. Document count quota exceeded
  let res = runCli(['import-account', '--email', owner.email, exportDir], makeEnv(dataDir, { DOC_USER_COUNT: '2' }));
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /doc_quota|文档.*上限|文档额度/i);

  // 2. Document byte quota exceeded
  res = runCli(['import-account', '--email', owner.email, exportDir], makeEnv(dataDir, { DOC_USER_BYTES: '40' }));
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /doc_quota|文档.*上限|文档额度/i);

  let db = new DatabaseSync(path.join(dataDir, 'bojin.db'), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM docs').get().n, 0);
  db.close();

  // 3. Photo user byte quota exceeded (docs fit, photo exceeds 10 bytes)
  res = runCli(['import-account', '--email', owner.email, exportDir], makeEnv(dataDir, { PHOTO_USER_BYTES: '10' }));
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /storage_quota|照片.*上限|照片.*额度/i);

  db = new DatabaseSync(path.join(dataDir, 'bojin.db'), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0);
  db.close();
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'blobs')), []);

  // 4. Maintenance exclusive lock blocks import-account cleanly
  const { exclusive } = require('../lib/data-access');
  const releaseMaint = exclusive(dataDir);
  try {
    res = runCli(['import-account', '--email', owner.email, exportDir], makeEnv(dataDir));
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /maintenance/i);
  } finally {
    releaseMaint();
  }
});

test('legacy import <username> <dir> remains working unchanged', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-import-legacy-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Legacy export dir (without bogus blob since legacy importDir copies raw bytes)
  const legacyExport = path.join(tmp, 'legacy-export');
  fs.mkdirSync(path.join(legacyExport, 'docs', 'app'), { recursive: true });
  fs.mkdirSync(path.join(legacyExport, 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(legacyExport, 'docs', 'app', 'profile.json'), JSON.stringify({ weight: 68 }));
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'green' } }).png().toBuffer();
  fs.writeFileSync(path.join(legacyExport, 'blobs', `${EXIF_PHOTO_ID}.png`), png);

  const db = new DatabaseSync(path.join(dataDir, 'bojin.db'));
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, created TEXT NOT NULL, mustChange INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users VALUES ('u_legacy_user', 'legacyjay', 'unused', '2026-01-01', 0);
  `);
  db.close();

  const res = runCli(['import', 'LegacyJay', legacyExport], makeEnv(dataDir));
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /导入完成：文档 1 条（已存在跳过 0 条），照片 1 张/);

  const inspect = new DatabaseSync(path.join(dataDir, 'bojin.db'), { readOnly: true });
  try {
    const doc = inspect.prepare('SELECT uid, data FROM docs WHERE path = ?').get('data/users/u_legacy_user/app/app/profile');
    assert.equal(doc.uid, 'u_legacy_user');
    assert.deepEqual(JSON.parse(doc.data), { weight: 68 });
    const blob = inspect.prepare('SELECT uid, type, size FROM blobs WHERE id = ?').get(EXIF_PHOTO_ID);
    assert.equal(blob.uid, 'u_legacy_user');
    assert.equal(blob.type, 'image/png');
    assert.equal(blob.size, png.length);
  } finally {
    inspect.close();
  }
});
