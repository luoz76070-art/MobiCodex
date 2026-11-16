# 实施与验证

1. 阅读 issue #20 正文/评论、移动端规范和当前生产订阅/组件测试。
2. 修改 subscription 后台宽限及 AgentChat 只读快照；补假计时器和实际组件 handler/effect 回归。
3. 跑 targeted connection/reliability，随后 test:mobile、typecheck、lint、mobile build；自审未改 Relay/导航/顶栏且没有真实环境数据。
4. 仅在 codex/reconnect-keep-view 提交、推送并建 PR（Refs #20）。模拟器、Android 系统冻结/杀进程另行验收。

## 结果

- 定向 connection/reliability 初跑 110/110；补充在途令牌取消用例后，全量 test:mobile 528/528。
- typecheck、lint、mobile build 均通过。构建保留 Vite 的大于 500 kB chunk 体积提示。
- 同步更新吊销时不再展示加载骨架的旧结构断言。#15 原用例未改且继续通过。
- 自审：生产改动限 subscription 与 AgentChat；新测试执行生产组件的 handler/effect 和真实 reducer/runtime，输入为合成数据。未连接真实电脑，未做 Android/模拟器切屏验收。
