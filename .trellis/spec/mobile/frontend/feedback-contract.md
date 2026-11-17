# F7 反馈入口和待发（part 1）

`features/feedback/model.ts` 的 `openFeedback({text?, screenshot?: File, context?})` 只打开 App 级面板，不导航、不自动发送。设置提供入口；消息长按与分享入口留给 part 2。App 按连接 scope 挂载 FeedbackHost，保留当前 Agent/会话；反馈 BackLayer=215，复用 capture 模式语音层=220，系统返回先关语音再关反馈。

上下文在打开时冻结，白名单为版本、versionCode、页面、Agent、会话、最近一次可见错误、机型/系统。页面显示全部字段。版本按独立/宿主身份读取，机型/系统仅解析 UA，未知明确标记，不新增原生插件。

`lastError.ts` 在内存按当前 scope 记录最多 200 字。App 级 DOM 观察器集中调用 recorder，只采集可见 alert/error 元素（含 portal）；无 alert 语义的设置、连接和图片错误用 data-feedback-error 标记。先去 URL、路径、凭证/长令牌、邮箱再截断，不监听网络正文/日志或抓取输入值。重复未变化节点不覆盖较新错误，隐藏后重显算新提示，不持久化错误历史。

点击提交后先保存 IndexedDB `mobicodex-feedback-v1/queue`；键为 `[scope, clientId]`，每 scope 最多20条/约30MiB 编码数据。超配额拒绝新条、保留表单与既有队列，不用 localStorage 保存图片或凭证。关闭未提交表单会丢弃其内容，已排队的保留。截图≤5MiB，客户端识别签名、服务端作最终结构校验。

应用启动、online、回前台与前台30秒重试使用同一 UUID；HTTP 收件回执匹配 clientId/id/status 才移除。离线、401、429、网络失败和不匹配回执保留记录；同一 scope 单飞，卸载或换连接后迟到回包不改新 scope。重新配对的设备具有新的 owner，不承诺跨设备去重。

面板区分待发送和我的反馈，状态为已收到、已提交 #N、已修复/版本、未采纳/原因；打开、在线恢复和前台30秒读取更新，有手动刷新入口。不可读取时明确提示，不伪造成功。

`corepack pnpm test:mobile` 包含 `scripts/test-mobile-feedback.mjs`：上下文、UA、脱敏、队列去重/补发/隔离/配额、状态、生产面板 handlers、设置接线与生命周期。浏览器 IndexedDB 容量、Android 录音/系统选图与离线切换仍须真机验收。
