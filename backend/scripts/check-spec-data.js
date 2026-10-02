import { readFile, writeFile } from 'node:fs/promises';
import { loadLocalEnv, readConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { sha256 } from '../src/crypto.js';

loadLocalEnv();
const config = await readConfig();
if (process.env.SPEC_CHECK_DATABASE) config.postgres = { ...config.postgres, connectionString: undefined, database: process.env.SPEC_CHECK_DATABASE };
const pool = createPool(config);
const snapshotFile = new URL('../../database/backups/spec-data-check.json', import.meta.url);
try {
  const old = (await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='encrypted_display_name'")).rowCount > 0;
  const queries = {
    users: `SELECT user_id,${old?'encrypted_display_name':'display_name'} AS display_name,status,created_at,updated_at FROM users ORDER BY user_id`,
    recipients: `SELECT recipient_id,user_id,${old?'encrypted_name':'name'} AS name,encrypted_email,order_no,status,created_at,updated_at FROM recipients ORDER BY recipient_id`,
    face_templates: 'SELECT template_id,user_id,encrypted_template,model_version,threshold_version,status,provider,created_at,updated_at FROM face_templates ORDER BY template_id',
    consents: 'SELECT consent_id,user_id,temp_id,policy_version,consented_at,terminal_id,result,consent_type,request_id FROM consents ORDER BY consent_id',
    safety_checks: 'SELECT check_id,user_id,terminal_id,verified_at,consent_id,status,check_type,idempotency_key,request_sha256,expires_at,completed_at,created_at,updated_at FROM safety_checks ORDER BY check_id',
    mail_deliveries: 'SELECT delivery_id,check_id,recipient_id,provider_message_id,status,accepted_at,user_id,recipient_order_no,encrypted_email_snapshot,snapshot_erased_at,provider,attempt_count,next_attempt_at,last_attempt_at,sending_started_at,delivered_at,bounced_at,error_code,created_at,updated_at FROM mail_deliveries ORDER BY delivery_id',
    terminals: 'SELECT terminal_id,facility_id,status,app_version,last_seen_at,terminal_code,name,credential_fingerprint,created_at,updated_at FROM terminals ORDER BY terminal_id',
    audit_logs: 'SELECT log_id,actor_type,actor_id,action,target_type,target_id,result,occurred_at,error_code,request_id,terminal_id,retain_until,previous_entry_hmac,entry_hmac,signing_key_id FROM audit_logs ORDER BY log_id',
  };
  const snapshot = {};
  for (const [table, sql] of Object.entries(queries)) {
    const rows = (await pool.query(sql)).rows;
    snapshot[table] = { rows: rows.length, sha256: sha256(JSON.stringify(rows)).toString('hex') };
  }
  if (process.argv.includes('--capture')) {
    await writeFile(snapshotFile, JSON.stringify(snapshot,null,2)+'\n');
    console.log('Captured counts and data digests for the eight business tables; no personal values printed.');
  } else {
    const before = JSON.parse(await readFile(snapshotFile,'utf8'));
    for (const [table,value] of Object.entries(snapshot)) {
      if (JSON.stringify(value) !== JSON.stringify(before[table])) throw new Error(`Migration data mismatch: ${table}`);
    }
    console.log('All eight business tables preserved IDs, encrypted data, timestamps and operation records.');
  }
} finally { await pool.end(); }
