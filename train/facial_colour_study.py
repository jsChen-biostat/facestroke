"""
面部颜色与几何指标的**稳定性研究** —— 把 Aging Cell 2024 (e14196) 的特征思路搬到二维自拍。

文献事实（原文摘要）
  - 输入：**二维人脸图像**（不是三维扫描）
  - 架构：四个网络集成 —— Xception + ResNet50 + VGG19 + EfficientNetB1
  - 结果：训练集交叉验证 AUC 0.91；独立数据集 AUC 0.82
  - 作者的可解释性结论：判别信号主要来自**面部中央（印堂 + 口周）蓝通道强度升高**

为什么先做「稳定性」而不是「分类」
  该文献能成立，前提是**受控拍摄**（固定设备、固定光照、急诊科环境）。
  在手机自拍上，颜色会被白平衡、曝光、环境色温整体平移 —— 我们已经在这份公开数据上
  量化过：中央绝对颜色的"信号"里有很大一部分其实是"图片来源"。
  **所以在做任何分类之前，必须先知道：同一个人的同一个指标，在受控与不受控条件下各漂多少。**
  这个问题**一个人就能回答**，不需要任何病人或志愿者。

两种模式（自动识别）
  可靠性模式：`--data` 下的子目录是**拍摄条件**（同一个人，不同条件）
      <目录>/A_受控/*.jpg     同一房间、同一光源、同一距离、同一时段
      <目录>/B_变化/*.jpg     换房间/换时段/换角度（尽量只改光照，别改表情与距离）
      → 报告：每个指标在「同一条件内的抖动」 vs 「换条件引起的漂移」，以及两者之比

  分组模式：`--data` 下是 Stroke / NonStroke 两个组
      → 报告：各特征子集能否区分两组，以及（必须并列的）泄漏检验

用法
    .venv\\Scripts\\python.exe train\\facial_colour_study.py protocol
    .venv\\Scripts\\python.exe train\\facial_colour_study.py analyze --data <目录>

只用本机依赖：mediapipe / numpy / Pillow。不联网、不上传。
"""

import argparse
import hashlib
import json
import random
import warnings
from pathlib import Path

import numpy as np
from PIL import Image

warnings.filterwarnings("ignore")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPORTS = ROOT / "work" / "reports"
CACHE = ROOT / "work" / "colour_study_landmarks.npz"
MODEL = ROOT / "web" / "public" / "mediapipe" / "face_landmarker.task"

EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".pgm"}

# MediaPipe FaceMesh 关键点
GLABELLA = 9
FOREHEAD = 10
MOUTH_L, MOUTH_R = 61, 291
EYE_L_OUT, EYE_R_OUT = 33, 263
CHEEK_L, CHEEK_R = 234, 454
NASION, CHIN = 168, 152

# EXIF 标签
EXIF_TAGS = {
    271: "make", 272: "model", 306: "datetime",
    34855: "iso", 33434: "exposure", 33437: "fnumber",
    37386: "focal", 41987: "whitebalance",
}


# ------------------------------------------------------------------ 协议

PROTOCOL = """
============================================================
受控采集协议（一个人就能完成，约 10 分钟）
============================================================

要回答的问题
  同一个人的同一个面部指标，在「同一拍摄条件」下有多稳？
  一旦换光照，它又漂多少？
  —— 漂移远大于抖动，就说明这个指标主要在被光照牵着走。

准备
  · 一部手机（就用你平时拍的那部），**不要开美颜/滤镜**，用普通相机模式
  · 两个拍摄地点，光照要明显不同（例如：白天窗边 / 晚上室内顶灯）
  · 每次拍之前，手机拿在**手臂自然前伸**的位置，正对脸，不用变焦

A 组：受控条件（建议 10 张）
  · 在**同一个地点**、**同一个光源**、**同一次坐下**拍完
  · 每张之间：稍微起身再坐回，保持距离与角度尽量一致
  · 表情自然放松，不要笑

B 组：变化条件（建议 10 张）
  · 换到**另一个光照环境**（换房间 / 换时段 / 开另一盏灯）
  · **只改光照**：距离、角度、表情尽量和 A 组一样
  · 同一次坐姿拍完 10 张

放文件
  <你的目录>/A_受控/  放 A 组的照片
  <你的目录>/B_变化/  放 B 组的照片

然后运行
  .venv\\Scripts\\python.exe train\\facial_colour_study.py analyze --data "<你的目录>"

这份研究**不涉及任何疾病判断**，也不需要别人配合。
============================================================
"""


