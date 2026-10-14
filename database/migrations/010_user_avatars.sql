\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(17001001);
SELECT EXISTS(SELECT 1 FROM app_meta.schema_migrations WHERE version='010_user_avatars') AS already_applied \gset
\if :already_applied
\echo '010_user_avatars already applied; skipping.'
\else
-- Existing users intentionally keep NULL and continue showing the default icon.
ALTER TABLE users ADD COLUMN encrypted_avatar bytea;
COMMENT ON COLUMN users.encrypted_avatar IS 'Encrypted 96x96 JPEG thumbnail for authenticated admin lists only; no original photo.';
ALTER TABLE users ADD CONSTRAINT users_deleted_avatar_empty CHECK(status<>'deleted' OR encrypted_avatar IS NULL);

CREATE FUNCTION erase_deleted_user_avatar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='deleted' THEN NEW.encrypted_avatar=NULL; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER users_erase_avatar BEFORE INSERT OR UPDATE ON users
 FOR EACH ROW EXECUTE FUNCTION erase_deleted_user_avatar();

CREATE FUNCTION erase_withdrawn_user_avatar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.consent_type='registration' AND NEW.result='withdrawn' AND NEW.user_id IS NOT NULL THEN
  UPDATE users SET encrypted_avatar=NULL WHERE user_id=NEW.user_id;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER consents_erase_avatar AFTER INSERT OR UPDATE ON consents
 FOR EACH ROW EXECUTE FUNCTION erase_withdrawn_user_avatar();
INSERT INTO app_meta.schema_migrations(version) VALUES('010_user_avatars');
\endif
COMMIT;
