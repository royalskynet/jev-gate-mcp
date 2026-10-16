#!/bin/bash
# One-shot launchd job (local.jev-gate.usage-report): pushes the quota-by-caller
# summary once, then unloads and removes itself. Zero-token.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=local.jev-gate.usage-report
REPORT=$(node "$DIR/scripts/usage-report.mjs" --since 2026-10-05T03:20:00Z 2>&1 | head -12)
hpush "📊 Jev 額度用量（依 caller，tokens 由多到少）
$REPORT"
echo "$(date -u +%FT%TZ) pushed"
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
