import fs from "node:fs/promises";
import path from "node:path";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SDKSessionInfo, SessionMessage, listSessions, getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, AgentStatus } from "./agentGateway.js";
import { agentError, type AgentDelivery, type AgentMessage, type AgentSession, type AgentSessionSnapshot, type SessionAdapter } from "./sessions.js";

export const claudeCliConfigSchema = z.object({ directories: z.array(z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0"))).max(64) }).strict();
export type ClaudeCliConfig = z.infer<typeof claudeCliConfigSchema>;
export type ClaudeCliSdk = { listSessions: typeof listSessions; getSessionInfo: typeof getSessionInfo; getSessionMessages: typeof getSessionMessages };
const capabilities = { inspectLoadedSessions: false, sendMessage: false, steer: false, interrupt: false, approve: false };
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const pageSize = 50;
const notice = "只读预览，发送功能下一版提供";
type Located = { info: SDKSessionInfo; directory: string; sdkDirectory: string };
type Listener = { snapshot: (value: AgentSessionSnapshot) => void; disconnect: () => void };
type Entry = { id: string; listeners: Set<Listener>; timer?: ReturnType<typeof setTimeout>; pending?: Promise<void>; fingerprint?: string; snapshot?: AgentSessionSnapshot };
type Cursor = { kind: "list"; search: string; time: number; id: string } | { kind: "history"; id: string; before: number; anchor: string };
const inside = (directory: string, root: string) => { const relative = path.relative(root, directory); return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)); };

/** The injected SDK port exposes no query, process or mutation API. */
export class ClaudeCliAdapter implements AgentAdapter, SessionAdapter {
  readonly sessionApi: SessionAdapter = this;
  private readonly secret = randomBytes(32);
  private readonly controlToken = randomUUID();
  private readonly entries = new Map<string, Entry>();
  private stopped = false;
  private readonly config: ClaudeCliConfig;
  constructor(config: ClaudeCliConfig | undefined, private readonly sdk: ClaudeCliSdk,
    private readonly registered: (id: string) => Promise<boolean> = async () => false, private readonly pollMs = 3000) {
    this.config = claudeCliConfigSchema.parse(config ?? { directories: [] });
  }
  snapshot(): AgentStatus {
    const enabled = this.config.directories.length > 0;
    return { id: "claude-cli", label: "Claude CLI", transport: "claude-cli-local-records", sessionApi: 1, enabled,
      state: enabled ? "connected" : "unprobed", usesAccessibility: false, sameDesktopThreadVerified: false,
      capabilities: { ...capabilities }, loadedSessions: null, checkedAt: null, errorCode: enabled ? null : "CLAUDE_CLI_DISABLED" };
  }
  async probe() { await this.roots(); return this.snapshot(); }
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
    this.running();
    let entry = this.entries.get(id);
    if (!entry) { entry = { id, listeners: new Set() }; this.entries.set(id, entry); }
    const listener = { snapshot: onSnapshot, disconnect: onDisconnect };
    entry.listeners.add(listener);
    try {
      if (entry.snapshot) onSnapshot(structuredClone(entry.snapshot));
      await this.refresh(entry);
    } catch (error) { this.drop(entry); throw error; }
    return () => { entry.listeners.delete(listener); if (!entry.listeners.size) this.drop(entry); };
  }
  async sendMessage(): Promise<AgentDelivery> { throw agentError("CLAUDE_CLI_READ_ONLY", 409); }
  async interruptSession(): Promise<AgentDelivery> { throw agentError("CLAUDE_CLI_READ_ONLY", 409); }
  async respondQuestion(): Promise<AgentDelivery> { throw agentError("CLAUDE_CLI_READ_ONLY", 409); }
  async respondPermission(): Promise<AgentDelivery> { throw agentError("CLAUDE_CLI_READ_ONLY", 409); }
  async stop() { this.stopped = true; for (const entry of this.entries.values()) this.drop(entry); }
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
    const fingerprint = JSON.stringify([located.directory, located.info.lastModified, located.info.fileSize, session]);
    if (!this.current(entry) || fingerprint === entry.fingerprint) return;
    const rows = await this.messages(located), page = this.page(rows, rows.length, entry.id);
    if (!this.current(entry)) return;
    const snapshot: AgentSessionSnapshot = { agentId: "claude-cli", session, connected: true, updatedAt: session.updatedAt,
      status: "idle", activity: "outputting", messages: page.messages, historyCursor: page.cursor, partialText: true, readOnly: notice,
      questions: [], permissions: [], control: { token: this.controlToken, canSend: false, canSteer: false, canInterrupt: false }, submission: null };
    entry.fingerprint = fingerprint; entry.snapshot = snapshot;
    for (const listener of entry.listeners) { try { listener.snapshot(structuredClone(snapshot)); } catch { entry.listeners.delete(listener); } }
    if (!entry.listeners.size) this.drop(entry);
  }
  private drop(entry: Entry) {
    if (this.entries.get(entry.id) !== entry) return;
    this.entries.delete(entry.id); clearTimeout(entry.timer);
    for (const listener of entry.listeners) { try { listener.disconnect(); } catch { /* SSE owner may already be closed. */ } }
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
