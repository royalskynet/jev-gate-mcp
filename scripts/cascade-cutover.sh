#!/bin/bash
# P2b cutover (PLAN-20261008-laya-first-cascade.md): called by
# cascade-stopgate-report-once.sh with the P2a report. Machine-checks the
# report and, on PASS, flips two callers onto the :8793 daemon by writing
# ~/.jevgate/cascade-callers.json (both read it every call, no restart):
#   compact      → agent-glue/claude/compact-hook.mjs readCascadeUrl
#   mythos-stop  → ~/bots/mythos/bin/stop-gate.mjs, "shadow" (log only)
# Every step is verified; any failure restores the previous flag file.
# Prints one RESULT line first so the caller can push it. Zero-token.
# DRY=1: judge the report only, change nothing.
set -u
REPORT=${1:?report path}
DIR="$(cd "$(dirname "$0")/.." && pwd)"
FLAG=${CASCADE_FLAG:-$HOME/.jevgate/cascade-callers.json}
DAEMON=${CASCADE_URL:-http://127.0.0.1:8793}

# First block of the report = the window since the P2a switch.
block=$(awk 'NR>1 && /^Stop gate via cascade/{exit} {print}' "$REPORT")
judged=$(printf '%s\n' "$block" | sed -n 's/.*judged Stops (gate.log): \([0-9]*\).*/\1/p')
fallback=$(printf '%s\n' "$block" | sed -n 's/.*direct fallback ≈ \([0-9]*\).*/\1/p')
status=$(printf '%s\n' "$block" | sed -n 's/^status: //p')
notified=$(printf '%s\n' "$block" | sed -n 's/.*"notified":\([a-z]*\).*/\1/p')

why=""
[ -n "$judged" ] && [ "$judged" -ge 10 ] || why="$why judged=${judged:-?}<10"
[ -n "$fallback" ] && [ $((fallback * 10)) -le $((judged > 20 ? judged : 20)) ] || why="$why fallback=${fallback:-?}>max(2,10%)"
printf '%s\n' "$status" | grep -Eq '(^| )[45][0-9][0-9]=' && why="$why non-2xx:[$status]"
[ -z "$status" ] && why="$why no-status"
[ "$notified" = true ] && why="$why OR-daily-cap-hit"

if [ -n "$why" ]; then
  echo "RESULT: FAIL (no change)$why"
  exit 2
fi
if [ -n "${DRY:-}" ]; then
  echo "RESULT: PASS (dry, no change) judged=$judged fallback=$fallback status=[$status]"
  exit 0
fi

bak="$FLAG.bak-$(date +%Y%m%d%H%M%S)"
if [ -f "$FLAG" ]; then cp "$FLAG" "$bak"; else : > "$bak.absent"; fi
restore() {
  if [ -f "$bak" ]; then cp "$bak" "$FLAG"; else rm -f "$FLAG"; fi
  echo "RESULT: ROLLBACK at $1 (flag file restored)"
  exit 1
}

# 1. Daemon must answer before anything is pointed at it.
curl -s -o /dev/null -m 5 "$DAEMON/" ; [ $? -eq 0 ] || restore "daemon-unreachable"

# 2. Write the flags (merge: keep any other caller already switched).
node -e '
const fs=require("fs"),[f,u]=process.argv.slice(1);
let d={};try{d=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
d.compact=u; d["mythos-stop"]=d["mythos-stop"]==="block"?"block":"shadow";
fs.mkdirSync(require("path").dirname(f),{recursive:true});
fs.writeFileSync(f,JSON.stringify(d,null,1)+"\n");' "$FLAG" "$DAEMON" || restore "write-flag"

# 3. Each reader must see its own switch, through its own code.
got=$(cd "$DIR" && node --input-type=module -e '
const { readCascadeUrl } = await import("./agent-glue/claude/compact-hook.mjs");
const fs = await import("node:fs/promises");
console.log(await readCascadeUrl({ fs: { read: (p) => fs.readFile(p, "utf8") } }, process.argv[1]));' "$FLAG" 2>/dev/null)
[ "$got" = "${DAEMON%/}" ] || restore "compact-reads:[$got]"
got=$(MYTHOS_CASCADE_FLAG="$FLAG" node --input-type=module -e '
const { mode } = await import(process.env.HOME + "/bots/mythos/bin/stop-gate.mjs"); console.log(mode());' 2>/dev/null)
case "$got" in shadow|block) ;; *) restore "mythos-stop-reads:[$got]" ;; esac

echo "RESULT: PASS judged=$judged fallback=$fallback status=[$status] → compact=$DAEMON mythos-stop=$got (backup $bak)"
