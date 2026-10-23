import type { Metadata } from "next";
import { MasterImport } from "@/components/admin/master-import";
import { PageHeader, Section } from "@/components/kit";
import { requirePageContext } from "@/lib/server/session";
import { assertAdmin, headOfficeTimezone } from "@/lib/server/services/context";

export const metadata: Metadata = { title: "Import workers" };

export default async function ImportWorkersPage() {
  const ctx = await requirePageContext("admin");
  assertAdmin(ctx);
  const [batches, profiles, tz] = await Promise.all([ctx.store.listImportBatches(), ctx.store.listProfiles(), headOfficeTimezone(ctx)]);
  const by = new Map(profiles.map((p) => [p.id, p.fullName]));
  const history = batches.filter((b) => b.kind === "worker_master").sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/admin/workers", label: "Workers" }}
        title="Import workers from Excel"
        description="Adds contractor workers from the contractor master workbook. Employee IDs are kept exactly as written. Workers are not assigned to a plant by the import."
      />
      <MasterImport />
      {history.length > 0 && (
        <Section title="Earlier imports">
          <ul className="divide-y overflow-hidden rounded-xl bg-card shadow-surface" data-testid="import-history">
            {history.map((b) => {
              const totals = (b.summary.totals ?? {}) as { create?: number; updateApproved?: number };
              return (
                <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-3 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{b.fileName}</span>
                  <span className="tabular text-muted-foreground">
                    {totals.create ?? 0} new · {totals.updateApproved ?? 0} updated
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(b.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: tz })}
                    {b.createdBy && ` · ${by.get(b.createdBy) ?? "Unknown user"}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </div>
  );
}
