import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { loadLocalEnv, readConfig } from '../../src/config.js';
import { createPool } from '../../src/db.js';
import { LocalCipher, token, sha256 } from '../../src/crypto.js';
import { TemporaryStore } from '../../src/temporary-store.js';
import { createApp } from '../../src/app.js';
import { MailWorker } from '../../src/mail-worker.js';
import { MailFailure } from '../../src/providers/aws-mail.js';
import { auditDigest } from '../../src/audit.js';

if (!/^anshin_api_test_[a-zA-Z0-9_]+$/.test(process.env.TEST_DATABASE_NAME ?? '')) throw new Error('TEST_DATABASE_NAME must name an isolated anshin_api_test_* database');
let app, pool, redis, config, store, worker, terminal, otherTerminal, face, mail;
const credentials = token(); const otherCredentials = token();
let identity = 'person-a';
const observedErrors = [];

before(async () => {
  loadLocalEnv(); config = await readConfig();
  config.postgres = { ...config.postgres, database: process.env.TEST_DATABASE_NAME };
  delete config.postgres.connectionString;
  config.redisPrefix = `anshin-test:${randomUUID()}:`;
  pool = createPool(config);
  redis = createClient({ url: config.redisUrl }); redis.on('error', () => {}); await redis.connect();
  store = new TemporaryStore(redis, config);
  const facility = (await pool.query(`INSERT INTO facilities(facility_code,name) VALUES($1,'Test facility') RETURNING facility_id`, [randomUUID()])).rows[0];
  terminal = (await pool.query(`INSERT INTO terminals(facility_id,terminal_code,name,status,credential_fingerprint) VALUES($1,$2,'Test terminal','active',$3) RETURNING *`, [facility.facility_id, randomUUID(), sha256(credentials).toString('hex')])).rows[0];
  otherTerminal = (await pool.query(`INSERT INTO terminals(facility_id,terminal_code,name,status,credential_fingerprint) VALUES($1,$2,'Other terminal','active',$3) RETURNING *`, [facility.facility_id, randomUUID(), sha256(otherCredentials).toString('hex')])).rows[0];
  for (const type of ['registration','safety']) await pool.query(`INSERT INTO consent_policies(policy_version,consent_type,title,body,content_sha256,status,published_at)
    VALUES('test-v1',$1,'Test','Test policy',$2,'published',clock_timestamp())`, [type, sha256('Test policy')]);
  face = {
    name: 'test-face', ready: true, references: new Map(), sessions: new Map(), override: null, indexCalls: 0, failCapture: false,
    requireReady() { if (!this.ready) { const e = new Error('unavailable'); e.status=503; e.code='SERVICE_NOT_CONFIGURED'; throw e; } },
    async createLiveness() { const id = randomUUID(); this.sessions.set(id, identity); return { sessionId: id, region: 'test' }; },
    async capture(id) {
      if (this.failCapture) { const { ApiError } = await import('../../src/errors.js'); throw new ApiError(422,'FACE-004','Liveness rejected'); }
      return { image: Buffer.from(this.sessions.get(id)), qualityPassed: true, livenessPassed: true };
    },
    async index(image, userId) { this.indexCalls++; const ref = { faceId: randomUUID(), collectionId: 'test', modelVersion: 'test-v1', provider: this.name };
      this.references.set(userId, { ...ref, identity: image.toString() }); return ref; },
    async search(image) { return { modelVersion: 'test-v1', candidates: this.override ?? [...this.references].filter(([,ref])=>ref.identity===image.toString()).map(([userId,ref])=>({ userId,faceId:ref.faceId,score:0.999 })) }; },
    async delete(ref) { for (const [id,value] of this.references) if (value.faceId===ref.faceId) this.references.delete(id); }
  };
  mail = { name: 'test-mail', ready: true, sends: [], outcomes: [], async send(message) {
    this.sends.push(message); const outcome = this.outcomes.shift(); if (outcome) throw outcome; return { messageId: randomUUID() };
  } };
  const deps = { pool, config, redis, store, face, mail, cipher: new LocalCipher(config.encryptionKey), logger: false,
    webhookVerifier: async () => {} }; // Test injection only; server runtime always verifies real SNS signatures.
  app = await createApp(deps);
  app.addHook('onError', (request, reply, error, done) => { observedErrors.push({ code:error.code, message:error.message, constraint:error.constraint }); done(); });
  worker = new MailWorker(deps); await app.ready();
});
after(async () => {
  if (app) await app.close();
  if (redis) { const keys = []; for await (const batch of redis.scanIterator({ MATCH: `${config.redisPrefix}*`, COUNT: 100 })) keys.push(...batch); if (keys.length) await redis.del(keys); await redis.quit(); }
  if (pool) await pool.end();
});

