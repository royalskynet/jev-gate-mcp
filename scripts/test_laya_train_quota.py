import importlib.util
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location("lt", Path(__file__).with_name("laya-train.py"))
lt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lt)


def unit(qid, i, wrong=False, tconf=None):
    # baseline 與 truth 不同＝現役答錯（noul 差 ≥0.2）
    return {"qid": qid, "rec": i, "qtype": "choice", "external": False, "weight": 1.0,
            "truth": 0, "tconf": tconf,
            "baseline": None if not wrong else {"type": "choice", "choice": "x"},
            "question": {"type": "choice", "criteria": {"a": "", "x": ""}}}


def corpus():
    us = [unit(f"claim_{i % 3}", i, tconf=i / 400) for i in range(400)]
    us += [unit(f"route", 1000 + i) for i in range(300)]
    us += [unit(f"tier", 2000 + i) for i in range(300)]
    return us


def test_targets_get_the_budget_and_others_keep_a_floor():
    q = lt.family_quotas(corpus(), {"claim_#", "call_t#"}, 600, floor=15)
    assert q == {"route": 15, "tier": 15, "claim_#": 400}  # 570 但只有 400 筆：不超過族大小


def test_two_targets_split_evenly():
    us = corpus() + [unit(f"call_t{i}", 3000 + i) for i in range(500)]
    q = lt.family_quotas(us, {"claim_#", "call_t#"}, 600, floor=15)
    assert q["claim_#"] == q["call_t#"] == 285 and q["route"] == 15


def test_constant_families_are_dropped_but_targets_kept():
    def u(qid, i, truth, qtype="noul"):
        return {"qid": qid, "rec": i, "qtype": qtype, "external": False, "truth": truth}
    us = [u(f"result_t{i}", i, 0.1) for i in range(300)]                 # 全 <.5：固定
    us += [u(f"call_t{i}", i, 0.9 if i % 50 == 0 else 0.1) for i in range(300)]  # 2% 陽性：不算固定
    us += [u(f"claim_{i}", i, 0, "choice") for i in range(300)]          # 固定但是接手目標
    us += [u(f"tier", i, 0, "choice") for i in range(50)]                # 樣本太少
    c = lt.constant_families(us, share=0.99, min_n=200, keep={"claim_#"})
    assert set(c) == {"result_t#"} and c["result_t#"] == (1.0, 300)


def test_no_target_present_or_budget_too_small_falls_back():
    assert lt.family_quotas(corpus(), {"call_t#"}, 600) is None
    assert lt.family_quotas(corpus(), {"claim_#"}, 30, floor=15) is None
    assert lt.family_quotas(corpus(), None, 600) is None


def test_hard_weights_respects_quotas_and_picks_confident_teacher_labels():
    us = corpus()
    q = lt.family_quotas(us, {"claim_#"}, 300, floor=15)
    kept, _ = lt.hard_weights(us, cap=q, targets={"claim_#"}, easy_ratio=1.0, easy_floor=5)
    by = {}
    for u in kept:
        by.setdefault(lt._family(u["qid"]), []).append(u)
    assert len(by["route"]) <= 15 and len(by["tier"]) <= 15
    claims = by["claim_#"]
    assert 0 < len(claims) <= q["claim_#"]
    # 嚴選：留下的全是老師信心最高的那一段
    cut = sorted((u["tconf"] for u in us if u["qid"].startswith("claim_")), reverse=True)[len(claims) - 1]
    assert min(u["tconf"] for u in claims) >= cut


def test_target_families_reads_whitelist_rejected(tmp_path):
    p = tmp_path / "wl.json"
    p.write_text(json.dumps({"rejected": [{"family": "call_t#"}, {"family": "claim_#"}]}))
    assert lt.target_families("auto", p) == {"call_t#", "claim_#"}
    assert lt.target_families("off", p) is None
    assert lt.target_families("auto", tmp_path / "missing.json") is None
    assert lt.target_families("claim_#", p) == {"claim_#"}


def test_weighted_split_favours_close_and_busy_family():
    us = corpus() + [unit(f"call_t{i}", 3000 + i) for i in range(500)]
    q = lt.family_quotas(us, {"claim_#", "call_t#"}, 600, floor=15, weights={"call_t#": 3.0, "claim_#": 1.0})
    assert q["call_t#"] == 15 + 405 and q["claim_#"] == 15 + 135 and q["route"] == 15
    # 全 0（例如兩族都停滯）退回均分
    q0 = lt.family_quotas(us, {"claim_#", "call_t#"}, 600, floor=15, weights={"call_t#": 0.0, "claim_#": 0.0})
    assert q0["call_t#"] == q0["claim_#"] == 285


def test_startup_check_forces_low_memory_profile():
    from types import SimpleNamespace as NS
    a = NS(cache_dir=None, lora=False, limit=0)
    fixes, mu = lt.low_mem_fixes(a, {}, 0)
    assert a.cache_dir and "laya-hcache-auto-" in a.cache_dir and mu == 600 and len(fixes) == 3
    # 已照夜訓帶齊：不改
    a = NS(cache_dir="/x", lora=False, limit=0)
    assert lt.low_mem_fixes(a, {"PYTHONUNBUFFERED": "1"}, 600) == ([], 600) and a.cache_dir == "/x"
    # 明示例外不動快取
    for a, env in ((NS(cache_dir=None, lora=True, limit=0), {}), (NS(cache_dir=None, lora=False, limit=50), {}),
                   (NS(cache_dir=None, lora=False, limit=0), {"JEV_LAYA_RAM_CACHE": "1"})):
        lt.low_mem_fixes(a, env, 600)
        assert a.cache_dir is None
    # 預設值＝夜訓值
    assert lt.MAX_PER_QID == 150 or "JEV_LAYA_MAX_PER_QID" in __import__("os").environ


