#!/bin/bash
# One-shot launchd job (com.51mini.jev-cascade-report-1009): pushes the Stop
# gate's first-day cascade summary once, then unloads and removes itself.
# Zero-token.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.51mini.jev-cascade-report-1009
REPORT=$(node "$DIR/scripts/cascade-stopgate-report.mjs" --since 2026-10-08T15:35:00Z 2>&1 | head -12)
mkdir -p "$HOME/.jevgate/reports"
printf '%s\n' "$REPORT" > "$HOME/.jevgate/reports/cascade-stopgate-2026-10-09.md"
hpush "🧮 Stop gate 走本機服務第一天
$REPORT"
echo "$(date -u +%FT%TZ) pushed"
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
