import { availableAgents, type Agent } from "../features/agents/catalog";
import { agentSession, codexWorkspaceLocation, type Navigation } from "./navigation";

// A navigation destination is independent of the narrower, server-supported HandoffTarget.
export type SessionTarget = { agentId: string; sessionId: string; title: string; cwd: string };
export type OpenSessionTarget = SessionTarget | { agentId: "codex"; sessionId: null };

export class SessionTargetError extends Error {}

export async function sessionTargetNavigation(target: OpenSessionTarget, current: Navigation, scope: string,
  readAgents: () => Promise<Agent[]>): Promise<Navigation> {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(target.agentId)
    || (target.sessionId !== null && (!target.sessionId || target.sessionId.length > 1024 || /[\u0000-\u001f]/u.test(target.sessionId)))) {
    throw new SessionTargetError("会话入口无效，无法打开。");
  }
  if (target.agentId !== "codex") {
    const agent = availableAgents(await readAgents()).find(item => item.id === target.agentId);
    if (!agent) throw new SessionTargetError("此 Agent 未知或当前连接未提供，无法打开会话。");
    if (agent.state === "failed") throw new SessionTargetError("此 Agent 当前不可用，请检查电脑上的连接后重试。");
  }
  if (target.sessionId !== null) return agentSession(target.agentId, target.sessionId);
  return current.agentId === "codex" ? current : codexWorkspaceLocation(scope);
}
