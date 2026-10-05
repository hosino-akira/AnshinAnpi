import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { installRequestLog } from '../src/request-log.js';
import { installErrorHandler, fail } from '../src/errors.js';
import { bodySchemas } from '../src/validation.js';

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anshin-request-log-'));
  const path = join(directory, 'exchanges.jsonl');
  const app = Fastify({ logger: false });
  installErrorHandler(app);
  installRequestLog(app, { enabled: true, path, ...options });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, path, directory };
}

test('exchange log captures scores and original request but hides photos and nested credentials', async t => {
  const { app, path } = await setup(t);
  app.post('/v1/example', async (request, reply) => {
    request.body.changed = true;
    return reply.code(201).send({ user_token: 'response-secret', metrics: { similarity_score: 99.7 },
      nested: { password: 'nested-secret' } });
  });
  const photo = 'data:image/jpeg;base64,/9j/4AAAAAA=';
  const response = await app.inject({ method: 'POST', url: '/v1/example?user_token=query-secret',
    headers: { authorization: 'Bearer header-secret', 'idempotency-key': 'operation-1' },
    payload: { image_base64: photo, display_name: 'Test', consent_result: 'granted' } });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().user_token, 'response-secret');
  const raw = await readFile(path, 'utf8');
  for (const privateValue of [photo, 'response-secret', 'nested-secret', 'header-secret', 'query-secret']) {
    assert.ok(!raw.includes(privateValue));
  }
  const record = JSON.parse(raw);
  assert.equal(record.status, 201);
  assert.equal(record.request_body.changed, undefined);
  assert.equal(record.request_body.image_base64.has_data_url_prefix, true);
  assert.equal(record.response_body.metrics.similarity_score, 99.7);
  assert.equal(record.headers['idempotency-key'], 'operation-1');
  assert.ok(record.request_id);
});

test('schema errors reveal field paths and quality errors retain detailed scores', async t => {
  const { app, path } = await setup(t);
  app.post('/v1/capture', async request => {
    bodySchemas.photoCapture.parse(request.body);
    fail(422, 'FACE_QUALITY_FAILED', 'Quality failed', { brightness: 20, yaw: 45, failed_checks: ['brightness', 'yaw'] });
  });
  const invalid = await app.inject({ method: 'POST', url: '/v1/capture', payload: { image_base64: 'invalid!' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.details.validation_errors[0].path, 'image_base64');
  const quality = await app.inject({ method: 'POST', url: '/v1/capture', payload: { image_base64: '/9j/4AAAAAA=' } });
  assert.equal(quality.statusCode, 422);
  const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records[0].request_id, invalid.json().error.request_id);
  assert.equal(records[1].response_body.error.details.yaw, 45);
  assert.deepEqual(records[1].response_body.error.details.failed_checks, ['brightness', 'yaw']);
});

test('production, disabled logging and mail webhooks never write exchange logs', async t => {
  for (const options of [{ production: true }, { enabled: false }, {}]) {
    const { app, path } = await setup(t, options);
    const url = Object.keys(options).length ? '/v1/example' : '/v1/mail/webhooks';
    app.post(url, async () => ({ ok: true }));
    await app.inject({ method: 'POST', url, payload: { message: 'private-webhook' } });
    await assert.rejects(readFile(path), error => error.code === 'ENOENT');
  }
});

test('rotation retains a previous file and write failures do not break an API response', async t => {
  const { app, path } = await setup(t, { maxBytes: 1 });
  app.get('/v1/example', async () => ({ ok: true }));
  await app.inject('/v1/example');
  await app.inject('/v1/example');
  await app.inject('/v1/example');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 200);
  assert.equal(JSON.parse(await readFile(`${path}.1`, 'utf8')).status, 200);
  const broken = await setup(t);
  const other = Fastify({ logger: false });
  t.after(() => other.close());
  installRequestLog(other, { enabled: true, path: broken.directory });
  other.get('/v1/example', async () => ({ ok: true }));
  const response = await other.inject('/v1/example');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
});
