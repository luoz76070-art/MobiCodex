# MobiCodex 工程档案入口

更新：2026-11-18

## 作用

继续施工前，先读本文件，再按链接读取对应的工程文件。不能只靠聊天记忆推进：需求变更、技术判断、实测结果和阶段验收都要落到仓库里。需求和问题在 GitHub issue 里跟踪。

## 项目现在是什么

- MobiCodex 用手机管住电脑上的 AI 编程助手，由三部分组成：Android App（`apps/mobile`）、跑在电脑上的网关（`apps/relay` 和 `plugins/mobile-codex`），以及用户自己的 Broker。网关主动连 Broker，电脑不用开放端口。
- 支持的 Agent：Codex 桌面端、Claude Code、Claude CLI、DeepSeek Harness、CC Desk、OpenCode。各自能做什么，见 [README](../README.md#支持的-agent)。
- 最新发布是 0.4.0（code43，2026-11-17），历次变化见 [CHANGELOG](../CHANGELOG.md)。发布由推 `mobicodex-v<版本>` tag 触发 [release-android.yml](../.github/workflows/release-android.yml)。
- 0.1.x 的 Kelivo 整合版已经停止，0.2.0 起是独立 App。Kelivo 源码和早期过程记录在归档 tag `archive/pre-cleanup-2026-11`，摘要见 [history.md](history.md)。

## 从哪里读起

- [AGENTS.md](../AGENTS.md)：本项目约定和 Trellis 入口。
- [project-layout.md](project-layout.md)：目录结构、各模块职责和常用命令。
- `.trellis/spec/`：前后端规范与契约，改哪一层代码先读那一层。
- [verification.md](verification.md)：本地验证入口；CI 见 `.github/workflows/ci.yml`。
- 进行中的计划（[docs/plans](plans/)）：
  - [Blurt 优化方案](plans/2026-11-12-blurt-mobicodex-optimization.md)
  - [任务清单](plans/2026-11-13-blurt-optimization-task-list.md)
  - CC Desk：[C0](plans/2026-11-14-c0-cc-desk-control.md)、[C2](plans/2026-11-15-c2-ccdesk-gateway.md)
  - Claude CLI：[C4](plans/2026-11-17-c4-claude-cli-channel.md)、[C4a](plans/2026-11-17-c4a-claude-cli-readonly.md)、[C4b](plans/2026-11-17-c4b-claude-cli-run.md)
  - [F3 分享入口和桌面快捷方式](plans/2026-11-15-f3-share-and-shortcuts.md)

## 文档目录

产品与交互：
- [product-requirements.md](product-requirements.md)：产品需求规格。
- [ui-interaction-spec.md](ui-interaction-spec.md)：手机端 UI 与交互规范。
- [voice-prompt-feasibility.md](voice-prompt-feasibility.md)：语音输入与提示词整理。

架构与接入：
- [architecture-feasibility.md](architecture-feasibility.md)：架构方案、实测证据和风险边界。
- [agent-gateway.md](agent-gateway.md)：插件化网关和其他 Agent 的接入方式（SessionAdapter）。
- [mobile-session-remote-connectivity.md](mobile-session-remote-connectivity.md)、[mobile-session-control-plugin-requirements.md](mobile-session-control-plugin-requirements.md)：远程连接与会话控制插件的需求。
- [technical-notes.md](technical-notes.md)：协议、后端和平台限制。

部署与运维：
- [usage.md](usage.md)：部署、启动、APK 构建和换电脑。
- [remote-broker.md](remote-broker.md)：公网 Broker 部署。
- [network-plan.md](network-plan.md)：局域网、IPv6 和公网路线。
- [online-update.md](online-update.md)：App 内更新和界面热更新。
- [ops/remote-connection-repair.md](ops/remote-connection-repair.md)：公网连接维护与回退。
- [ops/version-sync.md](ops/version-sync.md)：本地分步提交与版本同步。
- `docs/html/`：IPv4、IPv6、Token、自启动和排错的单页教程。

发布与验收：
- [github-actions-release.md](github-actions-release.md)：GitHub Actions 发布。
- [github-public-release-plan.md](github-public-release-plan.md)：公开仓库发布检查表。
- [github-package.md](github-package.md)：仓库里放什么、不放什么。
- [test-and-acceptance-plan.md](test-and-acceptance-plan.md)、[safety-and-acceptance.md](safety-and-acceptance.md)：测试、安全硬约束和验收原则。

历史记录：
- [history.md](history.md)：10-20 至 11-14 的阶段摘要和原始审计索引。
- [implementation-roadmap.md](implementation-roadmap.md)、[construction-plan.md](construction-plan.md)：早期施工路线。
- [legacy-notes.md](legacy-notes.md)、[v1.1-upload.md](v1.1-upload.md)、[v1.1.1-upload-fix.md](v1.1.1-upload-fix.md)、[ops/repo-boundary-migration-2026-11-13.md](ops/repo-boundary-migration-2026-11-13.md)：旧方案和旧版本记录。

## 不应再继续的方向

- 不把首页做成连接诊断页。
- 不做远程桌面画面同步。
- 不把主工作流降级成 `codex exec` 或独立 CLI 会话。
- 不修改 Codex Desktop 安装目录、系统环境变量、注册表或全局防火墙策略。
- 不把手机另开的 app-server 会话伪装成 Desktop 当前窗口的同步控制。
- 不再把早期扫码网页 bridge 作为主线。
- 不在仓库提交 APK、`.app`、`node_modules`、上传文件、token 或本地日志。

## 文档维护规则

- 做代码改动前，先确认它属于哪个 issue 或计划。
- 每次 APK 构建、网关实测、手机真机测试，都要更新 README、CHANGELOG 或对应 docs。
- 架构判断变了，更新 `docs/architecture-feasibility.md` 或 `docs/remote-broker.md`。
- 产品范围或交互方式变了，更新 `docs/product-requirements.md` 或 `docs/ui-interaction-spec.md`。
- 每次发版后，按 #40 审一遍 README 全篇，并用合成数据重截核心截图。
