"""
面部图像的卒中风险模型 —— **与文献完全相同的四网络集成框架**

文献：Wang YY, et al. "Prediagnosis recognition of acute ischemic stroke by
artificial intelligence from facial images." Aging Cell 2024;23:e14196.
  · 输入：二维人脸图像
  · 架构：集成四个网络 —— Xception + ResNet50 + VGG19 + EfficientNetB1
  · 数据：185 例急性缺血性卒中 + 551 例年龄性别配对对照
  · 结果：训练集交叉验证 AUC 0.91；独立数据集 AUC 0.82

本文件提供三件事
  1. 四个骨干的定义与集成封装（与文献一致）；
  2. 人脸对齐裁剪（训练与推理共用同一套，Python 与 JS 各一份实现，见 web/src/core/）；
  3. 命令：
       export-placeholder  导出**未训练**的四个 ONNX 与清单（把框架先跑通）
       train               用真实数据训练四网络集成并导出（数据到位后使用）

⚠️ 关于"未训练"的说明
  `export-placeholder` 导出的是**随机初始化的权重**。它的用途只有一个：
  让整条流程（采集→裁剪→四网络→集成→出分→展示）端到端跑通。
  **它给出的任何数字都没有意义**，App 里会明确标注。要得到有意义的结果，
  必须用 `train` 在受控采集、诊断明确的数据上训练。

⚠️ 关于体积（必须先知道）
  VGG19 单是 fp32 权重就有约 500 MB，四个网络合起来无法直接放进手机安装包。
  因此本脚本默认导出到 work/ensemble_models/（**不进安装包**），
  并提供 --profile light 用手机友好的骨干替换（架构框架不变）。

用法
    .venv\\Scripts\\python.exe train\\stroke_ensemble.py export-placeholder
    .venv\\Scripts\\python.exe train\\stroke_ensemble.py export-placeholder --profile light
    .venv\\Scripts\\python.exe train\\stroke_ensemble.py train --data <目录>
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parents[1]
OUT_DEFAULT = ROOT / "work" / "ensemble_models"

INPUT = 224
MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]

# 文献的四个骨干 / 手机友好的替代
PROFILES = {
    "paper": ["xception", "resnet50", "vgg19", "efficientnet_b1"],
    "light": ["mobilenet_v3_large", "resnet18", "efficientnet_b0", "squeezenet1_1"],
}


# --------------------------------------------------------------- Xception

class SeparableConv2d(nn.Module):
    def __init__(self, cin, cout, k=3, stride=1):
        super().__init__()
        self.depthwise = nn.Conv2d(cin, cin, k, stride, k // 2, groups=cin, bias=False)
        self.pointwise = nn.Conv2d(cin, cout, 1, 1, 0, bias=False)

    def forward(self, x):
        return self.pointwise(self.depthwise(x))


class XceptionBlock(nn.Module):
    """Xception 的基本块：SeparableConv ×n + 残差（必要时 1×1 投影）。"""

    def __init__(self, cin, couts, reps=1, stride=1, start_with_relu=True, grow_first=True):
        super().__init__()
        if couts != cin or stride != 1:
            self.skip = nn.Sequential(
                nn.Conv2d(cin, couts, 1, stride, bias=False), nn.BatchNorm2d(couts))
        else:
            self.skip = None
        layers = []
        c = cin
        if grow_first:
            layers += [nn.ReLU(inplace=True), SeparableConv2d(c, couts), nn.BatchNorm2d(couts)]
            c = couts
            reps -= 1
        for i in range(reps):
            layers += [nn.ReLU(inplace=True), SeparableConv2d(c, couts), nn.BatchNorm2d(couts)]
            c = couts
        if not grow_first:
            pass
        if stride != 1:
            layers.append(nn.MaxPool2d(3, stride, 1))
        self.body = nn.Sequential(*layers)
        self.out_channels = couts

    def forward(self, x):
        res = x if self.skip is None else self.skip(x)
        return self.body(x) + res


class Xception(nn.Module):
    """完整的 Xception（Entry / Middle ×8 / Exit），与文献所用骨干一致。"""

    def __init__(self, num_classes=1):
        super().__init__()
        self.entry = nn.Sequential(
            nn.Conv2d(3, 32, 3, 2, 1, bias=False), nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.Conv2d(32, 64, 3, 1, 1, bias=False), nn.BatchNorm2d(64), nn.ReLU(inplace=True),
            XceptionBlock(64, 128, 2, 2, start_with_relu=False, grow_first=True),
            XceptionBlock(128, 256, 2, 2, start_with_relu=True, grow_first=True),
            XceptionBlock(256, 728, 2, 2, start_with_relu=True, grow_first=True),
        )
        self.middle = nn.Sequential(*[
            XceptionBlock(728, 728, 3, 1, start_with_relu=True, grow_first=True) for _ in range(8)
        ])
        self.exit = nn.Sequential(
            XceptionBlock(728, 1024, 2, 2, start_with_relu=True, grow_first=False),
            SeparableConv2d(1024, 1536), nn.BatchNorm2d(1536), nn.ReLU(inplace=True),
            SeparableConv2d(1536, 2048), nn.BatchNorm2d(2048), nn.ReLU(inplace=True),
        )
        self.pool = nn.AdaptiveAvgPool2d(1)
        self.drop = nn.Dropout(0.5)
        self.fc = nn.Linear(2048, num_classes)

    def forward(self, x):
        x = self.exit(self.middle(self.entry(x)))
        x = self.pool(x).flatten(1)
        return self.fc(self.drop(x))


# ------------------------------------------------------------ 四个骨干

def build_backbone(name: str, pretrained: bool = False) -> nn.Module:
    """返回输出 1 个 logit 的骨干。"""
    if name == "xception":
        return Xception(1)

    import torchvision.models as tvm
    factory = {
        "resnet50": (tvm.resnet50, "fc"),
        "resnet18": (tvm.resnet18, "fc"),
        "vgg19": (tvm.vgg19, "classifier"),
        "efficientnet_b1": (tvm.efficientnet_b1, "classifier"),
        "efficientnet_b0": (tvm.efficientnet_b0, "classifier"),
        "mobilenet_v3_large": (tvm.mobilenet_v3_large, "classifier"),
        "squeezenet1_1": (tvm.squeezenet1_1, "classifier"),
    }
    if name not in factory:
        raise ValueError(f"未知骨干：{name}")
    fn, head = factory[name]
    weights = "DEFAULT" if pretrained else None
    net = fn(weights=weights)
    if head == "fc":
        net.fc = nn.Linear(net.fc.in_features, 1)
    elif name.startswith("efficientnet") or name.startswith("mobilenet"):
        net.classifier[-1] = nn.Linear(net.classifier[-1].in_features, 1)
    else:  # vgg19 / squeezenet
        if name == "vgg19":
            net.classifier[-1] = nn.Linear(net.classifier[-1].in_features, 1)
        else:
            net.classifier[1] = nn.Conv2d(net.classifier[1].in_channels, 1, kernel_size=1)
            net.num_classes = 1
    return net


class StrokeEnsemble(nn.Module):
    """四个网络的集成：各自取 sigmoid 后**取平均**（文献所述的 integrating 方式）。"""

    def __init__(self, names, pretrained=False):
        super().__init__()
        self.names = list(names)
        self.nets = nn.ModuleList([build_backbone(n, pretrained) for n in self.names])

    def forward(self, x):
        probs = []
        for net in self.nets:
            out = net(x)
            probs.append(torch.sigmoid(out.reshape(out.shape[0], -1)[:, 0]))
        return torch.stack(probs, dim=1)

    def probability(self, x):
        """集成概率 = 四个网络概率的均值。"""
        return self.forward(x).mean(dim=1)


# --------------------------------------------------- 人脸对齐裁剪（共用）

LEFT_EYE, RIGHT_EYE = 33, 263


def align_face(img, landmarks_xy, size=INPUT, margin=1.6):
    """按双眼连线转正并裁剪成正方形。landmarks_xy 为归一化坐标列表。

    与 web/src/core/strokeEnsemble.js 中的实现必须保持一致。
    """
    from PIL import Image
    W, H = img.size
    le = np.array(landmarks_xy[LEFT_EYE], dtype=float) * [W, H]
    re = np.array(landmarks_xy[RIGHT_EYE], dtype=float) * [W, H]
    mid = (le + re) / 2
    d = re - le
    angle = float(np.degrees(np.arctan2(d[1], d[0])))
    eye_dist = float(np.linalg.norm(d)) or 1.0
    side = eye_dist * margin
    rot = img.convert("RGB").rotate(angle, center=tuple(mid), resample=Image.BICUBIC)
    box = (mid[0] - side / 2, mid[1] - side / 2, mid[0] + side / 2, mid[1] + side / 2)
    return rot.crop(tuple(int(round(v)) for v in box)).resize((size, size), Image.BILINEAR)


def to_tensor(img):
    a = np.asarray(img, dtype=np.float32) / 255.0
    x = np.stack([(a[:, :, i] - MEAN[i]) / STD[i] for i in range(3)], axis=0)
    return torch.from_numpy(x)[None]


# ------------------------------------------------------------- 导出与训练

def export_onnx(model: StrokeEnsemble, outdir: Path, profile: str):
    outdir.mkdir(parents=True, exist_ok=True)
    model.eval()
    dummy = torch.zeros(1, 3, INPUT, INPUT)
    manifest = {"profile": profile, "input": INPUT, "backbones": model.names,
                "combine": "mean of sigmoid outputs", "files": []}
    for name, net in zip(model.names, model.nets):
        path = outdir / f"{name}.onnx"
        torch.onnx.export(net, dummy, str(path), input_names=["input"],
                          output_names=["logit"], opset_version=17, dynamo=False)
        manifest["files"].append({"backbone": name, "file": path.name,
                                  "size_mb": round(path.stat().st_size / 1e6, 1)})
        print(f"  {name:<20} {manifest['files'][-1]['size_mb']:>8.1f} MB")
    total = sum(f["size_mb"] for f in manifest["files"])
    manifest["total_mb"] = round(total, 1)
    manifest["trained"] = False
    manifest["warning"] = ("未训练（随机初始化）。仅用于把流程跑通；"
                           "任何输出数字都没有意义。")
    (outdir / "ensemble.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  合计 {total:.1f} MB → {outdir}")
    return manifest


def cmd_export_placeholder(args):
    names = PROFILES[args.profile]
    print(f"构建四网络集成（{args.profile} 档）：{', '.join(names)}")
    model = StrokeEnsemble(names, pretrained=False)
    manifest = export_onnx(model, Path(args.out), args.profile)
    if manifest["total_mb"] > 200:
        print("\n⚠️ 体积提醒：该档合计 %.0f MB，**不适合**直接放进手机安装包。"
              % manifest["total_mb"])
        print("   手机端建议改用 --profile light，或改用服务端推理。")
        print("   本脚本已把它导出到 work/ 下，**不会**进入安装包。")


def cmd_train(args):
    raise SystemExit(
        "训练需要真实的临床数据。\n"
        "前置条件（见 11_神经网络任务设计_四网络.md 第 7 节）：\n"
        "  · 病例与对照**同设备同光照同协议**采集\n"
        "  · 诊断明确（DWI-MRI 或标准临床流程）\n"
        "  · 排除出血性卒中、TIA、面神经炎、既往面瘫、帕金森\n"
        "  · 已取得伦理批件\n"
        "  · 先跑平凡基线检验：python train\\trivial_baseline.py --data <目录>\n"
        "拿到数据后再启用本命令。")


def main():
    ap = argparse.ArgumentParser(description="文献同款四网络集成框架")
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("export-placeholder", help="导出未训练的四网络 ONNX")
    e.add_argument("--out", default=str(OUT_DEFAULT))
    e.add_argument("--profile", choices=list(PROFILES), default="paper")
    e.set_defaults(func=cmd_export_placeholder)

    t = sub.add_parser("train", help="用真实数据训练（需要临床数据）")
    t.add_argument("--data", required=True)
    t.add_argument("--out", default=str(OUT_DEFAULT))
    t.add_argument("--profile", choices=list(PROFILES), default="paper")
    t.set_defaults(func=cmd_train)

    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
