-- PostgreSQL 17. Apply with psql; each migration is atomic and recorded once.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = public, pg_catalog;
SELECT pg_advisory_xact_lock(17001001);

CREATE SCHEMA IF NOT EXISTS app_meta;
DO $$ BEGIN
 IF to_regclass('public.schema_migrations') IS NOT NULL THEN
  ALTER TABLE public.schema_migrations SET SCHEMA app_meta;
 END IF;
END; $$;
CREATE TABLE IF NOT EXISTS app_meta.schema_migrations (
    version varchar(100) PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT current_timestamp
);
SELECT EXISTS (SELECT 1 FROM app_meta.schema_migrations WHERE version = '001_initial_schema') AS already_applied \gset
\if :already_applied
    \echo '001_initial_schema already applied; skipping.'
\else

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.created_at := OLD.created_at;
    NEW.updated_at := clock_timestamp();
    NEW.row_version := OLD.row_version + 1;
    RETURN NEW;
END;
$$;

CREATE TABLE facilities (
    facility_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_code varchar(50) NOT NULL UNIQUE CHECK (btrim(facility_code) <> ''),
    name varchar(150) NOT NULL CHECK (btrim(name) <> ''),
    timezone varchar(100) NOT NULL DEFAULT 'Asia/Tokyo',
    status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0)
);
COMMENT ON TABLE facilities IS '施設マスタ。時刻はUTCで保存し、施設のtimezoneで表示する。';

CREATE FUNCTION validate_facility_timezone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
        RAISE EXCEPTION 'Unknown facility timezone' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER facilities_timezone BEFORE INSERT OR UPDATE OF timezone ON facilities
    FOR EACH ROW EXECUTE FUNCTION validate_facility_timezone();

CREATE TABLE terminals (
    terminal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id uuid NOT NULL REFERENCES facilities(facility_id) ON DELETE RESTRICT,
    terminal_code varchar(100) NOT NULL UNIQUE CHECK (btrim(terminal_code) <> ''),
    name varchar(100) NOT NULL CHECK (btrim(name) <> ''),
    status varchar(20) NOT NULL DEFAULT 'inactive'
        CHECK (status IN ('active', 'inactive', 'maintenance', 'retired')),
    app_version varchar(100),
    credential_fingerprint varchar(128),
    last_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0)
);
CREATE INDEX terminals_facility_status_idx ON terminals(facility_id, status);
CREATE INDEX terminals_last_seen_idx ON terminals(last_seen_at) WHERE status = 'active';
COMMENT ON TABLE terminals IS '認証済み設置端末。秘密鍵・認証トークン自体は保存しない。';

CREATE TABLE users (
    user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id uuid NOT NULL REFERENCES facilities(facility_id) ON DELETE RESTRICT,
    encrypted_display_name bytea NOT NULL CHECK (octet_length(encrypted_display_name) > 0),
    display_name_lookup_hmac bytea NOT NULL CHECK (octet_length(display_name_lookup_hmac) = 32),
    encryption_key_id varchar(200) NOT NULL CHECK (btrim(encryption_key_id) <> ''),
    lookup_key_id varchar(200) NOT NULL CHECK (btrim(lookup_key_id) <> ''),
    status varchar(30) NOT NULL DEFAULT 'pending_registration'
        CHECK (status IN ('pending_registration', 'active', 'suspended', 'deleted')),
    registered_at timestamptz,
    suspended_at timestamptz,
    deleted_at timestamptz,
    purge_after timestamptz,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
    CHECK (status <> 'active' OR registered_at IS NOT NULL),
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
    CHECK (purge_after IS NULL OR purge_after >= COALESCE(deleted_at, suspended_at, created_at)),
    CHECK (status NOT IN ('deleted', 'suspended') OR purge_after IS NOT NULL)
);
CREATE INDEX users_facility_status_idx ON users(facility_id, status, created_at DESC);
CREATE INDEX users_name_lookup_idx ON users(lookup_key_id, display_name_lookup_hmac) WHERE status <> 'deleted';
CREATE INDEX users_purge_idx ON users(purge_after) WHERE purge_after IS NOT NULL;
COMMENT ON TABLE users IS '登録者。仕様のdisplay_nameはencrypted_display_nameとして暗号化保存する。';
COMMENT ON COLUMN users.display_name_lookup_hmac IS '正規化した氏名のHMAC-SHA-256。完全一致検索用。鍵はDB外で管理。';
COMMENT ON COLUMN users.purge_after IS '削除処理期限。30日は仕様案であり、確定した保持方針に従い設定する。';

