export class FaceApiError extends Error {
  constructor(public code: string, public status: number, public retryAfterSeconds?: number,
    public details?: Record<string, unknown>) { super(code); }
}

// The single robot uses user IDs; no device or user secrets are attached.
export async function faceApi<T>(path: string, method = 'GET', body?: unknown, userId?: string,
  options: { baseUrl?: string; idempotencyKey?: string } = {}): Promise<T> {
  const target = `${(options.baseUrl ?? '/api/terminal').replace(/\/$/, '')}${path}`;
  const url = method === 'GET' && userId ? `${target}${target.includes('?') ? '&' : '?'}user_id=${encodeURIComponent(userId)}` : target;
  const response = await fetch(url, {
    method, cache: 'no-store', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json',
      ...(method !== 'GET' ? { 'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID() } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(userId && !path.match(/\/users\/[^/]+\/recipients$/) ? { ...(body as Record<string, unknown> ?? {}), user_id: userId } : body ?? {}),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const failure = result as { error?: { code?: unknown; details?: { retry_after_seconds?: unknown } } } | null;
    const code = failure?.error?.code;
    const retry = failure?.error?.details?.retry_after_seconds;
    throw new FaceApiError(typeof code === 'string' ? code : 'REQUEST_FAILED', response.status,
      typeof retry === 'number' && Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined,
      failure?.error?.details as Record<string, unknown> | undefined);
  }
  return result as T;
}
