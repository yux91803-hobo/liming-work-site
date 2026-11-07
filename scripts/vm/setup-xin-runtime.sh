#!/bin/sh
set -eu
# Only a human/controller runs this bootstrap. Background tasks cannot install packages.
if ! command -v codex >/dev/null 2>&1; then
  echo '需要安装支持 app-server、turn/steer 和权限配置的 Codex（当前验证版本 0.166.0）' >&2
  exit 1
fi
if [ ! -x /usr/bin/bwrap ]; then
  sudo -n apt-get update
  sudo -n apt-get install -y bubblewrap
fi
codex --version
/usr/bin/bwrap --version
if [ ! -x /usr/lib/chromium/chromium ]; then
  sudo -n apt-get update
  sudo -n apt-get install -y chromium
fi
python3 -c 'import os, signal; assert hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "需要 Python 3.9+ 和支持 pidfd 的 Linux，才能安全清理失去组长的任务进程"'
# Verify the actual VM namespace policy; user namespaces alone do not support procfs on every image.
sudo -n env -i PATH=/usr/bin:/bin /usr/bin/bwrap --ro-bind / / --unshare-pid --unshare-ipc --proc /proc \
  -- /usr/bin/setpriv --reuid="$(id -u)" --regid="$(id -g)" --clear-groups --bounding-set=-all --no-new-privs /usr/bin/true
