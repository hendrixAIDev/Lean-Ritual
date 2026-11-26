'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ttsGemini = require('../tools/demo-video/tts_gemini');
const ttsElevenLabs = require('../tools/demo-video/tts_elevenlabs');
const ttsIflytek = require('../tools/demo-video/tts_iflytek');
const { startLocalServer } = require('../tools/demo-video/seed');
const { createAIProxy } = require('../lib/ai');
const { CONSENT_VERSION } = require('../lib/auth');
const { DatabaseSync } = require('node:sqlite');

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

test('Finding 1: tools/demo-video is excluded from Docker context (.dockerignore) and release bundle', () => {
  const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  const rules = dockerignore
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  assert.ok(
    rules.includes('tools/demo-video') || rules.includes('tools/demo-video/') || rules.includes('tools'),
    '.dockerignore must exclude tools/demo-video'
  );
  assert.ok(
    !rules.some(r => /^!tools(?:\/demo-video)?(?:\/|$)/.test(r)),
    '.dockerignore must not re-include tools/demo-video'
  );

  const releaseScript = fs.readFileSync(path.join(ROOT, 'ops', 'package-release.py'), 'utf8');
  assert.doesNotMatch(releaseScript, /["']tools(?:\/demo-video)?["']/, 'ops/package-release.py must not include tools/demo-video');
});

test('Finding 3 (Gemini): uses x-goog-api-key header and redacts echoed keys before truncation', async () => {
  const fakeKey = 'AIzaSyFakeGeminiSecretKeyForTesting9876543210';
  let capturedUrl = '';
  let capturedHeaders = null;

  await withEnv({ GEMINI_API_KEY: fakeKey }, async () => {
    // 1. Echoed key placed right across the 200-char truncation boundary inside JSON error message
    const pad = 'x'.repeat(185);
    const bodyWithSplitKey = JSON.stringify({
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: `${pad} leaked=${fakeKey} trailing-secret-context`
      }
    });

    await assert.rejects(
      () =>
        ttsGemini.generateAudioFromApi({
          modelId: 'gemini-3.8-flash-tts',
          voiceName: 'Leda',
          stylePrompt: 'warm',
          text: 'SUPER_SECRET_USER_TEXT_DO_NOT_DUMP',
          fetchImpl: async (url, opts) => {
            capturedUrl = String(url);
            capturedHeaders = opts.headers;
            return {
              ok: false,
              status: 400,
              text: async () => bodyWithSplitKey
            };
          }
        }),
      err => {
        assert.ok(!capturedUrl.includes(fakeKey), 'API key must not be in request URL');
        assert.ok(!capturedUrl.includes('?key='), 'Request URL must not use ?key= query parameter');
        assert.equal(capturedHeaders['x-goog-api-key'], fakeKey, 'API key must be passed in x-goog-api-key header');
        assert.ok(!err.message.includes(fakeKey), 'Full API key must not appear in error');
        assert.ok(!err.message.includes('AIzaSyFake'), 'Partial/truncated API key prefix must not appear in error');
        assert.ok(!err.message.includes('9876543210'), 'Partial/truncated API key suffix must not appear in error');
        assert.ok(!err.message.includes('SUPER_SECRET_USER_TEXT'), 'Request body text must not appear in error');
        return true;
      }
    );

    // 2. Non-JSON HTML error echoing key must omit raw body completely
    await assert.rejects(
      () =>
        ttsGemini.generateAudioFromApi({
          modelId: 'gemini-3.8-flash-tts',
          voiceName: 'Leda',
          stylePrompt: 'warm',
          text: 'hello',
          fetchImpl: async () => ({
            ok: false,
            status: 403,
            text: async () => `<html>Forbidden for key ${fakeKey} raw-html-body</html>`
          })
        }),
      err => {
        assert.ok(!err.message.includes(fakeKey));
        assert.ok(!err.message.includes('raw-html-body'));
        assert.match(err.message, /HTTP 403/);
        return true;
      }
    );
  });
});

test('Finding 3 (ElevenLabs): redacts echoed keys across truncation boundaries and omits raw bodies', async () => {
  const fakeKey = 'sk_fake_elevenlabs_secret_key_boundary_test_99999';

  await withEnv({ ELEVENLABS_API_KEY: fakeKey }, async () => {
    const pad = 'y'.repeat(185);
    const bodyWithSplitKey = JSON.stringify({
      detail: {
        status: 'invalid_api_key',
        message: `${pad} token=${fakeKey} extra`
      }
    });

    await assert.rejects(
      () =>
        ttsElevenLabs.apiRequest('/text-to-speech/voice123?output_format=mp3_44100_128', {
          method: 'POST',
          body: { text: 'REQUEST_PAYLOAD_MUST_NOT_LEAK' },
          fetchImpl: async () => ({
            ok: false,
            status: 401,
            text: async () => bodyWithSplitKey
          })
        }),
      err => {
        assert.ok(!err.message.includes(fakeKey), 'Full ElevenLabs key must not appear in error');
        assert.ok(!err.message.includes('sk_fake_eleven'), 'Truncated ElevenLabs key prefix must not appear');
        assert.ok(!err.message.includes('boundary_test_99999'), 'Truncated ElevenLabs key suffix must not appear');
        assert.ok(!err.message.includes('REQUEST_PAYLOAD_MUST_NOT_LEAK'), 'Request payload must not appear');
        return true;
      }
    );

    // Network error echoing key
    await assert.rejects(
      () =>
        ttsElevenLabs.apiRequest('/user/subscription', {
          fetchImpl: async () => {
            throw new Error(`connect failed with xi-api-key=${fakeKey} https://api.elevenlabs.io/v1?secret=${fakeKey}`);
          }
        }),
      err => {
        assert.ok(!err.message.includes(fakeKey));
        assert.ok(!err.message.includes('sk_fake_eleven'));
        return true;
      }
    );
  });
});

test('Finding 3 (iFLYTEK): strips signed URLs, base64 authorization, HMAC signature, and credentials from WebSocket errors', async () => {
  const creds = {
    IFLYTEK_APPID: 'app_secret_id_12345',
    IFLYTEK_API_KEY: 'iflytek_api_key_67890abcdef',
    IFLYTEK_API_SECRET: 'iflytek_api_secret_zyxwvut98765'
  };

  await withEnv(creds, async () => {
    let capturedSignedUrl = '';

    class FakeFailingWebSocket {
      constructor(url) {
        capturedSignedUrl = String(url);
        this.listeners = new Map();
        const u = new URL(capturedSignedUrl);
        const authParam = u.searchParams.get('authorization');
        setImmediate(() => {
          const handlers = this.listeners.get('error') || [];
          for (const fn of handlers) {
            fn({
              message: `Handshake failed for ${capturedSignedUrl} auth=${authParam} key=${creds.IFLYTEK_API_KEY} secret=${creds.IFLYTEK_API_SECRET} app=${creds.IFLYTEK_APPID}`
            });
          }
        });
      }
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      }
      close() {}
    }

    await assert.rejects(
      () =>
        ttsIflytek.synthesizeRawFromApi({
          text: '测试文本',
          WebSocketImpl: FakeFailingWebSocket
        }),
      err => {
        const u = new URL(capturedSignedUrl);
        const rawAuth = u.searchParams.get('authorization');
        assert.ok(rawAuth && rawAuth.length > 20, 'Signed URL should contain base64 authorization');
        assert.ok(!err.message.includes(rawAuth), 'Base64 authorization must be stripped from error');
        assert.ok(!err.message.includes(encodeURIComponent(rawAuth)), 'URL-encoded authorization must be stripped');
        assert.ok(!err.message.includes(creds.IFLYTEK_API_KEY), 'API key must be stripped');
        assert.ok(!err.message.includes(creds.IFLYTEK_API_SECRET), 'API secret must be stripped');
        assert.ok(!err.message.includes(creds.IFLYTEK_APPID), 'App ID must be stripped');
        assert.ok(!err.message.includes('?authorization='), 'Signed query string must be stripped');
        return true;
      }
    );

    // Short-audio path: mocked status=2 frame with <1024 bytes audio and credentials echoed in header.sid
    class FakeShortAudioWebSocket {
      constructor(url) {
        this.url = String(url);
        this.listeners = new Map();
        const u = new URL(this.url);
        const rawAuth = u.searchParams.get('authorization');
        setImmediate(() => {
          for (const fn of this.listeners.get('open') || []) fn({});
        });
        this._rawAuth = rawAuth;
      }
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      }
      send() {
        setImmediate(() => {
          const msg = JSON.stringify({
            header: {
              code: 0,
              status: 2,
              sid: `sid-leak-${creds.IFLYTEK_API_KEY}-${creds.IFLYTEK_API_SECRET}-${this._rawAuth}`
            },
            payload: {
              audio: {
                status: 2,
                audio: Buffer.from('tiny-pcm').toString('base64')
              }
            }
          });
          for (const fn of this.listeners.get('message') || []) fn({ data: msg });
        });
      }
      close() {}
    }

    await assert.rejects(
      () =>
        ttsIflytek.synthesizeRawFromApi({
          text: '测试短音频',
          WebSocketImpl: FakeShortAudioWebSocket
        }),
      err => {
        assert.match(err.message, /unexpectedly small audio/);
        assert.ok(!err.message.includes('sid-leak'), 'Raw sid must not appear in short-audio error');
        assert.ok(!err.message.includes(creds.IFLYTEK_API_KEY), 'API key echoed in sid must not leak');
        assert.ok(!err.message.includes(creds.IFLYTEK_API_SECRET), 'API secret echoed in sid must not leak');
        assert.ok(!err.message.includes(creds.IFLYTEK_APPID), 'App ID must not leak');
        return true;
      }
    );

    // Non-zero API error frame with credentials echoed in both message and sid
    class FakeApiErrorWebSocket {
      constructor(url) {
        this.url = String(url);
        this.listeners = new Map();
        setImmediate(() => {
          for (const fn of this.listeners.get('open') || []) fn({});
        });
      }
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      }
      send() {
        setImmediate(() => {
          const msg = JSON.stringify({
            header: {
              code: 11200,
              message: `denied for ${creds.IFLYTEK_API_KEY} url=${this.url}`,
              sid: `sid-${creds.IFLYTEK_API_SECRET}`
            }
          });
          for (const fn of this.listeners.get('message') || []) fn({ data: msg });
        });
      }
      close() {}
    }

    await assert.rejects(
      () =>
        ttsIflytek.synthesizeRawFromApi({
          text: '测试报错',
          WebSocketImpl: FakeApiErrorWebSocket
        }),
      err => {
        assert.equal(err.code, 11200);
        assert.ok(!err.message.includes(creds.IFLYTEK_API_KEY), 'API key must not leak from code!=0 message');
        assert.ok(!err.message.includes(creds.IFLYTEK_API_SECRET), 'API secret must not leak from code!=0 sid');
        assert.ok(!err.message.includes('?authorization='), 'Signed query string must not leak from code!=0 error');
        return true;
      }
    );

    // Cache metadata writer must not persist raw provider sid
    const iflytekSrc = fs.readFileSync(path.join(ROOT, 'tools', 'demo-video', 'tts_iflytek.js'), 'utf8');
    assert.doesNotMatch(iflytekSrc, /\bsid\s*:\s*res\.sid\b/, 'Cache metadata must omit raw provider sid');
  });
});

