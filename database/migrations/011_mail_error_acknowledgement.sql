\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(17001001);
SELECT EXISTS(SELECT 1 FROM app_meta.schema_migrations WHERE version='011_mail_error_acknowledgement') AS already_applied \gset
\if :already_applied
\echo '011_mail_error_acknowledgement は適用済みのためスキップします。'
\else
ALTER TABLE mail_deliveries ADD COLUMN error_acknowledged_at timestamptz;
COMMENT ON COLUMN mail_deliveries.error_acknowledged_at IS '管理者の確認済み操作で一覧から除外する日時。元の配信結果は保持する。';
CREATE INDEX mail_deliveries_unacknowledged_error_idx ON mail_deliveries(updated_at DESC,delivery_id DESC)
 WHERE status IN ('failed','unknown','bounced') AND error_acknowledged_at IS NULL;
INSERT INTO app_meta.schema_migrations(version) VALUES('011_mail_error_acknowledgement');
\endif
COMMIT;
