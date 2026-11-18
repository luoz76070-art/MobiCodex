import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DeviceRegistry } from './devices.js';
import { z } from 'zod';
import { FeedbackStore, feedbackError, feedbackImageBytes, feedbackPreviewSchema } from '../feedback/store.js';
import { createFeedbackRedactor, createFeedbackSubmitter, ghIssueClient, renderFeedbackIssue, type FeedbackGithubConfig, type FeedbackIssueClient } from '../feedback/github.js';

export function registerFeedbackRoutes(app: FastifyInstance, options: {
  dataDirectory: string; owners: WeakMap<FastifyRequest, string>; devices: DeviceRegistry;
  /** GitHub repos a phone may file to; none keeps every feedback in this inbox. */
  github?: FeedbackGithubConfig; hide?: Array<string | undefined>; issueClient?: FeedbackIssueClient; submitWaitMs?: number;
}) {
  const store = new FeedbackStore(options.dataDirectory);
  const targets = new Map((options.github?.repos ?? []).map(target => [target.id, target]));
  const redact = createFeedbackRedactor({ hide: options.hide });
  const submitter = options.github ? createFeedbackSubmitter({ store, targets, redact, client: options.issueClient ?? ghIssueClient(options.github) }) : undefined;
  submitter?.start();
  const guard = (request: FastifyRequest) => () => {
    if (!options.devices.has(options.owners.get(request) ?? '')) throw feedbackError('unauthorized', 401);
  };
  const target = (id: unknown) => typeof id === 'string' ? targets.get(id) : undefined;
  app.addHook('onClose', async () => { await submitter?.stop(); await store.drain(); });
  app.register(async routes => {
    routes.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return reply.code(400).send({ error: 'feedback_invalid_request' });
      const value = error as { message?: string; statusCode?: number };
      const known = value.message && /^feedback_[a-z_]+$/.test(value.message);
      return reply.code(value.statusCode === 413 ? 413 : known || value.statusCode === 401 ? value.statusCode ?? 503 : 503)
        .send({ error: known ? value.message : value.statusCode === 401 ? 'unauthorized' : 'feedback_unavailable' });
    });
    routes.post('/api/feedback', { bodyLimit: 4 * Math.ceil(feedbackImageBytes / 3) + 32 * 1024 }, async request => {
      const check = guard(request), chosen = (request.body as { target?: unknown } | null)?.target;
      if (chosen !== undefined && !target(chosen)) { check(); throw feedbackError('feedback_unknown_target', 400); }
      const receipt = await store.save(request.body, options.owners.get(request)!, check);
      if (!receipt.target || !submitter) return receipt;
      // Usually done within seconds, so the phone shows the issue number straight away; otherwise it keeps retrying here.
      return await submitter.settle(receipt.id, options.submitWaitMs ?? 15_000) ?? receipt;
    });
    routes.get('/api/feedback', async request => ({ items: await store.list(options.owners.get(request)!, guard(request)) }));
    routes.get('/api/feedback/targets', async request => {
      guard(request)();
      return { targets: [...targets.values()].map(({ id, label, repo, public: open }) => ({ id, label, repo, public: open })) };
    });
    routes.post('/api/feedback/preview', async request => {
      guard(request)();
      const input = feedbackPreviewSchema.parse(request.body), chosen = target(input.target);
      if (!chosen) throw feedbackError('feedback_unknown_target', 400);
      return { target: { id: chosen.id, label: chosen.label, repo: chosen.repo, public: chosen.public }, ...renderFeedbackIssue(input, redact) };
    });
  });
}