async function request(method, url, body, userToken, extra = {}) {
  const headers = { 'x-terminal-id': terminal.terminal_id, 'x-terminal-token': credentials,
    ...(method !== 'GET' ? { 'idempotency-key': randomUUID() } : {}), ...(userToken ? { authorization: `Bearer ${userToken}` } : {}), ...extra };
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
  const verified = await success('POST','/v1/faces/verify-registration',{ liveness_session_id: await liveness('registration',null,completed.user_token) },completed.user_token);
  assert.equal(verified.result,'matched');
  await success('POST','/v1/users/me/confirmation',{ confirmed:true },verified.user_token);
  const check = await success('POST',`/v1/enrollments/${id}/confirmation-mails`,{},verified.user_token);
  await worker.tick();
  const result = await success('GET',`/v1/safety-checks/${check.check_id}`,undefined,verified.user_token);
  assert.equal(result.status,'accepted');
  return { userId: completed.user_id, token: verified.user_token, checkId: check.check_id, enrollmentId:id };
}
async function identify(label) {
  identity = label;
  const result = await success('POST','/v1/faces/identify',{ liveness_session_id: await liveness('safety') });
  assert.equal(result.result,'matched');
  return result.user_token;
}
let personA, personB;

test('terminal authentication, policy and service-not-configured behavior', async () => {
  assert.equal((await app.inject({ method:'GET',url:'/v1/terminal' })).statusCode,401);
  assert.equal((await request('GET','/v1/terminal',undefined,null,{ 'x-terminal-token': token() })).status,401);
  assert.equal((await success('GET','/v1/consent-policies?type=registration')).policy_version,'test-v1');
  mail.ready=false;
  assert.equal((await request('POST','/v1/safety-checks',{ policy_version:'test-v1',consent:true })).status,503);
  mail.ready=true;
});
test('pre-consent fields live only in encrypted temporary storage; denial erases them', async () => {
  const baseline = Number((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n);
  identity='denied-person';
  const draft = await success('POST','/v1/enrollments',{});
  await success('PATCH',`/v1/enrollments/${draft.temp_id}/profile`,{ display_name:'一時利用者' });
  await success('POST',`/v1/enrollments/${draft.temp_id}/face`,{ liveness_session_id:await liveness('enrollment',draft.temp_id) });
  const raw = await redis.get(store.key('draft',draft.temp_id));
  assert.ok(!raw.includes('一時利用者') && !raw.includes('denied-person'));
  await success('POST',`/v1/enrollments/${draft.temp_id}/consent`,{ policy_version:'test-v1',result:'denied' });
  assert.equal(await store.get('draft',draft.temp_id),null);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n),baseline);
  assert.equal(face.indexCalls,0);
});
test('registration with two contacts persists encrypted data and activates after mail acceptance', async () => {
  personA=await enroll('person-a',[{ name:'家族1',email:'family-one@example.com' },{ name:'家族2',email:'family-two@example.com' }]);
  const user=(await pool.query('SELECT * FROM users WHERE user_id=$1',[personA.userId])).rows[0];
  assert.equal(user.status,'active'); assert.ok(!user.encrypted_display_name.includes(Buffer.from('利用者')));
  assert.equal((await pool.query('SELECT count(*) AS n FROM recipients WHERE user_id=$1',[personA.userId])).rows[0].n,'2');
  assert.deepEqual(mail.sends.map(x=>x.email),['family-one@example.com','family-two@example.com']);
  const recipients=await success('GET','/v1/users/me/recipients',undefined,personA.token);
  assert.equal(recipients.recipients[0].masked_email,'fa•••@example.com');
  assert.equal(JSON.stringify(recipients).includes('family-one@'),false);
});
test('unconfirmed recognition cannot reveal contacts or send; rejecting identity revokes the token', async () => {
  const raw=await identify('person-a');
  assert.equal((await request('GET','/v1/users/me/recipients',undefined,raw)).status,403);
  assert.equal((await request('POST','/v1/safety-checks',{ policy_version:'test-v1',consent:true },raw)).status,403);
  await success('POST','/v1/users/me/confirmation',{ confirmed:false },raw);
  assert.equal((await request('GET','/v1/users/me/recipients',undefined,raw)).status,401);
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
test('a token from another user or terminal cannot read a send result', async () => {
  personB=await enroll('person-b');
  assert.equal((await request('GET',`/v1/safety-checks/${personA.checkId}`,undefined,personB.token)).status,404);
  assert.equal((await request('GET','/v1/users/me/recipients',undefined,personA.token,{ 'x-terminal-id':otherTerminal.terminal_id,'x-terminal-token':otherCredentials })).status,401);
});
test('expired and idle sessions do not reveal personal information', async () => {
  const raw=await identify('person-a'); await success('POST','/v1/users/me/confirmation',{ confirmed:true },raw);
  await pool.query(`UPDATE api_sessions SET last_activity_at=clock_timestamp()-interval '91 seconds' WHERE token_sha256=$1`,[sha256(raw)]);
  assert.equal((await request('GET','/v1/users/me/recipients',undefined,raw)).status,401);
});
test('ambiguous and absent recognition results return no names or user token', async () => {
  const [idA,refA]=[personA.userId,face.references.get(personA.userId)]; const [idB,refB]=[personB.userId,face.references.get(personB.userId)];
  face.override=[{ userId:idA,faceId:refA.faceId,score:0.999 },{ userId:idB,faceId:refB.faceId,score:0.998 }];
  const ambiguous=await success('POST','/v1/faces/identify',{ liveness_session_id:await liveness('safety') });
  assert.equal(ambiguous.result,'ambiguous');assert.equal(ambiguous.display_name,undefined);assert.equal(ambiguous.user_token,undefined);
  face.override=[];
  const missing=await success('POST','/v1/faces/identify',{ liveness_session_id:await liveness('safety') });
  assert.equal(missing.result,'no_match');assert.equal(missing.display_name,undefined);
  face.override=null; await store.clearFailures(terminal.terminal_id);
});
test('liveness sessions are single use and bound to a terminal; client flags are rejected', async () => {
  identity='person-a';const id=await liveness('safety');
  assert.equal((await request('POST','/v1/faces/identify',{ liveness_session_id:id, liveness_passed:true })).status,400);
  assert.equal((await request('POST','/v1/faces/identify',{ liveness_session_id:id },null,{ 'x-terminal-id':otherTerminal.terminal_id,'x-terminal-token':otherCredentials })).status,410);
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
  assert.equal((await pool.query('SELECT count(*) AS n FROM mail_delivery_events WHERE provider_event_id=$1',[notification.MessageId])).rows[0].n,'1');
});
test('expired send requests are cancelled before contacting SES', async () => {
  const raw=await identify('person-b'); await success('POST','/v1/users/me/confirmation',{ confirmed:true },raw);
  const check=await success('POST','/v1/safety-checks',{ policy_version:'test-v1',consent:true },raw);
  await pool.query(`UPDATE safety_checks SET expires_at=created_at+interval '1 millisecond' WHERE check_id=$1`,[check.check_id]);
  const count=mail.sends.length;await worker.tick();assert.equal(mail.sends.length,count);
  assert.equal((await success('GET',`/v1/safety-checks/${check.check_id}`,undefined,raw)).status,'cancelled');
});
test('suspension revokes sessions and queues deletion of managed face features', async () => {
  await pool.query(`UPDATE users SET status='suspended',suspended_at=clock_timestamp(),purge_after=clock_timestamp()+interval '30 days' WHERE user_id=$1`,[personB.userId]);
  assert.equal((await request('GET','/v1/users/me/recipients',undefined,personB.token)).status,401);
  assert.equal((await pool.query('SELECT count(*) AS n FROM face_cleanup_jobs')).rows[0].n,'1');
  await worker.cleanFaces();assert.equal(face.references.has(personB.userId),false);
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
