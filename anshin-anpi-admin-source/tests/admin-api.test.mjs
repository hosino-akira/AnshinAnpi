import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const source=await readFile(new URL('../lib/admin-api.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {adminApi,AdminApiError}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const originalFetch=globalThis.fetch,originalWindow=globalThis.window;
const events=new EventTarget();globalThis.window=events;
after(()=>{globalThis.fetch=originalFetch;if(originalWindow===undefined) delete globalThis.window;else globalThis.window=originalWindow;});

test('missing routes and HTML or null error responses produce a readable error',async()=> {
  for(const body of ['{"message":"Route POST:/v1/admin/login not found","error":"Not Found","statusCode":404}','<h1>Not Found</h1>','null']) {
    globalThis.fetch=async()=>new Response(body,{status:404});
    await assert.rejects(adminApi('/login','POST',{email:'admin@example.com',password:'test'}),error=>error instanceof AdminApiError && error.code==='ADMIN_BACKEND_UNAVAILABLE' && /接続できません/.test(error.message));
  }
});
test('wrong passwords, lockout, offline and timeout errors explain what the user can do',async()=> {
  for(const [status,code,expected] of [[401,'ADMIN_LOGIN_FAILED',/パスワードが正しくありません/],[429,'ADMIN_LOCKED',/5分/],[503,'ADMIN_BACKEND_UNAVAILABLE',/接続できません/],[503,'ADMIN_NOT_INITIALIZED',/接続できません/]]) {
    globalThis.fetch=async()=>Response.json({error:{code}},{status});
    await assert.rejects(adminApi('/login','POST',{}),error=>expected.test(error.message));
  }
  globalThis.fetch=async()=>{throw new TypeError('Failed to fetch');};
  await assert.rejects(adminApi('/login','POST',{}),error=>error.code==='ADMIN_BACKEND_UNAVAILABLE' && /もう一度/.test(error.message));
  globalThis.fetch=async()=>{throw new DOMException('Timeout','TimeoutError');};
  await assert.rejects(adminApi('/login','POST',{}),error=>error.code==='ADMIN_REQUEST_TIMEOUT');
});
test('malformed successful login does not grant a session',async()=> {
  globalThis.fetch=async()=>Response.json({});
  await assert.rejects(adminApi('/login','POST',{}),error=>error.code==='ADMIN_RESPONSE_INVALID');
});
test('login uses password only, forwards CSRF, and session expiry fires once',async()=> {
  let seen,expired=0;events.addEventListener('admin-session-expired',()=>expired++);
  globalThis.fetch=async(url,options)=>{seen={url,options};return Response.json({admin:{name:'Admin',email:'admin@example.com'},csrf_token:'csrf-test'});};
  await adminApi('/login','POST',{email:'admin@example.com',password:'example'});
  assert.equal(seen.url,'/api/admin/login');assert.deepEqual(JSON.parse(seen.options.body),{email:'admin@example.com',password:'example'});
  globalThis.fetch=async(url,options)=>{seen={url,options};return Response.json({error:{code:'ADMIN_SESSION_REQUIRED'}},{status:401});};
  await assert.rejects(adminApi('/profile','PUT',{}));assert.equal(seen.options.headers['X-CSRF-Token'],'csrf-test');assert.equal(expired,1);
  await assert.rejects(adminApi('/session'));assert.equal(expired,1);
});
