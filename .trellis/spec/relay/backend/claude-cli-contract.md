# Claude CLI 契约（C4a / C4b）

- 独立 claude-cli / Claude CLI，不合并插件 claude / Claude Code。记录只用锁定 SDK 的 listSessions/getSessionInfo/getSessionMessages，不自行解析文件。C4b 仅用户发送或新建时调用注入的 query，流式输入。
- claudeCli.directories 为唯一目录授权来源，缺省/空未启用。根与 cwd 取 realpath、relative 判断包含，读取前后和执行前重新校验；保留经授权的 SDK 项目别名，防止符号链接重定向越界。列表只输出目录名。
- claudeCli.executable 可选绝对路径，否则发现 PATH 和常见安装位置。execFile 只检查一次 --version，五秒/8KiB 上限。SDK 0.3.326 的 claudeCodeVersion 元数据为 2.1.326，作为本集成保守下限；不能声称 SDK 公布了通用最低版本。缺失/过旧/检查失败显示稳定错误并禁用发送。原生可选依赖仍排除。
- 共享路由 GET /api/agents/:agentId/directories 返回不透明选择令牌与目录名；POST /api/agents/:agentId/sessions 严格 {directory,text}，只能选配置根；可选 Idempotency-Key 经 SubmissionRegistry 绑定 owner/agent/body，重试不再启动。现有发送等操作保留 UUID 控制令牌、设备鉴权和幂等。
- query 只用已安装执行文件，cwd 授权、继续 resume 原 ID、新建固定 sessionId；includePartialMessages=true、permissionMode=default、settingSources=user/project/local、env 继承，无额外凭据。禁止绕过审批。canUseTool 全拒绝；AskUserQuestion 另有 PreToolUse 拒绝，防止本地 allow 规则跳过回调。手机显示系统消息，不开放问答/审批接口。
- 插件登记查询由 createRelayServer 注入公开函数，适配器不互读内部状态。插件登记或最近两分钟的非本网关记录写入返回 409 CLAUDE_CLI_SESSION_BUSY，不分叉；回收后保留自有记录指纹，随后外部修改使豁免失效。这是时间/所有权启发式，不是跨进程原子锁。
- 同时最多三条 Query；启动同步预留容量，同会话首发串行。queue 等 result 再投递，steer 立即追加；有界待发输入，interrupt 调 Query.interrupt。结果 completed/failed/interrupted 进入 lastTurn，新轮不抹掉上轮结果。
- 仅正文和工具名摘要进入快照；部分与完整 assistant 合并，思考/工具参数/子代理不下发。活动证据 thinking/working/outputting 与当前轮绑定。失败清理 Query，未发队列可见但不重放；首条记录未落盘的失败仍可订阅、禁用发送。
- 正在运行或有人查看不回收；idle 且最后查看离开十五分钟后 close，停止全关，回调/订阅释放幂等，后台错误捕获。运行进程最多三条，结束快照缓存有界。
- 列表搜索标题/第一句、修改倒序、签名分页；历史按 SDK 链向前，仅正文/短工具摘要。SDK 未提供记录时间时留空，不伪造。外部会话按订阅共享三秒轮询，无订阅不读取正文。
- 手机复用统一顶栏、列表、会话和 ComputerComposer；增加配置目录选择/首句表单，错误保留草稿；创建回包未知时同键核对。本期审批/提问自动拒绝，不触发真实模型验收。
- test:claude-cli、test:mobile 全为假 query/合成记录/假可执行文件；官方读取测试隔离 HOME、阻断网络/进程。不读取真实用户会话，不调用真实模型。
