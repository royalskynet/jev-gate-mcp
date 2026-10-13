#!/bin/bash
# Hourly launchd watchdog for the Zen free Jev tier (the default provider).
# Probe rc: 0 Zen up, 2 Zen in quota cooldown with OpenRouter as backup,
# 1 Zen down with no backup (every Jev consumer keeps everything).
# Zero-token: runs the probe, pushes only when the rc changes.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.jevgate/zen-watch.rc"
mkdir -p "$(dirname "$STATE")"
OUT=$(node "$DIR/scripts/zen-free-probe.mjs")
RC=$?
PREV=$(cat "$STATE" 2>/dev/null || echo 0)
if [ "$RC" != "$PREV" ]; then
  echo "$RC" > "$STATE"
  UNTIL=$(printf '%s\n' "$OUT" | grep -o 'cooldown_until=[^ ]*' | cut -d= -f2)
  case "$RC" in
    # rc 0/2 已併入 daily_brief.py 的重點日報（模型段），不再單獨推播
    0) : ;;
    2) : ;;
    *) hpush "⚠️ Jev zen free 失效且無 OpenRouter 備援：Jev 判斷已停。看 ~/.jevgate/zen-free-status.json" ;;
  esac
fi
rm -f "$HOME/.jevgate/zen-watch.down" # legacy marker from the rc-less version
echo "$(date -u +%FT%TZ) rc=$RC"
