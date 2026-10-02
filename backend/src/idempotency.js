import { canonical, sha256, equal } from './crypto.js';
import { fail } from './errors.js';

export async function idempotent(deps, request, reply, action, recover = null) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Keyが必要です。');
  const operation = `${request.method} ${request.routeOptions.url}`;
  const hash = sha256(canonical({ operation, params: request.params ?? {}, body: request.body ?? {},
    session: request.headers.authorization ? sha256(request.headers.authorization).toString('hex') : null }));
  const db = await deps.pool.connect();
  const ctx = { db, hash, key, commits: [], rollbacks: [] };
  let committed = false; let locked = false;
  const lockKey = `${request.terminal.terminal_id}:${key}`;
  try {
    // Hold the lock until COMMIT and the in-memory response state are both complete.
    await db.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]); locked = true;
    await db.query('BEGIN');
    const previous = await deps.store.get('idempotency', lockKey);
    if (previous) {
      if (previous.operation !== operation || !equal(Buffer.from(previous.request_sha256, 'hex'), hash)) fail(409, 'IDEMPOTENCY_CONFLICT', '同じ操作IDで異なる内容は送信できません。');
      if (new Date(previous.expires_at) <= new Date()) fail(409, 'IDEMPOTENCY_EXPIRED', '操作IDの有効期限が過ぎました。新しい操作を開始してください。');
      const result = previous.body;
      await db.query('COMMIT'); committed = true;
      reply.header('Idempotency-Replayed', 'true').code(previous.response_status);
      return result;
    }
    // Mail operation IDs also have a persistent UNIQUE constraint. Process restart
    // must never turn an already committed send into a second email batch.
    const send = (await db.query('SELECT * FROM safety_checks WHERE terminal_id=$1 AND idempotency_key=$2', [request.terminal.terminal_id,key])).rows[0];
    let result;
    if (send) {
      if (!equal(send.request_sha256,hash)) fail(409,'IDEMPOTENCY_CONFLICT','同じ操作IDで異なる内容は送信できません。');
      reply.header('Idempotency-Replayed','true');
      if (recover) result=await recover(send,ctx);
      else {
        const rows=(await db.query('SELECT delivery_id,recipient_id,status FROM mail_deliveries WHERE check_id=$1 ORDER BY recipient_order_no',[send.check_id])).rows;
        result={status:202,body:{check_id:send.check_id,status:send.status,mail_status:send.status,user_id:send.user_id,recipient_results:rows}};
      }
    } else result=await action(ctx);
    const {body,status=200}=result;
    await db.query('COMMIT'); committed = true;
    for (const callback of ctx.commits) await callback().catch(() => request.log.error({ requestId: request.id, errorCode: 'POST_COMMIT_CLEANUP_FAILED' }, 'cleanup_failed'));
    await deps.store.put('idempotency', lockKey, { operation, request_sha256: hash.toString('hex'),
      body, response_status: status, expires_at: new Date(Date.now()+900000).toISOString() }, new Date(Date.now()+900000).toISOString());
    reply.code(status);
    return body;
  } catch (error) {
    if (!committed) {
      await db.query('ROLLBACK').catch(() => {});
      for (const callback of ctx.rollbacks.reverse()) await callback().catch(() => request.log.error({ requestId: request.id, errorCode: 'ROLLBACK_CLEANUP_FAILED' }, 'cleanup_failed'));
    }
    throw error;
  } finally {
    let destroyed = false;
    if (locked) {
      try { await db.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))',[lockKey]); }
      catch { db.release(true); destroyed=true; }
    }
    if (!destroyed) db.release();
  }
}
