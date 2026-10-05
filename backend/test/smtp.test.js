import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import nodemailer from 'nodemailer';
import { readMailConfig } from '../src/config.js';
import { SmtpMailProvider, smtpOptions } from '../src/providers/smtp-mail.js';
import { MailFailure } from '../src/mail-failure.js';

const config = { smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecure: false,
  smtpUser: 'sender@example.com', smtpPassword: 'test-only', smtpFrom: 'sender@example.com', contactAddress: '施設スタッフ' };
const message = { email: 'family@example.com', displayName: '山田 太郎', occurredAt: '2026-10-05T01:00:00Z',
  timezone: 'Asia/Tokyo', type: 'registration', deliveryId: '00000000-0000-4000-8000-000000000001' };

test('SMTP config validates TLS and addresses and accepts password from Secrets Manager', () => {
  const env = { SMTP_FROM_EMAIL: ' Sender@EXAMPLE.com ', SMTP_PASSWORD: 'local' };
  const result = readMailConfig(env, { SMTP_PASSWORD: 'secret' });
  assert.equal(result.smtpFrom, 'sender@example.com');
  assert.equal(result.smtpPassword, 'secret');
  assert.equal(result.smtpPort, 587);
  assert.equal(result.smtpSecure, false);
  assert.equal(readMailConfig({ SMTP_PORT: '465' }).smtpSecure, true);
  assert.equal(readMailConfig({ SMTP_PASSWORD: ' pass with spaces ' }).smtpPassword, ' pass with spaces ');
  for (const bad of [{ SMTP_PORT: 'bad' }, { SMTP_PORT: '0' }, { SMTP_PORT: '65536' }, { SMTP_PORT: '12.5' },
    { SMTP_SECURE: 'yes' }, { SMTP_SECURE: 'true', SMTP_PORT: '587' }, { SMTP_SECURE: 'false', SMTP_PORT: '465' },
    { SMTP_HOST: 'smtp://example.com' }, { SMTP_FROM_EMAIL: 'Name <a@example.com>' }, { SMTP_REPLY_TO_EMAIL: 'invalid' }])
    assert.throws(() => readMailConfig(bad));
});

test('production SMTP requires TLS, verifies certificates and disables sensitive protocol logs', () => {
  const options = smtpOptions(config);
  assert.equal(options.requireTLS, true);
  assert.equal(options.secure, false);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.logger, false);
  assert.equal(options.debug, false);
  const implicit = smtpOptions({ ...config, smtpPort: 465, smtpSecure: true });
  assert.equal(implicit.secure, true);
  assert.equal(implicit.requireTLS, false);
});

test('SMTP sends each address separately with stable Message-ID, reply address and Tokyo date', async () => {
  const inputs = [];
  const provider = new SmtpMailProvider({ ...config, smtpReplyTo: 'staff@example.com' }, {
    sendMail: async input => { inputs.push(input); return { accepted: [message.email], rejected: [], messageId: input.messageId }; },
  });
  await provider.send(message);
  await provider.send({ ...message, type: 'safety' });
  for (const input of inputs) {
    assert.deepEqual(input.envelope, { from: config.smtpFrom, to: [message.email] });
    assert.deepEqual(input.to, [{ address: message.email }]);
    assert.equal(input.cc, undefined); assert.equal(input.bcc, undefined);
    assert.equal(input.messageId, `<${message.deliveryId}@example.com>`);
    assert.equal(input.headers['X-Anshin-Delivery-Id'], message.deliveryId);
    assert.equal(input.replyTo, 'staff@example.com');
    assert.match(input.text, /10:00/);
    assert.equal(input.text.includes(config.smtpPassword), false);
  }
  assert.match(inputs[0].subject, /連絡先登録/);
  assert.match(inputs[1].subject, /山田 太郎/);
});

