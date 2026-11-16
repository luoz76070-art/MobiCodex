import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { activityEvidence } from "../store/activityEvidence.js";
import type { AgentAdapter, AgentStatus } from "./agentGateway.js";
import { CcDeskConnection, type CcDeskConnectionOptions } from "./ccDeskConnection.js";
import { CcDeskControl } from "./ccDeskControl.js";
import { CCDESK_KEYCHAIN_SERVICE, ccDeskId, type CcDeskConfig, type CcDeskServerMessage, type CcDeskSession } from "./ccDeskProtocol.js";
import { CcDeskTranscript } from "./ccDeskTranscript.js";
import { agentError, type AgentDelivery, type AgentOperation, type AgentSessionSnapshot, type SessionAdapter } from "./sessions.js";

const run = promisify(execFile);
const WATCHES = 8;
const LINGER_MS = 120_000;
const none = { inspectLoadedSessions: false, sendMessage: false, steer: false, interrupt: false, approve: false };
type Listener = { receive: (snapshot: AgentSessionSnapshot) => void; disconnect: () => void };
type Entry = {
  id: string; token: string; session: CcDeskSession | null; transcript: CcDeskTranscript; listeners: Set<Listener>;
  connection: CcDeskConnection | null; pending: Promise<void>; timer?: NodeJS.Timeout; dropped: boolean;
  lingerTimer?: NodeJS.Timeout; lingerOrder?: number;
  submission: AgentSessionSnapshot["submission"]; operationError: AgentSessionSnapshot["operationError"];
};
export type CcDeskDependencies = {
  readToken?: (account: string) => Promise<string>;
  connection?: (options: CcDeskConnectionOptions) => CcDeskConnection;
  control?: CcDeskControl;
  lingerMs?: number;
};

/** Reads the service token from the login keychain, where `mobile-codex ccdesk login` put it. */
export async function keychainToken(account: string) {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", CCDESK_KEYCHAIN_SERVICE, "-a", account, "-w"], { timeout: 10_000 });
    const token = stdout.trim();
    if (token.length >= 24 && token.length <= 512) return token;
  } catch { /* missing item or locked keychain */ }
  throw agentError("CCDESK_TOKEN_MISSING", 409);
}
const rejected: Record<string, string> = { other_device: "CCDESK_OTHER_DEVICE", execution_offline: "CCDESK_CONTROL_UNAVAILABLE", run_active: "CCDESK_RUN_ACTIVE",
  native_busy: "CCDESK_BUSY", run_inactive: "CCDESK_REQUEST_EXPIRED", run_finishing: "CCDESK_BUSY", not_owner: "CCDESK_OTHER_DEVICE", not_found: "CCDESK_SESSION_NOT_FOUND" };

/**
 * CC Desk sessions. Reading goes over connections of this gateway's own (one per followed session, the service
 * lets a connection follow one); writing goes through the patched client's socket (integrations/cc-desk), over
 * the client's own connection, so commands run on this Mac as if typed in its window.
 */
export class CcDeskAdapter implements AgentAdapter, SessionAdapter {
  readonly sessionApi: SessionAdapter = this;
  private state: AgentStatus = { id: "ccdesk", label: "CC Desk", state: "unprobed", transport: "ccdesk-ws", usesAccessibility: false,
    sameDesktopThreadVerified: false, capabilities: { ...none }, loadedSessions: null, checkedAt: null, errorCode: null };
  private readonly entries = new Map<string, Entry>();
  private lingerOrder = 0;
  private readonly control: CcDeskControl;
  private probing: Promise<AgentStatus> | null = null;
  private token: string | null = null;
  private stopped = false;
  constructor(private readonly config: CcDeskConfig, private readonly deps: CcDeskDependencies = {}) {
    this.control = deps.control ?? new CcDeskControl({ service: config.url, directory: config.controlDirectory });
    this.control.on("state", () => {
      // A reader that said it is this computer goes when the window does (or changes who it is), so the service
      // never keeps the computer's seat for MobiCodex alone; the phone reconnects and reads as it then can.
      const device = this.control.device;
      for (const entry of [...this.entries.values()]) {
        const bound = entry.connection?.device;
        if (bound && (bound.id !== device?.id || bound.name !== device?.name || bound.platform !== device?.platform)) this.drop(entry);
        else this.publish(entry);
      }
    });
  }