CREATE TABLE consent_policies (
    policy_version varchar(50) NOT NULL CHECK (btrim(policy_version) <> ''),
    consent_type varchar(20) NOT NULL CHECK (consent_type IN ('registration', 'safety')),
    title varchar(200) NOT NULL CHECK (btrim(title) <> ''),
    body text NOT NULL CHECK (btrim(body) <> ''),
    content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
    status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
    published_at timestamptz,
    retired_at timestamptz,
    requires_reconsent boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
    PRIMARY KEY (policy_version, consent_type),
    CHECK (status = 'draft' OR published_at IS NOT NULL),
    CHECK (status <> 'retired' OR retired_at IS NOT NULL)
);
CREATE UNIQUE INDEX consent_policies_current_uq ON consent_policies(consent_type) WHERE status = 'published';
COMMENT ON TABLE consent_policies IS '登録同意・都度送信同意の版管理。公開後の文面変更は禁止。';

CREATE TABLE consents (
    consent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES users(user_id) ON DELETE SET NULL,
    temp_id uuid,
    consent_type varchar(20) NOT NULL CHECK (consent_type IN ('registration', 'safety')),
    policy_version varchar(50) NOT NULL,
    consented_at timestamptz NOT NULL DEFAULT current_timestamp,
    terminal_id uuid NOT NULL REFERENCES terminals(terminal_id) ON DELETE RESTRICT,
    result varchar(20) NOT NULL CHECK (result IN ('granted', 'denied', 'withdrawn')),
    request_id uuid NOT NULL DEFAULT gen_random_uuid(),
    subject_erased_at timestamptz,
    retain_until timestamptz NOT NULL DEFAULT (current_timestamp + interval '1 year'),
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    FOREIGN KEY (policy_version, consent_type) REFERENCES consent_policies(policy_version, consent_type) ON DELETE RESTRICT,
    UNIQUE (consent_id, user_id, terminal_id, consent_type),
    CHECK ((subject_erased_at IS NULL AND num_nonnulls(user_id, temp_id) = 1)
        OR (subject_erased_at IS NOT NULL AND user_id IS NULL AND temp_id IS NULL)),
    CHECK (consent_type <> 'safety' OR temp_id IS NULL),
    CHECK (retain_until >= consented_at)
);
CREATE INDEX consents_user_type_idx ON consents(user_id, consent_type, consented_at DESC);
CREATE INDEX consents_temp_idx ON consents(temp_id) WHERE temp_id IS NOT NULL;
CREATE INDEX consents_policy_idx ON consents(policy_version, consent_type);
CREATE INDEX consents_terminal_idx ON consents(terminal_id);
CREATE INDEX consents_retention_idx ON consents(retain_until);
COMMENT ON TABLE consents IS '同意結果の履歴。temp_idは不透明な相関IDのみ。同意前の氏名・顔を保存しない。';

CREATE FUNCTION validate_consent_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (SELECT 1 FROM consent_policies WHERE policy_version = NEW.policy_version
            AND consent_type = NEW.consent_type
            AND (status = 'published' OR (NEW.result = 'withdrawn' AND status = 'retired'))) THEN
            RAISE EXCEPTION 'Consent requires a published policy' USING ERRCODE = '23514';
        END IF;
        IF NEW.subject_erased_at IS NOT NULL THEN
            RAISE EXCEPTION 'New consent must identify its user or temporary session' USING ERRCODE = '23514';
        END IF;
    ELSE
        IF (NEW.consent_id, NEW.consent_type, NEW.policy_version, NEW.consented_at, NEW.terminal_id,
            NEW.result, NEW.request_id, NEW.created_at, NEW.retain_until)
            IS DISTINCT FROM (OLD.consent_id, OLD.consent_type, OLD.policy_version, OLD.consented_at,
                OLD.terminal_id, OLD.result, OLD.request_id, OLD.created_at, OLD.retain_until) THEN
            RAISE EXCEPTION 'Consent evidence is immutable; append a new decision' USING ERRCODE = '23514';
        END IF;
        IF NOT ((NEW.user_id, NEW.temp_id, NEW.subject_erased_at) IS NOT DISTINCT FROM
                (OLD.user_id, OLD.temp_id, OLD.subject_erased_at)
            OR (OLD.user_id IS NULL AND OLD.temp_id IS NOT NULL AND NEW.user_id IS NOT NULL
                AND NEW.temp_id IS NULL AND NEW.subject_erased_at IS NULL)
            OR (NEW.user_id IS NULL AND NEW.temp_id IS NULL AND NEW.subject_erased_at IS NOT NULL)) THEN
            RAISE EXCEPTION 'Consent subject cannot be reassigned' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER consents_validate BEFORE INSERT OR UPDATE ON consents
    FOR EACH ROW EXECUTE FUNCTION validate_consent_record();

