# Aliyun US West staging handoff

Historical provisioning guide. The app is now publicly reachable for invited
testing; see STAGING-STATUS.md for evidence and remaining gates. Host settings
still require inspection. For GitHub automation see GITHUB-DEPLOYMENT.md.

Updated November 4, 2026 (America/Los_Angeles). Jay has provisioned Aliyun US West (Silicon Valley), Ubuntu 24.04, 2 vCPU, 2 GiB RAM and 40 GiB ESSD. This replaces the original Hong Kong assumption. The instance exists; the application has not been deployed there. This capacity is a starting point for a small invitation beta, subject to memory/disk monitoring and load testing.

## Jay: domain and access

1. Register a domain through Cloudflare if the desired name/TLD is available. Registration, DNS hosting and the optional HTTP proxy are separate functions. Cloudflare Registrar requires Cloudflare authoritative DNS; confirm the renewal price and supported TLD before purchase.
2. Choose one canonical app hostname, for example `app.your-domain.com`. In Cloudflare DNS create an A record for `app` pointing to the instance's public IPv4 shown in Aliyun. Start with **DNS only** (gray cloud). Do not create an AAAA record unless IPv6 is actually configured and reachable. Do not enable HSTS/preload during initial setup.
3. In the Aliyun firewall/security group allow inbound TCP 80 and 443. Restrict SSH (22) to the administrator's source address or approved access path. Keep application port 8080 closed publicly. Preserve a working console/SSH session while changing access rules.
4. Provide the chosen hostname and SSH username. Configure scoped SSH access through the approved secret/access configuration, or execute the prepared commands yourself. Do not paste private keys or passwords into chat/Linear. Purchasing a host alone does not give Codex access.
5. Select transactional SMTP and verify its sender domain using the provider's exact SPF/DKIM/DMARC instructions. Mail-related DNS records must not be HTTP-proxied. The public support Gmail address can remain a contact address; it does not by itself provide transactional SMTP credentials.

## Codex or administrator: install and stage

Use one deployment model. The existing backup automation targets the native `bojin.service` deployment below; do not simultaneously start a Docker app on the same data directory.

- Install Node 24 and Caddy using their official Ubuntu instructions; verify `node --version`, `command -v node`, and `caddy version`. The supplied service expects `/usr/bin/node`; adjust ExecStart if the actual verified path differs.
- Create a dedicated system user `bojin` with no interactive login. Place the reviewed release at `/opt/bojin` (root-owned source), install locked dependencies with `npm ci --omit=dev`, and run `node build.js` before starting the service. Exclude `.git`, local `.env`, databases and photos from source transfer. Record the release revision/archive digest.
- Create `/var/lib/bojin` owned by `bojin`, mode 0700. Keep application data outside the source tree. Never copy or migrate live user data before the backup/restore gate.
- Create `/opt/bojin/.env` from `.env.example`, owned by root with group bojin and mode 0640. Keep `/opt/bojin` traversable by the service user. Supply a unique persistent random AUTH_SECRET, real SMTP settings and `AUTH_BASE_URL=https://YOUR_HOSTNAME`. Keep `HOST=127.0.0.1`, `PORT=8080`, `COOKIE_SECURE=1`, `TRUST_PROXY=1`, `MAIL_MODE=smtp`. Configure AI credentials and provider spending controls when available; manual logging works without AI.
- Install `bojin.service` in `/etc/systemd/system/`, then `sudo systemctl daemon-reload` and `sudo systemctl enable --now bojin`. Check `systemctl status bojin` and `curl --fail http://127.0.0.1:8080/api/health`. Review errors without sharing secrets or full request contents.
- Replace the example hostname in Caddyfile, install it as `/etc/caddy/Caddyfile`, and run `sudo caddy validate --config /etc/caddy/Caddyfile` before reloading Caddy. Public DNS must resolve correctly and ports 80/443 must reach Caddy for normal certificate issuance. Caddy automatically manages HTTPS; do not install Cloudflare Origin CA certificates for direct DNS-only access.
- Check `https://YOUR_HOSTNAME/api/health` from outside the server. Issue only agreed disposable invitations through `scripts/auth-admin.js` as the service user with its environment loaded; preserve legacy IDs for real migration. Invitation links are secrets.

Do not enable Cloudflare proxy until the direct deployment works. If later tested, use Full (strict) TLS and verify client-IP handling/rate limits before enabling it: the app currently trusts the immediate reverse proxy, and adding another proxy requires explicit trusted-proxy configuration. Avoid Flexible TLS. Neither DNS-only nor orange-cloud mode guarantees mainland availability.

## Gates before real users

- Complete actual SMTP verification/reset delivery, AI provider/region eligibility and a budgeted real API test.
- Run restart persistence, upload/export/delete and offsite restore drills on disposable accounts. Follow OPERATIONS.md; configure backup storage and local/remote expiration before enabling the timer. Keep the latest deletion ledger independently recoverable.
- Finalize privacy text: Aliyun US West means application data is stored outside mainland China. AI, email and backup locations still depend on the selected providers.
- Run MAINLAND-TESTING.md. If US West routing is unreliable, compare another route/region (including Hong Kong) using the same checklist before moving production data. Do not infer reliability from the provider brand or geographical label.
- Monitor memory, available disk, backup age and certificate/HTTP health. Confirm automatic renewal and spending alerts for the server and domain.
