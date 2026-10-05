import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadLocalEnv, readConfig } from '../../src/config.js';
import { createPool } from '../../src/db.js';
import { LocalCipher } from '../../src/crypto.js';
import { TemporaryStore } from '../../src/temporary-store.js';
import { createApp } from '../../src/app.js';
import { ensureSingleTerminal, SINGLE_TERMINAL_CODE, SINGLE_TERMINAL_ID } from '../../src/single-terminal.js';
import { MailWorker } from '../../src/mail-worker.js';
import { MailFailure } from '../../src/providers/aws-mail.js';
import { auditDigest } from '../../src/audit.js';

if (!/^anshin_api_test_[a-zA-Z0-9_]+$/.test(process.env.TEST_DATABASE_NAME ?? '')) throw new Error('TEST_DATABASE_NAME must name an isolated anshin_api_test_* database');
let app, pool, config, store, worker, terminal, otherTerminal, face, mail;
let identity = 'person-a';
const observedErrors = [];

before(async () => {
  loadLocalEnv(); config = await readConfig();
  config.postgres = { ...config.postgres, database: process.env.TEST_DATABASE_NAME };
  delete config.postgres.connectionString;
  pool = createPool(config);
  store = new TemporaryStore(config);
  const facility = { facility_id:randomUUID() };
  const created = await ensureSingleTerminal(pool);
  assert.equal(created.terminal_id, SINGLE_TERMINAL_ID);
  assert.equal(created.credential_fingerprint, null);
  // 旧環境の端末UUIDを模擬し、起動時に置き換えないことを確認します。
  await pool.query('UPDATE terminals SET terminal_id=$1 WHERE terminal_code=$2', [randomUUID(), SINGLE_TERMINAL_CODE]);
  terminal = await ensureSingleTerminal(pool);
  assert.notEqual(terminal.terminal_id, SINGLE_TERMINAL_ID);
  otherTerminal = (await pool.query(`INSERT INTO terminals(facility_id,terminal_code,name,status) VALUES($1,$2,'Other terminal','active') RETURNING *`, [facility.facility_id, randomUUID()])).rows[0];
  const policies = ['registration','safety'].map(consent_type => ({consent_type,policy_version:'test-v1',title:'Test',body:'Test policy',status:'published',requires_reconsent:false}));
  face = {
    name: 'test-face', ready: true, references: new Map(), sessions: new Map(), override: null, indexCalls: 0, failCapture: false,
    requireReady() { if (!this.ready) { const e = new Error('unavailable'); e.status=503; e.code='SERVICE_NOT_CONFIGURED'; throw e; } },
    async createLiveness() { const id = randomUUID(); this.sessions.set(id, identity); return { sessionId: id, region: 'test' }; },
    async capture(id) {
      if (this.failCapture) { const { ApiError } = await import('../../src/errors.js'); throw new ApiError(422,'FACE-004','Liveness rejected'); }
      return { image: Buffer.from(this.sessions.get(id)), qualityPassed: true, livenessPassed: true };
    },
    async captureImage() {
      return { image: Buffer.from(identity), qualityPassed: true, livenessPassed: false,
        metrics: { face_confidence: 99.8, brightness: 60, sharpness: 85 } };
    },
    async index(image, userId) { this.indexCalls++; const ref = { faceId: randomUUID(), collectionId: 'test', modelVersion: 'test-v1', provider: this.name };
      this.references.set(userId, { ...ref, identity: image.toString() }); return ref; },
    async search(image) { return { modelVersion: 'test-v1', candidates: this.override ?? [...this.references].filter(([,ref])=>ref.identity===image.toString()).map(([userId,ref])=>({ userId,faceId:ref.faceId,score:0.999 })) }; },
    async delete(ref) { for (const [id,value] of this.references) if (value.faceId===ref.faceId) this.references.delete(id); }
  };
  mail = { name: 'test-mail', ready: true, sends: [], outcomes: [], async send(message) {
    this.sends.push(message); const outcome = this.outcomes.shift(); if (outcome) throw outcome; return { messageId: randomUUID() };
  } };
  const deps = { pool, config, store, face, mail, policies, cipher: new LocalCipher(config.encryptionKey), logger: false,
    webhookVerifier: async () => {} }; // Test injection only; server runtime always verifies real SNS signatures.
  app = await createApp(deps);
  app.addHook('onError', (request, reply, error, done) => { observedErrors.push({ code:error.code, message:error.message, constraint:error.constraint }); done(); });
  worker = new MailWorker(deps); await app.ready();
});
after(async () => {
  if (app) await app.close();
  store?.close();
  if (pool) await pool.end();
});

