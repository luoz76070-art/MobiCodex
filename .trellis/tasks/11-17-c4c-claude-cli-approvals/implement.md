# 实施与验证

1. 核对官方文档与安装包类型，接入交互管理器和生命周期回收。
2. 扩展可选共享契约/路由，接入手机共用卡片和运行时控制。
3. 更新未发布说明与 Claude CLI 契约。
4. 隔离测试覆盖审批、提问、撤回/超时和切换；检查其他 Agent 兼容。
5. 依次运行 test:mobile、test:claude-cli、test:ccdesk、typecheck、lint、build、build:plugin；审查差异和隐私后提交推送、创建 PR。

## 自审与验证结果

- 七项指定命令均退出 0：test:mobile 580 项；test:claude-cli 38 项；test:ccdesk 7 项工具与 16 项 Relay；typecheck、lint、build、build:plugin 通过。额外共享网关、项目图片、Claude 插件与独立网关回归 72 项通过。
- 审批/问答测试验证完整 SDK 回包、本地建议过滤、suppressAlwaysAllowRule、默认/自定义拒绝理由、单次回答和 HTTP 幂等；signal/result/interrupt/崩溃/stop 撤回；生产三十分钟准确截止和超时中断。工具名/输入/preview 均纯文本，不转发推理。
- 切换测试验证安全模式白名单、当前 Query 模型列表、无进程不启动、迟到响应隔离、SDK 错误不泄漏。手机真实组件事件测试覆盖审批、单多选/自由回答、纯文本预览、设置读取和切换路由，以及卡片撤回。
- 未改 plugins/mobile-claude 或 ClaudeAdapter；main 与 origin/main 保持原提交。所有模型相关测试使用假 Query/合成回调与记录；未运行真实模型。
- 浏览器安全策略拒绝本地页面检查，未绕过；视觉与 Android 真机集成未验收。手机生产构建保留既有大块体积提示。SDK 与真实 CLI 的端到端交互仍需发布验收。
