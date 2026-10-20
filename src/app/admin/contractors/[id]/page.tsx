import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ChevronLeft, IndianRupee, MapPin, Users } from "lucide-react";
import { EditContractorDialog, PhotoUploadButton } from "@/components/admin/contractor-dialogs";
import { NewPaymentRuleDialog } from "@/components/admin/payment-rule-form";
import { AddWorkerDialog, WorkerActions } from "@/components/admin/worker-dialogs";
import { ContractorAvatar } from "@/components/contractor-avatar";
import { EmptyState, Group, LinkRow, SegmentedLinks, StatusPill } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { describeRule, ruleForDate } from "@/lib/domain/calc";
import { assignmentCovers } from "@/lib/domain/register";
import { formatDateShort } from "@/lib/domain/time";
import { adminDirectory } from "@/lib/server/services/admin";
import { activeWorkerCount, deploymentOptions, workerSummaries } from "@/lib/server/services/directory";
import { requirePageContext } from "@/lib/server/session";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Contractor" };

type Params = Promise<{ id: string }>;
type Search = Promise<{ tab?: string; show?: string }>;

export default async function ContractorPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const ctx = await requirePageContext("admin");
  const { id } = await params;
  const sp = await searchParams;
  const dir = await adminDirectory(ctx);
  const contractor = dir.contractors.find((c) => c.id === id);
  if (!contractor) notFound();
  const tab = ["workers", "sites", "rules"].includes(sp.tab ?? "") ? sp.tab! : "workers";
  const options = deploymentOptions(dir);
  const projectName = new Map(dir.projects.map((p) => [p.id, p.name]));
  const rules = dir.rules.filter((r) => r.contractorId === id).sort((a, b) => b.version - a.version);
  const current = ruleForDate(rules, id, dir.today);
  const latest = rules[0] ?? null;
  const workerCount = activeWorkerCount(dir, id);
  const contractorSites = dir.cpas.filter((a) => a.contractorId === id);
  const activeSites = contractorSites.filter((a) => assignmentCovers(a, dir.today)).length;

  return (
    <div className="space-y-6">
      <Link
        href="/admin/contractors"
        className="-ml-1.5 inline-flex h-8 items-center gap-0.5 rounded-md pr-2 pl-0.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronLeft className="size-4" /> Contractors
      </Link>

      <section className="flex flex-wrap items-center gap-4 sm:flex-nowrap">
        <div className="relative shrink-0">
          <ContractorAvatar name={contractor.name} photoUrl={contractor.photoUrl} size="lg" />
          <PhotoUploadButton contractorId={id} hasPhoto={!!contractor.photoUrl} />
        </div>
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-title font-semibold">{contractor.name}</h1>
            {!contractor.isActive && <StatusPill tone="neutral">Inactive</StatusPill>}
          </div>
          <p className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground">
            <MapPin className="size-3.5" /> {contractor.location}
          </p>
          <p className="tabular mt-1 text-sm">
            <strong className="font-semibold">{workerCount}</strong> <span className="text-muted-foreground">workers ·</span>{" "}
            <strong className="font-semibold">{activeSites}</strong> <span className="text-muted-foreground">{activeSites === 1 ? "site" : "sites"}</span>
          </p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <EditContractorDialog contractor={contractor} />
          <Link href={`/admin/attendance?tab=report&contractor=${id}`} className={buttonVariants({ className: "flex-1 sm:flex-none" })}>
            View attendance <ArrowRight />
          </Link>
        </div>
      </section>

      <SegmentedLinks
        label="Contractor sections"
        items={[
          { href: `/admin/contractors/${id}?tab=workers`, label: "Workers", active: tab === "workers", count: workerCount },
          { href: `/admin/contractors/${id}?tab=sites`, label: "Sites", active: tab === "sites", count: activeSites },
          { href: `/admin/contractors/${id}?tab=rules`, label: "Payment rules", active: tab === "rules" },
        ]}
      />

      {tab === "workers" &&
        (() => {
          const all = workerSummaries(dir, { contractorId: id });
          const showInactive = sp.show === "all";
          const activeCount = all.filter((w) => w.isActive).length;
          const list = showInactive ? all : all.filter((w) => w.isActive);
          const inactiveCount = all.length - activeCount;
          return (
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {activeCount} active
                  {inactiveCount > 0 && (
                    <>
                      {" · "}
                      <Link className="font-medium text-primary hover:underline" href={`/admin/contractors/${id}?tab=workers${showInactive ? "" : "&show=all"}`}>
                        {showInactive ? "hide" : "show"} {inactiveCount} inactive
                      </Link>
                    </>
                  )}
                </p>
                <AddWorkerDialog options={options} defaultContractorId={id} />
              </div>
              {list.length === 0 ? (
                <EmptyState icon={Users} title="No workers yet" description="Add workers and assign them to one of this contractor's sites." />
              ) : (
                <Group as="ul" data-testid="worker-admin-list">
                  {list.map((w) => (
                    <li key={w.id} className="flex items-center gap-3 py-2.5 pr-2 pl-4">
                      <div className="min-w-0 flex-1">
                        <div className={cn("truncate text-md font-medium", !w.isActive && "text-muted-foreground line-through")}>{w.fullName}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {w.code} · {w.isActive ? (w.currentProjectId ? projectName.get(w.currentProjectId) : "No current site") : "Inactive"}
                          {w.isActive && w.currentSince && ` · since ${formatDateShort(w.currentSince)}`}
                        </div>
                      </div>
                      <WorkerActions worker={w} options={options} />
                    </li>
                  ))}
                </Group>
              )}
            </section>
          );
        })()}

      {tab === "sites" && (
        <section className="space-y-3">
          <p className="text-sm text-muted-foreground">Project sites where this contractor is deployed. Manage assignments from each project.</p>
          {contractorSites.length === 0 ? (
            <EmptyState icon={MapPin} title="Not deployed yet" description="Assign this contractor from a project's page." />
          ) : (
            <Group as="ul">
              {contractorSites.map((a) => {
                const active = assignmentCovers(a, dir.today);
                const count = dir.assignments.filter((w) => w.contractorId === id && w.projectId === a.projectId && assignmentCovers(w, dir.today)).length;
                return (
                  <li key={a.id}>
                    <LinkRow
                      href={`/admin/projects/${a.projectId}`}
                      title={projectName.get(a.projectId)}
                      subtitle={`Since ${formatDateShort(a.startDate)}${a.endDate ? ` · ended ${formatDateShort(a.endDate)}` : ""}`}
                      trailing={
                        active ? (
                          <span className="tabular text-sm text-muted-foreground">{count} workers</span>
                        ) : (
                          <StatusPill tone="neutral">Ended</StatusPill>
                        )
                      }
                    />
                  </li>
                );
              })}
            </Group>
          )}
        </section>
      )}

      {tab === "rules" && (
        <section className="space-y-5">
          <div className="rounded-xl bg-card p-4 shadow-surface">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className={cn("grid size-10 shrink-0 place-items-center rounded-full", current ? "bg-present-soft text-present" : "bg-muted text-muted-foreground")}>
                  <IndianRupee className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-muted-foreground">In force today</div>
                  <div className={cn("mt-0.5 text-md font-semibold", !current && "font-medium text-muted-foreground italic")} data-testid="current-rule">
                    {describeRule(current)}
                  </div>
                  {current ? (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Version {current.version} · from {formatDateShort(current.effectiveFrom)}
                    </div>
                  ) : (
                    <p className="mt-1 text-sm text-muted-foreground">Attendance totals still work. Payable amounts show “Not configured” until a rule is set.</p>
                  )}
                </div>
              </div>
              <NewPaymentRuleDialog contractorId={id} contractorName={contractor.name} latest={latest} today={dir.today} />
            </div>
          </div>
          {rules.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold">Version history</h2>
              <Group as="ol" className="text-sm">
                {rules.map((r) => (
                  <li key={r.id} className="flex gap-3 px-4 py-3">
                    <span className="tabular grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">v{r.version}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap justify-between gap-x-2">
                        <span className="font-medium">{describeRule(r)}</span>
                        <span className="text-xs text-muted-foreground">from {formatDateShort(r.effectiveFrom)}</span>
                      </div>
                      {r.notes && <div className="mt-0.5 text-xs text-muted-foreground">{r.notes}</div>}
                    </div>
                  </li>
                ))}
              </Group>
              <p className="text-xs text-muted-foreground">Rule versions cannot be edited or deleted. Each date uses the version in force on that date.</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
