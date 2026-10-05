import { loadLocalEnv, readConfig } from './config.js';
import { createPool } from './db.js';
import { LocalCipher, KmsCipher } from './crypto.js';
import { loadPolicies } from './policies.js';
import { TemporaryStore } from './temporary-store.js';
import { AwsFaceProvider } from './providers/aws-face.js';
import { SmtpMailProvider } from './providers/smtp-mail.js';

export async function createRuntime() {
  loadLocalEnv();
  const config = await readConfig();
  const pool = createPool(config);
  try {
    if (!(await pool.query("SELECT 1 FROM app_meta.schema_migrations WHERE version='004_spec_v1_eight_tables'")).rowCount) throw new Error('Run the database migrations first');
    const cipher = config.encryptionMode === 'kms' ? new KmsCipher(config) : new LocalCipher(config.encryptionKey, config.encryptionKeyId);
    const store = new TemporaryStore(config);
    const face = new AwsFaceProvider(config);
    const mail = new SmtpMailProvider(config);
    return { config, pool, cipher, policies: loadPolicies(), store, face, mail,
      close: async () => { store.close(); mail.close(); face.client.destroy(); await pool.end(); } };
  } catch (error) { await pool.end(); throw error; }
}
