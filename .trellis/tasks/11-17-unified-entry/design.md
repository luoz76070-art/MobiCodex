# Design
App 持有按连接 scope 排队的外部入口，openSessionTarget 统一校验、草稿离开保护和目标提交。导航目标独立于 HandoffTarget；仅非 Codex 目标读取当前 Agent 注册表，failed/未知不回落 Codex。
入口先入队，成功导航才交付给 Workspace。分享和新任务/语音快捷方式保持队首直到显式完成；快捷方式使用 App 内递增序号，保持原生接口，工作区以 ref 防止 effect 重放。异步请求绑定 AbortSignal 与 scope，页面已变化时提示重试。
宿主重复 handoff 更新卡片状态，不重复导航或发送；迁移仍沿原确认/ACK 流程。保留 ProductBeforeNavigate 的上传、保存失败保护。
