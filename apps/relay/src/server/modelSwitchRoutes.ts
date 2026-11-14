import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LiveTurnController } from "../codex/liveTurnController.js";
import { alternatives, approvalPolicyForTurn, channelOf, modelChoices, quotaResetAt, readCatalog, sandboxPolicyForTurn, switchEffort, threadModelState, type ModelChoice, type SwitchOptions } from "../codex/modelSwitch.js";
import type { CodexStore } from "../store/codexStore.js";

const switchError = (code: string, statusCode: number) => Object.assign(new Error(code), { statusCode, code });
type LiveSandbox = "read-only" | "workspace-write" | "danger-full-access";

/** Settings for the turn that moves a thread onto another model; everything but the model stays as it was. */
export type PreparedSwitch = {
  model: string; effort: string | null; channelLabel: string;
  /** Desktop follower start-turn: explicit settings, because inherited settings ignore model and effort. */
  desktop: { model: string; effort: string | null; sandboxPolicy: Record<string, unknown> | null; approvalPolicy: unknown };
  /** Gateway app-server turn. */
  live: { sandbox?: LiveSandbox; approvalPolicy?: "never" | "on-request" };
};

/**
 * F6: offer the other channels when a Codex thread ran out of quota. The switch itself is an ordinary
 * send on the same thread (desktop or gateway route) that names the model; `prepare` fills in the rest.
 */
export function createModelSwitchRoutes(context: {
  liveTurns: Pick<LiveTurnController, "listModels">; store: Pick<CodexStore, "getThreadSummary">; codexHome: string;
  resetAt?: (model: string | null) => Promise<string | null>;
}) {
  const { liveTurns, store, codexHome, resetAt = quotaResetAt } = context;
  let cached: { at: number; choices: ModelChoice[] } | null = null;
  async function choices() {
    if (cached && Date.now() - cached.at < 60_000) return cached.choices;
    const list = modelChoices(await liveTurns.listModels(), readCatalog(codexHome));
    cached = { at: Date.now(), choices: list };
    return list;
  }
  async function threadState(threadId: string) {
    const thread = await store.getThreadSummary(threadId);
    if (!thread?.rolloutPath) throw switchError("codex_thread_not_found", 404);
    return threadModelState(thread.rolloutPath);
  }
  const label = (all: ModelChoice[], model: string | null) => model ? all.find(choice => choice.slug === model)?.channelLabel ?? channelOf(model) : null;

  async function prepare(threadId: string, model: string): Promise<PreparedSwitch> {
    const all = await choices(), choice = all.find(item => item.slug === model);
    if (!choice) throw switchError("codex_model_unknown", 400);
    const state = await threadState(threadId);
    const effort = switchEffort(choice, state.effort);
    const sandboxPolicy = sandboxPolicyForTurn(state.sandboxPolicy);
    const liveSandbox = typeof state.sandboxPolicy?.type === "string" && ["read-only", "workspace-write", "danger-full-access"].includes(state.sandboxPolicy.type)
      ? state.sandboxPolicy.type as LiveSandbox : undefined;
    const approval = approvalPolicyForTurn(state.approvalPolicy);
    return { model, effort, channelLabel: choice.channelLabel,
      desktop: { model, effort, sandboxPolicy, approvalPolicy: approval },
      live: { sandbox: liveSandbox, approvalPolicy: approval === "never" ? "never" : "on-request" } };
  }

  const params = z.object({ id: z.string().min(1).max(200) });
  return {
    prepare,
    register(app: FastifyInstance) {
      app.get("/api/codex/models", async () => ({ models: await choices() }));
      app.get("/api/codex/threads/:id/switch-options", async (request): Promise<SwitchOptions> => {
        const state = await threadState(params.parse(request.params).id);
        const all = await choices(), { usable, blocked } = alternatives(all, state.model, state.contextTokens);
        return { model: state.model, channel: state.model ? channelOf(state.model) : null, channelLabel: label(all, state.model),
          resetAt: await resetAt(state.model).catch(() => null), alternatives: usable, blocked };
      });
    },
  };
}
