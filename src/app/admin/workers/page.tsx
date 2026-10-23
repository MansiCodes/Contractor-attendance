import type { Metadata } from "next";
import Link from "next/link";
import { FileSpreadsheet } from "lucide-react";
import { WorkerDirectory } from "@/components/admin/worker-directory";
import { AddWorkerDialog } from "@/components/admin/worker-dialogs";
import { PageHeader } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { adminDirectory } from "@/lib/server/services/admin";
import { deploymentOptions, workerSummaries } from "@/lib/server/services/directory";
import { requirePageContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Workers" };

type Search = Promise<{ view?: string }>;

export default async function WorkersPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requirePageContext("admin");
  const sp = await searchParams;
  const dir = await adminDirectory(ctx);
  const options = deploymentOptions(dir);
  const contractorName = new Map(dir.contractors.map((c) => [c.id, c.name]));
  const projectName = new Map(dir.projects.map((p) => [p.id, p.name]));
  const workers = workerSummaries(dir, {}).map((w) => ({
    ...w,
    contractorName: contractorName.get(w.contractorId) ?? "—",
    projectName: w.currentProjectId ? projectName.get(w.currentProjectId) ?? null : null,
  }));
  const contractors = dir.contractors
    .filter((c) => workers.some((w) => w.contractorId === c.id))
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workers"
        description="Contractor workers in every plant. Only head office admins can add or change workers."
        actions={
          <>
            <Link href="/admin/workers/import" className={buttonVariants({ variant: "outline" })} data-testid="import-workers">
              <FileSpreadsheet /> Import from Excel
            </Link>
            <AddWorkerDialog options={options} />
          </>
        }
      />
      <WorkerDirectory workers={workers} contractors={contractors} options={options} initialView={sp.view === "unassigned" ? "unassigned" : "all"} />
    </div>
  );
}
