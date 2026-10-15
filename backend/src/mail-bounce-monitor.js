import { createHash, randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { transaction } from './db.js';
import { audit } from './audit.js';
import { updateCheck } from './mail-worker.js';
import { MAX_BOUNCE_BYTES, parseBounceReport } from './bounce-report.js';

export function bounceImapOptions(config) {
  return {
    host: config.bounceHost, port: config.bouncePort, secure: true,
    auth: { user: config.bounceUser, pass: config.bouncePassword },
    tls: { rejectUnauthorized: true }, logger: false, logRaw: false,
    disableAutoIdle: true, disableCompression: true,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  };
}

export class MailBounceMonitor {
  constructor(deps, createClient = options => new ImapFlow(options)) {
    Object.assign(this, deps);
    this.createClient = createClient;
    this.stopped = false;
    this.checkpointKey = `mail.bounce.${createHash('sha256').update(JSON.stringify([
      this.config.bounceHost, this.config.bouncePort, this.config.bounceUser, this.config.bounceMailbox,
    ])).digest('hex')}`;
  }

  async applyReport(report) {
    return transaction(this.pool, async db => {
      const metadata = (await db.query("SELECT user_id,recipient_id,check_id FROM mail_deliveries WHERE delivery_id=$1 AND provider='smtp'", [report.deliveryId])).rows[0];
      if (!metadata?.user_id || !metadata.check_id) return false;
      // 管理画面の編集と同じく、利用者 → 連絡先 → 確認記録 → 配信記録の順でロックします。
      const user = (await db.query('SELECT * FROM users WHERE user_id=$1 FOR UPDATE', [metadata.user_id])).rows[0];
      const recipient = metadata.recipient_id && (await db.query('SELECT * FROM recipients WHERE recipient_id=$1 FOR UPDATE', [metadata.recipient_id])).rows[0];
      const check = (await db.query('SELECT * FROM safety_checks WHERE check_id=$1 FOR UPDATE', [metadata.check_id])).rows[0];
      const delivery = (await db.query('SELECT * FROM mail_deliveries WHERE delivery_id=$1 FOR UPDATE', [report.deliveryId])).rows[0];
      if (!user || user.status === 'deleted' || !check || !delivery || delivery.provider !== 'smtp'
        || !['accepted', 'unknown', 'delivered'].includes(delivery.status)
        || !delivery.encrypted_email_snapshot || delivery.snapshot_erased_at) return false;
      const expectedMessageId = delivery.provider_message_id ?? `<${report.deliveryId}@${this.config.smtpFrom.split('@')[1]}>`;
      if (report.messageId && report.messageId !== expectedMessageId) return false;
      const sentAddress = await this.cipher.open(delivery.encrypted_email_snapshot, 'recipient-email');
      if (sentAddress.toLowerCase() !== report.recipient) return false;
      const occurredAt = new Date();
      await db.query(`UPDATE mail_deliveries SET status='bounced',bounced_at=$2,error_code=$3,
        provider_message_id=COALESCE(provider_message_id,$4),next_attempt_at=NULL WHERE delivery_id=$1`,
      [report.deliveryId, occurredAt, `SMTP_DSN_${report.status}`, expectedMessageId]);
      // 修正前の宛先への退信で、修正済みの連絡先を無効にしません。
      if (recipient && recipient.status !== 'deleted'
        && (await this.cipher.open(recipient.encrypted_email, 'recipient-email')).toLowerCase() === report.recipient) {
        await db.query(`UPDATE recipients SET status='needs_correction',last_bounced_at=$2,bounce_count=bounce_count+1 WHERE recipient_id=$1`,
          [recipient.recipient_id, occurredAt]);
      }
      await updateCheck(db, metadata.check_id);
      await audit(db, this.config, { id: randomUUID(), terminal: { terminal_id: check.terminal_id } },
        'mail.smtp.bounced', 'delivery', report.deliveryId, 'failure', `SMTP_DSN_${report.status}`);
      return true;
    });
  }

  async poll() {
    if (!this.config.bounceEnabled || this.stopped) return { scanned: 0, bounced: 0 };
    const checkpoint = (await this.pool.query('SELECT document FROM app_meta.admin_settings WHERE setting_key=$1', [this.checkpointKey])).rows[0]?.document;
    const client = this.createClient(bounceImapOptions(this.config));
    this.client = client;
    // IMAP エラーにはサーバーの応答や宛先が含まれるため、元のエラーをログに出しません。
    client.on('error', () => {});
    const deadline = setTimeout(() => client.close(), 45000);
    let lock;
    try {
      await client.connect();
      lock = await client.getMailboxLock(this.config.bounceMailbox, { readOnly: true });
      if (!client.mailbox.readOnly) throw new Error('MAIL_BOUNCE_READ_ONLY_REQUIRED');
      const validity = String(client.mailbox.uidValidity);
      // さくらの読み取り専用 EXAMINE などでは UIDNEXT が省略される場合があります。
      // STATUS で取得し、未定義の値から無効な走査位置を作らないようにします。
      let nextUid = client.mailbox.uidNext;
      if (!Number.isSafeInteger(nextUid) || nextUid < 1) {
        const status = await client.status(this.config.bounceMailbox, { uidNext: true, uidValidity: true });
        if (String(status.uidValidity) !== validity) throw new Error('MAIL_BOUNCE_UIDVALIDITY_CHANGED');
        nextUid = status.uidNext;
      }
      if (!Number.isSafeInteger(nextUid) || nextUid < 1) throw new Error('MAIL_BOUNCE_UIDNEXT_MISSING');
      const maxUid = nextUid - 1;
      const resume = checkpoint?.uidValidity === validity && Number.isSafeInteger(checkpoint.lastUid) && checkpoint.lastUid >= 0;
      let lastUid = resume ? checkpoint.lastUid : 0;
      const since = new Date(Date.now() - this.config.bounceLookbackDays * 86400000);
      const uids = lastUid < maxUid ? (await client.search({ uid: `${lastUid + 1}:${maxUid}`, ...(!resume ? { since } : {}) }, { uid: true }) || []) : [];
      const pending = uids.filter(uid => uid > lastUid && uid <= maxUid).sort((a, b) => a - b);
      const batch = pending.slice(0, 50);
      const metadata = batch.length ? await client.fetchAll(batch, { uid: true, size: true, bodyStructure: true }, { uid: true }) : [];
      let bounced = 0;
      for (const message of metadata.sort((a, b) => a.uid - b.uid)) {
        if (this.stopped) throw new Error('MAIL_BOUNCE_STOPPED');
        if (message.bodyStructure?.type?.toLowerCase() !== 'multipart/report' || message.bodyStructure.parameters?.['report-type']?.toLowerCase() !== 'delivery-status') continue;
        if (!Number.isFinite(message.size) || message.size > MAX_BOUNCE_BYTES) {
          this.logger?.warn({ errorCode: 'MAIL_BOUNCE_TOO_LARGE' }, 'mail_bounce_skipped');
          continue;
        }
        const fetched = await client.fetchOne(message.uid, { source: { maxLength: MAX_BOUNCE_BYTES + 1 } }, { uid: true });
        if (!fetched) continue; // Another mail client may have removed it.
        if (!fetched.source) throw new Error('MAIL_BOUNCE_SOURCE_MISSING');
        let reports;
        try { reports = await parseBounceReport(fetched.source); }
        catch {
          this.logger?.warn({ errorCode: 'MAIL_BOUNCE_INVALID_REPORT' }, 'mail_bounce_skipped');
          continue;
        }
        for (const report of reports) if (await this.applyReport(report)) bounced += 1;
      }
      // DB 更新がすべて成功した後に走査位置を保存し、異常終了後も安全に再処理します。
      lastUid = pending.length > batch.length ? batch.at(-1) : Math.max(lastUid, maxUid);
      await this.pool.query(`INSERT INTO app_meta.admin_settings(setting_key,document) VALUES($1,$2::jsonb)
        ON CONFLICT(setting_key) DO UPDATE SET document=EXCLUDED.document,updated_at=clock_timestamp()`,
      [this.checkpointKey, JSON.stringify({ uidValidity: validity, lastUid, lastPolledAt: new Date().toISOString() })]);
      return { scanned: batch.length, bounced };
    } finally {
      clearTimeout(deadline);
      lock?.release();
      await client.logout().catch(() => client.close());
      this.client = null;
    }
  }

  tick() {
    if (this.active || this.stopped) return;
    this.active = this.poll().then(result => {
      if (result.bounced) this.logger?.info({ count: result.bounced }, 'mail_bounces_recorded');
    }).catch(() => {
      if (!this.stopped) this.logger?.error({ errorCode: 'MAIL_BOUNCE_MONITOR_FAILED' }, 'mail_bounce_monitor_failed');
    }).finally(() => { this.active = null; });
  }

  start(logger) {
    if (!this.config.bounceEnabled) return;
    this.logger = logger;
    this.timer = setInterval(() => this.tick(), this.config.bouncePollSeconds * 1000);
    this.timer.unref();
    logger.info({ pollSeconds: this.config.bouncePollSeconds }, 'mail_bounce_monitor_started');
    this.tick();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.client?.close();
    await this.active;
  }
}
