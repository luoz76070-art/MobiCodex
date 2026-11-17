import type { ActivityEvidence } from "../../../../shared/activityEvidence.js";
import type { LastTurn } from "../../../../shared/lastTurn.js";
export type AgentSession = { id: string; title: string; directory: string; updatedAt: string; desktopOpen?: boolean };
export type AgentMessage = { id: string; timestamp: string; role: string; text: string; kind: string; turnId?: string; phase?: "commentary" | "final_answer" };
export type AgentQuestion = {
  id: string; status: "pending" | "submitted" | "uncertain";
  unavailableReason?: string | null;
  questions: { question: string; header: string; options: { label: string; description: string; preview?: string }[]; multiple: boolean; custom: boolean }[];
};
export type AgentPermissionMode = "default" | "plan" | "acceptEdits";
export type AgentSessionSettings = { permissionMode: AgentPermissionMode; model: string | null };
export type AgentModel = { value: string; displayName: string; description: string };
export type AgentPermission = {
  workingDirectory?: string; inputTruncated?: boolean; allowReason?: boolean; localSettings?: boolean;
  id: string; status: "pending" | "submitted" | "uncertain";
  action: string; resources: string[]; save: string[]; detail: string; unavailableReason: string | null;
  decisions: ("once" | "always" | "reject")[];
};
export type AgentSessionSnapshot = {
  readOnly?: string;
  runtimeSettings?: AgentSessionSettings;
  activeTurnId?: string | null;
  activityEvidence?: ActivityEvidence | null;
  lastTurn?: LastTurn | null;
  /** Native turn that consumed each recent clientMessageId, when the host can say so exactly (DeepSeek, W4b). */
  consumedTurns?: { clientMessageId: string; turnId: string }[];
  agentId: string; session: AgentSession; connected: boolean; updatedAt: string;
  status: "idle" | "running"; activity: "thinking" | "working" | "outputting";
  messages: AgentMessage[]; questions: AgentQuestion[]; permissions: AgentPermission[];
  historyCursor: string | null;
  partialText: boolean;
  queue?: { available: boolean; items: { clientMessageId: string; text: string; status: "waiting" | "paused" | "cancelling" | "uncertain" }[] };
  operationError?: { clientMessageId: string; code: "rejected" | "expired" } | null;
  /** Transient host condition the phone should see while a turn is stuck, e.g. the model API retrying. */
  notice?: string | null;
  control: { token: string; canSend: boolean; canSteer: boolean; canInterrupt: boolean } | null;
  submission: { clientMessageId: string; action: "message" | "interrupt"; delivery: "submitted" | "confirmed" | "uncertain" } | null;
};
export type AgentOperation = { controlToken: string; clientMessageId: string };
export type AgentDelivery = { ok: true; delivery: "submitted" | "confirmed" | "uncertain" };

/** Shared session API. Creation is explicit and limited to adapters that advertise it. */
export interface SessionAdapter {
  sessionSettings?(sessionId: string): Promise<AgentSessionSettings & { models: AgentModel[] }>;
  setPermissionMode?(sessionId: string, input: AgentOperation & { mode: AgentPermissionMode }): Promise<AgentDelivery>;
  setModel?(sessionId: string, input: AgentOperation & { model: string }): Promise<AgentDelivery>;
  listDirectories?(): Promise<{ directories: { id: string; label: string }[]; errorCode?: string | null; errorMessage?: string | null }>;
  createSession?(input: { directory: string; text: string }): Promise<{ session: AgentSession }>;
  validSessionId(id: string): boolean;
  listSessions(search?: string, cursor?: string, range?: "recent" | "all"): Promise<{ sessions: AgentSession[]; cursor: string | null }>;
  readHistory(sessionId: string, cursor: string): Promise<{ messages: AgentMessage[]; cursor: string | null }>;
  watchSession(sessionId: string, onSnapshot: (snapshot: AgentSessionSnapshot) => void, onDisconnect: () => void): Promise<() => void>;
  sendMessage(sessionId: string, input: AgentOperation & { text: string; delivery: "steer" | "queue" }): Promise<AgentDelivery>;
  interruptSession(sessionId: string, input: AgentOperation): Promise<AgentDelivery>;
  cancelQueuedMessage?(sessionId: string, id: string, input: AgentOperation): Promise<AgentDelivery>;
  respondQuestion(sessionId: string, id: string, input: AgentOperation & { answers: string[][] }): Promise<AgentDelivery>;
  respondPermission(sessionId: string, id: string, input: AgentOperation & { decision: "once" | "always" | "reject"; reason?: string }): Promise<AgentDelivery>;
}

export function agentError(code: string, statusCode = 502) {
  return Object.assign(new Error(code), { code, statusCode });
}