# ------------------------------------------------------------- 关键点与特征

def extract_landmarks(paths):
    """带缓存地提取关键点。返回 (L, found)。"""
    if CACHE.exists():
        z = np.load(CACHE)
        if len(z["found"]) == len(paths) and str(z.get("sig", "")) == _sig(paths):
            print("  使用缓存的关键点")
            return z["L"], z["found"]
    import mediapipe as mp
    from mediapipe.tasks import python as mpp
    from mediapipe.tasks.python import vision

    opts = vision.FaceLandmarkerOptions(
        base_options=mpp.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=vision.RunningMode.IMAGE, num_faces=2)
    lm = vision.FaceLandmarker.create_from_options(opts)
    L = np.zeros((len(paths), 478, 2), dtype=np.float32)
    found = np.zeros(len(paths), dtype=np.int8)
    for i, p in enumerate(paths):
        try:
            r = lm.detect(mp.Image.create_from_file(str(p)))
            faces = r.face_landmarks or []
            if len(faces) == 1:
                L[i] = np.array([[q.x, q.y] for q in faces[0]], dtype=np.float32)
                found[i] = 1
        except Exception:  # noqa: BLE001
            pass
        if (i + 1) % 20 == 0:
            print(f"    {i+1}/{len(paths)}  检出 {int(found[:i+1].sum())}")
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(CACHE, L=L, found=found, sig=_sig(paths))
    return L, found


def _sig(paths):
    h = hashlib.md5()
    for p in paths:
        s = Path(p).stat()
        h.update(f"{Path(p).name}:{s.st_size}".encode())
    return h.hexdigest()


def roi_mean(arr, pts, idx, r_frac):
    h, w = arr.shape[:2]
    cx, cy = pts[idx]
    face = float(np.linalg.norm(pts[EYE_R_OUT] - pts[EYE_L_OUT])) or 1.0
    r = max(2, int(face * r_frac))
    x0, x1 = max(0, int(cx - r)), min(w, int(cx + r))
    y0, y1 = max(0, int(cy - r)), min(h, int(cy + r))
    if x1 <= x0 or y1 <= y0:
        return None
    return arr[y0:y1, x0:x1].reshape(-1, 3).mean(axis=0)


