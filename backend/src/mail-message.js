export const SAFETY_MAIL_SUBJECT = '【安心安否確認】{{登録者名}}さんからのお知らせ';
export const SAFETY_MAIL_BODY = `{{送信先名}} 様

{{登録者名}}さんが、{{確認日時}}に安心安否確認システムから安否確認を送信しました。本人の操作により送信された自動メールです。

現在、{{施設名}}の端末でご本人の確認が完了しています。

※本メールは送信専用です。
※このサービスは緊急通報ではありません。緊急時は119番・110番をご利用ください。`;

export function mailMessage(config, { displayName, recipientName, facilityName, occurredAt, timezone, type, template }) {
  const date = new Intl.DateTimeFormat('ja-JP', {
    timeZone: timezone, dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(occurredAt));
  if (type === 'test') return {
    subject: '【安心安否確認】SMTP 接続テスト',
    text: `安心安否確認システムのメール送信テストです。\n送信日時：${date}\nこのメールが届いていれば、SMTP によるメール送信を確認できます。`,
  };
  const variables = {
    '送信先名': recipientName ?? 'ご連絡先',
    '登録者名': displayName,
    '確認日時': date,
    '施設名': facilityName ?? config.facilityName ?? 'ご利用施設',
  };
  // Replace only template tokens, once; names containing tokens remain literal data.
  const render = template => template.replace(/\{\{(送信先名|登録者名|確認日時|施設名)\}\}/g,
    (_, name) => variables[name]);
  const registration = type === 'registration';
  if (type === 'contact_change') return {
    subject: '【安心安否確認】連絡先変更のお知らせ',
    text: `${variables['送信先名']} 様\n\n${displayName}さんの連絡先が、${date}に管理者によって変更されました。\nお問い合わせ：${config.contactAddress}\n\n※このサービスは緊急通報ではありません。`,
  };
  return {
    subject: registration ? '【安心安否確認】連絡先登録のお知らせ' : render(template?.subject ?? SAFETY_MAIL_SUBJECT),
    text: registration
      ? `${variables['送信先名']} 様\n\n${displayName}さんの連絡先として、${date}に登録されました。\n安心安否確認は、ご本人の操作により登録された連絡先へ安否確認メールを送るサービスです。\n\nこの登録にお心当たりがない場合は、以下の問い合わせ先までご連絡ください。\nお問い合わせ：${config.contactAddress}\n\n※本メールは送信専用です。\n※このサービスは緊急通報ではありません。緊急時は119番・110番をご利用ください。`
      : render(template?.body ?? SAFETY_MAIL_BODY),
  };
}
