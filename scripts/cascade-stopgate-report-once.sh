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
# Hand the report to Mythos (its tmux pane, next remind tick) so it judges and
# replies through its own bot; a plain push would never reach its context.
"$HOME/bots/mythos/bin/remind" add +0m "Jev cascade P2a 報告出來了：讀 $HOME/.jevgate/reports/cascade-stopgate-2026-10-09.md，照主記憶待辦「Jev cascade P2a 觀察」的標準（direct fallback≈0、無 5xx、OR 日上限沒爆；Laya 接手 0 是預期）判讀，reply 給我數字、判斷，以及要不要從 compact 開始切其他呼叫點。計畫在 $DIR/docs/prd/PLAN-20261008-laya-first-cascade.md P2。" --ask
echo "$(date -u +%FT%TZ) handed to mythos"
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
