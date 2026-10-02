import { randomUUID } from 'node:crypto';
import { token, sha256, lookup } from './crypto.js';
import { fail, unavailable } from './errors.js';
import { audit } from './audit.js';
import { transaction } from './db.js';
import { maskEmail } from './validation.js';

export class UserService {
  constructor(deps) { Object.assign(this, deps); }
  async policy(db, type, version) {
    const row = (await db.query(`SELECT * FROM consent_policies WHERE consent_type=$1 AND status='published' FOR SHARE`, [type])).rows[0];
    if (!row) fail(503, 'POLICY_NOT_AVAILABLE', '同意文面を準備中です。');
    if (version && row.policy_version !== version) fail(409, 'POLICY_VERSION_CHANGED', '最新の同意文面をご確認ください。');
    return row;
  }
  async draft(request, id) {
    const draft = await this.store.get('draft', id);
    if (!draft || draft.terminalId !== request.terminal.terminal_id) fail(410, 'TIME-001', '操作時間が過ぎたため終了しました。');
    if (Date.now() - Date.parse(draft.lastActivityAt) > this.config.idleTtlSeconds * 1000) {
      await this.store.remove('draft', id);
      fail(410, 'TIME-001', '操作時間が過ぎたため終了しました。');
    }
    draft.lastActivityAt = new Date().toISOString();
    return draft;
  }
  async session(request, db, purpose, { confirmed = false } = {}) {
    const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!bearer) fail(401, 'USER_SESSION_REQUIRED', '顔を確認してから操作してください。');
    const owner = (await db.query('SELECT user_id FROM api_sessions WHERE token_sha256=$1 AND terminal_id=$2', [sha256(bearer), request.terminal.terminal_id])).rows[0];
    if (owner) await db.query('SELECT user_id FROM users WHERE user_id=$1 FOR SHARE', [owner.user_id]);
    const row = (await db.query(`SELECT s.*, u.status AS user_status FROM api_sessions s JOIN users u USING(user_id)
      WHERE s.token_sha256=$1 AND s.terminal_id=$2 FOR UPDATE OF s`, [sha256(bearer), request.terminal.terminal_id])).rows[0];
    if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()
      || Date.now() - Date.parse(row.last_activity_at) > this.config.idleTtlSeconds * 1000
      || (purpose && row.purpose !== purpose)
      || !['active', 'pending_registration'].includes(row.user_status)
      || (row.purpose === 'safety' && row.user_status !== 'active')) fail(401, 'USER_SESSION_EXPIRED', 'もう一度、顔を確認してください。');
    if (confirmed && !row.confirmed_at) fail(403, 'IDENTITY_CONFIRMATION_REQUIRED', 'ご本人のお名前をご確認ください。');
    await db.query('UPDATE api_sessions SET last_activity_at=clock_timestamp() WHERE session_id=$1', [row.session_id]);
    return row;
  }
  async newSession(db, request, userId, purpose, verificationId = null) {
    const raw = token(); const expiresAt = new Date(Date.now() + this.config.verificationTtlSeconds * 1000);
    await db.query(`INSERT INTO api_sessions(token_sha256,terminal_id,user_id,purpose,verification_id,expires_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [sha256(raw), request.terminal.terminal_id, userId, purpose, verificationId, expiresAt]);
    return { user_token: raw, expires_at: expiresAt.toISOString() };
  }
  async createDraft(request, ctx) {
    await this.policy(ctx.db, 'registration');
    const id = randomUUID(); const expiry = new Date(Date.now() + this.config.draftTtlSeconds * 1000).toISOString();
    await this.store.put('draft', id, { id, userId: randomUUID(), terminalId: request.terminal.terminal_id,
      expiresAt: expiry, lastActivityAt: new Date().toISOString(), recipients: [] }, expiry);
    await audit(ctx.db, this.config, request, 'enrollment.started', 'enrollment', id);
    return { status: 201, body: { temp_id: id, expires_at: expiry } };
  }
  async getDraft(request, id) {
    const completed = (await this.pool.query(`SELECT e.user_id,u.status FROM api_enrollments e JOIN users u USING(user_id)
      WHERE temp_id=$1 AND terminal_id=$2`, [id, request.terminal.terminal_id])).rows[0];
    if (completed) return { temp_id: id, status: completed.status };
    return this.store.lock('draft', id, async () => {
      const draft = await this.draft(request, id);
      const consent = (await this.pool.query(`SELECT consent_id FROM consents WHERE temp_id=$1 AND terminal_id=$2 AND result='granted'`, [id, request.terminal.terminal_id])).rows[0];
      await this.store.put('draft', id, draft, draft.expiresAt);
      return { temp_id: id, expires_at: draft.expiresAt, has_face: Boolean(draft.image), has_profile: Boolean(draft.displayName),
        consent_granted: Boolean(consent), recipients: draft.recipients.map(x => ({ name: x.name, masked_email: maskEmail(x.email) })) };
    });
  }
  async changeDraft(request, id, action) {
    return this.store.lock('draft', id, async () => {
      const draft = await this.draft(request, id);
      await action(draft);
      await this.store.put('draft', id, draft, draft.expiresAt);
      return { body: { temp_id: id, expires_at: draft.expiresAt } };
    });
  }
  async setProfile(request, id, body) { return this.changeDraft(request, id, draft => { draft.displayName = body.display_name; }); }
  async setRecipients(request, id, body, ctx) {
    return this.changeDraft(request, id, async draft => {
      const consent = (await ctx.db.query(`SELECT consent_id FROM consents WHERE temp_id=$1 AND terminal_id=$2 AND result='granted'`, [id, request.terminal.terminal_id])).rows[0];
      if (!consent) fail(409, 'REGISTRATION_CONSENT_REQUIRED', '個人情報の取扱いに同意してください。');
      draft.recipients = body.recipients;
    });
  }
  async consentDraft(request, id, body, ctx) {
    return this.store.lock('draft', id, async () => {
      const draft = await this.draft(request, id);
      if (body.result === 'granted' && (!draft.displayName || !draft.image)) fail(409, 'ENROLLMENT_INCOMPLETE', '顔とお名前を入力してから同意してください。');
      await this.policy(ctx.db, 'registration', body.policy_version);
      const existing = (await ctx.db.query(`SELECT * FROM consents WHERE temp_id=$1 AND terminal_id=$2 AND consent_type='registration'`, [id, request.terminal.terminal_id])).rows[0];
      if (existing) {
        if (existing.policy_version !== body.policy_version || existing.result !== body.result) fail(409, 'CONSENT_ALREADY_RECORDED', '登録を中止し、最初から操作してください。');
        return { body: { consent_id: existing.consent_id, result: existing.result } };
      }
      const result = await ctx.db.query(`INSERT INTO consents(temp_id,consent_type,policy_version,terminal_id,result,request_id)
        VALUES($1,'registration',$2,$3,$4,$5) RETURNING consent_id`, [id, body.policy_version, request.terminal.terminal_id, body.result, request.id]);
      if (body.result === 'denied') await this.store.remove('draft', id);
      else await this.store.put('draft', id, draft, draft.expiresAt);
      await audit(ctx.db, this.config, request, 'consent.registration', 'consent', result.rows[0].consent_id, body.result === 'granted' ? 'success' : 'denied');
      return { body: { consent_id: result.rows[0].consent_id, result: body.result } };
    });
  }
  async cancelDraft(request, id, ctx) {
    return this.store.lock('draft', id, async () => {
    const completed = (await ctx.db.query('SELECT user_id FROM api_enrollments WHERE temp_id=$1 AND terminal_id=$2', [id, request.terminal.terminal_id])).rows[0];
    if (completed) fail(409, 'ENROLLMENT_ALREADY_PERSISTED', '登録済みです。スタッフへお声がけください。');
    await this.draft(request, id);
    await this.store.remove('draft', id);
    await audit(ctx.db, this.config, request, 'enrollment.cancelled', 'enrollment', id);
    return { body: { cancelled: true } };
    });
  }
  async createLiveness(request, body, ctx) {
    await this.store.checkCooldown(request.terminal.terminal_id);
    let userSession;
    if (body.purpose === 'enrollment') await this.draft(request, body.enrollment_id);
    if (body.purpose === 'registration') userSession = await this.session(request, ctx.db, 'registration');
    const result = await this.face.createLiveness(randomUUID());
    const expiresAt = new Date(Date.now() + 175000).toISOString();
    await this.store.put('liveness', result.sessionId, { terminalId: request.terminal.terminal_id, purpose: body.purpose,
      enrollmentId: body.enrollment_id ?? null, sessionId: userSession?.session_id ?? null }, expiresAt);
    return { status: 201, body: { liveness_session_id: result.sessionId, region: result.region, expires_at: expiresAt } };
  }
  async capture(request, sessionId, purpose, ctx, subjectId = null) {
    await this.store.checkCooldown(request.terminal.terminal_id);
    return this.store.lock('liveness', sessionId, async () => {
      const record = await this.store.get('liveness', sessionId);
      if (!record || record.terminalId !== request.terminal.terminal_id || record.purpose !== purpose
        || (purpose === 'enrollment' && record.enrollmentId !== subjectId)
        || (purpose === 'registration' && record.sessionId !== subjectId)) fail(410, 'LIVENESS_SESSION_EXPIRED', 'もう一度、顔を撮影してください。');
      try {
        const captured = await this.face.capture(sessionId);
        await this.store.remove('liveness', sessionId);
        return captured;
      } catch (error) {
        if (error.status === 422) {
          await this.store.remove('liveness', sessionId);
          await this.store.failure(request.terminal.terminal_id);
          ctx.rollbacks.push(() => transaction(this.pool, db => audit(db, this.config, request, 'face.rejected', 'terminal', request.terminal.terminal_id, 'failure', error.code)));
        }
        throw error;
      }
    });
  }
  async setFace(request, id, body, ctx) {
    return this.changeDraft(request, id, async draft => {
      const { image } = await this.capture(request, body.liveness_session_id, 'enrollment', ctx, id);
      try { draft.image = image.toString('base64'); } finally { image.fill(0); }
    });
  }
  async completeDraft(request, id, ctx) {
    return this.store.lock('draft', id, async () => {
      const draft = await this.draft(request, id);
      if (!draft.displayName || !draft.image || draft.recipients.length < 1) fail(409, 'ENROLLMENT_INCOMPLETE', '登録内容をご確認ください。');
      const consent = (await ctx.db.query(`SELECT * FROM consents WHERE temp_id=$1 AND terminal_id=$2 AND result='granted' FOR UPDATE`, [id, request.terminal.terminal_id])).rows[0];
      if (!consent) fail(409, 'REGISTRATION_CONSENT_REQUIRED', '個人情報の取扱いに同意してください。');
      await this.policy(ctx.db, 'registration', consent.policy_version);
      this.face.requireReady();
      await this.pool.query(`INSERT INTO face_index_leases(user_id,terminal_id,expires_at) VALUES($1,$2,$3)
        ON CONFLICT(user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`, [draft.userId, request.terminal.terminal_id, draft.expiresAt]);
      const image = Buffer.from(draft.image, 'base64');
      let reference;
      try { reference = await this.face.index(image, draft.userId); } finally { image.fill(0); }
      ctx.rollbacks.push(async () => {
        await this.face.delete(reference);
        await this.pool.query('DELETE FROM face_index_leases WHERE user_id=$1', [draft.userId]);
      });
      await ctx.db.query(`INSERT INTO users(user_id,facility_id,encrypted_display_name,display_name_lookup_hmac,encryption_key_id,lookup_key_id)
        VALUES($1,$2,$3,$4,$5,$6)`, [draft.userId, request.terminal.facility_id,
        await this.cipher.seal(draft.displayName, 'user-name'), lookup(this.config, draft.displayName), this.cipher.keyId, this.config.lookupKeyId]);
      for (const [index, recipient] of draft.recipients.entries()) {
        await ctx.db.query(`INSERT INTO recipients(user_id,encrypted_name,encrypted_email,email_lookup_hmac,encryption_key_id,lookup_key_id,order_no)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [draft.userId, await this.cipher.seal(recipient.name, 'recipient-name'),
          await this.cipher.seal(recipient.email, 'recipient-email'), lookup(this.config, recipient.email), this.cipher.keyId, this.config.lookupKeyId, index + 1]);
      }
      await ctx.db.query(`INSERT INTO face_templates(user_id,encrypted_template,encryption_key_id,provider,model_version,threshold_version,template_format)
        VALUES($1,$2,$3,$4,$5,$6,'provider_reference')`, [draft.userId, await this.cipher.seal(reference, 'face-reference'),
        this.cipher.keyId, this.face.name, reference.modelVersion, this.config.thresholdVersion]);
      await ctx.db.query('UPDATE consents SET user_id=$1,temp_id=NULL WHERE consent_id=$2', [draft.userId, consent.consent_id]);
      await ctx.db.query('INSERT INTO api_enrollments(temp_id,user_id,terminal_id) VALUES($1,$2,$3)', [id, draft.userId, request.terminal.terminal_id]);
      const session = await this.newSession(ctx.db, request, draft.userId, 'registration');
      await audit(ctx.db, this.config, request, 'enrollment.completed', 'user', draft.userId);
      ctx.commits.push(async () => { await this.store.remove('draft', id); await this.pool.query('DELETE FROM face_index_leases WHERE user_id=$1', [draft.userId]); });
      return { status: 201, body: { user_id: draft.userId, status: 'pending_registration', ...session } };
    }, ctx);
  }
  async candidates(db, found, onlyUserId = null) {
    const ids = [...new Set(found.candidates.map(c => c.userId).filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? '')))];
    if (!ids.length) return [];
    const templates = (await db.query(`SELECT t.*,u.status FROM face_templates t JOIN users u USING(user_id)
      WHERE t.user_id=ANY($1::uuid[]) AND t.status='active' AND (u.status='active' OR u.user_id=$2)`, [ids, onlyUserId])).rows;
    const valid = [];
    for (const template of templates) {
      const ref = await this.cipher.open(template.encrypted_template, 'face-reference');
      const candidate = found.candidates.find(c => c.userId === template.user_id && c.faceId === ref.faceId);
      if (candidate && Number.isFinite(candidate.score) && (!onlyUserId || candidate.userId === onlyUserId)) valid.push({ ...candidate, templateId: template.template_id });
    }
    return valid.sort((a, b) => b.score - a.score);
  }
  async verify(request, body, ctx, purpose) {
    const session = purpose === 'registration' ? await this.session(request, ctx.db, 'registration') : null;
    if (session?.consumed_by_check_id) fail(409, 'SESSION_ALREADY_USED', '登録確認メールの結果をご確認ください。');
    const capture = await this.capture(request, body.liveness_session_id, purpose, ctx, session?.session_id);
    let found;
    try { found = await this.face.search(capture.image); } finally { capture.image.fill(0); }
    const candidates = await this.candidates(ctx.db, found, session?.user_id);
    const first = candidates[0]; const second = candidates[1];
    const margin = purpose === 'registration' ? 0 : this.config.requiredMargin;
    const matched = first && first.score >= this.config.matchThreshold && (!second || first.score - second.score >= margin);
    const result = matched ? 'matched' : first?.score >= this.config.matchThreshold ? 'ambiguous' : 'no_match';
    const userId = matched ? first.userId : session?.user_id ?? null;
    const verified = await ctx.db.query(`INSERT INTO face_verifications(user_id,template_id,terminal_id,purpose,result,match_score,
        runner_up_score,threshold,required_margin,model_version,threshold_version,quality_passed,liveness_passed,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,true,$12) RETURNING verification_id,verified_at`,
      [userId, matched ? first.templateId : null, request.terminal.terminal_id, purpose, result, first?.score ?? null,
        second?.score ?? null, this.config.matchThreshold, margin, found.modelVersion, this.config.thresholdVersion, request.id]);
    await audit(ctx.db, this.config, request, `face.${purpose}`, 'verification', verified.rows[0].verification_id, matched ? 'success' : 'failure', matched ? null : 'FACE-003');
    if (!matched) {
      const attempts = await this.store.failure(request.terminal.terminal_id);
      return { body: { result, attempts_remaining: Math.max(0, 3 - attempts) } };
    }
    await this.store.clearFailures(request.terminal.terminal_id);
    const user = (await ctx.db.query('SELECT encrypted_display_name FROM users WHERE user_id=$1', [userId])).rows[0];
    let credentials;
    if (session) {
      await ctx.db.query('UPDATE api_sessions SET revoked_at=clock_timestamp() WHERE session_id=$1', [session.session_id]);
    }
    credentials = await this.newSession(ctx.db, request, userId, purpose, verified.rows[0].verification_id);
    return { body: { result: 'matched', display_name: await this.cipher.open(user.encrypted_display_name, 'user-name'), ...credentials } };
  }
  async confirmIdentity(request, body, ctx) {
    const session = await this.session(request, ctx.db);
    if (!session.verification_id) fail(409, 'FACE_VERIFICATION_REQUIRED', '顔を確認してください。');
    if (!body.confirmed) {
      await ctx.db.query('UPDATE api_sessions SET revoked_at=clock_timestamp() WHERE session_id=$1', [session.session_id]);
      await audit(ctx.db, this.config, request, 'identity.rejected', 'session', session.session_id, 'denied');
      return { body: { confirmed: false, session_ended: true } };
    }
    await ctx.db.query('UPDATE api_sessions SET confirmed_at=clock_timestamp() WHERE session_id=$1', [session.session_id]);
    await audit(ctx.db, this.config, request, 'identity.confirmed', 'session', session.session_id);
    return { body: { confirmed: true } };
  }
  async getRecipients(request) {
    return transaction(this.pool, async db => {
      const session = await this.session(request, db, null, { confirmed: true });
      const rows = (await db.query(`SELECT * FROM recipients WHERE user_id=$1 AND status <> 'deleted' ORDER BY order_no`, [session.user_id])).rows;
      const recipients = [];
      for (const row of rows) recipients.push({ recipient_id: row.recipient_id, name: await this.cipher.open(row.encrypted_name, 'recipient-name'),
        masked_email: maskEmail(await this.cipher.open(row.encrypted_email, 'recipient-email')), status: row.status });
      return { recipients };
    });
  }
  async queueSend(request, ctx, purpose, body = {}, enrollmentId = null) {
    if (!this.mail.ready) unavailable('メール送信サービス');
    const session = await this.session(request, ctx.db, purpose, { confirmed: true });
    if (session.consumed_by_check_id) fail(409, 'SESSION_ALREADY_USED', '送信済みの結果をご確認ください。');
    const user = (await ctx.db.query('SELECT * FROM users WHERE user_id=$1 FOR SHARE', [session.user_id])).rows[0];
    let consent;
    if (purpose === 'registration') {
      const enrollment = (await ctx.db.query(`SELECT * FROM api_enrollments WHERE temp_id=$1 AND user_id=$2 AND terminal_id=$3 FOR UPDATE`, [enrollmentId, session.user_id, request.terminal.terminal_id])).rows[0];
      if (!enrollment || enrollment.confirmation_check_id) fail(409, 'REGISTRATION_MAIL_ALREADY_STARTED', '登録確認メールの結果をご確認ください。');
      consent = (await ctx.db.query(`SELECT * FROM consents WHERE user_id=$1 AND consent_type='registration' AND result='granted' ORDER BY consented_at DESC LIMIT 1`, [session.user_id])).rows[0];
      if (!consent) fail(409, 'REGISTRATION_CONSENT_REQUIRED', '個人情報の取扱いをご確認ください。');
      await this.policy(ctx.db, 'registration', consent.policy_version);
    } else {
      await this.policy(ctx.db, 'safety', body.policy_version);
      const registrationPolicy = await this.policy(ctx.db, 'registration');
      if (registrationPolicy.requires_reconsent && !(await ctx.db.query(`SELECT 1 FROM consents WHERE user_id=$1 AND consent_type='registration' AND result='granted' AND policy_version=$2`, [session.user_id, registrationPolicy.policy_version])).rowCount) {
        fail(409, 'RECONSENT_REQUIRED', '個人情報の取扱いへの再同意が必要です。スタッフへお声がけください。');
      }
      consent = (await ctx.db.query(`INSERT INTO consents(user_id,consent_type,policy_version,terminal_id,result,request_id)
        VALUES($1,'safety',$2,$3,'granted',$4) RETURNING *`, [session.user_id, body.policy_version, request.terminal.terminal_id, request.id])).rows[0];
    }
    const verification = (await ctx.db.query('SELECT * FROM face_verifications WHERE verification_id=$1', [session.verification_id])).rows[0];
    if (!verification || Date.now() - Date.parse(verification.verified_at) >= this.config.verificationTtlSeconds * 1000) fail(401, 'FACE_VERIFICATION_EXPIRED', 'もう一度、顔を確認してください。');
    const recipients = (await ctx.db.query(`SELECT * FROM recipients WHERE user_id=$1 AND status='active' ORDER BY order_no FOR SHARE`, [user.user_id])).rows;
    if (!recipients.length) fail(409, 'NO_ACTIVE_RECIPIENT', '送信先をご確認ください。スタッフへお声がけください。');
    const check = (await ctx.db.query(`INSERT INTO safety_checks(user_id,terminal_id,check_type,verification_id,verified_at,consent_id,idempotency_key,request_sha256,expires_at)
      VALUES($1,$2,$3,$4,(SELECT verified_at FROM face_verifications WHERE verification_id=$4),$5,$6,$7,$8) RETURNING check_id`, [user.user_id, request.terminal.terminal_id, purpose,
      verification.verification_id, consent.consent_id, ctx.key, ctx.hash, session.expires_at])).rows[0];
    const recipientResults = [];
    for (const recipient of recipients) {
      const delivery = (await ctx.db.query(`INSERT INTO mail_deliveries(check_id,user_id,recipient_id,recipient_order_no,encrypted_email_snapshot,encryption_key_id,provider,next_attempt_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,current_timestamp) RETURNING delivery_id`, [check.check_id, user.user_id, recipient.recipient_id,
        recipient.order_no, recipient.encrypted_email, recipient.encryption_key_id, this.mail.name])).rows[0];
      recipientResults.push({ delivery_id: delivery.delivery_id, recipient_id: recipient.recipient_id, status: 'queued' });
    }
    await ctx.db.query('UPDATE api_sessions SET consumed_by_check_id=$1 WHERE session_id=$2', [check.check_id, session.session_id]);
    if (purpose === 'registration') await ctx.db.query('UPDATE api_enrollments SET confirmation_check_id=$1 WHERE temp_id=$2', [check.check_id, enrollmentId]);
    await audit(ctx.db, this.config, request, 'mail.queued', 'safety_check', check.check_id);
    return { status: 202, body: { check_id: check.check_id, status: 'queued', recipient_results: recipientResults } };
  }
  async getCheck(request, id) {
    return transaction(this.pool, async db => {
      const session = await this.session(request, db);
      const check = (await db.query('SELECT * FROM safety_checks WHERE check_id=$1 AND user_id=$2 AND terminal_id=$3', [id, session.user_id, request.terminal.terminal_id])).rows[0];
      if (!check) fail(404, 'NOT_FOUND', '送信結果が見つかりません。');
      const deliveries = (await db.query(`SELECT delivery_id,recipient_id,status,attempt_count,accepted_at,delivered_at,bounced_at,error_code FROM mail_deliveries WHERE check_id=$1 ORDER BY recipient_order_no`, [id])).rows;
      return { check_id: id, type: check.check_type, status: check.status, created_at: check.created_at,
        completed_at: check.completed_at, recipient_results: deliveries };
    });
  }
  async retryCheck(request, id, ctx) {
    if (!this.mail.ready) unavailable('メール送信サービス');
    const session = await this.session(request, ctx.db, null, { confirmed: true });
    const check = (await ctx.db.query('SELECT * FROM safety_checks WHERE check_id=$1 AND user_id=$2 AND terminal_id=$3 FOR UPDATE', [id, session.user_id, request.terminal.terminal_id])).rows[0];
    if (!check || Date.parse(check.expires_at) <= Date.now()) fail(409, 'SEND_WINDOW_EXPIRED', '送信できる時間が過ぎました。最初から操作してください。');
    const result = await ctx.db.query(`UPDATE mail_deliveries d SET status='queued',next_attempt_at=clock_timestamp(),error_code=NULL
      FROM recipients r WHERE d.check_id=$1 AND d.recipient_id=r.recipient_id AND r.status='active'
      AND d.status='failed' AND d.error_code='MAIL-002' AND d.attempt_count<3 RETURNING d.delivery_id`, [id]);
    if (!result.rowCount) fail(409, 'NO_RETRYABLE_DELIVERY', '再送できる送信先はありません。スタッフへお声がけください。');
    await ctx.db.query(`UPDATE safety_checks SET status='queued',completed_at=NULL WHERE check_id=$1`, [id]);
    await audit(ctx.db, this.config, request, 'mail.retry_requested', 'safety_check', id);
    return { status: 202, body: { check_id: id, status: 'queued', retried_delivery_ids: result.rows.map(row => row.delivery_id) } };
  }
  async endSession(request, ctx) {
    const session = await this.session(request, ctx.db);
    await ctx.db.query('UPDATE api_sessions SET revoked_at=clock_timestamp() WHERE session_id=$1', [session.session_id]);
    await audit(ctx.db, this.config, request, 'session.ended', 'session', session.session_id);
    return { body: { session_ended: true } };
  }
}
