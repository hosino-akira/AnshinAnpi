import pg from 'pg';

export function createPool(config) {
  const pool = new pg.Pool({ ...config.postgres, ...(config.postgresSsl ? { ssl: { rejectUnauthorized: true } } : {}),
    max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    options: '-c timezone=UTC -c statement_timeout=20000 -c lock_timeout=10000' });
  // ローカル PostgreSQL の再起動で待機中の接続が切れた場合は pg が再接続します。
  // エラーイベントを処理し、API プロセスを継続して稼働させます。
  pool.on('error', () => console.error('DATABASE_CONNECTION_LOST'));
  return pool;
}

export async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
