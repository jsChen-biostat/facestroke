"""T-05 (part 1): derive the mirror-landmark table and calibrate the score.

Why this script exists
----------------------
`symmetry.js` needs to know WHICH landmark pairs mirror each other. Guessing
("indices differ by N") is wrong: MediaPipe's 478-point ordering is not arranged
that way, and a wrong table silently destroys the whole geometric channel.

So we derive the table from data instead:

  1. run FaceLandmarker on near-frontal non-stroke faces (the cleaned set)
  2. align every face into a canonical frame
     (origin = eye midpoint, scale = inter-ocular distance, axis = vertical)
  3. take the median shape -> canonical template
  4. reflect every template point across the template midline and find its
     mutual nearest neighbour -> that IS the mirror pair
  5. label each pair with a facial zone from its position in the template
  6. compute the asymmetry distribution over the whole sample and report the
     percentiles that will become A_ref / A_max

Outputs
-------
  work/reports/mirror_pairs.json     pairs + zone labels + anchors
  work/reports/symmetry_calibration.md   human-readable calibration report

Run: .venv\\Scripts\\python.exe train\\derive_mirror_pairs.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")

WS = Path(__file__).resolve().parents[2]
APP = Path(__file__).resolve().parents[1]
FACES = APP / "work" / "cleaned" / "faces" / "NonStroke"
TASK = APP / "web" / "public" / "mediapipe" / "face_landmarker.task"
REPORTS = APP / "work" / "reports"
FIGURES = APP / "work" / "figures"

N_SAMPLE = 400
YAW_TOL = 0.15

# MediaPipe FaceMesh canonical indices (documented, stable across the 468/478 set)
IDX = {
    "eye_r_outer": 33, "eye_r_inner": 133,
    "eye_l_inner": 362, "eye_l_outer": 263,
    "nasion": 168, "chin": 152, "nose_tip": 1,
    "mouth_r": 61, "mouth_l": 291,
    "lip_top": 13, "lip_bottom": 14,
}


def load_landmarker():
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    if not TASK.exists():
        raise SystemExit(f"model not found: {TASK}\nrun scripts/fetch_mediapipe_assets.ps1 first")
    opts = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(TASK)),
        output_face_blendshapes=False,
        output_facial_transformation_matrixes=False,
        num_faces=1,
        running_mode=vision.RunningMode.IMAGE,
    )
    return mp, vision.FaceLandmarker.create_from_options(opts)


def detect_all() -> tuple[np.ndarray, list[str]]:
    mp, lm = load_landmarker()
    files = sorted(FACES.glob("*.jpg"))
    if not files:
        raise SystemExit(f"no cleaned faces found in {FACES} (run train/data_audit.py first)")
    step = max(1, len(files) // N_SAMPLE)
    picked = files[::step][:N_SAMPLE]

    shapes, used = [], []
    for i, p in enumerate(picked):
        try:
            img = mp.Image.create_from_file(str(p))
            res = lm.detect(img)
            if not res.face_landmarks:
                continue
            pts = np.array([[q.x, q.y, q.z] for q in res.face_landmarks[0]], dtype=np.float64)
            if pts.shape[0] < 468:
                continue
            shapes.append(pts)
            used.append(p.name)
        except Exception:  # noqa: BLE001
            continue
        if (i + 1) % 50 == 0:
            print(f"  detected {len(shapes)}/{i + 1}")
    return np.array(shapes), used


def align(pts: np.ndarray) -> np.ndarray:
    """Map a face into the canonical frame.

    origin = eye midpoint, scale = inter-ocular distance,
    rotation = the MIDLINE (nasion -> chin) is vertical.

    The reference axis is taken from midline landmarks (nasion, chin) rather than
    the eye line, because a unilateral droop displaces an eye corner and would
    then sit inside the reference frame. Must stay identical to symmetry.js.
    """
    r_out, l_out = pts[IDX["eye_r_outer"]], pts[IDX["eye_l_outer"]]
    eye_mid = (r_out + l_out) / 2.0
    # 2D (image-plane) inter-ocular distance. Using the 3D norm here made the
    # scale differ from symmetry.js and shifted A by ~1% across languages.
    scale = float(np.linalg.norm((l_out - r_out)[:2]))
    if scale < 1e-6:
        return None

    a, b = pts[IDX["nasion"]], pts[IDX["chin"]]
    v = (b[:2] - a[:2])
    vlen = np.linalg.norm(v)
    if vlen < 1e-9:
        return None
    vx, vy = v / vlen
    # R maps the midline direction onto (0, 1)
    xy = (pts[:, :2] - eye_mid[:2]) / scale
    x_new = vy * xy[:, 0] - vx * xy[:, 1]
    y_new = vx * xy[:, 0] + vy * xy[:, 1]
    return np.stack([x_new, y_new], axis=1)


def yaw_proxy(xy: np.ndarray) -> float:
    """~0 for a frontal face. Compares nose-tip distance to each eye corner."""
    n = xy[IDX["nose_tip"]]
    return float(abs(np.linalg.norm(n - xy[IDX["eye_r_outer"]])
                     - np.linalg.norm(n - xy[IDX["eye_l_outer"]])))


def mirror_pt(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    ab = b - a
    t = float(np.dot(p - a, ab) / np.dot(ab, ab))
    return 2.0 * (a + t * ab) - p


def derive_pairs(tpl: np.ndarray, max_d: float = 0.045) -> tuple[list[tuple[int, int]], np.ndarray]:
    a, b = tpl[IDX["nasion"]], tpl[IDX["chin"]]
    mirrored = np.array([mirror_pt(p, a, b) for p in tpl])
    n = len(tpl)
    d = np.linalg.norm(mirrored[:, None, :] - tpl[None, :, :], axis=2)
    np.fill_diagonal(d, np.inf)
    nn = np.argmin(d, axis=1)
    pairs, dists = [], []
    for i in range(n):
        j = int(nn[i])
        if nn[j] == i and d[i, j] <= max_d and i < j:
            pairs.append((i, j))
            dists.append(float(d[i, j]))
    return pairs, np.array(dists)


def label_zone(tpl: np.ndarray, i: int, j: int) -> str:
    """Assign a clinical observation zone from position in the canonical frame."""
    x = (abs(tpl[i][0]) + abs(tpl[j][0])) / 2.0
    y = (tpl[i][1] + tpl[j][1]) / 2.0
    if y < -0.28:
        return "forehead"      # 额纹区
    if -0.28 <= y < 0.32 and x > 0.18:
        return "eyelid"        # 眼睑区
    if 0.32 <= y < 0.72 and 0.10 <= x < 0.42:
        return "nasolabial"    # 鼻唇沟区
    if 0.55 <= y and x < 0.42:
        return "mouth"         # 口角区
    return "other"


def asymmetry(xy: np.ndarray, pairs_with_zone: list[tuple[int, int, str]],
              a: np.ndarray, b: np.ndarray) -> dict:
    """Per-zone mean mirror error.

    HISTORY / WHY THIS IS NOT "distance to the midline":
    v1 measured |dist(p_i, midline) - dist(p_j, midline)|. A unit test showed
    that metric is BLIND TO VERTICAL DROOP: when the midline is vertical, the
    perpendicular distance of a point is just |x|, so sliding a mouth corner
    downwards changes nothing at all -- and vertical sag is exactly the dominant
    clinical sign of facial droop.

    v2 therefore compares the mirrored face against the real face:
        d(i,j) = || mirror(p_i) - p_j ||
    which captures horizontal AND vertical mismatch. The mirror pairs themselves
    are unchanged; only the error metric was corrected.
    """
    mirrored = np.array([mirror_pt(p, a, b) for p in xy])
    out: dict[str, list[float]] = {}
    for (i, j, zone) in pairs_with_zone:
        out.setdefault(zone, []).append(float(np.linalg.norm(mirrored[i] - xy[j])))
    return {z: float(np.mean(v)) for z, v in out.items()}


def main() -> int:
    REPORTS.mkdir(parents=True, exist_ok=True)
    FIGURES.mkdir(parents=True, exist_ok=True)

    print("=== [1/5] detecting landmarks ===")
    shapes, names = detect_all()
    print(f"  detected: {len(shapes)} faces")

    print("=== [2/5] aligning to canonical frame ===")
    aligned = []
    for pts in shapes:
        xy = align(pts)
        if xy is not None:
            aligned.append(xy)
    aligned = np.array(aligned)
    yaws = np.array([yaw_proxy(xy) for xy in aligned])
    keep = yaws < YAW_TOL
    frontal = aligned[keep]
    print(f"  aligned {len(aligned)}, near-frontal (|yaw proxy| < {YAW_TOL}): {len(frontal)} "
          f"({len(frontal)/max(1,len(aligned))*100:.1f}%)")

    print("=== [3/5] canonical template + mirror pairs ===")
    tpl = np.median(frontal, axis=0)
    pairs, pdists = derive_pairs(tpl)
    zones = {}
    for i, j in pairs:
        zones.setdefault(label_zone(tpl, i, j), []).append([i, j])
    # flat list with the zone attached, used by the calibration pass
    pairs_with_zone = [(i, j, label_zone(tpl, i, j)) for i, j in pairs]
    print(f"  mirror pairs found: {len(pairs)} (median residual {np.median(pdists):.4f})")
    for z, pl in sorted(zones.items()):
        print(f"    {z:<11} {len(pl)} pairs")

    print("=== [4/5] calibration over the sample ===")
    per_face = []
    for xy in frontal:
        a, b = xy[IDX["nasion"]], xy[IDX["chin"]]
        per_face.append(asymmetry(xy, pairs_with_zone, a, b))
    zone_names = ["forehead", "eyelid", "nasolabial", "mouth"]
    stats = {}
    for z in zone_names:
        vals = np.array([f.get(z, np.nan) for f in per_face])
        vals = vals[~np.isnan(vals)]
        if not len(vals):
            continue
        stats[z] = {
            "p50": float(np.percentile(vals, 50)),
            "p90": float(np.percentile(vals, 90)),
            "p95": float(np.percentile(vals, 95)),
            "p99": float(np.percentile(vals, 99)),
            "mean": float(vals.mean()),
        }
        print(f"  {z:<11} p50={stats[z]['p50']:.4f} p90={stats[z]['p90']:.4f} "
              f"p95={stats[z]['p95']:.4f} p99={stats[z]['p99']:.4f}")
    overall = np.array([np.mean([f.get(z, 0.0) for z in zone_names]) for f in per_face])
    stats["_overall"] = {"p50": float(np.percentile(overall, 50)),
                         "p95": float(np.percentile(overall, 95)),
                         "p99": float(np.percentile(overall, 99))}

    print("=== [5/5] writing outputs ===")
    out = {
        "derived_from": {"n_detected": int(len(shapes)), "n_frontal": int(len(frontal)),
                         "source": "work/cleaned/faces/NonStroke", "yaw_tol": YAW_TOL},
        "anchors": IDX,
        "axis": [IDX["nasion"], IDX["chin"]],
        "template": {str(i): [round(float(v), 5) for v in tpl[i]] for i in
                     sorted({k for pr in pairs for k in pr})},
        "pairs": {z: pl for z, pl in zones.items()},
        "pairs_flat": [[i, j] for i, j in pairs],
        "zone_stats": stats,
    }
    (REPORTS / "mirror_pairs.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[written] {REPORTS / 'mirror_pairs.json'}")

    md = [
        "# T-05 几何通道标定报告\n",
        "> 由 `train/derive_mirror_pairs.py` 自动生成。镜面对点表**由数据推导**，不是猜测。\n",
        "## 1. 推导方法\n",
        "1. 在清洗后的非卒中人脸裁片上运行 MediaPipe FaceLandmarker（478 点）；",
        "2. 以「双眼外眼角中点」为原点、「瞳距」为尺度、「鼻根—下巴」为纵轴，把每张脸对齐到标准坐标系；",
        "3. 取中位形状作为**标准脸模板**；",
        "4. 把模板上每个点沿中线镜像，找**互为最近邻**的点作为镜像点对；",
        "5. 按点在标准坐标系中的位置标注临床观察分区。\n",
        f"- 检出人脸：{len(shapes)} 张；其中近正脸（偏航代理值 < {YAW_TOL}）：**{len(frontal)}** 张",
        f"- 推导出镜像点对：**{len(pairs)}** 对（镜像残差中位数 {np.median(pdists):.4f}）\n",
        "## 2. 镜像点对分区统计\n",
        "| 分区 | 点对数 |", "|---|---|",
    ]
    for z, pl in sorted(zones.items()):
        md.append(f"| {z} | {len(pl)} |")
    md += ["", "## 3. 非卒中人群的不对称度分布（用于标定 A_ref / A_max）\n",
           "| 分区 | p50 | p90 | p95 | p99 |", "|---|---|---|---|---|"]
    for z in zone_names:
        if z in stats:
            s = stats[z]
            md.append(f"| {z} | {s['p50']:.4f} | {s['p90']:.4f} | {s['p95']:.4f} | {s['p99']:.4f} |")
    md += ["", "## 4. 建议的标定锚点\n",
           "按 `05` §6 的规定，用**非卒中人群分布**定锚点，不拍脑袋：\n",
           f"- `A_ref`（视为完全对称）= 各区 p50 的加权平均 ≈ **{stats['_overall']['p50']:.4f}**",
           f"- `A_max`（视为明显不对称）= 各区 p99 的加权平均之上，建议取 ≈ **{stats['_overall']['p99']:.4f}**\n",
           "对应的 0–100 映射：`S = 100 × (1 − clip((A − A_ref) / (A_max − A_ref), 0, 1))`\n",
           "🔴 **需医生确认**：四个分区的权重、四个动作的权重，以及 A_max 是否合理。\n",
           "## 5. 局限\n",
           "- 标定样本来自公开数据集（来源合法性未解决，见 🔴-05），只用于**阈值标定**，不用于训练；",
           "- 样本缺少年龄/性别/肤色标注，无法评估公平性；",
           "- 该分布反映的是「本数据集人群」，与真实用户人群可能有偏移，内测后需重新标定。\n"]
    (REPORTS / "symmetry_calibration.md").write_text("\n".join(md), encoding="utf-8")
    print(f"[written] {REPORTS / 'symmetry_calibration.md'}")
    print("=== DONE ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
