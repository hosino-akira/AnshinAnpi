import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { email } from './validation.js';

// Also used by the SMTP check, which does not need database or encryption secrets.
export function readMailConfig(env = process.env, secrets = {}) {
  const address = name => {
    const value = env[name]?.trim();
    if (!value) return undefined;
    const result = email.safeParse(value);
    if (!result.success) throw new Error(`INVALID_${name}`);
    return result.data;
  };
  const port = Number(env.SMTP_PORT?.trim() || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_SMTP_PORT');
  const secure = env.SMTP_SECURE?.trim();
  if (secure && !['true', 'false'].includes(secure)) throw new Error('INVALID_SMTP_SECURE');
  const smtpSecure = secure ? secure === 'true' : port === 465;
  if ((port === 465 && !smtpSecure) || (port === 587 && smtpSecure)) throw new Error('INVALID_SMTP_TLS_MODE');
  const host = env.SMTP_HOST?.trim() || undefined;
  if (host && (!/^[a-zA-Z0-9.-]+$/.test(host) || host.includes('..'))) throw new Error('INVALID_SMTP_HOST');
  return {
    smtpHost: host, smtpPort: port, smtpSecure,
    smtpUser: env.SMTP_USER?.trim() || undefined,
    smtpPassword: secrets.SMTP_PASSWORD ?? env.SMTP_PASSWORD,
    smtpFrom: address('SMTP_FROM_EMAIL'), smtpReplyTo: address('SMTP_REPLY_TO_EMAIL'),
    contactAddress: env.SERVICE_CONTACT?.trim() || '施設スタッフへお問い合わせください。',
    facilityName: env.FACILITY_NAME?.trim() || 'ご利用施設',
  };
}

export function loadLocalEnv() {
  for (const path of [new URL('../../.env', import.meta.url), new URL('../.env', import.meta.url)]) {
    if (existsSync(path)) {
      const values = parseEnv(readFileSync(fileURLToPath(path), 'utf8'));
      for (const [key, value] of Object.entries(values)) process.env[key] ??= value;
    }
  }
}

export async function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  let secrets = {};
  if (env.AWS_SECRET_ARN) {
    const result = await new SecretsManagerClient({ region: env.AWS_REGION }).send(new GetSecretValueCommand({ SecretId: env.AWS_SECRET_ARN }));
    secrets = JSON.parse(result.SecretString ?? '{}');
  }
  const key = (name) => {
    const value = secrets[name] ?? env[name];
    if (!value || Buffer.from(value, 'base64').length !== 32) throw new Error(`${name} must be a base64-encoded 32-byte secret`);
    return Buffer.from(value, 'base64');
  };
  const mode = env.DATA_ENCRYPTION_MODE ?? 'local';
  if (!['local', 'kms'].includes(mode)) throw new Error('Invalid DATA_ENCRYPTION_MODE');
  if (production && mode !== 'kms') throw new Error('Production requires KMS encryption');
  if (mode === 'kms' && (!env.AWS_REGION || !env.AWS_KMS_KEY_ARN)) throw new Error('KMS region/key are required');
  if (production && (!env.AWS_SECRET_ARN || !env.CORS_ORIGINS)) throw new Error('Production requires AWS_SECRET_ARN and explicit CORS_ORIGINS');
  const config = {
    production, host: env.API_HOST ?? '127.0.0.1', port: Number(env.API_PORT ?? 3001),
    postgres: env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {
      host: env.POSTGRES_HOST ?? '127.0.0.1', port: Number(env.POSTGRES_PORT ?? 5433),
      database: env.POSTGRES_DB ?? 'anshin', user: env.POSTGRES_USER ?? 'anshin', password: env.POSTGRES_PASSWORD,
    },
    postgresSsl: env.POSTGRES_SSL === 'true',
    encryptionMode: mode, encryptionKey: mode === 'local' ? key('DATA_ENCRYPTION_KEY') : null,
    encryptionKeyId: mode === 'kms' ? env.AWS_KMS_KEY_ARN : 'local-data-v1',
    temporaryKey: key('TEMPORARY_ENCRYPTION_KEY'), auditKey: key('AUDIT_HMAC_KEY'),
    auditKeyId: env.AUDIT_KEY_ID ?? 'audit-v1',
    awsRegion: env.AWS_REGION, rekognitionRegion: env.AWS_REKOGNITION_REGION ?? env.AWS_REGION,
    collectionId: env.AWS_REKOGNITION_COLLECTION_ID,
    ...readMailConfig(env, secrets),
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s => s.trim()).filter(Boolean),
    // Initial PoC settings, intentionally configurable rather than claimed accuracy guarantees.
    matchThreshold: Number(env.FACE_MATCH_THRESHOLD ?? 0.99), requiredMargin: Number(env.FACE_MATCH_MARGIN ?? 0.05),
    livenessThreshold: Number(env.FACE_LIVENESS_THRESHOLD ?? 0.99), thresholdVersion: env.FACE_THRESHOLD_VERSION ?? 'poc-v1',
    draftTtlSeconds: 900, idleTtlSeconds: 90, verificationTtlSeconds: 180,
    logLevel: env.LOG_LEVEL ?? 'info', workerEnabled: env.MAIL_WORKER_ENABLED !== 'false',
    apiDebugLogEnabled: !production && env.API_DEBUG_LOG_ENABLED === 'true',
    migrationsPath: fileURLToPath(new URL('../../database/migrations/', import.meta.url)),
  };
  for (const setting of ['matchThreshold', 'requiredMargin', 'livenessThreshold']) {
    if (!Number.isFinite(config[setting]) || config[setting] < 0 || config[setting] > 1) throw new Error(`Invalid ${setting}`);
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid API_PORT');
  return config;
}
