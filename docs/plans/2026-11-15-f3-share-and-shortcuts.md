# F3：分享入口和桌面快捷方式

2026-11-15。对应任务清单 F3（含原 W2b）。分两条线实现：线 A 原生（Android），线 B 网页端。两边只通过下面的“插件接口”对接，互不改对方的文件。

## 目标与验收

- 从其他 App 分享文字、链接、1–9 张图片给 MobiCodex，可以选：发给当前线程、开新任务、存成事项卡。
- 桌面长按图标出现：新任务、语音输入、最近 3 个线程。
- App 冷启动和在后台两种情况都能收到分享；快捷方式能直接进到对应位置。
- 分享的内容不会自动发出：进到线程后填进输入框和附件，由用户确认后再发。

## 插件接口（两条线共同遵守）

Capacitor 插件名 `Intake`。

事件（都用 `notifyListeners(name, data, true)`，没有监听者时保留到第一个监听者挂上，保证冷启动不丢）：

```ts
type IntakeImage = { path: string; name: string; mimeType: string; size: number }; // path 是 App 缓存目录里的绝对路径
type SharePayload = { id: string; text: string | null; subject: string | null; images: IntakeImage[]; skipped: number };
type ShortcutPayload = { target: "new-task" | "voice" | "thread"; key?: string; title?: string };
// "share"    → SharePayload
// "shortcut" → ShortcutPayload；target 为 thread 时 key 是线程键（见下），title 是线程标题
```

方法：

```ts
setRecentThreads(options: { threads: { key: string; title: string }[] }): Promise<void> // 最多用前 3 个
clear(options: { id?: string }): Promise<void> // 删掉这次分享在缓存里的文件；不给 id 时清理 24 小时以前的
```

- 线程键沿用通知用的格式：Codex 线程是 `desktop:<线程ID>` 或 `live:<线程ID>`（`codexAttentionKey`），由 `parseAttentionKey` 解析。
- 网页端用 `Capacitor.convertFileSrc(path)` 读取图片（fetch 成 Blob 再变成 File）。

## 线 A：原生

1. **AndroidManifest**：MainActivity 增加 intent-filter：
   - `android.intent.action.SEND`，category `DEFAULT`，mimeType `text/plain` 和 `image/*`；
   - `android.intent.action.SEND_MULTIPLE`，category `DEFAULT`，mimeType `image/*`；
   - `<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />`。
2. **静态快捷方式** `res/xml/shortcuts.xml`：`new_task`（新任务）、`voice`（语音输入）。intent 的 action 为 `com.mobilecodex.app.SHORTCUT`，`targetPackage` 为 `com.mobilecodex.app`，`targetClass` 为 `com.mobilecodex.app.MainActivity`，extra `mobicodexShortcut` 分别是 `new-task`、`voice`。文字放 strings.xml，图标用新的单色矢量图（新任务、麦克风、对话三个）。
3. **`IntakePlugin.java`**（`@CapacitorPlugin(name = "Intake")`）：
   - `load()` 里处理 `getActivity().getIntent()`，并清理 24 小时以前的分享缓存。
   - 分享：从 `EXTRA_TEXT`、`EXTRA_SUBJECT`、`EXTRA_STREAM`（单个 Uri 或列表）取内容。只收 MIME 以 `image/` 开头的，最多 9 张、单张不超过 25 MiB，其余计入 `skipped`。在后台线程把每张图从 ContentResolver 复制到 `cacheDir/share/<id>/`，文件名优先用 `OpenableColumns.DISPLAY_NAME`。文字和图片都没有时忽略。复制完成后发 `share`。
   - 快捷方式：action 为 `com.mobilecodex.app.SHORTCUT` 时，按 extra `mobicodexShortcut`（以及线程的 `key`、`title`）发 `shortcut`。
   - 处理过的 intent 改成 `ACTION_MAIN` 并去掉相关 extra，避免 Activity 重建时重复投递。
   - `setRecentThreads`：用 `ShortcutManagerCompat.setDynamicShortcuts` 设最多 3 个线程快捷方式，id 用 `thread:<key>`，短标签截到 24 个字符（空的写“线程”），rank 按顺序，intent 带 target `thread`、`key`、`title`。
   - `clear`：删除 `cacheDir/share/<id>`；不给 id 时删 24 小时以前的子目录。
   - MainActivity：`registerPlugin(IntakePlugin.class)`；`onNewIntent` 里把 intent 转给 Intake（和现在转给 Attention 一样，两者按 action 区分，互不影响）。

## 线 B：网页端

1. `src/features/intake/plugin.ts`：上面的类型、`Intake = registerPlugin(...)`、`intakeAvailable()`（原生平台且插件可用）、`shareText(payload)`（主题和正文合并：主题不在正文里时放第一行，去掉首尾空白）、`shareFiles(payload, fetcher = fetch)`（按 `convertFileSrc` 取回 File，保留文件名和类型）。
2. `useIntake({ onShare, onShortcut })`：在最外层 App 挂监听，写法参照 `useAttention`。
3. `ShareSheet.tsx`：底部弹层“分享到 MobiCodex”。显示文字的前几行和图片缩略图；有 `skipped` 时提示“另有 N 项没收下（只收 9 张以内的图片，单张不超过 25MB）”。四个按钮：
   - “发给当前线程「标题」”：没有当前线程时不可点，并提示先打开一个线程；
   - “开新任务”；
   - “存成事项卡”；
   - “取消”。
   返回键关闭弹层，等同取消。处理完或取消后调用 `Intake.clear({ id })`。
4. 接线：
   - 收到分享时切到 Codex 页（关掉事项页和捕获面板），由 Workspace 显示 ShareSheet（它知道当前线程）。
   - 发给当前线程 / 开新任务：文字追加到该线程的草稿（已有草稿时空一行再接上），图片走现有的附件上传（`uploadFiles` 改成也接受 `File[]`）。**不自动发送。**开新任务先调用现有的 `startNewThread()`。
   - 存成事项卡：打开 CapturePanel，并给它新的可选参数 `initialDraft`（`{ key, detail, files }`，同一个 key 只应用一次，只在新建时生效，编辑已有事项时忽略），说明填分享的文字，图片作为事项图片。
   - 快捷方式：`new-task` → Codex 页新任务；`voice` → 新任务并直接打开语音输入（`VoiceInput` 新增可选参数 `openRequest?: number`，值变化时打开，效果和点麦克风一样）；`thread` → 用 `parseAttentionKey` 解析后走现有的“从通知打开线程”流程。
   - 最近线程：线程列表变化时取最近更新的 3 个 Codex 线程，调用 `Intake.setRecentThreads`，键用 `codexAttentionKey`，内容没变不重复调用。
5. 测试 `scripts/test-mobile-intake.mjs`，加进 `test:mobile`：`shareText`、`shareFiles`（假的 fetcher）、ShareSheet 渲染（三个动作、没有当前线程时不可点、skipped 提示）、以及 App 里的接线（监听、`initialDraft`、`setRecentThreads`、`openRequest`）。

## 不做

- 不自动发送分享内容。
- 只收图片和文字，不收其他文件类型（后续需要再加）。
- 分享到 Agent 会话（DeepSeek 等）不在这次范围内，先统一进 Codex 页。
