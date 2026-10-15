import { simpleParser } from 'mailparser';

export const MAX_BOUNCE_BYTES = 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const messageIdPattern = /^<([0-9a-f-]{36})@([a-z0-9.-]+)>$/i;
const parserOptions = { keepDeliveryStatus: true, skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true };

function fields(text) {
  const result = new Map();
  for (const line of text.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n')) {
    const split = line.indexOf(':');
    if (split < 1) continue;
    const key = line.slice(0, split).toLowerCase();
    // 同じフィールドが重複する曖昧な通知は、配信記録の照合に使用しません。
    result.set(key, result.has(key) ? '' : line.slice(split + 1).trim());
  }
  return result;
}

// 機械処理可能な配信状態通知だけを受け付けます。件名や本文の配信不能メッセージ、
// 転送メール、開封確認だけでは退信と判定しません。
export async function parseBounceReport(source) {
  if (!Buffer.isBuffer(source) || source.length > MAX_BOUNCE_BYTES) return [];
  const mail = await simpleParser(source, parserOptions);
  const contentType = mail.headers.get('content-type');
  if (contentType?.value?.toLowerCase() !== 'multipart/report' || contentType.params?.['report-type']?.toLowerCase() !== 'delivery-status') return [];
  const returnPaths = mail.headerLines.filter(header => header.key === 'return-path').map(header => header.line.replace(/^Return-Path:\s*/i, '').trim());
  if (returnPaths.length !== 1) return [];
  const autoSubmitted = String(mail.headers.get('auto-submitted') ?? '').toLowerCase().split(/[\s;(]/)[0];
  const daemonPath = /^<?(?:mailer-daemon|postmaster)(?:@[a-z0-9.-]+)?>?$/i.test(returnPaths[0]);
  // さくらが生成する DSN の Return-Path は <> ではなく MAILER-DAEMON になる場合があります。
  // 自動通知の印に加え、構造化 DSN、元のランダムな Message-ID、宛先の一致を確認します。
  if (returnPaths[0] !== '<>' && !(daemonPath && ['auto-generated', 'auto-replied'].includes(autoSubmitted))) return [];
  const statusParts = mail.attachments.filter(part => part.contentType === 'message/delivery-status');
  if (statusParts.length !== 1) return [];
  const blocks = statusParts[0].content.toString('utf8').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/).map(fields);
  const messageIds = new Set();
  if (blocks[0]?.get('original-message-id')) messageIds.add(blocks[0].get('original-message-id'));
  for (const part of mail.attachments) {
    if (['message/rfc822', 'text/rfc822-headers', 'message/global-headers'].includes(part.contentType)) {
      const original = fields(part.content.toString('utf8').split(/\r?\n\r?\n/)[0]);
      if (original.get('message-id')) messageIds.add(original.get('message-id'));
    }
  }
  if (messageIds.size > 1) return [];
  const messageId = [...messageIds][0] ?? null;
  const match = messageId?.match(messageIdPattern);
  const envelopeId = blocks[0]?.get('original-envelope-id');
  const deliveryId = match?.[1] ?? envelopeId;
  if (!uuidPattern.test(deliveryId ?? '') || (messageId && !match) || (envelopeId && envelopeId.toLowerCase() !== deliveryId.toLowerCase())) return [];
  const reports = [];
  for (const block of blocks.slice(1)) {
    if (block.get('action')?.toLowerCase() !== 'failed' || !/^5\.\d{1,3}\.\d{1,3}$/.test(block.get('status') ?? '')) continue;
    const finalRecipient = block.get('final-recipient')?.match(/^rfc822;\s*([^\s<>]+@[^\s<>]+)$/i)?.[1];
    if (!finalRecipient || finalRecipient.length > 254) continue;
    reports.push({ deliveryId: deliveryId.toLowerCase(), messageId, recipient: finalRecipient.toLowerCase(), status: block.get('status') });
  }
  return reports;
}
