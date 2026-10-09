\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(17001001);
SELECT EXISTS(SELECT 1 FROM app_meta.schema_migrations WHERE version='009_remove_old_consent_policies') AS already_applied \gset
\if :already_applied
\echo '009_remove_old_consent_policies already applied; skipping.'
\else
-- Remove obsolete policy documents; keep the current registration and safety versions.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_meta.admin_settings WHERE setting_key='policy.registration.privacy-v2')
    OR NOT EXISTS (SELECT 1 FROM app_meta.admin_settings WHERE setting_key='policy.safety.safety-v1') THEN
    RAISE EXCEPTION 'Apply migrations 007 and 008 before removing old policies';
  END IF;
END; $$;
DELETE FROM app_meta.admin_settings
WHERE (setting_key LIKE 'policy.registration.%' AND setting_key <> 'policy.registration.privacy-v2')
   OR (setting_key LIKE 'policy.safety.%' AND setting_key <> 'policy.safety.safety-v1');
INSERT INTO app_meta.schema_migrations(version) VALUES('009_remove_old_consent_policies');
\endif
COMMIT;
