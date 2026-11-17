# Implementation

1. SDK源码及合成隔离验证，锁依赖并省略可选原生包。
2. 白名单配置、Adapter、服务器注册与插件状态查询注入。
3. 统一手机只读显示、测试与契约记录。
4. 指定检查、自审隐私/范围、功能分支提交推送和PR。

完成：官方 SDK 0.3.326 精确锁定；仅注入三个本地读取函数；排除八个可选原生包，独立网关 bundle 附带 SDK 原始许可证。记录许可证、体积、纯本地隔离证据与限制于 docs/plans/2026-11-17-c4a-claude-cli-readonly.md。

实现配置贯通、真实目录白名单、搜索/签名分页、历史翻页、过滤推理/工具私有内容、按订阅共享轮询与停止保护、只读409及插件登记查询注入。手机沿用统一界面，配置缺省显示未启用，禁用输入/附件/语音，历史窗口可持续向前翻。符号链接项目保留经授权的 SDK 项目键，读取中改向越界时丢弃结果。

验证：test:mobile 555/555；test:ccdesk 工具7/7与relay16/16；test:claude-cli 11/11；合并相关relay回归83/83（Claude插件、AgentGateway、Agent图片、托管网关和C4a）；typecheck、lint、build及build:plugin通过。构建保留既有大chunk提示。未做真机/视觉验收；没有读取真实会话、调用模型或启动Claude。

范围自审：ClaudeAdapter与plugins/mobile-claude无差异；新增文件/变更内容无本机路径、用户名、邮箱或实际服务器地址。远端main新增一项不重叠修复，仅检查，不自动合并/rebase，也不修改main。
