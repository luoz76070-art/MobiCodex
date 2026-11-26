# Mobile Codex for DeepSeek Harness

DeepSeek **官方** `dsh` 原进程 Cordis bundle。插件0.3.0支持 0.2 线（`>=0.2.1-rc.2 <0.3.0-0`），其中 `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.5`、`0.2.2-rc.1`、`0.2.2-rc.3`、`0.2.2-rc.5` 已跑过官方隔离检查；其他 0.2.x 按“未验证”运行，启动时逐项核对核心接口，见[版本范围与逐项核对](#版本范围与逐项核对插件03062)。不因版本号相同就假定内部接口一致。官方安装器/profile使用engines版本门，不通过SDK或新CLI代替原线程。

插件0.2.3将原生失败轮次显示为“DeepSeek Harness 运行提示”，包括模型暂不可用、请求被拒绝、网络连接失败等固定说明。实时与历史共用投影，重开不重复，不输出原始服务端错误或凭证；失败不标记为成功终稿，也不自动重发。沿用APK36现有消息协议，手机已送达的输入继续保留在会话中。

插件0.2.0可选择`scope: "all"`：原profile跨工作区普通线程和未加载历史，保留真实缓存标题、分页列表和按需历史。默认列表为近30天（官方最后用户对话/创建时间），仍运行或当前查看的线程保留；“查看更早会话”展开全部。摘要缓存15秒、原消息/创建/状态事件失效，手机列表前台每30秒及回前台刷新；无手机请求不扫描正文。不会删除更早的桌面记录。

查看和翻页不会启动任务。只有手机显式发送时，才经原官方`sessionController.prompt`在同一Host恢复同一sessionId；accepted仍须等待原user/message的rpcId确认。原在线任务继续用live handle排队、追加/中断，未知结果锁定不重发。中断确认表示原任务结束，不保证结束原因一定是取消。旧配置默认`directory`，继续仅精确目录内在线根会话。

支持原生提问、完整计划及工具单次允许/拒绝；两端先答生效。拿不到完整工具参数时只提供拒绝。文本按官方page读取，每页40条/256KiB，单条32768字符；手机历史窗口240条，可继续前移并返回最新。附件、工具过程和推理不作为聊天正文同步，历史提问不复活为待答卡片。连接前正在输出的部分文本可能需等权威消息补齐。directory模式保留原4096事件的大log降级规则。

插件0.2.8新增回合对应（W4b）：手机消息以 `user/message` 进入回合时，记下“这条 clientMessageId 由哪个回合消费”。官方事件契约保证该事件位于所属回合的 `turn/start` 与 `turn/end` 之间，被拒绝的步骤不产生该事件，所以不靠猜。每个原会话保留最近16条，无订阅时也保留；网关据此把交接事项在回合完成后转到待验证，失败或中断时退回。同时随附 S1/S2 的每轮结果与活动证据。

插件0.2.5向配套手机与网关提供当前手机待发项：仅当该输入仍在原生 `inbox.nextTurn` 时可查看和取消。取消只调用 `inbox.remove(messageId)`，保留当前任务及其他桌面待发项。沿用一次未确认输入限制；排队接纳不代表已经执行，取消结果未知时锁定且不自动重试。插件重载不会恢复手机提交映射，更新前需确认没有未决输入。

## 准备

先运行仓库的 `corepack pnpm build:plugin`，独立目录为 `dist-plugin/mobile-deepseek/`。本机需要已安装兼容的官方 Harness；本项目不会自动安装或升级它。

创建私有配置文件，例如 `/absolute/private/deepseek-mobile.json`（父目录0700，文件0600）：

```json
{
  "port": 9876,
  "token": "REPLACE_WITH_AN_INDEPENDENT_RANDOM_BASE64URL_SECRET",
  "directory": "/absolute/project",
  "scope": "all"
}
```

密钥需32–512位 base64url 字符；单独生成，不复用手机、管理或 Claude 密钥。仅监听127.0.0.1；不要把9876端口暴露公网。一个桥接对应一个原dsh进程；同一端口被占用时加载失败。多进程分别使用端口和配置，不自动聚合。

在**原有 profile** 中显式安装（以下命令中的路径和profile由使用者替换）：

```sh
dsh plugin --profile EXISTING_PROFILE add /absolute/dist-plugin/mobile-deepseek
```

在启动该原profile的终端设置私有配置路径：

```sh
export MOBILE_CODEX_DEEPSEEK_CONFIG=/absolute/private/deepseek-mobile.json
```

CLI profile可用官方 `dsh --profile EXISTING_PROFILE --dump-config` 在不启动模型的情况下检查bundle层。不要为手机连接创建另一个profile或恢复另一个模型会话；已运行的进程须实际加载此插件才可接入。

### macOS 官方桌面版

桌面版的原profile为`desktop`。其CLI不一定在PATH中，可使用应用自带的入口安装：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add --offline --ignore-scripts /absolute/fixed/mobile-deepseek
```

此包没有运行依赖，离线链接即可；保留profile现有的`autoInstallPeers: false`，共享宿主的`dsh-llm`，不另装一套宿主依赖。pnpm可能提示linked peer依赖，最终以宿主实际加载和鉴权bridge响应为准。

GUI进程通常不会继承终端export。先备份`~/.dsh/profiles/desktop/cordis.patch.yml`，在原有列表后增加以下覆盖，并使用前文私有JSON配置的绝对路径：

```yaml
- id: mobile-codex
  name: dsh-mobile-codex
  config:
    configFile: /absolute/private/deepseek-mobile.json
```

官方桌面版允许自带CLI管理`desktop`的插件，但禁止通过普通`dsh --profile desktop`或`--dump-config`启动/检查这个保留profile。桌面HMR会监视profile manifest和patch；新插件可动态加载到原进程。检查桌面“插件”页启用状态及鉴权`/info`、`/sessions`的实际响应，不把安装命令成功当作已经加载。如果宿主启动时已经拒绝过旧插件（例如 DeepSeek 先升级、插件后更新），换上新插件后不会自动重载：在“插件”页把 Mobile Codex 关掉再打开，或把 `cordis.patch.yml` 里该项的 `disabled` 改成 `true` 再改回 `false`（2026-11-26 本机实测）。若宿主报告需要重启，等待原任务安全结束后正常重启，不为接入强停任务。2026-10-21本机动态加载及公网只读复核见[实际接入记录](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/deepseek-desktop-connect.md)。

网关的私有 `gateway.json` 加入：

```json
{
  "deepseek": {
    "url": "http://127.0.0.1:9876/",
    "token": "SAME_AS_THE_PRIVATE_BRIDGE_TOKEN",
    "directory": "/absolute/project",
    "scope": "all"
  }
}
```

这是新增字段示例，保留原配置其余字段。显式重启网关后，手机“切换 Agent”中选择 DeepSeek Harness，再选原线程。APK22提供近30天/更早切换与连续历史窗口；APK21可继续使用默认近期列表和已有控制，但其历史显示上限仍190条。命令行Relay也支持 `MOBILE_CODEX_DEEPSEEK_URL/TOKEN/DIRECTORY`。

## 验证与回退

`corepack pnpm test:deepseek` 使用合成Cordis上下文和随机端口，不运行真实模型。`node scripts/check-deepseek-history.mjs /absolute/isolated-runtime`另以当前安装包官方list/page/prompt算法、真实SessionStore/Query与合成持久化/resolver检查冷历史；不读取用户profile，不调用模型，也不能代替用户真实继续验收。

另可显式运行 `node scripts/check-deepseek-runtime.mjs /absolute/isolated-runtime`；目录需已包含同版的官方`@deepseek-ai/dsh`、`@deepseek-ai/dsh-agent-loop-testkit`及其依赖（0.2.1-rc.2/rc.3/rc.5配Cordis4.0.5，0.2.2-rc.1/rc.5配Cordis4.1.0）。新版官方运行时须用Node >=24.9.0执行检查。检查器不安装依赖，使用临时profile验证bundle解析/版本门/CLI配置、Loader与内存Session/事件总线、依赖卸载/恢复和端口释放；再以官方生产AgentLoop及本地确定性adapter验证排队、追加、流与权威文本去重、中断保留Inbox和旧任务令牌拒绝。2026-10-21此13项及隔离回归22/22通过，3次本地响应、外部模型请求0次。最后清理自己的Context/profile；不读取用户配置或原会话。

插件0.1.1修复官方流的revision逐帧递增校验，拒绝旧revision、错attempt和错index，避免正文被全部过滤。APK21和网关无需更换；宿主需要显式加载此修复插件。安装、加载和原会话控制须分别验收，隔离检查不代表Android真实控制已经通过。

卸载使用 `dsh plugin --profile EXISTING_PROFILE remove dsh-mobile-codex`，并删除网关deepseek字段；只停止该插件的监听与订阅，不终止原Agent或清空其inbox。进程重启后不承诺跨重启exactly-once；不对结果未知的输入重新发送。

## rc.3升级边界

插件从宿主共享的`@deepseek-ai/dsh-llm/package.json`读取实际版本，用于`/info.harnessVersion`，不能硬编码rc.2让新版宿主伪装通过。0.2.9及以前按精确白名单校验，缺失/未知版本拒绝启动；0.3.0起改为范围加逐项核对，见末节。对应网关也必须接受rc.3；只改插件或只改网关均不完整。APK36沿用，无需为本次桥接兼容重新安装。

本次两版官方隔离检查各通过13项运行时、8项问答审批和4项历史；只登记本地确定性adapter，不读取用户profile或调用外部模型。部署和原手机结果另记[rc.3验收记录](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-30/deepseek-rc3-compat.md)。

## rc.5升级边界

原宿主重开后已升级rc.5，0.2.2及未安装的0.2.3候选均被官方版本门拒绝。0.2.4在保留失败提示的同时精确接纳rc.5，配套网关的deepSeekInfo也需更新；未知rc.4/rc.6仍拒绝。当前官方rc.5的10个关键生产入口与rc.3字节相同，运行时13项、审批8项、历史4项隔离检查通过，审批方法指纹保持严格。真实手机和模型服务恢复另见[本轮验收记录](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-30/deepseek-control-acceptance.md)。

## 0.2.2-rc.5升级边界（插件0.2.9，#62）

桌面版 11-18 自动升级到 0.2.2-rc.5（Cordis 4.1.0），0.2.8 被版本门拒绝，9876 不再监听，手机上 DeepSeek 连不上。manifest、bridge、网关握手和三个官方检查脚本同时加入 rc.5；未知 rc.4/rc.6 仍拒绝。

官方隔离检查（隔离运行时：本机桌面版 app.asar 只读提取的 dsh 0.2.2-rc.5 + npm 官方 dsh-agent-loop-testkit 0.2.2-rc.5，sha512 与 registry 一致；宿主自带 Node 24.21.0）：runtime 14、interactions 12、history 4，共 30 项通过；外部模型请求 0，夹具模型请求 3，未改用户 profile、未读原会话、未做真实审批。

这种逐版本适配在 0.3.0 改掉了，见下节。

## 版本范围与逐项核对（插件0.3.0，#62）

- **版本范围**：`engines.dsh` 改为 `>=0.2.1-rc.2 <0.3.0-0`。官方加载器比较时计入预发布版本，所以 0.2 线上的新版本直接加载；0.3 及以后仍被官方版本门拒绝。
- **已验证名单**：`bridge.mjs` 的 `verifiedHarnessVersions` 只列跑过三个官方隔离检查的版本。其他 0.2.x 按“未验证”运行：`/info` 返回 `verified: false`，手机在 DeepSeek 旁提示“还没经过 MobiCodex 验证”。
- **核心接口逐项核对**：启动时检查 `dsh-llm.createUserMessage`、`ctx.on`、`ctx.agents`、`ctx.sessionQuery.observeSession`。缺任何一项，或版本不在 0.2 线（只可能来自手动豁免），桥接只回答 `/info`（`compatible: false` 和缺失项），其余请求一律返回 503，不碰宿主；手机显示是哪项接口变了。
- **可选能力单独停用**：问答和审批继续按官方方法源码指纹核对，对不上只停这部分（`interactions: false`），查看和发消息不受影响；历史分页继续单独检查 `sessionController`。
- **连不上时说清原因**：网关只读本机 `/Applications/DeepSeek Harness.app` 的版本号和 `~/.dsh/profiles/desktop` 链接的插件版本与版本范围，区分“DeepSeek 已更新、插件不支持”“还没装插件”“需要把插件关掉再打开”和“DeepSeek 没开”。手机读取 Agent 列表时，网关最多每 30 秒刷新一次 DeepSeek 状态（只调 `/info` 和会话目录，不读会话正文）。
- **网关握手**：接受插件给出的任意格式正确的版本号；旧插件不带 `verified` 时按已验证处理。

DeepSeek 出新版本后，运行 `corepack pnpm check:host-versions` 查看本机 DeepSeek/OpenCode 是否在已验证名单（退出码 2 表示需要处理）；不在就按“验证与回退”跑三个隔离检查，通过后把版本加进 `verifiedHarnessVersions`。

0.3.0 在 0.2.2-rc.5 隔离运行时复核：runtime 14、interactions 12、history 4 项全部通过，外部模型请求 0。

