"""T-06 (part 1): build the synthetic training set for M-Q and M-S.

DATA SOURCE DECISION (2026-10-01, on the user's instruction)
------------------------------------------------------------
We now use the Stroke/NonStroke photos as BASE IMAGES only.

The class labels are DISCARDED and never enter the synthetic dataset. That is
what makes this legitimate: the earlier audit proved those labels are explained
by acquisition domain (a logistic regression on colour/brightness/sharpness -
no facial structure at all - reached test AUC 0.993), so they cannot support a
disease classifier. But M-Q and M-S need no disease labels: their labels are
CREATED by the degradation and the warp we apply.

Outputs
-------
work/synth/quality/{ok,too_dark,too_bright,blurry,occluded,turned}/{part}/*.jpg
work/synth/symmetry/{part}/*.jpg
work/synth/manifests/quality_{part}.csv     path,label
work/synth/manifests/symmetry_{part}.csv    path,score,region,amplitude,base
work/reports/synth_dataset_report.md

Run: .venv\\Scripts\\python.exe train\\build_synthetic_dataset.py
"""

from __future__ import annotations

import csv
import json
import random
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from geometry import (  # noqa: E402
    load_pair_table, pairs_with_zone, calibration, measure, load_landmarker,
)

sys.stdout.reconfigure(encoding="utf-8")

APP = Path(__file__).resolve().parents[1]
FACES = APP / "work" / "cleaned" / "faces"
SPLITS = APP / "work" / "reports" / "splits"
OUT = APP / "work" / "synth"
REPORTS = APP / "work" / "reports"
TASK = APP / "web" / "public" / "mediapipe" / "face_landmarker.task"

SEED = 42
BASE_PER_SPLIT = {"train": 240, "val": 60, "test": 60}
QUALITY_CLASSES = ["ok", "too_dark", "too_bright", "blurry", "occluded", "turned"]
SYMMETRY_PER_BASE = 4
REGIONS = ["mouth", "eyelid", "nasolabial", "forehead", "all"]

# region landmark indices (MediaPipe canonical)
REGION_IDX = {
    "mouth": [61, 291, 13, 14, 78, 308],
    "eyelid": [33, 263, 133, 362, 159, 386],
    "nasolabial": [129, 358, 205, 425, 50, 280],
    "forehead": [70, 300, 105, 334, 107, 336],
    "all": [61, 291, 33, 263, 129, 358, 70, 300],
}


# ------------------------------------------------------------------ helpers
def base_images(part: str) -> list[Path]:
    """Pool both classes' images for a split. Labels are intentionally dropped."""
    out: list[Path] = []
    for cname in ("Stroke", "NonStroke"):
        f = SPLITS / f"{part}_{cname}.txt"
        if not f.exists():
            continue
        for name in f.read_text(encoding="utf-8").splitlines():
            name = name.strip()
            if not name:
                continue
            p = FACES / cname / name
            if p.exists():
                out.append(p)
    return out


def to_np(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("RGB"), dtype=np.uint8)


def save_jpg(arr: np.ndarray, path: Path, quality: int = 92) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr).save(path, quality=quality)