CREATE FUNCTION protect_policy_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (OLD.status <> 'draft' OR EXISTS (
        SELECT 1 FROM consents WHERE policy_version = OLD.policy_version AND consent_type = OLD.consent_type
    )) AND (NEW.policy_version, NEW.consent_type, NEW.title, NEW.body, NEW.content_sha256, NEW.published_at)
        IS DISTINCT FROM (OLD.policy_version, OLD.consent_type, OLD.title, OLD.body, OLD.content_sha256, OLD.published_at) THEN
        RAISE EXCEPTION 'Publish a new policy version instead of editing published content' USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
        RAISE EXCEPTION 'A published policy cannot return to draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER consent_policies_protect BEFORE UPDATE ON consent_policies
    FOR EACH ROW EXECUTE FUNCTION protect_policy_content();

CREATE TABLE face_templates (
    template_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    encrypted_template bytea NOT NULL CHECK (octet_length(encrypted_template) > 0),
    encryption_key_id varchar(200) NOT NULL CHECK (btrim(encryption_key_id) <> ''),
    provider varchar(100) NOT NULL CHECK (btrim(provider) <> ''),
    model_version varchar(100) NOT NULL CHECK (btrim(model_version) <> ''),
    threshold_version varchar(100) NOT NULL CHECK (btrim(threshold_version) <> ''),
    status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'deleted')),
    revoked_at timestamptz,
    purge_after timestamptz,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
    UNIQUE (template_id, user_id),
    CHECK (status = 'active' OR (revoked_at IS NOT NULL AND purge_after IS NOT NULL)),
    CHECK (purge_after IS NULL OR purge_after >= COALESCE(revoked_at, created_at))
);
CREATE UNIQUE INDEX face_templates_active_user_uq ON face_templates(user_id) WHERE status = 'active';
CREATE INDEX face_templates_user_idx ON face_templates(user_id, created_at DESC);
CREATE INDEX face_templates_model_idx ON face_templates(provider, model_version) WHERE status = 'active';
CREATE INDEX face_templates_purge_idx ON face_templates(purge_after) WHERE purge_after IS NOT NULL;
COMMENT ON TABLE face_templates IS '暗号化済み顔特徴のみ。原画像は保存しない。照合時はusers.statusも確認する。';

CREATE TABLE recipients (
    recipient_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    encrypted_name bytea NOT NULL CHECK (octet_length(encrypted_name) > 0),
    encrypted_email bytea NOT NULL CHECK (octet_length(encrypted_email) > 0),
    email_lookup_hmac bytea NOT NULL CHECK (octet_length(email_lookup_hmac) = 32),
    encryption_key_id varchar(200) NOT NULL CHECK (btrim(encryption_key_id) <> ''),
    lookup_key_id varchar(200) NOT NULL CHECK (btrim(lookup_key_id) <> ''),
    order_no smallint NOT NULL CHECK (order_no BETWEEN 1 AND 2),
    status varchar(30) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled', 'needs_correction', 'deleted')),
    last_bounced_at timestamptz,
    bounce_count integer NOT NULL DEFAULT 0 CHECK (bounce_count >= 0),
    deleted_at timestamptz,
    purge_after timestamptz,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
    UNIQUE (recipient_id, user_id),
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
    CHECK (status <> 'deleted' OR purge_after IS NOT NULL),
    CHECK (purge_after IS NULL OR purge_after >= COALESCE(deleted_at, created_at))
);
CREATE UNIQUE INDEX recipients_user_order_uq ON recipients(user_id, order_no) WHERE status <> 'deleted';
CREATE UNIQUE INDEX recipients_user_email_uq ON recipients(user_id, email_lookup_hmac) WHERE status <> 'deleted';
CREATE INDEX recipients_user_idx ON recipients(user_id);
CREATE INDEX recipients_correction_idx ON recipients(user_id) WHERE status = 'needs_correction';
CREATE INDEX recipients_purge_idx ON recipients(purge_after) WHERE purge_after IS NOT NULL;
COMMENT ON TABLE recipients IS '最大2件の連絡先。仕様のnameはencrypted_nameに対応。削除済みスロットは再利用できる。';
COMMENT ON COLUMN recipients.email_lookup_hmac IS 'trim/lowerで正規化したメールのHMAC-SHA-256。重複排除用。全宛先で同じ有効検索鍵を使用。';

