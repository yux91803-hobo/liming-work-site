# Box runner: safe recovery and restart limitations

Scope: PRIVATE `yux91803-hobo/liming-work-site`, immutable GitHub repository ID `1434453690`; runner `box-liming-work-site`, labels `self-hosted/Linux/X64/box`. Debian 13 x86_64. Use the normal box user with authorized `gh` and passwordless sudo; do not run installer as root or copy gh authentication into the CI account.

## One explicit recovery command

After retrieving this directory from the private repository and authorizing gh, inspect the old runner ID/status:

```bash
gh api repos/yux91803-hobo/liming-work-site/actions/runners --jq '.runners[]|{id,name,status,busy,labels:[.labels[].name]}'
# Read-only preflight; performs NO installation, DELETE, registration-token request or service restart:
bash scripts/box-runner/install.sh --recover --dry-run --replace-offline-runner-id 21
# Only AFTER a real wipe and when the exact old ID is offline/not busy:
bash scripts/box-runner/install.sh --recover --replace-offline-runner-id 21
```

The last command explicitly selects removal of that exact offline orphan, reinstalls prerequisites/distributions/account/configuration, privately obtains a fresh short-lived registration token through gh, registers and starts the current-container service. Replace `21` with the actual old ID; it is NOT a blanket delete permission. The CURRENT online runner21 must not be deleted or used as a wipe test.

Safety checks are fail-closed: exact repository ID/name/private/admin permission; private-fork workflows disabled; unique expected runner name; matching explicitly selected ID and box/self-hosted labels; status exactly offline and busy exactly false. The repository and exact runner are re-read immediately before DELETE. Online/busy/unknown/mismatching states and retained/partial local authentication refuse replacement. GitHub has no atomic status-conditional DELETE exposed here, so the immediate re-read minimizes, but cannot mathematically eliminate, a server-side state race. No replacement retry loop or alternative API is used.

Without the replacement flag, matching existing local authentication is kept (idempotent); a same-name orphan refuses and prints the explicit selection needed. When no same-name remote/local registration exists, `--recover` registers fresh without deletion. If failure occurs after deleting the orphan but before new registration, inspect the inventory; when the name is genuinely free, retry WITHOUT a replacement flag. Never delete another ID blindly.

Other modes:
- `bash install.sh --check`: read-only local/runtime/inventory checks.
- `bash install.sh --install [--replace-offline-runner-id ID]`: install/register/configure but do not start.
- `bash install.sh --recover --dry-run`: read-only idempotence/fresh-registration plan.
- `bash install.sh --start`: start existing dedicated supervisor in THIS container, already-running no-op.
- `python3 test_recovery.py`: 23 offline mocked safety tests, no GitHub/sudo/model/application calls.
- `bash backup.sh /chosen/local/path.tar.gz`: whitelist only these ten recipe/test files, never runtime authentication.

## What does NOT work automatically

This shared box currently has `tini` as PID1; system and user systemd report offline. No cron/runit/s6 or desktop-session/user-systemd startup mechanism was found. The dedicated Supervisor restarts its runner child after crashes while the container lives, but is NOT a full-container boot hook. No .profile/.bashrc startup trick, shared platform daemon modification, permanent routine, paid service, or real box reboot was used.

Research found no documented supported user boot hook. Official recovery docs say machine replacement/recovery drops installed apps/packages and virtual environments. The official support forum also warns that background programs in .profile/.bashrc can wedge ALL bots' shell access; this is not a safe substitute. A true solution requires the platform to expose a supported per-user boot/post-restore service hook (with an approved way to reinstall dependencies and start the dedicated supervisor), or provide a documented persistent service manager. Then the already-existing `--recover`/`--start` entrypoints can be attached to it. Until that capability exists, somebody must explicitly invoke recovery/start after rebuild. Do NOT call this unattended reboot persistence.

References:
- https://cursor.com/help/grok-bot/computer-recovery
- https://forum.cursor.com/t/grok-bot-computer-unresponsive-since-oct-23-reset-didnt-help/176019/6
- https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application

## Isolation / credentials / tested scope

Runner account `actions-box` has no sudo, no login shell and only its own group. `/var/lib/liming-actions` is700; official runner-generated credential files are600. Supervisor's config/control/logs are root-only. Root-owned wrapper drops UID/GID/capabilities, enables no_new_privs, clears environment and runs official runsvc.sh in a Bubblewrap filesystem/PID sandbox; bot home/workspace/app/root/control paths are not mounted. Networking is shared, so ONLY trusted private-repository code is safe. Workflows reject forks/non-main dispatch refs; repository private-fork execution is disabled.

Paths: runner `/var/lib/liming-actions/runner`; tools `/opt/liming-runner-tools`; CI dependency cache `/opt/hostedtoolcache`; service config `/etc/liming-actions/supervisord.conf`; root-only control/logs `/var/lib/liming-actions-supervisor`. Pins/checksums are in versions.json/install.sh. Browser restore uses Google's official signed APT repository when Chrome is absent.

