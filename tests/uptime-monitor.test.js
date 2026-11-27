'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const WORKER_PATH = path.join(ROOT, 'ops', 'uptime-monitor', 'worker.js');
const WRANGLER_TOML_PATH = path.join(ROOT, 'ops', 'uptime-monitor', 'wrangler.toml');

let modPromise;
function loadWorkerModule() {
  if (!modPromise) {
    modPromise = import(pathToFileURL(WORKER_PATH).href);
  }
  return modPromise;
}

function createMemoryKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  let reads = 0;
  let writes = 0;
  return {
    async get(key) {
      reads += 1;
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      writes += 1;
      store.set(key, String(value));
    },
    getState(key) {
      const raw = store.get(key);
      return raw ? JSON.parse(raw) : null;
    },
    get stats() {
      return { reads, writes };
    }
  };
}

function createSilentLogger() {
  const entries = [];
  return {
    entries,
    log: (...args) => entries.push(['log', ...args]),
    warn: (...args) => entries.push(['warn', ...args]),
    error: (...args) => entries.push(['error', ...args])
  };
}

function makeJsonResponse(body, { status = 200, contentType = 'application/json; charset=utf-8' } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: contentType ? { 'content-type': contentType } : {}
  });
}

const SECRET_TOPIC = 'super-secret-ntfy-topic-9f8e7d6c5b4a';
const SECRET_ALERT_URL = `https://ntfy.sh/${SECRET_TOPIC}`;

test('healthy check (200 ok:true revision) sends zero alerts and avoids redundant KV writes', async () => {
  const { runCheck, STATE_KEY, USER_AGENT } = await loadWorkerModule();
  const kv = createMemoryKV();
  const logger = createSilentLogger();
  const probeRequests = [];
  const alertRequests = [];
  let nowMs = Date.parse('2026-11-27T10:00:00.000Z');

  const fakeFetch = async (url, opts) => {
    if (String(url) === SECRET_ALERT_URL) {
      alertRequests.push({ url, opts });
      return new Response('ok', { status: 200 });
    }
    probeRequests.push({ url: String(url), opts });
    return makeJsonResponse({ ok: true, revision: 'abc1234' });
  };

  const env = {
    TARGET_URL: 'https://leanritual.app/api/health',
    ALERT_URL: SECRET_ALERT_URL,
    RETRY_DELAY_MS: '0',
    STATE_KV: kv
  };

  const first = await runCheck(env, { fetch: fakeFetch, now: () => nowMs, sleep: async () => {}, logger });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'up');
  assert.equal(first.revision, 'abc1234');
  assert.equal(first.attempts, 1);
  assert.equal(first.alerted, false);
  assert.equal(alertRequests.length, 0);
  assert.equal(probeRequests.length, 1);
  assert.equal(probeRequests[0].url, 'https://leanritual.app/api/health');
  assert.equal(probeRequests[0].opts.headers['Cache-Control'], 'no-cache');
  assert.equal(probeRequests[0].opts.headers['User-Agent'], USER_AGENT);
  assert.equal(probeRequests[0].opts.redirect, 'manual');
  assert.ok(probeRequests[0].opts.signal instanceof AbortSignal);

  assert.equal(kv.stats.writes, 1);
  assert.deepEqual(kv.getState(STATE_KEY), {
    status: 'up',
    since: '2026-11-27T10:00:00.000Z',
    lastAlertAt: null,
    consecutiveFailures: 0,
    lastRevision: 'abc1234',
    lastError: null
  });

  // Second steady-state healthy tick should not trigger a redundant KV write.
  nowMs += 2 * 60 * 1000;
  const second = await runCheck(env, { fetch: fakeFetch, now: () => nowMs, sleep: async () => {}, logger });
  assert.equal(second.ok, true);
  assert.equal(second.alerted, false);
  assert.equal(alertRequests.length, 0);
  assert.equal(kv.stats.writes, 1, 'steady-state healthy tick should not rewrite unchanged KV state');
});

