import { randomUUID } from "node:crypto";
import type { query, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentError, type AgentMessage, type AgentOperation, type AgentPermissionMode, type AgentSessionSnapshot } from "./sessions.js";
import { ClaudeCliInteractions } from "./claudeCliInteractions.js";
import { compatibleClaudeVersion, resolveClaudeCliExecutable, claudeCliMinimumVersion, type ClaudeCliExecutable } from "./claudeCliExecutable.js";

export type ClaudeCliQuery = Pick<Query, typeof Symbol.asyncIterator | "interrupt" | "close" | "supportedModels" | "setModel" | "setPermissionMode">;
export type ClaudeCliQueryFactory = (input: Parameters<typeof query>[0]) => ClaudeCliQuery;
export type ClaudeCliRuntimePorts = {
  resolveExecutable?: (configured?: string) => Promise<ClaudeCliExecutable>;
  idleMs?: number;
  interactionMs?: number;
  now?: () => number;
};
type Input = { text: string; clientMessageId: string };
class InputStream implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private wake?: () => void;
  private ended = false;
  push(value: SDKUserMessage) { if (this.ended) throw agentError("CLAUDE_CLI_PROCESS_EXITED", 409); if (this.values.length >= 64) throw agentError("CLAUDE_CLI_QUEUE_FULL", 409); this.values.push(value); this.wake?.(); }
  close() { this.ended = true; this.values = []; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended) {
      const value = this.values.shift();
      if (value) yield value;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}
type Run = {
  interactions?: ClaudeCliInteractions; query?: ClaudeCliQuery; input: InputStream; snapshot: AgentSessionSnapshot; pending: Input[];
  streamId?: string; blocks: Map<number, string>; timer?: ReturnType<typeof setTimeout>;
  interrupted: boolean; closed: boolean; turnId: string;
};

