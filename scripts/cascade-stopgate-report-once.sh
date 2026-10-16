#!/bin/bash
# One-shot launchd job (com.host.jev-cascade-report-1009): pushes the Stop
# gate's first-day cascade summary once, then unloads and removes itself.
# Zero-token.
set -u
# DRY=1: write the report and judge it, change nothing, hand nothing over.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.host.jev-cascade-report-1009
REPORT=$(node "$DIR/scripts/cascade-stopgate-report.mjs" --since 2026-10-08T15:35:00Z 2>&1 | head -12)
OUT="$HOME/.jevgate/reports/cascade-stopgate-2026-10-09.md"
# fix 10255: a dry run must never overwrite the real report.
[ -n "${DRY:-}" ] && OUT="${TMPDIR:-/tmp}/cascade-stopgate-dry.md"
mkdir -p "$(dirname "$OUT")"
printf '%s\n' "$REPORT" > "$OUT"
# P2b cutover is a script, not a model step: it judges the report against the
# P2a criteria and flips compact + mythos-stop (shadow) only on PASS, with
# rollback. Mythos just explains the outcome through its own bot.
CUT=$(bash "$DIR/scripts/cascade-cutover.sh" "$OUT" 2>&1); crc=$?
printf '\n## P2b cutover (rc=%s)\n%s\n' "$crc" "$CUT" >> "$OUT"
[ -n "${DRY:-}" ] && { echo "DRY: $CUT"; exit 0; }
"$HOME/.local/bin/hpush" "Jev cascade P2a→P2b: $(printf '%s' "$CUT" | head -1)"
"$HOME/bots/mythos/bin/remind" add +0m "Jev cascade P2a 報告與 P2b 自動切換結果出來了：讀 $HOME/.jevgate/reports/cascade-stopgate-2026-10-09.md（最後一段是 cascade-cutover.sh 的輸出）。切換已由腳本做完或回滾，你不要改任何設定。reply 給我：P2a 數字、切換結果（PASS／FAIL／ROLLBACK 與原因），以及你對數字的判讀。PASS 時補一句：compact 改走 :8793、你自己的 Stop gate 以 shadow 只記錄（log ~/.jev-gate/gate-mythos.log），10-12 21:00 由腳本判斷要不要轉成會擋。" --ask
echo "$(date -u +%FT%TZ) handed to mythos"
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
