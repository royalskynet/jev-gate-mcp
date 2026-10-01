#!/bin/bash
# Nightly (03:10) launchd job: let the local Laya weights answer the teacher
# corpus rows the day's normal Jev calls left behind, then push only when a
# question type becomes ready to hand to Laya. Zero-token: no Jev call here,
# the corpus only grows from requests that needed Jev anyway.
#
# Ready = cumulative n >= LAYA_READY_MIN and agreement >= LAYA_READY_RATE for
# one <digest>/<question>. Each ready key is pushed once (laya-ready.notified).
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPORT="${JEV_LAYA_REPORT:-$HOME/.jevgate/laya-agreement.json}"
NOTIFIED="$HOME/.jevgate/laya-ready.notified"
MIN="${LAYA_READY_MIN:-200}"
RATE="${LAYA_READY_RATE:-0.95}"
echo "$(date -u +%FT%TZ) start"
node "$DIR/scripts/laya-label-corpus.mjs"
RC=$?
if [ "$RC" != 0 ]; then
  hpush "⚠️ Laya 夜間標註失敗 rc=${RC}，看 ~/.jevgate/laya-nightly.log"
  exit "$RC"
fi
mkdir -p "$(dirname "$NOTIFIED")" && touch "$NOTIFIED"
jq -r --argjson min "$MIN" --argjson rate "$RATE" \
  '.groups | to_entries[] | select(.value.n >= $min and .value.rate >= $rate)
   | "\(.key)\t\(.value.n)\t\(.value.rate * 1000 | round / 10)"' "$REPORT" |
while IFS=$'\t' read -r key n pct; do
  grep -qxF "$key" "$NOTIFIED" && continue
  hpush "🎓 Laya 在 ${key} 與 Jev 一致 ${pct}%（n=${n}），可考慮讓 Laya 接這題型"
  echo "$key" >> "$NOTIFIED"
done
echo "$(date -u +%FT%TZ) end rc=0"
