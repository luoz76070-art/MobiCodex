# Mobile Codex plugin privacy notice

The Mobile Codex plugin runs a gateway on your own computer. The maintainers do not run a data service for it and receive nothing from it: there is no telemetry, analytics or crash reporting.

## Stored on your computer

- The gateway configuration (by default `~/Library/Application Support/Mobile Codex Gateway/gateway.json`, file mode 0600) and its log, which records stable error codes only and no credentials.
- Paired-device records, voice-input keys and files uploaded from your phone, in the `.mobile-codex/` directory of the workspace you chose with `init`.
- If you ask for it, a macOS LaunchAgent and a fixed copy of the gateway under `~/Library/Application Support/Mobile Codex Gateway/service/`.

## Sent from your computer, only to places you configure

- **Phone traffic.** The gateway listens on 127.0.0.1 only. For remote access it opens an outbound TLS connection to the Broker set in your configuration (`tunnel.brokerUrl`). Messages, approvals and uploads exchanged between your phone and Codex Desktop pass through that Broker, so use one you run or trust.
- **Local agents.** It talks to the local Codex Desktop app server and, when you enable them, to Claude Code, OpenCode, a DeepSeek harness or CC Desk at the addresses in your configuration.
- **Voice input (optional).** After you save your own keys from the phone app, recorded audio is sent to Alibaba Cloud Model Studio (DashScope, China or international endpoint) for transcription, and the transcript to DeepSeek or the compatible endpoint you set for clean-up. Those providers' terms and privacy policies apply.

## Removing your data

`service uninstall` removes the LaunchAgent and its receipt. Deleting the configuration file and the workspace's `.mobile-codex/` directory removes the rest. Revoking a device, on the phone or with `revoke --device <UUID>`, invalidates its credentials immediately.

Questions: <https://github.com/luoz76070-art/MobiCodex/issues>

---

# Mobile Codex 插件隐私说明

插件在你自己的电脑上运行网关。维护者不为它运营任何数据服务，也收不到任何数据：没有遥测、统计或崩溃上报。

- **存在本机**：网关配置（默认 `~/Library/Application Support/Mobile Codex Gateway/gateway.json`，权限 0600）和日志（只记录错误码，不含凭证）；已配对设备、语音输入密钥和手机上传的文件，在 `init` 指定的工作区的 `.mobile-codex/` 目录里；你要求时才会安装的 macOS 登录项和固定的网关副本。
- **只发往你配置的地方**：
  - 网关只监听 127.0.0.1，远程访问时主动用 TLS 连到配置里的 Broker（`tunnel.brokerUrl`）。手机和 Codex Desktop 之间的消息、审批、上传都会经过这个 Broker，请用自己部署或信任的。
  - 本机的 Codex Desktop app-server，以及你启用的 Claude Code、OpenCode、DeepSeek harness、CC Desk。
  - 语音输入（可选）：在手机上填了自己的密钥后，录音发给阿里云百炼（DashScope，国内或国际节点）转写，转写文本发给 DeepSeek 或你设置的兼容接口整理，适用这些服务自己的条款。
- **删除**：`service uninstall` 移除登录项；删掉配置文件和工作区的 `.mobile-codex/` 目录即清除其余数据；撤销设备会立即让它的凭证失效。
