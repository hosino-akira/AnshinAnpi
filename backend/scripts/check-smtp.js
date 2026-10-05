import { loadLocalEnv, readMailConfig } from '../src/config.js';
import { SmtpMailProvider } from '../src/providers/smtp-mail.js';
import { randomUUID } from 'node:crypto';
import { email } from '../src/validation.js';

// Default: TLS and authentication only. --send-to explicitly sends one test email.
let provider;
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--send-to')) throw new Error('INVALID_ARGUMENT');
  const recipient = args.length ? email.parse(args[1]) : null;
  loadLocalEnv();
  provider = new SmtpMailProvider(readMailConfig());
  await provider.verify();
  console.log(JSON.stringify({ check: 'smtp', status: 'ok', tls: true, authenticated: true }));
  if (recipient) {
    const result = await provider.send({ email: recipient, displayName: '送信テスト',
      occurredAt: new Date(), timezone: 'Asia/Tokyo', type: 'test', deliveryId: randomUUID() });
    console.log(JSON.stringify({ check: 'smtp-send', status: 'accepted', messageId: result.messageId }));
  }
} catch (error) {
  // Raw SMTP responses can contain addresses; do not print them or credentials.
  const code = error.code || (/^[A-Z][A-Z0-9_]{0,99}$/.test(error.message ?? '') ? error.message : 'SMTP_CHECK_FAILED');
  console.error(JSON.stringify({ check: 'smtp', status: 'failed', code }));
  process.exitCode = 1;
} finally { provider?.close(); }
