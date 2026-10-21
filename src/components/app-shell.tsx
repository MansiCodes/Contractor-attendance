import Link from "next/link";
import type { Actor } from "@/lib/domain/types";
import { getAppMode } from "@/lib/config";
import { BrandMark, BrandWordmark } from "./brand";
import { NavLinks, type NavKey } from "./nav-links";
import { UserMenu } from "./user-menu";

export function DemoBadge({ className = "" }: { className?: string }) {
  return (
    <span
      data-testid="demo-banner"
      title="Fictional sample data. Not connected to a database."
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-pending-soft px-2.5 text-xs font-semibold whitespace-nowrap text-pending ${className}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-pending-dot" />
      Demo<span className="hidden xl:inline"> data</span>
    </span>
  );
}

export function AppShell({ actor, nav, children }: { actor: Actor; nav: "operator" | "admin"; children: React.ReactNode }) {
  const demo = getAppMode() === "demo";
  const items: NavKey[] =
    nav === "admin" ? ["overview", "attendance-admin", "contractors", "projects", "workers", "settings"] : ["attendance", "history"];
  return (
    <div className="min-h-dvh [--bottom-nav-h:calc(3.5rem+env(safe-area-inset-bottom))] [--header-h:0px] md:[--bottom-nav-h:0px] md:[--header-h:3.5rem]">
      <header className="z-30 border-b border-border/80 bg-background/85 backdrop-blur-md md:sticky md:top-0">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 md:px-6">
          <Link href="/" className="flex items-center gap-2.5 rounded-lg" aria-label="NF Attendance home">
            <BrandMark />
            <BrandWordmark className="max-[339px]:hidden md:max-lg:hidden" />
          </Link>
          {demo && <DemoBadge />}
          <nav className="hidden md:ml-1 md:block lg:ml-4" aria-label="Main">
            <NavLinks items={items} variant="top" />
          </nav>
          <div className="ml-auto">
            <UserMenu name={actor.fullName} role={actor.role} demo={demo} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pt-5 pb-[calc(var(--bottom-nav-h)+2.5rem)] md:px-6 md:pt-8">{children}</main>
      <nav
        aria-label="Main"
        className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border/80 bg-card/90 backdrop-blur-md md:hidden"
      >
        <NavLinks items={items} variant="bottom" />
      </nav>
    </div>
  );
}
