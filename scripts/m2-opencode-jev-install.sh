#!/bin/bash
# 在 M2 跑（不是 51mini）：把 opencode TUI 接上 jev-laya plugin。
# 效果：每個工具輸出先做 L0 剪裁（免費、本機）；剪完仍 ≥16KB 的 bash/read/grep/glob/webfetch
# 輸出，再交 Jev 依「使用者這次要做的事」判斷 keep/drop。任何失敗都原樣放行，不分模型。
# 依賴只有 node 內建模組，不用 npm install。
set -euo pipefail

if [ "$(sysctl -n hw.model)" = "Mac16,10" ]; then
  echo "這台是 51mini（Mac16,10），本腳本只給 M2 跑，停止。" >&2
  exit 1
fi

REPO="${JEV_GATE_DIR:-$HOME/jev-gate-mcp}"
[ -d "$REPO/.git" ] || { echo "找不到 repo：$REPO（可用 JEV_GATE_DIR 指定）" >&2; exit 1; }

# 工作樹有未提交改動時 --ff-only 可能失敗：直接停，不替你 stash。
git -C "$REPO" pull --ff-only

PLUGIN_DIR="$HOME/.config/opencode/plugins"
mkdir -p "$PLUGIN_DIR"
ln -sfn "$REPO/integrations/opencode/jev-laya.js" "$PLUGIN_DIR/jev-laya.js"
echo "plugin：$(readlink "$PLUGIN_DIR/jev-laya.js")"

if [ -z "${JEV_ENDPOINT:-}" ] && [ ! -f "$HOME/.creds/kv/TYPESAFE_API_KEY.txt" ]; then
  echo "警告：沒有 JEV_ENDPOINT，也沒有 ~/.creds/kv/TYPESAFE_API_KEY.txt → 只有 L0 剪裁，不會呼叫 Jev。" >&2
fi

# 煙霧測試：真打一次 Jev（約 2 個 chunk，費用極小），只印結果欄位，不印 key。
cd "$REPO"
JEV_CLI_LEDGER=/dev/null node --input-type=module -e "
import { existsSync } from 'node:fs';
import { defaultJevEnv } from './integrations/opencode/prune-core.js';
defaultJevEnv(process.env, existsSync);
process.env.JEV_USAGE_CALLER ??= 'prune:opencode-smoke';
const { pruneCommand } = await import('./agent-glue/src/prune.js');
const noise = Array.from({ length: 1500 }, (_, i) => 'heartbeat ok tick ' + i).join('\n');
const text = noise + '\nERROR: database connection refused on port 5432\n' + noise;
const r = await pruneCommand({ tool: 'Bash', request: 'why does the database connection fail', text });
console.log(JSON.stringify({ reason: r.reason, judged: r.judged, chars_before: r.chars_before, chars_after: r.chars_after, kept_error: r.text.includes('ERROR: database') }));
"
echo "看判讀：judged=true 且 kept_error=true＝Jev 有接上且沒剪掉答案；reason=no-key＝金鑰沒讀到；judged=false 其他＝網路或端點錯。"
echo "重開 opencode TUI 後生效。"
