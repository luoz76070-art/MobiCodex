# Claude CLI 只读契约（C4a）

- 独立 `claude-cli` / Claude CLI；插件 `claude` / Claude Code 不合并。仅通过锁定的官方 SDK 三个读取函数访问记录；禁止 query、进程运行、模型调用或自行解析记录回退。
- 网关 `claudeCli.directories` 是唯一目录授权来源，缺省/空显示未启用。根与 cwd 都取 realpath，path.relative 判断包含，正文读取前后重新校验。手机不能指定 dir/cwd/directory，列表只输出项目目录名。
- SDK 构造注入；插件登记查询由 createRelayServer 注入公开查询函数，两个 adapter 不互读内部状态。desktopOpen 仅表示插件当前登记，不能推断其他运行进程。
- 列表搜索标题/第一句，修改时间倒序，签名游标分页；历史按 SDK 链向前分页，仅正文/短工具摘要，不转发 thinking、工具参数或结果。SDK 不提供消息时间，留空并保留链顺序；不得伪造时间。
- 按订阅共享 3 秒轮询，变化才读正文；最后订阅离开或 stop 释放，停止后不发布迟到结果。写方法一律 409 CLAUDE_CLI_READ_ONLY，能力 false。
- 手机复用统一顶栏/列表/会话/输入框；只读说明常驻，输入、附件和语音禁用。历史窗口可向前移动并返回最新。
- `test:claude-cli` 与 `test:mobile` 使用假 SDK 和合成文件。官方 SDK 验证必须隔离 HOME/认证、阻断进程和网络，不能读取真实用户会话。版本、许可证、安装体积与 SDK 限制见 docs/plans/2026-11-17-c4a-claude-cli-readonly.md。
