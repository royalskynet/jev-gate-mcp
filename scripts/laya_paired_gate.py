#!/usr/bin/env python3
"""夜訓上線閘：現役 bundle 與新版在同一批題上的配對比較。

舊閘拿新版當晚的 live_gated 準確率去比 champion 檔裡的舊數字。那個數字是
10-02 在 186 題上量的、之後不再重算，而新版是在當晚更大的題庫（~338 題）上量，
兩個準確率不同母體，從 10-02 起每晚都把新版判成退步。

這裡改成同卷：兩個 bundle 都由 laya-eval-onnx.py --gate-dump 在同一份 corpus 上
逐題跑一次，每題記下「線上會不會本機答（routed）」與「答對沒（correct）」。
一題算某模型的錯，當且僅當它會被本機答、而且答錯——沒被本機答的題送雲端，
不算任何一方的錯。比較的是兩方本機答錯的題，以聯集為母體。

為什麼用 McNemar 精確檢定而不是「準確率差 > TOL」：配對二元結果只有不一致的題
（一方錯、另一方沒錯）帶資訊。準確率接近 1.0、n≈300 時，一題就是 0.3pp，固定
TOL=1pp 等於三、四題的雜訊就擋。McNemar 只看不一致的題數 b（新版錯、現役沒錯）
與 c（反之），在「兩者一樣好」的虛無假設下 b ~ Binomial(b+c, 0.5)，p 值有明確意義。
只在新版錯得較多（b > c）且雙尾 p < ALPHA 時擋。

ponytail: 兩個上限，夠用就不加：
  1. 新版是在全部 corpus 上訓出來的，同卷評估對它是 in-sample，偏樂觀；現役只看過
     舊資料。所以這道閘對新版偏寬鬆（10-11 起 nightly 已拿掉 OOF 地板，接手安全改由
     服務端每題 confMin＋CP 錯誤預算守）。要更嚴就改成只拿現役上線之後才進來的題（兩方都沒
     訓過不可能——新版訓過全部），或在訓練端留一個 holdout 切片。
  2. 只數錯題數，不正規化本機接手量。新版若信心較高、本機接手更多題，同錯誤率下
     絕對錯題數會較多，可能被擋。要區分就改比「每接手一題的錯誤率」配對版。

  laya_paired_gate.py CHAMP.jsonl CAND.jsonl   # 印出 JSON 判決
  laya_paired_gate.py --selftest
"""
import json
import math
import sys

ALPHA = 0.05


def mcnemar_exact_p(b, c):
    """McNemar 精確檢定雙尾 p 值：b+c 個不一致題中，較少的一側 ≤ min(b,c) 的機率 ×2。"""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def lane(rows):
    """一個模型在自己會本機答的那批題上的 n 與準確率。"""
    routed = [r for r in rows if r["routed"]]
    acc = sum(1 for r in routed if r["correct"]) / len(routed) if routed else None
    return {"n": len(routed), "accuracy": acc}


def paired_gate(champ_rows, cand_rows, alpha=ALPHA):
    """同卷配對判決。rows：[{key, routed, correct}]，兩邊用 key 對齊。

    現役沒有任何評估列（沒有現役 bundle）＝無從配對，放行，只回報新版數字。
    """
    cand_only = lane(cand_rows)
    if not champ_rows:
        return {"ship": True, "paired": False, "candidate": cand_only, "champion": None,
                "b": 0, "c": 0, "p": 1.0, "n_common": 0}
    champ = {r["key"]: r for r in champ_rows}
    cand = {r["key"]: r for r in cand_rows}
    common = sorted(champ.keys() & cand.keys())
    err = lambda r: bool(r["routed"]) and not r["correct"]
    b = sum(1 for k in common if err(cand[k]) and not err(champ[k]))
    c = sum(1 for k in common if err(champ[k]) and not err(cand[k]))
    p = mcnemar_exact_p(b, c)
    return {
        "ship": not (b > c and p < alpha),
        "paired": True,
        "candidate": lane([cand[k] for k in common]),
        "champion": lane([champ[k] for k in common]),
        "b": b, "c": c, "p": round(p, 4), "n_common": len(common),
    }


def _rows(n_ok, n_wrong, n_cloud=0, prefix="q"):
    out, i = [], 0
    for routed, correct, count in ((True, True, n_ok), (True, False, n_wrong), (False, False, n_cloud)):
        for _ in range(count):
            out.append({"key": f"{prefix}{i}", "routed": routed, "correct": correct})
            i += 1
    return out


def selftest():
    assert mcnemar_exact_p(0, 0) == 1.0
    assert abs(mcnemar_exact_p(6, 0) - 0.03125) < 1e-12
    assert abs(mcnemar_exact_p(4, 2) - 0.6875) < 1e-12

    # 同卷 現役 0.988 vs 新版 0.982（n=338）：新版多錯 4 題、少錯 2 題 → 不顯著 → 放行。
    champ = _rows(338, 0)
    cand = _rows(338, 0)
    for i in range(4):          # 新版錯、現役對
        cand[i]["correct"] = False
    for i in range(4, 6):       # 兩方都錯
        cand[i]["correct"] = champ[i]["correct"] = False
    for i in range(6, 8):       # 現役錯、新版對
        champ[i]["correct"] = False
    v = paired_gate(champ, cand)
    assert v["ship"] and (v["b"], v["c"]) == (4, 2), v
    assert round(v["candidate"]["accuracy"], 3) == 0.982 and v["candidate"]["n"] == 338, v
    assert round(v["champion"]["accuracy"], 3) == 0.988, v

    # 明顯退步：新版多錯 12 題、現役多錯 1 題 → p≈0.003 → 擋。
    champ, cand = _rows(338, 0), _rows(338, 0)
    for i in range(12):
        cand[i]["correct"] = False
    champ[20]["correct"] = False
    v = paired_gate(champ, cand)
    assert not v["ship"] and v["p"] < ALPHA, v

    # 新版比較好（錯得少）即使顯著也放行——這是單方向的退步閘。
    v = paired_gate(_rows(326, 12), _rows(338, 0))
    assert v["ship"] and v["b"] == 0 and v["c"] == 12, v

    # 只有新版會本機答錯、但現役那題本來送雲端：仍算新版的錯（線上真的會多答錯一題）。
    champ = _rows(0, 0, n_cloud=10)
    cand = _rows(4, 6)
    assert paired_gate(champ, cand)["b"] == 6

    # 沒有現役 bundle：無從配對，放行並回報新版自己的數字。
    v = paired_gate([], _rows(9, 1))
    assert v["ship"] and not v["paired"] and v["candidate"] == {"n": 10, "accuracy": 0.9}, v
    print("selftest ok")


def load(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def main(argv):
    if argv[1:] == ["--selftest"]:
        selftest()
        return 0
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    print(json.dumps(paired_gate(load(argv[1]), load(argv[2]))))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
