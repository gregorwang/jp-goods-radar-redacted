import { AppShell } from "@/components/app-shell";
import { hasAdminSession } from "@/lib/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RadarLayout({ children }: { children: React.ReactNode }) {
  if (!(await hasAdminSession())) redirect("/login");
  const cookieStore = await cookies();
  return <AppShell initialRailCollapsed={cookieStore.get("jpgr-rail")?.value === "compact"}>{children}</AppShell>;
}
