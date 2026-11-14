import { execFile } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

/**
 * F6: when a channel's quota runs out, the same thread continues on another channel the user picks.
 * Codex only calls the previous model on a switch when the two models' comp_hash differ, or when the
 * new window is smaller and already full (it compacts with the previous model first). Within one
 * comp_hash a switch is a plain model change, so only those models are offered when a channel is out.
 */
export type ModelChoice = {
  slug: string; displayName: string; channel: string; channelLabel: string; efforts: string[]; defaultEffort: string | null;
  compHash: string | null; contextWindow: number | null; compactLimit: number | null;
};
export type SwitchOptions = {
  model: string | null; channel: string | null; channelLabel: string | null; resetAt: string | null;
  alternatives: ModelChoice[]; blocked: number;
};
/** The thread's settings as of its last turn, from the rollout. */
export type ThreadModelState = {
  model: string | null; effort: string | null; approvalPolicy: unknown; sandboxPolicy: Record<string, unknown> | null; contextTokens: number | null;
};
type CatalogEntry = { compHash: string | null; contextWindow: number | null; compactLimit: number | null };

const defaultChannel = "default";
export function channelOf(slug: string) { return /^ccs-[^/]+\//.test(slug) ? slug.slice(0, slug.indexOf("/")) : defaultChannel; }
const baseModel = (slug: string) => slug.slice(slug.indexOf("/") + 1);
function labelOf(displayName: string, channel: string) {
  const match = displayName.match(/[（(]([^（()）]+)[)）]\s*$/u);
  return match ? match[1].trim() : channel === defaultChannel ? "默认渠道" : channel.replace(/^ccs-/, "");
}
const numberOr = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

/** comp_hash and window per model from the catalog Codex is configured with (config.toml model_catalog_json). */
export function readCatalog(codexHome: string): Map<string, CatalogEntry> {
  const entries = new Map<string, CatalogEntry>();
  try {
    const config = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const file = /^\s*model_catalog_json\s*=\s*"([^"]+)"/m.exec(config)?.[1];
    if (!file) return entries;
    const catalog = JSON.parse(readFileSync(path.isAbsolute(file) ? file : path.join(codexHome, file), "utf8")) as { models?: unknown };
    for (const model of Array.isArray(catalog.models) ? catalog.models : []) {
      const item = model as Record<string, unknown>;
      if (typeof item.slug !== "string") continue;
      entries.set(item.slug, { compHash: typeof item.comp_hash === "string" ? item.comp_hash : null,
        contextWindow: numberOr(item.context_window), compactLimit: numberOr(item.auto_compact_token_limit) });
    }
  } catch { /* No catalog: nothing is known, and Codex then never compacts for a hash change either. */ }
  return entries;
}

/** model/list from the gateway's app-server, normalised; hidden and image models are left out. */
export function modelChoices(list: unknown, catalog: Map<string, CatalogEntry> = new Map()): ModelChoice[] {
  const data = list && typeof list === "object" ? (list as { data?: unknown; models?: unknown }).data ?? (list as { models?: unknown }).models : null;
  if (!Array.isArray(data)) return [];
  const choices: ModelChoice[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const slug = typeof item.model === "string" ? item.model : typeof item.id === "string" ? item.id : typeof item.slug === "string" ? item.slug : null;
    if (!slug || item.hidden === true || /image/i.test(slug)) continue;
    const displayName = typeof item.displayName === "string" && item.displayName ? item.displayName : slug;
    const levels = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [];
    const efforts = levels.map(level => typeof level === "string" ? level : level && typeof level === "object" ? (level as { reasoningEffort?: unknown }).reasoningEffort : null)
      .filter((value): value is string => typeof value === "string");
    const channel = channelOf(slug), known = catalog.get(slug);
    choices.push({ slug, displayName, channel, channelLabel: labelOf(displayName, channel), efforts,
      defaultEffort: typeof item.defaultReasoningEffort === "string" ? item.defaultReasoningEffort : null,
      compHash: known?.compHash ?? null, contextWindow: known?.contextWindow ?? null, compactLimit: known?.compactLimit ?? null });
  }
  return choices;
}

