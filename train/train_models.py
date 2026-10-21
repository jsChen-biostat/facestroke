"""T-06 (part 2): train M-Q (capture quality) and M-S (symmetry score), export ONNX.

Spec: facestroke-build/05b_CNN任务修订_对称度与质量模型.md

Backbone note
-------------
05b says ResNet18. We use MobileNetV3-Small instead, because the SAME spec caps
the exported model at < 5 MB and < 800 ms on a phone: ResNet18 is ~45 MB fp32 /
~12 MB int8, MobileNetV3-Small is ~10 MB fp32 / ~2.5 MB int8. Recorded as a
deliberate deviation in 05b and in the commit message.

RED LINES honoured here
-----------------------
  - NO horizontal-flip augmentation (the task measures left/right asymmetry)
  - NO strong colour jitter (colour is a known shortcut signal)
  - splits come from the T-02 cluster split, so base images never straddle sets

Run: .venv\\Scripts\\python.exe train\\train_models.py
"""

from __future__ import annotations

import csv
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from scipy.stats import spearmanr, pearsonr
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights

sys.stdout.reconfigure(encoding="utf-8")

APP = Path(__file__).resolve().parents[1]
SYNTH = APP / "work" / "synth"
MANIFESTS = SYNTH / "manifests"
MODELS = APP / "work" / "models"
WEBMODELS = APP / "web" / "public" / "models"
REPORTS = APP / "work" / "reports"

SEED = 42
TRAIN_SIZE = 224      # training resolution
EXPORT_SIZE = 160     # on-device resolution
BATCH = 32
THREADS = 16
QUALITY_CLASSES = ["ok", "too_dark", "too_bright", "blurry", "occluded", "turned"]

# augmentation deliberately excludes horizontal flip
TRAIN_TF = transforms.Compose([
    transforms.Resize((TRAIN_SIZE, TRAIN_SIZE)),
    transforms.RandomAffine(degrees=5, translate=(0.05, 0.05), scale=(0.95, 1.05)),
    transforms.ColorJitter(brightness=0.10, contrast=0.10),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])
