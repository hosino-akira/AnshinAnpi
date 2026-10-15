// 管理画面のメッセージは所定の文面を使用します。診断と再試行の判断に使うため、
// DB には元の配信 error_code を保持します。
export function mailErrorDisplay(delivery) {
  const code = delivery.status === 'bounced' || delivery.error_code === 'MAIL-001' ? 'MAIL-001' : 'MAIL-002';
  return {
    code,
    message: code === 'MAIL-001'
      ? '確認メールを送信できませんでした。メールアドレスをご確認ください。'
      : 'ただいまメールを送信できません。時間をおいてお試しください。',
  };
}
