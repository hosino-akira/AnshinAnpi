import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { TemporaryStore } from '../src/temporary-store.js';
import { UserService } from '../src/user-service.js';

async function setup(t) {
  const secret = randomBytes(32).toString('base64');
  const config = await readConfig({
    DATA_ENCRYPTION_KEY: secret, TEMPORARY_ENCRYPTION_KEY: secret, AUDIT_HMAC_KEY: secret,
  });
  assert.equal(config.idleTtlSeconds, 300);
  assert.equal(config.verificationTtlSeconds, 900);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const store = new TemporaryStore(config);
  t.after(() => store.close());
  const service = new UserService({ config, store });
  const request = {
    terminal: { terminal_id: randomUUID() },
    body: { user_id: randomUUID() }, routeOptions: { url: '/v1/users/:id/recipients' },
  };
  request.params = { id: request.body.user_id };
  const db = { query: async () => ({ rows: [{ status: 'active' }] }) };
  return { config, store, service, request, db };
}

test('registration drafts survive four idle minutes and are physically removed at five', async t => {
  const { config, store, service, request } = await setup(t);
  await store.put('draft', 'draft-id', {
    terminalId: request.terminal.terminal_id, lastActivityAt: new Date().toISOString(),
  }, new Date(Date.now() + config.draftTtlSeconds * 1000));
  t.mock.timers.tick(240_000);
  assert.ok(await service.draft(request, 'draft-id'));
  t.mock.timers.tick(60_000);
  assert.equal(store.state.entries.has(store.key('draft', 'draft-id')), false);
  await assert.rejects(service.draft(request, 'draft-id'), error => error.code === 'TIME-001');
});

test('face sessions survive four idle minutes, refresh activity, and reject over five idle minutes', async t => {
  const { store, service, request, db } = await setup(t);
  await service.newSession(db, request, request.body.user_id, 'safety');
  t.mock.timers.tick(240_000);
  await service.session(request, db, 'safety');
  const session = await store.get('session', request.body.user_id);
  assert.equal(session.last_activity_at, new Date().toISOString());
  t.mock.timers.tick(301_000);
  await assert.rejects(service.session(request, db, 'safety'), error => error.code === 'FACE_VERIFICATION_REQUIRED');
});

test('continued activity does not extend the fifteen-minute maximum face session lifetime', async t => {
  const { service, request, db } = await setup(t);
  await service.newSession(db, request, request.body.user_id, 'safety');
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(240_000);
    await service.session(request, db, 'safety');
  }
  t.mock.timers.tick(180_000);
  await assert.rejects(service.session(request, db, 'safety'), error => error.code === 'FACE_VERIFICATION_REQUIRED');
});
