import importlib.util
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location("lr", Path(__file__).with_name("laya-live-ready.py"))
lr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lr)

E = [{"caller": "cascade:compact", "family": "result_t#", "lb": 0.9268, "n": 545}]
START = datetime(2026, 10, 13, 8, 5, tzinfo=timezone.utc)
NOW = datetime(2026, 10, 21, 0, 0, tzinfo=timezone.utc)


def wl(gen, entries=E):
    return {"generated": gen, "entries": entries}


def test_ready_after_7_days():
    assert "result_t#" in lr.verdict(wl("2026-10-20T20:22:14Z"), START, "shadow", NOW)


def test_not_ready_at_6_5_days():
    assert lr.verdict(wl("2026-10-19T20:22:14Z"), START, "shadow", NOW) is None


def test_silent_when_live_empty_or_stale():
    assert lr.verdict(wl("2026-10-20T20:22:14Z"), START, "live", NOW) is None
    assert lr.verdict(wl("2026-10-20T20:22:14Z", []), START, "shadow", NOW) is None
    assert lr.verdict(wl("2026-10-17T20:22:14Z"), START, "shadow", NOW) is None


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
