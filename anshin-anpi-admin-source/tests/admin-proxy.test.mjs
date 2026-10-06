import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyAdmin} from '../build/admin-proxy.mjs';

test('admin proxy preserves cookies, CSRF and idempotency without forwarding arbitrary routes',async()=> {
  let seen;
  const result=await proxyAdmin(new Request('https://frontend.example/api/admin/profile',{
    method:'PUT',headers:{origin:'https://frontend.example',cookie:'anshin_admin=example','x-csrf-token':'csrf','idempotency-key':'once'},body:'{}',
  }),'https://backend.example',async(url,options)=> {
    seen={url:String(url),options};return new Response('{"ok":true}',{headers:{'Set-Cookie':'anshin_admin=; Path=/; HttpOnly; Secure; Max-Age=0'}});
  });
  assert.equal(seen.url,'https://backend.example/v1/admin/profile');assert.equal(seen.options.headers.get('cookie'),'anshin_admin=example');
  assert.equal(seen.options.headers.get('x-csrf-token'),'csrf');assert.equal(seen.options.headers.get('origin'),'https://frontend.example');
  assert.match(result.headers.get('set-cookie'),/HttpOnly; Secure/);
  assert.equal((await proxyAdmin(new Request('https://frontend.example/api/admin/mail/webhooks'),'https://backend.example')).status,404);
});
test('cross-site requests cannot mutate or read administrator data',async()=> {
  let calls=0;const fetchImpl=async()=>{calls++;return new Response('{}');};
  const result=await proxyAdmin(new Request('https://frontend.example/api/admin/users',{headers:{origin:'https://attacker.example'}}),'https://backend.example',fetchImpl);
  assert.equal(result.status,403);assert.equal(calls,0);
  await assert.rejects(proxyAdmin(new Request('https://frontend.example/api/admin/users'),'http://backend.example',fetchImpl),/HTTPS/);
});
