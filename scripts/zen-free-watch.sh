#!/bin/bash
# Hourly launchd watchdog for the Zen free Jev tier (the default provider).
# Zen has no paid sibling to fail over to, so a dead free tier means every
# Jev consumer (gateway, Stop gate, prune, compact) quietly keeps everything.
# Zero-token: runs the probe, pushes only on an up/down transition.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
MARK="$HOME/.jevgate/zen-watch.down"
mkdir -p "$(dirname "$MARK")"
if node "$DIR/scripts/zen-free-probe.mjs" --quiet; then
  if [ -e "$MARK" ]; then
    rm -f "$MARK"
    hpush "✅ Jev zen free 恢復（jev-1.13-free）"
  fi
else
  if [ ! -e "$MARK" ]; then
    touch "$MARK"
    hpush "⚠️ Jev zen free 探測失敗：所有 Jev 判斷已停（無付費 fallback）。看 ~/.jevgate/zen-free-status.json"
  fi
fi
echo "$(date -u +%FT%TZ) rc=$([ -e "$MARK" ] && echo down || echo ok)"
