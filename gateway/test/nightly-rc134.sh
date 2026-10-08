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
exit "${FAKE_TRAIN_RC:-0}"
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

# 訓練被 ram_guard SIGTERM（fix 10256）：通知要指向守衛 log，並記下峰值行
rm -f "$MARKER" "$HPASS_LOG"
OUT=$(FAKE_RC=0 FAKE_TRAIN_RC=143 bash "$NIGHTLY" 2>/dev/null); rc=$?
check "train rc143 propagates" 143 "$rc" 1 "$([ -f "$MARKER" ] && echo 1 || echo 0)"
if grep -q "ram_guard" "$HPASS_LOG" 2>/dev/null; then echo "ok - rc143 hpush names ram_guard"; pass=$((pass+1)); else echo "not ok - rc143 hpush names ram_guard"; fail=$((fail+1)); fi
if echo "$OUT" | grep -qE "train peak_fp=[0-9]+MB rc=143"; then echo "ok - peak line logged"; pass=$((pass+1)); else echo "not ok - peak line logged"; fail=$((fail+1)); fi

# 峰值過門檻要告警（門檻設 0 必觸發），沒過不能告警
rm -f "$HPASS_LOG"
FAKE_RC=0 JEV_LAYA_PEAK_WARN_MB=0 bash "$NIGHTLY" >/dev/null 2>&1
if grep -q "記憶體峰值" "$HPASS_LOG" 2>/dev/null; then echo "ok - peak over threshold warns"; pass=$((pass+1)); else echo "not ok - peak over threshold warns"; fail=$((fail+1)); fi
rm -f "$HPASS_LOG"
FAKE_RC=0 bash "$NIGHTLY" >/dev/null 2>&1
if grep -q "記憶體峰值" "$HPASS_LOG" 2>/dev/null; then echo "not ok - peak under threshold silent"; fail=$((fail+1)); else echo "ok - peak under threshold silent"; pass=$((pass+1)); fi

echo "# pass=$pass fail=$fail"
[ "$fail" = 0 ]
