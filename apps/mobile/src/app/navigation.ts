import { loadAgentView } from "../features/agents/runtime";
import { loadWorkspaceCache } from "../features/threads/cache";
import { newThreadId } from "./config";

export type Navigation =
  | { version: 1; level: "picker"; agentId: null; sessionId: null }
  | { version: 1; level: "agent"; agentId: string; sessionId: null }
  | { version: 1; level: "session"; agentId: string; sessionId: string };
export const agentPicker = (): Navigation => ({ version: 1, level: "picker", agentId: null, sessionId: null });
export const agentList = (agentId: string): Navigation => ({ version: 1, level: "agent", agentId, sessionId: null });
export const agentSession = (agentId: string, sessionId: string): Navigation => ({ version: 1, level: "session", agentId, sessionId });
const key = (scope: string) => `mobileCodexNavigationV1:${scope}`;
const validAgent = (id: unknown): id is string => typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(id);
const validSession = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 1024 && !/[\u0000-\u001f]/u.test(id);

export function codexWorkspaceLocation(scope: string): Navigation {
  const cache = loadWorkspaceCache(scope);
  if (cache.isNewThread) return agentSession("codex", newThreadId);
  return cache.selectedId && cache.threads.some(thread => thread.id === cache.selectedId)
    ? agentSession("codex", cache.selectedId) : agentList("codex");
}

export function loadNavigation(scope: string, migrateLegacy = true): Navigation {
  try {
    const raw = localStorage.getItem(key(scope));
    if (raw !== null) {
      if (raw.length > 8192) return agentPicker();
      const value = JSON.parse(raw);
      if (value?.version !== 1) return agentPicker();
      if (value.level === "picker" && value.agentId === null && value.sessionId === null) return agentPicker();
      if (!validAgent(value.agentId)) return agentPicker();
      if (value.level === "agent" && value.sessionId === null) return agentList(value.agentId);
      if (value.level === "session" && validSession(value.sessionId)) return agentSession(value.agentId, value.sessionId);
      return agentPicker();
    }
    if (migrateLegacy) {
      const mode = localStorage.getItem("productRemoteMode");
      if (mode === "codex") return codexWorkspaceLocation(scope);
      if (mode === "agent") {
        const view = loadAgentView(scope);
        if (view && validAgent(view.agentId)) return validSession(view.sessionId) ? agentSession(view.agentId, view.sessionId) : agentList(view.agentId);
      }
    }
  } catch { /* Invalid or unavailable metadata never deletes task drafts. */ }
  return agentPicker();
}

export function saveNavigation(scope: string, value: Navigation) {
  try { localStorage.setItem(key(scope), JSON.stringify(value)); } catch { /* Navigation remains usable in memory. */ }
}

export function parentNavigation(value: Navigation): Navigation | null {
  if (value.level === "picker") return null;
  // Codex keeps its existing thread drawer; its workspace returns directly to the picker.
  if (value.agentId === "codex") return agentPicker();
  return value.level === "session" ? agentList(value.agentId) : agentPicker();
}

export function handleNavigationBack({ dismissLayer, current, beforeLeave, navigate }: {
  dismissLayer: () => boolean; current: Navigation; beforeLeave: () => boolean; navigate: (next: Navigation) => void;
}): boolean {
  if (dismissLayer()) return true;
  const next = parentNavigation(current);
  if (!next) return false;
  if (beforeLeave()) navigate(next);
  return true; // A blocked leave is consumed too; native back must not discard unsaved input.
}

/** Both native back and header back go through App's single ordered handler. */
export function requestNavigationBack() {
  window.dispatchEvent(new Event("product-back", { cancelable: true }));
}
