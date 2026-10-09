\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(17001001);
SELECT EXISTS(SELECT 1 FROM app_meta.schema_migrations WHERE version='008_safety_consent_template') AS already_applied \gset
\if :already_applied
\echo '008_safety_consent_template already applied; skipping.'
\else
-- Keep historical consent versions; substitute the verified user's name at response time.
INSERT INTO app_meta.admin_settings(setting_key,document)
VALUES ('policy.safety.safety-v1','{"consent_type":"safety","policy_version":"safety-v1","title":"安否確認メールの送信内容","body":"{{登録者名}}さんが、安否確認操作を行いました。\n本人の操作により送信された自動メールです。","status":"published","requires_reconsent":false,"effective_date":"2026-10-08"}'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;
INSERT INTO app_meta.schema_migrations(version) VALUES('008_safety_consent_template');
\endif
COMMIT;
