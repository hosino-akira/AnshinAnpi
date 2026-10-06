import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { equal, sha256, token } from './crypto.js';
import { transaction } from './db.js';
import { audit } from './audit.js';
import { fail } from './errors.js';

const derive = promisify(scrypt);
export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function passwordMatches(password, encoded) {
  const [algorithm, salt, expected] = encoded.split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expected)) return false;
  const key = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(key, Buffer.from(expected, 'hex'));
}
export const adminProfile = row => ({ name: row.name, email: row.email,
  last_login_at: row.last_login_at, last_login_ip: row.last_login_ip });
export const COOKIE_NAME = 'anshin_admin';

export class AdminAuth {
  constructor(deps) { Object.assign(this, deps); }
  cookie(value, clear = false) {
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 28800}${this.config.production ? '; Secure' : ''}`;
  }
  origin(request) {
    // Browser requests must match the configured frontend origins. CLI requests have no Origin.
    const origin = request.headers.origin;
    if (origin && !this.config.corsOrigins.includes(origin)) fail(403, 'ADMIN_ORIGIN_REJECTED', 'この画面から操作できません。');
    if (!origin && request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'ADMIN_ORIGIN_REJECTED', 'この画面から操作できません。');
  }
  async rate(request) {
    const key = this.store.key('admin-rate', sha256(request.ip).toString('hex'));
    const count = await this.store.state.incr(key);
    if (count === 1) await this.store.state.expire(key, 300);
    if (count > 20) fail(429, 'ADMIN_RATE_LIMITED', 'しばらく待って再試行してください。');
  }
  async login(request, body, reply) {
    this.origin(request); await this.rate(request);
    const result = await transaction(this.pool, async db => {
      const row = (await db.query('SELECT * FROM app_meta.administrator WHERE singleton FOR UPDATE')).rows[0];
      request.admin = { email: row?.email ?? 'administrator' };
      if (!row) return { error: 'ADMIN_NOT_INITIALIZED', status: 503 };
      if (row.locked_until && Date.parse(row.locked_until) > Date.now()) return { error: 'ADMIN_LOCKED', status: 429 };
      const passwordOk = await passwordMatches(body.password, row.password_hash);
      if (body.email !== row.email || !passwordOk) {
        await db.query(`UPDATE app_meta.administrator SET failed_attempts=failed_attempts+1,
          locked_until=CASE WHEN failed_attempts+1>=5 THEN clock_timestamp()+interval '5 minutes' ELSE NULL END WHERE singleton`);
        await audit(db, this.config, request, 'admin.login', 'administrator', 'singleton', 'failure', 'ADMIN_LOGIN_FAILED');
        return { error: 'ADMIN_LOGIN_FAILED', status: 401 };
      }
      const updated = (await db.query(`UPDATE app_meta.administrator SET failed_attempts=0,locked_until=NULL,
        last_login_at=clock_timestamp(),last_login_ip=$1 WHERE singleton RETURNING *`, [request.ip])).rows[0];
      await audit(db, this.config, request, 'admin.login', 'administrator', 'singleton');
      return updated;
    });
    if (result.error) fail(result.status, result.error, result.status === 503 ? '管理者の初期設定が必要です。' : 'ログインできません。入力内容を確認するか、しばらく待って再試行してください。');
    const raw = token(), sessionKey = sha256(raw).toString('hex');
    const expiry = new Date(Date.now() + 8 * 3600000).toISOString();
    const csrf = token();
    await this.store.put('admin-session', sessionKey, { auth_version: result.auth_version, csrf, expires_at: expiry, last_activity: Date.now() }, expiry);
    reply.header('Set-Cookie', this.cookie(raw));
    return { admin: adminProfile(result), csrf_token: csrf };
  }
  async authenticate(request, mutate = false) {
    this.origin(request);
    const raw = request.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) fail(401, 'ADMIN_SESSION_REQUIRED', '管理者としてログインしてください。');
    const key = sha256(raw).toString('hex');
    const session = await this.store.get('admin-session', key);
    const row = session && (await this.pool.query('SELECT name,email,last_login_at,last_login_ip,auth_version FROM app_meta.administrator WHERE singleton')).rows[0];
    if (!session || !row || row.auth_version !== session.auth_version || Date.now() - session.last_activity > 15 * 60000) {
      await this.store.remove('admin-session', key);
      fail(401, 'ADMIN_SESSION_REQUIRED', 'ログインの有効期限が切れました。');
    }
    if (mutate && (typeof request.headers['x-csrf-token'] !== 'string' || !equal(request.headers['x-csrf-token'], session.csrf)))
      fail(403, 'ADMIN_CSRF_REQUIRED', '画面を再読み込みしてください。');
    session.last_activity = Date.now();
    await this.store.put('admin-session', key, session, session.expires_at);
    request.admin = row; request.adminSession = { ...session, key };
    return row;
  }
  async verifyCurrent(db, request, password) {
    await this.rate(request);
    const row = (await db.query('SELECT * FROM app_meta.administrator WHERE singleton FOR UPDATE')).rows[0];
    if (row.auth_version !== request.adminSession.auth_version) fail(401, 'ADMIN_SESSION_REQUIRED', '再ログインしてください。');
    if (!(await passwordMatches(password, row.password_hash))) fail(401, 'ADMIN_LOGIN_FAILED', '現在のパスワードを確認してください。');
  }
}
