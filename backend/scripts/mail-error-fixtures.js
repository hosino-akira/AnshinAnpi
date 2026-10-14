import { loadLocalEnv, readConfig } from '../src/config.js';
import { createPool, transaction } from '../src/db.js';
import { LocalCipher } from '../src/crypto.js';

const action = process.argv[2];
if (!['seed', 'clean'].includes(action)) throw new Error('Usage: node scripts/mail-error-fixtures.js seed|clean');
loadLocalEnv();
// This tool never constructs a mail provider and cannot target cloud databases.
const host = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : process.env.POSTGRES_HOST ?? '127.0.0.1';
if (process.env.NODE_ENV === 'production' || process.env.AWS_SECRET_ARN || (process.env.DATA_ENCRYPTION_MODE ?? 'local') !== 'local'
  || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('Fixtures require a local development database and local encryption.');
const config = await readConfig();
const pool = createPool(config);
const cipher = new LocalCipher(config.encryptionKey, config.encryptionKeyId);
const userId = '4da17777-0f17-4b18-9d95-d11a79100000';
const provider = 'local-mail-display-test';
const fixtures = [
  { recipientId: '4da17777-0f17-4b18-9d95-d11a79100001', deliveryId: '4da17777-0f17-4b18-9d95-d11a79100011', code: 'MAIL-001', attempts: 1 },
  { recipientId: '4da17777-0f17-4b18-9d95-d11a79100002', deliveryId: '4da17777-0f17-4b18-9d95-d11a79100012', code: 'MAIL-002', attempts: 3 },
];
const testName = 'メールエラー表示テスト';
try {
  await transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(17001014)');
    const existing = (await db.query('SELECT display_name,status FROM users WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
    if (existing && (existing.status !== 'suspended' || await cipher.open(existing.display_name, 'user-name') !== testName))
      throw new Error('Fixture identity changed; refusing to overwrite or delete it.');
    if (existing) {
      const related = (await db.query(`SELECT
        EXISTS(SELECT 1 FROM safety_checks WHERE user_id=$1) OR EXISTS(SELECT 1 FROM consents WHERE user_id=$1)
        OR EXISTS(SELECT 1 FROM face_templates WHERE user_id=$1)
        OR EXISTS(SELECT 1 FROM recipients WHERE user_id=$1 AND recipient_id<>ALL($2::uuid[]))
        OR EXISTS(SELECT 1 FROM mail_deliveries WHERE user_id=$1 AND (provider<>$3 OR delivery_id<>ALL($4::uuid[]))) AS changed`,
      [userId, fixtures.map(f => f.recipientId), provider, fixtures.map(f => f.deliveryId)])).rows[0];
      if (related.changed) throw new Error('Fixture has additional records; refusing cleanup.');
      await db.query('DELETE FROM mail_deliveries WHERE user_id=$1 AND provider=$2 AND delivery_id=ANY($3::uuid[])', [userId, provider, fixtures.map(f => f.deliveryId)]);
      await db.query('DELETE FROM users WHERE user_id=$1', [userId]);
    }
    if (action === 'clean') return;
    await db.query("INSERT INTO users(user_id,display_name,status) VALUES($1,$2,'suspended')", [userId, await cipher.seal(testName, 'user-name')]);
    for (const [index, fixture] of fixtures.entries()) {
      const address = `${fixture.code.toLowerCase()}@example.invalid`;
      const snapshot = await cipher.seal(address, 'recipient-email');
      await db.query('INSERT INTO recipients(recipient_id,user_id,name,encrypted_email,order_no) VALUES($1,$2,$3,$4,$5)',
        [fixture.recipientId, userId, await cipher.seal(`${fixture.code} テスト送信先`, 'recipient-name'), snapshot, index + 1]);
      await db.query(`INSERT INTO mail_deliveries(delivery_id,user_id,recipient_id,recipient_order_no,encrypted_email_snapshot,provider,status,error_code,attempt_count)
        VALUES($1,$2,$3,$4,$5,$6,'failed',$7,$8)`,
      [fixture.deliveryId, userId, fixture.recipientId, index + 1, snapshot, provider, fixture.code, fixture.attempts]);
    }
  });
  console.log(action === 'seed'
    ? 'Added 2 local display fixtures. Open http://127.0.0.1:5174/admin and click 最新データを再読込. No email was sent.'
    : 'Removed local mail display fixtures. Click 最新データを再読込.');
} finally { await pool.end(); }
