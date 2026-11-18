# 工程布局

更新：2026-11-18，仓库整理（#41）之后。整理前的完整目录在归档 tag `archive/pre-cleanup-2026-11`。

## 顶层

```text
MobiCodex/
├── AGENTS.md                 # 本项目约定与 Trellis 入口，Codex 会话会读它
├── README.md、CHANGELOG.md、NOTICE、SECURITY.md、CONTRIBUTING.md、LICENSE
├── .trellis/                 # Trellis：spec/ 前后端规范与契约，tasks/ 任务与归档，workspace/ 续接记录，scripts/
├── .agents/skills/           # Trellis 技能（Codex 会话用）
├── .codex/                   # 本项目的 Codex 配置和 hooks，会往 Codex 会话里注入 Trellis 状态
├── .github/workflows/        # ci.yml：每次推送和 PR；release-android.yml：推 mobicodex-v<版本> tag 时发版
├── apps/
│   ├── mobile/               # MobiCodex Android App：React 页面 + Capacitor 原生壳（android/）
│   └── relay/                # Fastify：电脑网关、各 Agent 适配器、Broker 与 Tunnel
├── plugins/                  # 电脑端插件包：mobile-codex（网关）、mobile-claude、mobile-deepseek、codex-live-session
├── integrations/cc-desk/     # CC Desk 的补丁副本和本机 socket 控制
├── shared/                   # 手机和网关共用的类型声明
├── scripts/                  # 构建、测试、发布、更新清单、原生 helper；manager/ 和 *.ps1 是 Windows 管理器与启动脚本
├── releases/android/mobicodex/<版本>/README.md   # 各版本发布说明；APK 在 GitHub Releases
└── docs/                     # 产品、架构、运维文档；plans/ 是进行中的计划，history.md 是早期过程摘要
```

`output/`、`dist-*/`、`node_modules/`、`apps/mobile/android/build/` 等本地产物都被忽略，不进仓库。

## apps/mobile/src

- `main.tsx`：只负责挂载 React 和全局样式。
- `app/`：App 编排、导航、全局设置、会话目标和类型。
- `features/`：
  - 会话和 Agent：`agents/`（选择 Agent、各 Agent 的工作区和会话列表）、`chat/`（消息与渲染）、`threads/`、`handoff/`。
  - 输入：`voice/`、`quickCommands/`、`capture/`、`intake/`。
  - 其他功能：`workItems/`（事项）、`connection/`（连接、档案与诊断）、`notify/`、`feedback/`、`quota/`、`updates/`、`product/`（宿主与独立模式）。
- `shared/`：通用组件（标题栏、空状态、骨架屏、下拉刷新等）。
- `styles.css`：设计令牌和样式。`scripts/test-mobile-design-tokens.mjs` 会对照 `scripts/fixtures/a1-palettes.json` 检查配色。

## apps/relay/src

- 入口：`server.ts`（Node）、`serverExe.ts`（Windows SEA）、`brokerServer.ts`、`remoteTunnelClient.ts`。
- `gateway/`：电脑网关的启动、配置、诊断、macOS 后台服务、保持唤醒，以及 CC Desk 安装。
- `agents/`：统一的 SessionAdapter 和各家适配器，包括 Claude（插件和 CLI）、DeepSeek、CC Desk、OpenCode。
- `codex/`、`desktop/`：Codex app-server、turn，以及 Codex Desktop IPC 和 macOS 输入。
- `server/`：路由和 SSE；`transport/`：Broker、Tunnel、协议与心跳。
- `store/`、`workItems/`、`voice/`、`capture/`、`attention/`、`feedback/`：存储和对应功能的后端。
- `smoke/`：人工集成 smoke 和探测。

## 工作入口

每次先读 `docs/project-index.md`、对应的 `.trellis/spec/` 和当前任务。

```bash
python3 .trellis/scripts/get_context.py --mode packages
python3 .trellis/scripts/task.py list
corepack pnpm install --frozen-lockfile
corepack pnpm verify      # 本地完整验证，见 docs/verification.md
corepack pnpm build
```

Trellis 的自动提交保持关闭，提交按 AGENTS.md 里的流程显式进行。