test('transient first-attempt blip that succeeds on immediate retry sends zero alerts', async () => {
  const { runCheck } = await loadWorkerModule();
  const kv = createMemoryKV();
  const logger = createSilentLogger();
  const sleeps = [];
  const alerts = [];
  let probeAttempt = 0;

  const fakeFetch = async (url, opts) => {
    if (String(url) === SECRET_ALERT_URL) {
      alerts.push(opts.body);
      return new Response('ok', { status: 200 });
    }
    probeAttempt += 1;
    if (probeAttempt === 1) {
      return new Response('Bad Gateway', { status: 502 });
    }
    return makeJsonResponse({ ok: true, revision: 'abc1234567890' });
  };

  const result = await runCheck(
    {
      ALERT_URL: SECRET_ALERT_URL,
      RETRY_DELAY_MS: '3000',
      STATE_KV: kv
    },
    {
      fetch: fakeFetch,
      now: () => Date.parse('2026-11-27T10:02:00.000Z'),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      logger
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.alerted, false);
  assert.deepEqual(sleeps, [3000]);
  assert.equal(alerts.length, 0);
});

test('confirmed UP -> DOWN -> cooldown suppression -> 6h reminder -> DOWN -> UP recovery lifecycle', async () => {
  const { runCheck, STATE_KEY } = await loadWorkerModule();
  const kv = createMemoryKV();
  const logger = createSilentLogger();
  const alerts = [];
  let healthy = true;
  let currentRevision = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let nowMs = Date.parse('2026-11-27T10:00:00.000Z');

  const fakeFetch = async (url, opts) => {
    if (String(url) === SECRET_ALERT_URL) {
      alerts.push({ body: opts.body, headers: opts.headers, method: opts.method });
      return new Response('ok', { status: 200 });
    }
    if (healthy) {
      return makeJsonResponse({ ok: true, revision: currentRevision });
    }
    return new Response('Bad Gateway', { status: 502 });
  };

  const env = {
    ALERT_URL: SECRET_ALERT_URL,
    RETRY_DELAY_MS: '0',
    REMINDER_MINUTES: '360',
    STATE_KV: kv
  };
  const deps = { fetch: fakeFetch, now: () => nowMs, sleep: async () => {}, logger };

  // 1. Baseline UP
  const up1 = await runCheck(env, deps);
  assert.equal(up1.ok, true);
  assert.equal(alerts.length, 0);

  // 2. Confirmed UP -> DOWN at T+2m (both attempt 1 and retry return 502)
  healthy = false;
  nowMs += 2 * 60 * 1000;
  const down1 = await runCheck(env, deps);
  assert.equal(down1.ok, false);
  assert.equal(down1.transition, 'down');
  assert.equal(down1.attempts, 2);
  assert.equal(down1.alerted, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].method, 'POST');
  assert.equal(alerts[0].body, '[DOWN] leanritual.app health check failed: HTTP 502');
  assert.equal(alerts[0].headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(alerts[0].headers.Priority, 'high');

  const stateAfterDown1 = kv.getState(STATE_KEY);
  assert.equal(stateAfterDown1.status, 'down');
  assert.equal(stateAfterDown1.consecutiveFailures, 1);
  assert.equal(stateAfterDown1.since, '2026-11-27T10:02:00.000Z');
  assert.equal(stateAfterDown1.lastAlertAt, '2026-11-27T10:02:00.000Z');
  assert.equal(stateAfterDown1.lastError, 'HTTP 502');

  // 3. Repeat DOWN within 6h cooldown (T+359m after first down): suppressed!
  nowMs += 359 * 60 * 1000;
  const downSuppressed = await runCheck(env, deps);
  assert.equal(downSuppressed.ok, false);
  assert.equal(downSuppressed.transition, 'suppressed');
  assert.equal(downSuppressed.alerted, false);
  assert.equal(alerts.length, 1);
  assert.equal(kv.getState(STATE_KEY).consecutiveFailures, 2);

  // 4. Repeat DOWN at T+360m (6h after lastAlertAt): sends 1 reminder!
  nowMs += 1 * 60 * 1000;
  const downReminder = await runCheck(env, deps);
  assert.equal(downReminder.ok, false);
  assert.equal(downReminder.transition, 'reminder');
  assert.equal(downReminder.alerted, true);
  assert.equal(alerts.length, 2);
  assert.equal(
    alerts[1].body,
    '[DOWN] leanritual.app health check failed (still down for 6h): HTTP 502'
  );
  assert.equal(kv.getState(STATE_KEY).consecutiveFailures, 3);
  assert.equal(kv.getState(STATE_KEY).lastAlertAt, '2026-11-27T16:02:00.000Z');

  // 5. Repeat DOWN 2m after reminder: suppressed again!
  nowMs += 2 * 60 * 1000;
  const downSuppressed2 = await runCheck(env, deps);
  assert.equal(downSuppressed2.transition, 'suppressed');
  assert.equal(downSuppressed2.alerted, false);
  assert.equal(alerts.length, 2);

  // 6. Recovery DOWN -> UP 13m later (total down: 6h 15m) with new revision
  healthy = true;
  currentRevision = 'abcdef9876543210fedcba9876543210abcdef98';
  nowMs += 13 * 60 * 1000;
  const recovered = await runCheck(env, deps);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.transition, 'recovered');
  assert.equal(recovered.alerted, true);
  assert.equal(alerts.length, 3);
  assert.equal(
    alerts[2].body,
    '[RECOVERED] leanritual.app is back up (down for 6h 15m, rev abcdef9)'
  );
  assert.equal(alerts[2].headers.Tags, 'white_check_mark');

  const finalState = kv.getState(STATE_KEY);
  assert.equal(finalState.status, 'up');
  assert.equal(finalState.consecutiveFailures, 0);
  assert.equal(finalState.lastRevision, currentRevision);
  assert.equal(finalState.lastError, null);
  assert.equal(finalState.since, '2026-11-27T16:17:00.000Z');
});