-- Serialize child changes through a real parent write, including at REPEATABLE READ.
CREATE FUNCTION lock_recipient_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
        RAISE EXCEPTION 'A recipient cannot move between users' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN owner_id := OLD.user_id; ELSE owner_id := NEW.user_id; END IF;
    UPDATE users SET updated_at = clock_timestamp() WHERE user_id = owner_id;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER recipients_lock_owner BEFORE INSERT OR UPDATE OR DELETE ON recipients
    FOR EACH ROW EXECUTE FUNCTION lock_recipient_owner();

CREATE FUNCTION require_active_user_recipient() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN owner_id := OLD.user_id; ELSE owner_id := NEW.user_id; END IF;
    IF EXISTS (SELECT 1 FROM users WHERE user_id = owner_id AND status = 'active')
        AND NOT EXISTS (SELECT 1 FROM recipients WHERE user_id = owner_id AND status <> 'deleted') THEN
        RAISE EXCEPTION 'An active user must have at least one recipient' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER users_require_recipient AFTER INSERT OR UPDATE ON users
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_active_user_recipient();
CREATE CONSTRAINT TRIGGER recipients_require_recipient AFTER INSERT OR UPDATE OR DELETE ON recipients
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_active_user_recipient();

CREATE TABLE face_verifications (
    verification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES users(user_id) ON DELETE SET NULL,
    template_id uuid,
    terminal_id uuid NOT NULL REFERENCES terminals(terminal_id) ON DELETE RESTRICT,
    purpose varchar(20) NOT NULL CHECK (purpose IN ('registration', 'safety')),
    result varchar(30) NOT NULL CHECK (result IN ('matched', 'no_match', 'ambiguous', 'quality_failed', 'liveness_failed', 'error')),
    match_score double precision CHECK (match_score BETWEEN 0 AND 1),
    runner_up_score double precision CHECK (runner_up_score BETWEEN 0 AND 1),
    threshold double precision CHECK (threshold BETWEEN 0 AND 1),
    required_margin double precision CHECK (required_margin BETWEEN 0 AND 1),
    model_version varchar(100) NOT NULL CHECK (btrim(model_version) <> ''),
    threshold_version varchar(100) NOT NULL CHECK (btrim(threshold_version) <> ''),
    quality_passed boolean NOT NULL,
    liveness_passed boolean NOT NULL,
    verified_at timestamptz NOT NULL DEFAULT current_timestamp,
    request_id uuid NOT NULL DEFAULT gen_random_uuid(),
    retain_until timestamptz NOT NULL DEFAULT (current_timestamp + interval '1 year'),
    UNIQUE (verification_id, user_id, terminal_id, purpose),
    FOREIGN KEY (template_id, user_id) REFERENCES face_templates(template_id, user_id) ON DELETE SET NULL (template_id),
    CHECK (result <> 'matched' OR (quality_passed AND liveness_passed
        AND match_score IS NOT NULL AND threshold IS NOT NULL AND match_score >= threshold
        AND required_margin IS NOT NULL
        AND (runner_up_score IS NULL OR match_score - runner_up_score >= required_margin))),
    CHECK (retain_until >= verified_at)
);
CREATE INDEX face_verifications_user_idx ON face_verifications(user_id, verified_at DESC);
CREATE INDEX face_verifications_template_idx ON face_verifications(template_id, user_id);
CREATE INDEX face_verifications_terminal_idx ON face_verifications(terminal_id, verified_at DESC);
CREATE INDEX face_verifications_retention_idx ON face_verifications(retain_until);
COMMENT ON TABLE face_verifications IS '顔照合の判定証跡。スコアはアダプタで0〜1へ正規化し、撮影画像は保存しない。';

