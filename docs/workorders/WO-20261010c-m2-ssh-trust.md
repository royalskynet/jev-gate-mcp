# WO-20261010c：M2 信任 51mini 的 SSH 金鑰（一次性）

在 **M2 本機**執行，做完以後 51mini 的主 session 就能直接 SSH 進 M2 跑工單，不用再靠人工複製貼上。

- 這把金鑰只能從 51mini 的 tailnet IP `100.96.184.1` 使用（`from=`）。金鑰外流到別台機器也登不進來。
- 已關閉 agent／port／X11 轉發。
- **撤銷方法**：刪掉 `~/.ssh/authorized_keys` 裡註解含 `51mini->m2` 的那一行。

## 步驟

```sh
sysctl -n hw.model   # 如果是 Mac16,10 就停：那台是 51mini
mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
LINE='from="100.96.184.1",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP0AZC52jtZCmxeFPMNEJaBjXUpEss4vAi+CrjhI/EMl 51mini->m2 2026-10-10'
grep -qF "51mini->m2" ~/.ssh/authorized_keys || printf '%s\n' "$LINE" >> ~/.ssh/authorized_keys
whoami; grep -c '51mini->m2' ~/.ssh/authorized_keys
systemsetup -getremotelogin 2>/dev/null || echo "systemsetup needs admin; port 22 已確認開著"
```

## 驗收

- 回報 `whoami`，以及 `grep -c` 的結果（要是 `1`）。
- 51mini 端會跑 `ssh m2@100.125.130.1 hostname` 驗證，這一步不用 M2 做。

回報貼在 #29 或新留言都可以。