EVAL_TF = transforms.Compose([
    transforms.Resize((TRAIN_SIZE, TRAIN_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])


class ManifestDataset(Dataset):
    def __init__(self, rows: list[dict], root: Path, tf, label_key: str, label_map=None):
        self.rows = rows
        self.root = root
        self.tf = tf
        self.label_key = label_key
        self.label_map = label_map

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        p = self.root / r["path"]
        with Image.open(p) as im:
            x = self.tf(im.convert("RGB"))
        raw = r[self.label_key]
        y = self.label_map[raw] if self.label_map else float(raw)
        if not self.label_map:
            y = y / 100.0  # regression target in 0..1
        return x, torch.tensor(y, dtype=torch.long if self.label_map else torch.float32)


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def build_model(n_out: int) -> nn.Module:
    m = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.IMAGENET1K_V1)
    for p in m.features.parameters():
        p.requires_grad = False
    in_f = m.classifier[3].in_features
    m.classifier[3] = nn.Linear(in_f, n_out)
    return m


def unfreeze_last_blocks(m: nn.Module, n_blocks: int = 2) -> None:
    blocks = list(m.features.children())
    for b in blocks[-n_blocks:]:
        for p in b.parameters():
            p.requires_grad = True


def run_epoch(model, loader, crit, opt, train: bool) -> tuple[float, list, list]:
    model.train(train)
    total, n = 0.0, 0
    preds, targets = [], []
    for x, y in loader:
        if train:
            opt.zero_grad()
        with torch.set_grad_enabled(train):
            out = model(x)
            if out.ndim == 2 and out.shape[1] > 1:
                loss = crit(out, y)
                p = out.argmax(1)
            else:
                out = out.squeeze(1)
                loss = crit(out, y)
                p = out
        if train:
            loss.backward()
            opt.step()
        total += float(loss.item()) * len(y)
        n += len(y)
        preds.extend(p.detach().cpu().numpy().tolist())
        targets.extend(y.detach().cpu().numpy().tolist())
    return total / max(1, n), preds, targets


def quality_metrics(preds, targets) -> dict:
    preds = np.array(preds)
    targets = np.array(targets)
    acc = float((preds == targets).mean()) if len(targets) else 0.0
    cm = np.zeros((len(QUALITY_CLASSES), len(QUALITY_CLASSES)), dtype=int)
    for t, p in zip(targets, preds):
        cm[int(t), int(p)] += 1
    recalls = {}
    for i, c in enumerate(QUALITY_CLASSES):
        tot = cm[i].sum()
        recalls[c] = float(cm[i, i] / tot) if tot else 0.0
    return {"accuracy": acc, "recall": recalls, "confusion": cm.tolist()}


def regression_metrics(preds, targets) -> dict:
    p = np.array(preds) * 100.0
    t = np.array(targets) * 100.0
    if len(t) < 2:
        return {"mae": None}
    mae = float(np.abs(p - t).mean())
    rho = float(spearmanr(t, p).statistic)
    r = float(pearsonr(t, p)[0])
    bins = [(0, 20), (20, 40), (40, 60), (60, 80), (80, 101)]
    by_bin = {}
    for lo, hi in bins:
        m = (t >= lo) & (t < hi)
        by_bin[f"{lo}-{hi}"] = {
            "n": int(m.sum()),
            "mae": float(np.abs(p[m] - t[m]).mean()) if m.sum() else None,
        }
    return {"mae": mae, "spearman": rho, "pearson": r, "by_bin": by_bin}


def train_quality() -> dict:
    print("\n=== M-Q: capture quality (6 classes) ===")
    tr = read_csv(MANIFESTS / "quality_train.csv")
    va = read_csv(MANIFESTS / "quality_val.csv")
    te = read_csv(MANIFESTS / "quality_test.csv")
    lmap = {c: i for i, c in enumerate(QUALITY_CLASSES)}

    trl = DataLoader(ManifestDataset(tr, APP, TRAIN_TF, "label", lmap), batch_size=BATCH, shuffle=True, num_workers=0)
    val = DataLoader(ManifestDataset(va, APP, EVAL_TF, "label", lmap), batch_size=BATCH, num_workers=0)
    tel = DataLoader(ManifestDataset(te, APP, EVAL_TF, "label", lmap), batch_size=BATCH, num_workers=0)

    model = build_model(len(QUALITY_CLASSES))
    crit = nn.CrossEntropyLoss()
    best = {"acc": -1.0, "state": None, "epoch": -1}

    def fit(epochs, lr, tag):
        opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=lr, weight_decay=1e-4)
        for e in range(epochs):
            t0 = time.time()
            tr_loss, _, _ = run_epoch(model, trl, crit, opt, True)
            va_loss, vp, vt = run_epoch(model, val, crit, opt, False)
            m = quality_metrics(vp, vt)
            print(f"  [{tag}] epoch {e + 1}/{epochs} train_loss={tr_loss:.4f} val_loss={va_loss:.4f} val_acc={m['accuracy']:.4f} ({time.time() - t0:.0f}s)")
            if m["accuracy"] > best["acc"]:
                best.update(acc=m["accuracy"], epoch=e, state={k: v.clone() for k, v in model.state_dict().items()})

    fit(6, 1e-3, "head")
    unfreeze_last_blocks(model, 2)
    fit(4, 2e-4, "finetune")

    if best["state"]:
        model.load_state_dict(best["state"])
    _, tp, tt = run_epoch(model, tel, crit, None, False)
    test = quality_metrics(tp, tt)
    print(f"  TEST accuracy={test['accuracy']:.4f}")
    for c, r in test["recall"].items():
        print(f"    recall {c:<11} {r:.3f}")

    MODELS.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), MODELS / "mq_v1.pt")
    return {"model": model, "val_acc": best["acc"], "test": test, "classes": QUALITY_CLASSES}