async function request(method, url, body, userId, extra = {}) {
  const headers = { ...(method !== 'GET' ? { 'idempotency-key': randomUUID() } : {}), ...extra };
  if (userId) {
    if (method === 'GET') url += `${url.includes('?') ? '&' : '?'}user_id=${userId}`;
    else if (!url.match(/\/users\/[^/]+\/recipients$/)) body = { ...body, user_id: body?.user_id ?? userId };
  }
  const response = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body } : {}) });
  return { status: response.statusCode, body: response.statusCode===204 ? null : response.json(), response };
}
async function success(method,url,body,userToken,extra) {
  const result = await request(method,url,body,userToken,extra);
  assert.ok(result.status>=200 && result.status<300, `${method} ${url}: ${JSON.stringify(result.body)}`);
  return result.body;
}
async function liveness(purpose, enrollmentId, userToken) {
  return (await success('POST','/v1/faces/liveness-sessions',{ purpose, ...(enrollmentId ? { enrollment_id: enrollmentId } : {}) },userToken)).liveness_session_id;
}
async function enroll(label, recipients = [{ name: '家族', email: `${label}@example.com` }]) {
  identity = label;
  const draft = await success('POST','/v1/enrollments',{});
  const id = draft.temp_id;
  await success('PATCH',`/v1/enrollments/${id}/profile`,{ display_name: `利用者 ${label}` });
  await success('POST',`/v1/enrollments/${id}/face`,{ liveness_session_id: await liveness('enrollment',id) });
  await success('POST',`/v1/enrollments/${id}/consent`,{ policy_version: 'test-v1',result:'granted' });
  await success('PUT',`/v1/enrollments/${id}/recipients`,{ recipients });
  const key = randomUUID();
  const completed = await success('POST',`/v1/enrollments/${id}/complete`,{},null,{ 'idempotency-key': key });
  const replay = await request('POST',`/v1/enrollments/${id}/complete`,{},null,{ 'idempotency-key': key });
  assert.deepEqual(replay.body,completed); assert.equal(replay.response.headers['idempotency-replayed'],'true');
  assert.equal(await store.get('draft',id),null);
  const verified = await success('POST','/v1/faces/verify-registration',{ liveness_session_id: await liveness('registration',null,completed.user_id) },completed.user_id);
  assert.equal(verified.result,'matched');
  await success('POST','/v1/users/me/confirmation',{ confirmed:true },verified.user_id);
  const check = await success('POST',`/v1/enrollments/${id}/confirmation-mails`,{},verified.user_id);
  await worker.tick();
  const result = await success('GET',`/v1/safety-checks/${check.check_id}`,undefined,verified.user_id);
  assert.equal(result.status,'accepted');
  return { userId: completed.user_id, token: verified.user_id, checkId: check.check_id, enrollmentId:id };
}
async function identify(label) {
  identity = label;
  const result = await success('POST','/v1/faces/identify',{ liveness_session_id: await liveness('safety') });
  assert.equal(result.result,'matched');
  return result.user_id;
}
let personA, personB;

test('published policies are public and device-free writes still require idempotency', async () => {
  for (const type of ['registration','safety']) {
    const response=await app.inject({method:'GET',url:`/v1/consent-policies?type=${type}`,headers:{origin:'http://frontend.example:5174'}});
    assert.equal(response.statusCode,200);
    assert.equal(response.json().policy_version,'test-v1');
    assert.equal(response.json().body,'Test policy');
    assert.equal(response.headers['access-control-allow-origin'],'*');
    assert.equal(response.headers['cache-control'],'no-store');
  }
  assert.equal((await app.inject({method:'GET',url:'/v1/consent-policies?type=invalid'})).statusCode,400);
  for (const [url,payload] of [['/v1/enrollments',{}],['/v1/faces/identify',{image_base64:'aQ=='}]]) {
    const response=await app.inject({method:'POST',url,payload});
    assert.equal(response.statusCode,400);
    assert.equal(response.json().error.code,'IDEMPOTENCY_KEY_REQUIRED');
  }
});

