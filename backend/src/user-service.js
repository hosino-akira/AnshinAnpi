import { randomUUID } from 'node:crypto';
import { fail, unavailable } from './errors.js';
import { audit } from './audit.js';
import { transaction } from './db.js';
import { publishedPolicy } from './admin-settings.js';
import { maskEmail } from './validation.js';

export class UserService {
  constructor(deps) { Object.assign(this, deps); }
  async policy(db, type, version) { return publishedPolicy(db, this.policies, type, version); }
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
    let userId = request.body?.user_id ?? request.query?.user_id;
    const path = request.routeOptions.url;
    if (path.startsWith('/v1/users/:id/')) userId = request.params.id;
    if (!userId && path.includes('confirmation-mails'))
      userId = (await db.query('SELECT user_id FROM users WHERE temp_id=$1', [request.params.id])).rows[0]?.user_id;
    if (!userId && (path.includes('mail-results/') || path.includes('safety-checks/')))
      userId = (await db.query('SELECT user_id FROM safety_checks WHERE check_id=$1', [request.params.id])).rows[0]?.user_id;
    if (typeof userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId))
      fail(400, 'USER_ID_REQUIRED', '利用者IDを指定してください。');
    const hash = userId;
    let row = await this.store.get('session', hash);
    // Serialize mutations for one user through the existing user row.
    const user = row && (await db.query('SELECT status FROM users WHERE user_id=$1 FOR UPDATE', [row.user_id])).rows[0];
    row = await this.store.get('session', hash);
    if (!row || row.terminal_id !== request.terminal.terminal_id || row.revoked_at || !user
      || Date.parse(row.expires_at) <= Date.now()
      || Date.now() - Date.parse(row.last_activity_at) > this.config.idleTtlSeconds * 1000
      || (purpose && row.purpose !== purpose)
      || !['active','pending_registration'].includes(user.status)
      || (row.purpose === 'safety' && user.status !== 'active')) fail(409, 'FACE_VERIFICATION_REQUIRED', 'もう一度、顔を確認してください。');
    if (confirmed && !row.confirmed_at) fail(403, 'IDENTITY_CONFIRMATION_REQUIRED', 'ご本人のお名前をご確認ください。');
    row.user_id = hash; row.user_status = user.status;
    await this.updateSession(row, { last_activity_at: new Date().toISOString() });
    return row;
  }
  async updateSession(session, changes, ctx = null) {
    Object.assign(session, changes);
    const save = () => this.store.put('session', session.user_id, session, session.expires_at);
    if (ctx) ctx.commits.push(save); else await save();
  }
  async newSession(db, request, userId, purpose, verification = null, ctx = null, returnSession = false) {
    const expiresAt = new Date(Date.now() + this.config.verificationTtlSeconds * 1000).toISOString();
    const session = { session_id: randomUUID(),
      terminal_id: request.terminal.terminal_id, user_id: userId, purpose,
      verification_id: verification?.verification_id ?? null, verified_at: verification?.verified_at ?? null,
      authentication_method: verification?.authentication_method ?? null, liveness_passed: verification?.liveness_passed ?? null,
      expires_at: expiresAt, last_activity_at: new Date().toISOString() };
    await this.updateSession(session, {}, ctx);
    const credentials={user_id:userId};
    return returnSession ? {credentials,session} : credentials;
  }
  async createDraft(request, ctx) {
    await this.policy(ctx.db, 'registration');
    const id = randomUUID(); const expiry = new Date(Date.now() + this.config.draftTtlSeconds * 1000).toISOString();
    await this.store.put('draft', id, {
      id, userId: randomUUID(), terminalId: request.terminal.terminal_id,
      expiresAt: expiry, lastActivityAt: new Date().toISOString(), recipients: []
    }, expiry);
    await audit(ctx.db, this.config, request, 'enrollment.started', 'enrollment', id);
    return { status: 201, body: { temp_id: id, expires_at: expiry } };
  }
  async getDraft(request, id) {
    const completed = (await this.pool.query(`SELECT user_id,status FROM users WHERE temp_id=$1 AND terminal_id=$2`, [id, request.terminal.terminal_id])).rows[0];
    if (completed) return { temp_id: id, status: completed.status };
    return this.store.lock('draft', id, async () => {
      const draft = await this.draft(request, id);
      const consent = (await this.pool.query(`SELECT consent_id FROM consents WHERE temp_id=$1 AND terminal_id=$2 AND result='granted'`, [id, request.terminal.terminal_id])).rows[0];
      await this.store.put('draft', id, draft, draft.expiresAt);
      return {
        temp_id: id, expires_at: draft.expiresAt, has_face: Boolean(draft.image), has_profile: Boolean(draft.displayName),
        consent_granted: Boolean(consent), recipients: draft.recipients.map(x => ({ name: x.name, masked_email: maskEmail(x.email) }))
      };
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
      // Record consent before the browser sends face video to AWS. The face is
      // still required by completeDraft before registration can be persisted.
      if (body.result === 'granted' && !draft.displayName) fail(409, 'ENROLLMENT_INCOMPLETE', 'お名前を入力してから同意してください。');
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
      const completed = (await ctx.db.query('SELECT user_id FROM users WHERE temp_id=$1 AND terminal_id=$2', [id, request.terminal.terminal_id])).rows[0];
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
    await this.store.put('liveness', result.sessionId, {
      terminalId: request.terminal.terminal_id, purpose: body.purpose,
      enrollmentId: body.enrollment_id ?? null, sessionId: userSession?.session_id ?? null
    }, expiresAt);
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
    let metrics;
    const result = await this.changeDraft(request, id, async draft => {
      if (body.image_base64) {
        await this.store.checkCooldown(request.terminal.terminal_id);
        const consent = (await ctx.db.query("SELECT consent_id FROM consents WHERE temp_id=$1 AND terminal_id=$2 AND result='granted'", [id, request.terminal.terminal_id])).rows[0];
        if (!consent) fail(409, 'REGISTRATION_CONSENT_REQUIRED', '個人情報の取扱いに同意してください。');
      }
      const captured = body.image_base64 ? await this.face.captureImage(body.image_base64)
        : await this.capture(request, body.liveness_session_id, 'enrollment', ctx, id);
      const { image } = captured;
      metrics = { ...captured.metrics, liveness_passed: captured.livenessPassed };
      try {
        draft.image = image.toString('base64');
        delete draft.duplicateCheckedAtCapture;
      } finally { image.fill(0); }
    });
    return { ...result, body: { ...result.body, metrics } };
  }
  async completeDraft(request,id,ctx) {
    return this.store.lock('draft',id,async () => this.persistDraft(request,id,await this.draft(request,id),ctx),ctx);
  }
  async persistDraft(request,id,draft,ctx) {
  if (!draft.displayName || !draft.image || draft.recipients.length < 1) fail(409, 'ENROLLMENT_INCOMPLETE', '登録内容をご確認ください。');
  const consent = (await ctx.db.query(`SELECT * FROM consents WHERE temp_id=$1 AND terminal_id=$2 AND result='granted' FOR UPDATE`, [id, request.terminal.terminal_id])).rows[0];
  if (!consent) fail(409, 'REGISTRATION_CONSENT_REQUIRED', '個人情報の取扱いに同意してください。');
  await this.policy(ctx.db, 'registration', consent.policy_version);
  this.face.requireReady();
  const image = Buffer.from(draft.image, 'base64');
  let reference;
  try {
    // Serialize face indexing and persistence. The current registration flow has
    // already checked this photo at capture; legacy drafts still need that check.
    await ctx.db.query("SELECT pg_advisory_xact_lock(hashtextextended('anshin:face-registration', 0))");
    if (!draft.duplicateCheckedAtCapture) await this.assertNewFace(ctx.db, image);
    reference = await this.face.index(image, draft.userId);
  } finally { image.fill(0); }
  ctx.rollbacks.push(async () => {
    await this.face.delete(reference);
  });
  await ctx.db.query(`INSERT INTO users(user_id,display_name,temp_id,terminal_id)
    VALUES($1,$2,$3,$4)`, [draft.userId, await this.cipher.seal(draft.displayName, 'user-name'), id, request.terminal.terminal_id]);
  for (const [index, recipient] of draft.recipients.entries()) {
    await ctx.db.query(`INSERT INTO recipients(user_id,name,encrypted_email,order_no)
      VALUES($1,$2,$3,$4)`, [draft.userId, await this.cipher.seal(recipient.name, 'recipient-name'),
      await this.cipher.seal(recipient.email, 'recipient-email'), index + 1]);
  }
  await ctx.db.query(`INSERT INTO face_templates(user_id,encrypted_template,provider,model_version,threshold_version)
    VALUES($1,$2,$3,$4,$5)`, [draft.userId, await this.cipher.seal(reference, 'face-reference'),
    this.face.name, reference.modelVersion, this.config.thresholdVersion]);
  await ctx.db.query('UPDATE consents SET user_id=$1,temp_id=NULL WHERE consent_id=$2', [draft.userId, consent.consent_id]);
  const session = await this.newSession(ctx.db, request, draft.userId, 'registration', null, ctx);
  await audit(ctx.db, this.config, request, 'enrollment.completed', 'user', draft.userId);
  ctx.commits.push(() => this.store.remove('draft', id));
  return { status: 201, body: { user_id: draft.userId, status: 'pending_registration', ...session } };
  }
  async captureRegistration(request,body,ctx) {
    await this.store.checkCooldown(request.terminal.terminal_id);
    const captured=await this.face.captureImage(body.image_base64);
    const id=randomUUID(); const expiresAt=new Date(Date.now()+this.config.draftTtlSeconds*1000).toISOString();
    try {
      await this.assertNewFace(ctx.db, captured.image, captured.metrics);
      await this.store.put('draft',id,{id,userId:randomUUID(),terminalId:request.terminal.terminal_id,
        expiresAt,lastActivityAt:new Date().toISOString(),recipients:[],image:captured.image.toString('base64'),
        duplicateCheckedAtCapture:true},expiresAt);
    } finally {captured.image.fill(0);}
    ctx.rollbacks.push(() => this.store.remove('draft',id));
    await audit(ctx.db,this.config,request,'enrollment.captured','enrollment',id);
    return {status:201,body:{face_valid:true,temp_id:id,expires_at:expiresAt,idle_timeout_seconds:this.config.idleTtlSeconds,
      metrics:{...captured.metrics,liveness_passed:false}}};
  }
  async register(request,body,ctx) {
    const id=body.temp_id;
    return this.store.lock('draft',id,async () => {
      if ((await ctx.db.query('SELECT 1 FROM users WHERE temp_id=$1 AND terminal_id=$2',[id,request.terminal.terminal_id])).rowCount)
        fail(409,'ENROLLMENT_ALREADY_PERSISTED','登録済みです。スタッフへお声がけください。');
      const draft=await this.draft(request,id);
      await this.policy(ctx.db,'registration',body.policy_version);
      if (!draft.image) fail(409,'ENROLLMENT_INCOMPLETE','最初に顔写真を撮影してください。');
      // Always acquire this before the audit-chain lock, including the legacy flow.
      if (body.consent_result==='granted')
        await ctx.db.query("SELECT pg_advisory_xact_lock(hashtextextended('anshin:face-registration', 0))");
      const consent=(await ctx.db.query(`INSERT INTO consents(temp_id,consent_type,policy_version,terminal_id,result,request_id)
        VALUES($1,'registration',$2,$3,$4,$5) RETURNING consent_id`,[id,body.policy_version,request.terminal.terminal_id,body.consent_result,request.id])).rows[0];
      await audit(ctx.db,this.config,request,'consent.registration','consent',consent.consent_id,body.consent_result==='granted'?'success':'denied');
      if (body.consent_result==='denied') {
        ctx.commits.push(() => this.store.remove('draft',id));
        return {body:{success:false,user_id:null,user_status:null,registration_completed:false,consent_result:'denied',status:'cancelled'}};
      }
      draft.displayName=body.display_name; draft.recipients=body.recipients;
      const saved=await this.persistDraft(request,id,draft,ctx);
      return {...saved,body:{...saved.body,success:true,user_status:saved.body.status,registration_completed:false}};
    },ctx);
  }
  async assertNewFace(db, image, quality = {}) {
    const found = await this.face.search(image);
    const candidates = await this.candidates(db, found);
    const duplicate = candidates.find(candidate => candidate.score >= this.config.matchThreshold);
    if (duplicate) fail(409, 'FACE_ALREADY_REGISTERED', 'すでに登録されています。登録済みの方の操作を選ぶか、スタッフへお声がけください。', {
      ...quality, similarity_score: duplicate.score * 100, match_threshold: this.config.matchThreshold * 100,
    });
  }
  async candidates(db, found, onlyUserId = null) {
    const ids = [...new Set(found.candidates.map(c => c.userId).filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? '')))];
    if (!ids.length) return [];
    const templates = (await db.query(`SELECT t.*,u.status FROM face_templates t JOIN users u USING(user_id)
      WHERE t.user_id=ANY($1::uuid[]) AND t.status='active'
      AND (($2::uuid IS NULL AND u.status='active') OR u.user_id=$2)`, [ids, onlyUserId])).rows;
    const valid = [];
    for (const template of templates) {
      const ref = await this.cipher.open(template.encrypted_template, 'face-reference');
      const candidate = found.candidates.find(c => c.userId === template.user_id && c.faceId === ref.faceId);
      if (candidate && Number.isFinite(candidate.score) && (!onlyUserId || candidate.userId === onlyUserId)) valid.push({ ...candidate, templateId: template.template_id });
    }
    return valid.sort((a, b) => b.score - a.score);
  }
  async verify(request, body, ctx, purpose, {autoMail=false,expectedUserId=null}={}) {
    if (body.image_base64) await this.store.checkCooldown(request.terminal.terminal_id);
    const session = purpose === 'registration' ? await this.session(request, ctx.db, 'registration') : null;
    if (expectedUserId && session?.user_id!==expectedUserId) fail(403,'USER_ID_MISMATCH','本人確認した利用者IDと一致しません。');
    if (session?.consumed_by_check_id) fail(409, 'SESSION_ALREADY_USED', '登録確認メールの結果をご確認ください。');
    const capture = body.image_base64 ? await this.face.captureImage(body.image_base64)
      : await this.capture(request, body.liveness_session_id, purpose, ctx, session?.session_id);
    let found;
    try { found = await this.face.search(capture.image); } finally { capture.image.fill(0); }
    const candidates = await this.candidates(ctx.db, found, session?.user_id);
    const first = candidates[0]; const second = candidates[1];
    const margin = purpose === 'registration' ? 0 : this.config.requiredMargin;
    const matched = first && first.score >= this.config.matchThreshold && (!second || first.score - second.score >= margin);
    const result = matched ? 'matched' : first?.score >= this.config.matchThreshold ? 'ambiguous' : 'no_match';
    const metrics = { ...capture.metrics, liveness_passed: capture.livenessPassed,
      similarity_score: first ? first.score * 100 : null,
      match_threshold: this.config.matchThreshold * 100 };
    const userId = matched ? first.userId : session?.user_id ?? null;
    const verification = { verification_id: randomUUID(), verified_at: new Date().toISOString(),
      authentication_method: body.image_base64 ? 'image' : 'liveness', liveness_passed: capture.livenessPassed };
    await audit(ctx.db, this.config, request, `face.${purpose}`, 'verification', verification.verification_id, matched ? 'success' : 'failure', matched ? null : 'FACE-003');
    if (!matched) {
      const attempts = await this.store.failure(request.terminal.terminal_id);
      return {body:{matched:false,result,metrics,verification_status:'not_matched',
        ...(session ? {user_status:session.user_status} : {}),attempts_remaining:Math.max(0,3-attempts)}};
    }
    await this.store.clearFailures(request.terminal.terminal_id);
    const user = (await ctx.db.query('SELECT display_name FROM users WHERE user_id=$1', [userId])).rows[0];
    let credentials;
    if (session) {
      await this.updateSession(session, { revoked_at: new Date().toISOString() }, ctx);
    }
    const created=await this.newSession(ctx.db,request,userId,purpose,verification,ctx,true);
    credentials=created.credentials;
    let notification;
    if (autoMail) {
      created.session.confirmed_at=new Date().toISOString();
      notification=await this.queueForSession(request,ctx,'registration',{},null,created.session);
    }
    const userStatus=(await ctx.db.query('SELECT status FROM users WHERE user_id=$1',[userId])).rows[0].status;
    return {body:{matched:true,result:'matched',verification_status:'verified',user_id:userId,user_status:userStatus,
      similarity_score:metrics.similarity_score,metrics,display_name:await this.cipher.open(user.display_name,'user-name'),...credentials,
      ...(notification ? {check_id:notification.body.check_id,send_requested:true,registration_completed:false} : {})}};
  }
  async confirmIdentity(request, body, ctx) {
    const session = await this.session(request, ctx.db);
    if (!session.verification_id) fail(409, 'FACE_VERIFICATION_REQUIRED', '顔を確認してください。');
    if (!body.confirmed) {
      await this.updateSession(session, { revoked_at: new Date().toISOString() }, ctx);
      await audit(ctx.db, this.config, request, 'identity.rejected', 'session', session.session_id, 'denied');
      return { body: { confirmed: false, session_ended: true } };
    }
    await this.updateSession(session, { confirmed_at: new Date().toISOString() }, ctx);
    await audit(ctx.db, this.config, request, 'identity.confirmed', 'session', session.session_id);
    return { body: { confirmed: true } };
  }
  async getRecipients(request) {
    return transaction(this.pool, async db => {
      const session = await this.session(request, db, null, { confirmed: true });
      const rows = (await db.query(`SELECT * FROM recipients WHERE user_id=$1 AND status <> 'deleted' ORDER BY order_no`, [session.user_id])).rows;
      const recipients = [];
      for (const row of rows) recipients.push({
        recipient_id: row.recipient_id, name: await this.cipher.open(row.name, 'recipient-name'),
        masked_email: maskEmail(await this.cipher.open(row.encrypted_email, 'recipient-email')), status: row.status
      });
      return { recipients };
    });
  }
  async queueSend(request, ctx, purpose, body = {}, enrollmentId = null) {
    if (!this.mail.ready) unavailable('メール送信サービス');
    const session = await this.session(request, ctx.db, purpose, { confirmed: true });
    return this.queueForSession(request,ctx,purpose,body,enrollmentId,session);
  }
  async queueForSession(request,ctx,purpose,body,enrollmentId,session) {
    if (!this.mail.ready) unavailable('メール送信サービス');
    if (session.consumed_by_check_id) fail(409, 'SESSION_ALREADY_USED', '送信済みの結果をご確認ください。');
    const user = (await ctx.db.query('SELECT * FROM users WHERE user_id=$1 FOR SHARE', [session.user_id])).rows[0];
    let consent;
    if (purpose === 'registration') {
      const enrollment = (await ctx.db.query(`SELECT * FROM users WHERE ($1::uuid IS NULL OR temp_id=$1) AND user_id=$2 AND terminal_id=$3 FOR UPDATE`, [enrollmentId, session.user_id, request.terminal.terminal_id])).rows[0];
      if (!enrollment || (await ctx.db.query("SELECT 1 FROM safety_checks WHERE user_id=$1 AND check_type='registration'", [session.user_id])).rowCount) fail(409, 'REGISTRATION_MAIL_ALREADY_STARTED', '登録確認メールの結果をご確認ください。');
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
    if (!session.verification_id || !session.verified_at || Date.now() - Date.parse(session.verified_at) >= this.config.verificationTtlSeconds * 1000) fail(401, 'FACE_VERIFICATION_EXPIRED', 'もう一度、顔を確認してください。');
    const recipients = (await ctx.db.query(`SELECT * FROM recipients WHERE user_id=$1 AND status='active' ORDER BY order_no FOR SHARE`, [user.user_id])).rows;
    if (!recipients.length) fail(409, 'NO_ACTIVE_RECIPIENT', '送信先をご確認ください。スタッフへお声がけください。');
    const check = (await ctx.db.query(`INSERT INTO safety_checks(user_id,terminal_id,check_type,verified_at,consent_id,idempotency_key,request_sha256,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING check_id`, [user.user_id, request.terminal.terminal_id, purpose,
      session.verified_at, consent.consent_id, ctx.key, ctx.hash, session.expires_at])).rows[0];
    for (const recipient of recipients) {
      await ctx.db.query(`INSERT INTO mail_deliveries(check_id,user_id,recipient_id,recipient_order_no,encrypted_email_snapshot,provider,next_attempt_at)
        VALUES($1,$2,$3,$4,$5,$6,current_timestamp) RETURNING delivery_id`, [check.check_id, user.user_id, recipient.recipient_id,
        recipient.order_no, recipient.encrypted_email, this.mail.name]);
    }
    await this.updateSession(session, { consumed_by_check_id: check.check_id }, ctx);
    await audit(ctx.db, this.config, request, 'mail.queued', 'safety_check', check.check_id);
    return { status: 202, body: { success: true, send_requested: true, check_id: check.check_id, user_id: user.user_id } };
  }
  async getCheck(request, id) {
    return transaction(this.pool, async db => {
      const session = await this.session(request, db);
      const check = (await db.query('SELECT c.*,u.status AS user_status FROM safety_checks c JOIN users u USING(user_id) WHERE check_id=$1 AND c.user_id=$2 AND c.terminal_id=$3', [id, session.user_id, request.terminal.terminal_id])).rows[0];
      if (!check) fail(404, 'NOT_FOUND', '送信結果が見つかりません。');
      const deliveries = (await db.query(`SELECT delivery_id,recipient_id,status,attempt_count,accepted_at,delivered_at,bounced_at,error_code FROM mail_deliveries WHERE check_id=$1 ORDER BY recipient_order_no`, [id])).rows;
      return {
        check_id: id, type: check.check_type, status: check.status, created_at: check.created_at,
        completed_at:check.completed_at,recipient_results:deliveries,mail_status:check.status,user_id:check.user_id,user_status:check.user_status,
        registration_completed:check.check_type==='registration' && deliveries.length>0 && deliveries.every(d=>['accepted','delivered','bounced'].includes(d.status)) && check.user_status==='active'
      };
    });
  }
  async replayRegistrationVerification(request,send,ctx) {
    const user=(await ctx.db.query('SELECT status FROM users WHERE user_id=$1 FOR UPDATE',[send.user_id])).rows[0];
    if (!user || !['pending_registration','active'].includes(user.status)) fail(403,'USER_NOT_AVAILABLE','利用停止中です。');
    const verified={verification_id:randomUUID(),verified_at:send.verified_at,authentication_method:'image',liveness_passed:false};
    const created=await this.newSession(ctx.db,request,send.user_id,'registration',verified,ctx,true);
    created.session.confirmed_at=new Date().toISOString(); created.session.consumed_by_check_id=send.check_id;
    return {body:{matched:true,result:'matched',verification_status:'verified',user_id:send.user_id,user_status:user.status,
      metrics:{similarity_score:null,match_threshold:this.config.matchThreshold*100,liveness_passed:false},similarity_score:null,
      check_id:send.check_id,send_requested:true,registration_completed:user.status==='active',
      ...created.credentials,recovered:true}};
  }
  async confirmRecipients(request,userId,body,ctx) {
    const session=await this.session(request,ctx.db,'safety');
    if (session.user_id!==userId) fail(403,'USER_ID_MISMATCH','本人確認した利用者IDと一致しません。');
    if (!session.verification_id) fail(409,'FACE_VERIFICATION_REQUIRED','顔を確認してください。');
    if (!body.confirmed) {
      await this.updateSession(session,{revoked_at:new Date().toISOString()},ctx);
      await audit(ctx.db,this.config,request,'identity.rejected','session',session.session_id,'denied');
      return {body:{success:false,confirmed:false,session_ended:true,recipients:[]}};
    }
    await this.updateSession(session,{confirmed_at:new Date().toISOString()},ctx);
    const policy=await this.policy(ctx.db,'safety');
    const recipients=[];
    for (const row of (await ctx.db.query("SELECT * FROM recipients WHERE user_id=$1 AND status<>'deleted' ORDER BY order_no",[userId])).rows) {
      recipients.push({recipient_id:row.recipient_id,name:await this.cipher.open(row.name,'recipient-name'),
        masked_email:maskEmail(await this.cipher.open(row.encrypted_email,'recipient-email')),status:row.status});
    }
    await audit(ctx.db,this.config,request,'identity.confirmed','session',session.session_id);
    return {body:{success:true,confirmed:true,user_id:userId,recipients,consent_body:policy.body,policy_version:policy.policy_version}};
  }
  async notifySafety(request,body,ctx) {
    const session=await this.session(request,ctx.db,'safety',{confirmed:true});
    if (session.user_id!==body.user_id) fail(403,'USER_ID_MISMATCH','本人確認した利用者IDと一致しません。');
    if (!body.consent) {
      await this.updateSession(session,{revoked_at:new Date().toISOString()},ctx);
      await audit(ctx.db,this.config,request,'consent.safety','user',body.user_id,'denied');
      return {body:{success:true,send_requested:false,check_id:null,user_id:body.user_id,session_ended:true}};
    }
    const result=await this.queueForSession(request,ctx,'safety',body,null,session);
    return result;
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
    await this.updateSession(session, { revoked_at: new Date().toISOString() }, ctx);
    await audit(ctx.db, this.config, request, 'session.ended', 'session', session.session_id);
    return { body: { session_ended: true } };
  }
}
