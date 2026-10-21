# 安全问题

## 报告漏洞

别开公开 issue。用 GitHub 的 [Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
（仓库 Security 页 → Report a vulnerability），或者直接发邮件给维护者。

我们关心的几类问题：

- 照片或人脸数据被写到了意料之外的地方（文件、缓存、日志、崩溃报告）
- 应用在没有网络的情况下尝试外连
- 通过畸形图片触发的内存问题或崩溃
- 权限声明与实际行为不一致

## 这个应用的安全模型

说清楚它依赖什么，才知道哪些不算漏洞：

- **没有后端。** 没有账号、没有 API、没有遥测。唯一的网络访问是加载本地打包的 wasm，走的是自有 origin。
  如果发现任何指向外部的请求，那就是 bug，请报。
- **数据不出应用沙箱。** 照片在内存里解码、分析完即丢，不写相册也不写外部存储。
  测量记录存在 WebView 的 localStorage 里，随卸载清除。
- **Android 权限**：`CAMERA` 是必需的；`VIBRATE` 用于操作反馈；
  `READ/WRITE_EXTERNAL_STORAGE` 是旧版 Capacitor 模板留下的，只在 API 32 及以下生效，新系统不会授予。
  看到别的权限请报。
- **WebView 调试**在 debug 构建里是开着的（`webContentsDebuggingEnabled: true`），
  发布版必须关掉，这一条在发版清单里。

## 不在这套模型里的

- 设备被 root、WebView 被替换、系统级录屏。
- 用户自己选错照片。这不是安全问题，是可用性问题。
- **测量结果本身不可靠**。这一条属于 `docs/LIMITATIONS.md`，不属于安全。
