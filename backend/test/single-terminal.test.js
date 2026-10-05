import test from 'node:test';
import assert from 'node:assert/strict';
import { openApiDocument } from '../src/openapi.js';

test('single-robot contract requires no device secrets but keeps user tokens and idempotency', () => {
  const doc = openApiDocument();
  assert.deepEqual(Object.keys(doc.components.securitySchemes), ['UserToken']);
  assert.deepEqual(doc.paths['/v1/registrations/capture'].post.security, []);
  assert.deepEqual(doc.paths['/v1/registrations/verify'].post.security, [{ UserToken: [] }]);
  assert.deepEqual(doc.paths['/v1/mail-results/{id}'].get.security, [{ UserToken: [] }]);
  assert.ok(doc.paths['/v1/registrations/capture'].post.parameters.some(
    p => p.name === 'Idempotency-Key' && p.required));
  assert.deepEqual(doc.paths['/v1/mail/webhooks'].post.security, []);
});
