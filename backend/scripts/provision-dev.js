import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.js';
import { transaction } from '../src/db.js';
import { token, sha256 } from '../src/crypto.js';

const runtime = await createRuntime();
try {
  if (runtime.config.production) throw new Error('Development provisioning is disabled in production');
  const path = new URL('../.local-terminal.json', import.meta.url);
  let credentials;
  try { credentials = JSON.parse(await readFile(path, 'utf8')); } catch { credentials = null; }
  const raw = credentials?.terminal_token ?? token();
  const terminalId = credentials?.terminal_id ?? randomUUID();
  await transaction(runtime.pool, async db => {
    const facility = (await db.query(`INSERT INTO facilities(facility_code,name) VALUES('LOCAL-DEV','ローカル開発施設')
      ON CONFLICT(facility_code) DO UPDATE SET status='active' RETURNING facility_id`)).rows[0];
    await db.query(`INSERT INTO terminals(terminal_id,facility_id,terminal_code,name,status,credential_fingerprint,app_version)
      VALUES($1,$2,'LOCAL-DEV-01','ローカル開発端末','active',$3,'api-dev-v1')
      ON CONFLICT(terminal_code) DO UPDATE SET status='active',credential_fingerprint=EXCLUDED.credential_fingerprint`,
      [terminalId, facility.facility_id, sha256(raw).toString('hex')]);
    for (const type of ['registration','safety']) {
      if (!(await db.query("SELECT 1 FROM consent_policies WHERE consent_type=$1 AND status='published'", [type])).rowCount) {
        const body = type === 'registration'
          ? '【開発確認用・正式運用不可】本人確認と安否確認メール送信のため、氏名、顔特徴データ、連絡先メールを取り扱います。顔原画像はアプリに永続保存しません。AWS Rekognitionを使う場合、顔特徴はAWSのCollectionに保存されます。同意しない場合、一時データを破棄します。保存期間や運営者等は正式運用前に確定します。本サービスは緊急通報ではありません。'
          : '【開発確認用・正式運用不可】表示された送信先へ、ご本人が安否確認操作を行ったことをメールで通知することに同意します。送信受付は受信・閲覧を保証しません。本サービスは緊急通報ではありません。';
        await db.query(`INSERT INTO consent_policies(policy_version,consent_type,title,body,content_sha256,status,published_at)
          VALUES('dev-v1',$1,$2,$3,$4,'published',clock_timestamp())`, [type, '開発確認用同意文面', body, sha256(body)]);
      }
    }
  });
  const actual = (await runtime.pool.query("SELECT terminal_id FROM terminals WHERE terminal_code='LOCAL-DEV-01'")).rows[0];
  await writeFile(path, JSON.stringify({ terminal_id: actual.terminal_id, terminal_token: raw, base_url: `http://localhost:${runtime.config.port}` }, null, 2), { mode: 0o600 });
  console.log(`Development terminal is ready. Credentials are stored locally in ${fileURLToPath(path)} (not printed).`);
} finally { await runtime.close(); }
