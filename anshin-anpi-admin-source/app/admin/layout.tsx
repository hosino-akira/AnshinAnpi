import type { Metadata, Viewport } from "next";
import AdminConsole from "@/components/admin/admin-console";
import "./admin.css";

// 管理画面は利用者向けキオスク画面とは別のブラウザ用途として設定します。
export const metadata: Metadata = {
  title: "管理コンソール | 安心安否確認システム",
  description: "登録者、メール送信先、個人情報取扱文面を管理する管理者用画面です。",
};

// PCブラウザではアクセシビリティのため拡大操作を許可します。
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  themeColor: "#142c40",
};

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <AdminConsole />
      {children}
    </>
  );
}
