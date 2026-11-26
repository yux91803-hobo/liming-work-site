#!/usr/bin/env bash
# Liming 平板装机：在 DSH Go 的终端里（打开一个对话 → 全部功能 → 终端）运行
#   apt-get update && apt-get install -y curl && curl -fsSL https://liming-work.com/tablet/setup.sh | bash
# （App 里的 Ubuntu 是精简版，没有 curl、python3、openssh-client；curl 由这行先装，后两个脚本自己装。）
# 装好随本机引擎启停的 WorkBuddy 网关和插件，并在 li2、li 上配好给平板用的 Harness web 配置；
# 再装「平板调用云电脑」：平板上的 liming-cloud（让本机 AI 把活派给 li、li2），li、li2 上的 liming-lease（任务跑着时不让机器睡）。
# 脚本里不含任何密钥。SSH 令牌和只读 key 存在平板 ~/.liming-cloud/secrets.json（权限 600），给 liming-cloud 连 li、li2、看机器状态；
# 写 key 只经 SSH 存到那台云电脑的 ~/.liming-cloud/lease.key，不落平板。可以重复运行。
#   --dry-run  只列出要做的事    --skip-li  不接 li
# 设计和说明：liming-work-site 仓库 docs/superpowers/specs/2026-11-25-tablet-dshgo-design.md、docs/tablet.md
set -euo pipefail