/** Owns only processes created by this gateway. Reading a record never starts query(). */
export class ClaudeCliRuntime {
  private readonly runs = new Map<string, Run>();
  private readonly viewers = new Map<string, number>();
  private stopped = false;
  private executable?: ClaudeCliExecutable;
  private initialization?: Promise<void>;
  errorCode: string | null = null;
  errorMessage: string | null = null;
  constructor(private readonly factory: ClaudeCliQueryFactory, private readonly configured: string | undefined,
    private readonly publish: (id: string) => void, private readonly ports: ClaudeCliRuntimePorts = {}) {}
  ready() {
    return this.initialization ??= (async () => {
      try {
        this.executable = await (this.ports.resolveExecutable ?? resolveClaudeCliExecutable)(this.configured);
        if (!compatibleClaudeVersion(this.executable.version)) {
          this.errorCode = "CLAUDE_CLI_VERSION_TOO_OLD";
          this.errorMessage = `请升级 Claude Code（当前 ${this.executable.version}，需要 ≥ ${claudeCliMinimumVersion}）`;
        }
      } catch (error) {
        this.errorCode = (error as { code?: string }).code ?? "CLAUDE_CLI_VERSION_FAILED";
        this.errorMessage = this.errorCode === "CLAUDE_CLI_EXECUTABLE_NOT_FOUND" ? "未找到 Claude Code，请在电脑安装 claude 或配置 claudeCli.executable。" : "无法检查 Claude Code 版本，请在电脑检查 claude 安装。";
      }
    })();
  }
  get version() { return this.executable?.version; }
  get available() { return Boolean(this.executable && !this.errorCode && !this.stopped); }
  private now() { return this.ports.now?.() ?? Date.now(); }
  owns(id: string) { const run = this.runs.get(id); return Boolean(run && !run.closed); }
  snapshot(id: string) { return this.runs.get(id)?.snapshot; }
  sessions() { return [...this.runs.values()].map(run => run.snapshot.session); }
  watch(id: string) {
    this.viewers.set(id, (this.viewers.get(id) ?? 0) + 1);
    clearTimeout(this.runs.get(id)?.timer);
    return () => {
      const remaining = (this.viewers.get(id) ?? 1) - 1;
      if (remaining > 0) this.viewers.set(id, remaining); else this.viewers.delete(id);
      const run = this.runs.get(id); if (run) this.reapLater(id, run);
    };
  }
  async start(snapshot: AgentSessionSnapshot, directory: string, input: Input, resume: boolean) {
    await this.ready();
    if (this.stopped) throw agentError("CLAUDE_CLI_STOPPED", 503);
    if (!this.available) throw agentError(this.errorCode ?? "CLAUDE_CLI_VERSION_FAILED", 409);
    if ([...this.runs.values()].filter(run => !run.closed).length >= 3) throw agentError("CLAUDE_CLI_BUSY_LIMIT", 409);
    const id = snapshot.session.id;
    if (this.owns(id)) throw agentError("CLAUDE_CLI_SESSION_BUSY", 409);
    // Reserve the slot before factory construction or starting any asynchronous work.
    const previous = this.runs.get(id)?.snapshot;
    const run: Run = { input: new InputStream(), snapshot: structuredClone(snapshot), pending: [], blocks: new Map(), interrupted: false, closed: false, turnId: randomUUID() };
    run.snapshot.lastTurn = previous?.lastTurn ?? snapshot.lastTurn;
    this.runs.set(id, run);
    for (const [key, previous] of this.runs) { if (this.runs.size <= 128) break; if (previous.closed && !this.viewers.has(key)) this.runs.delete(key); }
    run.snapshot.questions = []; run.snapshot.permissions = [];
    run.snapshot.runtimeSettings = { permissionMode: "default", model: null };
    run.interactions = new ClaudeCliInteractions(run.snapshot, directory, () => this.changed(id, run), () => {
      run.interrupted = true; run.interactions?.revoke("等待手机答复超时，本轮已中断。");
      void run.query?.interrupt().catch(() => { if (!run.closed) this.fail(id, run); });
    }, this.ports.interactionMs);
    try {
      run.query = this.factory({ prompt: run.input, options: {
        pathToClaudeCodeExecutable: this.executable!.executable,
        cwd: directory, ...(resume ? { resume: id } : { sessionId: id }),
        includePartialMessages: true, permissionMode: "default", settingSources: ["user", "project", "local"], env: { ...process.env },
        canUseTool: async (name, input, options) => {
          if (run.closed || this.stopped || run.interrupted || run.snapshot.status !== "running") return { behavior: "deny", message: "本轮已结束，请求已撤回" };
          return run.interactions!.request(name, input, options);
        },
      } });
      this.deliver(id, run, input, false);
      void this.consume(id, run);
    } catch {
      this.fail(id, run); throw agentError("CLAUDE_CLI_PROCESS_FAILED", 409);
    }
  }
  send(id: string, input: Input, delivery: "queue" | "steer") {
    const run = this.runs.get(id);
    if (!run || run.closed) throw agentError("CLAUDE_CLI_PROCESS_EXITED", 409);
    if (run.pending.length >= 64) throw agentError("CLAUDE_CLI_QUEUE_FULL", 409);
    if (delivery === "queue" && run.snapshot.status === "running") {
      run.pending.push(input); this.receipt(run, input.clientMessageId, "message"); this.changed(id, run);
    } else this.deliver(id, run, input, delivery === "steer");
  }
  async interrupt(id: string, input: AgentOperation) {
    const run = this.runs.get(id);
    if (!run?.query || run.closed || run.snapshot.status !== "running") throw agentError("CLAUDE_CLI_NOT_RUNNING", 409);
    run.interrupted = true; run.interactions?.revoke("本轮已中断，请求已撤回");
    try { await run.query.interrupt(); } catch { this.fail(id, run); throw agentError("CLAUDE_CLI_PROCESS_FAILED", 409); }
    this.receipt(run, input.clientMessageId, "interrupt"); this.changed(id, run);
  }
  cancel(id: string, clientMessageId: string) {
    const run = this.runs.get(id);
    if (!run || run.closed) throw agentError("CLAUDE_CLI_PROCESS_EXITED", 409);
    if (!run.pending.some(item => item.clientMessageId === clientMessageId)) throw agentError("CLAUDE_CLI_QUEUE_ITEM_UNAVAILABLE", 409);
    run.pending = run.pending.filter(item => item.clientMessageId !== clientMessageId); this.changed(id, run);
  }
  permission(id: string, requestId: string, decision: "once" | "always" | "reject", reason?: string) {
    const run = this.runs.get(id);
    if (!run || run.closed) throw agentError("CLAUDE_CLI_REQUEST_HANDLED", 409);
    run.interactions!.permission(requestId, decision, reason);
  }
  question(id: string, requestId: string, answers: string[][]) {
    const run = this.runs.get(id);
    if (!run || run.closed) throw agentError("CLAUDE_CLI_REQUEST_HANDLED", 409);
    run.interactions!.question(requestId, answers);
  }
  private controlled(id: string) {
    const run = this.runs.get(id);
    if (!run?.query || run.closed || this.stopped) throw agentError("CLAUDE_CLI_NOT_RUNNING", 409);
    return run as Run & { query: ClaudeCliQuery };
  }
  private stillCurrent(id: string, run: Run) {
    if (this.controlled(id) !== run) throw agentError("CLAUDE_CLI_NOT_RUNNING", 409);
  }
  async settings(id: string) {
    const run = this.controlled(id);
    const models = await run.query.supportedModels().catch(() => { throw agentError("CLAUDE_CLI_SETTINGS_FAILED", 409); }); this.stillCurrent(id, run);
    return { ...run.snapshot.runtimeSettings!, models: models.map(({ value, displayName, description }) => ({ value, displayName, description })) };
  }
  async setPermissionMode(id: string, mode: AgentPermissionMode) {
    if (!["default", "plan", "acceptEdits"].includes(mode)) throw agentError("CLAUDE_CLI_PERMISSION_MODE_INVALID", 400);
    const run = this.controlled(id);
    await run.query.setPermissionMode(mode).catch(() => { throw agentError("CLAUDE_CLI_SETTINGS_FAILED", 409); }); this.stillCurrent(id, run);
    run.snapshot.runtimeSettings!.permissionMode = mode; this.changed(id, run);
  }
  async setModel(id: string, model: string) {
    const run = this.controlled(id), { models } = await this.settings(id); this.stillCurrent(id, run);
    if (!models.some(item => item.value === model)) throw agentError("CLAUDE_CLI_MODEL_INVALID", 400);
    await run.query.setModel(model).catch(() => { throw agentError("CLAUDE_CLI_SETTINGS_FAILED", 409); }); this.stillCurrent(id, run);
    run.snapshot.runtimeSettings!.model = model; this.changed(id, run);
  }
  stop() { this.stopped = true; for (const run of this.runs.values()) this.close(run); this.viewers.clear(); }
  private receipt(run: Run, clientMessageId: string, action: "message" | "interrupt") { run.snapshot.submission = { clientMessageId, action, delivery: "confirmed" }; }
  private deliver(id: string, run: Run, input: Input, steer: boolean) {
    clearTimeout(run.timer);
    if (run.snapshot.status !== "running") { run.turnId = randomUUID(); run.interrupted = false; }
    run.snapshot.status = "running"; run.snapshot.activity = "thinking"; run.snapshot.activeTurnId = run.turnId;
    run.input.push({ type: "user", uuid: input.clientMessageId as ReturnType<typeof randomUUID>, session_id: id, parent_tool_use_id: null,
      message: { role: "user", content: input.text }, ...(steer ? { priority: "now" as const } : {}) });
    this.upsert(run, { id: input.clientMessageId, timestamp: "", role: "user", text: input.text, kind: "agent_message", turnId: run.turnId });
    this.receipt(run, input.clientMessageId, "message"); this.changed(id, run);
  }
  private changed(id: string, run: Run) {
    run.snapshot.activityEvidence = run.snapshot.status === "running" ? { kind: run.snapshot.activity, turnId: run.turnId, observedAt: new Date(this.now()).toISOString() } : null;
    run.snapshot.updatedAt = new Date(this.now()).toISOString(); run.snapshot.session.updatedAt = run.snapshot.updatedAt;
    run.snapshot.queue = { available: !run.closed, items: run.pending.map(item => ({ ...item, status: "waiting" })) };
    run.snapshot.control = { token: run.snapshot.control!.token, canSend: this.available, canSteer: !run.closed && run.snapshot.status === "running", canInterrupt: !run.closed && run.snapshot.status === "running" };
    if (!this.stopped) this.publish(id);
  }
  private upsert(run: Run, message: AgentMessage) {
    run.snapshot.messages = [...run.snapshot.messages.filter(item => item.id !== message.id), message].slice(-100);
  }
  private async consume(id: string, run: Run) {
    try {
      for await (const message of run.query!) {
        if (run.closed || this.stopped) return;
        this.event(id, run, message);
      }
      if (!run.closed && !this.stopped) {
        if (run.snapshot.status === "running") this.fail(id, run);
        else { this.close(run); this.changed(id, run); }
      }
    } catch { if (!run.closed && !this.stopped) this.fail(id, run); }
  }
  private event(id: string, run: Run, message: SDKMessage) {
    if (message.session_id !== id || ("parent_tool_use_id" in message && message.parent_tool_use_id) || ("agent_id" in message && message.agent_id)) return;
    if (message.type === "system" && message.subtype === "init") {
      run.snapshot.runtimeSettings!.model = message.model;
    } else if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "message_start") { run.streamId = `stream:${event.message.id}`; run.blocks.clear(); }
      else if (event.type === "content_block_start") {
        if (event.content_block.type === "text") { run.blocks.set(event.index, event.content_block.text.slice(0, 4000)); run.snapshot.activity = "outputting"; }
        else if (event.content_block.type === "tool_use") { run.blocks.set(event.index, `工具调用：${event.content_block.name.slice(0, 80)}`); run.snapshot.activity = "working"; }
        else if (event.content_block.type === "thinking") run.snapshot.activity = "thinking";
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        run.blocks.set(event.index, ((run.blocks.get(event.index) ?? "") + event.delta.text).slice(0, 4000)); run.snapshot.activity = "outputting";
      }
      const text = [...run.blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n").slice(0, 4000);
      if (text && run.streamId) this.upsert(run, { id: run.streamId, timestamp: "", role: "assistant", kind: "agent_message", text, turnId: run.turnId });
    } else if (message.type === "assistant") {
      if (run.streamId) run.snapshot.messages = run.snapshot.messages.filter(item => item.id !== run.streamId);
      run.streamId = undefined; run.blocks.clear();
      const text = message.message.content.flatMap(part => part.type === "text" ? [part.text] : part.type === "tool_use" ? [`工具调用：${part.name.slice(0, 80)}`] : []).join("\n").slice(0, 4000);
      if (text) this.upsert(run, { id: message.uuid, timestamp: "", role: "assistant", kind: "agent_message", text, turnId: run.turnId });
      run.snapshot.activity = message.message.content.some(part => part.type === "tool_use") ? "working" : "outputting";
    } else if (message.type === "result") {
      run.interactions?.revoke();
      const status = run.interrupted ? "interrupted" : message.is_error || message.subtype !== "success" ? "failed" : "completed";
      run.snapshot.lastTurn = { turnId: run.turnId, status, reason: { code: `CLAUDE_CLI_${status.toUpperCase()}`, message: status === "completed" ? "已完成" : status === "interrupted" ? "已中断" : "运行失败，请在电脑检查 Claude Code。" }, endedAt: new Date(this.now()).toISOString(), timeSource: "observed" };
      run.snapshot.status = "idle"; run.snapshot.activity = "outputting"; run.snapshot.activeTurnId = null;
      this.changed(id, run);
      const next = run.pending.shift();
      if (next) this.deliver(id, run, next, false); else this.reapLater(id, run);
      return;
    } else return;
    this.changed(id, run);
  }
  private fail(id: string, run: Run) {
    this.close(run);
    run.snapshot.status = "idle"; run.snapshot.activeTurnId = null;
    run.snapshot.lastTurn = { turnId: run.turnId, status: "failed", reason: { code: "CLAUDE_CLI_PROCESS_FAILED", message: "Claude Code 进程异常退出，请重试。" }, endedAt: new Date(this.now()).toISOString(), timeSource: "observed" };
    // Retain the text visibly, but never replay inputs after a process crash.
    for (const pending of run.pending) this.upsert(run, { id: `unsent:${pending.clientMessageId}`, role: "system", kind: "system", timestamp: "", text: `进程已退出，这条待发消息未发送，请重新提交：\n${pending.text.slice(0, 4000)}` });
    run.pending = [];
    this.changed(id, run);
  }
  private close(run: Run) {
    if (run.closed) return;
    run.closed = true; delete run.snapshot.runtimeSettings; run.interactions?.revoke("会话进程已退出，请求已撤回"); clearTimeout(run.timer); run.input.close();
    try { run.query?.close(); } catch { /* Closing one process must not prevent the others from closing. */ }
  }
  private reapLater(id: string, run: Run) {
    clearTimeout(run.timer);
    if (run.closed || run.snapshot.status !== "idle" || this.viewers.has(id)) return;
    run.timer = setTimeout(() => { this.close(run); this.changed(id, run); }, this.ports.idleMs ?? 15 * 60_000);
    run.timer.unref();
  }
}
