import { RekognitionClient, CreateFaceLivenessSessionCommand, GetFaceLivenessSessionResultsCommand,
  DetectFacesCommand, IndexFacesCommand, SearchFacesByImageCommand, DeleteFacesCommand, ListFacesCommand, DescribeCollectionCommand } from '@aws-sdk/client-rekognition';
import { ApiError, fail, unavailable } from '../errors.js';

export class AwsFaceProvider {
  name = 'aws-rekognition';
  constructor(config, client = new RekognitionClient({ region: config.rekognitionRegion, maxAttempts: 2 })) {
    this.config = config; this.client = client;
    this.ready = Boolean(config.rekognitionRegion && config.collectionId);
  }
  requireReady() { if (!this.ready) unavailable('顔認識サービス'); }
  async call(command) {
    try { return await this.client.send(command, { abortSignal: AbortSignal.timeout(12000) }); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      if (error.name === 'InvalidImageFormatException') fail(400, 'INVALID_FACE_IMAGE', '画像を読み取れません。');
      if (error.name === 'InvalidParameterException' && /no faces in the image/i.test(error.message ?? '')) {
        fail(422, 'FACE-001', '画像内に顔が見つかりません。');
      }
      if (error.name === 'InvalidParameterException' && command instanceof DetectFacesCommand) {
        fail(400, 'INVALID_FACE_IMAGE', '画像の寸法や形式をご確認ください。');
      }
      const details = { aws_error: /^[A-Za-z0-9_]{1,80}$/.test(error.name ?? '') ? error.name : 'UnknownError',
        aws_operation: command.constructor.name };
      if (['ExpiredTokenException', 'ExpiredToken', 'CredentialsProviderError'].includes(error.name)) {
        fail(503, 'FACE_AUTH_EXPIRED', 'AWS 認証を更新してください。', details);
      }
      if (error.name === 'AccessDeniedException') fail(503, 'FACE_ACCESS_DENIED', 'AWS の権限をご確認ください。', details);
      fail(503, 'FACE_SERVICE_UNAVAILABLE', '現在、顔を確認できません。スタッフへお声がけください。', details);
    }
  }
  async createLiveness(clientToken) {
    this.requireReady();
    const result = await this.call(new CreateFaceLivenessSessionCommand({ ClientRequestToken: clientToken, Settings: { AuditImagesLimit: 0 } }));
    if (!result.SessionId) fail(503, 'FACE_SERVICE_UNAVAILABLE', '顔確認を開始できませんでした。');
    return { sessionId: result.SessionId, region: this.config.rekognitionRegion };
  }
  async capture(sessionId) {
    this.requireReady();
    const result = await this.call(new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }));
    if (['CREATED', 'IN_PROGRESS'].includes(result.Status)) fail(409, 'LIVENESS_IN_PROGRESS', '顔確認を完了してください。');
    if (result.Status !== 'SUCCEEDED' || !Number.isFinite(result.Confidence) || result.Confidence / 100 < this.config.livenessThreshold) {
      fail(422, 'FACE-004', '安全のため確認できませんでした。', {
        liveness_score: Number.isFinite(result.Confidence) ? result.Confidence : null,
        liveness_threshold: this.config.livenessThreshold * 100,
        feedback: (result.Feedback ?? []).map(item => item.Code),
      });
    }
    const image = Buffer.from(result.ReferenceImage?.Bytes ?? []);
    if (!image.length) fail(422, 'FACE-001', 'もう一度、顔を撮影してください。');
    try {
      const metrics = await this.inspectImage(image);
      return { image, qualityPassed: true, livenessPassed: true, metrics: {
        ...metrics, liveness_score: result.Confidence,
      } };
    } catch (error) { image.fill(0); throw error; }
  }
  async captureImage(base64) {
    this.requireReady();
    const image = Buffer.from(base64, 'base64');
    try {
      const jpeg = image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
      const png = image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (!image.length || image.length > 512 * 1024 || (!jpeg && !png)) {
        fail(400, 'INVALID_FACE_IMAGE', 'JPEG または PNG（512 KiB 以下）を送信してください。');
      }
      const metrics = await this.inspectImage(image);
      return { image, qualityPassed: true, livenessPassed: false, metrics };
    } catch (error) { image.fill(0); throw error; }
  }
  async inspectImage(image) {
      const detection = await this.call(new DetectFacesCommand({ Image: { Bytes: image }, Attributes: ['DEFAULT'] }));
      if (detection.FaceDetails?.length !== 1) fail(422, detection.FaceDetails?.length ? 'FACE-002' : 'FACE-001', 'お一人でカメラに映ってください。');
      const face = detection.FaceDetails[0];
      const metrics = { face_confidence: face.Confidence ?? null,
        brightness: face.Quality?.Brightness ?? null, sharpness: face.Quality?.Sharpness ?? null,
        yaw: face.Pose?.Yaw ?? null, pitch: face.Pose?.Pitch ?? null, roll: face.Pose?.Roll ?? null };
      const failedChecks = [];
      if ((metrics.face_confidence ?? 0) < 99) failedChecks.push('face_confidence');
      if ((metrics.brightness ?? 0) < 40) failedChecks.push('brightness');
      if ((metrics.sharpness ?? 0) < 40) failedChecks.push('sharpness');
      for (const angle of ['yaw', 'pitch', 'roll']) if (Math.abs(metrics[angle] ?? 180) > 30) failedChecks.push(angle);
      if (failedChecks.length) {
        fail(422, 'FACE_QUALITY_FAILED', '顔の向きや明るさを調整し、もう一度お試しください。', {
          ...metrics, failed_checks: failedChecks,
          thresholds: { face_confidence_min: 99, brightness_min: 40, sharpness_min: 40, pose_abs_max: 30 },
        });
      }
      return metrics;
  }
  async index(image, userId) {
    this.requireReady();
    const result = await this.call(new IndexFacesCommand({ CollectionId: this.config.collectionId, Image: { Bytes: image },
      ExternalImageId: userId, MaxFaces: 1, QualityFilter: 'AUTO', DetectionAttributes: ['DEFAULT'] }));
    if (result.FaceRecords?.length !== 1 || result.UnindexedFaces?.length) {
      if (result.FaceRecords?.length) await this.delete({ faceId: result.FaceRecords[0].Face.FaceId, collectionId: this.config.collectionId }).catch(() => {});
      fail(422, 'FACE_QUALITY_FAILED', '顔を登録できませんでした。もう一度お試しください。');
    }
    return { faceId: result.FaceRecords[0].Face.FaceId, collectionId: this.config.collectionId,
      modelVersion: result.FaceModelVersion ?? 'unknown', provider: this.name };
  }
  async search(image) {
    this.requireReady();
    // An empty collection has no candidate; it is not a service outage.
    const collection = await this.call(new DescribeCollectionCommand({ CollectionId: this.config.collectionId }));
    if (collection.FaceCount === 0) {
      return { modelVersion: collection.FaceModelVersion ?? 'unknown', candidates: [] };
    }
    const result = await this.call(new SearchFacesByImageCommand({ CollectionId: this.config.collectionId,
      Image: { Bytes: image }, FaceMatchThreshold: 0, MaxFaces: 100, QualityFilter: 'AUTO' }));
    return { modelVersion: result.FaceModelVersion ?? 'unknown', candidates: (result.FaceMatches ?? []).map(match => ({
      userId: match.Face?.ExternalImageId, faceId: match.Face?.FaceId, score: (match.Similarity ?? 0) / 100,
    })) };
  }
  async delete(reference) {
    this.requireReady();
    if (reference.collectionId !== this.config.collectionId) fail(503, 'FACE_COLLECTION_MISMATCH', '顔データの設定をご確認ください。');
    await this.call(new DeleteFacesCommand({ CollectionId: reference.collectionId, FaceIds: [reference.faceId] }));
  }
  async list(nextToken) {
    this.requireReady();
    const result = await this.call(new ListFacesCommand({ CollectionId: this.config.collectionId, MaxResults: 100, NextToken: nextToken }));
    return { faces: result.Faces ?? [], nextToken: result.NextToken };
  }
}
