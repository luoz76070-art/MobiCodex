# F7 本机反馈收件箱（part 1）

- `POST /api/feedback` / `GET /api/feedback` 沿用 `/api/*` Bearer 与配对设备 owner；不能由正文指定 owner。GET 只返回当前 owner，`Cache-Control: no-store`。
- POST JSON：`clientId` UUID、非空 `text`（最多 2000 UTF-16 单位）、`context` 白名单；可选 `screenshot: {mimeType, dataBase64}`。context 必含 version≤80、versionCode 非负整数、page≤80、agentId≤64、sessionId≤160、lastError≤200、model/os≤120。空值用空串表示。
- 截图仅 PNG/JPEG/WebP，解码后≤5MiB，严格 base64 + 文件头/结构/MIME 检查；复用 capture 图片验证去除 EXIF 等元数据。不使用客户端扩展名或文件路径。全局 bodyLimit 之外另有反馈路由上限。
- `FeedbackStore(dataDirectory)` 只写 `dataDirectory/feedback/`；独立 Relay 默认采用 `defaultGatewayConfigPath()` 的父目录，托管 CLI 按实际 `--config` 文件的父目录传入。不得以 defaultCwd/项目目录派生反馈路径。测试注入临时私有目录。
- 目录 0700、JSON/截图 0600。文件名是 owner+clientId 的 SHA256，JSON 先写临时文件再 rename；拒绝符号链接目录/JSON。单网关串行创建，每设备滚动一小时最多 20 条，计数由落盘 createdAt 恢复。重复 clientId 不占额度、不改原文或状态，设备之间独立。
- 每条 `<id>.json` 可配同名 png/jpg/webp；只有 JSON 是正式收件回执。JSON 保留 owner（设备 ID，不是凭证）；HTTP 回包去掉 owner，截图仅返回 MIME/大小，不返回文件名、绝对路径或 base64。
- 人工仅修改 JSON 的 `status` 对象：`{"state":"received"}` / `{"state":"filed","issue":123}` / `{"state":"fixed","version":"0.3.2"}` / `{"state":"dismissed","reason":"已有相同反馈"}`。保持其余字段及权限；GET/重试从磁盘重读，不缓存状态、不提供修改 API、不自动创建 issue。未知/损坏记录返回收件箱不可用，不覆盖。
- 隔离命令：`corepack pnpm test:feedback`；包含鉴权先于解析、限长、三类截图及伪装/超限、并发幂等、重启、人工状态、设备隔离、限流、权限及符号链接拒绝。
- 本轮不提供截图下载接口或自动清理策略。人工复盘先检查个人信息及截图，再自行提 issue；收件箱保留由管理员维护。
