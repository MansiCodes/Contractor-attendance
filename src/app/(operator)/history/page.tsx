import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, History } from "lucide-react";
import { AttendanceBar, EmptyState, Group, PageHeader } from "@/components/kit";
import { dailySummaries } from "@/lib/server/services/attendance";
import { accessibleProjects } from "@/lib/server/services/context";
import { requirePageContext } from "@/lib/server/session";
import { FALLBACK_TIMEZONE } from "@/lib/domain/policy";
import { formatDateHeading, todayIn } from "@/lib/domain/time";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "History" };

type Search = Promise<{ project?: string }>;

export default async function HistoryPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requirePageContext("operator");
  const sp = await searchParams;
  const projects = await accessibleProjects(ctx);
  const projectId = projects.find((p) => p.id === sp.project)?.id ?? null;
  const days = await dailySummaries(ctx, { days: 31, projectId });
  const byDate = new Map<string, typeof days>();
  for (const d of days) byDate.set(d.date, [...(byDate.get(d.date) ?? []), d]);
  const multiSite = projects.length > 1;
  // "Today" as the selected site (or the first of the operator's sites) sees it.
  const today = todayIn((projects.find((p) => p.id === projectId) ?? projects[0])?.timezone ?? FALLBACK_TIMEZONE, ctx.now);

  return (
    <div className="space-y-6">
      <PageHeader title="History" description="Daily totals for your plants over the last 31 days. Tap a day to see the register." />

      {multiSite && (
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4" role="list" aria-label="Filter by plant">
          {[{ id: null as string | null, label: "All my plants" }, ...projects.map((p) => ({ id: p.id as string | null, label: p.name }))].map((f) => {
            const active = f.id === projectId;
            return (
              <Link
                key={f.id ?? "all"}
                role="listitem"
                href={f.id ? `/history?project=${f.id}` : "/history"}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 shrink-0 items-center rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors",
                  active ? "bg-foreground text-background" : "bg-card text-muted-foreground shadow-surface hover:text-foreground",
                )}
              >
                {f.label}
              </Link>
            );
          })}
        </div>
      )}

      {byDate.size === 0 && <EmptyState icon={History} title="No attendance yet" description="Days you record will appear here." />}

      <div className="space-y-6">
        {[...byDate.entries()].map(([date, items]) => (
          <section key={date} className="space-y-2">
            <h2 className="px-1 text-sm font-semibold text-muted-foreground">{formatDateHeading(date, today)}</h2>
            <Group as="ul">
              {items.map((d) => {
                const done = d.pending === 0 && d.outMissing === 0;
                return (
                  <li key={`${d.projectId}:${d.contractorId}`}>
                    <Link
                      href={`/history/day?project=${d.projectId}&contractor=${d.contractorId}&date=${d.date}`}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60 active:bg-muted"
                    >
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-md font-semibold">{d.contractorName}</div>
                            {multiSite && <div className="truncate text-xs text-muted-foreground">{d.projectName}</div>}
                          </div>
                          <span className="tabular shrink-0 text-xs text-muted-foreground">{d.total} workers</span>
                        </div>
                        <AttendanceBar present={d.present} absent={d.absent} total={d.total} />
                        <div className="tabular flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                          <span className="text-present">{d.present} present</span>
                          <span className="text-absent">{d.absent} absent</span>
                          {d.pending > 0 && <span className="font-semibold text-pending">{d.pending} pending</span>}
                          {d.outMissing > 0 && <span className="text-pending">{d.outMissing} OUT missing</span>}
                          {done && <span className="text-muted-foreground">Complete</span>}
                        </div>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-subtle-foreground" />
                    </Link>
                  </li>
                );
              })}
            </Group>
          </section>
        ))}
      </div>
    </div>
  );
}
