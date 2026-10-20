import { AppShell } from "@/components/app-shell";
import { requirePageContext } from "@/lib/server/session";

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const { actor } = await requirePageContext("operator");
  return (
    <AppShell actor={actor} nav="operator">
      {children}
    </AppShell>
  );
}
