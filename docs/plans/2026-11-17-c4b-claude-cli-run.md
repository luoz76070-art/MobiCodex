# C4b Claude CLI 运行通道

实现范围：独立 Claude CLI Agent 新建、原会话继续、正文流、queue/steer、中断；不分叉，不开放手机审批和提问，不改插件 ClaudeAdapter 行为。

## SDK 与执行文件

保持 @anthropic-ai/claude-agent-sdk@0.3.326 精确锁定和八个 ignoredOptionalDependencies。SDK package.json 的 claudeCodeVersion 是 **2.1.326**；SDK 未声明跨版本通用最低值。本集成以配套版本为保守最低支持版本，自动测试检查常量与官方包元数据一致。SDK 类型文档对部分可选配置另有 2.1.248/2.1.261 等要求，它们不能充当整个 SDK 的兼容保证。

网关查找配置的绝对执行路径，或 PATH、用户 .local/bin、旧 .claude/local 及常见安装目录。通过 execFile 执行 --version，五秒超时、输出不超过 8KiB，不使用 shell，不读取登录凭据。每个适配器只检查一次；升级后重启网关。过旧显示“请升级 Claude Code（当前 x，需要 ≥ 2.1.326）”。配置目录为空不检查执行文件。

SDK 仍使用 Anthropic 专有许可条款，不是 MIT；许可证随独立网关包复制（C4a 已实现）。JS 包解包 5,474,496 字节 / 32 文件；平台原生包未安装，本次不增加依赖。query 始终显式指定电脑已安装的 Claude Code。

## 配置与接口

claudeCli: { directories: string[], executable?: string }，两类路径均要求绝对路径。手机只看到项目目录名及不透明选择令牌。

| 接口 | 行为 |
| --- | --- |
| GET /api/agents | 版本检查结果、稳定错误、发送能力；不启动模型 |
| GET /api/agents/claude-cli/directories | 配置根选择项、运行条件错误 |
| POST /api/agents/claude-cli/sessions | 严格 directory 令牌和 text 首句；可选 Idempotency-Key 头绑定设备与内容 |
| POST .../sessions/:id/messages | 继续原 ID 或投递已有输入队列；queue 等 result，steer 立即追加 |
| POST .../sessions/:id/interrupt | 中断网关拥有的当前轮 |
| POST .../sessions/:id/queue/:id/cancel | 取消尚未投递的队列条目 |

现有鉴权、设备撤销、SSE 快照和写入幂等继续复用。白名单目录读取/执行边界重新解析真实路径；新建仅限配置根，继续允许已授权根内项目。

## 进程与权限

每个运行会话一条 query，最多三条；首发串行和同步占位防并发超限。可交互进程保持流式输入；result 确定上轮结果，继续发队列下一项。运行中/有人查看不回收，idle 且无查看十五分钟后关闭；网关停止关闭所有自建 Query。进程错误隔离并保存失败状态；未投递内容显示提示、不自动重放。首次记录未保存时仍展示失败和输入。

canUseTool 拒绝所有需要审批的操作；AskUserQuestion 另有 PreToolUse 拒绝，不受本地 allow 规则跳过回调影响。界面显示“已自动拒绝：工具名（手机审批下一版提供）”。不启用 bypassPermissions、不额外注入凭据。

## 验证与限制

隔离用例覆盖版本、目录与软链接、创建/恢复、流/隐私、queue/steer、取消/中断、写入保护、并发上限、查看与空闲回收、关闭竞态、崩溃、自动拒绝和 HTTP 创建幂等；手机真实组件处理器覆盖共用输入框与创建/错误/未知回包核对。

写入保护根据插件登记、最近两分钟时间与本网关拥有进程/记录指纹判断，不是跨进程文件锁；电脑在检查之后同时打开会话仍有竞态。未声明 SDK 更早版本必定不可用，只是未作为本集成支持基线。真实模型、真实登录渠道、Android 和浏览器视觉验收未执行，需单独验收；创建幂等记录与结束状态只在网关内存保存，重启不保证重试去重。
