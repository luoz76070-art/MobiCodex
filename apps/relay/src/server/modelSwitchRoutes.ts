import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AttentionHub } from "../attention/attentionHub.js";
import type { LiveTurnController } from "../codex/liveTurnController.js";
import { alternatives, channelOf, continuationEffort, continuationPrompt, modelChoices, quotaResetAt, readContinuation, type ModelChoice, type SwitchOptions } from "../codex/modelSwitch.js";
import type { CodexStore } from "../store/codexStore.js";
import type { SubmissionRegistry } from "./submissions.js";

const switchError = (code: string, statusCode: number) => Object.assign(new Error(code), { statusCode, code });

/** F6: offer the other channels when a Codex thread ran out of quota, and continue there on request. */
export function createModelSwitchRoutes(context: {
  liveTurns: Pick<LiveTurnController, "listModels" | "startTurn">; store: Pick<CodexStore, "getThreadSummary">;
  submissions: SubmissionRegistry; owners: WeakMap<FastifyRequest, string>; attention: Pick<AttentionHub, "watch">;
  resetAt?: (model: string | null) => Promise<string | null>;
}) {
  const { liveTurns, store, submissions, owners, attention, resetAt = quotaResetAt } = context;
  let cached: { at: number; choices: ModelChoice[] } | null = null;
  async function choices() {
    if (cached && Date.now() - cached.at < 60_000) return cached.choices;
    const list = modelChoices(await liveTurns.listModels());
    cached = { at: Date.now(), choices: list };
    return list;
  }
  async function source(threadId: string) {
    const thread = await store.getThreadSummary(threadId);
    if (!thread?.rolloutPath) throw switchError("codex_thread_not_found", 404);
    return { thread, rolloutPath: thread.rolloutPath };
  }
  const params = z.object({ id: z.string().min(1).max(200) });
  return {
    register(app: FastifyInstance) {
      app.get("/api/codex/models", async () => ({ models: await choices() }));
      app.get("/api/codex/threads/:id/switch-options", async (request): Promise<SwitchOptions> => {
        const { rolloutPath } = await source(params.parse(request.params).id);
        const [all, history] = await Promise.all([choices(), readContinuation(rolloutPath)]);
        const current = history.model ? all.find(choice => choice.slug === history.model) : undefined;
        return { model: history.model, channel: history.model ? channelOf(history.model) : null, channelLabel: current?.channelLabel ?? (history.model ? channelOf(history.model) : null),
          resetAt: await resetAt(history.model).catch(() => null), alternatives: alternatives(all, history.model) };
      });
      app.post("/api/codex/threads/:id/continue", { bodyLimit: 64 * 1024 }, async request => {
        const { id } = params.parse(request.params);
        const body = z.object({
          model: z.string().min(1).max(200), effort: z.string().max(20).nullable().optional(), message: z.string().max(20_000).optional(),
          clientMessageId: z.string().uuid(), approvalPolicy: z.enum(["never", "on-request"]).optional(),
          sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
        }).strict().parse(request.body);
        const owner = owners.get(request)!;
        return submissions.execute(body.clientMessageId, { route: "codex-continue", threadId: id, owner, ...body }, async () => {
          const all = await choices(), choice = all.find(item => item.slug === body.model);
          if (!choice) throw switchError("codex_model_unknown", 400);
          const { thread, rolloutPath } = await source(id);
          const history = await readContinuation(rolloutPath);
          const from = history.model ? all.find(item => item.slug === history.model)?.channelLabel ?? channelOf(history.model) : null;
          const turn = await liveTurns.startTurn({
            message: body.message?.trim() || continuationPrompt(from, history.omitted), cwd: thread.cwd,
            model: choice.slug, effort: continuationEffort(choice, body.effort), inject: history.items,
            name: `${thread.threadName || "Codex 任务"} · 换到${choice.channelLabel}`, approvalPolicy: body.approvalPolicy, sandbox: body.sandbox,
          });
          attention.watch(owner, { source: "live", threadId: turn.threadId, turnId: turn.turnId });
          return { ...turn, continuedFrom: id, model: choice.slug, channelLabel: choice.channelLabel, carried: history.items.length, omitted: history.omitted };
        });
      });
    },
  };
}
