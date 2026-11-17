# Design

Relay feedback/store 负责校验、串行写入、原子 JSON、截图签名与配额；server/feedbackRoutes 接现有 owner/devices。私有数据目录默认沿用 defaultGatewayConfigPath 的父目录，托管 CLI 传入实际配置文件父目录以兼容 --config；测试只注入临时目录。
context 采用固定白名单，各项限长。status 是可人工编辑的对象：received / filed(issue) / fixed(version) / dismissed(reason)。GET 从磁盘重读，不覆盖人工状态，不返回 owner/路径/截图正文。
手机 feedback 下分离 model（上下文、UA、状态）、lastError（仅当前 scope 可见错误，先脱敏再截断）、queue（IndexedDB 有界持久队列和单飞补发）与 FeedbackSheet。App 提供打开入口，保留当前工作区，使用 BackLayers 处理返回，语音复用 VoiceInput。
本轮仅新增设置入口，预留 openFeedback 参数，不改变导航或 relay Agent 控制。
