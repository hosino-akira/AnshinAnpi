import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { audit } from './audit.js';
import { MailFailure } from './providers/aws-mail.js';

export async function updateCheck(db, checkId) {
  if (!checkId) return;
  const deliveries = (await db.query('SELECT status FROM mail_deliveries WHERE check_id=$1', [checkId])).rows;
  const statuses = deliveries.map(row => row.status);
  const accepted = statuses.filter(status => ['accepted', 'delivered', 'bounced'].includes(status)).length;
  const pending = statuses.some(status => ['queued', 'sending'].includes(status));
  const status = pending ? 'processing' : statuses.includes('unknown') ? 'unknown'
    : accepted === statuses.length && accepted > 0 ? 'accepted' : accepted > 0 ? 'partially_accepted'
      : statuses.every(status => status === 'cancelled') ? 'cancelled' : 'failed';
  await db.query(`UPDATE safety_checks SET status=$2,completed_at=CASE WHEN $3 THEN NULL ELSE clock_timestamp() END WHERE check_id=$1`, [checkId, status, pending]);
  if (accepted === statuses.length && accepted > 0) await db.query(`UPDATE users u SET status='active',registered_at=COALESCE(u.registered_at,clock_timestamp())
    FROM safety_checks c WHERE c.check_id=$1 AND c.user_id=u.user_id AND c.check_type='registration' AND u.status='pending_registration'`, [checkId]);
}

