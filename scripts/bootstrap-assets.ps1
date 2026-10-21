# 把第三方 wasm 从 node_modules 复制到 web/public/
#
# 为什么需要这一步：应用是完全离线的，不向任何 CDN 请求资源。
# MediaPipe 和 onnxruntime 的 wasm 又太大（合计约 50 MB）、且能从 npm 包复现，
# 所以不入库，构建前用这个脚本就位。
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\bootstrap-assets.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$web = Join-Path $root 'web'
$nm = Join-Path $web 'node_modules'

if (-not (Test-Path $nm)) {
    Write-Host 'node_modules 不存在，先装依赖…'
    Push-Location $web
    try { npm install } finally { Pop-Location }
}

# --- MediaPipe -------------------------------------------------------------
$mpSrc = Join-Path $nm '@mediapipe/tasks-vision/wasm'
if (-not (Test-Path $mpSrc)) {
    throw "找不到 $mpSrc。请确认 web/package.json 里有 @mediapipe/tasks-vision，并已 npm install。"
}
$mpDst = Join-Path $web 'public/mediapipe'
New-Item -ItemType Directory -Force -Path $mpDst | Out-Null
Copy-Item (Join-Path $mpSrc '*') $mpDst -Force
Write-Host ("MediaPipe wasm -> public/mediapipe  ({0} 个文件)" -f (Get-ChildItem $mpDst -File | Measure-Object).Count)

if (-not (Test-Path (Join-Path $mpDst 'face_landmarker.task'))) {
    Write-Warning 'face_landmarker.task 缺失。它应该随仓库提供；如果被误删，从 MediaPipe 官方模型页重新下载。'
}

# --- onnxruntime-web -------------------------------------------------------
$ortSrc = Join-Path $nm 'onnxruntime-web/dist'
if (-not (Test-Path $ortSrc)) {
    Write-Warning '找不到 onnxruntime-web，跳过。没有它的话，模型推理这条通道会不可用，其余功能正常。'
} else {
    $ortDst = Join-Path $web 'public/ort'
    New-Item -ItemType Directory -Force -Path $ortDst | Out-Null
    foreach ($f in 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs') {
        $src = Join-Path $ortSrc $f
        if (Test-Path $src) { Copy-Item $src $ortDst -Force } else { Write-Warning "缺少 $f" }
    }
    Write-Host ("onnxruntime wasm -> public/ort  ({0} 个文件)" -f (Get-ChildItem $ortDst -File | Measure-Object).Count)
}

Write-Host ''
Write-Host '完成。接下来：'
Write-Host '  cd web && npm run dev -- --host    # 开发'
Write-Host '  或  powershell -File scripts\build-apk.ps1 -JavaHome <JDK> -AndroidSdk <SDK>'
