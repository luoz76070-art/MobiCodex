export type Agent = { id: string; label: string; transport: string; sessionApi?: 1; state?: string; enabled?: boolean };
export const codexAgent: Agent = { id: "codex", label: "Codex", transport: "codex" };
export function availableAgents(agents: Agent[]): Agent[] {
  return agents.filter(item => /^[a-z][a-z0-9-]{0,63}$/u.test(item.id) && item.id !== "codex" && (item.sessionApi === 1
    || (item.id === "opencode" && item.transport === "opencode-v2-http-sse") || (item.id === "claude" && item.transport === "claude-mods-http") || (item.id === "deepseek" && item.transport === "deepseek-cordis-http-sse")));
}