  validSessionId(id: string) { return ccDeskId.safeParse(id).success; }
  snapshot(): AgentStatus {
    const writable = this.state.state === "connected" && this.control.writable;
    return structuredClone({ ...this.state, capabilities: this.state.state === "connected"
      ? { inspectLoadedSessions: true, sendMessage: writable, steer: writable, interrupt: writable, approve: writable } : { ...none } });
  }
  probe(): Promise<AgentStatus> {
    if (this.probing) return this.probing;
    this.state = { ...this.state, state: "probing", errorCode: null };
    this.probing = (async () => {
      try {
        const connection = await this.connect();
        const count = connection.ready?.sessions.length ?? 0;
        connection.close();
        if (!this.stopped) this.state = { ...this.state, state: "connected", loadedSessions: { count, hasMore: false }, checkedAt: new Date().toISOString(), errorCode: null };
      } catch (error) {
        if (!this.stopped) this.state = { ...this.state, state: "failed", loadedSessions: null, checkedAt: new Date().toISOString(),
          errorCode: String((error as { code?: unknown }).code ?? "CCDESK_CONNECTION_FAILED") };
      }
      return this.snapshot();
    })().finally(() => { this.probing = null; });
    return this.probing;
  }

  async listSessions(search = "", cursor?: string) {
    if (cursor) throw agentError("CCDESK_CURSOR_UNSUPPORTED", 400);
    const connection = await this.connect();
    const sessions = connection.ready?.sessions ?? [];
    connection.close();
    // A service that shows each computer only its own sessions shows none to a reader that cannot say which it is.
    if (!connection.device && !sessions.length) throw agentError("CCDESK_CONTROL_UNAVAILABLE", 409);
    const needle = search.trim().toLowerCase();
    return {
      sessions: sessions
        .filter(session => !needle || `${session.title}\n${session.projectPath}\n${session.device?.name ?? ""}`.toLowerCase().includes(needle))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(session => ({ id: session.id, title: this.onThisMac(session) ? session.title : `${session.title}（${session.device?.name ?? "另一台电脑"}）`,
          directory: session.projectPath, updatedAt: session.updatedAt })),
      cursor: null,
    };
  }

  async readHistory(id: string, cursor: string) {
    if (!this.validSessionId(id) || !/^[1-9]\d{0,15}$/u.test(cursor)) throw agentError("CCDESK_INPUT_INVALID", 400);
    const watched = this.entries.get(id)?.connection;
    const connection = watched && !watched.closed ? watched : await this.connect();
    try {
      const page = await connection.request({ type: "session.history", sessionId: id, beforeSequence: Number(cursor) }, "snapshot").catch(error => { throw this.unseen(connection, error); });
      const transcript = new CcDeskTranscript();
      for (const event of page.events) transcript.apply(event, true);
      return { messages: transcript.list(), cursor: page.hasEarlier && page.firstSequence > 1 ? String(page.firstSequence) : null };
    } finally { if (connection !== watched) connection.close(); }
  }

