# C2：网关接入 CC Desk（读 + 写）

2026-11-15。前提：路线 A 已完成并实测（`integrations/cc-desk/`），用户日常用补丁副本。本文定网关与手机端的接口，按此实现。

## 总体

- 新 Agent：`id: "ccdesk"`，`label: "CC Desk"`，`transport: "ccdesk-ws"`，实现现有 `AgentAdapter` + `SessionAdapter`（`apps/relay/src/agents/sessions.ts`），手机端走现有 `/api/agents/ccdesk/...` 接口。
- **读（C2a）**：网关自己连 CC Desk 服务端（协议 17）。每条连接只能订阅一个会话，所以：
  - 会话列表：临时连接，取 `ready.sessions`，用完即关。
  - 打开的会话：每个会话一条连接（上限 8），`session.subscribe` 拿历史页，之后接 `session.event` / `session.fragment` / `session.updated`。
  - 更早的历史：在该会话的连接上发 `session.history`（`beforeSequence`）。
  - 连接只发 `auth`（`tunnel:false`，设备名“MobiCodex 网关”），**不发 `device`**，服务端不会为网关建席位或执行通道。
- **写（C2b）**：经补丁副本的本机接口（`~/.mobicodex/ccdesk/*.json` 里 `service` 与配置的服务地址一致、`pid` 存活的那个 socket）。五种指令：`message.send`、`approval.reply`、`run.cancel`（停止）、`run.continue`（暂不暴露）、`run.task.stop`（暂不暴露）。
- 找不到本机接口、接口不可写、会话不在这台 Mac 上（`session.device.id` ≠ 配置的 `deviceId`）时，只读，并在权限卡上写明原因。

## 配置与凭据

`gateway.json` 增加：

```json
"ccdesk": { "url": "wss://<host>:<port>/ws", "fingerprint": "<SHA-256，可选>", "deviceId": "<这台 Mac 在 CC Desk 里的设备 ID，可选>" }
```

- 服务凭据只在钥匙串：服务名 `mobicodex-ccdesk`，账户为服务地址。网关在探测时用 `security find-generic-password -w` 读取，只放在内存里，不进日志、事件或错误信息。
- `mobile-codex ccdesk login [--url] [--fingerprint]`：默认值取 CC Desk 自己的设置（`settings.json` 里的 `login.url`、`login.fingerprint`、`deviceId`，不读 `login.token`）；凭据由 `security add-generic-password -U -w` 在终端里提示用户输入（不经过命令行参数和环境变量）；写回 `gateway.json` 的 `ccdesk` 段（原子写、0600）。`ccdesk logout` 删钥匙串项和配置段；`ccdesk status` 只报是否配置、是否找到本机接口。
- 证书：配置了指纹时只认该指纹（握手后、发送凭据前核对）；没配时走系统 CA。

## 事件到手机快照的映射

| CC Desk 事件 | 手机快照 |
| --- | --- |
| `message.user` | `user_message`，`id = u:<messageId>`；匹配到本次发送的 `clientMessageId` 时，送达状态变为 confirmed |
| `text.delta`（记录 + 片段） | `agent_message`，`id = a:<messageId>`；文字 = 已记录部分 + 尚未记录的片段，收到同一键的记录事件时清空片段；该轮 `completed` 时最后一条标 `final_answer` |
| `tool.requested` / `tool.input` | `function_call`，`Tool: <name>` + `Command:`（Bash）或输入摘要 |
| `tool.output` / `tool.result` | `function_call_output`，保留结尾 4000 字符 |
| `approval.requested` | 工具为 `AskUserQuestion` → `questions`；其他 → `permissions`（`decisions: ["once","reject"]`） |
| `approval.resolved` | 移除对应卡片 |
| `run.status` | `running` / `awaiting_approval` → 运行中；`completed` / `cancelled` / `failed` → 空闲，并给 `lastTurn` |
| `run.error` | 一条 `agent_message`：“出错：…” |
| `thinking.delta`、`native.*`、`turn.stats`、`message.delivery` | 不进消息；只影响活动状态（思考/工作/输出） |

- 快照最多带最近 240 条消息，`historyCursor` 为最早一条已加载事件的序号（还有更早时）。
- 回答提问：`approval.reply`，`allowed: true`，`answers` 以问题原文为键，多选用 `", "` 连接。
- 权限：`once` → `allowed: true`，`reject` → `allowed: false`；不提供 `always`。
- 发送：`requestId` = 手机的 `clientMessageId`（UUID），超时或连接中断后同一 ID 重发不会重复。运行中发送 = 插话（`canSteer`）。
- 错误码：`CCDESK_NOT_CONFIGURED`、`CCDESK_TOKEN_MISSING`、`CCDESK_AUTH_FAILED`、`CCDESK_PROTOCOL_UNSUPPORTED`、`CCDESK_CERT_MISMATCH`、`CCDESK_CONNECTION_FAILED`、`CCDESK_CONTROL_UNAVAILABLE`、`CCDESK_OTHER_DEVICE`、`CCDESK_STALE_CONTROL`、`CCDESK_REQUEST_EXPIRED`、`CCDESK_BUSY`。

## 手机端

- `AgentWorkspace.tsx` 白名单加 `ccdesk` + `ccdesk-ws`；说明文字、空列表提示、“会话能力”说明；历史翻页沿用 DeepSeek 的游标方式。
- `features/agents/runtime.ts`：`ccdesk` 会话 ID 为 UUID。
- 只改网页层，可走界面更新通道（发版仍等用户说“发”）。

## 测试

- CI：`apps/relay/tests/ccDesk.test.mjs`，进程内假服务端（协议 17 子集）+ 假本机接口：列表、订阅与片段拼接、历史翻页、提问与权限映射、发送/停止/审批、其他电脑的会话只读、凭证缺失与协议不符、证书指纹不符时不发送凭据。
- 本地：真实 CC Desk 服务端（模拟模式）+ 改过的转发层 + 网关适配器，端到端跑一遍；再在真实环境用测试会话验收。

## 实现情况（11-15）

- 网关：`apps/relay/src/agents/ccDesk{Protocol,Connection,Control,Transcript,Adapter}.ts`，命令行 `gateway/ccDeskSetup.ts`。证书：配了指纹只认指纹，没配走系统 CA（CC Desk 的自签证书因此必须配指纹）。
- 手机：列表过滤已认 `sessionApi: 1`，不用另加白名单；历史翻页走通用方式（与 Claude 通道相同，最多 190 条）。补了说明文字、`ccdesk` 会话 ID 校验，以及 `CCDESK_OTHER_DEVICE`、`CCDESK_CONTROL_UNAVAILABLE`、`CCDESK_RUN_ACTIVE`、`CCDESK_BUSY`、`CCDESK_TOKEN_MISSING` 的提示。
- 测试：`ccDesk.test.mjs` 8 项（CI）；本地端到端 `integrations/cc-desk/test/e2e-gateway.mjs` 11 项通过。
- 剩下：升级电脑上的网关；用户在终端运行 `ccdesk login`，重启网关；真实环境用测试会话验收；手机界面更新等用户说“发”。

## 不做

- 新建会话（W3b）：仍走一次性定时任务文件，另做。
- 后台任务停止、`run.continue`：等手机端有入口再开。
- 旧 Claude 插件通道（`claude`）保留，C2 稳定一版后按 C3 下线。
