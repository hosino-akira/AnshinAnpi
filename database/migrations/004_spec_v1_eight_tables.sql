\set ON_ERROR_STOP on
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SELECT pg_advisory_xact_lock(17001001);
SELECT EXISTS(SELECT 1 FROM app_meta.schema_migrations WHERE version='004_spec_v1_eight_tables') AS already_applied \gset
\if :already_applied
\echo '004_spec_v1_eight_tables already applied; skipping.'
\else
-- Apply only after a backup and exporting published policy text to configuration.
CREATE SCHEMA migration_004_old;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['facilities','terminals','users','consent_policies','consents','face_templates','recipients','face_verifications','safety_checks','mail_deliveries','mail_delivery_events','audit_logs','api_enrollments','api_sessions','api_idempotency','face_index_leases','face_cleanup_jobs'] LOOP
  EXECUTE format('ALTER TABLE public.%I SET SCHEMA migration_004_old',t);
 END LOOP;
END; $$;
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

INSERT INTO terminals(terminal_id,facility_id,status,app_version,last_seen_at,terminal_code,name,timezone,credential_fingerprint,created_at,updated_at)
 SELECT t.terminal_id,t.facility_id,t.status,t.app_version,t.last_seen_at,t.terminal_code,t.name,f.timezone,t.credential_fingerprint,t.created_at,t.updated_at
 FROM migration_004_old.terminals t JOIN migration_004_old.facilities f USING(facility_id);
INSERT INTO users(user_id,display_name,status,created_at,updated_at,temp_id,terminal_id,registered_at,suspended_at,deleted_at,purge_after)
 SELECT u.user_id,u.encrypted_display_name,u.status,u.created_at,u.updated_at,e.temp_id,e.terminal_id,u.registered_at,u.suspended_at,u.deleted_at,u.purge_after
 FROM migration_004_old.users u LEFT JOIN migration_004_old.api_enrollments e USING(user_id);
INSERT INTO face_templates(template_id,user_id,encrypted_template,model_version,threshold_version,status,provider,created_at,updated_at)
 SELECT template_id,user_id,encrypted_template,model_version,threshold_version,status,provider,created_at,updated_at FROM migration_004_old.face_templates;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM migration_004_old.face_cleanup_jobs) THEN
  RAISE EXCEPTION 'Complete pending external face cleanup before this migration';
 END IF;
END; $$;
INSERT INTO recipients(recipient_id,user_id,name,encrypted_email,order_no,status,last_bounced_at,bounce_count,created_at,updated_at)
 SELECT recipient_id,user_id,encrypted_name,encrypted_email,order_no,status,last_bounced_at,bounce_count,created_at,updated_at FROM migration_004_old.recipients;
INSERT INTO consents(consent_id,user_id,temp_id,policy_version,consented_at,terminal_id,result,consent_type,request_id)
 SELECT consent_id,user_id,temp_id,policy_version,consented_at,terminal_id,result,consent_type,request_id FROM migration_004_old.consents;
INSERT INTO safety_checks(check_id,user_id,terminal_id,verified_at,consent_id,status,check_type,idempotency_key,request_sha256,expires_at,completed_at,created_at,updated_at)
 SELECT check_id,user_id,terminal_id,verified_at,consent_id,status,check_type,idempotency_key,request_sha256,expires_at,completed_at,created_at,updated_at FROM migration_004_old.safety_checks;
INSERT INTO mail_deliveries(delivery_id,check_id,recipient_id,provider_message_id,status,accepted_at,user_id,recipient_order_no,encrypted_email_snapshot,snapshot_erased_at,provider,attempt_count,next_attempt_at,last_attempt_at,sending_started_at,delivered_at,bounced_at,error_code,created_at,updated_at)
 SELECT delivery_id,check_id,recipient_id,provider_message_id,status,accepted_at,user_id,recipient_order_no,encrypted_email_snapshot,snapshot_erased_at,provider,attempt_count,next_attempt_at,last_attempt_at,sending_started_at,delivered_at,bounced_at,error_code,created_at,updated_at FROM migration_004_old.mail_deliveries;
INSERT INTO audit_logs(log_id,actor_type,actor_id,action,target_type,target_id,result,occurred_at,error_code,request_id,terminal_id,retain_until,previous_entry_hmac,entry_hmac,signing_key_id)
 OVERRIDING SYSTEM VALUE SELECT log_id,actor_type,actor_id,action,target_type,target_id,result,occurred_at,error_code,request_id,terminal_id,retain_until,previous_entry_hmac,entry_hmac,signing_key_id FROM migration_004_old.audit_logs;
SELECT setval(pg_get_serial_sequence('audit_logs','log_id'),COALESCE((SELECT max(log_id) FROM audit_logs),1),EXISTS(SELECT 1 FROM audit_logs));
-- All old data remains available in the pre-migration dump. No extra runtime tables.
DROP SCHEMA migration_004_old CASCADE;
DROP FUNCTION IF EXISTS touch_updated_at(),validate_facility_timezone(),validate_consent_record(),protect_policy_content(),lock_recipient_owner(),require_active_user_recipient(),validate_new_safety_check(),validate_new_delivery(),protect_audit_logs(),erase_recipient_snapshots(),erase_user_references(),queue_external_face_cleanup(),revoke_user_api_access() CASCADE;
INSERT INTO app_meta.schema_migrations(version) VALUES('004_spec_v1_eight_tables');
\endif
COMMIT;
