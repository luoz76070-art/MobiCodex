# MobiCodex 0.4.6（versionCode 49）

2026-11-26 · Android 6.0+ · 包名 `com.mobilecodex.app`

## 这一版

- **所有 Agent 都从左上角切会话**（#56）：Claude Code、CC Desk、DeepSeek、Claude CLI、OpenCode 的会话里，左上角改成「打开会话列表」，从左边滑出这个 Agent 的会话列表（搜索、按项目分组、刷新、加载更多，Claude CLI 还能新建），点一个直接切换，和 Codex 一样。系统返回键先关列表，再按原来的顺序返回。
- **从桌面图标打开先进「选择 Agent」**（#42）：冷启动，或者系统在后台结束了 App 再打开时，先进选择页；从后台切回、界面更新后重新加载仍停在原页；点通知、分享到 App、桌面快捷方式照旧直达目标，草稿和会话缓存都保留。
- **消息里的网址可以直接点开**（#58）：正文里的网址和代码样式的网址都是链接，句末标点和中文不算进链接，路径里成对的括号算在里面。
- **DeepSeek 更新后不再整个断开**（#62）：DeepSeek 0.2 系列的新版本照常能用，没验证过的版本会提示“还没经过 MobiCodex 验证”；连不上时写明原因（DeepSeek 已更新而插件不支持、还没装插件、要在 DeepSeek 里把插件关掉再打开，或 DeepSeek 没开）。OpenCode 同样支持 2.0.x。
- **只改电脑端的**：处理完的反馈 7 天后自动清理（#59）；很长的 Codex 会话读最新的分段，不再停在旧内容（#54）；经本地代理出错时原因更准确（#54）。这几项更新网关就生效，手机不用升级。

0.4.5 及更早的改动见 [0.4.5 版本说明](../0.4.5/README.md)。完整列表见[更新说明](../../../../CHANGELOG.md)。

**电脑端**：用这一版源码重新构建网关并切换。用 DeepSeek 的话，DeepSeek 插件要升到 0.3.0（`dist-plugin/mobile-deepseek`，见 [DeepSeek 插件说明](../../../../plugins/mobile-deepseek/README.md)），装好后在 DeepSeek 的插件页把 Mobile Codex 关掉再打开一次。旧网关配新手机也能用，只是看不到 DeepSeek 和 OpenCode 的原因提示。

## 安装

1. 用下载页的安装包覆盖安装 0.4.5 或更早的版本（同一签名，数据保留）。
2. 电脑上按[网关管理](../../../../plugins/mobile-codex/README.md)用本版源码构建网关（`corepack pnpm build:plugin`），沿用原配置和工作目录切换到新程序。
3. 用 DeepSeek：按 DeepSeek 插件说明安装插件 0.3.0，再在 DeepSeek 的插件页把 Mobile Codex 关掉再打开。