CREATE TABLE safety_checks (
    check_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES users(user_id) ON DELETE SET NULL,
    terminal_id uuid NOT NULL REFERENCES terminals(terminal_id) ON DELETE RESTRICT,
    check_type varchar(20) NOT NULL DEFAULT 'safety' CHECK (check_type IN ('registration', 'safety')),
    verification_id uuid UNIQUE,
    verified_at timestamptz NOT NULL,
    consent_id uuid UNIQUE,
    idempotency_key varchar(128) NOT NULL CHECK (btrim(idempotency_key) <> ''),
    request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
    status varchar(30) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'accepted', 'partially_accepted', 'failed', 'cancelled')),
    expires_at timestamptz NOT NULL,
    completed_at timestamptz,
    retain_until timestamptz NOT NULL DEFAULT (current_timestamp + interval '1 year'),
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
    UNIQUE (terminal_id, idempotency_key),
    UNIQUE (check_id, user_id),
    FOREIGN KEY (consent_id, user_id, terminal_id, check_type)
        REFERENCES consents(consent_id, user_id, terminal_id, consent_type) ON DELETE SET NULL (consent_id),
    FOREIGN KEY (verification_id, user_id, terminal_id, check_type)
        REFERENCES face_verifications(verification_id, user_id, terminal_id, purpose) ON DELETE SET NULL (verification_id),
    CHECK (expires_at > created_at),
    CHECK (verified_at <= created_at),
    CHECK (completed_at IS NULL OR completed_at >= created_at),
    CHECK (retain_until >= created_at)
);
CREATE INDEX safety_checks_user_idx ON safety_checks(user_id, created_at DESC);
CREATE INDEX safety_checks_queue_idx ON safety_checks(expires_at) WHERE status IN ('queued', 'processing');
CREATE INDEX safety_checks_retention_idx ON safety_checks(retain_until);
COMMENT ON TABLE safety_checks IS '1回の送信操作。check_typeで登録確認メールと安否メールを区分する。';
COMMENT ON COLUMN safety_checks.request_sha256 IS '同じ冪等キーで異なる入力が来た場合、APIはこのダイジェストを比較して409を返す。';
COMMENT ON COLUMN safety_checks.expires_at IS '本人操作の有効期限。配信ワーカーは期限後の遅延送信を行わない。';

CREATE FUNCTION validate_new_safety_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE user_status text;
BEGIN
    IF NEW.user_id IS NULL OR NEW.consent_id IS NULL OR NEW.verification_id IS NULL THEN
        RAISE EXCEPTION 'A new send requires a user, consent and face verification' USING ERRCODE = '23514';
    END IF;
    SELECT status INTO user_status FROM users WHERE user_id = NEW.user_id FOR SHARE;
    IF user_status IS NULL OR user_status NOT IN ('active', 'pending_registration')
        OR (NEW.check_type = 'safety' AND user_status <> 'active') THEN
        RAISE EXCEPTION 'User is not eligible for this send' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM consents WHERE consent_id = NEW.consent_id AND result = 'granted') THEN
        RAISE EXCEPTION 'A send requires granted consent' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM face_verifications
        WHERE verification_id = NEW.verification_id AND result = 'matched' AND verified_at = NEW.verified_at) THEN
        RAISE EXCEPTION 'A send requires a successful face verification' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM terminals WHERE terminal_id = NEW.terminal_id AND status = 'active') THEN
        RAISE EXCEPTION 'Terminal is not active' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER safety_checks_validate BEFORE INSERT ON safety_checks
    FOR EACH ROW EXECUTE FUNCTION validate_new_safety_check();

