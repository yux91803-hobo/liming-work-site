#!/bin/bash
# Run as the normal box user (not root); requires existing authorized gh and sudo.
set -euo pipefail
umask 077
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=yux91803-hobo/liming-work-site
NAME=box-liming-work-site
USER_NAME=actions-box
HOME_DIR=/var/lib/liming-actions
RUNNER=$HOME_DIR/runner
TOOLS=/opt/liming-runner-tools
CACHE=/opt/hostedtoolcache
MODE=${1:---check}
case "$MODE" in --check|--install|--start) ;; *) echo 'usage: install.sh [--check|--install|--start]'; exit 2;; esac
if [ "$MODE" = --check ]; then
  id "$USER_NAME"
  sudo -u "$USER_NAME" test -f "$RUNNER/.runner"
  sudo stat -c '%a %U %n' "$HOME_DIR" "$RUNNER/.credentials" "$RUNNER/.credentials_rsaparams"
  sudo "$TOOLS/bin/sandbox.sh" /bin/bash -c 'node --version; python --version; google-chrome --version; python -c "import playwright,ssl,sqlite3"; test ! -e /home/box; test ! -e /workspace/secrets; test ! -e /app'
  gh api "repos/$REPO/actions/runners" --jq '{runners:[.runners[]|{id,name,status,busy,labels:[.labels[].name]}]}'
  echo 'Inspection only. No boot persistence is asserted.'
  exit
fi
if [ "$MODE" = --start ]; then
  # This starts the current container service; NOT a container boot hook.
  if sudo "$TOOLS/supervisor-venv/bin/supervisorctl" -c /etc/liming-actions/supervisord.conf status >/dev/null 2>&1; then
    echo 'Dedicated supervisor is already running.'
  else
    sudo env -i PATH=/usr/bin:/bin HOME=/root "$TOOLS/supervisor-venv/bin/supervisord" -c /etc/liming-actions/supervisord.conf
  fi
  exit
fi
if [ "$(id -u)" = 0 ]; then echo 'Run as the normal box user so gh uses its authorized identity, not root.' >&2; exit 1; fi
command -v gh >/dev/null
sudo -n true
# Only the tested base is supported; fail instead of silently installing wrong ABI builds.
. /etc/os-release
if ! { [ "$ID" = debian ] && [ "$VERSION_ID" = 13 ]; }; then
  echo 'This recipe is validated on Debian 13 x86_64 only; review dependencies for a different image.' >&2; exit 1
fi
[ "$(uname -m)" = x86_64 ]
# Only CI dependencies; no paid resources or application services.
sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl git jq xz-utils tar bubblewrap util-linux python3-venv gnupg libicu76 libssl3t64 libkrb5-3 zlib1g libstdc++6
if ! command -v google-chrome >/dev/null; then
  key=$(mktemp); trap 'rm -f "$key"' EXIT
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o "$key"
  gpg --show-keys --with-colons "$key" | awk -F: '$1=="fpr" && $10=="EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796" {found=1} END {exit !found}'
  sudo install -m 644 "$key" /usr/share/keyrings/liming-google-linux.asc
  printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/liming-google-linux.asc] https://dl.google.com/linux/chrome/deb/ stable main' | sudo tee /etc/apt/sources.list.d/liming-google-chrome.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends google-chrome-stable
  rm -f "$key"; trap - EXIT
fi
if ! id "$USER_NAME" >/dev/null 2>&1; then
  sudo useradd --system --user-group --home-dir "$HOME_DIR" --create-home --shell /usr/sbin/nologin "$USER_NAME"
fi
[ "$(id -Gn "$USER_NAME")" = "$USER_NAME" ] || { echo 'CI account has unexpected supplementary groups; inspect manually.' >&2; exit 1; }
sudo chmod 700 "$HOME_DIR"
sudo install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$RUNNER"
sudo install -d -m 755 "$TOOLS" "$TOOLS/bin"
sudo install -d -m 755 -o "$USER_NAME" -g "$USER_NAME" "$CACHE"
TMP=$(mktemp -d); trap 'rm -rf -- "$TMP"' EXIT
fetch() { curl -fL --retry 2 "$1" -o "$2"; printf '%s  %s\n' "$3" "$2" | sha256sum -c -; }
if ! sudo -u "$USER_NAME" test -x "$RUNNER/bin/Runner.Listener"; then
  fetch https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-linux-x64-2.338.2.tar.gz "$TMP/runner.tgz" baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
  # parent mktemp is 700: root extracts only verified official binaries, then hands ownership to CI.
  sudo tar xzf "$TMP/runner.tgz" -C "$RUNNER"
  sudo chown -R "$USER_NAME:$USER_NAME" "$RUNNER"
fi
if [ ! -x "$TOOLS/node-v22.23.4-linux-x64/bin/node" ]; then
  fetch https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz "$TMP/node.tar.xz" 1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
  sudo tar xJf "$TMP/node.tar.xz" -C "$TOOLS"
