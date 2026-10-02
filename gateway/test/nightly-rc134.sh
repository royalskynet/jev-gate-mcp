#!/bin/bash
set -u
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
NIGHTLY="$DIR/scripts/laya-nightly.sh"
SB=$(mktemp -d)
trap 'rm -rf "$SB"' EXIT

mkdir -p "$SB/bin"
cat > "$SB/bin/hpush" <<'EOF'
#!/bin/sh
echo "hpush $*" >> "$HPASS_LOG"
EOF
chmod +x "$SB/bin/hpush"
export HPASS_LOG="$SB/hpush.log"

cat > "$SB/fake-python" <<'EOF'
#!/bin/sh
touch "$MARKER"
exit 0
EOF
chmod +x "$SB/fake-python"

cat > "$SB/fake-label.mjs" <<'EOF'
const done = process.env.JEV_LAYA_LABEL_DONE;
if (process.env.FAKE_WRITE_DONE === '1') {
  const { writeFileSync } = await import('node:fs');
  const epoch = process.env.FAKE_EPOCH != null ? Number(process.env.FAKE_EPOCH) : Math.floor(Date.now() / 1000);
  writeFileSync(done, JSON.stringify({ ts: new Date().toISOString(), epoch, corpus: 1, scored: 1, failed: 0, pid: process.pid }) + '\n', { mode: 0o600 });
}
process.exit(Number(process.env.FAKE_RC ?? 0));
EOF

export JEV_LAYA_PYTHON="$SB/fake-python"
export JEV_LAYA_LABEL_SCRIPT="$SB/fake-label.mjs"
export JEV_LAYA_LABEL_DONE="$SB/laya-label.done"
export JEV_LAYA_TRAIN_REPORT="$SB/train-report.json"
export JEV_LAYA_CHAMPION="$SB/champion.json"
export MARKER="$SB/reached-train"
export PATH="$SB/bin:$PATH"

pass=0; fail=0
check() {
  local name="$1" erc="$2" arc="$3" emk="$4" amk="$5"
  if [ "$erc" = "$arc" ] && [ "$emk" = "$amk" ]; then
    echo "ok - $name"; pass=$((pass+1))
  else
    echo "not ok - $name (rc=$arc want $erc, marker=$amk want $emk)"; fail=$((fail+1))
  fi
}

rm -f "$MARKER" "$JEV_LAYA_LABEL_DONE"
FAKE_RC=134 FAKE_WRITE_DONE=1 bash "$NIGHTLY" >/dev/null 2>&1; rc=$?
mk=0; [ -f "$MARKER" ] && mk=1
check "rc134+fresh beacon continues" 0 "$rc" 1 "$mk"

rm -f "$MARKER" "$JEV_LAYA_LABEL_DONE"
FAKE_RC=134 FAKE_WRITE_DONE=0 bash "$NIGHTLY" >/dev/null 2>&1; rc=$?
mk=0; [ -f "$MARKER" ] && mk=1
check "rc134+no beacon aborts" 134 "$rc" 0 "$mk"

rm -f "$MARKER" "$JEV_LAYA_LABEL_DONE"
FAKE_RC=1 FAKE_WRITE_DONE=1 bash "$NIGHTLY" >/dev/null 2>&1; rc=$?
mk=0; [ -f "$MARKER" ] && mk=1
check "rc1+fresh beacon aborts" 1 "$rc" 0 "$mk"

rm -f "$MARKER"
FAKE_RC=134 FAKE_WRITE_DONE=1 FAKE_EPOCH=1 bash "$NIGHTLY" >/dev/null 2>&1; rc=$?
mk=0; [ -f "$MARKER" ] && mk=1
check "rc134+stale beacon aborts" 134 "$rc" 0 "$mk"

echo "# pass=$pass fail=$fail"
[ "$fail" = 0 ]
