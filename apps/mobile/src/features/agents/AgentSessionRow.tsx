import { formatListTime } from "../../shared/format";
import type { AgentSession } from "./types";

/**
 * #39: one session in any Agent's list, as a compact row like a Codex thread: the title on one line (it is often
 * the latest message, so it is cut, not wrapped), then a muted line with when it changed and where it is open.
 */
export function AgentSessionRow({ session, now, onOpen }: { session: AgentSession; now?: number; onOpen: () => void }) {
  const title = session.title.replace(/\s+/gu, " ").trim() || "未命名会话";
  return <button type="button" className="agent-session-row agent-session-item" onClick={onOpen}>
    <span className="agent-session-title">{title}</span>
    <span className="agent-session-meta">
      <time dateTime={session.updatedAt}>{formatListTime(session.updatedAt, now)}</time>
      {session.desktopOpen && <span className="desktop">电脑上开着</span>}
    </span>
  </button>;
}
