#!/usr/bin/env python3
"""ADR-0002 Serving 的開 live 前置條件是否齊備（零 token，nightly 校準後呼叫）。

條件：白名單檔 3 天內產出、至少一族通過、shadow 列從第一筆到校準時間滿 7 天、
cascade 目前不是 live。齊備時印一行通知並 exit 0；否則 exit 1、不印。
只通知不切換：切 live 仍是人讀過後的決定（ADR-0002），且 fix 10628 曾因 live 出事。
"""
import argparse
import json
import os
import plistlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def first_shadow(path):
    with open(path, errors="replace") as f:
        for line in f:
            if '"shadow"' not in line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("shadow") is True and r.get("ts"):
                return ts(r["ts"])
    return None


def verdict(wl, shadow_start, mode, now):
    """回傳通知字串或 None。"""
    if mode == "live" or not wl.get("entries") or shadow_start is None:
        return None
    gen = ts(wl["generated"])
    if now - gen > timedelta(days=3) or gen - shadow_start < timedelta(days=7):
        return None
    fam = "、".join(f"{e['caller']}/{e['family']} lb={e['lb']} n={e['n']}" for e in wl["entries"])
    days = (gen - shadow_start).total_seconds() / 86400
    return f"🟢 Laya 白名單可評估開 live：shadow {days:.1f} 天，通過 {fam}。回 Claude「判 live」"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--whitelist", default=os.environ.get("JEV_LAYA_WHITELIST_FILE", str(HOME / ".jevgate" / "laya-whitelist.json")))
    ap.add_argument("--samples", default=os.environ.get("JEV_ROUTING_LOG", str(HOME / ".jevgate" / "routing-samples.jsonl")))
    ap.add_argument("--plist", default=str(HOME / "Library/LaunchAgents/local.jev-gate.cascade.plist"))
    a = ap.parse_args()
    try:
        wl = json.loads(Path(a.whitelist).read_text())
        mode = plistlib.loads(Path(a.plist).read_bytes()).get("EnvironmentVariables", {}).get("JEV_LAYA_WHITELIST", "")
        msg = verdict(wl, first_shadow(a.samples), mode, datetime.now(timezone.utc))
    except (OSError, ValueError, KeyError):
        return 1
    if msg:
        print(msg)
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
