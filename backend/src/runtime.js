import { createClient } from 'redis';
import { loadLocalEnv, readConfig } from './config.js';
import { createPool } from './db.js';
import { LocalCipher, KmsCipher } from './crypto.js';
import { TemporaryStore } from './temporary-store.js';
import { AwsFaceProvider } from './providers/aws-face.js';
import { AwsMailProvider } from './providers/aws-mail.js';

export async function createRuntime() {
  loadLocalEnv();
  const config = await readConfig();
  const pool = createPool(config);
  const redis = createClient({ url: config.redisUrl, socket: { connectTimeout: 5000, reconnectStrategy: false } });
  redis.on('error', () => {}); // Application logs only fixed error codes, never URLs or secrets.
  try {
    await redis.connect();
    if (!(await pool.query("SELECT 1 FROM schema_migrations WHERE version='002_user_api'")).rowCount) throw new Error('Run the database migrations first');
    const cipher = config.encryptionMode === 'kms' ? new KmsCipher(config) : new LocalCipher(config.encryptionKey, config.encryptionKeyId);
    return { config, pool, redis, cipher, store: new TemporaryStore(redis, config), face: new AwsFaceProvider(config), mail: new AwsMailProvider(config),
      close: async () => { await redis.quit().catch(() => {}); await pool.end(); } };
  } catch (error) { if (redis.isOpen) await redis.quit().catch(() => {}); await pool.end(); throw error; }
}