test('single robot works without device headers and ignores client device overrides', async () => {
  const direct = await app.inject({ method:'GET',url:'/v1/terminal' });
  assert.equal(direct.statusCode,200);
  assert.equal(direct.json().terminal_id,terminal.terminal_id);
  const overridden = await success('GET','/v1/terminal',undefined,null,
    { 'x-terminal-id':otherTerminal.terminal_id,'x-terminal-token':'unused' });
  assert.equal(overridden.terminal_id,terminal.terminal_id);
  await pool.query("UPDATE terminals SET status='maintenance' WHERE terminal_id=$1",[terminal.terminal_id]);
  try {
    const inactive=await request('GET','/v1/terminal');
    assert.equal(inactive.status,503);
    assert.equal(inactive.body.error.code,'TERMINAL_UNAVAILABLE');
    assert.equal((await ensureSingleTerminal(pool)).status,'maintenance');
  } finally {
    await pool.query("UPDATE terminals SET status='active' WHERE terminal_id=$1",[terminal.terminal_id]);
  }
  assert.equal((await request('POST','/v1/registrations/capture',{image_base64:'aGVsbG8='},null,
    {'idempotency-key':''})).body.error.code,'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal((await success('GET','/v1/consent-policies?type=registration')).policy_version,'test-v1');
  mail.ready=false;
  assert.equal((await request('POST','/v1/safety-checks',{ user_id:randomUUID(),policy_version:'test-v1',consent:true })).status,503);
  mail.ready=true;
});
test('pre-consent fields live only in encrypted temporary storage; denial erases them', async () => {
  const baseline = Number((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n);
  identity='denied-person';
  const draft = await success('POST','/v1/enrollments',{});
  await success('PATCH',`/v1/enrollments/${draft.temp_id}/profile`,{ display_name:'一時利用者' });
  await success('POST',`/v1/enrollments/${draft.temp_id}/face`,{ liveness_session_id:await liveness('enrollment',draft.temp_id) });
  const raw = await store.state.get(store.key('draft',draft.temp_id));
  assert.ok(!raw.includes('一時利用者') && !raw.includes('denied-person'));
  await success('POST',`/v1/enrollments/${draft.temp_id}/consent`,{ policy_version:'test-v1',result:'denied' });
  assert.equal(await store.get('draft',draft.temp_id),null);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n),baseline);
  assert.equal(face.indexCalls,0);
});
test('registration with two contacts persists encrypted data and activates after mail acceptance', async () => {
  personA=await enroll('person-a',[{ name:'家族1',email:'family-one@example.com' },{ name:'家族2',email:'family-two@example.com' }]);
  const user=(await pool.query('SELECT * FROM users WHERE user_id=$1',[personA.userId])).rows[0];
  assert.equal(user.status,'active'); assert.ok(!user.display_name.includes(Buffer.from('利用者')));
  assert.equal((await pool.query('SELECT count(*) AS n FROM recipients WHERE user_id=$1',[personA.userId])).rows[0].n,'2');
  assert.deepEqual(mail.sends.map(x=>x.email),['family-one@example.com','family-two@example.com']);
  const recipients=await success('GET','/v1/users/me/recipients',undefined,personA.token);
  assert.equal(recipients.recipients[0].masked_email,'fa•••@example.com');
  assert.equal(JSON.stringify(recipients).includes('family-one@'),false);
});
test('unconfirmed recognition cannot reveal contacts or send; rejecting identity ends verification', async () => {
  const raw=await identify('person-a');
  assert.equal((await request('GET','/v1/users/me/recipients',undefined,raw)).status,403);
  assert.equal((await request('POST','/v1/safety-checks',{ policy_version:'test-v1',consent:true },raw)).status,403);
  await success('POST','/v1/users/me/confirmation',{ confirmed:false },raw);
  assert.equal((await request('GET','/v1/users/me/recipients',undefined,raw)).status,409);
});
test('concurrent duplicate safety requests create one event and exactly one delivery per contact', async () => {
  const raw=await identify('person-a'); await success('POST','/v1/users/me/confirmation',{ confirmed:true },raw);
  const key=randomUUID(); const body={ policy_version:'test-v1',consent:true };
  const [a,b]=await Promise.all([request('POST','/v1/safety-checks',body,raw,{ 'idempotency-key':key }),request('POST','/v1/safety-checks',body,raw,{ 'idempotency-key':key })]);
  assert.equal(a.status,202);assert.equal(b.status,202);assert.equal(a.body.check_id,b.body.check_id);
  assert.equal((await pool.query('SELECT count(*) AS n FROM mail_deliveries WHERE check_id=$1',[a.body.check_id])).rows[0].n,'2');
  const count=mail.sends.length; await worker.tick(); await worker.tick(); assert.equal(mail.sends.length,count+2);
  assert.equal((await success('GET',`/v1/safety-checks/${a.body.check_id}`,undefined,raw)).status,'accepted');
  assert.equal((await request('POST','/v1/safety-checks',{ policy_version:'different',consent:true },raw,{ 'idempotency-key':key })).status,409);
});
test('a user ID from another user or terminal cannot read a send result', async () => {
  personB=await enroll('person-b');
  assert.equal((await request('GET',`/v1/safety-checks/${personA.checkId}`,undefined,personB.token)).status,404);
  assert.equal((await request('GET','/v1/users/me/recipients')).status,400);
  const hash=personA.userId;
  const session=await store.get('session',hash);
  const originalTerminal=session.terminal_id;
  session.terminal_id=otherTerminal.terminal_id;
  await store.put('session',hash,session,session.expires_at);
  try {
    assert.equal((await request('GET','/v1/users/me/recipients',undefined,personA.token)).status,409);
  } finally {
    session.terminal_id=originalTerminal;
    await store.put('session',hash,session,session.expires_at);
  }
});
test('expired and idle sessions do not reveal personal information', async () => {
  const raw=await identify('person-a'); await success('POST','/v1/users/me/confirmation',{ confirmed:true },raw);
  const sessionHash=raw;
  const session=await store.get('session',sessionHash);
  session.last_activity_at=new Date(Date.now()-91000).toISOString();
  await store.put('session',sessionHash,session,session.expires_at);
  assert.equal((await request('GET','/v1/users/me/recipients',undefined,raw)).status,409);
});
test('ambiguous and absent recognition results return no names or user ID', async () => {
  const [idA,refA]=[personA.userId,face.references.get(personA.userId)]; const [idB,refB]=[personB.userId,face.references.get(personB.userId)];
  face.override=[{ userId:idA,faceId:refA.faceId,score:0.999 },{ userId:idB,faceId:refB.faceId,score:0.998 }];
  const ambiguous=await success('POST','/v1/faces/identify',{ liveness_session_id:await liveness('safety') });
  assert.equal(ambiguous.result,'ambiguous');assert.equal(ambiguous.display_name,undefined);assert.equal(ambiguous.user_id,undefined);
  face.override=[];
  const missing=await success('POST','/v1/faces/identify',{ liveness_session_id:await liveness('safety') });
  assert.equal(missing.result,'no_match');assert.equal(missing.display_name,undefined);
  face.override=null; await store.clearFailures(terminal.terminal_id);
});
test('liveness sessions are single use and bound to a terminal; client flags are rejected', async () => {
  identity='person-a';const id=await liveness('safety');
  assert.equal((await request('POST','/v1/faces/identify',{ liveness_session_id:id, liveness_passed:true })).status,400);
  const record=await store.get('liveness',id);
  const expiry=new Date(Date.now()+60000).toISOString();
  record.terminalId=otherTerminal.terminal_id;
  await store.put('liveness',id,record,expiry);
  assert.equal((await request('POST','/v1/faces/identify',{ liveness_session_id:id })).status,410);
  record.terminalId=terminal.terminal_id;
  await store.put('liveness',id,record,expiry);
  await success('POST','/v1/faces/identify',{ liveness_session_id:id });
  assert.equal((await request('POST','/v1/faces/identify',{ liveness_session_id:id })).status,410);
});
test('partial failures keep per-contact state and accepted mail is not retried', async () => {
  const raw=await identify('person-a'); await success('POST','/v1/users/me/confirmation',{ confirmed:true },raw);
  const check=await success('POST','/v1/safety-checks',{ policy_version:'test-v1',consent:true },raw);
  mail.outcomes=[null,new MailFailure('MAIL-001')]; const baseline=mail.sends.length;
  await worker.tick();
  const result=await success('GET',`/v1/safety-checks/${check.check_id}`,undefined,raw);
  assert.equal(result.status,'partially_accepted');assert.deepEqual(result.recipient_results.map(x=>x.status),['accepted','failed']);
  assert.equal((await request('POST',`/v1/safety-checks/${check.check_id}/retry`,{},raw)).status,409);
  await worker.tick();assert.equal(mail.sends.length,baseline+2);
});
test('unknown SES outcome is never automatically resent and signed callbacks reconcile it', async () => {
  const raw=await identify('person-b'); await success('POST','/v1/users/me/confirmation',{ confirmed:true },raw);
  const check=await success('POST','/v1/safety-checks',{ policy_version:'test-v1',consent:true },raw);
  mail.outcomes=[new MailFailure('MAIL_RESULT_UNKNOWN',{ uncertain:true })];const baseline=mail.sends.length;
  await worker.tick();await worker.tick();
  const result=await success('GET',`/v1/safety-checks/${check.check_id}`,undefined,raw);
  assert.equal(result.status,'unknown');assert.equal(mail.sends.length,baseline+1);
  assert.equal((await request('POST',`/v1/safety-checks/${check.check_id}/retry`,{},raw)).status,409);
  const messageId=randomUUID();const notification={ Type:'Notification',MessageId:randomUUID(),
    Message:JSON.stringify({ eventType:'Delivery',mail:{ messageId,tags:{ anshin_delivery_id:[result.recipient_results[0].delivery_id] } },delivery:{ timestamp:new Date().toISOString() } }) };
  assert.equal((await app.inject({ method:'POST',url:'/v1/mail/webhooks',payload:notification })).statusCode,204,JSON.stringify(observedErrors.slice(-1)));
  assert.equal((await app.inject({ method:'POST',url:'/v1/mail/webhooks',payload:notification })).statusCode,204);
  const final=await success('GET',`/v1/safety-checks/${check.check_id}`,undefined,raw);
  assert.equal(final.recipient_results[0].status,'delivered');
  assert.equal(await store.state.get(store.key('webhook',`test-mail:${notification.MessageId}`)),'1');
});
test('expired send requests are cancelled before contacting SES', async () => {
  const raw=await identify('person-b'); await success('POST','/v1/users/me/confirmation',{ confirmed:true },raw);
  const check=await success('POST','/v1/safety-checks',{ policy_version:'test-v1',consent:true },raw);
  await pool.query(`UPDATE safety_checks SET expires_at=clock_timestamp()-interval '1 second' WHERE check_id=$1`,[check.check_id]);
  const count=mail.sends.length;await worker.tick();assert.equal(mail.sends.length,count);
  assert.equal((await success('GET',`/v1/safety-checks/${check.check_id}`,undefined,raw)).status,'cancelled');
});
test('suspension revokes sessions and queues deletion of managed face features', async () => {
  await pool.query(`UPDATE users SET status='suspended',suspended_at=clock_timestamp(),purge_after=clock_timestamp()+interval '30 days' WHERE user_id=$1`,[personB.userId]);
  assert.equal((await request('GET','/v1/users/me/recipients',undefined,personB.token)).status,409);
  assert.equal((await pool.query("SELECT count(*) AS n FROM face_templates WHERE status='revoked'")).rows[0].n,'1');
  await worker.cleanFaces();assert.equal(face.references.has(personB.userId),false);
});
test('photo enrollment and verification return similarity without claiming liveness', async () => {
  identity = 'photo-person'; face.override = null;
  const payload = { image_base64: Buffer.from([255,216,255,224]).toString('base64') };
  const draft = await success('POST','/v1/enrollments',{});
  await success('PATCH',`/v1/enrollments/${draft.temp_id}/profile`,{ display_name:'Photo person' });
  assert.equal((await request('POST',`/v1/enrollments/${draft.temp_id}/face`,payload)).status,409);
  await success('POST',`/v1/enrollments/${draft.temp_id}/consent`,{ policy_version:'test-v1',result:'granted' });
  await success('PUT',`/v1/enrollments/${draft.temp_id}/recipients`,{ recipients:[{name:'Contact',email:'photo@example.com'}] });
  const checked=await success('POST',`/v1/enrollments/${draft.temp_id}/face`,payload);
  assert.equal(checked.metrics.liveness_passed,false);
  const completed=await success('POST',`/v1/enrollments/${draft.temp_id}/complete`,{});
  const verified=await success('POST','/v1/faces/verify-registration',payload,completed.user_id);
  assert.equal(verified.result,'matched');
  assert.equal(verified.metrics.similarity_score,99.9);
  assert.equal(verified.metrics.liveness_passed,false);
  const stored=await store.get('session',verified.user_id);
  assert.equal(stored.authentication_method,'image');
  assert.equal(stored.liveness_passed,false);
  const notActive=await success('POST','/v1/faces/identify',payload);
  assert.equal(notActive.result,'no_match');
  assert.equal(notActive.metrics.similarity_score,null);
});

