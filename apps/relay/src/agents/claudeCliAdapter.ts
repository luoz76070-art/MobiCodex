import fs from "node:fs/promises";
import path from "node:path";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SDKSessionInfo, SessionMessage, listSessions, getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, AgentStatus } from "./agentGateway.js";
import { agentError, type AgentDelivery, type AgentOperation, type AgentMessage, type AgentSession, type AgentSessionSnapshot, type SessionAdapter } from "./sessions.js";

import { ClaudeCliRuntime, type ClaudeCliQueryFactory, type ClaudeCliRuntimePorts } from "./claudeCliRuntime.js";

export const claudeCliConfigSchema = z.object({ directories: z.array(z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0"))).max(64), executable: z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0")).optional() }).strict();
export type ClaudeCliConfig = z.infer<typeof claudeCliConfigSchema>;
export type ClaudeCliSdk = { listSessions: typeof listSessions; getSessionInfo: typeof getSessionInfo; getSessionMessages: typeof getSessionMessages; query?: ClaudeCliQueryFactory };
const capabilities = { inspectLoadedSessions: false, sendMessage: false, steer: false, interrupt: false, approve: false };
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const pageSize = 50;
const notice = "只读预览，发送功能下一版提供";
type Located = { info: SDKSessionInfo; directory: string; sdkDirectory: string; unsaved?: boolean };
type Listener = { snapshot: (value: AgentSessionSnapshot) => void; disconnect: () => void; release?: () => void };
type Entry = { id: string; listeners: Set<Listener>; timer?: ReturnType<typeof setTimeout>; pending?: Promise<void>; fingerprint?: string; snapshot?: AgentSessionSnapshot };
type Cursor = { kind: "list"; search: string; time: number; id: string } | { kind: "history"; id: string; before: number; anchor: string };
const inside = (directory: string, root: string) => { const relative = path.relative(root, directory); return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)); };

