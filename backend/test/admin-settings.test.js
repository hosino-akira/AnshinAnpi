import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPolicies} from '../src/policies.js';
import {initializeAdminSettings} from '../src/admin-settings.js';

test('privacy copy is seeded as a new dated version and does not overwrite saved policies',async()=> {
  const policies=loadPolicies(),privacy=policies.find(x=>x.consent_type==='registration');
  assert.equal(privacy.policy_version,'privacy-v1');
  assert.equal(privacy.title,'安心安否確認システムにおける個人情報の取扱い');
  assert.equal(privacy.requires_reconsent,false);
  assert.match(privacy.body,/6\. お問い合わせ\n個人情報の確認、変更、削除に関するお問い合わせは、施設の個人情報管理責任者までお申し出ください。$/);
  const inserts=[];
  await initializeAdminSettings({policies,pool:{async query(sql,values){assert.match(sql,/ON CONFLICT DO NOTHING/);inserts.push(values);}}});
  const seeded=inserts.find(([key])=>key==='policy.registration.privacy-v1')[1];
  assert.equal(seeded.effective_date,'2026-10-06');assert.equal(seeded.body,privacy.body);
});
