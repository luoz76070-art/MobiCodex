# 设计与自审

所有 Agent 已共用 ComputerComposer，故在这里唯一接入 QuickCommands；GlobalSettings 接入同一份存储的编辑设置。feature 内集中限制、默认值、存取与追加规则，useSyncExternalStore 同步同页与跨页变化，无网络调用。

编辑器复用 BackLayers 返回层，portal、焦点约束与关闭还焦。胶囊以 pointer 手势区分点击、长按和移动；移动超过阈值、pointercancel、离开、失焦、卸载清理计时器。键盘 Enter/Space 填入，ContextMenu/Shift+F10 编辑。保存失败保留编辑文字并提示。

自审：只在共享输入组件接入，所有发送入口及 Agent 草稿仍归原会话所有；不引入重复会话组件、依赖或网关状态。
