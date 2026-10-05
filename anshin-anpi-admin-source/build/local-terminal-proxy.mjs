// Development-only proxy for the fixed single robot; no device credentials are required.
export function createTerminalMiddleware({ backendUrl, fetchImpl = fetch }) {
  const target = new URL(backendUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      || target.protocol !== 'http:') throw new Error('Local backend URL must use loopback HTTP');
  return async (request, response, next) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/terminal/')) return next();
    const host = request.headers.host || '';
    const hostname = host.replace(/:\d+$/, '');
    const origin = request.headers.origin;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)
        || (origin && origin !== `http://${host}`)) {
      response.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: { code: 'LOCAL_ORIGIN_REQUIRED' } }));
      return;
    }
    const path = url.pathname.slice('/api/terminal'.length);
    const rules = [
      ['POST', /^\/registrations(\/(capture|verify))?$/],
      ['GET', /^\/registrations\/[0-9a-f-]{36}$/],
      ['DELETE', /^\/registrations\/[0-9a-f-]{36}$/],
      ['POST', /^\/users\/[0-9a-f-]{36}\/recipients$/],
      ['POST', /^\/safety-notifications$/],
      ['GET', /^\/mail-results\/[0-9a-f-]{36}$/],
      ['POST', /^\/mail-results\/[0-9a-f-]{36}\/retry$/],
      ['GET', /^\/terminal$/], ['GET', /^\/consent-policies$/],
      ['POST', /^\/enrollments$/], ['PATCH', /^\/enrollments\/[0-9a-f-]{36}\/profile$/],
      ['PUT', /^\/enrollments\/[0-9a-f-]{36}\/recipients$/],
      ['POST', /^\/enrollments\/[0-9a-f-]{36}\/(consent|face|complete)$/],
      ['DELETE', /^\/enrollments\/[0-9a-f-]{36}$/],
      ['POST', /^\/faces\/(liveness-sessions|verify-registration|identify)$/],
      ['DELETE', /^\/sessions\/current$/],
    ];
    if (!rules.some(([method, pattern]) => request.method === method && pattern.test(path))) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
      return;
    }
    try {
      const headers = { 'Content-Type': 'application/json' };
      for (const name of ['authorization', 'idempotency-key']) {
        if (typeof request.headers[name] === 'string') headers[name] = request.headers[name];
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
        chunks.push(chunk);
      }
      const upstream = await fetchImpl(new URL(`/v1${path}${url.search}`, target), {
        method: request.method, headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks),
        redirect: 'error', signal: AbortSignal.timeout(25000),
      });
      response.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(await upstream.text());
    } catch (error) {
      const tooLarge = error.message === 'PAYLOAD_TOO_LARGE';
      response.writeHead(tooLarge ? 413 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: { code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'LOCAL_BACKEND_UNAVAILABLE' } }));
    }
  };
}
