# Real UI navigation flow check

为 #19 发版前复核提供真实网页导航脚本；只用独立 origin 和虚构数据，不接 Relay 或真实会话，不改手机生产源码。
复用 README 截图脚本的静态服务、API、SSE 和浏览器启动；保留原五张截图输出。
逐步检查 Agent 根页、Claude 列表/会话、全局设置、单步 product-back、Codex 返回及刷新恢复；每步截图并打印顶栏标题，失败退出非零。
补 CC Desk 会话与 attention 数据。网页未暴露通知入口时明确跳过，不用其他导航冒充通知成功。
浏览器因沙箱限制由用户外部运行，本轮只执行语法、lint、合成服务与现有导航相关测试、构建。