  async watchSession(id: string, receive: Listener["receive"], disconnect: Listener["disconnect"]) {
    if (!this.validSessionId(id)) throw agentError("CCDESK_INPUT_INVALID", 400);
    if (this.stopped) throw agentError("CCDESK_STOPPED", 503);
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= WATCHES) {
        const oldest = [...this.entries.values()].filter(candidate => !candidate.listeners.size && candidate.lingerOrder !== undefined)
          .sort((a, b) => a.lingerOrder! - b.lingerOrder!)[0];
        if (!oldest) throw agentError("CCDESK_BUSY", 429);
        this.drop(oldest, false);
      }
      const created: Entry = { id, token: randomUUID(), session: null, transcript: new CcDeskTranscript(), listeners: new Set(), connection: null,
        pending: Promise.resolve(), dropped: false, submission: null, operationError: null };
      entry = created;
      this.entries.set(id, created);
      created.pending = (async () => {
        const connection = await this.connect();
        if (created.dropped || this.stopped) { connection.close(); throw agentError("CCDESK_DISCONNECTED"); }
        created.connection = connection;
        connection.on("message", (message: CcDeskServerMessage) => this.receive(created, message));
        connection.once("close", () => this.drop(created));
        const page = await connection.request({ type: "session.subscribe", sessionId: id, afterSequence: 0 }, "snapshot").catch(error => { throw this.unseen(connection, error); });
        created.session = page.session;
        created.transcript.load(page);
      })();
    }
    this.clearLinger(entry);
    const listener = { receive, disconnect };
    entry.listeners.add(listener);
    try { await entry.pending; } catch (error) { entry.listeners.delete(listener); this.drop(entry, false); throw error; }
    if (entry.dropped) throw agentError("CCDESK_DISCONNECTED");
    receive(this.view(entry));
    const owned = entry;
    return () => {
      if (!owned.listeners.delete(listener) || owned.listeners.size || owned.dropped) return;
      // Keep reading while the phone is away; writes still require a live listener in writable().
      owned.lingerOrder = ++this.lingerOrder;
      owned.lingerTimer = setTimeout(() => {
        if (!owned.listeners.size) this.drop(owned, false);
      }, this.deps.lingerMs ?? LINGER_MS);
      owned.lingerTimer.unref();
    };
  }

  async sendMessage(id: string, input: AgentOperation & { text: string; delivery: "steer" | "queue" }): Promise<AgentDelivery> {
    const entry = this.writable(id, input.controlToken);
    if (!input.text.trim() || input.text.length > 16_000) throw agentError("invalid_message", 400);
    if (entry.submission?.delivery === "submitted") throw agentError("CCDESK_OPERATION_PENDING", 409);
    return this.operate(entry, input.clientMessageId, "message", { type: "message.send", sessionId: id, text: input.text });
  }
  async interruptSession(id: string, input: AgentOperation): Promise<AgentDelivery> {
    const entry = this.writable(id, input.controlToken);
    const active = entry.transcript.activeRun;
    if (!active) throw agentError("CCDESK_NO_RUNNING_TURN", 409);
    return this.operate(entry, input.clientMessageId, "interrupt", { type: "run.cancel", sessionId: id, runId: active.id });
  }
  async respondPermission(id: string, requestId: string, input: AgentOperation & { decision: "once" | "always" | "reject" }): Promise<AgentDelivery> {
    const entry = this.writable(id, input.controlToken);
    const approval = this.approval(entry, requestId, false);
    if (input.decision !== "once" && input.decision !== "reject") throw agentError("CCDESK_DECISION_UNAVAILABLE", 409);
    return this.answer(entry, approval.id, { type: "approval.reply", requestId: input.clientMessageId, sessionId: id, runId: approval.runId, approvalId: approval.id, allowed: input.decision === "once" });
  }
  async respondQuestion(id: string, requestId: string, input: AgentOperation & { answers: string[][] }): Promise<AgentDelivery> {
    const entry = this.writable(id, input.controlToken);
    const approval = this.approval(entry, requestId, true);
    const questions = entry.transcript.interactions("", null).questions.find(question => question.id === approval.id)?.questions ?? [];
    if (input.answers.length !== questions.length || input.answers.some((values, index) => !Array.isArray(values) || !values.length || values.length > 20
      || (!questions[index]!.multiple && values.length !== 1) || values.some(value => typeof value !== "string" || !value.trim() || value.length > 4000)))
      throw agentError("CCDESK_INVALID_ANSWER", 400);
    const answers = Object.fromEntries(questions.map((question, index) => [question.question, input.answers[index]!.join(", ")]));
    return this.answer(entry, approval.id, { type: "approval.reply", requestId: input.clientMessageId, sessionId: id, runId: approval.runId, approvalId: approval.id, allowed: true, answers });
  }

  async stop() {
    this.stopped = true;
    this.control.stop();
    for (const entry of [...this.entries.values()]) this.drop(entry);
    this.entries.clear();
  }

  /** Not found to a reader that could not say which computer it is: most likely hidden from it, not gone. */
  private unseen(connection: CcDeskConnection, error: unknown) {
    return !connection.device && (error as { code?: string }).code === "CCDESK_SESSION_NOT_FOUND" ? agentError("CCDESK_CONTROL_UNAVAILABLE", 409) : error;
  }

  private async connect() {
    if (this.stopped) throw agentError("CCDESK_STOPPED", 503);
    const readToken = this.deps.readToken ?? keychainToken;
    this.token ??= await readToken(this.config.url);
    await this.control.refresh().catch(() => undefined);
    const device = this.control.device;
    const open = (token: string) => {
      const options = { url: this.config.url, token, ...(this.config.fingerprint ? { fingerprint: this.config.fingerprint } : {}), ...(device ? { device } : {}) };
      const connection = this.deps.connection?.(options) ?? new CcDeskConnection(options);
      return connection.open().then(() => connection);
    };
    try { return await open(this.token); }
    catch (error) {
      if ((error as { code?: string }).code !== "CCDESK_AUTH_FAILED") throw error;
      // The token may have been replaced since it was read.
      this.token = await readToken(this.config.url);
      return open(this.token);
    }
  }

  private receive(entry: Entry, message: CcDeskServerMessage) {
    switch (message.type) {
      case "session.event":
        if (message.event.sessionId !== entry.id) return;
        entry.transcript.apply(message.event, true);
        entry.transcript.trim();
        if (entry.submission && entry.submission.delivery !== "confirmed") {
          const { payload } = message.event;
          if (entry.submission.action === "message" && payload.type === "message.user" && payload.messageId === entry.submission.clientMessageId)
            entry.submission = { ...entry.submission, delivery: "confirmed" };
          // However the run ended, a stop has nothing left to do.
          if (entry.submission.action === "interrupt" && payload.type === "run.status" && ["completed", "cancelled", "failed"].includes(String(payload.status)))
            entry.submission = { ...entry.submission, delivery: "confirmed" };
        }
        break;
      case "session.fragment":
        if (message.sessionId !== entry.id) return;
        entry.transcript.apply({ runId: message.runId, createdAt: new Date().toISOString(), payload: message.payload }, false);
        break;
      case "session.updated":
        if (message.session.id !== entry.id) return;
        entry.session = message.session;
        entry.transcript.sync(message.session);
        break;
      case "session.deleted":
        if (message.sessionId === entry.id) this.drop(entry);
        return;
      default: return;
    }
    this.publish(entry);
  }

  private onThisMac(session: CcDeskSession | null) {
    const mine = this.control.device?.id ?? this.config.deviceId;
    return Boolean(session) && (!mine || session!.device?.id === mine);
  }
  private blocked(entry: Entry): string | null {
    if (!this.onThisMac(entry.session)) return "这个会话在另一台电脑上，只能在那台电脑上操作。";
    if (!this.control.writable) return "CC Desk 没有开启手机控制：请在电脑上打开“CC Desk Tunnel（手机控制）”。";
    return null;
  }
  private writable(id: string, controlToken: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.dropped || !entry.session || !entry.listeners.size || entry.token !== controlToken) throw agentError("CCDESK_STALE_CONTROL", 409);
    if (!this.onThisMac(entry.session)) throw agentError("CCDESK_OTHER_DEVICE", 409);
    if (!this.control.writable) throw agentError("CCDESK_CONTROL_UNAVAILABLE", 409);
    return entry;
  }
  private approval(entry: Entry, requestId: string, question: boolean) {
    const approval = entry.transcript.approvals.get(requestId);
    const asked = approval && entry.transcript.tools.get(approval.toolId)?.name === "AskUserQuestion";
    if (!approval || approval.status !== "pending" || Boolean(asked) !== question) throw agentError("CCDESK_REQUEST_EXPIRED", 409);
    return approval;
  }

  private async operate(entry: Entry, clientMessageId: string, action: "message" | "interrupt", command: { type: string; sessionId: string } & Record<string, unknown>): Promise<AgentDelivery> {
    entry.operationError = null;
    entry.submission = { clientMessageId, action, delivery: "submitted" };
    this.publish(entry);
    try {
      const result = await this.control.relay({ ...command, requestId: clientMessageId });
      if (!result.ok) {
        entry.submission = null;
        entry.operationError = { clientMessageId, code: "rejected" };
        this.publish(entry);
        throw agentError(rejected[result.code ?? ""] ?? "CCDESK_REJECTED", 409);
      }
      if (entry.submission?.clientMessageId === clientMessageId && action === "message" && entry.transcript.confirmed.has(clientMessageId))
        entry.submission = { ...entry.submission, delivery: "confirmed" };
      this.publish(entry);
      return { ok: true, delivery: entry.submission?.clientMessageId === clientMessageId ? entry.submission.delivery : "submitted" };
    } catch (error) {
      if ((error as { code?: string }).code === "CCDESK_TIMEOUT") {
        if (entry.submission?.clientMessageId === clientMessageId) entry.submission = { ...entry.submission, delivery: "uncertain" };
        this.publish(entry);
        return { ok: true, delivery: "uncertain" };
      }
      if (entry.submission?.clientMessageId === clientMessageId && entry.submission.delivery === "submitted") entry.submission = null;
      this.publish(entry);
      throw error;
    }
  }

  private async answer(entry: Entry, approvalId: string, command: { type: string; requestId: string; sessionId: string } & Record<string, unknown>): Promise<AgentDelivery> {
    const approval = entry.transcript.approvals.get(approvalId)!;
    approval.status = "submitted";
    this.publish(entry);
    try {
      const result = await this.control.relay(command);
      if (!result.ok) {
        if (entry.transcript.approvals.get(approvalId) === approval) approval.status = "pending";
        this.publish(entry);
        throw agentError(rejected[result.code ?? ""] ?? "CCDESK_REJECTED", 409);
      }
      return { ok: true, delivery: "submitted" };
    } catch (error) {
      if ((error as { code?: string }).code !== "CCDESK_TIMEOUT") {
        if (approval.status === "submitted" && entry.transcript.approvals.get(approvalId) === approval) approval.status = "pending";
        this.publish(entry);
        throw error;
      }
      if (entry.transcript.approvals.get(approvalId) === approval) approval.status = "uncertain";
      this.publish(entry);
      return { ok: true, delivery: "uncertain" };
    }
  }

  private view(entry: Entry): AgentSessionSnapshot {
    const session = entry.session!, transcript = entry.transcript, active = transcript.activeRun;
    const blocked = this.blocked(entry), writable = !blocked && !entry.dropped;
    const busy = entry.submission?.delivery === "submitted";
    return {
      agentId: "ccdesk",
      session: { id: session.id, title: session.title, directory: session.projectPath, updatedAt: session.updatedAt },
      connected: !entry.dropped, updatedAt: new Date().toISOString(),
      status: active ? "running" : "idle", activity: transcript.activity,
      activeTurnId: active?.id ?? null, activityEvidence: active ? activityEvidence(transcript.activity, active.id) : null,
      lastTurn: transcript.lastTurn,
      messages: transcript.list(), ...transcript.interactions(session.projectPath, blocked),
      historyCursor: transcript.hasEarlier && transcript.firstSequence > 1 ? String(transcript.firstSequence) : null,
      partialText: false,
      operationError: entry.operationError,
      control: entry.dropped ? null : { token: entry.token, canSend: writable && !busy, canSteer: writable && !busy && Boolean(active), canInterrupt: writable && Boolean(active) },
      submission: entry.submission ? { ...entry.submission } : null,
    };
  }

  private publish(entry: Entry) {
    if (entry.dropped || !entry.session || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (entry.dropped) return;
      const snapshot = this.view(entry);
      for (const listener of entry.listeners) { try { listener.receive(structuredClone(snapshot)); } catch { /* the stream owner closes it */ } }
    }, 40);
    entry.timer.unref();
  }

  private clearLinger(entry: Entry) {
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = undefined;
    entry.lingerOrder = undefined;
  }

  private drop(entry: Entry, notify = true) {
    if (entry.dropped) return;
    entry.dropped = true;
    clearTimeout(entry.timer);
    this.clearLinger(entry);
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    entry.connection?.close();
    if (notify) for (const listener of [...entry.listeners]) { try { listener.disconnect(); } catch { /* already gone */ } }
    entry.listeners.clear();
  }
}
