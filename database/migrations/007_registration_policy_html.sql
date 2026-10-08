\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(17001001);
SELECT EXISTS(SELECT 1 FROM app_meta.schema_migrations WHERE version='007_registration_policy_html') AS already_applied \gset
\if :already_applied
\echo '007_registration_policy_html already applied; skipping.'
\else
-- Publish a new version without changing policies referenced by existing consents.
INSERT INTO app_meta.admin_settings(setting_key,document)
VALUES ('policy.registration.privacy-v2','{"consent_type":"registration","policy_version":"privacy-v2","title":"安心安否確認サービスの個人情報取扱い","body":"<h2>安心安否確認サービスの個人情報取扱い</h2>\n<p>本サービスでは、ご本人を確認し、登録した連絡先へ安否確認メールを送るため、氏名、顔画像から作成する顔特徴データ、連絡先の氏名・メールアドレス、利用日時、送信結果を取り扱います。</p>\n<h3>利用目的と保存について</h3>\n<p>取得した情報は、安否確認サービスの提供、本人確認、障害対応および不正利用防止のためにのみ使用します。顔画像は原則保存せず、顔特徴データは暗号化して保管します。</p>\n<h3>委託・開示・削除について</h3>\n<p>サービス運営に必要な範囲で、顔認識またはメール配信を行う委託先に情報を取り扱わせる場合があります。開示・訂正・削除・同意撤回は、施設の問い合わせ窓口へお申し出ください。</p>\n<h3>ご同意いただけない場合</h3>\n<p>同意しない場合は登録できません。同意前に撮影・入力した情報は直ちに破棄します。本サービスは緊急通報ではなく、メールの受信・閲覧を保証するものではありません。</p>","status":"published","requires_reconsent":false,"effective_date":"2026-10-08"}'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;
INSERT INTO app_meta.schema_migrations(version) VALUES('007_registration_policy_html');
\endif
COMMIT;
