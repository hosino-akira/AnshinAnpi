import https from 'node:https';
import { createVerify, randomUUID } from 'node:crypto';
import { SNSClient, ConfirmSubscriptionCommand } from '@aws-sdk/client-sns';
import { fail, unavailable } from './errors.js';
import { transaction } from './db.js';
import { updateCheck } from './mail-worker.js';
import { audit } from './audit.js';

const certificates = new Map();
export function snsSigningText(message) {
  const names = message.Type === 'Notification'
    ? ['Message','MessageId', ...(message.Subject !== undefined ? ['Subject'] : []), 'Timestamp','TopicArn','Type']
    : ['Message','MessageId','SubscribeURL','Timestamp','Token','TopicArn','Type'];
  if (names.some(name => typeof message[name] !== 'string')) fail(400, 'INVALID_WEBHOOK', 'Invalid notification');
  return names.map(name => `${name}\n${message[name]}\n`).join('');
}
export function validateCertificateUrl(value, region) {
  let url;
  try { url = new URL(value); } catch { fail(401, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid signing certificate'); }
  if (url.protocol !== 'https:' || url.hostname !== `sns.${region}.amazonaws.com` || url.username || url.password
    || (url.port && url.port !== '443') || url.search || url.hash
    || !/^\/SimpleNotificationService-[a-zA-Z0-9]+\.pem$/.test(url.pathname)) fail(401, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid signing certificate');
  return url;
}
async function getCertificate(url) {
  const cached = certificates.get(url.href);
  if (cached && cached.until > Date.now()) return cached.pem;
  const pem = await new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 4000 }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Certificate unavailable')); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 16384) response.destroy(new Error('Certificate too large')); else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Certificate timeout')));
    request.on('error', reject);
  });
  if (certificates.size > 10) certificates.clear();
  certificates.set(url.href, { pem, until: Date.now() + 3600000 });
  return pem;
}

export async function verifySns(message, config, certificateLoader = getCertificate) {
  if (!config.snsTopicArn) unavailable('メール配信通知');
  if (!message || message.TopicArn !== config.snsTopicArn || !['Notification','SubscriptionConfirmation'].includes(message.Type)
    || !['1','2'].includes(message.SignatureVersion) || typeof message.Signature !== 'string') fail(401, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid notification');
  const when = Date.parse(message.Timestamp);
  if (!Number.isFinite(when) || Math.abs(Date.now() - when) > 900000) fail(401, 'WEBHOOK_EXPIRED', 'Expired notification');
  const region = config.snsTopicArn.split(':')[3];
  const url = validateCertificateUrl(message.SigningCertURL, region);
  let valid = false;
  try {
    const cert = await certificateLoader(url);
    valid = createVerify(message.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1')
      .update(snsSigningText(message)).verify(cert, message.Signature, 'base64');
  } catch { fail(401, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid notification'); }
  if (!valid) fail(401, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid notification');
}

export function createWebhookHandler(deps) {
  return async (request, reply) => {
    if (deps.mail.name === 'smtp') unavailable('メール配信通知');
    const notification = request.body;
    await (deps.webhookVerifier ?? verifySns)(notification, deps.config);
    if (notification.Type === 'SubscriptionConfirmation') {
      const client = deps.snsClient ?? new SNSClient({ region: deps.config.snsTopicArn.split(':')[3] });
      await client.send(new ConfirmSubscriptionCommand({ TopicArn: deps.config.snsTopicArn, Token: notification.Token }));
      return { confirmed: true };
    }
    let event;
    try { event = JSON.parse(notification.Message); } catch { fail(400, 'INVALID_WEBHOOK', 'Invalid notification'); }
    const eventMap = { Send: 'accepted', Delivery: 'delivered', Bounce: 'bounced', Complaint: 'complained', Reject: 'failed', RenderingFailure: 'failed' };
    const type = eventMap[event.eventType ?? event.notificationType];
    if (!type) return reply.code(204).send();
    const deliveryId = event.mail?.tags?.anshin_delivery_id?.[0];
    const messageId = event.mail?.messageId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId ?? '')
      || typeof messageId !== 'string' || messageId.length > 255 || typeof notification.MessageId !== 'string' || notification.MessageId.length > 255) fail(400, 'INVALID_WEBHOOK', 'Invalid notification');
    const occurredAt = new Date(event.delivery?.timestamp ?? event.bounce?.timestamp ?? event.complaint?.timestamp ?? event.mail?.timestamp ?? notification.Timestamp);
    if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 300000) fail(400, 'INVALID_WEBHOOK', 'Invalid notification');
    await transaction(deps.pool, async db => {
      const metadata = (await db.query('SELECT check_id FROM mail_deliveries WHERE delivery_id=$1 AND provider=$2', [deliveryId, deps.mail.name])).rows[0];
      if (!metadata) return;
      const check = metadata.check_id && (await db.query('SELECT * FROM safety_checks WHERE check_id=$1 FOR UPDATE', [metadata.check_id])).rows[0];
      const delivery = (await db.query('SELECT * FROM mail_deliveries WHERE delivery_id=$1 FOR UPDATE', [deliveryId])).rows[0];
      if (delivery.provider_message_id && delivery.provider_message_id !== messageId) fail(409, 'WEBHOOK_MESSAGE_MISMATCH', 'Invalid notification');
      const replayKey = deps.store.key('webhook',`${deps.mail.name}:${notification.MessageId}`);
      if (await deps.store.state.exists(replayKey)) return;
      let next = delivery.status;
      if (type === 'bounced' || type === 'complained') next = 'bounced';
      else if (type === 'delivered' && delivery.status !== 'bounced') next = 'delivered';
      else if (type === 'accepted' && !['delivered','bounced'].includes(delivery.status)) next = 'accepted';
      else if (type === 'failed' && !['delivered','bounced'].includes(delivery.status)) next = 'failed';
      await db.query(`UPDATE mail_deliveries SET status=$2::varchar,provider_message_id=$3,attempt_count=GREATEST(attempt_count,1),
        accepted_at=CASE WHEN $4 THEN COALESCE(accepted_at,$5) ELSE accepted_at END,
        delivered_at=CASE WHEN $2::varchar='delivered' THEN COALESCE(delivered_at,$5) ELSE delivered_at END,
        bounced_at=CASE WHEN $2::varchar='bounced' THEN COALESCE(bounced_at,$5) ELSE bounced_at END,
        error_code=CASE WHEN $2::varchar='bounced' THEN 'MAIL-001' WHEN $2::varchar='failed' THEN 'MAIL-001' ELSE NULL END,
        next_attempt_at=NULL WHERE delivery_id=$1`, [deliveryId, next, messageId, ['accepted','delivered','bounced'].includes(next), occurredAt]);
      if (next === 'bounced' && delivery.status !== 'bounced' && delivery.recipient_id) await db.query(`UPDATE recipients SET status='needs_correction',last_bounced_at=$2,bounce_count=bounce_count+1
        WHERE recipient_id=$1 AND status <> 'deleted'`, [delivery.recipient_id, occurredAt]);
      await updateCheck(db, metadata.check_id);
      if (check) await audit(db, deps.config, { id: request.id ?? randomUUID(), terminal: { terminal_id: check.terminal_id } },
        `mail.webhook.${type}`, 'delivery', deliveryId);
    });
    await deps.store.state.set(deps.store.key('webhook',`${deps.mail.name}:${notification.MessageId}`),'1',{EX:86400});
    return reply.code(204).send();
  };
}
