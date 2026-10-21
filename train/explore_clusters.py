"""Diagnostic exploration for T-02 clustering + duplicate structure.

Temporary analysis tool. Prints:
  1. filename-number gap distribution (to choose a defensible cluster rule)
  2. duplicate-group structure (size, numbering, cross-class label conflicts)
  3. objective colourfulness per class (to test the gray-vs-colour claim)

Run: .venv\\Scripts\\python.exe train\\explore_clusters.py
"""

from __future__ import annotations

import hashlib
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

DATASET = Path(__file__).resolve().parents[1] / "datasets" / "archive" / "Annotated stroke and non stroke Dataset"
CLASSES = ("Stroke", "NonStroke")
IMG_EXT = {".jpg", ".jpeg", ".png"}


def num_of(p: Path) -> int:
    import re
    m = re.search(r"(\d+)", p.stem)
    return int(m.group(1)) if m else -1


def md5_of(p: Path) -> str:
    h = hashlib.md5()
    with p.open("rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


print("=" * 70)
print("1. FILENAME NUMBER GAP DISTRIBUTION")
print("=" * 70)
files = {}
for c in CLASSES:
    ps = sorted([p for p in (DATASET / c).iterdir() if p.suffix.lower() in IMG_EXT], key=num_of)
    files[c] = ps
    nums = np.array([num_of(p) for p in ps])
    gaps = np.diff(nums)
    qs = [50, 75, 90, 95, 99, 100]
    print(f"\n{c}: n={len(nums)}  number range {nums.min()}..{nums.max()}  span={nums.max()-nums.min()}")
    print("  gap percentiles: " + "  ".join(f"p{q}={np.percentile(gaps,q):.0f}" for q in qs))
    buckets = [(1, 1), (2, 3), (4, 10), (11, 30), (31, 100), (101, 500), (501, 10**9)]
    for lo, hi in buckets:
        cnt = int(((gaps >= lo) & (gaps <= hi)).sum())
        print(f"  gap {lo:>4}-{hi if hi < 10**9 else 'inf':>4}: {cnt:>5}  ({cnt/len(gaps)*100:5.1f}%)")

print()
print("=" * 70)
print("2. DUPLICATE STRUCTURE (MD5)")
print("=" * 70)
hashes = defaultdict(list)
for c in CLASSES:
    for p in files[c]:
        hashes[md5_of(p)].append((c, p.name))
groups = {h: v for h, v in hashes.items() if len(v) > 1}
sizes = Counter(len(v) for v in groups.values())
print(f"\ntotal unique md5: {len(hashes)}   duplicate groups: {len(groups)}")
print("group size histogram: " + ", ".join(f"size{k}={v}" for k, v in sorted(sizes.items())))
cross = [v for v in groups.values() if len({c for c, _ in v}) > 1]
print(f"groups spanning BOTH classes (label conflict): {len(cross)}")
if cross:
    for v in cross[:3]:
        print("   e.g. " + str(v[:6]))
n_extra = sum(len(v) - 1 for v in groups.values())
print(f"redundant copies: {n_extra}  ({n_extra/len(hashes)*100:.1f}% of unique)")
in_class = Counter()
for c in CLASSES:
    seen = Counter()
    for p in files[c]:
        h = md5_of(p)
        if len(hashes[h]) > 1:
            seen[h] += 1
    print(f"  {c}: files inside duplicate groups = {sum(seen.values())} / {len(files[c])}")

print()
print("=" * 70)
print("3. COLOURFULNESS (mean channel spread; 0 = perfectly gray)")
print("=" * 70)
rng = np.random.default_rng(0)
for c in CLASSES:
    ps = files[c]
    idx = rng.choice(len(ps), size=min(300, len(ps)), replace=False)
    spreads, sizes = [], []
    for i in idx:
        with Image.open(ps[i]) as im:
            a = np.asarray(im.convert("RGB"), dtype=np.int16)
            sizes.append(a.shape[:2])
            spreads.append(float((a.max(axis=2) - a.min(axis=2)).mean()))
    spreads = np.array(spreads)
    print(f"{c}: colourfulness mean={spreads.mean():.2f} median={np.median(spreads):.2f} "
          f"p10={np.percentile(spreads,10):.2f} p90={np.percentile(spreads,90):.2f}  "
          f"(n={len(spreads)})")
print()
print("interpretation: mean spread < ~2 means visually gray content stored as RGB")
