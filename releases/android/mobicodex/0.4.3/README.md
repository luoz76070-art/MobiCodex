# MobiCodex 0.4.3（versionCode 46）

2026-11-19 · Android 6.0+ · 包名 `com.mobilecodex.app`

## 这一版

- **修复“事项”打不开**（0.4.2 引入，#50）：0.4.2 里点“事项”或“新建事项”不显示弹窗，现在恢复正常。另外新增一项检查，以后删样式时不会再把还在用的弹窗样式一起删掉。

0.4.2 的其他改动（新建会话只留一个入口、运行策略分两行、Claude CLI 连续对话、电脑端插件 0.3.0）见 [0.4.2 版本说明](../0.4.2/README.md)。完整列表见[更新说明](../../../../CHANGELOG.md)。

**电脑端**：这一版不用动。从 0.4.1 或更早升级并且用 Claude CLI 的话，按 0.4.2 的说明重新构建网关。

## 安装

1. 用下载页的安装包覆盖安装 0.4.2 或更早的版本（同一签名，数据保留）。
2. 从 0.4.1 或更早升级并且用 Claude CLI：按[网关管理](../../../../plugins/mobile-codex/README.md)用本版源码构建网关（`corepack pnpm build:plugin`），沿用原配置和工作目录切换到新程序。

## 发布结果

2026-11-19 发布。

- **GitHub Release** `mobicodex-v0.4.3`（Actions run 44357342536，成功；同一提交的 CI run 44356848793 通过）：APK、界面包、两份清单和 `SHA256SUMS`。
- **安装包** `mobile-codex-0.4.3-e2c6c270c0c8.apk`，3,443,934 字节，SHA-256 `e2c6c270c0c8b7541fc6582ad183769e413ce71862714e66a879537f400d2576`，versionCode 46。
  - 签名证书 SHA-256 `3ffb81f3524a590f469b80476951a22fbc6e441a470b9270079a8c1d452c4a38`，与 0.4.2 相同，可以直接覆盖安装。
  - 界面包里有恢复的弹窗样式（`.handoff-scrim` 是 `position:fixed`），0.4.2 的界面包里没有。
- **下载页** https://zyzlz.xin/mobile-codex/releases/android/preview/index.html 已换成 0.4.3（旧页面在服务器上备份）。
  - 更新清单 `preview/latest.json` 指向 0.4.3（code 46），0.4.2 的清单移到 `previous.json`。
  - 服务器上只留 0.4.2 和 0.4.3 两个安装包；0.4.1 的安装包已从服务器移除，GitHub Releases 上的同名文件仍可下载。
  - 界面更新通道（`hot/latest.json`）没有改。
- **电脑端插件**：`codex-plugin` 分支已更新到 0.4.3 的构建。和 0.4.2 那次相比只差一行，就是随机生成的网关实例 id。
- **发布后核对**：从公网下载的 APK 与 CI 产物逐字节相同；分段下载返回 206；线上清单为 0.4.3 / 46，`previous.json` 为 0.4.2 / 45。
- **还要确认**：真机上点“事项”和“新建事项”，看弹窗是否正常。
