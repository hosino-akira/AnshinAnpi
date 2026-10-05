// このシステムはロボット1台を使用します。端末はサーバー側で固定します。
// 既存の開発端末コードを再利用し、同意・送信履歴の端末IDを維持します。
export const SINGLE_TERMINAL_CODE = 'LOCAL-DEV-01';
export const SINGLE_TERMINAL_ID = '00000000-0000-4000-8000-000000000001';
const SINGLE_FACILITY_ID = '00000000-0000-4000-8000-000000000002';

export async function ensureSingleTerminal(pool) {
  await pool.query(
    `INSERT INTO terminals(terminal_id,facility_id,terminal_code,name,status,app_version)
      VALUES($1,$2,$3,'単一ロボット','active','api-single-robot-v1')
      ON CONFLICT(terminal_code) DO NOTHING`,
    [SINGLE_TERMINAL_ID, SINGLE_FACILITY_ID, SINGLE_TERMINAL_CODE]
  );
  const terminal = (await pool.query(
    'SELECT * FROM terminals WHERE terminal_code=$1', [SINGLE_TERMINAL_CODE]
  )).rows[0];
  if (!terminal) throw new Error('SINGLE_TERMINAL_NOT_CONFIGURED');
  return terminal;
}
