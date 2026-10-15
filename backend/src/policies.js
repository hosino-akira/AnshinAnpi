import { readFileSync } from 'node:fs';
import { fail } from './errors.js';

// 同意文面の初期値は配布時の設定として読み込み、利用者データとは分けて管理します。
export function loadPolicies() {
  const rows = JSON.parse(readFileSync(new URL('../config/consent-policies.json', import.meta.url), 'utf8'));
  for (const type of ['registration', 'safety']) {
    const current = rows.filter(row => row.consent_type === type && row.status === 'published');
    if (current.length !== 1 || !current[0].policy_version || !current[0].title || !current[0].body) {
      throw new Error('同意の種類ごとに公開済みの文面が 1 件必要です。');
    }
  }
  return rows;
}

export function currentPolicy(policies, type, version) {
  const row = policies.find(row => row.consent_type === type && row.status === 'published');
  if (!row) fail(503, 'POLICY_NOT_AVAILABLE', '同意文面を準備中です。');
  if (version && row.policy_version !== version) fail(409, 'POLICY_VERSION_CHANGED', '最新の同意文面をご確認ください。');
  return row;
}
