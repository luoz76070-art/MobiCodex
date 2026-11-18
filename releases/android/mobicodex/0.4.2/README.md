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
