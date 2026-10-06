import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {loadLocalEnv,readConfig} from '../../src/config.js';
import {createPool} from '../../src/db.js';
import {LocalCipher,sha256} from '../../src/crypto.js';
import {TemporaryStore} from '../../src/temporary-store.js';
import {createApp} from '../../src/app.js';
import {passwordHash} from '../../src/admin-auth.js';
import {MailWorker} from '../../src/mail-worker.js';
import {mailMessage} from '../../src/mail-message.js';
import {auditDigest} from '../../src/audit.js';

if (!/^anshin_api_test_[a-zA-Z0-9_]+$/.test(process.env.TEST_DATABASE_NAME??'')) throw new Error('Isolated test database required');
let pool,config,cipher,store,app,worker,terminal,cookie,csrf,user,face,mail;
let password='test-admin-password-123';
const address='admin@example.com';
before(async()=> {
  loadLocalEnv();config=await readConfig();config.postgres={...config.postgres,database:process.env.TEST_DATABASE_NAME};delete config.postgres.connectionString;
  config.apiDebugLogEnabled=false; pool=createPool(config);cipher=new LocalCipher(config.encryptionKey);store=new TemporaryStore(config);
  await pool.query(`INSERT INTO app_meta.administrator(name,email,password_hash) VALUES('Admin',$1,$2)`,[address,await passwordHash(password)]);
  face={name:'test-face',ready:true,deleted:[],requireReady(){},async captureImage(){return {image:Buffer.from('test-photo'),metrics:{},livenessPassed:false};},async search(){return {candidates:[]};},async index(){return {faceId:randomUUID(),collectionId:'test',modelVersion:'test-v1'};},async delete(ref){this.deleted.push(ref.faceId);}};
  mail={name:'test-mail',ready:true,sends:[],async send(message){this.sends.push(message);return {messageId:randomUUID()};}};
  const policies=['registration','safety'].map(consent_type=>({consent_type,policy_version:'test-v1',title:'Test',body:'Test policy',status:'published',requires_reconsent:false}));
  const deps={pool,config,cipher,store,face,mail,policies,logger:false};app=await createApp(deps);worker=new MailWorker(deps);
  app.addHook('onError',(request,reply,error,done)=>{ if (reply.statusCode>=500 || !error.status && error.name!=='ZodError') console.error('ADMIN_TEST_ERROR',error.code,error.message); done(); });
  await app.ready();
  terminal=(await pool.query("SELECT * FROM terminals WHERE terminal_code='LOCAL-DEV-01'")).rows[0];
  const id=randomUUID();
  await pool.query(`INSERT INTO users(user_id,display_name,status,terminal_id,registered_at) VALUES($1,$2,'active',$3,clock_timestamp())`,[id,await cipher.seal('試験 利用者','user-name'),terminal.terminal_id]);
  await pool.query(`INSERT INTO face_templates(user_id,encrypted_template,model_version,threshold_version,provider) VALUES($1,$2,'test','test','test-face')`,[id,await cipher.seal({faceId:'old-face',collectionId:'test'},'face-reference')]);
  await pool.query(`INSERT INTO recipients(user_id,name,encrypted_email,order_no) VALUES($1,$2,$3,1)`,[id,await cipher.seal('家族','recipient-name'),await cipher.seal('family@example.com','recipient-email')]);
  await pool.query(`INSERT INTO consents(user_id,policy_version,terminal_id,result,consent_type) VALUES($1,'test-v1',$2,'granted','registration')`,[id,terminal.terminal_id]);
});
after(async()=> {
  if (app) await app.close();store?.close();
  if (pool) {await pool.query('DELETE FROM app_meta.administrator');await pool.query('DELETE FROM app_meta.admin_settings');
    // Preserve audit records for the existing full-chain verification tests.
    if (terminal) {
      await pool.query('DELETE FROM safety_checks WHERE terminal_id=$1',[terminal.terminal_id]);
      await pool.query('DELETE FROM consents WHERE terminal_id=$1',[terminal.terminal_id]);
    }
    await pool.query("DELETE FROM users WHERE user_id=$1",[user?.id]);await pool.end();}
});
async function call(method,path,body,extra={}) {
  const response=await app.inject({method,url:`/v1/admin${path}`,headers:{...(cookie ? {cookie} : {}),
    ...(method==='GET'?{}:{'x-csrf-token':csrf??'','idempotency-key':randomUUID()}),...extra},...(body===undefined?{}:{payload:body})});
  return {status:response.statusCode,body:response.json(),response};
}
async function ok(method,path,body,extra) {const result=await call(method,path,body,extra);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;}
async function freshUser() {user=(await ok('GET','/users')).users.find(x=>x.name==='試験 利用者');return user;}
const userBody=changes=>({name:user.name,status:user.status,recipients:user.recipients.map(({id,name,email})=>({id,name,email})),expected_revision:user.revision,identity_confirmed:true,reset_face:false,reason:'correction',...changes});

