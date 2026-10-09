#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

release_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
release_tag=$(tr -d '\r\n' < "$release_dir/release-tag.txt")
[[ "$release_tag" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]]
runtime_env=/home/debian/.config/anshin-anpi/runtime.env
api_name=anshin-vps-api-1
admin_name=anshin-vps-admin-1
database_name=anshin-vps-postgres-1

test "$(id -un)" = debian
test -f "$runtime_env"
test -f "$release_dir/images.tar"
sudo -v
compose_dir=$(sudo docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$api_name")
case "$compose_dir" in
  /home/debian/anshin-anpi/releases/*) ;;
  *) echo 'Unexpected existing deployment path; stopped.' >&2; exit 1 ;;
esac
test -f "$compose_dir/compose.production.yaml"
compose() {
  sudo docker compose --env-file "$runtime_env" -f "$compose_dir/compose.production.yaml" "$@"
}
database_sql() {
  sudo docker exec -i "$database_name" sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' psql "$@"
}
compose config --quiet
test "$(grep -c '^VPS_IMAGE_TAG=' "$runtime_env")" -eq 1
test "$(sudo docker inspect --format '{{.State.Health.Status}}' "$database_name")" = healthy
database_before=$(sudo docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$database_name")
sudo docker load --input "$release_dir/images.tar"
new_api=$(sudo docker image inspect --format '{{.Id}}' "anshin-anpi-api:$release_tag")
new_admin=$(sudo docker image inspect --format '{{.Id}}' "anshin-anpi-admin:$release_tag")

backup_dir=$(mktemp -d /home/debian/.config/anshin-anpi/consent-deploy-backup.XXXXXXXX)
cp -p -- "$runtime_env" "$backup_dir/runtime.env"
printf '%s\n' "Backup directory: $backup_dir"
rollback() {
  deployment_status=$?
  trap - ERR
  echo 'Deployment failed; restoring previous policy settings and application images.' >&2
  if test -s "$backup_dir/restore-policies.sql"; then
    database_sql < "$backup_dir/restore-policies.sql" || {
      echo "Policy rollback failed. Database backup: $backup_dir/database.dump" >&2
      exit 1
    }
  fi
  cp -p -- "$backup_dir/runtime.env" "$runtime_env"
  compose up -d --no-deps --pull never --force-recreate --wait --wait-timeout 120 api admin || {
    echo "Application rollback needs attention. Backup directory: $backup_dir" >&2
    exit 1
  }
  exit "$deployment_status"
}
trap rollback ERR
compose stop api admin

sudo docker exec "$database_name" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_dir/database.dump"
test -s "$backup_dir/database.dump"
database_sql -At > "$backup_dir/restore-policies.sql" <<'SQL'
SELECT 'BEGIN; SELECT pg_advisory_xact_lock(17001001);';
SELECT 'DELETE FROM app_meta.admin_settings WHERE setting_key LIKE ''policy.registration.%'' OR setting_key LIKE ''policy.safety.%'';';
SELECT format('INSERT INTO app_meta.admin_settings(setting_key,document,updated_at) VALUES(%L,%L::jsonb,%L::timestamptz);',setting_key,document::text,updated_at::text)
FROM app_meta.admin_settings WHERE setting_key LIKE 'policy.registration.%' OR setting_key LIKE 'policy.safety.%';
SELECT 'DELETE FROM app_meta.schema_migrations WHERE version IN (''007_registration_policy_html'',''008_safety_consent_template'',''009_remove_old_consent_policies'');';
SELECT format('INSERT INTO app_meta.schema_migrations(version,applied_at) VALUES(%L,%L::timestamptz);',version,applied_at::text)
FROM app_meta.schema_migrations WHERE version IN ('007_registration_policy_html','008_safety_consent_template','009_remove_old_consent_policies');
SELECT 'COMMIT;';
SQL
for migration in 007_registration_policy_html 008_safety_consent_template 009_remove_old_consent_policies; do
  database_sql < "$release_dir/database/migrations/$migration.sql"
done
policy_count=$(database_sql -At <<'SQL'
SELECT count(*) FROM app_meta.admin_settings WHERE setting_key LIKE 'policy.registration.%' OR setting_key LIKE 'policy.safety.%';
SQL
)
test "$policy_count" = 2

sed -i "s/^VPS_IMAGE_TAG=.*/VPS_IMAGE_TAG=$release_tag/" "$runtime_env"
chmod 600 "$runtime_env"
compose config --quiet
compose up -d --no-deps --pull never --force-recreate --wait --wait-timeout 120 api admin
test "$(sudo docker inspect --format '{{.Image}}' "$api_name")" = "$new_api"
test "$(sudo docker inspect --format '{{.Image}}' "$admin_name")" = "$new_admin"
test "$(sudo docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$database_name")" = "$database_before"
sudo docker exec "$api_name" node --input-type=module -e '
import assert from "node:assert/strict";
import { loadPolicies } from "./src/policies.js";
import { UserService } from "./src/user-service.js";
for (const expected of loadPolicies()) {
  const response = await fetch(`http://127.0.0.1:3001/v1/consent-policies?type=${expected.consent_type}`);
  assert.equal(response.status, 200);
  const actual = await response.json();
  assert.equal(actual.policy_version, expected.policy_version);
  assert.equal(actual.body, expected.body);
}
assert.ok(UserService.prototype.confirmRecipients.toString().includes("consentBody"));
console.log("Current policy responses and backend name substitution code verified.");
'
curl --fail --silent --show-error --max-time 20 https://anshin.info/health/ready >/dev/null
curl --fail --silent --show-error --location --max-time 20 https://anshin.info/admin/login >/dev/null
trap - ERR
compose ps
printf '%s\n' "DEPLOYMENT_OK: $release_tag" 'Current policies only: privacy-v2, safety-v1.' "Backup directory: $backup_dir"
