import test from 'node:test';
import assert from 'node:assert/strict';
import { mailMessage } from '../src/mail-message.js';
import { SmtpMailProvider } from '../src/providers/smtp-mail.js';
import { AwsMailProvider } from '../src/providers/aws-mail.js';

const config = { facilityName: 'さくら施設', contactAddress: 'support@example.com' };
const message = { displayName: '山田 太郎', recipientName: '山田 花子',
  occurredAt: '2026-10-05T15:30:00Z', timezone: 'Asia/Tokyo', type: 'safety',
  email: 'hanako@example.com', deliveryId: 'delivery-1' };

test('safety email resolves actual names, local operation time and facility with the required copy', () => {
  const content = mailMessage(config, message);
  assert.equal(content.subject, '【安心安否確認】山田 太郎さんからのお知らせ');
  assert.equal(content.text, `山田 花子 様

山田 太郎さんが、2026/10/06 0:30に安心安否確認システムから安否確認を送信しました。本人の操作により送信された自動メールです。

現在、さくら施設の端末でご本人の確認が完了しています。

※本メールは送信専用です。
※このサービスは緊急通報ではありません。緊急時は119番・110番をご利用ください。`);
  assert.doesNotMatch(content.text, /\{\{|undefined|hanako@example.com/);
  const other = mailMessage(config, { ...message, recipientName: '山田 一郎', timezone: 'UTC', facilityName: '別の施設' });
  assert.match(other.text, /^山田 一郎 様/);
  assert.match(other.text, /2026\/10\/05 15:30/);
  assert.match(other.text, /別の施設の端末/);
  assert.doesNotMatch(other.text, /山田 花子|さくら施設/);
});

test('registration email includes registration time, service explanation and incorrect-registration contact', () => {
  const content = mailMessage(config, { ...message, type: 'registration' });
  assert.equal(content.subject, '【安心安否確認】連絡先登録のお知らせ');
  assert.match(content.text, /^山田 花子 様/);
  assert.match(content.text, /山田 太郎さんの連絡先として、2026\/10\/06 0:30に登録されました/);
  assert.match(content.text, /ご本人の操作により登録された連絡先へ安否確認メールを送るサービス/);
  assert.match(content.text, /お心当たりがない場合/);
  assert.match(content.text, /お問い合わせ：support@example.com/);
  assert.match(content.text, /送信専用/);
  assert.match(content.text, /緊急通報ではありません。緊急時は119番・110番/);
  assert.doesNotMatch(content.text, /\{\{|undefined/);
});

test('inserted names remain literal even when they contain another template variable', () => {
  const content = mailMessage(config, { ...message, recipientName: '家族 {{施設名}}', displayName: '利用者 {{確認日時}}' });
  assert.match(content.text, /^家族 \{\{施設名\}\} 様/);
  assert.equal(content.subject, '【安心安否確認】利用者 {{確認日時}}さんからのお知らせ');
});

test('SMTP and SES send identical content for both business email types to one recipient', async () => {
  let smtpInput, sesInput;
  const smtp = new SmtpMailProvider({ ...config, smtpHost: 'smtp.example.com', smtpPort: 587,
    smtpUser: 'no-reply@example.com', smtpPassword: 'test-only', smtpFrom: 'no-reply@example.com' }, {
    sendMail: async input => { smtpInput = input; return { accepted: [message.email], messageId: input.messageId }; },
  });
  const ses = new AwsMailProvider({ ...config, awsRegion: 'test', sesFrom: 'no-reply@example.com' }, {
    send: async command => { sesInput = command.input; return { MessageId: 'ses-message' }; },
  });
  for (const type of ['registration', 'safety']) {
    await smtp.send({ ...message, type });
    await ses.send({ ...message, type });
    assert.equal(smtpInput.subject, sesInput.Content.Simple.Subject.Data);
    assert.equal(smtpInput.text, sesInput.Content.Simple.Body.Text.Data);
    assert.deepEqual(smtpInput.envelope.to, [message.email]);
    assert.deepEqual(sesInput.Destination, { ToAddresses: [message.email] });
  }
});