CREATE TABLE mail_deliveries (
    delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    check_id uuid,
    user_id uuid REFERENCES users(user_id) ON DELETE SET NULL,
    recipient_id uuid,
    recipient_order_no smallint NOT NULL CHECK (recipient_order_no BETWEEN 1 AND 2),
    encrypted_email_snapshot bytea,
    encryption_key_id varchar(200),
    snapshot_erased_at timestamptz,
    provider varchar(100) NOT NULL CHECK (btrim(provider) <> ''),
    provider_message_id varchar(255),
    status varchar(20) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'accepted', 'delivered', 'bounced', 'failed', 'cancelled')),
    attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
    next_attempt_at timestamptz,
    last_attempt_at timestamptz,
    accepted_at timestamptz,
    delivered_at timestamptz,
    bounced_at timestamptz,
    error_code varchar(100),
    retain_until timestamptz NOT NULL DEFAULT (current_timestamp + interval '1 year'),
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
    UNIQUE (check_id, recipient_id),
    UNIQUE (check_id, recipient_order_no),
    FOREIGN KEY (check_id, user_id) REFERENCES safety_checks(check_id, user_id) ON DELETE SET NULL (check_id),
    FOREIGN KEY (recipient_id, user_id) REFERENCES recipients(recipient_id, user_id) ON DELETE SET NULL (recipient_id),
    CHECK ((snapshot_erased_at IS NULL AND encrypted_email_snapshot IS NOT NULL
            AND octet_length(encrypted_email_snapshot) > 0 AND encryption_key_id IS NOT NULL AND btrim(encryption_key_id) <> '')
        OR (snapshot_erased_at IS NOT NULL AND encrypted_email_snapshot IS NULL AND encryption_key_id IS NULL)),
    CHECK (snapshot_erased_at IS NULL OR status <> 'queued'),
    CHECK (provider_message_id IS NULL OR btrim(provider_message_id) <> ''),
    CHECK (status NOT IN ('accepted', 'delivered', 'bounced') OR (provider_message_id IS NOT NULL AND accepted_at IS NOT NULL AND attempt_count >= 1)),
    CHECK (status <> 'delivered' OR delivered_at IS NOT NULL),
    CHECK (status <> 'bounced' OR bounced_at IS NOT NULL),
    CHECK (next_attempt_at IS NULL OR (status = 'queued' AND attempt_count < 3)),
    CHECK (retain_until >= created_at)
);
CREATE UNIQUE INDEX mail_deliveries_provider_message_uq ON mail_deliveries(provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX mail_deliveries_user_idx ON mail_deliveries(user_id);
CREATE INDEX mail_deliveries_recipient_idx ON mail_deliveries(recipient_id, user_id);
CREATE INDEX mail_deliveries_retry_idx ON mail_deliveries(next_attempt_at, created_at) WHERE status = 'queued';
CREATE INDEX mail_deliveries_retention_idx ON mail_deliveries(retain_until);
COMMENT ON TABLE mail_deliveries IS '宛先別結果。acceptedは配信事業者の受付であり、受信完了ではない。';
COMMENT ON COLUMN mail_deliveries.attempt_count IS '初回1回＋再試行2回で最大3回。曖昧なAPIタイムアウトは事業者側冪等性・照会で処理する。';

CREATE FUNCTION validate_new_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.check_id IS NULL OR NEW.user_id IS NULL OR NEW.recipient_id IS NULL THEN
        RAISE EXCEPTION 'A new delivery requires a check, user and recipient' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM recipients WHERE recipient_id = NEW.recipient_id
        AND user_id = NEW.user_id AND order_no = NEW.recipient_order_no AND status = 'active') THEN
        RAISE EXCEPTION 'Delivery recipient is not active or does not belong to the user' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM safety_checks WHERE check_id = NEW.check_id
        AND user_id = NEW.user_id AND status IN ('queued', 'processing') AND expires_at > clock_timestamp()) THEN
        RAISE EXCEPTION 'Send event is not open for delivery' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER mail_deliveries_validate BEFORE INSERT ON mail_deliveries
    FOR EACH ROW EXECUTE FUNCTION validate_new_delivery();

CREATE TABLE mail_delivery_events (
    event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id uuid REFERENCES mail_deliveries(delivery_id) ON DELETE SET NULL,
    provider varchar(100) NOT NULL CHECK (btrim(provider) <> ''),
    provider_event_id varchar(255) NOT NULL CHECK (btrim(provider_event_id) <> ''),
    provider_message_id varchar(255) NOT NULL CHECK (btrim(provider_message_id) <> ''),
    event_type varchar(20) NOT NULL CHECK (event_type IN ('accepted', 'delivered', 'bounced', 'complained', 'failed')),
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT current_timestamp,
    processed_at timestamptz,
    error_code varchar(100),
    retain_until timestamptz NOT NULL DEFAULT (current_timestamp + interval '1 year'),
    UNIQUE (provider, provider_event_id),
    CHECK (processed_at IS NULL OR processed_at >= received_at),
    CHECK (retain_until >= received_at)
);
CREATE INDEX mail_delivery_events_delivery_idx ON mail_delivery_events(delivery_id, occurred_at);
CREATE INDEX mail_delivery_events_message_idx ON mail_delivery_events(provider, provider_message_id);
CREATE INDEX mail_delivery_events_pending_idx ON mail_delivery_events(received_at) WHERE processed_at IS NULL;
CREATE INDEX mail_delivery_events_retention_idx ON mail_delivery_events(retain_until);
COMMENT ON TABLE mail_delivery_events IS '署名検証済みWebhookの必要項目のみ。イベントIDでリプレイを排除。本文・生payloadは保存しない。';

