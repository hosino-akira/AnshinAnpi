import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRuntime } from '../src/runtime.js';
import { AdminService } from '../src/admin-service.js';
import { passwordHash, passwordMatches } from '../src/admin-auth.js';

test('PostgreSQL keeps password unchanged on basic save and isolates password changes',
  {skip:process.env.ANSHIN_ACCOUNT_DATABASE_TESTS!=='local'},async()=>{
  const runtime=await createRuntime();const client=await runtime.pool.connect();
  try {
    await client.query('BEGIN');
    let next=0;const stack=[];
    const db={release(){},query:async(sql,args)=>{
      if(sql==='BEGIN'){const name=`account_test_${++next}`;stack.push(name);return client.query(`SAVEPOINT ${name}`);}
      if(sql==='COMMIT')return client.query(`RELEASE SAVEPOINT ${stack.pop()}`);
      if(sql==='ROLLBACK')return client.query(`ROLLBACK TO SAVEPOINT ${stack.pop()}`);
      return client.query(sql,args);
    }};
    const original=(await client.query('SELECT * FROM app_meta.administrator WHERE singleton FOR UPDATE')).rows[0];
    assert(original,'Local administrator must already be configured.');
    const service=new AdminService({...runtime,pool:{connect:async()=>db,query:db.query}});
    const request={id:randomUUID(),ip:'127.0.0.10',admin:{email:original.email},adminSession:{auth_version:original.auth_version,key:'account-test'},body:{}};
    const result=await service.saveProfile(request,{name:'Account test',email:'account-test@example.invalid'});
    assert.equal(result.reauthenticate,false);
    let saved=(await client.query('SELECT * FROM app_meta.administrator WHERE singleton')).rows[0];
    assert(saved.password_hash===original.password_hash);assert.equal(saved.auth_version,original.auth_version);
    assert.equal(saved.name,'Account test');assert.equal(saved.email,'account-test@example.invalid');
    await assert.rejects(service.saveProfile({...request,adminSession:{auth_version:original.auth_version-1}},{name:'Stale',email:'stale@example.invalid'}),{code:'ADMIN_SESSION_REQUIRED'});
    await client.query('UPDATE app_meta.administrator SET password_hash=$1 WHERE singleton',[await passwordHash('temporary-test')]);
    let clearCookie=''; const reply={header:(key,value)=>{if(key==='Set-Cookie')clearCookie=value;}};
    await assert.rejects(service.changePassword(request,{current_password:'incorrect',new_password:'x'},reply),{code:'ADMIN_LOGIN_FAILED'});
    await service.changePassword(request,{current_password:'temporary-test',new_password:'x'},reply);
    saved=(await client.query('SELECT * FROM app_meta.administrator WHERE singleton')).rows[0];
    assert(await passwordMatches('x',saved.password_hash));assert.equal(saved.auth_version,original.auth_version+1);
    assert.equal(saved.name,'Account test');assert.equal(saved.email,'account-test@example.invalid');assert.match(clearCookie,/Max-Age=0/);
  } finally {await client.query('ROLLBACK');client.release();await runtime.close();}
});
