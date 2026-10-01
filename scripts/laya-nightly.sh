#!/bin/bash
# Nightly (03:00 Asia/Taipei) launchd job：真訓練，不只標註。
#
# 兩段：
#   1. laya-label-corpus.mjs — 讓現行 int8 ONNX 權重回答當天累積的 corpus，
#      寫進 local_answer。這是訓練後比較用的對照組，不是目的本身。
#   2. laya-train.py --promote — encoder 凍結、cross-fit 訓 decision head、
#      用 out-of-fold logits 擬溫度，只有配對增益顯著才換權重。
#
# Zero-token：全程不打 Jev，corpus 只從本來就需要 Jev 的請求長出來。
#
# 升級閘在 laya-train.py 裡（--min-gain + bootstrap CI 下界須離開 0）。
# 這裡只負責推播結果，不自己判達標——兩處都判會漂移。
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPORT="${JEV_LAYA_TRAIN_REPORT:-$HOME/.jevgate/laya-train-report.json}"
PY="${JEV_LAYA_PYTHON:-$HOME/.jevgate/train-venv/bin/python}"
echo "$(date -u +%FT%TZ) start"

# 基線必須釘在原始 int8 bundle，不能跟著 JEV_LAYA_MODEL_DIR 漂。
# 一旦標註用的是訓練後權重，local_answer 就變成模型自己的答案，
# 下一輪的「vs int8 基線」會變成自我比較，增益看起來會憑空消失。
JEV_LAYA_MODEL_DIR="${JEV_LAYA_BASELINE_DIR:-$HOME/.jevgate/laya-multilingual-int8}" \
  node "$DIR/scripts/laya-label-corpus.mjs"
RC=$?
if [ "$RC" != 0 ]; then
  hpush "⚠️ Laya 夜間標註失敗 rc=${RC}，看 ~/.jevgate/laya-nightly.log"
  exit "$RC"
fi

if [ ! -x "$PY" ]; then
  hpush "⚠️ Laya 訓練跳過：找不到 $PY"
  echo "$(date -u +%FT%TZ) end rc=0 train=skipped"
  exit 0
fi
"$PY" "$DIR/scripts/laya-train.py" --promote
RC=$?
if [ "$RC" != 0 ]; then
  hpush "⚠️ Laya 夜間訓練失敗 rc=${RC}，看 ~/.jevgate/laya-nightly.log"
  exit "$RC"
fi

# 換了權重就立刻導出 ONNX。訓練產物是 safetensors，推論端只讀 ONNX bundle，
# 不導出就等於沒生效——這兩步綁死在一起，不留「訓好了但沒人讀」的縫。
#
# 升級閘看的是整體配對增益，但線上那條 lane 吃的是 T=CONF_MIN 這個點的校準。
# 模型可以整體更準卻在該點更糟，所以導出前再擋一次地板（ADR-0002）。
CONF_MIN="${JEV_LAYA_CONF_MIN:-0.70}"
FLOOR="${JEV_LAYA_ACC_FLOOR:-0.95}"
if [ "$(jq -r '.promoted // false' "$REPORT" 2>/dev/null)" = true ]; then
  GATE_ACC=$(jq -r --argjson t "$CONF_MIN" \
    '[.coverage_curve[] | select(.threshold == $t) | .accuracy // 0] | first // 0' "$REPORT" 2>/dev/null)
  if [ "$(jq -n --argjson a "${GATE_ACC:-0}" --argjson f "$FLOOR" '$a >= $f')" = true ]; then
    "$PY" "$DIR/scripts/laya-export-onnx.py"
    ERC=$?
    [ "$ERC" != 0 ] && hpush "⚠️ Laya 導出 ONNX 失敗 rc=${ERC}（權重已換但 bundle 還是舊的）"
  else
    hpush "⚠️ Laya 權重已換但不導出：T=${CONF_MIN} 準確率 ${GATE_ACC} < 地板 ${FLOOR}，線上 bundle 維持舊版"
  fi
fi

# 推播一行摘要：增益、是否換權重、以及 97% 準確率下能接走多少比例。
jq -r '
  def pct: . * 1000 | round / 10;
  [ "units=\(.units)",
    "OOF=\(.oof_accuracy | pct)%",
    (if .paired_delta then "vs int8 \(.paired_delta * 1000 | round / 10)pp" else "vs int8 n/a" end),
    (.coverage_curve | map(select(.accuracy != null and .accuracy >= 0.95))
      | if length > 0 then "可接手 \(max_by(.coverage).coverage | pct)% @\(max_by(.coverage).threshold)" else "無可用閾值" end),
    (if .promoted then "已換權重" else "未達標" end)
  ] | join("，")' "$REPORT" 2>/dev/null |
while read -r line; do
  [ -n "$line" ] && hpush "🎓 Laya 夜訓：${line}"
done
echo "$(date -u +%FT%TZ) end rc=0"
