#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Run with sudo. Update code and the additive avatar schema; preserve policies.
test "$(id -u)" -eq 0
release_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
release_tag=$(tr -d '\r\n' < "$release_dir/release-tag.txt")
[[ "$release_tag" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]]
runtime_env=/home/debian/.config/anshin-anpi/runtime.env
api_name=anshin-vps-api-1
admin_name=anshin-vps-admin-1
database_name=anshin-vps-postgres-1
test -f "$runtime_env"
test -f "$release_dir/images.tar"
test -f "$release_dir/database/migrations/010_user_avatars.sql"
compose_dir=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$api_name")
case "$compose_dir" in /home/debian/anshin-anpi/releases/*) ;; *) echo 'Unexpected deployment path.' >&2; exit 1 ;; esac
compose() { docker compose --env-file "$runtime_env" -f "$compose_dir/compose.production.yaml" "$@"; }
database_sql() {
  docker exec -i "$database_name" sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' psql "$@"
}
policy_digest() {
  database_sql -At -c "SELECT md5(COALESCE(string_agg(setting_key || ':' || document::text || ':' || updated_at::text, E'\n' ORDER BY setting_key), '')) FROM app_meta.admin_settings WHERE setting_key LIKE 'policy.%';"
}
compose config --quiet
test "$(grep -c '^VPS_IMAGE_TAG=' "$runtime_env")" -eq 1
test "$(docker inspect --format '{{.State.Health.Status}}' "$database_name")" = healthy
test "$(database_sql -At -c "SELECT EXISTS(SELECT 1 FROM app_meta.schema_migrations WHERE version='006_password_only_admin');")" = t
database_before=$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$database_name")
policies_before=$(policy_digest)
avatar_schema_before=$(database_sql -At -c "SELECT EXISTS(SELECT 1 FROM app_meta.schema_migrations WHERE version='010_user_avatars');")
docker load --input "$release_dir/images.tar"
new_api=$(docker image inspect --format '{{.Id}}' "anshin-anpi-api:$release_tag")
new_admin=$(docker image inspect --format '{{.Id}}' "anshin-anpi-admin:$release_tag")
backup_dir=$(mktemp -d /home/debian/.config/anshin-anpi/app-deploy-backup.XXXXXXXX)
cp -p -- "$runtime_env" "$backup_dir/runtime.env"
printf '%s\n' "Backup directory: $backup_dir"
rollback() {
  deployment_status=$?
  trap - ERR
  echo 'Deployment failed; restoring previous application images and environment.' >&2
  cp -p -- "$backup_dir/runtime.env" "$runtime_env"
  # The additive nullable column and deletion triggers are compatible with old code.
  compose up -d --no-deps --pull never --force-recreate --wait --wait-timeout 120 api admin || {
    echo "Application rollback needs attention. Database backup: $backup_dir/database.dump" >&2
    exit 1
  }
  exit "$deployment_status"
}
trap rollback ERR
compose stop api admin
docker exec "$database_name" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_dir/database.dump"
test -s "$backup_dir/database.dump"
database_sql < "$release_dir/database/migrations/010_user_avatars.sql"
if test "$avatar_schema_before" = f; then
  test "$(database_sql -At -c "SELECT count(*) FROM users WHERE encrypted_avatar IS NOT NULL;")" = 0
fi
test "$(policy_digest)" = "$policies_before"
sed -i "s/^VPS_IMAGE_TAG=.*/VPS_IMAGE_TAG=$release_tag/" "$runtime_env"
chmod 600 "$runtime_env"
chown --reference="$backup_dir/runtime.env" "$runtime_env"
compose config --quiet
compose up -d --no-deps --pull never --force-recreate --wait --wait-timeout 120 api admin
test "$(docker inspect --format '{{.Image}}' "$api_name")" = "$new_api"
test "$(docker inspect --format '{{.Image}}' "$admin_name")" = "$new_admin"
test "$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$database_name")" = "$database_before"
test "$(policy_digest)" = "$policies_before"
docker exec "$api_name" node --input-type=module -e '
import assert from "node:assert/strict";
import sharp from "sharp";
import { createAvatar } from "./src/avatar.js";
import { adminSchemas } from "./src/admin-service.js";
import { mailErrorDisplay } from "./src/mail-error-display.js";
const source = await sharp({create:{width:160,height:120,channels:3,background:"#5588aa"}}).jpeg().toBuffer();
const thumbnail = Buffer.from(await createAvatar(source), "base64");
const metadata = await sharp(thumbnail).metadata();
assert.equal(metadata.width,96); assert.equal(metadata.height,96); assert.equal(metadata.format,"jpeg");
assert(adminSchemas.login.safeParse({email:"test@example.invalid",password:"a"}).success);
assert(adminSchemas.profile.safeParse({name:"test",email:"test@example.invalid"}).success);
assert(adminSchemas.passwordChange.safeParse({current_password:"a",new_password:"b"}).success);
assert.deepEqual(mailErrorDisplay({status:"failed",error_code:"MAIL-001"}),{code:"MAIL-001",message:"確認メールを送信できませんでした。メールアドレスをご確認ください。"});
assert.deepEqual(mailErrorDisplay({status:"unknown",error_code:"MAIL_RESULT_UNKNOWN"}),{code:"MAIL-002",message:"ただいまメールを送信できません。時間をおいてお試しください。"});
const response = await fetch("http://127.0.0.1:3001/health/ready");
assert.equal(response.status,200);
const denied = await fetch("http://127.0.0.1:3001/v1/admin/users");
assert.equal(denied.status,401);
const passwordDenied = await fetch("http://127.0.0.1:3001/v1/admin/password",{method:"PUT",headers:{"Content-Type":"application/json"},body:"{}"});
assert.equal(passwordDenied.status,401);
console.log("Production image: specification mail messages, thumbnail encoding, account/password contracts, health and authentication verified.");
'
curl --fail --silent --show-error --max-time 20 https://anshin.info/health/ready >/dev/null
curl --fail --silent --show-error --location --max-time 20 https://anshin.info/admin/login >/dev/null
trap - ERR
compose ps
printf '%s\n' "DEPLOYMENT_OK: $release_tag" 'Existing consent documents unchanged.' "Backup directory: $backup_dir"
