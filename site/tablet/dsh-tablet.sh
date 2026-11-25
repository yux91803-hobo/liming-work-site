#!/bin/sh
# 平板（DSH Go）连这台电脑时用：独立的 tablet 配置，网关 key 只在这台电脑上读。
# DSH Go 的「托管启动」会在后面加 --host 127.0.0.1 --port 0 --no-open，原样传给 dsh。
# 由 https://liming-work.com/tablet/setup.sh 放到 ~/.local/bin/dsh-tablet，说明见仓库 docs/tablet.md。
XIN_HARNESS_KEY=$(cat "$HOME/.xin/harness.key" 2>/dev/null) && [ -n "$XIN_HARNESS_KEY" ] || {
  echo "dsh-tablet: 读不到 $HOME/.xin/harness.key，这台电脑的网关还没配好" >&2
  exit 78
}
export XIN_HARNESS_KEY
exec "$HOME/.local/bin/dsh" --profile tablet "$@"
