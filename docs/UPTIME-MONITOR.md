# External Uptime Monitor (Cloudflare Worker)

A $0-cost external uptime monitor running on Cloudflare's edge (`ops/uptime-monitor/`) that probes `https://leanritual.app/api/health` every 2 minutes via a Cron Trigger and alerts an `ntfy`-compatible HTTPS webhook (`ALERT_URL`) on state transitions.

## Why this exists

- **GitHub Actions cron is best-effort:** `.github/workflows/uptime.yml` can skip scheduled slots under GitHub queue load.
- **On-host watchdogs cannot alert if the VM itself is unreachable:** `ops/health-watchdog.sh` runs on the Aliyun host, so a network/host outage silences it.
- **Cloudflare Workers Free Tier fits comfortably:** `*/2 * * * *` is **720 invocations/day** (vs. 100,000/day free). Steady-state healthy checks perform **1 KV read and 0 KV writes** per run (vs. 100,000 reads/day and 1,000 writes/day free).

## Behavior

- **Probe validation:** `GET TARGET_URL` (`https://leanritual.app/api/health`) with `Cache-Control: no-cache`, custom `User-Agent`, `redirect: "manual"`, and an `8s` timeout (`AbortSignal.timeout`). Requires HTTP `200`, JSON `Content-Type`, `body.ok === true`, and a non-empty string `body.revision`.
- **Anti-flap confirmation:** On any failure, waits `RETRY_DELAY_MS` (default `3000 ms`) and performs **one immediate retry** inside the same cron run before declaring the site down.
- **State deduplication (`STATE_KV`):**
  - `UP → DOWN`: sends one `[DOWN] leanritual.app health check failed: <reason>` alert.
  - Still `DOWN`: suppresses duplicate alerts for `REMINDER_MINUTES` (default `360` = 6 hours), then sends periodic reminders.
  - `DOWN → UP`: sends one `[RECOVERED] leanritual.app is back up (down for <duration>, rev <short-sha>)` alert.
  - **Without `STATE_KV`:** falls back cleanly by sending a `[DOWN]` alert on every failed cron run (no deduplication and no `[RECOVERED]` notice). Binding `STATE_KV` is strongly recommended.
- **Public HTTP surface disabled:** `workers_dev = false` in `wrangler.toml` and the `fetch()` handler unconditionally returns `404 Not Found`, so nobody can trigger outbound probes over HTTP.
- **Secret safety:** `ALERT_URL` is stored as a Cloudflare Worker secret, validated as HTTPS-only, and never logged on errors.

## 5-Step Setup

All commands below are run from `ops/uptime-monitor/`:

```sh
cd ops/uptime-monitor
```

### 1. Authenticate Wrangler with Cloudflare

```sh
wrangler login
wrangler whoami
```

### 2. Create and bind the `STATE_KV` namespace

```sh
wrangler kv namespace create STATE_KV
```

Copy the returned `id` into `ops/uptime-monitor/wrangler.toml` by uncommenting the `[[kv_namespaces]]` block:

```toml
[[kv_namespaces]]
binding = "STATE_KV"
id = "<your-kv-namespace-id>"
```

### 3. Configure the `ALERT_URL` secret

Set your `ntfy` (or other plain-text HTTPS POST) webhook URL as an encrypted Worker secret (never commit it to `wrangler.toml`):

```sh
wrangler secret put ALERT_URL
# Paste e.g.: https://ntfy.sh/<long-random-topic-name>
```

### 4. Deploy the Worker and Cron Trigger

```sh
wrangler deploy
```

### 5. Verify live execution

Tail live cron logs (wait up to 2 minutes for the next `*/2 * * * *` tick):

```sh
wrangler tail
```

Inspect the persisted KV state after a tick completes (replace `<your-kv-namespace-id>` with the ID from Step 2):

```sh
wrangler kv key get --namespace-id="<your-kv-namespace-id>" "uptime:state:v1" --remote
```

Expected healthy output:

```json
{"status":"up","since":"...","lastAlertAt":null,"consecutiveFailures":0,"lastRevision":"...","lastError":null}
```

To verify failure alerting safely without touching production, deploy to a temporary target or run local unit tests from the repo root:

```sh
node --test tests/uptime-monitor.test.js
```

## Optional Configuration (`[vars]` in `wrangler.toml`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `TARGET_URL` | `https://leanritual.app/api/health` | HTTPS health endpoint to probe |
| `PROBE_TIMEOUT_MS` | `8000` | Per-attempt probe timeout in ms (`100`–`30000`) |
| `RETRY_DELAY_MS` | `3000` | Delay in ms before the single anti-flap retry (`0`–`15000`) |
| `REMINDER_MINUTES` | `360` | Cooldown between repeat `[DOWN]` reminders (`1`–`10080`) |

## Teardown

To remove the Worker, its Cron Trigger, and optionally the KV namespace:

```sh
cd ops/uptime-monitor
wrangler delete --name lean-ritual-uptime
wrangler kv namespace delete --namespace-id="<your-kv-namespace-id>"
```
