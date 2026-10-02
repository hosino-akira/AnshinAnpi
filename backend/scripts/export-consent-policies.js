import { writeFile } from 'node:fs/promises';
import { loadLocalEnv, readConfig } from '../src/config.js';
import { createPool } from '../src/db.js';

// Run against the old schema before 004. Contains policy text, never user data.
loadLocalEnv();
const pool = createPool(await readConfig());
try {
  if ((await pool.query("SELECT to_regclass('public.consent_policies') AS old")).rows[0].old) {
    const rows = (await pool.query(`SELECT consent_type,policy_version,title,body,status,requires_reconsent
      FROM consent_policies ORDER BY consent_type,created_at`)).rows;
    for (const type of ['registration','safety']) {
      if (rows.filter(row => row.consent_type === type && row.status === 'published').length !== 1) {
        throw new Error('Each policy type must have one published document before export');
      }
    }
    await writeFile(new URL('../config/consent-policies.json', import.meta.url), JSON.stringify(rows,null,2)+'\n');
    console.log(`Exported ${rows.length} consent document versions. No user records exported.`);
  } else console.log('Policy configuration already uses the file; no legacy table to export.');
} finally { await pool.end(); }
