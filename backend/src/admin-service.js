import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { displayName, email, uuid, bodySchemas } from './validation.js';
import { transaction } from './db.js';
import { audit } from './audit.js';
import { fail } from './errors.js';
import { sha256, canonical } from './crypto.js';
import { AdminAuth, adminProfile, passwordHash } from './admin-auth.js';
import { publishedPolicy } from './admin-settings.js';
import { UserService } from './user-service.js';

const password = z.string().min(12).max(128);
const revision = z.string().min(1).max(100);
const reason = z.enum(['support', 'correction', 'suspension', 'deletion', 'audit']);
const contact = z.strictObject({ id: uuid.optional(), name: displayName, email });
export const adminSchemas = {
  login: z.strictObject({ email, password: z.string().min(1).max(128) }),
  profile: z.strictObject({ name: displayName, email, current_password: z.string().min(1).max(128), new_password: password.optional() }),
  user: z.strictObject({ name: displayName, status: z.enum(['active','suspended','pending_registration']),
    recipients: z.array(contact).min(1).max(2).refine(rows => new Set(rows.map(x => x.email)).size === rows.length, 'Duplicate recipients'),
    expected_revision: revision, identity_confirmed: z.literal(true), reset_face: z.boolean().default(false), reason }),
  deletion: z.strictObject({ expected_revision: revision, reason: z.literal('deletion') }),
  search: z.strictObject({ name: displayName, reason }),
  template: z.strictObject({ subject: z.string().trim().min(1).max(200).refine(x => !/[\r\n\u0000]/.test(x)),
    body: z.string().trim().min(1).max(10000), expected_revision: revision }),
  policy: z.strictObject({ policy_version: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,49}$/),
    body: z.string().trim().min(1).max(10000),
    effective_date: z.iso.date() }),
  face: z.strictObject({ ...bodySchemas.photoCapture.shape, expected_revision: revision, owner_present: z.literal(true),
    policy_version: z.string().min(1).max(50), consent_granted: z.literal(true) }),
  consent: z.strictObject({ expected_revision: revision, owner_present: z.literal(true),
    policy_version: z.string().min(1).max(50), consent_granted: z.literal(true) }),
};
export const adminRoutes = [
  ['post','/v1/admin/login','管理员邮箱及密码登录','login'],
  ['get','/v1/admin/session','读取管理会话及 CSRF 令牌'],
  ['post','/v1/admin/logout','退出管理会话'],
  ['put','/v1/admin/profile','修改唯一管理员账号；再次验证密码','profile'],
  ['get','/v1/admin/dashboard','真实统计及最近邮件错误'],
  ['get','/v1/admin/users','分页登记者和联系人列表'],
  ['post','/v1/admin/users/search','按姓名完全一致搜索并记录用途','search'],
  ['put','/v1/admin/users/{id}','订正资料、停用或请求脸部重登','user'],
  ['delete','/v1/admin/users/{id}','删除申请、撤销及个人信息擦除','deletion'],
  ['delete','/v1/admin/users/{id}/recipients/{recipientId}','删除联系人','deletion'],
  ['post','/v1/admin/users/{id}/face','本人在场并同意后重新登记脸部','face'],
  ['post','/v1/admin/users/{id}/consent','本人在场重新同意当前登记文面','consent'],
  ['get','/v1/admin/settings','当前邮件模板及同意版本'],
  ['put','/v1/admin/mail-template','更新安否邮件模板','template'],
  ['post','/v1/admin/policies/registration','发布利用者显示的个人信息文面版本','policy'],
];

