"""Emit web/src/core/mirror_pairs.js from the audit JSON.

Why: symmetry.js must import the pair table in BOTH the browser (Vite) and Node
(the unit test). Node requires an import attribute for JSON modules, Vite does
not, so a plain generated .js module keeps one file working in both places.

Run: .venv\\Scripts\\python.exe train\\emit_mirror_pairs_js.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

APP = Path(__file__).resolve().parents[1]
SRC = APP / "work" / "reports" / "mirror_pairs.json"
DST = APP / "web" / "src" / "core" / "mirror_pairs.js"


def main() -> int:
    d = json.loads(SRC.read_text(encoding="utf-8"))
    slim = {
        "anchors": d["anchors"],
        "axis": d["axis"],
        "pairs": d["pairs"],
        "pairs_flat": d["pairs_flat"],
        "zone_stats": d["zone_stats"],
        "derived_from": d["derived_from"],
    }
    body = json.dumps(slim, ensure_ascii=False, separators=(",", ":"))
    text = (
        "// AUTO-GENERATED FILE - DO NOT EDIT BY HAND.\n"
        "// Source: work/reports/mirror_pairs.json\n"
        "// Producer: train/derive_mirror_pairs.py\n"
        "// Regenerate: .venv\\Scripts\\python.exe train\\emit_mirror_pairs_js.py\n"
        "//\n"
        "// The mirror-pair table was DERIVED from data (reflect each template\n"
        "// landmark across the canonical midline, keep mutual nearest neighbours),\n"
        "// not guessed from index arithmetic. See work/reports/symmetry_calibration.md\n"
        "\n"
        f"export default {body};\n"
    )
    DST.write_text(text, encoding="utf-8")
    print(f"[written] {DST}  ({len(text)} bytes, {len(slim['pairs_flat'])} pairs)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