test('failure modes: malformed JSON, non-JSON Content-Type, ok:false, missing revision, HTTP 502, and timeout', async () => {
  const { runCheck } = await loadWorkerModule();

  const cases = [
    {
      name: 'malformed JSON',
      responder: () => makeJsonResponse('{not-valid-json', { status: 200 }),
      expectedReason: /invalid JSON/i
    },
    {
      name: 'non-JSON Content-Type',
      responder: () => new Response('<html>503</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      expectedReason: /unexpected Content-Type/i
    },
    {
      name: 'ok: false',
      responder: () => makeJsonResponse({ ok: false, revision: 'abc1234' }),
      expectedReason: /ok !== true/i
    },
    {
      name: 'missing revision',
      responder: () => makeJsonResponse({ ok: true }),
      expectedReason: /missing health revision/i
    },
    {
      name: 'empty revision string',
      responder: () => makeJsonResponse({ ok: true, revision: '   ' }),
      expectedReason: /missing health revision/i
    },
    {
      name: 'HTTP 502',
      responder: () => new Response('Bad Gateway', { status: 502 }),
      expectedReason: /HTTP 502/
    },
    {
      name: 'timeout error',
      responder: () => {
        const err = new Error('The operation timed out');
        err.name = 'TimeoutError';
        throw err;
      },
      expectedReason: /timeout after 1500ms/i
    }
  ];

  for (const tc of cases) {
    const kv = createMemoryKV();
    const logger = createSilentLogger();
    const alerts = [];
    const fakeFetch = async (url, opts) => {
      if (String(url) === SECRET_ALERT_URL) {
        alerts.push(opts.body);
        return new Response('ok', { status: 200 });
      }
      return tc.responder();
    };

    const result = await runCheck(
      {
        ALERT_URL: SECRET_ALERT_URL,
        PROBE_TIMEOUT_MS: '1500',
        RETRY_DELAY_MS: '0',
        STATE_KV: kv
      },
      { fetch: fakeFetch, now: () => Date.parse('2026-11-27T11:00:00.000Z'), sleep: async () => {}, logger }
    );

    assert.equal(result.ok, false, `${tc.name} should fail`);
    assert.equal(result.attempts, 2, `${tc.name} should retry once before failing`);
    assert.match(result.error, tc.expectedReason, `${tc.name} reason mismatch`);
    assert.equal(alerts.length, 1, `${tc.name} should trigger 1 [DOWN] alert`);
    assert.match(alerts[0], /^\[DOWN\] leanritual\.app health check failed: /);
  }
});

test('real AbortSignal timeout triggers timeout failure cleanly', async () => {
  const { probeOnce } = await loadWorkerModule();

  const slowFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      });
    });

  const result = await probeOnce('https://leanritual.app/api/health', {
    fetchImpl: slowFetch,
    timeoutMs: 50
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout after 50ms');
});