/** Would switching from `from` to `to` make Codex call `from` first (which fails when its quota is gone)? */
export function needsPreviousModel(from: Pick<ModelChoice, "compHash" | "contextWindow"> | undefined, to: ModelChoice, contextTokens: number | null) {
  if (!from) return false;
  if (from.compHash && to.compHash && from.compHash !== to.compHash) return true;
  const shrinks = from.contextWindow !== null && to.contextWindow !== null && from.contextWindow > to.contextWindow;
  return shrinks && contextTokens !== null && (contextTokens > (to.compactLimit ?? Infinity) || contextTokens >= (to.contextWindow ?? Infinity));
}

/** Other channels that can take over without the exhausted model; the same model elsewhere comes first. */
export function alternatives(choices: ModelChoice[], failedModel: string | null, contextTokens: number | null = null) {
  const channel = failedModel ? channelOf(failedModel) : null, base = failedModel ? baseModel(failedModel) : null;
  const from = failedModel ? choices.find(choice => choice.slug === failedModel) : undefined;
  const others = choices.filter(choice => choice.channel !== channel);
  const usable = others.filter(choice => !needsPreviousModel(from, choice, contextTokens));
  const ranked = usable.map((choice, index) => ({ choice, rank: baseModel(choice.slug) === base ? 0 : 1, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index).map(entry => entry.choice);
  return { usable: ranked, blocked: others.length - usable.length };
}

/** Keep the thread's reasoning effort when the new model has it; otherwise medium, else the model's default. */
export function switchEffort(choice: ModelChoice, current?: string | null) {
  if (current && (!choice.efforts.length || choice.efforts.includes(current))) return current;
  if (choice.efforts.includes("medium")) return "medium";
  return choice.defaultEffort ?? choice.efforts[0] ?? null;
}

/** The last turn's model, effort and permissions, plus how full the context was. */
export async function threadModelState(rolloutPath: string): Promise<ThreadModelState> {
  const state: ThreadModelState = { model: null, effort: null, approvalPolicy: null, sandboxPolicy: null, contextTokens: null };
  const lines = readline.createInterface({ input: createReadStream(rolloutPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
    let entry: { type?: unknown; payload?: Record<string, unknown> };
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry.payload;
    if (!payload) continue;
    if (entry.type === "turn_context") {
      if (typeof payload.model === "string") state.model = payload.model;
      state.effort = typeof payload.effort === "string" ? payload.effort : state.effort;
      if (payload.approval_policy !== undefined) state.approvalPolicy = payload.approval_policy;
      if (payload.sandbox_policy && typeof payload.sandbox_policy === "object") state.sandboxPolicy = payload.sandbox_policy as Record<string, unknown>;
    } else if (entry.type === "event_msg" && payload.type === "token_count") {
      const usage = (payload.info as { last_token_usage?: { input_tokens?: unknown } } | null)?.last_token_usage;
      if (typeof usage?.input_tokens === "number") state.contextTokens = usage.input_tokens;
    }
  }
  return state;
}

/** A rollout sandbox_policy as the app-server's SandboxPolicy (camelCase), so a switch keeps the thread's access. */
export function sandboxPolicyForTurn(policy: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!policy) return null;
  const network = policy.network_access === true;
  if (policy.type === "danger-full-access") return { type: "dangerFullAccess" };
  if (policy.type === "read-only") return { type: "readOnly", networkAccess: network };
  if (policy.type === "workspace-write") return {
    type: "workspaceWrite", writableRoots: Array.isArray(policy.writable_roots) ? policy.writable_roots.filter(root => typeof root === "string") : [],
    networkAccess: network, excludeTmpdirEnvVar: policy.exclude_tmpdir_env_var === true, excludeSlashTmp: policy.exclude_slash_tmp === true,
  };
  return null;
}

/** The approval policy as the app-server accepts it; anything unrecognised asks the user. */
export function approvalPolicyForTurn(policy: unknown): unknown {
  if (policy === "never" || policy === "on-request" || policy === "untrusted") return policy;
  if (policy && typeof policy === "object" && "granular" in policy) return policy;
  return "on-request";
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