test('password-only login grants admin authority; anonymous requests and wrong passwords are rejected',async()=> {
  assert.equal((await call('GET','/users')).status,401);
  assert.equal((await call('POST','/login',{email:address,password:'wrong'})).status,401);
  const response=await call('POST','/login',{email:address,password});
  assert.equal(response.status,200);cookie=response.response.headers['set-cookie'].split(';')[0];csrf=response.body.csrf_token;
  assert.match(response.response.headers['set-cookie'],/HttpOnly; SameSite=Strict/);
  assert.equal(response.body.admin.password,undefined);
  assert.equal((await call('POST','/login',{email:address,password},{origin:'https://attacker.example'})).status,403);
  await freshUser();assert.equal(user.name,'試験 利用者');
});
test('mutations require CSRF and a live revision; contact corrections enqueue one notification',async()=> {
  assert.equal((await call('PUT',`/users/${user.id}`,userBody({}),{'x-csrf-token':''})).status,403);
  assert.equal((await call('PUT',`/users/${user.id}`,userBody({expected_revision:'old'}))).status,409);
  assert.equal((await call('PUT',`/users/${user.id}`,userBody({identity_confirmed:false}))).status,400);
  const key=randomUUID(),body=userBody({recipients:[{id:user.recipients[0].id,name:user.recipients[0].name,email:'corrected@example.com'}]});
  const first=await ok('PUT',`/users/${user.id}`,body,{'idempotency-key':key});
  const replay=await ok('PUT',`/users/${user.id}`,body,{'idempotency-key':key});assert.deepEqual(first,replay);
  assert.equal((await pool.query("SELECT count(*) AS n FROM safety_checks WHERE user_id=$1 AND check_type='contact_change'",[user.id])).rows[0].n,'1');
  await worker.tick();assert.equal(mail.sends.length,1);assert.equal(mail.sends[0].email,'corrected@example.com');
  assert.match(mailMessage(config,mail.sends[0]).subject,/連絡先変更/);await freshUser();
});
test('duplicate contact emails and foreign recipient IDs are rejected without partial changes',async()=> {
  assert.equal((await call('PUT',`/users/${user.id}`,userBody({recipients:[{name:'A',email:'same@example.com'},{name:'B',email:'same@example.com'}]}))).status,400);
  assert.equal((await call('PUT',`/users/${user.id}`,userBody({recipients:[{id:randomUUID(),name:'A',email:'other@example.com'}]}))).status,400);
  assert.equal((await freshUser()).recipients[0].email,'corrected@example.com');
});
test('templates persist and render through the real mail-message code',async()=> {
  const settings=await ok('GET','/settings');
  assert.equal((await call('PUT','/mail-template',{subject:'bad\nsubject',body:'Body',expected_revision:settings.mail.revision})).status,400);
  assert.equal((await call('PUT','/mail-template',{subject:'{{unknown}}',body:'Body',expected_revision:settings.mail.revision})).status,400);
  await ok('PUT','/mail-template',{subject:'安否 {{登録者名}}',body:'{{送信先名}} {{施設名}} {{確認日時}}',expected_revision:settings.mail.revision});
  const saved=await ok('GET','/settings');assert.equal(saved.mail.subject,'安否 {{登録者名}}');
  const content=mailMessage(config,{displayName:'本人',recipientName:'家族',occurredAt:new Date(),timezone:'Asia/Tokyo',type:'safety',template:saved.mail});
  assert.equal(content.subject,'安否 本人');assert.match(content.text,/家族/);
});
test('policies keep history, activate on the effective date, and accept witnessed reconsent',async()=> {
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const body={policy_version:'admin-v2',title:'新文面',body:'新しい同意本文',effective_date:today,requires_reconsent:true};
  await ok('POST','/policies/registration',body);
  assert.equal((await call('POST','/policies/registration',body)).status,409);
  const publicPolicy=(await app.inject('/v1/consent-policies?type=registration')).json();assert.equal(publicPolicy.policy_version,'admin-v2');
  await ok('POST','/policies/registration',{...body,policy_version:'future-v3',effective_date:'2099-01-01'});
  assert.equal((await app.inject('/v1/consent-policies?type=registration')).json().policy_version,'admin-v2');
  assert.equal((await pool.query("SELECT count(*) AS n FROM app_meta.admin_settings WHERE setting_key LIKE 'policy.registration.%'")).rows[0].n,'3');
  await freshUser();const renewed=await ok('POST',`/users/${user.id}/consent`,{expected_revision:user.revision,owner_present:true,consent_granted:true,policy_version:'admin-v2'});
  user=renewed.user;assert.equal(user.consentVersion,'admin-v2');
});
test('suspension invalidates face templates and reenrollment requires presence and current consent',async()=> {
  user=(await ok('PUT',`/users/${user.id}`,userBody({status:'suspended',reset_face:true,reason:'suspension'}))).user;
  assert.equal(user.faceStatus,'renewal');
  assert.equal((await pool.query("SELECT status FROM face_templates WHERE user_id=$1",[user.id])).rows[0].status,'revoked');
  assert.equal((await call('PUT',`/users/${user.id}`,userBody({status:'active'}))).body.error.code,'FACE_REENROLLMENT_REQUIRED');
  const body={image_base64:'aW1hZ2U=',expected_revision:user.revision,owner_present:true,consent_granted:true,policy_version:'admin-v2'};
  assert.equal((await call('POST',`/users/${user.id}/face`,{...body,owner_present:false})).status,400);
  user=(await ok('POST',`/users/${user.id}/face`,body)).user;assert.equal(user.status,'active');assert.equal(user.faceStatus,'registered');
});
test('deleting the last recipient suspends recognition; deleting a user erases personal snapshots and keeps audit evidence',async()=> {
  const id=user.id;
  user=(await ok('DELETE',`/users/${id}/recipients/${user.recipients[0].id}`,{expected_revision:user.revision,reason:'deletion'})).user;
  assert.equal(user.status,'suspended');assert.equal(user.recipients.length,0);
  await ok('DELETE',`/users/${id}`,{expected_revision:user.revision,reason:'deletion'});
  assert.equal((await pool.query('SELECT status FROM users WHERE user_id=$1',[id])).rows[0].status,'deleted');
  assert.equal((await pool.query('SELECT encrypted_email_snapshot FROM mail_deliveries WHERE user_id=$1',[id])).rows[0].encrypted_email_snapshot,null);
  assert.equal((await ok('GET','/users')).users.some(x=>x.id===id),false);
  assert.ok((await ok('GET','/audit-logs')).logs.some(x=>x.action==='admin.user.deleted' && x.reason==='deletion'));
  const rows=(await pool.query('SELECT * FROM audit_logs ORDER BY log_id')).rows;let previous=null;
  for (const row of rows) {assert.deepEqual(row.entry_hmac,auditDigest(config,row,previous));previous=row.entry_hmac;}
});
test('account changes require the current password, revoke sessions and allow password-only relogin and logout',async()=> {
  const updatedPassword='updated-admin-password-456';
  const body={name:'Updated Admin',email:address,current_password:'incorrect',new_password:updatedPassword};
  assert.equal((await call('PUT','/profile',body)).status,401);
  const saved=await ok('PUT','/profile',{...body,current_password:password});
  assert.equal(saved.admin.name,'Updated Admin');assert.equal(saved.reauthenticate,true);
  assert.equal((await call('GET','/session')).status,401);
  assert.equal((await call('POST','/login',{email:address,password})).status,401);
  password=updatedPassword;
  let response=await call('POST','/login',{email:address,password});assert.equal(response.status,200);
  cookie=response.response.headers['set-cookie'].split(';')[0];csrf=response.body.csrf_token;
  assert.equal((await ok('GET','/session')).admin.name,'Updated Admin');
  await ok('POST','/logout');assert.equal((await call('GET','/session')).status,401);
  response=await call('POST','/login',{email:address,password});assert.equal(response.status,200);
  cookie=response.response.headers['set-cookie'].split(';')[0];csrf=response.body.csrf_token;
});

test('idle timeout, session revocation and persistent login lockout apply',async()=> {
  const raw=cookie.split('=')[1],key=sha256(raw).toString('hex'),session=await store.get('admin-session',key);
  await store.put('admin-session',key,{...session,last_activity:Date.now()-16*60000},session.expires_at);
  assert.equal((await call('GET','/dashboard')).status,401);
  const response=await call('POST','/login',{email:address,password});cookie=response.response.headers['set-cookie'].split(';')[0];csrf=response.body.csrf_token;
  await pool.query('UPDATE app_meta.administrator SET auth_version=auth_version+1');
  assert.equal((await call('GET','/dashboard')).status,401);
  for(let i=0;i<5;i++) await call('POST','/login',{email:address,password:'wrong'});
  assert.equal((await call('POST','/login',{email:address,password})).status,429);
});
