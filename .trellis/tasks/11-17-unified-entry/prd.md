# #19 PR3: external session entries
通知、分享、快捷方式、handoff 统一导航，兼容冷热启动。CC Desk 按自身 Agent 打开；未知/不可用 Agent 提示。分享在离开受阻时保留，处理成功后清理，不自动发送。快捷方式一次消费；重复交接不重放导航或提交。
不改 Relay、原生协议、顶栏外观和业务交接支持范围。只使用合成数据验证。
验收：五组入口/导航测试与完整 mobile、typecheck、lint、mobile build 通过。
