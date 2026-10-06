import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, createSign } from 'node:crypto';
import { LocalCipher, KmsCipher, canonical, lookup } from '../src/crypto.js';
import { bodySchemas, maskEmail } from '../src/validation.js';
import { verifySns, snsSigningText, validateCertificateUrl } from '../src/webhook.js';
import { AwsFaceProvider } from '../src/providers/aws-face.js';
import { AwsMailProvider, MailFailure } from '../src/providers/aws-mail.js';
import { TemporaryStore } from '../src/temporary-store.js';

test('AES-GCM authenticates ciphertext and the field purpose', async () => {
  const cipher = new LocalCipher(randomBytes(32));
  const envelope = await cipher.seal({ name: '山田 太郎' }, 'user-name');
  assert.deepEqual(await cipher.open(envelope, 'user-name'), { name: '山田 太郎' });
  assert.equal(envelope.includes(Buffer.from('山田')), false);
  await assert.rejects(cipher.open(envelope, 'recipient-email'));
  const changed = JSON.parse(envelope.toString()); changed.data = Buffer.from('changed').toString('base64');
  await assert.rejects(cipher.open(Buffer.from(JSON.stringify(changed)), 'user-name'));
});

test('KMS envelope binds encryption context and clears data keys', async () => {
  const plaintext = randomBytes(32); const known = Buffer.from(plaintext); let context;
  const client = { send: async command => {
    context = command.input.EncryptionContext;
    if (command.constructor.name === 'GenerateDataKeyCommand') return { Plaintext: plaintext, CiphertextBlob: Buffer.from('wrapped') };
    return { Plaintext: Buffer.from(known) };
  } };
  const cipher = new KmsCipher({ encryptionKeyId: 'key-arn' }, client);
  const value = await cipher.seal('sample', 'user-name');
  assert.equal(plaintext.every(b => b === 0), true);
  assert.deepEqual(context, { application: 'anshin-anpi', purpose: 'user-name' });
  assert.equal(await cipher.open(value, 'user-name'), 'sample');
});

test('canonical request digests do not depend on object key order', () => {
  assert.equal(canonical({ a: 1, b: { c: 2, d: 3 } }), canonical({ b: { d: 3, c: 2 }, a: 1 }));
});

test('normalized email HMAC and masked API response', () => {
  const config = { lookupKey: randomBytes(32) };
  assert.deepEqual(lookup(config, ' Person@EXAMPLE.com '), lookup(config, 'person@example.com'));
  assert.equal(maskEmail('family@example.com'), 'fa•••@example.com');
});

test('input validation rejects spoofed biometric decisions, duplicate emails and unsafe names', () => {
  assert.throws(() => bodySchemas.face.parse({ liveness_session_id: '00000000-0000-4000-8000-000000000001', liveness_passed: true }));
  assert.throws(() => bodySchemas.recipients.parse({ recipients: [{ name: 'A', email: 'a@example.com' }, { name: 'B', email: ' A@example.com ' }] }));
  assert.throws(() => bodySchemas.recipients.parse({ recipients: [] }));
  assert.throws(() => bodySchemas.recipients.parse({ recipients: Array(3).fill({ name: 'A', email: 'a@example.com' }) }));
  assert.throws(() => bodySchemas.profile.parse({ display_name: '<script>' }));
  assert.throws(() => bodySchemas.profile.parse({ display_name: 'a\nmail@example.com' }));
  assert.throws(() => bodySchemas.safety.parse({ policy_version: 'v1', consent: false }));
});

test('SNS certificate URL cannot redirect certificate lookup to an attacker', () => {
  for (const url of ['http://sns.ap-northeast-1.amazonaws.com/SimpleNotificationService-ab.pem',
    'https://sns.ap-northeast-1.amazonaws.com.attacker.test/SimpleNotificationService-ab.pem',
    'https://sns.ap-northeast-1.amazonaws.com:444/SimpleNotificationService-ab.pem',
    'https://sns.ap-northeast-1.amazonaws.com/other.pem',
    'https://user@sns.ap-northeast-1.amazonaws.com/SimpleNotificationService-ab.pem']) {
    assert.throws(() => validateCertificateUrl(url, 'ap-northeast-1'));
  }
});

