# CC Desk 手机控制（路线 A）

让 MobiCodex 在手机上给 CC Desk Tunnel 的会话发消息、审批、回答提问、停止。只适用于 CC Desk Tunnel 客户端 **0.3.2**（协议 17）：这个版本的服务端只接受会话所在电脑上、带执行通道的那条连接发来的写操作，也就是 CC Desk 窗口自己的连接。服务端 0.3.3 起官方支持从另一台设备操作会话，能升级的话不需要这个补丁。

## 它做什么

- **不改原版**：复制一份客户端到 `~/Applications/CC Desk Tunnel（手机控制）.app`，只改副本 `app.asar` 里的转发层 `electron/proxy-bridge.mjs`（加 5 处挂钩），再放进 `electron/mobicodex-control.mjs`。
- **本机接口**：副本的主进程开一个 Unix socket（目录 `~/.mobicodex/ccdesk/`，权限 0700；socket 0600），不开网络端口。
- **只放行五种指令**：`message.send`、`approval.reply`、`run.cancel`、`run.continue`、`run.task.stop`。删会话、改设置、登录、终端等一律拒绝。
- **借窗口的连接发出**：指令进的是窗口现有的连接，服务端看到的就是这台电脑在操作，命令照样在这台电脑上执行，手机发的消息在窗口里和自己打字一样。
- **不打扰窗口**：服务端对这些指令的回复截回给 socket，不给窗口；只有手机在操作、窗口没打开的会话，其实时事件不转给窗口（窗口会把任何会话的用量读数当成当前会话的）。窗口打开了那个会话，就照常实时显示。
- **读消息不走这里**：服务端每条连接同时只能跟一个会话，借窗口的连接读会把窗口正在看的会话顶掉。MobiCodex 网关用自己的连接读（不建执行通道）。服务端按设备隔离会话时，网关以窗口报的同一个设备身份读：挂钩记下窗口登录时的设备名和设备 ID（不记凭据），经本机接口告诉网关。

## 安装

```sh
node integrations/cc-desk/patch.mjs install
```

脚本先核对原版：版本必须是 0.3.2，转发层文件的 SHA-256 必须与原版一致，否则拒绝。生成副本后逐个文件读回核对，并在独立 Node 进程里加载一次改过的转发层。

然后退出 CC Desk，打开副本。副本与原版共用同一套设置和登录（不用重新登录），两者不能同时开（CC Desk 每个配置目录只允许一个实例）。

- 副本复制时去掉了下载隔离标记：原版当初下载后你已批准过；副本的签名封印不再覆盖改过的 `app.asar`（`codesign --verify` 会报 sealed resource invalid），带着隔离标记会被系统拦下。可执行文件本身没变。
- 第一次打开副本，系统可能弹钥匙串授权（CC Desk 读取保存的登录凭据），点「始终允许」；拒绝的话在副本里重新输入一次凭据即可。
- `node integrations/cc-desk/patch.mjs status` 查看原版、副本和本机接口的状态。

## 还原

退出副本，打开原版即可，原版从未改动，服务端也没有任何改动。不再需要时 `node integrations/cc-desk/patch.mjs remove` 把副本移到废纸篓。网关找不到本机接口会自动回到只读。

## 接入手机（网关）

1. 在这台电脑的终端里运行（凭据只在这里输入一次，存进钥匙串，不写进任何文件、命令行参数或环境变量）：

   ```sh
   node dist-plugin/mobile-codex/scripts/mobile-codex.mjs ccdesk login
   ```

   服务地址、证书指纹和这台电脑的设备 ID 默认取 CC Desk 自己的设置（不读它保存的凭据）；不一样时加 `--url wss://…/ws`、`--fingerprint <SHA-256>`。登录前先连一次服务端核对凭据和证书。
2. 重启网关（`stop` 再 `start`）。手机的 Agent 列表里出现“CC Desk”。
3. `ccdesk status` 查看是否配置、钥匙串里有没有凭据、找没找到本机接口；`ccdesk logout` 删除凭据和配置。

网关读消息用自己的连接（每个打开的会话一条，最多 8 条），写操作只经本机接口。

- 服务端开着 `PROXY_SESSION_VISIBILITY=device` 时，每台电脑只看得到自己的会话，网关得说自己是这台电脑。服务端还会按连接报的名字给这台电脑的所有会话改名，所以网关用的设备名和 ID 必须和窗口报的一字不差（取自本机接口，不自己猜：CC Desk 用启动时的主机名，主机名会变）。
- 窗口断开，网关的读连接也跟着断开，不在服务端上替这台电脑占着席位；关连接时不发 `leave`（从这台电脑最后一条连接发出，会立刻结束它正在跑的任务）。
- 所以开的是原版 CC Desk 时，手机上看不到 CC Desk 的会话，会提示打开副本。服务端共享可见时，其他电脑的会话只能看、不能发，卡片上写明原因。

## 本机接口协议

每个 CC Desk 配置目录（每个连接）一个 socket：`~/.mobicodex/ccdesk/<配置目录的哈希>.sock`，旁边的同名 `.json` 写着 `profile`、`service`（服务地址）、`pid`、`controlVersion`。每行一个 JSON：

```json
{"id":"1","op":"status"}
{"id":"2","op":"command","command":{"type":"message.send","requestId":"<uuid>","sessionId":"<uuid>","text":"……"}}
```

- 应答：`{"id":"2","ok":true,"response":{"ok":true,"sessionId":"…"}}`；`response` 是服务端的回复，`response.ok` 为假时带 `code`、`message`（比如 `other_device`）。
- 本地拒绝：`{"id":"2","ok":false,"error":{"code":"not_ready","message":"…"}}`，`code` 为 `not_ready`、`not_connected`、`not_allowed`、`bad_request`、`duplicate`、`timeout`、`connection_closed` 之一。
- 连上时和状态变化时推送 `{"event":"state","state":{"connected":true,"writable":true,"adapter":"claude-code","connectionId":"…","serviceVersion":"0.3.2","protocolVersion":17,"device":{"id":"…","name":"…"},"controlVersion":1}}`。`writable` 在执行通道就绪后才为真；`device` 是窗口登录时报的设备 ID 和设备名（窗口带了平台时也带 `platform`），窗口还没登录时为 `null`。
- `requestId` 就是这条消息的 ID：超时或连接中断后用同一个 `requestId` 重发，服务端不会重复执行。

## 边界

- 副本要开着手机才能操作；服务端按设备隔离会话时，连看也要副本开着。
- 本机以同一账号运行的程序都能用这个接口，与它们本来就能读这个账号的文件、凭据是同一信任级别；不对网络开放。
- CC Desk 客户端升级后要重新生成副本；脚本只认 0.3.2 的原版文件。

## 测试

- `pnpm test:ccdesk`：asar 读写、挂钩、指令过滤与回复路由、本机接口（CI 运行）。
- `apps/relay/tests/ccDesk.test.mjs`（也在 `pnpm test:ccdesk` 里）：网关的 CC Desk 接入，对着进程内的假服务端和假本机接口。
- 本地端到端（需要 CC Desk 服务端程序，不在本仓库）：`test/e2e-fixture.mjs` 让改过的转发层连离线模拟模式的服务端；`test/e2e-electron.mjs` 用副本本身、独立配置目录登录模拟服务端，经本机接口发消息并截图；`test/e2e-gateway.mjs` 让网关的 CC Desk 接入对着模拟服务端和改过的转发层，从手机这一侧发消息、审批、回答提问、停止（先构建 relay）。
