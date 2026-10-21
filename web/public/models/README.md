# 模型权重

这个目录在仓库里是空的（只有一个 README）。

应用会在这里找四类 `.onnx`：

| 文件 | 用途 | 从哪来 |
| --- | --- | --- |
| `mq_v1.onnx` / `mq_v1_int8.onnx` | 质量判定 | `train/train_models.py` |
| `ms_v1.onnx` / `ms_v1_int8.onnx` | 对称度 | 同上 |
| `models.json` | 上面四份的清单 | 同上 |
| `ensemble/*.onnx` + `ensemble/ensemble.json` | 四网络集成 | `train/stroke_ensemble.py export --profile light` |

**权重不随仓库分发的原因**：训练数据不能分发（见 `docs/DATA-AND-ETHICS.md`），
而一份没有训练过的权重放进包里只会让人误以为能用。

缺少这些文件时应用不会崩，而是明说"模型不可用"并退回到确定性的规则通道 ——
`core/cnn.js` 里的 `CNN_SKIP_TEXT` 就是这些提示文案。

自己训练的话：

```bash
cd train
python train_models.py --help
python stroke_ensemble.py export --profile light    # 只导出占位结构，用于联调
```

`stroke_ensemble.py` 的 `train` 子命令在拿到同源、纵向、带结局的数据之前是拒绝执行的，
这是刻意的。
