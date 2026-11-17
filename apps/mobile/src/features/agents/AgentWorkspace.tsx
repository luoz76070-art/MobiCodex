import { agentSession, type Navigation } from "../../app/navigation";
import { availableAgents, type Agent } from "./catalog";
import { WorkspaceHeader } from "../../shared/WorkspaceHeader";
import type { SessionTarget } from "../../app/sessionTargets";
import { SystemNotice } from "../../shared/SystemNotice";
import { useDeviceRevoked } from "../connection/useDeviceRevoked";
import { deviceRevokedMessage } from "../connection/authorization";
import { ComposerSessionStatus } from "../chat/SessionStatus";
import { agentSessionStatus } from "../chat/sessionStatusModel";
import { loadReadingPositions, saveReadingPositions } from "../chat/readingPositions";
import { productBeforeNavigate } from "../product/host";
import { useEffect, useRef, useState } from "react";
import { registerVoiceAgentDrafts } from "../voice/draftRecovery";
import type { VoiceRecoveryPort } from "../voice/useVoiceRecovery";
import { VoiceInput } from "../voice/VoiceInput";
import { Loader2 } from "lucide-react";
import { PullToRefresh } from "../../shared/PullToRefresh";
import { EmptyState } from "../../shared/EmptyState";
import { ListSkeleton, MessageSkeleton } from "../../shared/Skeleton";
import { haptic } from "../../shared/haptics";
import type { CodexMessage, PendingAttachment } from "../../app/types";
import { maxMessagesPerThread } from "../../app/config";
import { MessageBubble, MessageTimeline, AttachmentTray } from "../chat/components";
import { ComputerComposer } from "../chat/ComputerComposer";
import { MessageMediaProvider } from "../chat/MessageImage";
import { composeMessageWithAttachments, mergeAttachments, revokeAttachmentPreviews } from "../chat/attachments";
import { uploadAttachments } from "../chat/uploadAttachments";
import { agentDraftParts, composeAgentDraft } from "./drafts";
import { apiGet, apiPost, authHeaders, requestJson, buildUrl } from "../connection/http";
import { subscribeEvents, type SubscriptionState } from "../connection/subscription";
import { createSnapshotReducer } from "../connection/snapshotPatch";
import { writeClipboard } from "../../shared/clipboard";
import { AgentQuestions } from "./AgentQuestions";
import { AgentQueue } from "./AgentQueue";
import { agentDelivery, agentHistoryWindow, loadAgentDrafts, loadPendingAgentDraft, savePendingAgentDraft, reconcileAgentDraft, saveAgentDrafts, verifyAgentSnapshot, type PendingAgentDraft } from "./runtime";
import type { AgentDelivery, AgentPermission, AgentSession, AgentSessionSnapshot } from "./types";
import { groupByProject, projectGroupLabel, sessionInRange, sessionListRefreshMs } from "../threads/model";
import { ProjectGroups } from "../threads/ProjectGroups";
import { SessionRangeControl } from "../threads/SessionRangeControl";
import { agentAttentionKey, attentionAfterSend, setAttentionViewing } from "../notify/attention";

const agentErrors: Record<string, string> = {
  CLAUDE_CLI_DISABLED: "Claude CLI 未启用，请在电脑网关配置允许读取的目录。",
  CLAUDE_CLI_DIRECTORY_UNAVAILABLE: "允许读取的目录不可用，请在电脑检查网关配置。",
  CLAUDE_CLI_SESSION_NOT_ALLOWED: "此会话不在网关允许读取的目录中。",
  CLAUDE_CLI_HISTORY_CHANGED: "会话记录已变化，请返回最新消息后重新加载历史。",
  CLAUDE_CLI_SESSION_BUSY: "这个会话正在电脑上使用，请先在电脑上退出 claude 再从手机继续",
  CLAUDE_CLI_BUSY_LIMIT: "Claude CLI 已达到 3 个运行会话的上限，请等待空闲会话关闭后重试。",
  CLAUDE_CLI_VERSION_TOO_OLD: "请升级电脑上的 Claude Code 后重启网关。",
  CLAUDE_CLI_EXECUTABLE_NOT_FOUND: "未找到 Claude Code，请在电脑安装 claude 或配置 claudeCli.executable。",
  CLAUDE_CLI_VERSION_FAILED: "无法检查 Claude Code 版本，请在电脑检查安装。",
  CLAUDE_CLI_PROCESS_FAILED: "Claude Code 进程异常退出，请保留输入并重试。",
  CLAUDE_CLI_SESSION_NOT_SAVED: "会话记录尚未保存，请在电脑检查 Claude Code 的运行状态。",
  CLAUDE_CLI_QUEUE_FULL: "待发消息已满，请等待当前任务处理后重试。",
  CLAUDE_CLI_QUEUE_ITEM_UNAVAILABLE: "这条待发消息已送出或已取消，请等待会话同步。",
  CLAUDE_CLI_READ_ONLY: "只读预览，发送功能下一版提供",
  CCDESK_OTHER_DEVICE: "这个会话在另一台电脑上，只能在那台电脑上操作。",
  CCDESK_CONTROL_UNAVAILABLE: "CC Desk 没有开启手机控制：请在电脑上打开“CC Desk Tunnel（手机控制）”后重试。",
  CCDESK_RUN_ACTIVE: "会话正在运行，请等它结束或先中断。",
  CCDESK_BUSY: "CC Desk 正忙，请稍后再试。",
  CCDESK_TOKEN_MISSING: "电脑端网关还没有登录 CC Desk：请在电脑终端运行 mobile-codex ccdesk login。",
};
const friendlyError = (error: unknown) => {
  const status = (error as { status?: number })?.status, code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && Object.hasOwn(agentErrors, code)) return agentErrors[code];
  return status === 401 ? deviceRevokedMessage : status === 410 ? "电脑会话暂时离线，请返回会话列表并等待重新连接。" : status === 404 ? "电脑端尚未提供此 Agent，请更新或检查插件配置。"
    : status === 409 ? "会话状态已变化，请等待重新同步后再操作。" : "无法连接 Agent，请确认电脑上的网关与 Agent 服务正在运行。";
};

