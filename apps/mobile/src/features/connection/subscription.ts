import { relayAuthorization } from "./authorization";

export type SubscriptionState = "connecting" | "online" | "recovering" | "paused" | "unauthorized";
export const BACKGROUND_GRACE_MS = 20_000;

/** What a page shows once its stream is torn down (turn ended, thread changed): nothing is recovering any more; a revoked device stays revoked. */
export function releasedStreamState(current: SubscriptionState): SubscriptionState {
  return current === "unauthorized" ? current : "connecting";
}
export type SubscriptionDiagnostic = { at: string; generation: number; state: SubscriptionState | "stopped";
  reason: "start" | "retry" | "open" | "stream-error" | "heartbeat-timeout" | "invalid-event" | "auth-failed" | "token-failed" | "background" | "foreground" | "network-online" | "dispose" };

/** One owner for token refresh, transport loss, heartbeat and foreground recovery. */
export function subscribeEvents(options: {
  authorization?: { endpoint: string; token: string };
  getToken: (signal: AbortSignal) => Promise<{ streamToken: string | null }>;
  url: (token: string) => string;
  events: Record<string, (data: unknown) => void>;
  onState: (state: SubscriptionState) => void;
  onDiagnostic?: (event: SubscriptionDiagnostic) => void;
  retryBaseMs?: number;
  heartbeatMs?: number;
  backgroundGraceMs?: number;
}) {
  let disposed = false;
  let unauthorized = false;
  let attempt = 0;
  let generation = 0;
  let connectionGeneration = 0;
  const record = (state: SubscriptionDiagnostic["state"], reason: SubscriptionDiagnostic["reason"]) =>
    options.onDiagnostic?.({ at: new Date().toISOString(), generation: connectionGeneration, state, reason });
  let source: EventSource | null = null;
  let request: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let background: ReturnType<typeof setTimeout> | undefined;
  const clearBackground = () => { clearTimeout(background); background = undefined; };
  const suspended = () => document.hidden && background === undefined;
  const close = () => {
    ++generation;
    clearTimeout(retry);
    clearTimeout(heartbeat);
    source?.close();
    source = null;
    request?.abort();
    request = null;
  };
  const failed = (reason: SubscriptionDiagnostic["reason"]) => {
    close();
    if (disposed || unauthorized) return;
    if (suspended()) { options.onState("paused"); record("paused", reason); return; }
    options.onState("recovering");
    record("recovering", reason);
    const budget = Math.min(15000, (options.retryBaseMs ?? 500) * 2 ** Math.min(attempt++, 6));
    retry = setTimeout(() => void connect("retry"), budget * (0.5 + Math.random() * 0.5));
  };
  const touch = () => {
    clearTimeout(heartbeat);
    heartbeat = setTimeout(() => failed("heartbeat-timeout"), options.heartbeatMs ?? 45000);
  };
  const connect = async (reason: SubscriptionDiagnostic["reason"] = "start") => {
    close();
    if (disposed || unauthorized) return;
    if (suspended()) { options.onState("paused"); record("paused", "background"); return; }
    connectionGeneration++;
    const current = generation;
    const controller = new AbortController();
    request = controller;
    options.onState(attempt ? "recovering" : "connecting");
    record(attempt ? "recovering" : "connecting", reason);
    // Token requests and an EventSource handshake also have a deadline.
    touch();
    try {
      const response = await options.getToken(controller.signal);
      if (disposed || current !== generation || controller.signal.aborted) return;
      if (!response.streamToken) throw new Error("stream token unavailable");
      const stream = new EventSource(options.url(response.streamToken));
      source = stream;
      stream.onopen = () => {
        if (disposed || current !== generation) return;
        attempt = 0;
        touch();
        options.onState("online");
        record("online", "open");
      };
      stream.addEventListener("ping", () => { if (!disposed && current === generation) touch(); });
      for (const [event, apply] of Object.entries(options.events)) {
        stream.addEventListener(event, (message) => {
          if (disposed || current !== generation) return;
          touch();
          try { apply(JSON.parse((message as MessageEvent).data)); } catch { failed("invalid-event"); }
        });
      }
      stream.onerror = () => { if (current === generation && !disposed) failed("stream-error"); };
    } catch (error) {
      if (disposed || current !== generation || controller.signal.aborted) return;
      const status = (error as { status?: number })?.status;
      if (status === 401 || status === 403) {
        clearBackground(); close(); unauthorized = true; options.onState("unauthorized");
        record("unauthorized", "auth-failed");
      } else failed("token-failed");
    }
  };
  const visible = () => {
    if (disposed || unauthorized) return;
    if (document.hidden) {
      // A repeated visibility/focus event must not extend the original deadline.
      if (background !== undefined) return;
      background = setTimeout(() => {
        background = undefined;
        if (disposed || unauthorized || !document.hidden) return;
        close(); options.onState("paused"); record("paused", "background");
      }, options.backgroundGraceMs ?? BACKGROUND_GRACE_MS);
    } else {
      clearBackground();
      if (!source && !request) void connect("foreground");
    }
  };
  const online = () => { if (!document.hidden && !source) void connect("network-online"); };
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("online", online);
  window.addEventListener("focus", visible);
  const authorization = options.authorization && relayAuthorization(options.authorization.endpoint, options.authorization.token);
  const revoked = () => { clearBackground(); close(); unauthorized = true; options.onState("unauthorized"); record("unauthorized", "auth-failed"); };
  const detachAuthorization = authorization?.subscribe(revoked);
  if (authorization?.isRevoked()) revoked();
  else void connect();
  return () => {
    if (disposed) return;
    disposed = true;
    detachAuthorization?.();
    clearBackground();
    close();
    record("stopped", "dispose");
    document.removeEventListener("visibilitychange", visible);
    window.removeEventListener("online", online);
    window.removeEventListener("focus", visible);
  };
}
