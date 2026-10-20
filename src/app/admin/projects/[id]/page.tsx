import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ChevronLeft, MapPin } from "lucide-react";
import { AssignContractor, OperatorAccessToggle, ProjectSettingsForm, RemoveContractorButton } from "@/components/admin/project-dialogs";
import { AddWorkerDialog, WorkerActions } from "@/components/admin/worker-dialogs";
import { ContractorAvatar } from "@/components/contractor-avatar";
import { EmptyState, Group, Section, StatusPill } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { assignmentCovers } from "@/lib/domain/register";
import { formatDateShort } from "@/lib/domain/time";
import { adminDirectory } from "@/lib/server/services/admin";
import { deploymentOptions, workerSummaries } from "@/lib/server/services/directory";
import { requirePageContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Project" };

type Params = Promise<{ id: string }>;

export default async function ProjectPage({ params }: { params: Params }) {
  const ctx = await requirePageContext("admin");
  const { id } = await params;
  const dir = await adminDirectory(ctx);
  const project = dir.projects.find((p) => p.id === id);
  if (!project) notFound();
  const options = deploymentOptions(dir);
  const activeCpas = dir.cpas.filter((a) => a.projectId === id && assignmentCovers(a, dir.today));
  const contractorById = new Map(dir.contractors.map((c) => [c.id, c]));
  const unassigned = dir.contractors.filter((c) => c.isActive && !activeCpas.some((a) => a.contractorId === c.id)).map((c) => ({ id: c.id, name: c.name }));
  const workers = workerSummaries(dir, { projectId: id });
  const operators = dir.profiles.filter((u) => u.role === "operator" && u.isActive);

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href="/admin/projects"
          className="-ml-1.5 inline-flex h-8 items-center gap-0.5 rounded-md pr-2 pl-0.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> Projects
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-title font-semibold text-balance">{project.name}</h1>
              {!project.isActive && <StatusPill tone="neutral">Inactive</StatusPill>}
            </div>
            <p className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground">
              <MapPin className="size-3.5" /> {project.location}
            </p>
          </div>
          <Link href={`/admin/attendance?tab=register&project=${id}`} className={buttonVariants({ className: "w-full sm:w-auto" })}>
            Open register <ArrowRight />
          </Link>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-6">
        <Section title="Contractors at this site" description={`${activeCpas.length} assigned`}>
          <Group as="ul">
            {activeCpas.length === 0 && <li className="px-4 py-3.5 text-sm text-muted-foreground">No contractors assigned yet.</li>}
            {activeCpas.map((a) => {
              const c = contractorById.get(a.contractorId);
              const count = workers.filter((w) => w.contractorId === a.contractorId).length;
              return (
                <li key={a.id} className="flex items-center gap-3 py-2.5 pr-2 pl-4">
                  {c && <ContractorAvatar name={c.name} photoUrl={c.photoUrl} size="sm" />}
                  <div className="min-w-0 flex-1">
                    <Link href={`/admin/contractors/${a.contractorId}`} className="block truncate text-md font-medium hover:text-primary hover:underline">
                      {c?.name}
                    </Link>
                    <div className="tabular text-xs text-muted-foreground">
                      {count} workers · since {formatDateShort(a.startDate)}
                    </div>
                  </div>
                  <RemoveContractorButton assignmentId={a.id} name={c?.name ?? "contractor"} />
                </li>
              );
            })}
          </Group>
          <AssignContractor projectId={id} options={unassigned} />
        </Section>

        <Section title="Operators" description="Who can record attendance here">
          <Group>
            {operators.length === 0 && <p className="px-4 py-3.5 text-sm text-muted-foreground">No operators yet. Add them under Projects → Attendance operators.</p>}
            {operators.map((u) => (
              <OperatorAccessToggle
                key={u.id}
                operatorId={u.id}
                projectId={id}
                granted={dir.access.some((a) => a.operatorId === u.id && a.projectId === id && !a.revokedAt)}
                label={`${u.fullName} · ${u.email}`}
              />
            ))}
          </Group>
        </Section>
      </div>

      <Section
        title="Workers at this site"
        description={`${workers.length} assigned today`}
        actions={<AddWorkerDialog options={options} defaultProjectId={id} defaultContractorId={activeCpas[0]?.contractorId} />}
      >
        {workers.length === 0 ? (
          <EmptyState title="No workers assigned" description="Add workers here, or transfer them from another site." />
        ) : (
          <Group as="ul" className="md:grid md:grid-cols-2 md:divide-y-0 md:[&>li]:border-b md:[&>li:nth-child(odd)]:border-r">
            {workers.map((w) => (
              <li key={w.id} className="flex items-center gap-3 py-2 pr-2 pl-4">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-md font-medium">{w.fullName}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {w.code} · {contractorById.get(w.contractorId)?.name}
                  </div>
                </div>
                <WorkerActions worker={w} options={options} />
              </li>
            ))}
          </Group>
        )}
      </Section>

      <Section title="Site settings">
        <ProjectSettingsForm project={project} />
      </Section>
    </div>
  );
}
