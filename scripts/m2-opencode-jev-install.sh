#!/bin/bash
# 在 M2 跑（不是 host）：把 opencode TUI 接上 jev-laya plugin。
# 效果：每個工具輸出先做 L0 剪裁（免費、本機）；剪完仍 ≥16KB 的 bash/read/grep/glob/webfetch
# 輸出，再交 Jev 依「使用者這次要做的事」判斷 keep/drop。任何失敗都原樣放行，不分模型。
# 另外：compaction（舊工具輸出交 Jev 判 keep/drop）、推理強度（每則訊息判一次難度，
# 有 Laya cascade 才跑，預設直接降，記在 ~/.jevgate/opencode-effort.log；JEV_EFFORT_APPLY=0 只記不降；沒 Laya 自動關閉）。
# Genie repo 在的話一併接上 genie-dedup（零 token 去重，不呼叫 Jev）。
# 依賴只有 node 內建模組，不用 npm install。
set -euo pipefail

if [ "$(sysctl -n hw.model)" = "Mac16,10" ]; then
  echo "這台是 host（Mac16,10），本腳本只給 M2 跑，停止。" >&2
  exit 1
fi

# 「這台缺什麼」的通知每項只在第一次安裝時印；重跑本腳本或 git pull 更新都不再印。
# 已印過的項目記在 ~/.jevgate/install-notices（刪掉該檔就會再印一次）。
NOTICES="$HOME/.jevgate/install-notices"
notice() { # notice <key> <訊息>
  mkdir -p "$(dirname "$NOTICES")"
  grep -qxF "$1" "$NOTICES" 2>/dev/null && return 0
  echo "提醒：$2" >&2
  echo "$1" >> "$NOTICES"
}

REPO="${JEV_GATE_DIR:-$HOME/jev-gate-mcp}"
[ -d "$REPO/.git" ] || { echo "找不到 repo：${REPO}（可用 JEV_GATE_DIR 指定）" >&2; exit 1; }

# 工作樹有未提交改動時 --ff-only 可能失敗：直接停，不替你 stash。
git -C "$REPO" pull --ff-only

# 官方安裝器放 ~/.opencode/bin，PATH 只在 .zshrc 加，非互動 shell（SSH 執行）看不到。
command -v opencode >/dev/null || [ -x "$HOME/.opencode/bin/opencode" ] || notice no-opencode "這台找不到 opencode 指令 → plugin 已接好，但要裝了 opencode 才會載入。"

PLUGIN_DIR="$HOME/.config/opencode/plugins"
mkdir -p "$PLUGIN_DIR"
ln -sfn "$REPO/integrations/opencode/jev-laya.js" "$PLUGIN_DIR/jev-laya.js"
echo "plugin：$(readlink "$PLUGIN_DIR/jev-laya.js")"

GENIE="${GENIE_DIR:-}"
if [ -z "$GENIE" ]; then
  for d in "$HOME/genie-harness" "$HOME/dev/genie-harness"; do [ -d "$d/.git" ] && GENIE="$d" && break; done
fi
[ -n "$GENIE" ] && git -C "$GENIE" pull --ff-only
if [ -n "$GENIE" ] && [ -f "$GENIE/opencode/genie-dedup.js" ]; then
  ln -sfn "$GENIE/opencode/genie-dedup.js" "$PLUGIN_DIR/genie-dedup.js"
  echo "plugin：$(readlink "$PLUGIN_DIR/genie-dedup.js")"
else
  notice no-genie "這台沒有 Genie repo（~/genie-harness 或 ~/dev/genie-harness，可用 GENIE_DIR 指定）→ 零 token 去重沒接上。"
fi

if [ -z "${JEV_ENDPOINT:-}" ] && [ ! -f "$HOME/.creds/kv/TYPESAFE_API_KEY.txt" ]; then
  notice no-jev-key "這台沒有 JEV_ENDPOINT，也沒有 ~/.creds/kv/TYPESAFE_API_KEY.txt → 只有 L0 剪裁，不會呼叫 Jev。"
fi

# 推理強度只在有 Laya cascade（cascade-callers.json 設 effort）時才跑；M2 沒裝 Laya → 自動關閉。
if ! grep -q '"effort"' "$HOME/.jevgate/cascade-callers.json" 2>/dev/null; then
  notice no-laya "這台沒有 Laya cascade → 推理強度判斷已自動關閉（每則訊息不會多打一筆付費 Jev）。要強制開設 JEV_EFFORT_ENABLED=1。"
fi

# 煙霧測試：真打一次 Jev（約 2 個 chunk，費用極小），只印結果欄位，不印 key。
cd "$REPO"
JEV_CLI_LEDGER=/dev/null node --input-type=module -e "
import { existsSync } from 'node:fs';
import { defaultJevEnv } from './integrations/opencode/prune-core.js';
defaultJevEnv(process.env, existsSync);
process.env.JEV_USAGE_CALLER ??= 'opencode-smoke';
const { pruneCommand } = await import('./agent-glue/src/prune.js');
const noise = Array.from({ length: 1500 }, (_, i) => 'heartbeat ok tick ' + i).join('\n');
const text = noise + '\nERROR: database connection refused on port 5432\n' + noise;
const r = await pruneCommand({ tool: 'Bash', request: 'why does the database connection fail', text });
console.log(JSON.stringify({ reason: r.reason, judged: r.judged, chars_before: r.chars_before, chars_after: r.chars_after, kept_error: r.text.includes('ERROR: database') }));
"
echo "看判讀：judged=true 且 kept_error=true＝Jev 有接上且沒剪掉答案；reason=no-key＝金鑰沒讀到；judged=false 其他＝網路或端點錯。"
echo "重開 opencode TUI 後生效。"