CREATE TABLE audit_logs (
    log_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_type varchar(20) NOT NULL CHECK (actor_type IN ('user', 'admin', 'terminal', 'system')),
    actor_id varchar(200),
    action varchar(100) NOT NULL CHECK (btrim(action) <> ''),
    target_type varchar(100) NOT NULL CHECK (btrim(target_type) <> ''),
    target_id varchar(200),
    result varchar(20) NOT NULL CHECK (result IN ('success', 'failure', 'denied')),
    error_code varchar(100),
    request_id uuid NOT NULL DEFAULT gen_random_uuid(),
    terminal_id uuid REFERENCES terminals(terminal_id) ON DELETE RESTRICT,
    occurred_at timestamptz NOT NULL DEFAULT current_timestamp,
    retain_until timestamptz NOT NULL DEFAULT (current_timestamp + interval '1 year'),
    previous_entry_hmac bytea CHECK (octet_length(previous_entry_hmac) = 32),
    entry_hmac bytea NOT NULL CHECK (octet_length(entry_hmac) = 32),
    signing_key_id varchar(200) NOT NULL CHECK (btrim(signing_key_id) <> ''),
    CHECK (retain_until >= occurred_at)
);
CREATE INDEX audit_logs_occurred_idx ON audit_logs(occurred_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs(target_type, target_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_type, actor_id, occurred_at DESC);
CREATE INDEX audit_logs_request_idx ON audit_logs(request_id);
CREATE INDEX audit_logs_terminal_idx ON audit_logs(terminal_id);
CREATE INDEX audit_logs_retention_idx ON audit_logs(retain_until);
COMMENT ON TABLE audit_logs IS '追記専用監査ログ。機微値・自由文は格納しない。HMAC作成と検証はDB外の監査サービスが担う。';

CREATE FUNCTION protect_audit_logs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.retain_until <= current_timestamp THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Audit logs are append-only until their retention deadline' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER audit_logs_protect BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION protect_audit_logs();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION protect_audit_logs();

-- Remove every retained copy of contact email when a recipient/user is physically erased.
CREATE FUNCTION erase_recipient_snapshots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE mail_deliveries SET encrypted_email_snapshot = NULL, encryption_key_id = NULL,
        snapshot_erased_at = clock_timestamp(),
        status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
        next_attempt_at = NULL
    WHERE recipient_id = OLD.recipient_id AND snapshot_erased_at IS NULL;
    RETURN OLD;
END;
$$;
CREATE TRIGGER recipients_erase_snapshots BEFORE DELETE ON recipients
    FOR EACH ROW EXECUTE FUNCTION erase_recipient_snapshots();

CREATE FUNCTION erase_user_references() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Clear composite references from leaf to parent before changing consent ownership.
    UPDATE mail_deliveries SET user_id = NULL, encrypted_email_snapshot = NULL, encryption_key_id = NULL,
        snapshot_erased_at = clock_timestamp(),
        status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
        next_attempt_at = NULL
        WHERE user_id = OLD.user_id;
    UPDATE safety_checks SET user_id = NULL,
        completed_at = CASE WHEN status IN ('queued', 'processing') THEN clock_timestamp() ELSE completed_at END,
        status = CASE WHEN status IN ('queued', 'processing') THEN 'cancelled' ELSE status END
        WHERE user_id = OLD.user_id;
    UPDATE consents SET user_id = NULL, temp_id = NULL, subject_erased_at = clock_timestamp()
        WHERE user_id = OLD.user_id;
    RETURN OLD;
END;
$$;
CREATE TRIGGER users_erase_references BEFORE DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION erase_user_references();

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['facilities', 'terminals', 'users', 'consent_policies',
        'face_templates', 'recipients', 'safety_checks', 'mail_deliveries'] LOOP
        EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
            table_name || '_updated_at', table_name);
    END LOOP;
END;
$$;

INSERT INTO app_meta.schema_migrations(version) VALUES ('001_initial_schema');
\endif
COMMIT;