def test_footprint_restart_halves_once_then_gives_up():
    env = lt.restart_argv_env({}, 600, "/h/laya-hcache-auto-1")
    assert env["JEV_LAYA_MAX_UNITS"] == "300" and env["JEV_LAYA_RESTARTS"] == "1"
    assert env["JEV_LAYA_AUTO_HCACHE"] == "/h/laya-hcache-auto-1"
    assert lt.restart_argv_env({}, 200, "/nightly/hcache")["JEV_LAYA_MAX_UNITS"] == "150"
    assert "JEV_LAYA_AUTO_HCACHE" not in lt.restart_argv_env({}, 600, "/nightly/hcache")
    assert lt.restart_argv_env(env, 300, None) is None


def test_watch_kills_restarts_then_exits_loud(tmp_path):
    import os
    import subprocess
    import sys
    # 寫成檔案跑：execve 重啟用的是 sys.argv，python -c 會把程式碼弄丟
    script = tmp_path / "w.py"
    script.write_text("import importlib.util,time,sys;s=importlib.util.spec_from_file_location('lt',sys.argv[1]);"
                      "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                      "m.start_footprint_watch(600,None,limit_gb=0.001,every=0.05);time.sleep(10)")
    env = {k: v for k, v in os.environ.items() if not k.startswith("JEV_LAYA_")}
    p = subprocess.run([sys.executable, str(script), str(Path(__file__).with_name("laya-train.py"))],
                       env=env, capture_output=True, text=True, timeout=30)
    assert p.returncode == lt.EX_FOOTPRINT, p.stderr
    assert "總量 600→300 重啟" in p.stderr and "已重啟 1 次仍超量" in p.stderr, p.stderr


def test_phys_footprint_reads_own_process():
    fp = lt.phys_footprint()
    assert fp is not None and 1 << 20 < fp < 64 << 30


def test_target_weights_requests_over_gap_and_stalled_zero(tmp_path):
    p = tmp_path / "wl.json"
    p.write_text(json.dumps({"alpha": 0.1, "stalled": ["x_#"], "rejected": [
        {"family": "call_t#", "requests": 1, "lb": 0.5},
        {"family": "call_t#", "requests": 111, "lb": 0.8565},
        {"family": "claim_#", "requests": 52, "lb": 0.4252},
        {"family": "x_#", "requests": 99, "lb": 0.7},
        {"family": "y_#", "requests": 10, "lb": None}]}))
    w = lt.target_weights(p)
    assert abs(w["call_t#"] - 112 / (0.9 - 0.8565)) < 1e-6, w   # 同族合併：requests 加總、lb 取最多那筆
    assert abs(w["claim_#"] - 52 / (0.9 - 0.4252)) < 1e-6, w
    assert w["x_#"] == 0.0 and abs(w["y_#"] - 20.0) < 1e-6, w
    assert w["call_t#"] > 20 * w["claim_#"]
    assert lt.target_weights(tmp_path / "missing.json") is None


def test_target_weights_gap_measured_to_constant(tmp_path):
    # 10-20：lb 0.93 已過 0.90，但常數 0.971 → 差距量到常數（0.041），不是 0.02 地板；常數 1.0 永遠過不了 → 0。
    p = tmp_path / "wl.json"
    p.write_text(json.dumps({"alpha": 0.1, "rejected": [
        {"family": "call_t#", "requests": 143, "lb": 0.93, "constant": 0.971},
        {"family": "amb", "requests": 58, "lb": 0.5435, "constant": 0.6034},
        {"family": "result_t#", "requests": 146, "lb": 0.9963, "constant": 1.0}]}))
    w = lt.target_weights(p)
    assert abs(w["call_t#"] - 143 / (0.971 - 0.93)) < 1e-6, w
    assert abs(w["amb"] - 58 / (0.9 - 0.5435)) < 1e-6, w
    assert w["result_t#"] == 0.0, w


def test_target_weights_constant_reason_gets_floor_only(tmp_path):
    # 10-20 試算：wrong_reading_costly lb .963／常數 .989 → requests÷0.026 吸走名額。判 constant 的族只留底量。
    p = tmp_path / "wl.json"
    p.write_text(json.dumps({"alpha": 0.1, "rejected": [
        {"family": "wrc", "requests": 436, "lb": 0.9625, "constant": 0.989, "reason": "constant"},
        {"family": "tier", "requests": 52, "lb": 0.4975, "constant": 0.6, "reason": "lb"}]}))
    w = lt.target_weights(p)
    assert w["wrc"] == 0.0, w
    assert abs(w["tier"] - 52 / (0.9 - 0.4975)) < 1e-6, w


def test_sweep_removes_only_dead_auto_caches(tmp_path):
    import subprocess
    p = subprocess.Popen(["true"]); p.wait()          # 已結束的 pid
    dead, alive = tmp_path / f"laya-hcache-auto-{p.pid}", tmp_path / f"laya-hcache-auto-{os.getpid()}"
    other = tmp_path / "laya-hcache-auto-x"
    for d in (dead, alive, other):
        d.mkdir()
    assert lt.sweep_dead_auto_caches(tmp_path) == [dead]
    assert not dead.exists() and alive.exists() and other.exists()
