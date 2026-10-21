"""T-17: build the bad-image regression set for G4.

Why raw pixels instead of JPEGs: the JS quality gate is the thing under test, and
Node has no image decoder. We therefore export raw RGBA plus the landmark arrays,
so the Node test can run the REAL gate functions (luminanceStats,
laplacianVariance, yawProxyOf, faceWidthRatioOf, mouthFlatnessRatio, assessFrame)
on real pixel data.

A CONTROL GROUP of clean frames is included on purpose: without it, "100% of bad
images rejected" could be satisfied by a gate that rejects everything.

Outputs
-------
work/badset/{good,dark,bright,blurry,occluded,turned,far,noface,multi}/NN.rgba
work/badset/manifest.json

Run: .venv\\Scripts\\python.exe train\\build_badset.py
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))

sys.stdout.reconfigure(encoding="utf-8")

APP = Path(__file__).resolve().parents[1]
FACES = APP / "work" / "cleaned" / "faces"
SPLITS = APP / "work" / "reports" / "splits"
OUT = APP / "work" / "badset"
TASK = APP / "web" / "public" / "mediapipe" / "face_landmarker.task"

W, H = 320, 240          # matches the analysis canvas in s5_capture.js
PER_KIND = 8
SEED = 42

IDX_MOUTH = [61, 291, 13, 14, 78, 308]
IDX_EYE_R_OUTER = 33
IDX_EYE_L_OUTER = 263
IDX_NOSE_TIP = 1
# the control group must represent what the app asks the user for: a frontal
# pose. Without this filter the controls include near-profile web photos and the
# yaw gate becomes untestable (measured: control yaw reached 0.297).
MAX_BASE_YAW = 0.08


def yaw_proxy(lm: list) -> float:
    """Same definition as web/src/core/quality.js yawProxyOf()."""
    r, l, n = lm[IDX_EYE_R_OUTER], lm[IDX_EYE_L_OUTER], lm[IDX_NOSE_TIP]
    eye = ((l[0] - r[0]) ** 2 + (l[1] - r[1]) ** 2) ** 0.5
    if eye < 1e-6:
        return float("inf")
    dl = ((n[0] - r[0]) ** 2 + (n[1] - r[1]) ** 2) ** 0.5
    dr = ((n[0] - l[0]) ** 2 + (n[1] - l[1]) ** 2) ** 0.5
    return abs(dl - dr) / eye


def clean_faces(n: int) -> list[Path]:
    out: list[Path] = []
    for cname in ("NonStroke", "Stroke"):
        f = SPLITS / f"test_{cname}.txt"
        if not f.exists():
            continue
        for name in f.read_text(encoding="utf-8").splitlines():
            name = name.strip()
            if name and (FACES / cname / name).exists():
                out.append(FACES / cname / name)
    random.Random(SEED).shuffle(out)
    return out[:n]


def to_rgba(img: Image.Image) -> bytes:
    a = np.asarray(img.convert("RGB").resize((W, H), Image.BILINEAR), dtype=np.uint8)
    rgba = np.dstack([a, np.full(a.shape[:2], 255, dtype=np.uint8)])
    return rgba.tobytes()


def write_case(kind: str, i: int, raw: bytes, landmarks: list | None, notes: str) -> dict:
    d = OUT / kind
    d.mkdir(parents=True, exist_ok=True)
    rel = f"{kind}/{i:02d}"
    (OUT / f"{rel}.rgba").write_bytes(raw)
    entry = {"id": rel, "kind": kind, "file": f"{rel}.rgba", "w": W, "h": H, "note": notes}
    if landmarks is not None:
        lp = OUT / f"{rel}.landmarks.json"
        lp.write_text(json.dumps(landmarks), encoding="utf-8")
        entry["landmarks"] = f"{rel}.landmarks.json"
    return entry


def detect(landmarker, mp, path: Path) -> list | None:
    res = landmarker.detect(mp.Image.create_from_file(str(path)))
    if not res.face_landmarks:
        return None
    pts = res.face_landmarks[0]
    if len(pts) < 478:
        return None
    return [[float(p.x), float(p.y), float(p.z)] for p in pts]


def main() -> int:
    if OUT.exists():
        for p in OUT.rglob("*"):
            if p.is_file():
                p.unlink()

    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    landmarker = vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(TASK)),
            output_face_blendshapes=False,
            output_facial_transformation_matrixes=False,
            num_faces=1,
            running_mode=vision.RunningMode.IMAGE,
        )
    )

    faces = clean_faces(PER_KIND * 3)
    manifest: list[dict] = []
    rng = np.random.default_rng(SEED)

    used = 0
    for fp in faces:
        if used >= PER_KIND:
            break
        lm = detect(landmarker, mp, fp)
        if lm is None:
            continue
        if yaw_proxy(lm) >= MAX_BASE_YAW:
            continue  # keep the control group genuinely frontal
        with Image.open(fp) as im:
            base = im.convert("RGB").resize((W, H), Image.BILINEAR)
        arr = np.asarray(base).astype(np.float32)
        used += 1
        i = used - 1

        # ---- control: a clean frame must PASS the gate -----------------------
        manifest.append(write_case("good", i, to_rgba(base), lm, "clean frame, must pass"))

        # ---- pixel-only degradations ----------------------------------------
        manifest.append(write_case("dark", i, to_rgba(Image.fromarray(
            np.clip(arr * 0.22, 0, 255).astype(np.uint8))), lm, "gain 0.22"))
        manifest.append(write_case("bright", i, to_rgba(Image.fromarray(
            np.clip(arr * 2.6, 0, 255).astype(np.uint8))), lm, "gain 2.6"))
        manifest.append(write_case("blurry", i, to_rgba(base.filter(ImageFilter.GaussianBlur(6.0))), lm, "gaussian sigma 6"))

        # ---- landmark-driven: turned (nose pushed sideways) ------------------
        turned = [list(p) for p in lm]
        tip = turned[1]
        tip[0] = min(0.98, tip[0] + 0.10)
        manifest.append(write_case("turned", i, to_rgba(base), turned, "nose shifted 0.10 -> yaw proxy"))

        # ---- landmark-driven: too far (landmarks scaled toward the centre) ---
        far = [[0.5 + (p[0] - 0.5) * 0.45, 0.5 + (p[1] - 0.5) * 0.45, p[2]] for p in lm]
        manifest.append(write_case("far", i, to_rgba(base), far, "landmarks scaled 0.45 -> small face"))

        # ---- landmark-driven: occlusion (rectangle over the mouth region) ----
        occl = base.copy()
        dr = ImageDraw.Draw(occl)
        xs = [lm[k][0] * W for k in IDX_MOUTH]
        ys = [lm[k][1] * H for k in IDX_MOUTH]
        dr.rectangle([min(xs) - 14, min(ys) - 10, max(xs) + 14, max(ys) + 12], fill=(235, 238, 241))
        manifest.append(write_case("occluded", i, to_rgba(occl), lm, "flat rectangle over the mouth"))

        # ---- no face / multiple faces ---------------------------------------
        manifest.append(write_case("noface", i, to_rgba(base), [], "no landmarks detected"))
        manifest.append(write_case("multi", i, to_rgba(base), lm, "two faces in frame (faceCount=2)"))

    (OUT / "manifest.json").write_text(json.dumps({
        "generated": "train/build_badset.py",
        "width": W, "height": H, "per_kind": PER_KIND,
        "cases": manifest,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    kinds: dict[str, int] = {}
    for c in manifest:
        kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
    print(f"base faces used: {used}")
    print("cases per kind:", kinds)
    print(f"[written] {OUT / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
