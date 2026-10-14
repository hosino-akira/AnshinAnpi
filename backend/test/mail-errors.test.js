import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mailErrorDisplay } from '../src/mail-error-display.js';
import { SmtpMailProvider } from '../src/providers/smtp-mail.js';
import { MailWorker } from '../src/mail-worker.js';
import { AdminService } from '../src/admin-service.js';

const messages = {
  'MAIL-001': '確認メールを送信できませんでした。メールアドレスをご確認ください。',
  'MAIL-002': 'ただいまメールを送信できません。時間をおいてお試しください。',
};
test('only the two specification codes and exact messages are exposed, preserving stored diagnosis', () => {
  for (const [status, rawCode, expected] of [
    ['failed', 'MAIL-001', 'MAIL-001'], ['bounced', null, 'MAIL-001'],
    ['failed', 'MAIL-002', 'MAIL-002'], ['failed', 'MAIL_AUTH_REQUIRED', 'MAIL-002'],
    ['failed', 'MAIL_TLS_FAILED', 'MAIL-002'], ['failed', 'MAIL_CONFIG_REQUIRED', 'MAIL-002'],
    ['unknown', 'MAIL_RESULT_UNKNOWN', 'MAIL-002'], ['failed', null, 'MAIL-002'],
  ]) {
    const row = { status, error_code: rawCode };
    assert.deepEqual(mailErrorDisplay(row), { code: expected, message: messages[expected] });
    assert.equal(row.error_code, rawCode);
  }
});

test('dashboard API converts existing diagnostic records without changing stored errors', async () => {
  const rows = ['MAIL-001', 'MAIL-002', 'MAIL_AUTH_REQUIRED', 'MAIL_TLS_FAILED', 'MAIL_CONFIG_REQUIRED', 'MAIL_RESULT_UNKNOWN'].map((code, index) => ({
    delivery_id: randomUUID(), user_id: randomUUID(), display_name: '登録者', name: '送信先', encrypted_email_snapshot: 'test@example.invalid',
    updated_at: new Date().toISOString(), error_code: code, status: index === 5 ? 'unknown' : 'failed',
  }));
  const db = { release() {}, async query(sql) {
    if (sql.includes('AS errors')) return { rows: [{ errors: rows.length }] };
    if (sql.includes('SELECT d.*')) return { rows };
    if (sql.includes('SELECT nextval')) return { rows: [{ id: 1 }] };
    assert(!sql.startsWith('UPDATE mail_deliveries'));
    return { rows: [] };
  } };
  const service = new AdminService({ pool: { connect: async () => db }, cipher: { open: async value => value },
    config: { auditKey: Buffer.alloc(32), auditKeyId: 'test' } });
  const result = await service.dashboard({ id: randomUUID(), admin: { email: 'admin@example.invalid' } });
  assert.equal(result.counts.errors, 6);
  assert.deepEqual(result.errors.map(row => row.code), ['MAIL-001', 'MAIL-002', 'MAIL-002', 'MAIL-002', 'MAIL-002', 'MAIL-002']);
  for (const error of result.errors) assert.equal(error.message, messages[error.code]);
  assert.equal(result.errors[5].status, 'unknown');
  assert(!JSON.stringify(result.errors).includes('MAIL_RESULT_UNKNOWN'));
  assert.equal(rows[5].error_code, 'MAIL_RESULT_UNKNOWN');
});

