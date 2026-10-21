#!/bin/bash
# Hourly launchd watchdog for the Zen free Jev tier (the default provider).
# Probe rc: 0 Zen up, 2 Zen in quota cooldown with OpenRouter as backup,
# 1 Zen down with no backup (every Jev consumer keeps everything), 3 IP banned
# (403 FreeTierError) with OpenRouter as backup. daily_brief.py maps the same codes.
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
    # rc 0/2 已併入 daily_brief.py 的重點日報（模型段），不再單獨推播；
    # 例外：封 IP（3）解除要即時推，否則只有隔天日報看得到（10-19）
    0) if [ "$PREV" = 3 ]; then
         U=$(zen-gate until 2>/dev/null); case "$U" in ''|*[!0-9]*) U=不明 ;; *) U=$(date -r "$U" "+%m-%d %H:%M") ;; esac
         hpush "✅ Jev Zen 免費層解封了，Jev 回到免費層。dc 的 Zen 閘到期才開（到 $U）"
       fi ;;
    2) : ;;
    3) hpush "⚠️ Jev Zen 免費層被 OpenCode 封 IP（403 FreeTierError），Jev 改走付費 OpenRouter，解封要等上游。看 ~/.jevgate/zen-free-status.json" ;;
    *) hpush "⚠️ Jev zen free 失效且無 OpenRouter 備援：Jev 判斷已停。看 ~/.jevgate/zen-free-status.json" ;;
  esac
fi
# Backstop for a failure kind the probe cannot name yet: a quota cooldown heals
# within hours (longest seen ~15h), so 24 hourly rc=2 in a row is an outage.
STREAK_F="$HOME/.jevgate/zen-watch.streak"
if [ "$RC" = 2 ]; then STREAK=$(( $(cat "$STREAK_F" 2>/dev/null || echo 0) + 1 )); else STREAK=0; fi
echo "$STREAK" > "$STREAK_F"
if [ "$STREAK" = "${ZEN_WATCH_STREAK_MAX:-24}" ]; then
  hpush "⚠️ Jev Zen 免費層連續 ${STREAK} 次探測都在冷卻（rc=2），超過額度冷卻該有的長度，Jev 一直走付費 OpenRouter。看 ~/.jevgate/zen-free-status.json"
fi
rm -f "$HOME/.jevgate/zen-watch.down" # legacy marker from the rc-less version
echo "$(date -u +%FT%TZ) rc=$RC"
