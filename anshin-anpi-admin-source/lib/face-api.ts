export class FaceApiError extends Error {
  constructor(public code: string, public status: number, public retryAfterSeconds?: number,
    public details?: Record<string, unknown>) { super(code); }
}

// The development proxy attaches terminal authentication on the server.
export async function faceApi<T>(path: string, method = 'GET', body?: unknown, userToken?: string,
  options: { baseUrl?: string; idempotencyKey?: string } = {}): Promise<T> {
  const response = await fetch(`${(options.baseUrl ?? '/api/terminal').replace(/\/$/, '')}${path}`, {
    method, cache: 'no-store', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json',
      ...(method !== 'GET' ? { 'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID() } : {}),
      ...(userToken ? { Authorization: `Bearer ${userToken}` } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
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