def colour_features(path, pts):
    """宏观颜色：中央区（印堂+口周）与参考区（额上+双颊）的 R/G/B，以及差值/比值。"""
    with Image.open(path) as im:
        arr = np.asarray(im.convert("RGB"), dtype=np.float32)
    W, H = im.size
    P = pts * np.array([W, H], dtype=np.float32)
    cent = [roi_mean(arr, P, GLABELLA, 0.22), roi_mean(arr, P, (MOUTH_L + MOUTH_R) // 2, 0.28)]
    cent = [c for c in cent if c is not None]
    refs = [roi_mean(arr, P, FOREHEAD, 0.30), roi_mean(arr, P, CHEEK_L, 0.18),
            roi_mean(arr, P, CHEEK_R, 0.18)]
    refs = [r for r in refs if r is not None]
    if not cent or not refs:
        return None
    c = np.mean(cent, axis=0)
    r = np.mean(refs, axis=0)
    return {
        "colour 中央−参考": c - r,
        "colour 中央绝对值": c,
        "colour 参考绝对值": r,
        "colour log(中央/参考)": np.log(c / np.maximum(r, 1.0)),
    }


def geometry_features(pts, pairs, ybins):
    """几何：标准坐标系下的镜像误差（分箱均值），与身体/拍摄颜色无关。"""
    W = pts
    e1, e2 = W[EYE_L_OUT], W[EYE_R_OUT]
    mid = (e1 + e2) / 2
    scale = float(np.linalg.norm(e2 - e1)) or 1e-9
    up = W[NASION] - W[CHIN]
    up = up / (float(np.linalg.norm(up)) or 1e-9)
    C = (W - mid) / scale
    C = np.stack([C[:, 0] * up[1] + C[:, 1] * up[0], C[:, 0] * -up[0] + C[:, 1] * up[1]], axis=1)
    err = np.array([np.hypot(-C[i, 0] - C[j, 0], C[i, 1] - C[j, 1]) for i, j in pairs])
    out = []
    for b in range(8):
        sel = ybins == b
        out.append(err[sel].mean() if sel.any() else 0.0)
    out += [err.mean(), np.median(err), err.std(), np.percentile(err, 90)]
    return np.array(out, dtype=np.float64)


def mirror_pairs_from(mean_shape):
    m = mean_shape
    mir = np.stack([-m[:, 0], m[:, 1]], axis=1)
    d = np.linalg.norm(mir[:, None, :] - m[None, :, :], axis=2)
    np.fill_diagonal(d, 1e9)
    j = d.argmin(axis=1)
    pairs, seen = [], set()
    for i in range(len(j)):
        a, b = i, int(j[i])
        if (a, b) in seen or (b, a) in seen:
            continue
        seen.add((a, b))
        pairs.append((a, b))
    return pairs


def exif_of(path):
    out = {}
    try:
        with Image.open(path) as im:
            ex = im.getexif()
            for tag, name in EXIF_TAGS.items():
                if tag in ex:
                    out[name] = str(ex[tag])
            out["size"] = f"{im.size[0]}x{im.size[1]}"
    except Exception:  # noqa: BLE001
        pass
    return out


# ------------------------------------------------------------------ 统计

def stability(vals_by_cond):
    """同一条件内的抖动 vs 条件间的漂移。返回汇总字典。"""
    conds = list(vals_by_cond.keys())
    arrs = [np.asarray(vals_by_cond[c], dtype=float) for c in conds]
    dim = arrs[0].shape[1] if arrs[0].ndim > 1 else 1

    within = []
    for a in arrs:
        if len(a) > 1:
            within.append(a.std(axis=0, ddof=1))
    within_sd = np.mean(within, axis=0) if within else np.zeros(dim)

    if len(arrs) >= 2:
        means = np.stack([a.mean(axis=0) for a in arrs])
        drift = means.max(axis=0) - means.min(axis=0)
    else:
        drift = np.zeros(dim)

    ratio = drift / np.maximum(within_sd, 1e-9)
    return {
        "within_sd": float(np.mean(within_sd)),
        "drift": float(np.mean(drift)),
        "ratio": float(np.mean(ratio)),
        "ratio_p90": float(np.percentile(ratio, 90)),
        "within_sd_vec": within_sd.tolist(),
        "drift_vec": drift.tolist(),
    }


def auc_score(s, y):
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s), dtype=float)
    ranks[order] = np.arange(1, len(s) + 1)
    n_pos, n_neg = int(y.sum()), int((1 - y).sum())
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    return float((ranks[y == 1].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def logit(X, y, iters=600, lr=0.5, l2=1e-3):
    X = np.hstack([X, np.ones((len(X), 1))])
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-np.clip(X @ w, -30, 30)))
        w -= lr * (X.T @ (p - y) / len(y) + l2 * w)
    return w


# -------------------------------------------------------------------- main

def run_protocol():
    print(PROTOCOL)


