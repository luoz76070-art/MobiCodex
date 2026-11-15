# MobiCodex 0.3.1（versionCode 42）

2026-11-15 · Android 6.0+ · 包名 `com.mobilecodex.app`

## 这一版

- **任务完成通知弹出并震动**：任务完成、失败或中断时，通知在屏幕上方弹出横幅并震动，提示音用系统默认；点横幅直接进对应线程，锁屏上仍只显示「有任务需要你查看」。
  - 升级后旧的「任务完成」通知类别自动换成新的；之前在系统里关掉过的，仍保持关闭。
  - 「设置 → 通知」会显示弹出或震动有没有被系统关掉，并能直接打开这类通知的系统设置。有的手机还要在系统里单独打开「悬浮通知」（或「横幅」）。
- **CC Desk 会话**：在 Agent 页查看电脑上 CC Desk 的会话并跟随输出，可以发消息、处理审批与提问、停止。
- 修复：手机发起的线程里，一轮在后台结束后回到 App，「正在恢复连接」的提示一直不消失。

**电脑端**：通知弹出和修复只需要新 APK。CC Desk 会话需要电脑端运行打了补丁的 CC Desk 副本（见 [integrations/cc-desk](../../../../integrations/cc-desk/README.md)），并用本版源码重新构建网关。

## 安装

1. 用下载页的安装包覆盖安装 0.3.0（同一签名，数据保留）。
2. 要用 CC Desk 会话：按[网关管理](../../../../plugins/mobile-codex/README.md)用本版源码构建网关（`corepack pnpm build:plugin`），沿用原配置和工作目录切换到新程序。

## 发布结果

2026-11-15 发布。

- **GitHub Release** `mobicodex-v0.3.1`（Actions run 43728957275，成功；同一提交的 CI run 43728952817 也通过）：APK、界面包、两份清单和 `SHA256SUMS`。
- **安装包** `mobile-codex-0.3.1-152e239f3493.apk`，3,431,646 字节，SHA-256 `152e239f3493bc9a60cae070ac89051ef5c603e97e5af77de44c6bf41c86c95e`，versionCode 42。
  - 签名证书 SHA-256 `3ffb81f3524a590f469b80476951a22fbc6e441a470b9270079a8c1d452c4a38`，与 0.3.0 相同，可以直接覆盖安装。
  - 字节数和 0.3.0 碰巧相同，校验值不同，包内已有新的「任务完成」通知类别。
- **下载页** https://zyzlz.xin/mobile-codex/releases/android/preview/index.html 已换成 0.3.1（旧页面在服务器上备份）。
  - 更新清单 `preview/latest.json` 指向 0.3.1（code 42），0.3.0 的清单移到 `previous.json`。
  - 界面更新通道（`hot/latest.json`）没有改。
- **发布后核对**
  - 从公网下载的 APK 与 CI 产物逐字节相同；分段下载返回 206，跨域头正常。
  - 线上清单为 0.3.1 / 42，大小和校验值一致；`previous.json` 为 0.3.0 / 41。
  - 服务器上 preview 目录只多了本版 APK，并替换了 `index.html`、`latest.json`、`previous.json`。
- **验证**
  - 通知弹出和震动已在合并前用调试包在 Android 模拟器上验收，包括升级后换成新类别、横幅弹出、系统记录到通知震动、点横幅进线程、设置提示和跳转。
  - 「正在恢复连接」的修复同时在模拟器上确认过。
  - CC Desk 会话已在真机上验收。
  - 本次正式包没有再单独上模拟器。
