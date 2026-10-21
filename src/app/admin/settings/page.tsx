import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, Info, Lock, MapPin } from "lucide-react";
import { PolicyForm } from "@/components/admin/policy-form";
import { describePolicyValue, describeVersion, FIELD_LABELS } from "@/components/admin/policy-text";
import { EmptyState, Group, PageHeader, Section, StatusPill } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { POLICY_FIELDS } from "@/lib/domain/policy";
import { formatDateLong, formatDateShort, instantToLocal } from "@/lib/domain/time";
import { loadSettings } from "@/lib/server/services/settings";
import { requirePageContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Attendance settings" };

type Search = Promise<{ edit?: string; site?: string }>;

// Admin only: the admin layout redirects everyone else, and loadSettings() and the
// save action re-check the role on the server.
export default async function SettingsPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requirePageContext("admin");
  const sp = await searchParams;
  const view = await loadSettings(ctx);
  const editingCompany = sp.edit === "company";
  const editingSite = sp.site ?? null;
  const projectName = new Map(view.sites.map((s) => [s.project.id, s.project.name]));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Attendance settings"
        description="Company-wide rules, with optional overrides per site. Each change is saved as a new version from a start date."
      />

      <div className="flex items-start gap-2.5 rounded-xl bg-muted px-3.5 py-3 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span>
          A suggested IN time never marks anyone present. Workers stay pending until an operator confirms them, and accepted
          suggestions are flagged in reports. Recorded attendance is never rewritten by a settings change.
        </span>
      </div>

      <Section
        id="company"
        title="Company defaults"
        description={`Apply to every site unless the site overrides them${view.company.current ? ` · version ${view.company.current.version}` : ""}`}
        actions={
          !editingCompany && (
            <Link href="/admin/settings?edit=company#company" className={buttonVariants({ variant: "outline" })} data-testid="edit-company">
              Edit defaults
            </Link>
          )
        }
      >
        {editingCompany ? (
          <PolicyForm
            scope={{ kind: "company" }}
            snapshots={view.company.snapshots}
            versionDates={view.company.versionDates}
            today={view.companyToday}
            closeHref="/admin/settings#company"
          />
        ) : (
          <Group as="ul" className="text-sm md:grid md:grid-cols-2 md:divide-y-0 md:[&>li]:border-b md:[&>li:nth-child(odd)]:border-r">
            {POLICY_FIELDS.map((f) => (
              <li key={f} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                <span className="text-muted-foreground">{FIELD_LABELS[f]}</span>
                <span className="text-right font-medium" data-testid={`company-${f}`}>
                  {describePolicyValue(f, view.company.effective[f])}
                </span>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-3 px-4 py-2.5">
              <span className="text-muted-foreground">Timezone for new sites</span>
              <span className="text-right font-medium">{view.company.defaultTimezone}</span>
            </li>
          </Group>
        )}
        {view.company.upcoming.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Scheduled: {view.company.upcoming.map((v) => `version ${v.version} from ${formatDateShort(v.effectiveFrom)}`).join(", ")}.
          </p>
        )}
      </Section>

      <Section title="Sites" description="Each site uses the company defaults except where it overrides them.">
        {view.sites.length === 0 ? (
          <EmptyState icon={MapPin} title="No project sites yet" />
        ) : (
          <Group as="ul">
            {view.sites.map((s) => {
              const overrides = POLICY_FIELDS.filter((f) => s.effective.source[f] === "site");
              const editing = editingSite === s.project.id;
              return (
                <li key={s.project.id} id={`site-${s.project.id}`} className="space-y-3 px-4 py-3.5" data-testid="settings-site">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{s.project.name}</span>
                        {!s.project.isActive && <StatusPill tone="neutral">Inactive</StatusPill>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                        <span>{s.project.location}</span>
                        <span aria-hidden>·</span>
                        <span className="inline-flex items-center gap-1">
                          {s.timezoneLocked && <Lock className="size-3" aria-label="Timezone locked" />}
                          {s.project.timezone}
                        </span>
                      </div>
                    </div>
                    {!editing && (
                      <Link href={`/admin/settings?site=${s.project.id}#site-${s.project.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                        Edit site rules
                      </Link>
                    )}
                  </div>
                  {editing ? (
                    <PolicyForm
                      scope={{ kind: "site", projectId: s.project.id, projectName: s.project.name }}
                      snapshots={s.snapshots}
                      versionDates={s.versionDates}
                      today={s.today}
                      closeHref={`/admin/settings#site-${s.project.id}`}
                    />
                  ) : (
                    <p className="text-sm" data-testid="site-overrides">
                      {overrides.length === 0 ? (
                        <span className="text-muted-foreground">Uses the company defaults.</span>
                      ) : (
                        overrides.map((f, i) => (
                          <span key={f}>
                            {i > 0 && <span className="text-muted-foreground"> · </span>}
                            <span className="text-muted-foreground">{FIELD_LABELS[f]}:</span> {describePolicyValue(f, s.effective[f])}
                          </span>
                        ))
                      )}
                    </p>
                  )}
                  {s.warnings.map((w) => (
                    <p key={w} className="flex items-start gap-2 rounded-lg bg-pending-soft px-3 py-2 text-xs text-pending" data-testid="site-warning">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {w}
                    </p>
                  ))}
                  {s.upcoming.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Scheduled: {s.upcoming.map((v) => `version ${v.version} from ${formatDateShort(v.effectiveFrom)}`).join(", ")}.
                    </p>
                  )}
                </li>
              );
            })}
          </Group>
        )}
      </Section>

      <Section title="Change history" description="Every version ever saved. Versions are never edited or deleted.">
        <Group as="ul" className="text-sm" data-testid="settings-history">
          {view.history.slice(0, 50).map((v) => {
            const isCompany = v.projectId === null;
            const at = instantToLocal(v.createdAt, view.sites.find((s) => s.project.id === v.projectId)?.project.timezone ?? view.company.defaultTimezone);
            const lines = describeVersion(v, isCompany);
            return (
              <li key={v.id} className="space-y-1 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-semibold">
                    {isCompany ? "Company defaults" : projectName.get(v.projectId!) ?? "Site"} · version {v.version}
                  </span>
                  <span className="tabular text-xs text-muted-foreground">
                    in force from {formatDateLong(v.effectiveFrom)} · saved {formatDateShort(at.date)} {at.time}
                    {v.createdBy ? ` by ${view.authors[v.createdBy] ?? "an admin"}` : " (initial setup)"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{lines.length === 0 ? "Uses the company defaults for everything." : lines.join(" · ")}</p>
                {v.notes && <p className="text-xs">{v.notes}</p>}
              </li>
            );
          })}
        </Group>
      </Section>
    </div>
  );
}
