// Public administrator messages follow the specification. Keep the original
// delivery error_code in storage for diagnosis and retry decisions.
export function mailErrorDisplay(delivery) {
  const code = delivery.status === 'bounced' || delivery.error_code === 'MAIL-001' ? 'MAIL-001' : 'MAIL-002';
  return {
    code,
    message: code === 'MAIL-001'
      ? '確認メールを送信できませんでした。メールアドレスをご確認ください。'
      : 'ただいまメールを送信できません。時間をおいてお試しください。',
  };
}