test('Finding 4: production server has no demo AI mock hook, and demo server fails closed on unintercepted /api/ai', async () => {
  // 1. Production server.js & lib/ai.js must never reference demo-ai-block or accept loopback OPENROUTER_BASE
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const aiSrc = fs.readFileSync(path.join(ROOT, 'lib', 'ai.js'), 'utf8');
  assert.doesNotMatch(serverSrc, /demo-ai-block|DEMO_AI_MOCK|MOCK_AI/i);
  assert.doesNotMatch(aiSrc, /demo-ai-block|DEMO_AI_MOCK|MOCK_AI/i);

  const memDb = new DatabaseSync(':memory:');
  assert.throws(
    () =>
      createAIProxy(memDb, {
        aiProvider: 'openrouter',
        orKey: 'dummy',
        orBase: 'http://127.0.0.1:9999/api/v1',
        aiDaily: 10,
        aiGlobalDaily: 100,
        aiMaxTokens: 500
      }),
    /OPENROUTER_BASE must use https:\/\/openrouter\.ai/
  );
  memDb.close();

  // 2. Demo server spawned via seed.js preloads demo-ai-block.js and fails closed locally on POST /api/ai
  const srv = await startLocalServer();
  try {
    const cfgRes = await fetch(`${srv.base}/api/config`);
    assert.equal(cfgRes.status, 200);
    const cfg = await cfgRes.json();
    assert.equal(cfg.ai, true, 'Demo server should expose AI controls for UI walkthrough');

    // Create and verify a local user via invite + Better Auth endpoints, then call POST /api/ai directly
    const email = 'ai-failclosed@example.com';
    const inv = srv.invite(email);
    const token = new URL(inv.url).searchParams.get('invite');
    assert.ok(token);

    const regRes = await fetch(`${srv.base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: srv.base },
      body: JSON.stringify({
        name: 'DemoCheck',
        email,
        password: 'demo-ritual-pass-2026',
        invitation: token,
        consentTerms: true,
        consentSensitiveCrossBorder: true,
        agreedConsentVersion: CONSENT_VERSION
      })
    });
    assert.equal(regRes.status, 200, `sign-up failed: ${await regRes.clone().text()}`);

    const mailDir = path.join(srv.dir, 'mail');
    const mails = fs
      .readdirSync(mailDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(mailDir, f), 'utf8')));
    const verifyMail = mails.find(m => m.kind === 'verify' && m.to === email);
    assert.ok(verifyMail, 'Expected verification email in file mail dir');

    const verifyRes = await fetch(verifyMail.url, { redirect: 'manual' });
    assert.ok(verifyRes.status >= 200 && verifyRes.status < 400);

    const loginRes = await fetch(`${srv.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: srv.base },
      body: JSON.stringify({ email, password: 'demo-ritual-pass-2026' })
    });
    assert.equal(loginRes.status, 200);
    const setCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')].filter(Boolean);
    const cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');
    assert.ok(cookieHeader.length > 0, 'Expected session cookie');

    // Direct POST /api/ai bypassing Playwright must fail closed locally without contacting OpenRouter
    const t0 = Date.now();
    const aiRes = await fetch(`${srv.base}/api/ai`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bojin': '1',
        Cookie: cookieHeader
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] })
    });
    const elapsedMs = Date.now() - t0;
    assert.equal(aiRes.status, 502, 'Unintercepted /api/ai must fail closed with 502');
    const aiJson = await aiRes.json();
    assert.equal(aiJson.error, 'ai_failed');
    assert.ok(elapsedMs < 2000, `Expected immediate local fail-closed rejection, took ${elapsedMs}ms`);
  } finally {
    await srv.stop();
  }
});

test('Finding 5: ASSETS.md cites verified iFLYTEK product docs, commercial terms, paid status, and attribution policy', () => {
  const assetsMd = fs.readFileSync(path.join(ROOT, 'tools', 'demo-video', 'ASSETS.md'), 'utf8');
  assert.ok(!assetsMd.includes('superSmart-tts.html'), 'Broken 404 superSmart-tts.html link must be removed');
  assert.ok(assetsMd.includes('https://www.xfyun.cn/doc/spark/super%20smart-tts.html'), 'Must link live super smart-tts API doc');
  assert.ok(assetsMd.includes('https://www.xfyun.cn/doc/tts/online_tts/tts_agreement.html'), 'Must link TTS Service Agreement');
  assert.ok(assetsMd.includes('https://www.xfyun.cn/doc/policy/orderpolicy.html'), 'Must link Open Platform Order Policy');
  assert.ok(assetsMd.includes('https://www.xfyun.cn/doc/policy/agreement.html'), 'Must link Open Platform User Service Agreement');
  assert.match(assetsMd, /owner-confirmed/i, 'Must document owner-confirmed paid plans');
  assert.match(assetsMd, /Attribution/i, 'Must document attribution terms');
});