export class AdminService {
  constructor(deps) { Object.assign(this, deps); this.auth = new AdminAuth(deps); }
  async log(request, action, target = 'administrator', id = 'singleton') {
    return transaction(this.pool, db => audit(db, this.config, request, action, target, id));
  }
  async user(db, id, expected) {
    const row = (await db.query("SELECT *,updated_at::text AS revision FROM users WHERE user_id=$1 AND status<>'deleted' FOR UPDATE", [id])).rows[0];
    if (!row) fail(404, 'NOT_FOUND', '登録者が見つかりません。');
    if (expected && row.revision !== expected) fail(409, 'ADMIN_REVISION_CHANGED', '他の操作で変更されました。再読み込みしてください。');
    return row;
  }
  async serialize(db, row) {
    const contacts = (await db.query("SELECT * FROM recipients WHERE user_id=$1 AND status<>'deleted' ORDER BY order_no", [row.user_id])).rows;
    const hasFace = (await db.query("SELECT 1 FROM face_templates WHERE user_id=$1 AND status='active'", [row.user_id])).rowCount > 0;
    const consent = (await db.query("SELECT policy_version FROM consents WHERE user_id=$1 AND consent_type='registration' AND result='granted' ORDER BY consented_at DESC LIMIT 1", [row.user_id])).rows[0];
    const lastCheck = (await db.query("SELECT max(created_at) AS at FROM safety_checks WHERE user_id=$1 AND check_type='safety'", [row.user_id])).rows[0].at;
    return { id: row.user_id, name: await this.cipher.open(row.display_name, 'user-name'), status: row.status,
      faceStatus: hasFace ? 'registered' : 'renewal', registeredAt: row.registered_at ?? row.created_at,
      updatedAt: row.updated_at, revision: row.revision, lastCheckAt: lastCheck, consentVersion: consent?.policy_version ?? '',
      recipients: await Promise.all(contacts.map(async x => ({ id: x.recipient_id, name: await this.cipher.open(x.name, 'recipient-name'),
        email: await this.cipher.open(x.encrypted_email, 'recipient-email'), status: x.status }))) };
  }
  async list(request, search) {
    const pagination = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).max(100000).default(0) }).parse(request.query);
    return transaction(this.pool, async db => {
      const rows = (await db.query(`SELECT *,updated_at::text AS revision FROM users WHERE status<>'deleted' ORDER BY created_at DESC,user_id
        ${search ? '' : 'LIMIT $1 OFFSET $2'}`, search ? [] : [pagination.limit,pagination.offset])).rows;
      const users = [];
      for (const row of rows) {
        if (search && await this.cipher.open(row.display_name, 'user-name') !== search.name) continue;
        users.push(await this.serialize(db,row));
      }
      const total = search ? users.length : Number((await db.query("SELECT count(*) FROM users WHERE status<>'deleted'")).rows[0].count);
      await audit(db,this.config,request,search ? 'admin.users.search' : 'admin.users.read','users',null);
      return { users, total, offset: pagination.offset, limit: pagination.limit };
    });
  }
  async cancelRecipient(db, id) {
    await db.query(`UPDATE mail_deliveries SET status=CASE WHEN status IN ('queued','sending') THEN 'cancelled' ELSE status END,
      next_attempt_at=NULL,encrypted_email_snapshot=NULL,snapshot_erased_at=clock_timestamp() WHERE recipient_id=$1`, [id]);
    await db.query(`UPDATE safety_checks c SET status='cancelled',completed_at=clock_timestamp() WHERE c.status IN ('queued','processing')
      AND EXISTS(SELECT 1 FROM mail_deliveries d WHERE d.check_id=c.check_id AND d.recipient_id=$1)
      AND NOT EXISTS(SELECT 1 FROM mail_deliveries d WHERE d.check_id=c.check_id AND d.status IN ('queued','sending'))`, [id]);
  }
  async eraseRecipient(db, id) {
    await this.cancelRecipient(db,id);
    await db.query(`UPDATE recipients SET status='deleted',name=$2,encrypted_email=$3 WHERE recipient_id=$1`,
      [id,await this.cipher.seal('削除済み','recipient-name'),await this.cipher.seal('','recipient-email')]);
  }
  async queueCorrection(db, user, changed, request) {
    if (!changed.length || user.status !== 'active') return null;
    if (!this.mail.ready) fail(503,'SERVICE_NOT_CONFIGURED','変更確認メールを送るため、メール設定が必要です。');
    const key = `admin:${request.headers['idempotency-key']}`;
    const terminalId = user.terminal_id ?? (await db.query("SELECT terminal_id FROM terminals WHERE status='active' ORDER BY created_at LIMIT 1")).rows[0]?.terminal_id;
    const consent=(await db.query("SELECT consent_id FROM consents WHERE user_id=$1 AND consent_type='registration' AND result='granted' ORDER BY consented_at DESC LIMIT 1",[user.user_id])).rows[0];
    if (!consent) fail(409,'REGISTRATION_CONSENT_REQUIRED','登録時の同意記録を確認してください。');
    const check = (await db.query(`INSERT INTO safety_checks(user_id,terminal_id,check_type,verified_at,idempotency_key,request_sha256,consent_id,expires_at)
      VALUES($1,$2,'contact_change',clock_timestamp(),$3,$4,$5,clock_timestamp()+interval '15 minutes') RETURNING check_id`,
      [user.user_id,terminalId,key,sha256(canonical(request.body)),consent.consent_id])).rows[0];
    for (const recipient of changed) await db.query(`INSERT INTO mail_deliveries(check_id,user_id,recipient_id,recipient_order_no,encrypted_email_snapshot,provider,next_attempt_at)
      VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())`, [check.check_id,user.user_id,recipient.recipient_id,recipient.order_no,recipient.encrypted_email,this.mail.name]);
    return check.check_id;
  }
  async updateUser(request, body) {
    return transaction(this.pool, async db => {
      const user = await this.user(db,request.params.id,body.expected_revision);
      if (user.status === 'pending_registration' && body.status !== 'suspended' && body.status !== 'pending_registration')
        fail(409,'REGISTRATION_INCOMPLETE','初回登録の本人確認とメール受理を完了してください。');
      const existing = (await db.query("SELECT * FROM recipients WHERE user_id=$1 AND status<>'deleted' ORDER BY order_no FOR UPDATE",[user.user_id])).rows;
      const ids = body.recipients.filter(x=>x.id).map(x=>x.id);
      if (new Set(ids).size !== ids.length || ids.some(id=>!existing.some(x=>x.recipient_id===id))) fail(400,'VALIDATION_ERROR','送信先を再読み込みしてください。');
      for (const old of existing) if (!ids.includes(old.recipient_id)) await this.eraseRecipient(db,old.recipient_id);
      // Temporarily free the two order slots, then restore selected recipients atomically.
      await db.query("UPDATE recipients SET status='deleted' WHERE user_id=$1 AND status<>'deleted'",[user.user_id]);
      const changed = [];
      for (const [index,recipient] of body.recipients.entries()) {
        const old = existing.find(x=>x.recipient_id===recipient.id);
        const addressChanged = !old || await this.cipher.open(old.encrypted_email,'recipient-email') !== recipient.email;
        if (old && addressChanged) await this.cancelRecipient(db,old.recipient_id);
        const values = [user.user_id,await this.cipher.seal(recipient.name,'recipient-name'),await this.cipher.seal(recipient.email,'recipient-email'),index+1];
        const row = old ? (await db.query(`UPDATE recipients SET name=$2,encrypted_email=$3,order_no=$4,
          status=$5,bounce_count=CASE WHEN $6 THEN 0 ELSE bounce_count END WHERE recipient_id=$1 RETURNING *`,
          [old.recipient_id,...values.slice(1),addressChanged ? 'active' : old.status,addressChanged])).rows[0]
          : (await db.query('INSERT INTO recipients(user_id,name,encrypted_email,order_no) VALUES($1,$2,$3,$4) RETURNING *',values)).rows[0];
        if (addressChanged) changed.push(row);
      }
      const targetStatus = body.reset_face ? 'suspended' : body.status;
      if (targetStatus === 'active' && !(await db.query("SELECT 1 FROM face_templates WHERE user_id=$1 AND status='active'",[user.user_id])).rowCount)
        fail(409,'FACE_REENROLLMENT_REQUIRED','本人立会いで顔を再登録してください。');
      if (targetStatus === 'active' && !(await db.query("SELECT 1 FROM recipients WHERE user_id=$1 AND status='active'",[user.user_id])).rowCount)
        fail(409,'NO_ACTIVE_RECIPIENT','有効な送信先を登録してください。');
      await db.query(`UPDATE users SET display_name=$2,status=$3::varchar,suspended_at=CASE WHEN $3::varchar='suspended' THEN clock_timestamp() ELSE NULL END WHERE user_id=$1`,
        [user.user_id,await this.cipher.seal(body.name,'user-name'),targetStatus]);
      if (body.reset_face) await db.query("UPDATE face_templates SET status='revoked' WHERE user_id=$1 AND status='active'",[user.user_id]);
      user.status = targetStatus;
      const checkId = await this.queueCorrection(db,user,changed,request);
      await audit(db,this.config,request,body.reset_face ? 'admin.face.reset' : 'admin.user.updated','user',user.user_id);
      return { user: await this.serialize(db,await this.user(db,user.user_id)), notification_check_id: checkId };
    });
  }
  async deleteUser(request, body) {
    return transaction(this.pool, async db => {
      const row = await this.user(db,request.params.id,body.expected_revision);
      await db.query(`UPDATE users SET status='deleted',display_name=$2,deleted_at=clock_timestamp(),purge_after=clock_timestamp()+interval '30 days' WHERE user_id=$1`,
        [row.user_id,await this.cipher.seal('削除済み','user-name')]);
      for (const r of (await db.query("SELECT recipient_id FROM recipients WHERE user_id=$1",[row.user_id])).rows) await this.eraseRecipient(db,r.recipient_id);
      await db.query(`UPDATE mail_deliveries SET encrypted_email_snapshot=NULL,snapshot_erased_at=clock_timestamp() WHERE user_id=$1`,[row.user_id]);
      await audit(db,this.config,request,'admin.user.deleted','user',row.user_id);
      return { deleted: true };
    });
  }
  async deleteRecipient(request, body) {
    return transaction(this.pool,async db=> {
      const user=await this.user(db,request.params.id,body.expected_revision);
      const recipient=(await db.query("SELECT recipient_id FROM recipients WHERE recipient_id=$1 AND user_id=$2 AND status<>'deleted' FOR UPDATE",[request.params.recipientId,user.user_id])).rows[0];
      if (!recipient) fail(404,'NOT_FOUND','送信先が見つかりません。');
      await this.eraseRecipient(db,recipient.recipient_id);
      if (!(await db.query("SELECT 1 FROM recipients WHERE user_id=$1 AND status='active'",[user.user_id])).rowCount)
        await db.query("UPDATE users SET status='suspended',suspended_at=clock_timestamp() WHERE user_id=$1",[user.user_id]);
      else await db.query('UPDATE users SET updated_at=clock_timestamp() WHERE user_id=$1',[user.user_id]);
      await audit(db,this.config,request,'admin.recipient.deleted','recipient',recipient.recipient_id);
      return { user:await this.serialize(db,await this.user(db,user.user_id)) };
    });
  }
  async reenroll(request,body) {
    const captured = await this.face.captureImage(body.image_base64);
    let reference;
    try {
      return await transaction(this.pool,async db=> {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended('anshin:face-registration',0))");
        const user=await this.user(db,request.params.id,body.expected_revision);
        if (user.status !== 'suspended') fail(409,'FACE_RESET_REQUIRED','先に顔再登録待ちへ変更してください。');
        const policy=await publishedPolicy(db,this.policies,'registration',body.policy_version);
        if (!(await db.query("SELECT 1 FROM recipients WHERE user_id=$1 AND status='active'",[user.user_id])).rowCount) fail(409,'NO_ACTIVE_RECIPIENT','先に有効な送信先を登録してください。');
        await new UserService(this).assertNewFace(db,captured.image);
        reference=await this.face.index(captured.image,user.user_id);
        await db.query(`INSERT INTO face_templates(user_id,encrypted_template,provider,model_version,threshold_version) VALUES($1,$2,$3,$4,$5)`,
          [user.user_id,await this.cipher.seal(reference,'face-reference'),this.face.name,reference.modelVersion,this.config.thresholdVersion]);
        const terminalId=user.terminal_id ?? (await db.query("SELECT terminal_id FROM terminals WHERE status='active' LIMIT 1")).rows[0]?.terminal_id;
        await db.query(`INSERT INTO consents(user_id,consent_type,policy_version,terminal_id,result,request_id) VALUES($1,'registration',$2,$3,'granted',$4)`,[user.user_id,policy.policy_version,terminalId,request.id]);
        await db.query("UPDATE users SET status='active',suspended_at=NULL WHERE user_id=$1",[user.user_id]);
        await audit(db,this.config,request,'admin.face.reenrolled','user',user.user_id);
        return { user:await this.serialize(db,await this.user(db,user.user_id)), liveness_passed:false };
      });
    } catch (error) {
      if (reference) {
        try { await this.face.delete(reference); }
        catch {
          // Keep the encrypted reference for the existing worker's retry cleanup.
          await transaction(this.pool,async db=> {
            await db.query(`INSERT INTO face_templates(user_id,encrypted_template,provider,model_version,threshold_version,status)
              VALUES($1,$2,$3,$4,$5,'revoked')`,[request.params.id,await this.cipher.seal(reference,'face-reference'),this.face.name,reference.modelVersion,this.config.thresholdVersion]);
            await audit(db,this.config,request,'admin.face.cleanup.deferred','user',request.params.id);
          });
        }
      }
      throw error;
    } finally { captured.image.fill(0); }
  }
  async reconsent(request,body) {
    return transaction(this.pool,async db=> {
      const user=await this.user(db,request.params.id,body.expected_revision);
      const policy=await publishedPolicy(db,this.policies,'registration',body.policy_version);
      const terminalId=user.terminal_id ?? (await db.query("SELECT terminal_id FROM terminals WHERE status='active' LIMIT 1")).rows[0]?.terminal_id;
      await db.query(`INSERT INTO consents(user_id,consent_type,policy_version,terminal_id,result,request_id)
        VALUES($1,'registration',$2,$3,'granted',$4)`,[user.user_id,policy.policy_version,terminalId,request.id]);
      await db.query('UPDATE users SET updated_at=clock_timestamp() WHERE user_id=$1',[user.user_id]);
      await audit(db,this.config,request,'admin.consent.renewed','user',user.user_id);
      return { user:await this.serialize(db,await this.user(db,user.user_id)) };
    });
  }
  async dashboard(request) {
    return transaction(this.pool,async db=> {
      const counts=(await db.query(`SELECT
        (SELECT count(*) FROM users WHERE status<>'deleted') AS users,
        (SELECT count(*) FROM users WHERE status='active') AS active,
        (SELECT count(*) FROM recipients WHERE status<>'deleted') AS recipients,
        (SELECT count(*) FROM safety_checks WHERE check_type='safety' AND (created_at AT TIME ZONE 'Asia/Tokyo')::date=(clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date) AS today,
        (SELECT count(*) FROM safety_checks WHERE check_type='safety' AND status='accepted' AND (created_at AT TIME ZONE 'Asia/Tokyo')::date=(clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date) AS accepted,
        (SELECT count(*) FROM mail_deliveries WHERE status IN ('failed','unknown','bounced')) AS errors`)).rows[0];
      const errors=[];
      for (const d of (await db.query(`SELECT d.*,u.display_name,r.name FROM mail_deliveries d
        LEFT JOIN users u ON u.user_id=d.user_id LEFT JOIN recipients r ON r.recipient_id=d.recipient_id
        WHERE d.status IN ('failed','unknown','bounced') ORDER BY d.updated_at DESC LIMIT 50`)).rows) {
        errors.push({ id:d.delivery_id,userId:d.user_id,userName:d.display_name ? await this.cipher.open(d.display_name,'user-name') : '削除済み',
          recipientName:d.name ? await this.cipher.open(d.name,'recipient-name') : '削除済み',
          email:d.encrypted_email_snapshot ? await this.cipher.open(d.encrypted_email_snapshot,'recipient-email') : '消去済み',
          occurredAt:d.updated_at,code:d.error_code ?? d.status,status:d.status });
      }
      const activities=(await db.query("SELECT action,occurred_at FROM audit_logs WHERE actor_type='admin' AND action NOT LIKE '%.read' AND action<>'admin.login' ORDER BY log_id DESC LIMIT 5")).rows;
      await audit(db,this.config,request,'admin.dashboard.read','dashboard',null);
      return { counts:Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,Number(value)])),errors,activities };
    });
  }
  async settings(request) {
    return transaction(this.pool,async db=> {
      const mail=(await db.query("SELECT document,updated_at::text AS revision,updated_at FROM app_meta.admin_settings WHERE setting_key='mail.safety'")).rows[0];
      const policies=[await publishedPolicy(db,this.policies,'registration')];
      const history=(await db.query("SELECT document FROM app_meta.admin_settings WHERE setting_key LIKE 'policy.registration.%' ORDER BY updated_at DESC LIMIT 100")).rows.map(x=>x.document);
      await audit(db,this.config,request,'admin.settings.read','settings',null);
      return { mail:{...mail.document,revision:mail.revision,updated_at:mail.updated_at},policies,history };
    });
  }
  async saveTemplate(request,body) {
    const tokens=(body.subject+body.body).match(/\{\{[^}]*\}\}/g) ?? [];
    if (tokens.some(x=>!['{{送信先名}}','{{登録者名}}','{{確認日時}}','{{施設名}}'].includes(x))) fail(400,'UNKNOWN_TEMPLATE_TOKEN','差し込み項目を確認してください。');
    return transaction(this.pool,async db=> {
      const row=(await db.query("SELECT updated_at::text AS revision FROM app_meta.admin_settings WHERE setting_key='mail.safety' FOR UPDATE")).rows[0];
      if (row.revision!==body.expected_revision) fail(409,'ADMIN_REVISION_CHANGED','テンプレートを再読み込みしてください。');
      await db.query("UPDATE app_meta.admin_settings SET document=$1,updated_at=clock_timestamp() WHERE setting_key='mail.safety'",[{subject:body.subject,body:body.body}]);
      await audit(db,this.config,request,'admin.template.updated','settings','mail.safety');
      return { saved:true };
    });
  }
  async publishPolicy(request,body) {
    const type='registration';
    return transaction(this.pool,async db=> {
      await db.query('SELECT pg_advisory_xact_lock(17001003)');
      const key=`policy.${type}.${body.policy_version}`;
      if ((await db.query('SELECT 1 FROM app_meta.admin_settings WHERE setting_key=$1',[key])).rowCount) fail(409,'POLICY_VERSION_EXISTS','新しい版番号を指定してください。');
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      if (body.effective_date<today) fail(400,'POLICY_DATE_IN_PAST','適用日は本日以降にしてください。');
      await db.query('INSERT INTO app_meta.admin_settings(setting_key,document) VALUES($1,$2)',[key,{...body,title:body.body.split('\n')[0].trim().slice(0,100),requires_reconsent:false,consent_type:type,status:'published'}]);
      await audit(db,this.config,request,'admin.policy.published','policy',key);
      return { published:true,effective_date:body.effective_date };
    });
  }

}