/** Local records and gateway-owned execution share the same directory authorization. */
export class ClaudeCliAdapter implements AgentAdapter, SessionAdapter {
  readonly sessionApi: SessionAdapter = this;
  private readonly secret = randomBytes(32);
  private readonly controlToken = randomUUID();
  private readonly entries = new Map<string, Entry>();
  private stopped = false;
  private readonly runtime?: ClaudeCliRuntime;
  private readonly localDirectories = new Map<string, string>();
  private readonly sdkDirectories = new Map<string, string>();
  private readonly ownedRecords = new Map<string, string>();
  private readonly checkpoints = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly config: ClaudeCliConfig;
  constructor(config: ClaudeCliConfig | undefined, private readonly sdk: ClaudeCliSdk,
    private readonly registered: (id: string) => Promise<boolean> = async () => false, private readonly pollMs = 3000, runtimePorts: ClaudeCliRuntimePorts = {}) {
    this.config = claudeCliConfigSchema.parse(config ?? { directories: [] });
    if (sdk.query && this.config.directories.length) this.runtime = new ClaudeCliRuntime(sdk.query, this.config.executable, id => this.publishRuntime(id), runtimePorts);
  }
  snapshot(): AgentStatus {
    const enabled = this.config.directories.length > 0;
    return { id: "claude-cli", label: "Claude CLI", transport: "claude-cli-local-records", sessionApi: 1, enabled,
      state: enabled ? this.runtime?.errorCode ? "failed" : "connected" : "unprobed", usesAccessibility: false, sameDesktopThreadVerified: false,
      capabilities: { ...capabilities, sendMessage: Boolean(this.runtime?.available), steer: Boolean(this.runtime?.available), interrupt: Boolean(this.runtime?.available) }, loadedSessions: null, checkedAt: null, errorCode: enabled ? this.runtime?.errorCode ?? null : "CLAUDE_CLI_DISABLED", errorMessage: this.runtime?.errorMessage ?? null, cliVersion: this.runtime?.version };
  }
  async ready() { await this.runtime?.ready(); }
  async probe() { await this.roots(); await this.ready(); return this.snapshot(); }
  validSessionId(id: string) { return uuid.test(id); }
  async listSessions(search = "", cursor?: string) {
    const roots = await this.roots(), query = search.toLocaleLowerCase();
    const after = cursor ? this.decode(cursor, "list") : null;
    if (after && (after.kind !== "list" || after.search !== query)) throw agentError("CLAUDE_CLI_CURSOR_INVALID", 400);
    // The SDK's project lookup is exact, not recursive. Its global metadata API discovers nested
    // projects; no transcript messages are read until a real cwd has passed the allowlist.
    const lists = await Promise.all([this.sdk.listSessions({ includeWorktrees: false }),
      ...roots.map(dir => this.sdk.listSessions({ dir, includeWorktrees: false }))]);
    this.running();
    const located = new Map<string, Located>();
    for (const info of lists.flat()) {
      if (!this.validSessionId(info.sessionId) || !Number.isFinite(info.lastModified)) continue;
      const directory = await this.allowed(info.cwd, roots);
      if (!directory || !`${info.customTitle ?? info.summary}\n${info.firstPrompt ?? ""}`.toLocaleLowerCase().includes(query)) continue;
      const previous = located.get(info.sessionId);
      if (!previous || previous.info.lastModified < info.lastModified) located.set(info.sessionId, { info, directory, sdkDirectory: path.resolve(info.cwd!) });
    }
    for (const session of this.runtime?.sessions() ?? []) {
      if (located.has(session.id) || !`${session.title}`.toLocaleLowerCase().includes(query)) continue;
      const cwd = this.localDirectories.get(session.id), directory = await this.allowed(cwd, roots);
      if (directory) located.set(session.id, { info: { sessionId: session.id, summary: session.title, lastModified: Date.parse(session.updatedAt), fileSize: 0, cwd }, directory, sdkDirectory: cwd! });
    }
    const sorted = [...located.values()].sort((a, b) => b.info.lastModified - a.info.lastModified || a.info.sessionId.localeCompare(b.info.sessionId));
    const remaining = sorted.filter(({ info }) => !after || after.kind === "list" && (info.lastModified < after.time || info.lastModified === after.time && info.sessionId.localeCompare(after.id) > 0));
    const page = remaining.slice(0, pageSize), last = page.at(-1)?.info;
    const sessions = await Promise.all(page.map(item => this.view(item)));
    this.running();
    return { sessions, cursor: remaining.length > pageSize && last ? this.encode({ kind: "list", search: query, time: last.lastModified, id: last.sessionId }) : null };
  }
  async readHistory(id: string, cursor: string) {
    const boundary = this.decode(cursor, "history");
    if (boundary.kind !== "history" || boundary.id !== id) throw agentError("CLAUDE_CLI_CURSOR_INVALID", 400);
    const located = await this.locate(id), rows = await this.messages(located);
    if (boundary.before > rows.length || rows[boundary.before - 1]?.uuid !== boundary.anchor) throw agentError("CLAUDE_CLI_HISTORY_CHANGED", 409);
    return this.page(rows, boundary.before, id);
  }
  async watchSession(id: string, onSnapshot: Listener["snapshot"], onDisconnect: Listener["disconnect"]) {
    await this.locate(id);
    await this.ready();
    this.running();
    let entry = this.entries.get(id);
    if (!entry) { entry = { id, listeners: new Set() }; this.entries.set(id, entry); }
    const listener: Listener = { snapshot: onSnapshot, disconnect: onDisconnect };
    entry.listeners.add(listener);
    const unwatch = this.runtime?.watch(id);
    let released = false;
    listener.release = () => { if (!released) { released = true; unwatch?.(); } };
    try {
      if (entry.snapshot) onSnapshot(structuredClone(entry.snapshot));
      await this.refresh(entry);
    } catch (error) { listener.release(); this.drop(entry); throw error; }
    return () => { listener.release?.(); entry.listeners.delete(listener); if (!entry.listeners.size) this.drop(entry); };
  }
  async listDirectories() {
    const roots = await this.roots(); await this.ready();
    return { directories: roots.map((directory, index) => ({ id: this.directoryId(index), label: path.basename(directory) })), errorCode: this.runtime?.errorCode ?? null, errorMessage: this.runtime?.errorMessage ?? null };
  }
  async createSession(input: { directory: string; text: string }) {
    const roots = await this.roots();
    const directory = roots.find((_root, index) => this.directoryId(index) === input.directory);
    if (!directory) throw agentError("CLAUDE_CLI_SESSION_NOT_ALLOWED", 404);
    if (!this.runtime) throw agentError("CLAUDE_CLI_READ_ONLY", 409);
    const id = randomUUID(), now = new Date().toISOString();
    this.localDirectories.set(id, directory); this.sdkDirectories.set(id, directory);
    const session = { id, title: input.text.slice(0, 200), directory: path.basename(directory), updatedAt: now };
    try {
      await this.ready();
      if (!(await this.roots()).includes(directory)) throw agentError("CLAUDE_CLI_SESSION_NOT_ALLOWED", 404);
      await this.runtime.start(this.baseSnapshot(session, [], null), directory, { text: input.text, clientMessageId: randomUUID() }, false);
    } catch (error) { this.localDirectories.delete(id); this.sdkDirectories.delete(id); throw error; }
    return { session };
  }
  async sendMessage(id: string, input: AgentOperation & { text: string; delivery: "queue" | "steer" }): Promise<AgentDelivery> {
    return this.serialize(id, async () => {
      if (!this.runtime) throw agentError("CLAUDE_CLI_READ_ONLY", 409);
      this.checkControl(input);
      await this.checkpoints.get(id);
      const located = await this.locate(id);
      if (located.unsaved && !this.runtime.owns(id)) throw agentError("CLAUDE_CLI_SESSION_NOT_SAVED", 409);
      if (await this.registered(id) || this.externalWrite(id, located.info)) throw agentError("CLAUDE_CLI_SESSION_BUSY", 409);
      await this.ready();
      if (this.runtime.owns(id)) this.runtime.send(id, input, input.delivery);
      else {
        const rows = await this.messages(located), page = this.page(rows, rows.length, id);
        if (await this.registered(id)) throw agentError("CLAUDE_CLI_SESSION_BUSY", 409);
        const latest = await this.locate(id);
        if (latest.directory !== located.directory || this.externalWrite(id, latest.info)) throw agentError("CLAUDE_CLI_SESSION_BUSY", 409);
        if (await this.allowed(located.sdkDirectory, await this.roots()) !== located.directory) throw agentError("CLAUDE_CLI_SESSION_NOT_ALLOWED", 404);
        this.localDirectories.set(id, located.directory); this.sdkDirectories.set(id, located.sdkDirectory);
        await this.runtime.start(this.baseSnapshot(await this.view(located), page.messages, page.cursor), located.sdkDirectory, input, true);
      }
      return { ok: true, delivery: "confirmed" };
    });
  }
  async interruptSession(id: string, input: AgentOperation): Promise<AgentDelivery> {
    if (!this.runtime) throw agentError("CLAUDE_CLI_READ_ONLY", 409);
    this.checkControl(input); await this.locate(id);
    await this.runtime.interrupt(id, input); return { ok: true, delivery: "confirmed" };
  }
  async cancelQueuedMessage(id: string, queuedId: string, input: AgentOperation): Promise<AgentDelivery> {
    if (!this.runtime) throw agentError("CLAUDE_CLI_READ_ONLY", 409);
    this.checkControl(input); await this.locate(id);
    this.runtime.cancel(id, queuedId); return { ok: true, delivery: "confirmed" };
  }
  private checkControl(input: AgentOperation) { if (input.controlToken !== this.controlToken) throw agentError("CLAUDE_CLI_CONTROL_CHANGED", 409); this.running(); }
  private recordStamp(info: SDKSessionInfo) { return JSON.stringify([info.lastModified, info.fileSize, info.cwd]); }
  private externalWrite(id: string, info: SDKSessionInfo) {
    return !this.runtime?.owns(id) && Date.now() - info.lastModified < 120_000 && this.ownedRecords.get(id) !== this.recordStamp(info);
  }
  private directoryId(index: number) { return createHmac("sha256", this.secret).update(`directory:${index}`).digest("hex"); }
  private serialize<T>(id: string, run: () => Promise<T>): Promise<T> {
    const pending = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
    this.writes.set(id, pending);
    void pending.finally(() => { if (this.writes.get(id) === pending) this.writes.delete(id); }).catch(() => {});
    return pending;
  }
  async respondQuestion(): Promise<AgentDelivery> { throw agentError("CLAUDE_CLI_READ_ONLY", 409); }
  async respondPermission(): Promise<AgentDelivery> { throw agentError("CLAUDE_CLI_READ_ONLY", 409); }
  async stop() { this.stopped = true; this.runtime?.stop(); for (const entry of this.entries.values()) this.drop(entry); }
  private running() { if (this.stopped) throw agentError("CLAUDE_CLI_STOPPED", 503); }
  private async roots() {
    this.running();
    if (!this.config.directories.length) throw agentError("CLAUDE_CLI_DISABLED", 409);
    try {
      const roots = await Promise.all(this.config.directories.map(async directory => {
        const real = await fs.realpath(directory);
        if (!(await fs.stat(real)).isDirectory()) throw new Error();
        return real;
      }));
      this.running(); return [...new Set(roots)];
    } catch { throw agentError("CLAUDE_CLI_DIRECTORY_UNAVAILABLE", 409); }
  }
  private async allowed(cwd: string | undefined, roots: string[]) {
    if (!cwd || !path.isAbsolute(cwd) || cwd.includes("\0")) return null;
    try { const directory = await fs.realpath(cwd); return roots.some(root => inside(directory, root)) && (await fs.stat(directory)).isDirectory() ? directory : null; }
    catch { return null; }
  }
  private async locate(id: string): Promise<Located> {
    if (!this.validSessionId(id)) throw agentError("AGENT_SESSION_ID_INVALID", 400);
    const roots = await this.roots();
    const local = this.localDirectories.get(id), snapshot = this.runtime?.snapshot(id);
    if (local && snapshot && this.runtime?.owns(id)) {
      const sdkDirectory = this.sdkDirectories.get(id) ?? local;
      const directory = await this.allowed(sdkDirectory, roots);
      if (directory === local) return { info: { sessionId: id, summary: snapshot.session.title, cwd: local, lastModified: Date.parse(snapshot.session.updatedAt), fileSize: 0 }, directory, sdkDirectory };
      throw agentError("CLAUDE_CLI_SESSION_NOT_ALLOWED", 404);
    }
    const metadata = await this.sdk.listSessions({ includeWorktrees: false });
    for (const candidate of metadata) {
      if (candidate.sessionId !== id) continue;
      const directory = await this.allowed(candidate.cwd, roots);
      if (!directory) continue;
      // Keep the SDK's project key for an authorized symlink alias. Authorization always
      // uses its real directory, never the encoded project name or a client path.
      const sdkDirectory = path.resolve(candidate.cwd!);
      const info = await this.sdk.getSessionInfo(id, { dir: sdkDirectory });
      const currentRoots = await this.roots();
      if (info?.sessionId === id && await this.allowed(sdkDirectory, currentRoots) === directory
        && await this.allowed(info.cwd, currentRoots) === directory) return { info, directory, sdkDirectory };
    }
    // Startup may fail before the CLI persists its first record. Keep the failure
    // visible to a phone subscribing after the process has already exited.
    if (local && snapshot && !metadata.some(info => info.sessionId === id) && await this.allowed(this.sdkDirectories.get(id) ?? local, roots) === local) return {
      info: { sessionId: id, summary: snapshot.session.title, cwd: local, lastModified: Date.parse(snapshot.session.updatedAt), fileSize: 0 },
      directory: local, sdkDirectory: this.sdkDirectories.get(id) ?? local, unsaved: true,
    };
    throw agentError("CLAUDE_CLI_SESSION_NOT_ALLOWED", 404);
  }
  private async messages(located: Located) {
    if (await this.allowed(located.sdkDirectory, await this.roots()) !== located.directory) throw agentError("CLAUDE_CLI_SESSION_NOT_ALLOWED", 404);
    const rows = await this.sdk.getSessionMessages(located.info.sessionId, { dir: located.sdkDirectory });
    const verified = await this.locate(located.info.sessionId);
    if (verified.directory !== located.directory) throw agentError("CLAUDE_CLI_SESSION_NOT_ALLOWED", 404);
    return rows.filter(row => row.session_id === located.info.sessionId && row.parent_tool_use_id === null && row.parent_agent_id === null && ["user", "assistant"].includes(row.type));
  }
  private async view({ info, directory }: Located): Promise<AgentSession> {
    return { id: info.sessionId, title: (info.customTitle || info.summary || info.firstPrompt || "Claude CLI 会话").slice(0, 200),
      directory: path.basename(directory), updatedAt: new Date(info.lastModified).toISOString(), desktopOpen: await this.registered(info.sessionId) };
  }
  private page(rows: SessionMessage[], before: number, id: string) {
    const start = Math.max(0, before - pageSize);
    return { messages: rows.slice(start, before).flatMap(row => this.project(row)),
      cursor: start > 0 ? this.encode({ kind: "history", id, before: start, anchor: rows[start - 1]!.uuid }) : null };
  }
  private project(row: SessionMessage): AgentMessage[] {
    const message = row.message as { content?: unknown } | null;
    const content = message?.content;
    const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    const text: string[] = [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") text.push(part.text.slice(0, 4000));
      else if (part.type === "tool_use" && typeof part.name === "string") text.push(`工具调用：${part.name.slice(0, 80)}`);
      else if (part.type === "tool_result") text.push(part.is_error ? "工具执行失败" : "工具执行结果");
      if (text.join("\n").length >= 4000) break;
    }
    // The SDK strips timestamps. Empty timestamps hide the clock; the shared stable sort
    // preserves SDK chain order across history pages without inventing event times.
    return text.length ? [{ id: row.uuid, timestamp: "", role: row.type, text: text.join("\n").slice(0, 4000), kind: "agent_message" }] : [];
  }
  private current(entry: Entry) { return !this.stopped && this.entries.get(entry.id) === entry && entry.listeners.size > 0; }
  private refresh(entry: Entry): Promise<void> {
    if (entry.pending) return entry.pending;
    clearTimeout(entry.timer);
    const pending = this.readSnapshot(entry).finally(() => {
      if (entry.pending === pending) entry.pending = undefined;
      if (this.current(entry)) { entry.timer = setTimeout(() => { void this.refresh(entry).catch(() => this.drop(entry)); }, this.pollMs); entry.timer.unref(); }
    });
    return entry.pending = pending;
  }
  private async readSnapshot(entry: Entry) {
    const located = await this.locate(entry.id), session = await this.view(located);
    if (this.runtime?.owns(entry.id)) {
      const snapshot = this.runtime.snapshot(entry.id)!;
      snapshot.session.desktopOpen = session.desktopOpen;
      const info = await this.sdk.getSessionInfo(entry.id, { dir: located.sdkDirectory });
      if (info) {
        if (await this.allowed(info.cwd, await this.roots()) !== located.directory) throw agentError("CLAUDE_CLI_SESSION_NOT_ALLOWED", 404);
        const fingerprint = this.recordStamp(info);
        if (fingerprint !== entry.fingerprint) {
          const rows = await this.messages(located);
          if (this.runtime.owns(entry.id) && this.runtime.snapshot(entry.id) === snapshot && this.current(entry)) { snapshot.historyCursor = this.page(rows, rows.length, entry.id).cursor; entry.fingerprint = fingerprint; }
        }
      }
      this.publishRuntime(entry.id); return;
    }
    const fingerprint = JSON.stringify([located.directory, located.info.lastModified, located.info.fileSize, session]);
    if (!this.current(entry) || fingerprint === entry.fingerprint) return;
    const rows = await this.messages(located), page = this.page(rows, rows.length, entry.id);
    if (!this.current(entry)) return;
    if (this.runtime?.owns(entry.id)) { this.publishRuntime(entry.id); return; }
    const snapshot = this.baseSnapshot(session, page.messages, page.cursor);
    const previous = this.runtime?.snapshot(entry.id);
    if (previous) {
      snapshot.lastTurn = previous.lastTurn;
      snapshot.messages = [...page.messages, ...previous.messages.filter(message => message.role === "system" && !page.messages.some(row => row.id === message.id))].slice(-100);
    }
    if (located.unsaved && previous) {
      snapshot.messages = previous.messages;
      snapshot.readOnly = "会话记录尚未保存，请在电脑检查 Claude Code 的运行状态。";
      snapshot.control!.canSend = false;
    }
    entry.fingerprint = fingerprint; entry.snapshot = snapshot;
    for (const listener of entry.listeners) { try { listener.snapshot(structuredClone(snapshot)); } catch { listener.release?.(); entry.listeners.delete(listener); } }
    if (!entry.listeners.size) this.drop(entry);
  }
  private baseSnapshot(session: AgentSession, messages: AgentMessage[], historyCursor: string | null): AgentSessionSnapshot {
    const canSend = Boolean(this.runtime?.available);
    return { agentId: "claude-cli", session, connected: true, updatedAt: session.updatedAt, status: "idle", activity: "outputting", messages, historyCursor, partialText: true,
      ...(!canSend ? { readOnly: this.runtime?.errorMessage ?? notice } : {}), questions: [], permissions: [],
      control: { token: this.controlToken, canSend, canSteer: false, canInterrupt: false }, submission: null };
  }
  private publishRuntime(id: string) {
    const entry = this.entries.get(id), snapshot = this.runtime?.snapshot(id);
    // Remember the record fingerprint observed after our own turn, so reclaiming a
    // process does not misclassify its unchanged last write as an external writer.
    const directory = this.sdkDirectories.get(id);
    if (snapshot?.status === "idle" && this.runtime?.owns(id) && directory && !this.checkpoints.has(id)) {
      const pending = this.sdk.getSessionInfo(id, { dir: directory }).then(info => {
        if (info && this.runtime?.owns(id) && !this.stopped) this.ownedRecords.set(id, this.recordStamp(info));
      }).catch(() => {}).finally(() => { if (this.checkpoints.get(id) === pending) this.checkpoints.delete(id); });
      this.checkpoints.set(id, pending);
    }
    if (!entry || !this.current(entry) || !snapshot) return;
    entry.snapshot = structuredClone(snapshot);
    for (const listener of entry.listeners) { try { listener.snapshot(structuredClone(snapshot)); } catch { listener.release?.(); entry.listeners.delete(listener); } }
    if (!entry.listeners.size) this.drop(entry);
  }
  private drop(entry: Entry) {
    if (this.entries.get(entry.id) !== entry) return;
    this.entries.delete(entry.id); clearTimeout(entry.timer);
    for (const listener of entry.listeners) { listener.release?.(); try { listener.disconnect(); } catch { /* SSE owner may already be closed. */ } }
    entry.listeners.clear();
  }
  private encode(value: Cursor) {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${body}.${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }
  private decode(value: string, kind: Cursor["kind"]): Cursor {
    try {
      const [body, signature, extra] = value.split(".");
      if (!body || !signature || extra || value.length > 4096) throw new Error();
      const expected = createHmac("sha256", this.secret).update(body).digest(), actual = Buffer.from(signature, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      const result = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Cursor;
      if (result.kind !== kind) throw new Error();
      return result;
    } catch { throw agentError("CLAUDE_CLI_CURSOR_INVALID", 400); }
  }
}
