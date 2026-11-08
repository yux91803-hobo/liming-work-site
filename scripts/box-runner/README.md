# Box runner recovery

Scope: private yux91803-hobo/liming-work-site; runner box-liming-work-site, labels self-hosted/Linux/X64/box.
Debian 13 x86_64, normal box user with existing gh repo authorization and sudo.

- `bash install.sh --check`: read-only installation/runtime checks, no token generation.
- `bash install.sh --install`: recreate user, official verified distributions, browser/dependencies, registration, sandbox and dedicated supervisor config. Does NOT start/trigger jobs.
- Review workflow labels and queued jobs, then `bash install.sh --start`.
- `bash backup.sh /chosen/local/path.tar.gz`: whitelist recipes only, no credentials.

Installation paths: /var/lib/liming-actions/runner (700 parent, runner credential files 600); /opt/liming-runner-tools (root-owned tools); /opt/hostedtoolcache (CI-owned dependency cache); /etc/liming-actions; /var/lib/liming-actions-supervisor (root-only control socket/logs).

Supervisor 4.3.0 invokes the official runsvc.sh. A root-owned wrapper drops UID/GID/capabilities, sets no_new_privs, clears environment, and enters a Bubblewrap filesystem/PID sandbox. No box home/workspace/app files are mounted. Networking is shared, not a network security boundary. The runner is intentionally for trusted private-repository code only, not forks/untrusted PRs. CI cannot access root supervisor control socket. There is no sudo grant for actions-box.

CRITICAL LIMITATIONS:
- Current container uses tini, not systemd. Current-container process crash recovery is configured and tested; full-box/container restart autostart is NOT configured or promised. No platform daemon was edited. A supported platform boot hook is still needed.
- After total wipe, the previous GitHub runner entry remains but local credentials are gone. Installer refuses to replace/delete it or register a duplicate. Explicit authorization to remove that exact old entry is required before fresh registration. No long-lived registration token is stored in recovery files.
- Keep these recipes in this private repository under scripts/box-runner. After wiping the box, retrieve this directory through freshly authorized gh/git; local-only archives cannot survive wiping. No credentials are stored in the recipes.
- Installer syntax and --check are tested; complete destructive clean-image restore has NOT been performed. No CI/deploy/model calls are part of this installer.
- Production workflow retains the original real-model live tests. These consume model-provider quota; run only with owner authorization. The runner migration does not skip or weaken them.
- Self-hosted compute is free per current GitHub docs; artifact/cache storage is separately billed.

Pinned official runner/Node/Python SHA256 hashes are in versions.json and install.sh. Google Chrome is provisioned using its official signed APT repository only when absent. All application secrets remain in Actions Secrets; official runner local credential files are necessary registration state and must never be archived or committed.