test('actual audit entries have a valid HMAC chain and contain only opaque identifiers', async () => {
  const rows=(await pool.query('SELECT * FROM audit_logs ORDER BY log_id')).rows;
  let previous=null;
  for (const row of rows) {
    assert.deepEqual(row.previous_entry_hmac,previous);
    assert.deepEqual(auditDigest(config,row,previous),row.entry_hmac);
    assert.equal(JSON.stringify(row).includes('family-one@example.com'),false);
    previous=row.entry_hmac;
  }
  assert.ok(rows.length>10);
});


test('public schema has exactly the eight specification tables and field names', async () => {
  const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename);
  assert.deepEqual(tables,['audit_logs','consents','face_templates','mail_deliveries','recipients','safety_checks','terminals','users']);
  const columns=(await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('users','recipients')")).rows;
  assert.ok(columns.some(r=>r.table_name==='users'&&r.column_name==='display_name'));
  assert.ok(columns.some(r=>r.table_name==='recipients'&&r.column_name==='name'));
  assert.ok(!columns.some(r=>['encrypted_display_name','encrypted_name','display_name_lookup_hmac','email_lookup_hmac'].includes(r.column_name)));
});

test('mail duplicate prevention survives process memory loss', async () => {
  const raw=await identify('person-a'); await success('POST','/v1/users/me/confirmation',{confirmed:true},raw);
  const key=randomUUID(); const body={policy_version:'test-v1',consent:true};
  const first=await success('POST','/v1/safety-checks',body,raw,{'idempotency-key':key});
  store.close(); // Simulates a complete process restart, including session loss.
  const replay=await success('POST','/v1/safety-checks',body,raw,{'idempotency-key':key});
  assert.equal(replay.check_id,first.check_id);
  assert.equal((await pool.query('SELECT count(*) AS n FROM mail_deliveries WHERE check_id=$1',[first.check_id])).rows[0].n,'2');
  await worker.tick();
});


