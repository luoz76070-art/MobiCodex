# Implementation and verification

- 抽出合成网页 helper，capture 脚本保留五张 JPEG 的文件名、尺寸、质量和内容断言。
- 新增 check-navigation-flow.mjs，390×844，逐步截图、标题和返回消费断言；通知明确跳过。
- 新增合成测试覆盖干净初始化、刷新不覆盖导航/草稿、README seed、CC Desk/attention 身份、拒绝写请求、静态服务与四类 SSE。
- 验证通过：四个脚本 node --check；node --test scripts/test-synthetic-app.mjs（6/6）；corepack pnpm test:mobile（528/528）；corepack pnpm typecheck；corepack pnpm lint；corepack pnpm --filter @mobile-codex/mobile build。
- 构建仍有既有的单 chunk 超过 500 kB 提醒；本任务不调整生产打包。
- 不在沙箱启动 Chromium；真实 UI 步骤和重新生成 README 截图待用户在外部执行两条脚本。
