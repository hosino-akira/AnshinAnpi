import { notFound } from "next/navigation";
import { isAdminSection } from "@/lib/admin-navigation";

export default async function AdminSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isAdminSection(section)) notFound();
  // 共通レイアウトが現在のURLに対応する画面を表示し、編集状態を維持します。
  return null;
}
