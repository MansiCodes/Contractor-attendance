import { assignmentCovers } from "@/lib/domain/register";
import type { WorkerAssignment } from "@/lib/domain/types";
import type { adminDirectory } from "./admin";

type Directory = Awaited<ReturnType<typeof adminDirectory>>;

/** Read-model helpers for the admin screens (pure functions over the directory). */
export function currentAssignment(assignments: WorkerAssignment[], workerId: string, today: string) {
  return (
    assignments.find((a) => a.workerId === workerId && assignmentCovers(a, today)) ??
    assignments.find((a) => a.workerId === workerId && a.startDate > today) ??
    null
  );
}

export function deploymentOptions(dir: Directory) {
  const sitesByContractor: Record<string, string[]> = {};
  for (const a of dir.cpas) {
    if (!assignmentCovers(a, dir.today)) continue;
    const project = dir.projects.find((p) => p.id === a.projectId);
    if (!project?.isActive) continue;
    (sitesByContractor[a.contractorId] ??= []).push(a.projectId);
  }
  return {
    contractors: dir.contractors.filter((c) => c.isActive).map((c) => ({ id: c.id, name: c.name })),
    projects: dir.projects.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name })),
    sitesByContractor,
    today: dir.today,
  };
}

export function workerSummaries(dir: Directory, filter: { contractorId?: string; projectId?: string }) {
  return dir.workers
    .map((w) => {
      const a = currentAssignment(dir.assignments, w.id, dir.today);
      return {
        id: w.id,
        code: w.code,
        employeeCode: w.employeeCode,
        fullName: w.fullName,
        contractorId: w.contractorId,
        department: w.department,
        designation: w.designation,
        isActive: w.isActive,
        phone: w.phone,
        notes: w.notes,
        currentProjectId: w.isActive ? a?.projectId ?? null : null,
        currentSince: w.isActive ? a?.startDate ?? null : null,
      };
    })
    .filter(
      (w) =>
        (!filter.contractorId || w.contractorId === filter.contractorId) &&
        (!filter.projectId || (w.currentProjectId === filter.projectId && w.isActive)),
    )
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.fullName.localeCompare(b.fullName, "en-IN"));
}

export function activeWorkerCount(dir: Directory, contractorId: string) {
  return dir.workers.filter((w) => w.contractorId === contractorId && w.isActive && currentAssignment(dir.assignments, w.id, dir.today)).length;
}