fi
if [ ! -f "$CACHE/Python/3.12.16/x64.complete" ]; then
  fetch https://github.com/actions/python-versions/releases/download/3.12.16-40260402378/python-3.12.16-linux-24.04-x64.tar.gz "$TMP/python.tgz" dec61ed20cd3e71143f1642ef9966945dea8ae4f3e96b306205a710da4f2191a
  mkdir "$TMP/python"; tar xzf "$TMP/python.tgz" -C "$TMP/python"
  # Copy the public distribution into the CI home so its official setup script can run without sudo.
  sudo install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/python-dist"
  sudo cp -a "$TMP/python/." "$HOME_DIR/python-dist/"
  sudo chown -R "$USER_NAME:$USER_NAME" "$HOME_DIR/python-dist"
  sudo -u "$USER_NAME" env -i HOME="$HOME_DIR" PATH=/usr/bin:/bin RUNNER_TOOL_CACHE="$CACHE" /bin/bash -c 'cd /var/lib/liming-actions/python-dist; bash setup.sh'
fi
if [ ! -f "$CACHE/node/22.23.4/x64.complete" ]; then
  sudo install -d -m 755 -o "$USER_NAME" -g "$USER_NAME" "$CACHE/node/22.23.4"
  sudo install -d -m 755 -o "$USER_NAME" -g "$USER_NAME" "$CACHE/node/22.23.4/x64"
  sudo cp -a "$TOOLS/node-v22.23.4-linux-x64/." "$CACHE/node/22.23.4/x64/"
  sudo touch "$CACHE/node/22.23.4/x64.complete"
  sudo chown -R "$USER_NAME:$USER_NAME" "$CACHE/node/22.23.4"
fi
sudo -u "$USER_NAME" env -i HOME="$HOME_DIR" PATH="$CACHE/Python/3.12.16/x64/bin:/usr/bin:/bin" "$CACHE/Python/3.12.16/x64/bin/python" -m pip install playwright==1.64.1
if [ ! -x "$TOOLS/supervisor-venv/bin/supervisord" ]; then
  sudo /usr/bin/python3 -m venv "$TOOLS/supervisor-venv"
  sudo "$TOOLS/supervisor-venv/bin/pip" install supervisor==4.3.0
fi
# Never --replace/delete a remote runner without explicit authorization.
if ! sudo -u "$USER_NAME" test -f "$RUNNER/.runner"; then
  if [ -n "$(gh api "repos/$REPO/actions/runners" --jq ".runners[]|select(.name==\"$NAME\")|.id")" ]; then
    echo 'Runner name already exists remotely but local credentials are gone. Ask for explicit old-entry removal authorization; no duplicate or replacement was created.' >&2; exit 1
  fi
  python3 - <<'PYREG'
import json,subprocess,sys
p=subprocess.run(['gh','api','--method','POST','repos/yux91803-hobo/liming-work-site/actions/runners/registration-token'],capture_output=True,text=True)
if p.returncode:
 print(p.stderr,file=sys.stderr);sys.exit(p.returncode)
d=json.loads(p.stdout)
code="""import json,sys,os,subprocess
j=json.load(sys.stdin);os.umask(0o077)
e={'HOME':'/var/lib/liming-actions','USER':'actions-box','PATH':'/usr/bin:/bin','ACTIONS_RUNNER_INPUT_TOKEN':j['token']}
sys.exit(subprocess.run(['./config.sh','--unattended','--url','https://github.com/yux91803-hobo/liming-work-site','--name','box-liming-work-site','--labels','box','--work','_work'],cwd='/var/lib/liming-actions/runner',env=e).returncode)
"""
sys.exit(subprocess.run(['sudo','-u','actions-box','env','-i','PATH=/usr/bin:/bin','python3','-c',code],input=json.dumps(d),text=True).returncode)
PYREG
else
  sudo -u "$USER_NAME" python3 - <<'PYCHECK'
import json
j=json.load(open('/var/lib/liming-actions/runner/.runner'))
assert j['agentName']=='box-liming-work-site'
assert j['gitHubUrl'].rstrip('/')=='https://github.com/yux91803-hobo/liming-work-site'
print('Existing local registration retained; no new token requested.')
PYCHECK
fi
sudo -u "$USER_NAME" cp "$RUNNER/bin/runsvc.sh" "$RUNNER/runsvc.sh"
sudo -u "$USER_NAME" chmod 755 "$RUNNER/runsvc.sh"
printf '%s\n' "$TOOLS/node-v22.23.4-linux-x64/bin:$CACHE/Python/3.12.16/x64/bin:/usr/bin:/bin" | sudo -u "$USER_NAME" tee "$RUNNER/.path" >/dev/null
sudo chmod 600 "$RUNNER/.path" "$RUNNER/.credentials" "$RUNNER/.credentials_rsaparams" "$RUNNER/.runner"
sudo install -d -m 700 /var/lib/liming-actions-supervisor
sudo install -d -m 755 /etc/liming-actions/sandbox-etc/ssl/certs /etc/liming-actions/sandbox-etc/fonts /etc/liming-actions/sandbox-etc/alternatives
for f in resolv.conf hosts nsswitch.conf passwd group os-release ld.so.cache localtime; do sudo cp -L "/etc/$f" "/etc/liming-actions/sandbox-etc/$f"; done
sudo ln -sf /opt/google/chrome/google-chrome /etc/liming-actions/sandbox-etc/alternatives/google-chrome
sudo install -m 755 "$HERE/sandbox.sh" "$TOOLS/bin/sandbox.sh"
sudo install -m 600 "$HERE/supervisord.conf" /etc/liming-actions/supervisord.conf
# Deliberately no automatic start: first review current workflow labels and pending jobs.
echo 'Installed/restored without starting. Review workflows, then run install.sh --start.'
echo 'Container boot persistence is NOT configured. An offline pre-wipe registration needs explicit cleanup authorization.'
