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
# 換權重的閘在 laya-train.py 裡（--min-gain + bootstrap CI 下界須離開 0，對出廠 int8）；
# 導出上線的閘在下面（地板／人口／同卷配對，對現役）。
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPORT="${JEV_LAYA_TRAIN_REPORT:-$HOME/.jevgate/laya-train-report.json}"
PY="${JEV_LAYA_PYTHON:-$HOME/.jevgate/train-venv/bin/python}"
echo "$(date -u +%FT%TZ) start"
echo "$(date -u +%FT%TZ) start" >&2  # launchd 的 err.log 是 append，沒這行分不出哪晚
START_EPOCH=$(date +%s)

# 基線必須釘在原始 int8 bundle，不能跟著 JEV_LAYA_MODEL_DIR 漂。
# 一旦標註用的是訓練後權重，local_answer 就變成模型自己的答案，
# 下一輪的「vs int8 基線」會變成自我比較，增益看起來會憑空消失。
JEV_LAYA_MODEL_DIR="${JEV_LAYA_BASELINE_DIR:-$HOME/.jevgate/laya-multilingual-int8}" \
  node "${JEV_LAYA_LABEL_SCRIPT:-$DIR/scripts/laya-label-corpus.mjs}"
RC=$?
if [ "$RC" != 0 ]; then
  DONE="${JEV_LAYA_LABEL_DONE:-$HOME/.jevgate/laya-label.done}"
  EP=$(jq -r '.epoch // 0' "$DONE" 2>/dev/null || echo 0)
  if [ "$RC" = 134 ] && [ "${EP:-0}" -ge "$START_EPOCH" ]; then
    hpush "⚠️ Laya 標註完成但退出碼 rc=134（ORT teardown 競態），繼續訓練"
  else
    hpush "⚠️ Laya 夜間標註失敗 rc=${RC}，看 ~/.jevgate/laya-nightly.log"
    exit "$RC"
  fi
fi

# 標註有時間預算（JEV_LAYA_LABEL_BUDGET_SEC），用完就把剩下的留給明晚，否則寬樣本
# 積壓會把訓練推到白天。積壓必須看得見：沒有這一行，語料會無聲地永遠標不完。
DEFERRED=$(jq -r '.deferred // 0' "${JEV_LAYA_LABEL_DONE:-$HOME/.jevgate/laya-label.done}" 2>/dev/null || echo 0)

if [ ! -x "$PY" ]; then
  hpush "⚠️ Laya 訓練跳過：找不到 $PY"
  echo "$(date -u +%FT%TZ) end rc=0 train=skipped"
  exit 0
fi
# time -l 量峰值 footprint（ram_guard 用同一個量法）。exec 讓量到的是 python 本身；
# python 的 stderr 經 fd3 照舊進 err.log，只有 time 的統計進 TIMEF。
# 硬時限：10-10 語料暴增，訓練 2h40m 沒跑完才被手動砍（10-08/09 也都沒跑完）。
# timeout 在 time 外層，逾時送 TERM 給整個行程群組，rc=124、peak 量不到（印 ?）。
# PYTHONUNBUFFERED：stdout 進檔案會被緩衝，被砍時 log 一行進度都不剩。
TRAIN_TIMEOUT="${JEV_LAYA_TRAIN_TIMEOUT_SEC:-14400}"
# 不跟 Hindsight 搶：記憶體可用比例（kern.memorystatus_level，0–100）低於門檻今晚就不訓，明晚再來。
# 10-11 晚 llama-server＋Hindsight＋手動標註疊在一起把 24GB 壓到 free 6%，守衛自己都被餓死（fix 10398）。
MEM_MIN="${JEV_LAYA_MEM_LEVEL_MIN:-40}"
MEM_LEVEL=$(sysctl -n kern.memorystatus_level 2>/dev/null || echo 0)
if [ "$MEM_LEVEL" -lt "$MEM_MIN" ]; then
  hpush "⏸️ Laya 夜訓今晚跳過：記憶體可用 ${MEM_LEVEL}% < ${MEM_MIN}%（不跟 Hindsight 搶）"
  echo "$(date -u +%FT%TZ) end rc=0 train=skipped mem_level=${MEM_LEVEL}"
  exit 0
fi
# 低強度：h 快取放磁碟 memmap、encoder 快取完就卸（10-11 實測 200 units 峰值 4.7GB 只在編碼 40s，
# 訓練段 2.9–3.9GB），head 走 MPS（CPU 每筆每 epoch 0.8s、MPS 0.17s）。每題封頂 150：
# 去重後 1263 units，與 10-06 上線那版的 1552 同量級，5 fold×8 epoch 約 2h。
# taskpolicy -b＝背景 QoS（CPU 讓給前景與 Hindsight、IO 節流）。去重模型離線載入，快取沒有就失敗不略過。
HCACHE="${JEV_LAYA_HCACHE_DIR:-$HOME/.jevgate/laya-hcache}"
rm -rf "$HCACHE"; mkdir -p "$HCACHE"
TIMEF=$(mktemp)
PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1 JEV_LAYA_MAX_PER_QID="${JEV_LAYA_MAX_PER_QID:-150}" \
  timeout -s TERM "$TRAIN_TIMEOUT" \
  /usr/bin/time -l taskpolicy -b sh -c 'exec "$@" 2>&3' sh "$PY" "$DIR/scripts/laya-train.py" --promote \
    --device "${JEV_LAYA_DEVICE:-mps}" --cache-dir "$HCACHE" 3>&2 2>"$TIMEF"