export default function AgentWorkspace({ navigation, onNavigate, onOpenAgents, onOpenSettings, handoffTarget, onTargetOpened, onCapture, endpoint, token, scope, onBack, voiceRecovery }: { navigation: Navigation; onNavigate: (next: Navigation) => boolean; onOpenAgents: () => void; onOpenSettings: () => void; handoffTarget: SessionTarget | null; onTargetOpened: () => void; onCapture: () => void; endpoint: string; token: string; scope: string; onBack: () => void; voiceRecovery: VoiceRecoveryPort }) {
  const deviceRevoked = useDeviceRevoked(endpoint, token);
  const [agents, setAgents] = useState<Agent[]>([]);
  const agent = agents.find(item => item.id === navigation.agentId) ?? null;
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionDetails, setSessionDetails] = useState<AgentSession | null>(null);
  const selected = navigation.level === "session" ? sessions.find(item => item.id === navigation.sessionId)
    ?? (sessionDetails?.id === navigation.sessionId ? sessionDetails : { id: navigation.sessionId, title: "未命名会话", directory: "", updatedAt: "" }) : null;
  const [query, setQuery] = useState(""), [cursor, setCursor] = useState<string | null>(null);
  const [range, setRange] = useState<"recent" | "all">("recent");
  const [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => loadAgentDrafts(scope));
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  useEffect(() => registerVoiceAgentDrafts(scope, {
    read: () => draftsRef.current,
    write: value => { if (!saveAgentDrafts(scope, value)) return false; draftsRef.current = value; setDrafts(value); return true; },
  }), [scope]);
  const controller = useRef<AbortController | null>(null), requestId = useRef(0);
  useEffect(() => {
    const flush = () => saveAgentDrafts(scope, draftsRef.current);
    const beforeNavigate = (event: Event) => { if (!flush()) { event.preventDefault(); setError("草稿保存失败，请保留当前页面并重试。"); } };
    window.addEventListener("pagehide", flush);
    window.addEventListener(productBeforeNavigate, beforeNavigate);
    return () => { window.removeEventListener("pagehide", flush); window.removeEventListener(productBeforeNavigate, beforeNavigate); flush(); };
  }, [scope]);
  useEffect(() => { const timer = setTimeout(() => saveAgentDrafts(scope, draftsRef.current), 700); return () => clearTimeout(timer); }, [drafts, scope]);
  useEffect(() => {
    void loadAgents();
    return () => { ++requestId.current; controller.current?.abort(); };
  }, [endpoint, token]);
  function begin(silent = false) { controller.current?.abort(); controller.current = new AbortController(); const id = ++requestId.current; if (!silent) { setError(""); setLoading(true); } return { signal: controller.current.signal, id }; }
  async function loadAgents() {
    const request = begin();
    try {
      const data = await apiGet<{ agents: Agent[] }>(buildUrl(endpoint, "/api/agents"), token, request.signal);
      if (request.id !== requestId.current) return;
      if (!Array.isArray(data.agents)) throw new Error("invalid agents");
      const available = availableAgents(data.agents);
      setAgents(available);
      if (!available.some(item => item.id === navigation.agentId)) setError("此 Agent 未知或当前连接未提供，请返回选择 Agent。");
    } catch (caught) { if (!request.signal.aborted) setError(friendlyError(caught)); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }
  async function loadSessions(target: Agent, append = false, selectedRange = range, silent = false) {
    if (target.enabled === false) { setSessions([]); setCursor(null); setError(""); return; }
    const request = begin(silent);
    try {
      const params = new URLSearchParams({ ...(query.trim() ? { search: query.trim() } : {}), ...(append && cursor ? { cursor } : {}), ...(target.id === "deepseek" ? { range: selectedRange } : {}) });
      const data = await apiGet<{ sessions: AgentSession[]; cursor: string | null }>(buildUrl(endpoint, `/api/agents/${target.id}/sessions?${params}`), token, request.signal);
      if (request.id !== requestId.current) return;
      if (!Array.isArray(data.sessions)) throw new Error("invalid sessions");
      setSessions(current => silent ? [...new Map([...current, ...data.sessions].map(item => [item.id, item])).values()].filter(item => sessionInRange(item.updatedAt, selectedRange) || data.sessions.some(next => next.id === item.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        : append ? [...new Map([...current, ...data.sessions].map(item => [item.id, item])).values()] : data.sessions);
      if (!silent || sessions.length < 50) setCursor(data.cursor);
    } catch (caught) { if (!request.signal.aborted) setError(friendlyError(caught)); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    if (agent && (navigation.level === "agent" || sessions.length === 0)) void loadSessions(agent);
    // Navigation owns selection; refreshing a list must never select a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, navigation.level]);
  useEffect(() => {
    if (deviceRevoked || agent?.id !== "deepseek" || selected || loading) return;
    const refresh = () => { if (!document.hidden) void loadSessions(agent, false, range, true); };
    const timer = setInterval(refresh, sessionListRefreshMs);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [agent?.id, selected?.id, loading, range, query, cursor, sessions.length, endpoint, token, deviceRevoked]);
  useEffect(() => {
    if (!handoffTarget || handoffTarget.agentId === 'codex') return;
    const target = agents.find(a => a.id === handoffTarget.agentId);
    if (!target) return;
    setSessionDetails({ id: handoffTarget.sessionId, title: handoffTarget.title, directory: handoffTarget.cwd, updatedAt: new Date().toISOString() });
    onTargetOpened();
  }, [handoffTarget, agents, onTargetOpened]);
  // F1: no notification for the session that is on screen.
  useEffect(() => { setAttentionViewing(agent && selected ? agentAttentionKey(agent.id, selected.id) : null); }, [agent?.id, selected?.id]);
  useEffect(() => () => setAttentionViewing(null), []);
  function switchAgent() { onOpenAgents(); }
  const title = selected?.title || agent?.label || "选择 Agent";
  const subtitle = selected ? `${agent?.label} · 原服务会话` : "同一连接，分别管理会话";
  return <main className="agent-workspace">
    <WorkspaceHeader agentId={agent?.id ?? ""} title={title} subtitle={subtitle} project={selected?.directory ? projectGroupLabel(selected.directory) : undefined}
      leading="back" leadingLabel={selected ? "返回 Agent 会话列表" : "返回 Agent 列表"}
      onLeading={onBack} onSwitchAgent={switchAgent} onOpenItems={onCapture} onOpenSettings={onOpenSettings} />
    {agent?.errorMessage && <SystemNotice error>{agent.errorMessage}</SystemNotice>}
    {(deviceRevoked || error) && <SystemNotice error>{deviceRevoked ? deviceRevokedMessage : error}</SystemNotice>}
    {selected && agent ? <AgentChat voiceRecovery={voiceRecovery} key={`${agent.id}:${selected.id}`} endpoint={endpoint} token={token} agent={agent} session={selected}
      scopeKey={scope} draft={drafts[`${agent.id}:${selected.id}`] ?? ""} onDraft={value => setDrafts(current => {
        const key = `${agent.id}:${selected.id}`, next = { ...current };
        delete next[key];
        return { ...next, [key]: value };
      })} />
      : <PullToRefresh className="agent-session-list" onRefresh={() => agent ? loadSessions(agent) : loadAgents()}>
        {agent && <>
          {agent.id === "claude-cli" && agent.enabled !== false && <ClaudeCliCreate endpoint={endpoint} token={token} disabled={deviceRevoked || Boolean(agent.errorCode)} onCreated={session => {
            setSessionDetails(session); setSessions(current => [session, ...current]); onNavigate(agentSession(agent.id, session.id));
          }} />}
          {agent.id === "deepseek" && <SessionRangeControl range={range} disabled={loading} onChange={next => { setRange(next); void loadSessions(agent, false, next); }} />}
          <form className="search-field" onSubmit={event => { event.preventDefault(); void loadSessions(agent); }}><input aria-label="搜索 Agent 会话" placeholder="搜索会话" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /><button type="submit" disabled={loading}>搜索</button></form>
          {<ProjectGroups key={agent.id} scope={scope} agentId={agent.id} groups={groupByProject(sessions, session => session.directory)} search={query}>
            {session => <button className="agent-session-row" key={session.id} onClick={() => { onNavigate(agentSession(agent.id, session.id)); }}><strong>{session.title || "未命名会话"}</strong><time>{new Date(session.updatedAt).toLocaleString()}</time>{session.desktopOpen && <small>电脑上开着</small>}</button>}
          </ProjectGroups>}
          {!loading && !sessions.length && !error && <EmptyState compact title={agent.enabled === false ? "Claude CLI 未启用" : "没有会话"}>{agent.enabled === false ? "请在电脑网关配置 claudeCli.directories，选择允许读取的目录。" : agent.id === "claude-cli" ? "允许目录内没有匹配的本地会话。" : agent.id === "deepseek" ? range === "recent" ? "近 30 天没有匹配会话，可查看更早会话。" : "没有匹配的 DeepSeek 会话，请检查电脑插件连接或搜索条件。" : agent.id === "ccdesk" ? "CC Desk 服务上没有匹配的会话。" : agent.id === "claude" ? `尚无已连接的 ${agent.label} 会话，请先在电脑会话中加载并配置插件。` : "当前目录没有可用的现有会话。"}</EmptyState>}
          {cursor && <button className="action-button" disabled={loading} onClick={() => void loadSessions(agent, true)}>加载更多会话</button>}
        </>}
        {loading && (agent ? !sessions.length : !agents.length) ? <ListSkeleton label="正在读取…" />
          : loading && <p className="inline-loading" role="status"><Loader2 className="spin" size={18} />正在刷新…</p>}
      </PullToRefresh>}
  </main>;
}

function ClaudeCliCreate({ endpoint, token, disabled, onCreated }: { endpoint: string; token: string; disabled: boolean; onCreated: (session: AgentSession) => void }) {
  const [open, setOpen] = useState(false), [directories, setDirectories] = useState<{ id: string; label: string }[]>([]);
  const [directory, setDirectory] = useState(""), [text, setText] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<{ key: string; directory: string; text: string } | null>(null);
  const scope = useRef<AbortController | null>(null), locked = useRef(false);
  useEffect(() => () => scope.current?.abort(), [endpoint, token]);
  async function show() {
    if (locked.current || disabled) return;
    locked.current = true; setOpen(true); setBusy(true); setError("");
    scope.current?.abort(); const controller = new AbortController(); scope.current = controller;
    try {
      const result = await apiGet<{ directories: { id: string; label: string }[]; errorMessage?: string | null }>(buildUrl(endpoint, "/api/agents/claude-cli/directories"), token, controller.signal);
      if (controller.signal.aborted) return;
      setDirectories(result.directories); setDirectory(pending.current?.directory ?? result.directories[0]?.id ?? "");
      if (result.errorMessage) { setDirectories([]); setError(result.errorMessage); }
    } catch (caught) { if (!controller.signal.aborted) setError(friendlyError(caught)); }
    finally { if (!controller.signal.aborted) { locked.current = false; setBusy(false); } }
  }
  async function create() {
    if (locked.current || disabled || !directory || !text.trim()) return;
    locked.current = true; setBusy(true); setError("");
    pending.current ??= { key: crypto.randomUUID(), directory, text: text.trim() };
    const input = pending.current;
    scope.current?.abort(); const controller = new AbortController(); scope.current = controller;
    try {
      const result = await requestJson<{ session: AgentSession }>(buildUrl(endpoint, "/api/agents/claude-cli/sessions"), {
        method: "POST", signal: controller.signal, connectTimeout: 8000, readTimeout: 180000,
        headers: { ...authHeaders(token), "Content-Type": "application/json", "Idempotency-Key": input.key },
        body: { directory: input.directory, text: input.text },
      });
      if (!controller.signal.aborted) { pending.current = null; setUncertain(false); setText(""); setOpen(false); onCreated(result.session); }
    } catch (caught) {
      if (!controller.signal.aborted) {
        const definite = [400, 401, 403, 404, 409, 410, 429].includes((caught as { status?: number })?.status ?? 0);
        if (definite) pending.current = null;
        setUncertain(!definite);
        setError(definite ? friendlyError(caught) : "创建结果待确认，请核对创建结果或返回列表查看，勿重复新建。");
      }
    }
    finally { if (!controller.signal.aborted) { locked.current = false; setBusy(false); } }
  }
  return <section className="agent-create">
    <button type="button" className="action-button" disabled={disabled || busy} onClick={() => void show()}>新建会话</button>
    {open && <form className="user-input-card" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label>项目目录<select aria-label="项目目录" value={directory} disabled={busy || disabled || uncertain} onChange={event => setDirectory(event.target.value)}>
        {directories.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <label>第一句话<textarea aria-label="第一句话" value={text} maxLength={20_000} disabled={busy || disabled || uncertain} onChange={event => setText(event.target.value)} /></label>
      {error && <SystemNotice error>{error}</SystemNotice>}
      <button type="submit" className="action-button" disabled={busy || disabled || !directories.length || !directory || !text.trim()}>{uncertain ? "核对创建结果" : "创建并发送"}</button>
      <button type="button" className="action-button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
    </form>}
  </section>;
}

function AgentChat({ endpoint, token, agent, session, draft, onDraft, scopeKey, voiceRecovery }: {
  voiceRecovery: VoiceRecoveryPort;
  scopeKey: string; endpoint: string; token: string; agent: Agent; session: AgentSession; draft: string; onDraft: (value: string) => void;
}) {
  const pagedHistory = agent.id === "claude-cli" || agent.id === "deepseek";
  const [snapshot, setSnapshot] = useState<AgentSessionSnapshot | null>(null), snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const readOnly = Boolean(snapshot?.readOnly);
  const draftRef = useRef(draft); draftRef.current = draft;
  const draftSession = `${agent.id}:${session.id}`;
  const pendingDraft = useRef<PendingAgentDraft | null>(loadPendingAgentDraft(scopeKey, draftSession));
  const [stream, setStream] = useState<SubscriptionState>("connecting"), [error, setError] = useState("");
  const streamRef = useRef<SubscriptionState>("connecting");
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [uploading, setUploading] = useState(false), uploadScope = useRef<AbortController | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null), previews = useRef(new Map<string, PendingAttachment>());
  const input = agentDraftParts(draft);
  const attachments = input.attachments.map(item => previews.current.get(item.path) ?? item);
  useEffect(() => {
    const before = (event: Event) => { if (uploadScope.current) { event.preventDefault(); setError("文件正在上传，请等待完成后离开。"); } };
    window.addEventListener(productBeforeNavigate, before);
    return () => { window.removeEventListener(productBeforeNavigate, before); uploadScope.current?.abort(); revokeAttachmentPreviews([...previews.current.values()]); };
  }, []);
  useEffect(() => {
    const paths = new Set(agentDraftParts(draft).attachments.map(item => item.path));
    for (const [path, item] of previews.current) if (!paths.has(path)) { revokeAttachmentPreviews([item]); previews.current.delete(path); }
  }, [draft]);
  function editText(text: string) {
    const next = composeAgentDraft(text, agentDraftParts(draftRef.current).attachments);
    if (next.length > 20_000) { setError("消息和附件路径合计不能超过 20,000 字，请缩短后重试。"); return; }
    onDraft(next);
  }
  async function uploadFiles(files: FileList | null) {
    if (readOnly || !files?.length || uploadScope.current || streamRef.current !== "online" || !snapshotRef.current?.control) return;
    const controller = new AbortController(); uploadScope.current = controller; setUploading(true); setError("");
    let uploaded: PendingAttachment[] = [];
    try {
      uploaded = await uploadAttachments(endpoint, token, Array.from(files), controller.signal);
      const current = agentDraftParts(draftRef.current), next = composeAgentDraft(current.text, mergeAttachments(current.attachments, uploaded));
      if (next.length > 20_000) throw new Error("附件路径与消息过长，请缩短草稿后重新添加附件。");
      for (const item of uploaded) previews.current.set(item.path, item);
      onDraft(next);
    } catch (caught) {
      revokeAttachmentPreviews(uploaded);
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "文件上传失败，请重试。");
    } finally {
      if (!controller.signal.aborted) { uploadScope.current = null; setUploading(false); if (uploadInput.current) uploadInput.current.value = ""; }
    }
  }
  const [history, setHistory] = useState<CodexMessage[]>([]), [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const historyRef = useRef(history); historyRef.current = history;
  const historyInitialized = useRef(false), [historyBusy, setHistoryBusy] = useState(false);
  const historyLock = useRef(false), viewport = useRef<HTMLDivElement>(null), scope = useRef<AbortController | null>(null);
  const readingScope = `agent:${scopeKey}`;
  const reading = useRef(loadReadingPositions(readingScope));
  const restoredTop = useRef(reading.current[draftSession]);
  const nearBottom = useRef(restoredTop.current === undefined), initialized = useRef(false);
  useEffect(() => {
    const flush = () => saveReadingPositions(readingScope, reading.current);
    window.addEventListener("pagehide", flush);
    window.addEventListener(productBeforeNavigate, flush);
    return () => { flush(); window.removeEventListener("pagehide", flush); window.removeEventListener(productBeforeNavigate, flush); };
  }, [readingScope]);
  const base = `/api/agents/${encodeURIComponent(agent.id)}/sessions/${encodeURIComponent(session.id)}`;
  useEffect(() => {
    const controller = new AbortController(); scope.current = controller;
    const reduce = createSnapshotReducer<AgentSessionSnapshot>();
    const unsubscribe = subscribeEvents({
      authorization: { endpoint, token },
      getToken: signal => apiPost(buildUrl(endpoint, `${base}/stream-token`), token, {}, signal),
      url: streamToken => buildUrl(endpoint, `${base}/events?${new URLSearchParams({ streamToken, v: "1" })}`),
      events: { "agent-session": input => {
        const next = verifyAgentSnapshot(reduce(input), agent.id, session.id);
        acceptMessageReceipt(next.submission, next.connected ? next.queue : undefined);
        setSnapshot(next);
        if (!historyInitialized.current || agent.id === "claude-cli" && !historyRef.current.length) { historyInitialized.current = true; setHistoryCursor(next.historyCursor); }
        if (!historyRef.current.length && nearBottom.current && !next.questions.length && !next.permissions.length) requestAnimationFrame(() => viewport.current?.scrollTo({ top: viewport.current.scrollHeight }));
        if (!initialized.current || next.questions.length || next.permissions.length) requestAnimationFrame(() => {
          if (!initialized.current && restoredTop.current !== undefined && viewport.current) {
            viewport.current.scrollTop = restoredTop.current;
          } else if (!historyRef.current.length && (!initialized.current || nearBottom.current)) {
            const card = viewport.current?.querySelector<HTMLElement>(".user-input-card, .agent-permission");
            if (card && viewport.current) viewport.current.scrollTop += card.getBoundingClientRect().top - viewport.current.getBoundingClientRect().top - 12;
          }
          initialized.current = true;
        });
      } },
      onState: state => {
        streamRef.current = state; setStream(state);
        if (state === "unauthorized") {
          controller.abort(); snapshotRef.current = null; setSnapshot(null); setHistory([]); setHistoryCursor(null);
        } else if (state !== "online") {
          // Keep the view, but require a fresh snapshot before re-enabling control.
          const readonly = (value: AgentSessionSnapshot | null) => value ? { ...value, connected: false, control: null, activityEvidence: null } : null;
          snapshotRef.current = readonly(snapshotRef.current); setSnapshot(readonly);
        }
      },
    });
    return () => { controller.abort(); unsubscribe(); };
  }, [endpoint, token, agent.id, session.id]);
  const online = stream === "online" && Boolean(snapshot?.connected && snapshot.control);
  const control = online ? snapshot?.control : null;
  function acceptMessageReceipt(receipt: AgentSessionSnapshot["submission"], queue?: AgentSessionSnapshot["queue"]) {
    const next = reconcileAgentDraft(draftRef.current, pendingDraft.current, receipt, queue);
    if (pendingDraft.current !== next.pending && !savePendingAgentDraft(scopeKey, draftSession, next.pending)) return;
    pendingDraft.current = next.pending;
    if (next.draft !== draftRef.current) { draftRef.current = next.draft; onDraft(next.draft); }
  }
  async function operate(action: "message" | "interrupt" | "question" | "permission" | "queue-cancel", suffix: string, extra: Record<string, unknown>, requestId?: string) {
    const current = snapshotRef.current, currentScope = scope.current;
    if (readOnly || streamRef.current !== "online" || !currentScope || currentScope.signal.aborted || busyRef.current || !current?.connected || !current.control) return false;
    busyRef.current = true; setBusy(true); setError("");
    const clientMessageId = crypto.randomUUID(), controlToken = current.control.token;
    if (action === "message") {
      if (pendingDraft.current) { busyRef.current = false; setBusy(false); setError("上一条输入结果待确认，请先等待电脑同步。"); return false; }
      const pending = { clientMessageId, text: draftRef.current };
      if (!savePendingAgentDraft(scopeKey, draftSession, pending)) { busyRef.current = false; setBusy(false); setError("无法保存输入，请保留当前页面并重试。"); return false; }
      pendingDraft.current = pending;
    }
    if (action === "message" || action === "interrupt") setSnapshot(value => value ? { ...value, submission: { clientMessageId, action, delivery: "submitted" } } : value);
    try {
      const result = await apiPost<AgentDelivery>(buildUrl(endpoint, `${base}${suffix}`), token, { clientMessageId, controlToken, ...extra }, currentScope.signal);
      if (currentScope.signal.aborted) return true;
      if (action === "message" || action === "interrupt") {
        setSnapshot(value => agentDelivery(value, clientMessageId, action, result));
        if (action === "message") { acceptMessageReceipt({ clientMessageId, action, delivery: result.delivery }); void attentionAfterSend(); }
      } else if (action !== "queue-cancel") setSnapshot(value => value?.connected && value.control?.token === controlToken ? { ...value,
        ...(action === "question" ? { questions: value.questions.map(q => q.id === requestId ? { ...q, status: result.delivery === "uncertain" ? "uncertain" : "submitted" } : q) }
          : { permissions: value.permissions.map(p => p.id === requestId ? { ...p, status: result.delivery === "uncertain" ? "uncertain" : "submitted" } : p) }),
      } : value);
      return true;
    } catch (caught) {
      if (currentScope.signal.aborted) return true;
      const definite = [400, 401, 403, 404, 409, 410, 429].includes((caught as { status?: number })?.status ?? 0);
      if (definite && (action === "message" || action === "interrupt")) {
        if (pendingDraft.current?.clientMessageId === clientMessageId && savePendingAgentDraft(scopeKey, draftSession, null)) pendingDraft.current = null;
        setSnapshot(value => value?.submission?.clientMessageId === clientMessageId && value.submission.delivery !== "confirmed" ? { ...value, submission: null } : value);
      }
      if (!definite && (action === "message" || action === "interrupt")) setSnapshot(value => agentDelivery(value, clientMessageId, action, { delivery: "uncertain" }));
      setError(definite ? friendlyError(caught) : "提交结果待确认，请勿重复操作，等待会话同步。");
      return !definite;
    } finally { if (!currentScope.signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  async function older() {
    if (!historyCursor || historyLock.current || !scope.current) return;
    const controller = scope.current, previousHeight = viewport.current?.scrollHeight ?? 0, previousTop = viewport.current?.scrollTop ?? 0;
    historyLock.current = true; setHistoryBusy(true);
    try {
      const result = await apiGet<{ messages: CodexMessage[]; cursor: string | null }>(buildUrl(endpoint, `${base}/history?${new URLSearchParams({ cursor: historyCursor })}`), token, controller.signal);
      if (controller.signal.aborted) return;
      setHistory(current => pagedHistory
        ? agentHistoryWindow(current.length ? current : snapshotRef.current?.messages ?? [], result.messages, maxMessagesPerThread)
        : [...new Map([...result.messages, ...current].map(message => [message.id, message])).values()].slice(-190)); setHistoryCursor(result.cursor);
      requestAnimationFrame(() => { if (viewport.current) viewport.current.scrollTop = previousTop + viewport.current.scrollHeight - previousHeight; });
    } catch (caught) { if (!controller.signal.aborted) setError(friendlyError(caught)); }
    finally { if (!controller.signal.aborted) { historyLock.current = false; setHistoryBusy(false); } }
  }
  const messages = [...new Map([...history, ...(pagedHistory && history.length ? [] : snapshot?.messages ?? [])].map(message => [message.id, message])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const unresolved = snapshot?.submission && snapshot.submission.delivery !== "confirmed";
  const queuedSubmission = snapshot?.queue?.items.some(item => item.clientMessageId === snapshot.submission?.clientMessageId);
  const sendEnabled = Boolean(!readOnly && control?.canSend && !busy && !uploading && !unresolved && !pendingDraft.current && (input.text.trim() || attachments.length));
  function send(delivery: "steer" | "queue" = "queue") {
    if (!sendEnabled || (delivery === "steer" && !control?.canSteer)) return;
    void operate("message", "/messages", { text: composeMessageWithAttachments(input.text, attachments), delivery });
  }
  const sessionStatus = agentSessionStatus(snapshot, online);
  return <section className="agent-chat">
    <SystemNotice className="agent-connection" error={stream === "unauthorized"}>{online ? `${agent.label} 已连接` : stream === "unauthorized" ? deviceRevokedMessage : "正在恢复连接…"}</SystemNotice>
    {snapshot?.readOnly && <SystemNotice error>{snapshot.readOnly}</SystemNotice>}
    {agent.id === "claude-cli" && (snapshot?.session.desktopOpen ?? session.desktopOpen) && <SystemNotice>这个会话正在电脑上使用，请先在电脑上退出 claude 再从手机继续</SystemNotice>}
    <div className="messages-viewport" ref={viewport} onScroll={() => { const element = viewport.current; if (element) { nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; reading.current[draftSession] = element.scrollTop; } }}>
      {(snapshot?.partialText || agent.id === "claude" || agent.id === "deepseek" || agent.id === "ccdesk") && <details className="agent-capabilities"><summary>会话能力与同步范围</summary>
        {snapshot?.partialText && <p>当前显示已同步的消息与工具记录，长内容可能截断；更早历史以本通道提供的加载入口为准。</p>}
        {agent.id === "claude-cli" && <p>按本地消息链顺序显示正文和简短工具摘要；需要审批或提问的操作将自动拒绝，手机审批下一版提供。</p>}
        {agent.id === "claude" && <p>消息在当前任务结束后处理；提问和单次审批可在手机处理。</p>}
        {agent.id === "ccdesk" && <p>只能操作这台电脑上的会话，其他电脑上的会话只能查看。发消息、审批和中断需要电脑上开着“CC Desk Tunnel（手机控制）”；权限请求可允许一次或拒绝。</p>}
        {agent.id === "deepseek" && <p>查看历史不会启动任务；发送后继续原会话，运行中可引导或排队。权限请求须核对完整参数后允许一次或拒绝。</p>}
      </details>}
      {snapshot?.operationError && <SystemNotice error>{snapshot.operationError.code === "rejected" ? "电脑会话拒绝了本次操作，输入内容已保留。" : "操作尚未送达电脑便已过期，输入内容已保留。"}</SystemNotice>}
      {historyCursor && (pagedHistory || history.length < 190) && <button className="history-button" disabled={historyBusy} onClick={() => void older()}>{historyBusy ? "读取历史中…" : "加载更早的消息"}</button>}
      {pagedHistory && history.length > 0 && <button className="history-button" disabled={historyBusy} onClick={() => { setHistory([]); setHistoryCursor(snapshot?.historyCursor ?? null); nearBottom.current = true; requestAnimationFrame(() => viewport.current?.scrollTo({ top: viewport.current.scrollHeight })); }}>正在浏览历史 · 返回最新</button>}
      {!pagedHistory && history.length >= 190 && <p className="setting-description">已达到手机历史显示上限，更早记录可在电脑查看。</p>}
      <MessageMediaProvider key={draftSession} endpoint={endpoint} token={token} agentId={agent.id} sessionId={session.id}>
        <MessageTimeline messages={messages} running={snapshot?.status === "running"} renderMessage={(message, expandToolDetails, assistantContinuation) => <MessageBubble message={message} assistantContinuation={assistantContinuation} expandToolDetails={expandToolDetails} assistantLabel={agent.label} smooth={false} smoothPending={false} onSmoothDone={() => {}} onCopy={() => writeClipboard(message.text)} />} />
      </MessageMediaProvider>
      {snapshot?.questions.map(question => <AgentQuestions key={question.id} request={question} agentLabel={agent.label} disabled={readOnly || !online || busy} onRespond={answers => operate("question", `/questions/${question.id}/respond`, { answers }, question.id)} />)}
      {snapshot?.permissions.map(permission => <PermissionCard key={permission.id} permission={permission} agentLabel={agent.label} disabled={readOnly || !online || busy} onRespond={decision => operate("permission", `/permissions/${permission.id}/respond`, { decision }, permission.id)} />)}
      {!snapshot && stream !== "unauthorized" && <MessageSkeleton label="正在读取原会话" />}
    </div>
    <footer className="composer-panel agent-composer">
      {error && <SystemNotice error>{error}</SystemNotice>}
      {unresolved && !queuedSubmission && <SystemNotice>{snapshot?.submission?.delivery === "uncertain" ? "提交结果未知，正在核对；请勿重复发送。" : "已提交，等待服务确认。"}</SystemNotice>}
      {snapshot?.queue && <AgentQueue queue={snapshot.queue} disabled={readOnly || !online || busy} onCancel={id => operate("queue-cancel", `/queue/${encodeURIComponent(id)}/cancel`, {}, id)} />}
      {attachments.length > 0 && <AttachmentTray attachments={attachments} onRemove={id => onDraft(composeAgentDraft(input.text, attachments.filter(item => item.id !== id)))} />}
      <input ref={uploadInput} type="file" multiple className="hidden-file-input" onChange={event => void uploadFiles(event.target.files)} />
      <ComputerComposer draft={input.text} onDraft={editText} onSend={send} onStop={() => void operate("interrupt", "/interrupt", {})} onUpload={() => uploadInput.current?.click()}
        voice={readOnly ? null : <VoiceInput context={{ cwd: session.directory, title: session.title, messages }} scope={scopeKey} thread={draftSession} recovery={voiceRecovery} endpoint={endpoint} token={token} draft={input.text} onDraft={editText} />} label="发送给当前 Agent 会话"
        placeholder={readOnly ? snapshot?.readOnly ?? "暂时不能发送" : online ? `向 ${agent.label} 发送消息` : "草稿已保留，等待恢复连接…"} status={<ComposerSessionStatus status={sessionStatus} lastTurn={snapshot?.lastTurn} running={snapshot?.status === "running"} fallback={`${agent.label} · 当前会话`} />}
        disabled={readOnly || !online} uploading={uploading} uploadDisabled={readOnly || !online || !token} busy={busy} running={snapshot?.status === "running"} hasContent={Boolean(input.text.trim() || attachments.length)}
        canSend={sendEnabled} canStop={Boolean(!readOnly && control?.canInterrupt)} deliveries={{ steer: sendEnabled && Boolean(control?.canSteer), queue: sendEnabled }}
        maxLength={Math.max(0, 20_000 - (draft.length - input.text.length))} />
    </footer>
  </section>;
}

function PermissionCard({ permission, disabled, onRespond, agentLabel }: { permission: AgentPermission; disabled: boolean; onRespond: (decision: "once" | "always" | "reject") => Promise<boolean>; agentLabel: string }) {
  const [sent, setSent] = useState(false), submitted = useRef(false);
  const locked = disabled || sent || permission.status !== "pending";
  return <section className="user-input-card agent-permission" aria-label={`${agentLabel} 权限请求`}>
    <header>需要处理权限请求：{permission.action}</header>
    <p>本次请求的操作范围</p><pre>{permission.resources.join("\n") || "未提供操作范围"}</pre>
    {permission.detail !== "{}" && <pre>{permission.detail}</pre>}
    {permission.save.length > 0 && <><p>选择保存规则后，将匹配以下范围</p><pre>{permission.save.join("\n")}</pre></>}
    {permission.unavailableReason && <p role="status">{permission.unavailableReason}</p>}
    <div className="agent-permission-actions">{permission.decisions.map(decision => <button key={decision} className="action-button" disabled={locked} onClick={() => {
      if (locked || submitted.current) return; submitted.current = true; setSent(true); haptic(decision === "reject" ? "warn" : "confirm");
      void onRespond(decision).then(accepted => { if (!accepted) { submitted.current = false; setSent(false); } });
    }}>{decision === "once" ? "允许一次" : decision === "always" ? "允许并保存规则" : "拒绝"}</button>)}</div>
    {locked && <p role="status">{permission.status === "uncertain" ? "结果待确认，请勿重复操作" : sent || permission.status !== "pending" ? "已提交，等待会话确认" : "连接恢复后重新核验请求"}</p>}
  </section>;
}
