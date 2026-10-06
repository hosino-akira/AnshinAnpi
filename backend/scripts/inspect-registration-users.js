import { loadLocalEnv, readConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { LocalCipher, KmsCipher } from '../src/crypto.js';

// Read-only local troubleshooting; does not contact the face or mail service.
loadLocalEnv();
const config = await readConfig();
const pool = createPool(config);
const cipher = config.encryptionMode === 'kms' ? new KmsCipher(config) : new LocalCipher(config.encryptionKey, config.encryptionKeyId);
try {
  const users = (await pool.query(`SELECT u.user_id,u.display_name,u.status,u.created_at,
    count(t.template_id) FILTER (WHERE t.status='active') AS active_face_count
    FROM users u LEFT JOIN face_templates t USING(user_id)
    WHERE u.status IN ('active','pending_registration')
    GROUP BY u.user_id ORDER BY u.created_at LIMIT 100`)).rows;
  for (const user of users) console.log(JSON.stringify({
    user_id: user.user_id, display_name: await cipher.open(user.display_name, 'user-name'),
    status: user.status, created_at: user.created_at, active_face_count: Number(user.active_face_count),
  }));
} finally { await pool.end(); }
