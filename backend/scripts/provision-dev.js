import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.js';
import { transaction } from '../src/db.js';
import { token, sha256 } from '../src/crypto.js';

const runtime = await createRuntime();
try {
  if (runtime.config.production) throw new Error('Development provisioning is disabled in production');
  const path = new URL('../.local-terminal.json', import.meta.url);
  let credentials;
  try { credentials = JSON.parse(await readFile(path, 'utf8')); } catch { credentials = null; }
  const raw = credentials?.terminal_token ?? token();
  const terminalId = credentials?.terminal_id ?? randomUUID();
  await transaction(runtime.pool, async db => {
    await db.query(`INSERT INTO terminals(terminal_id,facility_id,terminal_code,name,status,credential_fingerprint,app_version)
      VALUES($1,$2,'LOCAL-DEV-01','ローカル開発端末','active',$3,'api-dev-v1')
      ON CONFLICT(terminal_code) DO UPDATE SET status='active',credential_fingerprint=EXCLUDED.credential_fingerprint`,
      [terminalId, randomUUID(), sha256(raw).toString('hex')]);
  });
  const actual = (await runtime.pool.query("SELECT terminal_id FROM terminals WHERE terminal_code='LOCAL-DEV-01'")).rows[0];
  await writeFile(path, JSON.stringify({ terminal_id: actual.terminal_id, terminal_token: raw, base_url: `http://localhost:${runtime.config.port}` }, null, 2), { mode: 0o600 });
  console.log(`Development terminal is ready. Credentials are stored locally in ${fileURLToPath(path)} (not printed).`);
} finally { await runtime.close(); }