RC=$?
rm -rf "$HCACHE"  # 1263 units 約 1.3GB，每晚整份重算，不留
PEAK_MB=$(awk '/peak memory footprint/{print int($1/1048576)}' "$TIMEF")
rm -f "$TIMEF"
echo "$(date -u +%FT%TZ) train peak_fp=${PEAK_MB:-?}MB rc=${RC}"
# 10-08/09 MPS 快取囤到 15GB 被 ram_guard 砍（fix 10256），修後實測 8.2GB。超過門檻就是回歸。
PEAK_WARN_MB="${JEV_LAYA_PEAK_WARN_MB:-6144}"  # 10-11 低強度模式實測 4.7GB
if [ "${PEAK_MB:-0}" -ge "$PEAK_WARN_MB" ]; then
  hpush "⚠️ Laya 訓練記憶體峰值 ${PEAK_MB}MB ≥ ${PEAK_WARN_MB}MB，MPS 快取可能又在囤（fix 10256）"
fi
if [ "$RC" != 0 ]; then
  HINT=""
  [ "$RC" = 124 ] && HINT="（訓練超過 ${TRAIN_TIMEOUT}s 硬時限，看 log 停在哪個 fold/epoch；調 JEV_LAYA_MAX_PER_QID）"
  [ "$RC" = 143 ] && HINT="（SIGTERM，多半是 ram_guard 砍：grep 'kill rule' ~/.omlx/logs/ram_guard.log）"
  hpush "⚠️ Laya 夜間訓練失敗 rc=${RC}${HINT}，看 ~/.jevgate/laya-nightly.log"
  exit "$RC"
fi

