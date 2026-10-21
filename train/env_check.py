"""T-01 environment self-check.

Prints the local toolchain state that the FaceStroke build depends on.
Writes the same report to work/reports/env_report.txt.

Run:
    .venv\\Scripts\\python.exe train\\env_check.py
"""

from __future__ import annotations

import os
import platform
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "work" / "reports" / "env_report.txt"

MODULES = [
    "numpy",
    "pandas",
    "sklearn",
    "PIL",
    "matplotlib",
    "scipy",
    "cv2",
    "mediapipe",
    "onnx",
    "onnxruntime",
    "torch",
    "torchvision",
]


def collect() -> str:
    import importlib.util

    lines: list[str] = []
    lines.append("FaceStroke environment report")
    lines.append("=" * 48)
    lines.append(f"python        : {sys.version.split()[0]}")
    lines.append(f"executable    : {sys.executable}")
    lines.append(f"platform      : {platform.platform()}")
    lines.append(f"machine       : {platform.machine()}")
    lines.append(f"cpu_count     : {os.cpu_count()}")
    lines.append("")
    lines.append("python modules")
    lines.append("-" * 48)

    missing: list[str] = []
    for name in MODULES:
        found = importlib.util.find_spec(name) is not None
        version = ""
        if found:
            try:
                mod = __import__(name)
                version = getattr(mod, "__version__", "")
            except Exception as exc:  # noqa: BLE001
                version = f"(import failed: {exc})"
        else:
            missing.append(name)
        lines.append(f"  {name:<14} {'OK ' if found else 'MISSING'} {version}")

    lines.append("")
    lines.append("torch details")
    lines.append("-" * 48)
    try:
        import torch  # noqa: PLC0415

        lines.append(f"  torch version : {torch.__version__}")
        lines.append(f"  cuda available: {torch.cuda.is_available()}")
        lines.append(f"  threads       : {torch.get_num_threads()}")
    except Exception as exc:  # noqa: BLE001
        lines.append(f"  torch not usable: {exc}")

    lines.append("")
    lines.append("summary")
    lines.append("-" * 48)
    lines.append(f"  missing modules: {', '.join(missing) if missing else 'none'}")
    lines.append("  required for v1.0 core : numpy pandas sklearn PIL matplotlib scipy cv2 mediapipe onnx onnxruntime")
    lines.append("  required for CNN stage : torch torchvision")
    return "\n".join(lines)


def main() -> int:
    text = collect()
    print(text)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(text + "\n", encoding="utf-8")
    print()
    print(f"[written] {REPORT}")

    core = ["numpy", "pandas", "sklearn", "PIL", "matplotlib", "scipy", "cv2", "mediapipe"]
    import importlib.util

    missing_core = [m for m in core if importlib.util.find_spec(m) is None]
    if missing_core:
        print(f"[FAIL] missing core modules: {missing_core}")
        return 1
    print("[OK] core modules present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