# ------------------------------------------------------------- M-Q variants
def make_quality_variant(img: Image.Image, kind: str, rng: random.Random) -> Image.Image:
    a = to_np(img).astype(np.float32)

    if kind == "ok":
        gain = rng.uniform(0.90, 1.10)
        return Image.fromarray(np.clip(a * gain, 0, 255).astype(np.uint8))

    if kind == "too_dark":
        gain = rng.uniform(0.15, 0.45)
        return Image.fromarray(np.clip(a * gain, 0, 255).astype(np.uint8))

    if kind == "too_bright":
        gain = rng.uniform(1.80, 3.00)
        return Image.fromarray(np.clip(a * gain, 0, 255).astype(np.uint8))

    if kind == "blurry":
        sigma = rng.uniform(2.0, 8.0)
        return img.convert("RGB").filter(ImageFilter.GaussianBlur(radius=sigma))

    if kind == "occluded":
        h, w = a.shape[:2]
        cover = rng.uniform(0.08, 0.25)
        area = cover * w * h
        aspect = rng.uniform(0.6, 1.8)
        bh = int(np.sqrt(area / aspect))
        bw = int(area / max(1, bh))
        bw = max(8, min(w, bw))
        bh = max(8, min(h, bh))
        x0 = rng.randint(0, max(0, w - bw))
        # bias the block toward the lower half, like a mask or a hand
        y0 = rng.randint(h // 4, max(h // 4, h - bh))
        out = img.convert("RGB").copy()
        d = ImageDraw.Draw(out)
        tone = rng.choice([(242, 244, 246), (120, 170, 220), (60, 60, 60)])
        d.rectangle([x0, y0, x0 + bw, y0 + bh], fill=tone)
        return out

    if kind == "turned":
        yaw = rng.uniform(20.0, 60.0) * rng.choice([-1, 1])
        h, w = a.shape[:2]
        f = w / (2.0 * np.tan(np.radians(yaw) / 2.0)) if yaw else w
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        dx = (w * w) / (4.0 * f) if f else 0.0
        dst = np.float32([[dx, 0], [w - dx, 0], [w + dx * 0.6, h], [-dx * 0.6, h]])
        M = cv2.getPerspectiveTransform(src, dst)
        warped = cv2.warpPerspective(a, M, (w, h), borderMode=cv2.BORDER_REPLICATE)
        return Image.fromarray(warped.astype(np.uint8))

    raise ValueError(kind)


# ------------------------------------------------------------- M-S warping
def warp_droop(img: Image.Image, pts: np.ndarray, region: str, amplitude: float,
               rng: random.Random) -> Image.Image:
    """Apply a smooth, known one-sided downward displacement (synthetic droop).

    amplitude is in inter-ocular units; it is converted to pixels from the
    landmark geometry so the label means the same thing across image sizes.
    """
    h, w = img.height, img.width
    eye_r, eye_l = pts[33], pts[263]
    iod_px = float(np.linalg.norm((eye_l[:2] - eye_r[:2]) * np.array([w, h])))
    amp_px = amplitude * iod_px

    idx = REGION_IDX[region]
    pix = np.array([[pts[i][0] * w, pts[i][1] * h] for i in idx], dtype=np.float32)
    # displace only the subject's one side (image x greater than the face centre)
    cx_face = float(np.mean([pts[33][0], pts[263][0]])) * w
    side = pix[pix[:, 0] > cx_face]
    if len(side) == 0:
        side = pix
    centre = side.mean(axis=0)
    sigma = max(12.0, 0.28 * (float(np.linalg.norm((eye_l[:2] - eye_r[:2]) * np.array([w, h]))) * 1.6))

    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d2 = (xx - centre[0]) ** 2 + (yy - centre[1]) ** 2
    weight = np.exp(-d2 / (2.0 * sigma * sigma))
    dy = amp_px * weight

    # dst(x, y) = src(x, y - dy) moves content DOWN
    map_x = xx
    map_y = yy - dy
    src = to_np(img)
    out = cv2.remap(src, map_x, map_y, interpolation=cv2.INTER_LINEAR,
                    borderMode=cv2.BORDER_REPLICATE)
    return Image.fromarray(out)


def detect(landmarker, mp, path: Path) -> np.ndarray | None:
    res = landmarker.detect(mp.Image.create_from_file(str(path)))
    if not res.face_landmarks:
        return None
    pts = np.array([[q.x, q.y, q.z] for q in res.face_landmarks[0]], dtype=np.float64)
    return pts if pts.shape[0] >= 478 else None


# --------------------------------------------------------------------- main
def main() -> int:
    # optional scope flag: "both" (default) | "symmetry" | "quality"
    scope = sys.argv[1] if len(sys.argv) > 1 else "both"
    rng = random.Random(SEED)
    table = load_pair_table()
    pwz = pairs_with_zone(table)
    a_ref, a_max = calibration(table)
    print(f"calibration: a_ref={a_ref:.4f} a_max={a_max:.4f}  pairs={len(pwz)}")

    mp, landmarker = load_landmarker()
    manifests = OUT / "manifests"
    manifests.mkdir(parents=True, exist_ok=True)

    stats = {}
    for part in ("train", "val", "test"):
        bases = base_images(part)
        rng.shuffle(bases)
        bases = bases[:BASE_PER_SPLIT[part]]
        print(f"\n=== {part}: {len(bases)} base images ===")

        # ---------------- M-Q: labels come from the degradation applied -------
        q_rows = []
        if scope in ("both", "quality"):
            for bi, bp in enumerate(bases):
                with Image.open(bp) as im:
                    im = im.convert("RGB")
                    for kind in QUALITY_CLASSES:
                        variant = make_quality_variant(im, kind, rng)
                        dest = OUT / "quality" / kind / part / f"{bp.stem}_{kind}.jpg"
                        save_jpg(to_np(variant), dest)
                        q_rows.append((str(dest.relative_to(APP)), kind))
                if (bi + 1) % 60 == 0:
                    print(f"  quality {bi + 1}/{len(bases)}")
            with (manifests / f"quality_{part}.csv").open("w", newline="", encoding="utf-8") as fh:
                wtr = csv.writer(fh)
                wtr.writerow(["path", "label"])
                wtr.writerows(q_rows)
        else:
            qf = manifests / f"quality_{part}.csv"
            if qf.exists():
                q_rows = [(r["path"], r["label"]) for r in csv.DictReader(qf.open(encoding="utf-8"))]
                print(f"  quality: reused existing manifest ({len(q_rows)} rows)")

        # ---------------- M-S: label = geometry re-measured after warping ----
        if scope == "quality":
            s_rows = []
            sf = manifests / f"symmetry_{part}.csv"
            if sf.exists():
                s_rows = list(csv.reader(sf.open(encoding="utf-8")))[1:]
            scores = [float(r[1]) for r in s_rows if r]
            stats[part] = {
                "base_images": len(bases),
                "quality": {},
                "symmetry": len(s_rows),
                "symmetry_skipped": 0,
                "score_min": min(scores) if scores else None,
                "score_median": float(np.median(scores)) if scores else None,
                "score_max": max(scores) if scores else None,
            }
            continue

        # ---------------- M-S: label = geometry re-measured after warping ----
        # Labels are targeted at a uniform spread over the score range instead of
        # sampling amplitude blindly: a single-region warp is diluted by the
        # 4-zone average, so random amplitudes produced a median score of ~89 and
        # a near-useless regression target. We now solve for the amplitude that
        # should land near a sampled target score and do one correction step.
        s_rows = []
        skipped = 0
        region_factor = {"all": 1.0}
        for bi, bp in enumerate(bases):
            pts = detect(landmarker, mp, bp)
            if pts is None:
                skipped += 1
                continue
            base_meas = measure(pts, table, pwz, a_ref, a_max)
            base_a = base_meas["a"] if base_meas else a_ref

            for k in range(SYMMETRY_PER_BASE):
                region = rng.choice(REGIONS)
                target_score = rng.uniform(5.0, 98.0)
                target_a = a_ref + (1.0 - target_score / 100.0) * (a_max - a_ref)
                factor = region_factor.get(region, 0.28)
                amplitude = max(0.002, min(0.60, (target_a - base_a) * factor))

                best = None
                for attempt in range(3):
                    with Image.open(bp) as im:
                        warped = warp_droop(im.convert("RGB"), pts, region, amplitude, rng)
                    dest = OUT / "symmetry" / part / f"{bp.stem}_s{k}.jpg"
                    # BUG HISTORY: every attempt used to write straight to `dest`
                    # and delete it on failure - which deleted an already-good
                    # file from an earlier attempt and left the manifest pointing
                    # at a missing image. Write to a temp file and only promote it
                    # once the label is known.
                    tmp = dest.with_name(dest.stem + ".tmp.jpg")
                    save_jpg(to_np(warped), tmp)
                    wpts = detect(landmarker, mp, tmp)
                    if wpts is None:
                        tmp.unlink(missing_ok=True)
                        amplitude *= 1.4
                        continue
                    m = measure(wpts, table, pwz, a_ref, a_max)
                    if m is None:
                        tmp.unlink(missing_ok=True)
                        amplitude *= 1.4
                        continue
                    tmp.replace(dest)
                    best = (dest, m, amplitude)
                    if abs(m["score"] - target_score) <= 12.0 or attempt == 2:
                        break
                    # one correction step towards the target
                    achieved_delta = (m["a"] - base_a)
                    needed_delta = (target_a - base_a)
                    if abs(achieved_delta) > 1e-6:
                        amplitude = max(0.002, min(0.60, amplitude * (needed_delta / achieved_delta)))
                    else:
                        amplitude *= 1.6

                if best is None:
                    skipped += 1
                    continue
                dest, m, amplitude = best
                s_rows.append((
                    str(dest.relative_to(APP)), m["score"], region,
                    round(float(amplitude), 4), bp.stem,
                    round(base_meas["score"], 1) if base_meas else "",
                ))
            if (bi + 1) % 40 == 0:
                print(f"  symmetry {bi + 1}/{len(bases)}")
        with (manifests / f"symmetry_{part}.csv").open("w", newline="", encoding="utf-8") as fh:
            wtr = csv.writer(fh)
            wtr.writerow(["path", "score", "region", "amplitude", "base", "base_score"])
            wtr.writerows(s_rows)

        q_counts = {}
        for _, lab in q_rows:
            q_counts[lab] = q_counts.get(lab, 0) + 1
        scores = [float(r[1]) for r in s_rows]
        stats[part] = {
            "base_images": len(bases),
            "quality": q_counts,
            "symmetry": len(s_rows),
            "symmetry_skipped": skipped,
            "score_min": min(scores) if scores else None,
            "score_median": float(np.median(scores)) if scores else None,
            "score_max": max(scores) if scores else None,
        }
        print(f"  quality={q_counts}  symmetry={len(s_rows)} (skipped {skipped})")

    # ------------------------------------------------------------- report
    (REPORTS / "synth_dataset.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")

    md = [
        "# T-06 合成训练集构建报告\n",
        "> 由 `train/build_synthetic_dataset.py` 生成。\n",
        "## 1. 数据来源与关键决定\n",
        "底图取自清洗后的人脸裁片（Stroke 与 NonStroke **两类混用**）。",
        "**原类别标签被完全丢弃，不进入任何合成样本**——因为审计已证明该标签可由采集域解释"
        "（平凡基线 AUC 0.993），无法支撑疾病分类。",
        "M-Q 与 M-S 的标签由**施加的退化/形变构造**，不依赖任何疾病标签。\n",
        "## 2. 切分原则\n",
        "沿用 T-02 的**簇级切分**（MD5 去重 + pHash 近重复聚类）。因此同一张底图及其近重复"
        "不会同时出现在训练集与验证集；同一底图生成的所有合成样本只落在一个集合内。\n",
        "## 3. 产出\n",
        "| 切分 | 底图数 | M-Q 样本 | M-S 样本 | M-S 跳过 | 分数范围（M-S） |",
        "|---|---|---|---|---|---|",
    ]
    for part, st in stats.items():
        rng_txt = "—"
        if st["score_min"] is not None:
            rng_txt = f"{st['score_min']} / {st['score_median']} / {st['score_max']}"
        md.append(f"| {part} | {st['base_images']} | {sum(st['quality'].values())} | "
                  f"{st['symmetry']} | {st['symmetry_skipped']} | {rng_txt} |")
    md += [
        "",
        "M-Q 六类：`ok` `too_dark` `too_bright` `blurry` `occluded` `turned`",
        "（标签由构造决定，见 `05b` §3.2）\n",
        "M-S：对单侧施加平滑下垂位移，振幅已知；标签为**形变后重新测量**的几何分数，"
        "因此与产品实际使用的 0–100 分口径一致。\n",
        "## 4. 清单文件\n",
        "`work/synth/manifests/quality_{train,val,test}.csv`（path,label）\n",
        "`work/synth/manifests/symmetry_{train,val,test}.csv`（path,score,region,amplitude,base,base_score）\n",
        "## 5. 必须写进论文/答辩的局限\n",
        "1. 底图来自公开数据集，**来源合法性未解决**（含公众人物/图库图库人像），"
        "仅可用于内部研发，**不得对外分发，不得用于器械注册**；产品对外发布前必须替换为自采授权数据。",
        "2. 合成形变无法完全复现真实卒中面部表现，M-S 只能定位为「对称度估计器」，不是疾病判别器。",
        "3. 底图缺年龄/性别/肤色标注，无法评估公平性。",
        "4. 簇级切分只能消除近重复，仍可能存在同一人的不同照片跨集合。\n",
    ]
    (REPORTS / "synth_dataset_report.md").write_text("\n".join(md), encoding="utf-8")
    print(f"\n[report] {REPORTS / 'synth_dataset_report.md'}")
    print("=== DONE ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
