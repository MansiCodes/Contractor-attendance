import type { Metadata } from "next";
import Link from "next/link";
import { MapPin, UserRound } from "lucide-react";
import { AddOperatorDialog, AddProjectDialog, OperatorAccessToggle, OperatorActiveToggle } from "@/components/admin/project-dialogs";
import { ContractorAvatar } from "@/components/contractor-avatar";
import { EmptyState, PageHeader, SegmentedLinks, StatusPill } from "@/components/kit";
import { getAppMode } from "@/lib/config";
import { assignmentCovers } from "@/lib/domain/register";
import { adminDirectory } from "@/lib/server/services/admin";
import { dailySummaries } from "@/lib/server/services/attendance";
import { newSiteTimezone } from "@/lib/server/services/settings";
import { requirePageContext } from "@/lib/server/session";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Plants" };

type Search = Promise<{ tab?: string }>;

export default async function ProjectsPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requirePageContext("admin");
  const sp = await searchParams;
  const tab = sp.tab === "operators" ? "operators" : "plants";
  const [dir, today, defaultTimezone] = await Promise.all([adminDirectory(ctx), dailySummaries(ctx, { days: 1 }), newSiteTimezone(ctx)]);
  const contractorById = new Map(dir.contractors.map((c) => [c.id, c]));
  const projects = [...dir.projects].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name));
  const operators = dir.profiles
    .filter((u) => u.role === "operator")
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.fullName.localeCompare(b.fullName));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plants"
        description="Manufacturing plants, the contractors working in them, and who records attendance there."
        actions={tab === "plants" ? <AddProjectDialog defaultTimezone={defaultTimezone} /> : <AddOperatorDialog live={getAppMode() !== "demo"} />}
      />

      <SegmentedLinks
        label="Plant sections"
        items={[
          { href: "/admin/plants?tab=plants", label: "Manufacturing plants", active: tab === "plants", count: projects.length },
          { href: "/admin/plants?tab=operators", label: "Plant attendance operators", active: tab === "operators", count: operators.length },
        ]}
      />

      {tab === "plants" ? (
        projects.length === 0 ? (
          <EmptyState icon={MapPin} title="No plants yet" description="Add a plant, then assign contractors and operators to it." />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => {
              const contractors = dir.cpas
                .filter((a) => a.projectId === p.id && assignmentCovers(a, dir.today))
                .map((a) => contractorById.get(a.contractorId))
                .filter((c) => !!c);
              const workers = dir.assignments.filter((a) => a.projectId === p.id && assignmentCovers(a, dir.today)).length;
              const operatorCount = dir.access.filter((a) => a.projectId === p.id && !a.revokedAt).length;
              const todayRows = today.filter((d) => d.projectId === p.id);
              const total = todayRows.reduce((n, d) => n + d.total, 0);
              const pending = todayRows.reduce((n, d) => n + d.pending, 0);
              const marked = total - pending;
              return (
                <li key={p.id} className="min-w-0">
                  <Link
                    href={`/admin/plants/${p.id}`}
                    className={cn("flex h-full flex-col rounded-xl bg-card p-4 shadow-surface transition-shadow hover:shadow-raised", !p.isActive && "opacity-70")}
                    data-testid="project-card"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-md leading-6 font-semibold">{p.name}</div>
                      {!p.isActive && <StatusPill tone="neutral">Inactive</StatusPill>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground">
                      <MapPin className="size-3.5 shrink-0" /> <span className="truncate">{p.location}</span>
                    </div>

                    <div className="mt-3 flex min-w-0 items-center gap-2">
                      {contractors.length === 0 ? (
                        <span className="text-sm text-muted-foreground">No contractors yet</span>
                      ) : (
                        <>
                          <div className="flex shrink-0 -space-x-1.5">
                            {contractors.slice(0, 3).map((c) => (
                              <ContractorAvatar key={c.id} name={c.name} photoUrl={c.photoUrl} size="xs" className="ring-2 ring-card" />
                            ))}
                          </div>
                          <span className="truncate text-sm">{contractors.map((c) => c.name.replace(/\s*\(Demo\)/, "")).join(", ")}</span>
                        </>
                      )}
                    </div>

                    <div className="mt-auto pt-4">
                      {p.isActive && total > 0 && (
                        <div className="mb-2 flex items-center gap-2.5">
                          <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-border/70">
                            <div className={cn("h-full", pending === 0 ? "bg-present" : "bg-primary")} style={{ width: `${(marked / total) * 100}%` }} />
                          </div>
                          <span className={cn("tabular shrink-0 text-xs font-medium", pending === 0 ? "text-present" : "text-muted-foreground")}>
                            {pending === 0 ? "Done today" : `${marked}/${total} today`}
                          </span>
                        </div>
                      )}
                      <div className="tabular text-xs text-muted-foreground">
                        {workers} workers · {operatorCount} {operatorCount === 1 ? "operator" : "operators"}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )
      ) : operators.length === 0 ? (
        <EmptyState icon={UserRound} title="No operators yet" description="Add the people who record attendance at each plant." />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {operators.map((u) => (
            <li key={u.id} className={cn("overflow-hidden rounded-xl bg-card shadow-surface", !u.isActive && "opacity-75")}>
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-pending-soft text-pending">
                    <UserRound className="size-4.5" />
                  </span>
                  <div className="min-w-0">
                    <div className={cn("truncate font-semibold", !u.isActive && "text-muted-foreground line-through")}>{u.fullName}</div>
                    <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                  </div>
                </div>
                <OperatorActiveToggle profileId={u.id} isActive={u.isActive} />
              </div>
              <div className="px-4 pt-2.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">Can record attendance at</div>
              <div className="grid pb-1.5 sm:grid-cols-2">
                {dir.projects
                  .filter((p) => p.isActive)
                  .map((p) => (
                    <OperatorAccessToggle
                      key={p.id}
                      operatorId={u.id}
                      projectId={p.id}
                      granted={dir.access.some((a) => a.operatorId === u.id && a.projectId === p.id && !a.revokedAt)}
                      label={p.name}
                    />
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
