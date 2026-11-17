# 实施与验证

1. 核实 SDK 版本、query/stream/permission 类型，保持精确依赖。
2. 添加执行文件检查、进程运行模块；接入 C4a 与目录/创建路由。
3. 共享手机界面开放输入和创建、错误提示。
4. 注入 fake query/CLI 验证用户场景和边界；自审生命周期、目录再校验与鉴权。
5. test:mobile、test:claude-cli、test:ccdesk、typecheck、lint、build、build:plugin 全通过后核对隐私/范围并提交、推送、开 PR。

## 自审与结果

- 七项指定命令通过：test:mobile 562 项、test:claude-cli 28 项、test:ccdesk 7 项工具/16 项 Relay；typecheck、lint、build、build:plugin 退出 0。生产手机包保留既有大块体积提示。
- 额外共享路由、项目图片、插件 Claude 通道及独立网关隔离回归 72 项通过；未更改 plugins/mobile-claude 或 ClaudeAdapter。
- 自审补充并验证：创建未知回包同键核对；回收后自己的近期记录仍可继续；别名重定向拒绝；订阅异常释放查看计数；进程崩溃保留未发文本；首次记录落盘前失败可查看；正常 EOF 保留成功结果；实时窗口淘汰消息后同步历史游标，避免向前翻页跳过记录。
- 所有运行测试为假 query/假 CLI；官方 SDK 读取验证阻断进程和网络。未执行真实模型、Android 或浏览器视觉验收。写入方启发式不是跨进程原子锁；创建幂等仅当前网关内存有效。
