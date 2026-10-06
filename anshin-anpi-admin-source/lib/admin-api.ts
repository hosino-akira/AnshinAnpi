let csrfToken = '';
export class AdminApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const connectionMessage = '管理サービスに接続できません。しばらく待って、もう一度お試しください。';
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function responseError(status: number, payload: unknown): AdminApiError {
  const error = object(object(payload)?.error);
  const code = typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED';
  if (status === 404 && !error) return new AdminApiError(status, 'ADMIN_BACKEND_UNAVAILABLE', connectionMessage);
  if (status === 401 && code === 'ADMIN_LOGIN_FAILED') return new AdminApiError(status, code, 'メールアドレスまたはパスワードが正しくありません。入力内容をご確認ください。');
  if (status === 429) return new AdminApiError(status, code, '操作が多すぎます。5分ほど待ってから、もう一度お試しください。');
  if (['ADMIN_BACKEND_UNAVAILABLE', 'ADMIN_NOT_INITIALIZED'].includes(code)) return new AdminApiError(status, code, connectionMessage);
  return new AdminApiError(status, code, typeof error?.message === 'string' && error.message.trim() ? error.message : status >= 500 ? connectionMessage : '処理を完了できません。もう一度お試しください。');
}
export async function adminApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/admin${path}`, {
    method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', ...(method !== 'GET' ? {
      'X-CSRF-Token': csrfToken, 'Idempotency-Key': crypto.randomUUID(),
    } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  }); } catch (error) {
    const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
    throw new AdminApiError(0, timedOut ? 'ADMIN_REQUEST_TIMEOUT' : 'ADMIN_BACKEND_UNAVAILABLE', timedOut ? '応答に時間がかかっています。しばらく待って、もう一度お試しください。' : connectionMessage);
  }
  const payload: unknown = await response.json().catch(() => null);
  const result = object(payload) as (T & {
    error?: { message?: string; code?: string }; csrf_token?: string; reauthenticate?: boolean;
  }) | undefined;
  if (!response.ok) {
    if (response.status === 401 && path !== '/login' && csrfToken) {
      csrfToken = ''; window.dispatchEvent(new Event('admin-session-expired'));
    }
    throw responseError(response.status, payload);
  }
  if (!result || (path === '/login' || path === '/session') && (!object(object(payload)?.admin) || typeof result.csrf_token !== 'string' || !result.csrf_token))
    throw new AdminApiError(response.status, 'ADMIN_RESPONSE_INVALID', connectionMessage);
  if (result.csrf_token) csrfToken = result.csrf_token;
  if (path === '/logout' || result.reauthenticate) csrfToken = '';
  return result as T;
}
export type AdminSession = { admin: { name: string; email: string; last_login_at: string | null; last_login_ip: string | null }; csrf_token: string };
export type AdminSettings = {
  mail: { subject: string; body: string; revision: string; updated_at: string };
  policies: Policy[]; history: Policy[];
};
export type Policy = { consent_type: 'registration' | 'safety'; policy_version: string; title: string; body: string; effective_date: string; requires_reconsent: boolean };
export type Dashboard = { counts: { users: number; active: number; recipients: number; today: number; accepted: number; errors: number };
  errors: { id: string; userId: string; userName: string; recipientName: string; email: string; occurredAt: string; code: string; status: string }[];
  activities: { action: string; occurred_at: string }[];
};