def run_analyze(args):
    data = Path(args.data)
    if not data.is_dir():
        raise SystemExit(f"目录不存在：{data}")

    conds = {}
    for d in sorted(p for p in data.iterdir() if p.is_dir()):
        fs = sorted(p for p in d.iterdir() if p.suffix.lower() in EXTS)
        if fs:
            conds[d.name] = fs
    if not conds:
        raise SystemExit("没找到任何 <子目录>/*.jpg —— 先运行 protocol 看采集要求")

    for name, fs in conds.items():
        print(f"  {name:<20} {len(fs)} 张")
    if len(conds) == 1:
        print("  ⚠️ 只有一个条件：只能给出「同一条件下的抖动」，无法给出漂移。")

    paths = [p for fs in conds.values() for p in fs]
    print(f"\n共 {len(paths)} 张，提取关键点…")
    L, found = extract_landmarks(paths)
    ok = found == 1
    print(f"  关键点检出 {int(ok.sum())}/{len(ok)}"
          + ("   ← 检出率过低会削弱结论，请检查光线与距离" if ok.mean() < 0.8 else ""))

    # 用检出成功的脸推镜像配对
    idx_ok = np.nonzero(ok)[0]
    mean_shape = L[idx_ok].mean(axis=0)
    pairs = mirror_pairs_from(mean_shape)
    d = mean_shape[:, 1]
    yb = np.clip(((d - d.min()) / (np.ptp(d) + 1e-9) * 8 * 0.999).astype(int), 0, 7)
    ybins = np.array([yb[i] for i, _ in pairs])
    print(f"  镜像配对 {len(pairs)} 对")

    # 逐图提特征
    colour, geom, meta, owner = [], [], [], []
    for i, p in enumerate(paths):
        if not ok[i]:
            continue
        cf = colour_features(p, L[i])
        if cf is None:
            continue
        colour.append(np.concatenate([cf["colour 中央−参考"], cf["colour 中央绝对值"],
                                      cf["colour log(中央/参考)"]]))
        geom.append(geometry_features(L[i], pairs, ybins))
        meta.append(exif_of(p))
        for name, fs in conds.items():
            if p in fs:
                owner.append(name)
                break
    if not colour:
        raise SystemExit(
            "没有一张图能用于分析：关键点全部未检出。`n"
            "请检查：照片是否清晰、人脸在画面中是否够大、光线是否充足、是否为正面。`n"
            "（手机拍摄的彩色照片通常没问题；过小或过暗的图片会检不出。）")
    colour = np.stack(colour)
    geom = np.stack(geom)
    owner = np.array(owner)
    print(f"  可用 {len(owner)} 张，颜色特征 {colour.shape[1]} 维，几何特征 {geom.shape[1]} 维")

    is_group = set(conds) == {"Stroke", "NonStroke"} or set(conds) == {"stroke", "nonstroke"}
    report = {"mode": "group" if is_group else "reliability", "data": str(data),
              "conditions": {k: len(v) for k, v in conds.items()}, "n_used": int(len(owner))}

    if is_group:
        y = np.array([1 if o.lower() == "stroke" else 0 for o in owner])
        print("\n=== 分组模式：各特征子集 ===")
        print(f"{'特征':<26}{'两组AUC':>10}")
        rows = {}
        for name, X in (("颜色 中央−参考", colour[:, 0:3]),
                        ("颜色 中央绝对值", colour[:, 3:6]),
                        ("颜色 log(中央/参考)", colour[:, 6:9]),
                        ("几何 镜像误差", geom)):
            rng = np.random.default_rng(3)
            ix = rng.permutation(len(y))
            cut = int(len(ix) * 0.7)
            tr, te = ix[:cut], ix[cut:]
            mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-8
            w = logit((X[tr] - mu) / sd, y[tr])
            a = auc_score(np.hstack([(X[te] - mu) / sd, np.ones((len(te), 1))]) @ w, y[te])
            rows[name] = round(float(a), 4)
            print(f"{name:<26}{a:>10.4f}")
        report["group_auc"] = rows
        print("\n⚠️ 只要能区分两组就下结论是不成立的：本数据集已知标签不可信，")
        print("   且拍摄条件与类别共线。必须与可靠性结果一起解读。")
    else:
        vals_c = {c: colour[owner == c] for c in conds if (owner == c).sum() > 1}
        vals_g = {c: geom[owner == c] for c in conds if (owner == c).sum() > 1}
        sc = stability(vals_c)
        sg = stability(vals_g)
        print("\n=== 可靠性模式：同一条件内的抖动 vs 条件间的漂移 ===")
        print(f"{'特征':<16}{'条件内SD':>12}{'条件间漂移':>12}{'漂移/抖动':>12}")
        print(f"{'颜色':<16}{sc['within_sd']:>12.3f}{sc['drift']:>12.3f}{sc['ratio']:>12.2f}")
        print(f"{'几何':<16}{sg['within_sd']:>12.4f}{sg['drift']:>12.4f}{sg['ratio']:>12.2f}")
        report["colour"] = {k: round(v, 4) for k, v in sc.items() if not k.endswith("_vec")}
        report["geometry"] = {k: round(v, 4) for k, v in sg.items() if not k.endswith("_vec")}

        print("\n=== 判读 ===")
        print("  「漂移/抖动」= 换光照引起的位移 ÷ 同一光照下的随机抖动。")
        print("  · 远大于 1  → 该指标主要被光照牵着走，不能直接当作身体信号")
        print("  · 接近或小于 1 → 该指标对光照不敏感，适合放进产品")
        if sc["ratio"] > sg["ratio"] * 1.5:
            print(f"\n  本次结果：颜色 {sc['ratio']:.2f} 明显高于几何 {sg['ratio']:.2f}")
            print("  → 在**你自己的手机上**复现了文献方法的软肋：颜色受光照支配，几何不受。")
            print("  → 这支持「以几何为主通道」的现有设计。")
        elif sg["ratio"] > 1.5:
            print(f"\n  几何的漂移/抖动 = {sg['ratio']:.2f} 也偏大：")
            print("  说明两次拍摄的**距离或角度**没控制住（几何对这些敏感，颜色不敏感）。")
            print("  请按协议重拍：距离与角度尽量保持一致，只改光照。")
        else:
            print(f"\n  颜色 {sc['ratio']:.2f}、几何 {sg['ratio']:.2f} 都在可接受范围。")
            print("  可以进入下一步：在受控条件下采集更多数据。")

    # EXIF 一览：这是"自动记录的拍摄条件"
    if any(meta):
        keys = ["model", "iso", "exposure", "fnumber", "focal", "whitebalance", "size", "datetime"]
        print("\n=== 自动记录的拍摄条件（EXIF） ===")
        for c in conds:
            rows = [m for m, o in zip(meta, owner) if o == c]
            if not rows:
                continue
            print(f"  [{c}]")
            for k in keys:
                vs = sorted({r.get(k) for r in rows if r.get(k)})
                if vs:
                    shown = ", ".join(vs[:3]) + (" …" if len(vs) > 3 else "")
                    print(f"      {k:<14}{shown}")
        report["exif"] = {c: [m for m, o in zip(meta, owner) if o == c] for c in conds}

    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / "facial_colour_study.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告：{REPORTS / 'facial_colour_study.json'}")


def main():
    ap = argparse.ArgumentParser(description="面部颜色/几何指标稳定性研究")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("protocol", help="显示受控采集协议")
    a = sub.add_parser("analyze", help="分析照片目录")
    a.add_argument("--data", required=True)
    args = ap.parse_args()
    if args.cmd == "protocol":
        run_protocol()
    else:
        run_analyze(args)


if __name__ == "__main__":
    main()
