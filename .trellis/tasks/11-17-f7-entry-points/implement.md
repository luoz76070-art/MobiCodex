# Implementation

1. 共享消息长按菜单、键盘操作、复制与反馈预填。
2. 分享预填适配和可见图片说明。
3. 生产handlers隔离测试、全量指定检查和浏览器合成验收。
4. 自审修改范围与敏感信息，提交推送功能分支并开PR。

## 验证与自审

- corepack pnpm test:mobile：551/551通过。
- corepack pnpm test:feedback：31/31通过。
- corepack pnpm typecheck：通过。
- corepack pnpm lint：通过，0警告。
- corepack pnpm --filter @mobile-codex/mobile build：通过，保留既有大chunk提醒。
- 新增8项反馈测试，另更新原长按回归：三项菜单、方向键/Home/End/Tab/Esc、外部关闭、焦点恢复、复制失败/单飞、五类Agent及消息角色、脱敏顺序、可修改预填、分享单图/多图/无图、5MiB边界及超限、错误类型/签名/读取、取消时效。
- 自审确认只改变手机生产代码及相关测试/文档，context字段集合、网关源码和接口保持原状；入口不会自动发送。
- 浏览器访问本地合成验收页被安全审批拒绝，未取得视觉/真实浏览器验收证据；临时服务已停止。Android原生长按仲裁、读屏和系统分享仍待真机验收。
