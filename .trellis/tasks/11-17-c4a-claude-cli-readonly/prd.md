# C4a Claude CLI 只读 Agent

按完整C4设计增加独立claude-cli Agent，名称Claude CLI，保留Claude Code插件通道。配置claudeCli.directories为绝对路径白名单，缺省或空列表显示未启用。只允许真实工作目录处于白名单内的会话，不接受手机目录输入。

官方SDK精确锁定，仅调用listSessions/getSessionInfo/getSessionMessages；不启动Claude、不运行模型、不读取真实用户会话做测试。列表合并、搜索和分页；历史向前分页，正文和有界工具摘要，不转发推理；有人订阅时只读轮询最新快照；写方法固定409 CLAUDE_CLI_READ_ONLY。通过服务器注入查询函数标记插件登记会话“电脑上开着”。手机复用统一顶栏和会话组件并禁用输入，显示本期只读说明。

验收：SDK许可证/安装内容说明，隔离relay与手机测试，test:mobile/test:ccdesk/相关relay测试/typecheck/lint/build均通过；指定功能分支提交推送开PR。
