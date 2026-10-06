let csrfToken = '';
export class AdminApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export async function adminApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', ...(method !== 'GET' ? {
      'X-CSRF-Token': csrfToken, 'Idempotency-Key': crypto.randomUUID(),
    } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const result = await response.json().catch(() => ({ error: { message: '管理 API に接続できません。', code: 'ADMIN_BACKEND_UNAVAILABLE' } })) as T & {
    error?: { message?: string; code?: string }; csrf_token?: string; reauthenticate?: boolean;
  };
  if (!response.ok) {
    if (response.status === 401 && path !== '/login' && csrfToken) {
      csrfToken = ''; window.dispatchEvent(new Event('admin-session-expired'));
    }
    throw new AdminApiError(response.status, result.error?.code ?? 'REQUEST_FAILED', result.error?.message ?? '処理を完了できません。');
  }
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
