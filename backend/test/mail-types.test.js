import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminService } from '../src/admin-service.js';
import { MailWorker } from '../src/mail-worker.js';
import { SmtpMailProvider } from '../src/providers/smtp-mail.js';
import { mailMessage } from '../src/mail-message.js';

const config = {
  auditKey: Buffer.alloc(32), auditKeyId: 'test', contactAddress: '施設スタッフ',
  smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'test',
  smtpPassword: 'test', smtpFrom: 'sender@example.com',
};
const cipher = { open: async value => value, seal: async value => value };
const message = {
  displayName: '登録者', recipientName: '連絡先', email: 'recipient@example.com',
  occurredAt: '2026-10-08T04:33:00Z', timezone: 'Asia/Tokyo', deliveryId: 'delivery',
};
function poolFor(query) {
  return { query, connect: async () => ({ query, release() {} }) };
}
const result = (rows = []) => ({ rows, rowCount: rows.length });

test('registration and safety messages retain their content and template rendering', () => {
  const registration = mailMessage(config, { ...message, type: 'registration' });
  assert.equal(registration.subject, '【安心安否確認】連絡先登録のお知らせ');
  assert.match(registration.text, /登録者さんの連絡先として/);
  const safety = mailMessage(config, { ...message, type: 'safety' });
  assert.equal(safety.subject, '【安心安否確認】登録者さんからのお知らせ');
  assert.match(safety.text, /安否確認を送信しました/);
  const custom = mailMessage(config, {
    ...message, type: 'safety', displayName: '{{送信先名}}',
    template: { subject: '{{登録者名}}', body: '{{送信先名}}：{{登録者名}}' },
  });
  assert.deepEqual(custom, { subject: '{{送信先名}}', text: '連絡先：{{送信先名}}' });
});

for (const type of ['contact_change', 'test', 'other', undefined]) {
  test(`SMTP rejects unsupported type ${String(type)} before sending`, async () => {
    let sent = false;
    const provider = new SmtpMailProvider(config, { sendMail: async () => { sent = true; } });
    await assert.rejects(provider.send({ ...message, type }), { code: 'MAIL_TYPE_UNSUPPORTED' });
    assert.equal(sent, false);
  });
}

for (const operation of ['change', 'add', 'remove']) {
  test(`admin recipient ${operation} saves without SMTP and queues no email`, async () => {
    const queries = [];
    const user = { user_id: 'user', status: 'active', revision: 'revision' };
    const contacts = [
      { recipient_id: 'first', encrypted_email: 'old@example.com', status: 'active', order_no: 1 },
      ...(operation === 'remove' ? [{ recipient_id: 'second', encrypted_email: 'second@example.com', status: 'active', order_no: 2 }] : []),
    ];
    const query = async (sql, values) => {
      queries.push({ sql, values });
      if (/INSERT INTO (safety_checks|mail_deliveries)/.test(sql)) assert.fail('Contact edits must not queue email');
      if (sql.startsWith('SELECT *,updated_at::text')) return result([user]);
      if (sql.startsWith('SELECT * FROM recipients')) return result(contacts);
      if (sql.startsWith('SELECT 1 FROM face_templates') || sql.startsWith('SELECT 1 FROM recipients')) return result([{}]);
      if (sql.startsWith('SELECT entry_hmac')) return result();
      if (sql.startsWith('SELECT nextval')) return result([{ id: 1 }]);
      if (/^(BEGIN|COMMIT|ROLLBACK|UPDATE |INSERT INTO (recipients|audit_logs)|SELECT pg_advisory)/.test(sql)) return result();
      assert.fail(`Unexpected query: ${sql}`);
    };
    const service = new AdminService({ pool: poolFor(query), config, cipher, mail: { ready: false } });
    service.serialize = async () => ({ id: user.user_id });
    const recipients = [{ id: 'first', name: '連絡先', email: operation === 'change' ? 'new@example.com' : 'old@example.com' }];
    if (operation === 'add') recipients.push({ name: '追加先', email: 'new@example.com' });
    const body = { name: '登録者', status: 'active', recipients, expected_revision: 'revision', reason: 'correction' };
    const response = await service.updateUser({ params: { id: 'user' }, id: 'request', admin: { email: 'admin@example.com' }, body }, body);
    assert.deepEqual(response, { user: { id: 'user' } });
    assert.ok(queries.some(({ sql }) => sql.startsWith('UPDATE users SET display_name')));
    assert.ok(queries.some(({ sql }) => sql === 'COMMIT'));
    if (operation !== 'add') {
      const cancelled = queries.find(({ sql }) => sql.startsWith('UPDATE mail_deliveries SET status=CASE'));
      assert.ok(cancelled, 'Old recipient deliveries must still be cancelled and snapshots erased');
      assert.equal(cancelled.values[0], operation === 'remove' ? 'second' : 'first');
    }
    if (operation === 'change') {
      const saved = queries.find(({ sql }) => sql.startsWith('UPDATE recipients SET name='));
      assert.equal(saved.values[2], 'new@example.com');
    }
    if (operation === 'add') assert.ok(queries.some(({ sql }) => sql.startsWith('INSERT INTO recipients')));
  });
}

