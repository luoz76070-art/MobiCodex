# Implementation

1. 网关存储、路由、数据目录注入与隔离测试。
2. 手机上下文与脱敏、持久队列、设置面板和可复用入口。
3. 手机测试、后端隔离回归、typecheck、lint、mobile build，自审后提交推送开 PR。

## 验证结果

- corepack pnpm test:mobile：543/543。新增反馈15项覆盖生产模块与面板 handlers。
- corepack pnpm test:feedback：23/23（反馈后端8项 + 手机15项）。
- corepack pnpm test:ccdesk：控制脚本7/7，Relay 16/16。
- 插件构建后运行 feedback/capture/availability/managedGateway 隔离测试：48/48。
- corepack pnpm typecheck、corepack pnpm lint、corepack pnpm --filter @mobile-codex/mobile build：通过。构建保留既有大 chunk 提醒。
- 未连接真实电脑、提交模型任务或自动提 GitHub issue。浏览器/Android 语音、选图、IndexedDB 真正容量与进程重启恢复需要审查方验收；本轮只以可注入存储测试补发状态机。

## 自审边界

设置、连接卡和图片错误补 data-feedback-error 标记，不改其显示或控制语义。反馈持久化后刷新失败不回退保存结果；损坏/超限截图保留待发且不阻塞其他独立反馈。收件箱没有自动清理；人工须按契约只编辑 status。
