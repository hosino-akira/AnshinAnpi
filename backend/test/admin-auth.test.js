import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordHash, passwordMatches, AdminAuth } from '../src/admin-auth.js';
import { openApiDocument } from '../src/openapi.js';

test('passwords use independent scrypt salts and cannot be verified with the wrong password',async()=> {
  const a=await passwordHash('sufficient-test-password'),b=await passwordHash('sufficient-test-password');
  assert.notEqual(a,b); assert.equal(await passwordMatches('sufficient-test-password',a),true);
  assert.equal(await passwordMatches('wrong',a),false); assert.equal(await passwordMatches('wrong','malformed'),false);
});
test('production cookie is HttpOnly Secure SameSite=Strict and OpenAPI separates admin authority',()=> {
  const auth=new AdminAuth({config:{production:true}});
  assert.match(auth.cookie('value'),/HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
  assert.match(auth.cookie('',true),/Max-Age=0/);
  const doc=openApiDocument();
  assert.equal(doc.paths['/v1/admin/audit-logs'],undefined);
  assert.equal(doc.paths['/v1/admin/policies/{type}'],undefined);
  assert.ok(doc.paths['/v1/admin/policies/registration'].post);
  for (const [path,methods] of Object.entries(doc.paths)) if (path.startsWith('/v1/admin/') && !path.endsWith('/login'))
    for (const [method,route] of Object.entries(methods)) {
      assert.deepEqual(route.security,[{AdminCookie:[]}]);
      if (method!=='get') assert.ok(route.parameters.some(x=>x.name==='X-CSRF-Token' && x.required));
    }
});