const photoPayload={image_base64:Buffer.from([255,216,255,224]).toString('base64')};
let finalUser;
async function captureAndRegister(label,contacts=[{name:'Contact',email:`${label}@example.com`}]) {
  identity=label;
  const captured=await success('POST','/v1/registrations/capture',photoPayload);
  assert.equal(captured.face_valid,true);
  const body={temp_id:captured.temp_id,display_name:`Final ${label}`,recipients:contacts,policy_version:'test-v1',consent_result:'granted'};
  const key=randomUUID();
  const registered=await success('POST','/v1/registrations',body,null,{'idempotency-key':key});
  const repeated=await success('POST','/v1/registrations',body,null,{'idempotency-key':key});
  assert.deepEqual(repeated,registered);
  assert.equal(registered.user_status,'pending_registration');
  assert.equal(registered.registration_completed,false);
  assert.equal(await store.get('draft',captured.temp_id),null);
  return registered;
}

test('final capture requires no prior consent and neither creates users nor indexes AWS faces',async()=>{
  identity='final-capture';
  const beforeUsers=(await pool.query('SELECT count(*) AS n FROM users')).rows[0].n;
  const beforeIndices=face.indexCalls;
  const draft=await success('POST','/v1/registrations/capture',photoPayload);
  assert.equal(draft.face_valid,true);assert.ok(draft.temp_id);
  assert.equal((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n,beforeUsers);
  assert.equal(face.indexCalls,beforeIndices);
  assert.ok((await store.get('draft',draft.temp_id)).image);
  await success('DELETE',`/v1/registrations/${draft.temp_id}`,{});
  assert.equal(await store.get('draft',draft.temp_id),null);
});

test('final consent denial erases the first image and creates no formal user',async()=>{
  identity='final-denied';const draft=await success('POST','/v1/registrations/capture',photoPayload);
  const before=face.indexCalls;
  const result=await success('POST','/v1/registrations',{temp_id:draft.temp_id,display_name:'Denied',recipients:[{name:'Contact',email:'denied@example.com'}],policy_version:'test-v1',consent_result:'denied'});
  assert.equal(result.success,false);assert.equal(result.user_id,null);assert.equal(face.indexCalls,before);
  assert.equal(await store.get('draft',draft.temp_id),null);
});

test('final registration validates policy version before indexing and keeps a failed draft retryable',async()=>{
  identity='final-stale';const draft=await success('POST','/v1/registrations/capture',photoPayload);const before=face.indexCalls;
  const result=await request('POST','/v1/registrations',{temp_id:draft.temp_id,display_name:'Stale',recipients:[{name:'Contact',email:'stale@example.com'}],policy_version:'old-v0',consent_result:'granted'});
  assert.equal(result.status,409);assert.equal(result.body.error.code,'POLICY_VERSION_CHANGED');assert.equal(face.indexCalls,before);
  assert.ok(await store.get('draft',draft.temp_id));await success('DELETE',`/v1/registrations/${draft.temp_id}`,{});
});

test('final second verification automatically queues one registration notification and returns its result ID',async()=>{
  const registered=await captureAndRegister('final-one',[{name:'One',email:'final-one@example.com'},{name:'Two',email:'final-two@example.com'}]);
  assert.equal((await request('POST','/v1/registrations/verify',{...photoPayload,user_id:randomUUID()},registered.user_id)).status,409);
  identity='person-a';
  const anotherActiveUser=await success('POST','/v1/registrations/verify',{...photoPayload,user_id:registered.user_id},registered.user_id);
  assert.equal(anotherActiveUser.matched,false);assert.equal(anotherActiveUser.user_id,undefined);
  identity='other-person';
  const missing=await success('POST','/v1/registrations/verify',{...photoPayload,user_id:registered.user_id},registered.user_id);
  assert.equal(missing.matched,false);assert.equal(missing.check_id,undefined);
  assert.equal((await pool.query('SELECT count(*) AS n FROM safety_checks WHERE user_id=$1',[registered.user_id])).rows[0].n,'0');
  identity='final-one';const key=randomUUID();const body={...photoPayload,user_id:registered.user_id};
  const [first,repeat]=await Promise.all([request('POST','/v1/registrations/verify',body,registered.user_id,{'idempotency-key':key}),request('POST','/v1/registrations/verify',body,registered.user_id,{'idempotency-key':key})]);
  assert.equal(first.status,200);assert.deepEqual(first.body,repeat.body);
  assert.equal(first.body.matched,true);assert.equal(first.body.verification_status,'verified');assert.equal(first.body.send_requested,true);assert.equal(first.body.recipient_results,undefined);assert.equal(first.body.user_token,undefined);
  assert.equal(first.body.user_status,'pending_registration');assert.equal(first.body.similarity_score,99.9);
  const before=mail.sends.length;
  const pending=await success('GET',`/v1/mail-results/${first.body.check_id}`,undefined,first.body.user_id);
  assert.equal(pending.registration_completed,false);assert.equal(mail.sends.length,before);
  await worker.tick();
  const done=await success('GET',`/v1/mail-results/${first.body.check_id}`,undefined,first.body.user_id);
  assert.equal(done.registration_completed,true);assert.equal(done.user_status,'active');assert.equal(done.mail_status,'accepted');
  assert.deepEqual(mail.sends.slice(before).map(m=>m.type),['registration','registration']);
  finalUser={...registered,verificationBody:body,originalToken:registered.user_id,verificationKey:key,verified:first.body};
});

test('final registration replay after complete memory loss restores user verification without re-sending',async()=>{
  const before=mail.sends.length;store.close();
  const replay=await request('POST','/v1/registrations/verify',finalUser.verificationBody,finalUser.originalToken,{'idempotency-key':finalUser.verificationKey});
  assert.equal(replay.status,200);assert.equal(replay.body.recovered,true);assert.equal(replay.body.check_id,finalUser.verified.check_id);
  assert.equal(replay.body.metrics.similarity_score,null);assert.equal(replay.body.user_id,finalUser.user_id);assert.equal(replay.body.user_token,undefined);
  const result=await success('GET',`/v1/mail-results/${replay.body.check_id}`,undefined,replay.body.user_id);
  assert.equal(result.registration_completed,true);await worker.tick();assert.equal(mail.sends.length,before);
});

test('final safety identification, person confirmation and send use the same user ID and masked contacts',async()=>{
  identity='final-one';const identified=await success('POST','/v1/faces/identify',photoPayload);
  assert.equal(identified.matched,true);assert.equal(identified.user_id,finalUser.user_id);
  assert.equal((await request('POST','/v1/safety-notifications',{user_id:identified.user_id,consent:true,policy_version:'test-v1'},identified.user_id)).status,403);
  assert.equal((await request('POST',`/v1/users/${randomUUID()}/recipients`,{confirmed:true},identified.user_id)).status,409);
  const contacts=await success('POST',`/v1/users/${identified.user_id}/recipients`,{confirmed:true},identified.user_id);
  assert.equal(contacts.success,true);assert.equal(contacts.policy_version,'test-v1');assert.equal(contacts.consent_body,'Test policy');
  assert.equal(JSON.stringify(contacts).includes('final-one@example.com'),false);
  const key=randomUUID();const body={user_id:identified.user_id,consent:true,policy_version:contacts.policy_version};
  const sent=await success('POST','/v1/safety-notifications',body,identified.user_id,{'idempotency-key':key});
  const repeated=await success('POST','/v1/safety-notifications',body,identified.user_id,{'idempotency-key':key});assert.equal(sent.check_id,repeated.check_id);
  const before=mail.sends.length;await worker.tick();assert.deepEqual(mail.sends.slice(before).map(m=>m.type),['safety','safety']);
  const result=await success('GET',`/v1/mail-results/${sent.check_id}`,undefined,identified.user_id);assert.equal(result.mail_status,'accepted');
});

test('final rejection of identity or send consent creates no email event',async()=>{
  identity='final-one';const person=await success('POST','/v1/faces/identify',photoPayload);
  const denied=await success('POST',`/v1/users/${person.user_id}/recipients`,{confirmed:false},person.user_id);
  assert.equal(denied.success,false);assert.deepEqual(denied.recipients,[]);
  assert.equal((await request('POST',`/v1/users/${person.user_id}/recipients`,{confirmed:true},person.user_id)).status,409);
  const second=await success('POST','/v1/faces/identify',photoPayload);
  await success('POST',`/v1/users/${second.user_id}/recipients`,{confirmed:true},second.user_id);
  const before=(await pool.query('SELECT count(*) AS n FROM safety_checks')).rows[0].n;
  const notSent=await success('POST','/v1/safety-notifications',{user_id:second.user_id,consent:false,policy_version:'test-v1'},second.user_id);
  assert.equal(notSent.check_id,null);assert.equal(notSent.send_requested,false);
  assert.equal((await pool.query('SELECT count(*) AS n FROM safety_checks')).rows[0].n,before);
});

test('registration stays pending when any notification recipient fails',async()=>{
  const user=await captureAndRegister('final-partial',[{name:'A',email:'partial-a@example.com'},{name:'B',email:'partial-b@example.com'}]);
  const verified=await success('POST','/v1/registrations/verify',{...photoPayload,user_id:user.user_id},user.user_id);
  mail.outcomes=[null,new MailFailure('MAIL-001')];await worker.tick();
  const result=await success('GET',`/v1/mail-results/${verified.check_id}`,undefined,verified.user_id);
  assert.equal(result.mail_status,'partially_accepted');assert.equal(result.registration_completed,false);assert.equal(result.user_status,'pending_registration');
  assert.deepEqual(result.recipient_results.map(r=>r.status),['accepted','failed']);
});

test('unconfigured registration mail rolls back verification changes and can be retried',async()=>{
  const user=await captureAndRegister('final-mail-unavailable');
  const key=randomUUID(), body={...photoPayload,user_id:user.user_id};
  mail.ready=false;
  try {
    const failed=await request('POST','/v1/registrations/verify',body,user.user_id,{'idempotency-key':key});
    assert.equal(failed.status,503);assert.equal(failed.body.error.code,'SERVICE_NOT_CONFIGURED');
    assert.equal((await pool.query('SELECT count(*) AS n FROM safety_checks WHERE user_id=$1',[user.user_id])).rows[0].n,'0');
  } finally { mail.ready=true; }
  const retried=await success('POST','/v1/registrations/verify',body,user.user_id,{'idempotency-key':key});
  assert.equal(retried.matched,true);assert.equal(retried.send_requested,true);
  await worker.tick();
  const result=await success('GET',`/v1/mail-results/${retried.check_id}`,undefined,retried.user_id);
  assert.equal(result.registration_completed,true);
});
