-- Physical implementation of development specification v1.0, section 10.1.
-- The names listed in the specification are preserved. Names, email and face
-- references remain encrypted bytea values using the existing application cipher.
CREATE TABLE terminals (
 terminal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 facility_id uuid NOT NULL,
 status varchar(20) NOT NULL DEFAULT 'inactive' CHECK(status IN ('active','inactive','maintenance','retired')),
 app_version varchar(100), last_seen_at timestamptz,
 terminal_code varchar(100) NOT NULL UNIQUE, name varchar(100) NOT NULL,
 timezone varchar(100) NOT NULL DEFAULT 'Asia/Tokyo', credential_fingerprint varchar(128),
 created_at timestamptz NOT NULL DEFAULT current_timestamp,
 updated_at timestamptz NOT NULL DEFAULT current_timestamp
);
CREATE TABLE users (
 user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 display_name bytea NOT NULL,
 status varchar(30) NOT NULL DEFAULT 'pending_registration' CHECK(status IN ('pending_registration','active','suspended','deleted')),
 created_at timestamptz NOT NULL DEFAULT current_timestamp,
 updated_at timestamptz NOT NULL DEFAULT current_timestamp,
 temp_id uuid UNIQUE, terminal_id uuid REFERENCES terminals,
 registered_at timestamptz, suspended_at timestamptz, deleted_at timestamptz, purge_after timestamptz
);
CREATE TABLE face_templates (
 template_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 encrypted_template bytea NOT NULL,
 model_version varchar(100) NOT NULL, threshold_version varchar(100) NOT NULL,
 status varchar(20) NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','deleted')),
 provider varchar(100) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT current_timestamp,
 updated_at timestamptz NOT NULL DEFAULT current_timestamp
);
CREATE UNIQUE INDEX face_templates_active_user_uq ON face_templates(user_id) WHERE status='active';
CREATE TABLE recipients (
 recipient_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 name bytea NOT NULL, encrypted_email bytea NOT NULL,
 order_no smallint NOT NULL CHECK(order_no BETWEEN 1 AND 2),
 status varchar(30) NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','needs_correction','deleted')),
 last_bounced_at timestamptz, bounce_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT current_timestamp,
 updated_at timestamptz NOT NULL DEFAULT current_timestamp
);
CREATE UNIQUE INDEX recipients_user_order_uq ON recipients(user_id,order_no) WHERE status<>'deleted';
CREATE TABLE consents (
 consent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid REFERENCES users ON DELETE SET NULL, temp_id uuid,
 policy_version varchar(50) NOT NULL,
 consented_at timestamptz NOT NULL DEFAULT current_timestamp,
 terminal_id uuid NOT NULL REFERENCES terminals,
 result varchar(20) NOT NULL CHECK(result IN ('granted','denied','withdrawn')),
 consent_type varchar(20) NOT NULL CHECK(consent_type IN ('registration','safety')),
 request_id uuid NOT NULL DEFAULT gen_random_uuid()
);
CREATE INDEX consents_user_type_idx ON consents(user_id,consent_type,consented_at DESC);
CREATE INDEX consents_temp_idx ON consents(temp_id) WHERE temp_id IS NOT NULL;
CREATE TABLE safety_checks (
 check_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid REFERENCES users ON DELETE SET NULL,
 terminal_id uuid NOT NULL REFERENCES terminals,
 verified_at timestamptz NOT NULL, consent_id uuid REFERENCES consents ON DELETE SET NULL,
 status varchar(30) NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','unknown','accepted','partially_accepted','failed','cancelled')),
 check_type varchar(20) NOT NULL DEFAULT 'safety' CHECK(check_type IN ('registration','safety')),
 idempotency_key varchar(128) NOT NULL, request_sha256 bytea NOT NULL,
 expires_at timestamptz NOT NULL, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT current_timestamp,
 updated_at timestamptz NOT NULL DEFAULT current_timestamp,
 UNIQUE(terminal_id,idempotency_key)
);
CREATE UNIQUE INDEX registration_mail_user_uq ON safety_checks(user_id) WHERE check_type='registration';
CREATE TABLE mail_deliveries (
 delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 check_id uuid REFERENCES safety_checks ON DELETE CASCADE,
 recipient_id uuid REFERENCES recipients ON DELETE SET NULL,
 provider_message_id varchar(255),
 status varchar(20) NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','unknown','accepted','delivered','bounced','failed','cancelled')),
 accepted_at timestamptz,
 user_id uuid REFERENCES users ON DELETE SET NULL, recipient_order_no smallint NOT NULL,
 encrypted_email_snapshot bytea, snapshot_erased_at timestamptz,
 provider varchar(100) NOT NULL, attempt_count smallint NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
 next_attempt_at timestamptz, last_attempt_at timestamptz, sending_started_at timestamptz,
 delivered_at timestamptz, bounced_at timestamptz, error_code varchar(100),
 created_at timestamptz NOT NULL DEFAULT current_timestamp,
 updated_at timestamptz NOT NULL DEFAULT current_timestamp,
 UNIQUE(check_id,recipient_order_no)
);
CREATE INDEX mail_deliveries_retry_idx ON mail_deliveries(next_attempt_at,created_at) WHERE status='queued';
CREATE UNIQUE INDEX mail_deliveries_message_uq ON mail_deliveries(provider,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE TABLE audit_logs (
 log_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_type varchar(20) NOT NULL, actor_id varchar(200), action varchar(100) NOT NULL,
 target_type varchar(100) NOT NULL, target_id varchar(200), result varchar(20) NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT current_timestamp,
 error_code varchar(100), request_id uuid NOT NULL, terminal_id uuid,
 retain_until timestamptz NOT NULL DEFAULT (current_timestamp+interval '1 year'),
 previous_entry_hmac bytea, entry_hmac bytea NOT NULL, signing_key_id varchar(200) NOT NULL
);
CREATE INDEX audit_logs_target_idx ON audit_logs(target_type,target_id,occurred_at DESC);

CREATE FUNCTION spec_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END;
$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['terminals','users','face_templates','recipients','safety_checks','mail_deliveries'] LOOP
  EXECUTE format('CREATE TRIGGER updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION spec_touch_updated_at()',t);
 END LOOP;
END; $$;
-- Keep external references until the existing mail worker deletes managed faces.
CREATE FUNCTION spec_suspend_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN ('suspended','deleted') AND NEW.status IS DISTINCT FROM OLD.status THEN
  UPDATE face_templates SET status='revoked' WHERE user_id=NEW.user_id AND status='active';
  UPDATE mail_deliveries SET status='cancelled',next_attempt_at=NULL WHERE user_id=NEW.user_id AND status='queued';
  UPDATE safety_checks SET status='cancelled',completed_at=clock_timestamp() WHERE user_id=NEW.user_id AND status IN ('queued','processing');
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER users_suspend AFTER UPDATE OF status ON users FOR EACH ROW EXECUTE FUNCTION spec_suspend_user();
