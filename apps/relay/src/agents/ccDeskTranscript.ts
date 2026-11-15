import { makeLastTurn, type LastTurn } from "../store/lastTurn.js";
import type { CcDeskEvent, CcDeskPayload, CcDeskSession } from "./ccDeskProtocol.js";
import type { AgentMessage, AgentPermission, AgentQuestion } from "./sessions.js";

export const TRANSCRIPT_LIMIT = 240;
const OUTPUT = 4000, DETAIL = 32_000;
type Stamped = AgentMessage & { sequence: number };
export type CcDeskApproval = { id: string; runId: string; toolId: string; status: "pending" | "submitted" | "uncertain" };
type Run = { id: string; status: string; waiting?: string };

const text = (value: unknown) => (typeof value === "string" ? value : "");
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}\n…（内容已截断）` : value);
const tail = (value: string, max: number) => (value.length > max ? `…（只显示结尾）\n${value.slice(-max)}` : value);
function parsed(input: string): Record<string, unknown> | null {
  try { const value = JSON.parse(input); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
}
/** The shape the phone already knows for tools: `Tool:` and, for shell commands, `Command:`. */
export function toolText(name: string, input: string) {
  const value = parsed(input);
  const lines = [`Tool: ${name}`];
  if (typeof value?.command === "string") lines.push(`Command: ${value.command}`);
  else if (typeof value?.file_path === "string") lines.push(`File: ${value.file_path}`);
  else if (typeof value?.pattern === "string") lines.push(`Pattern: ${value.pattern}`);
  else if (typeof value?.url === "string") lines.push(`URL: ${value.url}`);
  else if (input.trim() && input.trim() !== "{}") lines.push(clip(input.trim(), 2000));
  return lines.join("\n");
}
export function questionsOf(input: string): AgentQuestion["questions"] | null {
  const questions = parsed(input)?.questions;
  if (!Array.isArray(questions) || !questions.length) return null;
  return questions.slice(0, 4).map(raw => {
    const question = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const options = Array.isArray(question.options) ? question.options : [];
    return { question: text(question.question).slice(0, 2000), header: text(question.header).slice(0, 120),
      options: options.slice(0, 20).map(option => ({ label: text((option as Record<string, unknown>)?.label).slice(0, 500), description: text((option as Record<string, unknown>)?.description).slice(0, 2000) })),
      multiple: question.multiSelect === true, custom: true };
  });
}

/**
 * One session as the phone sees it, built from CC Desk events. Streaming text arrives as fragments and is later
 * recorded as one event holding all of it, so the text shown is what was recorded plus the fragments since.
 */
export class CcDeskTranscript {
  readonly messages = new Map<string, Stamped>();
  readonly tools = new Map<string, { name: string; input: string }>();
  readonly approvals = new Map<string, CcDeskApproval>();
  readonly confirmed = new Set<string>();
  private readonly recorded = new Map<string, string>();
  private readonly live = new Map<string, string>();
  activeRun: Run | null = null;
  lastTurn: LastTurn | null = null;
  activity: "thinking" | "working" | "outputting" = "thinking";
  hasEarlier = false;
  firstSequence = 0;
  private last = 0;

  load(page: { events: CcDeskEvent[]; hasEarlier: boolean; firstSequence: number; session?: CcDeskSession }) {
    for (const event of page.events) this.apply(event, true);
    this.hasEarlier = page.hasEarlier;
    this.firstSequence = page.firstSequence;
    if (page.session) this.sync(page.session);
    this.trim();
  }

  /** The service's word on whether a run is going; events say how it ended. */
  sync(session: CcDeskSession) {
    const run = session.activeRun;
    this.activeRun = run ? { id: run.id, status: run.status, ...(run.waiting ? { waiting: run.waiting } : {}) } : null;
  }

  apply(event: Pick<CcDeskEvent, "runId" | "createdAt" | "payload"> & { sequence?: number }, recorded: boolean) {
    const payload = event.payload as CcDeskPayload & Record<string, unknown>;
    const sequence = event.sequence ?? this.last + 0.5;
    if (event.sequence) this.last = Math.max(this.last, event.sequence);
    const at = recorded ? event.createdAt : new Date().toISOString();
    const put = (id: string, message: Omit<Stamped, "id" | "sequence" | "timestamp">) => {
      const existing = this.messages.get(id);
      this.messages.set(id, { ...message, id, timestamp: existing?.timestamp ?? at, sequence: existing?.sequence ?? sequence });
    };
    switch (payload.type) {
      case "message.user": {
        const messageId = text(payload.messageId);
        this.confirmed.add(messageId);
        put(`u:${messageId}`, { role: "user", kind: "user_message", text: payload.continued === true ? "（继续上一轮）" : text(payload.text), turnId: event.runId });
        break;
      }
      case "text.delta": {
        const key = `a:${text(payload.messageId)}`;
        this.stream(key, key, text(payload.text), recorded);
        put(key, { role: "assistant", kind: "agent_message", text: this.joined(key), turnId: event.runId, phase: "commentary" });
        this.activity = "outputting";
        break;
      }
      case "thinking.delta": this.activity = "thinking"; break;
      case "tool.requested": case "tool.input": {
        const toolId = text(payload.toolId), known = this.tools.get(toolId);
        const tool = { name: text(payload.name) || known?.name || "tool", input: text(payload.input) || known?.input || "" };
        this.tools.set(toolId, tool);
        put(`t:${toolId}`, { role: "tool", kind: "function_call", text: toolText(tool.name, tool.input), turnId: event.runId });
        this.activity = "working";
        break;
      }
      case "tool.output": {
        const toolId = text(payload.toolId), key = `o:${toolId}`;
        this.stream(key, `${key}:${text(payload.stream)}`, text(payload.text), recorded);
        put(key, { role: "tool", kind: "function_call_output", text: tail(this.joined(key), OUTPUT), turnId: event.runId });
        this.activity = "working";
        break;
      }
      case "tool.result": {
        const toolId = text(payload.toolId), key = `o:${toolId}`;
        for (const name of [...this.live.keys()]) if (name.startsWith(`${key}:`)) this.live.delete(name);
        const output = text(payload.output) || this.recorded.get(key) || "";
        this.recorded.set(key, output);
        put(key, { role: "tool", kind: "function_call_output", text: `Status: ${text(payload.status)}\n${tail(output, OUTPUT)}`.trimEnd(), turnId: event.runId });
        break;
      }
      case "approval.requested":
        this.approvals.set(text(payload.approvalId), { id: text(payload.approvalId), runId: event.runId, toolId: text(payload.toolId), status: "pending" });
        break;
      case "approval.resolved": this.approvals.delete(text(payload.approvalId)); break;
      case "run.status": {
        const status = text(payload.status);
        if (status === "running" || status === "awaiting_approval") {
          this.activeRun = { id: event.runId, status, ...(typeof payload.waiting === "string" ? { waiting: payload.waiting } : {}) };
          break;
        }
        if (this.activeRun?.id === event.runId) this.activeRun = null;
        for (const [id, approval] of this.approvals) if (approval.runId === event.runId) this.approvals.delete(id);
        this.live.clear();
        const ended = status === "completed" ? makeLastTurn(event.runId, "completed", "ok", event.createdAt, this.lastTurn)
          : status === "cancelled" ? makeLastTurn(event.runId, "interrupted", "cancelled", event.createdAt, this.lastTurn)
            : status === "failed" ? makeLastTurn(event.runId, "failed", "provider_error", event.createdAt, this.lastTurn) : null;
        if (ended) this.lastTurn = ended;
        if (status === "completed") {
          const answer = [...this.messages.values()].filter(message => message.turnId === event.runId && message.kind === "agent_message").at(-1);
          if (answer) answer.phase = "final_answer";
        }
        this.activity = "thinking";
        break;
      }
      case "run.error":
        put(`e:${event.runId}:${sequence}`, { role: "assistant", kind: "agent_message", text: `出错：${clip(text(payload.message), 2000)}`, turnId: event.runId });
        break;
    }
  }

  private stream(message: string, key: string, value: string, recorded: boolean) {
    if (recorded) {
      this.recorded.set(message, (this.recorded.get(message) ?? "") + value);
      this.live.delete(key);
    } else this.live.set(key, (this.live.get(key) ?? "") + value);
  }
  private joined(message: string) {
    let value = this.recorded.get(message) ?? "";
    for (const [key, part] of this.live) if (key === message || key.startsWith(`${message}:`)) value += part;
    return value;
  }

  trim() {
    if (this.messages.size <= TRANSCRIPT_LIMIT) return;
    const kept = [...this.messages.values()].sort((a, b) => a.sequence - b.sequence).slice(-TRANSCRIPT_LIMIT);
    const keep = new Set(kept.map(message => message.id));
    for (const id of [...this.messages.keys()]) if (!keep.has(id)) { this.messages.delete(id); this.recorded.delete(id); }
    this.hasEarlier = true;
    this.firstSequence = Math.ceil(kept[0]!.sequence);
  }

  list(): AgentMessage[] {
    return [...this.messages.values()].sort((a, b) => a.sequence - b.sequence).map(({ sequence: _sequence, ...message }) => message);
  }

  interactions(directory: string, unavailableReason: string | null): { questions: AgentQuestion[]; permissions: AgentPermission[] } {
    const questions: AgentQuestion[] = [], permissions: AgentPermission[] = [];
    for (const approval of this.approvals.values()) {
      const tool = this.tools.get(approval.toolId) ?? { name: "tool", input: "" };
      const asked = tool.name === "AskUserQuestion" ? questionsOf(tool.input) : null;
      if (asked) { questions.push({ id: approval.id, status: approval.status, unavailableReason, questions: asked }); continue; }
      permissions.push({ id: approval.id, status: approval.status, action: tool.name, resources: [directory], save: [],
        detail: clip(`${toolText(tool.name, tool.input)}\n\n${tool.input}`, DETAIL), unavailableReason, decisions: ["once", "reject"] });
    }
    return { questions, permissions };
  }
}
