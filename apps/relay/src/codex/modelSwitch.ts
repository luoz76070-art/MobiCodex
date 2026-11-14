import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

/**
 * F6: when a channel's quota runs out, continue the work on another channel the user picks.
 * Codex cannot switch a thread in place without first calling the exhausted model (its handoff
 * compaction), so the work continues in a new thread that is given the old thread's visible history.
 */
export type ModelChoice = { slug: string; displayName: string; channel: string; channelLabel: string; efforts: string[]; defaultEffort: string | null };
export type SwitchOptions = { model: string | null; channel: string | null; channelLabel: string | null; resetAt: string | null; alternatives: ModelChoice[] };
export const continuationLimits = { items: 400, bytes: 1_500_000 };

const defaultChannel = "default";
export function channelOf(slug: string) { return /^ccs-[^/]+\//.test(slug) ? slug.slice(0, slug.indexOf("/")) : defaultChannel; }
const baseModel = (slug: string) => slug.slice(slug.indexOf("/") + 1);
function labelOf(displayName: string, channel: string) {
  const match = displayName.match(/[（(]([^（()）]+)[)）]\s*$/u);
  return match ? match[1].trim() : channel === defaultChannel ? "默认渠道" : channel.replace(/^ccs-/, "");
}

/** model/list from the gateway's app-server, normalised; hidden models are left out. */
export function modelChoices(list: unknown): ModelChoice[] {
  const data = list && typeof list === "object" ? (list as { data?: unknown; models?: unknown }).data ?? (list as { models?: unknown }).models : null;
  if (!Array.isArray(data)) return [];
  const choices: ModelChoice[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const slug = typeof item.model === "string" ? item.model : typeof item.id === "string" ? item.id : typeof item.slug === "string" ? item.slug : null;
    if (!slug || item.hidden === true) continue;
    const displayName = typeof item.displayName === "string" && item.displayName ? item.displayName : slug;
    const levels = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [];
    const efforts = levels.map(level => typeof level === "string" ? level : level && typeof level === "object" ? (level as { reasoningEffort?: unknown }).reasoningEffort : null)
      .filter((value): value is string => typeof value === "string");
    const channel = channelOf(slug);
    // Image models cannot take over coding work.
    if (/image/i.test(slug)) continue;
    choices.push({ slug, displayName, channel, channelLabel: labelOf(displayName, channel), efforts,
      defaultEffort: typeof item.defaultReasoningEffort === "string" ? item.defaultReasoningEffort : null });
  }
  return choices;
}

/** Everything outside the exhausted channel; the same model on another channel comes first. */
export function alternatives(choices: ModelChoice[], failedModel: string | null): ModelChoice[] {
  const channel = failedModel ? channelOf(failedModel) : null, base = failedModel ? baseModel(failedModel) : null;
  return choices.filter(choice => choice.channel !== channel)
    .map((choice, index) => ({ choice, rank: baseModel(choice.slug) === base ? 0 : 1, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index).map(entry => entry.choice);
}

/** A sensible effort for a continuation: medium when offered, else the model's default. */
export function continuationEffort(choice: ModelChoice, requested?: string | null) {
  if (requested && (!choice.efforts.length || choice.efforts.includes(requested))) return requested;
  if (choice.efforts.includes("medium")) return "medium";
  return choice.defaultEffort ?? choice.efforts[0] ?? null;
}

const contextOnly = /^\s*(<environment_context>|<user_instructions>|# AGENTS\.md|<permissions instructions>|<collaboration_mode>|<model_switch>|<turn_aborted>)/;
/**
 * The old thread's model-visible history as Responses API items: messages and tool calls with
 * their outputs. Encrypted reasoning belongs to the old account and is dropped, as are developer
 * and environment blocks the new thread writes for itself. Long threads keep their latest part.
 */
export async function readContinuation(rolloutPath: string) {
  const items: unknown[] = [];
  let model: string | null = null, effort: string | null = null;
  const lines = readline.createInterface({ input: createReadStream(rolloutPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; payload?: Record<string, unknown> };
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry.payload;
    if (!payload || typeof payload !== "object") continue;
    if (entry.type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model;
      if (typeof payload.effort === "string") effort = payload.effort;
      continue;
    }
    if (entry.type !== "response_item" || payload.type === "reasoning") continue;
    if (payload.type === "message") {
      if (payload.role === "developer" || payload.role === "system") continue;
      const content = Array.isArray(payload.content) ? payload.content as { text?: unknown }[] : [];
      if (content.length && content.every(part => contextOnly.test(typeof part.text === "string" ? part.text : ""))) continue;
    }
    items.push(payload);
  }
  let start = Math.max(0, items.length - continuationLimits.items), bytes = 0;
  for (let index = items.length - 1; index >= start; index--) {
    bytes += JSON.stringify(items[index]).length;
    if (bytes > continuationLimits.bytes) { start = index + 1; break; }
  }
  // Never begin with a tool output whose call was cut off.
  while (start < items.length && /_output$/.test(String((items[start] as { type?: unknown }).type))) start++;
  return { items: items.slice(start), omitted: start, model, effort };
}

export function continuationPrompt(fromLabel: string | null, omitted: number) {
  return [
    `（自动续接）上一轮${fromLabel ? `在「${fromLabel}」` : ""}因为额度用完中断了，现在换到这个模型接着做。`,
    omitted ? "前面较早的部分对话已省略，下面带过来的是最近的对话和工具记录。" : "前面的对话和工具记录都已经带过来。",
    "请先看一下当前进度（必要时检查工作区里的实际改动），然后接着完成没做完的部分。",
  ].join("\n");
}

/**
 * Best effort, macOS with CC Switch only: when the exhausted channel goes through CC Switch's proxy,
 * its log keeps the upstream reset time. Anything else simply has no reset time.
 */
export function quotaResetAt(model: string | null, home = os.homedir()): Promise<string | null> {
  const db = path.join(home, ".cc-switch", "cc-switch.db");
  if (!model || process.platform !== "darwin" || !existsSync(db) || !/^[\w./-]+$/.test(model)) return Promise.resolve(null);
  const sql = `select error_message from proxy_request_logs where status_code = 429 and request_model = '${model}' and created_at >= strftime('%s','now','-12 hours') order by created_at desc limit 1;`;
  return new Promise(resolve => {
    execFile("/usr/bin/sqlite3", ["-readonly", db, sql], { timeout: 2000 }, (error, stdout) => {
      const match = !error && /"reset_at"\s*:\s*"([^"]+)"/.exec(stdout);
      const time = match ? Date.parse(match[1]) : NaN;
      resolve(Number.isFinite(time) && time > Date.now() ? new Date(time).toISOString() : null);
    });
  });
}
