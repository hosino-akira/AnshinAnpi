\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(17001001);
SELECT EXISTS(SELECT 1 FROM app_meta.schema_migrations WHERE version='005_single_admin') AS already_applied \gset
\if :already_applied
\echo '005_single_admin already applied; skipping.'
\else
-- 単一の管理者と管理設定を追加し、public の 8 業務テーブルは引き続き共用します。
CREATE TABLE app_meta.administrator (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 name varchar(50) NOT NULL, email varchar(254) NOT NULL,
 password_hash text NOT NULL, encrypted_totp_secret bytea NOT NULL,
 last_totp_step bigint NOT NULL DEFAULT -1, auth_version integer NOT NULL DEFAULT 1,
 failed_attempts integer NOT NULL DEFAULT 0, locked_until timestamptz,
 last_login_at timestamptz, last_login_ip inet,
 created_at timestamptz NOT NULL DEFAULT current_timestamp,
 updated_at timestamptz NOT NULL DEFAULT current_timestamp
);
CREATE TABLE app_meta.admin_settings (
 setting_key varchar(100) PRIMARY KEY, document jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE audit_logs ADD COLUMN reason varchar(20) CHECK(reason IN ('support','correction','suspension','deletion','audit'));
-- 修正通知には既存の配信ワーカーを使い、別のキューは作成しません。
ALTER TABLE safety_checks DROP CONSTRAINT safety_checks_check_type_check;
ALTER TABLE safety_checks ADD CONSTRAINT safety_checks_check_type_check
 CHECK(check_type IN ('registration','safety','contact_change'));
INSERT INTO app_meta.schema_migrations(version) VALUES('005_single_admin');
\endif
COMMIT;
