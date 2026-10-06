import { currentPolicy, loadPolicies } from './policies.js';
import { SAFETY_MAIL_SUBJECT, SAFETY_MAIL_BODY } from './mail-message.js';

export async function initializeAdminSettings(deps) {
  for (const policy of deps.policies ?? loadPolicies()) {
    await deps.pool.query(`INSERT INTO app_meta.admin_settings(setting_key,document) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [`policy.${policy.consent_type}.${policy.policy_version}`, { ...policy, effective_date: policy.effective_date ?? '1970-01-01' }]);
  }
  await deps.pool.query(`INSERT INTO app_meta.admin_settings(setting_key,document) VALUES('mail.safety',$1) ON CONFLICT DO NOTHING`,
    [{ subject: SAFETY_MAIL_SUBJECT, body: SAFETY_MAIL_BODY }]);
}
export async function publishedPolicy(db, policies, type, version) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const rows = (await db.query(`SELECT document FROM app_meta.admin_settings WHERE setting_key LIKE $1
    AND document->>'status'='published' AND document->>'effective_date'<=$2
    ORDER BY document->>'effective_date' DESC,updated_at DESC LIMIT 1`, [`policy.${type}.%`, today])).rows;
  return currentPolicy(rows.length ? [rows[0].document] : policies, type, version);
}
export async function safetyTemplate(db) {
  return (await db.query("SELECT document FROM app_meta.admin_settings WHERE setting_key='mail.safety'")).rows[0]?.document;
}
