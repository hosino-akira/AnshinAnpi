import { canonical, sha256, equal } from './crypto.js';
import { fail } from './errors.js';

export async function idempotent(deps, request, reply, action) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Keyが必要です。');
  const operation = `${request.method} ${request.routeOptions.url}`;
  const hash = sha256(canonical({ operation, params: request.params ?? {}, body: request.body ?? {},
    session: request.headers.authorization ? sha256(request.headers.authorization).toString('hex') : null }));
  const db = await deps.pool.connect();
  const ctx = { db, hash, key, commits: [], rollbacks: [] };
  let committed = false;
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${request.terminal.terminal_id}:${key}`]);
    const previous = (await db.query('SELECT * FROM api_idempotency WHERE terminal_id=$1 AND idempotency_key=$2', [request.terminal.terminal_id, key])).rows[0];
    if (previous) {
      if (previous.operation !== operation || !equal(previous.request_sha256, hash)) fail(409, 'IDEMPOTENCY_CONFLICT', '同じ操作IDで異なる内容は送信できません。');
      if (new Date(previous.expires_at) <= new Date()) fail(409, 'IDEMPOTENCY_EXPIRED', '操作IDの有効期限が過ぎました。新しい操作を開始してください。');
      const result = await deps.cipher.open(previous.encrypted_response, 'api-response');
      await db.query('COMMIT'); committed = true;
      reply.header('Idempotency-Replayed', 'true').code(previous.response_status);
      return result;
    }
    const { body, status = 200 } = await action(ctx);
    const encrypted = await deps.cipher.seal(body, 'api-response');
    await db.query(`INSERT INTO api_idempotency(terminal_id,idempotency_key,operation,request_sha256,encrypted_response,response_status,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,current_timestamp+interval '15 minutes')`,
      [request.terminal.terminal_id, key, operation, hash, encrypted, status]);
    await db.query('COMMIT'); committed = true;
    for (const callback of ctx.commits) await callback().catch(() => request.log.error({ requestId: request.id, errorCode: 'POST_COMMIT_CLEANUP_FAILED' }, 'cleanup_failed'));
    reply.code(status);
    return body;
  } catch (error) {
    if (!committed) {
      await db.query('ROLLBACK').catch(() => {});
      for (const callback of ctx.rollbacks.reverse()) await callback().catch(() => request.log.error({ requestId: request.id, errorCode: 'ROLLBACK_CLEANUP_FAILED' }, 'cleanup_failed'));
    }
    throw error;
  } finally { db.release(); }
}