for (const type of ['registration', 'safety', 'contact_change', 'test', 'other']) {
  test(`worker ${['registration', 'safety'].includes(type) ? 'sends' : 'cancels'} queued ${type} mail`, async () => {
    const allowed = ['registration', 'safety'].includes(type);
    const check = { check_id: 'check', check_type: type, terminal_id: 'terminal', consent_id: 'consent',
      created_at: message.occurredAt, expires_at: new Date(Date.now() + 60000).toISOString() };
    const delivery = { delivery_id: 'delivery', provider: 'smtp', status: 'sending', attempt_count: 1,
      encrypted_email_snapshot: message.email };
    const sent = [];
    const query = async (sql, values) => {
      if (sql.startsWith('SELECT user_id,recipient_id,check_id')) return result([{ user_id: 'user', recipient_id: 'recipient', check_id: 'check' }]);
      if (sql.startsWith('SELECT * FROM users')) return result([{ user_id: 'user', status: type === 'registration' ? 'pending_registration' : 'active', display_name: message.displayName, created_at: message.occurredAt }]);
      if (sql.startsWith('SELECT * FROM recipients')) return result([{ status: 'active', name: message.recipientName }]);
      if (sql.startsWith('SELECT * FROM safety_checks')) return result([check]);
      if (sql.startsWith('SELECT * FROM mail_deliveries')) return result([delivery]);
      if (sql.startsWith('SELECT * FROM terminals')) return result([{ terminal_id: 'terminal', status: 'active', timezone: message.timezone }]);
      if (sql.startsWith('SELECT * FROM consents')) return result([{ result: 'granted', consented_at: message.occurredAt }]);
      if (sql.startsWith('SELECT 1 FROM consents') || sql.startsWith('SELECT entry_hmac')) return result();
      if (sql.startsWith('SELECT document')) return result([{ document: { subject: '安否確認', body: '{{登録者名}}さんからの安否確認' } }]);
      if (sql.startsWith('SELECT nextval')) return result([{ id: 1 }]);
      if (sql.startsWith('SELECT status FROM mail_deliveries')) return result([{ status: delivery.status }]);
      if (sql.startsWith("UPDATE mail_deliveries SET status='cancelled'")) {
        delivery.status = 'cancelled'; delivery.error_code = 'MAIL_TYPE_UNSUPPORTED'; return result();
      }
      if (sql.startsWith("UPDATE mail_deliveries SET status='accepted'")) { delivery.status = 'accepted'; return result(); }
      if (sql.startsWith('UPDATE safety_checks SET status=$2')) { check.status = values[1]; return result(); }
      if (/^(BEGIN|COMMIT|ROLLBACK|UPDATE users|SELECT pg_advisory|INSERT INTO audit_logs)/.test(sql)) return result();
      assert.fail(`Unexpected query: ${sql}`);
    };
    const provider = new SmtpMailProvider(config, {
      sendMail: async content => { sent.push(content); return { accepted: [message.email], messageId: 'smtp-id' }; },
    });
    const worker = new MailWorker({ pool: poolFor(query), mail: provider, cipher, config });
    await worker.deliver('delivery');
    assert.equal(sent.length, allowed ? 1 : 0);
    assert.equal(delivery.status, allowed ? 'accepted' : 'cancelled');
    assert.equal(check.status, allowed ? 'accepted' : 'cancelled');
    if (!allowed) assert.equal(delivery.error_code, 'MAIL_TYPE_UNSUPPORTED');
    if (type === 'registration') assert.match(sent[0].text, /連絡先として/);
    if (type === 'safety') assert.equal(sent[0].text, '登録者さんからの安否確認');
  });
}
