"""m2v_embed 必須在子行程載 model2vec：同行程載入約 2GB，del＋gc 也不還 OS，
會留到 encoder 快取階段疊成峰值（10-21 實測 6.7GB、夜訓 10-20 8.1GB）。
跑法：HF_HUB_OFFLINE=1 ~/.jevgate/train-venv/bin/python scripts/test_laya_m2v_memory.py（約 20s，要模型已在快取）"""
import importlib.util
import os
import resource
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("lt", Path(__file__).with_name("laya-train.py"))
lt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lt)

tree_file = Path(tempfile.mkdtemp()) / "tree"
os.environ["JEV_LAYA_TREE_PEAK_FILE"] = str(tree_file)
before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # macOS 單位 bytes
emb = lt.m2v_embed([f'{{"state": "第 {i} 筆 request {i * 7}"}}' for i in range(200)])
peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
assert emb.shape[0] == 200 and emb.shape[1] > 0, emb.shape
grew_mb = (peak - before) / 2**20
assert grew_mb < 500, f"m2v_embed 讓本行程峰值 RSS 漲 {grew_mb:.0f}MB：模型載進父行程了"
# 夜訓 /usr/bin/time 只量父行程；子行程的量必須寫進 tree 檔，否則峰值告警看不到子行程（fix 11166）
tree_mb = int(tree_file.read_text()) if tree_file.exists() else 0
assert tree_mb >= 1000, f"父＋子峰值只記到 {tree_mb}MB：子行程 footprint 沒入帳"
print(f"PASS（父＋子峰值 {tree_mb}MB，父行程峰值 RSS +{grew_mb:.0f}MB，dim={emb.shape[1]}）")
