"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, ClipboardCheck, History, LayoutGrid, MapPin, Settings, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = {
  attendance: { href: "/attendance", label: "Attendance", icon: ClipboardCheck, match: (p: string) => p.startsWith("/attendance") },
  history: { href: "/history", label: "History", icon: History, match: (p: string) => p.startsWith("/history") },
  overview: { href: "/admin", label: "Overview", icon: LayoutGrid, match: (p: string) => p === "/admin" },
  "attendance-admin": { href: "/admin/attendance", label: "Attendance", icon: ClipboardCheck, match: (p: string) => p.startsWith("/admin/attendance") },
  contractors: { href: "/admin/contractors", label: "Contractors", icon: Building2, match: (p: string) => p.startsWith("/admin/contractors") },
  projects: { href: "/admin/projects", label: "Projects", icon: MapPin, match: (p: string) => p.startsWith("/admin/projects") },
  workers: { href: "/admin/workers", label: "Workers", icon: Users, match: (p: string) => p.startsWith("/admin/workers") },
  settings: { href: "/admin/settings", label: "Settings", icon: Settings, match: (p: string) => p.startsWith("/admin/settings") },
} as const;

export type NavKey = keyof typeof NAV;

export function NavLinks({ items, variant }: { items: NavKey[]; variant: "top" | "bottom" }) {
  const pathname = usePathname();
  if (variant === "top") {
    return (
      <ul className="flex items-center gap-0.5">
        {items.map((k) => {
          const n = NAV[k];
          const active = n.match(pathname);
          return (
            <li key={k}>
              <Link
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors",
                  active ? "bg-card text-foreground shadow-surface" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ul className="mx-auto grid h-14 max-w-lg" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((k) => {
        const n = NAV[k];
        const active = n.match(pathname);
        const Icon = n.icon;
        return (
          <li key={k}>
            <Link
              href={n.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group flex h-full flex-col items-center justify-center gap-0.5 text-2xs font-medium transition-colors",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "grid h-7 w-12 place-items-center rounded-full transition-colors duration-200",
                  active ? "bg-primary-soft text-primary" : "group-active:bg-muted",
                )}
              >
                <Icon className="size-5" strokeWidth={active ? 2.25 : 1.75} />
              </span>
              {n.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
