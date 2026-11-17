# 技术设计

执行文件解析与版本检查独立模块；以 SDK 0.3.326 元数据 claudeCodeVersion 2.1.326 为保守兼容下限（SDK 未声明通用最低版本），只 execFile --version，一次探测共享 Promise。保留八个原生可选依赖排除。

ClaudeCliAdapter 保留目录授权与 SDK 记录接口；ClaudeCliRuntime 注入 query，管理有界输入迭代器、独占启动、队列、快照和关闭。运行消息投影只收正文/工具名，忽略推理、子代理和参数。流事件与完整 assistant 归并；result 结束当前轮并释放下一条队列。

共享 SessionAdapter 可选目录列表和创建方法；目录列表只提供不透明令牌和 basename，创建严格 {directory,text}，令牌回查配置根并再次 realpath。现有操作保留控制令牌和 HTTP 幂等。Agent 状态附错误说明/版本，快照禁用不可运行时发送。手机复用 AgentWorkspace/ComputerComposer，增加目录选择与首句表单。

写入保护只认可活动的网关 Query 所有权；恢复时检查插件登记和 SDK 元数据时间。时间启发式不是跨进程文件锁，竞态作为限制记录。所有后台任务捕获异常，stop 栅栏防止迟到启动。