test('SMTP requires complete credentials before verify or send and verification never sends mail', async () => {
  let verified = false;
  let sent = false;
  const transport = { verify: async () => { verified = true; }, sendMail: async () => { sent = true; } };
  const missing = new SmtpMailProvider({ ...config, smtpPassword: '' }, transport);
  assert.equal(missing.ready, false);
  await assert.rejects(missing.verify(), error => error.code === 'MAIL_CONFIG_REQUIRED');
  await assert.rejects(missing.send(message), error => error.code === 'MAIL_CONFIG_REQUIRED');
  assert.equal(verified, false); assert.equal(sent, false);
  const provider = new SmtpMailProvider(config, transport);
  await provider.verify();
  assert.equal(verified, true); assert.equal(sent, false);
});

test('SMTP only retries explicit temporary rejection and failures known to precede sending', async () => {
  const cases = [
    [{ code: 'EAUTH', responseCode: 535 }, 'MAIL_AUTH_REQUIRED', false, false],
    [{ code: 'ETLS' }, 'MAIL_TLS_FAILED', false, false],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'MAIL_TLS_FAILED', false, false],
    [{ code: 'EENVELOPE', responseCode: 550 }, 'MAIL-001', false, false],
    [{ code: 'EMESSAGE', responseCode: 451 }, 'MAIL-002', true, false],
    [{ code: 'EDNS' }, 'MAIL-002', true, false],
    [{ code: 'ETIMEDOUT', command: 'CONN' }, 'MAIL-002', true, false],
    [{ code: 'ETIMEDOUT', command: 'DATA' }, 'MAIL_RESULT_UNKNOWN', false, true],
    [{ code: 'ESOCKET', command: 'DATA' }, 'MAIL_RESULT_UNKNOWN', false, true],
    [{ code: 'ECONNRESET' }, 'MAIL_RESULT_UNKNOWN', false, true],
  ];
  for (const [failure, code, retryable, uncertain] of cases) {
    const provider = new SmtpMailProvider(config, { sendMail: async () => { throw failure; } });
    await assert.rejects(provider.send(message), error => error instanceof MailFailure
      && error.code === code && error.retryable === retryable && error.uncertain === uncertain);
  }
});

test('SMTP acceptance requires the exact recipient and a message identifier', async () => {
  for (const result of [{ accepted: [], messageId: 'id' }, { accepted: ['someone-else@example.com'], messageId: 'id' }, { accepted: [message.email] }]) {
    const provider = new SmtpMailProvider(config, { sendMail: async () => result });
    await assert.rejects(provider.send(message), error => error.code === 'MAIL_RESULT_UNKNOWN' && error.uncertain);
  }
  const rejected = new SmtpMailProvider(config, { sendMail: async () => ({ rejected: [message.email] }) });
  await assert.rejects(rejected.send(message), error => error.code === 'MAIL-001' && !error.uncertain);
});

test('SMTP sends a real MIME message to an isolated local server and closes the connection', async () => {
  const recipients = [], lines = [], connections = new Set();
  const server = createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    let buffer = '', data = false;
    socket.write('220 localhost test SMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') { data = false; socket.write('250 queued\r\n'); }
          else lines.push(line);
        } else if (/^EHLO/.test(line)) socket.write('250-localhost\r\n250 PIPELINING\r\n');
        else if (/^MAIL FROM/.test(line)) socket.write('250 ok\r\n');
        else if (/^RCPT TO/.test(line)) { recipients.push(line); socket.write('250 ok\r\n'); }
        else if (line === 'DATA') { data = true; socket.write('354 continue\r\n'); }
        else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Plaintext is confined to this injected loopback fixture; production requires TLS.
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: server.address().port,
    ignoreTLS: true, allowInternalNetworkInterfaces: true, connectionTimeout: 2000, socketTimeout: 2000 });
  const provider = new SmtpMailProvider(config, transport);
  try {
    const result = await provider.send(message);
    assert.equal(result.messageId, `<${message.deliveryId}@example.com>`);
    assert.deepEqual(recipients, [`RCPT TO:<${message.email}>`]);
    const mime = lines.join('\r\n');
    assert.match(mime, /X-Anshin-Delivery-Id:/i);
    assert.match(mime, /charset=utf-8/i);
    assert.equal(mime.includes(config.smtpPassword), false);
  } finally {
    provider.close();
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
