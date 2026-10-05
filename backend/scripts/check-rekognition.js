import { randomUUID } from 'node:crypto';
import { RekognitionClient, DescribeCollectionCommand } from '@aws-sdk/client-rekognition';
import { loadLocalEnv } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';
import { createApp } from '../src/app.js';

// Default mode reads collection metadata. --liveness creates one real AWS session.
loadLocalEnv();
const region = process.env.AWS_REKOGNITION_REGION || process.env.AWS_REGION;
const collectionId = process.env.AWS_REKOGNITION_COLLECTION_ID;
const client = new RekognitionClient({ region, maxAttempts: 1 });
let runtime;
let app;
try {
  if (!region || !collectionId) throw new Error('REKOGNITION_CONFIG_REQUIRED');
  const collection = await client.send(new DescribeCollectionCommand({ CollectionId: collectionId }), {
    abortSignal: AbortSignal.timeout(15000),
  });
  console.log(JSON.stringify({ check: 'collection', status: 'ok', region, collectionId,
    faceCount: collection.FaceCount, modelVersion: collection.FaceModelVersion }));
  if (process.argv.includes('--liveness')) {
    runtime = await createRuntime();
    app = await createApp({ ...runtime, logger: false });
    const request = { method: 'POST', url: '/v1/faces/liveness-sessions',
      headers: { 'idempotency-key': randomUUID() }, payload: { purpose: 'safety' } };
    const response = await app.inject(request);
    const body = response.json();
    if (response.statusCode !== 201 || !body.liveness_session_id) {
      throw new Error(body.error?.code || 'LIVENESS_API_FAILED');
    }
    const replay = await app.inject(request);
    if (replay.statusCode !== 201 || replay.json().liveness_session_id !== body.liveness_session_id
      || replay.headers['idempotency-replayed'] !== 'true') throw new Error('IDEMPOTENCY_REPLAY_FAILED');
    console.log(JSON.stringify({ check: 'liveness-api', status: 'ok', httpStatus: response.statusCode,
      region: body.region, expiresAt: body.expires_at, idempotencyReplay: true }));
  }
} catch (error) {
  // Never print raw SDK errors, credentials, or session identifiers.
  const code = error.$metadata ? error.name
    : /^[A-Z][A-Z0-9_]{0,99}$/.test(error.message ?? '') ? error.message : error.name;
  console.error(JSON.stringify({ status: 'failed', code,
    httpStatus: error.$metadata?.httpStatusCode }));
  process.exitCode = 1;
} finally {
  await app?.close();
  await runtime?.close();
  runtime?.face.client.destroy();
  runtime?.mail.client.destroy();
  client.destroy();
}
