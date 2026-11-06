# GitHub auto-deployment

当前部署与运维的统一入口：[部署与运维总手册](DEPLOYMENT-HANDBOOK.zh-CN.md)，包含另一 Agent 的交接整合、已验证部署证据及需要核对的冲突。此前的未部署/未合并状态属于历史记录，以总手册的证据日期为准。

Repository: https://github.com/hendrixAIDev/Lean-Ritual. Production: https://leanritual.app.
The recovered source is the uploaded release with SHA-256
`cf7ab52e6309bf04913b4033932b11397f1cff2446704ab7646de6ad4c8c7c51`.
It replaces the old initial-import source in GitHub. Login, privacy and shim bytes
from that archive matched the live site on November 5, 2026 (Pacific). Other host
files and configuration were not independently inspected.

## Behavior

Pull requests run the existing application tests, build, deployment boundary tests
and a real packaged-runtime/persistence/backup test. Pushes to `main` also package
the tested Linux x64 Node 24 runtime, including locked native dependencies. A
separate job deploys only when the **repository variable** `DEPLOY_ENABLED=true`.
Manual runs must select `main`. Deployment jobs are serialized and not cancelled
mid-deployment. Pending GitHub jobs can be superseded; this is not an ordered
database migration queue. Do not rerun an old workflow to roll production backward.

The deployment job downloads its own tested artifact and streams it over SSH.
It does not check out application code or run npm with deployment credentials.
Actions are pinned to verified upstream commit SHAs; the token has contents-read
permission. Environment secrets are available only to the deployment job.

The SSH key has a forced command and no shell, forwarding, PTY or general sudo.
The root-owned receiver only accepts bounded regular-file archives under explicit
runtime paths. Uploaded JS runs as `bojin`, including snapshot tooling. The
receiver never installs packages or executes uploaded programs as root. Scheduled
backups use a root-installed wrapper rather than a script in the release tree.

Server layout after one-time setup:

| Path | Purpose |
| --- | --- |
| `/opt/bojin` | Atomic symlink to the active code release |
| `/opt/bojin-releases/` | Preserved original code and staged runtime releases |
| `/etc/bojin/environment` | Existing private settings, root:bojin 0640 |
| `/var/lib/bojin` | Existing private SQLite/photo data |
| `/var/backups/bojin-deploy/` | Local pre-deployment snapshots and deletion ledgers |
| `/usr/local/sbin/lean-ritual-deploy` | Reviewed root-owned SSH receiver |
| `/usr/local/libexec/bojin-backup` | Reviewed root-owned scheduled backup wrapper |

Each deploy stages and validates the bundle, takes the shared maintenance lock,
stops the app, saves a consistent snapshot and deletion ledger, switches the code
symlink and starts the service. Local health must report the exact Git revision.
A backup/start/health failure attempts to restart the previous code; GitHub still
marks the deployment failed. Failure details remain in the host system log.
Public HTTPS health is checked afterward. A public routing failure fails the job
without automatically reversing a locally healthy release.

**This is code rollback, not automatic database rollback.** Future migrations
must remain compatible with the previous release or require a separately reviewed
maintenance/restore procedure. Restoring data requires the latest independent
deletion ledger per OPERATIONS.md. No snapshots or releases are pruned; retention,
offsite storage and capacity monitoring remain launch gates. One GiB free is a
minimum staging check, not proof that a full snapshot fits. A full disk aborts the
backup and attempts to restart the previous code.

## One-time server setup

An administrator must do this through the existing trusted console/SSH access.
The setup performs a short maintenance window with an offline snapshot. Do not
send private keys, `.env`, passwords or API tokens through chat or GitHub issues.

1. Review and merge the PR, then obtain that exact reviewed commit on the host.
   Do not run the installer from an unreviewed branch. Keep the admin console open.
