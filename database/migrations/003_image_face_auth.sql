\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(17001001);
SELECT EXISTS (SELECT 1 FROM app_meta.schema_migrations WHERE version='003_image_face_auth') AS already_applied \gset
\if :already_applied
\else
ALTER TABLE face_verifications ADD COLUMN authentication_method varchar(20) NOT NULL DEFAULT 'liveness'
  CHECK (authentication_method IN ('liveness','image'));
DO $$
DECLARE matched_constraint record;
BEGIN
  FOR matched_constraint IN SELECT conname FROM pg_constraint
    WHERE conrelid='face_verifications'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%liveness_passed%'
      AND pg_get_constraintdef(oid) LIKE '%matched%'
  LOOP
    EXECUTE format('ALTER TABLE face_verifications DROP CONSTRAINT %I', matched_constraint.conname);
  END LOOP;
END $$;
ALTER TABLE face_verifications ADD CONSTRAINT face_verifications_match_requirements CHECK (
  result <> 'matched' OR (quality_passed
    AND ((authentication_method='liveness' AND liveness_passed)
      OR (authentication_method='image' AND NOT liveness_passed))
    AND match_score IS NOT NULL AND threshold IS NOT NULL AND match_score >= threshold
    AND required_margin IS NOT NULL
    AND (runner_up_score IS NULL OR match_score-runner_up_score >= required_margin))
);
INSERT INTO app_meta.schema_migrations(version) VALUES ('003_image_face_auth');
\endif
COMMIT;
