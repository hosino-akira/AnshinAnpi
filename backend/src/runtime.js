import { loadLocalEnv, readConfig } from './config.js';
import { createPool } from './db.js';
import { LocalCipher, KmsCipher } from './crypto.js';
import { loadPolicies } from './policies.js';
import { TemporaryStore } from './temporary-store.js';
import { AwsFaceProvider } from './providers/aws-face.js';
import { AwsMailProvider } from './providers/aws-mail.js';

export async function createRuntime() {
  loadLocalEnv();
  const config = await readConfig();
  const pool = createPool(config);
  try {
    if (!(await pool.query("SELECT 1 FROM app_meta.schema_migrations WHERE version='004_spec_v1_eight_tables'")).rowCount) throw new Error('Run the database migrations first');
    const cipher = config.encryptionMode === 'kms' ? new KmsCipher(config) : new LocalCipher(config.encryptionKey, config.encryptionKeyId);
    const store = new TemporaryStore(config);
    return { config, pool, cipher, policies: loadPolicies(), store, face: new AwsFaceProvider(config), mail: new AwsMailProvider(config),
      close: async () => { store.close(); await pool.end(); } };
  } catch (error) { await pool.end(); throw error; }
}
