# 项目历史（2026-10-20 至 11-14）

这段时间的过程审计（`docs/audits/`，103 个文件）和已经做完或作废的计划，已在 2026-11-18 整理仓库时从 main 移除（[#41](https://github.com/luoz76070-art/MobiCodex/issues/41)）。原文都保留在归档 tag [`archive/pre-cleanup-2026-11`](https://github.com/luoz76070-art/MobiCodex/tree/archive/pre-cleanup-2026-11)。

每个版本改了什么，以 [CHANGELOG](../CHANGELOG.md) 为准。这里按阶段记下当时的主线和关键决定，方便回头查原始记录。

## 阶段摘要

1. **10-20：Codex To Phone 1.2.2 审核与首批优化。** 对源码、功能和连接体验做了一次完整审核，修好首次手机公网连接故障，恢复手机直接更新，修正手机工作状态显示。
2. **10-21 至 10-22：多 Agent 网关（1.3.0–1.3.4）。**
   - 交付 Agent 网关候选版。
   - DeepSeek Harness、Claude、OpenCode 的官方运行时逐一做了隔离复核。
   - 网关可以选择交给 macOS 后台托管。
   - 修复手机发送 HTTP 409，Android 兼容修复后过了 APK25 真机验收。
   - 打通 App 内 APK 下载和覆盖安装。
3. **10-23 至 10-24：输入和语音（1.3.5–1.3.14）。**
   - 语音接入百炼协议。
   - Codex 运行中支持排队和直接引导。
   - 输入重复显示连续修了几轮（输入镜像、三路时序、临时输入转正式输入）。
   - 执行过程自动折叠。
   - 定下版本同步流程（以 APK30 源码为基线）。
4. **10-29 至 10-31：可靠性（1.3.15–1.3.17）。**
   - 10-29 做了一次代码复审，随后分五个阶段处理同步和输入可靠性：短诊断与版本定位、正常提示词被误过滤、状态模块和统一验证入口。
   - 检查了 Mac 合盖后手机断线的问题。
   - DeepSeek rc.3 兼容，手机真实控制通过验收。
   - 出了 APK36–38 三个预览。
5. **11-03 至 11-04：Codex 连接恢复。** 排查会话列表和发送按钮置灰；未加载的冷会话也能直接发送。
6. **11-04 至 11-13：Kelivo 整合（0.1.5–0.1.11）。**
   - 过程：风格试迁移 → 原生构建和宿主接入 → 产品接线、设备验收、App 内更新、59 组功能对照证据 → 所有电脑 Agent 统一体验（code9）→ MobiCodex 品牌（code10）。
   - 11-08 接入 Claude Code，11-13 修好 Kelivo 的 Android CI 发布。
   - 11-14 决定停止 Kelivo 整合，0.2.0 起 MobiCodex 改为独立 App。
7. **11-14 之后：独立 App（0.2.0 起）。** 进行中的计划在 [docs/plans](plans/)，发布记录见 CHANGELOG，问题在 GitHub issue 里跟踪。

## 原始审计记录索引

链接都指向归档 tag 里的原文。每天的 `.json` 和 `.mjs` 是对应的验证证据。


### 2026-10-20

- [Codex To Phone 源码、功能与连接体验审核](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-20/README.md)
- [首次手机公网连接故障修复](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-20/connection-repair.md)
- [优化交付与统一实测](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-20/delivery.md)
- [首批优化执行记录](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-20/execution.md)
- [手机直接更新恢复](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-20/update-restore.md)
- [手机工作状态修复](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-20/work-status.md)
- 另有 5 个证据文件（[目录](https://github.com/luoz76070-art/MobiCodex/tree/archive/pre-cleanup-2026-11/docs/audits/2026-10-20)）

### 2026-10-21

- [真实验收前置条件（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/acceptance-readiness.md)
- [固定网关兼容修复上线（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/agent-compat-runtime-upgrade.md)
- [Agent 网关候选交付（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/agent-gateway-candidate.md)
- [Claude 官方校验与无模型运行时复核（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/claude-official-runtime.md)
- [Codex 长会话快照接收修复（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/codex-large-snapshot.md)
- [Codex 问答回包核验（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/codex-question-ack.md)
- [异步选择卡生命周期修复与复测](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/codex-question-lifecycle.md)
- [Codex 手机提问重连保护（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/codex-question-reconnect.md)
- [当前会话手机验收](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/current-session-phone-acceptance.md)
- [手机重复修复与 DeepSeek Harness 预览交付（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/deepseek-dedup.md)
- [DeepSeek Harness 桌面实际接入](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/deepseek-desktop-connect.md)
- [DeepSeek启动配置接线修复](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/deepseek-factory-wiring.md)
- [DeepSeek 手机卡片与单次权限](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/deepseek-interactions.md)
- [DeepSeek 官方运行时与流式修复复核（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/deepseek-official-runtime.md)
- [候选网关切换与手机预览交付（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/gateway-migration.md)
- [原生网关可选macOS后台托管（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/gateway-service.md)
- [旧 Mac 应用清理与当前网关位置](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/legacy-mac-app-cleanup.md)
- [OpenCode 官方服务隔离复核（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/opencode-official-runtime.md)
- [手机发送 HTTP 409 排查与修复预览](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/phone-send-409.md)
- [插件安装前复核（2026-10-21）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-21/plugin-preflight.md)

### 2026-10-22

- [Android 兼容性修复与 APK25 真机验收](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-22/android-compat.md)
- [DeepSeek跨工作区线程与按需历史](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-22/deepseek-history.md)
- [网关退出与重启稳定性](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-22/gateway-shutdown.md)
- [App 内 APK 下载与覆盖安装链路](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-22/in-app-update.md)
- [手机原请求与控制分项验收](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-22/phone-controls.md)
- [Codex近期范围与两Agent项目折叠](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-22/project-groups.md)
- [语音输入本地候选](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-22/voice-input.md)

### 2026-10-23

- [APK32预览源码同步](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/apk32-version-sync.md)
- [百炼协议与独立地址修正 · 2026-10-23](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/asr-protocol.md)
- [运行中输入区收紧](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/compact-running-composer.md)
- [输入区点击修复与Codex运行中排队](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/composer-queue.md)
- [手机输入镜像与缓存重复补修](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/input-mirror-cache.md)
- [APK33真机重复反馈与手机诊断](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/input-persistent-diagnosis.md)
- [输入三路时序与现存缓存补修](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/input-source-transition.md)
- [重复输入的完整过渡测试与修正方案](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/input-transition-test-plan.md)
- [执行过程自动折叠](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/process-collapse.md)
- [Codex运行中直接引导与排队修正](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/running-message-actions.md)
- [引导输入重复显示修正](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/steering-duplicate.md)
- [版本同步流程与APK30源码基线](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/version-sync.md)
- [语音真机确认、质量对照与当前故障 · 2026-10-23](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/voice-live.md)
- [语音网关与 APK26 预览发布](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/voice-release.md)
- [第三方DeepSeek地址与助手重复显示修复](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-23/voice-url-dedup.md)

### 2026-10-24

- [APK35 双气泡复核（尚未修复）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-24/input-display-recheck.md)
- [临时输入转正式输入与旧缓存修复](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-24/input-replacement.md)

### 2026-10-29

- [Mac 合盖后手机断线检查](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-29/clamshell-disconnect.md)
- [2026-10-29 项目代码复审](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-29/code-review.md)
- [阶段四：短诊断、版本和显示身份定位](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-29/compact-diagnostics.md)
- [阶段三：正常提示词误过滤修复](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-29/prompt-visibility.md)
- [同步与输入可靠性：阶段一、二交付](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-29/reliability-fix.md)

### 2026-10-30

- [DeepSeek 手机真实控制验收](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-30/deepseek-control-acceptance.md)
- [DeepSeek Harness rc.3兼容与手机复联](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-30/deepseek-rc3-compat.md)
- [临时轮次身份提升与APK37预览](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-30/indexed-turn-input.md)
- [阶段五：状态模块与统一验证入口](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-30/maintenance-boundaries.md)
- [APK36集成预览交付与真机验收](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-30/preview-validation.md)

### 2026-10-31

- [DeepSeek待发取消与APK38预览](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-10-31/deepseek-queue.md)

### 2026-11-03

- [Codex列表与发送置灰排查](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-03/codex-connection.md)

### 2026-11-04

- [Codex未加载会话发送恢复](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-04/codex-cold-thread-recovery.md)
- [Kelivo 风格试迁移与可行性复核](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-04/kelivo-style.md)

### 2026-11-05

- [Kelivo 原生构建检查收尾](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-05/kelivo-native-closeout.md)
- [Kelivo 原生构建与宿主接入验证](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-05/kelivo-native.md)
- [Kelivo 原生产品接线与独立预览](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-05/kelivo-product.md)

### 2026-11-06

- [Kelivo 整合：设备与本地能力验收](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-06/kelivo-device.md)
- [Kelivo 整合：交接接线与原生预览验收](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-06/kelivo-handoff.md)
- [Kelivo新App：首条真实电脑输入与连接检查](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-06/kelivo-live-connection.md)
- [Kelivo 固定版本：59组证据账本](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-06/kelivo-parity-evidence.md)
- [Kelivo 整合预览：手机下载安装交付](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-06/kelivo-phone-download.md)
- [Kelivo 整合预览：App 内更新](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-06/kelivo-update.md)
- [电脑页对齐 AI 对话页视觉](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-06/kelivo-visual.md)

### 2026-11-07

- [code9 配套网关与 DeepSeek 原桥接恢复](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-07/agent-parity-runtime.md)
- [所有电脑 Agent 统一体验与 code9 预览](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-07/agent-parity.md)
- [code7 App 内更新补发](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-07/app-update.md)
- [code7 真机与图片网关联动](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-07/device-link.md)
- [code8 执行说明常显与详情折叠](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-07/execution-notes.md)
- [电脑页项目外引用图片修复](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-07/image-reference-fix.md)
- [MobiCodex 品牌与 code10 更新](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-07/mobicodex-branding.md)
- [电脑页执行摘要、图片与GitHub预览交付](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-07/remote-rendering.md)
- 另有 11 个证据文件（[目录](https://github.com/luoz76070-art/MobiCodex/tree/archive/pre-cleanup-2026-11/docs/audits/2026-11-07)）

### 2026-11-08

- [Claude Code 沿用原接口接入 MobiCodex](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-08/claude-integration.md)
- [Claude 模型清单与可用性修正](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-08/claude-model-options.md)
- 另有 1 个证据文件（[目录](https://github.com/luoz76070-art/MobiCodex/tree/archive/pre-cleanup-2026-11/docs/audits/2026-11-08)）

### 2026-11-13

- [Kelivo Android CI 与预览发布修复](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/audits/2026-11-13/kelivo-ci-release-fix.md)

### 2026-11-14

- 另有 1 个证据文件（[目录](https://github.com/luoz76070-art/MobiCodex/tree/archive/pre-cleanup-2026-11/docs/audits/2026-11-14)）

## 已归档的计划

下面这些计划已经做完、作废，或者已经并进 #41，原文在归档 tag 里。进行中的计划仍在 [docs/plans](plans/)。

- 2026-10-29：[手机同步与输入可靠性优化计划](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-10-29-reliability.md)
- 2026-10-30：[DeepSeek 手机真实控制验收候选计划](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-10-30-deepseek-control-acceptance.md)
- 2026-10-30：[DeepSeek rc.3兼容与手机复联验收](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-10-30-deepseek-rc3-compat.md)
- 2026-10-30：[集成预览与真机验收](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-10-30-preview-validation.md)
- 2026-11-03：[Codex同步与发送能力修复候选](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-03-codex-connection-recovery.md)
- 2026-11-03：[Kelivo 全功能集成可行性方案](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-03-kelivo-parity-feasibility.md)
- 2026-11-03：[Kelivo v1.3.4 功能对等矩阵](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-03-kelivo-parity-matrix.md)
- 2026-11-04：[Kelivo 与 Codex 远控：统一 Kelivo 风格与双独立功能方案](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-04-kelivo-fast-integration.md)
- 2026-11-05：[Kelivo 原生整合下一轮计划](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-05-kelivo-native-next.md)
- 2026-11-05：[Kelivo 整合预览：原生验收与完整功能接续](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-05-kelivo-product-acceptance.md)
- 2026-11-06：[Kelivo 整合：设备与全功能对照接续](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-06-kelivo-device-parity.md)
- 2026-11-07：[电脑 Agent 通道统一体验](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-07-agent-experience-parity.md)
- 2026-11-07：[code9 电脑通道手机交互验收接续计划](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-07-agent-phone-acceptance.md)
- 2026-11-07：[MobiCodex 品牌与手机更新](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-07-mobicodex-branding.md)
- 2026-11-07：[code7 / code8 手机与配套网关复测](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-07-remote-rendering-device.md)
- 2026-11-08：[Opus 5.5 完整 Code 会话验收（待启动）](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-08-claude-opus-acceptance.md)
- 2026-11-12：[MobiCodex Kelivo GitHub Release 对齐计划](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-12-kelivo-github-release.md)
- 2026-11-13：[MobiCodex 仓库边界后的发布与本地清理计划](https://github.com/luoz76070-art/MobiCodex/blob/archive/pre-cleanup-2026-11/docs/plans/2026-11-13-post-boundary-cleanup.md)
