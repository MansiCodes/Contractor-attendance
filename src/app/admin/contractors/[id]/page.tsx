import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ChevronLeft, IndianRupee, MapPin, Users } from "lucide-react";
import { EditContractorDialog, IdentityReviewBanner, PhotoUploadButton } from "@/components/admin/contractor-dialogs";
import { NewPaymentRuleDialog } from "@/components/admin/payment-rule-form";
import { AddWorkerDialog, WorkerActions } from "@/components/admin/worker-dialogs";
import { WorkerPayTable } from "@/components/admin/worker-pay-table";
import { ContractorAvatar } from "@/components/contractor-avatar";
import { EmptyState, Group, LinkRow, SegmentedLinks, StatusPill } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { describeRule, ruleForDate, ruleGaps } from "@/lib/domain/calc";
import { latestPayTerms } from "@/lib/domain/master-import";
import { assignmentCovers } from "@/lib/domain/register";
import { formatDateShort } from "@/lib/domain/time";
import { adminDirectory } from "@/lib/server/services/admin";
import { activeWorkerCount, deploymentOptions, workerSummaries } from "@/lib/server/services/directory";
import { importedRulesFor } from "@/lib/server/services/master-import";
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
  const tab = ["workers", "plants", "rules"].includes(sp.tab ?? "") ? sp.tab! : "workers";
  const options = deploymentOptions(dir);
  const projectName = new Map(dir.projects.map((p) => [p.id, p.name]));
  const rules = dir.rules.filter((r) => r.contractorId === id).sort((a, b) => b.version - a.version);
  const current = ruleForDate(rules, id, dir.today);
  const latest = rules[0] ?? null;
  const workerCount = activeWorkerCount(dir, id);
  const contractorSites = dir.cpas.filter((a) => a.contractorId === id);
  const [suggestion, payTerms] = tab === "rules" ? await Promise.all([importedRulesFor(ctx, id), ctx.store.listWorkerPayTerms()]) : [null, []];
  const gaps = current ? ruleGaps(current) : [];
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
            {contractor.identityStatus === "needs_review" && <StatusPill tone="pending">Needs review</StatusPill>}
          </div>
          {contractor.legalName && contractor.legalName !== contractor.name && (
            <p className="mt-0.5 text-sm text-muted-foreground" data-testid="contractor-legal-name">
              Legal name: {contractor.legalName}
            </p>
          )}
          {contractor.location && (
            <p className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground">
              <MapPin className="size-3.5" /> {contractor.location}
            </p>
          )}
          <p className="tabular mt-1 text-sm" data-testid="contractor-active-workers">
            <strong className="font-semibold">{workerCount}</strong> <span className="text-muted-foreground">active {workerCount === 1 ? "worker" : "workers"}</span>
          </p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <EditContractorDialog contractor={contractor} />
          <Link href={`/admin/attendance?tab=report&contractor=${id}`} className={buttonVariants({ className: "flex-1 sm:flex-none" })}>
            View attendance <ArrowRight />
          </Link>
        </div>
      </section>

      {contractor.identityStatus === "needs_review" && <IdentityReviewBanner contractor={contractor} />}

      <SegmentedLinks
        label="Contractor sections"
        items={[
          { href: `/admin/contractors/${id}?tab=workers`, label: "Workers", active: tab === "workers", count: workerCount },
          { href: `/admin/contractors/${id}?tab=plants`, label: "Plants", active: tab === "plants", count: activeSites },
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
                <EmptyState icon={Users} title="No workers yet" description="Add workers and assign them to one of this contractor's plants." />
              ) : (
                <Group as="ul" data-testid="worker-admin-list">
                  {list.map((w) => (
                    <li key={w.id} className="flex items-center gap-3 py-2.5 pr-2 pl-4">
                      <div className="min-w-0 flex-1">
                        <div className={cn("truncate text-md font-medium", !w.isActive && "text-muted-foreground line-through")}>{w.fullName}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {w.employeeCode ?? w.code} · {w.isActive ? (w.currentProjectId ? projectName.get(w.currentProjectId) : "Unassigned") : "Inactive"}
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

      {tab === "plants" && (
        <section className="space-y-3">
          <p className="text-sm text-muted-foreground">Plants where this contractor supplies workers. Manage assignments from each plant.</p>
          {contractorSites.length === 0 ? (
            <EmptyState icon={MapPin} title="Not assigned to a plant yet" description="Assign this contractor from a plant's page." />
          ) : (
            <Group as="ul">
              {contractorSites.map((a) => {
                const active = assignmentCovers(a, dir.today);
                const count = dir.assignments.filter((w) => w.contractorId === id && w.projectId === a.projectId && assignmentCovers(w, dir.today)).length;
                return (
                  <li key={a.id}>
                    <LinkRow
                      href={`/admin/plants/${a.projectId}`}
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
                    <>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        Version {current.version} · from {formatDateShort(current.effectiveFrom)}
                      </div>
                      {gaps.length > 0 && (
                        <div className="mt-2 rounded-lg bg-pending-soft px-3 py-2 text-sm" data-testid="rule-gaps">
                          <span className="font-medium text-pending">Needs configuration:</span> {gaps.join(" · ")}.{" "}
                          <span className="text-muted-foreground">Affected amounts are not shown until these are set.</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="mt-1 text-sm text-muted-foreground">Attendance totals still work. Payable amounts show “Not configured” until a rule is set.</p>
                  )}
                </div>
              </div>
              <NewPaymentRuleDialog
                contractorId={id}
                contractorName={contractor.name}
                latest={latest}
                today={dir.today}
                suggestion={suggestion ? { rules: suggestion.rules, fileName: suggestion.fileName } : null}
              />
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
          <WorkerPayTable
            rows={workerSummaries(dir, { contractorId: id })
              .filter((w) => w.isActive)
              .map((w) => {
                const t = latestPayTerms(payTerms, w.id);
                return {
                  id: w.id,
                  fullName: w.fullName,
                  employeeCode: w.employeeCode,
                  code: w.code,
                  terms: t ? { rateAmount: t.rateAmount, rateBasis: t.rateBasis, commissionEligible: t.commissionEligible, effectiveFrom: t.effectiveFrom, version: t.version } : null,
                };
              })}
            showRates={current?.rateSource === "worker" || payTerms.some((t) => t.rateAmount !== null && dir.workers.some((w) => w.id === t.workerId && w.contractorId === id))}
            selectedCommission={!!current?.commissionEnabled && current.commissionScope === "selected"}
            today={dir.today}
          />
        </section>
      )}
    </div>
  );
}
