import nodemailer from 'nodemailer';
import { MailFailure } from '../mail-failure.js';
import { mailMessage } from '../mail-message.js';

export function smtpOptions(config) {
  return {
    host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure,
    // Port 587 upgrades with STARTTLS; never continue with plaintext authentication.
    requireTLS: !config.smtpSecure,
    tls: { rejectUnauthorized: true },
    auth: { user: config.smtpUser, pass: config.smtpPassword },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, dnsTimeout: 10000,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
  };
}

export function smtpFailure(error) {
  if (error instanceof MailFailure) return error;
  if (error.code === 'EAUTH') return new MailFailure('MAIL_AUTH_REQUIRED');
  if (error.code === 'ETLS' || ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error.code))
    return new MailFailure('MAIL_TLS_FAILED');
  if (error.responseCode >= 400 && error.responseCode < 500)
    return new MailFailure('MAIL-002', { retryable: true });
  if (error.responseCode >= 500 && error.responseCode < 600)
    return new MailFailure('MAIL-001');
  if (['EDNS', 'ECONNECTION'].includes(error.code) || (['ESOCKET', 'ETIMEDOUT'].includes(error.code) && error.command === 'CONN'))
    return new MailFailure('MAIL-002', { retryable: true });
  // A dropped connection during DATA may have happened after the server accepted it.
  return new MailFailure('MAIL_RESULT_UNKNOWN', { uncertain: true });
}

export class SmtpMailProvider {
  name = 'smtp';
  constructor(config, transport) {
    this.config = config;
    this.ready = Boolean(config.smtpHost && config.smtpPort && config.smtpUser && config.smtpPassword && config.smtpFrom);
    this.transport = transport ?? nodemailer.createTransport(smtpOptions(config));
  }
  async verify() {
    if (!this.ready) throw new MailFailure('MAIL_CONFIG_REQUIRED');
    try { await this.transport.verify(); }
    catch (error) { throw smtpFailure(error); }
  }
  async send(message) {
    if (!this.ready) throw new MailFailure('MAIL_CONFIG_REQUIRED');
    const content = mailMessage(this.config, message);
    // The same delivery retains its Message-ID on an explicit retry. This is not
    // an SMTP idempotency guarantee; uncertain outcomes are still never retried.
    const messageId = `<${message.deliveryId}@${this.config.smtpFrom.split('@')[1]}>`;
    try {
      const result = await this.transport.sendMail({
        from: { name: '安心安否確認', address: this.config.smtpFrom },
        to: [{ address: message.email }],
        envelope: { from: this.config.smtpFrom, to: [message.email] },
        ...(this.config.smtpReplyTo ? { replyTo: this.config.smtpReplyTo } : {}),
        subject: content.subject, text: content.text, date: new Date(message.occurredAt), messageId,
        headers: { 'X-Anshin-Delivery-Id': message.deliveryId, 'Auto-Submitted': 'auto-generated' },
      });
      if (result.rejected?.length) throw new MailFailure('MAIL-001');
      if (!result.accepted?.some(address => address.toLowerCase() === message.email.toLowerCase()) || !result.messageId)
        throw new MailFailure('MAIL_RESULT_UNKNOWN', { uncertain: true });
      return { messageId: result.messageId };
    } catch (error) { throw smtpFailure(error); }
  }
  close() { this.transport.close(); }
}
