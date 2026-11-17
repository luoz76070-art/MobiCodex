import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { agentError, type AgentSessionSnapshot } from "./sessions.js";

type Options = Parameters<CanUseTool>[2];
type Pending = {
  kind: "permission" | "question"; input: Record<string, unknown>; suggestions: PermissionUpdate[]; rejectOnly: boolean;
  finish: (result: PermissionResult) => void;
};
const questionsSchema = z.array(z.object({
  question: z.string().min(1).max(10_000), header: z.string().max(200).optional(), multiSelect: z.boolean().optional(),
  options: z.array(z.object({ label: z.string().min(1).max(10_000), description: z.string().max(10_000).optional(), preview: z.string().optional() })).max(100).default([]),
})).min(1).max(20);
const deny = (message: string): PermissionResult => ({ behavior: "deny", message });
const defaultReason = "用户在手机上拒绝了这个操作";
const visibleLimit = 20_000;
// File tools put the path first, so a cut-off body still shows where it writes. Any other input past the
// limit (e.g. a long Bash command) could hide its tail, so the phone may only reject it.
const fileTools = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Pending SDK callbacks belong to one owned Query. Nothing is allowed without a phone response. */
export class ClaudeCliInteractions {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly snapshot: AgentSessionSnapshot, private readonly directory: string,
    private readonly changed: () => void, private readonly timeout: () => void, private readonly waitMs = 30 * 60_000) {}

  request(name: string, rawInput: Record<string, unknown>, options: Options): Promise<PermissionResult> {
    if (options.signal.aborted) return Promise.resolve(deny("操作已取消"));
    if (this.pending.size >= 32) return Promise.resolve(deny("手机待处理请求已满，请等待用户处理。"));
    const input = structuredClone(rawInput), id = randomUUID();
    const suggestions = options.suppressAlwaysAllowRule ? [] : structuredClone(options.suggestions ?? []).filter(item =>
      item.destination === "localSettings" && !(item.type === "setMode" && !["default", "plan", "acceptEdits"].includes(item.mode)));
    const kind = name === "AskUserQuestion" ? "question" : "permission";
    let rejectOnly = false;
    if (kind === "question") {
      const parsed = questionsSchema.safeParse(input.questions);
      if (!parsed.success || new Set(parsed.data.map(q => q.question)).size !== parsed.data.length) return Promise.resolve(deny("无法在手机上显示这个提问，请重新提问。"));
      this.snapshot.questions.push({ id, status: "pending", questions: parsed.data.map(q => ({
        question: q.question, header: q.header ?? "", multiple: q.multiSelect ?? false, custom: true,
        options: q.options.map(option => ({ label: option.label, description: option.description ?? "", ...(option.preview !== undefined ? { preview: option.preview.slice(0, 20_000) + (option.preview.length > 20_000 ? "\n已截断" : "") } : {}) })),
      })) });
    } else {
      const fields = name === "Bash" ? ["command"] : name === "Write" ? ["file_path", "content"] : name === "Edit" ? ["file_path", "old_string", "new_string"] : [];
      const full = JSON.stringify({ ...Object.fromEntries(fields.filter(key => key in input).map(key => [key, input[key]])), ...input }, null, 2);
      const rules = JSON.stringify(suggestions, null, 2), truncated = full.length > visibleLimit;
      rejectOnly = truncated && !fileTools.has(name);
      const saving = suggestions.length > 0 && !rejectOnly;
      this.snapshot.permissions.push({ id, status: "pending", action: name.slice(0, 200), resources: [], save: saving ? [rules.slice(0, visibleLimit) + (rules.length > visibleLimit ? "\n已截断" : "")] : [],
        detail: full.slice(0, visibleLimit), inputTruncated: truncated, workingDirectory: this.directory,
        allowReason: true, localSettings: saving, decisions: rejectOnly ? ["reject"] : saving ? ["once", "always", "reject"] : ["once", "reject"],
        unavailableReason: rejectOnly ? "输入超过手机能显示的长度，看不到全部内容，不能在手机上允许。请拒绝，或在电脑上处理。" : null });
    }
    // Keep interaction payloads below the shared SSE budget, including UTF-8 previews.
    if (Buffer.byteLength(JSON.stringify([this.snapshot.questions, this.snapshot.permissions])) > 512_000) {
      this.snapshot.questions = this.snapshot.questions.filter(item => item.id !== id);
      this.snapshot.permissions = this.snapshot.permissions.filter(item => item.id !== id);
      return Promise.resolve(deny("请求内容超过手机显示上限，请缩小输入后重试。"));
    }
    return new Promise(resolve => {
      const cancel = () => finish(deny("操作已取消"));
      const timer = setTimeout(() => {
        finish({ behavior: "deny", message: "等待手机答复已超过 30 分钟，本轮已中断。", interrupt: true });
        this.timeout();
      }, this.waitMs);
      timer.unref();
      const finish = (result: PermissionResult) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); options.signal.removeEventListener("abort", cancel);
        this.snapshot.questions = this.snapshot.questions.filter(item => item.id !== id);
        this.snapshot.permissions = this.snapshot.permissions.filter(item => item.id !== id);
        this.changed(); resolve(result);
      };
      this.pending.set(id, { kind, input, suggestions, rejectOnly, finish });
      options.signal.addEventListener("abort", cancel, { once: true });
      if (options.signal.aborted) cancel(); else this.changed();
    });
  }
  permission(id: string, decision: "once" | "always" | "reject", reason?: string) {
    const pending = this.get(id, "permission");
    if (!["once", "always", "reject"].includes(decision) || decision === "always" && !pending.suggestions.length
      || pending.rejectOnly && decision !== "reject") throw agentError("CLAUDE_CLI_PERMISSION_INVALID", 400);
    pending.finish(decision === "reject" ? deny(reason?.trim() || defaultReason) : {
      behavior: "allow", updatedInput: pending.input, ...(decision === "always" ? { updatedPermissions: pending.suggestions } : {}),
    });
  }
  question(id: string, answers: string[][]) {
    const pending = this.get(id, "question");
    const questions = questionsSchema.parse(pending.input.questions);
    if (answers.length !== questions.length || answers.some((values, i) => !Array.isArray(values) || !values.length || values.length > 100
      || !questions[i]!.multiSelect && values.length !== 1 || values.some(value => typeof value !== "string" || !value.trim() || value.length > 10_000))) throw agentError("CLAUDE_CLI_ANSWER_INVALID", 400);
    pending.finish({ behavior: "allow", updatedInput: { ...pending.input, answers: Object.fromEntries(questions.map((question, i) => [question.question, answers[i]!.join(", ")])) } });
  }
  revoke(message = "本轮已结束，请求已撤回") { for (const pending of [...this.pending.values()]) pending.finish(deny(message)); }
  private get(id: string, kind: Pending["kind"]) {
    const pending = this.pending.get(id);
    if (!pending || pending.kind !== kind) throw agentError("CLAUDE_CLI_REQUEST_HANDLED", 409);
    return pending;
  }
}
