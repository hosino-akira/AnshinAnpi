/** 管理画面のURL。バックエンドの /api/admin/* とは別に定義します。 */
export const ADMIN_PAGE_PATHS = {
  dashboard: "/admin/dashboard",
  users: "/admin/users",
  recipients: "/admin/recipients",
  mailTemplate: "/admin/mail-template",
  privacy: "/admin/privacy",
  admin: "/admin/profile",
} as const;

export type AdminView = keyof typeof ADMIN_PAGE_PATHS;
export const ADMIN_LOGIN_PATH = "/admin/login";

export function getAdminView(pathname: string): AdminView | undefined {
  const path = pathname.replace(/\/$/, "");
  return (Object.keys(ADMIN_PAGE_PATHS) as AdminView[]).find(
    (view) => ADMIN_PAGE_PATHS[view] === path,
  );
}

export function isAdminSection(section: string): boolean {
  return section === "login" || getAdminView(`/admin/${section}`) !== undefined;
}

/** ログイン後の遷移先は管理画面の既知のURLだけを許可します。 */
export function getLoginReturnPath(search: string): string {
  const requested = new URLSearchParams(search).get("returnTo") ?? "";
  const view = getAdminView(requested);
  return ADMIN_PAGE_PATHS[view ?? "dashboard"];
}

export function getAdminLoginPath(pathname: string): string {
  const view = getAdminView(pathname);
  return view
    ? `${ADMIN_LOGIN_PATH}?returnTo=${encodeURIComponent(ADMIN_PAGE_PATHS[view])}`
    : ADMIN_LOGIN_PATH;
}
