import { redirect } from "next/navigation";
import { ADMIN_PAGE_PATHS } from "@/lib/admin-navigation";

export default function AdminEntryPage() {
  redirect(ADMIN_PAGE_PATHS.dashboard);
}
