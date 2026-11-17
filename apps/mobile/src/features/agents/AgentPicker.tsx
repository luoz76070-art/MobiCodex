import { EmptyState } from "../../shared/EmptyState";
import { useEffect, useRef, useState } from "react";
import { WorkspaceHeader } from "../../shared/WorkspaceHeader";
import { PullToRefresh } from "../../shared/PullToRefresh";
import { ListSkeleton } from "../../shared/Skeleton";
import { SystemNotice } from "../../shared/SystemNotice";
import { AgentPickRow } from "./AgentPickRow";
import { availableAgents, codexAgent, type Agent } from "./catalog";
import { checkingSummary, disabledSummary, offlineSummary, summarizeSessions, type AgentSummary } from "./agentSummary";
import { apiGet, buildUrl } from "../connection/http";
import { useDeviceRevoked } from "../connection/useDeviceRevoked";
import { deviceRevokedMessage } from "../connection/authorization";
import { loadWorkspaceCache } from "../threads/cache";
import type { AgentSession } from "./types";

export function AgentPicker({ endpoint, token, scope, onSelect, onOpenItems, onOpenSettings }: {
  endpoint: string; token: string; scope: string; onSelect: (agentId: string) => void; onOpenItems: () => void; onOpenSettings: () => void;
}) {
  const [agents, setAgents] = useState<Agent[]>([codexAgent]);
  const [summaries, setSummaries] = useState<Record<string, AgentSummary>>({});
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const revoked = useDeviceRevoked(endpoint, token);
  useEffect(() => {
    void loadAgents();
    return () => controller.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, token, scope]);
  async function loadAgents() {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setLoading(true); setError("");
    try {
      const data = await apiGet<{ agents: Agent[] }>(buildUrl(endpoint, "/api/agents"), token, current.signal);
      if (current.signal.aborted) return;
      if (!Array.isArray(data.agents)) throw new Error("invalid agents");
      const available = [codexAgent, ...availableAgents(data.agents)];
      setAgents(available);
      setSummaries(Object.fromEntries(available.map(item => [item.id, checkingSummary])));
      await Promise.all(available.map(async item => {
        if (item.enabled === false) { setSummaries(previous => ({ ...previous, [item.id]: disabledSummary })); return; }
        try {
          const cached = item.id === "codex" ? loadWorkspaceCache(scope).threads : null;
          const data = cached ? { sessions: cached, cursor: cached.length >= 120 ? "more" : null }
            : await apiGet<{ sessions: AgentSession[]; cursor: string | null }>(buildUrl(endpoint, `/api/agents/${item.id}/sessions${item.id === "deepseek" ? "?range=recent" : ""}`), token, current.signal);
          if (!Array.isArray(data.sessions)) throw new Error("invalid sessions");
          if (!current.signal.aborted) setSummaries(previous => ({ ...previous, [item.id]: summarizeSessions(data.sessions, Boolean(data.cursor)) }));
        } catch { if (!current.signal.aborted) setSummaries(previous => ({ ...previous, [item.id]: offlineSummary })); }
      }));
    } catch {
      if (!current.signal.aborted) { setError("无法连接 Agent，请确认电脑上的网关与 Agent 服务正在运行。"); setSummaries(previous => ({ ...previous, codex: offlineSummary })); }
    } finally { if (!current.signal.aborted) setLoading(false); }
  }
  return <main className="agent-workspace">
    <WorkspaceHeader agentId="" title="选择 Agent" subtitle="同一连接，分别管理会话" leading="none" leadingLabel="" onLeading={() => {}} onOpenItems={onOpenItems} onOpenSettings={onOpenSettings} />
    {(revoked || error) && <SystemNotice error>{revoked ? deviceRevokedMessage : error}</SystemNotice>}
    <PullToRefresh className="agent-session-list" onRefresh={loadAgents}>
      {agents.map(agent => <AgentPickRow key={agent.id} id={agent.id} label={agent.label} summary={summaries[agent.id]} recentOnly={agent.id === "deepseek"} onOpen={() => onSelect(agent.id)}
        description={agent.id === "codex" ? "电脑桌面会话与手机工作台" : agent.id === "deepseek" ? "查看电脑会话与历史，继续原线程和处理提问" : agent.id === "ccdesk" ? "查看 CC Desk 会话，发消息、审批与中断" : agent.id === "claude-cli" ? "只读查看允许目录中的本地会话与最新输出" : agent.id === "claude" ? "打开已加载插件的会话，查看输出、排队输入与中断" : "打开现有会话，查看输出与处理提问"} />)}
      {!loading && agents.length === 1 && !error && <EmptyState compact title="还没有接入其他 Agent">配置 DeepSeek Harness、Claude Code 插件、CC Desk 或 OpenCode 服务后，下拉刷新此页。</EmptyState>}
      {loading && <ListSkeleton label="正在读取…" />}
    </PullToRefresh>
  </main>;
}
