import type { AgentGateway } from "../agents/agentGateway.js";
import type { LiveTurnController } from "../codex/liveTurnController.js";
import type { DesktopControl } from "../desktop/desktopControl.js";
import { KeepAwake } from "./keepAwake.js";

/** Reconcile authoritative state, including Agents with no phone subscribers. */
export function monitorKeepAwake(awake: KeepAwake, sources: {
  liveTurns: LiveTurnController; desktop: DesktopControl; agents: AgentGateway;
}, enabled: boolean) {
  let stopped = false, pending: Promise<void> | undefined;
  let unavailableSources: string[] = [];
  // Retain an existing running desktop thread's read-only follow until it finishes,
  // even when the phone leaves it. These are subscription leases, not task state.
  const desktopFollows = new Map<string, () => void>();
  const followDesktop = () => {
    const running = new Set(sources.desktop.runningThreadIds?.() ?? []);
    for (const [id, release] of desktopFollows) if (!running.has(id)) { desktopFollows.delete(id); try { release(); } catch { /* Already disconnected. */ } }
    for (const id of running) if (!desktopFollows.has(id) && sources.desktop.followThread) {
      try { desktopFollows.set(id, sources.desktop.followThread(id)); } catch { /* Desktop follow capacity is bounded by its controller. */ }
    }
  };
  const codex = () => new Set([
    ...(sources.liveTurns.listActiveTurns?.() ?? []).map(turn => turn.threadId ?? turn.turnId),
    ...(sources.desktop.runningThreadIds?.() ?? []),
  ]).size;
  const local = () => awake.update([{ agentId: "codex", count: codex() }, ...(sources.agents.cachedRunningCounts?.() ?? [])], unavailableSources);
  const changed = () => {
    if (stopped || !enabled) return;
    try { followDesktop(); void local().catch(() => {}); } catch { /* Read-only observation cannot fail its event source. */ }
  };
  const refresh = (): Promise<void> => {
    if (stopped || !enabled) return Promise.resolve();
    changed();
    if (pending) return pending;
    pending = (async () => {
      // Read local state again after slow bridge requests; a delayed response must
      // not reinstate a completed turn. Local events never trigger bridge polling.
      const activity = await sources.agents.runningCounts?.();
      unavailableSources = activity?.unavailableSources ?? [];
      if (!stopped) await local();
    })().catch(() => { /* Observation never fails an Agent or the HTTP server. */ }).finally(() => { pending = undefined; });
    return pending;
  };
  const off = enabled ? sources.desktop.onStreamSnapshot?.(changed) : undefined;
  const agentOff = enabled ? sources.agents.onActivity?.(changed) : undefined;
  if (enabled) sources.liveTurns.on?.("snapshot", changed);
  const timer = enabled ? setInterval(() => { void refresh(); }, 2000) : undefined;
  timer?.unref();
  void refresh();
  return {
    refresh,
    async stop() {
      stopped = true; clearInterval(timer); off?.(); agentOff?.(); sources.liveTurns.off?.("snapshot", changed);
      for (const release of desktopFollows.values()) { try { release(); } catch { /* Still release the OS inhibitor. */ } }
      desktopFollows.clear();
      // Do not wait for remote reads; their late replies are ignored.
      await awake.stop();
    },
  };
}
