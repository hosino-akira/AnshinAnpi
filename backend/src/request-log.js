import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUEST_LOG_PATH = fileURLToPath(new URL('../logs/api-requests.jsonl', import.meta.url));
const secretKey = /token|password|secret|authorization|cookie|credential|signature|api[_-]?key/i;

// Local development exchanges retain business fields, but never photos or credentials.
export function sanitizeExchange(value, key = '') {
  if (secretKey.test(key)) return '[REDACTED]';
  if (key === 'image_base64') {
    if (typeof value !== 'string') return { type: typeof value };
    const hasDataUrlPrefix = /^data:/i.test(value);
    const base64 = hasDataUrlPrefix ? value.slice(value.indexOf(',') + 1) : value;
    const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64);
    return { redacted: true, characters: value.length, has_data_url_prefix: hasDataUrlPrefix,
      valid_base64: validBase64, decoded_bytes: validBase64 ? Buffer.byteLength(base64, 'base64') : null };
  }
  if (Array.isArray(value)) return value.map(item => sanitizeExchange(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizeExchange(item, name)]));
  }
  return value;
}

export function installRequestLog(app, { enabled = false, production = false, path = REQUEST_LOG_PATH,
  maxBytes = 10 * 1024 * 1024 } = {}) {
  if (!enabled || production) return;
  let writes = Promise.resolve();
  const exchanges = new WeakMap();
  app.addHook('onRequest', async request => {
    const url = new URL(request.raw.url, 'http://localhost');
    if (!url.pathname.startsWith('/v1/') || url.pathname === '/v1/mail/webhooks') return;
    exchanges.set(request, { time: new Date().toISOString(), request_id: request.id, method: request.method,
      path: url.pathname, query: sanitizeExchange(Object.fromEntries(url.searchParams)),
      headers: sanitizeExchange(Object.fromEntries(['content-type', 'idempotency-key', 'authorization',
        'x-terminal-id', 'x-terminal-token'].filter(name => request.headers[name] !== undefined)
        .map(name => [name, request.headers[name]]))), started: performance.now() });
  });
  app.addHook('preValidation', async request => {
    const exchange = exchanges.get(request);
    if (exchange) exchange.request_body = request.body && typeof request.body !== 'object'
      ? { omitted: 'non-object request body', type: typeof request.body } : sanitizeExchange(request.body ?? null);
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const exchange = exchanges.get(request);
    if (!exchange) return payload;
    let body = null;
    if (typeof payload === 'string') {
      try { body = JSON.parse(payload); } catch { body = { omitted: 'non-JSON response' }; }
    }
    const { started, ...record } = exchange;
    record.status = reply.statusCode;
    record.duration_ms = Math.round(performance.now() - started);
    record.response_body = sanitizeExchange(body);
    writes = writes.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const size = await stat(path).then(file => file.size, error => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
      if (size >= maxBytes) await rename(path, `${path}.1`);
      await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    }).catch(() => app.log.error({ errorCode: 'REQUEST_LOG_WRITE_FAILED' }, 'request_log_write_failed'));
    await writes;
    app.log.info({ exchange: record }, 'api_exchange');
    return payload;
  });
  app.addHook('onClose', async () => { await writes; });
  app.log.info({ path }, 'api_exchange_log_enabled');
}
