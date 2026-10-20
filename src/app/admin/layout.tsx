import { AppShell } from "@/components/app-shell";
import { requirePageContext } from "@/lib/server/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { actor } = await requirePageContext("admin");
  return (
    <AppShell actor={actor} nav="admin">
      {children}
    </AppShell>
  );
}
