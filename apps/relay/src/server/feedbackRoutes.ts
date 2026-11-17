import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DeviceRegistry } from './devices.js';
import { z } from 'zod';
import { FeedbackStore, feedbackError, feedbackImageBytes } from '../feedback/store.js';

export function registerFeedbackRoutes(app: FastifyInstance, options: {
  dataDirectory: string; owners: WeakMap<FastifyRequest, string>; devices: DeviceRegistry;
}) {
  const store = new FeedbackStore(options.dataDirectory);
  const guard = (request: FastifyRequest) => () => {
    if (!options.devices.has(options.owners.get(request) ?? '')) throw feedbackError('unauthorized', 401);
  };
  app.addHook('onClose', () => store.drain());
  app.register(async routes => {
    routes.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return reply.code(400).send({ error: 'feedback_invalid_request' });
      const value = error as { message?: string; statusCode?: number };
      const known = value.message && /^feedback_[a-z_]+$/.test(value.message);
      return reply.code(value.statusCode === 413 ? 413 : known || value.statusCode === 401 ? value.statusCode ?? 503 : 503)
        .send({ error: known ? value.message : value.statusCode === 401 ? 'unauthorized' : 'feedback_unavailable' });
    });
    routes.post('/api/feedback', { bodyLimit: 4 * Math.ceil(feedbackImageBytes / 3) + 32 * 1024 }, async request =>
      store.save(request.body, options.owners.get(request)!, guard(request)));
    routes.get('/api/feedback', async request => ({ items: await store.list(options.owners.get(request)!, guard(request)) }));
  });
}
