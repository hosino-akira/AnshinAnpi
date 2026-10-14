import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import Fastify from 'fastify';
import { createRuntime } from '../src/runtime.js';
import { UserService } from '../src/user-service.js';
import { AdminService, registerAdmin } from '../src/admin-service.js';
import { publishedPolicy } from '../src/admin-settings.js';
import { installErrorHandler } from '../src/errors.js';

test('registration, authenticated listing, replacement, deletion and withdrawal lifecycle',
  {skip:process.env.ANSHIN_AVATAR_DATABASE_TESTS!=='local'},async()=> {
  const runtime=await createRuntime();
  const client=await runtime.pool.connect();
  const app=Fastify();
  try {
    await client.query('BEGIN');
    // Service transactions become savepoints, so all synthetic fixtures are rolled back.
    let savepoint=0; const stack=[];
    const db={release(){},query:async(sql,params)=> {
      if(sql==='BEGIN') {const name=`avatar_test_${++savepoint}`;stack.push(name);return client.query(`SAVEPOINT ${name}`);}
      if(sql==='COMMIT') return client.query(`RELEASE SAVEPOINT ${stack.pop()}`);
      if(sql==='ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${stack.pop()}`);
      return client.query(sql,params);
    }};
    const pool={query:db.query,connect:async()=>db};
    const terminal=(await client.query("SELECT * FROM terminals WHERE status='active' LIMIT 1")).rows[0];
    assert(terminal,'Local database must contain the configured terminal.');
    const policy=await publishedPolicy(client,runtime.policies,'registration');
    const policyBefore=JSON.stringify((await client.query("SELECT document FROM app_meta.admin_settings WHERE setting_key LIKE 'policy.%' ORDER BY setting_key")).rows);
    let image=await sharp({create:{width:300,height:300,channels:3,background:'#2288cc'}}).jpeg().toBuffer();
    let faceNumber=0;
    const face={name:'test',requireReady(){},search:async()=>({candidates:[]}),delete:async()=>{},
      captureImage:async()=>({image:Buffer.from(image),boundingBox:{Left:.2,Top:.2,Width:.6,Height:.6},metrics:{},livenessPassed:false}),
      index:async()=>({faceId:`test-${++faceNumber}`,modelVersion:'test'})};
    const deps={...runtime,pool,face}; const users=new UserService(deps); const admin=new AdminService(deps);
    const request={id:randomUUID(),terminal,params:{},body:{}};
    const ctx={db,commits:[],rollbacks:[]};
    const capture=await users.captureRegistration(request,{image_base64:image.toString('base64')},ctx);
    const registered=await users.register(request,{temp_id:capture.body.temp_id,display_name:'Avatar test',
      recipients:[{name:'Test contact',email:'avatar-test@example.invalid'}],policy_version:policy.policy_version,consent_result:'granted'},ctx);
    for(const commit of ctx.commits) await commit();
    const id=registered.body.user_id;
    const row=async()=> (await client.query('SELECT *,updated_at::text AS revision FROM users WHERE user_id=$1',[id])).rows[0];
    const first=await row(); assert(first.encrypted_avatar);
    const plaintext=await runtime.cipher.open(first.encrypted_avatar,'user-avatar');
    assert(!first.encrypted_avatar.includes(Buffer.from(plaintext)));
    assert.equal((await sharp(Buffer.from(plaintext,'base64')).metadata()).width,96);
    assert(!(await client.query('SELECT * FROM users WHERE user_id=$1',[id])).fields.some(f=>f.name==='image'));
    const listed=await admin.serialize(db,first); assert(listed.avatar.startsWith('data:image/jpeg;base64,'));
    const legacyId=randomUUID();
    await client.query('INSERT INTO users(user_id,display_name) VALUES($1,$2)',[legacyId,await runtime.cipher.seal('Legacy test','user-name')]);
    assert.equal((await admin.serialize(db,(await client.query('SELECT * FROM users WHERE user_id=$1',[legacyId])).rows[0])).avatar,null);
    await client.query("UPDATE users SET status='suspended' WHERE user_id=$1",[id]);
    assert((await row()).encrypted_avatar,'Ordinary suspension retains the thumbnail.');
    const adminRequest={id:randomUUID(),admin:{email:'avatar-test@example.invalid'},params:{id},body:{}};
    image=await sharp({create:{width:300,height:300,channels:3,background:'#22cc88'}}).jpeg().toBuffer();
    const renewed=await admin.reenroll(adminRequest,{image_base64:image.toString('base64'),expected_revision:(await row()).revision,
      policy_version:policy.policy_version,owner_present:true,consent_granted:true});
    assert.notEqual(renewed.user.avatar,listed.avatar);
    const current=await row(); const currentUser=await admin.serialize(db,current);
    await admin.updateUser(adminRequest,{name:currentUser.name,status:'active',recipients:currentUser.recipients,
      expected_revision:current.revision,identity_confirmed:true,reset_face:true,reason:'correction'});
    assert.equal((await row()).encrypted_avatar,null,'Face reset clears the old avatar.');
    await admin.reenroll(adminRequest,{image_base64:image.toString('base64'),expected_revision:(await row()).revision,
      policy_version:policy.policy_version,owner_present:true,consent_granted:true});
    await client.query("INSERT INTO consents(user_id,consent_type,policy_version,terminal_id,result) VALUES($1,'registration',$2,$3,'withdrawn')",[id,policy.policy_version,terminal.terminal_id]);
    assert.equal((await row()).encrypted_avatar,null,'Withdrawal clears the avatar.');
    await client.query('UPDATE users SET encrypted_avatar=$2 WHERE user_id=$1',[id,first.encrypted_avatar]);
    await admin.deleteUser(adminRequest,{expected_revision:(await row()).revision,reason:'deletion'});
    assert.equal((await row()).encrypted_avatar,null); assert.equal((await row()).status,'deleted');
    installErrorHandler(app); await registerAdmin(app,deps); await app.ready();
    const denied=await app.inject({method:'GET',url:'/v1/admin/users',headers:{origin:'http://127.0.0.1:5174'}});
    assert.equal(denied.statusCode,401); assert(!denied.body.includes('data:image'));
    const policyAfter=JSON.stringify((await client.query("SELECT document FROM app_meta.admin_settings WHERE setting_key LIKE 'policy.%' ORDER BY setting_key")).rows);
    assert.equal(policyAfter,policyBefore,'No consent document was changed.');
  } finally {
    await app.close(); await client.query('ROLLBACK'); client.release(); await runtime.close();
  }
});
