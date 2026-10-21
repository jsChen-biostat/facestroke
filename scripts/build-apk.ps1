# 构建 debug APK
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1 `
#       -JavaHome "C:\Program Files\Java\jdk-17" `
#       -AndroidSdk "$env:LOCALAPPDATA\Android\Sdk"
#
# 不传参数时会试着用环境变量 JAVA_HOME / ANDROID_HOME。

param(
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$AndroidSdk = $env:ANDROID_HOME
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$web = Join-Path $root 'web'

if (-not $JavaHome -or -not (Test-Path $JavaHome)) {
    throw '没找到 JDK。用 -JavaHome 指定，或先设置 JAVA_HOME。Capacitor 8 需要 JDK 17 或更高。'
}
if (-not $AndroidSdk -or -not (Test-Path $AndroidSdk)) {
    throw '没找到 Android SDK。用 -AndroidSdk 指定，或先设置 ANDROID_HOME。'
}
if (-not (Test-Path (Join-Path $web 'node_modules'))) {
    throw 'web/node_modules 不存在，先 cd web && npm install'
}
if (-not (Test-Path (Join-Path $web 'public/mediapipe/vision_wasm_internal.wasm'))) {
    throw '第三方 wasm 还没就位，先跑 scripts\bootstrap-assets.ps1'
}

$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $AndroidSdk
$env:ANDROID_SDK_ROOT = $AndroidSdk
$env:PATH = "$JavaHome\bin;$AndroidSdk\platform-tools;$env:PATH"
$env:CI = '1'

Write-Host '=== [1/4] 前端构建 ==='
Push-Location $web
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "vite build 失败（exit $LASTEXITCODE）" }

    Write-Host '=== [2/4] cap sync android ==='
    & npx cap sync android
    if ($LASTEXITCODE -ne 0) { throw "cap sync 失败（exit $LASTEXITCODE）" }

    Write-Host '=== [3/4] assembleDebug ==='
    Push-Location (Join-Path $web 'android')
    try {
        & .\gradlew.bat assembleDebug --no-daemon --console=plain
        if ($LASTEXITCODE -ne 0) { throw "gradle 失败（exit $LASTEXITCODE）" }
    } finally {
        Pop-Location
    }
} finally {
    Pop-Location
}

$apk = Join-Path $web 'android/app/build/outputs/apk/debug/app-debug.apk'
if (-not (Test-Path $apk)) { throw "构建结束但没找到 APK：$apk" }

$out = Join-Path $root 'apk'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$dest = Join-Path $out 'app-debug.apk'
Copy-Item $apk $dest -Force

$hash = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash
Write-Host ''
Write-Host ("APK    : {0}" -f $dest)
Write-Host ("size   : {0:N2} MB" -f ((Get-Item $dest).Length / 1MB))
Write-Host ("sha256 : {0}" -f $hash)
Write-Host ''
Write-Host '这是 debug 包，用调试密钥签名，不能上架。装到手机：adb install -r ' + $dest
