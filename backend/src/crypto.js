import { randomBytes, createCipheriv, createDecipheriv, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';

export const sha256 = value => createHash('sha256').update(value).digest();
export const token = () => randomBytes(32).toString('base64url');
export const equal = (a, b) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function encrypt(key, value, purpose) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`anshin-anpi:${purpose}`));
  const plaintext = Buffer.from(JSON.stringify(value));
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') };
  } finally { plaintext.fill(0); }
}

function decrypt(key, envelope, purpose) {
  if (envelope.v !== 1) throw new Error('Unsupported encryption envelope');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  cipher.setAAD(Buffer.from(`anshin-anpi:${purpose}`));
  cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]);
  try { return JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); }
}

export class LocalCipher {
  constructor(key, keyId = 'local-data-v1') { this.key = key; this.keyId = keyId; }
  async seal(value, purpose) { return Buffer.from(JSON.stringify(encrypt(this.key, value, purpose))); }
  async open(value, purpose) { return decrypt(this.key, JSON.parse(Buffer.from(value).toString('utf8')), purpose); }
}

export class KmsCipher {
  constructor(config, client = new KMSClient({ region: config.awsRegion, maxAttempts: 2 })) { this.client = client; this.keyId = config.encryptionKeyId; }
  async seal(value, purpose) {
    const context = { application: 'anshin-anpi', purpose };
    const result = await this.client.send(new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: 'AES_256', EncryptionContext: context }), { abortSignal: AbortSignal.timeout(8000) });
    const key = Buffer.from(result.Plaintext);
    try {
      return Buffer.from(JSON.stringify({ ...encrypt(key, value, purpose), wrapped_key: Buffer.from(result.CiphertextBlob).toString('base64'), key_id: this.keyId }));
    } finally { key.fill(0); result.Plaintext.fill(0); }
  }
  async open(value, purpose) {
    const envelope = JSON.parse(Buffer.from(value).toString('utf8'));
    const result = await this.client.send(new DecryptCommand({ CiphertextBlob: Buffer.from(envelope.wrapped_key, 'base64'),
      KeyId: envelope.key_id, EncryptionContext: { application: 'anshin-anpi', purpose } }), { abortSignal: AbortSignal.timeout(8000) });
    const key = Buffer.from(result.Plaintext);
    try { return decrypt(key, envelope, purpose); } finally { key.fill(0); result.Plaintext.fill(0); }
  }
}

export const lookup = (config, value) => createHmac('sha256', config.lookupKey).update(value.normalize('NFKC').trim().toLowerCase()).digest();
