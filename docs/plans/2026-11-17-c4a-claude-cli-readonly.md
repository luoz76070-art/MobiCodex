# C4a：Claude CLI 本地只读通道

独立 Agent `claude-cli`，显示名 **Claude CLI**，与插件通道 Claude Code 并列。仅通过官方 SDK 读取记录，不调用模型、不启动 Claude、不接管运行中的会话；原 ClaudeAdapter 和 mobile-claude 插件保持原有行为。

## SDK 核实（2026-11-17）

- 精确依赖 `@anthropic-ai/claude-agent-sdk@0.3.326`，运行代码仅导入 `listSessions`、`getSessionInfo`、`getSessionMessages`。三者的发布实现读取本地记录，不需要 Claude 登录，也不调用 Claude 运行入口。项目没有自行解析记录作为替代。
- 许可证：包元数据为 `SEE LICENSE IN README.md`；随包 LICENSE.md 保留 Anthropic 权利，并指向官方 Legal Agreements。因此这是 **Anthropic 专有条款**，不是 MIT。本次不把它重新声明为项目许可证。
- 独立网关打包时把 SDK 随包 LICENSE.md 复制到 bundle 旁的 CLAUDE-AGENT-SDK-LICENSE.md，保留其原始声明。
- npm 发布包共 32 个文件，解压 **5,474,496 bytes**（约 5.47 MB，不含 peer 依赖）。原生 Claude CLI 分装在八个可选平台包中；例如同版本 macOS ARM64 包解压 **353,038,248 bytes**（约 353 MB）。本仓库在 pnpm-workspace.yaml 精确排除这八个包，保留其他 optional dependencies。
- 当前锁文件下 SDK 与已安装依赖闭包约 **39,213,037 bytes / 101 packages**，统计普通文件，不计目录、链接和文件系统块开销，也不代表相对仓库已有依赖的增量。平台与锁文件变化后需重新测量。
- 隔离回归在子进程启动前设置合成 HOME、配置目录和空认证环境，使用合成记录，阻断 child_process、fetch、HTTP(S)。三个函数及真实 Adapter 均能读出两条消息，子进程/网络尝试均为零，并确认八个原生包均未安装。测试不读取用户实际会话。

官方依据：

- [固定 npm 版本元数据](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.326) 与随包 sdk.d.ts、sdk.mjs、LICENSE.md。
- [可选 macOS ARM64 包元数据](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/0.3.326)。
- [官方 TypeScript SDK 文档](https://platform.claude.com/docs/en/agent-sdk/typescript)。
- [Anthropic Legal Agreements](https://code.claude.com/docs/en/legal-and-compliance)。

## 配置与授权

在电脑的托管网关配置里添加 `claudeCli: { directories: string[] }`。每项必须是绝对目录；缺省或 `directories: []` 时仍显示 Agent，但标记“未启用”。修改后重启网关。本期不提供手机目录选择或路径参数。

配置根和会话 cwd 都经 realpath、目录检查和 path.relative 包含判断；允许根的子目录，拒绝相邻前缀、符号链接逃逸、`..` 逃逸及无 cwd 会话。每次读取重新授权，读取后再验证，授权变化即停止发布。SDK 项目列表是精确目录查询，所以合并配置目录查询和全局元数据发现后再过滤，正文只在授权后按可信 dir 读取。SDK 在找不到记录时可能查询 Git worktree 元数据；不启动 Claude 或登录流程。

列表仅输出目录末级名、标题、修改时间与 desktopOpen 标记，不输出完整工作目录。列表和历史游标签名，分别绑定搜索条件、会话及消息链边界，不携带路径。客户端篡改游标或传目录参数返回 400。

## 展示与生命周期

列表按修改时间倒序，每页 50，支持标题或第一句搜索；历史每页 50 向前翻，手机复用现有历史窗口，可以越过渲染预算继续向前。注册状态由 createRelayServer 注入查询函数，列表和会话显示“电脑上开着”，提示到 Claude Code 操作。

正文仅投影 user/assistant 的 text 块，工具只显示名称或固定结果摘要，每条最多 4000 字；排除 thinking、系统消息和子 Agent 消息，不转发工具输入或结果内容。SDK 没有返回逐条时间戳，消息时间留空，按 SDK 消息链顺序显示。会话修改时间来自 SDK 元数据。

有人订阅才每 3 秒检查元数据；同一会话共享轮询和在途读取，仅变化时推新快照。最后一个订阅离开、网关关闭或授权失败时释放，迟到结果不得发布。四类写方法固定返回 HTTP 409 `CLAUDE_CLI_READ_ONLY`，所有能力位 false；手机输入、附件和语音禁用，常驻“只读预览，发送功能下一版提供”。

## 验证与限制

`test:claude-cli` 覆盖配置、真实目录白名单、搜索/分页、历史、投影、写入拒绝、跟随释放、停机竞态、默认 HTTP 工厂和插件登记查询，以及已安装官方 SDK 的隔离验证。新手机用例纳入 `test:mobile`；relay 测试由现有 verify 的测试目录发现机制自动纳入。

SDK 自身决定可见消息链和压缩边界；大记录可能不含压缩前的完整历史，每次历史读取仍需 SDK 物化其可见消息链。多个项目的元数据扫描、活动订阅的轮询和文件正在写入时的最终一致性仍依赖 SDK。真实设备的目录可用性、列表视觉和长会话体验须在后续真机只读验收中确认；自动回归不调用真实模型。
