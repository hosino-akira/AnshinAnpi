/** 利用状態・顔登録とは別に、今回送信できる連絡先を判定します。 */
export function recipientAvailability(recipients: readonly { status: string }[]) {
  const availableCount = recipients.filter((recipient) => recipient.status === "active").length;
  return {
    availableCount,
    unavailableCount: recipients.length - availableCount,
    warning: recipients.length === 0
      ? "メール送信先が登録されていません"
      : availableCount === 0
        ? "有効なメール送信先がありません"
        : "",
  };
}

export function recipientStatusLabel(status: string) {
  return status === "active" ? "" : status === "needs_correction" ? "要修正" : "利用不可";
}
