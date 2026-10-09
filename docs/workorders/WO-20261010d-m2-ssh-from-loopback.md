# WO-20261010d：M2 SSH 金鑰的 `from=` 補上 loopback（一次性）

在 **M2 本機**執行。修 WO-20261010c 之後 51mini 連進來得到 `Permission denied (publickey)` 的問題。

## 為什麼

- 51mini 實測（2026-10-10）：金鑰有送出、伺服器拒收；51mini 端已確認私鑰與工單內公鑰一致。
- M2 的 tailscaled 是 userspace 模式（`--tun=userspace-networking`）。tailnet 進來的 TCP 由 tailscaled 撥 `127.0.0.1:22`，sshd 看到的來源是 loopback，不是 `100.96.184.1`，所以 `from="100.96.184.1"` 擋掉這把金鑰。
- 改成 `from="100.96.184.1,127.0.0.1,::1"`。代價：M2 本機上拿到這把**私鑰**的人也能經 localhost 登入；私鑰只存在 51mini，風險很小。
- 不改 tailnet ACL、不開 Tailscale SSH。

## 步驟

```sh
sysctl -n hw.model   # 如果是 Mac16,10 就停：那台是 51mini
cp ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-20261010d
sed -i '' '/51mini->m2/s/^from="100\.96\.184\.1",/from="100.96.184.1,127.0.0.1,::1",/' ~/.ssh/authorized_keys
grep -c '51mini->m2' ~/.ssh/authorized_keys
grep '51mini->m2' ~/.ssh/authorized_keys | grep -c '^from="100.96.184.1,127.0.0.1,::1",'
```

## 驗收

- 兩個 `grep -c` 都要是 `1`。
- 51mini 端會跑 `m2ssh 'hostname; sysctl -n hw.model'` 驗證（要看到 `Mac14,2`），M2 不用做。
- 還原：`cp ~/.ssh/authorized_keys.bak-20261010d ~/.ssh/authorized_keys`。

## 禁止

- 不用 sudo、不碰 MDM／TCC、不改 tailscaled 參數、不重啟 tailscaled。
- 不 `git commit --amend`、不改寫任何既有 commit。

回報貼在 #29。
