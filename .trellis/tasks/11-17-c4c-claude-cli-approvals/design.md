# 设计与变更边界

当前行为缺口位于 ClaudeCliRuntime 的固定拒绝回调。新增该运行时私有的交互管理器，持有原始输入、SDK 建议、signal 与截止时间；向共享快照投影待答卡片。答复先从待答集合原子移除再 resolve，不因手机重试重复执行；已撤回 ID 一律返回已处理。运行时所有终态统一撤回，超时调用 Query.interrupt。保留 C4a 目录和 C4b 写入保护。

共享 sessions/types 仅增加可选展示字段、拒绝理由和可选控制方法；agentSessionRoutes 沿用鉴权、控制令牌、owner/body 幂等。运行时控制不创建进程，切换前后核对 Query 身份；模型只来自当前 Query.supportedModels。手机沿用 AgentWorkspace、PermissionCard、AgentQuestions，控制区使用现有 details、quota-choice 和 action-button 样式。ClaudeAdapter 与插件不修改。

依据官方 Handle approvals and user input 文档及锁定 SDK 类型：allow 携 updatedInput；always 只回传 options.suggestions 中 localSettings 条目，suppressAlwaysAllowRule 隐藏持久选项；AskUserQuestion 的 answers 以原问题为键，保留原 questions。preview 直接文本渲染，不作为 Markdown 或 HTML。保留 SDK 版本及原生可选依赖排除。
