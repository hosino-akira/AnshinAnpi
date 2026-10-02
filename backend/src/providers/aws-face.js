import { RekognitionClient, CreateFaceLivenessSessionCommand, GetFaceLivenessSessionResultsCommand,
  DetectFacesCommand, IndexFacesCommand, SearchFacesByImageCommand, DeleteFacesCommand, ListFacesCommand } from '@aws-sdk/client-rekognition';
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
      fail(503, 'FACE_SERVICE_UNAVAILABLE', '現在、顔を確認できません。スタッフへお声がけください。');
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
      fail(422, 'FACE-004', '安全のため確認できませんでした。');
    }
    const image = Buffer.from(result.ReferenceImage?.Bytes ?? []);
    if (!image.length) fail(422, 'FACE-001', 'もう一度、顔を撮影してください。');
    try {
      const detection = await this.call(new DetectFacesCommand({ Image: { Bytes: image }, Attributes: ['DEFAULT'] }));
      if (detection.FaceDetails?.length !== 1) fail(422, detection.FaceDetails?.length ? 'FACE-002' : 'FACE-001', 'お一人でカメラに映ってください。');
      const face = detection.FaceDetails[0];
      if ((face.Confidence ?? 0) < 99 || (face.Quality?.Brightness ?? 0) < 40 || (face.Quality?.Sharpness ?? 0) < 40
        || Math.abs(face.Pose?.Yaw ?? 180) > 30 || Math.abs(face.Pose?.Pitch ?? 180) > 30 || Math.abs(face.Pose?.Roll ?? 180) > 30) {
        fail(422, 'FACE_QUALITY_FAILED', '顔の向きや明るさを調整し、もう一度お試しください。');
      }
      return { image, qualityPassed: true, livenessPassed: true };
    } catch (error) { image.fill(0); throw error; }
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
