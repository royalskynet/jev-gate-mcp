"""Laya 的逐題 state 裁切，鏡像 gateway/src/laya-state.js。

線上 runChunked 把 compact 的 call_tN／result_tN 題改餵裁過的 state；訓練、評估、導出
若還吃整段 state，學到的就是線上永遠不會送進來的輸入。兩邊由
tests/fixtures/laya-crop-golden.json 釘成同一份輸出，改一邊另一邊的測試就會 fail。
"""
import re

# input：被問的那個 call；other_input：其餘保留的 call。依真實 compact 流量調到塞得進 1024 token（fix 10649）
CROP = {"goal": 200, "text": 200, "input": 200, "other_input": 60, "near": 2, "tail": 3}

_TOOL_QID = re.compile(r"^(?:call|result)_(t\d+)$")


def _cut(s, n):
    # JS 的 String.length 是 UTF-16 單位；emoji 等 BMP 外字元兩邊會差一格
    # ponytail: 目前 golden 不含 BMP 外字元。要完全一致就改成兩邊都按 code point 切。
    return s[:n] + "…" if isinstance(s, str) and len(s) > n else s


def _call_id(c):
    # fast-jev state.js 的 compact 層把 call 寫成一行 "t12 Bash command=… → ok 340ch"
    if isinstance(c, str):
        return c.split(" ", 1)[0]
    return c.get("id") if isinstance(c, dict) else None


def crop_key(state, qid):
    m = _TOOL_QID.match(qid)
    if not m or not isinstance(state, dict) or not isinstance(state.get("history"), list):
        return None
    return m.group(1)


def _slim(entry, keep_id):
    out = {"i": entry.get("i"), "role": entry.get("role"), "text": _cut(entry.get("text") or "", CROP["text"])}
    calls = entry.get("tool_calls")
    if isinstance(calls, list):
        if keep_id:
            calls = [c for c in calls if _call_id(c) == keep_id]
        n = CROP["input"] if keep_id else CROP["other_input"]
        out["tool_calls"] = [_cut(c, n) if isinstance(c, str) else
                             {"id": c.get("id"), "tool": c.get("tool"),
                              "input": _cut(c.get("input") or "", n), "result": c.get("result")}
                             for c in calls]
    return out


def crop_state(state, tool_id):
    h = state["history"]
    at = next((j for j, e in enumerate(h)
               if isinstance(e.get("tool_calls"), list) and any(_call_id(c) == tool_id for c in e["tool_calls"])), -1)
    if at == -1:
        return state
    keep = set(range(max(0, at - CROP["near"]), min(len(h) - 1, at + CROP["near"]) + 1))
    keep |= set(range(max(0, len(h) - CROP["tail"]), len(h)))
    history, prev = [], -1
    for j in sorted(keep):
        if j > prev + 1:
            history.append({"omitted": j - prev - 1})
        history.append(_slim(h[j], tool_id if j == at else None))
        prev = j
    if prev < len(h) - 1:
        history.append({"omitted": len(h) - 1 - prev})
    out = {**state, "history": history}
    if isinstance(state.get("goal"), str):
        out["goal"] = _cut(state["goal"], CROP["goal"])
    return out


def laya_state(state, qid):
    """這一題 Laya 該看到的 state（不可裁的題原樣回傳）。"""
    key = crop_key(state, qid)
    return crop_state(state, key) if key else state
