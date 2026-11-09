#!/bin/bash
set -euo pipefail
umask 077
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
OUT=${1:-${PWD}/liming-runner-recovery.tar.gz}
# Whitelist recovery recipes only. Never archive the live runner directory,
# .credentials*, .runner, .env, _diag, _work, toolcache, supervisor logs or gh auth.
tar -czf "$OUT" -C "$HERE" install.sh backup.sh sandbox.sh supervisord.conf README.md versions.json register.py test_recovery.py service-relay.py test_service_relay.py
printf 'Recovery-only archive: %s\n' "$OUT"