test('fallback without STATE_KV still sends failure alerts cleanly and zero alerts when up', async () => {
  const { runCheck } = await loadWorkerModule();
  const logger = createSilentLogger();
  const alerts = [];
  let shouldFail = false;

  const fakeFetch = async (url, opts) => {
    if (String(url) === SECRET_ALERT_URL) {
      alerts.push(opts.body);
      return new Response('ok', { status: 200 });
    }
    return shouldFail
      ? new Response('Service Unavailable', { status: 503 })
      : makeJsonResponse({ ok: true, revision: 'deadbeef' });
  };

  const env = { ALERT_URL: SECRET_ALERT_URL, RETRY_DELAY_MS: '0' };
  const deps = { fetch: fakeFetch, sleep: async () => {}, logger };

  const up = await runCheck(env, deps);
  assert.equal(up.ok, true);
  assert.equal(up.kvBound, false);
  assert.equal(up.alerted, false);
  assert.equal(alerts.length, 0);

  shouldFail = true;
  const down = await runCheck(env, deps);
  assert.equal(down.ok, false);
  assert.equal(down.kvBound, false);
  assert.equal(down.alerted, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0], '[DOWN] leanritual.app health check failed: HTTP 503');
});

test('ALERT_URL validation and zero secret/URL leaks on alert delivery failures', async () => {
  const { runCheck, sendAlert, STATE_KEY } = await loadWorkerModule();

  // 1. Non-HTTPS ALERT_URL must be refused without logging the URL
  const insecureUrl = 'http://ntfy.sh/insecure-secret-topic-12345';
  const logger1 = createSilentLogger();
  let fetchCalled = false;
  const res1 = await sendAlert(insecureUrl, 'test', {
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response('ok', { status: 200 });
    },
    logger: logger1
  });
  assert.equal(res1.sent, false);
  assert.equal(res1.error, 'invalid_alert_url');
  assert.equal(fetchCalled, false);
  assert.ok(!JSON.stringify(logger1.entries).includes('insecure-secret-topic-12345'));
  assert.ok(!JSON.stringify(res1).includes('insecure-secret-topic-12345'));

  // 2. Thrown error echoing ALERT_URL and HTTP 500 from webhook must never leak ALERT_URL
  const kv = createMemoryKV();
  const logger2 = createSilentLogger();
  const fakeFetchThrowingSecret = async (url) => {
    if (String(url) === SECRET_ALERT_URL) {
      throw new TypeError(`fetch failed for ${SECRET_ALERT_URL} with Authorization: Bearer secret`);
    }
    return new Response('Bad Gateway', { status: 502 });
  };

  const result = await runCheck(
    { ALERT_URL: SECRET_ALERT_URL, RETRY_DELAY_MS: '0', STATE_KV: kv },
    { fetch: fakeFetchThrowingSecret, now: () => Date.parse('2026-11-27T12:00:00.000Z'), sleep: async () => {}, logger: logger2 }
  );
  assert.equal(result.ok, false);
  assert.equal(result.alerted, false);

  const serializedLogs = JSON.stringify(logger2.entries);
  const serializedResult = JSON.stringify(result);
  const serializedState = JSON.stringify(kv.getState(STATE_KEY));
  for (const blob of [serializedLogs, serializedResult, serializedState]) {
    assert.ok(!blob.includes(SECRET_TOPIC), 'ALERT_URL topic must never leak');
    assert.ok(!blob.includes(SECRET_ALERT_URL), 'ALERT_URL must never leak');
    assert.ok(!blob.includes('Bearer secret'), 'Headers/tokens must never leak');
  }

  // Because initial [DOWN] alert delivery failed, lastAlertAt remains null so the next tick retries alerting
  assert.equal(kv.getState(STATE_KEY).lastAlertAt, null);

  // 3. HTTP 500 from alert webhook must also never leak ALERT_URL or response body
  const logger3 = createSilentLogger();
  const res3 = await sendAlert(SECRET_ALERT_URL, '[DOWN] test', {
    fetchImpl: async () => new Response(`bad webhook ${SECRET_ALERT_URL}`, { status: 500 }),
    logger: logger3
  });
  assert.equal(res3.sent, false);
  assert.equal(res3.status, 500);
  assert.ok(!JSON.stringify(logger3.entries).includes(SECRET_TOPIC));
  assert.ok(!JSON.stringify(res3).includes(SECRET_TOPIC));
});

