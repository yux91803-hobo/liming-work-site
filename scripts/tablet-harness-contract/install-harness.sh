#!/usr/bin/env bash
# 在本机缓存目录安装真实 DeepSeek Harness（云端 0.2.2-rc.3 与平板锁定的 0.2.2-rc.1），供契约脚本使用。
# 安装产物落在仓库外（默认 $HOME/.cache/liming-dsh-contract），不进 Git 仓库。
set -euo pipefail

CACHE_DIR=${CONTRACT_CACHE_DIR:-$HOME/.cache/liming-dsh-contract}
RC3_DIR="$CACHE_DIR/rc3"
RC1_DIR="$CACHE_DIR/rc1"
PNPM_DIR="$CACHE_DIR/pnpm"
LOCK_BASE="https://raw.githubusercontent.com/ccch1mneyyy/dsh-Go/main/runtime/locks/dsh-0.2.2-rc.1"

mkdir -p "$RC3_DIR" "$RC1_DIR" "$PNPM_DIR"

echo "1/3 安装云端版本 @deepseek-ai/dsh@0.2.2-rc.3 → $RC3_DIR"
npm install --prefix "$RC3_DIR" --no-audit --no-fund @deepseek-ai/dsh@0.2.2-rc.3

echo "2/3 照 DSH Go runtime/locks/dsh-0.2.2-rc.1 安装平板版本 → $RC1_DIR"
curl -fsSL "$LOCK_BASE/package.json" -o "$RC1_DIR/package.json"
curl -fsSL "$LOCK_BASE/package-lock.json" -o "$RC1_DIR/package-lock.json"
(cd "$RC1_DIR" && npm ci --no-audit --no-fund)

echo "3/3 安装本地 pnpm（供 dsh plugin add 使用）→ $PNPM_DIR"
npm install --prefix "$PNPM_DIR" --no-audit --no-fund pnpm

echo "安装完成："
printf '  rc3:  %s (%s)\n' "$("$RC3_DIR/node_modules/.bin/dsh" --version)" "$RC3_DIR/node_modules/.bin/dsh"
printf '  rc1:  %s (%s)\n' "$("$RC1_DIR/node_modules/.bin/dsh" --version)" "$RC1_DIR/node_modules/.bin/dsh"
printf '  pnpm: %s (%s)\n' "$("$PNPM_DIR/node_modules/.bin/pnpm" --version)" "$PNPM_DIR/node_modules/.bin/pnpm"