export async function registerAdmin(app,deps) {
  const service=new AdminService(deps);
  await app.register(async api=> {
    api.decorateRequest('admin',null); api.decorateRequest('adminSession',null);
    api.addHook('onRequest',async request=> {
      if (request.routeOptions.url==='/v1/admin/login') return;
      await service.auth.authenticate(request,!['GET','HEAD'].includes(request.method));
    });
    api.addHook('onResponse',async(request,reply)=> {
      if (reply.statusCode>=400 && request.admin) {
        // All rejected admin actions are audited after their transaction rolls back.
        request.auditReason=null;
        const requestedReason=request.body?.reason;
        request.body={reason:['support','correction','suspension','deletion','audit'].includes(requestedReason) ? requestedReason : undefined};
        await service.log(request,'admin.request.denied','admin_api',request.routeOptions.url).catch(()=>api.log.error({errorCode:'ADMIN_DENIAL_AUDIT_FAILED'},'audit_failed'));
      }
    });
    const mutate=(schema,action)=>async (request,reply)=> {
      request.body=schema ? schema.parse(request.body??{}) : z.strictObject({}).parse(request.body??{});
      if (request.params.id) uuid.parse(request.params.id);
      if (request.params.recipientId) uuid.parse(request.params.recipientId);
      const key=request.headers['idempotency-key'];
      if (typeof key!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(key)) fail(400,'IDEMPOTENCY_KEY_REQUIRED','操作番号が必要です。');
      const cacheKey=sha256(`${request.adminSession.auth_version}:${request.method}:${request.url}:${key}`).toString('hex');
      const hash=sha256(canonical(request.body)).toString('hex');
      return deps.store.lock('admin-operation',cacheKey,async()=> {
        const previous=await deps.store.get('admin-operation',cacheKey);
        if (previous) {
          if (previous.hash!==hash) fail(409,'IDEMPOTENCY_CONFLICT','同じ操作番号で内容が変更されました。');
          reply.header('Idempotency-Replayed','true'); return previous.body;
        }
        const body=await action(request,request.body,reply);
        await deps.store.put('admin-operation',cacheKey,{hash,body},new Date(Date.now()+900000).toISOString());
        return body;
      });
    };
    api.post('/v1/admin/login',async (request,reply)=>service.auth.login(request,adminSchemas.login.parse(request.body),reply));
    api.get('/v1/admin/session',request=>({admin:adminProfile(request.admin),csrf_token:request.adminSession.csrf}));
    api.post('/v1/admin/logout',mutate(null,async(request,body,reply)=> {
      await service.log(request,'admin.logout');
      await deps.store.remove('admin-session',request.adminSession.key);
      reply.header('Set-Cookie',service.auth.cookie('',true));return {logged_out:true};
    }));
    api.put('/v1/admin/profile',mutate(adminSchemas.profile,async(request,body,reply)=> {
      const profile=await transaction(deps.pool,async db=> {
        await service.auth.verifyCurrent(db,request,body.current_password);
        const row=(await db.query(`UPDATE app_meta.administrator SET name=$1,email=$2,password_hash=COALESCE($3,password_hash),
          auth_version=auth_version+1,updated_at=clock_timestamp() WHERE singleton RETURNING *`,[body.name,body.email,body.new_password ? await passwordHash(body.new_password) : null])).rows[0];
        await audit(db,deps.config,request,'admin.profile.updated','administrator','singleton'); return adminProfile(row);
      });
      await deps.store.remove('admin-session',request.adminSession.key);
      reply.header('Set-Cookie',service.auth.cookie('',true)); return {admin:profile,reauthenticate:true};
    }));
    api.get('/v1/admin/dashboard',request=>service.dashboard(request));
    api.get('/v1/admin/users',request=>service.list(request));
    api.post('/v1/admin/users/search',mutate(adminSchemas.search,(request,body)=>service.list(request,body)));
    api.put('/v1/admin/users/:id',mutate(adminSchemas.user,(request,body)=>service.updateUser(request,body)));
    api.delete('/v1/admin/users/:id',mutate(adminSchemas.deletion,(request,body)=>service.deleteUser(request,body)));
    api.delete('/v1/admin/users/:id/recipients/:recipientId',mutate(adminSchemas.deletion,(request,body)=>service.deleteRecipient(request,body)));
    api.post('/v1/admin/users/:id/face',mutate(adminSchemas.face,(request,body)=>service.reenroll(request,body)));
    api.post('/v1/admin/users/:id/consent',mutate(adminSchemas.consent,(request,body)=>service.reconsent(request,body)));
    api.get('/v1/admin/settings',request=>service.settings(request));
    api.put('/v1/admin/mail-template',mutate(adminSchemas.template,(request,body)=>service.saveTemplate(request,body)));
    api.post('/v1/admin/policies/registration',mutate(adminSchemas.policy,(request,body)=>service.publishPolicy(request,body)));
  });
}
