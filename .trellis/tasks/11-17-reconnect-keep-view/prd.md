# #20 手机端连接保温

恢复连接时保留 Agent 消息、提问、审批及队列的内存视图，禁用操作；设备吊销清空并保留原提示。
后台默认宽限 20 秒，期间返回不重连，错误/心跳仍恢复；期满暂停，dispose/吊销清理计时。
保持 #15 的 releasedStreamState 与拆流提示清理。范围仅手机订阅、AgentChat、相关测试和契约；不改 Relay、导航或顶栏。

验收：合成连接/组件生命周期回归及 test:mobile、typecheck、lint、mobile build 全过；真机后台行为由审查方验收。
