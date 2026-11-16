# 设计

- subscription 单独持有 background 计时，默认 BACKGROUND_GRACE_MS=20000、options.backgroundGraceMs 可注入。
- 隐藏只启动一次倒计时；宽限期间仍允许正常重试与心跳检查，重试不延长后台期限。前台取消后台计时，保留现有 source/令牌请求；期满关闭连接/请求/重试并进入 paused。
- 吊销、dispose 清后台计时，generation 防止旧流（含 ping）复活心跳。
- AgentChat 在非 online 时保留展示字段、废止 control/connected/activityEvidence；同步 ref 阻止迟到按钮回调，online 后新快照才解锁。unauthorized 取消请求并清快照/历史。
- 不持久化快照或控制信息，不修改 releasedStreamState。无需依赖或公开接口变化（仅可选订阅测试参数）。
