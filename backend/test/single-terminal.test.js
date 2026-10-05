import test from 'node:test';
import assert from 'node:assert/strict';
import { openApiDocument } from '../src/openapi.js';

test('single-robot contract requires no device secrets and uses user IDs while keeping idempotency', () => {
  const doc = openApiDocument();
  assert.deepEqual(Object.keys(doc.components.securitySchemes), []);
  assert.deepEqual(doc.paths['/v1/registrations/capture'].post.security, []);
  assert.deepEqual(doc.paths['/v1/registrations/verify'].post.security, []);
  assert.deepEqual(doc.paths['/v1/mail-results/{id}'].get.security, []);
  assert.ok(doc.paths['/v1/registrations/capture'].post.parameters.some(
    p => p.name === 'Idempotency-Key' && p.required));
  assert.deepEqual(doc.paths['/v1/mail/webhooks'].post.security, []);
});

test('user send contract exposes acceptance without delivery details', () => {
  const doc = openApiDocument();
  assert.ok(doc.components.schemas.SendResult.properties.send_requested);
  assert.equal(doc.components.schemas.SendResult.properties.recipient_results, undefined);
  assert.equal(doc.components.schemas.FaceResult.properties.user_token, undefined);
});
