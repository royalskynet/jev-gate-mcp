# WO-20261010e：M2 SSH 驗證後斷線診斷（唯讀）

在 **M2 本機 terminal** 執行。全部唯讀，不改任何設定，不碰 `~/.ssh`。

## 現況（51mini 2026-10-10 實測，WO-20261010d 之後）

```
debug1: Server accepts key: ... ED25519 ... explicit
debug3: sign_and_send_pubkey: signing using ssh-ed25519 ...
debug3: send packet: type 50
Connection closed by 100.125.130.1 port 22
```

`from=` 已生效（金鑰被接受）。簽章送出後 sshd 不回成功或失敗，直接斷線，代表擋在驗證之後的帳號檢查。懷疑順序：遠端登入限定使用者（SACL `com.apple.access_ssh`）＞ MDM 推的 sshd 設定 ＞ PAM session。

## 步驟

```sh
sysctl -n hw.model   # 如果是 Mac16,10 就停：那台是 51mini
echo "== sacl_group_exists"; dscl . -read /Groups/com.apple.access_ssh RecordName 2>&1 | head -1
echo "== m2_in_sacl"; dseditgroup -o checkmember -m "$(whoami)" com.apple.access_ssh 2>&1
echo "== sacl_members"; dscl . -read /Groups/com.apple.access_ssh GroupMembership NestedGroups 2>&1
echo "== sshd_config"; grep -hiE '^[[:space:]]*(AllowUsers|AllowGroups|DenyUsers|DenyGroups|AuthenticationMethods|PubkeyAuthentication|UsePAM|ForceCommand|ChrootDirectory|Match)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/* 2>&1
echo "== pam_sshd"; cat /etc/pam.d/sshd 2>&1
echo "== sshd_log"; log show --last 2h --style compact --predicate 'process BEGINSWITH "sshd"' 2>&1 | grep -iE 'm2|sacl|not allowed|refused|pam|fatal|error|Accepted|disconnect' | tail -30
```

## 驗收

- 全部原始輸出貼到 #29，不要摘要。
- `log show` 若顯示要 admin 或沒有輸出，照貼即可，不要用 sudo。

## 禁止

- 不用 sudo、不改 sshd 設定、不改群組、不碰 MDM／TCC、不重啟服務。
- 不 commit、不 amend。
