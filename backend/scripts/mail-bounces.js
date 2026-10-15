import { ImapFlow } from 'imapflow';
import { loadLocalEnv, readConfig } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';
import { MailBounceMonitor, bounceImapOptions } from '../src/mail-bounce-monitor.js';

let runtime, client;
try {
  loadLocalEnv();
  if (process.argv.includes('--check')) {
    const config = await readConfig();
    if (!config.bounceEnabled) throw new Error('MAIL_BOUNCE_DISABLED');
    client = new ImapFlow(bounceImapOptions(config));
    client.on('error', () => {});
    await client.connect();
    const lock = await client.getMailboxLock(config.bounceMailbox, { readOnly: true });
    try {
      if (!client.mailbox.readOnly) throw new Error('MAIL_BOUNCE_READ_ONLY_REQUIRED');
      console.log('IMAP 接続とメールボックスの読み取り専用アクセスを確認しました。メールの送信・変更は行っていません。');
    } finally { lock.release(); }
  } else {
    runtime = await createRuntime();
    if (!runtime.config.bounceEnabled) throw new Error('MAIL_BOUNCE_DISABLED');
    const result = await new MailBounceMonitor(runtime).poll();
    console.log(`退信走査が完了しました。確認 ${result.scanned} 件、配信不能の記録 ${result.bounced} 件。メールは送信していません。`);
  }
} catch (error) {
  // IMAP 応答、パスワード、メール本文、宛先は出力しません。
  const code = error.message === 'MAIL_BOUNCE_DISABLED' ? error.message : 'MAIL_BOUNCE_CHECK_FAILED';
  console.error(`${code}: IMAP 設定、ネットワーク、データベース設定を確認してください。`);
  process.exitCode = 1;
} finally {
  if (client) await client.logout().catch(() => client.close());
  if (runtime) await runtime.close();
}
