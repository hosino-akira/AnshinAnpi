export function mailMessage(config, { displayName, occurredAt, timezone, type }) {
  const date = new Intl.DateTimeFormat('ja-JP', {
    timeZone: timezone, dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(occurredAt));
  if (type === 'test') return {
    subject: '【安心安否確認】SMTP 接続テスト',
    text: `安心安否確認システムのメール送信テストです。\n送信日時：${date}\nこのメールが届いていれば、SMTP によるメール送信を確認できます。`,
  };
  const registration = type === 'registration';
  return {
    subject: registration ? '【安心安否確認】連絡先登録のお知らせ' : `【安心安否確認】${displayName}さんからのお知らせ`,
    text: registration
      ? `${displayName}さんの連絡先として、${date}に登録されました。\n安心安否確認は、ご本人の操作により安否確認メールを送るサービスです。\n誤登録の場合：${config.contactAddress}\n本サービスは緊急通報ではありません。`
      : `${displayName}さんが ${date} に安否確認操作を行いました。\n本人の操作により送信された自動メールです。\n本サービスは緊急通報ではありません。\nお問い合わせ：${config.contactAddress}`,
  };
}
