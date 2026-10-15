#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# sudo で実行します。アプリと追加の DB 項目を更新し、同意文面を維持します。
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
test -f "$release_dir/database/migrations/011_mail_error_acknowledgement.sql"
compose_dir=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$api_name")
case "$compose_dir" in /home/debian/anshin-anpi/releases/*) ;; *) echo '配置先が想定と異なります。' >&2; exit 1 ;; esac
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
cp -p -- "$compose_dir/compose.production.yaml" "$backup_dir/compose.production.yaml"
printf '%s\n' "バックアップ先：$backup_dir"
rollback() {
  deployment_status=$?
  trap - ERR
  echo '更新に失敗しました。直前のアプリイメージと環境変数を復元します。' >&2
  cp -p -- "$backup_dir/runtime.env" "$runtime_env"
  # 追加した NULL 許容の列と削除トリガーは旧アプリでも使用できます。
  compose up -d --no-deps --pull never --force-recreate --wait --wait-timeout 120 api admin || {
    echo "アプリの復元に失敗しました。DB バックアップ：$backup_dir/database.dump" >&2
    exit 1
  }
  exit "$deployment_status"
}
trap rollback ERR
compose stop api admin
docker exec "$database_name" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_dir/database.dump"
test -s "$backup_dir/database.dump"
database_sql < "$release_dir/database/migrations/010_user_avatars.sql"
database_sql < "$release_dir/database/migrations/011_mail_error_acknowledgement.sql"
if test "$avatar_schema_before" = f; then
  test "$(database_sql -At -c "SELECT count(*) FROM users WHERE encrypted_avatar IS NOT NULL;")" = 0
fi
test "$(policy_digest)" = "$policies_before"
python3 - "$runtime_env" "$release_tag" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
updates = {
    'VPS_IMAGE_TAG': sys.argv[2],
    'MAIL_BOUNCE_ENABLED': 'true',
    'MAIL_BOUNCE_IMAP_PORT': '993',
    'MAIL_BOUNCE_POLL_SECONDS': '60',
    'MAIL_BOUNCE_LOOKBACK_DAYS': '7',
}
lines = p.read_text().splitlines()
for key, value in updates.items():
    matches = [i for i, line in enumerate(lines) if line.startswith(key + '=')]
    if len(matches) > 1:
        raise SystemExit('環境変数の設定が重複しています：' + key)
    if matches:
        lines[matches[0]] = key + '=' + value
    else:
        lines.append(key + '=' + value)
p.write_text('\n'.join(lines) + '\n')
PY
chmod 600 "$runtime_env"
chown --reference="$backup_dir/runtime.env" "$runtime_env"
compose config --quiet
compose up -d --no-deps --pull never --force-recreate --wait --wait-timeout 120 api admin
test "$(docker inspect --format '{{.Image}}' "$api_name")" = "$new_api"
test "$(docker inspect --format '{{.Image}}' "$admin_name")" = "$new_admin"
test "$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$database_name")" = "$database_before"
test "$(policy_digest)" = "$policies_before"
docker exec "$api_name" node scripts/mail-bounces.js --check
database_sql -At -c "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='mail_deliveries' AND column_name='error_acknowledged_at');" | grep -qx t
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
console.log("本番イメージのメール文面、サムネイル、管理者情報・パスワード、稼働状態と認証を確認しました。");
'
curl --fail --silent --show-error --max-time 20 https://anshin.info/health/ready >/dev/null
curl --fail --silent --show-error --location --max-time 20 https://anshin.info/admin/login >/dev/null
trap - ERR
# PostgreSQL の初期化用マウント先にも最新の SQL を保持します。
cp -p -- "$release_dir/database/migrations/011_mail_error_acknowledgement.sql" "$compose_dir/database/migrations/011_mail_error_acknowledgement.sql"
if test -f "$release_dir/README.md"; then
  install -m 644 "$release_dir/README.md" /home/debian/anshin-anpi/README.md
fi
compose ps
printf '%s\n' "DEPLOYMENT_OK: $release_tag" '既存の同意文面は維持しています。' "バックアップ先：$backup_dir"
