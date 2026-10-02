import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { randomUUID } from 'node:crypto';
import { sha256, equal } from './crypto.js';
import { fail, installErrorHandler } from './errors.js';
import { bodySchemas, uuid } from './validation.js';
import { idempotent } from './idempotency.js';
import { UserService } from './user-service.js';
import { createWebhookHandler } from './webhook.js';
import { openApiDocument } from './openapi.js';

export async function createApp(deps) {
  const { config, pool, store } = deps;
  const app = Fastify({ logger: deps.logger ?? { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers["x-terminal-token"]', 'req.body'] },
    genReqId: () => randomUUID(), logController: new LogController({ disableRequestLogging: true }), bodyLimit: 1024 * 1024,
    requestTimeout: 30000, trustProxy: false });
  await app.register(helmet);
  await app.register(cors, { origin: config.corsOrigins, credentials: false, methods: ['GET','POST','PUT','PATCH','DELETE'],
    allowedHeaders: ['Content-Type','Authorization','X-Terminal-Id','X-Terminal-Token','Idempotency-Key'],
    exposedHeaders: ['X-Request-Id','Idempotency-Replayed','Retry-After'] });
  installErrorHandler(app);
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').header('X-Request-Id', request.id);
    return payload;
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/openapi.json', async () => openApiDocument());
  app.get('/health/ready', async (request, reply) => {
    try { await pool.query('SELECT 1'); await store.redis.ping(); return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
  });
  // SNS sends JSON with text/plain; no raw payload is logged or persisted.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (request, body, done) => {
    try { done(null, JSON.parse(body)); } catch (error) { done(error); }
  });
  app.post('/v1/mail/webhooks', createWebhookHandler(deps));
  const service = new UserService(deps);

  await app.register(async api => {
    api.decorateRequest('terminal', null);
    api.addHook('onRequest', async request => {
      const terminalId = request.headers['x-terminal-id'];
      const terminalToken = request.headers['x-terminal-token'];
      if (!uuid.safeParse(terminalId).success || typeof terminalToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(terminalToken)) fail(401, 'TERMINAL_AUTH_REQUIRED', '認証済み端末から操作してください。');
      const terminal = (await pool.query(`SELECT t.*,f.timezone FROM terminals t JOIN facilities f USING(facility_id)
        WHERE terminal_id=$1 AND t.status='active' AND f.status='active'`, [terminalId])).rows[0];
      if (!terminal?.credential_fingerprint || !equal(sha256(terminalToken).toString('hex'), terminal.credential_fingerprint)) fail(401, 'TERMINAL_AUTH_FAILED', '端末認証に失敗しました。');
      request.terminal = terminal;
      const rateKey = store.key('rate', `${terminalId}:${Math.floor(Date.now() / 60000)}`);
      const count = await store.redis.incr(rateKey);
      if (count === 1) await store.redis.expire(rateKey, 65);
      if (count > 120) fail(429, 'RATE_LIMITED', '操作が多いため、しばらくお待ちください。');
      await pool.query('UPDATE terminals SET last_seen_at=clock_timestamp() WHERE terminal_id=$1 AND (last_seen_at IS NULL OR last_seen_at<clock_timestamp()-interval \'30 seconds\')', [terminalId]);
    });
    const mutate = (schema, action) => async (request, reply) => {
      request.body = schema.parse(request.body ?? {});
      for (const [name, value] of Object.entries(request.params ?? {})) if (name === 'id') uuid.parse(value);
      return idempotent(deps, request, reply, ctx => action(request, request.body, ctx));
    };
    api.get('/v1/terminal', async request => ({ terminal_id: request.terminal.terminal_id,
      facility_id: request.terminal.facility_id, timezone: request.terminal.timezone,
      capabilities: { face: deps.face.ready, mail: deps.mail.ready }, idle_timeout_seconds: config.idleTtlSeconds }));
    api.get('/v1/consent-policies', async request => {
      const type = request.query.type;
      if (!['registration','safety'].includes(type)) fail(400, 'VALIDATION_ERROR', '同意文面の種類をご指定ください。');
      const policy = await service.policy(pool, type);
      return { type, policy_version: policy.policy_version, title: policy.title, body: policy.body, requires_reconsent: policy.requires_reconsent };
    });
    api.post('/v1/enrollments', mutate(bodySchemas.empty, (request, body, ctx) => service.createDraft(request, ctx)));
    api.get('/v1/enrollments/:id', async request => service.getDraft(request, uuid.parse(request.params.id)));
    api.patch('/v1/enrollments/:id/profile', mutate(bodySchemas.profile, (request, body) => service.setProfile(request, request.params.id, body)));
    api.post('/v1/enrollments/:id/face', mutate(bodySchemas.face, (request, body, ctx) => service.setFace(request, request.params.id, body, ctx)));
    api.post('/v1/enrollments/:id/consent', mutate(bodySchemas.consent, (request, body, ctx) => service.consentDraft(request, request.params.id, body, ctx)));
    api.put('/v1/enrollments/:id/recipients', mutate(bodySchemas.recipients, (request, body, ctx) => service.setRecipients(request, request.params.id, body, ctx)));
    api.post('/v1/enrollments/:id/complete', mutate(bodySchemas.empty, (request, body, ctx) => service.completeDraft(request, request.params.id, ctx)));
    api.delete('/v1/enrollments/:id', mutate(bodySchemas.empty, (request, body, ctx) => service.cancelDraft(request, request.params.id, ctx)));
    api.post('/v1/faces/liveness-sessions', mutate(bodySchemas.liveness, (request, body, ctx) => service.createLiveness(request, body, ctx)));
    api.post('/v1/faces/verify-registration', mutate(bodySchemas.face, (request, body, ctx) => service.verify(request, body, ctx, 'registration')));
    api.post('/v1/faces/identify', mutate(bodySchemas.face, (request, body, ctx) => service.verify(request, body, ctx, 'safety')));
    api.post('/v1/users/me/confirmation', mutate(bodySchemas.confirmation, (request, body, ctx) => service.confirmIdentity(request, body, ctx)));
    api.get('/v1/users/me/recipients', request => service.getRecipients(request));
    api.post('/v1/enrollments/:id/confirmation-mails', mutate(bodySchemas.empty, (request, body, ctx) => service.queueSend(request, ctx, 'registration', body, request.params.id)));
    api.post('/v1/safety-checks', mutate(bodySchemas.safety, (request, body, ctx) => service.queueSend(request, ctx, 'safety', body)));
    api.get('/v1/safety-checks/:id', async request => service.getCheck(request, uuid.parse(request.params.id)));
    api.post('/v1/safety-checks/:id/retry', mutate(bodySchemas.empty, (request, body, ctx) => service.retryCheck(request, request.params.id, ctx)));
    api.delete('/v1/sessions/current', mutate(bodySchemas.empty, (request, body, ctx) => service.endSession(request, ctx)));
  });
  return app;
}
