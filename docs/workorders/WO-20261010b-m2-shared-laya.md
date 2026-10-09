# WO-20261010b：M2 接 51mini 共享 Laya（tailnet）

在 **M2 本機**執行。路徑以 `$HOME` 為準；repo 不在 `~/jev-gate-mcp` 就先 `export JEV_GATE_DIR=<repo 路徑>`。每步貼**原始輸出**，失敗就停在那步回報，不要自己變通。

## 背景

51mini 上有一個共享 Laya 實例 `http://100.96.184.1:8793`：
- 只聽 tailnet IP，只接受節點 `m2-userspace` 的來源 IP，其他來源回 403。
- 伺服器端強制 laya-only：不管送什麼 header，都不會打付費 Jev。Laya 判不了就回 503，plugin 收到 503 會保持原狀，不調推理強度。
- M2 的呼叫在 51mini 的 usage 記錄成 `cascade:tailnet:effort:opencode`。

## 步驟

```sh
R="${JEV_GATE_DIR:-$HOME/jev-gate-mcp}"
```

**1. 核機型、更新 repo**
```sh
sysctl -n hw.model   # 是 Mac16,10 就停：那是 51mini，不是 M2
cd "$R" && git checkout main && git pull --ff-only && git log --oneline -1
```

**2. 查 tailscaled 模式和本機 8793**
```sh
ps -axo command= | grep '[t]ailscaled' | cut -c1-200
ifconfig | grep -c 'inet 100\.'          # ≥1 ＝ kernel 模式；0 ＝ userspace
lsof -nP -iTCP:8793 -sTCP:LISTEN         # 有輸出就貼出來（關係到 #29）
```

**3. 連線測試**

kernel 模式：
```sh
curl -s -w ' %{http_code}\n' http://100.96.184.1:8793/health
```
userspace 模式：tailscaled 的啟動參數要有 `--outbound-http-proxy-listen=localhost:1055`。沒有的話，找出 tailscaled 是怎麼啟動的（launchd plist 或 brew services），把這個參數加上去、重啟 tailscaled，再測：
```sh
curl -s -x http://localhost:1055 -w ' %{http_code}\n' http://100.96.184.1:8793/health
```
要看到 `{"ok":true} 200`。看到 403 代表 51mini 認不出 M2 的 IP，停下來回報。

**4. 設定 plugin 走共享 Laya**

只加 `effort` 這個 key，既有的 key 不動：
```sh
node -e '
const f=process.env.HOME+"/.jevgate/cascade-callers.json", fs=require("fs");
let j={}; try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
j.effort="http://100.96.184.1:8793";
fs.mkdirSync(require("path").dirname(f),{recursive:true});
fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n"); console.log(j)'
```
只有 userspace 模式才要做：在 `~/.zshenv` 加 `export JEV_CASCADE_PROXY=http://localhost:1055`。這個設定只作用在 cascade 那一次 fetch，opencode 其他流量不會走 proxy。

**5. TUI 實測**

重開 opencode TUI，送 3 則訊息，難度由低到高，例如「改個錯字」「寫一個 shell 迴圈」「重構整個模組並補測試」。然後：
```sh
tail -5 ~/.jevgate/opencode-effort.log
```

## 驗收（全部成立才算過）

- 第 3 步看到 `200`。
- 第 5 步 `opencode-effort.log` 多了 3 行以上。
- 51mini 端由主 session 核對：usage 出現 `cascade:tailnet:effort:opencode`，而且沒有任何付費 Jev 的紀錄。

## 回報格式

貼到 issue 留言：第 1–5 步的原始輸出，加上 tailscaled 是哪種模式、有沒有改 tailscaled 參數。
