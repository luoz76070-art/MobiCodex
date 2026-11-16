# Implementation
1. 独立 sessionTargets 类型/目标解析，删除 externalNavigation 兼容适配。
2. App 四入口先入队，再统一执行目标；工作区确认一次消费，错误可重试。
3. 使用实际 App handlers 和纯目标解析补合成测试，覆盖冷热启动、scope 竞态、分享与快捷方式受阻、重复 handoff。
4. 自审 diff，跑 mobile tests、typecheck、lint、mobile build；提交并推送功能分支，PR Fixes #19。

## Verification
- `corepack pnpm test:mobile`: 518/518，通过；五组入口/导航测试覆盖合成冷热启动、CC Desk、未知/failed Agent、保存/上传受阻、FIFO 分享和按 ID 清理、快捷方式序号/重放、重复 handoff 与迁移、连接切换竞态和原生监听迟到回调。
- `corepack pnpm typecheck`: Relay 与 mobile 均通过。
- `corepack pnpm lint`: 通过。
- `corepack pnpm --filter @mobile-codex/mobile build`: 通过；保留已有主入口大于 500 kB 的非阻塞提示。
- `lgit diff --check`: 通过。未连接真实电脑、未测试 Android 模拟器或真机 Intent。分享队列只存内存，不新增跨进程恢复承诺。
