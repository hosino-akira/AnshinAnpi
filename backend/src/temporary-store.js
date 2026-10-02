import { randomUUID } from 'node:crypto';
import { LocalCipher } from './crypto.js';
import { fail } from './errors.js';

export class TemporaryStore {
  constructor(redis, config) { this.redis = redis; this.prefix = config.redisPrefix; this.idleTtlSeconds = config.idleTtlSeconds; this.cipher = new LocalCipher(config.temporaryKey, 'temporary-v1'); }
  key(kind, id) { return `${this.prefix}${kind}:${id}`; }
  async get(kind, id) {
    const raw = await this.redis.get(this.key(kind, id));
    return raw ? this.cipher.open(Buffer.from(raw, 'base64'), kind) : null;
  }
  async put(kind, id, value, expiresAt) {
    const ttl = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
    if (ttl <= 0) fail(410, 'TIME-001', '操作時間が過ぎたため終了しました。');
    const cipher = await this.cipher.seal(value, kind);
    await this.redis.set(this.key(kind, id), cipher.toString('base64'), { EX: kind === 'draft' ? Math.min(ttl, this.idleTtlSeconds) : ttl });
  }
  async remove(kind, id) { await this.redis.del(this.key(kind, id)); }
  async lock(kind, id, action, transactionContext = null) {
    const owner = randomUUID();
    const key = this.key(`lock-${kind}`, id);
    if (!await this.redis.set(key, owner, { NX: true, EX: 45 })) fail(409, 'OPERATION_IN_PROGRESS', '処理中です。少し待って再試行してください。');
    const renew = setInterval(() => this.redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], 45) else return 0 end',
      { keys: [key], arguments: [owner] }).catch(() => {}), 10000);
    renew.unref();
    let deferred = false;
    const release = async () => {
      clearInterval(renew);
      await this.redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end', { keys: [key], arguments: [owner] }).catch(() => {});
    };
    try {
      const result = await action();
      if (await this.redis.get(key) !== owner) fail(409, 'OPERATION_LOCK_LOST', 'もう一度、操作をご確認ください。');
      if (transactionContext) {
        // Completion must stay locked through SQL COMMIT and image cleanup.
        transactionContext.commits.push(release);
        transactionContext.rollbacks.unshift(release);
        deferred = true;
      }
      return result;
    } finally {
      if (!deferred) await release();
    }
  }
  async failure(terminalId) {
    const key = this.key('face-failures', terminalId);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 300);
    if (count >= 3) await this.redis.set(this.key('face-cooldown', terminalId), '1', { EX: 300 });
    return count;
  }
  async checkCooldown(terminalId) {
    const ttl = await this.redis.ttl(this.key('face-cooldown', terminalId));
    if (ttl > 0) fail(429, 'FACE-004', '安全のため、スタッフへお声がけください。', { retry_after_seconds: ttl });
  }
  async clearFailures(terminalId) { await this.redis.del(this.key('face-failures', terminalId)); }
}
