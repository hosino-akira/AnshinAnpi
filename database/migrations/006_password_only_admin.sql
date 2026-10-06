\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(17001001);
SELECT EXISTS(SELECT 1 FROM app_meta.schema_migrations WHERE version='006_password_only_admin') AS already_applied \gset
\if :already_applied
\echo '006_password_only_admin already applied; skipping.'
\else
-- Keep the existing password and remove authenticator data. Revoke old sessions.
ALTER TABLE app_meta.administrator DROP COLUMN encrypted_totp_secret, DROP COLUMN last_totp_step;
UPDATE app_meta.administrator SET auth_version=auth_version+1,updated_at=clock_timestamp();
INSERT INTO app_meta.schema_migrations(version) VALUES('006_password_only_admin');
\endif
COMMIT;
