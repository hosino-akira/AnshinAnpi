\set ON_ERROR_STOP on
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = public, pg_catalog;
SELECT pg_advisory_xact_lock(17001001);
SELECT EXISTS (SELECT 1 FROM app_meta.schema_migrations WHERE version = '002_user_api') AS already_applied \gset
\if :already_applied
    \echo '002_user_api already applied; skipping.'
\else

ALTER TABLE face_templates ADD COLUMN template_format varchar(30) NOT NULL DEFAULT 'feature_vector'
    CHECK (template_format IN ('feature_vector', 'provider_reference'));
COMMENT ON COLUMN face_templates.template_format IS 'Rekognitionでは暗号化したCollection/FaceId参照を保存し、特徴ベクトルはAWSが管理する。';

ALTER TABLE mail_deliveries DROP CONSTRAINT mail_deliveries_status_check;
ALTER TABLE mail_deliveries ADD CONSTRAINT mail_deliveries_status_check
    CHECK (status IN ('queued', 'sending', 'unknown', 'accepted', 'delivered', 'bounced', 'failed', 'cancelled'));
ALTER TABLE mail_deliveries ADD COLUMN sending_started_at timestamptz;
ALTER TABLE safety_checks DROP CONSTRAINT safety_checks_status_check;
ALTER TABLE safety_checks ADD CONSTRAINT safety_checks_status_check
    CHECK (status IN ('queued', 'processing', 'unknown', 'accepted', 'partially_accepted', 'failed', 'cancelled'));
COMMENT ON COLUMN mail_deliveries.sending_started_at IS '外部API呼出し前にsendingをコミット。結果不明のunknownは自動再送しない。';

CREATE TABLE api_enrollments (
    temp_id uuid PRIMARY KEY,
    user_id uuid NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
    terminal_id uuid NOT NULL REFERENCES terminals(terminal_id) ON DELETE RESTRICT,
    confirmation_check_id uuid REFERENCES safety_checks(check_id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE TABLE api_sessions (
    session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
    terminal_id uuid NOT NULL REFERENCES terminals(terminal_id) ON DELETE RESTRICT,
    user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    purpose varchar(20) NOT NULL CHECK (purpose IN ('registration', 'safety')),
    verification_id uuid REFERENCES face_verifications(verification_id) ON DELETE SET NULL,
    confirmed_at timestamptz,
    consumed_by_check_id uuid REFERENCES safety_checks(check_id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    last_activity_at timestamptz NOT NULL DEFAULT current_timestamp,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    CHECK (expires_at > created_at)
);
CREATE INDEX api_sessions_user_idx ON api_sessions(user_id);
CREATE INDEX api_sessions_expiry_idx ON api_sessions(expires_at);
COMMENT ON TABLE api_sessions IS '短期ユーザートークンはSHA-256のみ保存。端末・用途・顔照合に紐付ける。';

CREATE TABLE api_idempotency (
    terminal_id uuid NOT NULL REFERENCES terminals(terminal_id) ON DELETE RESTRICT,
    idempotency_key varchar(128) NOT NULL,
    operation varchar(200) NOT NULL,
    request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
    encrypted_response bytea NOT NULL,
    response_status smallint NOT NULL CHECK (response_status BETWEEN 200 AND 299),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (terminal_id, idempotency_key),
    CHECK (expires_at > created_at)
);
CREATE INDEX api_idempotency_expiry_idx ON api_idempotency(expires_at);
COMMENT ON TABLE api_idempotency IS 'POST/PUT/PATCHの成功応答を暗号化保存。生リクエストや氏名・メールは保存しない。';

CREATE TABLE face_index_leases (
    user_id uuid PRIMARY KEY,
    terminal_id uuid NOT NULL REFERENCES terminals(terminal_id) ON DELETE RESTRICT,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE face_index_leases IS 'AWS IndexFacesとDBコミット間の障害に備える作業リース。画像・特徴量は格納しない。';

CREATE TABLE face_cleanup_jobs (
    job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider varchar(100) NOT NULL,
    encrypted_reference bytea NOT NULL,
    encryption_key_id varchar(200) NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT current_timestamp,
    error_code varchar(100),
    created_at timestamptz NOT NULL DEFAULT current_timestamp
);
CREATE INDEX face_cleanup_jobs_due_idx ON face_cleanup_jobs(next_attempt_at);
COMMENT ON TABLE face_cleanup_jobs IS 'ユーザー・顔テンプレート削除後、AWSに残る顔ベクトルも削除するアウトボックス。';

CREATE FUNCTION queue_external_face_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.template_format = 'provider_reference'
        AND (TG_OP = 'DELETE' OR (OLD.status = 'active' AND NEW.status <> 'active')) THEN
        INSERT INTO face_cleanup_jobs(provider, encrypted_reference, encryption_key_id)
            VALUES (OLD.provider, OLD.encrypted_template, OLD.encryption_key_id);
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER face_templates_external_cleanup BEFORE DELETE OR UPDATE OF status ON face_templates
    FOR EACH ROW EXECUTE FUNCTION queue_external_face_cleanup();

CREATE FUNCTION revoke_user_api_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IN ('suspended', 'deleted') AND NEW.status IS DISTINCT FROM OLD.status THEN
        UPDATE api_sessions SET revoked_at = clock_timestamp() WHERE user_id = NEW.user_id AND revoked_at IS NULL;
        UPDATE face_templates SET status = 'revoked', revoked_at = clock_timestamp(), purge_after = NEW.purge_after
            WHERE user_id = NEW.user_id AND status = 'active';
        UPDATE mail_deliveries SET status = 'cancelled', next_attempt_at = NULL
            WHERE user_id = NEW.user_id AND status = 'queued';
        UPDATE safety_checks SET status = 'cancelled', completed_at = clock_timestamp()
            WHERE user_id = NEW.user_id AND status IN ('queued', 'processing');
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER users_revoke_api AFTER UPDATE OF status ON users
    FOR EACH ROW EXECUTE FUNCTION revoke_user_api_access();

INSERT INTO app_meta.schema_migrations(version) VALUES ('002_user_api');
\endif
COMMIT;
