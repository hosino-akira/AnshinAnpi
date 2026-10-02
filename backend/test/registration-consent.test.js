import test from 'node:test';
import assert from 'node:assert/strict';
import { UserService } from '../src/user-service.js';

function fixture(displayName) {
  const draft = { displayName, expiresAt: new Date(Date.now() + 60000).toISOString() };
  let recorded = false;
  const service = new UserService({
    config: { auditKey: Buffer.alloc(32, 1), auditKeyId: 'test-key' },
    store: { lock: async (_type, _id, action) => action(), put: async () => {} },
  });
  service.draft = async () => draft;
  service.policy = async () => ({ policy_version: 'v1' });
  const ctx = { db: { query: async sql => {
    if (sql.startsWith('INSERT INTO consents')) {
      recorded = true;
      return { rows: [{ consent_id: 'consent-1' }] };
    }
    if (sql.includes('nextval(')) return { rows: [{ id: 1 }] };
    return { rows: [] };
  } } };
  return { service, ctx, recorded: () => recorded };
}

test('registration consent can be recorded before face capture', async () => {
  const { service, ctx, recorded } = fixture('Development test');
  const result = await service.consentDraft({ terminal: { terminal_id: 'terminal-1' } }, 'draft-1',
    { policy_version: 'v1', result: 'granted' }, ctx);
  assert.equal(result.body.result, 'granted');
  assert.equal(recorded(), true);
});

test('registration consent still requires a name', async () => {
  const { service, ctx, recorded } = fixture(undefined);
  await assert.rejects(service.consentDraft({ terminal: { terminal_id: 'terminal-1' } }, 'draft-1',
    { policy_version: 'v1', result: 'granted' }, ctx), error => error.code === 'ENROLLMENT_INCOMPLETE');
  assert.equal(recorded(), false);
});
