"""Canonical Python implementation of the geometric channel.

Single source of truth for Python-side geometry, imported by the synthetic
dataset builder. It deliberately REUSES the already-validated functions from
derive_mirror_pairs.py instead of re-implementing them: duplicated geometry code
is exactly what produced a false test failure earlier in this project.

Must stay numerically identical to web/src/core/symmetry.js (verified by
web/tests/symmetry.test.js cross-validation against the fixture).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

# allow `import geometry` when running other scripts from the train/ directory
sys.path.insert(0, str(Path(__file__).resolve().parent))

from derive_mirror_pairs import (  # noqa: E402
    IDX, align, mirror_pt, asymmetry, load_landmarker,  # noqa: F401
)

APP = Path(__file__).resolve().parents[1]
REPORTS = APP / "work" / "reports"
ZONE_NAMES = ("forehead", "eyelid", "nasolabial", "mouth")


def load_pair_table(path: Path | None = None) -> dict:
    p = path or (REPORTS / "mirror_pairs.json")
    return json.loads(p.read_text(encoding="utf-8"))


def pairs_with_zone(table: dict) -> list[tuple[int, int, str]]:
    out: list[tuple[int, int, str]] = []
    for zone, plist in table["pairs"].items():
        for i, j in plist:
            out.append((int(i), int(j), zone))
    return out


def calibration(table: dict) -> tuple[float, float]:
    ov = table["zone_stats"]["_overall"]
    return float(ov["p50"]), float(ov["p99"])


def score_from_asymmetry(a: float, a_ref: float, a_max: float) -> float:
    if a is None or not np.isfinite(a) or a_max <= a_ref:
        return float("nan")
    t = (a - a_ref) / (a_max - a_ref)
    return round((1.0 - min(1.0, max(0.0, t))) * 100.0, 1)


def measure(pts: np.ndarray, table: dict, pwz: list[tuple[int, int, str]],
            a_ref: float, a_max: float) -> dict | None:
    """Full geometric measurement for one landmark array."""
    xy = align(pts)
    if xy is None:
        return None
    axis = table["axis"]
    a_pt, b_pt = xy[axis[0]], xy[axis[1]]
    zones = asymmetry(xy, pwz, a_pt, b_pt)
    vals = [zones[z] for z in ZONE_NAMES if z in zones]
    if not vals:
        return None
    a_val = float(np.mean(vals))
    return {
        "a": a_val,
        "zones": {k: float(v) for k, v in zones.items()},
        "score": score_from_asymmetry(a_val, a_ref, a_max),
    }
