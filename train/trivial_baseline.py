"""T-03 rehearsal: trivial (non-pathological) baseline test.

Purpose
-------
If a classifier that never looks at facial structure -- only at colour,
brightness and sharpness statistics -- can separate "Stroke" from "NonStroke"
with high AUC, then the dataset's labels are explained by acquisition domain,
not by pathology. That single number decides whether a trained CNN on this data
can mean anything.

It runs the same experiment twice:
  colour features   (what a colour CNN could exploit)
  grayscale features (what survives after removing colour)

Run: .venv\\Scripts\\python.exe train\\trivial_baseline.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

sys.stdout.reconfigure(encoding="utf-8")

APP = Path(__file__).resolve().parents[1]
CLEAN = APP / "work" / "cleaned"
SPLITS = APP / "work" / "reports" / "splits"
REPORTS = APP / "work" / "reports"
CLASSES = ("Stroke", "NonStroke")
LABEL = {"Stroke": 0, "NonStroke": 1}
WORK = 64


def load_list(part: str, cname: str) -> list[str]:
    p = SPLITS / f"{part}_{cname}.txt"
    if not p.exists():
        return []
    return [line.strip() for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]


def features(path: Path, colour: bool) -> np.ndarray | None:
    try:
        with Image.open(path) as im:
            im = im.convert("RGB" if colour else "L")
            small = im.resize((WORK, WORK), Image.BILINEAR)
            a = np.asarray(small, dtype=np.float32)
    except Exception:  # noqa: BLE001
        return None

    if colour:
        spread = float((a.max(axis=2) - a.min(axis=2)).mean())
        hist = []
        for ch in range(3):
            h, _ = np.histogram(a[:, :, ch], bins=16, range=(0, 255), density=True)
            hist.extend(h.tolist())
        gray = a.mean(axis=2)
    else:
        spread = 0.0
        hist = []
        h, _ = np.histogram(a, bins=32, range=(0, 255), density=True)
        hist.extend(h.tolist())
        gray = a

    gx = np.abs(np.diff(gray, axis=1)).mean()
    gy = np.abs(np.diff(gray, axis=0)).mean()
    return np.array([spread, gray.mean(), gray.std(), gx, gy, float(np.percentile(gray, 5)),
                     float(np.percentile(gray, 95))] + hist, dtype=np.float32)


def build(colour: bool) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    sub = "faces" if colour else "gray"
    Xtr, ytr, Xva, yva, Xte, yte = [], [], [], [], [], []
    for cname in CLASSES:
        for part, X, y in (("train", Xtr, ytr), ("val", Xva, yva), ("test", Xte, yte)):
            for f in load_list(part, cname):
                p = CLEAN / sub / cname / f
                if not p.exists():
                    continue
                v = features(p, colour)
                if v is None:
                    continue
                X.append(v)
                y.append(LABEL[cname])
    return (np.array(Xtr), np.array(ytr), np.array(Xva), np.array(yva), np.array(Xte), np.array(yte))


def run(colour: bool) -> dict:
    Xtr, ytr, Xva, yva, Xte, yte = build(colour)
    if len(Xtr) == 0:
        return {"error": "no data"}
    pipe = Pipeline([("sc", StandardScaler()),
                     ("lr", LogisticRegression(max_iter=2000, class_weight="balanced"))])
    pipe.fit(Xtr, ytr)
    out = {"n_train": int(len(ytr)), "n_val": int(len(yva)), "n_test": int(len(yte))}
    for name, X, y in (("train", Xtr, ytr), ("val", Xva, yva), ("test", Xte, yte)):
        if len(y) and len(set(y.tolist())) > 1:
            prob = pipe.predict_proba(X)[:, 1]
            out[f"auc_{name}"] = float(roc_auc_score(y, prob))
    return out


def main() -> int:
    print("=" * 68)
    print("TRIVIAL BASELINE -- can non-pathological features separate the classes?")
    print("=" * 68)
    print("(features: colourfulness / brightness / sharpness / colour histograms)")
    print("(model: logistic regression, cluster-level split, no image structure)")
    print()

    res = {}
    for tag, colour in (("COLOUR features", True), ("GRAYSCALE features", False)):
        r = run(colour)
        res[tag] = r
        print(f"{tag}")
        for k, v in r.items():
            print(f"   {k:<12} {v if isinstance(v, str) else round(v, 4)}")
        print()

    print("-" * 68)
    a = res.get("COLOUR features", {})
    b = res.get("GRAYSCALE features", {})
    ca, cb = a.get("auc_test"), b.get("auc_test")
    if ca is not None:
        print(f"colour-only  test AUC = {ca:.3f}")
    if cb is not None:
        print(f"gray-only    test AUC = {cb:.3f}")
    print()
    print("interpretation")
    print("  0.50-0.60  -> no trivial shortcut; dataset labels are not explained by acquisition")
    print("  0.60-0.75  -> partial shortcut present; CNN results need heavy caveats")
    print("  0.75-1.00  -> dominant shortcut; this dataset cannot support a valid stroke model")
    print()

    (REPORTS / "trivial_baseline.json").write_text(
        json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[written] {REPORTS / 'trivial_baseline.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
