import { createRuntime } from '../src/runtime.js';
import { auditDigest } from '../src/audit.js';
import { equal } from '../src/crypto.js';

const runtime = await createRuntime();
try {
  const rows = (await runtime.pool.query('SELECT * FROM audit_logs ORDER BY log_id')).rows;
  let previous = null;
  for (const [index, row] of rows.entries()) {
    if (row.signing_key_id !== runtime.config.auditKeyId) throw new Error('Historical signing key is required for this audit segment');
    if (index > 0 && !equal(row.previous_entry_hmac ?? Buffer.alloc(0), previous)) throw new Error(`Audit chain mismatch at log ${row.log_id}`);
    if (!equal(auditDigest(runtime.config, row, row.previous_entry_hmac), row.entry_hmac)) throw new Error(`Audit signature mismatch at log ${row.log_id}`);
    previous = row.entry_hmac;
  }
  console.log(`Verified ${rows.length} retained audit records. External anchoring is required to detect tail deletion or privileged replacement.`);
} finally { await runtime.close(); }
