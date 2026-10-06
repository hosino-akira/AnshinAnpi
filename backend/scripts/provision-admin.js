import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createRuntime } from '../src/runtime.js';
import { transaction } from '../src/db.js';
import { audit } from '../src/audit.js';
import { passwordHash } from '../src/admin-auth.js';
import { displayName, email } from '../src/validation.js';

const {values} = parseArgs({options:{email:{type:'string'},name:{type:'string'},reset:{type:'boolean',default:false}}});
const address=email.parse(values.email ?? 'admin@anshin-anpi.jp');
const name=displayName.parse(values.name ?? '安心施設 管理者');
const runtime=await createRuntime();
const path=new URL('../.admin-setup.json',import.meta.url);
let wrote=false;
try {
  await transaction(runtime.pool,async db=> {
    await db.query('SELECT pg_advisory_xact_lock(17001004)');
    const exists=(await db.query('SELECT 1 FROM app_meta.administrator WHERE singleton')).rowCount;
    if (exists && !values.reset) throw new Error('ADMIN_ALREADY_EXISTS: use --reset only to recover lost credentials');
    const password=randomBytes(24).toString('base64url');
    await db.query(`INSERT INTO app_meta.administrator(name,email,password_hash) VALUES($1,$2,$3)
      ON CONFLICT(singleton) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,password_hash=EXCLUDED.password_hash,
      auth_version=administrator.auth_version+1,
      failed_attempts=0,locked_until=NULL,updated_at=clock_timestamp()`,[name,address,await passwordHash(password)]);
    await audit(db,runtime.config,{id:randomUUID(),admin:{email:address}},values.reset ? 'admin.credentials.reset' : 'admin.initialized','administrator','singleton');
    await writeFile(path,JSON.stringify({email:address,name,password,
      instructions:'Sign in with your email and password. Store the password securely; delete this file after setup.'},null,2),
      {encoding:'utf8',mode:0o600,flag:values.reset ? 'w' : 'wx'});
    wrote=true;
  });
  console.log('Single administrator configured. Read backend/.admin-setup.json locally for your initial password. Credentials were not printed.');
} catch(error) {
  if (wrote) await unlink(path).catch(()=>{});
  console.error(error.code === 'EEXIST' ? 'SETUP_FILE_EXISTS: move the old setup file before initializing' : error.message.startsWith('ADMIN_ALREADY_EXISTS') ? error.message : 'ADMIN_INITIALIZATION_FAILED');
  process.exitCode=1;
} finally { await runtime.close(); }
