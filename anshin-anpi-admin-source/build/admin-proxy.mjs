// A same-origin proxy preserves HttpOnly cookies and does not expose the DB to browsers.
export async function proxyAdmin(request, backendUrl, fetchImpl = fetch) {
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith('/api/admin/')) return null;
  const backend = new URL(backendUrl);
  if (backend.protocol !== 'https:' && !(backend.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(backend.hostname)))
    throw new Error('ADMIN_BACKEND_REQUIRES_HTTPS');
  const origin = request.headers.get('origin');
  if ((origin && origin !== incoming.origin) || request.headers.get('sec-fetch-site') === 'cross-site')
    return Response.json({error:{code:'ADMIN_ORIGIN_REJECTED',message:'この画面から操作できません。'}},{status:403});
  const path = incoming.pathname.slice('/api/admin'.length);
  if (!/^\/(?:login|logout|session|profile|dashboard|settings|mail-template|audit-logs|policies\/(?:registration|safety)|users(?:\/search|\/[0-9a-f-]{36}(?:\/(?:face|consent)|\/recipients\/[0-9a-f-]{36})?)?)$/.test(path))
    return Response.json({error:{code:'NOT_FOUND'}},{status:404});
  const headers = new Headers({'Content-Type':'application/json'});
  for (const name of ['cookie','x-csrf-token','idempotency-key','origin','sec-fetch-site']) {
    if (request.headers.has(name)) headers.set(name,request.headers.get(name));
  }
  try {
    const body = ['GET','HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    if (body && body.byteLength > 1024 * 1024) return Response.json({error:{code:'PAYLOAD_TOO_LARGE'}},{status:413});
    const upstream = await fetchImpl(new URL(`/v1/admin${path}${incoming.search}`,backend),{
      method:request.method,headers,body,redirect:'error',signal:AbortSignal.timeout(25000),
    });
    const output = new Headers({'Content-Type':'application/json','Cache-Control':'no-store'});
    for (const name of ['set-cookie','idempotency-replayed','x-request-id']) if (upstream.headers.has(name)) output.set(name,upstream.headers.get(name));
    return new Response(upstream.body,{status:upstream.status,headers:output});
  } catch {
    return Response.json({error:{code:'ADMIN_BACKEND_UNAVAILABLE',message:'管理 API に接続できません。'}},{status:503});
  }
}
export function createAdminMiddleware({backendUrl,fetchImpl=fetch}) {
  return async (request,response,next)=> {
    if (!request.url?.startsWith('/api/admin/')) return next();
    const host = request.headers.host ?? '';
    if (!['127.0.0.1','localhost','[::1]'].includes(host.replace(/:\d+$/,''))) {
      response.writeHead(403,{'Content-Type':'application/json'}); response.end('{"error":{"code":"LOCAL_ORIGIN_REQUIRED"}}'); return;
    }
    try {
      const chunks=[]; let size=0;
      for await (const chunk of request) {
        size+=chunk.length;
        if (size>1024*1024) {response.writeHead(413);response.end();return;}
        chunks.push(chunk);
      }
      const webRequest=new Request(`http://${host}${request.url}`,{method:request.method,headers:request.headers,
        ...(['GET','HEAD'].includes(request.method) ? {} : {body:Buffer.concat(chunks)})});
      const result=await proxyAdmin(webRequest,backendUrl,fetchImpl);
      response.writeHead(result.status,Object.fromEntries(result.headers));response.end(await result.text());
    } catch { response.writeHead(503,{'Content-Type':'application/json'});response.end('{"error":{"code":"ADMIN_BACKEND_UNAVAILABLE"}}'); }
  };
}