# 換了權重就立刻導出 ONNX。訓練產物是 safetensors，推論端只讀 ONNX bundle，
# 不導出就等於沒生效——這兩步綁死在一起，不留「訓好了但沒人讀」的縫。
#
# 導出才是上線，所以閘掛在這裡。這是「換版本閘」：只回答新版有沒有比現役差。
#   人口閘（qids）   兩條 lane 都不看題目身分（信心閘看 qtype、state 閘看 state 的
#                    key 形狀），所以 caller 改自己的 state 或新 caller 接進來，都會
#                    讓從未量測過的題目無聲進入本機 lane。名單裡出現現役沒有的題目就不導出。
#   同卷配對         新版先導到候選目錄（不上線），現役與候選用 laya-eval-onnx.py
#                    --gate-dump 在同一份 corpus 上各跑一次，laya_paired_gate.py 做
#                    McNemar 精確檢定，只有新版本機答錯的題顯著較多才擋。
# 10-11 拿掉絕對地板（FLOOR 0.95）與最少題數（MIN_N 30）（使用者核准）：兩者是「接手閘」
# 的判準卻擋在換版本閘，n 長不大加上地板，10-07 OOF 0.637 的訓練成果一直上不了線
# （Google Rules of ML #24/#39、champion/challenger 共識：換版本只比現役，相對）。
# 接手安全由服務端每題 confMin＋CP 錯誤預算（只算 Laya 接手題）負責。
CHAMP="${JEV_LAYA_CHAMPION:-$HOME/.jevgate/laya-champion.json}"
LIVE="${JEV_LAYA_EXPORT_DIR:-$HOME/.jevgate/laya-trained-onnx}"
CAND="${JEV_LAYA_CANDIDATE_DIR:-$HOME/.jevgate/laya-candidate-onnx}"
PAIRED=""
if [ "$(jq -r '.promoted // false' "$REPORT" 2>/dev/null)" = true ]; then
  SPEC=$(jq -r '.live_gated.conf_min // ""' "$REPORT" 2>/dev/null)
  # 現役沒有 qids（舊檔）就無從比對，這一輪只靠同卷配對擋。
  NEW_QIDS=$(jq -r --slurpfile c "$CHAMP" '
    ($c[0].qids // null) as $k
    | if $k == null then "" else [.live_gated.qids[] | select(. as $q | $k | index($q) | not)] | join(",") end
  ' "$REPORT" 2>/dev/null)
  if [ -n "$NEW_QIDS" ]; then
    hpush "⚠️ Laya 權重已換但不導出：本機 lane 出現現役沒有的題目 ${NEW_QIDS}（從未量測就上線），bundle 維持舊版"
  else
    rm -rf "$CAND" "$CAND.prev" "$CAND.new"
    # parity 只比本機會答的題，翻轉只警告：int8 實測會翻 gated 題 10/64（fp32 0/64），
    # 但翻轉≠答錯，導出到候選目錄後由下面的同卷配對閘拿老師答案判（使用者 10-09 核准）
    GATED_QIDS=$(jq -r '.live_gated.qids // [] | join(",")' "$REPORT" 2>/dev/null)
    JEV_LAYA_EXPORT_DIR="$CAND" "$PY" "$DIR/scripts/laya-export-onnx.py" --parity-qids "$GATED_QIDS" --parity-warn-only
    ERC=$?
    rm -rf "$CAND.prev" "$CAND.new"  # .new＝導出被中途砍掉時 atexit 來不及清的殘骸
    if [ "$ERC" != 0 ]; then
      hpush "⚠️ Laya 導出 ONNX 失敗 rc=${ERC}（權重已換但 bundle 還是舊的）"
    else
      GD="$(mktemp -d)"
      : > "$GD/champ.jsonl"
      ERC=0
      if [ -f "$LIVE/laya.onnx" ]; then
        "$PY" "$DIR/scripts/laya-eval-onnx.py" --bundle "$LIVE" --gate-dump "$GD/champ.jsonl" >/dev/null || ERC=$?
      fi
      [ "$ERC" = 0 ] && { "$PY" "$DIR/scripts/laya-eval-onnx.py" --bundle "$CAND" --gate-dump "$GD/cand.jsonl" >/dev/null || ERC=$?; }
      [ "$ERC" = 0 ] && { "$PY" "$DIR/scripts/laya_paired_gate.py" "$GD/champ.jsonl" "$GD/cand.jsonl" > "$GD/verdict.json" || ERC=$?; }
      V="$GD/verdict.json"
      if [ "$ERC" != 0 ]; then
        hpush "⚠️ Laya 同卷配對評估失敗 rc=${ERC}（權重已換但 bundle 維持舊版），看 ~/.jevgate/laya-nightly.log"
      else
        PAIRED=$(jq -r '
          def pct: . * 1000 | round / 10;
          if .paired then
            "同卷 n=\(.n_common) 新版 \(.candidate.accuracy // 0 | pct)%（本機 \(.candidate.n)）vs 現役 \(.champion.accuracy // 0 | pct)%（本機 \(.champion.n)），新版多錯 \(.b)／少錯 \(.c)，McNemar p=\(.p)"
          else "無現役 bundle，新版 \(.candidate.accuracy // 0 | pct)%（本機 \(.candidate.n)）" end' "$V")
        if [ "$(jq -r '.ship' "$V")" != true ]; then
          hpush "⚠️ Laya 權重已換但不導出：${PAIRED} < 0.05，新版顯著退步，bundle 維持舊版"
        else
          # 候選換上線：與 laya-export-onnx.py 的 commit() 同一套 .prev 慣例。
          rm -rf "$LIVE.prev"
          if [ -e "$LIVE" ]; then mv "$LIVE" "$LIVE.prev"; fi
          mv "$CAND" "$LIVE"
          # 只有真的換上線才更新現役紀錄，數字是同卷重算的那份，下次才比得起來。
          jq -n --slurpfile v "$V" --arg s "$SPEC" \
            --arg ts "$(date -u +%FT%TZ)" --argjson u "$(jq -r '.units // 0' "$REPORT")" \
            --argjson q "$(jq -c '.live_gated.qids // []' "$REPORT")" \
            '{accuracy:($v[0].candidate.accuracy // 0), n:$v[0].candidate.n, units:$u, conf_min:$s, qids:$q,
              paired:{n_common:$v[0].n_common, b:$v[0].b, c:$v[0].c, p:$v[0].p,
                      prev_accuracy:($v[0].champion.accuracy // null), prev_n:($v[0].champion.n // null)},
              promoted_at:$ts}' > "$CHAMP.tmp" &&
            mv "$CHAMP.tmp" "$CHAMP" && chmod 600 "$CHAMP"
        fi
      fi
      rm -rf "$GD"
      rm -rf "$CAND"  # 被擋或評估失敗的候選不留著佔 500MB+
    fi
  fi
fi

# 推播一行摘要：增益、是否換權重、以及 97% 準確率下能接走多少比例。
jq -r '
  def pct: . * 1000 | round / 10;
  [ "units=\(.units)",
    "OOF=\(.oof_accuracy | pct)%",
    (if .paired_delta then "vs int8 \(.paired_delta * 1000 | round / 10)pp" else "vs int8 n/a" end),
    (if .live_gated.accuracy then
       "線上 lane n=\(.live_gated.n) 準確 \(.live_gated.accuracy | pct)%"
     else "線上 lane 無樣本" end),
    (if .promoted then "已換權重" else "未達標" end),
    (if $paired != "" then $paired else empty end),
    (if ($deferred | tonumber) > 0 then "標註尚餘 \($deferred) 筆（預算用完，留給明晚）" else empty end)
  ] | join("，")' --arg paired "$PAIRED" --arg deferred "${DEFERRED:-0}" "$REPORT" 2>/dev/null |
while read -r line; do
  [ -n "$line" ] && hpush "🎓 Laya 夜訓：${line}"
done
echo "$(date -u +%FT%TZ) end rc=0"
