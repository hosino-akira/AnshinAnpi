import test from 'node:test';
import assert from 'node:assert/strict';
import { AwsFaceProvider } from '../src/providers/aws-face.js';
import { bodySchemas } from '../src/validation.js';

const photo = Buffer.from([255, 216, 255, 224, 0, 0, 0, 0]);
const face = { Confidence: 99.9, Quality: { Brightness: 65, Sharpness: 90 }, Pose: { Yaw: 0, Pitch: 0, Roll: 0 } };

test('photo capture checks quality without creating or asserting a liveness session', async () => {
  const calls = [];
  const provider = new AwsFaceProvider({ rekognitionRegion: 'test', collectionId: 'test' }, {
    send: async command => { calls.push(command.constructor.name); return { FaceDetails: [face] }; },
  });
  const result = await provider.captureImage(photo.toString('base64'));
  assert.deepEqual(calls, ['DetectFacesCommand']);
  assert.equal(result.livenessPassed, false);
  assert.equal(result.metrics.face_confidence, 99.9);
  result.image.fill(0);
});

test('photo capture rejects invalid formats and oversized payloads before AWS', async () => {
  const provider = new AwsFaceProvider({ rekognitionRegion: 'test', collectionId: 'test' }, {
    send: async () => { throw new Error('must not call AWS'); },
  });
  for (const bytes of [Buffer.from('not a photo'), Buffer.alloc(512 * 1024 + 1, 255)]) {
    await assert.rejects(provider.captureImage(bytes.toString('base64')), e => e.code === 'INVALID_FACE_IMAGE');
  }
});

test('photo schema rejects mixed modes and client supplied biometric scores', () => {
  const image_base64 = photo.toString('base64');
  assert.deepEqual(bodySchemas.face.parse({ image_base64 }), { image_base64 });
  assert.throws(() => bodySchemas.face.parse({ image_base64, liveness_session_id: '00000000-0000-4000-8000-000000000001' }));
  assert.throws(() => bodySchemas.face.parse({ image_base64, similarity_score: 100 }));
  assert.throws(() => bodySchemas.face.parse({ image_base64: 'not/base64!' }));
});

test('quality rejection returns measured scores and clears image memory', async () => {
  let image;
  const provider = new AwsFaceProvider({ rekognitionRegion: 'test', collectionId: 'test' }, {
    send: async command => { image = command.input.Image.Bytes;
      return { FaceDetails: [{ ...face, Quality: { Brightness: 20, Sharpness: 90 } }] }; },
  });
  await assert.rejects(provider.captureImage(photo.toString('base64')), e => e.code === 'FACE_QUALITY_FAILED' && e.details.brightness === 20);
  assert.equal(image.every(byte => byte === 0), true);
});

test('empty collections return no candidates without attempting a search', async () => {
  const calls = [];
  const provider = new AwsFaceProvider({ rekognitionRegion: 'test', collectionId: 'test' }, {
    send: async command => { calls.push(command.constructor.name); return { FaceCount: 0, FaceModelVersion: '7.0' }; },
  });
  assert.deepEqual(await provider.search(photo), { modelVersion: '7.0', candidates: [] });
  assert.deepEqual(calls, ['DescribeCollectionCommand']);
});

test('quality diagnostics identify posture and all failing measurements without changing thresholds', async () => {
  const provider = new AwsFaceProvider({ rekognitionRegion: 'test', collectionId: 'test' }, {
    send: async () => ({ FaceDetails: [{ ...face, Quality: { Brightness: 20, Sharpness: 90 }, Pose: { Yaw: 45, Pitch: 0, Roll: 0 } }] }),
  });
  await assert.rejects(provider.captureImage(photo.toString('base64')), error => {
    assert.equal(error.code, 'FACE_QUALITY_FAILED');
    assert.equal(error.details.yaw, 45);
    assert.deepEqual(error.details.failed_checks, ['brightness', 'yaw']);
    assert.equal(error.details.thresholds.pose_abs_max, 30);
    return true;
  });
});

test('AWS failures expose only safe diagnostics and classify invalid images', async () => {
  const provider = new AwsFaceProvider({ rekognitionRegion: 'test', collectionId: 'test' }, {
    send: async () => { const e = new Error('private response'); e.name = 'AccessDeniedException'; throw e; },
  });
  await assert.rejects(provider.captureImage(photo.toString('base64')), e =>
    e.code === 'FACE_ACCESS_DENIED' && e.details.aws_error === 'AccessDeniedException'
    && !JSON.stringify(e.details).includes('private response'));
});
