import { createHmac } from 'node:crypto';
import { canonical } from './crypto.js';

export const signedAuditFields = row => ({
  log_id: String(row.log_id), actor_type: row.actor_type, actor_id: row.actor_id ?? null,
  action: row.action, target_type: row.target_type, target_id: row.target_id ?? null,
  result: row.result, error_code: row.error_code ?? null, request_id: row.request_id,
  terminal_id: row.terminal_id ?? null, occurred_at: new Date(row.occurred_at).toISOString(),
  retain_until: new Date(row.retain_until).toISOString(), signing_key_id: row.signing_key_id,
});

export function auditDigest(config, row, previous) {
  return createHmac('sha256', config.auditKey).update(previous ?? Buffer.alloc(0)).update(canonical(signedAuditFields(row))).digest();
}

export async function audit(db, config, request, action, targetType, targetId, result = 'success', errorCode = null) {
  await db.query('SELECT pg_advisory_xact_lock(17001002)');
  const previous = (await db.query('SELECT entry_hmac FROM audit_logs ORDER BY log_id DESC LIMIT 1')).rows[0]?.entry_hmac ?? null;
  const id = (await db.query("SELECT nextval(pg_get_serial_sequence('audit_logs', 'log_id')) AS id")).rows[0].id;
  const occurred = new Date();
  const retention = new Date(occurred); retention.setUTCFullYear(retention.getUTCFullYear() + 1);
  const row = { log_id: id, actor_type: 'terminal', actor_id: request.terminal.terminal_id,
    action, target_type: targetType, target_id: targetId ?? null, result, error_code: errorCode,
    request_id: request.id, terminal_id: request.terminal.terminal_id, occurred_at: occurred,
    retain_until: retention, signing_key_id: config.auditKeyId };
  const entry = auditDigest(config, row, previous);
  await db.query(`INSERT INTO audit_logs(log_id, actor_type, actor_id, action, target_type, target_id, result,
    error_code, request_id, terminal_id, occurred_at, retain_until, previous_entry_hmac, entry_hmac, signing_key_id)
    OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, row.actor_type, row.actor_id, action, targetType, row.target_id, result, errorCode,
      request.id, row.terminal_id, occurred, retention, previous, entry, config.auditKeyId]);
}
