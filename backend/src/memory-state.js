// Single-process transient state. Restarting the API ends unfinished sessions.
// Timers physically release expired entries, including temporary face images.
export class MemoryState {
  constructor() { this.entries = new Map(); }
  async get(key) {
    const entry = this.entries.get(key);
    if (entry?.expiresAt && entry.expiresAt <= Date.now()) { await this.del(key); return null; }
    return entry?.value ?? null;
  }
  async exists(key) { return (await this.get(key)) === null ? 0 : 1; }
  async set(key, value, { EX, NX } = {}) {
    if (NX && await this.exists(key)) return null;
    await this.del(key);
    const entry = { value, expiresAt: EX ? Date.now() + EX * 1000 : null, timer: null };
    if (EX) {
      entry.timer = setTimeout(() => { if (this.entries.get(key) === entry) this.entries.delete(key); }, EX * 1000);
      entry.timer.unref();
    }
    this.entries.set(key, entry);
    return 'OK';
  }
  async del(key) {
    for (const item of Array.isArray(key) ? key : [key]) {
      clearTimeout(this.entries.get(item)?.timer); this.entries.delete(item);
    }
  }
  async incr(key) {
    const value = Number(await this.get(key) ?? 0) + 1;
    const existing = this.entries.get(key);
    if (existing) existing.value = String(value); else await this.set(key, String(value));
    return value;
  }
  async expire(key, seconds) {
    const value = await this.get(key);
    if (value !== null) await this.set(key, value, { EX: seconds });
  }
  async ttl(key) {
    if (await this.get(key) === null) return -2;
    const expiry = this.entries.get(key).expiresAt;
    return expiry ? Math.ceil((expiry - Date.now()) / 1000) : -1;
  }
  close() { for (const entry of this.entries.values()) clearTimeout(entry.timer); this.entries.clear(); }
}
