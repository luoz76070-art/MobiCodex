# MobiCodex 0.4.2（versionCode 45）

2026-11-19 · Android 6.0+ · 包名 `com.mobilecodex.app`

## 这一版

- **Claude CLI 可以连续对话了**（电脑端网关）：手机上发起的一轮结束后，马上接着发下一条，不会再报“会话忙”；会话列表也不再误显示“电脑上开着”。
- **新建会话只留一个入口**（#31）：去掉每个项目分组下面的“在这个项目里新建”按钮；点顶部“新线程”后从电脑上的项目列表里选，当前项目排在最前并标出，点哪个就在哪个项目里新建。
- **运行策略更好懂**（#38）：设置里的“运行策略（仅 Codex）”收进可展开的一栏，分两行写清“执行前要不要问我”（直接执行 / 需要时问我）和“能改哪些文件”（只读 / 工程内 / 不限）。含义和默认值不变。
- **电脑端插件 0.3.0**（#22）：命令行和网关移进技能目录，从插件目录站（如 awesome-codex-plugins）装上就能直接运行；补了图标、截图和[隐私说明](../../../../plugins/mobile-codex/PRIVACY.md)。每次正式发版，构建好的插件会推到仓库的 `codex-plugin` 分支。
- **代码清理**（#44）：去掉手机端只在 Kelivo 宿主里运行的旧代码，App 行为不变。

完整列表见[更新说明](../../../../CHANGELOG.md)。

**电脑端**：用 Claude CLI 的话，需要用本版源码重新构建网关；其余改动只要装新 App。

## 安装

1. 用下载页的安装包覆盖安装 0.4.1（同一签名，数据保留）。
2. 用 Claude CLI 的话，按[网关管理](../../../../plugins/mobile-codex/README.md)用本版源码构建网关（`corepack pnpm build:plugin`），沿用原配置和工作目录切换到新程序。插件 0.3.0 起网关文件在 `mobile-codex/skills/mobile-codex/lib/gateway.mjs`，`mobile-codex/scripts/mobile-codex.mjs` 这个入口不变。

## 发布结果

2026-11-19 发布。

- **GitHub Release** `mobicodex-v0.4.2`（Actions run 44350231606，成功；同一提交的 CI run 44349725584 两个任务都通过：类型检查、lint、构建、隔离检查，以及 Android 调试包和 lint）：APK、界面包、两份清单和 `SHA256SUMS`。
- **安装包** `mobile-codex-0.4.2-83f060a6ba3e.apk`，3,443,934 字节，SHA-256 `83f060a6ba3e428b5052b72b3554b28158f7d08d30bbd3debc6e1ac00df31bbf`，versionCode 45。
  - 签名证书 SHA-256 `3ffb81f3524a590f469b80476951a22fbc6e441a470b9270079a8c1d452c4a38`，与 0.4.1 相同，可以直接覆盖安装。
- **下载页** https://zyzlz.xin/mobile-codex/releases/android/preview/index.html 已换成 0.4.2（旧页面在服务器上备份）。
  - 更新清单 `preview/latest.json` 指向 0.4.2（code 45），0.4.1 的清单移到 `previous.json`。
  - 服务器上只留 0.4.1 和 0.4.2 两个安装包；0.4.0 的安装包已从服务器移除，GitHub Releases 上的同名文件仍可下载。
  - 界面更新通道（`hot/latest.json`）没有改。
- **电脑端插件**：发版工作流把构建好的插件推到了 `codex-plugin` 分支（单个提交）。分支内容和本版源码构建的结果一致，只差每次构建随机生成的网关实例 id。
  - 用 plugin-scanner 3.59.0 扫了两次：分支根目录、目录站生成器做出的安装包，都是 94/100。
  - 已向 awesome-codex-plugins 提交收录（#22），目录站的检查全部通过，等维护者合并。
- **发布后核对**：从公网下载的 APK 与 CI 产物逐字节相同；分段下载返回 206；线上清单为 0.4.2 / 45，`previous.json` 为 0.4.1 / 44。
- **发布后发现的问题**：点“事项”或“新建事项”不显示弹窗。原因是 #44 删掉了这两个弹窗共用的样式，已在 #50 修复，随 0.4.3 发布。
- **还要确认**：新建会话的项目列表（#31）需要在真机上看一遍。