test('SNS signature, topic and freshness are verified', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = { snsTopicArn: 'arn:aws:sns:ap-northeast-1:123456789012:mail' };
  const message = { Type: 'Notification', Message: '{}', MessageId: 'test-id', TopicArn: config.snsTopicArn,
    Timestamp: new Date().toISOString(), SignatureVersion: '2',
    SigningCertURL: 'https://sns.ap-northeast-1.amazonaws.com/SimpleNotificationService-ab.pem' };
  message.Signature = createSign('RSA-SHA256').update(snsSigningText(message)).sign(privateKey, 'base64');
  const loader = async () => publicKey;
  await verifySns(message, config, loader);
  await assert.rejects(verifySns({ ...message, Message: 'tampered' }, config, loader));
  await assert.rejects(verifySns({ ...message, TopicArn: 'wrong-topic' }, config, loader));
  await assert.rejects(verifySns({ ...message, Timestamp: '2020-01-01' }, config, loader));
});

test('AWS face capture uses server liveness results and rejects more than one face', async () => {
  const calls = [];
  const config = { rekognitionRegion: 'test', collectionId: 'test', livenessThreshold: 0.99 };
  const provider = new AwsFaceProvider(config, { send: async command => {
    calls.push(command.constructor.name);
    if (command.constructor.name === 'GetFaceLivenessSessionResultsCommand') return { Status: 'SUCCEEDED', Confidence: 99.9, ReferenceImage: { Bytes: Buffer.from('image') } };
    return { FaceDetails: [{}, {}] };
  } });
  await assert.rejects(provider.capture('session'), error => error.code === 'FACE-002');
  assert.deepEqual(calls, ['GetFaceLivenessSessionResultsCommand', 'DetectFacesCommand']);
});

test('AWS face provider does not index before an explicit enrollment operation', async () => {
  const calls = [];
  const provider = new AwsFaceProvider({ rekognitionRegion: 'test', collectionId: 'test' }, { send: async command => {
    calls.push(command);
    return { SessionId: 'test-session' };
  } });
  await provider.createLiveness('operation');
  assert.equal(calls[0].constructor.name, 'CreateFaceLivenessSessionCommand');
  assert.equal(calls[0].input.Settings.OutputConfig, undefined);
  assert.equal(calls[0].input.Settings.AuditImagesLimit, 0);
});

test('SES sends only one address and attaches a delivery ID for reconciliation', async () => {
  let input;
  const provider = new AwsMailProvider({ awsRegion: 'test', sesFrom: 'sender@example.com', contactAddress: 'staff' }, {
    send: async command => { input = command.input; return { MessageId: 'message-id' }; }
  });
  const result = await provider.send({ email: 'family@example.com', displayName: '山田 太郎', occurredAt: new Date(),
    timezone: 'Asia/Tokyo', type: 'safety', deliveryId: 'delivery' });
  assert.equal(result.messageId, 'message-id');
  assert.deepEqual(input.Destination, { ToAddresses: ['family@example.com'] });
  assert.deepEqual(input.EmailTags, [{ Name: 'anshin_delivery_id', Value: 'delivery' }]);
});

test('SES ambiguous network errors cannot be automatically retried', async () => {
  const provider = new AwsMailProvider({ awsRegion: 'test', sesFrom: 'sender@example.com', contactAddress: 'staff' }, {
    send: async () => { throw new Error('network reset'); }
  });
  await assert.rejects(provider.send({ email: 'family@example.com', displayName: 'A', occurredAt: new Date(), timezone: 'UTC', type: 'safety', deliveryId: 'id' }),
    error => error instanceof MailFailure && error.uncertain && !error.retryable);
});

test('temporary draft has a physical idle TTL and completion lock lasts through commit', async () => {
  const store = new TemporaryStore({temporaryKey:randomBytes(32),idleTtlSeconds:300});
  await store.put('draft','id',{ name:'temporary' },new Date(Date.now()+900000));
  const remaining=await store.state.ttl(store.key('draft','id'));
  assert.ok(remaining>299 && remaining<=300);
  const ctx={ commits:[],rollbacks:[] };
  await store.lock('draft','id',async()=>({ completed:true }),ctx);
  await assert.rejects(store.lock('draft','id',async()=>null),error=>error.code==='OPERATION_IN_PROGRESS');
  await ctx.commits[0]();
  await store.lock('draft','id',async()=>true);
  store.close();
});
