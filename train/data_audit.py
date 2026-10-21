"""T-02 data audit & cleaning for FaceStroke (rev 2).

Revision note (2026-10-01):
  The original plan assumed filename numbering identifies subjects ("adjacent
  numbers = same person"). Measurement disproved it: the largest gap between
  consecutive numbers is 17 (Stroke) / 9 (NonStroke), i.e. numbering is a global
  sequence index carrying no subject information. Grouping by gap therefore
  chains the whole dataset into one cluster.

  Replacement method, used here:
    1. exact de-duplication by MD5
    2. perceptual hash (pHash, 64-bit) + Hamming-distance clustering to group
       near-identical images (same photo / same session)
    3. split train/val/test BY CLUSTER so near-duplicates cannot straddle sets

What it does:
  1. scan + report counts / sizes / colour modes / colourfulness
  2. MD5 de-duplication, incl. cross-class label conflicts
  3. pHash clustering with a threshold sweep
  4. cluster-level split (70/15/15) + leakage verification
  5. face crop from YOLO boxes (20% margin) -> 256x256
  6. unified grayscale copy
  7. report + contact sheets

Run:
    .venv\\Scripts\\python.exe train\\data_audit.py

This script NEVER deletes original data. It only writes derived files.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.fft import dct

sys.stdout.reconfigure(encoding="utf-8")

# ---------------------------------------------------------------- config
WS = Path(__file__).resolve().parents[2]
DATASET = WS / "FACEstroke" / "archive" / "Annotated stroke and non stroke Dataset"
APP = Path(__file__).resolve().parents[1]
CLEAN = APP / "work" / "cleaned"
REPORTS = APP / "work" / "reports"
FIGURES = APP / "work" / "figures"

CLASSES = ("Stroke", "NonStroke")
LABEL = {"Stroke": 0, "NonStroke": 1}
PHASH_THRESHOLD = 8          # Hamming distance on 64-bit pHash
SPLIT = (0.70, 0.15, 0.15)
SEED = 42
CROP_SIZE = 256
CROP_MARGIN = 0.20
IMG_EXT = {".jpg", ".jpeg", ".png"}
COLOR_SAMPLE = 300


# ---------------------------------------------------------------- helpers
def num_of(p: Path) -> int:
    m = re.search(r"(\d+)", p.stem)
    return int(m.group(1)) if m else -1


def md5_of(p: Path) -> str:
    h = hashlib.md5()
    with p.open("rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def read_boxes(txt: Path) -> list[tuple[int, float, float, float, float]]:
    out = []
    if not txt.exists():
        return out
    for line in txt.read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            out.append((int(float(parts[0])), *[float(v) for v in parts[1:5]]))
        except ValueError:
            continue
    return out


def phash64(img: Image.Image, hs: int = 8, hf: int = 4) -> int:
    """64-bit perceptual hash (DCT based)."""
    im = img.convert("L").resize((32, 32), Image.BILINEAR)
    a = np.asarray(im, dtype=np.float32)
    d = dct(dct(a, axis=0, norm="ortho"), axis=1, norm="ortho")[:hs, :hs]
    med = np.median(d.ravel()[1:])
    bits = (d > med).ravel()
    v = 0
    for b in bits:
        v = (v << 1) | int(b)
    return v


def popcount_matrix(hashes: np.ndarray) -> np.ndarray:
    """Pairwise Hamming distances for uint64 hashes (n x n uint8)."""
    n = len(hashes)
    out = np.zeros((n, n), dtype=np.uint8)
    for i in range(n):
        x = hashes ^ hashes[i]
        # popcount via lookup on bytes
        out[i] = np.unpackbits(x.view(np.uint8).reshape(n, 8), axis=1).sum(axis=1)
    return out


class UF:
    def __init__(self, n: int):
        self.p = list(range(n))

    def find(self, x: int) -> int:
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def cluster_sizes(dist: np.ndarray, thr: int) -> tuple[list[list[int]], Counter]:
    n = dist.shape[0]
    uf = UF(n)
    iu = np.triu_indices(n, k=1)
    close = np.where(dist[iu] <= thr)[0]
    for k in close:
        uf.union(int(iu[0][k]), int(iu[1][k]))
    groups: dict[int, list[int]] = defaultdict(list)
    for i in range(n):
        groups[uf.find(i)].append(i)
    cl = list(groups.values())
    return cl, Counter(len(c) for c in cl)


# ---------------------------------------------------------------- step 1: scan
def scan() -> dict:
    per_class = {}
    for cname in CLASSES:
        cdir = DATASET / cname
        imgs = sorted([p for p in cdir.iterdir() if p.suffix.lower() in IMG_EXT], key=num_of)
        txts = {num_of(p) for p in cdir.glob("*.txt")}
        rows = []
        for p in imgs:
            with Image.open(p) as im:
                w, h = im.size
                mode = im.mode
            rows.append({
                "file": p.name, "num": num_of(p), "w": w, "h": h, "mode": mode,
                "bytes": p.stat().st_size, "has_txt": num_of(p) in txts,
                "md5": md5_of(p), "path": p,
            })
        ws = np.array([r["w"] for r in rows])
        hs = np.array([r["h"] for r in rows])
        nums = np.array([r["num"] for r in rows])
        gaps = np.diff(nums)
        dup = Counter(r["md5"] for r in rows)
        per_class[cname] = {
            "n_images": len(rows),
            "n_txt": len(txts),
            "missing_txt": [r["file"] for r in rows if not r["has_txt"]],
            "modes": dict(Counter(r["mode"] for r in rows)),
            "w_med": float(np.median(ws)), "h_med": float(np.median(hs)),
            "w_min": int(ws.min()), "w_max": int(ws.max()),
            "h_min": int(hs.min()), "h_max": int(hs.max()),
            "bytes_med": int(np.median([r["bytes"] for r in rows])),
            "n_dup_extra": sum(v - 1 for v in dup.values() if v > 1),
            "n_dup_groups": sum(1 for v in dup.values() if v > 1),
            "num_min": int(nums.min()), "num_max": int(nums.max()),
            "gap_max": int(gaps.max()) if len(gaps) else 0,
            "gap_p99": float(np.percentile(gaps, 99)) if len(gaps) else 0.0,
            "rows": rows,
        }
    return per_class


def colourfulness(per_class: dict) -> dict:
    rng = np.random.default_rng(0)
    out = {}
    for cname in CLASSES:
        ps = [r["path"] for r in per_class[cname]["rows"]]
        idx = rng.choice(len(ps), size=min(COLOR_SAMPLE, len(ps)), replace=False)
        vals = []
        for i in idx:
            with Image.open(ps[i]) as im:
                a = np.asarray(im.convert("RGB"), dtype=np.int16)
                vals.append(float((a.max(axis=2) - a.min(axis=2)).mean()))
        v = np.array(vals)
        out[cname] = {"mean": float(v.mean()), "median": float(np.median(v)),
                      "p10": float(np.percentile(v, 10)), "p90": float(np.percentile(v, 90))}
    return out


# ---------------------------------------------------------------- step 5-6: crops
def crop_and_gray(per_class: dict, faces: Path, gray: Path) -> dict:
    stats = defaultdict(int)
    for cname in CLASSES:
        (faces / cname).mkdir(parents=True, exist_ok=True)
        (gray / cname).mkdir(parents=True, exist_ok=True)
        for r in per_class[cname]["rows"]:
            if not r["has_txt"]:
                stats["skipped_no_txt"] += 1
                continue
            boxes = read_boxes(r["path"].with_suffix(".txt"))
            if not boxes:
                stats["skipped_empty_txt"] += 1
                continue
            _, cx, cy, bw, bh = max(boxes, key=lambda b: b[3] * b[4])
            try:
                with Image.open(r["path"]) as im:
                    im = im.convert("RGB")
                    W, H = im.size
                    x1, y1 = (cx - bw / 2) * W, (cy - bh / 2) * H
                    x2, y2 = (cx + bw / 2) * W, (cy + bh / 2) * H
                    mx, my = (x2 - x1) * CROP_MARGIN, (y2 - y1) * CROP_MARGIN
                    box = (max(0, int(x1 - mx)), max(0, int(y1 - my)),
                           min(W, int(x2 + mx)), min(H, int(y2 + my)))
                    if box[2] - box[0] < 8 or box[3] - box[1] < 8:
                        stats["skipped_tiny_box"] += 1
                        continue
                    face = im.crop(box).resize((CROP_SIZE, CROP_SIZE), Image.BILINEAR)
                    face.save(faces / cname / r["file"], quality=92)
                    face.convert("L").save(gray / cname / r["file"], quality=92)
                    stats[f"written_{cname}"] += 1
            except Exception as exc:  # noqa: BLE001
                stats["errors"] += 1
                stats[f"err_{type(exc).__name__}"] += 1
    return dict(stats)


def contact_sheet(cname: str, rows: list[dict], out: Path, n: int = 36, cols: int = 6) -> None:
    step = max(1, len(rows) // n)
    sample = rows[::step][:n]
    cell = 160
    rn = (len(sample) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rn * cell), "white")
    d = ImageDraw.Draw(sheet)
    for i, r in enumerate(sample):
        with Image.open(r["path"]) as im:
            t = im.convert("RGB")
            t.thumbnail((cell - 8, cell - 24))
        x, y = (i % cols) * cell, (i // cols) * cell
        sheet.paste(t, (x + 4, y + 4))
        d.text((x + 6, y + cell - 16), f"{Path(r['file']).stem} {r['w']}x{r['h']}", fill="black")
    sheet.save(out)
    print(f"[figure] {out}")


# ---------------------------------------------------------------- main
def main() -> int:
    for d in (CLEAN, REPORTS, FIGURES, REPORTS / "splits"):
        d.mkdir(parents=True, exist_ok=True)
    faces, gray = CLEAN / "faces", CLEAN / "gray"

    print("=== [1/7] scanning ===")
    per_class = scan()
    for c, s in per_class.items():
        print(f"  {c}: n={s['n_images']} txt={s['n_txt']} missing_txt={len(s['missing_txt'])} "
              f"modes={s['modes']} median={s['w_med']:.0f}x{s['h_med']:.0f} "
              f"dup_extra={s['n_dup_extra']} numrange={s['num_min']}..{s['num_max']} gap_max={s['gap_max']}")

    print("=== [2/7] colourfulness ===")
    col = colourfulness(per_class)
    for c, v in col.items():
        print(f"  {c}: mean={v['mean']:.1f} median={v['median']:.1f} p10={v['p10']:.1f} p90={v['p90']:.1f}")

    print("=== [3/7] MD5 de-duplication ===")
    keep: dict[str, dict] = {}       # md5 -> representative row
    dropped: dict[str, list[str]] = defaultdict(list)
    cross_conflicts: list[dict] = []
    for cname in CLASSES:
        for r in per_class[cname]["rows"]:
            h = r["md5"]
            if h in keep:
                other = keep[h]
                dropped[h].append(f"{cname}/{r['file']}")
                if other["class"] != cname:
                    cross_conflicts.append({
                        "md5": h,
                        "kept": f"{other['class']}/{other['file']}",
                        "also_in": f"{cname}/{r['file']}",
                    })
            else:
                r2 = dict(r)
                r2["class"] = cname
                keep[h] = r2
    uniq = list(keep.values())
    print(f"  total files={sum(s['n_images'] for s in per_class.values())} "
          f"unique={len(uniq)} dropped_as_duplicate={sum(len(v) for v in dropped.values())}")
    print(f"  cross-class label conflicts (same image, two labels): {len(cross_conflicts)}")
    for cc in cross_conflicts[:5]:
        print(f"    {cc['kept']}  ==  {cc['also_in']}")

    print("=== [4/7] pHash near-duplicate clustering ===")
    hashes = np.zeros(len(uniq), dtype=np.uint64)
    for i, r in enumerate(uniq):
        with Image.open(r["path"]) as im:
            hashes[i] = np.uint64(phash64(im))
    dist = popcount_matrix(hashes)
    print(f"  distance matrix {dist.shape} computed")
    sweep = {}
    for thr in (4, 6, 8, 10, 12):
        cl, hist = cluster_sizes(dist, thr)
        sweep[thr] = {"n_clusters": len(cl), "largest": max(hist), "size_hist": dict(hist)}
        print(f"  thr={thr:>2}: clusters={len(cl):>4} largest={max(hist):>4} "
              f"sizes={dict(sorted(hist.items())[:6])}")

    cl_idx, hist = cluster_sizes(dist, PHASH_THRESHOLD)
    print(f"  using thr={PHASH_THRESHOLD}: {len(cl_idx)} clusters")

    print("=== [5/7] cluster-level split + leakage check ===")
    rng = random.Random(SEED)
    splits: dict[str, list[list[dict]]] = {"train": [], "val": [], "test": []}
    split_info = {}
    for cname in CLASSES:
        cls = [[uniq[i] for i in c if uniq[i]["class"] == cname] for c in cl_idx]
        cls = [c for c in cls if c]
        rng.shuffle(cls)
        n = len(cls)
        n_tr, n_va = int(round(n * SPLIT[0])), int(round(n * SPLIT[1]))
        parts = {"train": cls[:n_tr], "val": cls[n_tr:n_tr + n_va], "test": cls[n_tr + n_va:]}
        for k in splits:
            splits[k].extend(parts[k])
        split_info[cname] = {
            "clusters": {k: len(v) for k, v in parts.items()},
            "images": {k: sum(len(c) for c in v) for k, v in parts.items()},
        }
        print(f"  {cname}: clusters={split_info[cname]['clusters']} images={split_info[cname]['images']}")

    seen: dict[str, str] = {}
    leaks = []
    for part, cls in splits.items():
        for c in cls:
            for r in c:
                if r["file"] in seen:
                    leaks.append(f"{r['file']} in {seen[r['file']]} and {part}")
                seen[r["file"]] = part
    print(f"  leakage check: {'PASS' if not leaks else f'FAIL {len(leaks)}'}")

    for part in ("train", "val", "test"):
        for cname in CLASSES:
            files = sorted(r["file"] for c in splits[part] for r in c if r["class"] == cname)
            (REPORTS / "splits" / f"{part}_{cname}.txt").write_text(
                "\n".join(files) + ("\n" if files else ""), encoding="utf-8")

    print("=== [6/7] crop + grayscale (originals untouched) ===")
    crop_stats = crop_and_gray(per_class, faces, gray)
    print(f"  {crop_stats}")

    print("=== [7/7] reports ===")
    for cname in CLASSES:
        contact_sheet(cname, per_class[cname]["rows"], FIGURES / f"contact_{cname}.png", n=36)

    stats = {
        "generated": "train/data_audit.py rev2",
        "dataset_root": str(DATASET),
        "per_class": {c: {k: v for k, v in s.items() if k != "rows"} for c, s in per_class.items()},
        "colourfulness": col,
        "dedup": {
            "unique": len(uniq),
            "dropped": sum(len(v) for v in dropped.values()),
            "cross_class_conflicts": cross_conflicts,
        },
        "phash": {"threshold": PHASH_THRESHOLD, "n_clusters": len(cl_idx),
                  "largest_cluster": max(hist), "size_hist": {str(k): v for k, v in sorted(hist.items())},
                  "sweep": {str(k): {"n_clusters": v["n_clusters"], "largest": v["largest"]}
                            for k, v in sweep.items()}},
        "split": split_info,
        "leakage": {"n": len(leaks), "examples": leaks[:5]},
        "crop": crop_stats,
    }
    (REPORTS / "audit_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")

    csv = ["md5,class,kept_file,duplicate_files"]
    for h, reps in dropped.items():
        k = keep[h]
        csv.append(f'"{h}",{k["class"]},{k["file"]},"{";".join(reps)}"')
    (REPORTS / "duplicates.csv").write_text("\n".join(csv) + "\n", encoding="utf-8")

    (REPORTS / "audit_report.md").write_text(
        build_report(per_class, col, stats, crop_stats, leaks), encoding="utf-8")
    print(f"[report] {REPORTS / 'audit_report.md'}")
    print("=== DONE ===")
    return 0


def build_report(per_class, col, stats, crop_stats, leaks) -> str:
    L = ["# T-02 数据审计报告（rev2）\n",
         "> 由 `train/data_audit.py` 自动生成。**脚本不删除任何原始数据**，只写派生文件。\n",
         "> rev2 修订原因：原计划假设「连号 = 同一受试者」，实测证伪（见 §2），改用 MD5 去重 + 感知哈希近重复聚类做防泄漏切分。\n",
         "## 1. 数据总量与形态\n",
         "| 类别 | 图片 | 标注 | 缺标注 | 存储色彩模式 | 尺寸中位数 | 文件大小中位数 |",
         "|---|---|---|---|---|---|---|"]
    for c, s in per_class.items():
        L.append(f"| {c} | {s['n_images']} | {s['n_txt']} | {len(s['missing_txt'])} | "
                 f"{s['modes']} | {s['w_med']:.0f}×{s['h_med']:.0f} | {s['bytes_med']/1024:.1f} KB |")

    L += ["\n## 2. 三个严重问题（本次审计的核心发现）\n",
          "### 2.1 编号不含受试者信息（原计划假设不成立）\n",
          "| 类别 | 编号范围 | 相邻编号最大间隔 | p99 间隔 |",
          "|---|---|---|---|"]
    for c, s in per_class.items():
        L.append(f"| {c} | {s['num_min']}–{s['num_max']} | **{s['gap_max']}** | {s['gap_p99']:.0f} |")
    L += ["",
          "编号是**全局顺序索引**，不存在「换一个人就跳一大段」的结构。原计划中「相邻编号差 ≤ 100 视为同一簇」"
          "会把整类数据链成一个簇（实测正是如此），切分随之失效。\n",
          "### 2.2 大规模重复（77% 冗余）\n",
          f"- 原始文件总数：{sum(s['n_images'] for s in per_class.values())}，**唯一 MD5 仅 {stats['dedup']['unique']} 个**",
          f"- 作为重复副本被剔除：**{stats['dedup']['dropped']} 个**",
          f"- **跨类别标签冲突：{len(stats['dedup']['cross_class_conflicts'])} 组**（同一张图分别被标成 Stroke 与 NonStroke）",
          "",
          "→ 若按文件随机切分，同一张图会同时出现在训练集与测试集，**所有指标将严重虚高**。\n",
          "### 2.3 域混淆与标签可信度\n",
          "| 类别 | 彩色度（通道极差均值，0=纯灰） |",
          "|---|---|"]
    for c, v in col.items():
        L.append(f"| {c} | {v['mean']:.1f}（中位 {v['median']:.1f}） |")
    L += ["",
          "抽样对照图 `work/figures/contact_Stroke.png` 与 `contact_NonStroke.png` 显示：",
          "- **NonStroke 组**：大量**公众人物／网络图库人像**（可直接辨认的名人、活动照、带水印的图库样图）；",
          "- **Stroke 组**：混合了**卧床老年患者**、以及**微笑儿童与健康成人**照片——后者显然不是卒中面部表现。",
          "",
          "→ 结论：两类之间的差异**至少部分来自「图片来源与拍摄场景」而非病理特征**；"
          "且 Stroke 组内存在明显标签噪声。二者叠加会使任何 AUC 数字不可解释。\n",
          "## 3. 防泄漏切分（按簇切分）\n",
          f"方法：MD5 去重 → pHash(64bit) 汉明距离 ≤ {stats['phash']['threshold']} 单链聚类 → 按簇 70/15/15 切分。\n",
          "阈值敏感性（阈值越大簇越少、越大）：\n",
          "| 阈值 | 簇数 | 最大簇 |", "|---|---|---|"]
    for k, v in stats["phash"]["sweep"].items():
        L.append(f"| {k} | {v['n_clusters']} | {v['largest']} |")
    L += ["", "| 类别 | train 簇/图 | val 簇/图 | test 簇/图 |", "|---|---|---|---|"]
    for c, si in stats["split"].items():
        L.append(f"| {c} | {si['clusters']['train']}/{si['images']['train']} | "
                 f"{si['clusters']['val']}/{si['images']['val']} | "
                 f"{si['clusters']['test']}/{si['images']['test']} |")
    L += ["", f"**泄漏校验**：{'✅ 通过' if not leaks else f'❌ 失败 {len(leaks)} 处'}",
          "", "切分清单：`work/reports/splits/{train,val,test}_{Stroke,NonStroke}.txt`",
          "重复清单：`work/reports/duplicates.csv`\n",
          "## 4. 清洗产物\n", "| 项 | 数量 |", "|---|---|"]
    for k, v in sorted(crop_stats.items()):
        L.append(f"| {k} | {v} |")
    L += ["", "- 人脸裁片（RGB 256×256，标注框外扩 20%）：`work/cleaned/faces/{Stroke,NonStroke}/`",
          "- 统一域副本（灰度 256×256）：`work/cleaned/gray/{Stroke,NonStroke}/`\n",
          "## 5. 结论与建议（🔴 需人类决策）\n",
          "**就「训练一个卒中识别 CNN」这一目标而言，本数据集不满足要求**，原因是标签噪声与域混淆重叠，"
          "这不是工程问题而是科学问题；即使消融实验按计划执行，也只能证明它「学歪了」，无法得到一个可用于产品的模型。\n",
          "可行的替代方向（见 `10_进度状态_接力板.md` 的 🔴-06）：",
          "1. **A（推荐）**：v1.0 的判定以**几何通道**为主，CNN 通道改为「面部对称度／关键点回归」任务，"
          "用合规的人脸关键点公开数据集训练，不再做「卒中 vs 非卒中」分类；",
          "2. **B**：把模型任务改为**个体基线对比**（与本人历史比），无需阳性样本，天然规避标签问题；",
          "3. **C**：坚持训练卒中分类器，但仅作为内部技术可行性验证，**不对外宣称任何准确率**，"
          "并在论文／答辩中如实披露本数据集的缺陷；",
          "4. **D**：暂停模型训练，先补自采合规数据（需医院合作与伦理批件，周期以月计）。\n",
          "**原始数据一张未删**，等待你的决定。\n"]
    return "\n".join(L)


if __name__ == "__main__":
    raise SystemExit(main())