2. Put the **public** deployment key in a file on the server, for example
   `/tmp/lean-ritual-deploy.pub`. Its matching private key belongs only in the
   GitHub `production` environment secret `DEPLOY_SSH_KEY`. If not already
   provisioned, generate a dedicated Ed25519 key on a trusted administrator
   machine and upload its private half directly to GitHub Secrets.
3. Inspect without changes:

   ```sh
   sudo python3 ops/install-auto-deploy.py
   ```

   The installer checks the actual service user, working directory, executable,
   environment-file selection, expected loopback listener, external data path,
   HTTPS origin, secure cookies, SMTP mode and Node major version. It prints no
   secret values and stops if the configuration differs. Inspect differences
   before adapting the script; do not blindly force the handoff's intended paths.

4. Apply the reviewed setup:

   ```sh
   sudo python3 ops/install-auto-deploy.py --apply --public-key /tmp/lean-ritual-deploy.pub
   curl --fail --silent --show-error https://leanritual.app/api/health
   ```

   It creates a dedicated restricted account, installs the receiver and sudo rule,
   preserves the current directory as a bootstrap release, copies existing
   settings into `/etc/bojin/environment`, and updates the service environment-file
   drop-in. It installs the backup wrapper/unit but does not enable a backup
   timer, alter Caddy/DNS/firewall settings, configure offsite storage or set
   retention. If an existing deployment key or sudo rule differs, it stops rather
   than replacing it. Do not apply across an active manual admin/data operation.
   Verify login and saved disposable records after setup.

5. Obtain the **host public key from the trusted server console**, not from an
   unauthenticated network scan:

   ```sh
   sudo awk '{print "47.254.72.103 " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
   ```

   Save that single public line as GitHub environment secret
   `DEPLOY_KNOWN_HOSTS`. The client enforces this pinned host key. Changing
   `DEPLOY_HOST` requires a matching verified known-host entry.

6. The Aliyun security group and host firewall must admit SSH from the deployment
   runner. This environment's HTTP proxy does not grant SSH access to the host.
   Standard GitHub-hosted runner IPs vary. Keep the forced key restriction;
   evaluate runner egress or a separately maintained runner if firewall policy
   requires a stable source. No firewall changes are made by this workflow.

## GitHub configuration and activation

Create environment **production**, restrict its deployment branch to `main`, and
configure:

| Location | Name | Value |
| --- | --- | --- |
| Repository variable | `DEPLOY_ENABLED` | `false` until host setup passes, then `true` |
| Production environment variable | `DEPLOY_HOST` | `47.254.72.103` |
| Production environment secret | `DEPLOY_SSH_KEY` | Dedicated restricted private key |
| Production environment secret | `DEPLOY_KNOWN_HOSTS` | Console-verified host public-key line |

No SMTP, AI or `AUTH_SECRET` value belongs in GitHub for this workflow. Those
remain on the host. Use GitHub Secrets UI or `gh secret set` with file/stdin input;
do not put private values in shell command arguments.

After one-time setup, set `DEPLOY_ENABLED=true` and run **Test and deploy** on
`main`. Confirm the job passes, `/api/health` reports the same Git SHA, and a
disposable account survives logout/login and reload. Later tested pushes to main
deploy automatically. Protect `main` with required tests/review as appropriate
for who has write access. Additional approval reviewers are optional; automatic
deployment does not require a per-push manual approval.

To pause future deploys, set `DEPLOY_ENABLED=false`. This does not interrupt a
deployment already running. Never cancel a running transfer during maintenance
unless investigating a failed deployment from the host console. To update the
root receiver or backup wrapper, review their changes and rerun the host
installer through trusted admin access; application deployments intentionally do
not replace privileged helpers.

## Acceptance limits

CI uses disposable SQLite data, file-based mail and no paid AI. Successful CI or
public GET checks do not establish actual SMTP/reset delivery, invited-user
isolation on the deployed host, offsite restoration or mainland connectivity.
Follow MAINLAND-TESTING.md and keep LEA-14/15/16 open until their evidence exists.
The privacy correction in this PR is source work until its deployment is verified.
