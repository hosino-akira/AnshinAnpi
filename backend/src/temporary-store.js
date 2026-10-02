import { MemoryState } from './memory-state.js';
import { LocalCipher } from './crypto.js';
import { fail } from './errors.js';

export class TemporaryStore {
  constructor(config) { this.state = new MemoryState(); this.locks = new Set(); this.prefix = 'anshin:'; this.idleTtlSeconds = config.idleTtlSeconds; this.cipher = new LocalCipher(config.temporaryKey, 'temporary-v1'); }
  key(kind, id) { return `${this.prefix}${kind}:${id}`; }
  async get(kind, id) {
    const raw = await this.state.get(this.key(kind, id));
    return raw ? this.cipher.open(Buffer.from(raw, 'base64'), kind) : null;
  }
  async put(kind, id, value, expiresAt) {
    const ttl = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
    if (ttl <= 0) fail(410, 'TIME-001', '操作時間が過ぎたため終了しました。');
    const cipher = await this.cipher.seal(value, kind);
    await this.state.set(this.key(kind, id), cipher.toString('base64'), { EX: kind === 'draft' ? Math.min(ttl, this.idleTtlSeconds) : ttl });
  }
  async remove(kind, id) { await this.state.del(this.key(kind, id)); }
  async lock(kind, id, action, transactionContext = null) {
    const key = this.key(`lock-${kind}`, id);
    if (this.locks.has(key)) fail(409, 'OPERATION_IN_PROGRESS', '処理中です。少し待って再試行してください。');
    this.locks.add(key);
    let deferred = false;
    const release = async () => { this.locks.delete(key); };
    try {
      const result = await action();
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
    const count = await this.state.incr(key);
    if (count === 1) await this.state.expire(key, 300);
    if (count >= 3) await this.state.set(this.key('face-cooldown', terminalId), '1', { EX: 300 });
    return count;
  }
  async checkCooldown(terminalId) {
    const ttl = await this.state.ttl(this.key('face-cooldown', terminalId));
    if (ttl > 0) fail(429, 'FACE-004', '安全のため、スタッフへお声がけください。', { retry_after_seconds: ttl });
  }
  close() { this.state.close(); this.locks.clear(); }
  async clearFailures(terminalId) { await this.state.del(this.key('face-failures', terminalId)); }
}