export class MailWorker {
  constructor(deps) { Object.assign(this, deps); this.busy = false; this.lastMaintenance = 0; }
  async claim() {
    return transaction(this.pool, async db => {
      const delivery = (await db.query(`SELECT d.delivery_id FROM mail_deliveries d
        WHERE d.status='queued' AND d.attempt_count<3 AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=clock_timestamp())
        ORDER BY d.created_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED`)).rows[0];
      if (!delivery) return null;
      await db.query(`UPDATE mail_deliveries SET status='sending',sending_started_at=clock_timestamp(),
        attempt_count=attempt_count+1,last_attempt_at=clock_timestamp(),next_attempt_at=NULL WHERE delivery_id=$1`, [delivery.delivery_id]);
      return delivery.delivery_id;
    });
  }
  async deliver(id) {
    const metadata = (await this.pool.query('SELECT user_id,recipient_id,check_id FROM mail_deliveries WHERE delivery_id=$1', [id])).rows[0];
    if (!metadata) return;
    return transaction(this.pool, async db => {
      // Parent -> check -> delivery lock order is shared with webhook processing.
      const user = (await db.query('SELECT * FROM users WHERE user_id=$1 FOR SHARE', [metadata.user_id])).rows[0];
      const recipient = (await db.query('SELECT * FROM recipients WHERE recipient_id=$1 FOR SHARE', [metadata.recipient_id])).rows[0];
      const check = (await db.query('SELECT * FROM safety_checks WHERE check_id=$1 FOR UPDATE', [metadata.check_id])).rows[0];
      const delivery = (await db.query('SELECT * FROM mail_deliveries WHERE delivery_id=$1 FOR UPDATE', [id])).rows[0];
      if (!delivery || delivery.status !== 'sending') return;
      const terminal = check && (await db.query('SELECT * FROM terminals WHERE terminal_id=$1 FOR SHARE', [check.terminal_id])).rows[0];
      const consent = check && (await db.query('SELECT * FROM consents WHERE consent_id=$1 FOR SHARE', [check.consent_id])).rows[0];
      const withdrawn = user && (await db.query(`SELECT 1 FROM consents WHERE user_id=$1 AND result='withdrawn'
        AND (consent_type='registration' OR consent_type=$2) AND consented_at >= $3 LIMIT 1`, [user.user_id, check?.check_type ?? 'safety', consent?.consented_at ?? new Date(0)])).rowCount;
      if (!user || !recipient || !check || !terminal || terminal.status !== 'active' || recipient.status !== 'active'
        || user.status !== (check.check_type === 'registration' && user.status === 'pending_registration' ? 'pending_registration' : 'active')
        || Date.parse(check.expires_at) <= Date.now() || consent?.result !== 'granted' || withdrawn || delivery.snapshot_erased_at) {
        await db.query(`UPDATE mail_deliveries SET status='cancelled',error_code='SEND_AUTHORIZATION_EXPIRED' WHERE delivery_id=$1`, [id]);
        await updateCheck(db, metadata.check_id);
        return;
      }
      const request = { id: randomUUID(), terminal };
      try {
        const result = await this.mail.send({ email: await this.cipher.open(delivery.encrypted_email_snapshot, 'recipient-email'),
          displayName: await this.cipher.open(user.display_name, 'user-name'), occurredAt: check.created_at,
          timezone: terminal.timezone, type: check.check_type, deliveryId: id });
        await db.query(`UPDATE mail_deliveries SET status='accepted',provider_message_id=$2,accepted_at=clock_timestamp(),error_code=NULL WHERE delivery_id=$1`, [id, result.messageId]);
        await audit(db, this.config, request, 'mail.accepted', 'delivery', id);
      } catch (error) {
        const failure = error instanceof MailFailure ? error : new MailFailure('MAIL_RESULT_UNKNOWN', { uncertain: true });
        const retry = failure.retryable && delivery.attempt_count < 3 && Date.parse(check.expires_at) > Date.now() + 5000;
        await db.query(`UPDATE mail_deliveries SET status=$2,error_code=$3,next_attempt_at=$4 WHERE delivery_id=$1`,
          [id, failure.uncertain ? 'unknown' : retry ? 'queued' : 'failed', failure.code,
            retry ? new Date(Date.now() + 1000 * 2 ** delivery.attempt_count) : null]);
        await audit(db, this.config, request, failure.uncertain ? 'mail.result_unknown' : 'mail.failed', 'delivery', id, 'failure', failure.code);
      }
      await updateCheck(db, check.check_id);
    });
  }
  async maintain() {
    // Reclaiming a crashed SES request by re-sending would risk a duplicate email.
    const stale = (await this.pool.query(`SELECT delivery_id,check_id FROM mail_deliveries WHERE status='sending'
      AND sending_started_at < clock_timestamp()-interval '45 seconds'`)).rows;
    for (const row of stale) await transaction(this.pool, async db => {
      if (row.check_id) await db.query('SELECT check_id FROM safety_checks WHERE check_id=$1 FOR UPDATE', [row.check_id]);
      const updated = await db.query(`UPDATE mail_deliveries SET status='unknown',error_code='MAIL_RESULT_UNKNOWN'
        WHERE delivery_id=$1 AND status='sending' AND sending_started_at < clock_timestamp()-interval '45 seconds'`, [row.delivery_id]);
      if (updated.rowCount) await updateCheck(db, row.check_id);
    });
  }
  async cleanFaces() {
    if (!this.face.ready) return;
    await transaction(this.pool, async db => {
      const row = (await db.query(`SELECT * FROM face_templates WHERE status='revoked' AND provider=$1
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [this.face.name])).rows[0];
      if (!row) return;
      await this.face.delete(await this.cipher.open(row.encrypted_template, 'face-reference'));
      await db.query("UPDATE face_templates SET status='deleted' WHERE template_id=$1", [row.template_id]);
    });
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (Date.now() - this.lastMaintenance > 60000) { await this.maintain(); await this.cleanFaces(); this.lastMaintenance = Date.now(); }
      if (this.mail.ready) {
        for (let i = 0; i < 4; i++) { const id = await this.claim(); if (!id) break; await this.deliver(id); }
      }
    } finally { this.busy = false; }
  }
  start(logger) {
    this.timer = setInterval(() => this.tick().catch(() => logger.error({ errorCode: 'WORKER_FAILED' }, 'worker_failed')), 1000);
    this.timer.unref();
  }
  async stop() {
    clearInterval(this.timer);
    const deadline = Date.now() + 30000;
    while (this.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  }
}