def train_symmetry() -> dict:
    print("\n=== M-S: symmetry score regression ===")
    tr = read_csv(MANIFESTS / "symmetry_train.csv")
    va = read_csv(MANIFESTS / "symmetry_val.csv")
    te = read_csv(MANIFESTS / "symmetry_test.csv")

    trl = DataLoader(ManifestDataset(tr, APP, TRAIN_TF, "score"), batch_size=BATCH, shuffle=True, num_workers=0)
    val = DataLoader(ManifestDataset(va, APP, EVAL_TF, "score"), batch_size=BATCH, num_workers=0)
    tel = DataLoader(ManifestDataset(te, APP, EVAL_TF, "score"), batch_size=BATCH, num_workers=0)

    model = build_model(1)
    crit = nn.SmoothL1Loss()
    best = {"rho": -2.0, "state": None, "epoch": -1}

    def fit(epochs, lr, tag):
        opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=lr, weight_decay=1e-4)
        for e in range(epochs):
            t0 = time.time()
            tr_loss, _, _ = run_epoch(model, trl, crit, opt, True)
            va_loss, vp, vt = run_epoch(model, val, crit, opt, False)
            m = regression_metrics(vp, vt)
            rho = m.get("spearman")
            print(f"  [{tag}] epoch {e + 1}/{epochs} train_loss={tr_loss:.4f} val_loss={va_loss:.4f} val_MAE={m['mae']:.2f} rho={rho:.3f} ({time.time() - t0:.0f}s)")
            if rho is not None and rho > best["rho"]:
                best.update(rho=rho, epoch=e, state={k: v.clone() for k, v in model.state_dict().items()})

    fit(8, 1e-3, "head")
    unfreeze_last_blocks(model, 2)
    fit(4, 2e-4, "finetune")

    if best["state"]:
        model.load_state_dict(best["state"])
    _, tp, tt = run_epoch(model, tel, crit, None, False)
    test = regression_metrics(tp, tt)
    print(f"  TEST MAE={test['mae']:.2f} spearman={test['spearman']:.3f} pearson={test['pearson']:.3f}")
    for k, v in test["by_bin"].items():
        print(f"    bin {k:<8} n={v['n']:<4} MAE={v['mae'] if v['mae'] is None else round(v['mae'], 2)}")

    MODELS.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), MODELS / "ms_v1.pt")
    return {"model": model, "val_rho": best["rho"], "test": test}


def export_onnx(model: nn.Module, path: Path, n_out: int) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    model.eval()
    dummy = torch.randn(1, 3, EXPORT_SIZE, EXPORT_SIZE)
    torch.onnx.export(
        model, dummy, str(path),
        opset_version=17,
        input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        dynamo=False,
    )
    size_mb = path.stat().st_size / (1024 * 1024)

    # numeric verification: ONNX Runtime vs PyTorch
    import onnxruntime as ort
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    x = torch.randn(2, 3, EXPORT_SIZE, EXPORT_SIZE)
    with torch.no_grad():
        ref = model(x).numpy()
    got = sess.run(None, {"input": x.numpy()})[0]
    max_diff = float(np.abs(ref - got).max())
    print(f"  exported {path.name}: {size_mb:.2f} MB, max|torch-onnx| = {max_diff:.2e}")
    return {"file": path.name, "size_mb": round(size_mb, 2), "max_diff": max_diff, "n_out": n_out}


def quantize(src: Path, dst: Path) -> dict:
    from onnxruntime.quantization import quantize_dynamic, QuantType
    quantize_dynamic(str(src), str(dst), weight_type=QuantType.QUInt8)
    return {"file": dst.name, "size_mb": round(dst.stat().st_size / (1024 * 1024), 2)}


