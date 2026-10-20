import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { ContractorAvatar } from "@/components/contractor-avatar";
import { AttendanceBar, Group, PageHeader, Section, Stat } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { getOverview } from "@/lib/server/services/reports";
import { requirePageContext } from "@/lib/server/session";
import { formatDateHeading, formatMonth, monthRange } from "@/lib/domain/time";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Overview" };

type Search = Promise<{ month?: string }>;

export default async function OverviewPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requirePageContext("admin");
  const sp = await searchParams;
  const monthOf = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? `${sp.month}-01` : null;
  const [data, contractors] = await Promise.all([getOverview(ctx, monthOf), ctx.store.listContractors()]);
  const photoOf = new Map(contractors.map((c) => [c.id, c.photoUrl]));
  const { cards } = data;
  const monthKey = data.month.from.slice(0, 7);
  const prevMonth = monthRange(new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10)).from.slice(0, 7);
  const thisMonth = data.today.slice(0, 7);
  const recordedToday = cards.presentToday + cards.absentToday;
  const totalToday = recordedToday + cards.pendingToday;
  const pct = totalToday > 0 ? Math.round((recordedToday / totalToday) * 100) : 0;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={formatDateHeading(data.today)}
        title="Overview"
        actions={
          <Link href="/admin/attendance?tab=register" className={buttonVariants({ variant: "outline" })}>
            Open register <ArrowRight />
          </Link>
        }
      />

      {/* Today at a glance: one surface, not a wall of tiles */}
      <section aria-label="Today at a glance" className="overflow-hidden rounded-xl bg-card shadow-surface">
        <div className="space-y-2.5 px-4 pt-4 pb-3.5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold">Today&apos;s attendance</h2>
            <span className="tabular text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{recordedToday}</span> of {totalToday} marked · {pct}%
            </span>
          </div>
          <AttendanceBar present={cards.presentToday} absent={cards.absentToday} total={totalToday} className="h-2" />
        </div>
        <div className="grid grid-cols-3 gap-px border-t bg-border lg:grid-cols-6 [&>*]:bg-card">
          <Stat label="Present" value={cards.presentToday} tone="present" data-testid="tile-present" />
          <Stat label="Pending" value={cards.pendingToday} tone="pending" data-testid="tile-pending" hint={cards.outMissingToday > 0 ? `${cards.outMissingToday} without OUT` : undefined} />
          <Stat label="Absent" value={cards.absentToday} tone="absent" data-testid="tile-absent" />
          <Stat label="Projects" value={cards.activeSites} href="/admin/projects" data-testid="tile-sites" />
          <Stat label="Contractors" value={cards.contractors} href="/admin/contractors" data-testid="tile-contractors" />
          <Stat label="Workers" value={cards.activeWorkers} href="/admin/workers" data-testid="tile-workers" />
        </div>
      </section>

      <Section
        id="attention"
        title="Sites with incomplete attendance today"
        description={data.attention.length > 0 ? "Tap a site to open its register." : undefined}
      >
        {data.attention.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl bg-card px-4 py-4 shadow-surface">
            <CheckCircle2 className="size-5 text-present" />
            <p className="text-sm">All sites are complete for today.</p>
          </div>
        ) : (
          <Group as="ul">
            {data.attention.map((a) => {
              const done = a.total - a.pending;
              return (
                <li key={`${a.projectId}:${a.contractorId}`}>
                  <Link
                    href={`/admin/attendance?tab=register&project=${a.projectId}&contractor=${a.contractorId}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60 active:bg-muted"
                  >
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="min-w-0">
                        <div className="truncate text-md font-semibold">{a.projectName}</div>
                        <div className="flex items-baseline justify-between gap-3 text-xs">
                          <span className="truncate text-muted-foreground">{a.contractorName}</span>
                          <span className="tabular shrink-0">
                            {a.pending > 0 && (
                              <span className="font-semibold text-pending">
                                {a.pending} of {a.total} pending
                              </span>
                            )}
                            {a.pending > 0 && a.outMissing > 0 && <span className="text-muted-foreground"> · </span>}
                            {a.outMissing > 0 && <span className="text-muted-foreground">{a.outMissing} OUT missing</span>}
                          </span>
                        </div>
                      </div>
                      <div className="flex h-1 overflow-hidden rounded-full bg-border/70">
                        <div className="h-full bg-present" style={{ width: `${a.total ? (done / a.total) * 100 : 0}%` }} />
                      </div>
                    </div>
                    <ChevronRight className="size-4 shrink-0 text-subtle-foreground" />
                  </Link>
                </li>
              );
            })}
          </Group>
        )}
      </Section>

      <Section
        title={`Contractor-wise · ${formatMonth(data.month.from)}`}
        actions={
          <div className="flex items-center gap-1">
            <Link href={`/admin?month=${prevMonth}`} className={buttonVariants({ variant: "outline", size: "sm" })} aria-label="Previous month">
              <ChevronLeft /> Previous
            </Link>
            {monthKey !== thisMonth && (
              <Link href="/admin" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                This month
              </Link>
            )}
          </div>
        }
      >
        {/* Desktop: a quiet table */}
        <div className="hidden overflow-hidden rounded-xl bg-card shadow-surface md:block">
          <table className="w-full text-sm" data-testid="contractor-summary">
            <thead>
              <tr className="border-b text-left text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                <th className="px-4 py-2.5 font-semibold">Contractor</th>
                <th className="px-4 py-2.5 text-right font-semibold">Sites</th>
                <th className="px-4 py-2.5 text-right font-semibold">Workers</th>
                <th className="px-4 py-2.5 text-right font-semibold">Present today</th>
                <th className="px-4 py-2.5 text-right font-semibold">Worker-days</th>
                <th className="px-4 py-2.5 text-right font-semibold">Est. payable</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.contractorRows.map((c) => (
                <tr key={c.contractorId} className="transition-colors hover:bg-muted/50">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/admin/attendance?tab=report&contractor=${c.contractorId}&from=${data.month.from}&to=${data.month.to}`}
                      className="group flex items-center gap-3"
                    >
                      <ContractorAvatar name={c.name} photoUrl={photoOf.get(c.contractorId) ?? null} size="xs" />
                      <span className="font-medium group-hover:text-primary group-hover:underline">{c.name}</span>
                    </Link>
                  </td>
                  <td className="tabular px-4 py-2.5 text-right">{c.sites}</td>
                  <td className="tabular px-4 py-2.5 text-right">{c.workers}</td>
                  <td className="tabular px-4 py-2.5 text-right">{c.presentToday}</td>
                  <td className="tabular px-4 py-2.5 text-right">{c.monthWorkerDays}</td>
                  <td className={cn("tabular px-4 py-2.5 text-right font-medium", c.payable === "Not configured" && "font-normal text-muted-foreground italic")}>
                    {c.payable}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Phones: one readable card per contractor */}
        <Group as="ul" className="md:hidden">
          {data.contractorRows.map((c) => (
            <li key={c.contractorId}>
              <Link
                href={`/admin/attendance?tab=report&contractor=${c.contractorId}&from=${data.month.from}&to=${data.month.to}`}
                className="flex items-start gap-3 px-4 py-3 active:bg-muted"
              >
                <ContractorAvatar name={c.name} photoUrl={photoOf.get(c.contractorId) ?? null} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-md font-semibold">{c.name}</div>
                  <div className="tabular mt-0.5 text-xs text-muted-foreground">
                    {c.workers} workers · {c.sites} {c.sites === 1 ? "site" : "sites"} · {c.presentToday} present today
                  </div>
                  <div className="tabular mt-2 flex items-baseline justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">{c.monthWorkerDays} worker-days</span>
                    <span className={cn("font-semibold", c.payable === "Not configured" && "font-normal text-muted-foreground italic")}>{c.payable}</span>
                  </div>
                </div>
                <ChevronRight className="mt-2.5 size-4 shrink-0 text-subtle-foreground" />
              </Link>
            </li>
          ))}
        </Group>
        <p className="text-xs text-muted-foreground">
          Payables are estimates from configured contractor rules. Pending entries and entries without an OUT time are not counted.
        </p>
      </Section>
    </div>
  );
}
