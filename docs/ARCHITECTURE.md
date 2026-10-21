# 架构

## 一句话

一个 Vite 打包的纯前端应用，通过 Capacitor 装进 Android 的 WebView 里跑。
没有后端，没有框架（不用 React / Vue），页面是 12 个导出函数，路由是 60 行哈希路由。

不上框架是刻意的：这套东西的状态很少，页面之间几乎不共享状态，用框架反而要花时间在
"这层抽象到底帮我省了什么"上。现在的代价是所有 DOM 都得手动查、手动绑事件，
所以有一个静态检查脚本专门盯"模板里的 id 改了但绑定没改"这类错误。

## 数据流

```
摄像头 / 相册
     │
     ▼
┌──────────────────────────────────────────────┐
│ 采集层  screens/s5_capture                    │
│  · 实时取景，逐帧出 478 点                     │
│  · 质量门控（core/quality）：亮度/清晰/偏航/占比 │
│  · 过关后倒计时，连拍多帧，选最锐的几张          │
└──────────────────┬───────────────────────────┘
                   ▼
┌──────────────────────────────────────────────┐
│ 计算层  screens/s6_analyze                    │
│  · core/symmetry    几何通道 → 四区均值 → 分数  │
│  · core/asymmetryModel  镜像点距离差 → MLP      │
│  · core/cnn / strokeEnsemble  可选的四网络通道  │
│  · core/fusion      两路合并（极性一致才合并）   │
└──────────────────┬───────────────────────────┘
                   ▼
┌──────────────────────────────────────────────┐
│ 呈现层  core/report + screens/s7_result       │
│  · 文案从 report.js 出，测试会扫禁用词          │
│  · core/policy 做上限与拦截（动作测试测不到就降级）│
│  · core/knowledge 出知识条目与建议，附出处       │
└──────────────────┬───────────────────────────┘
                   ▼
        core/storage（localStorage）+ core/trend（趋势）
```

## 模块分工

| 模块 | 职责 | 值得注意的地方 |
| --- | --- | --- |
| `core/landmarks.js` | 加载 MediaPipe、出关键点 | 自己 fetch 成 blob URL 再交给 MediaPipe，绕开 Android AssetManager 不规范化 `//` 的坑 |
| `core/symmetry.js` | 几何通道 | `CALIBRATION` 标了 `provisional: true`，换数据必须重标 |
| `core/mirror_pairs.js` | 220 对镜像点 + 分区统计 | 自动生成，不要手改；来源是 `train/derive_mirror_pairs.py` |
| `core/quality.js` | 确定性质量门控 | 阈值从"故意拍坏"的对照集标出来的，避免全拒蒙对 |
| `core/cnn.js` | 质量/对称度两个小模型 | 只 import `onnxruntime-web/wasm`，别 import 全量包，会拖进 WebGPU |
| `core/strokeEnsemble.js` | 四网络集成 | 清单驱动；权重不入库，缺了就明说缺 |
| `core/fusion.js` | 两路合成 | 极性必须一致，冲突时不取平均而是拒答 |
| `core/policy.js` | 结果上限与降级 | 动作测试没测到时不允许出高等级结论 |
| `core/report.js` | 文案与报告 | `BANNED_PATTERNS` 是红线，测试直接读它 |
| `core/knowledge.js` | 知识库 | 每条都带出处；没有出处的话不写 |
| `core/storage.js` | 记录 | localStorage，卸载即清 |

## 三条不肯让步的约束

1. **照片不出设备。** 没有上传路径，也没有"为了改进模型偷偷传一份"的开关。想收集数据只能靠用户主动导出。
2. **结果不出现概率和颜色分档。** 输出形状决定理解方式：给百分比会被当成发病概率。
3. **前端不许出现"诊断/筛查/预测"这类词。** 有测试盯着，不是靠自觉。

## 关于 WebView 的两个现实

- **白平衡锁不住。** Capacitor 的相机走 `getUserMedia`，拿不到 Camera2 的 `CONTROL_AWB_LOCK`。
  颜色测量的可比性因此受限于"同光位同设备"。要突破得写原生插件。
- **wasm 加载路径敏感。** Android 的资产加载器不做路径规范化，任何带 `//` 或以 `/` 开头的拼接都会失败。
  `landmarks.js` 顶部的长注释就是这件事的尸检报告，改动那块之前请先读。