def main() -> int:
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    random.seed(SEED)
    torch.set_num_threads(THREADS)
    MODELS.mkdir(parents=True, exist_ok=True)
    REPORTS.mkdir(parents=True, exist_ok=True)
    WEBMODELS.mkdir(parents=True, exist_ok=True)

    print(f"threads={THREADS} train_size={TRAIN_SIZE} export_size={EXPORT_SIZE}")

    q = train_quality()
    s = train_symmetry()

    print("\n=== export ===")
    q_onnx = export_onnx(q["model"], WEBMODELS / "mq_v1.onnx", len(QUALITY_CLASSES))
    s_onnx = export_onnx(s["model"], WEBMODELS / "ms_v1.onnx", 1)
    q_q = quantize(WEBMODELS / "mq_v1.onnx", WEBMODELS / "mq_v1_int8.onnx")
    s_q = quantize(WEBMODELS / "ms_v1.onnx", WEBMODELS / "ms_v1_int8.onnx")
    print(f"  int8: {q_q['file']} {q_q['size_mb']} MB / {s_q['file']} {s_q['size_mb']} MB")

    meta = {
        "generated": "train/train_models.py",
        "backbone": "mobilenet_v3_small (IMAGENET1K_V1), frozen trunk + last 2 blocks fine-tuned",
        "train_size": TRAIN_SIZE, "export_size": EXPORT_SIZE,
        "seed": SEED,
        "horizontal_flip_augmentation": False,
        "quality": {"classes": QUALITY_CLASSES, "val_acc": q["val_acc"], "test": q["test"], "onnx": q_onnx, "int8": q_q},
        "symmetry": {"val_spearman": s["val_rho"], "test": s["test"], "onnx": s_onnx, "int8": s_q},
    }
    (REPORTS / "model_training.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    # model fingerprint consumed by the web app
    (WEBMODELS / "models.json").write_text(json.dumps({
        "geo": "geo-v1.0",
        "cnn": "cnn-v1.0",
        "fusion": "fusion-1.0",
        "quality": {"file": "mq_v1.onnx", "classes": QUALITY_CLASSES, "input": EXPORT_SIZE},
        "symmetry": {"file": "ms_v1.onnx", "input": EXPORT_SIZE, "scale": 100},
        "trained_on": "synthetic set built from cleaned dataset base images (labels discarded)",
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    md = [
        "# T-06 模型训练报告\n",
        "> 由 `train/train_models.py` 生成。\n",
        "## 1. 设置\n",
        f"- 骨干：MobileNetV3-Small（ImageNet 预训练），冻结主干 + 微调最后 2 个 block",
        f"- 训练分辨率 {TRAIN_SIZE}，导出分辨率 {EXPORT_SIZE}；随机种子 {SEED}",
        "- **未使用水平翻转增强**（本任务的核心信号就是左右不对称）",
        "- **未使用强颜色抖动**（颜色是已知的捷径信号）",
        "- 切分沿用 T-02 的簇级切分，底图不跨集合\n",
        "## 2. M-Q 采集质量判别（6 类）\n",
        f"- 验证集准确率：**{q['val_acc']:.4f}**",
        f"- 测试集准确率：**{q['test']['accuracy']:.4f}**\n",
        "| 类别 | 召回率 |", "|---|---|",
    ]
    for c, r in q["test"]["recall"].items():
        md.append(f"| {c} | {r:.3f} |")
    md += ["", "混淆矩阵（行=真实，列=预测）：\n", "```"]
    hdr = "        " + " ".join(f"{c[:8]:>8}" for c in QUALITY_CLASSES)
    md.append(hdr)
    for i, c in enumerate(QUALITY_CLASSES):
        md.append(f"{c[:8]:>8} " + " ".join(f"{v:>8}" for v in q["test"]["confusion"][i]))
    md += ["```", "", "## 3. M-S 对称度回归\n",
           f"- 验证集 Spearman ρ：**{s['val_rho']:.3f}**",
           f"- 测试集 MAE：**{s['test']['mae']:.2f} 分**（0–100 口径）",
           f"- 测试集 Spearman ρ：**{s['test']['spearman']:.3f}**，Pearson r：{s['test']['pearson']:.3f}\n",
           "**按分数区间分箱的 MAE**（说明模型在哪个区间才可信）：\n",
           "| 真实分数区间 | 样本数 | MAE |", "|---|---|---|"]
    for k, v in s["test"]["by_bin"].items():
        mae_txt = "—" if v["mae"] is None else f"{v['mae']:.2f}"
        md.append(f"| {k} | {v['n']} | {mae_txt} |")
    md += ["", "## 4. 导出与端侧预算\n",
           "| 模型 | ONNX 体积 | INT8 体积 | PyTorch↔ONNX 最大差 |", "|---|---|---|---|",
           f"| M-Q | {q_onnx['size_mb']} MB | {q_q['size_mb']} MB | {q_onnx['max_diff']:.2e} |",
           f"| M-S | {s_onnx['size_mb']} MB | {s_q['size_mb']} MB | {s_onnx['max_diff']:.2e} |",
           "", "## 5. 必须写进论文/答辩的局限\n",
           "1. 训练数据是**合成**的：底图取自公开数据集（来源合法性未解决，仅限内部研发，不得对外分发、不得用于器械注册）；",
           "2. 合成形变（尤其大振幅 all 区域）看起来更像整体扭曲，不等于真实面部下垂；",
           "3. 遮挡类用纯色矩形构造，与真实口罩的纹理不同；",
           "4. M-Q 与 M-S **都不是疾病判别器**，M-S 只是「对称度的像素级估计器」；",
           "5. 底图缺年龄/性别/肤色标注，无法评估公平性；",
           "6. 簇级切分只能消除近重复，仍可能有同一人的不同照片跨集合；",
           "7. 尚未做任何真实世界外部验证。\n"]
    (REPORTS / "model_training_report.md").write_text("\n".join(md), encoding="utf-8")
    print(f"\n[report] {REPORTS / 'model_training_report.md'}")
    print("=== DONE ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