Application secrets stay in Actions Secrets with the existing deployment behavior. Fresh temporary registration token is stdin/environment-only; it and gh auth are never backed up/committed/printed. Necessary official runner-generated local auth stays private and is NOT a recovery asset. Backups contain only install.sh,backup.sh,sandbox.sh,supervisord.conf,README.md,versions.json,register.py,test_recovery.py,service-relay.py,test_service_relay.py. Fetch these recipes from the private repo after a wipe; a local-only archive cannot survive a wipe.

Shell/Python syntax, live read-only idempotence, active-runner replacement refusal, archive whitelist and23 mock cases were tested. No real orphan deletion, current-runner re-registration, destructive wipe, full clean-image restore or actual reboot was performed. Current-container child-crash recovery was tested in the original installation. No deployment/model test is part of the recovery tests. Production model acceptance is a separate application workflow, not a reason to weaken recovery checks.


## Graceful service control and connection health (recipe v3)

A process-running/online indication is NOT evidence of job delivery. Inspect actual
queued job IDs, assigned runner_id, local Worker, listener session and timestamps.
The 2026-11-09 incident logged a 100-second broker GET timeout; its initial transport
root cause remains unconfirmed. Fresh HEAD/HTTPS success does not test authenticated
long polling. Upstream issue4703/open PR4734 describes an unbounded response-body
stall but is not a released fix or proof of this instance's cause; do NOT install
unreviewed runner patches, disable TLS, bypass proxies, or delete registration21.

A separate local defect WAS reproduced: signaling the old outer Bubblewrap wrapper
with TERM killed its detached children through --die-with-parent before their
handlers ran. That bypassed the official service shutdown/session cleanup and can
cause post-restart409 "session already exists". Recipe v3 runs a root-owned Python
signal relay ABOVE the unchanged UID/capability/filesystem/PID sandbox. On stop it
finds only the official RunnerService.js descendant (UID,exact argv,cwd and ancestry
checks), opens a PID-stable handle, and forwards INT just as official runsvc.sh does.
It keeps the sandbox parent alive during cleanup. Shutdown is bounded75seconds,
then only its own sandbox is killed; Supervisor retains its90-second hard limit.
No credentials, environment values, network payloads or other service state are read.

`sudo python3 scripts/box-runner/test_service_relay.py` runs THREE disposable sandbox tests, not the production runner:
graceful TERM->INT propagation, bounded unresponsive-child termination, no arbitrary
CLI command execution. Run `python3 test_recovery.py` separately for23 mock safety cases.
The relay requires Python3 with Linux pidfd support, supplied by the tested Debian13.

Existing live installations require an explicit idle maintenance transition; merely
copying the config does not update a running Supervisor child. Never restart with a
Worker/active job, queued assignment already in progress, or another recovery operator.
Record reservation/outcome in patrol-events.log and auto-restart-log.txt. For the OLD
wrapper, allow the official Node manager to finish graceful INT before killing its
Bubblewrap parent; otherwise wait for official stale-session expiry without repeated
restarts. Fresh installs use the relay immediately. Keep the prior root-only config
for rollback; rolling back also requires idle coordination and a graceful stop.

Patrol policy: read-only first; one shared advisory lock and reservation, minimum
15-minute cooldown. Do NOT restart for a single offline sample, expected session
Conflict/reconnect, or the absence of log output in an otherwise idle runner. Observe
natural reconnect through the official client's bounded retry window; never kill a
Worker even if API says offline. Evidence for escalation: a same-label queued job
unassigned for10minutes AND no Worker/in-progress job, persistent transport failure,
and no current maintenance/reconnect. At most one controlled graceful recovery, then
escalate with sanitized times/errors; do not create an endless periodic restart loop.
These patrol rules must be adopted by the owner of the existing routine, not by a new
routine added by this recipe. Full-container boot persistence is still unavailable.

Official references:
- https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/monitor-and-troubleshoot
- https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-proxy-servers
- https://github.com/actions/runner/issues/4090
- https://github.com/actions/runner/issues/4703
- https://github.com/actions/runner/pull/4734

## Network stall fix 2026-11-09 (VM pause -> silent dead TCP flows)
Root cause of the broker 100 s timeouts / renewjob stalls / "lost communication": the
box VM is periodically paused by its host (observed 21:10:51-21:12:01 CST: monotonic
+11.8 s vs wall +66 s; systemd 3-min watchdog kills at 09:47/10:10/11:21 CST). All egress
goes through a host-side transparent proxy (every name resolves to 198.18.0.1). After a
pause, pre-pause flows are silently black-holed (no RST): renewjob sockets showed
unacked data + growing retransmits, and .NET waited its full 100 s HTTP timeout
(GITHUB_ACTIONS_RUNNER_HTTP_TIMEOUT cannot go below 100 s). Mitigation:
`liming-tcp-keepalive.c`, LD_PRELOAD'ed by sandbox.sh, enables SO_KEEPALIVE
(idle 15 s, intvl 5 s, cnt 3) and TCP_USER_TIMEOUT 30 s on outbound TCP of
Runner.Listener/Runner.Worker only (no-op for every other process). Dead flows now fail
in ~30 s and the official retry reconnects. The pauses themselves are platform-side
and are NOT fixed; a pause long enough can still lose a job. Rollback: remove the
LD_PRELOAD= entry from sandbox.sh and do an idle graceful restart.