BASE=${LIMING_BASE:-https://liming-work.com/tablet}
GW_DIR=${LIMING_GW_DIR:-/root/workbuddy-gateway}
PLUGIN_DIR=${LIMING_PLUGIN_DIR:-/root/liming-gateway}
CLOUD_PLUGIN_DIR=${LIMING_CLOUD_PLUGIN_DIR:-/root/liming-cloud}
CLOUD_DIR=${LIMING_CLOUD_DIR:-${HOME:-/root}/.liming-cloud}
SSH=${LIMING_SSH:-ssh}
DSH=${LIMING_DSH:-dsh}
APT=${LIMING_APT:-apt-get}
TTY=${LIMING_TTY:-/dev/tty}
VERSION=v2.0.8
# 原版发布包的大小和 SHA-256，2026-11-25 在 li 上核对过（与 releases/SHA256SUMS.v2.0.8 一致）。
ZIP_SIZE=${LIMING_ZIP_SIZE:-22962873}
ZIP_SHA256=${LIMING_ZIP_SHA256:-b322c73b9a18f09c6560bff0e4b748e9acdc26272c339b4f5fce2413bb500cc6}
REMOTE_ZIP=/data/workbuddy-gateway/releases/workbuddy2api-hub-$VERSION.zip
WORK=''
GATEWAY_FILES='package.json cordis.patch.yml lib/index.js lib/gateway.js'
# 两个插件的文件清单（单测核对和仓库一致）
CLOUD_FILES='package.json cordis.patch.yml lib/cancel-reasons.js lib/dsh-client.js lib/index.js lib/instabox-read.js lib/ledger.js lib/outbox.js lib/recovery.js lib/redact.js lib/remote-bootstrap.js lib/remote.js lib/runner.js lib/secrets.js lib/selector.js lib/settings.js lib/ssh-tunnel.js lib/steps.js lib/throttle.js lib/tool-card.js lib/tools.js lib/ui.js'
LEASE_FILES='package.json cordis.patch.yml lib/index.js lib/lease.js'

say() { printf '%s\n' "$*"; }
say_err() { printf '%s\n' "$*" >&2; }
die() { say_err "装机没完成：$*"; exit 1; }
rssh() { "$SSH" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 "$@"; }

trim() {
  local s=${1//$'\r'/}
  s=${s#"${s%%[![:space:]]*}"}
  printf '%s' "${s%"${s##*[![:space:]]}"}"
}

# 认 InstaBox 后台复制来的一行「ssh ibssh_…@主机」（前后空格、回车、少了 ssh 都行），输出 用户@主机。
parse_token_line() {
  local s re='^(ssh[[:space:]]+)?(ibssh_[A-Za-z0-9._~+=-]+@[A-Za-z0-9][A-Za-z0-9.-]*)$'
  s=$(trim "${1-}")
  [[ $s =~ $re ]] || return 1
  printf '%s\n' "${BASH_REMATCH[2]}"
}

# 从终端读一个令牌（第 2 个参数非空表示可以直接回车跳过，跳过时返回 1）。
ask_token() {
  local label=$1 optional=$2 line target tries=0 eof=0
  while [ "$tries" -lt 3 ]; do
    tries=$((tries + 1)); line=''
    printf '%s' "粘贴 $label 的 SSH 令牌行（ssh ibssh_…@主机${optional:+，直接回车跳过}）：" >&2
    if ! IFS= read -rs line <&3; then [ -n "$line" ] || eof=1; fi
    printf '\n' >&2
    line=$(trim "$line")
    if [ -z "$line" ]; then
      [ -n "$optional" ] && return 1
      [ "$eof" = 1 ] && die "没读到 $label 的令牌"
      continue
    fi
    if target=$(parse_token_line "$line"); then printf '%s\n' "$target"; return 0; fi
    say_err "格式不对：应是一行 ssh ibssh_…@主机，在 InstaBox 后台的 Connect → SSH tokens 里复制。"
    [ "$eof" = 1 ] && break
  done
  die "$label 的令牌不对"
}

# 读一把 InstaBox key（不回显、不打印）；直接回车返回 1（跳过，或保留原来的）。
ask_key() {
  local label=$1 hint=$2 line=''
  while true; do
    printf '%s' "粘贴 $label（$hint；直接回车跳过或保留原来的）：" >&2
    IFS= read -rs line <&3 || true
    printf '\n' >&2
    line=$(trim "$line")
    [ -n "$line" ] || return 1
    if printf '%s' "$line" | grep -Eq '^[!-~]{8,256}$'; then printf '%s' "$line"; return 0; fi
    say_err "格式不对：key 是一串不带空格的字符，在 InstaBox 后台 API keys 里新建后复制。"
  done
}

# 把一台机器的 SSH 目标和只读 key 记进 ~/.liming-cloud/secrets.json（目录 700、文件 600、先写临时文件再改名）。
# 只读 key 为空时保留原来的；写 key 从来不经过这里。
save_secret() {
  mkdir -p "$CLOUD_DIR"; chmod 700 "$CLOUD_DIR"
  LIMING_M="$1" LIMING_T="$2" LIMING_K="${3:-}" python3 - "$CLOUD_DIR/secrets.json" <<'PY'
import json, os, sys
path = sys.argv[1]
try:
    doc = json.load(open(path, encoding='utf-8'))
    assert isinstance(doc, dict) and isinstance(doc.get('machines'), dict)
except Exception:
    doc = {'schemaVersion': 1, 'machines': {}}
m = os.environ['LIMING_M']
cur = doc['machines'].get(m) or {}
entry = {'sshTarget': os.environ['LIMING_T'], 'sshPort': 22}
key = os.environ.get('LIMING_K', '')
if key:
    entry['readKey'] = key
elif cur.get('readKey'):
    entry['readKey'] = cur['readKey']
doc['schemaVersion'] = 1
doc['machines'][m] = entry
tmp = path + '.tmp'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write('\n')
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY
}

# 下载一个文件；内容里要有 marker，开头不能是「<」（网站对不存在的路径会回首页 HTML）。失败时不留文件。
fetch_file() {
  local url=$1 dest=$2 marker=$3 part first
  part="$dest.part.$$"
  if ! curl -fsSL --retry 2 --connect-timeout 20 -o "$part" "$url" 2>/dev/null; then
    rm -f "$part"; say_err "下载失败：$url"; return 1
  fi
  first=$(head -c 512 "$part" | tr -d '[:space:]' | cut -c1)
  if [ "$first" = '<' ] || ! grep -qF -- "$marker" "$part"; then
    rm -f "$part"; say_err "下载到的不是要的文件（可能是网站首页）：$url"; return 1
  fi
  mv -f "$part" "$dest"
}

verify_zip() {
  local f=$1 size sum
  size=$(wc -c < "$f" | tr -d '[:space:]')
  if [ "$size" != "$ZIP_SIZE" ]; then say_err "网关安装包大小不对（$size 字节，应为 $ZIP_SIZE）"; return 1; fi
  sum=$(sha256sum "$f" | cut -d' ' -f1)
  if [ "$sum" != "$ZIP_SHA256" ]; then say_err "网关安装包校验不对，没有安装"; return 1; fi
}

# 校验通过才解压：先解到临时目录、核对，再换成 $VERSION；accounts、usage、logs 只建不动。
install_gateway() {
  local zip=$1 stage d
  verify_zip "$zip" || return 1
  mkdir -p "$GW_DIR"
  stage=$(mktemp -d "$GW_DIR/.stage.XXXXXX")
  if ! python3 -m zipfile -e "$zip" "$stage" >/dev/null 2>&1 || [ ! -f "$stage/wb-proxy/wb_proxy.py" ]; then
    rm -rf "$stage"; say_err "网关安装包解不开，或里面没有 wb-proxy/wb_proxy.py"; return 1
  fi
  chmod +x "$stage"/wb-proxy/bin/wb-tls-bridge-* "$stage"/wb-proxy/*.sh 2>/dev/null || true
  rm -rf "${GW_DIR:?}/$VERSION"
  mkdir -p "$GW_DIR/$VERSION"
  mv "$stage/wb-proxy" "$GW_DIR/$VERSION/wb-proxy"
  rm -rf "$stage"
  ln -sfn "$VERSION/wb-proxy" "$GW_DIR/current"
  for d in accounts usage logs; do mkdir -p "$GW_DIR/$d"; chmod 700 "$GW_DIR/$d"; done
}

# 插件文件每次都更新（本地路径安装是链接目录，重启引擎就用上新的）；只在第一次挂进 web 配置。
install_plugin() {
  local src=$1 dest=$2 files=$3 f
  for f in $files; do mkdir -p "$(dirname "$dest/$f")"; cp -f "$src/$f" "$dest/$f"; done
  if [ ! -f "$dest/.added" ]; then
    "$DSH" plugin --profile web add "$dest" </dev/null || { say_err "插件挂不上，看上面 dsh 的报错"; return 1; }
    : > "$dest/.added"
  fi
}

# 下载一个插件的全部文件到 $2；按文件类型核对内容（网站对不存在的路径会回首页）。
fetch_plugin() {
  local name=$1 dest=$2 files=$3 f marker
  for f in $files; do
    case "$f" in
      package.json) marker="\"name\": \"$name\"";;
      cordis.patch.yml) marker=$name;;
      *) marker=export;;
    esac
    mkdir -p "$(dirname "$dest/$f")"
    fetch_file "$BASE/$name/$f" "$dest/$f" "$marker" || return 1
  done
}

# 在 li2、li 上执行的脚本：只写包装脚本、web 配置的补丁和工作目录（web 配置那台电脑上没人用：小芯、天启用 headless）；
# web 配置里原有别的补丁就先备份；只检查 key 文件在不在，不读出来。
remote_script() {
  local wrapper=$1 profile=$2 machine=$3 lease_key=$4 lease_src=$5 f
  printf 'LIMING_MACHINE=%q\nLEASE_KEY=%q\n' "$machine" "$lease_key"
  cat <<'HEAD'
set -eu
umask 077
[ -x "$HOME/.local/bin/dsh" ] || { echo NO_DSH; exit 3; }
[ -s "$HOME/.xin/harness.key" ] || { echo NO_KEY; exit 4; }
WS=${LIMING_REMOTE_WS:-/data/workspace/tablet}
mkdir -p "$HOME/.local/bin" "$HOME/.dsh/profiles/web" "$WS"
cat > "$HOME/.local/bin/dsh-tablet.tmp" <<'LIMING_WRAPPER_EOF'
HEAD
  cat "$wrapper"
  cat <<'MID'
LIMING_WRAPPER_EOF
chmod 700 "$HOME/.local/bin/dsh-tablet.tmp"
mv -f "$HOME/.local/bin/dsh-tablet.tmp" "$HOME/.local/bin/dsh-tablet"
P="$HOME/.dsh/profiles/web/cordis.patch.yml"
cat > "$P.new" <<'LIMING_PROFILE_EOF'
MID
  cat "$profile"
  cat <<'TAIL'
LIMING_PROFILE_EOF
if [ -s "$P" ] && ! grep -q "scripts/tablet-profile.mjs" "$P"; then mv -f "$P" "$P.bak.$(date +%Y%m%d%H%M%S)"; fi
mv -f "$P.new" "$P"
mkdir -p "$HOME/.liming-cloud" "$HOME/.liming-lease/lib"
chmod 700 "$HOME/.liming-cloud"
printf '%s\n' "$LIMING_MACHINE" > "$HOME/.liming-cloud/machine-name"
if [ -n "$LEASE_KEY" ]; then
  printf '%s\n' "$LEASE_KEY" > "$HOME/.liming-cloud/lease.key.tmp"
  chmod 600 "$HOME/.liming-cloud/lease.key.tmp"
  mv -f "$HOME/.liming-cloud/lease.key.tmp" "$HOME/.liming-cloud/lease.key"
fi
LEASE_KEY=''
TAIL
  for f in $LEASE_FILES; do
    printf 'cat > "$HOME/.liming-lease/%s" <<'"'"'LIMING_FILE_EOF'"'"'\n' "$f"
    cat "$lease_src/$f"
    printf 'LIMING_FILE_EOF\n'
  done
  cat <<'END'
LEASE=ok
if [ ! -f "$HOME/.liming-lease/.added" ]; then
  if out=$("$HOME/.local/bin/dsh" plugin --profile web add "$HOME/.liming-lease" </dev/null 2>&1); then : > "$HOME/.liming-lease/.added"
  else LEASE=failed; printf '%s\n' "$out" | tail -n 3 | sed 's/^/LEASE_LOG /'; fi
fi
[ -s "$HOME/.liming-cloud/lease.key" ] && K=yes || K=no
echo "LEASE $LEASE $K"
echo "OK $HOME/.local/bin/dsh-tablet $WS"
END
}

# 输出「包装脚本路径<TAB>工作目录<TAB>租约插件 ok/failed<TAB>写 key yes/no」。
remote_setup() {
  local target=$1 label=$2 lease_key=${3:-} out line wrapper ws lease leasekey
  if ! out=$(remote_script "$WORK/dsh-tablet.sh" "$WORK/dsh-tablet-profile.yml" "$label" "$lease_key" "$WORK/lease" | rssh "$target" 'bash -s' 2>&1); then
    case "$out" in
      *NO_DSH*) say_err "$label 上没找到 ~/.local/bin/dsh（Harness 没装好）";;
      *NO_KEY*) say_err "$label 上没有 ~/.xin/harness.key（这台的网关还没配好）";;
      *) say_err "$label 上配 web 配置失败：$(printf '%s\n' "$out" | tail -n 3)";;
    esac
    return 1
  fi
  line=$(printf '%s\n' "$out" | grep '^OK ' | tail -n 1) || true
  [ -n "$line" ] || { say_err "$label 没有回 OK"; return 1; }
  read -r _ wrapper ws <<<"$line"
  line=$(printf '%s\n' "$out" | grep '^LEASE ' | tail -n 1) || true
  read -r _ lease leasekey <<<"${line:-LEASE failed no}"
  [ "$lease" = ok ] || say_err "$label 上租约插件没挂上：$(printf '%s\n' "$out" | grep '^LEASE_LOG ' | sed 's/^LEASE_LOG //' | tail -n 2)"
  printf '%s\t%s\t%s\t%s\n' "$wrapper" "$ws" "$lease" "$leasekey"
}

# 问这台的只读 key 和写 key，把 SSH 目标和只读 key 记进平板，写 key 交给 remote_setup 经 SSH 存到那台上
setup_machine() {
  local target=$1 label=$2 rk wk
  rk=$(ask_key "$label 账号的只读 key" "InstaBox 后台 API keys 新建，只勾 machines:read；用来看机器醒没醒，不会叫醒它") || rk=''
  wk=$(ask_key "$label 账号的写 key" "只勾 machines:write，别勾删除；只存到 $label 上，任务跑着时不让它睡") || wk=''
  save_secret "$label" "$target" "$rk" || { say_err "记不下 $label 的连接信息"; return 1; }
  remote_setup "$target" "$label" "$wk"
}

ensure_packages() {
  local missing=() pair
  for pair in python3:python3 "$SSH":openssh-client curl:curl sha256sum:coreutils; do
    command -v "${pair%%:*}" >/dev/null 2>&1 || missing+=("${pair##*:}")
  done
  [ ${#missing[@]} -eq 0 ] && return 0
  say "安装 ${missing[*]}……"
  { "$APT" update && "$APT" install -y ca-certificates "${missing[@]}"; } </dev/null >/dev/null || die "装不上 ${missing[*]}"
}

dry_run_plan() {
  say "--dry-run：只列出要做的事，什么都没改。"
  say "1. 检查 dsh；缺 python3、openssh-client、curl 才装。"
  say "2. 从 $BASE 下载插件和 li、li2 用的配置。"
  say "3. 问 li2 的 SSH 令牌；网关没装就从 li2 取安装包 $REMOTE_ZIP，核对大小和 SHA-256 后解到 $GW_DIR。"
  say "4. 插件放到 $PLUGIN_DIR；第一次装时 dsh plugin --profile web add。"
  say "5. 云端任务插件放到 $CLOUD_PLUGIN_DIR；第一次装时 dsh plugin --profile web add。"
  say "6. 问 li2 账号的只读 key 和写 key（都可以回车跳过）；SSH 目标和只读 key 记进 $CLOUD_DIR/secrets.json（权限 600）。"
  say "7. 在 li2 上写 ~/.local/bin/dsh-tablet、~/.dsh/profiles/web/cordis.patch.yml（原有别的就先备份）、建 /data/workspace/tablet；"
  say "   装租约插件 ~/.liming-lease、写 ~/.liming-cloud/machine-name，给了写 key 就存成 ~/.liming-cloud/lease.key（权限 600）。"
  if [ "$1" = 1 ]; then say "8. --skip-li：不接 li。"; else say "8. 问 li 的令牌（可以直接回车跳过），在 li 上做同样的事。"; fi
}

summary() {
  local w ws line
  say ""
  say "装好了。"
  say "· 网关：$GW_DIR/current（$VERSION），日志在 $GW_DIR/logs/"
  say "· 插件：$PLUGIN_DIR（网关），$CLOUD_PLUGIN_DIR（云端任务）"
  local name lease leasekey
  for name in li2 li; do
    if [ "$name" = li2 ]; then line=$1; else line=$2; fi
    if [ -z "$line" ]; then say "· li：没接（以后想接，再跑一次这个脚本）"; continue; fi
    IFS=$'\t' read -r w ws lease leasekey <<<"$line"
    say "· $name：启动命令 $w，工作目录 $ws"
    if [ "$leasekey" = yes ]; then say "  租约插件已装、写 key 已存：任务跑着时 $name 不会被当成空闲暂停"
    else say "  $name 上没装写 key：任务长时间没输出时，$name 可能被当成空闲暂停（重跑脚本时补上）"; fi
  done
  cat <<'EOF'

接下来在 App 里：
1. 设置 › 本机引擎 › 重启。网关会跟着引擎起来。
2. 浏览器打开 http://127.0.0.1:8788 ，用 admin 登录，先在设置里改密码（平板上别的 App 也能访问这个地址），再加网关账号，然后在「设置 → API Key」新建一个 key。
3. 设置 › 模型 › 添加渠道：兼容协议 Responses，Base URL http://127.0.0.1:8788/v1，API Key 填上一步的 key；点「获取模型」，勾 deepseek-v4.1-flash、glm-5.4、kimi-k3.1-pro。每个模型的上下文填 1M，输入类型选「文本和图片」；思考档位 DeepSeek 选 不思考/低/高/最高，GLM、Kimi 选 低/高/最高。
4. 切换主机 › 管理远程主机 › 添加 SSH 主机：主机填令牌行里 @ 右边那段，用户名填 @ 左边那段，端口 22；实例管理选「托管启动」，启动命令和工作目录照上面填（启动命令后面不要加 web）。再关掉「连接上次使用的主机」。
5. 设置 › 手机操控：打开开关，开无障碍和通知。

别做：别点「重置运行环境」（会删掉网关和账号）；连上 li2 时别接着天启的对话；用完切回本机，云电脑才会按时睡。
EOF
}

main() {
  local dry=0 skip_li=0 arg li2 li='' li_asked=0 r2 r1=''
  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry=1;;
      --skip-li) skip_li=1;;
      -h|--help) sed -n '2,7p' "$0" 2>/dev/null || true; return 0;;
      *) die "不认识的参数：$arg";;
    esac
  done
  if [ "$dry" = 1 ]; then dry_run_plan "$skip_li"; return 0; fi
  command -v "$DSH" >/dev/null 2>&1 || die "没找到 dsh：先在 DSH Go 里装好本机运行环境，再在 App 的终端里运行"
  [ "$(uname -m)" = aarch64 ] || say "提示：这台是 $(uname -m)，平板上应是 aarch64。"
  ensure_packages
  exec 3<"$TTY" || die "读不到终端（$TTY）：请在 App 的终端里运行"
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  say "下载插件和配置……"
  mkdir -p "$WORK/plugin/lib"
  fetch_file "$BASE/liming-gateway/package.json" "$WORK/plugin/package.json" '"name": "liming-gateway"' || die "插件没下载下来"
  fetch_file "$BASE/liming-gateway/cordis.patch.yml" "$WORK/plugin/cordis.patch.yml" 'liming-gateway' || die "插件没下载下来"
  fetch_file "$BASE/liming-gateway/lib/index.js" "$WORK/plugin/lib/index.js" 'liming-gateway' || die "插件没下载下来"
  fetch_file "$BASE/liming-gateway/lib/gateway.js" "$WORK/plugin/lib/gateway.js" 'createSupervisor' || die "插件没下载下来"
  fetch_plugin liming-cloud "$WORK/cloud" "$CLOUD_FILES" || die "云端任务插件没下载下来"
  fetch_plugin liming-lease "$WORK/lease" "$LEASE_FILES" || die "租约插件没下载下来"
  fetch_file "$BASE/dsh-tablet.sh" "$WORK/dsh-tablet.sh" 'dsh-tablet' || die "包装脚本没下载下来"
  fetch_file "$BASE/dsh-tablet-profile.yml" "$WORK/dsh-tablet-profile.yml" '- id: llm-pi-ai' || die "tablet 配置没下载下来"

  li2=$(ask_token 'li2（天启那台）' '')
  if [ -f "$GW_DIR/current/wb_proxy.py" ]; then
    say "网关已经装好（$GW_DIR/current），不再下载。"
  else
    say "从 li2 取网关安装包（约 22 MB）……"
    if ! rssh -n "$li2" "cat $REMOTE_ZIP" > "$WORK/gw.zip" 2>/dev/null || ! verify_zip "$WORK/gw.zip" 2>/dev/null; then
      [ "$skip_li" = 1 ] && die "li2 上取不到网关安装包；去掉 --skip-li 再运行，从 li 取"
      say "li2 上取不到，改从 li 取。"
      li=$(ask_token 'li（小芯那台）' ''); li_asked=1
      rssh -n "$li" "cat $REMOTE_ZIP" > "$WORK/gw.zip" 2>/dev/null || die "li 上也取不到网关安装包（$REMOTE_ZIP）"
    fi
    install_gateway "$WORK/gw.zip" || die "网关没装上"
    say "网关装好了：$GW_DIR/current"
  fi
  install_plugin "$WORK/plugin" "$PLUGIN_DIR" "$GATEWAY_FILES" || die "插件没装上"
  say "插件装好了：$PLUGIN_DIR"
  install_plugin "$WORK/cloud" "$CLOUD_PLUGIN_DIR" "$CLOUD_FILES" || die "云端任务插件没装上"
  say "云端任务插件装好了：$CLOUD_PLUGIN_DIR"

  r2=$(setup_machine "$li2" li2) || die "li2 上的配置没配好"
  if [ "$skip_li" = 0 ]; then
    if [ "$li_asked" = 0 ]; then li=$(ask_token 'li（小芯那台）' 1) || li=''; fi
    if [ -n "$li" ]; then r1=$(setup_machine "$li" li) || die "li 上的配置没配好"; fi
  fi
  summary "$r2" "$r1"
}

if [ "${LIMING_SETUP_LIB:-0}" != 1 ]; then main "$@"; fi