async function workerFixture(smtpError) {
  const userId = randomUUID(), recipientId = randomUUID(), checkId = randomUUID(), deliveryId = randomUUID();
  const user = { user_id: userId, status: 'pending_registration', display_name: 'テスト登録者', created_at: new Date() };
  const recipient = { recipient_id: recipientId, status: 'active', name: 'テスト送信先' };
  const check = { check_id: checkId, user_id: userId, check_type: 'registration', terminal_id: randomUUID(), consent_id: randomUUID(), expires_at: new Date(Date.now() + 600000) };
  const delivery = { delivery_id: deliveryId, user_id: userId, recipient_id: recipientId, check_id: checkId,
    encrypted_email_snapshot: 'test@example.invalid', provider: 'smtp', status: 'queued', attempt_count: 0 };
  const attempts = [];
  const mail = new SmtpMailProvider({ smtpHost: 'smtp.example.invalid', smtpPort: 587, smtpUser: 'test', smtpPassword: 'test', smtpFrom: 'sender@example.invalid' }, {
    async sendMail(message) { attempts.push(message); throw smtpError; }, close() {},
  });
  const db = { release() {}, async query(sql, args) {
    if (sql.startsWith('SELECT user_id,recipient_id,check_id')) return { rows: [delivery] };
    if (sql.startsWith('SELECT * FROM users')) return { rows: [user] };
    if (sql.startsWith('SELECT * FROM recipients')) return { rows: [recipient] };
    if (sql.startsWith('SELECT * FROM safety_checks')) return { rows: [check] };
    if (sql.startsWith('SELECT * FROM mail_deliveries')) return { rows: [{ ...delivery }] };
    if (sql.startsWith('SELECT * FROM terminals')) return { rows: [{ status: 'active', timezone: 'Asia/Tokyo' }] };
    if (sql.startsWith('SELECT * FROM consents')) return { rows: [{ result: 'granted', consented_at: new Date() }] };
    if (sql.includes("result='withdrawn'")) return { rows: [], rowCount: 0 };
    if (sql.startsWith('UPDATE mail_deliveries SET status=$2')) {
      Object.assign(delivery, { status: args[1], error_code: args[2], next_attempt_at: args[3] }); return { rows: [] };
    }
    if (sql.startsWith('SELECT status FROM mail_deliveries')) return { rows: [{ status: delivery.status }] };
    if (sql.includes('SELECT nextval')) return { rows: [{ id: attempts.length }] };
    return { rows: [] };
  } };
  const worker = new MailWorker({ mail, pool: { query: db.query, connect: async () => db },
    cipher: { open: async value => value }, config: { auditKey: Buffer.alloc(32), auditKeyId: 'test', facilityName: 'テスト施設' } });
  const runAttempt = async () => {
    assert.equal(delivery.status, 'queued');
    delivery.status = 'sending'; delivery.attempt_count += 1;
    await worker.deliver(deliveryId);
  };
  return { delivery, attempts, runAttempt };
}

test('SMTP 550 produces MAIL-001 with no retry', async () => {
  const fixture = await workerFixture({ code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' });
  await fixture.runAttempt();
  assert.equal(fixture.attempts.length, 1);
  assert.equal(fixture.delivery.status, 'failed');
  assert.equal(fixture.delivery.error_code, 'MAIL-001');
  assert.equal(fixture.delivery.next_attempt_at, null);
  assert.equal(mailErrorDisplay(fixture.delivery).message, messages['MAIL-001']);
});

test('connection TIMEOUT retries twice, then exposes MAIL-002 after 3 total attempts', async () => {
  const fixture = await workerFixture({ code: 'ETIMEDOUT', command: 'CONN' });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await fixture.runAttempt();
    assert.equal(fixture.delivery.status, attempt < 3 ? 'queued' : 'failed');
    assert.equal(fixture.delivery.error_code, 'MAIL-002');
    if (attempt < 3) assert(fixture.delivery.next_attempt_at > new Date());
  }
  assert.equal(fixture.attempts.length, 3);
  assert.equal(fixture.delivery.next_attempt_at, null);
  assert.equal(new Set(fixture.attempts.map(message => message.messageId)).size, 1);
  assert.equal(mailErrorDisplay(fixture.delivery).message, messages['MAIL-002']);
});

test('display changes leave uncertain send handling and diagnostic code intact', async () => {
  const fixture = await workerFixture({ code: 'ETIMEDOUT', command: 'DATA' });
  await fixture.runAttempt();
  assert.equal(fixture.delivery.status, 'unknown');
  assert.equal(fixture.delivery.error_code, 'MAIL_RESULT_UNKNOWN');
  assert.equal(fixture.delivery.next_attempt_at, null);
  assert.equal(fixture.attempts.length, 1);
  assert.equal(mailErrorDisplay(fixture.delivery).code, 'MAIL-002');
});
