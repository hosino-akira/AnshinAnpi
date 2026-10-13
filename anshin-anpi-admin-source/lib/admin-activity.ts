import type { Dashboard } from "./admin-api";

export function activityText(activity: Dashboard["activities"][number]): string {
  const user = activity.user_name ? `${activity.user_name}さん` : "登録者";
  switch (activity.action) {
    case "admin.user.updated":
      return `${user}の情報を更新しました`;
    case "admin.user.suspended":
      return `${user}を利用停止に変更しました`;
    case "admin.user.resumed":
      return `${user}の利用を再開しました`;
    case "admin.user.deleted":
      return "登録者を削除しました";
    case "admin.recipient.updated":
      return `${user}の送信先を更新しました`;
    case "admin.recipient.deleted":
      return `${user}の送信先を削除しました`;
    case "admin.policy.published": {
      const version = activity.policy_version;
      const label = version ? ` ${/^\d/.test(version) ? `v${version}` : version}` : "";
      return `個人情報取扱文面${label}を公開しました`;
    }
    case "admin.template.updated":
      return "送信メールのタイトルと本文を更新しました";
    case "admin.profile.updated":
      return "管理者情報を更新しました";
    case "admin.face.reset":
      return `${user}を顔の再登録待ちに変更しました`;
    case "admin.face.reenrolled":
      return `${user}の顔を再登録しました`;
    case "admin.face.cleanup.deferred":
      return `${user}の顔情報の削除を再試行待ちにしました`;
    case "admin.consent.renewed":
      return `${user}の個人情報取扱文面への再同意を記録しました`;
    case "admin.users.search":
      return "登録者を氏名で検索しました";
    case "admin.logout":
      return "管理画面からログアウトしました";
    case "admin.request.denied":
      return "管理操作を受け付けられませんでした";
    case "admin.initialized":
      return "管理者アカウントを作成しました";
    case "admin.credentials.reset":
      return "管理者のパスワードをリセットしました";
    default:
      return "管理操作を記録しました";
  }
}

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
});
const timeFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
});
const dateFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export function activityTime(value: string, now: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const elapsed = now - date.getTime();
  if (elapsed < 0) return dateFormat.format(date);
  if (elapsed < 60_000) return "たった今";
  const days = Math.round((
    Date.parse(dayFormat.format(new Date(now))) - Date.parse(dayFormat.format(date))
  ) / 86_400_000);
  if (days === 0) {
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}分前`;
    return `${Math.floor(elapsed / 3_600_000)}時間前`;
  }
  if (days === 1) return `昨日 ${timeFormat.format(date)}`;
  if (days < 7) return `${days}日前`;
  return dateFormat.format(date);
}
