import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { adminSchemas, registerAdmin } from '../src/admin-service.js';
import { passwordHash, passwordMatches } from '../src/admin-auth.js';
import { TemporaryStore } from '../src/temporary-store.js';
import { installErrorHandler } from '../src/errors.js';
import { openApiDocument } from '../src/openapi.js';
import { proxyAdmin } from '../../anshin-anpi-admin-source/build/admin-proxy.mjs';

test('basic information and password contracts have separate required fields',()=>{
  assert(adminSchemas.profile.safeParse({name:'管理者',email:'admin@example.invalid'}).success);
  assert(!adminSchemas.profile.safeParse({name:'管理者',email:'admin@example.invalid',new_password:'x'}).success);
  assert(!adminSchemas.passwordChange.safeParse({new_password:'x'}).success);
  const paths=openApiDocument().paths;
  assert.deepEqual(paths['/v1/admin/profile'].put.requestBody.content['application/json'].schema.required,['name','email']);
  assert.deepEqual(paths['/v1/admin/password'].put.requestBody.content['application/json'].schema.required,['current_password','new_password']);
});
test('basic-only save preserves password and sessions; password change verifies and expires old sessions',async()=>{
  let row={name:'Original',email:'old@example.invalid',password_hash:await passwordHash('original'),auth_version:1,failed_attempts:0,last_login_at:null,last_login_ip:null};
  const auditActions=[];
  const db={release(){},async query(sql,args){
    if(sql.startsWith('SELECT') && sql.includes('app_meta.administrator')) return {rows:[{...row}]};
    if(sql.startsWith('UPDATE app_meta.administrator SET name=')) {row={...row,name:args[0],email:args[1]};return {rows:[{...row}]};}
    if(sql.startsWith('UPDATE app_meta.administrator SET password_hash=')) {row={...row,password_hash:args[0],auth_version:row.auth_version+1};return {rows:[]};}
    if(sql.includes('SELECT nextval')) return {rows:[{id:auditActions.length+1}]};
    if(sql.includes('INSERT INTO audit_logs')) auditActions.push(args[3]);
    return {rows:[]};
  }};
  const config={production:false,corsOrigins:['http://127.0.0.1:5174'],temporaryKey:Buffer.alloc(32),idleTtlSeconds:300,auditKey:Buffer.alloc(32),auditKeyId:'test'};
  const store=new TemporaryStore(config);
  const app=Fastify(); installErrorHandler(app);
  try {
    await registerAdmin(app,{config,store,pool:{query:db.query,connect:async()=>db}}); await app.ready();
    const token='a'.repeat(43); const otherToken='b'.repeat(43); const csrf='csrf-for-test';
    const {sha256}=await import('../src/crypto.js');
    const expires_at=new Date(Date.now()+3600000).toISOString();
    for(const raw of [token,otherToken]) await store.put('admin-session',sha256(raw).toString('hex'),{auth_version:1,csrf,expires_at},expires_at);
    const headers={cookie:`anshin_admin=${token}`,origin:'http://127.0.0.1:5174','x-csrf-token':csrf,'idempotency-key':randomUUID()};
    const originalHash=row.password_hash;
    let result=await app.inject({method:'PUT',url:'/v1/admin/profile',headers,payload:{name:'Updated',email:'new@example.invalid'}});
    assert.equal(result.statusCode,200); assert.equal(result.json().reauthenticate,false);
    assert.equal(result.json().admin.name,'Updated'); assert.equal(row.password_hash,originalHash); assert.equal(row.auth_version,1);
    assert.equal(result.headers['set-cookie'],undefined);
    const session=await app.inject({method:'GET',url:'/v1/admin/session',headers});
    assert.equal(session.statusCode,200); assert.equal(session.json().admin.email,'new@example.invalid');
    assert.equal(session.json().expires_at,expires_at);
    result=await app.inject({method:'PUT',url:'/v1/admin/password',headers:{...headers,'idempotency-key':randomUUID()},payload:{current_password:'wrong',new_password:'x'}});
    assert.equal(result.statusCode,401); assert.equal(row.password_hash,originalHash);
    assert.equal((await app.inject({method:'GET',url:'/v1/admin/session',headers})).statusCode,200);
    result=await app.inject({method:'PUT',url:'/v1/admin/password',headers:{...headers,'idempotency-key':randomUUID()},payload:{current_password:'original',new_password:'x'}});
    assert.equal(result.statusCode,200); assert.equal(result.json().reauthenticate,true);
    assert.match(result.headers['set-cookie'],/Max-Age=0/);
    assert(await passwordMatches('x',row.password_hash)); assert.equal(row.name,'Updated'); assert.equal(row.email,'new@example.invalid');
    for(const raw of [token,otherToken]) assert.equal((await app.inject({method:'GET',url:'/v1/admin/session',headers:{cookie:`anshin_admin=${raw}`}})).statusCode,401);
    assert(auditActions.includes('admin.profile.updated')); assert(auditActions.includes('admin.password.updated'));
    assert.equal((await app.inject({method:'PUT',url:'/v1/admin/profile',payload:{name:'Denied',email:'denied@example.invalid'}})).statusCode,401);
  } finally {await app.close();store.close();}
});
test('same-origin admin proxy forwards the new password endpoint',async()=>{
  let target;
  const response=await proxyAdmin(new Request('http://127.0.0.1:5174/api/admin/password',{method:'PUT',headers:{origin:'http://127.0.0.1:5174'},body:'{}'}),'http://127.0.0.1:3002',async url=>{target=url.toString();return Response.json({saved:true});});
  assert.equal(response.status,200); assert.equal(target,'http://127.0.0.1:3002/v1/admin/password');
});
