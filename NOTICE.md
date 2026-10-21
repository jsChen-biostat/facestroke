# 第三方组件与资源

这个项目自己没有重新发明轮子。下面列出随仓库分发的东西，以及它们的许可。

## 随仓库分发的二进制

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `web/public/mediapipe/face_landmarker.task` | [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) 官方模型 | Apache-2.0 |
| `web/android/gradle/wrapper/gradle-wrapper.jar` | Gradle Wrapper | Apache-2.0 |

## 不随仓库分发、由脚本从 npm 包复制的

`scripts/bootstrap-assets.ps1` 会把下面这些从 `node_modules` 复制到 `web/public/`。
它们不出现在 git 里，但会进最终安装包，所以声明在这里。

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `public/mediapipe/vision_wasm_*.js|.wasm` | `@mediapipe/tasks-vision` 1.0.1 | Apache-2.0 |
| `public/ort/ort-wasm-simd-threaded.wasm|.mjs` | `onnxruntime-web` 1.30.0 | MIT |

## npm 依赖

主要几个：

- `@mediapipe/tasks-vision` — Apache-2.0
- `onnxruntime-web` — MIT
- `@capacitor/*` — MIT
- `vite` — MIT

完整的依赖树和各自的许可条目以 `web/package-lock.json` 为准，`npm ls --all` 可以列出全部。

## 刻意不包含的

- **任何数据集。** 见 `docs/DATA-AND-ETHICS.md`。
- **任何训练好的模型权重。** 仓库里的 `web/public/models/` 目录只放了一个空的清单文件，
  真正的 `.onnx` 需要你自己训练导出。这样做是为了避免出现"包里有个模型但没人知道它训过什么"。

## 引用

如果你在文章里用到这个项目的算法，可以直接引方法而不是引仓库：镜像点配对由数据推导、
规范坐标系以内眼角间距为尺度、分数用参考分布的中位数与 99 分位做线性映射。
这些做法在面部不对称的文献里都很常见，本项目只是把它们拼成了一个能跑的手机应用。