test('corrupt or throwing STATE_KV does not silence outage alerts, and formatDuration handles all ranges', async () => {
  const { runCheck, formatDuration, STATE_KEY } = await loadWorkerModule();

  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(12 * 60_000), '12m');
  assert.equal(formatDuration(6 * 3600_000), '6h');
  assert.equal(formatDuration(65 * 60_000), '1h 5m');
  assert.equal(formatDuration(51 * 3600_000), '2d 3h');

  const corruptKv = createMemoryKV({ [STATE_KEY]: '{not-json' });
  const logger = createSilentLogger();
  const alerts = [];
  const fakeFetch = async (url, opts) => {
    if (String(url) === SECRET_ALERT_URL) {
      alerts.push(opts.body);
      return new Response('ok', { status: 200 });
    }
    return new Response('Redirect', { status: 302, headers: { location: 'http://evil.example/' } });
  };

  const result = await runCheck(
    { ALERT_URL: SECRET_ALERT_URL, RETRY_DELAY_MS: '0', STATE_KV: corruptKv },
    { fetch: fakeFetch, now: () => Date.parse('2026-11-27T12:30:00.000Z'), sleep: async () => {}, logger }
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'HTTP 302');
  assert.equal(result.alerted, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0], '[DOWN] leanritual.app health check failed: HTTP 302');
  assert.equal(corruptKv.getState(STATE_KEY).status, 'down');
});

test('HTTP fetch handler returns 404 and triggers zero outbound requests', async () => {
  const { default: worker } = await loadWorkerModule();
  const origFetch = globalThis.fetch;
  let outboundCalls = 0;
  globalThis.fetch = async () => {
    outboundCalls += 1;
    return new Response('should not be called', { status: 200 });
  };

  try {
    for (const method of ['GET', 'POST', 'HEAD']) {
      const req = new Request('https://lean-ritual-uptime.example.workers.dev/trigger', { method });
      const res = await worker.fetch(req, { ALERT_URL: SECRET_ALERT_URL });
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal(outboundCalls, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('scheduled handler delegates to runCheck using worker env', async () => {
  const { default: worker, STATE_KEY } = await loadWorkerModule();
  const kv = createMemoryKV();
  const origFetch = globalThis.fetch;
  let probedUrl = null;
  globalThis.fetch = async (url) => {
    probedUrl = String(url);
    return makeJsonResponse({ ok: true, revision: 'cafebabe123456' });
  };

  try {
    await worker.scheduled(
      { cron: '*/2 * * * *', scheduledTime: Date.now() },
      { TARGET_URL: 'https://leanritual.app/api/health', RETRY_DELAY_MS: '0', STATE_KV: kv }
    );
    assert.equal(probedUrl, 'https://leanritual.app/api/health');
    const saved = kv.getState(STATE_KEY);
    assert.equal(saved.status, 'up');
    assert.equal(saved.lastRevision, 'cafebabe123456');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('wrangler.toml config and ops/package-release.py boundary are valid', () => {
  const toml = fs.readFileSync(WRANGLER_TOML_PATH, 'utf8');
  assert.match(toml, /^name\s*=\s*"lean-ritual-uptime"/m);
  assert.match(toml, /^main\s*=\s*"worker\.js"/m);
  assert.match(toml, /^workers_dev\s*=\s*false/m);
  assert.match(toml, /crons\s*=\s*\[\s*"\*\/2 \* \* \* \*"\s*\]/);
  assert.match(toml, /TARGET_URL\s*=\s*"https:\/\/leanritual\.app\/api\/health"/);
  assert.doesNotMatch(toml, /^ALERT_URL\s*=/m, 'ALERT_URL must be set via wrangler secret, never committed');

  const releaseScript = fs.readFileSync(path.join(ROOT, 'ops', 'package-release.py'), 'utf8');
  assert.doesNotMatch(releaseScript, /["']ops(?:\/uptime-monitor)?["']/, 'ops/package-release.py must exclude ops/uptime-monitor/');
});
